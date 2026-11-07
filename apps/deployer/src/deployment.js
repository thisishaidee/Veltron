export const TOKEN_ACCOUNT = "veltron-token.testnet";
export const TOKEN_WASM_BYTES = 325106;
export const TOKEN_WASM_SHA256 = "5d5041336cc8fc92cc9ca11fff1f0b1f7ead33c4826c6d12013f957ba1e7c95b";

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function buildDeployContractAction(code) {
  if (!(code instanceof Uint8Array) || code.byteLength === 0) {
    throw new TypeError("Verified contract code must be a non-empty Uint8Array.");
  }
  return { type: "DeployContract", params: { code } };
}

export function calculateDeploymentBudget({ accountBalance, storageUsage, wasmBytes, storageAmountPerByte, gasPrice, costs }) {
  const values = [accountBalance, storageUsage, wasmBytes, storageAmountPerByte, gasPrice];
  if (values.some(value => !Number.isSafeInteger(value) && typeof value !== "bigint")) {
    throw new TypeError("Deployment budget inputs must be integers.");
  }
  const base = BigInt(costs.deployContract.send_sir);
  const perByte = BigInt(costs.deployContractPerByte.send_sir);
  const baseExecution = BigInt(costs.deployContract.execution);
  const perByteExecution = BigInt(costs.deployContractPerByte.execution);
  const receiptSend = BigInt(costs.receipt.send_sir);
  const receiptExecution = BigInt(costs.receipt.execution);
  const gas = receiptSend + base + BigInt(wasmBytes) * perByte + receiptExecution +
    baseExecution + BigInt(wasmBytes) * perByteExecution;
  const fee = gas * BigInt(gasPrice);
  const projectedStorage = BigInt(storageUsage) + BigInt(wasmBytes);
  const storageReserve = projectedStorage * BigInt(storageAmountPerByte);
  const safetyMargin = 50000000000000000000000n; // 0.05 NEAR, in addition to protocol estimate.
  const requiredBalance = storageReserve + fee + safetyMargin;
  return {
    gas: gas.toString(),
    feeYocto: fee.toString(),
    storageReserveYocto: storageReserve.toString(),
    safetyMarginYocto: safetyMargin.toString(),
    requiredBalanceYocto: requiredBalance.toString(),
    hasSufficientBalance: BigInt(accountBalance) >= requiredBalance
  };
}

export async function requestDeployContract(wallet, accountId, code) {
  if (accountId !== TOKEN_ACCOUNT) {
    throw new Error("The connected signer must be veltron-token.testnet.");
  }
  if (!wallet || typeof wallet.signAndSendTransaction !== "function") {
    throw new Error("The connected wallet does not expose signAndSendTransaction.");
  }
  return wallet.signAndSendTransaction({
    receiverId: TOKEN_ACCOUNT,
    actions: [buildDeployContractAction(code)]
  });
}
