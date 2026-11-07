# VELTRON Testnet Deployer — Stage 1

This directory contains a static, browser-only artifact preflight page and a read-only NEAR Testnet wallet connection.

## What it does
- Accepts the two WASM files extracted from the recorded GitHub Actions artifact.
- Computes SHA-256 with the browser Web Crypto API.
- Compares each file against hashes recorded from CI run for commit `0f2ef4fbc4aeb7ed21eaaf99ea6dfa8a3bc0d69e`.
- Connects through NEAR Connect to wallets advertising Testnet support.
- Reads the connected account ID from the wallet sign-in event.
- Reads the active network from the connected wallet metadata. It reports Testnet only when the wallet reports `networkId: "testnet"`; a mismatch or unavailable network is explicitly shown as unverified.

## What it deliberately does not do
- It does not request a signed message or transaction.
- It does not sign or submit transactions.
- It does not deploy or initialize either contract.
- It does not accept private keys or seed phrases.
- A matching hash is file identity verification only, not a security audit.
- Wallet network metadata is a client-reported session property, not an independent on-chain attestation.

## How to use
1. Open the workflow run for commit `0f2ef4fbc4aeb7ed21eaaf99ea6dfa8a3bc0d69e`.
2. Download the `veltron-wasm-0f2ef4fbc4aeb7ed21eaaf99ea6dfa8a3bc0d69e` artifact.
3. Extract it and select `veltron_treasury.wasm` and `veltron_test_token.wasm` on the page.
4. Continue only if both hashes match.
5. Connect the intended testnet wallet. Continue only if the account and wallet-reported network are correct.

## Updating the reference
After any contract-source or build-configuration change, update expected hashes only from a fresh successful CI run on the exact reviewed commit. Never copy hashes from a local build or an older artifact.

This is an initial preflight stage, not a deployment tool. A displayed Testnet network is a wallet-reported property and does not certify contract safety or authorize deployment.
