# VELTRON Testnet Deployer — Stage 1

This directory contains a browser-only Testnet deployer with artifact verification, read-only preflight, and a user-initiated single-action test-token deployment flow.

## What it does
- Accepts the two WASM files extracted from the recorded GitHub Actions artifact.
- Computes SHA-256 with the browser Web Crypto API.
- Compares each file against the SHA-256 values recorded from the exact reviewed CI artifact. The current reference values are also shown in `index.html`.
- Configures NEAR Connect for Testnet and enables wallets advertising Testnet support.
- Reads the connected account ID from the wallet sign-in event.
- Checks the configured VELTRON RPC endpoint with a read-only NEAR status request and reports Testnet only when the response says `chain_id: "testnet"`.
- Keeps the wallet's active network separately labelled as not independently verified.
- Uses NEAR Connect's `wallet.signAndSendTransaction` API with one `DeployContract` action only after fresh checks and an explicit user click. Meteor must display the exact request for the user to inspect and approve.

## What it deliberately does not do
- It does not request a signed message.
- It never signs or submits automatically; only an explicit user action can open the wallet's approval flow.
- It does not deploy the treasury contract or initialize either contract.
- It does not treat a successful connection or CI source check as proof that the live wallet session will approve the action.
- CI checks both a pinned Meteor executor snapshot and the live manifest/executor source at test time. This is compatibility evidence, not proof of a live wallet signature.
- It does not accept private keys or seed phrases.
- A matching hash is file identity verification only, not a security audit.
- RPC verification confirms only the configured VELTRON RPC endpoint; it does not prove the wallet's active network.
- Connector configuration and wallet capability filtering are not independent proof of the wallet's active network.

## How to use
1. Open the latest successful Contract checks workflow run for the reviewed branch and note its exact commit SHA.
2. Download the `veltron-wasm-<exact-commit-sha>` artifact produced by that run.
3. Extract it and select `veltron_treasury.wasm` and `veltron_test_token.wasm` on the page.
4. Continue only if both hashes match. A file match does not prove the deployed treasury matches; check the finalized on-chain code hash separately.
5. Confirm the VELTRON RPC endpoint reports Testnet. This is not wallet-network verification.
6. Connect the intended testnet wallet. The account ID is displayed, but active network remains explicitly unverified at this stage.
7. If using the deployment control, confirm Testnet in Meteor itself, inspect the exact wallet prompt, and reject any unexpected signer, receiver, network, or action.

## Updating the reference
After any contract-source or build-configuration change, update expected hashes only from a fresh successful CI run on the exact reviewed commit. Never copy hashes from a local build or an older artifact.

Wallet connection does not certify the active network or contract safety. The deployment control performs fresh read-only checks and then requests a single user-approved Testnet transaction; it is not authorization for mainnet or real-fund use.

## Deployment review and approval\n\nThe page offers one user-initiated test-token deployment after fresh checks. It does not expose initialization or treasury deployment. See the detailed gate sequence below.\n\n\n## Meteor wallet executor source check

The NEAR Connect manifest inspected on 2026-11-07 lists Meteor Wallet executor version `1.1.1` at a mutable URL under the `data-storage` branch of `Meteor-Wallet/meteor_wallet_sdk`. That branch pointed to commit `ef1be35fc3712f2de60a7563aed543d78e73f763` when inspected.

The `test:executor` CI check downloads the executor source from that immutable commit and verifies that:
- the `DeployContract` selector action is converted with `actionCreators.deployContract(code)`;
- the single-transaction method maps actions through that converter; and
- the multi-transaction method maps each transaction's actions through that converter.

This is a source-level compatibility regression check only. It does not execute the executor, verify the currently served mutable branch, prove the user's live wallet app runs this exact revision, or send/sign a transaction. A real wallet preview and independent review remain mandatory before any deployment.


## User-initiated test-token deployment

The deploy control is enabled only for the connected account `veltron-token.testnet`. Before it opens a wallet request, the browser:

1. Requires the user to confirm that Meteor itself currently displays Testnet.
2. Recomputes the selected token WASM SHA-256 and verifies the exact 325,106-byte CI artifact.
3. Rechecks the NEAR RPC chain ID, finalized block, protocol configuration, target account balance/storage, and absence of existing contract code.
4. Calculates the modeled one-action transaction fee from the live protocol configuration and gas price, calculates the projected storage reserve, and requires an additional 0.05 NEAR margin.
5. Constructs exactly one `DeployContract` action with receiver `veltron-token.testnet`.

The app then calls NEAR Connect's `wallet.signAndSendTransaction({ receiverId, actions })`. The user must inspect the Meteor prompt and approve it. If the wallet prompt shows a different network, signer, receiver, or action, reject it. A connected wallet or a source-level executor test is not proof that a live signing request will work.

After the wallet request returns, the app reads finalized on-chain code and independently computes SHA-256 over the returned WASM bytes. It reports success only if the on-chain code matches the exact recorded artifact. If the code is not yet visible or differs, stop and do not initialize.

**Initialization is intentionally not available in this change.** It must be a separate transaction review after the deployed code hash is verified, with its own current gas/deposit checks and wallet approval. Never combine deployment and initialization.


## Live treasury configuration panel

The main deployer page also displays the deployed treasury's owner, agent account, per-transaction cap, and pause state using finalized read-only contract views. It queries both `https://rpc.testnet.near.org` and `https://rpc.testnet.fastnear.com`, verifies each reports Testnet, and displays values only when the two snapshots match the reviewed owner/agent configuration and the treasury remains paused. If either provider fails, disagrees, or returns an unexpected safety state, the panel clears the values and reports that configuration is not verified. This panel does not connect a wallet, request a signature, or submit a transaction.

Build and run the mobile dashboard tests with `npm run test:e2e -- --project=iphone-chromium-emulation`.


## Commitment management

The commitment-management page reads finalized treasury position and all active commitments from two independent NEAR Testnet RPC providers at the same finalized block. It withholds state if providers disagree. Create, update, and cancel operations are owner-only and require an explicit NEAR Connect wallet approval. Amounts use exact six-decimal VTT base-unit conversion. The page does not settle commitments or initiate agent payments.

Build the dashboard with `npm run build` and run commitment safety tests with `npm run test:commitments`.

## Owner controls

The owner-controls page exposes existing treasury methods for changing the authorized agent and per-transaction cap, adjusting the safety reserve, pausing/resuming outgoing transfers, settling a recorded commitment, and reconciling a token surplus supported by a successful balance audit no older than five minutes. Each operation is owner-only, uses a fresh dual-provider finalized snapshot, and requires an explicit Meteor wallet approval. The page does not invent agent permission flags that the contract does not implement.

The page also displays current pending transfers, active commitments, and the latest token-balance audit. This is a current-state view, not a complete historical event log: the current contract does not expose a queryable historical event ledger. A full historical audit trail requires a separately designed and independently verified event-indexing source.

Build includes `src/admin-controls.js`. Run the owner-controls regression checks with `npm run test:admin-controls`; browser coverage is included in `npm run test:e2e`.

