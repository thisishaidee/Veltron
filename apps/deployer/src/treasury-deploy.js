import { NearConnector } from "@hot-labs/near-connect";
import { TREASURY_ACCOUNT, TREASURY_WASM_BYTES, TREASURY_WASM_SHA256, calculateTreasuryDeploymentBudget, requestTreasuryDeployContract } from "./treasury-deployment.js";

const RPCS=[{name:"FastNEAR",url:"https://rpc.testnet.fastnear.com"},{name:"dRPC",url:"https://near-testnet.drpc.org"},{name:"NEAR public RPC",url:"https://rpc.testnet.near.org"}];
const $=s=>document.querySelector(s);
let connector,connectedAccount,networkConfirmed=false,fileVerified=false,preflightPassed=false,wasmBytes;
const set=(s,v)=>$(s).textContent=v;
function fmt(v){const n=BigInt(v),u=10n**24n;return (n/u).toString()+"."+(n%u).toString().padStart(24,"0").slice(0,6)+" NEAR";}
async function rpcOne(endpoint,method,params){
 const response=await fetch(endpoint.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"veltron-treasury-deploy",method,params})});
 const payload=await response.json();
 if(!response.ok||payload.error||!payload.result){const e=payload.error||{};const d=e.data?(typeof e.data==="string"?e.data:JSON.stringify(e.data)):e.cause?.info||e.cause?.name||"";throw new Error((e.message||"RPC request failed")+(d?" — "+d:""));}
 return payload.result;
}
async function read(method,params){
 const errors=[];for(const endpoint of RPCS){try{return {value:await rpcOne(endpoint,method,params),provider:endpoint.name};}catch(e){errors.push(endpoint.name+": "+e.message);}}
 throw new Error(errors.join(" | "));
}
async function sha(bytes){const d=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(d),b=>b.toString(16).padStart(2,"0")).join("");}
$("#wasm").addEventListener("change",async()=>{
 fileVerified=false;preflightPassed=false;$("#preflight").disabled=true;$("#deploy").disabled=true;
 const file=$("#wasm").files?.[0];if(!file){set("#file-status","No file selected.");return;}
 try{wasmBytes=new Uint8Array(await file.arrayBuffer());const hash=await sha(wasmBytes);fileVerified=wasmBytes.length===TREASURY_WASM_BYTES&&hash===TREASURY_WASM_SHA256;set("#file-status",(fileVerified?"MATCH — ":"REJECTED — ")+"Size "+wasmBytes.length+" bytes; SHA-256 "+hash);$("#preflight").disabled=!fileVerified||!connectedAccount||!networkConfirmed;}
 catch(e){set("#file-status","File verification failed: "+e.message);}
});
function update(){ $("#preflight").disabled=!(fileVerified&&connectedAccount===TREASURY_ACCOUNT&&networkConfirmed);$("#deploy").disabled=!preflightPassed; }
try{
 connector=new NearConnector({network:"testnet",features:{testnet:true},footerBranding:null});
 connector.on("wallet:signIn",event=>{connectedAccount=event?.accounts?.[0]?.accountId||undefined;set("#account",connectedAccount||"No account returned");set("#wallet-status",connectedAccount===TREASURY_ACCOUNT?"Treasury account selected. Complete Testnet confirmation and preflight.":"Wrong account. Select veltron-treasury.testnet in Meteor.");preflightPassed=false;update();});
 connector.on("wallet:signOut",()=>{connectedAccount=undefined;networkConfirmed=false;preflightPassed=false;set("#account","Not connected");set("#wallet-status","Wallet disconnected.");update();});
 $("#connect").disabled=false;$("#connect").textContent="Connect Meteor / NEAR Testnet wallet";set("#wallet-status","Wallet connector ready.");
}catch(e){set("#wallet-status","Wallet connector failed to initialize: "+e.message);}
$("#connect").addEventListener("click",async()=>{try{await connector.connect();}catch(e){set("#wallet-status","Connection not completed: "+e.message);}});
$("#confirm-network").addEventListener("click",()=>{networkConfirmed=!networkConfirmed;$("#confirm-network").textContent=networkConfirmed?"Testnet confirmed — tap to undo":"Confirm Meteor displays NEAR Testnet";set("#network-status",networkConfirmed?"You confirmed Meteor itself displays NEAR Testnet.":"Not confirmed.");preflightPassed=false;update();});
$("#preflight").addEventListener("click",async()=>{
 $("#preflight").disabled=true;preflightPassed=false;$("#deploy").disabled=true;set("#preflight-status","Checking live Testnet state and deployment budget…");
 try{
  if(!fileVerified||connectedAccount!==TREASURY_ACCOUNT||!networkConfirmed)throw new Error("Required file, treasury account, or Testnet confirmation is missing.");
  const status=await read("status",[]);if(status.value.chain_id!=="testnet")throw new Error("RPC did not confirm Testnet.");
  const block=await read("block",{finality:"final"});
  const config=await read("EXPERIMENTAL_protocol_config",{block_id:block.value.header.height});
  const account=await read("query",{request_type:"view_account",finality:"final",account_id:TREASURY_ACCOUNT});
  if(!account.value||!account.value.amount||account.value.storage_usage===undefined)throw new Error("Treasury account response incomplete.");
  const keys=await read("query",{request_type:"view_access_key_list",finality:"final",account_id:TREASURY_ACCOUNT});
  if(!keys.value.keys?.some(k=>k.access_key?.permission==="FullAccess"))throw new Error("No FullAccess public key found for treasury account.");
  let codeError="",codePresent=false;
  try{const code=await read("query",{request_type:"view_code",finality:"final",account_id:TREASURY_ACCOUNT});codePresent=Boolean(code.value.code_base64);}
  catch(e){codeError=e.message;}
  if(codePresent)throw new Error("STOP: treasury account already has contract code; refusing overwrite.");
  if(!/contract code for contract ID .* has never been observed|no contract code|NO_CONTRACT_CODE/i.test(codeError))throw new Error("Could not prove target has no deployed code: "+codeError);
  const rt=config.value.runtime_config,cost=rt?.transaction_costs,ac=cost?.action_creation_config,rc=cost?.action_receipt_creation_config;
  if(!rt?.storage_amount_per_byte||!ac?.deploy_contract_cost||!ac?.deploy_contract_cost_per_byte||!rc?.send_sir||!rc?.execution||!block.value.header.gas_price)throw new Error("Live protocol fee/storage configuration incomplete.");
  const budget=calculateTreasuryDeploymentBudget({accountBalance:account.value.amount,storageUsage:account.value.storage_usage,wasmBytes:TREASURY_WASM_BYTES,storageAmountPerByte:rt.storage_amount_per_byte,gasPrice:block.value.header.gas_price,costs:{deployContract:ac.deploy_contract_cost,deployContractPerByte:ac.deploy_contract_cost_per_byte,receipt:rc}});
  if(!budget.hasSufficientBalance)throw new Error("Insufficient treasury NEAR balance. Required "+fmt(budget.requiredBalanceYocto)+", available "+fmt(account.value.amount)+".");
  preflightPassed=true;
  set("#preflight-status","READ-ONLY PREFLIGHT PASSED\nNetwork: Testnet via "+status.provider+"\nFinalized block: "+block.value.header.height+"\nTreasury: "+TREASURY_ACCOUNT+"\nBalance: "+fmt(account.value.amount)+"\nStorage used: "+account.value.storage_usage+" bytes\nCode: none observed\nFullAccess key: present\nWASM: "+TREASURY_WASM_BYTES+" bytes; SHA-256 matches CI artifact\nModeled fee: "+fmt(budget.feeYocto)+"\nProjected storage reserve: "+fmt(budget.storageReserveYocto)+"\nSafety margin: "+fmt(budget.safetyMarginYocto)+"\nRequired balance: "+fmt(budget.requiredBalanceYocto)+"\nProvider: "+status.provider+"\nNo transaction requested.");
 }catch(e){set("#preflight-status","PREFLIGHT BLOCKED — "+e.message+"\nNo transaction requested.");}
 finally{update();}
});
$("#deploy").addEventListener("click",async()=>{
 $("#deploy").disabled=true;set("#deploy-status","Repeating critical checks immediately before wallet request…");
 try{
  if(!preflightPassed||!fileVerified||connectedAccount!==TREASURY_ACCOUNT||!networkConfirmed)throw new Error("Preflight state expired or required gate changed. Run preflight again.");
  const status=await read("status",[]);if(status.value.chain_id!=="testnet")throw new Error("Testnet not confirmed by RPC.");
  const code=await read("query",{request_type:"view_code",finality:"final",account_id:TREASURY_ACCOUNT});
  if(code.value.code_base64)throw new Error("Contract code now exists. Refusing deployment.");
  const latestHash=await sha(wasmBytes);if(latestHash!==TREASURY_WASM_SHA256)throw new Error("WASM changed after verification.");
  const wallet=await connector.wallet();
  set("#deploy-status","Opening Meteor. Review carefully: Testnet; signer and receiver veltron-treasury.testnet; exactly one DeployContract action; no initialization, deposit, or transfer. Approve only if every detail matches.");
  const result=await requestTreasuryDeployContract(wallet,connectedAccount,wasmBytes);
  set("#deploy-status","Wallet returned a result. Checking finalized deployed code hash…");
  let verified=false,lastError;
  for(let i=0;i<3;i++){try{const deployed=await read("query",{request_type:"view_code",finality:"final",account_id:TREASURY_ACCOUNT});if(!deployed.value.code_base64)throw new Error("No finalized code visible yet.");const bytes=Uint8Array.from(atob(deployed.value.code_base64),c=>c.charCodeAt(0));const hash=await sha(bytes);if(hash!==TREASURY_WASM_SHA256)throw new Error("On-chain hash mismatch: "+hash);verified=true;set("#deploy-status","DEPLOYED CODE HASH VERIFIED — "+hash+" ("+bytes.length+" bytes). Code identity verified only. Contract is NOT initialized. Stop here.");break;}catch(e){lastError=e;}}
  if(!verified)set("#deploy-status","Wallet request returned"+(result?" a response":"")+", but finalized code verification is incomplete: "+lastError.message+". Do not initialize; retry read-only verification later.");
 }catch(e){set("#deploy-status","Deployment request stopped: "+e.message+". No further action taken.");}
});
