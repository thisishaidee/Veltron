#!/usr/bin/env python3
"""Read-only verification of the initialized VELTRON treasury on NEAR Testnet.

Accepts both pre-registration and post-registration VTT storage states. Before deployment, the treasury hash must match the recorded previous build so its initialized state can be inspected safely. The new build is verified separately by the treasury artifact preflight. Never signs or submits a transaction.
"""
import base64
import hashlib
import json
import urllib.request

RPC = "https://rpc.testnet.near.org"
TREASURY = "veltron-treasury.testnet"
TOKEN = "veltron-token.testnet"
TREASURY_SHA256 = "3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36"
TOKEN_SHA256 = "5d5041336cc8fc92cc9ca11fff1f0b1f7ead33c4826c6d12013f957ba1e7c95b"
EXPECTED_RESERVE = "200000000"
EXPECTED_STORAGE_MIN = "1250000000000000000000"


def rpc(method, params, request_id):
    body = json.dumps({
        "jsonrpc": "2.0", "id": request_id, "method": method, "params": params
    }).encode()
    request = urllib.request.Request(
        RPC, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read())
    if "error" in payload:
        raise RuntimeError(f"{method} RPC error: {payload['error']}")
    return payload["result"]


def view(account_id, method, args=None):
    encoded = base64.b64encode(
        json.dumps(args or {}, separators=(",", ":")).encode()
    ).decode()
    result = rpc("query", {
        "request_type": "call_function",
        "finality": "final",
        "account_id": account_id,
        "method_name": method,
        "args_base64": encoded,
    }, method)
    return json.loads(bytes(result["result"]).decode())


print("VELTRON INITIALIZED TREASURY PREFLIGHT — READ ONLY")
status = rpc("status", [], "network-status")
if status.get("chain_id") != "testnet":
    raise SystemExit("FAIL: RPC endpoint is not NEAR Testnet.")
block = rpc("block", {"finality": "final"}, "final-block")
print(f"Finalized Testnet block: {block['header']['height']} ({block['header']['hash']})")

for account_id, expected_hash in ((TREASURY, TREASURY_SHA256), (TOKEN, TOKEN_SHA256)):
    code = rpc("query", {
        "request_type": "view_code", "finality": "final", "account_id": account_id
    }, f"code-{account_id}")
    actual_hash = hashlib.sha256(base64.b64decode(code["code_base64"])).hexdigest()
    print(f"{account_id} deployed SHA-256: {actual_hash}")
    if actual_hash != expected_hash:
        raise SystemExit(f"FAIL: deployed code hash mismatch for {account_id}.")

metadata = view(TOKEN, "ft_metadata")
if metadata.get("symbol") != "VTT" or metadata.get("decimals") != 6:
    raise SystemExit(f"FAIL: unexpected VTT metadata: {metadata}")
bounds = view(TOKEN, "storage_balance_bounds")
if bounds.get("min") != EXPECTED_STORAGE_MIN or bounds.get("max") != EXPECTED_STORAGE_MIN:
    raise SystemExit(f"FAIL: unexpected VTT storage bounds: {bounds}")
storage = view(TOKEN, "storage_balance_of", {"account_id": TREASURY})
if storage is None:
    registration = "NOT YET REGISTERED (expected before registration transaction)"
else:
    total = int(storage.get("total", "0"))
    if total < int(EXPECTED_STORAGE_MIN):
        raise SystemExit(f"FAIL: treasury storage registration is underfunded: {storage}")
    registration = f"REGISTERED with {total} yoctoNEAR"

position = view(TREASURY, "get_financial_position")
if position.get("safety_reserve") != EXPECTED_RESERVE:
    raise SystemExit(f"FAIL: safety reserve mismatch: {position}")
for field in ("treasury_balance", "active_commitments", "pending_discretionary", "spendable_balance"):
    try:
        if int(position[field]) < 0:
            raise ValueError("negative")
    except (KeyError, TypeError, ValueError):
        raise SystemExit(f"FAIL: invalid financial-position field {field}: {position}")

paused = view(TREASURY, "get_pause_status")
if not isinstance(paused, bool):
    raise SystemExit(f"FAIL: pause status is not boolean: {paused}")
commitments = view(TREASURY, "get_commitments")
if not isinstance(commitments.get("commitments"), list):
    raise SystemExit(f"FAIL: malformed commitments response: {commitments}")
pending = view(TREASURY, "get_pending_transfers")
if not isinstance(pending, list):
    raise SystemExit(f"FAIL: malformed pending-transfers response: {pending}")
audit = view(TREASURY, "get_token_balance_audit")
if not isinstance(audit.get("audit_pending"), bool):
    raise SystemExit(f"FAIL: malformed token-balance audit response: {audit}")

print("VTT metadata:", json.dumps(metadata, sort_keys=True))
print("Treasury VTT storage:", registration)
print("Treasury financial position:", json.dumps(position, sort_keys=True))
print("Treasury paused:", paused)
print("Commitments returned:", len(commitments["commitments"]))
print("Pending transfers returned:", len(pending))
print("Token-balance audit:", json.dumps(audit, sort_keys=True))
print("PASS: existing pre-upgrade treasury and VTT state are readable and structurally valid.")
print("The reviewed new treasury artifact is not asserted to be deployed by this check.")
print("This check verifies read-only state; it does not authorize deposits or token transfers.")
print("No transaction was constructed, signed, or submitted.")
