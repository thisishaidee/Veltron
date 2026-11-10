import { NearConnector } from "@hot-labs/near-connect";
const OWNER="haideedotxyz.testnet", TREASURY="veltron-treasury.testnet";
const INIT_TX="9QuWeKSVogmVyxVNJxrjnFocz94pZjBmMgwByZ4yk71q";
const OLD_HASH="3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36";
const RPCS=[{name:"NEAR RPC",url:"https://rpc.testnet.near.org"},{name:"FastNEAR",url:"https://rpc.testnet.fastnear.com"}];
const $=id=>document.getElementById(id);
let connector,accountId="",proofOK=false,preflightOK=false,snapshot=null,requesting=false,pendingNonce=null;
function status(id,msg){$(id).textContent=msg;}
async function rpc(ep,method,params){
 const r=await fetch(ep.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"veltron-owner-control",method,params})});
 if(!r.ok)throw new Error(ep.name+" HTTP "+r.status);
 const p=await r.json();if(p.error)throw new Error(ep.name+" "+(p.error.message||"RPC error"));return p.result;
}
async function both(method,params){const v=await Promise.all(RPCS.map(e=>rpc(e,method,params)));if(JSON.stringify(v[0])!==JSON.stringify(v[1]))throw new Error("Independent RPCs disagree on "+method);return v[0];}
function decodeView(r){return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));}
async function view(method,args={}){
 const encoded=btoa(unescape(encodeURIComponent(JSON.stringify(args))));
 const vals=await Promise.all(RPCS.map(async e=>decodeView(await rpc(e,"query",{request_type:"call_function",finality:"final",account_id:TREASURY,method_name:method,args_base64:encoded}))));
 if(JSON.stringify(vals[0])!==JSON.stringify(vals[1]))throw new Error("Independent RPCs disagree on view method "+method);
 return vals[0];
}
async function hash(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");}
async function verifyInitOwner(){
 const txs=await Promise.all(RPCS.map(e=>rpc(e,"tx",[INIT_TX,OWNER])));
 const summarize=tx=>{if(tx?.status?.Failure)throw new Error("Treasury initialization transaction failed.");const action=(tx?.transaction?.actions||[]).find(a=>a.FunctionCall?.method_name==="new");if(!action)throw new Error("Recorded initialization transaction does not contain the expected new() call.");const args=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(action.FunctionCall.args),c=>c.charCodeAt(0))));return {owner:args.owner_id,signer:tx.transaction.signer_id,receiver:tx.transaction.receiver_id};};
 const summaries=txs.map(summarize);if(JSON.stringify(summaries[0])!==JSON.stringify(summaries[1]))throw new Error("RPC providers disagree on the original initialization transaction.");
 const result=summaries[0];if(result.owner!==OWNER||result.receiver!==TREASURY)throw new Error("Initialization transaction does not prove the expected treasury owner.");return result;
}
async function runPreflight(){
 preflightOK=false;snapshot=null;$("pause").disabled=true;$("preflight").disabled=true;
 status("preflight-status","Reading finalized Testnet state from both providers…");
 try{
  if(accountId!==OWNER||!proofOK)throw new Error("Connect and verify the exact owner wallet first.");
  if(!$("network-confirm").checked)throw new Error("Confirm Testnet inside Meteor first.");
  const networks=await Promise.all(RPCS.map(async e=>{const s=await rpc(e,"status",[]);if(s.chain_id!=="testnet")throw new Error(e.name+" is not Testnet");return s.chain_id;}));
  const init=await verifyInitOwner();
  if(init.signer!==OWNER)throw new Error("Initialization signer is not the configured owner account.");
  const keyLists=await Promise.all(RPCS.map(e=>rpc(e,"query",{request_type:"view_access_key_list",finality:"final",account_id:OWNER})));
  const keySummary=list=>(list.keys||[]).map(k=>({public_key:k.public_key,permission:k.access_key.permission})).sort((a,b)=>a.public_key.localeCompare(b.public_key));
  if(JSON.stringify(keySummary(keyLists[0]))!==JSON.stringify(keySummary(keyLists[1]))||!keySummary(keyLists[0]).some(k=>k.permission==="FullAccess"&&k.public_key===window.__veltronProofKey))throw new Error("The signed-message key is not a matching FullAccess key on both Testnet providers.");
  const codes=await Promise.all(RPCS.map(e=>rpc(e,"query",{request_type:"view_code",finality:"final",account_id:TREASURY})));
  if(codes[0].code_base64!==codes[1].code_base64)throw new Error("RPC providers disagree on treasury code.");
  const codeHash=await hash(Uint8Array.from(atob(codes[0].code_base64),c=>c.charCodeAt(0)));
  if(codeHash!==OLD_HASH)throw new Error("Treasury code hash differs from the reviewed existing deployment. Stop.");
  const [paused,position,commitments,pending,audit]=await Promise.all([
   view("get_pause_status"),view("get_financial_position"),view("get_commitments"),view("get_pending_transfers"),view("get_token_balance_audit")
  ]);
  if(typeof paused!=="boolean"||!Array.isArray(commitments?.commitments)||!Array.isArray(pending)||typeof audit?.audit_pending!=="boolean")throw new Error("Treasury state response is malformed.");
  if(paused){preflightOK=true;snapshot={paused,position,commitments,pending,audit};status("preflight-status","ALREADY PAUSED — no pause transaction is needed.");}
  else{
   if(pending.length)throw new Error("STOP: pending transfers exist. Do not pause yet.");
   if(audit.audit_pending)throw new Error("STOP: token-balance audit is pending. Do not pause yet.");
   if(commitments.commitments.length)throw new Error("STOP: active commitments exist. Pausing also blocks owner settlement. Resolve or explicitly review commitments before pausing.");
   preflightOK=true;snapshot={paused,position,commitments,pending,audit};
   status("preflight-status","PREFLIGHT PASSED — owner confirmed from the original initialization transaction; both RPCs agree; no active commitments, pending transfers, or pending audit. No transaction has been sent.");
  }
  status("state","Pause status: "+paused+"\nActive commitments: "+commitments.commitments.length+"\nPending transfers: "+pending.length+"\nToken audit pending: "+audit.audit_pending+"\nTreasury ledger balance: "+position.treasury_balance+"\nSafety reserve: "+position.safety_reserve+"\nCode SHA-256: "+codeHash+"\nRPCs: "+networks.join(", "));
  $("pause").disabled=paused||!preflightOK;
  $("verify").disabled=false;
 }catch(e){status("preflight-status","STOP — "+(e.message||String(e))+" No wallet transaction was requested.");}
 finally{$("preflight").disabled=false;}
}
function b58(s){const a="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=0n;for(const c of s){const d=a.indexOf(c);if(d<0)throw Error("Invalid base58");n=n*58n+BigInt(d);}let out=[];while(n){out.unshift(Number(n&255n));n>>=8n;}let z=0;while(z<s.length&&s[z]==="1")z++;return new Uint8Array([...new Array(z).fill(0),...out]);}
async function verifySignedMessage(event,nonce){
 const entry=event?.accounts?.[0],sm=entry?.signedMessage;
 if(entry?.accountId!==OWNER||sm?.accountId!==OWNER||!sm.publicKey?.startsWith("ed25519:")||!sm.signature)throw Error("Wallet did not return an owner signed-message proof.");
 const key=b58(sm.publicKey.slice(8)),sig=sm.signature.startsWith("ed25519:")?b58(sm.signature.slice(8)):Uint8Array.from(atob(sm.signature),c=>c.charCodeAt(0));
 const enc=new TextEncoder(),str=v=>{const b=enc.encode(v),n=new Uint8Array(4);new DataView(n.buffer).setUint32(0,b.length,true);return[n,b];};
 const tag=new Uint8Array(4);new DataView(tag.buffer).setUint32(0,2147484061,true);
 const parts=[tag,...str("VELTRON owner control — harmless Testnet identity proof; no transaction authorized."),nonce,...str(location.host),new Uint8Array([0])];
 const data=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let off=0;for(const p of parts){data.set(p,off);off+=p.length;}
 const digest=await crypto.subtle.digest("SHA-256",data),pub=await crypto.subtle.importKey("raw",key,{name:"Ed25519"},false,["verify"]);
 if(!await crypto.subtle.verify({name:"Ed25519"},pub,sig,digest))throw Error("NEP-413 signature is invalid.");
 const access=await both("query",{request_type:"view_access_key",finality:"final",account_id:OWNER,public_key:sm.publicKey});
 if(access.permission!=="FullAccess")throw Error("Signed key is not FullAccess.");
 window.__veltronProofKey=sm.publicKey;proofOK=true;status("proof","OWNER KEY VERIFIED — valid signed-message proof and FullAccess key. No transaction was sent.");
}
$("connect").addEventListener("click",async()=>{
 $("connect").disabled=true;
 try{
  connector=new NearConnector({network:"testnet",features:{testnet:true,signMessage:true},footerBranding:null});
  connector.on("wallet:signIn",e=>{accountId=e?.accounts?.[0]?.accountId||"";status("wallet",accountId?"Connected account: "+accountId:"No account returned.");$("preflight").disabled=accountId!==OWNER;$("verify-owner").disabled=accountId!==OWNER;});
  connector.on("wallet:signInAndSignMessage",e=>{if(pendingNonce)void verifySignedMessage(e,pendingNonce).catch(err=>status("proof","OWNER PROOF FAILED — "+(err.message||String(err))));});
  connector.on("wallet:signOut",()=>{accountId="";proofOK=false;preflightOK=false;snapshot=null;status("wallet","Disconnected.");$("preflight").disabled=true;$("pause").disabled=true;$("verify-owner").disabled=true;});
  await connector.connect();
  if(!accountId){const a=await connector.getAccounts?.();accountId=a?.[0]?.accountId||"";}
  status("wallet",accountId?"Connected account: "+accountId:"Connection returned without account.");
  $("preflight").disabled=accountId!==OWNER;$("verify-owner").disabled=accountId!==OWNER;
 }catch(e){status("wallet","Connection failed: "+(e.message||String(e)));}
 finally{$("connect").disabled=false;}
});

$("verify-owner").addEventListener("click",async()=>{
 if(!connector||accountId!==OWNER)return;
 $("verify-owner").disabled=true;proofOK=false;preflightOK=false;$("pause").disabled=true;
 try{
  const nonce=crypto.getRandomValues(new Uint8Array(32));pendingNonce=nonce;
  status("proof","Requesting a harmless NEP-413 signed message. This is not a blockchain transaction.");
  const result=await connector.connect({signMessageParams:{message:"VELTRON owner control — harmless Testnet identity proof; no transaction authorized.",recipient:location.host,nonce}});
  if(result?.accounts?.[0]?.signedMessage)await verifySignedMessage(result,nonce);
  else status("proof","Wallet returned without a signed-message result. No ownership proof accepted.");
 }catch(e){status("proof","OWNER PROOF NOT COMPLETED — "+(e.message||String(e))+". No transaction was sent.");}
 finally{$("verify-owner").disabled=accountId!==OWNER;}
});

$("network-confirm").addEventListener("change",()=>{preflightOK=false;snapshot=null;$("pause").disabled=true;});
$("preflight").addEventListener("click",runPreflight);
$("pause").addEventListener("click",async()=>{
 if(!preflightOK||!snapshot||snapshot.paused||accountId!==OWNER||!proofOK||!$("network-confirm").checked||requesting)return;
 requesting=true;$("pause").disabled=true;status("pause-status","Opening Meteor. Inspect the exact method, receiver, signer, arguments, and zero deposit before approving.");
 try{
  const wallet=await connector.wallet();
  await wallet.signAndSendTransaction({network:"testnet",signerId:OWNER,receiverId:TREASURY,actions:[{type:"FunctionCall",params:{methodName:"set_paused",args:{paused:true},gas:"30000000000000",deposit:"0"}}]});
  status("pause-status","Wallet returned a response. Verify finalized pause status with the read-only button. Do not submit again.");
 }catch(e){status("pause-status","Wallet request returned an error or uncertain result: "+(e.message||String(e))+". Do not retry; verify chain state first.");}
 finally{requesting=false;$("verify").disabled=false;}
});
$("verify").addEventListener("click",async()=>{
 $("verify").disabled=true;
 try{const paused=await view("get_pause_status");status("pause-status",paused?"PAUSE VERIFIED — both Testnet RPCs report paused=true. Return to the treasury deployment page and rerun its read-only preflight.":"Not paused yet — both RPCs report paused=false. Do not submit another request until the previous wallet result is understood.");}
 catch(e){status("pause-status","Verification incomplete: "+(e.message||String(e))+". Do not retry a transaction.");}
 finally{$("verify").disabled=false;}
});
