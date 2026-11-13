const EVENT_NAMES = new Set([
  "treasury_initialized", "deposit_credited", "commitment_created", "commitment_updated",
  "commitment_cancelled", "pause_status_changed", "safety_reserve_updated",
  "agent_configuration_updated", "payment_requested", "payment_approved",
  "payment_rejected", "transfer_started", "transfer_succeeded", "transfer_failed",
  "balance_audit_requested", "balance_audit_completed", "balance_audit_failed", "surplus_reconciled"
]);
const MAX_BATCH_EVENTS = 500;
const MAX_D1_BATCH_STATEMENTS = 900;

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function requiredString(value, name, max = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(name + " must be a non-empty string of at most " + max + " characters");
  }
  return value;
}

function validateEvent(input, block, expectedContract) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Each event must be an object");
  if (!isSafeInteger(input.log_index)) throw new Error("log_index must be a non-negative safe integer");
  const receiptId = requiredString(input.receipt_id, "receipt_id");
  const transactionHash = requiredString(input.transaction_hash, "transaction_hash");
  if (!isSafeInteger(input.receipt_index)) throw new Error("receipt_index must be a non-negative safe integer");
  if (!["SUCCESS_VALUE", "SUCCESS_RECEIPT_ID", "FAILURE", "UNKNOWN"].includes(input.receipt_status)) {
    throw new Error("receipt_status must preserve the normalized NEAR execution outcome status");
  }
  if (!input.envelope || input.envelope.standard !== "veltron" || input.envelope.version !== "1.0.0") {
    throw new Error("Unsupported VELTRON event standard or version");
  }
  if (!EVENT_NAMES.has(input.envelope.event)) throw new Error("Unknown VELTRON event type");
  if (!Array.isArray(input.envelope.data) || input.envelope.data.length !== 1) throw new Error("Event data must contain exactly one object");
  const data = input.envelope.data[0];
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Event data item must be an object");
  const actorId = requiredString(data.actor_id, "actor_id", 128);
  const eventTimestamp = requiredString(data.timestamp_ns, "timestamp_ns", 40);
  if (!/^\d+$/.test(eventTimestamp)) throw new Error("timestamp_ns must be a decimal integer string");
  if (block.contract_id !== expectedContract) throw new Error("Unexpected contract_id");
  return {
    receiptId, transactionHash, actorId, eventTimestamp,
    eventType: input.envelope.event, eventVersion: input.envelope.version,
    transferId: data.transfer_id == null ? null : String(data.transfer_id),
    commitmentId: data.commitment_id == null ? null : String(data.commitment_id),
    payload: JSON.stringify(input.envelope),
    receiptIndex: input.receipt_index, logIndex: input.log_index, receiptStatus: input.receipt_status
  };
}

