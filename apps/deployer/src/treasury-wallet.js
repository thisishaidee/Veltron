import {NearConnector} from "@hot-labs/near-connect";
import {
  TREASURY_ACCOUNT, NEW_TREASURY_WASM_BYTES, NEW_TREASURY_WASM_SHA256,
  OLD_TREASURY_WASM_SHA256, calculateTreasuryDeployBudget,
  sha256Hex, requestTreasuryDeploy, decodeViewResult, base58Decode
} from "./treasury-deployment.js";

const $ = selector => document.querySelector(selector);
const connectButton=$("#connect-wallet"), walletStatus=$("#wallet-status");
const walletAccount=$("#wallet-account"), walletNetwork=$("#wallet-network"), rpcNetwork=$("#rpc-network");
const artifactInput=$("#treasury-wasm"), artifactStatus=$("#artifact-status");
const confirmButton=$("#confirm-testnet"), confirmationStatus=$("#network-confirmation");
const verifyWalletKeyButton=$("#verify-wallet-key"),verifyWalletKeyStatus=$("#wallet-key-status");
const WALLET_PROOF_MESSAGE="VELTRON treasury upgrade ownership verification — Testnet only. No transaction or contract deployment is authorized.";
const preflightButton=$("#run-preflight"), preflightStatus=$("#preflight-status");
const deployButton=$("#deploy-treasury"), deploymentStatus=$("#deployment-status");
const verifyButton=$("#verify-upgraded-code"), feeReview=$("#fee-review");
const RPCS=[
  {name:"NEAR RPC",url:"https://rpc.testnet.near.org"},
  {name:"FastNEAR",url:"https://rpc.testnet.fastnear.com"}
];
let connector, accountId, networkConfirmed=false, artifactVerified=false, preflightSnapshot=null;
let requestMayHaveBeenSubmitted=false;
let deploymentInProgress=false;
let walletOwnershipVerified=false;
let pendingWalletProofNonce;
let signedMessageEventReceived=false;

async function rpc(endpoint,method,params) {
  const response=await fetch(endpoint.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"veltron-treasury-preflight",method,params})});
  const payload=await response.json();
  if(!response.ok||payload.error) throw new Error(endpoint.name+" "+method+": "+(payload.error?.message||response.statusText));
  return payload.result;
}
async function eachRpc(method,params) {
  const results=[];
  const errors=[];
  for(const endpoint of RPCS) {
    try { results.push({provider:endpoint.name,result:await rpc(endpoint,method,params)}); }
    catch(error) { errors.push(String(error?.message||error)); }
  }
  if(results.length!==2) throw new Error("Both independent Testnet RPC providers are required. "+errors.join(" | "));
  return results;
}
function accountQuery(account) {
  return {request_type:"view_account",finality:"final",account_id:account};
}
function codeQuery(account) {
  return {request_type:"view_code",finality:"final",account_id:account};
}
function formatNear(value) {
  const amount=BigInt(value), unit=10n**24n;
  return (amount/unit).toString()+"."+((amount%unit).toString().padStart(24,"0").slice(0,6))+" NEAR";
}
function setDeploymentEnabled() {
  deployButton.disabled=deploymentInProgress||!(accountId===TREASURY_ACCOUNT&&walletOwnershipVerified&&networkConfirmed&&artifactVerified&&preflightSnapshot);
}

