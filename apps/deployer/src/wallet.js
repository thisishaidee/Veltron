import { NearConnector } from "@hot-labs/near-connect";
import {
  TOKEN_ACCOUNT,
  TOKEN_WASM_BYTES,
  TOKEN_WASM_SHA256,
  calculateDeploymentBudget,
  requestDeployContract,
  sha256Hex
} from "./deployment.js";

const connectButton = document.querySelector("#connect-wallet");
const status = document.querySelector("#wallet-status");
const account = document.querySelector("#wallet-account");
const network = document.querySelector("#wallet-network");
const rpcNetwork = document.querySelector("#rpc-network");

let connector;
let connectedAccountId;

function showStatus(message) {
  status.textContent = message;
}

function resetWalletDetails() {
  account.textContent = "Not connected";
  network.textContent = "Not independently verified";
}

const RPC_ENDPOINTS = [
  { name: "FastNEAR", url: "https://rpc.testnet.fastnear.com" },
  { name: "dRPC", url: "https://near-testnet.drpc.org" },
  { name: "NEAR public RPC", url: "https://rpc.testnet.near.org" }
];
const verifiedRpcEndpoints = new Set();

async function rpcRequest(endpoint, method, params, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-read-only-check", method, params }),
      signal: controller.signal
    });
    const responseText = await response.text();
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error("HTTP " + response.status + ": RPC returned a non-JSON response.");
    }
    if (!response.ok) throw new Error("HTTP " + response.status + ": " + (payload?.message || payload?.error?.message || "request failed"));
    if (payload.error) {
      const rpcError = payload.error;
      const detail = rpcError.data
        ? " Details: " + (typeof rpcError.data === "string" ? rpcError.data : JSON.stringify(rpcError.data)).slice(0, 300)
        : "";
      throw new Error("RPC error" + (rpcError.code ? " (" + rpcError.code + ")" : "") + ": " + (rpcError.message || "request failed") + detail);
    }
    if (!payload.result) throw new Error("RPC response did not contain a result.");
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function getVerifiedRpcEndpoints() {
  const verified = [];
  const failures = [];
  for (const endpoint of RPC_ENDPOINTS) {
    if (verifiedRpcEndpoints.has(endpoint.url)) {
      verified.push(endpoint);
      continue;
    }
    try {
      const statusResult = await rpcRequest(endpoint, "status", [], 8000);
      if (statusResult.chain_id !== "testnet") {
        failures.push(endpoint.name + " did not identify Testnet");
        continue;
      }
      verifiedRpcEndpoints.add(endpoint.url);
      verified.push(endpoint);
    } catch (error) {
      failures.push(endpoint.name + ": " + (error?.name === "AbortError" ? "timeout" : String(error?.message || error)));
    }
  }
  if (!verified.length) throw new Error("No RPC endpoint could be verified as NEAR Testnet. " + failures.join(" | "));
  return verified;
}

async function verifyRpcNetwork() {
  rpcNetwork.textContent = "Checking independent Testnet RPC providers…";
  try {
    const endpoints = await getVerifiedRpcEndpoints();
    rpcNetwork.textContent = "Testnet verified via " + endpoints[0].name + " (read-only RPC; " + endpoints.length + " verified endpoint" + (endpoints.length === 1 ? "" : "s") + ")";
  } catch (error) {
    rpcNetwork.textContent = "Unverified — " + String(error?.message || error).slice(0, 220);
    console.error("VELTRON NEAR RPC network check failed", error);
  }
}

function handleWalletSignIn(event) {
  const accountId = event?.accounts?.[0]?.accountId;
  if (!accountId) {
    resetWalletDetails();
    account.textContent = "Unavailable";
    showStatus("Wallet connected, but no account ID was returned.");
    return;
  }

  account.textContent = accountId;
  deployButton.disabled = accountId !== TOKEN_ACCOUNT;
  network.textContent = "Not independently verified";
  showStatus(
    "Wallet connected. The wallet's active network is not independently verified by this page. Confirm Testnet in Meteor itself before requesting a deployment."
  );
  connectButton.disabled = false;
}

