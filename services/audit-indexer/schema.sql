PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS indexer_cursors (
  network TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  block_height INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp_ns TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (network, contract_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  network TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_height INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp_ns TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  receipt_index INTEGER NOT NULL,
  receipt_status TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_timestamp_ns TEXT NOT NULL,
  transfer_id TEXT,
  commitment_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (network, contract_id, receipt_id, log_index)
);

CREATE INDEX IF NOT EXISTS audit_events_order_idx
  ON audit_events (network, contract_id, block_height DESC, receipt_index DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS audit_events_type_idx
  ON audit_events (network, contract_id, event_type, block_height DESC, receipt_index DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON audit_events (network, contract_id, actor_id, block_height DESC, receipt_index DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS audit_events_transfer_idx
  ON audit_events (network, contract_id, transfer_id, block_height DESC, receipt_index DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS audit_events_commitment_idx
  ON audit_events (network, contract_id, commitment_id, block_height DESC, receipt_index DESC, log_index DESC);
