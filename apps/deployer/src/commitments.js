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
let verifiedSnapshot;
let busy = false;

async function rpc(endpoint, method, params) {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-commitment-management", method, params })
  });
  if (!response.ok) throw new Error(endpoint.name + " HTTP " + response.status);
  const payload = await response.json();
  if (payload.error) throw new Error(endpoint.name + ": " + (payload.error.message || "RPC error"));
  return payload.result;
}

async function view(endpoint, method, args, blockHash) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(args ?? {}))));
  const result = await rpc(endpoint, "query", {
    request_type: "call_function", block_id: blockHash,
    account_id: TREASURY, method_name: method, args_base64: encoded
  });
  if (result.block_hash !== blockHash) throw new Error(endpoint.name + " returned a view from a different block.");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

async function readAllCommitments(endpoint, blockHash) {
  const commitments = [];
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 6; pageNumber += 1) {
    const page = await view(endpoint, "get_commitments", { from_id: cursor, limit: 50 }, blockHash);
    if (!page || !Array.isArray(page.commitments)) throw new Error(endpoint.name + " returned an invalid commitments page.");
    commitments.push(...page.commitments);
    if (commitments.length > 256) throw new Error(endpoint.name + " exceeded the contract commitment limit.");
    if (page.next_cursor === null) return commitments;
    if (typeof page.next_cursor !== "string" || page.next_cursor === cursor) {
      throw new Error(endpoint.name + " returned an invalid commitment cursor.");
    }
    cursor = page.next_cursor;
  }
  throw new Error(endpoint.name + " did not finish commitment pagination.");
}

async function readProvider(endpoint) {
  const network = await rpc(endpoint, "status", []);
  if (network.chain_id !== "testnet") throw new Error(endpoint.name + " did not confirm Testnet.");
  const [owner, position, paused, commitments] = await Promise.all([
    view(endpoint, "get_owner"),
    view(endpoint, "get_financial_position"),
    view(endpoint, "get_pause_status"),
    readAllCommitments(endpoint)
  ]);
  if (owner !== OWNER) throw new Error(endpoint.name + " reports an unexpected treasury owner.");
  if (!position || typeof position !== "object" || typeof paused !== "boolean") {
    throw new Error(endpoint.name + " returned incomplete treasury state.");
  }
  for (const key of ["treasury_balance", "active_commitments", "safety_reserve", "spendable_balance"]) {
    const raw = position[key];
    const normalized = typeof raw === "string" ? raw :
      typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) :
      raw && typeof raw === "object" && typeof raw["0"] === "string" ? raw["0"] : "";
    if (!/^[0-9]+$/.test(normalized)) {
      throw new Error(endpoint.name + " returned invalid " + key + " (response shape: " + JSON.stringify(position).slice(0, 350) + ").");
    }
    position[key] = normalized;
  }
  return { blockHash, owner, position, paused, commitments };
}
function formatVtt(raw) {
  const value = BigInt(raw);
  const whole = value / 1000000n;
  const fraction = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (fraction ? "." + fraction : "") + " VTT";
}

function render(snapshot) {
  $("balance").textContent = formatVtt(snapshot.position.treasury_balance);
  $("committed").textContent = formatVtt(snapshot.position.active_commitments);
  $("reserve").textContent = formatVtt(snapshot.position.safety_reserve);
  $("spendable").textContent = formatVtt(snapshot.position.spendable_balance);
  $("paused").textContent = snapshot.paused ? "YES" : "NO";
  const list = $("commitments");
  list.replaceChildren();
  if (!snapshot.commitments.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No active commitments.";
    list.append(empty);
  }
  for (const item of snapshot.commitments) {
    const row = document.createElement("div");
    row.className = "item";
    const title = document.createElement("strong");
    title.textContent = item.id;
    const detail = document.createElement("p");
    detail.textContent = formatVtt(item.amount) + " · " + item.recipient_id;
    const description = document.createElement("p");
    description.className = "muted";
    description.textContent = item.description + (item.settlement_pending ? " · Settlement pending" : "");
    const select = document.createElement("button");
    select.className = "secondary";
    select.textContent = "Load for editing";
    select.addEventListener("click", () => {
      $("commitment-id").value = item.id;
      $("recipient").value = item.recipient_id;
      const raw = String(item.amount).padStart(7, "0");
      const whole = raw.slice(0, -6);
      const fraction = raw.slice(-6).replace(/0+$/, "");
      $("amount").value = whole + (fraction ? "." + fraction : "");
      $("description").value = item.description;
      $("cancel-id").value = item.id;
      $("save-status").textContent = "Loaded existing commitment. Saving will call update_commitment.";
    });
    row.append(title, detail, description, select);
    list.append(row);
  }
}

async function refresh() {
  $("refresh").disabled = true;
  $("read-status").textContent = "Reading finalized state from both independent Testnet RPCs…";
  $("save").disabled = true;
  $("cancel").disabled = true;
  verifiedSnapshot = undefined;
  for (const id of ["balance", "committed", "reserve", "spendable", "paused"]) $(id).textContent = "—";
  $("commitments").replaceChildren();
  try {
    const [first, second] = await Promise.all(RPCS.map(readProvider));
    if (stable(first) !== stable(second)) throw new Error("RPC providers disagree. State is withheld.");
    verifiedSnapshot = first;
    render(first);
    $("read-status").textContent = "VERIFIED — both providers agree on finalized treasury position and commitments. Last checked " + new Date().toISOString();
    const ready = accountId === OWNER && $("network-confirm").checked && !busy;
    $("save").disabled = !ready;
    $("cancel").disabled = !ready;
  } catch (error) {
    $("read-status").textContent = "STATE NOT VERIFIED — " + String(error.message || error) + ". No transaction was sent.";
  } finally {
    $("refresh").disabled = false;
  }
}

