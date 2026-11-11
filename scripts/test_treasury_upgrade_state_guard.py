import unittest
from unittest.mock import patch

from treasury_upgrade_state_guard import all_commitments


def commitment(identifier):
    return {"id": identifier}


class CommitmentPaginationTests(unittest.TestCase):
    def test_reads_all_256_commitments_across_six_pages(self):
        ids = [f"commitment-{i:03d}" for i in range(256)]
        pages = []
        for start in range(0, 256, 50):
            entries = [commitment(value) for value in ids[start:start + 50]]
            next_cursor = entries[-1]["id"] if start + 50 < len(ids) else None
            pages.append({"commitments": entries, "next_cursor": next_cursor})

        with patch("treasury_upgrade_state_guard.view", side_effect=pages) as mocked:
            result = all_commitments("test-rpc")

        self.assertEqual([item["id"] for item in result], ids)
        self.assertEqual(mocked.call_count, 6)
        self.assertEqual(mocked.call_args_list[1].args[2], "get_commitments")
        self.assertEqual(mocked.call_args_list[1].args[3], {
            "from_id": "commitment-049", "limit": 50
        })

    def test_rejects_cursor_that_does_not_match_last_entry(self):
        page = {
            "commitments": [commitment(f"item-{i:03d}") for i in range(50)],
            "next_cursor": "item-048",
        }
        with patch("treasury_upgrade_state_guard.view", return_value=page):
            with self.assertRaisesRegex(RuntimeError, "cursor does not match"):
                all_commitments("test-rpc")

    def test_rejects_duplicate_or_non_increasing_ids(self):
        duplicate = {"commitments": [commitment("a"), commitment("a")], "next_cursor": None}
        with patch("treasury_upgrade_state_guard.view", return_value=duplicate):
            with self.assertRaisesRegex(RuntimeError, "duplicate"):
                all_commitments("test-rpc")

        descending = {"commitments": [commitment("b"), commitment("a")], "next_cursor": None}
        with patch("treasury_upgrade_state_guard.view", return_value=descending):
            with self.assertRaisesRegex(RuntimeError, "strictly increasing"):
                all_commitments("test-rpc")

    def test_rejects_empty_page_after_continuation_cursor(self):
        first_entries = [commitment(f"item-{i:03d}") for i in range(50)]
        pages = [
            {"commitments": first_entries, "next_cursor": first_entries[-1]["id"]},
            {"commitments": [], "next_cursor": None},
        ]
        with patch("treasury_upgrade_state_guard.view", side_effect=pages):
            with self.assertRaisesRegex(RuntimeError, "empty page after a continuation"):
                all_commitments("test-rpc")

    def test_rejects_cursor_on_short_page(self):
        page = {
            "commitments": [commitment(f"item-{i:03d}") for i in range(49)],
            "next_cursor": "item-048",
        }
        with patch("treasury_upgrade_state_guard.view", return_value=page):
            with self.assertRaisesRegex(RuntimeError, "non-full page"):
                all_commitments("test-rpc")

    def test_fails_closed_when_sixth_page_still_has_cursor(self):
        pages = []
        for page_number in range(6):
            start = page_number * 50
            entries = [commitment(f"item-{i:03d}") for i in range(start, start + 50)]
            pages.append({"commitments": entries, "next_cursor": entries[-1]["id"]})
        with patch("treasury_upgrade_state_guard.view", side_effect=pages):
            with self.assertRaisesRegex(RuntimeError, "six-page bound"):
                all_commitments("test-rpc")


if __name__ == "__main__":
    unittest.main()
