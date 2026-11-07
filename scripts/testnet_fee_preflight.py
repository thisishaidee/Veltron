#!/usr/bin/env python3
"""Read-only NEAR Testnet fee preflight. Sends JSON-RPC reads only; never signs or submits transactions."""
import json
import urllib.request

RPC = "https://rpc.testnet.near.org"
WASM_BYTES = 325_106
EXPECTED_SHA256 = "5d5041336cc8fc92cc9ca11fff1f0b1f7ead33c4826c6d12013f957ba1e7c95b"

def rpc(method, params, request_id):
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read())
    if "error" in payload:
        raise RuntimeError(f"{method} RPC error: {payload['error']}")
    return payload["result"]

block = rpc("block", {"finality": "final"}, "final-block")
height = block["header"]["height"]
gas_price = int(block["header"]["gas_price"])
config = rpc("EXPERIMENTAL_protocol_config", {"block_id": height}, "protocol-config")
runtime = config["runtime_config"]
costs = runtime["transaction_costs"]
action = costs["action_creation_config"]
base = int(action["deploy_contract_cost"]["send_sir"])
per_byte = int(action["deploy_contract_cost_per_byte"]["send_sir"])
deploy_gas = base + WASM_BYTES * per_byte
deploy_yocto = deploy_gas * gas_price

print("VELTRON READ-ONLY NEAR TESTNET FEE PREFLIGHT")
print(f"RPC endpoint: {RPC}")
print(f"Finalized block: height={height} hash={block['header']['hash']}")
print(f"Protocol version: {config.get('protocol_version', 'not returned')}")
print(f"Gas price: {gas_price} yoctoNEAR/gas")
print(f"Token WASM bytes: {WASM_BYTES}")
print(f"Expected token WASM SHA-256: {EXPECTED_SHA256}")
print(f"DeployContract base send_sir: {base} gas")
print(f"DeployContract per-byte send_sir: {per_byte} gas/byte")
print(f"DeployContract action fee: {deploy_gas} gas")
print(f"DeployContract action fee at sampled gas price: {deploy_yocto} yoctoNEAR")
print(f"DeployContract action fee in NEAR: {deploy_yocto / 10**24:.12f} NEAR")
print("Action creation config keys:", ", ".join(sorted(action.keys())))
print("Transaction cost config keys:", ", ".join(sorted(costs.keys())))
storage_config = costs.get("storage_usage_config", {})
print("Storage usage config:", json.dumps(storage_config, sort_keys=True))
if "storage_amount_per_byte" in storage_config:
    storage_per_byte = int(storage_config["storage_amount_per_byte"])
    storage_stake = WASM_BYTES * storage_per_byte
    print(f"Code storage stake estimate: {storage_stake} yoctoNEAR ({storage_stake / 10**24:.9f} NEAR)")
else:
    print("Code storage stake estimate: unavailable; storage_amount_per_byte not found.")
receipt_config = costs.get("action_receipt_creation_config")
if receipt_config is not None:
    print("Action receipt creation config:", json.dumps(receipt_config, sort_keys=True))
else:
    print("Action receipt creation config: not present under transaction_costs; inspect full runtime config before treating the action fee as an all-in transaction quote.")
print("IMPORTANT: This is the DeployContract action fee component only, not a final all-in transaction quote.")
print("No transaction was constructed, signed, or submitted.")
