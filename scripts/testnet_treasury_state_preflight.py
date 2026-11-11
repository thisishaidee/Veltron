#!/usr/bin/env python3
"""Read-only verification of the VELTRON treasury Testnet deployment.

Verifies that finalized Testnet still runs the exact known deployed base
artifact, while separately identifying the proposed upgrade artifact built
from this checkout. This script never signs or submits transactions.
"""
import base64
import hashlib
import json
import os
import pathlib
import urllib.error
import urllib.request

RPC = "https://rpc.testnet.near.org"
ACCOUNT = "veltron-treasury.testnet"
WASM = pathlib.Path("target/wasm32-unknown-unknown/release/veltron_treasury.wasm")
BASE_WASM_ENV = "VELTRON_BASE_TREASURY_WASM"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
    raise SystemExit(f"FAIL: proposed treasury WASM not found: {WASM}")

base_wasm_value = os.environ.get(BASE_WASM_ENV)
if not base_wasm_value:
    raise SystemExit(f"FAIL: {BASE_WASM_ENV} is required; refusing to guess the deployed baseline.")
BASE_WASM = pathlib.Path(base_wasm_value)
if not BASE_WASM.is_file():
    raise SystemExit(f"FAIL: exact deployed base WASM not found: {BASE_WASM}")

candidate_hash = sha256(WASM)
base_hash = sha256(BASE_WASM)

print("VELTRON TREASURY READ-ONLY TESTNET DEPLOYMENT CHECK")
print(f"RPC endpoint: {RPC}")
print(f"Treasury account: {ACCOUNT}")
print(f"Proposed upgrade WASM bytes: {WASM.stat().st_size}")
print(f"Proposed upgrade WASM SHA-256: {candidate_hash}")
print(f"Known deployed base WASM bytes: {BASE_WASM.stat().st_size}")
print(f"Known deployed base WASM SHA-256: {base_hash}")

if candidate_hash == base_hash:
    raise SystemExit("FAIL: proposed artifact is identical to the base artifact; expected upgrade difference is absent.")

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
        raise SystemExit("FAIL: no treasury contract code found on Testnet; expected deployed baseline is absent.")
    raise

code_b64 = code.get("code_base64", "")
if not code_b64:
    raise SystemExit("FAIL: Testnet returned no treasury contract code; expected deployed baseline is absent.")

deployed_bytes = base64.b64decode(code_b64)
deployed_hash = hashlib.sha256(deployed_bytes).hexdigest()
print(f"On-chain treasury WASM bytes: {len(deployed_bytes)}")
print(f"On-chain treasury WASM SHA-256: {deployed_hash}")

if deployed_hash != base_hash:
    print("TREASURY DEPLOYMENT STATUS: LIVE CODE DOES NOT MATCH THE KNOWN DEPLOYED BASE")
    raise SystemExit("FAIL: stop; the live contract differs from the pinned baseline. Investigate before any upgrade.")

print("TREASURY DEPLOYMENT STATUS: KNOWN BASELINE VERIFIED")
print("Finalized Testnet code matches the exact pinned base artifact.")
print("The proposed upgrade artifact is different and is not deployed by this check.")
print("This verifies code identity only; it does not authorize deployment or prove initialization state.")
print("No transaction was constructed, signed, or submitted.")
