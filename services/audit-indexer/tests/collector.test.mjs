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
        async first() { return cursor; },
        async run() { return { success: true }; }
      };
    },
    async batch(statements) {
      const args = statements.at(-1).args;
      cursor = {
        block_height: args[2],
        block_hash: args[3],
        coverage_start_height: args[5],
        finalized_head_height: args[6],
        history_complete: args[7]
      };
      return [];
    },
    get cursor() { return cursor; }
  };
}

function rpcResponse(body) {
  const header = body.params.finality === "final"
    ? { height: 101, hash: "h101" }
    : { height: body.params.block_id, hash: "h" + body.params.block_id };
  return Response.json({ jsonrpc: "2.0", id: body.id, result: { header } });
}

const contractId = "veltron-treasury.testnet";
const eventLog = "EVENT_JSON:" + JSON.stringify({
  standard: "veltron",
  version: "1.0.0",
  event: "treasury_initialized",
  data: [{ actor_id: "owner.testnet", timestamp_ns: "100" }]
});

test("uses indexed account history, batched transaction receipts, and bulk finalized block headers", async () => {
  const db = fakeDb();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url === "https://rpc.testnet.fastnear.com") return rpcResponse(JSON.parse(init.body));
    if (url === "https://tx.test.fastnear.com/v0/account") {
      return Response.json({
        account_txs: [{ transaction_hash: "tx-before-coverage", tx_block_height: 99, tx_index: 4 }],
        txs_count: 1
      });
    }
    if (url === "https://tx.test.fastnear.com/v0/transactions") {
      return Response.json({
        transactions: [{
          transaction: { hash: "tx-before-coverage" },
          receipts: [{
            execution_outcome: {
              id: "receipt-100",
              block_height: 100,
              outcome: {
                executor_id: contractId,
                logs: [eventLog],
                status: { SuccessValue: "" }
              }
            }
          }]
        }]
      });
    }
    if (url === "https://tx.test.fastnear.com/v0/blocks") {
      return Response.json({
        blocks: [{
          block_height: 100,
          block_hash: "h100",
          prev_block_hash: "h99",
          block_timestamp: "100"
        }]
      });
    }
    throw new Error("Unexpected URL: " + url);
  };

  const result = await runFinalizedIndexer({
    NETWORK: "testnet",
    TREASURY_ACCOUNT: contractId,
    START_BLOCK_HEIGHT: "100",
    MAX_BLOCKS_PER_TICK: "1",
    AUDIT_DB: db
  }, fetchImpl);

  assert.deepEqual(result, {
    indexed_blocks: 1,
    indexed_events: 1,
    indexed_through: 100,
    finalized_head: 101,
    coverage_start_height: 100,
    history_complete: false,
    account_transactions: 1
  });
  assert.equal(calls.find((call) => call.url.endsWith("/v0/account")).body.is_receiver, true);
  assert.equal(calls.find((call) => call.url.endsWith("/v0/account")).body.from_tx_block_height, 0);
  assert.deepEqual(calls.find((call) => call.url.endsWith("/v0/transactions")).body.tx_hashes, ["tx-before-coverage"]);
  assert.deepEqual(calls.find((call) => call.url.endsWith("/v0/blocks")).body, {
    from_block_height: 100, to_block_height: 101, limit: 1, desc: false
  });
  assert.equal(db.cursor.block_height, 100);
  assert.equal(db.cursor.history_complete, 0);
});

