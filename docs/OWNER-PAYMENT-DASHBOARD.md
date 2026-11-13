# Owner-controlled agent payment dashboard

This page is a follow-on to the contract API in PR #35. It must not be merged into `main` before PR #35 is merged.

## Contract API

- `get_pending_transfers()` returns a bounded list of pending records with `id`, `amount`, `kind`, and `created_at_ns`.
- A queued request is the `DiscretionaryRequest { recipient_id, memo }` kind. It is a reservation, not an on-chain token transfer.
- `approve_payment({ request_id })` is owner-only and converts a queued request into an asynchronous NEP-141 transfer.
- `reject_payment({ request_id })` is owner-only and releases the reservation without moving tokens.
- After approval, the request is no longer queued; the newly created in-flight transfer has its own transfer ID and `Discretionary` kind.
- `get_financial_position()` includes `pending_discretionary` and `spendable_balance`.

## Dashboard requirements

1. Add a mobile-first payment operations page linked from the deployer landing page and commitment manager.
2. Read state at one finalized block, independently from NEAR Public RPC and FastNEAR Testnet RPC. Verify every view response block hash and require both providers' normalized snapshots to match before rendering actionable controls.
3. Render queued discretionary requests separately from actual in-flight transfers. Never label a queued request as a transfer or imply tokens have moved.
4. Show request ID, recipient, amount formatted from six-decimal VTT base units using BigInt, memo, and creation timestamp. Show the latest spendable balance, safety reserve, and pause state.
5. Only enable approve/reject for the configured owner account `haideedotxyz.testnet`, after the user explicitly confirms Meteor displays NEAR Testnet and after a fresh dual-provider finalized snapshot.
6. Wallet calls must be one explicit FunctionCall to `veltron-treasury.testnet`, signer `haideedotxyz.testnet`, method `approve_payment` or `reject_payment`, gas/deposit matching existing owner transaction patterns. Arguments must be exact: `{ request_id: "<u64 decimal string>" }`.
7. Never auto-sign, auto-submit, retry an uncertain transaction, or treat a wallet return as proof of final execution. Invalidate actionable snapshot before opening the wallet; after wallet response, refresh finalized state from both providers. If outcome is uncertain, clearly say so and require read-only refresh before any retry.
8. Reject must remain available while paused if the contract permits it; approval must be disabled while paused. Respect contract-level authorization as the final authority.
9. Add robust UI tests for provider disagreement, stale snapshot, wrong wallet, network not confirmed, malformed request records, amount formatting, approve/reject arguments, paused behavior, and uncertain wallet outcomes.
10. Include bundle and tests in package scripts/CI. No deployment, unpause, token transfer, or live Testnet transaction is part of implementation or tests.

## Security boundaries

- No secret keys, seed phrases, backend signing, wallet automation, or private RPC credentials.
- No automatic approval and no direct NEP-141 call from the browser.
- A queued request only becomes a token transfer through the owner-approved contract method.
- Do not expose owner controls when RPC providers disagree, the snapshot is stale, the account is not the owner, or Testnet confirmation is absent.


Commitment settlement in the owner-controls dashboard uses `settle_commitment_checked(id, expected_recipient_id, expected_amount)`. The contract compares the expected values with the currently stored commitment before scheduling the token transfer, preventing a stale dashboard snapshot from redirecting or resizing an approved settlement.
