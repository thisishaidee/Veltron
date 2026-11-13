import test from "node:test";
import assert from "node:assert/strict";
import { ingestBlock } from "../src/storage.js";
import { extractContractEvents, runFinalizedIndexer } from "../src/collector.js";

const config = { network: "testnet", contractId: "veltron-treasury.testnet" };
const block = {
  network: "testnet",
  contract_id: "veltron-treasury.testnet",
  finalized: true,
  block_height: 120,
  block_hash: "block-hash",
  prev_block_hash: "previous-block-hash",
  block_timestamp_ns: "123456789",
  coverage_start_height: 120,
  finalized_head_height: 120,
  events: [{
    receipt_id: "receipt-1",
    transaction_hash: "transaction-1",
    receipt_index: 0,
    log_index: 0,
    receipt_status: "SUCCESS_VALUE",
    envelope: {
      standard: "veltron",
      version: "1.0.0",
      event: "payment_requested",
      data: [{ actor_id: "veltron-agent.testnet", timestamp_ns: "123456789", request_id: "1", amount: "9007199254740993" }]
    }
  }]
};

function fakeDb(existing = null) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => existing,
            run: async () => ({ success: true }),
            sql,
            args
          };
        }
      };
    },
    batch: async (items) => { statements.push(...items); return []; }
  };
}

test("stores a finalized VELTRON event and advances the cursor atomically", async () => {
  const db = fakeDb();
  const result = await ingestBlock(db, config, block);
  assert.deepEqual(result, { accepted: 1, block_height: 120, history_complete: true });
  assert.equal(db.statements.length, 2);
  assert.match(db.statements[0].sql, /INSERT OR IGNORE INTO audit_events/);
  assert.equal(db.statements[0].args[8], 4_000_000);
  assert.match(db.statements[1].sql, /INSERT INTO indexer_cursors/);
  assert.equal(db.statements[0].args[15], null);
});

test("rejects unfinalized blocks", async () => {
  await assert.rejects(() => ingestBlock(fakeDb(), config, { ...block, finalized: false }), /Only finalized blocks/);
});

test("rejects wrong network and contract", async () => {
  await assert.rejects(() => ingestBlock(fakeDb(), config, { ...block, network: "mainnet" }), /Network mismatch/);
  await assert.rejects(() => ingestBlock(fakeDb(), config, { ...block, contract_id: "attacker.testnet" }), /Contract mismatch/);
});

test("rejects unsupported event versions and malformed numeric encodings", async () => {
  const badVersion = structuredClone(block);
  badVersion.events[0].envelope.version = "2.0.0";
  await assert.rejects(() => ingestBlock(fakeDb(), config, badVersion), /Unsupported VELTRON/);
  const badAmountTime = structuredClone(block);
  badAmountTime.events[0].envelope.data[0].timestamp_ns = "1.2";
  await assert.rejects(() => ingestBlock(fakeDb(), config, badAmountTime), /decimal integer string/);
});

test("rejects unknown event names and oversized batches", async () => {
  const unknown = structuredClone(block);
  unknown.events[0].envelope.event = "arbitrary_event";
  await assert.rejects(() => ingestBlock(fakeDb(), config, unknown), /Unknown VELTRON event/);
  await assert.rejects(() => ingestBlock(fakeDb(), config, { ...block, events: Array(501).fill(block.events[0]) }), /at most 500/);
});

test("rejects a block behind the durable cursor", async () => {
  await assert.rejects(() => ingestBlock(fakeDb({ block_height: 121 }), config, block), /behind the durable cursor/);
});

test("accepts empty finalized blocks so the indexing watermark can advance", async () => {
  const db = fakeDb();
  const result = await ingestBlock(db, config, { ...block, events: [], block_height: 121, finalized_head_height: 121 });
  assert.deepEqual(result, { accepted: 0, block_height: 121, history_complete: true });
  assert.equal(db.statements.length, 1);
});

