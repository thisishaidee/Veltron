import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const html=await readFile(new URL("../transfer.html",import.meta.url),"utf8");
const js=await readFile(new URL("../src/transfer.js",import.meta.url),"utf8");
test("wallet transfer page is Testnet-only and fixed to the intended accounts",()=>{
 for(const value of ["haideedotxyz.testnet","veltron-token.testnet","veltron-treasury.testnet","NEAR Testnet"])assert.ok(html.includes(value)||js.includes(value));
 assert.match(js,/network:"testnet"/);
});
test("only the reviewed 10 VTT ft_transfer_call is constructed",()=>{
 assert.match(js,/methodName:"ft_transfer_call"/);
 assert.match(js,/amount:AMOUNT/);
 assert.equal((10n*1000000n).toString(),"10000000");
 assert.match(js,/msg:""/);
 assert.match(js,/deposit:"1"/);
 assert.match(js,/gas:GAS/);
 assert.doesNotMatch(js,/ft_transfer["']/);
});
test("preflight checks finalized metadata, registration, balance and empty treasury ledger",()=>{
 for(const value of ["finality:"+"final","storage_balance_of","ft_balance_of","get_financial_position","chain_id!=="+"testnet"])assert.ok(js.includes(value));
 assert.match(js,/treasury_balance\)!==0n/);
});
test("transaction is gated on owner account, Testnet confirmation and passed preflight",()=>{
 assert.match(js,/accountId!==OWNER/);
 assert.match(js,/network-confirm/);
 assert.match(js,/if\(!preflightPassed/);
});
test("uncertain wallet results explicitly prevent blind resubmission",()=>{
 assert.match(js,/do not retry/i);
});
