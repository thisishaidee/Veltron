import { NearConnector } from "@hot-labs/near-connect";

const connectButton = document.querySelector("#connect-wallet");
const status = document.querySelector("#wallet-status");
const account = document.querySelector("#wallet-account");
const network = document.querySelector("#wallet-network");
const rpcNetwork = document.querySelector("#rpc-network");

let connector;

function showStatus(message) {
  status.textContent = message;
}

function resetWalletDetails() {
  account.textContent = "Not connected";
  network.textContent = "Not independently verified";
}

async function verifyRpcNetwork() {
  rpcNetwork.textContent = "Checking configured NEAR RPC…";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch("https://rpc.testnet.near.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-network-check", method: "status", params: [] }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error("RPC request failed");
    const payload = await response.json();
    const chainId = payload?.result?.chain_id;
    rpcNetwork.textContent = chainId === "testnet"
      ? "Testnet verified (VELTRON RPC endpoint)"
      : "Unverified — RPC did not identify NEAR Testnet";
  } catch (error) {
    rpcNetwork.textContent = "Unverified — configured NEAR RPC could not be checked";
    console.error("VELTRON NEAR RPC network check failed", error);
  } finally {
    clearTimeout(timeout);
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
  network.textContent = "Not independently verified";
  showStatus(
    "Wallet connected through a Testnet-configured connector. The wallet's active network has not been independently verified. Do not proceed to transactions or deployment."
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch("https://rpc.testnet.near.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-token-preflight", method, params }),
      signal: controller.signal
    });
    const responseText = await response.text();
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error("RPC returned HTTP " + response.status + " with a non-JSON response.");
    }
    if (!response.ok) {
      throw new Error("RPC HTTP " + response.status + ": " + (payload?.message || payload?.error?.message || "request failed"));
    }
    if (payload.error) {
      const rpcError = payload.error;
      const detail = rpcError.data
        ? " Details: " + (typeof rpcError.data === "string" ? rpcError.data : JSON.stringify(rpcError.data)).slice(0, 500)
        : "";
      throw new Error("RPC error" + (rpcError.code ? " (" + rpcError.code + ")" : "") + ": " +
        (rpcError.message || "request failed") + detail);
    }
    if (!payload.result) throw new Error("RPC response did not contain a result.");
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
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
    const code = await nearRpc("query", {
      request_type: "view_code",
      finality: "final",
      account_id: "veltron-token.testnet"
    });

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
    const cap = (100n * scale).toString();
    const reserve = (200n * scale).toString();
    tokenCheckStatus.textContent =
      "CONTRACT CODE FOUND — ft_metadata responded successfully. This confirms metadata only, not full NEP-141 compliance. Token: " + name +
      " (" + symbol + "), decimals: " + decimals +
      ". Proposed settings: 100 tokens per agent payment = " + cap +
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
