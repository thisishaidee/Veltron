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

test("calculates storage reserve and transaction fee using integer arithmetic", () => {
  const result = calculateDeploymentBudget({
    accountBalance: "50000000000000000000000000",
    storageUsage: 100,
    wasmBytes: 3,
    storageAmountPerByte: "5",
    gasPrice: "2",
    costs: {
      deployContract: { send_sir: "10", execution: "7" },
      deployContractPerByte: { send_sir: "2", execution: "3" },
      receipt: { send_sir: "11", execution: "13" }
    }
  });
  assert.equal(result.gas, "56");
  assert.equal(result.feeYocto, "112");
  assert.equal(result.storageReserveYocto, "515");
  assert.equal(result.hasSufficientBalance, true);
});

test("fails closed when the account cannot cover storage, fee, and margin", () => {
  const result = calculateDeploymentBudget({
    accountBalance: "100",
    storageUsage: 100,
    wasmBytes: 3,
    storageAmountPerByte: "5",
    gasPrice: "2",
    costs: {
      deployContract: { send_sir: "10", execution: "7" },
      deployContractPerByte: { send_sir: "2", execution: "3" },
      receipt: { send_sir: "11", execution: "13" }
    }
  });
  assert.equal(result.hasSufficientBalance, false);
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
  assert.equal(request.network, "testnet");
  assert.equal(request.signerId, TOKEN_ACCOUNT);
  assert.equal(request.receiverId, TOKEN_ACCOUNT);
  assert.equal(request.actions.length, 1);
  assert.equal(request.actions[0].type, "DeployContract");
  assert.equal(request.actions[0].params.code, bytes);
});
