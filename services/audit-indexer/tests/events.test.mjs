import test from "node:test";
import assert from "node:assert/strict";
import { ingestBlock } from "../src/index.js";

const config = { network: "testnet", contractId: "veltron-treasury.testnet" };
const block = {
  network: "testnet",
  contract_id: "veltron-treasury.testnet",
  finalized: true,
  block_height: 120,
  block_hash: "block-hash",
  block_timestamp_ns: "123456789",
  events: [{
    receipt_id: "receipt-1",
    transaction_hash: "transaction-1",
    receipt_index: 0,
    log_index: 0,
    receipt_status: "SUCCESSFUL",
    envelope: {
      standard: "veltron",
      version: "1.0.0",
      event: "payment_requested",
      data: [{ actor_id: "veltron-agent.testnet", timestamp_ns: "123456789", request_id: "1", amount: "9007199254740993" }]
    }
  }]
}};

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
  assert.deepEqual(result, { accepted: 1, block_height: 120 });
  assert.equal(db.statements.length, 2);
  assert.match(db.statements[0].sql, /INSERT OR IGNORE INTO audit_events/);
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
  const result = await ingestBlock(db, config, { ...block, events: [], block_height: 121 });
  assert.deepEqual(result, { accepted: 0, block_height: 121 });
  assert.equal(db.statements.length, 1);
});
