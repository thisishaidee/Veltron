import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/admin-controls.js", import.meta.url), "utf8");
const html = await readFile(new URL("../owner-controls.html", import.meta.url), "utf8");

test("owner controls reads the same finalized block from two independent Testnet RPCs", () => {
  assert.match(source, /rpc\.testnet\.near\.org/);
  assert.match(source, /rpc\.testnet\.fastnear\.com/);
  assert.match(source, /chain_id !== "testnet"/);
  assert.match(source, /stable\(a\) !== stable\(b\)/);
  assert.match(source, /SNAPSHOT_TTL_MS = 30000/);
});

test("owner actions are restricted to the configured owner and explicit Testnet confirmation", () => {
  assert.match(source, /accountId === OWNER/);
  assert.match(source, /typeof audit\?\.audit_pending !== "boolean"/);
  assert.match(source, /The agent must be distinct from the owner, treasury, and token contract/);
  assert.match(source, /active_commitments\) \+ BigInt\(snapshot\.position\.pending_discretionary/);
  assert.match(source, /\$\("network-confirm"\)\.checked/);
  for (const method of ["set_agent", "set_safety_reserve", "set_paused", "settle_commitment", "reconcile_token_surplus"]) {
    assert.ok(source.includes('send("' + method + '"') || source.includes('send(methodName'));
  }
  assert.match(source, /signAndSendTransaction/);
});

test("surplus reconciliation requires a completed current audit and no pending transfers", () => {
  assert.match(source, /snapshot\.audit\.audit_pending/);
  assert.match(source, /snapshot\.pending\.length !== 0/);
  assert.match(source, /AUDIT_MAX_AGE_NS = 30000000000n/);
  assert.match(source, /auditAge > AUDIT_MAX_AGE_NS/);
  assert.match(source, /ledgerAtObservation !== snapshot\.position\.treasury_balance/);
  assert.match(source, /BigInt\(amount\) > surplus/);
});

test("UI explicitly avoids claiming a complete historical event log", () => {
  assert.match(html, /not a complete historical event log/i);
  assert.match(html, /requires an indexed event source/i);
});
