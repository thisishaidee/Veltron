import test from "node:test";
import assert from "node:assert/strict";
import {
  TREASURY_ACCOUNT,
  RPC_URLS,
  VIEW_METHODS,
  buildViewRequest,
  decodeViewResult,
  readTreasurySnapshot
} from "../src/dashboard.mjs";

const BLOCK_HASH = "finalized-block-hash";
const deployedAccount = {
  amount: "1000000000000000000000000",
  storage_usage: 338824,
  code_hash: "contract-code-hash"
};
const viewValues = {
  get_financial_position: { treasury_balance: "10", active_commitments: "0", safety_reserve: "200", pending_discretionary: "0", spendable_balance: "0" },
  get_pause_status: true,
  get_commitments: { commitments: [], next_cursor: null },
  get_pending_transfers: [],
  get_token_balance_audit: { audit_pending: false, observed_token_balance: "10", ledger_balance_at_observation: "10", observed_at_ns: "1" }
};

function response(result) {
  return { ok: true, json: async () => ({ result }) };
}
function makeFetch({ failView = false, chainId = "testnet", noCode = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (body.method === "status") return response({ chain_id: chainId });
    if (body.method === "block") return response({ header: { hash: BLOCK_HASH } });
    if (body.method === "query" && body.params.request_type === "view_account") {
      return response(noCode ? { ...deployedAccount, code_hash: "11111111111111111111111111111111" } : deployedAccount);
    }
    if (body.method === "query" && body.params.request_type === "call_function") {
      if (failView) return { ok: false, status: 503, json: async () => ({}) };
      const value = viewValues[body.params.method_name];
      return response({ result: Array.from(new TextEncoder().encode(JSON.stringify(value))) });
    }
    throw new Error("Unexpected RPC request");
  };
  return { fetchImpl, calls };
}

test("dashboard is pinned to the dedicated treasury testnet account", () => {
  assert.equal(TREASURY_ACCOUNT, "veltron-treasury.testnet");
});

test("dashboard exposes only the five approved read-only contract methods", () => {
  assert.deepEqual(VIEW_METHODS, [
    "get_financial_position",
    "get_pause_status",
    "get_commitments",
    "get_pending_transfers",
    "get_token_balance_audit"
  ]);
});

test("view request cannot target a write method or a different account", () => {
  const request = buildViewRequest("get_financial_position", {}, BLOCK_HASH);
  assert.equal(request.method, "query");
  assert.equal(request.params.account_id, "veltron-treasury.testnet");
  assert.equal(request.params.block_id, BLOCK_HASH);
  assert.throws(() => buildViewRequest("set_paused", { paused: true }), /read-only/);
  assert.throws(() => buildViewRequest("request_payment", { amount: "1" }), /read-only/);
});

test("view response bytes decode as JSON", () => {
  const encoded = Array.from(new TextEncoder().encode(JSON.stringify({ spendable_balance: "900" })));
  assert.deepEqual(decodeViewResult(encoded), { spendable_balance: "900" });
});

test("dashboard refuses a non-testnet RPC response", async () => {
  const { fetchImpl } = makeFetch({ chainId: "mainnet" });
  await assert.rejects(readTreasurySnapshot(fetchImpl), /expected NEAR testnet/);
});

test("dashboard reports an undeployed treasury without attempting contract calls", async () => {
  const { fetchImpl, calls } = makeFetch({ noCode: true });
  const snapshot = await readTreasurySnapshot(fetchImpl);
  assert.equal(snapshot.deployed, false);
  assert.equal(snapshot.account.storage_usage, 338824);
  assert.equal(snapshot.block_hash, BLOCK_HASH);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.url === RPC_URLS[0]));
  assert.equal(calls[2].body.params.block_id, BLOCK_HASH);
});

test("all dashboard reads use one provider and one finalized block hash", async () => {
  const { fetchImpl, calls } = makeFetch();
  const snapshot = await readTreasurySnapshot(fetchImpl);
  assert.equal(snapshot.deployed, true);
  assert.equal(snapshot.block_hash, BLOCK_HASH);
  assert.equal(snapshot.rpc_url, RPC_URLS[0]);
  assert.ok(calls.every(call => call.url === RPC_URLS[0]));
  const dataReads = calls.filter(call => call.body.method === "query");
  assert.ok(dataReads.every(call => call.body.params.block_id === BLOCK_HASH));
  assert.equal(dataReads.length, 6);
});

test("a provider failure during snapshot reads fails closed instead of mixing providers", async () => {
  const { fetchImpl, calls } = makeFetch({ failView: true });
  await assert.rejects(readTreasurySnapshot(fetchImpl), /503/);
  assert.ok(calls.every(call => call.url === RPC_URLS[0]));
  assert.equal(calls.some(call => call.url === RPC_URLS[1]), false);
});
