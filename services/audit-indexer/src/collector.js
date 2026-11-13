import { ingestBlock } from "./storage.js";

const NETWORKS = {
  testnet: {
    history: "https://tx.test.fastnear.com",
    rpc: ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]
  },
  mainnet: {
    history: "https://tx.main.fastnear.com",
    rpc: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"]
  }
};
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_BLOCKS_PER_RANGE = 100;
const MAX_BLOCKS_PER_TICK = 200;
const MAX_ACCOUNT_HISTORY_PAGE = 200;
const MAX_TRANSACTION_BATCH = 20;
// Re-read a rolling window so receipts created shortly before the current cursor
// are still discovered if their execution is finalized in a later block.
const RECEIPT_LOOKBACK_BLOCKS = 10_000;

async function fetchJsonWithRetry(url, init, fetchImpl, label, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchImpl(url, init);
    if (response.ok) return await response.json();
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts - 1) {
      throw new Error(label + " returned HTTP " + response.status);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
  }
  throw new Error(label + " failed after retries");
}

function postJson(body) {
  return {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function getRpcBlockHeader(rpcUrls, params, fetchImpl) {
  const failures = [];
  for (const rpcUrl of rpcUrls) {
    try {
      const document = await fetchJsonWithRetry(rpcUrl, {
        ...postJson({ jsonrpc: "2.0", id: "veltron-audit-indexer", method: "block", params })
      }, fetchImpl, "NEAR RPC block request", 2);
      if (document && document.error || !document || !document.result || !document.result.header) {
        throw new Error("RPC response is missing its finalized block header");
      }
      return document.result.header;
    } catch (error) {
      failures.push(rpcUrl + ": " + String(error.message || error));
    }
  }
  throw new Error("All NEAR RPC block providers failed: " + failures.join("; "));
}

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

function parseEventEnvelope(log) {
  try { return JSON.parse(log.slice("EVENT_JSON:".length)); }
  catch { throw new Error("Malformed EVENT_JSON log in finalized receipt"); }
}

export function extractTransactionEvents(transactions, contractId, minHeight, maxHeight) {
  if (!Array.isArray(transactions)) throw new Error("FastNear transaction response is missing transactions");
  const eventsByBlock = new Map();
  for (const entry of transactions) {
    const transactionHash = entry?.transaction?.hash;
    if (typeof transactionHash !== "string" || !transactionHash) {
      throw new Error("FastNear transaction response omitted transaction.hash");
    }
    if (!Array.isArray(entry.receipts)) throw new Error("FastNear transaction response is missing receipts");
    entry.receipts.forEach((receipt, receiptIndex) => {
      const execution = receipt?.execution_outcome;
      const outcome = execution?.outcome;
      if (outcome?.executor_id !== contractId) return;
      const height = execution.block_height;
      if (!Number.isSafeInteger(height)) throw new Error("FastNear receipt execution omitted a valid block_height");
      if (height < minHeight || height > maxHeight) return;
      if (typeof execution.id !== "string" || !execution.id) {
        throw new Error("FastNear receipt execution omitted its receipt ID");
      }
      if (!Array.isArray(outcome.logs)) throw new Error("FastNear contract receipt outcome is missing logs");
      outcome.logs.forEach((log, logIndex) => {
        if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) return;
        const events = eventsByBlock.get(height) || [];
        events.push({
          receipt_id: execution.id,
          transaction_hash: transactionHash,
          receipt_index: receiptIndex,
          log_index: logIndex,
          receipt_status: outcomeStatus(outcome.status),
          envelope: parseEventEnvelope(log)
        });
        eventsByBlock.set(height, events);
      });
    });
  }
  return eventsByBlock;
}

async function fetchAccountTransactions(historyUrl, contractId, fromHeight, toHeight, fetchImpl) {
  const transactions = [];
  const seenTokens = new Set();
  let resumeToken = null;
  do {
    const body = {
      account_id: contractId,
      is_receiver: true,
      from_tx_block_height: fromHeight,
      to_tx_block_height: toHeight,
      desc: false,
      limit: MAX_ACCOUNT_HISTORY_PAGE
    };
    if (resumeToken) body.resume_token = resumeToken;
    const document = await fetchJsonWithRetry(
      historyUrl + "/v0/account",
      postJson(body),
      fetchImpl,
      "FastNear account history"
    );
    if (!document || !Array.isArray(document.account_txs)) {
      throw new Error("FastNear account history response is missing account_txs");
    }
    transactions.push(...document.account_txs);
    const nextToken = document.resume_token || null;
    if (nextToken && seenTokens.has(nextToken)) throw new Error("FastNear account history repeated a pagination token");
    if (nextToken) seenTokens.add(nextToken);
    resumeToken = nextToken;
    if (transactions.length > 20_000) throw new Error("FastNear account history exceeded the bounded 20,000-row scan limit");
  } while (resumeToken);
  const unique = new Map();
  for (const item of transactions) {
    if (typeof item?.transaction_hash !== "string" || !item.transaction_hash) {
      throw new Error("FastNear account history row omitted transaction_hash");
    }
    unique.set(item.transaction_hash, item);
  }
  return [...unique.values()];
}

async function fetchTransactionDetails(historyUrl, hashes, fetchImpl) {
  const transactions = [];
  for (let offset = 0; offset < hashes.length; offset += MAX_TRANSACTION_BATCH) {
    const batch = hashes.slice(offset, offset + MAX_TRANSACTION_BATCH);
    const document = await fetchJsonWithRetry(
      historyUrl + "/v0/transactions",
      postJson({ tx_hashes: batch }),
      fetchImpl,
      "FastNear transaction batch"
    );
    if (!document || !Array.isArray(document.transactions)) {
      throw new Error("FastNear transaction batch response is missing transactions");
    }
    transactions.push(...document.transactions);
  }
  const returned = new Set();
  for (const entry of transactions) {
    const hash = entry?.transaction?.hash;
    if (typeof hash !== "string" || !hash) throw new Error("FastNear transaction detail omitted transaction.hash");
    returned.add(hash);
  }
  for (const hash of hashes) {
    if (!returned.has(hash)) throw new Error("FastNear transaction detail missing requested hash " + hash);
  }
  return transactions;
}

async function fetchBlockRange(historyUrl, fromHeight, toHeight, fetchImpl) {
  const limit = toHeight - fromHeight;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BLOCKS_PER_RANGE) {
    throw new Error("FastNear block range must contain between 1 and 100 blocks");
  }
  const document = await fetchJsonWithRetry(
    historyUrl + "/v0/blocks",
    postJson({ from_block_height: fromHeight, to_block_height: toHeight, limit, desc: false }),
    fetchImpl,
    "FastNear finalized block range"
  );
  if (!document || !Array.isArray(document.blocks)) throw new Error("FastNear block range response is missing blocks");
  return document.blocks;
}