function initializeWalletConnection() {
  connectButton.disabled = true;
  showStatus("Preparing supported wallet options…");
  resetWalletDetails();
  verifyRpcNetwork();

  try {
    connector = new NearConnector({
      network: "testnet",
      features: { testnet: true },
      footerBranding: null
    });

    connector.on("wallet:signIn", handleWalletSignIn);

    connector.on("wallet:signOut", () => {
      deployButton.disabled = true;
      resetWalletDetails();
      showStatus("Wallet disconnected.");
      connectButton.disabled = false;
    });

    connectButton.disabled = false;
    showStatus("Ready. Choose a wallet that supports NEAR Testnet.");
  } catch (error) {
    connector = undefined;
    connectButton.disabled = true;
    showStatus("Wallet connector could not initialize. Reload and try again.");
    console.error("VELTRON wallet connector initialization failed", error);
  }
}

connectButton.addEventListener("click", async () => {
  if (!connector) return;
  connectButton.disabled = true;
  showStatus("Opening wallet connection…");

  try {
    await connector.connect();
  } catch (error) {
    showStatus("Connection was not completed. You can try again.");
    console.error("VELTRON wallet connection failed", error);
    connectButton.disabled = false;
  }
});

initializeWalletConnection();


const tokenCheckButton = document.querySelector("#verify-token-contract");
const tokenCheckStatus = document.querySelector("#token-contract-status");

async function nearRpc(method, params) {
  const endpoints = await getVerifiedRpcEndpoints();
  const failures = [];
  for (const endpoint of endpoints) {
    try {
      return await rpcRequest(endpoint, method, params, 12000);
    } catch (error) {
      failures.push(endpoint.name + ": " + (error?.name === "AbortError" ? "timeout" : String(error?.message || error)));
    }
  }
  throw new Error("All verified Testnet RPC endpoints failed. " + failures.join(" | "));
}

function explainTokenCheckError(error) {
  const message = String(error?.message || error || "Unknown RPC error");
  if (error?.name === "AbortError") return "RPC request timed out. The Testnet RPC may be busy; retry shortly.";
  if (/does not exist|unknown account|account.*not found/i.test(message)) {
    return "TOKEN ACCOUNT NOT FOUND: veltron-token.testnet was not found by the Testnet RPC. Check the account ID and network.";
  }
  if (/doesn't exist|no contract|contract.*not found|method.*not found/i.test(message)) {
    return "ACCOUNT OR CONTRACT CHECK FAILED: " + message;
  }
  return message.slice(0, 700);
}

async function verifyTokenContractReadOnly() {
  tokenCheckButton.disabled = true;
  tokenCheckStatus.textContent = "Checking whether veltron-token.testnet exists on NEAR Testnet…";
  try {
    const accountInfo = await nearRpc("query", {
      request_type: "view_account",
      finality: "final",
      account_id: "veltron-token.testnet"
    });

    tokenCheckStatus.textContent = "Account found. Checking for deployed contract code…";
    let code;
    try {
      code = await nearRpc("query", {
        request_type: "view_code",
        finality: "final",
        account_id: "veltron-token.testnet"
      });
    } catch (error) {
      const message = String(error?.message || error || "");
      if (/contract code for contract ID .* has never been observed/i.test(message)) {
        code = null;
      } else {
        throw error;
      }
    }

    if (!code || !code.code_base64) {
      tokenCheckStatus.textContent =
        "ACCOUNT EXISTS — veltron-token.testnet was found, but no contract code is deployed. " +
        "Account balance: " + (accountInfo.amount || "unavailable") +
        " yoctoNEAR. This is a read-only result; no transaction was sent.";
      return;
    }

    tokenCheckStatus.textContent = "Contract code exists. Code hash: " + code.hash + ". Checking NEP-141 metadata…";
    const view = await nearRpc("query", {
      request_type: "call_function",
      finality: "final",
      account_id: "veltron-token.testnet",
      method_name: "ft_metadata",
      args_base64: btoa("{}")
    });

    const metadataText = new TextDecoder().decode(new Uint8Array(view.result));
    const metadata = JSON.parse(metadataText);
    const decimals = Number(metadata.decimals);
    const symbol = String(metadata.symbol || "Unknown");
    const name = String(metadata.name || "Unnamed token");
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) {
      throw new Error("Token returned invalid decimals metadata.");
    }
    const scale = 10n ** BigInt(decimals);
    const cap = (50n * scale).toString();
    const reserve = (200n * scale).toString();
    tokenCheckStatus.textContent =
      "CONTRACT CODE FOUND — ft_metadata responded successfully. This confirms metadata only, not full NEP-141 compliance. Token: " + name +
      " (" + symbol + "), decimals: " + decimals +
      ". Proposed settings: 50 tokens per agent payment = " + cap +
      " smallest units; 200-token reserve = " + reserve +
      " smallest units. Code hash: " + code.hash +
      ". Read-only check only; nothing was deployed, initialized, or transferred.";
  } catch (error) {
    tokenCheckStatus.textContent = "CHECK INCOMPLETE: " + explainTokenCheckError(error) +
      " No transaction was sent. This check is read-only.";
    console.error("VELTRON token contract read-only check failed", error);
  } finally {
    tokenCheckButton.disabled = false;
  }
}

