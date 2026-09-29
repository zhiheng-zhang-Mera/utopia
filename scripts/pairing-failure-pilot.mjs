import assert from 'node:assert/strict';
import { randomBytes,createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createGateway } from '../services/dev-gateway/server.mjs';

// API integration only: no camera, phone, UI, discovery, or live runtime access.
const root=fileURLToPath(new URL('../',import.meta.url));
const scratch=resolve(root,'.runtime/failure-pilot');
const output=resolve(root,'evidence/raw/v0.2/pairing-api-failures.json');
const at=()=>new Date().toISOString();
const sourceFiles=['scripts/pairing-failure-pilot.mjs','services/dev-gateway/server.mjs','services/dev-gateway/pairing.mjs','services/dev-gateway/store.mjs','services/dev-gateway/discovery.mjs','contracts/pairing-v1/descriptor.mjs','contracts/city-control-v0/protocol.mjs','pnpm-lock.yaml'];
const hashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async p=>[p,createHash('sha256').update(await readFile(resolve(root,p))).digest('hex')])));
const apps=[],trials=[];
const abort=new AbortController();
for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>abort.abort());
const evidence={kind:'API_INTEGRATION_PILOT',scope:'Isolated loopback HTTP API negative pairing trials. No Android camera, UI, BLE, or mDNS observations.',codeSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),sourceHashesAtStart:await hashes(),startedAt:at(),defaultSessionTtlMs:300000,fakeClock:false,shortenedTtl:false,discoveryEnabled:false,trials};
async function gateway(){
 const token=randomBytes(32).toString('hex'),nodeToken=randomBytes(32).toString('hex');
 const dir=await mkdtemp(join(scratch,'trial-'));
 const app=await createGateway({host:'127.0.0.1',port:0,dir,token,nodeToken,discoveryEnabled:false});apps.push(app);
 return {app,token,nodeToken};
}
async function request(ctx,path,body,authenticated=false){
 const headers={'X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'};
 if(authenticated)headers.Authorization='Bearer '+ctx.token;
 const start=performance.now();
 const response=await fetch(ctx.app.url+'/api/v0/'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
 const data=await response.json();assert.ok(data.apiVersion===0&&data.schemaVersion===0,'Protocol envelope mismatch');
 return {status:response.status,data,elapsedMs:Math.round((performance.now()-start)*100)/100};
}
async function session(ctx){const r=await request(ctx,'pairing/session',{},true);assert.ok(r.status===200,'Session creation failed');assert.ok(Date.parse(r.data.expiresAt)-Date.parse(r.data.createdAt)===300000,'Default five-minute lifetime changed');return r.data;}
function qr(s){return {cityId:s.descriptor.cityId,sessionId:s.pairingSessionId,method:'qr',secret:new URL(s.qrPayload).searchParams.get('secret')};}
async function reject(ctx,s,mode,index,body,expected,extra={}){
 const submittedAt=at(),r=await request(ctx,'pairing/exchange',body),observedAt=at();
 const wire=JSON.stringify(r.data);
 const noCredentialLeak=!Object.hasOwn(r.data,'credential')&&![ctx.token,ctx.nodeToken,s.shortCode,qr(s).secret].some(value=>value&&wire.includes(value));
 assert.ok(r.status===expected,'Unexpected rejection status');assert.ok(noCredentialLeak,'Rejection disclosed pairing material');
 const info=await request(ctx,'pairing/info'),city=await request(ctx,'city',undefined,true);
 const stableIdentity=info.status===200&&city.status===200&&info.data.cityId===s.descriptor.cityId&&city.data.cityId===s.descriptor.cityId;
 assert.ok(stableIdentity,'City identity changed');
 trials.push({trialId:mode+'-'+index,mode,submittedAt,observedAt,httpStatus:r.status,expectedHttpStatus:expected,requestElapsedMs:r.elapsedMs,noCredentialLeak,stableIdentity,success:true,...extra});
 console.log('Completed '+mode+' '+index+'; HTTP '+r.status);
}
async function expiry(index){
 const ctx=await gateway(),s=await session(ctx),createdAt=s.createdAt,expiresAt=s.expiresAt,waitStart=performance.now();
 const waitMs=Math.max(0,Date.parse(expiresAt)-Date.now())+1500;
 console.log('Started real five-minute expiry trial '+index);
 await delay(waitMs,undefined,{signal:abort.signal});
 assert.ok(Date.now()>Date.parse(expiresAt),'Expiry not reached');
 await reject(ctx,s,'expired-qr',index,qr(s),410,{createdAt,expiresAt,elapsedSinceCreationMs:Date.now()-Date.parse(createdAt),monotonicWaitMs:Math.round(performance.now()-waitStart),independentGateway:true});
}
async function immediate(){
 const ctx=await gateway();
 for(let index=1;index<=2;index++){
  let s=await session(ctx);const wrongCode=String((Number(s.shortCode)+1)%1000000).padStart(6,'0');
  await reject(ctx,s,'wrong-short-code',index,{cityId:s.descriptor.cityId,sessionId:s.pairingSessionId,method:'mdns',shortCode:wrongCode},403);
  s=await session(ctx);await session(ctx);await reject(ctx,s,'replaced-qr',index,qr(s),410);
  s=await session(ctx);const accepted=await request(ctx,'pairing/exchange',qr(s));
  assert.ok(accepted.status===200&&accepted.data.credential===ctx.token&&accepted.data.cityId===s.descriptor.cityId,'Initial QR API exchange failed');
  await reject(ctx,s,'used-qr',index,qr(s),410,{initialExchangeHttpStatus:200});
 }
}
try{
 await mkdir(scratch,{recursive:true});
 const results=await Promise.allSettled([expiry(1),expiry(2),immediate()]);
 assert.ok(results.every(r=>r.status==='fulfilled'),'One or more API failure trials did not complete');
 evidence.status='PASS';
}catch{
 evidence.status=abort.signal.aborted?'INTERRUPTED':'FAIL';process.exitCode=1;
 console.error('Pairing API failure pilot did not complete; inspect sanitized trial counts.');
}finally{
 await Promise.allSettled(apps.map(app=>app.close()));
 evidence.completedAt=at();evidence.sourceHashesAtEnd=await hashes();
 evidence.sourceStable=JSON.stringify(evidence.sourceHashesAtStart)===JSON.stringify(evidence.sourceHashesAtEnd);
 evidence.counts=Object.fromEntries(['expired-qr','wrong-short-code','replaced-qr','used-qr'].map(mode=>[mode,trials.filter(t=>t.mode===mode&&t.success).length]));
 await mkdir(resolve(root,'evidence/raw/v0.2'),{recursive:true});await writeFile(output,JSON.stringify(evidence,null,2)+'\n');
 console.log('Sanitized pairing API failure evidence written; status '+evidence.status);
}
