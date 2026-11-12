import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../commitment-management.html", import.meta.url), "utf8");
const js = await readFile(new URL("../src/commitments.js", import.meta.url), "utf8");

test("a stalled RPC request is aborted and rejects within the configured timeout", async () => {
  const start = js.indexOf("async function rpc(endpoint, method, params) {");
  const end = js.indexOf("\\nasync function view(", start);
  assert.ok(start >= 0 && end > start, "RPC function can be isolated for a behavioural test");
  const rpcSource = js.slice(start, end).replace("const RPC_TIMEOUT_MS = 12000;", "const RPC_TIMEOUT_MS = 25;");
  const rpc = vm.runInNewContext(rpcSource + "\\nrpc;", {
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  });
  await assert.rejects(
    rpc({ name: "stalled provider", url: "https://rpc.invalid" }, "status", []),
    /stalled provider timed out after 0.025 seconds/
  );
});

test("commitment IDs are preserved byte-for-byte for existing commitment lookups and wallet calls", () => {
  assert.ok(js.includes('const id = $("commitment-id").value;'));
  assert.ok(js.includes('const id = $("cancel-id").value;'));
  assert.ok(js.includes("verifiedSnapshot?.commitments.find(item => item.id === id)"));
  assert.ok(!js.includes('const id = $("commitment-id").value.trim();'));
  assert.ok(!js.includes('const id = $("cancel-id").value.trim();'));
  assert.ok(js.includes('if (!id || new TextEncoder().encode(id).length > 64)'));
});

test("commitment manager is Testnet-only and fixed to the configured owner and treasury", () => {
  for (const value of ["haideedotxyz.testnet", "veltron-treasury.testnet", "NEAR TESTNET"]) {
    assert.ok(html.includes(value) || js.includes(value));
  }
  assert.match(js, /network: "testnet"/);
});

test("pins both independent RPC providers to the same finalized block", () => {
  assert.ok(js.includes('"block", { finality: "final" }'));
  assert.ok(js.includes("const blockHash = finalized?.header?.hash"));
  assert.ok(js.includes("readProvider(endpoint, blockHash)"));
  assert.ok(js.includes("block_id: blockHash"));
  assert.ok(js.includes("result.block_hash !== blockHash"));
});

test("reads finalized financial position and all commitment pages from two independent RPCs", () => {
  assert.ok(js.includes("https://rpc.testnet.near.org"));
  assert.ok(js.includes("https://rpc.testnet.fastnear.com"));
  for (const method of ["get_owner", "get_financial_position", "get_pause_status", "get_commitments"]) {
    assert.ok(js.includes(method));
  }
  assert.ok(js.includes('finality: "final"'));
  assert.ok(js.includes("stable(first) !== stable(second)"));
  assert.ok(js.includes("readAllCommitments"));
  assert.ok(js.includes("pageNumber < 6"));
});

test("only the owner can request create, update, and cancel operations", () => {
  assert.ok(js.includes("accountId !== OWNER"));
  for (const method of ["create_commitment", "update_commitment", "cancel_commitment"]) assert.ok(js.includes(method));
  assert.ok(js.includes("signerId: OWNER"));
  assert.ok(js.includes("receiverId: TREASURY"));
  assert.ok(js.includes('deposit: "0"'));
});

test("amount conversion uses integer arithmetic and six-decimal precision", () => {
  assert.ok(js.includes("BigInt(match[1]) * 1000000n"));
  assert.ok(js.includes("\\d{1,6}"));
  assert.ok(!js.includes("Number(item.amount)"));
});

test("pending settlements cannot be edited or cancelled; payment and settlement are not exposed", () => {
  assert.ok(js.includes("settlement_pending"));
  assert.ok(!js.includes('methodName: "settle_commitment"'));
  assert.ok(!js.includes('methodName: "request_payment"'));
});

test("uncertain wallet outcomes require read-only verification before retry", () => {
  assert.ok(js.includes("REQUEST RESULT UNCERTAIN"));
  assert.ok(js.includes("do not blindly resubmit"));
});