tokenCheckButton.addEventListener("click", verifyTokenContractReadOnly);


const deployButton = document.querySelector("#deploy-token-contract");
const deployNetworkConfirmation = document.querySelector("#confirm-testnet-network");
const deployStatus = document.querySelector("#deployment-execution-status");
const verifyDeployedCodeButton = document.querySelector("#verify-deployed-code");

function formatYoctoNear(value) {
  const amount = BigInt(value);
  const whole = amount / 10n ** 24n;
  const fraction = (amount % (10n ** 24n)).toString().padStart(24, "0").slice(0, 6);
  return whole.toString() + "." + fraction + " NEAR";
}

async function readDeploymentPreflight(file) {
  const statusResult = await nearRpc("status", []);
  if (statusResult.chain_id !== "testnet") throw new Error("RPC no longer confirms NEAR Testnet.");

  const wasmBytes = new Uint8Array(await file.arrayBuffer());
  if (wasmBytes.byteLength !== TOKEN_WASM_BYTES) {
    throw new Error("WASM size mismatch. Expected " + TOKEN_WASM_BYTES + " bytes; received " + wasmBytes.byteLength + ".");
  }
  const localHash = await sha256Hex(wasmBytes);
  if (localHash !== TOKEN_WASM_SHA256) {
    throw new Error("WASM SHA-256 mismatch. The selected file is not the recorded CI artifact.");
  }

  const block = await nearRpc("block", { finality: "final" });
  const config = await nearRpc("EXPERIMENTAL_protocol_config", { block_id: block.header.height });
  const accountInfo = await nearRpc("query", {
    request_type: "view_account",
    finality: "final",
    account_id: TOKEN_ACCOUNT
  });

  try {
    const deployed = await nearRpc("query", {
      request_type: "view_code",
      finality: "final",
      account_id: TOKEN_ACCOUNT
    });
    if (deployed?.code_base64) {
      throw new Error("STOP: contract code already exists at " + TOKEN_ACCOUNT + ". Do not overwrite it.");
    }
  } catch (error) {
    if (String(error?.message || error).startsWith("STOP:")) throw error;
    if (!/contract code for contract ID .* has never been observed|contract.*not found|no contract code/i.test(String(error?.message || error))) {
      throw new Error("Could not prove the target account has no contract code: " + String(error?.message || error));
    }
  }

  const runtime = config.runtime_config;
  const costs = runtime?.transaction_costs;
  const actionConfig = costs?.action_creation_config;
  const receiptConfig = costs?.action_receipt_creation_config;
  if (!runtime?.storage_amount_per_byte || !actionConfig?.deploy_contract_cost ||
      !actionConfig?.deploy_contract_cost_per_byte || !receiptConfig?.send_sir ||
      !receiptConfig?.execution || !block?.header?.gas_price) {
    throw new Error("Current Testnet fee or storage configuration is incomplete. Stop; no transaction was requested.");
  }

  const budget = calculateDeploymentBudget({
    accountBalance: accountInfo.amount,
    storageUsage: accountInfo.storage_usage,
    wasmBytes: wasmBytes.byteLength,
    storageAmountPerByte: runtime.storage_amount_per_byte,
    gasPrice: block.header.gas_price,
    costs: {
      deployContract: actionConfig.deploy_contract_cost,
      deployContractPerByte: actionConfig.deploy_contract_cost_per_byte,
      receipt: receiptConfig
    }
  });
  if (!budget.hasSufficientBalance) {
    throw new Error("Insufficient balance for the live storage reserve, modeled transaction fee, and 0.05 NEAR safety margin. No wallet request was made.");
  }
  return { wasmBytes, localHash, block, budget, accountInfo };
}

