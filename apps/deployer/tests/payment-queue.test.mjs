import test from "node:test";
import assert from "node:assert/strict";
import { actionReadiness, formatVtt, normalizePending, paymentCall, uncertainOutcomeMessage, OWNER, TREASURY } from "../src/payment-queue-core.js";

const request = (id="7", kind="discretionary_request") => ({
  id, amount:"125500000", created_at_ns:"1730000000000000000",
  kind: { [kind]: { recipient_id:"vendor.testnet", memo:"Invoice 42" } }
});

test("formats six-decimal VTT amounts with BigInt", () => {
  assert.equal(formatVtt("125500001"), "125.500001 VTT");
  assert.equal(formatVtt("1000000"), "1 VTT");
  assert.throws(() => formatVtt("1.2"));
});

test("separates queued requests from actual in-flight transfers", () => {
  const result = normalizePending([request("7"), request("8","discretionary"), {
    id:"9",amount:"1000000",created_at_ns:"1730000000000000000",
    kind:{commitment_settlement:{commitment_id:"rent"}}
  }]);
  assert.deepEqual(result.queued.map(x=>x.id),["7"]);
  assert.deepEqual(result.transfers.map(x=>x.id),["8","9"]);
});

test("rejects malformed and duplicate pending records", () => {
  assert.throws(() => normalizePending([{...request(),id:"-1"}]));
  assert.throws(() => normalizePending([request(),request()]),/Duplicate/);
  assert.throws(() => normalizePending([{...request(),kind:{unknown:{}}}]),/Unknown/);
});

test("provider disagreement or an unverified snapshot disables controls", () => {
  const snapshot={verified:true,providersAgree:false,checkedAt:1000,paused:false};
  assert.equal(actionReadiness({snapshot,accountId:OWNER,networkConfirmed:true,now:1001}).canApprove,false);
});

test("stale snapshot, wrong wallet, and missing Testnet confirmation disable controls", () => {
  const snapshot={verified:true,providersAgree:true,checkedAt:1000,paused:false};
  assert.equal(actionReadiness({snapshot,accountId:OWNER,networkConfirmed:true,now:31001}).canApprove,false);
  assert.equal(actionReadiness({snapshot,accountId:"intruder.testnet",networkConfirmed:true,now:1001}).canApprove,false);
  assert.equal(actionReadiness({snapshot,accountId:OWNER,networkConfirmed:false,now:1001}).canApprove,false);
});

test("pause disables approval but does not disable rejection", () => {
  const snapshot={verified:true,providersAgree:true,checkedAt:1000,paused:true};
  const ready=actionReadiness({snapshot,accountId:OWNER,networkConfirmed:true,now:1001});
  assert.equal(ready.canApprove,false);
  assert.equal(ready.canReject,true);
});

test("approve and reject construct exact owner wallet FunctionCalls", () => {
  for (const methodName of ["approve_payment","reject_payment"]) {
    assert.deepEqual(paymentCall(methodName,"42"),{
      network:"testnet",signerId:OWNER,receiverId:TREASURY,
      actions:[{type:"FunctionCall",params:{methodName,args:{request_id:"42"},gas:"30000000000000",deposit:"0"}}]
    });
  }
  assert.throws(()=>paymentCall("approve_payment","-1"));
  assert.throws(()=>paymentCall("transfer","42"));
});

test("uncertain wallet outcome explicitly blocks blind retry", () => {
  assert.match(uncertainOutcomeMessage(),/Do not retry/);
});
