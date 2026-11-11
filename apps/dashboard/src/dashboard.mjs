export const TREASURY_ACCOUNT = "veltron-treasury.testnet";

export const RPC_URLS = [
  "https://rpc.testnet.fastnear.com",
  "https://near-testnet.drpc.org",
  "https://rpc.testnet.near.org"
];

export const VIEW_METHODS = Object.freeze([
  "get_financial_position",
  "get_pause_status",
  "get_commitments",
  "get_pending_transfers",
  "get_token_balance_audit"
]);

const VIEW_METHOD_SET = new Set(VIEW_METHODS);

function toBase64Utf8(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildViewRequest(methodName, args = {}, blockHash = null) {
  if (!VIEW_METHOD_SET.has(methodName)) {
    throw new Error("Dashboard only permits approved read-only contract methods.");
  }
  const params = {
    request_type: "call_function",
    account_id: TREASURY_ACCOUNT,
    method_name: methodName,
    args_base64: toBase64Utf8(args)
  };
  if (blockHash) params.block_id = blockHash;
  else params.finality = "final";
  return {
    jsonrpc: "2.0",
    id: "veltron-dashboard",
    method: "query",
    params
  };
}

export function decodeViewResult(resultBytes) {
  if (!Array.isArray(resultBytes)) throw new Error("Invalid NEAR view response.");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(resultBytes)));
}

export async function rpcRequest(method, params, fetchImpl = fetch, rpcUrl = null) {
  const urls = rpcUrl ? [rpcUrl] : RPC_URLS;
  let lastError;
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-dashboard", method, params })
      });
      if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message || "NEAR RPC error");
      return payload.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError?.message || "All NEAR Testnet RPC endpoints failed.");
}

async function selectFinalizedSnapshot(fetchImpl) {
  let lastError;
  for (const rpcUrl of RPC_URLS) {
    try {
      const status = await rpcRequest("status", [], fetchImpl, rpcUrl);
      if (status.chain_id !== "testnet") {
        throw new Error(`Wrong network: expected NEAR testnet, received ${status.chain_id || "unknown"}.`);
      }
      const block = await rpcRequest("block", { finality: "final" }, fetchImpl, rpcUrl);
      const blockHash = block?.header?.hash;
      if (!blockHash) throw new Error("RPC did not return a finalized block hash.");
      return { rpc_url: rpcUrl, block_hash: blockHash };
    } catch (error) {
      if (/Wrong network:/.test(error.message)) throw error;
      lastError = error;
    }
  }
  throw new Error(lastError?.message || "Could not establish a finalized NEAR Testnet snapshot.");
}

export async function callView(methodName, args = {}, fetchImpl = fetch, snapshot = null) {
  const request = buildViewRequest(methodName, args, snapshot?.block_hash || null);
  const result = await rpcRequest(request.method, request.params, fetchImpl, snapshot?.rpc_url || null);
  return decodeViewResult(result.result);
}

export async function readTreasurySnapshot(fetchImpl = fetch) {
  const snapshot = await selectFinalizedSnapshot(fetchImpl);
  const account = await rpcRequest("query", {
    request_type: "view_account",
    block_id: snapshot.block_hash,
    account_id: TREASURY_ACCOUNT
  }, fetchImpl, snapshot.rpc_url);

  const noCode = !account.code_hash || account.code_hash === "11111111111111111111111111111111";
  if (noCode) {
    return { deployed: false, account, network: "testnet", ...snapshot };
  }

  // Every read is pinned to the same provider and finalized block hash.
  const [position, paused, commitments, pending, audit] = await Promise.all([
    callView("get_financial_position", {}, fetchImpl, snapshot),
    callView("get_pause_status", {}, fetchImpl, snapshot),
    callView("get_commitments", { from_id: null, limit: 50 }, fetchImpl, snapshot),
    callView("get_pending_transfers", {}, fetchImpl, snapshot),
    callView("get_token_balance_audit", {}, fetchImpl, snapshot)
  ]);

  return {
    deployed: true,
    network: "testnet",
    account,
    position,
    paused,
    commitments,
    pending,
    audit,
    ...snapshot
  };
}
