import assert from "node:assert/strict";
import test from "node:test";
import {
  TOKEN_ACCOUNT,
  buildDeployContractAction,
  calculateDeploymentBudget,
  requestDeployContract
} from "../src/deployment.js";

test("builds only a DeployContract action with the supplied WASM bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const action = buildDeployContractAction(bytes);
  assert.equal(action.type, "DeployContract");
  assert.equal(action.params.code, bytes);
  assert.throws(() => buildDeployContractAction(new Uint8Array()), /non-empty/);
});

test("calculates storage reserve and one-action transaction fee using integer arithmetic", () => {
  const result = calculateDeploymentBudget({
    accountBalance: "5319866090462500000000000",
    storageUsage: 182,
    wasmBytes: 325106,
    storageAmountPerByte: "10000000000000000000",
    gasPrice: "100000000",
    costs: {
      deployContract: { send_sir: "184765750000", execution: "0" },
      deployContractPerByte: { send_sir: "6812999", execution: "0" },
      receipt: { send_sir: "108059500000", execution: "108059500000" }
    }
  });
  assert.equal(result.hasSufficientBalance, true);
  assert.equal(result.storageReserveYocto, "3252880000000000000000000");
  assert.equal(result.feeYocto, "239971260289400000000");
  assert.equal(result.requiredBalanceYocto, "3307849260289400000000000");
});

test("refuses a signer other than the dedicated token account", async () => {
  let called = false;
  const wallet = { signAndSendTransaction: async () => { called = true; } };
  await assert.rejects(
    requestDeployContract(wallet, "haideedotxyz.testnet", new Uint8Array([1])),
    /signer must be veltron-token.testnet/
  );
  assert.equal(called, false);
});

test("requests exactly one DeployContract transaction for the token account", async () => {
  const bytes = new Uint8Array([7, 8, 9]);
  let request;
  const wallet = { signAndSendTransaction: async value => { request = value; return "wallet-result"; } };
  const result = await requestDeployContract(wallet, TOKEN_ACCOUNT, bytes);
  assert.equal(result, "wallet-result");
  assert.equal(request.receiverId, TOKEN_ACCOUNT);
  assert.equal(request.actions.length, 1);
  assert.equal(request.actions[0].type, "DeployContract");
  assert.equal(request.actions[0].params.code, bytes);
});
