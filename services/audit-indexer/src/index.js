import { runFinalizedIndexer } from "./collector.js";

const EVENT_NAMES = new Set([
  "treasury_initialized",
  "deposit_credited",
  "commitment_created",
  "commitment_updated",
  "commitment_cancelled",
  "pause_status_changed",
  "safety_reserve_updated",
  "agent_configuration_updated",
  "payment_requested",
  "payment_approved",
  "payment_rejected",
  "transfer_started",
  "transfer_succeeded",
  "transfer_failed",
  "balance_audit_requested",
  "balance_audit_completed",
  "balance_audit_failed",
  "surplus_reconciled"
]);
const MAX_BATCH_EVENTS = 500;
const MAX_PAGE_SIZE = 100;

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

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
  if (!Array.isArray(input.envelope.data) || input.envelope.data.length !== 1) {
    throw new Error("Event data must contain exactly one object");
  }
  const data = input.envelope.data[0];
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Event data item must be an object");
  const actorId = requiredString(data.actor_id, "actor_id", 128);
  const eventTimestamp = requiredString(data.timestamp_ns, "timestamp_ns", 40);
  if (!/^\d+$/.test(eventTimestamp)) throw new Error("timestamp_ns must be a decimal integer string");
  if (block.contract_id !== expectedContract) throw new Error("Unexpected contract_id");
  return {
    receiptId, transactionHash, actorId, eventTimestamp,
    eventType: input.envelope.event,
    eventVersion: input.envelope.version,
    transferId: data.transfer_id == null ? null : String(data.transfer_id),
    commitmentId: data.commitment_id == null ? null : String(data.commitment_id),
    payload: JSON.stringify(input.envelope),
    receiptIndex: input.receipt_index,
    logIndex: input.log_index,
    receiptStatus: input.receipt_status
  };
}

async function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}