async function verifyDeployedTokenCode() {
  const result = await nearRpc("query", {
    request_type: "view_code",
    finality: "final",
    account_id: TOKEN_ACCOUNT
  });
  if (!result?.code_base64) throw new Error("No deployed code is visible at the finalized block yet.");
  const binary = Uint8Array.from(atob(result.code_base64), character => character.charCodeAt(0));
  const actualHash = await sha256Hex(binary);
  if (actualHash !== TOKEN_WASM_SHA256) {
    throw new Error("STOP: on-chain WASM SHA-256 does not match the approved CI artifact. Do not initialize.");
  }
  return { actualHash, bytes: binary.byteLength };
}

deployButton.addEventListener("click", async () => {
  let walletRequestStarted = false;
  deployButton.disabled = true;
  deployStatus.textContent = "Running fresh Testnet, account, artifact, fee, and storage checks…";
  try {
    if (!connector || !connectedAccountId) throw new Error("Connect the intended wallet first.");
    if (connectedAccountId !== TOKEN_ACCOUNT) throw new Error("Connected account must be " + TOKEN_ACCOUNT + ".");
    if (!deployNetworkConfirmation.checked) throw new Error("Confirm that Meteor Wallet itself currently displays Testnet before continuing.");
    const file = document.querySelector("#token").files[0];
    if (!file) throw new Error("Select the verified veltron_test_token.wasm file first.");

    const preflight = await readDeploymentPreflight(file);
    deployStatus.textContent =
      "Preflight passed at finalized block " + preflight.block.header.height +
      ". Modeled transaction fee: " + formatYoctoNear(preflight.budget.feeYocto) +
      "; projected storage reserve: " + formatYoctoNear(preflight.budget.storageReserveYocto) +
      "; additional safety margin: 0.05 NEAR. Opening Meteor for your review. Approve only if it shows Testnet, signer/receiver " +
      TOKEN_ACCOUNT + ", and one DeployContract action. No initialization is included.";

    const wallet = await connector.wallet();
    const outcome = await requestDeployContract(wallet, connectedAccountId, preflight.wasmBytes);
    deployStatus.textContent = "Wallet request returned. Checking finalized on-chain code hash; do not initialize unless it matches exactly.";
    try {
      const verified = await verifyDeployedTokenCode();
      deployStatus.textContent =
        "DEPLOYED CODE HASH VERIFIED — " + verified.actualHash +
        " (" + verified.bytes + " bytes). This verifies code identity only. Token is NOT initialized. Stop here; initialization requires a separate review.";
    } catch (verifyError) {
      deployStatus.textContent =
        "Wallet request returned" + (outcome ? " with a response" : "") +
        ", but on-chain code verification is not complete: " + String(verifyError?.message || verifyError) +
        " Do not initialize. Retry the read-only code check later.";
    }
  } catch (error) {
    deployStatus.textContent = walletRequestStarted
      ? "WALLET REQUEST DID NOT RETURN SUCCESSFULLY — submission status is uncertain. Use the read-only code-hash check before retrying; do not initialize. Details: " + String(error?.message || error)
      : "PREFLIGHT STOPPED BEFORE THE WALLET REQUEST: " + String(error?.message || error);
    console.error("VELTRON DeployContract flow stopped", error);
  } finally {
    deployButton.disabled = connectedAccountId !== TOKEN_ACCOUNT;
  }
});


verifyDeployedCodeButton.addEventListener("click", async () => {
  verifyDeployedCodeButton.disabled = true;
  deployStatus.textContent = "Reading finalized on-chain contract code and comparing its SHA-256…";
  try {
    const verified = await verifyDeployedTokenCode();
    deployStatus.textContent =
      "DEPLOYED CODE HASH VERIFIED — " + verified.actualHash +
      " (" + verified.bytes + " bytes). This verifies code identity only. Token is NOT initialized. Stop here; initialization requires a separate review.";
  } catch (error) {
    deployStatus.textContent = "CODE NOT VERIFIED — " + String(error?.message || error) +
      " Do not initialize. You may retry this read-only check after the transaction is finalized.";
  } finally {
    verifyDeployedCodeButton.disabled = false;
  }
});
