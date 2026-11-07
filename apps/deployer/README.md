# VELTRON Testnet Deployer — Stage 1

This directory contains a static, browser-only artifact preflight page.

## What it does
- Accepts the two WASM files extracted from the recorded GitHub Actions artifact.
- Computes SHA-256 with the browser Web Crypto API.
- Compares each file against hashes recorded from CI run for commit `0f2ef4fbc4aeb7ed21eaaf99ea6dfa8a3bc0d69e`.
- Displays the currently agreed Testnet account/configuration values for human review.

## What it deliberately does not do
- It does not connect to Meteor or any other wallet.
- It does not sign or submit transactions.
- It does not deploy or initialize either contract.
- It does not accept private keys or seed phrases.
- A matching hash is file identity verification only, not a security audit.

## How to use
1. Open the workflow run for commit `0f2ef4fbc4aeb7ed21eaaf99ea6dfa8a3bc0d69e`.
2. Download the `veltron-wasm-0f2ef4fbc4aeb7ed21eaaf99ea6dfa8a3bc0d69e` artifact.
3. Extract it and select `veltron_treasury.wasm` and `veltron_test_token.wasm` on the page.
4. Continue only if both hashes match.

## Updating the reference
After any contract-source or build-configuration change, update expected hashes only from a fresh successful CI run on the exact reviewed commit. Never copy hashes from a local build or an older artifact.

This is an initial preflight stage, not a deployment tool. Wallet integration and transaction preview require separate review and testing.
