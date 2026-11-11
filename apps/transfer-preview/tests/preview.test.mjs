import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../index.html", import.meta.url);
const html = await readFile(pageUrl, "utf8");
const inlineScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];

test("transfer preview is explicitly read-only", () => {
  assert.match(html, /cannot connect a wallet, request signatures, or submit transactions/i);
  assert.match(html, /preview only/i);
  assert.doesNotMatch(html, /@hot-labs\/near-connect|signAndSendTransaction|createSignedTransaction|wallet\.sign/i);
});

test("page reads the expected NEP-141 state", () => {
  assert.ok(inlineScript, "inline preflight script must exist");
  for (const method of ["ft_metadata", "ft_balance_of", "storage_balance_of"]) {
    assert.ok(inlineScript.includes('view("' + method + '"'), "must read " + method);
  }
  assert.ok(inlineScript.includes('finality:"final"'), "RPC reads must use finalized state");
});

test("preview contains the exact proposed test-transfer parameters", () => {
  assert.match(html, /haideedotxyz\.testnet/);
  assert.match(html, /veltron-agent\.testnet/);
  assert.match(html, /"amount": "10000000"/);
  assert.match(html, /1 yoctoNEAR/);
  assert.match(html, /VELTRON test transfer/);
  assert.equal((10n * (10n ** 6n)).toString(), "10000000");
});

test("inline JavaScript parses without executing browser actions", () => {
  assert.ok(inlineScript, "inline preflight script must exist");
  assert.doesNotThrow(() => new Function(inlineScript));
});
