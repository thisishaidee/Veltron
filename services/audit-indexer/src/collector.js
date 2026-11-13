const NETWORKS = {
  testnet: "https://testnet.neardata.xyz",
  mainnet: "https://mainnet.neardata.xyz"
};

function outcomeStatus(status) {
  if (typeof status === "string") {
    if (status === "Unknown") return "UNKNOWN";
    throw new Error("Unexpected NEAR execution status string: " + status);
  }
  if (!status || typeof status !== "object") throw new Error("Missing NEAR execution outcome status");
  const key = Object.keys(status)[0];
  if (key === "SuccessValue") return "SUCCESS_VALUE";
  if (key === "SuccessReceiptId") return "SUCCESS_RECEIPT_ID";
  if (key === "Failure") return "FAILURE";
  if (key === "Unknown") return "UNKNOWN";
  throw new Error("Unsupported NEAR execution outcome status");
}

export function extractContractEvents(block, contractId) {
  if (!block || !Array.isArray(block.shards)) throw new Error("NEAR Data block is missing shard documents");
  const receipts = [];
  for (const shard of block.shards) {
    if (!Array.isArray(shard.receipt_execution_outcomes)) {
      throw new Error("NEAR Data shard is missing receipt_execution_outcomes");
    }
    for (let index = 0; index < shard.receipt_execution_outcomes.length; index++) {
      const item = shard.receipt_execution_outcomes[index];
      const outcome = item?.execution_outcome;
      if (outcome?.outcome?.executor_id !== contractId) continue;
      receipts.push({
        shardId: shard.shard_id,
        sourceIndex: index,
        outcome,
        transactionHash: item.tx_hash
      });
    }
  }
  receipts.sort((a, b) => a.shardId - b.shardId || a.sourceIndex - b.sourceIndex);
  const events = [];
  receipts.forEach((receipt, receiptIndex) => {
    const logs = receipt.outcome?.outcome?.logs;
    if (!Array.isArray(logs)) throw new Error("Contract receipt outcome is missing logs");
    logs.forEach((log, logIndex) => {
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) return;
      if (typeof receipt.transactionHash !== "string" || !receipt.transactionHash) {
        throw new Error("NEAR Data omitted tx_hash for an event-bearing receipt");
      }
      let envelope;
      try { envelope = JSON.parse(log.slice("EVENT_JSON:".length)); }
      catch { throw new Error("Malformed EVENT_JSON log in finalized receipt"); }
      events.push({
        receipt_id: receipt.outcome.id,
        transaction_hash: receipt.transactionHash,
        receipt_index: receiptIndex,
        log_index: logIndex,
        receipt_status: outcomeStatus(receipt.outcome.outcome.status),
        envelope
      });
    });
  });
  return events;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("NEAR Data returned HTTP " + response.status);
  return response.json();
}

export async function runFinalizedIndexer(env) {
  const baseUrl = NETWORKS[env.NETWORK];
  if (!baseUrl) throw new Error("NETWORK must be testnet or mainnet");
  const contractId = env.TREASURY_ACCOUNT;
  if (!contractId) throw new Error("TREASURY_ACCOUNT is required");
  const maxBlocks = Math.max(1, Math.min(30, Number(env.MAX_BLOCKS_PER_TICK || 10)));
  if (!Number.isSafeInteger(maxBlocks)) throw new Error("MAX_BLOCKS_PER_TICK must be an integer");

  const cursor = await env.AUDIT_DB.prepare(
    "SELECT block_height, block_hash FROM indexer_cursors WHERE network = ? AND contract_id = ?"
  ).bind(env.NETWORK, contractId).first();
  const startHeight = cursor
    ? cursor.block_height + 1
    : Number(env.START_BLOCK_HEIGHT);
  if (!Number.isSafeInteger(startHeight) || startHeight < 0) {
    throw new Error("Set START_BLOCK_HEIGHT to the first finalized block at or before treasury deployment");
  }

  const headDocument = await fetchJson(baseUrl + "/v0/last_block/final");
  const headHeight = headDocument?.block?.header?.height;
  if (!Number.isSafeInteger(headHeight)) throw new Error("NEAR Data finalized head response is invalid");

  let indexedBlocks = 0;
  let indexedEvents = 0;
  let lastHeight = cursor?.block_height ?? null;
  for (let height = startHeight; height <= headHeight && indexedBlocks < maxBlocks; height++) {
    const document = await fetchJson(baseUrl + "/v0/block/" + height);
    if (!document || !document.block?.header || document.block.header.height !== height) {
      throw new Error("Finalized block " + height + " is unavailable or mismatched; cursor was not advanced");
    }
    const header = document.block.header;
    const events = extractContractEvents(document, contractId);
    const result = await ingestBlock(env.AUDIT_DB, {
      network: env.NETWORK,
      contractId
    }, {
      network: env.NETWORK,
      contract_id: contractId,
      finalized: true,
      block_height: height,
      block_hash: header.hash,
      prev_block_hash: header.prev_hash,
      block_timestamp_ns: header.timestamp_nanosec,
      events
    });
    indexedBlocks++;
    indexedEvents += result.accepted;
    lastHeight = height;
  }
  return { indexed_blocks: indexedBlocks, indexed_events: indexedEvents, indexed_through: lastHeight, finalized_head: headHeight };
}
