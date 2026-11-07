# VELTRON Testnet Deployer — Stage 1

This directory contains a static, browser-only artifact preflight page and a read-only NEAR wallet connection.

## What it does
- Accepts the two WASM files extracted from the recorded GitHub Actions artifact.
- Computes SHA-256 with the browser Web Crypto API.
- Compares each file against hashes recorded from CI run for commit `e6ac9aca4228032701d42dd167bd822fd5e94209`.
- Configures NEAR Connect for Testnet and enables wallets advertising Testnet support.
- Reads the connected account ID from the wallet sign-in event.
- Checks the configured VELTRON RPC endpoint with a read-only NEAR status request and reports Testnet only when the response says `chain_id: "testnet"`.
- Keeps the wallet's active network separately labelled as not independently verified.
- Explicitly reports deployment-action support as unverified; a successful connection is not proof that a wallet can sign and submit `DeployContract`.

## What it deliberately does not do
- It does not request a signed message or transaction.
- It does not sign or submit transactions.
- It does not deploy or initialize either contract.
- It does not infer `DeployContract` support from a successful connection or from the connector exposing a generic transaction method.
- CI performs a source-level check against an immutable snapshot of Meteor's published NEAR Connect executor. This verifies the upstream conversion path in that snapshot, not the currently served mutable executor or a live wallet signature.
- It does not accept private keys or seed phrases.
- A matching hash is file identity verification only, not a security audit.
- RPC verification confirms only the configured VELTRON RPC endpoint; it does not prove the wallet's active network.
- Connector configuration and wallet capability filtering are not independent proof of the wallet's active network.

## How to use
1. Open the workflow run for commit `e6ac9aca4228032701d42dd167bd822fd5e94209`.
2. Download the `veltron-wasm-a2f224a490c8dd9b9e42fcd5252330b7e58972de` artifact.
3. Extract it and select `veltron_treasury.wasm` and `veltron_test_token.wasm` on the page.
4. Continue only if both hashes match.
5. Confirm the VELTRON RPC endpoint reports Testnet. This is not wallet-network verification.
6. Connect the intended testnet wallet. The account ID is displayed, but active network remains explicitly unverified at this stage.
7. Treat deployment-action support as unverified until that exact wallet/browser combination is independently confirmed. Do not use a real deployment transaction as a capability probe.

## Updating the reference
After any contract-source or build-configuration change, update expected hashes only from a fresh successful CI run on the exact reviewed commit. Never copy hashes from a local build or an older artifact.

This is an initial preflight stage, not a deployment tool. Wallet connection does not certify the active network, contract safety, or authorize deployment.

## Deployment transaction review preview

The page also displays a **non-executable** review of the proposed test-token deployment followed by a separate initialization step. It shows the target account, DeployContract action, expected WASM SHA-256, and proposed initializer arguments. Gas and attached deposit remain explicitly unresolved pending independent calculation and review.

This preview adds no signing or transaction-submission capability. Do not treat the displayed sequence as authorization to deploy. Before implementation of any signing flow, independently verify the wallet's active network, target account state, artifact hash, protocol gas/deposit requirements, and exact transaction shown by the wallet. After deployment, verify the on-chain code hash before preparing a separate initialization transaction.


## Meteor wallet executor source check

The NEAR Connect manifest inspected on 2026-11-07 lists Meteor Wallet executor version `1.1.1` at a mutable URL under the `data-storage` branch of `Meteor-Wallet/meteor_wallet_sdk`. That branch pointed to commit `ef1be35fc3712f2de60a7563aed543d78e73f763` when inspected.

The `test:executor` CI check downloads the executor source from that immutable commit and verifies that:
- the `DeployContract` selector action is converted with `actionCreators.deployContract(code)`;
- the single-transaction method maps actions through that converter; and
- the multi-transaction method maps each transaction's actions through that converter.

This is a source-level compatibility regression check only. It does not execute the executor, verify the currently served mutable branch, prove the user's live wallet app runs this exact revision, or send/sign a transaction. A real wallet preview and independent review remain mandatory before any deployment.
