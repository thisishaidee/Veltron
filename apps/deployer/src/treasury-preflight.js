const ACCOUNT="veltron-treasury.testnet";
const EXPECTED_BYTES=338088;
const EXPECTED_SHA256="3ed0cf173950f319fce18fd6f286c899ea264c76d2e1f4fd1411b54ce3455d36";
const RPCS=[
 {name:"FastNEAR",url:"https://rpc.testnet.fastnear.com"},
 {name:"dRPC",url:"https://near-testnet.drpc.org"},
 {name:"NEAR public RPC",url:"https://rpc.testnet.near.org"}
];
const fileInput=document.querySelector("#wasm");
const fileStatus=document.querySelector("#file-status");
const result=document.querySelector("#result");
let verifiedFile=false;
async function rpc(endpoint,method,params){
 const response=await fetch(endpoint.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"veltron-treasury-preflight",method,params})});
 const payload=await response.json();
 if(!response.ok||payload.error||!payload.result)throw new Error(payload.error?.message||"RPC request failed");
 return payload.result;
}
async function read(method,params){
 const errors=[];
 for(const endpoint of RPCS){try{return {value:await rpc(endpoint,method,params),provider:endpoint.name};}catch(e){errors.push(endpoint.name+": "+e.message);}}
 throw new Error(errors.join(" | "));
}
async function sha256(bytes){
 const hash=await crypto.subtle.digest("SHA-256",bytes);
 return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
}
fileInput.addEventListener("change",async()=>{
 verifiedFile=false;fileStatus.textContent="Checking selected file…";
 const file=fileInput.files?.[0];
 if(!file){fileStatus.textContent="No file selected.";return;}
 if(file.size!==EXPECTED_BYTES){fileStatus.textContent="REJECTED — expected "+EXPECTED_BYTES+" bytes; received "+file.size+".";return;}
 try{
  const actual=await sha256(await file.arrayBuffer());
  verifiedFile=actual===EXPECTED_SHA256;
  fileStatus.textContent=(verifiedFile?"MATCH — ":"MISMATCH — ")+actual;
 }catch(e){fileStatus.textContent="Could not hash file in this browser: "+e.message;}
});
document.querySelector("#check").addEventListener("click",async()=>{
 const button=document.querySelector("#check");button.disabled=true;
 result.textContent="Checking Testnet, account, code state, balance, storage and public access-key permissions…";
 try{
  if(!verifiedFile)throw new Error("Select and verify the exact treasury WASM artifact first.");
  const status=await read("status",[]);
  if(status.value.chain_id!=="testnet")throw new Error("RPC did not identify NEAR Testnet.");
  const [account,keys]=await Promise.all([
   read("query",{request_type:"view_account",finality:"final",account_id:ACCOUNT}),
   read("query",{request_type:"view_access_key_list",finality:"final",account_id:ACCOUNT})
  ]);
  let codePresent=false,codeError="";
  try{
   const code=await read("query",{request_type:"view_code",finality:"final",account_id:ACCOUNT});
   codePresent=Boolean(code.value.code_base64);
  }catch(e){codeError=e.message;}
  if(codePresent)throw new Error("STOP: contract code already exists at "+ACCOUNT+". This preflight will not overwrite it.");
  if(!/contract code for contract ID .* has never been observed|contract.*not found|no contract code/i.test(codeError))
   throw new Error("Could not prove that the target has no deployed code: "+codeError);
  const amount=BigInt(account.value.amount);
  const yocto=10n**24n;
  const balance=(amount/yocto).toString()+"."+(amount%yocto).toString().padStart(24,"0").slice(0,6)+" NEAR";
  const keysText=(keys.value.keys||[]).map(k=>k.public_key+" — "+(typeof k.access_key.permission==="string"?k.access_key.permission:JSON.stringify(k.access_key.permission))).join("\n")||"No keys returned";
  result.textContent="READ-ONLY PREFLIGHT PASSED\nNetwork: NEAR Testnet (via "+status.provider+")\nTarget: "+ACCOUNT+"\nAccount balance: "+balance+"\nStorage used: "+account.value.storage_usage+" bytes\nContract code: none observed (via "+codeError.slice(0,100)+")\nRegistered public keys: "+(keys.value.keys||[]).length+"\n"+keysText+"\nWASM: "+EXPECTED_BYTES+" bytes; SHA-256 matches CI artifact.\n\nNo wallet connected. No transaction signed or submitted. This is not deployment approval. A separate live fee/storage calculation and dedicated wallet flow are still required.";
 }catch(e){result.textContent="PREFLIGHT INCOMPLETE — "+e.message+"\nNo transaction was sent and no account permissions were changed.";}
 finally{button.disabled=false;}
});