async function verifyNep413Proof(signedMessage,nonce) {
  const publicKeyText=typeof signedMessage?.publicKey==="string"?signedMessage.publicKey:signedMessage?.publicKey?.toString?.();
  if(signedMessage?.accountId!==TREASURY_ACCOUNT||!publicKeyText?.startsWith("ed25519:")||!signedMessage?.signature)throw new Error("Signed message account, Ed25519 key, or signature is missing.");
  const key=base58Decode(publicKeyText.slice(8));
  const sig=typeof signedMessage.signature==="string"&&signedMessage.signature.startsWith("ed25519:")
    ?base58Decode(signedMessage.signature.slice(8))
    :Uint8Array.from(atob(signedMessage.signature),c=>c.charCodeAt(0));
  if(key.length!==32||sig.length!==64||nonce?.length!==32)throw new Error("Invalid NEP-413 key, signature, or nonce length.");
  const enc=new TextEncoder();
  const str=value=>{const bytes=enc.encode(value),length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,bytes.length,true);return[length,bytes];};
  const tag=new Uint8Array(4);new DataView(tag.buffer).setUint32(0,2147484061,true);
  const parts=[tag,...str(WALLET_PROOF_MESSAGE),nonce,...str(window.location.host),new Uint8Array([0])];
  const data=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;
  for(const part of parts){data.set(part,offset);offset+=part.length;}
  const digest=await crypto.subtle.digest("SHA-256",data);
  const imported=await crypto.subtle.importKey("raw",key,{name:"Ed25519"},false,["verify"]);
  if(!await crypto.subtle.verify({name:"Ed25519"},imported,sig,digest))throw new Error("NEP-413 signature is invalid.");
  const access=await eachRpc("query",{request_type:"view_access_key",finality:"final",account_id:TREASURY_ACCOUNT,public_key:publicKeyText});
  for(const item of access){if(item.result?.permission!=="FullAccess")throw new Error(item.provider+" does not report this exact signing key as FullAccess.");}
  return publicKeyText;
}
async function handleSignedMessageEvent(event,nonce) {
  const entry=event?.accounts?.[0],signed=entry?.signedMessage;
  if(entry?.accountId!==TREASURY_ACCOUNT||(signed?.accountId&&signed.accountId!==TREASURY_ACCOUNT)){
    walletOwnershipVerified=false;setDeploymentEnabled();
    verifyWalletKeyStatus.textContent="NOT VERIFIED — wallet did not prove control of "+TREASURY_ACCOUNT+".";
    return;
  }
  try {
    const publicKey=await verifyNep413Proof(signed,nonce);
    if(pendingWalletProofNonce!==nonce||accountId!==TREASURY_ACCOUNT)throw new Error("Wallet account or proof request changed before verification completed.");
    walletOwnershipVerified=true;
    verifyWalletKeyStatus.textContent="OWNERSHIP VERIFIED — valid NEP-413 signature and the exact connected key is FullAccess on both Testnet RPC providers. No transaction was sent. Key: "+publicKey;
  } catch(error) {
    walletOwnershipVerified=false;
    verifyWalletKeyStatus.textContent="NOT VERIFIED — "+String(error?.message||error).slice(0,260)+" No transaction was sent.";
  }
  setDeploymentEnabled();
}
async function verifyArtifact() {
  artifactVerified=false; preflightSnapshot=null; setDeploymentEnabled();
  const file=artifactInput.files?.[0];
  if(!file){artifactStatus.textContent="Select the treasury WASM from the exact successful CI artifact.";return;}
  if(!file.name.endsWith(".wasm")){artifactStatus.textContent="Rejected: select a .wasm file.";return;}
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());
    const hash=await sha256Hex(bytes);
    if(bytes.length!==NEW_TREASURY_WASM_BYTES||hash!==NEW_TREASURY_WASM_SHA256) {
      artifactStatus.textContent="MISMATCH — bytes: "+bytes.length+"; SHA-256: "+hash+". This file cannot be deployed.";
      return;
    }
    artifactVerified=true;
    artifactStatus.textContent="MATCH — exact reviewed CI artifact ("+bytes.length+" bytes; "+hash+").";
  } catch(error) { artifactStatus.textContent="Could not verify file: "+String(error?.message||error); }
  setDeploymentEnabled();
}
artifactInput.addEventListener("change",verifyArtifact);

