#!/usr/bin/env python3
"""Read-only treasury-specific NEAR Testnet deployment cost preflight.

Reads finalized Testnet protocol parameters, treasury account state, and VTT
storage bounds. It never constructs, signs, or submits a transaction.
"""
import json
import urllib.request

RPC = "https://rpc.testnet.near.org"
TREASURY = "veltron-treasury.testnet"
TOKEN = "veltron-token.testnet"
TREASURY_WASM_BYTES = 338_088
EXPECTED_TREASURY_SHA256 = "3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36"
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
    import base64
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
receipt_gas = int(receipt["send_sir"]) + int(receipt["execution"])
transaction_fee_gas = deploy_send_gas + deploy_exec_gas + receipt_gas
transaction_fee_yocto = transaction_fee_gas * gas_price
deploy_action_fee_yocto = deploy_send_gas * gas_price

account = rpc("query", {
    "request_type": "view_account",
    "finality": "final",
    "account_id": TREASURY,
}, "treasury-account")
balance = int(account["amount"])
storage_per_byte = int(runtime["storage_amount_per_byte"])
current_storage = int(account.get("storage_usage", 0))
projected_storage = current_storage + TREASURY_WASM_BYTES
projected_storage_reserve = projected_storage * storage_per_byte
vtt_bounds = view(TOKEN, "storage_balance_bounds")
vtt_minimum = int(vtt_bounds["min"])

try:
    code = rpc("query", {
        "request_type": "view_code",
        "finality": "final",
        "account_id": TREASURY,
    }, "treasury-code")
    deployed = bool(code.get("code_base64"))
except RuntimeError as exc:
    if "contract code" in str(exc).lower() or "code not found" in str(exc).lower():
        deployed = False
    else:
        raise

if deployed:
    raise SystemExit("STOP: treasury already has contract code; do not use this pre-deployment estimate.")
if TREASURY_WASM_BYTES <= 0:
    raise SystemExit("FAIL: invalid treasury WASM size.")

remaining_after_reserves = balance - projected_storage_reserve - vtt_minimum
remaining_after_deploy_fee = remaining_after_reserves - transaction_fee_yocto

print("VELTRON TREASURY DEPLOYMENT COST PREFLIGHT — READ ONLY")
print(f"Finalized Testnet block: {height} ({block['header']['hash']})")
print(f"Protocol version: {config.get('protocol_version', 'not returned')}")
print(f"Gas price: {gas_price} yoctoNEAR/gas")
print(f"Treasury WASM bytes (expected CI build): {TREASURY_WASM_BYTES}")
print(f"Expected treasury WASM SHA-256: {EXPECTED_TREASURY_SHA256}")
print(f"DeployContract send gas: {deploy_send_gas}")
print(f"DeployContract action send fee: {deploy_action_fee_yocto / YOCTO:.12f} NEAR")
print(f"One-action transaction fee estimate (receipt + DeployContract send/execution): {transaction_fee_yocto / YOCTO:.12f} NEAR")
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
