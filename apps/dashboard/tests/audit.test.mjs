import test from "node:test";
import assert from "node:assert/strict";
import { AUDIT_API_URL, readAuditStatus } from "../src/audit.mjs";

test("reads VELTRON Testnet audit coverage and recent events", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, AUDIT_API_URL + "/v1/events?limit=5");
    assert.equal(options.headers.accept, "application/json");
    return Response.json({
      network: "testnet",
      contract_id: "veltron-treasury.testnet",
      events: [{ event: "payment_requested", data: { actor_id: "agent.testnet" }, provenance: { block_height: 123, receipt_status: "SUCCESS_VALUE" } }],
      indexing: { coverage: "partial_or_unknown", history_complete: false, indexed_through: { block_height: 123 }, note: "Watermark is not proof of completeness." }
    });
  };
  const status = await readAuditStatus(fetchImpl);
  assert.equal(status.network, "testnet");
  assert.equal(status.coverage, "partial_or_unknown");
  assert.equal(status.history_complete, false);
  assert.equal(status.indexed_through.block_height, 123);
  assert.equal(status.events[0].event, "payment_requested");
});

test("rejects an unexpected network or treasury account", async () => {
  const fetchImpl = async () => Response.json({ network: "mainnet", contract_id: "attacker.near", events: [], indexing: {} });
  await assert.rejects(readAuditStatus(fetchImpl), /unexpected network or treasury account/);
});

test("fails closed when the audit API is unavailable", async () => {
  const fetchImpl = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(readAuditStatus(fetchImpl), /HTTP 503/);
});
