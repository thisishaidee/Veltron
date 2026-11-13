# VELTRON audit indexer API

This service is the durable storage and read-API layer for VELTRON's receipt audit events.

## Current scope

- Scheduled finalized-block polling uses FastNear RPC first, then dRPC and official NEAR RPC fallbacks for finalized head and anchor checks. FastNear Transactions API identifies transactions that delivered receipts to the treasury and returns their receipt execution outcomes/logs in batches of up to 20 transactions; FastNear Block Range supplies up to 100 finalized block headers per request.
- Strict validation of network, treasury account, event standard/version, event names, event provenance and integer-string timestamps.
- D1 persistence with idempotency key `(network, contract_id, receipt_id, log_index)`.
- Atomic D1 batch of event inserts and block-watermark advancement.
- Bounded cursor pagination and filters for event type, actor, transfer ID and commitment ID.
- Records `coverage_start_height`, `finalized_head_height`, and `history_complete`; coverage is complete only after every finalized block from the configured start height through the recorded finalized head has passed sequential hash-continuity checks.

**Current deployment:** the dedicated VELTRON D1 database and `veltron-audit-indexer` Worker are provisioned and deployed. The event-emitting treasury release is installed and coverage begins at its first finalized block. The Worker uses a rolling 10,000-block account-history lookback so receipts originating shortly before the current cursor are still considered when their execution is finalized later. The production schedule is configured at a five-minute cadence while the indexed provider is monitored for rate limits.

On the first run, the collector fetches the block immediately before `START_BLOCK_HEIGHT` from canonical NEAR RPC and verifies the first bulk block header links to that anchor. It advances the cursor only after every returned header is contiguous and its previous hash matches the durable cursor. `history_complete` becomes true only when the cursor reaches the finalized head; it means complete structured-event coverage from the configured start block forward, not a reconstruction of activity before that block.

## Endpoints

- `GET /health`: service identity and configured network/contract.
- `GET /v1/events?limit=50&cursor=...`: read-only event history. Optional filters: `type`, `actor`, `transfer_id`, `commitment_id`.
The scheduled collector uses the account-history endpoint with `is_receiver=true` to find transactions that delivered receipts to the treasury, then fetches transaction details in batches and filters receipt execution outcomes by `executor_id === TREASURY_ACCOUNT`. It parses logs beginning with `EVENT_JSON:` and normalizes execution statuses to `SUCCESS_VALUE`, `SUCCESS_RECEIPT_ID`, `FAILURE` or `UNKNOWN`. It preserves the source transaction hash, receipt ID, receipt index, log index, outcome status, block hash and block timestamp. This includes NEP-141 transfer-call receipts that execute `ft_on_transfer` on the treasury. Block headers are fetched in contiguous ranges of up to 100 and verified against the durable hash cursor. The 10,000-block transaction lookback is intentional: it rechecks earlier transactions for receipts whose execution lands after the current cursor.

Receipt logs are retained with their execution status, including failed or unknown outcomes. A log from a failed receipt is not proof that the corresponding state change committed; consumers must inspect `receipt_status` and transaction outcome before interpreting it as a successful financial action. The public read-only `GET /health` and `GET /v1/events` endpoints support browser CORS; no credentials are used for these public chain-derived records. The Worker exposes no public ingestion endpoint: only its scheduled collector or protected manual trigger can write to D1, and neither accepts caller-supplied blocks or events.

## Local validation

```sh
cd services/audit-indexer
npm test
```

## Dedicated Cloudflare resources

- D1 database: `veltron-audit-index`
- D1 database ID: `1a2c1f9c-d6a0-48c0-829c-a8e840c9913b`
- D1 region: `WEUR` (Amsterdam)
- Worker: `veltron-audit-indexer`
- Worker API: `https://veltron-audit-indexer.haideecoded-e0f.workers.dev`
- D1 binding: `AUDIT_DB`
- Network and contract: `testnet` / `veltron-treasury.testnet`

The existing D1 schema is created from `schema.sql`; migration `migrations/0002_coverage_metadata.sql` adds the coverage start, finalized-head and completion columns. The release boundary is already configured at the first finalized block after the code-only treasury upgrade. The D1 cursor and all existing `audit_events` are preserved. The scheduled scan must remain read-only with respect to treasury state; only finalized block metadata and verified contract receipt logs are written to D1. Do not label coverage complete until the cursor reaches the recorded finalized head.

## Protected manual recovery trigger

The scheduled collector is the normal indexing path. For operator-led recovery or an immediate one-off verification, an optional protected endpoint is available:

1. Set a strong secret outside source control: `wrangler secret put INDEXER_TRIGGER_TOKEN`.
2. Send `POST /internal/run-indexer` with `Authorization: Bearer <token>`.
3. The handler accepts no caller-supplied block, event, or database payload. It invokes the same finalized-block collector and continuity checks used by the scheduled trigger.

The endpoint returns 404 unless the request is a POST with the configured secret. Never place the token in repository files, URLs, browser code, or logs. This endpoint does not change treasury state or submit NEAR transactions.
