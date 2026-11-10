export const TREASURY_ACCOUNT = "veltron-treasury.testnet";
export const TOKEN_ACCOUNT = "veltron-token.testnet";
export const EXPECTED_TOKEN_SYMBOL = "VTT";
export const EXPECTED_TOKEN_DECIMALS = 6;

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

export function buildViewRequest(methodName, args = {}) {
  if (!VIEW_METHOD_SET.has(methodName)) {
    throw new Error("Dashboard only permits approved read-only contract methods.");
  }
  return {
    jsonrpc: "2.0",
    id: "veltron-dashboard",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: TREASURY_ACCOUNT,
      method_name: methodName,
      args_base64: toBase64Utf8(args)
    }
  };
}

export function decodeViewResult(resultBytes) {
  if (!Array.isArray(resultBytes)) throw new Error("Invalid NEAR view response.");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(resultBytes)));
}

export function formatTokenAmount(rawValue, decimals) {
  if (rawValue == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 24) {
    throw new Error("Invalid token amount or decimals.");
  }
  const value = BigInt(rawValue);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = absolute % scale;
  const groupedWhole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(whole);
  if (decimals === 0 || fraction === 0n) return (negative ? "-" : "") + groupedWhole;
  const fractionalText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + groupedWhole + "." + fractionalText;
}

export async function rpcRequest(method, params, fetchImpl = fetch) {
  let lastError;
  for (const url of RPC_URLS) {
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

export async function callView(methodName, args = {}, fetchImpl = fetch) {
  const request = buildViewRequest(methodName, args);
  const result = await rpcRequest(request.method, request.params, fetchImpl);
  return decodeViewResult(result.result);
}

export async function readTokenMetadata(fetchImpl = fetch) {
  const result = await rpcRequest("query", {
    request_type: "call_function",
    finality: "final",
    account_id: TOKEN_ACCOUNT,
    method_name: "ft_metadata",
    args_base64: toBase64Utf8({})
  }, fetchImpl);
  const metadata = decodeViewResult(result.result);
  if (metadata.symbol !== EXPECTED_TOKEN_SYMBOL || metadata.decimals !== EXPECTED_TOKEN_DECIMALS) {
    throw new Error("Unexpected VELTRON token metadata. Expected VTT with 6 decimals; refusing to format balances.");
  }
  return metadata;
}

export async function readTreasurySnapshot(fetchImpl = fetch) {
  const status = await rpcRequest("status", [], fetchImpl);
  if (status.chain_id !== "testnet") {
    throw new Error(`Wrong network: expected NEAR testnet, received ${status.chain_id || "unknown"}.`);
  }

  const account = await rpcRequest("query", {
    request_type: "view_account",
    finality: "final",
    account_id: TREASURY_ACCOUNT
  }, fetchImpl);

  const noCode = !account.code_hash || account.code_hash === "11111111111111111111111111111111";
  if (noCode) {
    return { deployed: false, account, network: status.chain_id };
  }

  const [position, paused, commitments, pending, audit, tokenMetadata] = await Promise.all([
    callView("get_financial_position", {}, fetchImpl),
    callView("get_pause_status", {}, fetchImpl),
    callView("get_commitments", { from_id: null, limit: 50 }, fetchImpl),
    callView("get_pending_transfers", {}, fetchImpl),
    callView("get_token_balance_audit", {}, fetchImpl),
    readTokenMetadata(fetchImpl)
  ]);

  return {
    deployed: true,
    network: status.chain_id,
    account,
    position,
    paused,
    commitments,
    pending,
    audit,
    tokenMetadata
  };
}
