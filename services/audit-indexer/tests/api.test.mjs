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
  assert.equal(body.indexing.coverage, "awaiting_coverage_start");
  assert.equal(body.indexing.coverage_start_height, null);
  assert.equal(body.indexing.configured_start_height, null);
  assert.equal(body.indexing.coverage_start_matches_config, false);
  assert.equal(body.indexing.finalized_head_height, null);
});

test("certifies coverage only when the finalized cursor reaches the recorded head", async () => {
  const completeDb = {
    prepare() {
      return {
        bind() {
          return {
            all: async () => ({ results: [] }),
            first: async () => ({
              block_height: 100,
              block_hash: "h100",
              block_timestamp_ns: "100",
              coverage_start_height: 90,
              finalized_head_height: 100,
              history_complete: 1
            })
          };
        }
      };
    }
  };
  const response = await worker.fetch(new Request("https://audit.example/v1/events"), { ...env, START_BLOCK_HEIGHT: "100", AUDIT_DB: completeDb });
  const body = await response.json();
  assert.equal(body.indexing.history_complete, true);
  assert.equal(body.indexing.coverage, "complete_from_start_height");
  assert.equal(body.indexing.coverage_start_height, 90);
  assert.equal(body.indexing.finalized_head_height, 100);
  assert.equal(body.indexing.coverage_start_matches_config, false);
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