function encodeCursor(row) {
  const raw = JSON.stringify([row.block_height, row.receipt_index, row.log_index]);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized));
    if (!Array.isArray(decoded) || decoded.length !== 3 || !decoded.every(isSafeInteger)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function rowToEvent(row) {
  return {
    event_id: [row.network, row.contract_id, row.receipt_id, row.log_index].join(":"),
    network: row.network,
    contract_id: row.contract_id,
    event: row.event_type,
    version: row.event_version,
    data: JSON.parse(row.payload_json).data[0],
    provenance: {
      block_height: row.block_height,
      block_hash: row.block_hash,
      block_timestamp_ns: row.block_timestamp_ns,
      transaction_hash: row.transaction_hash,
      receipt_id: row.receipt_id,
      receipt_index: row.receipt_index,
      log_index: row.log_index,
      receipt_status: row.receipt_status
    }
  };
}

export async function ingestBlock(db, config, block) {
  if (!block || block.finalized !== true) throw new Error("Only finalized blocks may be ingested");
  if (block.network !== config.network) throw new Error("Network mismatch");
  if (block.contract_id !== config.contractId) throw new Error("Contract mismatch");
  if (!isSafeInteger(block.block_height)) throw new Error("Invalid block height");
  requiredString(block.block_hash, "block_hash");
  requiredString(block.prev_block_hash, "prev_block_hash");
  requiredString(block.block_timestamp_ns, "block_timestamp_ns");
  if (!/^\d+$/.test(block.block_timestamp_ns)) throw new Error("block_timestamp_ns must be a decimal integer string");
  if (!Array.isArray(block.events) || block.events.length > MAX_BATCH_EVENTS) {
    throw new Error("events must be an array containing at most " + MAX_BATCH_EVENTS + " entries");
  }

  const validated = block.events.map((event) => validateEvent(event, block, config.contractId));
  const existing = await db.prepare(
    "SELECT block_height FROM indexer_cursors WHERE network = ? AND contract_id = ?"
  ).bind(config.network, config.contractId).first();
  if (existing && block.block_height < existing.block_height) {
    throw new Error("Block height moved behind the durable cursor");
  }
  if (existing && block.block_height === existing.block_height && block.block_hash !== existing.block_hash) {
    throw new Error("Block hash changed at the current finalized cursor");
  }
  if (existing && block.block_height > existing.block_height + 1) {
    throw new Error("Block gap detected; refusing to advance the cursor past unindexed heights");
  }
  if (existing && block.block_height === existing.block_height + 1 && block.prev_block_hash !== existing.block_hash) {
    throw new Error("Previous block hash does not match the durable finalized cursor");
  }

  const statements = validated.map((event) => db.prepare(`
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
  ));
  statements.push(db.prepare(`
    INSERT INTO indexer_cursors (network, contract_id, block_height, block_hash, block_timestamp_ns, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(network, contract_id) DO UPDATE SET
      block_height = excluded.block_height,
      block_hash = excluded.block_hash,
      block_timestamp_ns = excluded.block_timestamp_ns,
      updated_at = CURRENT_TIMESTAMP
    WHERE excluded.block_height >= indexer_cursors.block_height
  `).bind(config.network, config.contractId, block.block_height, block.block_hash, block.block_timestamp_ns));
  await db.batch(statements);
  return { accepted: validated.length, block_height: block.block_height };
}

async function getEvents(request, env) {
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(MAX_PAGE_SIZE, limitRaw)) : 50;
  const filters = ["network = ?", "contract_id = ?"];
  const values = [env.NETWORK, env.TREASURY_ACCOUNT];
  for (const [param, column] of [["type", "event_type"], ["actor", "actor_id"], ["transfer_id", "transfer_id"], ["commitment_id", "commitment_id"]]) {
    const value = url.searchParams.get(param);
    if (value) { filters.push(column + " = ?"); values.push(value.slice(0, 256)); }
  }
  const cursorValue = url.searchParams.get("cursor");
  if (cursorValue) {
    const cursor = decodeCursor(cursorValue);
    if (!cursor) return jsonResponse({ error: "Invalid pagination cursor" }, 400);
    filters.push("(block_height, receipt_index, log_index) < (?, ?, ?)");
    values.push(...cursor);
  }
  const rows = await env.AUDIT_DB.prepare(`
    SELECT * FROM audit_events WHERE ${filters.join(" AND ")}
    ORDER BY block_height DESC, receipt_index DESC, log_index DESC LIMIT ?
  `).bind(...values, limit + 1).all();
  const events = rows.results || [];
  const hasMore = events.length > limit;
  if (hasMore) events.pop();
  const watermark = await env.AUDIT_DB.prepare(
    "SELECT block_height, block_hash, block_timestamp_ns FROM indexer_cursors WHERE network = ? AND contract_id = ?"
  ).bind(env.NETWORK, env.TREASURY_ACCOUNT).first();
  return jsonResponse({
    events: events.map(rowToEvent),
    next_cursor: hasMore && events.length ? encodeCursor(events[events.length - 1]) : null,
    page_size: limit,
    network: env.NETWORK,
    contract_id: env.TREASURY_ACCOUNT,
    indexing: {
      indexed_through: watermark ? {
        block_height: watermark.block_height,
        block_hash: watermark.block_hash,
        block_timestamp_ns: watermark.block_timestamp_ns
      } : null,
      history_complete: false,
      coverage: "partial_or_unknown",
      note: "The watermark reports the last ingested finalized block, not proof that historical backfill is complete."
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "veltron-audit-indexer-api", network: env.NETWORK, contract_id: env.TREASURY_ACCOUNT });
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      try { return await getEvents(request, env); }
      catch { return jsonResponse({ error: "Unable to query audit history" }, 500); }
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/blocks") {
      const auth = request.headers.get("authorization") || "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!await tokenMatches(provided, env.INGEST_TOKEN)) return jsonResponse({ error: "Unauthorized" }, 401);
      let block;
      try { block = await request.json(); }
      catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
      try {
        const result = await ingestBlock(env.AUDIT_DB, {
          network: env.NETWORK,
          contractId: env.TREASURY_ACCOUNT
        }, block);
        return jsonResponse({ ok: true, ...result }, 202);
      } catch (error) {
        return jsonResponse({ error: String(error.message || error) }, 400);
      }
    }
    return jsonResponse({ error: "Not found" }, 404);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runFinalizedIndexer(env).then((result) => {
      console.log(JSON.stringify({ event: "audit_indexer_tick_complete", ...result }));
    }).catch((error) => {
      console.error(JSON.stringify({ event: "audit_indexer_tick_failed", message: String(error.message || error) }));
    }));
  }
};
