# VELTRON Treasury Dashboard

This is the first dashboard milestone: a mobile-first, read-only Testnet monitor.

## What it reads

The dashboard is pinned to `veltron-treasury.testnet` and reads finalized NEAR Testnet state through public RPC:

- `get_financial_position`
- `get_pause_status`
- `get_commitments`
- `get_pending_transfers`
- `get_token_balance_audit`

It also reads the account's code hash and storage usage before attempting contract views. If no contract code is installed, it reports that the treasury is not deployed.

## Safety boundary

- No wallet connector or wallet session.
- No message signing or transaction signing.
- No contract calls that change state.
- No token transfers, deployment, or initialization.
- RPC requests are pinned to NEAR Testnet and the dedicated treasury account.
- Amounts are shown as raw token units; the UI does not assume token decimals.

This dashboard is not an authorization to deploy or initialize the contract. Owner actions and agent execution controls will be designed as a separate, reviewed milestone after read-only monitoring is verified against an initialized testnet contract.

## Run locally

Serve this directory with any static HTTP server, then open `index.html`. ES modules should be served over HTTP rather than opened as a `file://` URL.

## Tests

From this directory:

```bash
npm test
```


## Integrated audit history

The dashboard also reads the dedicated VELTRON Testnet audit API at `https://veltron-audit-indexer.haideecoded-e0f.workers.dev`. It displays the latest indexed block, coverage status, and recent events. A partial watermark is never treated as proof of complete history.

The **Owner control center** and **Full financial audit history** links open the separately deployed Cloudflare Pages application. The dashboard itself remains read-only and never requests a wallet signature.
