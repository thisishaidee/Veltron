#!/usr/bin/env python3
"""Independent, read-only VELTRON Testnet verification through two NEAR RPC providers."""
import base64
import hashlib
import json
import urllib.error
import urllib.request

RPCS = {
    "NEAR": "https://rpc.testnet.near.org",
    "FastNear": "https://rpc.testnet.fastnear.com",
}
TOKEN = "veltron-token.testnet"
TREASURY = "veltron-treasury.testnet"
OWNER = "haideedotxyz.testnet"
AGENT = "veltron-agent.testnet"
TOKEN_SHA256 = "5d5041336cc8fc92cc9ca11fff1f0b1f7ead33c4826c6d12013f957ba1e7c95b"
TREASURY_SHA256 = "3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36"
EXPECTED_SUPPLY = "1000000000000"
EXPECTED_OWNER = "999980000000"
EXPECTED_AGENT = "20000000"


def rpc(endpoint, method, params, request_id):
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}).encode()
    request = urllib.request.Request(endpoint, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read())
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"{endpoint} unavailable for {method}: {exc}") from exc
    if "error" in payload:
        raise RuntimeError(f"{endpoint} {method} RPC error: {payload['error']}")
    return payload["result"]


def query(endpoint, request_type, account_id, **extra):
    return rpc(endpoint, "query", {"request_type": request_type, "finality": "final", "account_id": account_id, **extra}, request_type)


def view(endpoint, account_id, method, args=None):
    encoded = base64.b64encode(json.dumps(args or {}, separators=(",", ":")).encode()).decode()
    result = query(endpoint, "call_function", account_id, method_name=method, args_base64=encoded)
    return json.loads(bytes(result["result"]).decode())


def verify(provider, endpoint):
    status = rpc(endpoint, "status", [], "status")
    if status.get("chain_id") != "testnet":
        raise RuntimeError(f"{provider}: endpoint is not NEAR Testnet")
    block = rpc(endpoint, "block", {"finality": "final"}, "final-block")
    print(f"{provider} finalized block: {block['header']['height']} {block['header']['hash']}")

    token_code = query(endpoint, "view_code", TOKEN)
    token_hash = hashlib.sha256(base64.b64decode(token_code["code_base64"])).hexdigest()
    if token_hash != TOKEN_SHA256:
        raise RuntimeError(f"{provider}: VTT deployed code hash mismatch: {token_hash}")

    metadata = view(endpoint, TOKEN, "ft_metadata")
    supply = view(endpoint, TOKEN, "ft_total_supply")
    owner = view(endpoint, TOKEN, "ft_balance_of", {"account_id": OWNER})
    agent = view(endpoint, TOKEN, "ft_balance_of", {"account_id": AGENT})
    treasury_storage = view(endpoint, TOKEN, "storage_balance_of", {"account_id": TREASURY})
    storage_bounds = view(endpoint, TOKEN, "storage_balance_bounds")

    if metadata.get("symbol") != "VTT" or metadata.get("decimals") != 6:
        raise RuntimeError(f"{provider}: unexpected VTT metadata: {metadata}")
    if (supply, owner, agent) != (EXPECTED_SUPPLY, EXPECTED_OWNER, EXPECTED_AGENT):
        raise RuntimeError(f"{provider}: VTT supply/balances mismatch: {supply}, {owner}, {agent}")
    if treasury_storage is not None:
        raise RuntimeError(f"{provider}: treasury unexpectedly already registered: {treasury_storage}")
    if storage_bounds.get("min") != "1250000000000000000000":
        raise RuntimeError(f"{provider}: unexpected token storage minimum: {storage_bounds}")

    treasury_account = query(endpoint, "view_account", TREASURY)
    try:
        treasury_code = query(endpoint, "view_code", TREASURY)
        code_b64 = treasury_code.get("code_base64", "")
    except RuntimeError as exc:
        if "contract code" not in str(exc).lower() and "code not found" not in str(exc).lower():
            raise
        code_b64 = ""
    if code_b64:
        treasury_hash = hashlib.sha256(base64.b64decode(code_b64)).hexdigest()
        if treasury_hash != TREASURY_SHA256:
            raise RuntimeError(f"{provider}: treasury has unexpected code hash {treasury_hash}")
        treasury_status = "EXPECTED CODE PRESENT"
    else:
        treasury_status = "NO CONTRACT CODE"

    result = {
        "token_hash": token_hash,
        "metadata": metadata,
        "supply": supply,
        "owner": owner,
        "agent": agent,
        "treasury_storage": treasury_storage,
        "storage_bounds": storage_bounds,
        "treasury_balance": treasury_account.get("amount"),
        "treasury_storage_usage": treasury_account.get("storage_usage"),
        "treasury_code": treasury_status,
    }
    print(f"{provider} verified state: " + json.dumps(result, sort_keys=True))
    return result


print("VELTRON DUAL-RPC FINALIZED TESTNET VERIFICATION — READ ONLY")
results = {name: verify(name, url) for name, url in RPCS.items()}
if results["NEAR"] != results["FastNear"]:
    raise SystemExit("FAIL: independent RPC providers returned different finalized account/contract state.")
print("PASS: NEAR and FastNear agree on finalized VTT and treasury state.")
print("No transaction was constructed, signed, or submitted.")
