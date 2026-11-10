import { NearConnector } from "@hot-labs/near-connect";

const OWNER="haideedotxyz.testnet";
const TOKEN="veltron-token.testnet";
const TREASURY="veltron-treasury.testnet";
const RPC="https://rpc.testnet.near.org";
const AMOUNT="10000000";
const GAS="100000000000000";
const $=id=>document.getElementById(id);
let connector,accountId,preflightPassed=false,requestStarted=false;

async function rpc(method,params){
 const response=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"veltron-treasury-deposit",method,params})});
 if(!response.ok)throw new Error("NEAR Testnet RPC HTTP "+response.status);
 const payload=await response.json();if(payload.error)throw new Error(payload.error.message||"NEAR RPC error");return payload.result;
}
async function view(contract,method,args){
 const encoded=btoa(unescape(encodeURIComponent(JSON.stringify(args))));
 const result=await rpc("query",{request_type:"call_function",finality:"final",account_id:contract,method_name:method,args_base64:encoded});
 return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}
function fmt(raw){const n=BigInt(raw),whole=n/1000000n,frac=(n%1000000n).toString().padStart(6,"0").replace(/0+$/,"");return whole.toLocaleString("en-US")+(frac?"."+frac:"")+" VTT";}
function setPreflight(enabled){preflightPassed=enabled;$("send").disabled=!enabled;}
async function verifyState(){
 const [owner,treasury,position,metadata]=await Promise.all([
  view(TOKEN,"ft_balance_of",{account_id:OWNER}),
  view(TOKEN,"ft_balance_of",{account_id:TREASURY}),
  view(TREASURY,"get_financial_position",{}),
  view(TOKEN,"ft_metadata",{})
 ]);
 if(metadata.name!=="VELTRON Test Token"||metadata.symbol!=="VTT"||metadata.decimals!==6)throw new Error("Token metadata mismatch; stop.");
 $("owner").textContent=fmt(owner);$("treasury").textContent=fmt(treasury);$("ledger").textContent=fmt(position.treasury_balance);
 return {owner,treasury,position,metadata};
}
async function runPreflight(){
 setPreflight(false);
 if(localStorage.getItem("veltron-vtt-treasury-deposit-attempted")==="true"){$("preflight-status").textContent="STOP — a transfer request was already attempted from this browser. Verify finalized chain state; do not submit a second request.";return;}$("preflight").disabled=true;$("preflight-status").textContent="Reading finalized Testnet state…";
 try{
  if(accountId!==OWNER)throw new Error("Connected signer must be "+OWNER+".");
  if(!$("network-confirm").checked)throw new Error("Confirm Testnet in Meteor itself first.");
  const status=await rpc("status",[]);if(status.chain_id!=="testnet")throw new Error("RPC did not identify NEAR Testnet.");
  const [storage,state]=await Promise.all([
   view(TOKEN,"storage_balance_of",{account_id:TREASURY}),verifyState()
  ]);
  if(!storage||BigInt(storage.total)<1250000000000000000000n)throw new Error("Treasury token storage registration is missing or below minimum.");
  if(BigInt(state.owner)<BigInt(AMOUNT))throw new Error("Owner balance is below 10 VTT.");
  if(BigInt(state.treasury)!==0n||BigInt(state.position.treasury_balance)!==0n)throw new Error("Treasury is not in the expected empty pre-funding state. Stop and inspect.");
  $("preflight-status").textContent="PREFLIGHT PASSED — Testnet, VTT metadata, treasury registration, owner funds and empty treasury ledger verified at finalized state. Review the transaction in Meteor.";
  setPreflight(true);
 }catch(e){$("preflight-status").textContent="STOP — "+String(e.message||e);setPreflight(false);}
 finally{$("preflight").disabled=false;}
}
async function verifyAfter(){
 $("verify").disabled=true;$("verify-status").textContent="Reading finalized balances and ledger…";
 try{
  const s=await verifyState();
  const expected=BigInt(AMOUNT);
  if(BigInt(s.treasury)>=expected&&BigInt(s.position.treasury_balance)>=expected){
   $("verify-status").textContent="DEPOSIT VERIFIED — treasury token balance and internal ledger both reflect at least 10 VTT. Owner balance: "+fmt(s.owner)+".";
  }else{
   $("verify-status").textContent="Current finalized state read successfully, but the 10 VTT deposit is not yet confirmed in both token balance and ledger. Do not retry the transaction; check again later.";
  }
 }catch(e){$("verify-status").textContent="VERIFICATION INCOMPLETE — "+String(e.message||e)+". Do not retry any transaction until state is checked.";}
 finally{$("verify").disabled=false;}
}
$("connect").addEventListener("click",async()=>{
 $("connect").disabled=true;$("account").textContent="Opening wallet connector…";
 try{
  connector=new NearConnector({network:"testnet",features:{testnet:true},footerBranding:null});
  connector.on("wallet:signIn",event=>{
   accountId=event?.accounts?.[0]?.accountId||"";
   $("account").textContent=accountId?"Connected account: "+accountId:"Wallet did not return an account.";
   $("preflight").disabled=accountId!==OWNER;
   setPreflight(false);
  });
  connector.on("wallet:signOut",()=>{accountId="";$("account").textContent="Wallet disconnected."; $("preflight").disabled=true;setPreflight(false);});
  await connector.connect();
  if(!accountId){const accounts=await connector.getAccounts?.();accountId=accounts?.[0]?.accountId||"";}
  $("account").textContent=accountId?"Connected account: "+accountId:"Connection returned; account event not yet received.";
  $("preflight").disabled=accountId!==OWNER;
 }catch(e){$("account").textContent="Connection failed: "+String(e.message||e);$("preflight").disabled=true;}
 finally{$("connect").disabled=false;}
});
$("preflight").addEventListener("click",runPreflight);
$("send").addEventListener("click",async()=>{
 if(!preflightPassed||accountId!==OWNER||!$("network-confirm").checked||requestStarted)return;
 requestStarted=true;localStorage.setItem("veltron-vtt-treasury-deposit-attempted","true");$("send").disabled=true;$("send-status").textContent="Opening Meteor approval. Inspect the exact transaction before approving.";
 try{
  const wallet=await connector.wallet();
  const result=await wallet.signAndSendTransaction({network:"testnet",signerId:OWNER,receiverId:TOKEN,actions:[{type:"FunctionCall",params:{methodName:"ft_transfer_call",args:{receiver_id:TREASURY,amount:AMOUNT,memo:null,msg:""},gas:GAS,deposit:"1"}}]});
  $("send-status").textContent="Wallet returned a transaction response. Checking finalized state. If verification is not conclusive, do not submit again.";
  await verifyAfter();
 }catch(e){
  $("send-status").textContent="Wallet request returned an error or was not completed: "+String(e.message||e)+". Submission status may be uncertain; use read-only verification and do not retry yet.";
 }finally{requestStarted=false;}
});
$("verify").addEventListener("click",verifyAfter);
$("network-confirm").addEventListener("change",()=>{setPreflight(false);$("preflight").disabled=accountId!==OWNER||!$("network-confirm").checked;});
