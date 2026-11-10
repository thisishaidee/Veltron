export const TREASURY_ACCOUNT = "veltron-treasury.testnet";
export const NEW_TREASURY_WASM_BYTES = 338235;
export const NEW_TREASURY_WASM_SHA256 = "66d3d95d8b4f7142cb47062051a93158994236a3791d83e994946af3dd5525af";
export const OLD_TREASURY_WASM_SHA256 = "3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36";
export const TREASURY_SAFETY_RESERVE = "200000000";

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function integer(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new TypeError(label + " must be a non-negative integer.");
}

export function calculateTreasuryDeployBudget({balance, storageUsage, wasmBytes, storageAmountPerByte, gasPrice, minGasPurchasePrice, costs}) {
  const baseSend = integer(costs.deploy.send_sir, "DeployContract send fee");
  const perByteSend = integer(costs.deployPerByte.send_sir, "DeployContract per-byte send fee");
  const baseExec = integer(costs.deploy.execution, "DeployContract execution fee");
  const perByteExec = integer(costs.deployPerByte.execution, "DeployContract per-byte execution fee");
  const receiptSend = integer(costs.receipt.send_sir, "Receipt send fee");
  const receiptExec = integer(costs.receipt.execution, "Receipt execution fee");
  const bytes = integer(wasmBytes, "WASM bytes");
  const sendGas = receiptSend + baseSend + bytes * perByteSend;
  const executionGas = receiptExec + baseExec + bytes * perByteExec;
  const currentGasPrice = integer(gasPrice, "Gas price");
  const receiptGasPrice = currentGasPrice > integer(minGasPurchasePrice, "Minimum gas purchase price")
    ? currentGasPrice : integer(minGasPurchasePrice, "Minimum gas purchase price");
  // NEP-642 prices transaction-to-receipt send gas at the current block price,
  // and prepaid receipt execution gas at max(current price, min gas purchase price).
  const sendFeeYocto = sendGas * currentGasPrice;
  const executionFeeYocto = executionGas * receiptGasPrice;
  const feeYocto = sendFeeYocto + executionFeeYocto;
  const projectedStorage = integer(storageUsage, "Storage usage") + bytes;
  const storageReserveYocto = projectedStorage * integer(storageAmountPerByte, "Storage amount per byte");
  const safetyMarginYocto = 50000000000000000000000n;
  const required = storageReserveYocto + feeYocto + safetyMarginYocto;
  const available = integer(balance, "Account balance");
  return {
    sendGas: sendGas.toString(),
    executionGas: executionGas.toString(),
    sendFeeYocto: sendFeeYocto.toString(),
    executionFeeYocto: executionFeeYocto.toString(),
    feeYocto: feeYocto.toString(),
    storageReserveYocto: storageReserveYocto.toString(),
    safetyMarginYocto: safetyMarginYocto.toString(),
    requiredBalanceYocto: required.toString(),
    hasSufficientBalance: available >= required
  };
}

export function buildTreasuryDeployAction(code) {
  if (!(code instanceof Uint8Array) || code.byteLength !== NEW_TREASURY_WASM_BYTES) {
    throw new TypeError("Treasury WASM must be the exact reviewed non-empty artifact.");
  }
  return {type:"DeployContract",params:{code}};
}

export async function requestTreasuryDeploy(wallet, signerId, code) {
  if (signerId !== TREASURY_ACCOUNT) throw new Error("The connected signer must be " + TREASURY_ACCOUNT + ".");
  if (!wallet || typeof wallet.signAndSendTransaction !== "function") {
    throw new Error("The connected wallet does not expose signAndSendTransaction.");
  }
  return wallet.signAndSendTransaction({
    signerId:TREASURY_ACCOUNT,
    receiverId:TREASURY_ACCOUNT,
    actions:[buildTreasuryDeployAction(code)]
  });
}

export function decodeViewResult(result) {
  if (!Array.isArray(result?.result)) throw new Error("Malformed NEAR view-function response.");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}
