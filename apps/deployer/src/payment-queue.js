import { NearConnector } from "@hot-labs/near-connect";
import {
  OWNER, TREASURY, RPCS, stable, formatVtt, normalizePending,
  actionReadiness, paymentCall, uncertainOutcomeMessage, EVENT_AWARE_CONTRACT_CODE_HASH
} from "./payment-queue-core.mjs";

const $ = id => document.getElementById(id);
let connector;
let accountId = "";
let verifiedSnapshot;
let busy = false;
let generation = 0;
let expiryTimer;
const TIMEOUT_MS = 12000;

async function rpc(endpoint, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-payment-queue", method, params }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(endpoint.name + " HTTP " + response.status);
    const payload = await response.json();
    if (payload.error) throw new Error(endpoint.name + ": " + (payload.error.message || "RPC error"));
    if (!payload.result) throw new Error(endpoint.name + " returned no result.");
    return payload.result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(endpoint.name + " timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function encodeArgs(args) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(args ?? {}))));
}

async function view(endpoint, method, args, blockHash) {
  const result = await rpc(endpoint, "query", {
    request_type: "call_function",
    block_id: blockHash,
    account_id: TREASURY,
    method_name: method,
    args_base64: encodeArgs(args)
  });
  if (result.block_hash !== blockHash) throw new Error(endpoint.name + " returned " + method + " at a different block.");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

function normalizePosition(position, endpointName) {
  if (!position || typeof position !== "object") throw new Error(endpointName + " returned no financial position.");
  const result = {};
  for (const key of ["treasury_balance", "active_commitments", "safety_reserve", "pending_discretionary", "spendable_balance"]) {
    const value = position[key];
    const raw = typeof value === "string" ? value :
      typeof value === "number" && Number.isSafeInteger(value) ? String(value) :
      value && typeof value === "object" && typeof value["0"] === "string" ? value["0"] : "";
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(endpointName + " returned invalid " + key + ".");
    result[key] = raw;
  }
  return result;
}

async function readProvider(endpoint, blockHash) {
  const network = await rpc(endpoint, "status", []);
  if (network.chain_id !== "testnet") throw new Error(endpoint.name + " did not confirm NEAR Testnet.");
  const [account, owner, position, paused, pending] = await Promise.all([
    rpc(endpoint, "query", { request_type: "view_account", account_id: TREASURY, block_id: blockHash }),
    view(endpoint, "get_owner", {}, blockHash),
    view(endpoint, "get_financial_position", {}, blockHash),
    view(endpoint, "get_pause_status", {}, blockHash),
    view(endpoint, "get_pending_transfers", {}, blockHash)
  ]);
  if (!account || typeof account.code_hash !== "string" || !account.code_hash || (account.block_hash && account.block_hash !== blockHash)) throw new Error(endpoint.name + " returned an invalid treasury code-hash snapshot.");
  if (owner !== OWNER) throw new Error(endpoint.name + " reports an unexpected treasury owner.");
  if (typeof paused !== "boolean") throw new Error(endpoint.name + " returned an invalid pause state.");
  const classified = normalizePending(pending);
  return {
    blockHash, codeHash: account.code_hash,
    supportsApproval: account.code_hash === EVENT_AWARE_CONTRACT_CODE_HASH,
    owner, position: normalizePosition(position, endpoint.name),
    paused, queued: classified.queued, transfers: classified.transfers
  };
}

function renderList(containerId, records, isQueued) {
  const container = $(containerId);
  container.replaceChildren();
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = isQueued ? "No agent payment requests are awaiting approval." : "No outgoing transfers are currently in flight.";
    container.append(empty);
    return;
  }
  for (const item of records) {
    const row = document.createElement("article");
    row.className = "item";
    const title = document.createElement("strong");
    title.textContent = (isQueued ? "REQUEST #" : "TRANSFER #") + item.id;
    const amount = document.createElement("p");
    amount.textContent = formatVtt(item.amount);
    const recipient = document.createElement("p");
    recipient.textContent = isQueued
      ? "Recipient: " + item.detail.recipient_id
      : item.kind === "discretionary"
        ? "Recipient: " + item.detail.recipient_id
        : "Commitment settlement: " + item.detail.commitment_id;
    const memo = document.createElement("p");
    memo.className = "muted";
    memo.textContent = isQueued
      ? (item.detail.memo ? "Memo: " + item.detail.memo : "No memo supplied")
      : item.kind === "discretionary" && item.detail.memo ? "Memo: " + item.detail.memo : "In-flight transfer";
    const created = document.createElement("p");
    created.className = "muted";
    const millis = BigInt(item.created_at_ns) / 1000000n;
    created.textContent = "Created: " + (millis <= BigInt(Number.MAX_SAFE_INTEGER) ? new Date(Number(millis)).toLocaleString() : "timestamp unavailable");
    row.append(title, amount, recipient, memo, created);
    if (isQueued) {
      const actions = document.createElement("div");
      actions.className = "actions";
      const approve = document.createElement("button");
      approve.textContent = "Approve payment";
      approve.disabled = true;
      approve.addEventListener("click", () => void act("approve_payment", item.id));
      const reject = document.createElement("button");
      reject.className = "danger";
      reject.textContent = "Reject request";
      reject.disabled = true;
      reject.addEventListener("click", () => void act("reject_payment", item.id));
      actions.append(approve, reject);
      row.append(actions);
      item.controls = { approve, reject };
    }
    container.append(row);
  }
}

function lockControls() {
  for (const button of $("queue").querySelectorAll("button")) button.disabled = true;
}

function updateControls() {
  const readiness = actionReadiness({
    snapshot: verifiedSnapshot,
    accountId,
    networkConfirmed: $("network-confirm").checked
  });
  for (const item of verifiedSnapshot?.queued || []) {
    if (!item.controls) continue;
    item.controls.approve.disabled = busy || !readiness.canApprove;
    item.controls.reject.disabled = busy || !readiness.canReject;
  }
}

function render(snapshot) {
  $("balance").textContent = formatVtt(snapshot.position.treasury_balance);
  $("commitments").textContent = formatVtt(snapshot.position.active_commitments);
  $("reserve").textContent = formatVtt(snapshot.position.safety_reserve);
  $("pending").textContent = formatVtt(snapshot.position.pending_discretionary);
  $("spendable").textContent = formatVtt(snapshot.position.spendable_balance);
  $("paused").textContent = snapshot.paused ? "YES" : "NO";
  renderList("queue", snapshot.queued, true);
  renderList("transfers", snapshot.transfers, false);
  updateControls();
}

async function refresh() {
  const current = ++generation;
  verifiedSnapshot = undefined;
  $("refresh").disabled = true;
  $("read-status").textContent = "Reading the same finalized block from both independent Testnet RPC providers…";
  for (const id of ["balance","commitments","reserve","pending","spendable","paused"]) $(id).textContent = "—";
  $("queue").textContent = "Loading queued requests…";
  $("transfers").textContent = "Loading in-flight transfers…";
  try {
    const blocks = await Promise.all(RPCS.map(endpoint => rpc(endpoint, "block", { finality: "final" })));
    const hashes = blocks.map(block => block?.header?.hash);
    const heights = blocks.map(block => block?.header?.height);
    if (!hashes[0] || hashes[0] !== hashes[1] || heights[0] !== heights[1]) {
      throw new Error("Providers do not agree on the same finalized block. All owner controls remain disabled.");
    }
    const [first, second] = await Promise.all(RPCS.map(endpoint => readProvider(endpoint, hashes[0])));
    if (current !== generation) return;
    if (stable(first) !== stable(second)) throw new Error("Providers disagree on treasury state. Owner controls remain disabled.");
    verifiedSnapshot = {
      ...first, verified: true, providersAgree: true,
      checkedAt: Date.now(), blockHeight: heights[0]
    };
    render(verifiedSnapshot);
    clearTimeout(expiryTimer);
    const renderedSnapshot = verifiedSnapshot;
    expiryTimer = setTimeout(() => {
      if (verifiedSnapshot === renderedSnapshot) {
        updateControls();
        $("read-status").textContent = "SNAPSHOT EXPIRED — refresh finalized state from both providers before approving or rejecting.";
      }
    }, 30000);
    $("read-status").textContent = "VERIFIED — both providers agree at finalized block " + heights[0] + " (" + hashes[0] + "). Code hash: " + verifiedSnapshot.codeHash + ". " + (verifiedSnapshot.supportsApproval ? "Owner approval and rejection methods are supported by this contract version." : "This deployed contract version does not expose approve_payment/reject_payment; queue actions remain disabled until the exact reviewed release is installed.") + " Snapshot is actionable for 30 seconds. Last checked " + new Date(verifiedSnapshot.checkedAt).toLocaleTimeString() + ".";
  } catch (error) {
    if (current === generation) {
      $("read-status").textContent = "STATE NOT VERIFIED — " + String(error?.message || error) + " No wallet action is available.";
      $("queue").textContent = "Requests withheld because state is not verified.";
      $("transfers").textContent = "Transfers withheld because state is not verified.";
    }
  } finally {
    if (current === generation) $("refresh").disabled = busy;
  }
}

async function act(methodName, requestId) {
  const readiness = actionReadiness({
    snapshot: verifiedSnapshot,
    accountId,
    networkConfirmed: $("network-confirm").checked
  });
  if (busy || (methodName === "approve_payment" ? !readiness.canApprove : !readiness.canReject)) {
    $("read-status").textContent = "Action blocked: owner, Testnet confirmation, fresh dual-provider snapshot, and pause requirements must all pass.";
    return;
  }
  const record = verifiedSnapshot.queued.find(item => item.id === String(requestId));
  if (!record) {
    $("read-status").textContent = "Request is no longer in the verified queue. Refresh before taking action.";
    return;
  }
  const verb = methodName === "approve_payment" ? "APPROVE" : "REJECT";
  if (!window.confirm(verb + " request #" + requestId + " for " + formatVtt(record.amount) + " to " + record.detail.recipient_id + "? Meteor will show one FunctionCall to " + TREASURY + ".")) return;

  // Native confirmation dialogs block the event loop, so the expiry timer cannot
  // run while the dialog is open. Revalidate the snapshot and request immediately
  // after confirmation, before opening the wallet for signing.
  const confirmedReadiness = actionReadiness({
    snapshot: verifiedSnapshot,
    accountId,
    networkConfirmed: $("network-confirm").checked
  });
  const confirmedRecord = verifiedSnapshot?.queued.find(item => item.id === String(requestId));
  if (busy || (methodName === "approve_payment" ? !confirmedReadiness.canApprove : !confirmedReadiness.canReject) ||
      !confirmedRecord || confirmedRecord.amount !== record.amount ||
      confirmedRecord.detail.recipient_id !== record.detail.recipient_id ||
      confirmedRecord.detail.memo !== record.detail.memo ||
      !connector || accountId !== OWNER) {
    $("read-status").textContent = "Action cancelled: the verified snapshot expired or owner/request state changed while confirmation was open. Refresh finalized state before trying again.";
    await refresh();
    return;
  }

  busy = true;
  generation += 1;
  for (const queued of verifiedSnapshot?.queued || []) {
    if (queued.controls) { queued.controls.approve.disabled = true; queued.controls.reject.disabled = true; }
  }
  verifiedSnapshot = undefined;
  $("read-status").textContent = "Opening Meteor for explicit " + verb.toLowerCase() + " approval. Review signer, receiver, method, request ID, gas and zero deposit.";
  try {
    if (!connector || accountId !== OWNER || !$("network-confirm").checked) throw new Error("Owner wallet or Testnet confirmation changed.");
    const wallet = await connector.wallet();
    await wallet.signAndSendTransaction(paymentCall(methodName, String(requestId)));
    $("read-status").textContent = "Wallet returned a response. This is not proof of final execution. Refreshing both providers at finalized state…";
  } catch (error) {
    $("read-status").textContent = uncertainOutcomeMessage() + " Wallet detail: " + String(error?.message || error);
  }
  try {
    await refresh();
    if (verifiedSnapshot) {
      const stillQueued = verifiedSnapshot.queued.some(item => item.id === String(requestId));
      $("read-status").textContent += stillQueued
        ? " The request still appears queued in finalized state; inspect it before any new attempt."
        : " The request is no longer queued in the finalized snapshot. Inspect the in-flight transfers and contract state.";
    }
  } finally {
    busy = false;
    $("refresh").disabled = false;
    updateControls();
  }
}

$("connect").addEventListener("click", async () => {
  $("connect").disabled = true;
  try {
    connector = new NearConnector({ network: "testnet", features: { testnet: true }, footerBranding: null });
    connector.on("wallet:signIn", event => {
      accountId = event?.accounts?.[0]?.accountId || "";
      lockControls();
      verifiedSnapshot = undefined;
      $("wallet-account").textContent = accountId ? "Connected: " + accountId : "Wallet did not return an account.";
      if (accountId !== OWNER) $("wallet-account").textContent += " — owner account required.";
      updateControls();
    });
    connector.on("wallet:signOut", () => {
      accountId = "";
      lockControls();
      verifiedSnapshot = undefined;
      $("wallet-account").textContent = "Disconnected";
      updateControls();
    });
    await connector.connect();
    if (!accountId) {
      const accounts = await connector.getAccounts?.();
      accountId = accounts?.[0]?.accountId || "";
    }
    $("wallet-account").textContent = accountId ? "Connected: " + accountId : "Connected; account not returned.";
    if (accountId !== OWNER) $("wallet-account").textContent += " — owner account required.";
    updateControls();
  } catch (error) {
    $("wallet-account").textContent = "Connection failed: " + String(error?.message || error);
  } finally {
    $("connect").disabled = false;
  }
});

$("refresh").addEventListener("click", () => { if (!busy) void refresh(); });
$("network-confirm").addEventListener("change", updateControls);
void refresh();
