const API = document.querySelector('meta[name="veltron-audit-api"]')?.content?.trim().replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
let cursor = null;
let loading = false;
let filters = {};
let activeNetwork = "testnet";

function text(tag, value, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value == null ? "" : String(value);
  return node;
}
function setStatus(message) { $("results").textContent = message; }
function explorer(path, value) {
  const link = document.createElement("a");
  const explorerHost = activeNetwork === "mainnet" ? "https://nearblocks.io/" : "https://testnet.nearblocks.io/";
  link.href = explorerHost + path + "/" + encodeURIComponent(value);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = value;
  return link;
}
function renderEvent(event) {
  const card = document.createElement("article");
  card.className = "event";
  card.append(text("h3", event.event || "Unknown event"));
  card.append(text("p", "Actor: " + (event.data?.actor_id || "Not recorded"), "meta"));
  card.append(text("p", "Timestamp (ns): " + (event.data?.timestamp_ns || "Not recorded"), "meta"));
  const p = document.createElement("p");
  p.className = "meta";
  p.append(document.createTextNode("Block " + event.provenance.block_height + " · Transaction "));
  p.append(explorer("txns", event.provenance.transaction_hash));
  card.append(p);
  card.append(text("p", "Receipt: " + event.provenance.receipt_id, "meta"));
  card.append(text("p", "Receipt status: " + event.provenance.receipt_status + " · Log index: " + event.provenance.log_index, "meta"));
  card.append(text("pre", JSON.stringify(event.data, null, 2), "payload"));
  return card;
}
function currentFilters() {
  return {
    type: $("type").value,
    actor: $("actor").value.trim(),
    transfer_id: $("transfer").value.trim(),
    commitment_id: $("commitment").value.trim()
  };
}
async function load(reset) {
  if (!API) {
    $("service-status").textContent = "NOT CONFIGURED — deploy the audit-indexer Worker and set the API URL in this page's veltron-audit-api meta tag.";
    setStatus("No API request was made. No historical records are available from this page yet.");
    return;
  }
  if (loading) return;
  loading = true;
  $("more").disabled = true;
  if (reset) {
    cursor = null;
    filters = currentFilters();
    $("events").replaceChildren();
  }
  setStatus("Loading finalized audit events…");
  try {
    const params = new URLSearchParams({ limit: "50" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(API + "/v1/events?" + params.toString(), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Audit API returned HTTP " + response.status);
    const body = await response.json();
    for (const event of body.events || []) $("events").append(renderEvent(event));
    cursor = body.next_cursor || null;
    activeNetwork = body.network === "mainnet" ? "mainnet" : "testnet";
    const index = body.indexing || {};
    $("coverage").textContent = index.history_complete && index.coverage_start_height ? "Complete from block " + index.coverage_start_height : index.coverage_start_height ? "Backfill in progress" : "Awaiting release start block";
    $("watermark").textContent = index.indexed_through?.block_height ?? "No finalized block indexed";
    $("coverage-note").textContent = index.note || "Coverage has not been verified.";
    $("service-status").textContent = "Connected · " + (body.network || "unknown network") + " · " + (body.contract_id || "unknown contract");
    const coverageStatus = index.history_complete ? "All finalized blocks from block " + index.coverage_start_height + " through block " + index.finalized_head_height + " are indexed." : index.coverage_start_height ? "Backfill is still in progress." : "Waiting for the event-emitting release block; historical coverage has not started.";
    setStatus((body.events || []).length + " event(s) loaded. " + coverageStatus);
    $("more").disabled = !cursor;
  } catch (error) {
    setStatus("LOAD FAILED — " + String(error.message || error));
  } finally {
    loading = false;
  }
}
$("apply").addEventListener("click", () => load(true));
$("refresh").addEventListener("click", () => load(true));
$("more").addEventListener("click", () => load(false));
load(true);
