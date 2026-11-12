#!/usr/bin/env python3
"""Read-only, dual-RPC verification of the live VELTRON Testnet treasury.

Pins every view to one finalized block hash and checks deployed WASM identity,
configuration, accounting, commitments, pending transfers, token registration,
and the observed NEP-141 balance. Never signs or submits transactions.
"""
import base64
import hashlib
import json
import urllib.request

TREASURY = "veltron-treasury.testnet"
TOKEN = "veltron-token.testnet"
OWNER = "haideedotxyz.testnet"
AGENT = "veltron-agent.testnet"
RPCS = {
    "NEAR": "https://rpc.testnet.near.org",
    "FastNear": "https://rpc.testnet.fastnear.com",
}
TREASURY_SHA256 = "a70d8aea3538fd177859fdb7e31b8c1c1e7a982de24d76dbdcf4d88b006d2aca"
TOKEN_SHA256 = "5d5041336cc8fc92cc9ca11fff1f0b1f7ead33c4826c6d12013f957ba1e7c95b"
EXPECTED_RESERVE = "200000000"
EXPECTED_LEDGER = "10000000"
EXPECTED_AGENT_LIMIT = "50000000"
EXPECTED_STORAGE_MIN = "1250000000000000000000"
YOCTO_PER_NEAR = 10**24
STORAGE_PRICE_PER_BYTE = 10**19


def rpc(endpoint, method, params, timeout=25):
    payload = {"jsonrpc": "2.0", "id": "veltron-live-state", "method": method, "params": params}
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, separators=(",", ":")).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.loads(response.read())
    if "error" in body:
        raise RuntimeError(f"{endpoint} {method} RPC error: {body['error']}")
    if "result" not in body:
        raise RuntimeError(f"{endpoint} {method} returned no result")
    return body["result"]


def query(endpoint, request_type, account_id, block_hash, **extra):
    result = rpc(endpoint, "query", {
        "request_type": request_type,
        "block_id": block_hash,
        "account_id": account_id,
        **extra,
    })
    if result.get("block_hash") != block_hash:
        raise RuntimeError(f"{endpoint} {request_type} returned a different block hash")
    return result


def view(endpoint, account_id, method, block_hash, args=None):
    encoded = base64.b64encode(
        json.dumps(args or {}, separators=(",", ":")).encode()
    ).decode()
    result = query(
        endpoint,
        "call_function",
        account_id,
        block_hash,
        method_name=method,
        args_base64=encoded,
    )
    raw = bytes(result["result"]).decode("utf-8")
    return json.loads(raw)


def all_commitments(endpoint, block_hash):
    commitments = []
    cursor = None
    seen = set()
    for _ in range(6):
        page = view(
            endpoint, TREASURY, "get_commitments", block_hash,
            {"from_id": cursor, "limit": 50},
        )
        if not isinstance(page, dict) or not isinstance(page.get("commitments"), list):
            raise RuntimeError("get_commitments returned an invalid page")
        entries = page["commitments"]
        next_cursor = page.get("next_cursor")
        if len(entries) > 50:
            raise RuntimeError("get_commitments exceeded the requested page size")
        if cursor is not None and not entries:
            raise RuntimeError("get_commitments returned an empty continuation page")
        previous_id = cursor
        for item in entries:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                raise RuntimeError("get_commitments returned a malformed entry")
            commitment_id = item["id"]
            if commitment_id in seen:
                raise RuntimeError("get_commitments returned a duplicate ID")
            if previous_id is not None and commitment_id <= previous_id:
                raise RuntimeError("get_commitments IDs are not strictly increasing")
            seen.add(commitment_id)
            previous_id = commitment_id
        commitments.extend(entries)
        if next_cursor is None:
            if len(commitments) > 256:
                raise RuntimeError("active commitment count exceeds the contract limit")
            return commitments
        if not isinstance(next_cursor, str) or not next_cursor or not entries:
            raise RuntimeError("get_commitments returned an invalid pagination cursor")
        if len(entries) != 50:
            raise RuntimeError("get_commitments returned a cursor for a non-full page")
        if next_cursor != entries[-1]["id"] or next_cursor == cursor:
            raise RuntimeError("get_commitments returned an invalid pagination cursor")
        cursor = next_cursor
    raise RuntimeError("get_commitments exceeded the six-page bound")


