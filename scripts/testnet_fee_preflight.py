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
# DeployContract requires the transaction predecessor/signer to equal the receiver.
# This preflight therefore models veltron-token.testnet signing for itself.
base_fee = action["deploy_contract_cost"]
per_byte_fee = action["deploy_contract_cost_per_byte"]
base = int(base_fee["send_sir"])
per_byte = int(per_byte_fee["send_sir"])
deploy_gas = base + WASM_BYTES * per_byte
deploy_yocto = deploy_gas * gas_price
deploy_execution = int(base_fee["execution"]) + WASM_BYTES * int(per_byte_fee["execution"])
receipt_config = costs["action_receipt_creation_config"]
receipt_send_sir = int(receipt_config["send_sir"])
receipt_execution = int(receipt_config["execution"])
transaction_fee_gas = receipt_send_sir + deploy_gas + receipt_execution + deploy_execution
transaction_fee_yocto = transaction_fee_gas * gas_price
storage_per_byte = int(runtime["storage_amount_per_byte"])

print("VELTRON READ-ONLY NEAR TESTNET FEE PREFLIGHT")
print(f"RPC endpoint: {RPC}")
print(f"Finalized block: height={height} hash={block['header']['hash']}")
print(f"Protocol version: {config.get('protocol_version', 'not returned')}")
print(f"Gas price: {gas_price} yoctoNEAR/gas")
print(f"Token WASM bytes: {WASM_BYTES}")
print(f"Expected token WASM SHA-256: {EXPECTED_SHA256}")
print(f"Modeled signer: {TARGET_ACCOUNT} (must equal DeployContract receiver)")
print(f"DeployContract base send_sir: {base} gas")
print(f"DeployContract per-byte send_sir: {per_byte} gas/byte")
print(f"DeployContract action send fee: {deploy_gas} gas")
print(f"DeployContract action send fee at sampled gas price: {deploy_yocto} yoctoNEAR")
print(f"DeployContract action send fee in NEAR: {deploy_yocto / 10**24:.12f} NEAR")
print(f"One-action transaction fee gas (self-addressed receipt send+execution; DeployContract send+execution): {transaction_fee_gas} gas")
print(f"One-action transaction fee at sampled gas price: {transaction_fee_yocto} yoctoNEAR ({transaction_fee_yocto / 10**24:.12f} NEAR)")
print("Note: excludes signature-verification gas if the signing key type requires it; no wallet key type is assumed.")
print(f"Runtime storage amount per byte: {storage_per_byte} yoctoNEAR/byte")
print(f"Code-byte storage reserve estimate: {WASM_BYTES * storage_per_byte} yoctoNEAR ({WASM_BYTES * storage_per_byte / 10**24:.9f} NEAR)")
print("Action creation config keys:", ", ".join(sorted(action.keys())))
print("Transaction cost config keys:", ", ".join(sorted(costs.keys())))
storage_config = costs.get("storage_usage_config", {})
print("Storage usage config (record metadata only):", json.dumps(storage_config, sort_keys=True))
print("Action receipt creation config:", json.dumps(receipt_config, sort_keys=True))
print("IMPORTANT: This is a one-action fee estimate for a self-addressed DeployContract transaction only; it excludes signature verification and any separate initialization transaction.")

# Read-only target-account state at the same finalized block.
TARGET_ACCOUNT = "veltron-token.testnet"

def query_account(request_type):
    return rpc("query", {
        "request_type": request_type,
        "finality": "final",
        "account_id": TARGET_ACCOUNT
    }, f"account-{request_type}")

account = query_account("view_account")
print(f"Target account: {TARGET_ACCOUNT}")
print(f"Account balance: {int(account['amount'])} yoctoNEAR")
print(f"Account balance: {int(account['amount']) / 10**24:.9f} NEAR")
print(f"Account locked balance: {int(account.get('locked', '0'))} yoctoNEAR")
current_storage = int(account.get("storage_usage", 0))
print(f"Account storage usage: {current_storage} bytes")
projected_storage = current_storage + WASM_BYTES
projected_reserve = projected_storage * storage_per_byte
print(f"Approx. post-deploy storage usage (current + WASM bytes): {projected_storage} bytes")
print(f"Approx. post-deploy minimum storage-backed balance: {projected_reserve} yoctoNEAR ({projected_reserve / 10**24:.9f} NEAR)")
print("This is a projection; confirm actual storage_usage and amount after deployment before any later action.")
try:
    code_result = query_account("view_code")
    code_b64 = code_result.get("code_base64", "")
    if not code_b64:
        print("Deployed contract code: absent (empty code response)")
    else:
        import base64
        import hashlib
        deployed_bytes = base64.b64decode(code_b64)
        deployed_hash = hashlib.sha256(deployed_bytes).hexdigest()
        print(f"Deployed contract code: present ({len(deployed_bytes)} bytes)")
        print(f"On-chain code SHA-256: {deployed_hash}")
        print(f"Expected token WASM SHA-256: {EXPECTED_SHA256}")
        print(f"On-chain code hash matches expected token WASM: {deployed_hash == EXPECTED_SHA256}")
except RuntimeError as exc:
    # NEAR returns contract code-not-found for accounts without deployed code.
    if "contract code" in str(exc).lower() or "code not found" in str(exc).lower():
        print("Deployed contract code: absent (RPC reports no contract code)")
    else:
        raise
print("No transaction was constructed, signed, or submitted.")
