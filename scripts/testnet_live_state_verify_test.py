import copy
import unittest

from testnet_live_state_verify import (
    AGENT, EXPECTED_AGENT_LIMIT, EXPECTED_LEDGER, EXPECTED_RESERVE,
    OWNER, TOKEN_SHA256, TREASURY_SHA256, validate_snapshot,
)


def valid_snapshot():
    return {
        "treasury_hash": TREASURY_SHA256,
        "token_hash": TOKEN_SHA256,
        "owner": OWNER,
        "agent_config": {"agent_id": AGENT, "max_per_transaction": EXPECTED_AGENT_LIMIT},
        "paused": True,
        "position": {
            "treasury_balance": EXPECTED_LEDGER,
            "active_commitments": "0",
            "safety_reserve": EXPECTED_RESERVE,
            "pending_discretionary": "0",
            "spendable_balance": "0",
        },
        "commitments": [],
        "pending_transfers": [],
        "token_audit": {
            "audit_pending": False,
            "observed_token_balance": EXPECTED_LEDGER,
            "ledger_balance_at_observation": EXPECTED_LEDGER,
        },
        "token_metadata": {"symbol": "VTT", "decimals": 6},
        "token_supply": "1000000000000",
        "treasury_token_balance": EXPECTED_LEDGER,
        "token_storage": {"total": "1250000000000000000000"},
        "storage_bounds": {"min": "1250000000000000000000"},
        "treasury_account": {
            "amount": str(6 * 10**24),
            "storage_usage": "339927",
            "code_hash": "expected-account-code-hash",
        },
    }


class LiveStateVerificationTests(unittest.TestCase):
    def test_accepts_expected_deployed_treasury_state(self):
        validate_snapshot(valid_snapshot())

    def test_rejects_unreviewed_treasury_code(self):
        state = valid_snapshot()
        state["treasury_hash"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "treasury WASM hash mismatch"):
            validate_snapshot(state)

    def test_rejects_wrong_owner_or_agent(self):
        for field, value in (("owner", "attacker.testnet"), ("agent_config", {"agent_id": "attacker.testnet", "max_per_transaction": EXPECTED_AGENT_LIMIT})):
            state = valid_snapshot()
            state[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_snapshot(state)

    def test_rejects_unpaused_treasury(self):
        state = valid_snapshot()
        state["paused"] = False
        with self.assertRaisesRegex(ValueError, "must remain paused"):
            validate_snapshot(state)

    def test_rejects_commitment_or_pending_transfer(self):
        for field, value in (("commitments", [{"id": "invoice"}]), ("pending_transfers", [{"id": "1"}])):
            state = valid_snapshot()
            state[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_snapshot(state)

    def test_rejects_ledger_or_reserve_drift(self):
        state = valid_snapshot()
        state["position"]["safety_reserve"] = "199999999"
        with self.assertRaisesRegex(ValueError, "safety_reserve"):
            validate_snapshot(state)

    def test_rejects_token_balance_or_audit_mismatch(self):
        state = valid_snapshot()
        state["treasury_token_balance"] = "9999999"
        with self.assertRaisesRegex(ValueError, "actual treasury VTT balance"):
            validate_snapshot(state)

    def test_rejects_insufficient_storage_backing(self):
        state = valid_snapshot()
        state["treasury_account"]["amount"] = "1"
        with self.assertRaisesRegex(ValueError, "storage backing"):
            validate_snapshot(state)


if __name__ == "__main__":
    unittest.main()
