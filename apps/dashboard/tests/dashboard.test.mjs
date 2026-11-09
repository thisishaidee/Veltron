import test from "node:test";
import assert from "node:assert/strict";
import {
  TREASURY_ACCOUNT,
  VIEW_METHODS,
  buildViewRequest,
  decodeViewResult,
  readTreasurySnapshot
} from "../src/dashboard.mjs";

test("dashboard is pinned to the dedicated treasury testnet account", () => {
  assert.equal(TREASURY_ACCOUNT, "veltron-treasury.testnet");
});

test("dashboard exposes only the five approved read-only contract methods", () => {
  assert.deepEqual(VIEW_METHODS, [
    "get_financial_position",
    "get_pause_status",
    "get_commitments",
    "get_pending_transfers",
    "get_token_balance_audit"
  ]);
});

test("view request cannot target a write method or a different account", () => {
  const request = buildViewRequest("get_financial_position");
  assert.equal(request.method, "query");
  assert.equal(request.params.account_id, "veltron-treasury.testnet");
  assert.throws(() => buildViewRequest("set_paused", { paused: true }), /read-only/);
  assert.throws(() => buildViewRequest("request_payment", { amount: "1" }), /read-only/);
});

test("view response bytes decode as JSON", () => {
  const encoded = Array.from(new TextEncoder().encode(JSON.stringify({ spendable_balance: "900" })));
  assert.deepEqual(decodeViewResult(encoded), { spendable_balance: "900" });
});

test("dashboard refuses a non-testnet RPC response", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ result: { chain_id: "mainnet" } })
  });
  await assert.rejects(readTreasurySnapshot(fakeFetch), /expected NEAR testnet/);
});

test("dashboard reports an undeployed treasury without attempting contract calls", async () => {
  let calls = 0;
  const fakeFetch = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (body.method === "status") {
      return { ok: true, json: async () => ({ result: { chain_id: "testnet" } }) };
    }
    return {
      ok: true,
      json: async () => ({
        result: { amount: "1000000000000000000000000", storage_usage: 182, code_hash: "11111111111111111111111111111111" }
      })
    };
  };
  const snapshot = await readTreasurySnapshot(fakeFetch);
  assert.equal(snapshot.deployed, false);
  assert.equal(snapshot.account.storage_usage, 182);
  assert.equal(calls, 2);
});


const largeAmount = "900719925474099312345678901234567890";

function rpcJson(result) {
  return { ok: true, json: async () => ({ result }) };
}

function viewBytes(value) {
  return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}

test("contract fixtures preserve U128 and U64 decimal strings without precision loss", () => {
  const financialPosition = {
    treasury_balance: largeAmount,
    active_commitments: "250000000000000000000000",
    safety_reserve: "100000000000000000000000",
    pending_discretionary: "50000000000000000000000",
    spendable_balance: "500719925474099312345678901234567890"
  };
  const decoded = decodeViewResult(viewBytes(financialPosition));
  assert.equal(decoded.treasury_balance, largeAmount);
  assert.equal(typeof decoded.treasury_balance, "string");
  assert.equal(decoded.spendable_balance, financialPosition.spendable_balance);
});

test("contract fixtures cover empty commitment pages and populated commitment descriptions", () => {
  const emptyPage = decodeViewResult(viewBytes({ commitments: [], next_cursor: null }));
  assert.deepEqual(emptyPage, { commitments: [], next_cursor: null });

  const populatedPage = decodeViewResult(viewBytes({
    commitments: [{
      id: "payroll-november",
      recipient_id: "payroll.testnet",
      amount: largeAmount,
      description: "November payroll",
      settlement_pending: true
    }],
    next_cursor: "payroll-november"
  }));
  assert.equal(populatedPage.commitments[0].description, "November payroll");
  assert.equal(populatedPage.commitments[0].amount, largeAmount);
  assert.equal(populatedPage.commitments[0].settlement_pending, true);
  assert.equal(populatedPage.next_cursor, "payroll-november");
});

