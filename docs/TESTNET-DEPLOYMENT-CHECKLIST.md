# VELTRON Testnet Deployment Checklist

> **Scope:** This is a controlled testnet procedure for the current MVP. It is not approval for mainnet or real-fund use. The contract has not been independently audited.

## 1. Deployment gate

Do not deploy until all of the following are true:

- [ ] The intended source commit is recorded and reviewed.
- [ ] The treasury and test-token WebAssembly artifacts build from a clean checkout.
- [ ] The full workspace and NEAR Sandbox integration tests pass on that exact commit.
- [ ] The deployer has reviewed `docs/CONTRACT-DESIGN.md` and understands its limitations.
- [ ] The selected token contract is a trusted testnet NEP-141 contract. Do not use an arbitrary token address.
- [ ] The owner, agent, token, and treasury will be four distinct NEAR accounts.
- [ ] The owner and agent keys are controlled separately. Never give the agent the owner key or deployer credentials.
- [ ] The owner account and treasury account have enough testnet NEAR for deployment, storage, and transaction gas.
- [ ] The exact initialization values have been reviewed before the one-time initializer is called.

## 2. Record the deployment configuration

Fill and independently verify this record before deploying:

| Setting | Value to record |
|---|---|
| Network | NEAR testnet |
| Source repository | `thisishaidee/Veltron` |
| Source commit SHA | |
| Treasury WASM SHA-256 | |
| Test-token contract account | |
| Treasury contract account | |
| Owner account | |
| Agent account | |
| Maximum per-transaction amount | |
| Safety reserve | |
| Token name, symbol, and decimals | |
| Deployment date/time (UTC) | |
| Deployer/operator | |

The token contract account is immutable in the current treasury contract. There is no token setter. Verify it carefully before initialization.

## 3. Prepare accounts and token

- [ ] Create or select a dedicated treasury contract account on testnet.
- [ ] Create or select a separate owner account with secure key custody.
- [ ] Create a separate agent account. Give its key only to the agent process that needs to request discretionary payments.
- [ ] Deploy or select the intended testnet NEP-141 token contract.
- [ ] Verify the token contract account and its source/administrator or upgrade controls.
- [ ] Confirm that the token supports standard NEP-141 `ft_transfer`, `ft_transfer_call`, `ft_balance_of`, and storage registration behavior.
- [ ] Register the treasury account with the token using the token's `storage_deposit` method.
- [ ] Register each intended payment recipient with the token before attempting transfers, where the token requires recipient registration.
- [ ] Record the token's `ft_metadata` and initial balances.

Do not assume a token is safe merely because it exposes NEP-141 method names. Tokens with transfer fees, rebasing, unusual balance semantics, blacklists, freezes, or unreviewed upgrade controls are not suitable for this MVP deployment.

## 4. Build and deploy

- [ ] Check out the exact reviewed source commit.
- [ ] Build the treasury and test-token WASM artifacts in release mode for `wasm32-unknown-unknown`.
- [ ] Record the SHA-256 hash of each artifact and retain the build logs.
- [ ] Deploy the intended treasury WASM to the dedicated treasury account.
- [ ] Confirm the deployed code hash matches the artifact you built.
- [ ] Initialize the treasury exactly once with:
  - `owner_id`: the designated owner account;
  - `token_id`: the verified NEP-141 token account;
  - `agent_id`: the designated agent account;
  - `max_per_transaction`: a deliberately conservative test amount;
  - `safety_reserve`: the agreed test reserve.
- [ ] Read back the public configuration/state where available and independently verify it against the deployment record.

**Important:** Do not initialize with guessed account IDs or placeholder values. The current contract has no token migration or owner recovery mechanism. If the wrong immutable configuration is initialized, stop and assess a fresh contract deployment rather than attempting an improvised recovery.

## 5. Post-deployment smoke tests

Use test tokens only. Record transaction hashes and resulting view values.

### A. Initial state and deposit

- [ ] Confirm the initial treasury ledger and spendable balance are zero.
- [ ] Deposit a small test amount using the token's `ft_transfer_call` with an empty `msg`.
- [ ] Confirm the treasury ledger increases by exactly the accepted amount.
- [ ] Confirm the token's `ft_balance_of(treasury)` matches the ledger after the deposit.
- [ ] Confirm a plain `ft_transfer` is not credited to the internal ledger.

### B. Roles and spending limits

- [ ] Confirm a non-owner cannot create, update, cancel, or settle commitments.
- [ ] Confirm a non-agent cannot request a discretionary payment.
- [ ] Create a small commitment and confirm spendable balance falls by that amount.
- [ ] Confirm the agent cannot spend committed funds or the safety reserve.
- [ ] Confirm a payment at the configured transaction limit is accepted only when spendable funds permit it.
- [ ] Confirm a payment above the transaction limit is rejected.
- [ ] Confirm the owner can rotate the agent and the old agent immediately loses payment authority.

### C. Transfers, callbacks, and pause

- [ ] Complete a registered-recipient payment and confirm ledger and recipient token balances.
- [ ] Attempt a transfer to an unregistered recipient (if the token requires registration); confirm failure releases the pending reservation without reducing the ledger.
- [ ] Confirm a failed commitment settlement remains active and can be retried.
- [ ] Pause the treasury and confirm new discretionary payments and commitment settlements are rejected.
- [ ] Confirm an already-submitted transfer can still finish its callback while paused.
- [ ] Unpause only after verifying the intended owner account is calling.

### D. Audit and reconciliation

- [ ] Run `refresh_token_balance_audit` as the owner.
- [ ] Confirm the audit result is observational and does not itself change the ledger.
- [ ] If using a direct token transfer to create test surplus, confirm it is not credited until a successful audit and explicit owner reconciliation.
- [ ] Reconcile only a small, independently verified test surplus.
- [ ] Confirm reconciliation consumes the observation and a second reconciliation requires a fresh audit.

## 6. Operational monitoring

- [ ] Monitor `get_pause_status`, `get_financial_position`, `get_pending_transfers`, and `get_token_balance_audit`.
- [ ] Treat old pending transfers as incidents to investigate, not as permission to clear them manually. The contract deliberately has no force-clear or timeout release.
- [ ] Investigate token transfer receipts and callback outcomes before retrying or changing operational state.
- [ ] Keep an owner-controlled incident procedure for pausing new outgoing transfers.
- [ ] Keep deployment records, source/artifact hashes, initialization transaction, token account, and all smoke-test transaction hashes.

## 7. Stop conditions

Stop testing and do not deposit additional tokens if any of these occur:

- The deployed code hash does not match the reviewed artifact.
- The initialized owner, agent, token, limit, or reserve differs from the approved deployment record.
- The token balance and internal ledger diverge unexpectedly.
- A transfer reports success but the recipient balance does not increase as expected.
- A callback remains pending unexpectedly or accounting views become inconsistent.
- An unauthorized account can change state or initiate a payment.
- The token is paused, upgraded, blacklisted, or otherwise behaves differently from the reviewed assumptions.

Use the owner pause as a circuit breaker for new outgoing transfers where possible, then investigate from chain receipts and token state. Do not use real assets to reproduce a failure.

## 8. What this checklist does not certify

Passing these steps demonstrates only that the current build completed a controlled testnet smoke test. It does not establish production security, token solvency, upgrade safety, callback liveness under all network conditions, or suitability for real funds. Mainnet deployment requires independent security review, an explicit token and governance assessment, operational key-management review, and a separately approved deployment plan.
