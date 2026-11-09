import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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

test("persists the connected signer ID for preflight and clears it on reset", () => {
  const walletSource = readFileSync(new URL("../src/wallet.js", import.meta.url), "utf8");
  assert.match(walletSource, /connectedAccountId = accountId;/);
  assert.match(walletSource, /function resetWalletDetails\(\)\s*\{\s*connectedAccountId = undefined;/);
});

test("treasury preflight is read-only and pinned to the treasury account and CI artifact", () => {
  const page = readFileSync(new URL("../treasury.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/treasury-preflight.js", import.meta.url), "utf8");
  assert.match(page, /Read-only Deployment Preflight/);
  assert.match(page, /veltron-treasury\.testnet/);
  assert.match(source, /const ACCOUNT="veltron-treasury\.testnet"/);
  assert.match(source, /338088/);
  assert.match(source, /3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36/);
  assert.match(source, /view_access_key_list/);
  assert.match(source, /view_account/);
  assert.match(source, /view_code/);
  assert.doesNotMatch(page + source, /signAndSendTransaction|DeployContract|signMessage|wallet\.connect|ft_transfer/);
});

import {
  TREASURY_ACCOUNT,
  TREASURY_WASM_BYTES,
  TREASURY_WASM_SHA256,
  buildTreasuryDeployAction,
  calculateTreasuryDeploymentBudget,
  requestTreasuryDeployContract
} from "../src/treasury-deployment.js";

test("treasury deploy module is pinned to the treasury account and exact CI artifact", () => {
  assert.equal(TREASURY_ACCOUNT, "veltron-treasury.testnet");
  assert.equal(TREASURY_WASM_BYTES, 338088);
  assert.equal(TREASURY_WASM_SHA256, "3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36");
  assert.throws(() => buildTreasuryDeployAction(new Uint8Array([1, 2, 3])), /exact verified/);
});

test("treasury deploy action contains exactly one DeployContract action for the treasury account", async () => {
  const bytes = new Uint8Array(TREASURY_WASM_BYTES);
  let request;
  const wallet = { signAndSendTransaction: async value => { request = value; return "wallet-result"; } };
  const result = await requestTreasuryDeployContract(wallet, TREASURY_ACCOUNT, bytes);
  assert.equal(result, "wallet-result");
  assert.equal(request.network, "testnet");
  assert.equal(request.signerId, TREASURY_ACCOUNT);
  assert.equal(request.receiverId, TREASURY_ACCOUNT);
  assert.equal(request.actions.length, 1);
  assert.equal(request.actions[0].type, "DeployContract");
  assert.equal(request.actions[0].params.code, bytes);
});

test("treasury deploy refuses any other signer before calling the wallet", async () => {
  let called = false;
  const wallet = { signAndSendTransaction: async () => { called = true; } };
  await assert.rejects(
    requestTreasuryDeployContract(wallet, "haideedotxyz.testnet", new Uint8Array(TREASURY_WASM_BYTES)),
    /signer must be veltron-treasury.testnet/
  );
  assert.equal(called, false);
});

test("treasury budget uses only the pinned treasury WASM byte count", () => {
  const input = {
    accountBalance: "50000000000000000000000000",
    storageUsage: 182,
    wasmBytes: TREASURY_WASM_BYTES,
    storageAmountPerByte: "5",
    gasPrice: "2",
    costs: {
      deployContract: { send_sir: "10", execution: "7" },
      deployContractPerByte: { send_sir: "2", execution: "3" },
      receipt: { send_sir: "11", execution: "13" }
    }
  };
  assert.equal(calculateTreasuryDeploymentBudget(input).hasSufficientBalance, true);
  assert.throws(() => calculateTreasuryDeploymentBudget({ ...input, wasmBytes: 325106 }), /pinned WASM/);
});

import { readFileSync as readTreasuryFile } from "node:fs";

test("dedicated treasury deployment page is pinned, isolated, and guarded", () => {
  const page = readTreasuryFile(new URL("../treasury-deploy.html", import.meta.url), "utf8");
  const source = readTreasuryFile(new URL("../src/treasury-deploy.js", import.meta.url), "utf8");
  assert.match(page, /veltron-treasury\.testnet/);
  assert.match(page, /338,088 bytes/);
  assert.match(page, /3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36/);
  assert.match(source, /chain_id!==\"testnet\"/);
  assert.match(source, /view_account/);
  assert.match(source, /view_access_key_list/);
  assert.match(source, /view_code/);
  assert.match(source, /EXPERIMENTAL_protocol_config/);
  assert.match(source, /calculateTreasuryDeploymentBudget/);
  assert.match(source, /requestTreasuryDeployContract/);
  assert.match(source, /connectedAccount===TREASURY_ACCOUNT/);
  assert.match(page, /cannot initialize or transfer tokens/);
  assert.doesNotMatch(source, /ft_transfer|ft_transfer_call|FunctionCall|signMessage/);
});

test("dedicated treasury deployer requires a verified NEP-413 ownership proof before preflight and deployment", () => {
  const page = readFileSync(new URL("../treasury-deploy.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/treasury-deploy.js", import.meta.url), "utf8");
  assert.match(page, /id="prove-wallet"/);
  assert.match(source, /signMessageParams/);
  assert.match(source, /crypto\.subtle\.verify/);
  assert.match(source, /request_type:"view_access_key"/);
  assert.match(source, /permission!=="FullAccess"/);
  assert.match(source, /ownershipVerified/);
  assert.match(source, /!ownershipVerified/);
  assert.match(source, /freshBudget\.hasSufficientBalance/);
  assert.match(source, /NO_CONTRACT_CODE/);
  assert.doesNotMatch(source, /ft_transfer|ft_transfer_call|FunctionCall/);
});
