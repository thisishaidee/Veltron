import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../execution.html", import.meta.url), "utf8");

test("balance page is explicitly read-only and names the intended Testnet accounts", () => {
  assert.match(html, /READ-ONLY/);
  assert.match(html, /veltron-token\.testnet/);
  assert.match(html, /haideedotxyz\.testnet/);
  assert.match(html, /veltron-agent\.testnet/);
  assert.match(html, /rpc\.testnet\.near\.org/);
});

test("page reads token metadata and both NEP-141 balances", () => {
  assert.match(html, /view\("ft_metadata"/);
  assert.match(html, /view\("ft_balance_of", \{ account_id: OWNER \}\)/);
  assert.match(html, /view\("ft_balance_of", \{ account_id: AGENT \}\)/);
  assert.match(html, /metadata\.decimals !== 6/);
});

test("page rejects a non-Testnet RPC response and displays live balances", () => {
  assert.match(html, /network\.chain_id !== "testnet"/);
  assert.match(html, /formatVtt\(ownerBalance\)/);
  assert.match(html, /formatVtt\(agentBalance\)/);
});

test("page contains no wallet connection, signing, or transfer capability", () => {
  assert.doesNotMatch(html, /NearConnector|signAndSendTransaction|wallet\.connect|ft_transfer|FunctionCall/);
  assert.doesNotMatch(html, /seed phrase input|private key input/i);
});