test("contract fixtures cover both externally tagged pending transfer variants", () => {
  const pending = decodeViewResult(viewBytes([
    {
      id: "18446744073709551610",
      amount: largeAmount,
      kind: { Discretionary: { recipient_id: "vendor.testnet", memo: "Invoice 204" } },
      created_at_ns: "1794240000000000000"
    },
    {
      id: "18446744073709551611",
      amount: "12500000000000000000000",
      kind: { CommitmentSettlement: { commitment_id: "payroll-november" } },
      created_at_ns: "1794240000000000001"
    }
  ]));
  assert.equal(pending[0].id, "18446744073709551610");
  assert.equal(pending[0].kind.Discretionary.recipient_id, "vendor.testnet");
  assert.equal(pending[0].kind.Discretionary.memo, "Invoice 204");
  assert.equal(pending[1].kind.CommitmentSettlement.commitment_id, "payroll-november");
  assert.equal(typeof pending[1].created_at_ns, "string");
});

test("token audit fixtures cover null and populated optional U128/U64 values", () => {
  const emptyAudit = decodeViewResult(viewBytes({
    audit_pending: false,
    observed_token_balance: null,
    ledger_balance_at_observation: null,
    observed_at_ns: null
  }));
  assert.equal(emptyAudit.observed_token_balance, null);
  assert.equal(emptyAudit.observed_at_ns, null);

  const populatedAudit = decodeViewResult(viewBytes({
    audit_pending: true,
    observed_token_balance: largeAmount,
    ledger_balance_at_observation: "800000000000000000000000000000000000",
    observed_at_ns: "1794240000000000000"
  }));
  assert.equal(populatedAudit.audit_pending, true);
  assert.equal(populatedAudit.observed_token_balance, largeAmount);
  assert.equal(typeof populatedAudit.observed_at_ns, "string");
});

test("deployed treasury snapshot reads all five contract views and preserves their shapes", async () => {
  const fixtures = {
    get_financial_position: {
      treasury_balance: largeAmount,
      active_commitments: "250000000000000000000000",
      safety_reserve: "100000000000000000000000",
      pending_discretionary: "50000000000000000000000",
      spendable_balance: "500719925474099312345678901234567890"
    },
    get_pause_status: true,
    get_commitments: {
      commitments: [{
        id: "payroll-november",
        recipient_id: "payroll.testnet",
        amount: "250000000000000000000000",
        description: "November payroll",
        settlement_pending: false
      }],
      next_cursor: null
    },
    get_pending_transfers: [{
      id: "18446744073709551610",
      amount: largeAmount,
      kind: { Discretionary: { recipient_id: "vendor.testnet", memo: null } },
      created_at_ns: "1794240000000000000"
    }],
    get_token_balance_audit: {
      audit_pending: false,
      observed_token_balance: largeAmount,
      ledger_balance_at_observation: largeAmount,
      observed_at_ns: "1794240000000000000"
    }
  };
  const calledMethods = [];
  const fakeFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "status") {
      return rpcJson({ chain_id: "testnet" });
    }
    if (body.params.request_type === "view_account") {
      return rpcJson({
        amount: "1000000000000000000000000",
        storage_usage: 182,
        code_hash: "deployed-contract-code-hash"
      });
    }
    const methodName = body.params.method_name;
    calledMethods.push(methodName);
    assert.equal(body.params.account_id, TREASURY_ACCOUNT);
    return rpcJson({ result: viewBytes(fixtures[methodName]) });
  };

  const snapshot = await readTreasurySnapshot(fakeFetch);
  assert.equal(snapshot.deployed, true);
  assert.equal(snapshot.network, "testnet");
  assert.deepEqual(new Set(calledMethods), new Set(VIEW_METHODS));
  assert.equal(snapshot.position.treasury_balance, largeAmount);
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.commitments.commitments[0].description, "November payroll");
  assert.equal(snapshot.pending[0].kind.Discretionary.recipient_id, "vendor.testnet");
  assert.equal(snapshot.audit.observed_token_balance, largeAmount);
});