export async function runFinalizedIndexer(env, fetchImpl = fetch) {
  const network = NETWORKS[env.NETWORK];
  if (!network) throw new Error("NETWORK must be testnet or mainnet");
  const contractId = env.TREASURY_ACCOUNT;
  if (!contractId) throw new Error("TREASURY_ACCOUNT is required");
  const maxBlocks = Math.max(1, Math.min(MAX_BLOCKS_PER_TICK, Number(env.MAX_BLOCKS_PER_TICK || 100)));
  if (!Number.isSafeInteger(maxBlocks)) throw new Error("MAX_BLOCKS_PER_TICK must be an integer");

  const cursor = await env.AUDIT_DB.prepare(
    "SELECT block_height, block_hash, coverage_start_height, finalized_head_height, history_complete FROM indexer_cursors WHERE network = ? AND contract_id = ?"
  ).bind(env.NETWORK, contractId).first();
  const startHeight = cursor ? cursor.block_height + 1 : Number(env.START_BLOCK_HEIGHT);
  if (!Number.isSafeInteger(startHeight) || startHeight < 0) throw new Error("Set START_BLOCK_HEIGHT to the first finalized block at or before treasury deployment");

  const headHeader = await getRpcBlockHeader(network.rpc, { finality: "final" }, fetchImpl);
  const headHeight = headHeader.height;
  if (!Number.isSafeInteger(headHeight)) throw new Error("NEAR RPC finalized head response is invalid");

  const coverageStartHeight = cursor ? cursor.coverage_start_height : startHeight;
  let indexedBlocks = 0, indexedEvents = 0, lastHeight = cursor?.block_height ?? null;
  let historyComplete = cursor?.history_complete === 1;
  let expectedPreviousHash = cursor?.block_hash ?? null;
  if (!cursor && startHeight > 0 && startHeight <= headHeight) {
    const anchorHeader = await getRpcBlockHeader(network.rpc, { block_id: startHeight - 1 }, fetchImpl);
    if (anchorHeader.height !== startHeight - 1 || typeof anchorHeader.hash !== "string" || !anchorHeader.hash) {
      throw new Error("NEAR RPC start-anchor block is unavailable or mismatched; refusing to begin an unanchored history");
    }
    expectedPreviousHash = anchorHeader.hash;
  }

  const historyFromHeight = Math.max(0, startHeight - RECEIPT_LOOKBACK_BLOCKS);
  const accountRows = await fetchAccountTransactions(
    network.history, contractId, historyFromHeight, headHeight + 1, fetchImpl
  );
  const hashes = accountRows.map((row) => row.transaction_hash);
  const transactionDetails = hashes.length
    ? await fetchTransactionDetails(network.history, hashes, fetchImpl)
    : [];
  const eventsByBlock = extractTransactionEvents(transactionDetails, contractId, startHeight, headHeight);

  while (startHeight <= headHeight && indexedBlocks < maxBlocks) {
    const rangeStart = startHeight + indexedBlocks;
    const rangeEnd = Math.min(headHeight + 1, rangeStart + Math.min(MAX_BLOCKS_PER_RANGE, maxBlocks - indexedBlocks));
    const blocks = await fetchBlockRange(network.history, rangeStart, rangeEnd, fetchImpl);
    if (blocks.length !== rangeEnd - rangeStart) {
      throw new Error("FastNear returned an incomplete block range; cursor was not advanced past missing blocks");
    }
    for (const header of blocks) {
      const height = header.block_height;
      if (!Number.isSafeInteger(height) || height !== startHeight + indexedBlocks) {
        throw new Error("FastNear block range returned an unexpected block height");
      }
      if (typeof header.block_hash !== "string" || !header.block_hash ||
          typeof header.prev_block_hash !== "string" || !header.prev_block_hash ||
          !/^\\d+$/.test(String(header.block_timestamp))) {
        throw new Error("FastNear block range omitted a required block header field");
      }
      if (expectedPreviousHash && header.prev_block_hash !== expectedPreviousHash) {
        throw new Error("Finalized block " + height + " does not link to the verified previous block hash; cursor was not advanced");
      }
      const result = await ingestBlock(env.AUDIT_DB, { network: env.NETWORK, contractId }, {
        network: env.NETWORK,
        contract_id: contractId,
        finalized: true,
        block_height: height,
        block_hash: header.block_hash,
        prev_block_hash: header.prev_block_hash,
        block_timestamp_ns: String(header.block_timestamp),
        coverage_start_height: coverageStartHeight,
        finalized_head_height: headHeight,
        events: eventsByBlock.get(height) || []
      });
      expectedPreviousHash = header.block_hash;
      indexedBlocks++;
      indexedEvents += result.accepted;
      lastHeight = height;
      historyComplete = result.history_complete;
    }
  }

  if (cursor && coverageStartHeight > 0 && lastHeight !== null && lastHeight >= headHeight && !historyComplete) {
    await env.AUDIT_DB.prepare("UPDATE indexer_cursors SET finalized_head_height = ?, history_complete = 1, updated_at = CURRENT_TIMESTAMP WHERE network = ? AND contract_id = ?")
      .bind(headHeight, env.NETWORK, contractId).run();
    historyComplete = true;
  }
  return {
    indexed_blocks: indexedBlocks,
    indexed_events: indexedEvents,
    indexed_through: lastHeight,
    finalized_head: headHeight,
    coverage_start_height: coverageStartHeight,
    history_complete: historyComplete,
    account_transactions: accountRows.length
  };
}
