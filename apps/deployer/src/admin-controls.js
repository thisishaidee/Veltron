import { NearConnector } from "@hot-labs/near-connect";

const OWNER = "haideedotxyz.testnet";
const TREASURY = "veltron-treasury.testnet";
const TOKEN_DECIMALS = 6;
const GAS = "30000000000000";
const RPCS = [
  { name: "NEAR Public RPC", url: "https://rpc.testnet.near.org" },
  { name: "FastNEAR", url: "https://rpc.testnet.fastnear.com" }
];
const $ = id => document.getElementById(id);
let connector;
let accountId = "";
let snapshot;
let busy = false;
let generation = 0;
const SNAPSHOT_TTL_MS = 30000;
const AUDIT_MAX_AGE_NS = 30000000000n;
const TIMEOUT_MS = 12000;

async function rpc(endpoint, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-owner-controls", method, params }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(endpoint.name + " HTTP " + response.status);
    const payload = await response.json();
    if (payload.error) throw new Error(endpoint.name + ": " + (payload.error.message || "RPC error"));
    return payload.result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(endpoint.name + " timed out.");
    throw error;
  } finally { clearTimeout(timeout); }
}

function encodeArgs(args = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function view(endpoint, method, args, blockHash) {
  const result = await rpc(endpoint, "query", {
    request_type: "call_function", block_id: blockHash,
    account_id: TREASURY, method_name: method, args_base64: encodeArgs(args)
  });
  if (result.block_hash !== blockHash) throw new Error(endpoint.name + " returned a different finalized block.");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
function raw(value, label) {
  const normalized = typeof value === "string" ? value :
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) :
    value && typeof value === "object" && typeof value["0"] === "string" ? value["0"] : "";
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) throw new Error("Invalid " + label + " returned by treasury.");
  return normalized;
}
function formatVtt(value) {
  const amount = BigInt(value), whole = amount / 1000000n;
  const fraction = (amount % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (fraction ? "." + fraction : "") + " VTT";
}
function parseVtt(value, allowZero = false) {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter a valid VTT amount with up to six decimal places.");
  const result = BigInt(match[1]) * 1000000n + BigInt((match[2] || "").padEnd(6, "0") || "0");
  if (allowZero ? result < 0n : result <= 0n) throw new Error(allowZero ? "Amount cannot be negative." : "Amount must be greater than zero.");
  return result.toString();
}
function validAccount(value) {
  if (!/^[a-z0-9._-]{2,64}$/.test(value)) throw new Error("Enter a valid NEAR account ID.");
  return value;
}
async function readAllCommitments(endpoint, blockHash) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 6; page += 1) {
    const result = await view(endpoint, "get_commitments", { from_id: cursor, limit: 50 }, blockHash);
    if (!Array.isArray(result?.commitments)) throw new Error(endpoint.name + " returned an invalid commitments page.");
    all.push(...result.commitments);
    if (all.length > 256) throw new Error(endpoint.name + " exceeded the contract commitment limit.");
    if (result.next_cursor == null) return all;
    if (typeof result.next_cursor !== "string" || result.next_cursor === cursor) throw new Error(endpoint.name + " returned an invalid commitment cursor.");
    cursor = result.next_cursor;
  }
  throw new Error(endpoint.name + " did not finish commitment pagination.");
}
async function readProvider(endpoint, blockHash) {
  const network = await rpc(endpoint, "status", []);
  if (network.chain_id !== "testnet") throw new Error(endpoint.name + " did not confirm Testnet.");
  const [owner, agent, position, paused, commitments, pending, audit] = await Promise.all([
    view(endpoint, "get_owner", {}, blockHash),
    view(endpoint, "get_agent_config", {}, blockHash),
    view(endpoint, "get_financial_position", {}, blockHash),
    view(endpoint, "get_pause_status", {}, blockHash),
    readAllCommitments(endpoint, blockHash),
    view(endpoint, "get_pending_transfers", {}, blockHash),
    view(endpoint, "get_token_balance_audit", {}, blockHash)
  ]);
  if (owner !== OWNER) throw new Error(endpoint.name + " reports an unexpected owner.");
  if (!agent || typeof agent.agent_id !== "string") throw new Error(endpoint.name + " returned invalid agent configuration.");
  if (!position || typeof paused !== "boolean" || typeof audit?.audit_pending !== "boolean" || !Array.isArray(pending) || !Array.isArray(commitments)) {
    throw new Error(endpoint.name + " returned incomplete treasury state.");
  }
  const normalizedPosition = {};
  for (const key of ["treasury_balance", "active_commitments", "safety_reserve", "pending_discretionary", "spendable_balance"]) {
    normalizedPosition[key] = raw(position[key], key);
  }
  const normalizedAgent = {
    agent_id: agent.agent_id,
    max_per_transaction: raw(agent.max_per_transaction, "agent cap")
  };
  const normalizedAudit = {
    audit_pending: audit?.audit_pending === true,
    observed_token_balance: audit?.observed_token_balance == null ? null : raw(audit.observed_token_balance, "observed token balance"),
    ledger_balance_at_observation: audit?.ledger_balance_at_observation == null ? null : raw(audit.ledger_balance_at_observation, "audit ledger balance"),
    observed_at_ns: audit?.observed_at_ns == null ? null : raw(audit.observed_at_ns, "audit timestamp")
  };
  return {
    blockHash, owner, agent: normalizedAgent, position: normalizedPosition, paused,
    commitments,
    pending, audit: normalizedAudit
  };
}
function readiness() {
  return !busy && accountId === OWNER && $("network-confirm").checked &&
    snapshot?.verified === true && Number.isFinite(snapshot.checkedAtMonotonic) &&
    performance.now() - snapshot.checkedAtMonotonic >= 0 &&
    performance.now() - snapshot.checkedAtMonotonic <= SNAPSHOT_TTL_MS;
}
function setActionButtons() {
  const ready = readiness();
  for (const id of ["save-agent", "save-reserve", "pause", "resume", "reconcile"]) $(id).disabled = !ready;
  $("pause").disabled = !ready || snapshot?.paused === true;
  $("resume").disabled = !ready || snapshot?.paused !== true;
  $("reconcile").disabled = !ready || !reconciliationReady();
  for (const button of $("commitments").querySelectorAll("button[data-settlement]")) {
    button.disabled = !ready || button.dataset.settlementPending === "true" || snapshot?.paused === true;
  }
}
function reconciliationReady() {
  if (!snapshot || snapshot.audit.audit_pending || snapshot.pending.length !== 0) return false;
  const observed = snapshot.audit.observed_token_balance;
  const ledgerAtObservation = snapshot.audit.ledger_balance_at_observation;
  const observedAt = snapshot.audit.observed_at_ns;
  if (observed === null || ledgerAtObservation === null || observedAt === null) return false;
  if (ledgerAtObservation !== snapshot.position.treasury_balance) return false;
  const auditAge = BigInt(snapshot.blockTimestampNs) - BigInt(observedAt);
  if (auditAge < 0n || auditAge > AUDIT_MAX_AGE_NS) return false;
  return BigInt(observed) > BigInt(ledgerAtObservation);
}
function render(s) {
  $("balance").textContent = formatVtt(s.position.treasury_balance);
  $("committed").textContent = formatVtt(s.position.active_commitments);
  $("reserve").textContent = formatVtt(s.position.safety_reserve);
  $("pending-total").textContent = formatVtt(s.position.pending_discretionary);
  $("spendable").textContent = formatVtt(s.position.spendable_balance);
  $("paused").textContent = s.paused ? "PAUSED" : "NOT PAUSED";
  $("pause-summary").textContent = s.paused ? "PAUSED" : "NOT PAUSED";
  $("agent").textContent = s.agent.agent_id;
  $("cap").textContent = formatVtt(s.agent.max_per_transaction);
  $("agent-id").value = s.agent.agent_id;
  $("agent-cap").value = decimalInput(s.agent.max_per_transaction);
  $("reserve-amount").value = decimalInput(s.position.safety_reserve);
  $("audit-pending").textContent = s.audit.audit_pending ? "YES" : "NO";
  $("audit-token").textContent = s.audit.observed_token_balance === null ? "No successful observation" : formatVtt(s.audit.observed_token_balance);
  $("audit-ledger").textContent = s.audit.ledger_balance_at_observation === null ? "—" : formatVtt(s.audit.ledger_balance_at_observation);
  $("audit-time").textContent = s.audit.observed_at_ns ?? "—";
  if (s.audit.observed_token_balance !== null && s.audit.ledger_balance_at_observation !== null) {
    const surplus = BigInt(s.audit.observed_token_balance) - BigInt(s.audit.ledger_balance_at_observation);
    const auditAge = s.blockTimestampNs ? BigInt(s.blockTimestampNs) - BigInt(s.audit.observed_at_ns || "0") : AUDIT_MAX_AGE_NS + 1n;
    $("surplus").textContent = surplus > 0n
      ? "Observed surplus: " + formatVtt(surplus.toString()) + (s.audit.ledger_balance_at_observation === s.position.treasury_balance && auditAge >= 0n && auditAge <= AUDIT_MAX_AGE_NS ? ". Audit ledger matches current ledger and observation is under 30 seconds old." : ". STALE: ledger changed or audit is older than 30 seconds; refresh the balance audit.")
      : "No positive token surplus was observed.";
  } else $("surplus").textContent = "No completed balance audit is available. Use the separate Balance Audit page first.";
  renderCommitments(s.commitments);
  renderActivity(s.pending, s.commitments, s.audit);
}
function decimalInput(value) {
  const n = BigInt(value), whole = n / 1000000n;
  const fraction = (n % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return whole.toString() + (fraction ? "." + fraction : "");
}
function renderCommitments(items) {
  const root = $("commitments"); root.replaceChildren();
  if (!items.length) { root.textContent = "No active commitments."; return; }
  for (const item of items) {
    const row = document.createElement("div"); row.className = "item";
    const title = document.createElement("strong"); title.textContent = item.id;
    const details = document.createElement("p");
    details.textContent = formatVtt(raw(item.amount, "commitment amount")) + " · " + item.recipient_id + (item.settlement_pending ? " · SETTLEMENT PENDING" : "");
    const action = document.createElement("button"); action.className = "secondary";
    action.textContent = item.settlement_pending ? "Settlement pending" : "Review settlement";
    action.dataset.settlement = "true";
    action.dataset.settlementPending = String(item.settlement_pending === true);
    action.disabled = !readiness() || item.settlement_pending || snapshot.paused;
    action.addEventListener("click", () => settle(item));
    row.append(title, details, action); root.append(row);
  }
}
function renderActivity(pending, commitments, audit) {
  const root = $("activity"); root.replaceChildren();
  const heading = document.createElement("p");
  heading.textContent = "Current pending transfers: " + pending.length + ". Active commitments: " + commitments.length + ".";
  root.append(heading);
  if (!pending.length) {
    const empty = document.createElement("p"); empty.textContent = "No pending transfers currently recorded."; root.append(empty);
  }
  for (const item of pending) {
    const row = document.createElement("p"); row.className = "item";
    row.textContent = "Pending #" + item.id + " · " + formatVtt(raw(item.amount, "pending transfer amount")) + " · " + kindLabel(item.kind) + " · created at " + item.created_at_ns + " ns";
    root.append(row);
  }
  const auditLine = document.createElement("p"); auditLine.className = "item";
  auditLine.textContent = "Latest token-balance audit: " + (audit.audit_pending ? "pending" : audit.observed_token_balance === null ? "no successful observation" : "observation recorded at " + audit.observed_at_ns + " ns");
  root.append(auditLine);
}
function kindLabel(kind) {
  if (kind?.DiscretionaryRequest) return "agent request awaiting owner decision";
  if (kind?.Discretionary) return "discretionary transfer in flight";
  if (kind?.CommitmentSettlement) return "commitment settlement in flight";
  return "unknown pending kind";
}
async function refresh() {
  if (busy) return;
  const current = ++generation;
  $("refresh").disabled = true;
  snapshot = undefined; setActionButtons();
  $("read-status").textContent = "Reading finalized state from both independent Testnet RPC providers…";
  for (const id of ["balance","committed","reserve","pending-total","spendable","paused","agent","cap","audit-pending","audit-token","audit-ledger","audit-time"]) $(id).textContent = "—";
  $("commitments").textContent = "State withheld until both providers agree.";
  $("activity").textContent = "State withheld until both providers agree.";
  try {
    const block = await rpc(RPCS[0], "block", { finality: "final" });
    const hash = block?.header?.hash;
    if (typeof hash !== "string" || !hash) throw new Error("Could not obtain a finalized block hash.");
    const blockTimestampNs = raw(block?.header?.timestamp_nanosec, "finalized block timestamp");
    const [a,b] = await Promise.all(RPCS.map(endpoint => readProvider(endpoint, hash)));
    if (current !== generation) return;
    if (stable(a) !== stable(b)) throw new Error("RPC providers disagree at the same finalized block. State is withheld.");
    snapshot = { ...a, blockTimestampNs, verified: true, checkedAtMonotonic: performance.now() };
    render(snapshot);
    $("read-status").textContent = "VERIFIED — both providers agree at finalized block " + hash + ". Snapshot expires after 30 seconds. No transaction was sent.";
    setActionButtons();
    setTimeout(() => {
      if (snapshot && performance.now() - snapshot.checkedAtMonotonic > SNAPSHOT_TTL_MS) {
        snapshot = undefined; setActionButtons();
        $("read-status").textContent = "SNAPSHOT EXPIRED — refresh finalized state before any owner action.";
      }
    }, SNAPSHOT_TTL_MS + 50);
  } catch (error) {
    if (current === generation) {
      $("read-status").textContent = "STATE NOT VERIFIED — " + String(error?.message || error) + ". No wallet action is available.";
    }
  } finally { if (current === generation) $("refresh").disabled = false; }
}
async function send(methodName, args, statusId, options = {}) {
  if (!readiness()) throw new Error("Owner account, Testnet confirmation and fresh dual-provider finalized state are required.");
  if (options.requireUnpaused && snapshot.paused) throw new Error("Treasury is paused. Resume it separately before this operation.");
  if (options.requireNoPending && snapshot.pending.length !== 0) throw new Error("Pending transfers exist. Wait for their finalized outcome before reconciling.");
  const expected = snapshot;
  const confirmation = options.confirmation || ("Review " + methodName + " in Meteor?");
  if (!window.confirm(confirmation)) return;
  if (!readiness() || snapshot !== expected || snapshot.blockHash !== expected.blockHash) {
    throw new Error("Snapshot or owner state changed during confirmation. Refresh and retry.");
  }
  busy = true; generation += 1; snapshot = undefined; setActionButtons();
  $("read-status").textContent = "Opening Meteor for explicit owner approval. Inspect the exact transaction.";
  $(statusId).textContent = "Waiting for wallet approval…";
  try {
    const wallet = await connector.wallet();
    await wallet.signAndSendTransaction({
      network: "testnet", signerId: OWNER, receiverId: TREASURY,
      actions: [{ type: "FunctionCall", params: { methodName, args, gas: GAS, deposit: "0" } }]
    });
    $(statusId).textContent = "Wallet returned a response. This does not prove final execution. Refreshing finalized state…";
  } catch (error) {
    $(statusId).textContent = "REQUEST OUTCOME UNCERTAIN — " + String(error?.message || error) + ". Refresh finalized state before considering another attempt.";
  } finally {
    busy = false; await refresh(); setActionButtons();
  }
}
$("connect").addEventListener("click", async () => {
  $("connect").disabled = true;
  try {
    connector = new NearConnector({ network: "testnet", features: { testnet: true }, footerBranding: null });
    connector.on("wallet:signIn", event => {
      accountId = event?.accounts?.[0]?.accountId || "";
      snapshot = undefined; setActionButtons();
      $("wallet-account").textContent = accountId || "No account returned.";
      $("wallet-status").textContent = accountId === OWNER ? "Owner account connected. Confirm Testnet in Meteor." : "Connected account is not the configured owner.";
    });
    connector.on("wallet:signOut", () => {
      accountId = ""; snapshot = undefined; setActionButtons();
      $("wallet-account").textContent = "Disconnected"; $("wallet-status").textContent = "Wallet disconnected.";
    });
    await connector.connect();
    if (!accountId) accountId = (await connector.getAccounts?.())?.[0]?.accountId || "";
    $("wallet-account").textContent = accountId || "Connected; account not returned.";
    $("wallet-status").textContent = accountId === OWNER ? "Owner connected. Confirm Testnet in Meteor and refresh." : "Owner account required.";
  } catch (error) {
    $("wallet-status").textContent = "Connection failed: " + String(error?.message || error);
  } finally { $("connect").disabled = false; }
});
$("refresh").addEventListener("click", refresh);
$("network-confirm").addEventListener("change", setActionButtons);
$("save-agent").addEventListener("click", async () => {
  try {
    const agent_id = validAccount($("agent-id").value.trim());
    if ([OWNER, TREASURY, "veltron-token.testnet"].includes(agent_id)) throw new Error("The agent must be distinct from the owner, treasury, and token contract.");
    const max_per_transaction = parseVtt($("agent-cap").value);
    await send("set_agent", { agent_id, max_per_transaction }, "agent-status", {
      confirmation: "Change the authorized agent to " + agent_id + " with a per-transaction cap of " + formatVtt(max_per_transaction) + "? Review this exact set_agent call in Meteor."
    });
  } catch (error) { $("agent-status").textContent = "NOT SENT — " + String(error?.message || error); }
});
$("save-reserve").addEventListener("click", async () => {
  try {
    const amount = parseVtt($("reserve-amount").value, true);
    if (!snapshot || BigInt(snapshot.position.active_commitments) + BigInt(snapshot.position.pending_discretionary) + BigInt(amount) > BigInt(snapshot.position.treasury_balance)) {
      throw new Error("The new reserve would make commitments, pending discretionary reservations, and the reserve exceed the treasury balance.");
    }
    if (BigInt(amount) < BigInt(snapshot?.position.safety_reserve || "0") &&
        !window.confirm("You are reducing the safety reserve. This increases potential spendable funds. Continue to the exact wallet review?")) return;
    await send("set_safety_reserve", { amount }, "reserve-status", {
      confirmation: "Set the protected safety reserve to " + formatVtt(amount) + "? The contract will reject this if commitments plus reserve exceed treasury balance."
    });
  } catch (error) { $("reserve-status").textContent = "NOT SENT — " + String(error?.message || error); }
});
$("pause").addEventListener("click", async () => {
  try { await send("set_paused", { paused: true }, "pause-status", { confirmation: "EMERGENCY PAUSE: block new outgoing treasury transfers? Review the exact set_paused(true) call in Meteor." }); }
  catch (error) { $("pause-status").textContent = "NOT SENT — " + String(error?.message || error); }
});
$("resume").addEventListener("click", async () => {
  try { await send("set_paused", { paused: false }, "pause-status", { confirmation: "RESUME outgoing treasury transfers? This removes the emergency circuit breaker. Review set_paused(false) in Meteor." }); }
  catch (error) { $("pause-status").textContent = "NOT SENT — " + String(error?.message || error); }
});
async function settle(item) {
  try {
    if (item.settlement_pending) throw new Error("Settlement is already pending.");
    await send("settle_commitment", { id: item.id }, "settlement-status", {
      requireUnpaused: true,
      confirmation: "Settle commitment " + item.id + " for " + formatVtt(raw(item.amount, "commitment amount")) + " to " + item.recipient_id + "? The contract pays only the recorded recipient. Review settle_commitment in Meteor."
    });
  } catch (error) { $("settlement-status").textContent = "NOT SENT — " + String(error?.message || error); }
}
$("reconcile").addEventListener("click", async () => {
  try {
    if (!reconciliationReady()) throw new Error("A current successful audit, matching ledger snapshot and zero pending transfers are required.");
    const amount = parseVtt($("reconcile-amount").value);
    const surplus = BigInt(snapshot.audit.observed_token_balance) - BigInt(snapshot.audit.ledger_balance_at_observation);
    if (BigInt(amount) > surplus) throw new Error("Amount exceeds the audited token surplus of " + formatVtt(surplus.toString()) + ".");
    await send("reconcile_token_surplus", { amount }, "reconcile-status", {
      requireNoPending: true,
      confirmation: "Credit " + formatVtt(amount) + " to the internal ledger from the latest audited token surplus? Maximum observed surplus: " + formatVtt(surplus.toString()) + ". This changes accounting state but does not transfer tokens."
    });
  } catch (error) { $("reconcile-status").textContent = "NOT SENT — " + String(error?.message || error); }
});
$("reconcile-amount").addEventListener("input", () => {
  if (snapshot) {
    try {
      const amount = parseVtt($("reconcile-amount").value);
      const surplus = BigInt(snapshot.audit.observed_token_balance || "0") - BigInt(snapshot.audit.ledger_balance_at_observation || "0");
      $("reconcile").disabled = !readiness() || !reconciliationReady() || BigInt(amount) > surplus;
    } catch { $("reconcile").disabled = true; }
  }
});
void refresh();
