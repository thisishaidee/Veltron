#!/usr/bin/env python3
"""Read-only verification of the deployed VELTRON Testnet token; never signs or submits transactions."""
import base64
import hashlib
import json
import urllib.request

RPC = "https://rpc.testnet.near.org"
ACCOUNT = "veltron-token.testnet"
EXPECTED_SHA256 = "5d5041336cc8fc92cc9ca11fff1f0b1f7ead33c4826c6d12013f957ba1e7c95b"
OWNER = "haideedotxyz.testnet"
AGENT = "veltron-agent.testnet"
EXPECTED_SUPPLY = "1000000000000"
EXPECTED_OWNER_BALANCE = "999980000000"
EXPECTED_AGENT_BALANCE = "20000000"


def rpc(method, params, request_id):
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    }).encode()
    request = urllib.request.Request(
        RPC, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read())
    if "error" in payload:
        raise RuntimeError(f"{method} RPC error: {payload['error']}")
    return payload["result"]


block = rpc("block", {"finality": "final"}, "final-block")
height = block["header"]["height"]
print("VELTRON TOKEN READ-ONLY TESTNET STATE CHECK")
print(f"Finalized block: {height} ({block['header']['hash']})")
print(f"Contract: {ACCOUNT}")

code = rpc("query", {
    "request_type": "view_code",
    "finality": "final",
    "account_id": ACCOUNT,
}, "view-code")
wasm = base64.b64decode(code["code_base64"])
actual_hash = hashlib.sha256(wasm).hexdigest()
print(f"Deployed WASM bytes: {len(wasm)}")
print(f"On-chain WASM SHA-256: {actual_hash}")
print(f"Expected WASM SHA-256: {EXPECTED_SHA256}")
if actual_hash != EXPECTED_SHA256:
    raise SystemExit("FAIL: deployed token code does not match the reviewed artifact.")
print("PASS: deployed token code matches the reviewed artifact.")

# NEAR SDK persists contract state under the exact storage key b"STATE".
state = rpc("query", {
    "request_type": "view_state",
    "finality": "final",
    "account_id": ACCOUNT,
    "prefix_base64": base64.b64encode(b"STATE").decode(),
    "include_proof": False,
}, "view-state")
if not state.get("values"):
    print("LIVE TOKEN STATE: NOT INITIALIZED")
    print("No contract state was found under the NEAR SDK STATE key.")
    print("No transaction was constructed, signed, or submitted.")
    raise SystemExit(0)


def view(method, args):
    return rpc("query", {
        "request_type": "call_function",
        "finality": "final",
        "account_id": ACCOUNT,
        "method_name": method,
        "args_base64": base64.b64encode(json.dumps(args, separators=(",", ":")).encode()).decode(),
    }, method)


metadata = json.loads(bytes(view("ft_metadata", {})["result"]).decode())
supply = json.loads(bytes(view("ft_total_supply", {})["result"]).decode())
owner_balance = json.loads(bytes(view("ft_balance_of", {"account_id": OWNER})["result"]).decode())
agent_balance = json.loads(bytes(view("ft_balance_of", {"account_id": AGENT})["result"]).decode())
print("LIVE TOKEN STATE: INITIALIZED")
print("Metadata:", json.dumps(metadata, sort_keys=True))
print("Total supply (raw units):", supply)
print(f"Owner balance for {OWNER} (raw units):", owner_balance)
print(f"Agent balance for {AGENT} (raw units):", agent_balance)

if metadata.get("symbol") != "VTT" or metadata.get("decimals") != 6:
    raise SystemExit("FAIL: initialized token metadata differs from the planned VTT configuration.")
if (
    supply != EXPECTED_SUPPLY
    or owner_balance != EXPECTED_OWNER_BALANCE
    or agent_balance != EXPECTED_AGENT_BALANCE
    or int(owner_balance) + int(agent_balance) != int(supply)
):
    raise SystemExit("FAIL: finalized VTT supply distribution differs from the two verified test transfers.")
print("PASS: VTT metadata, total supply, and owner/agent balances match the verified testnet transfers.")
print("No transaction was constructed, signed, or submitted.")