function initializeWallet() {
  try {
    connector=new NearConnector({network:"testnet",features:{testnet:true,signMessage:true},footerBranding:null});
    connector.on("wallet:signIn",event=>{
      accountId=event?.accounts?.[0]?.accountId;
      walletAccount.textContent=accountId||"No account returned";
      walletNetwork.textContent="Not independently verified — confirm Testnet in Meteor itself";
      walletOwnershipVerified=false;
      verifyWalletKeyButton.disabled=!accountId;
      verifyWalletKeyStatus.textContent="Not verified. Request a harmless signed-message proof to verify the exact connected key.";
      walletStatus.textContent=accountId
        ?"Wallet connected. Connection does not prove the active wallet network. Confirm Testnet inside Meteor before preflight."
        :"Wallet connection returned no account.";
      preflightSnapshot=null;
      if(event?.source==="signInAndSignMessage"||event?.accounts?.[0]?.signedMessage){
        signedMessageEventReceived=true;
        void handleSignedMessageEvent(event,pendingWalletProofNonce);
      }
      setDeploymentEnabled();
    });
    connector.on("wallet:signInAndSignMessage",event=>{signedMessageEventReceived=true;void handleSignedMessageEvent(event,pendingWalletProofNonce);});
    connector.on("wallet:signOut",()=>{
      accountId=undefined; preflightSnapshot=null; networkConfirmed=false;walletOwnershipVerified=false;pendingWalletProofNonce=undefined;verifyWalletKeyButton.disabled=true;
      walletAccount.textContent="Not connected";walletNetwork.textContent="Not independently verified";
      walletStatus.textContent="Wallet disconnected.";confirmButton.disabled=true;preflightButton.disabled=true;setDeploymentEnabled();
    });
    connectButton.disabled=false;connectButton.textContent="Connect NEAR Testnet wallet";
    walletStatus.textContent="Ready. Select Meteor Wallet and connect the treasury account.";
  } catch(error) {
    walletStatus.textContent="Wallet connector failed to initialize: "+String(error?.message||error);
  }
}
verifyWalletKeyButton.addEventListener("click",async()=>{
  if(!connector||accountId!==TREASURY_ACCOUNT){
    verifyWalletKeyStatus.textContent="Connect Meteor as "+TREASURY_ACCOUNT+" first.";
    return;
  }
  verifyWalletKeyButton.disabled=true;
  signedMessageEventReceived=false;
  walletOwnershipVerified=false;
  setDeploymentEnabled();
  verifyWalletKeyStatus.textContent="Requesting a harmless signed message from Meteor. This is not a blockchain transaction.";
  try{
    const nonce=crypto.getRandomValues(new Uint8Array(32));
    pendingWalletProofNonce=nonce;
    const result=await connector.connect({signMessageParams:{message:WALLET_PROOF_MESSAGE,recipient:window.location.host,nonce}});
    if(result?.accounts?.[0]?.signedMessage)await handleSignedMessageEvent(result,nonce);
    else if(!signedMessageEventReceived)verifyWalletKeyStatus.textContent="Wallet returned without a signed-message result. No ownership proof accepted; no transaction was sent.";
  }catch(error){
    verifyWalletKeyStatus.textContent="MESSAGE SIGNING NOT COMPLETED — "+String(error?.message||error).slice(0,240)+". No transaction was requested.";
  }finally{verifyWalletKeyButton.disabled=false;}
});

connectButton.addEventListener("click",async()=>{
  if(!connector)return;
  connectButton.disabled=true;walletStatus.textContent="Opening wallet connection…";
  try { await connector.connect(); }
  catch(error){walletStatus.textContent="Connection not completed: "+String(error?.message||error);connectButton.disabled=false;}
  finally {connectButton.disabled=false;}
});
initializeWallet();

