#!/usr/bin/env python3
"""Read-only verification of the VELTRON treasury Testnet deployment.

Verifies both sides of the pre-upgrade boundary: finalized on-chain code must match the recorded previous build, and local WASM must match the reviewed new build. This is a pre-deployment check, not a post-deploy code-match check. It never signs or submits transactions.
"""
import base64
import hashlib
import json
import pathlib
import urllib.error
import urllib.request

RPC = "https://rpc.testnet.near.org"
ACCOUNT = "veltron-treasury.testnet"
WASM = pathlib.Path("target/wasm32-unknown-unknown/release/veltron_treasury.wasm")
EXPECTED_NEW_SHA256 = "a70d8aea3538fd177859fdb7e31b8c1c1e7a982de24d76dbdcf4d88b006d2aca"
EXPECTED_NEW_BYTES = 339_256
EXPECTED_EXISTING_SHA256 = "66d3d95d8b4f7142cb47062051a93158994236a3791d83e994946af3dd5525af"


def rpc(method, params, request_id):
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    }).encode()
    request = urllib.request.Request(
        RPC, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read())
    except urllib.error.URLError as exc:
        raise RuntimeError(f"NEAR Testnet RPC unavailable: {exc}") from exc
    if "error" in payload:
        raise RuntimeError(f"{method} RPC error: {payload['error']}")
    return payload["result"]


if not WASM.is_file():
    raise SystemExit(f"FAIL: expected locally built treasury WASM not found: {WASM}")

local_bytes = WASM.read_bytes()
local_hash = hashlib.sha256(local_bytes).hexdigest()
if len(local_bytes) != EXPECTED_NEW_BYTES or local_hash != EXPECTED_NEW_SHA256:
    raise SystemExit(
        f"FAIL: local treasury WASM is not the reviewed new artifact "
        f"(bytes={len(local_bytes)}, sha256={local_hash})."
    )

print("VELTRON TREASURY READ-ONLY TESTNET DEPLOYMENT CHECK")
print(f"RPC endpoint: {RPC}")
print(f"Treasury account: {ACCOUNT}")
print(f"Local treasury WASM bytes: {len(local_bytes)}")
print(f"Local treasury WASM SHA-256: {local_hash}")

status = rpc("status", [], "network-status")
chain_id = status.get("chain_id")
print(f"RPC chain ID: {chain_id}")
if chain_id != "testnet":
    raise SystemExit("FAIL: RPC endpoint did not identify itself as NEAR testnet.")

account = rpc("query", {
    "request_type": "view_account",
    "finality": "final",
    "account_id": ACCOUNT,
}, "treasury-account")
print(f"Finalized account balance: {account.get('amount')} yoctoNEAR")
print(f"Finalized storage usage: {account.get('storage_usage')} bytes")
print(f"Finalized account code hash: {account.get('code_hash')}")

try:
    code = rpc("query", {
        "request_type": "view_code",
        "finality": "final",
        "account_id": ACCOUNT,
    }, "treasury-view-code")
except RuntimeError as exc:
    message = str(exc).lower()
    if "contract code" in message or "code not found" in message:
        print("TREASURY DEPLOYMENT STATUS: NO CONTRACT CODE FOUND")
        print("No transaction was constructed, signed, or submitted.")
        raise SystemExit(0)
    raise

code_b64 = code.get("code_base64", "")
if not code_b64:
    print("TREASURY DEPLOYMENT STATUS: NO CONTRACT CODE FOUND")
    print("No transaction was constructed, signed, or submitted.")
    raise SystemExit(0)

deployed_bytes = base64.b64decode(code_b64)
deployed_hash = hashlib.sha256(deployed_bytes).hexdigest()
print(f"On-chain treasury WASM bytes: {len(deployed_bytes)}")
print(f"On-chain treasury WASM SHA-256: {deployed_hash}")

if deployed_hash != EXPECTED_EXISTING_SHA256:
    print("TREASURY DEPLOYMENT STATUS: UNKNOWN OR UNREVIEWED CODE")
    raise SystemExit("FAIL: on-chain treasury is not the recorded pre-upgrade version. Stop and investigate.")

print("TREASURY DEPLOYMENT STATUS: VERIFIED PRE-UPGRADE CODE")
print("The existing finalized treasury matches the recorded previous build.")
print("The local treasury WASM matches the reviewed new build.")
print("READY FOR DEPLOYMENT REVIEW ONLY — the new build is NOT deployed.")
print("This check does not authorize deployment or prove post-upgrade safety.")
print("No transaction was constructed, signed, or submitted.")
