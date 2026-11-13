import test from "node:test";
import assert from "node:assert/strict";
import { runFinalizedIndexer } from "../src/collector.js";

function fakeDb(initialCursor = null) {
  let cursor = initialCursor;
  return {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return cursor; }
      };
    },
    async batch(statements) {
      const args = statements.at(-1).args;
      cursor = { block_height: args[2], block_hash: args[3] };
      return [];
    },
    get cursor() { return cursor; }
  };
}

test("uses canonical NEAR RPC for finalized head and anchor, then checks full block continuity", async () => {
  const db = fakeDb();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://rpc.testnet.near.org") {
      const body = JSON.parse(init.body);
      const header = body.params.finality === "final"
        ? { height: 100, hash: "h100" }
        : { height: 99, hash: "h99" };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { header } });
    }
    const height = Number(url.split("/").at(-1));
    return Response.json({ block: { header: { height, hash: "h" + height, prev_hash: "h" + (height - 1), timestamp_nanosec: String(height) } }, shards: [] });
  };
  const result = await runFinalizedIndexer({
    NETWORK: "testnet", TREASURY_ACCOUNT: "veltron-treasury.testnet",
    START_BLOCK_HEIGHT: "100", MAX_BLOCKS_PER_TICK: "1", AUDIT_DB: db
  }, fetchImpl);
  assert.deepEqual(result, { indexed_blocks: 1, indexed_events: 0, indexed_through: 100, finalized_head: 100 });
  assert.equal(calls[0].url, "https://rpc.testnet.near.org");
  assert.equal(JSON.parse(calls[0].init.body).params.finality, "final");
  assert.equal(JSON.parse(calls[1].init.body).params.block_id, 99);
  assert.equal(calls[2].url, "https://testnet.neardata.xyz/v0/block/100");
  assert.equal(db.cursor.block_height, 100);
});

test("retries a rate-limited finalized-head RPC request", async () => {
  const db = fakeDb();
  let attempts = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://rpc.testnet.near.org") {
      attempts++;
      if (attempts === 1) return new Response("rate limited", { status: 429 });
      const body = JSON.parse(init.body);
      const header = body.params.finality === "final" ? { height: 50, hash: "h50" } : { height: 49, hash: "h49" };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { header } });
    }
    return Response.json({ block: { header: { height: 50, hash: "h50", prev_hash: "h49", timestamp_nanosec: "50" } }, shards: [] });
  };
  const result = await runFinalizedIndexer({
    NETWORK: "testnet", TREASURY_ACCOUNT: "veltron-treasury.testnet",
    START_BLOCK_HEIGHT: "50", MAX_BLOCKS_PER_TICK: "1", AUDIT_DB: db
  }, fetchImpl);
  assert.equal(attempts, 3);
  assert.equal(result.indexed_through, 50);
});
