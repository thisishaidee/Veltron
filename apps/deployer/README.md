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

## What it deliberately does not do
- It does not request a signed message or transaction.
- It does not sign or submit transactions.
- It does not deploy or initialize either contract.
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

## Updating the reference
After any contract-source or build-configuration change, update expected hashes only from a fresh successful CI run on the exact reviewed commit. Never copy hashes from a local build or an older artifact.

This is an initial preflight stage, not a deployment tool. Wallet connection does not certify the active network, contract safety, or authorize deployment.
