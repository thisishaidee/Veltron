import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("execution page is explicitly Testnet-only and binds the intended account and contract", () => {
  assert.match(html, /network:"testnet"/);
  assert.match(html, /haideedotxyz\.testnet/);
  assert.match(html, /veltron-token\.testnet/);
  assert.match(html, /veltron-agent\.testnet/);
});

test("exact NEP-141 transfer action is configured", () => {
  assert.match(html, /methodName:"ft_transfer"/);
  assert.match(html, /amount:AMOUNT/);
  assert.match(html, /AMOUNT="10000000"/);
  assert.match(html, /deposit:"1"/);
  assert.match(html, /memo:"VELTRON test transfer"/);
});

test("transaction request is behind explicit user interaction and fresh checks", () => {
  assert.match(html, /if\(!checksPassed\|\|accountId!==OWNER\|\|!wallet\)/);
  assert.match(html, /window\.confirm\(/);
  assert.match(html, /reviewButtonNotUsed/);
  assert.match(html, /addEventListener\("click",async\(\)=>\{/);
  assert.match(html, /wallet\.signAndSendTransaction\(/);
});

test("page never requests secret keys or recovery phrases", () => {
  assert.doesNotMatch(html, /seed phrase input|private key input/i);
});
