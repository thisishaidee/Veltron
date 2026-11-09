import test from "node:test";
import assert from "node:assert/strict";
import {
  TREASURY_ACCOUNT,
  VIEW_METHODS,
  buildViewRequest,
  decodeViewResult,
  readTreasurySnapshot
} from "../src/dashboard.mjs";

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
  const request = buildViewRequest("get_financial_position");
  assert.equal(request.method, "query");
  assert.equal(request.params.account_id, "veltron-treasury.testnet");
  assert.throws(() => buildViewRequest("set_paused", { paused: true }), /read-only/);
  assert.throws(() => buildViewRequest("request_payment", { amount: "1" }), /read-only/);
});

test("view response bytes decode as JSON", () => {
  const encoded = Array.from(new TextEncoder().encode(JSON.stringify({ spendable_balance: "900" })));
  assert.deepEqual(decodeViewResult(encoded), { spendable_balance: "900" });
});

test("dashboard refuses a non-testnet RPC response", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ result: { chain_id: "mainnet" } })
  });
  await assert.rejects(readTreasurySnapshot(fakeFetch), /expected NEAR testnet/);
});

test("dashboard reports an undeployed treasury without attempting contract calls", async () => {
  let calls = 0;
  const fakeFetch = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (body.method === "status") {
      return { ok: true, json: async () => ({ result: { chain_id: "testnet" } }) };
    }
    return {
      ok: true,
      json: async () => ({
        result: { amount: "1000000000000000000000000", storage_usage: 182, code_hash: "11111111111111111111111111111111" }
      })
    };
  };
  const snapshot = await readTreasurySnapshot(fakeFetch);
  assert.equal(snapshot.deployed, false);
  assert.equal(snapshot.account.storage_usage, 182);
  assert.equal(calls, 2);
});
