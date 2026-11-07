export const TOKEN_ACCOUNT = "veltron-token.testnet";
export const TOKEN_WASM_BYTES = 325106;
export const TOKEN_WASM_SHA256 = "5d5041336cc8fc92cc9ca11fff1f0b1f7ead33c4826c6d12013f957ba1e7c95b";

function asInteger(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\\d+$/.test(value)) return BigInt(value);
  throw new TypeError(label + " must be a non-negative integer.");
}

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
  const balance = asInteger(accountBalance, "Account balance");
  const usage = asInteger(storageUsage, "Storage usage");
  const byteCount = asInteger(wasmBytes, "WASM byte count");
  const storageRate = asInteger(storageAmountPerByte, "Storage amount per byte");
  const price = asInteger(gasPrice, "Gas price");
  const base = asInteger(costs.deployContract.send_sir, "DeployContract send fee");
  const perByte = asInteger(costs.deployContractPerByte.send_sir, "DeployContract per-byte send fee");
  const baseExecution = asInteger(costs.deployContract.execution, "DeployContract execution fee");
  const perByteExecution = asInteger(costs.deployContractPerByte.execution, "DeployContract per-byte execution fee");
  const receiptSend = asInteger(costs.receipt.send_sir, "Receipt send fee");
  const receiptExecution = asInteger(costs.receipt.execution, "Receipt execution fee");
  const gas = receiptSend + base + byteCount * perByte + receiptExecution + baseExecution + byteCount * perByteExecution;
  const fee = gas * price;
  const projectedStorage = usage + byteCount;
  const storageReserve = projectedStorage * storageRate;
  const safetyMargin = 50000000000000000000000n; // 0.05 NEAR, in addition to protocol estimate.
  const requiredBalance = storageReserve + fee + safetyMargin;
  return {
    gas: gas.toString(),
    feeYocto: fee.toString(),
    storageReserveYocto: storageReserve.toString(),
    safetyMarginYocto: safetyMargin.toString(),
    requiredBalanceYocto: requiredBalance.toString(),
    hasSufficientBalance: balance >= requiredBalance
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
