import { NearConnector } from "@hot-labs/near-connect";

const OWNER = "haideedotxyz.testnet";
const TREASURY = "veltron-treasury.testnet";
const TOKEN = "veltron-token.testnet";
const RPC = "https://rpc.testnet.near.org";
const AUDIT_GAS = "30000000000000";
const $ = (id) => document.getElementById(id);

let connector;
let accountId = "";
let preflightPassed = false;
let requestStarted = false;

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "veltron-treasury-audit", method, params })
  });
  if (!response.ok) throw new Error("NEAR Testnet RPC HTTP " + response.status);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "NEAR RPC error");
  return payload.result;
}

async function view(contract, method, args = {}) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(args))));
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: encoded
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

function formatVtt(raw) {
  if (raw === null || raw === undefined) return "Not recorded";
  const value = BigInt(raw);
  const whole = value / 1000000n;
  const fraction = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (fraction ? "." + fraction : "") + " VTT";
}

function setReady(ready) {
  preflightPassed = ready;
  $("request-audit").disabled = !ready;
}

async function readAuditState() {
  const [network, audit, position, tokenBalance] = await Promise.all([
    rpc("status", []),
    view(TREASURY, "get_token_balance_audit"),
    view(TREASURY, "get_financial_position"),
    view(TOKEN, "ft_balance_of", { account_id: TREASURY })
  ]);
  if (network.chain_id !== "testnet") throw new Error("RPC did not identify NEAR Testnet.");
  return { audit, position, tokenBalance };
}

function renderAuditState(state) {
  $("pending").textContent = state.audit.audit_pending ? "Yes — wait; do not submit another request" : "No";
  $("observed-token").textContent = formatVtt(state.audit.observed_token_balance?.[0] ?? state.audit.observed_token_balance);
  $("observed-ledger").textContent = formatVtt(state.audit.ledger_balance_at_observation?.[0] ?? state.audit.ledger_balance_at_observation);
  $("actual-token").textContent = formatVtt(state.tokenBalance);
  $("current-ledger").textContent = formatVtt(state.position.treasury_balance);
  $("observed-at").textContent = state.audit.observed_at_ns?.[0] ?? state.audit.observed_at_ns ?? "Not recorded";
}

async function refreshReadOnly() {
  $("read-status").textContent = "Reading finalized NEAR Testnet state…";
  try {
    const state = await readAuditState();
    renderAuditState(state);
    $("read-status").textContent = "Read-only check complete. No transaction was sent.";
    return state;
  } catch (error) {
    $("read-status").textContent = "READ FAILED — " + String(error.message || error);
    throw error;
  }
}

$("connect").addEventListener("click", async () => {
  $("connect").disabled = true;
  $("wallet-status").textContent = "Opening supported wallet options…";
  try {
    connector = new NearConnector({
      network: "testnet",
      features: { testnet: true },
      footerBranding: null
    });
    connector.on("wallet:signIn", (event) => {
      accountId = event?.accounts?.[0]?.accountId || "";
      $("wallet-account").textContent = accountId || "Wallet did not return an account.";
      $("preflight").disabled = accountId !== OWNER;
      setReady(false);
    });
    connector.on("wallet:signOut", () => {
      accountId = "";
      $("wallet-account").textContent = "Disconnected";
      $("preflight").disabled = true;
      setReady(false);
    });
    await connector.connect();
    if (!accountId) {
      const accounts = await connector.getAccounts?.();
      accountId = accounts?.[0]?.accountId || "";
    }
    $("wallet-account").textContent = accountId || "Connected; account not yet returned.";
    $("preflight").disabled = accountId !== OWNER;
    $("wallet-status").textContent = accountId === OWNER
      ? "Owner account connected. Confirm Testnet in Meteor itself before continuing."
      : "Connected account is not the required owner. No transaction can be requested.";
  } catch (error) {
    $("wallet-status").textContent = "Wallet connection failed — " + String(error.message || error);
    $("preflight").disabled = true;
  } finally {
    $("connect").disabled = false;
  }
});

$("preflight").addEventListener("click", async () => {
  setReady(false);
  $("preflight").disabled = true;
  $("preflight-status").textContent = "Checking owner, Testnet confirmation, and current audit state…";
  try {
    if (accountId !== OWNER) throw new Error("Connect haideedotxyz.testnet first.");
    if (!$("network-confirm").checked) throw new Error("Confirm NEAR Testnet in Meteor itself.");
    const state = await refreshReadOnly();
    if (state.audit.audit_pending) throw new Error("An audit is already pending. Wait and use read-only verification; do not submit another.");
    $("preflight-status").textContent = "PREFLIGHT PASSED — correct owner, Testnet confirmed, no audit currently pending. Review the exact audit request below.";
    setReady(true);
  } catch (error) {
    $("preflight-status").textContent = "STOP — " + String(error.message || error);
  } finally {
    $("preflight").disabled = accountId !== OWNER;
  }
});

$("request-audit").addEventListener("click", async () => {
  if (!preflightPassed || accountId !== OWNER || requestStarted) return;
  requestStarted = true;
  setReady(false);
  $("request-status").textContent = "Opening Meteor for the audit request. Check the transaction details before approving.";
  try {
    const wallet = await connector.wallet();
    await wallet.signAndSendTransaction({
      network: "testnet",
      signerId: OWNER,
      receiverId: TREASURY,
      actions: [{
        type: "FunctionCall",
        params: {
          methodName: "refresh_token_balance_audit",
          args: {},
          gas: AUDIT_GAS,
          deposit: "0"
        }
      }]
    });
    $("request-status").textContent = "Wallet returned. Use the read-only verification button below to confirm the callback completed. Do not submit another request while audit_pending is true.";
  } catch (error) {
    $("request-status").textContent = "Wallet request returned an error or may not have completed: " + String(error.message || error) + ". Check read-only state before considering another request.";
  } finally {
    requestStarted = false;
  }
});

$("verify").addEventListener("click", async () => {
  $("verify").disabled = true;
  try {
    const state = await refreshReadOnly();
    if (state.audit.audit_pending) {
      $("verify-status").textContent = "AUDIT PENDING — callback has not completed. Wait, then check again. Do not submit another request.";
    } else if (state.audit.observed_token_balance !== null && state.audit.observed_token_balance !== undefined) {
      const observed = BigInt(state.audit.observed_token_balance);
      const observedLedger = BigInt(state.audit.ledger_balance_at_observation);
      $("verify-status").textContent = "AUDIT SNAPSHOT RECORDED — observed token balance " + formatVtt(observed) + "; ledger at observation " + formatVtt(observedLedger) + ". This is an observation only; no tokens were moved or reconciled.";
    } else {
      $("verify-status").textContent = "NO AUDIT SNAPSHOT RECORDED YET. If the wallet request was just approved, wait briefly and check again. Do not blindly resubmit.";
    }
  } catch (error) {
    $("verify-status").textContent = "VERIFICATION INCOMPLETE — " + String(error.message || error);
  } finally {
    $("verify").disabled = false;
  }
});

$("read-only").addEventListener("click", async () => {
  $("read-only").disabled = true;
  try {
    await refreshReadOnly();
  } finally {
    $("read-only").disabled = false;
  }
});
