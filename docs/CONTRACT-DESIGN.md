# VELTRON Commitment Lock — Contract Design

## MVP boundary

The first contract supports one configured NEP-141 token, one owner, and one authorized agent. It does not support recurring schedules, multiple tokens, cross-chain transfers, or AI-controlled commitment edits.

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
- Tokens transferred directly to the contract without `ft_transfer_call` are not credited.
- The configured token contract is trusted; deploying with a malicious token address is unsafe.
- Token transfer callbacks, token registration requirements, storage costs, and deployed test-token behavior must be verified on testnet.
- A safety reserve is a protected accounting floor, not a separate escrow account.
- Recurring payments require an external caller or scheduler; contracts do not wake themselves up.
- Production use requires independent security review and careful handling of token upgrades/pauses and account recovery.

## First acceptance scenario

With a treasury balance of 1,000 units, commitments of 400 and 200, and a safety reserve of 100, spendable balance is 300. With an agent per-transaction cap of 500, a request for 450 must fail because it would consume protected funds; a request for 250 is within the spendable balance and transaction cap.
