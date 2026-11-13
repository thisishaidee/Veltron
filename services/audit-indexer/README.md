# VELTRON audit indexer API

This service is the durable storage and read-API layer for VELTRON's receipt audit events.

## Current scope

- Scheduled finalized-block polling from FastNEAR NEAR Data (`testnet.neardata.xyz` or `mainnet.neardata.xyz`), with extraction of receipt execution outcomes and `EVENT_JSON:` logs for the configured treasury.
- Strict validation of network, treasury account, event standard/version, event names, event provenance and integer-string timestamps.
- D1 persistence with idempotency key `(network, contract_id, receipt_id, log_index)`.
- Atomic D1 batch of event inserts and block-watermark advancement.
- Bounded cursor pagination and filters for event type, actor, transfer ID and commitment ID.
- Explicitly reports `history_complete: false` and `coverage: partial_or_unknown` until a verified historical coverage procedure proves coverage.

**Important:** the scheduled collector is implemented, but the service is not operational until its D1 database, verified `START_BLOCK_HEIGHT` and Worker deployment are configured. It polls finalized blocks in bounded batches and advances its cursor only after block continuity checks. On its first run it also fetches the preceding block and verifies that the configured start block links to that anchor. This does not itself certify complete historical coverage: confirm that NEAR Data serves the full required range, let indexing catch up, and verify continuity, event counts and receipt provenance. The API deliberately keeps `history_complete: false` until a separate, evidence-backed completeness procedure exists.

## Endpoints

- `GET /health`: service identity and configured network/contract.
- `GET /v1/events?limit=50&cursor=...`: read-only event history. Optional filters: `type`, `actor`, `transfer_id`, `commitment_id`.
The scheduled collector reads only finalized NEAR Data block endpoints, filters `receipt_execution_outcomes` by `executor_id === TREASURY_ACCOUNT`, parses logs beginning with `EVENT_JSON:`, and normalizes execution statuses to `SUCCESS_VALUE`, `SUCCESS_RECEIPT_ID`, `FAILURE` or `UNKNOWN`. It preserves the source transaction hash, receipt ID, receipt index, log index, outcome status, block hash and block timestamp. This includes NEP-141 transfer-call receipts that execute `ft_on_transfer` on the treasury. A deterministic shard/receipt ordering is used for pagination; it is not claimed to be a global execution-time ordering across parallel shards.

Receipt logs are retained with their execution status, including failed or unknown outcomes. A log from a failed receipt is not proof that the corresponding state change committed; consumers must inspect `receipt_status` and transaction outcome before interpreting it as a successful financial action. The public read-only `GET /health` and `GET /v1/events` endpoints support browser CORS; no credentials are used for these public chain-derived records. The Worker exposes no external ingestion endpoint: only its scheduled collector can write to D1, preventing a caller from seeding an unanchored cursor or injecting fabricated event provenance.

## Local validation

```sh
cd services/audit-indexer
npm test
```

## Provisioning (not performed by this PR)

1. Create a Cloudflare D1 database named `veltron-audit-index`.
2. Replace the placeholder `database_id` in `wrangler.jsonc` with the provisioned ID.
3. Apply `schema.sql` using the Cloudflare D1 migration workflow.
4. Set `START_BLOCK_HEIGHT` to a verified finalized block at or before the treasury contract deployment; never guess this value. On first run, the collector verifies the immediately preceding finalized block hash as the start anchor.
5. Deploy the Worker and verify health, scheduled ingestion and pagination endpoints.
6. Allow the bounded scheduled collector to catch up from `START_BLOCK_HEIGHT`; confirm sequential block hashes, receipt counts and provenance.
7. Verify finalized block continuity, event counts and provenance before setting any UI completeness indicator.

No contract deployment, wallet signing, treasury transaction or Worker deployment is performed by this repository change.


## Protected manual recovery trigger

The scheduled collector is the normal indexing path. For operator-led recovery or an immediate one-off verification, an optional protected endpoint is available:

1. Set a strong secret outside source control: `wrangler secret put INDEXER_TRIGGER_TOKEN`.
2. Send `POST /internal/run-indexer` with `Authorization: Bearer <token>`.
3. The handler accepts no caller-supplied block, event, or database payload. It invokes the same finalized-block collector and continuity checks used by the scheduled trigger.

The endpoint returns 404 unless the request is a POST with the configured secret. Never place the token in repository files, URLs, browser code, or logs. This endpoint does not change treasury state or submit NEAR transactions.
