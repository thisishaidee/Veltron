export const TREASURY_ACCOUNT = "veltron-treasury.testnet";
export const TREASURY_WASM_BYTES = 338088;
export const TREASURY_WASM_SHA256 = "3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36";

import { calculateDeploymentBudget } from "./deployment.js";

export function buildTreasuryDeployAction(code) {
  if (!(code instanceof Uint8Array) || code.byteLength !== TREASURY_WASM_BYTES) {
    throw new TypeError("Treasury WASM must be the exact verified 338,088-byte artifact.");
  }
  return { type: "DeployContract", params: { code } };
}

export function calculateTreasuryDeploymentBudget(input) {
  if (input.wasmBytes !== TREASURY_WASM_BYTES) {
    throw new Error("Treasury deployment budget must use the pinned WASM byte count.");
  }
  return calculateDeploymentBudget(input);
}

export async function requestTreasuryDeployContract(wallet, accountId, code) {
  if (accountId !== TREASURY_ACCOUNT) {
    throw new Error("The connected signer must be veltron-treasury.testnet.");
  }
  if (!wallet || typeof wallet.signAndSendTransaction !== "function") {
    throw new Error("The connected wallet does not expose signAndSendTransaction.");
  }
  const action = buildTreasuryDeployAction(code);
  return wallet.signAndSendTransaction({
    network: "testnet",
    signerId: TREASURY_ACCOUNT,
    receiverId: TREASURY_ACCOUNT,
    actions: [action]
  });
}
