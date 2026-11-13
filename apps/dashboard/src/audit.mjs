export const AUDIT_API_URL = "https://veltron-audit-indexer.haideecoded-e0f.workers.dev";

export async function readAuditStatus(fetchImpl = fetch) {
  const response = await fetchImpl(AUDIT_API_URL + "/v1/events?limit=5", {
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error("Audit API returned HTTP " + response.status);
  const payload = await response.json();
  if (payload.network !== "testnet" || payload.contract_id !== "veltron-treasury.testnet") {
    throw new Error("Audit API returned an unexpected network or treasury account.");
  }
  if (!payload.indexing || !Array.isArray(payload.events)) {
    throw new Error("Audit API response is missing its coverage or event data.");
  }
  return {
    network: payload.network,
    coverage: payload.indexing.coverage || "unknown",
    history_complete: payload.indexing.history_complete === true,
    indexed_through: payload.indexing.indexed_through || null,
    note: payload.indexing.note || "",
    events: payload.events.slice(0, 5)
  };
}
