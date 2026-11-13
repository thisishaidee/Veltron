import { runFinalizedIndexer } from "./collector.js";

const MAX_PAGE_SIZE = 100;
const PUBLIC_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Accept",
  "access-control-max-age": "86400"
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function encodeCursor(row) {
  const raw = JSON.stringify([row.block_height, row.receipt_index, row.log_index]);
  return btoa(raw).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
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
    if (!cursor) return jsonResponse({ error: "Invalid pagination cursor" }, 400, PUBLIC_CORS_HEADERS);
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
  }, 200, PUBLIC_CORS_HEADERS);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && ["/health", "/v1/events"].includes(url.pathname)) {
      return new Response(null, { status: 204, headers: PUBLIC_CORS_HEADERS });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "veltron-audit-indexer-api", network: env.NETWORK, contract_id: env.TREASURY_ACCOUNT }, 200, PUBLIC_CORS_HEADERS);
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      try { return await getEvents(request, env); }
      catch { return jsonResponse({ error: "Unable to query audit history" }, 500, PUBLIC_CORS_HEADERS); }
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