function parseAmount(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter a positive VTT amount with no more than six decimal places.");
  const fraction = (match[2] || "").padEnd(TOKEN_DECIMALS, "0");
  const base = BigInt(match[1]) * 1000000n + BigInt(fraction || "0");
  if (base <= 0n) throw new Error("Amount must be greater than zero.");
  return base.toString();
}

function validateAccount(value) {
  if (!/^[a-z0-9._-]{2,64}$/.test(value)) throw new Error("Enter a valid NEAR account ID.");
  return value;
}

async function sendCall(methodName, args, statusId) {
  if (busy || accountId !== OWNER || !$("network-confirm").checked || !verifiedSnapshot) {
    throw new Error("Connect the configured owner, confirm Testnet in Meteor, and refresh verified state first.");
  }
  busy = true;
  $("save").disabled = true;
  $("cancel").disabled = true;
  $(statusId).textContent = "Opening wallet approval. Check signer, receiver, method and arguments carefully.";
  try {
    const wallet = await connector.wallet();
    await wallet.signAndSendTransaction({
      network: "testnet",
      signerId: OWNER,
      receiverId: TREASURY,
      actions: [{
        type: "FunctionCall",
        params: { methodName, args, gas: GAS, deposit: "0" }
      }]
    });
    $(statusId).textContent = "Wallet returned a response. Refreshing finalized state to verify the result. Do not submit again if verification is inconclusive.";
    await refresh();
    $(statusId).textContent += " Check the refreshed commitment list and financial position.";
  } catch (error) {
    $(statusId).textContent = "REQUEST RESULT UNCERTAIN — " + String(error.message || error) + ". Refresh finalized state before considering another attempt; do not blindly resubmit.";
  } finally {
    busy = false;
    const ready = accountId === OWNER && $("network-confirm").checked && Boolean(verifiedSnapshot);
    $("save").disabled = !ready;
    $("cancel").disabled = !ready;
  }
}

$("connect").addEventListener("click", async () => {
  $("connect").disabled = true;
  try {
    connector = new NearConnector({ network: "testnet", features: { testnet: true }, footerBranding: null });
    connector.on("wallet:signIn", event => {
      accountId = event?.accounts?.[0]?.accountId || "";
      $("wallet-account").textContent = accountId ? "Connected: " + accountId : "No account returned.";
      verifiedSnapshot = undefined;
      $("save").disabled = true;
      $("cancel").disabled = true;
    });
    connector.on("wallet:signOut", () => {
      accountId = "";
      verifiedSnapshot = undefined;
      $("wallet-account").textContent = "Disconnected";
      $("save").disabled = true;
      $("cancel").disabled = true;
    });
    await connector.connect();
    if (!accountId) {
      const accounts = await connector.getAccounts?.();
      accountId = accounts?.[0]?.accountId || "";
    }
    $("wallet-account").textContent = accountId ? "Connected: " + accountId : "Connected; account not returned.";
    if (accountId !== OWNER) $("wallet-account").textContent += " — owner account required for commitment management.";
  } catch (error) {
    $("wallet-account").textContent = "Connection failed: " + String(error.message || error);
  } finally {
    $("connect").disabled = false;
  }
});

$("refresh").addEventListener("click", refresh);
$("network-confirm").addEventListener("change", () => {
  $("save").disabled = true;
  $("cancel").disabled = true;
  if ($("network-confirm").checked && accountId === OWNER && verifiedSnapshot) {
    $("save").disabled = false;
    $("cancel").disabled = false;
  }
});

$("save").addEventListener("click", async () => {
  try {
    const id = $("commitment-id").value.trim();
    if (!id || new TextEncoder().encode(id).length > 64) throw new Error("Commitment ID must contain 1–64 UTF-8 bytes.");
    const recipient_id = validateAccount($("recipient").value.trim());
    const amount = parseAmount($("amount").value);
    const description = $("description").value.trim();
    if (new TextEncoder().encode(description).length > 256) throw new Error("Description must be at most 256 UTF-8 bytes.");
    const existing = verifiedSnapshot?.commitments.find(item => item.id === id);
    const methodName = existing ? "update_commitment" : "create_commitment";
    const args = { id, recipient_id, amount, description };
    if (existing && existing.settlement_pending) throw new Error("This commitment has a settlement pending and cannot be updated.");
    await sendCall(methodName, args, "save-status");
  } catch (error) {
    $("save-status").textContent = "NOT SENT — " + String(error.message || error);
  }
});

$("cancel").addEventListener("click", async () => {
  try {
    const id = $("cancel-id").value.trim();
    if (!id) throw new Error("Enter a commitment ID from the verified list.");
    const existing = verifiedSnapshot?.commitments.find(item => item.id === id);
    if (!existing) throw new Error("That commitment is not present in the latest verified snapshot.");
    if (existing.settlement_pending) throw new Error("This commitment has a settlement pending and cannot be cancelled.");
    await sendCall("cancel_commitment", { id }, "cancel-status");
  } catch (error) {
    $("cancel-status").textContent = "NOT SENT — " + String(error.message || error);
  }
});

void refresh();
