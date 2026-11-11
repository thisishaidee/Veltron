#!/usr/bin/env python3
"""Read-only treasury-specific NEAR Testnet deployment cost preflight.

Reads finalized Testnet protocol parameters, treasury account state, and VTT
storage bounds. It never constructs, signs, or submits a transaction.
"""
import base64
import hashlib
import json
import urllib.request
from pathlib import Path

RPC = "https://rpc.testnet.near.org"
TREASURY = "veltron-treasury.testnet"
TOKEN = "veltron-token.testnet"
TREASURY_WASM_BYTES = 339_256
EXPECTED_TREASURY_SHA256 = "a70d8aea3538fd177859fdb7e31b8c1c1e7a982de24d76dbdcf4d88b006d2aca"
EXPECTED_EXISTING_TREASURY_SHA256 = "66d3d95d8b4f7142cb47062051a93158994236a3791d83e994946af3dd5525af"
EXPECTED_EXISTING_TREASURY_BYTES = 338_235
YOCTO = 10**24


def rpc(method, params, request_id):
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}).encode()
    request = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read())
    if "error" in payload:
        raise RuntimeError(f"{method} RPC error: {payload['error']}")
    return payload["result"]


def view(account_id, method, args=None):
    encoded = base64.b64encode(json.dumps(args or {}, separators=(",", ":")).encode()).decode()
    result = rpc("query", {
        "request_type": "call_function",
        "finality": "final",
        "account_id": account_id,
        "method_name": method,
        "args_base64": encoded,
    }, method)
    return json.loads(bytes(result["result"]).decode())


status = rpc("status", [], "status")
if status.get("chain_id") != "testnet":
    raise SystemExit("FAIL: configured RPC endpoint is not NEAR Testnet")

block = rpc("block", {"finality": "final"}, "final-block")
height = block["header"]["height"]
gas_price = int(block["header"]["gas_price"])
config = rpc("EXPERIMENTAL_protocol_config", {"block_id": height}, "protocol-config")
runtime = config["runtime_config"]
costs = runtime["transaction_costs"]
action = costs["action_creation_config"]
deploy_base = action["deploy_contract_cost"]
deploy_per_byte = action["deploy_contract_cost_per_byte"]
deploy_send_gas = int(deploy_base["send_sir"]) + TREASURY_WASM_BYTES * int(deploy_per_byte["send_sir"])
deploy_exec_gas = int(deploy_base["execution"]) + TREASURY_WASM_BYTES * int(deploy_per_byte["execution"])
receipt = costs["action_receipt_creation_config"]
receipt_send_gas = int(receipt["send_sir"])
receipt_exec_gas = int(receipt["execution"])
send_gas = deploy_send_gas + receipt_send_gas
execution_gas = deploy_exec_gas + receipt_exec_gas
if "min_gas_purchase_price" not in runtime:
    raise SystemExit("FAIL: runtime_config omitted min_gas_purchase_price; refusing to understate the execution fee.")
min_gas_purchase_price = int(runtime["min_gas_purchase_price"])
receipt_gas_price = max(gas_price, min_gas_purchase_price)
send_fee_yocto = send_gas * gas_price
execution_fee_yocto = execution_gas * receipt_gas_price
transaction_fee_yocto = send_fee_yocto + execution_fee_yocto
deploy_action_fee_yocto = deploy_send_gas * gas_price

account = rpc("query", {
    "request_type": "view_account",
    "finality": "final",
    "account_id": TREASURY,
}, "treasury-account")
balance = int(account["amount"])
storage_per_byte = int(runtime["storage_amount_per_byte"])
current_storage = int(account.get("storage_usage", 0))
if current_storage < EXPECTED_EXISTING_TREASURY_BYTES:
    raise SystemExit("FAIL: deployed code size exceeds account storage usage; refusing storage projection.")
projected_storage = current_storage - EXPECTED_EXISTING_TREASURY_BYTES + TREASURY_WASM_BYTES
projected_storage_reserve = projected_storage * storage_per_byte
vtt_bounds = view(TOKEN, "storage_balance_bounds")
vtt_minimum = int(vtt_bounds["min"])

WASM = Path("candidate-contract/target/wasm32-unknown-unknown/release/veltron_treasury.wasm")
if not WASM.is_file():
    raise SystemExit(f"FAIL: expected treasury WASM artifact not found: {WASM}")
local_wasm = WASM.read_bytes()
local_hash = hashlib.sha256(local_wasm).hexdigest()
if len(local_wasm) != TREASURY_WASM_BYTES or local_hash != EXPECTED_TREASURY_SHA256:
    raise SystemExit(f"FAIL: local treasury WASM does not match recorded CI artifact (bytes={len(local_wasm)}, sha256={local_hash}).")

code = rpc("query", {
    "request_type": "view_code",
    "finality": "final",
    "account_id": TREASURY,
}, "treasury-code")
if not code.get("code_base64"):
    raise SystemExit("FAIL: treasury contract code was not found; expected an existing initialized contract for this upgrade.")
existing_hash = hashlib.sha256(base64.b64decode(code["code_base64"])).hexdigest()
if existing_hash != EXPECTED_EXISTING_TREASURY_SHA256:
    raise SystemExit(f"FAIL: on-chain treasury code differs from reviewed pre-upgrade version (actual={existing_hash}). Stop and investigate.")


remaining_after_reserves = balance - projected_storage_reserve - vtt_minimum
remaining_after_deploy_fee = remaining_after_reserves - transaction_fee_yocto

print("VELTRON TREASURY DEPLOYMENT COST PREFLIGHT — READ ONLY")
print(f"Finalized Testnet block: {height} ({block['header']['hash']})")
print(f"Protocol version: {config.get('protocol_version', 'not returned')}")
print(f"Gas price: {gas_price} yoctoNEAR/gas")
print(f"Treasury WASM bytes (expected CI build): {TREASURY_WASM_BYTES}")
print(f"Expected new treasury WASM SHA-256: {EXPECTED_TREASURY_SHA256}")
print(f"Verified existing on-chain treasury SHA-256: {existing_hash}")
print(f"Minimum gas purchase price: {min_gas_purchase_price} yoctoNEAR/gas")
print(f"Receipt gas price used for prepaid execution: {receipt_gas_price} yoctoNEAR/gas")
print(f"DeployContract send gas: {deploy_send_gas}")
print(f"DeployContract action send fee: {deploy_action_fee_yocto / YOCTO:.12f} NEAR")
print(f"One-action transaction fee estimate (send gas at current price + prepaid execution at receipt price): {transaction_fee_yocto / YOCTO:.12f} NEAR")
print("Fee estimate excludes signature-verification gas, initialization, and later transactions.")
print(f"Treasury balance: {balance / YOCTO:.12f} NEAR")
print(f"Current storage usage: {current_storage} bytes")
print(f"Projected storage usage: {projected_storage} bytes")
print(f"Projected code + current storage reserve: {projected_storage_reserve / YOCTO:.9f} NEAR")
print(f"VTT storage registration minimum (separate future transaction): {vtt_minimum / YOCTO:.9f} NEAR")
print(f"Balance after projected storage and VTT registration reserves: {remaining_after_reserves / YOCTO:.12f} NEAR")
print(f"Balance after additionally subtracting one-action deploy fee estimate: {remaining_after_deploy_fee / YOCTO:.12f} NEAR")
print("This is an estimate, not a deployment authorization or guarantee of sufficiency.")
print("No transaction was constructed, signed, or submitted.")