function eventInsertStatement(db, config, block, event) {
  return db.prepare(`
    INSERT OR IGNORE INTO audit_events (
      network, contract_id, receipt_id, log_index, block_height, block_hash,
      block_timestamp_ns, transaction_hash, receipt_index, receipt_status,
      event_type, event_version, actor_id, event_timestamp_ns, transfer_id,
      commitment_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    config.network, config.contractId, event.receiptId, event.logIndex,
    block.block_height, block.block_hash, block.block_timestamp_ns,
    event.transactionHash, event.receiptIndex, event.receiptStatus,
    event.eventType, event.eventVersion, event.actorId, event.eventTimestamp,
    event.transferId, event.commitmentId, event.payload
  );
}

function cursorUpsertStatement(db, config, block) {
  const complete = block.coverage_start_height > 0 && block.block_height >= block.finalized_head_height;
  return db.prepare(`
    INSERT INTO indexer_cursors (
      network, contract_id, block_height, block_hash, block_timestamp_ns,
      coverage_start_height, finalized_head_height, history_complete, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(network, contract_id) DO UPDATE SET
      block_height = excluded.block_height,
      block_hash = excluded.block_hash,
      block_timestamp_ns = excluded.block_timestamp_ns,
      finalized_head_height = excluded.finalized_head_height,
      history_complete = excluded.history_complete,
      updated_at = CURRENT_TIMESTAMP
    WHERE excluded.block_height >= indexer_cursors.block_height
  `).bind(
    config.network, config.contractId, block.block_height, block.block_hash,
    block.block_timestamp_ns, block.coverage_start_height,
    block.finalized_head_height, complete ? 1 : 0
  );
}

export async function ingestBlocks(db, config, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error("At least one finalized block is required");
  if (!config || !config.network || !config.contractId) throw new Error("Network and contract configuration are required");

  const existing = await db.prepare(
    "SELECT block_height, block_hash, coverage_start_height FROM indexer_cursors WHERE network = ? AND contract_id = ?"
  ).bind(config.network, config.contractId).first();

  let expectedHeight = existing ? existing.block_height + 1 : blocks[0].block_height;
  let expectedPreviousHash = existing?.block_hash ?? null;
  const coverageStartHeight = existing?.coverage_start_height ?? blocks[0].coverage_start_height;
  const eventStatements = [];
  let accepted = 0;

  for (const block of blocks) {
    if (!block || block.finalized !== true) throw new Error("Only finalized blocks may be ingested");
    if (block.network !== config.network) throw new Error("Network mismatch");
    if (block.contract_id !== config.contractId) throw new Error("Contract mismatch");
    if (!isSafeInteger(block.block_height) || block.block_height !== expectedHeight) {
      throw new Error("Block gap or unexpected height detected; refusing to advance the cursor");
    }
    requiredString(block.block_hash, "block_hash");
    requiredString(block.prev_block_hash, "prev_block_hash");
    requiredString(block.block_timestamp_ns, "block_timestamp_ns");
    if (!/^\d+$/.test(block.block_timestamp_ns)) throw new Error("block_timestamp_ns must be a decimal integer string");
    if (!isSafeInteger(block.coverage_start_height) || block.coverage_start_height !== coverageStartHeight ||
        block.coverage_start_height > block.block_height) {
      throw new Error("coverage_start_height changed or is invalid");
    }
    if (!isSafeInteger(block.finalized_head_height) || block.finalized_head_height < block.block_height) {
      throw new Error("finalized_head_height must be at or above the ingested finalized block");
    }
    if (expectedPreviousHash && block.prev_block_hash !== expectedPreviousHash) {
      throw new Error("Previous block hash does not match the durable finalized cursor");
    }
    if (!Array.isArray(block.events) || block.events.length > MAX_BATCH_EVENTS) {
      throw new Error("events must be an array containing at most " + MAX_BATCH_EVENTS + " entries");
    }

    for (const input of block.events) {
      eventStatements.push(eventInsertStatement(db, config, block, validateEvent(input, block, config.contractId)));
      accepted++;
    }
    expectedPreviousHash = block.block_hash;
    expectedHeight++;
  }

  const lastBlock = blocks[blocks.length - 1];
  const complete = lastBlock.coverage_start_height > 0 && lastBlock.block_height >= lastBlock.finalized_head_height;

  // Event rows are idempotent. If a large event batch must be split, the durable
  // cursor is written only after every event batch succeeds; a retry safely
  // replays any already-inserted rows through INSERT OR IGNORE.
  for (let offset = 0; offset < eventStatements.length; offset += MAX_D1_BATCH_STATEMENTS) {
    await db.batch(eventStatements.slice(offset, offset + MAX_D1_BATCH_STATEMENTS));
  }
  await db.batch([cursorUpsertStatement(db, config, lastBlock)]);

  return {
    accepted,
    block_height: lastBlock.block_height,
    history_complete: complete
  };
}

export async function ingestBlock(db, config, block) {
  return await ingestBlocks(db, config, [block]);
}
