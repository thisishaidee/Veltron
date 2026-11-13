# VELTRON financial audit events

## Status

The treasury contract emits structured NEP-297-compatible logs under the `EVENT_JSON:` prefix. These logs are immutable parts of NEAR transaction receipts. This change is the on-chain event source only: it does **not** ship or operate a historical event indexer, database, or history API. The dashboard must not label the event stream as a complete searchable audit history until that separate service is deployed and verified.

## Envelope

Each log has the NEP-297 envelope:

```json
{
  "standard": "veltron",
  "version": "1.0.0",
  "event": "payment_requested",
  "data": [{
    "actor_id": "veltron-agent.testnet",
    "timestamp_ns": "123456789",
    "request_id": "7",
    "recipient_id": "vendor.testnet",
    "amount": "2500000",
    "memo": "Invoice 123"
  }]
}
```

All token quantities and nanosecond timestamps are decimal strings. Consumers must parse amounts as arbitrary-precision integers, never JavaScript floating-point numbers. The timestamp and actor are emitted by the contract at the point the event is logged. For callback events, the actor is the treasury contract account because the callback is executed by the contract itself; transaction and receipt provenance remains the authoritative source for who initiated the original action.

## Event catalogue

| Event | Meaning | Important fields |
| --- | --- | --- |
| `treasury_initialized` | Initial treasury authorization and spending baseline recorded at initialization | treasury, owner, token, agent, transaction cap, safety reserve, initial ledger balance, pause state |
| `deposit_credited` | NEP-141 deposit credited to the internal ledger | sender, token, amount, resulting ledger balance |
| `commitment_created` | New protected obligation created | commitment ID, recipient, amount, description |
| `commitment_updated` | Existing obligation changed | ID, previous/new recipient, previous/new amount, description |
| `commitment_cancelled` | Obligation released | ID, recipient, amount, description |
| `pause_status_changed` | Emergency outgoing-payment pause toggled | previous/current paused state |
| `safety_reserve_updated` | Protected reserve changed | previous/new amount |
| `agent_configuration_updated` | Authorized agent or cap changed | previous/new agent and cap |
| `payment_requested` | Agent proposed a payment | request ID, recipient, amount, memo |
| `payment_approved` | Owner approved an agent request | request ID, transfer ID, recipient, amount |
| `payment_rejected` | Owner rejected an agent request | request ID, recipient, amount, memo |
| `transfer_started` | Outgoing token transfer was initiated | transfer ID, recipient, amount, kind, optional commitment ID |
| `transfer_succeeded` | Transfer callback confirmed success | transfer ID, recipient, amount, kind, resulting ledger balance |
| `transfer_failed` | Transfer callback reported failure | transfer ID, recipient, amount, kind, unchanged ledger balance |
| `balance_audit_requested` | Read-only token balance audit started | token ID |
| `balance_audit_completed` | Token balance query completed | observed token balance, ledger balance, observation time |
| `balance_audit_failed` | Token balance query failed | ledger balance |
| `surplus_reconciled` | Owner credited a verified observed surplus | amount, observed token balance, ledger before/after |

Events are emitted after the corresponding state validation and mutation in the receipt. If a receipt later fails, its state changes are rolled back but its execution outcome may still retain logs emitted before the failure. Indexers must preserve `receipt_status`; a log from a failed or unknown receipt is not proof that the corresponding state change committed. A transfer start and its eventual callback result are separate events in separate receipts.

## Indexer requirements

A production audit indexer must:

1. Subscribe to an archival NEAR receipt/event source for the configured treasury account and Testnet/Mainnet network.
2. Parse only logs beginning with `EVENT_JSON:`, validate `standard=veltron`, supported version and known event names, and reject malformed payloads.
3. Store receipt provenance with every event: network, contract account, block height/hash, block timestamp, transaction hash, receipt ID, receipt outcome status, and log index.
4. Use the stable idempotency key `(network, contract_id, receipt_id, log_index)`; do not deduplicate on event payload or local timestamp.
5. Persist a durable block/stream cursor and support replay/backfill. Commit event rows and cursor advancement atomically so restarts cannot skip events.
6. Handle reorg/finality semantics from the chosen NEAR data source; expose only finalized events as confirmed history.
7. Provide bounded, cursor-based pagination ordered by block height, receipt index and log index, with filters for event type, account, transfer ID and commitment ID.
8. Return source provenance and a clear indexing watermark in every API response. Never present a partial backfill as complete history.
9. Treat callback events as outcomes, not as proof that a transfer succeeded unless the receipt outcome itself is successful and the event is `transfer_succeeded`.
10. Keep the event feed read-only. It must never sign transactions or trigger treasury actions.

## Acceptance criteria for the history UI

- Shows only events returned by the configured indexer API, not browser-local guesses or current-state snapshots.
- Distinguishes requested, approved, started, succeeded, failed and rejected payment stages.
- Links each item to its NEAR transaction/receipt provenance.
- Shows the indexed-through block and whether the requested date range is fully indexed.
- Supports pagination without gaps or duplicate rows.
- Displays token amounts exactly using integer-safe formatting.
- Clearly distinguishes event history from the contract's current-state balance audit.

## Compatibility

The event schema version is `1.0.0`. Additive fields may be introduced without changing the version; changing event names, field meanings, or numeric encodings requires a documented versioning decision and corresponding indexer compatibility tests.