def code_hash(endpoint, account_id, block_hash):
    result = query(endpoint, "view_code", account_id, block_hash)
    code = result.get("code_base64")
    if not isinstance(code, str) or not code:
        raise RuntimeError(f"{account_id} returned no deployed WASM")
    return hashlib.sha256(base64.b64decode(code)).hexdigest()


def snapshot(endpoint, block_hash):
    status = rpc(endpoint, "status", [])
    if status.get("chain_id") != "testnet":
        raise RuntimeError(f"{endpoint} is not NEAR Testnet")

    treasury_account = query(endpoint, "view_account", TREASURY, block_hash)
    token_metadata = view(endpoint, TOKEN, "ft_metadata", block_hash)
    token_supply = view(endpoint, TOKEN, "ft_total_supply", block_hash)
    treasury_token_balance = view(
        endpoint, TOKEN, "ft_balance_of", block_hash, {"account_id": TREASURY}
    )
    token_storage = view(
        endpoint, TOKEN, "storage_balance_of", block_hash, {"account_id": TREASURY}
    )
    storage_bounds = view(endpoint, TOKEN, "storage_balance_bounds", block_hash)

    state = {
        "treasury_hash": code_hash(endpoint, TREASURY, block_hash),
        "token_hash": code_hash(endpoint, TOKEN, block_hash),
        "owner": view(endpoint, TREASURY, "get_owner", block_hash),
        "agent_config": view(endpoint, TREASURY, "get_agent_config", block_hash),
        "paused": view(endpoint, TREASURY, "get_pause_status", block_hash),
        "position": view(endpoint, TREASURY, "get_financial_position", block_hash),
        "commitments": all_commitments(endpoint, block_hash),
        "pending_transfers": view(endpoint, TREASURY, "get_pending_transfers", block_hash),
        "token_audit": view(endpoint, TREASURY, "get_token_balance_audit", block_hash),
        "token_metadata": token_metadata,
        "token_supply": token_supply,
        "treasury_token_balance": treasury_token_balance,
        "token_storage": token_storage,
        "storage_bounds": storage_bounds,
        "treasury_account": {
            "amount": treasury_account.get("amount"),
            "storage_usage": treasury_account.get("storage_usage"),
            "code_hash": treasury_account.get("code_hash"),
        },
    }
    validate_snapshot(state)
    return state