async function checkRpcNetworks() {
  rpcNetwork.textContent="Checking both independent RPC providers…";
  const results=await Promise.all(RPCS.map(async endpoint=>{
    const status=await rpc(endpoint,"status",[]);
    if(status.chain_id!=="testnet")throw new Error(endpoint.name+" is not Testnet.");
    return endpoint.name;
  }));
  rpcNetwork.textContent="Testnet confirmed by "+results.join(" and ")+" (RPC only; wallet network is separate).";
}
confirmButton.disabled=false;
confirmButton.addEventListener("click",()=>{
  networkConfirmed=!networkConfirmed;
  confirmButton.setAttribute("aria-pressed",String(networkConfirmed));
  confirmButton.textContent=networkConfirmed?"Confirmed: Meteor displays Testnet — tap to undo":"Confirm: Meteor itself displays NEAR Testnet";
  confirmationStatus.textContent=networkConfirmed?"You confirmed the network shown inside Meteor. The page still checks RPC chain IDs independently.":"Not confirmed. Check Meteor before continuing.";
  preflightSnapshot=null;setDeploymentEnabled();
});
async function view(endpoint,account,method,args={}) {
  const encoded=btoa(unescape(encodeURIComponent(JSON.stringify(args))));
  return decodeViewResult(await rpc(endpoint,"query",{
    request_type:"call_function",finality:"final",account_id:account,method_name:method,args_base64:encoded
  }));
}
async function viewBoth(account,method,args={}) {
  const values=await Promise.all(RPCS.map(endpoint=>view(endpoint,account,method,args)));
  if(JSON.stringify(values[0])!==JSON.stringify(values[1])) {
    throw new Error("Independent RPC providers disagree on treasury view method "+method+".");
  }
  return values[0];
}
async function runPreflight() {
  preflightButton.disabled=true;deployButton.disabled=true;preflightSnapshot=null;setDeploymentEnabled();
  preflightStatus.textContent="Checking artifact, wallet account, two Testnet RPCs, current code, initialized state and live fee parameters…";
  try {
    if(!artifactVerified)throw new Error("The exact CI treasury WASM has not passed its local hash check.");
    if(accountId!==TREASURY_ACCOUNT)throw new Error("Connect Meteor as "+TREASURY_ACCOUNT+".");
    if(!networkConfirmed)throw new Error("Confirm that Meteor itself displays Testnet.");
    const file=artifactInput.files[0],wasmBytes=new Uint8Array(await file.arrayBuffer());
    const hash=await sha256Hex(wasmBytes);
    if(wasmBytes.length!==NEW_TREASURY_WASM_BYTES||hash!==NEW_TREASURY_WASM_SHA256)throw new Error("Selected artifact changed or no longer matches the recorded hash.");
    const [networkChecks,blocks,accounts,codes,keyLists]=await Promise.all([
      Promise.all(RPCS.map(async endpoint=>{const s=await rpc(endpoint,"status",[]);if(s.chain_id!=="testnet")throw new Error(endpoint.name+" is not Testnet");return s.chain_id;})),
      eachRpc("block",{finality:"final"}),
      eachRpc("query",accountQuery(TREASURY_ACCOUNT)),
      eachRpc("query",codeQuery(TREASURY_ACCOUNT)),
      eachRpc("query",{request_type:"view_access_key_list",finality:"final",account_id:TREASURY_ACCOUNT})
    ]);
    const configs=await eachRpc("EXPERIMENTAL_protocol_config",{block_id:blocks[0].result.header.height});
    const feeShape=item=>({
      protocol_version:item.result.protocol_version,
      storage_amount_per_byte:item.result.runtime_config?.storage_amount_per_byte,
      deploy:item.result.runtime_config?.transaction_costs?.action_creation_config?.deploy_contract_cost,
      deployPerByte:item.result.runtime_config?.transaction_costs?.action_creation_config?.deploy_contract_cost_per_byte,
      receipt:item.result.runtime_config?.transaction_costs?.action_receipt_creation_config,
      minGasPurchasePrice:item.result.runtime_config?.min_gas_purchase_price
    });
    if(JSON.stringify(feeShape(configs[0]))!==JSON.stringify(feeShape(configs[1]))) {
      throw new Error("Independent RPC providers disagree on finalized deployment fee/storage parameters.");
    }
    for(const item of keyLists) {
      const keys=item.result?.keys;
      if(!Array.isArray(keys)||!keys.some(entry=>entry?.access_key?.permission==="FullAccess")) {
        throw new Error(item.provider+" did not confirm a full-access key exists for the treasury account.");
      }
    }
    const oldHashes=codes.map(x=>sha256Hex(Uint8Array.from(atob(x.result.code_base64),c=>c.charCodeAt(0))));
    const computedOldHashes=await Promise.all(oldHashes);
    if(computedOldHashes.some(h=>h!==OLD_TREASURY_WASM_SHA256))throw new Error("STOP: existing treasury code does not match the recorded pre-upgrade hash on both providers. No wallet request will be made.");
    if(computedOldHashes[0]!==computedOldHashes[1])throw new Error("Independent RPCs disagree on the current treasury code.");
    const accountValues=accounts.map(x=>({amount:x.result.amount,storage_usage:x.result.storage_usage,code_hash:x.result.code_hash}));
    if(JSON.stringify(accountValues[0])!==JSON.stringify(accountValues[1]))throw new Error("Independent RPCs disagree on finalized treasury account state.");
    const latestHeight=Math.min(...blocks.map(x=>x.result.header.height));
    const state=await Promise.all([
      viewBoth(TREASURY_ACCOUNT,"get_financial_position"),
      viewBoth(TREASURY_ACCOUNT,"get_pause_status"),
      viewBoth(TREASURY_ACCOUNT,"get_commitments"),
      viewBoth(TREASURY_ACCOUNT,"get_pending_transfers"),
      viewBoth(TREASURY_ACCOUNT,"get_token_balance_audit")
    ]);
    const [position,paused,commitments,pending,audit]=state;
    if(position?.safety_reserve!== "200000000")throw new Error("Existing safety reserve is unexpected: "+JSON.stringify(position));
    for(const field of ["treasury_balance","active_commitments","pending_discretionary","spendable_balance"]) {
      if(!/^\d+$/.test(String(position?.[field]??"")))throw new Error("Existing financial position field is invalid: "+field);
    }
    if(typeof paused!=="boolean"||!Array.isArray(commitments?.commitments)||!Array.isArray(pending)||typeof audit?.audit_pending!=="boolean") {
      throw new Error("Existing treasury state did not pass structural validation.");
    }
    if(!paused) throw new Error("STOP: pause the treasury through its owner-controlled process before a code upgrade.");
    if(pending.length!==0) throw new Error("STOP: pending transfers exist. Wait for them to resolve before upgrading.");
    if(audit.audit_pending) throw new Error("STOP: a token-balance audit callback is pending. Wait for it to finish before upgrading.");
    const config=configs[0].result.runtime_config, block=blocks[0].result;
    const action=config.transaction_costs.action_creation_config,receipt=config.transaction_costs.action_receipt_creation_config;
    const budget=calculateTreasuryDeployBudget({
      balance:accountValues[0].amount,storageUsage:accountValues[0].storage_usage,
      wasmBytes:wasmBytes.length,storageAmountPerByte:config.storage_amount_per_byte,
      gasPrice:block.header.gas_price,
      minGasPurchasePrice:configs[0].result.runtime_config?.min_gas_purchase_price,
      costs:{deploy:action.deploy_contract_cost,deployPerByte:action.deploy_contract_cost_per_byte,receipt}
    });
    if(!budget.hasSufficientBalance)throw new Error("Treasury balance does not cover projected storage reserve, deployment fee and 0.05 NEAR safety margin.");
    preflightSnapshot={hash,wasmBytes,blockHeight:latestHeight,budget,oldHash:computedOldHashes[0],account:accountValues[0],position,paused,commitments,pending,audit};
    feeReview.textContent="NEP-642 estimate — send fee: "+formatNear(budget.sendFeeYocto)+"; prepaid execution fee: "+formatNear(budget.executionFeeYocto)+"; total deployment transaction fee: "+formatNear(budget.feeYocto)+"; projected storage reserve: "+formatNear(budget.storageReserveYocto)+"; additional safety margin: "+formatNear(budget.safetyMarginYocto)+". Existing balance: "+formatNear(accountValues[0].amount)+". This is an estimate, not a wallet quote.";
    preflightStatus.textContent="PASS — both RPCs confirm Testnet and the expected old treasury code; initialized state is readable and structurally valid. Block checked: "+latestHeight+". The new artifact hash matches. No transaction has been sent.";
    verifyButton.disabled=false;
  } catch(error) {
    preflightStatus.textContent="STOP — "+String(error?.message||error)+" No wallet request was made.";
    feeReview.textContent="Fee estimate unavailable until all preflight gates pass.";
  } finally {preflightButton.disabled=false;setDeploymentEnabled();}
}
preflightButton.addEventListener("click",runPreflight);

