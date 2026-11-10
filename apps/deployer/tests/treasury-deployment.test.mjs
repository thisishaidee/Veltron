import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {
  TREASURY_ACCOUNT, NEW_TREASURY_WASM_BYTES, NEW_TREASURY_WASM_SHA256,
  OLD_TREASURY_WASM_SHA256, calculateTreasuryDeployBudget,
  buildTreasuryDeployAction, requestTreasuryDeploy, base58Decode
} from "../src/treasury-deployment.js";

test("decodes Base58 leading zero bytes without adding an extra byte",()=>{
  assert.deepEqual([...base58Decode("12")],[0,1]);
  assert.deepEqual([...base58Decode("1")],[0]);
  assert.deepEqual([...base58Decode("1112")],[0,0,0,1]);
  assert.throws(()=>base58Decode("0"),/Invalid base58/);
});

test("pins the exact reviewed new and existing treasury artifact identities",()=>{
  assert.equal(TREASURY_ACCOUNT,"veltron-treasury.testnet");
  assert.equal(NEW_TREASURY_WASM_BYTES,338235);
  assert.equal(NEW_TREASURY_WASM_SHA256,"66d3d95d8b4f7142cb47062051a93158994236a3791d83e994946af3dd5525af");
  assert.equal(OLD_TREASURY_WASM_SHA256,"3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36");
});

test("refuses a treasury artifact with the wrong size",()=>{
  assert.throws(()=>buildTreasuryDeployAction(new Uint8Array([1,2,3])),/exact reviewed/);
});

test("constructs exactly one DeployContract action from verified bytes",()=>{
  const bytes=new Uint8Array(NEW_TREASURY_WASM_BYTES);
  const action=buildTreasuryDeployAction(bytes);
  assert.equal(action.type,"DeployContract");
  assert.equal(action.params.code,bytes);
  assert.deepEqual(Object.keys(action.params),["code"]);
});

test("calculates fee, storage reserve and safety margin with integer arithmetic",()=>{
  const result=calculateTreasuryDeployBudget({
    balance:"100000000000000000000000000",
    storageUsage:182,
    wasmBytes:NEW_TREASURY_WASM_BYTES,
    storageAmountPerByte:"10000000000000000000",
    gasPrice:"100000000",minGasPurchasePrice:"100000000",
    costs:{
      deploy:{send_sir:"100",execution:"200"},
      deployPerByte:{send_sir:"2",execution:"3"},
      receipt:{send_sir:"11",execution:"13"}
    }
  });
  assert.equal(result.hasSufficientBalance,true);
  assert.equal(result.safetyMarginYocto,"50000000000000000000000");
  assert.ok(BigInt(result.requiredBalanceYocto)>BigInt(result.storageReserveYocto));
});

test("prices prepaid execution at the NEP-642 minimum gas purchase price when higher",()=>{
  const result=calculateTreasuryDeployBudget({
    balance:"999999999999999999999999999",
    storageUsage:182,wasmBytes:NEW_TREASURY_WASM_BYTES,
    storageAmountPerByte:"10000000000000000000",
    gasPrice:"100",minGasPurchasePrice:"1000",
    costs:{
      deploy:{send_sir:"100",execution:"200"},
      deployPerByte:{send_sir:"2",execution:"3"},
      receipt:{send_sir:"11",execution:"13"}
    }
  });
  assert.equal(result.sendGas,"676581");
  assert.equal(result.executionGas,"1014918");
  assert.equal(result.sendFeeYocto,"67658100");
  assert.equal(result.executionFeeYocto,"1014918000");
  assert.equal(result.feeYocto,"1082576100");
});

test("fails closed when treasury cannot cover storage, fee and margin",()=>{
  const result=calculateTreasuryDeployBudget({
    balance:"100",storageUsage:182,wasmBytes:NEW_TREASURY_WASM_BYTES,
    storageAmountPerByte:"10000000000000000000",gasPrice:"100000000",minGasPurchasePrice:"100000000",
    costs:{deploy:{send_sir:"100",execution:"200"},deployPerByte:{send_sir:"2",execution:"3"},receipt:{send_sir:"11",execution:"13"}}
  });
  assert.equal(result.hasSufficientBalance,false);
});

test("refuses any signer other than veltron-treasury.testnet without calling wallet",async()=>{
  let called=false;
  const wallet={signAndSendTransaction:async()=>{called=true;}};
  await assert.rejects(requestTreasuryDeploy(wallet,"haideedotxyz.testnet",new Uint8Array(NEW_TREASURY_WASM_BYTES)),/signer must be/);
  assert.equal(called,false);
});

test("requests only one DeployContract action to the treasury account",async()=>{
  const bytes=new Uint8Array(NEW_TREASURY_WASM_BYTES);
  let request;
  const wallet={signAndSendTransaction:async value=>{request=value;return "wallet-response";}};
  const result=await requestTreasuryDeploy(wallet,TREASURY_ACCOUNT,bytes);
  assert.equal(result,"wallet-response");
  assert.equal(request.network,undefined);
  assert.equal(request.signerId,TREASURY_ACCOUNT);
  assert.equal(request.receiverId,TREASURY_ACCOUNT);
  assert.equal(request.actions.length,1);
  assert.equal(request.actions[0].type,"DeployContract");
  assert.equal(request.actions[0].params.code,bytes);
});

test("treasury page has no initializer or token-transfer action",()=>{
  const html=readFileSync(new URL("../treasury.html",import.meta.url),"utf8");
  assert.match(html,/veltron-treasury\.testnet/);
  assert.match(html,/one <code>DeployContract<\/code>/);
  assert.doesNotMatch(html,/signAndSendTransaction|ft_transfer|method_name.*new/);
  assert.match(html,/Initialization: excluded/);
});

test("wallet preflight has independent RPC, old-code, initialized-state and new-code gates",()=>{
  const source=readFileSync(new URL("../src/treasury-wallet.js",import.meta.url),"utf8");
  assert.match(source,/OLD_TREASURY_WASM_SHA256/);
  assert.match(source,/NEW_TREASURY_WASM_SHA256/);
  assert.match(source,/get_financial_position/);
  assert.match(source,/get_pending_transfers/);
  assert.match(source,/get_token_balance_audit/);
  assert.match(source,/viewBoth\(TREASURY_ACCOUNT/);
  assert.match(source,/if\(!paused\)/);
  assert.match(source,/pending.length!==0/);
  assert.match(source,/audit.audit_pending/);
  assert.match(source,/Both independent Testnet RPC providers are required/);
  assert.match(source,/WALLET_PROOF_MESSAGE/);
  assert.match(source,/verifyNep413Proof/);
  assert.match(source,/crypto\.subtle\.verify/);
  assert.match(source,/view_access_key/);
  assert.match(source,/permission!==\"FullAccess\"/);
  assert.match(source,/walletOwnershipVerified/);
  assert.match(source,/let deploymentInProgress=false/);
  assert.match(source,/if\(deploymentInProgress\)return/);
  assert.match(source,/deployButton\.disabled=deploymentInProgress\|\|/);
  assert.match(source,/finally\s*\{deploymentInProgress=false;setDeploymentEnabled\(\);\}/);
});
