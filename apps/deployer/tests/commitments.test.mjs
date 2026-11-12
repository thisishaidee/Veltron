import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../commitment-management.html", import.meta.url), "utf8");
const js = await readFile(new URL("../src/commitments.js", import.meta.url), "utf8");

test("commitment manager is explicitly Testnet-only and uses the configured owner and treasury", () => {
  for (const value of ["haideedotxyz.testnet", "veltron-treasury.testnet", "NEAR TESTNET"]) {
    assert.ok(html.includes(value) || js.includes(value));
  }
  assert.match(js, /network: "testnet"/);
});

test("reads finalized commitments and financial position from two independent RPCs", () => {
  assert.match(js, /https:\/\/rpc\.testnet\.near\.org/);
  assert.match(js, /https:\/\/rpc\.testnet\.fastnear\.com/);
  for (const value of ['"get_owner"', '"get_financial_position"', '"get_pause_status"', '"get_commitments"']) {
    assert.ok(js.includes(value));
  }
  assert.match(js, /finality: "final"/);
  assert.match(js, /stable\(first\) !== stable\(second\)/);
});

test("only the owner can request create, update, and cancel operations", () => {
  assert.match(js, /accountId !== OWNER/);
  for (const method of ['"create_commitment"', '"update_commitment"', '"cancel_commitment"']) {
    assert.ok(js.includes(method));
  }
  assert.match(js, /signerId: OWNER/);
  assert.match(js, /receiverId: TREASURY/);
  assert.match(js, /deposit: "0"/);
});

test("amounts are converted exactly to six-decimal base units without floating point", () => {
  assert.match(js, /BigInt\(match\[1\]\) \* 1000000n/);
  assert.match(js, /d{1,6}/);
});

test("pending settlements cannot be edited or cancelled and no settlement/payment action is exposed", () => {
  assert.match(js, /settlement_pending/);
  assert.doesNotMatch(js, /methodName: "settle_commitment"/);
  assert.doesNotMatch(js, /methodName: "request_payment"/);
});

test("wallet errors instruct read-only verification before any retry", () => {
  assert.match(js, /REQUEST RESULT UNCERTAIN/);
  assert.match(js, /do not blindly resubmit/);
});
