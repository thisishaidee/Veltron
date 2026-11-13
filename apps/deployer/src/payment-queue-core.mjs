export const OWNER = "haideedotxyz.testnet";
export const TREASURY = "veltron-treasury.testnet";
export const RPCS = [
  { name: "NEAR Public RPC", url: "https://rpc.testnet.near.org" },
  { name: "FastNEAR", url: "https://rpc.testnet.fastnear.com" }
];
export const GAS = "30000000000000";
export const SNAPSHOT_MAX_AGE_MS = 30_000;

export function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function formatVtt(raw) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(raw))) throw new Error("Invalid VTT base-unit amount.");
  const value = BigInt(raw);
  const whole = value / 1000000n;
  const fraction = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (fraction ? "." + fraction : "") + " VTT";
}

export function normalizePending(records) {
  if (!Array.isArray(records) || records.length > 512) throw new Error("Pending request view is malformed or exceeds its bound.");
  const queued = [];
  const transfers = [];
  const seen = new Set();
  for (const item of records) {
    if (!item || typeof item !== "object" ||
        typeof item.id !== "string" || !/^(0|[1-9][0-9]*)$/.test(item.id) ||
        typeof item.amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(item.amount) ||
        typeof item.created_at_ns !== "string" || !/^(0|[1-9][0-9]*)$/.test(item.created_at_ns) ||
        BigInt(item.id) > 18446744073709551615n || BigInt(item.created_at_ns) > 18446744073709551615n ||
        BigInt(item.amount) > 340282366920938463463374607431768211455n ||
        !item.kind || typeof item.kind !== "object" || Array.isArray(item.kind)) {
      throw new Error("A pending record has an invalid ID, amount, timestamp, or kind.");
    }
    const id = String(item.id);
    if (seen.has(id)) throw new Error("Duplicate pending request ID.");
    seen.add(id);
    const keys = Object.keys(item.kind);
    if (keys.length !== 1) throw new Error("Pending record kind is ambiguous.");
    const serializedKind = keys[0];
    const kind = ({
      DiscretionaryRequest: "discretionary_request",
      Discretionary: "discretionary",
      CommitmentSettlement: "commitment_settlement"
    })[serializedKind];
    if (!kind) throw new Error("Unknown pending record kind: " + serializedKind);
    const detail = item.kind[serializedKind];
    if (!detail || typeof detail !== "object") throw new Error("Pending record details are malformed.");
    const record = { id, amount: String(item.amount), created_at_ns: String(item.created_at_ns), kind, detail };
    if (kind === "discretionary_request") {
      if (typeof detail.recipient_id !== "string" || !/^[a-z0-9._-]{2,64}$/.test(detail.recipient_id) ||
          !(detail.memo === null || typeof detail.memo === "string")) {
        throw new Error("Queued payment request recipient or memo is malformed.");
      }
      queued.push(record);
    } else if (kind === "discretionary") {
      if (typeof detail.recipient_id !== "string" || !/^[a-z0-9._-]{2,64}$/.test(detail.recipient_id) ||
          !(detail.memo === null || typeof detail.memo === "string")) {
        throw new Error("In-flight discretionary transfer recipient or memo is malformed.");
      }
      transfers.push(record);
    } else if (kind === "commitment_settlement") {
      if (typeof detail.commitment_id !== "string" || detail.commitment_id.length < 1 || detail.commitment_id.length > 64) {
        throw new Error("Commitment settlement record is malformed.");
      }
      transfers.push(record);
    }
  }
  return { queued, transfers };
}

export function actionReadiness({ snapshot, accountId, networkConfirmed, now = Date.now() }) {
  const fresh = Boolean(snapshot && Number.isFinite(snapshot.checkedAt) &&
    now >= snapshot.checkedAt && now - snapshot.checkedAt <= SNAPSHOT_MAX_AGE_MS);
  const verified = Boolean(snapshot?.verified && snapshot?.providersAgree);
  const owner = accountId === OWNER;
  return { fresh, verified, owner, networkConfirmed: networkConfirmed === true,
    canReject: fresh && verified && owner && networkConfirmed,
    canApprove: fresh && verified && owner && networkConfirmed && snapshot?.paused === false };
}

export function paymentCall(methodName, requestId) {
  if (!["approve_payment", "reject_payment"].includes(methodName)) throw new Error("Unsupported payment action.");
  if (!/^(0|[1-9][0-9]*)$/.test(String(requestId)) || BigInt(requestId) > 18446744073709551615n) {
    throw new Error("Request ID must be a valid u64 decimal string.");
  }
  return {
    network: "testnet",
    signerId: OWNER,
    receiverId: TREASURY,
    actions: [{ type: "FunctionCall", params: {
      methodName, args: { request_id: String(requestId) }, gas: GAS, deposit: "0"
    }}]
  };
}

export function uncertainOutcomeMessage() {
  return "OUTCOME UNCERTAIN — the wallet response is not proof of final execution. Refresh finalized state from both providers. Do not retry until the request is confirmed still queued.";
}
