const RPCS = [
  { name: "NEAR Public RPC", url: "https://rpc.testnet.near.org" },
  { name: "FastNEAR", url: "https://rpc.testnet.fastnear.com" }
];
const TREASURY = "veltron-treasury.testnet";
const EXPECTED_OWNER = "haideedotxyz.testnet";
const EXPECTED_AGENT = "veltron-agent.testnet";
const $ = (id) => document.getElementById(id);

async function rpc(endpoint, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-dashboard-readonly", method, params }),
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || "HTTP " + response.status);
    }
    if (!payload.result) throw new Error("RPC response did not include a result.");
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function view(endpoint, method) {
  const result = await rpc(endpoint, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: TREASURY,
    method_name: method,
    args_base64: ""
  });
  if (!Array.isArray(result.result)) throw new Error(method + " returned invalid view data.");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

async function readProvider(endpoint) {
  const network = await rpc(endpoint, "status", []);
  if (network.chain_id !== "testnet") throw new Error(endpoint.name + " did not confirm NEAR Testnet.");
  const [owner, agentConfig, paused] = await Promise.all([
    view(endpoint, "get_owner"),
    view(endpoint, "get_agent_config"),
    view(endpoint, "get_pause_status")
  ]);
  if (typeof owner !== "string" || !agentConfig || typeof agentConfig !== "object" ||
      typeof agentConfig.agent_id !== "string" || paused !== true && paused !== false) {
    throw new Error(endpoint.name + " returned an invalid treasury configuration.");
  }
  let cap;
  try { cap = BigInt(agentConfig.max_per_transaction); }
  catch { throw new Error(endpoint.name + " returned an invalid transaction cap."); }
  if (cap < 0n) throw new Error(endpoint.name + " returned a negative transaction cap.");
  return { owner, agent_id: agentConfig.agent_id, max_per_transaction: cap.toString(), paused };
}

function clearValues() {
  for (const id of ["live-owner", "live-agent", "live-cap", "live-paused", "live-updated"]) {
    $(id).textContent = "Unavailable — refresh required";
  }
}

async function refresh() {
  const button = $("refresh-treasury-config");
  const status = $("treasury-config-status");
  button.disabled = true;
  status.textContent = "Reading finalized treasury views from two independent NEAR Testnet RPCs…";
  clearValues();
  try {
    const snapshots = await Promise.all(RPCS.map(readProvider));
    if (JSON.stringify(snapshots[0]) !== JSON.stringify(snapshots[1])) {
      throw new Error("The two independent RPC providers disagree. Values are withheld.");
    }
    const state = snapshots[0];
    if (state.owner !== EXPECTED_OWNER || state.agent_id !== EXPECTED_AGENT || state.paused !== true) {
      throw new Error("The live configuration differs from the reviewed VELTRON safety configuration. Values are withheld.");
    }
    $("live-owner").textContent = state.owner;
    $("live-agent").textContent = state.agent_id;
    $("live-cap").textContent = BigInt(state.max_per_transaction).toLocaleString("en-US") + " base units (50 VTT at 6 decimals)";
    $("live-paused").textContent = "YES — treasury paused";
    $("live-updated").textContent = new Date().toISOString();
    status.textContent = "VERIFIED — both independent RPCs agree on finalized read-only contract views. No wallet, signing, or transaction was used.";
  } catch (error) {
    clearValues();
    status.textContent = "CONFIGURATION NOT VERIFIED — " + String(error?.message || error) + " No wallet, signing, or transaction was used.";
  } finally {
    button.disabled = false;
  }
}

$("refresh-treasury-config").addEventListener("click", refresh);
void refresh();
