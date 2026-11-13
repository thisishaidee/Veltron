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
TREASURY_PUBLIC_KEY = "ed25519:9igPiXMDj4UrbmZwotWuJtuRAP9BiTefweYwgndKBQNS"
OLD_TREASURY_SHA256 = "a70d8aea3538fd177859fdb7e31b8c1c1e7a982de24d76dbdcf4d88b006d2aca"
NEW_TREASURY_SHA256 = "0c6495486e476ace94698a844a23925b07b088c759e04848e68d1dbb94f3ed2b"
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


def deployment_access_key(endpoint, provider):
    """Require the exact reviewed deployment key to remain a FullAccess key."""
    key = query(
        endpoint,
        "view_access_key",
        TREASURY,
        public_key=TREASURY_PUBLIC_KEY,
    )
    if not isinstance(key, dict) or key.get("permission") != "FullAccess":
        raise RuntimeError(
            f"{provider}: reviewed treasury deployment key is missing or is not FullAccess"
        )
    return {"public_key": TREASURY_PUBLIC_KEY, "permission": "FullAccess"}


def all_commitments(endpoint):
    """Read the complete bounded active set and fail closed on any pagination anomaly."""
    commitments = []
    seen_ids = set()
    cursor = None

    # The contract caps active commitments at 256 and returns at most 50 per page.
    # Six pages are sufficient (50 * 5 + 6), with no unbounded RPC loop.
    for _ in range(6):
        page = view(endpoint, TREASURY, "get_commitments", {"from_id": cursor, "limit": 50})
        if not isinstance(page, dict) or not isinstance(page.get("commitments"), list):
            raise RuntimeError("get_commitments returned an unexpected page shape")

        entries = page["commitments"]
        next_cursor = page.get("next_cursor")
        if len(entries) > 50:
            raise RuntimeError("get_commitments returned more than the requested page limit")
        if cursor is not None and not entries:
            raise RuntimeError("get_commitments returned an empty page after a continuation cursor")
        if next_cursor is not None and (not isinstance(next_cursor, str) or not next_cursor):
            raise RuntimeError("get_commitments returned an invalid next_cursor")
        if next_cursor is not None and len(entries) != 50:
            raise RuntimeError("get_commitments returned a cursor for a non-full page")

        previous_id = cursor
        for entry in entries:
            if not isinstance(entry, dict):
                raise RuntimeError("get_commitments returned a malformed commitment")
            commitment_id = entry.get("id")
            if not isinstance(commitment_id, str) or not commitment_id or len(commitment_id) > 64:
                raise RuntimeError("get_commitments returned a commitment with an invalid ID")
            if not isinstance(entry.get("recipient_id"), str) or not entry["recipient_id"]:
                raise RuntimeError(f"get_commitments returned an invalid recipient for {commitment_id}")
            if not isinstance(entry.get("description"), str):
                raise RuntimeError(f"get_commitments returned an invalid description for {commitment_id}")
            raw_amount = entry.get("amount")
            if isinstance(raw_amount, bool) or not isinstance(raw_amount, (str, int)):
                raise RuntimeError(f"get_commitments returned an invalid amount for {commitment_id}")
            try:
                amount = int(raw_amount)
            except ValueError:
                raise RuntimeError(f"get_commitments returned an invalid amount for {commitment_id}")
            if amount <= 0:
                raise RuntimeError(f"get_commitments returned a non-positive amount for {commitment_id}")
            if not isinstance(entry.get("settlement_pending"), bool):
                raise RuntimeError(f"get_commitments returned an invalid settlement flag for {commitment_id}")
            if commitment_id in seen_ids:
                raise RuntimeError(f"get_commitments returned duplicate commitment ID: {commitment_id}")
            if previous_id is not None and commitment_id <= previous_id:
                raise RuntimeError("get_commitments IDs are not strictly increasing across pages")
            seen_ids.add(commitment_id)
            previous_id = commitment_id

        if next_cursor is None:
            complete = commitments + entries
            if len(complete) > 256:
                raise RuntimeError("get_commitments exceeded the contract's 256-active-commitment limit")
            return complete
        if not entries or next_cursor != entries[-1]["id"]:
            raise RuntimeError("get_commitments cursor does not match the final commitment ID")
        if next_cursor == cursor:
            raise RuntimeError("get_commitments pagination cursor did not advance")

        commitments.extend(entries)
        cursor = next_cursor

    raise RuntimeError("Commitment pagination exceeded the expected six-page bound")


def assert_commitments_match_position(state, provider):
    """Cross-check the paginated commitment set against the contract's aggregate reserve."""
    try:
        expected_total = int(state["financial_position"]["active_commitments"])
        actual_total = sum(int(item["amount"]) for item in state["commitments"])
    except (KeyError, TypeError, ValueError):
        raise RuntimeError(f"{provider}: cannot reconcile commitment pages with financial position")
    if actual_total != expected_total:
        raise RuntimeError(
            f"{provider}: paginated commitment total {actual_total} does not match "
            f"financial-position active_commitments {expected_total}"
        )


def assert_upgrade_safe_state(state, provider):
    """Enforce the on-chain quiescence conditions before replacing contract code."""
    if state.get("paused") is not True:
        raise RuntimeError(f"{provider}: treasury must already be paused before a code upgrade")
    if state.get("pending_transfers") != []:
        raise RuntimeError(f"{provider}: pending treasury transfers must be empty before a code upgrade")
    try:
        pending_discretionary = int(state["financial_position"]["pending_discretionary"])
    except (KeyError, TypeError, ValueError):
        raise RuntimeError(f"{provider}: pending discretionary balance is missing or invalid")
    if pending_discretionary != 0:
        raise RuntimeError(f"{provider}: pending discretionary balance must be zero before a code upgrade")
    audit = state.get("token_audit")
    if not isinstance(audit, dict) or audit.get("audit_pending") is not False:
        raise RuntimeError(f"{provider}: token-balance audit must not be pending before a code upgrade")


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
        "deployment_access_key": deployment_access_key(endpoint, provider),
        "commitments": all_commitments(endpoint),
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
        if not isinstance(state["agent_config"], dict) or state["agent_config"].get("agent_id") != AGENT:
            raise RuntimeError(f"{provider}: configured agent changed or has an unexpected shape: {state['agent_config']}")
        try:
            max_per_transaction = int(state["agent_config"]["max_per_transaction"])
        except (KeyError, TypeError, ValueError):
            raise RuntimeError(f"{provider}: agent transaction limit is missing or invalid: {state['agent_config']}")
        if max_per_transaction <= 0:
            raise RuntimeError(f"{provider}: agent transaction limit must remain positive: {state['agent_config']}")
    if not isinstance(state["financial_position"], dict) or not isinstance(state["paused"], bool):
        raise RuntimeError(f"{provider}: treasury state response has unexpected shape")
    if not isinstance(state["pending_transfers"], list):
        raise RuntimeError(f"{provider}: pending transfers response has unexpected shape")
    if not isinstance(state["token_audit"], dict) or not isinstance(state["token_audit"].get("audit_pending"), bool):
        raise RuntimeError(f"{provider}: token-balance audit response has unexpected shape")
    assert_commitments_match_position(state, provider)
    if expected_treasury_hash == OLD_TREASURY_SHA256:
        assert_upgrade_safe_state(state, provider)
    return {"treasury_hash": treasury_hash, "token_hash": token_hash, "state": state}


def main():
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
    print("PASS: the exact reviewed treasury deployment key remains a FullAccess key on both RPCs.")
    print("No additional transaction was constructed, signed, or submitted by this verifier.")


if __name__ == "__main__":
    main()
