# VELTRON Commitment Lock — Contract Design

## MVP boundary

The first contract supports one configured NEP-141 token, one owner, and one authorized agent. The owner, agent, token contract, and treasury contract must be four distinct accounts; owner and agent separation is enforced at initialization. It does not support recurring schedules, multiple tokens, cross-chain transfers, or AI-controlled commitment edits.

## Accounting model

The contract credits its internal treasury ledger only when the configured token contract calls `ft_on_transfer`. Deposits must use NEP-141 `ft_transfer_call` with an empty message. A plain token transfer does not notify this contract and is not credited to the internal ledger.

```
Spendable = max(
  0,
  Treasury balance
  - Active commitments
  - Safety reserve
  - Pending discretionary transfers
)
```

Pending discretionary transfers are subtracted separately because NEAR cross-contract calls are asynchronous. The funds remain reserved until the token transfer callback confirms success or failure.

## Emergency pause

- The owner can call `set_paused(true)` to block new discretionary payments and commitment settlements. `get_pause_status` exposes the current state.
- The owner can resume operations with `set_paused(false)`.
- A pause does not cancel or freeze transfers already submitted to the token contract. Their callbacks continue to finalize accounting, including success and failure handling.
- Deposits remain accepted while paused, and owner administration, audit, and reconciliation remain available subject to their own safety checks. This pause is an outgoing-transfer circuit breaker, not a complete contract shutdown.

## Token balance audit

- The owner can call `refresh_token_balance_audit` to query the configured NEP-141 contract's actual token balance for the treasury.
- The asynchronous result is stored by a private callback and exposed through `get_token_balance_audit`, alongside the internal ledger balance captured when the query completes and the observation timestamp.
- The audit is read-only: it never credits or debits the ledger and never changes spendable balance. A difference is evidence of a balance discrepancy, not permission to recover or spend the difference.
- Only one audit can be pending at a time. A failed query clears the pending flag and preserves the previous successful observation.
- A successful observation can be used once by the owner through `reconcile_token_surplus(amount)`. The amount must be positive and no greater than the observed token balance minus the ledger balance captured at that observation.
- Reconciliation is rejected while transfers or an audit are pending, when there is no successful observation, when the ledger has changed since observation, or when no surplus was observed. A successful reconciliation consumes the observation; another reconciliation requires a fresh audit.
- Incoming accepted deposits and the start of outgoing transfers invalidate the stored observation. Audits are blocked while outgoing transfers are pending, and accepted deposits are rejected while an audit is pending. Plain direct NEP-141 transfers do not call the treasury and therefore cannot be locked; a direct transfer arriving after an audit can only make the recorded surplus conservative for a standard non-rebasing NEP-141 token.
- The observation is a point-in-time diagnostic, not a continuously synchronized balance or a cryptographic proof of token solvency. The configured token contract remains trusted and could report dishonest balances or implement non-standard behavior.

## Commitment limits and retrieval

- The MVP permits at most 256 active commitments at a time. Owners can cancel or settle commitments to free capacity.
- Commitment reads use cursor pagination. `get_commitments` accepts `from_id` (exclusive) and `limit`; the default page size is 25 and the maximum is 50. Use the returned `next_cursor` as the next request's `from_id` until it is `null`.
- The active-commitment total is calculated over a bounded collection, so accounting work cannot grow without limit. This cap is an MVP guardrail, not a substitute for profiling gas and storage costs under realistic workloads.
- Commitment IDs are limited to 64 UTF-8 bytes. Commitment descriptions and optional discretionary-payment memos are each limited to 256 UTF-8 bytes. These limits constrain user-supplied strings passed through contract calls; an omitted memo is allowed.
- Recipient and configuration account IDs use NEAR `AccountId` deserialization, so malformed account IDs are rejected before contract logic executes. The treasury rejects itself and the configured token contract as payment or commitment recipients; the token contract is infrastructure, not a vendor destination.

## Payment lifecycle

1. The authorized agent requests a discretionary payment, or the owner starts settlement of an existing commitment.
2. VELTRON records a pending transfer before scheduling the NEP-141 `ft_transfer`.
3. The contract calls the configured token contract with the required 1 yoctoNEAR security deposit.
4. A private callback receives the promise result.
5. On success, the internal treasury ledger is reduced. A successfully settled commitment is removed.
6. On failure, the pending reservation is removed and the commitment remains active.

This ordering prevents two requests from spending the same internally accounted balance while a transfer is in flight.

## Authority model

- Owner: creates, updates, cancels, and settles commitments; changes the safety reserve and agent.
- Agent: requests discretionary payments only.
- Token contract: may credit deposits only through the configured NEP-141 receiver call.
- Callback: private to the contract account.

Commitment recipients are fixed by the owner. The agent cannot change commitment recipients, cancel obligations, or withdraw funds directly.

## Important limitations

- This is an MVP implementation, not an audited production treasury.
- Internal accounting tracks deposits and outgoing transfers made through this contract. It does not query the token balance on every decision.
- Tokens transferred directly to the contract without `ft_transfer_call` are not credited. They become unaccounted token surplus: the actual NEP-141 balance can exceed the internal ledger, while spendable balance remains based on the ledger. The owner can inspect this discrepancy using the token balance audit and, after a successful observation, reconcile a bounded amount using `reconcile_token_surplus`.
- The configured token contract is trusted; deploying with a malicious token address is unsafe.
- Token transfer callbacks, token registration requirements, storage costs, and deployed test-token behavior must be verified on testnet.
- A safety reserve is a protected accounting floor, not a separate escrow account.
- Recurring payments require an external caller or scheduler; contracts do not wake themselves up.
- Production use requires independent security review and careful handling of token upgrades/pauses and account recovery.

## First acceptance scenario

With a treasury balance of 1,000 units, commitments of 400 and 200, and a safety reserve of 100, spendable balance is 300. With an agent per-transaction cap of 500, a request for 450 must fail because it would consume protected funds; a request for 250 is within the spendable balance and transaction cap.
