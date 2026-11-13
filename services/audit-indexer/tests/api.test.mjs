import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function emptyDb() {
  return {
    prepare() {
      return {
        bind() {
          return {
            all: async () => ({ results: [] }),
            first: async () => null
          };
        }
      };
    }
  };
}

const env = {
  NETWORK: "testnet",
  TREASURY_ACCOUNT: "veltron-treasury.testnet",
  AUDIT_DB: emptyDb()
};

test("read-only audit endpoint supports browser CORS preflight", async () => {
  const response = await worker.fetch(new Request("https://audit.example/v1/events", { method: "OPTIONS" }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-allow-methods"), /GET/);
});

test("read-only audit history response includes cross-origin access headers", async () => {
  const response = await worker.fetch(new Request("https://audit.example/v1/events"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const body = await response.json();
  assert.deepEqual(body.events, []);
  assert.equal(body.history_complete, undefined);
  assert.equal(body.indexing.history_complete, false);
});

test("health endpoint includes cross-origin access headers", async () => {
  const response = await worker.fetch(new Request("https://audit.example/health"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});


test("does not expose an external endpoint that can seed or advance the audit cursor", async () => {
  const response = await worker.fetch(new Request("https://audit.example/internal/v1/blocks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ block_height: 1, finalized: true })
  }), env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});


test("manual indexer trigger is not exposed without its secret or as a GET route", async () => {
  const protectedEnv = { ...env, INDEXER_TRIGGER_TOKEN: "test-only-secret" };
  for (const request of [
    new Request("https://audit.example/internal/run-indexer", { method: "POST" }),
    new Request("https://audit.example/internal/run-indexer", { method: "POST", headers: { authorization: "Bearer wrong" } }),
    new Request("https://audit.example/internal/run-indexer", { method: "GET", headers: { authorization: "Bearer test-only-secret" } })
  ]) {
    const response = await worker.fetch(request, protectedEnv);
    assert.equal(response.status, 404);
  }
});
