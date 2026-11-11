#!/usr/bin/env python3
"""Snapshot and verify VELTRON treasury state around one reviewed Testnet code upgrade."""
import argparse
import base64
import hashlib
import json
import urllib.request

RPCS = {
    "near": "https://rpc.testnet.near.org",
    "fastnear": "https://rpc.testnet.fastnear.com",
}
TREASURY = "veltron-treasury.testnet"
TOKEN = "veltron-token.testnet"
OWNER = "haideedotxyz.testnet"
AGENT = "veltron-agent.testnet"
OLD_TREASURY_SHA256 = "66d3d95d8b4f7142cb47062051a93158994236a3791d83e994946af3dd5525af"
NEW_TREASURY_SHA256 = "a70d8aea3538fd177859fdb7e31b8c1c1e7a982de24d76dbdcf4d88b006d2aca"
TOKEN_SHA256 = "5d5041336cc8fc92cc9ca11fff1f0b1f7ead33c4826c6d12013f957ba1e7c95b"


def rpc(endpoint, method, params, request_id):
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}).encode()
    req = urllib.request.Request(endpoint, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read())
    if "error" in payload:
        raise RuntimeError(f"{method} RPC error from {endpoint}: {payload['error']}")
    return payload["result"]


def query(endpoint, request_type, account_id, **extra):
    return rpc(endpoint, "query", {"request_type": request_type, "finality": "final", "account_id": account_id, **extra}, request_type)


def view(endpoint, account_id, method, args=None):
    encoded = base64.b64encode(json.dumps(args or {}, separators=(",", ":")).encode()).decode()
    result = query(endpoint, "call_function", account_id, method_name=method, args_base64=encoded)
    return json.loads(bytes(result["result"]).decode())


def snapshot(provider, endpoint, expected_treasury_hash):
    status = rpc(endpoint, "status", [], "status")
    if status.get("chain_id") != "testnet":
        raise RuntimeError(f"{provider}: RPC endpoint is not NEAR Testnet")
    treasury_code = query(endpoint, "view_code", TREASURY)
    treasury_hash = hashlib.sha256(base64.b64decode(treasury_code["code_base64"])).hexdigest()
    if treasury_hash != expected_treasury_hash:
        raise RuntimeError(f"{provider}: treasury code hash mismatch: {treasury_hash}")
    token_code = query(endpoint, "view_code", TOKEN)
    token_hash = hashlib.sha256(base64.b64decode(token_code["code_base64"])).hexdigest()
    if token_hash != TOKEN_SHA256:
        raise RuntimeError(f"{provider}: VTT contract code hash mismatch: {token_hash}")

    state = {
        "financial_position": view(endpoint, TREASURY, "get_financial_position"),
        "paused": view(endpoint, TREASURY, "get_pause_status"),
        "commitments": view(endpoint, TREASURY, "get_commitments", {"from_id": None, "limit": 50}),
        "pending_transfers": view(endpoint, TREASURY, "get_pending_transfers"),
        "token_audit": view(endpoint, TREASURY, "get_token_balance_audit"),
        "token_metadata": view(endpoint, TOKEN, "ft_metadata"),
        "treasury_token_balance": view(endpoint, TOKEN, "ft_balance_of", {"account_id": TREASURY}),
        "treasury_token_storage": view(endpoint, TOKEN, "storage_balance_of", {"account_id": TREASURY}),
    }
    if expected_treasury_hash == NEW_TREASURY_SHA256:
        state["owner"] = view(endpoint, TREASURY, "get_owner")
        state["agent_config"] = view(endpoint, TREASURY, "get_agent_config")
        if state["owner"] != OWNER:
            raise RuntimeError(f"{provider}: configured treasury owner changed: {state['owner']}")
        if state["agent_config"].get("agent_id") != AGENT:
            raise RuntimeError(f"{provider}: configured agent changed: {state['agent_config']}")
    if not isinstance(state["financial_position"], dict) or not isinstance(state["paused"], bool):
        raise RuntimeError(f"{provider}: treasury state response has unexpected shape")
    return {"treasury_hash": treasury_hash, "token_hash": token_hash, "state": state}


parser = argparse.ArgumentParser()
parser.add_argument("--mode", choices=["snapshot", "verify"], required=True)
parser.add_argument("--snapshot", required=True)
args = parser.parse_args()

expected = OLD_TREASURY_SHA256 if args.mode == "snapshot" else NEW_TREASURY_SHA256
results = {name: snapshot(name, url, expected) for name, url in RPCS.items()}
if results["near"] != results["fastnear"]:
    raise SystemExit("FAIL: independent RPC providers disagree on finalized code or treasury state")

if args.mode == "snapshot":
    with open(args.snapshot, "w", encoding="utf-8") as f:
        json.dump(results["near"], f, sort_keys=True)
    print("PASS: pre-upgrade treasury state snapshot captured from two agreeing Testnet RPC providers.")
else:
    with open(args.snapshot, "r", encoding="utf-8") as f:
        before = json.load(f)
    after = results["near"]["state"]
    for field, old_value in before["state"].items():
        if after.get(field) != old_value:
            raise SystemExit(f"FAIL: treasury/VTT state field changed during code upgrade: {field}")
    if after.get("owner") != OWNER or after.get("agent_config", {}).get("agent_id") != AGENT:
        raise SystemExit("FAIL: newly exposed owner or agent configuration does not match the expected initialized accounts.")
    print("PASS: new treasury WASM hash verified through both RPCs.")
    print("PASS: pre-existing financial position, pause state, commitments, pending transfers, token audit, VTT metadata, treasury token balance, and storage registration are unchanged.")
    print("PASS: newly exposed owner and agent configuration match the expected initialized accounts.")
print("No additional transaction was constructed, signed, or submitted by this verifier.")