test("rejects cursor gaps and conflicting hashes at the current height", async () => {
  await assert.rejects(
    () => ingestBlock(fakeDb({ block_height: 120, block_hash: "block-hash" }), config, { ...block, block_height: 122, finalized_head_height: 122 }),
    /Block gap detected/
  );
  await assert.rejects(
    () => ingestBlock(fakeDb({ block_height: 120, block_hash: "different-hash" }), config, block),
    /Block hash changed/
  );
});

test("extracts only finalized receipt logs executed by the configured treasury", () => {
  const eventLog = "EVENT_JSON:" + JSON.stringify({
    standard: "veltron",
    version: "1.0.0",
    event: "payment_requested",
    data: [{ actor_id: "veltron-agent.testnet", timestamp_ns: "123456789" }]
  });
  const parsed = extractContractEvents({
    shards: [
      { shard_id: 2, receipt_execution_outcomes: [{
        tx_hash: "tx-2",
        execution_outcome: { id: "receipt-2", outcome: {
          executor_id: "veltron-treasury.testnet",
          logs: ["ordinary log", eventLog],
          status: { SuccessReceiptId: "next-receipt" }
        } }
      }] },
      { shard_id: 0, receipt_execution_outcomes: [{
        tx_hash: "tx-other",
        execution_outcome: { id: "receipt-other", outcome: {
          executor_id: "other.testnet", logs: [eventLog], status: { SuccessValue: "" }
        } }
      }] }
    ]
  }, "veltron-treasury.testnet");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].receipt_id, "receipt-2");
  assert.equal(parsed[0].transaction_hash, "tx-2");
  assert.equal(parsed[0].receipt_index, 0);
  assert.equal(parsed[0].log_index, 1);
  assert.equal(parsed[0].receipt_status, "SUCCESS_RECEIPT_ID");
  assert.equal(parsed[0].envelope.event, "payment_requested");
});

test("rejects malformed event logs and missing receipt transaction provenance", () => {
  const malformed = { shards: [{ shard_id: 0, receipt_execution_outcomes: [{
    tx_hash: "tx",
    execution_outcome: { id: "receipt", outcome: {
      executor_id: "veltron-treasury.testnet", logs: ["EVENT_JSON:{bad"], status: { SuccessValue: "" }
    } }
  }] }] };
  assert.throws(() => extractContractEvents(malformed, "veltron-treasury.testnet"), /Malformed EVENT_JSON/);
  const missingTx = structuredClone(malformed);
  missingTx.shards[0].receipt_execution_outcomes[0].tx_hash = null;
  missingTx.shards[0].receipt_execution_outcomes[0].execution_outcome.outcome.logs = [
    "EVENT_JSON:" + JSON.stringify({ standard: "veltron", version: "1.0.0", event: "deposit_credited", data: [{ actor_id: "a", timestamp_ns: "1" }] })
  ];
  assert.throws(() => extractContractEvents(missingTx, "veltron-treasury.testnet"), /omitted tx_hash/);
});

test("requires the previous finalized block hash to chain to the cursor", async () => {
  await assert.rejects(
    () => ingestBlock(fakeDb({ block_height: 119, block_hash: "expected-prev-hash" }), config, block),
    /Previous block hash does not match/
  );
});