def validate_snapshot(state):
    if state["treasury_hash"] != TREASURY_SHA256:
        raise ValueError(f"treasury WASM hash mismatch: {state['treasury_hash']}")
    if state["token_hash"] != TOKEN_SHA256:
        raise ValueError(f"VTT WASM hash mismatch: {state['token_hash']}")
    if state["owner"] != OWNER:
        raise ValueError(f"unexpected treasury owner: {state['owner']}")
    agent = state["agent_config"]
    if not isinstance(agent, dict) or agent.get("agent_id") != AGENT:
        raise ValueError(f"unexpected agent configuration: {agent}")
    if str(agent.get("max_per_transaction")) != EXPECTED_AGENT_LIMIT:
        raise ValueError(f"unexpected per-transaction limit: {agent}")
    if state["paused"] is not True:
        raise ValueError("treasury must remain paused during this verification")

    position = state["position"]
    expected_position = {
        "treasury_balance": EXPECTED_LEDGER,
        "active_commitments": "0",
        "safety_reserve": EXPECTED_RESERVE,
        "pending_discretionary": "0",
        "spendable_balance": "0",
    }
    for key, expected in expected_position.items():
        if str(position.get(key)) != expected:
            raise ValueError(f"unexpected financial position field {key}: {position.get(key)!r}")
    if state["commitments"] != []:
        raise ValueError("unexpected active commitments are present")
    if state["pending_transfers"] != []:
        raise ValueError("unexpected pending transfers are present")

    audit = state["token_audit"]
    if audit.get("audit_pending") is not False:
        raise ValueError("token-balance audit is pending or malformed")
    if str(audit.get("observed_token_balance")) != EXPECTED_LEDGER:
        raise ValueError("latest observed VTT balance does not match the expected ledger")
    if str(audit.get("ledger_balance_at_observation")) != EXPECTED_LEDGER:
        raise ValueError("latest audit ledger snapshot does not match the expected ledger")
    if str(state["treasury_token_balance"]) != EXPECTED_LEDGER:
        raise ValueError("actual treasury VTT balance does not match the internal ledger")

    metadata = state["token_metadata"]
    if metadata.get("symbol") != "VTT" or metadata.get("decimals") != 6:
        raise ValueError(f"unexpected VTT metadata: {metadata}")
    try:
        token_supply = int(state["token_supply"])
    except (TypeError, ValueError):
        raise ValueError(f"invalid VTT total supply: {state['token_supply']!r}")
    if token_supply <= 0:
        raise ValueError("VTT total supply must be positive")
    bounds = state["storage_bounds"]
    if str(bounds.get("min")) != EXPECTED_STORAGE_MIN or str(bounds.get("max")) != EXPECTED_STORAGE_MIN:
        raise ValueError(f"unexpected VTT storage bounds: {bounds}")
    storage = state["token_storage"]
    if not isinstance(storage, dict) or int(storage.get("total", "0")) < int(EXPECTED_STORAGE_MIN):
        raise ValueError(f"treasury VTT storage is not registered: {storage}")

    account = state["treasury_account"]
    try:
        balance = int(account["amount"])
        usage = int(account["storage_usage"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("treasury account balance or storage usage is invalid")
    required = usage * STORAGE_PRICE_PER_BYTE + YOCTO_PER_NEAR // 10
    if balance < required:
        raise ValueError("treasury NEAR balance is below storage backing plus 0.1 NEAR margin")


def main():
    print("VELTRON LIVE TESTNET TREASURY VERIFICATION — READ ONLY")
    block = rpc(RPCS["NEAR"], "block", {"finality": "final"})
    block_hash = block["header"]["hash"]
    print(f"Finalized block: {block['header']['height']} ({block_hash})")

    results = {}
    for name, endpoint in RPCS.items():
        results[name] = snapshot(endpoint, block_hash)
        print(f"PASS: {name} verified deployed code and treasury state at the same finalized block")

    if results["NEAR"] != results["FastNear"]:
        raise SystemExit("FAIL: independent RPC providers disagree on finalized treasury state")

    state = results["NEAR"]
    print("Treasury WASM SHA-256:", state["treasury_hash"])
    print("VTT WASM SHA-256:", state["token_hash"])
    print("Owner:", state["owner"])
    print("Agent:", state["agent_config"]["agent_id"])
    print("Maximum per transaction:", state["agent_config"]["max_per_transaction"], "base units (50 VTT)")
    print("Paused:", state["paused"])
    print("Financial position:", json.dumps(state["position"], sort_keys=True))
    print("Active commitments:", len(state["commitments"]))
    print("Pending transfers:", len(state["pending_transfers"]))
    print("Treasury VTT balance:", state["treasury_token_balance"])
    print("Treasury NEAR balance:", state["treasury_account"]["amount"])
    print("Treasury storage usage:", state["treasury_account"]["storage_usage"])
    print("PASS: NEAR and FastNear agree on the complete finalized treasury snapshot.")
    print("PASS: no wallet, key, transaction, or state-changing method was used.")


if __name__ == "__main__":
    main()
