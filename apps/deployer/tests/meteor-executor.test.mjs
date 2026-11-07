import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const EXECUTOR_COMMIT = "ef1be35fc3712f2de60a7563aed543d78e73f763";
const EXECUTOR_URL =
  "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/" +
  EXECUTOR_COMMIT +
  "/storage/meteor-near-connect-latest.js";
const LIVE_MANIFEST_URL =
  "https://raw.githubusercontent.com/Meteor-Wallet/near-connect/main/repository/manifest.json";

function assertDeployContractSupport(source, label) {
  assert.match(
    source,
    /case"DeployContract":\{const\{code:\w+\}=\w+\.params;return actionCreators\.deployContract\(\w+\)\}/,
    label + " must convert DeployContract into a NEAR deployContract action",
  );

  assert.match(
    source,
    /this\.signAndSendTransaction=async \w+=>[\s\S]{0,2500}?actions\.map\(\w+=>convertSelectorActionToNearAction\(\w+\)\)/,
    label + " single-transaction path must use the DeployContract-capable converter",
  );

  assert.match(
    source,
    /this\.signAndSendTransactions=async \w+=>[\s\S]{0,2500}?actions\.map\(\w+=>convertSelectorActionToNearAction\(\w+\)\)/,
    label + " multi-transaction path must use the DeployContract-capable converter",
  );
}

async function fetchSource(url, label, minimumLength = 1_000_000) {
  const response = await fetch(url, { redirect: "error" });
  assert.equal(response.ok, true, label + " download failed: HTTP " + response.status);
  const source = await response.text();
  assert.ok(source.length > minimumLength, label + " is unexpectedly incomplete");
  return source;
}

test("pinned Meteor executor converts DeployContract for single and batch transactions", async () => {
  const source = await fetchSource(EXECUTOR_URL, "pinned executor snapshot");
  assertDeployContractSupport(source, "pinned executor snapshot");
});

test("current NEAR Connect manifest points to a DeployContract-capable Meteor executor", async () => {
  const manifestSource = await fetchSource(LIVE_MANIFEST_URL, "current NEAR Connect manifest", 1_000);
  const manifest = JSON.parse(manifestSource);
  const meteor = manifest.wallets?.find((wallet) => wallet.id === "meteor-wallet");

  assert.ok(meteor, "current manifest must include Meteor Wallet");
  assert.equal(meteor.version, "1.1.1", "review the test if the Meteor executor version changes");
  assert.equal(
    meteor.executor,
    "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/data-storage/storage/meteor-near-connect-latest.js",
    "review the test if Meteor changes its live executor URL",
  );

  const source = await fetchSource(meteor.executor, "live Meteor executor");
  assertDeployContractSupport(source, "live Meteor executor");

  const sha256 = createHash("sha256").update(source).digest("hex");
  console.log("Live Meteor executor SHA-256: " + sha256);
});
