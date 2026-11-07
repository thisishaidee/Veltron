import { NearConnector } from "@hot-labs/near-connect";

const connectButton = document.querySelector("#connect-wallet");
const status = document.querySelector("#wallet-status");
const account = document.querySelector("#wallet-account");
const network = document.querySelector("#wallet-network");

let connector;

function showStatus(message) {
  status.textContent = message;
}

async function initializeWalletConnection() {
  connectButton.disabled = true;
  showStatus("Loading supported wallet options…");

  try {
    connector = new NearConnector({
      network: "testnet",
      features: { testnet: true },
      footerBranding: null
    });

    connector.on("wallet:signIn", (event) => {
      const accountId = event?.accounts?.[0]?.accountId;
      if (!accountId) {
        account.textContent = "Unavailable";
        showStatus("Wallet connected, but no account ID was returned.");
        return;
      }

      account.textContent = accountId;
      network.textContent = "NEAR Testnet";
      showStatus("Wallet connected. Read-only mode: no transaction actions are enabled.");
      connectButton.disabled = false;
    });

    connector.on("wallet:signOut", () => {
      account.textContent = "Not connected";
      network.textContent = "Not connected";
      showStatus("Wallet disconnected.");
      connectButton.disabled = false;
    });

    await connector.whenManifestLoaded;
    connectButton.disabled = false;
    showStatus("Ready. Connect a wallet to NEAR Testnet.");
  } catch (error) {
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
    // The wallet:signIn event updates the connected account.
  } catch (error) {
    showStatus("Connection was not completed. You can try again.");
    console.error("VELTRON wallet connection failed", error);
    connectButton.disabled = false;
  }
});

initializeWalletConnection();
