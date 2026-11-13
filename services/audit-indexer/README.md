# VELTRON audit indexer API

This service is the durable storage and read-API layer for VELTRON's receipt audit events.

## Current scope

- Authenticated ingestion of finalized block batches from a separately operated NEAR receipt collector.
- Strict validation of network, treasury account, event standard/version, event names, event provenance and integer-string timestamps.
- D1 persistence with idempotency key `(network, contract_id, receipt_id, log_index)`.
- Atomic D1 batch of event inserts and block-watermark advancement.
- Bounded cursor pagination and filters for event type, actor, transfer ID and commitment ID.
- Explicitly reports `history_complete: false` and `coverage: partial_or_unknown` until a verified archival backfill process proves coverage.

**Important:** this API does not yet collect blocks from NEAR by itself. A separate archival NEAR receipt collector must submit finalized, sequential block batches to the authenticated ingestion endpoint. Do not describe the history feed as complete or production-live until that collector, archival source, backfill, D1 database and Worker are provisioned and verified.

## Endpoints

- `GET /health`: service identity and configured network/contract.
- `GET /v1/events?limit=50&cursor=...`: read-only event history. Optional filters: `type`, `actor`, `transfer_id`, `commitment_id`.
- `POST /internal/v1/blocks`: authenticated finalized-block ingestion.

The ingestion body has this shape:

```json
{
  "network": "testnet",
  "contract_id": "veltron-treasury.testnet",
  "finalized": true,
  "block_height": 123,
  "block_hash": "NEAR block hash",
  "block_timestamp_ns": "123456789",
  "events": [{
    "receipt_id": "receipt ID",
    "transaction_hash": "transaction hash",
    "receipt_index": 0,
    "log_index": 0,
    "receipt_status": "SUCCESS_VALUE",
    "envelope": {
      "standard": "veltron",
      "version": "1.0.0",
      "event": "payment_requested",
      "data": [{ "actor_id": "veltron-agent.testnet", "timestamp_ns": "123456789" }]
    }
  }]
}
```

The upstream collector must normalize NEAR execution statuses to `SUCCESS_VALUE`, `SUCCESS_RECEIPT_ID`, `FAILURE` or `UNKNOWN`, and only mark a block finalized after the chosen NEAR archival source's finality guarantees are satisfied. It must include all receipts and event logs for the configured treasury, including NEP-141 transfer-call receipts that invoke `ft_on_transfer`. Preserve transaction hash, receipt ID, receipt index, log index, outcome status, block hash and block timestamp exactly as returned by the source.

## Local validation

```sh
cd services/audit-indexer
npm test
```

## Provisioning (not performed by this PR)

1. Create a Cloudflare D1 database named `veltron-audit-index`.
2. Replace the placeholder `database_id` in `wrangler.jsonc` with the provisioned ID.
3. Apply `schema.sql` using the Cloudflare D1 migration workflow.
4. Set `INGEST_TOKEN` as a Worker secret. Never commit it.
5. Deploy the Worker and verify health and pagination endpoints.
6. Deploy and operate the archival NEAR receipt collector, with a durable source cursor and replay/backfill.
7. Verify finalized block continuity, event counts and provenance before setting any UI completeness indicator.

No contract deployment, wallet signing, treasury transaction or Worker deployment is performed by this repository change.