async function verifyNewCode() {
  const results=await eachRpc("query",codeQuery(TREASURY_ACCOUNT));
  const hashes=await Promise.all(results.map(x=>sha256Hex(Uint8Array.from(atob(x.result.code_base64),c=>c.charCodeAt(0)))));
  if(hashes.some(h=>h!==NEW_TREASURY_WASM_SHA256))throw new Error("New treasury code hash is not yet confirmed by both independent RPC providers.");
  if(hashes[0]!==hashes[1])throw new Error("Independent RPC providers disagree on the upgraded treasury code.");
  return hashes[0];
}
verifyButton.addEventListener("click",async()=>{
  verifyButton.disabled=true;deploymentStatus.textContent="Reading finalized code through both independent RPC providers…";
  try {const hash=await verifyNewCode();deploymentStatus.textContent="UPGRADE CODE VERIFIED — both RPC providers report "+hash+". This confirms code only; existing state must still be re-read. No initialization or token movement occurred.";}
  catch(error){deploymentStatus.textContent="CODE NOT VERIFIED — "+String(error?.message||error)+". Do not initialize or retry deployment until the finalized state is understood.";}
  finally{verifyButton.disabled=false;}
});
deployButton.addEventListener("click",async()=>{
  if(deploymentInProgress)return;
  deploymentInProgress=true;
  deployButton.disabled=true;requestMayHaveBeenSubmitted=false;
  deploymentStatus.textContent="Repeating fresh preflight immediately before opening Meteor…";
  try {
    if(!preflightSnapshot||!artifactVerified||accountId!==TREASURY_ACCOUNT||!networkConfirmed)throw new Error("All gates must pass again before opening the wallet.");
    const previous=preflightSnapshot;
    await runPreflight();
    if(!preflightSnapshot||preflightSnapshot.oldHash!==OLD_TREASURY_WASM_SHA256)throw new Error("Fresh preflight did not pass. No wallet request was made.");
    if(preflightSnapshot.hash!==previous.hash)throw new Error("Artifact changed between review and signing.");
    deploymentStatus.textContent="Fresh checks passed. Meteor will now show one DeployContract action. Inspect network, signer, receiver, action count and absence of deposit before approving.";
    const wallet=await connector.wallet();
    requestMayHaveBeenSubmitted=true;
    const result=await requestTreasuryDeploy(wallet,accountId,preflightSnapshot.wasmBytes);
    deploymentStatus.textContent="Wallet request returned. Verifying finalized code through two independent RPCs…";
    try {
      const hash=await verifyNewCode();
      verifyButton.disabled=false;
      deploymentStatus.textContent="SUCCESS — new treasury code hash verified by both RPC providers: "+hash+". Deployment only. No initializer or transfer was submitted. Existing state still requires a post-upgrade audit.";
    } catch(error) {
      deploymentStatus.textContent="WALLET REQUEST RETURNED, BUT ON-CHAIN VERIFICATION IS PENDING/FAILED — "+String(error?.message||error)+". Do not retry or initialize. Use the read-only verification button later.";
      verifyButton.disabled=false;
    }
  } catch(error) {
    deploymentStatus.textContent=(requestMayHaveBeenSubmitted?"REQUEST STATUS UNCERTAIN — do not retry until on-chain code is checked. ":"PREFLIGHT STOPPED BEFORE WALLET REQUEST — ")+String(error?.message||error);
    verifyButton.disabled=requestMayHaveBeenSubmitted?false:true;
  } finally {deploymentInProgress=false;setDeploymentEnabled();}
});
checkRpcNetworks().catch(error=>{rpcNetwork.textContent="NOT VERIFIED — "+String(error?.message||error);});