test("paginates account history and deduplicates transaction hashes before batch lookup", async () => {
  const db = fakeDb();
  let accountPage = 0;
  let requestedHashes;
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://rpc.testnet.fastnear.com") return rpcResponse(JSON.parse(init.body));
    if (url.endsWith("/v0/account")) {
      const body = JSON.parse(init.body);
      accountPage++;
      if (accountPage === 1) {
        assert.equal(body.resume_token, undefined);
        return Response.json({
          account_txs: [{ transaction_hash: "tx-a", tx_block_height: 99, tx_index: 1 }],
          resume_token: "page-2"
        });
      }
      assert.equal(body.resume_token, "page-2");
      return Response.json({
        account_txs: [
          { transaction_hash: "tx-a", tx_block_height: 99, tx_index: 1 },
          { transaction_hash: "tx-b", tx_block_height: 100, tx_index: 2 }
        ],
        resume_token: null
      });
    }
    if (url.endsWith("/v0/transactions")) {
      requestedHashes = JSON.parse(init.body).tx_hashes;
      return Response.json({ transactions: [
        { transaction: { hash: "tx-a" }, receipts: [] },
        { transaction: { hash: "tx-b" }, receipts: [] }
      ] });
    }
    if (url.endsWith("/v0/blocks")) {
      return Response.json({ blocks: [{
        block_height: 100, block_hash: "h100", prev_block_hash: "h99", block_timestamp: "100"
      }] });
    }
    throw new Error("Unexpected URL: " + url);
  };

  const result = await runFinalizedIndexer({
    NETWORK: "testnet", TREASURY_ACCOUNT: contractId,
    START_BLOCK_HEIGHT: "100", MAX_BLOCKS_PER_TICK: "1", AUDIT_DB: db
  }, fetchImpl);

  assert.equal(accountPage, 2);
  assert.deepEqual(requestedHashes, ["tx-a", "tx-b"]);
  assert.equal(result.account_transactions, 2);
  assert.equal(result.indexed_events, 0);
});

test("rejects an incomplete bulk block range without advancing the cursor", async () => {
  const db = fakeDb();
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://rpc.testnet.fastnear.com") return rpcResponse(JSON.parse(init.body));
    if (url.endsWith("/v0/account")) return Response.json({ account_txs: [], txs_count: 0 });
    if (url.endsWith("/v0/blocks")) return Response.json({ blocks: [] });
    throw new Error("Unexpected URL: " + url);
  };
  await assert.rejects(
    runFinalizedIndexer({
      NETWORK: "testnet", TREASURY_ACCOUNT: contractId,
      START_BLOCK_HEIGHT: "100", MAX_BLOCKS_PER_TICK: "1", AUDIT_DB: db
    }, fetchImpl),
    /incomplete block range/
  );
  assert.equal(db.cursor, null);
});

test("falls back to another NEAR RPC provider after repeated rate limits", async () => {
  const db = fakeDb();
  let primaryAttempts = 0;
  let fallbackCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://rpc.testnet.fastnear.com") {
      primaryAttempts++;
      return new Response("rate limited", { status: 429 });
    }
    if (url === "https://near-testnet.drpc.org") {
      fallbackCalls++;
      const body = JSON.parse(init.body);
      const header = body.params.finality === "final"
        ? { height: 100, hash: "h100" }
        : { height: 99, hash: "h99" };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { header } });
    }
    if (url.endsWith("/v0/account")) return Response.json({ account_txs: [], txs_count: 0 });
    if (url.endsWith("/v0/blocks")) {
      return Response.json({ blocks: [{
        block_height: 100, block_hash: "h100", prev_block_hash: "h99", block_timestamp: "100"
      }] });
    }
    throw new Error("Unexpected URL: " + url);
  };

  const result = await runFinalizedIndexer({
    NETWORK: "testnet", TREASURY_ACCOUNT: contractId,
    START_BLOCK_HEIGHT: "100", MAX_BLOCKS_PER_TICK: "1", AUDIT_DB: db
  }, fetchImpl);
  assert.equal(primaryAttempts, 4);
  assert.equal(fallbackCalls, 2);
  assert.equal(result.indexed_through, 100);
  assert.equal(result.history_complete, true);
});

test("does not certify coverage until the finalized head has been scanned", async () => {
  const db = fakeDb();
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://rpc.testnet.fastnear.com") return rpcResponse(JSON.parse(init.body));
    if (url.endsWith("/v0/account")) return Response.json({ account_txs: [], txs_count: 0 });
    if (url.endsWith("/v0/blocks")) {
      return Response.json({ blocks: [{
        block_height: 100, block_hash: "h100", prev_block_hash: "h99", block_timestamp: "100"
      }] });
    }
    throw new Error("Unexpected URL: " + url);
  };
  const result = await runFinalizedIndexer({
    NETWORK: "testnet", TREASURY_ACCOUNT: contractId,
    START_BLOCK_HEIGHT: "100", MAX_BLOCKS_PER_TICK: "1", AUDIT_DB: db
  }, fetchImpl);
  assert.equal(result.indexed_through, 100);
  assert.equal(result.finalized_head, 101);
  assert.equal(result.coverage_start_height, 100);
  assert.equal(result.history_complete, false);
  assert.equal(db.cursor.finalized_head_height, 101);
  assert.equal(db.cursor.history_complete, 0);
});