test("scheduled collector ingests indexed receipt events and bulk finalized headers", async () => {
  const db = fakeDb();
  const eventLog = "EVENT_JSON:" + JSON.stringify({
    standard: "veltron",
    version: "1.0.0",
    event: "treasury_initialized",
    data: [{ actor_id: "deployer.testnet", timestamp_ns: "1000000000" }]
  });
  const requested = [];
  const fetchMock = async (url, init = {}) => {
    requested.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url === "https://rpc.testnet.fastnear.com") {
      const params = JSON.parse(init.body).params;
      const header = params.finality === "final"
        ? { height: 100, hash: "block-100" }
        : { height: 99, hash: "block-99" };
      return Response.json({ result: { header } });
    }
    if (url === "https://tx.test.fastnear.com/v0/account") {
      return Response.json({
        account_txs: [{ transaction_hash: "tx-init", tx_block_height: 99, tx_index: 4 }],
        txs_count: 1
      });
    }
    if (url === "https://tx.test.fastnear.com/v0/transactions") {
      return Response.json({
        transactions: [{
          transaction: { hash: "tx-init" },
          execution_outcome: { index: 4 },
          receipts: [{
            execution_outcome: {
              id: "receipt-init",
              block_height: 100,
              outcome: {
                executor_id: "veltron-treasury.testnet",
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
          block_hash: "block-100",
          prev_block_hash: "block-99",
          block_timestamp: "1000000000"
        }]
      });
    }
    throw new Error("Unexpected URL: " + url);
  };
  const result = await runFinalizedIndexer({
    NETWORK: "testnet",
    TREASURY_ACCOUNT: "veltron-treasury.testnet",
    START_BLOCK_HEIGHT: "100",
    MAX_BLOCKS_PER_TICK: "10",
    AUDIT_DB: db
  }, fetchMock);
  assert.deepEqual(result, {
    indexed_blocks: 1,
    indexed_events: 1,
    indexed_through: 100,
    finalized_head: 100,
    coverage_start_height: 100,
    history_complete: true,
    account_transactions: 1
  });
  assert.equal(requested.length, 5);
  assert.equal(requested[0].url, "https://rpc.testnet.fastnear.com");
  assert.equal(requested[1].url, "https://rpc.testnet.fastnear.com");
  assert.equal(requested[2].url, "https://tx.test.fastnear.com/v0/account");
  assert.equal(requested[3].url, "https://tx.test.fastnear.com/v0/transactions");
  assert.equal(requested[4].url, "https://tx.test.fastnear.com/v0/blocks");
  assert.match(db.statements[0].sql, /INSERT OR IGNORE INTO audit_events/);
});

test("rejects a failed finalized-head HTTP response before parsing JSON", async () => {
  const db = fakeDb();
  const fetchMock = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(() => runFinalizedIndexer({
    NETWORK: "testnet", TREASURY_ACCOUNT: "veltron-treasury.testnet",
    START_BLOCK_HEIGHT: "100", MAX_BLOCKS_PER_TICK: "10", AUDIT_DB: db
  }, fetchMock), /NEAR RPC block request returned HTTP 503/);
  assert.equal(db.statements.length, 0);
});


test("refuses to start history when the first bulk block header does not link to its anchor", async () => {
  const db = fakeDb();
  const fetchMock = async (url, init = {}) => {
    if (url === "https://rpc.testnet.fastnear.com") {
      const params = JSON.parse(init.body).params;
      const header = params.finality === "final"
        ? { height: 100, hash: "block-100" }
        : { height: 99, hash: "trusted-anchor" };
      return Response.json({ result: { header } });
    }
    if (url === "https://tx.test.fastnear.com/v0/account") {
      return Response.json({ account_txs: [], txs_count: 0 });
    }
    if (url === "https://tx.test.fastnear.com/v0/blocks") {
      return Response.json({
        blocks: [{
          block_height: 100,
          block_hash: "block-100",
          prev_block_hash: "wrong-anchor",
          block_timestamp: "1000000000"
        }]
      });
    }
    throw new Error("Unexpected URL: " + url);
  };
  await assert.rejects(() => runFinalizedIndexer({
    NETWORK: "testnet", TREASURY_ACCOUNT: "veltron-treasury.testnet",
    START_BLOCK_HEIGHT: "100", MAX_BLOCKS_PER_TICK: "10", AUDIT_DB: db
  }, fetchMock), /does not link to the verified previous block hash/);
  assert.equal(db.statements.length, 0);
});
