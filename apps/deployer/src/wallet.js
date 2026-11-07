import { NearConnector } from "@hot-labs/near-connect";

const connectButton = document.querySelector("#connect-wallet");
const status = document.querySelector("#wallet-status");
const account = document.querySelector("#wallet-account");
const network = document.querySelector("#wallet-network");

let connector;

function showStatus(message) {
  status.textContent = message;
}

function resetWalletDetails() {
  account.textContent = "Not connected";
  network.textContent = "Not verified";
}

async function handleWalletSignIn(event) {
  const accountId = event?.accounts?.[0]?.accountId;
  if (!accountId) {
    resetWalletDetails();
    account.textContent = "Unavailable";
    showStatus("Wallet connected, but no account ID was returned.");
    return;
  }

  account.textContent = accountId;
  network.textContent = "Checking wallet-reported network…";
  showStatus("Checking the connected wallet session…");

  try {
    // NEAR Connect exposes the active wallet after the sign-in event.
    // Read its network metadata; never infer the active network from app config.
    const wallet = await connector.wallet();
    const networkId = wallet?.network?.networkId ?? wallet?.networkId;

    if (networkId === "testnet") {
      network.textContent = "Testnet (verified from wallet)";
      showStatus("Wallet connected on NEAR Testnet. Read-only mode: no transaction actions are enabled.");
    } else if (networkId) {
      network.textContent = `Mismatch — ${networkId}`;
      showStatus("Wallet network does not match the required NEAR Testnet. Do not proceed.");
    } else {
      network.textContent = "Unable to verify";
      showStatus("Wallet connected, but its active network could not be verified. Do not proceed.");
    }
  } catch (error) {
    network.textContent = "Unable to verify";
    showStatus("Wallet connected, but network verification failed. Do not proceed.");
    console.error("VELTRON wallet network verification failed", error);
  }

  connectButton.disabled = false;
}

function initializeWalletConnection() {
  connectButton.disabled = true;
  showStatus("Preparing supported wallet options…");
  resetWalletDetails();

  try {
    connector = new NearConnector({
      network: "testnet",
      features: { testnet: true },
      footerBranding: null
    });

    connector.on("wallet:signIn", (event) => {
      void handleWalletSignIn(event);
    });

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
    // The wallet:signIn event updates the connected account and verifies its network.
  } catch (error) {
    showStatus("Connection was not completed. You can try again.");
    console.error("VELTRON wallet connection failed", error);
    connectButton.disabled = false;
  }
});

initializeWalletConnection();
