import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../audit.html", import.meta.url), "utf8");
const js = await readFile(new URL("../src/audit.js", import.meta.url), "utf8");

test("audit page is fixed to the intended Testnet owner and treasury", () => {
  for (const value of ["haideedotxyz.testnet", "veltron-treasury.testnet", "NEAR Testnet"]) {
    assert.ok(html.includes(value) || js.includes(value));
  }
  assert.match(js, /network: "testnet"/);
  assert.match(js, /chain_id !== "testnet"/);
});

test("the only wallet action is the read-only balance audit request", () => {
  assert.match(js, /methodName: "refresh_token_balance_audit"/);
  assert.match(js, /receiverId: TREASURY/);
  assert.match(js, /args: \{\}/);
  assert.match(js, /gas: AUDIT_GAS/);
  assert.match(js, /deposit: "0"/);
  assert.match(js, /const AUDIT_GAS = "30000000000000"/);
  assert.doesNotMatch(js, /ft_transfer_call|ft_transfer|reconcile_token_surplus|settle_commitment/);
});

test("wallet request is gated by the owner, Testnet confirmation, and preflight", () => {
  assert.match(js, /accountId !== OWNER/);
  assert.match(js, /network-confirm/);
  assert.match(js, /if \(!preflightPassed/);
});

test("preflight and verification use finalized read-only contract views", () => {
  assert.match(js, /request_type: "call_function"/);
  assert.match(js, /finality: "final"/);
  assert.match(js, /get_token_balance_audit/);
  assert.match(js, /get_financial_position/);
  assert.match(js, /ft_balance_of/);
});

test("page warns against duplicate requests while audit is pending", () => {
  assert.match(js, /audit_pending/);
  assert.match(js, /do not submit another/i);
  assert.match(html, /Reject any wallet request with a different account/);
});
