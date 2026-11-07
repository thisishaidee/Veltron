import assert from "node:assert/strict";
import test from "node:test";

const EXECUTOR_COMMIT = "ef1be35fc3712f2de60a7563aed543d78e73f763";
const EXECUTOR_URL =
  `https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/${EXECUTOR_COMMIT}/storage/meteor-near-connect-latest.js`;

test("pinned Meteor executor converts DeployContract for single and batch transactions", async () => {
  const response = await fetch(EXECUTOR_URL, { redirect: "error" });
  assert.equal(response.ok, true, `executor snapshot download failed: HTTP ${response.status}`);

  const source = await response.text();
  assert.ok(source.length > 1_000_000, "executor snapshot is unexpectedly incomplete");

  assert.match(
    source,
    /case"DeployContract":\{const\{code:\w+\}=\w+\.params;return actionCreators\.deployContract\(\w+\)\}/,
    "executor snapshot must convert DeployContract into a NEAR deployContract action",
  );

  assert.match(
    source,
    /this\.signAndSendTransaction=async \w+=>[\s\S]{0,2500}?actions\.map\(\w+=>convertSelectorActionToNearAction\(\w+\)\)/,
    "single-transaction path must use the DeployContract-capable converter",
  );

  assert.match(
    source,
    /this\.signAndSendTransactions=async \w+=>[\s\S]{0,2500}?actions\.map\(\w+=>convertSelectorActionToNearAction\(\w+\)\)/,
    "multi-transaction path must use the DeployContract-capable converter",
  );
});
