import {mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';import {randomUUID} from 'node:crypto';
export const FAULT_KINDS=['HEARTBEAT_LOSS','PROVIDER_UNAVAILABLE','DELAY_RESULT','DUPLICATE_EVENT'];
const copy=v=>JSON.parse(JSON.stringify(v));
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const operation={HEARTBEAT_LOSS:'heartbeat',PROVIDER_UNAVAILABLE:'claim',DELAY_RESULT:'report',DUPLICATE_EVENT:'trace'};
// Injections are node-scoped request/observation faults. No OS, network or credential operations.
export function createFaultController({dir,node,trace,clock=Date.now}={}){
 // A RECEIPT STORE THE CITY CANNOT CREATE IS DEGRADED, NOT FATAL. This line used to call mkdirSync unguarded, and the
 // controller is constructed during City startup - so one file where `<runtime>/research` belongs threw ENOTDIR here and
 // the City never started. That is the same defect the store-guard family has now repaired four times (the REX-801
 // experiment registry, the capability-bridge theme artifacts, the WBC-604 execution profile and the REX-803 campaign
 // runner), and the read path below was already fixed for finding B1 while the mkdir on this same line was not.
 // Finding B4 of the REX-804 re-verification: it is not hypothetical - merging this branch into current main, which
 // already carries the REX-801 store-guard probe, turns that probe red with exactly this ENOTDIR.
 let storeState='READY',storeReason=null;
 try{mkdirSync(dir,{recursive:true});}catch(error){storeState='UNAVAILABLE';storeReason=String(error?.code??error?.message??'FAULT_STORE_UNAVAILABLE').slice(0,120);}
 const receipts=new Map(),active=new Map(),timers=new Map(),waiters=new Map();const broken=[];let closed=false;
 const persist=row=>{const target=join(dir,row.faultId+'.json');writeFileSync(target+'.tmp',JSON.stringify(row,null,2));renameSync(target+'.tmp',target);};
 // A RECEIPT THIS MODULE CANNOT READ IS REPORTED, NOT FATAL. The first version parsed every matching file unguarded, so
 // one unreadable receipt made the whole City refuse to start (found by the REX-804 opposite-host review, finding B1).
 // The write path is atomic, so a torn write is not the expected cause - an external edit, a disk fault or a foreign
 // tool is - but the consequence must never be a City that will not boot. This follows the pattern the sibling modules
 // already use: the experiment registry reports `broken` files and the trace collector degrades to PARTIAL.
 if(storeState==='READY')for(const name of readdirSync(dir)){
  if(!/^fault-[a-f0-9-]{36}\.json$/.test(name))continue;
  let row=null;
  try{row=JSON.parse(readFileSync(join(dir,name),'utf8'));}catch{broken.push({file:name,reason:'UNREADABLE_RECEIPT'});continue;}
  if(row===null||typeof row!=='object'||typeof row.faultId!=='string'||row.faultId+'.json'!==name||typeof row.status!=='string'){broken.push({file:name,reason:'RECEIPT_SHAPE_MISMATCH'});continue;}
  if(row.status==='ACTIVE'){row.status='INTERRUPTED';row.endedAt=new Date(clock()).toISOString();row.stopReason='PROCESS_RESTART';try{persist(row);}catch{broken.push({file:name,reason:'RECEIPT_REWRITE_FAILED'});}}
  receipts.set(row.faultId,row);
 }
 const get=id=>{const row=receipts.get(id);if(!row)fail('FAULT_NOT_FOUND',404);return copy(row);};
 const save=row=>{try{persist(row);}catch{row.storageFailure='FAULT_RECEIPT_WRITE_FAILED';throw Object.assign(new Error('FAULT_RECEIPT_WRITE_FAILED'),{code:'FAULT_RECEIPT_WRITE_FAILED',status:503});}};
 function stop(id,reason='EMERGENCY_STOP'){
  const row=receipts.get(id);if(!row)fail('FAULT_NOT_FOUND',404);
  if(row.status!=='ACTIVE')return get(id);
  // Remove executable effects and release delayed requests before persistence; a write failure cannot keep a fault live.
  if(active.get(row.nodeId)?.faultId===id)active.delete(row.nodeId);clearTimeout(timers.get(id));timers.delete(id);
  for(const wake of waiters.get(id)??[])wake();waiters.delete(id);
  row.status=reason==='DURATION_EXPIRED'?'EXPIRED':reason==='PROCESS_CLOSE'?'INTERRUPTED':'STOPPED';row.endedAt=new Date(clock()).toISOString();row.stopReason=reason;save(row);return get(id);
 }
 function current(id){const row=active.get(id);if(row&&clock()>=Date.parse(row.expiresAt)){try{stop(row.faultId,'DURATION_EXPIRED');}catch{}return null;}return row;}
 function start(input){
  if(closed)fail('FAULT_CONTROLLER_CLOSED',409);
  const {kind,nodeId,durationMs,confirmation}=input??{};
  if(!FAULT_KINDS.includes(kind)||typeof nodeId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(nodeId)||!Number.isInteger(durationMs)||durationMs<1||durationMs>30000||Object.keys(input).some(k=>!['kind','nodeId','durationMs','confirmation'].includes(k)))fail('INVALID_FAULT');
  if(confirmation!=='FAULT:'+kind+':'+nodeId)fail('FAULT_CONFIRMATION_REQUIRED',403);
  if(!node(nodeId)?.online)fail('FAULT_TARGET_NOT_READY',409);
  if(current(nodeId))fail('FAULT_TARGET_BUSY',409);
  const startTime=clock();const row={schemaVersion:1,faultId:'fault-'+randomUUID(),kind,nodeId,durationMs,confirmed:true,status:'ACTIVE',startedAt:new Date(startTime).toISOString(),expiresAt:new Date(startTime+durationMs).toISOString(),endedAt:null,stopReason:null,scope:'CANONICAL_NODE_REQUEST_OR_RESEARCH_OBSERVATION_ONLY',metrics:{injectedFailureCount:0,duplicateObservationCount:0,delayedReportCount:0,detectionTimeMs:null,recoveryTimeMs:null,missingReasons:{detectionTimeMs:'NOT_MEASURED: observer has not reported canonical failure',recoveryTimeMs:'NOT_MEASURED: restored target operation has not succeeded'}},detectedAt:null,recoveredAt:null};
  save(row);receipts.set(row.faultId,row);active.set(nodeId,row);
  timers.set(row.faultId,setTimeout(()=>{try{stop(row.faultId,'DURATION_EXPIRED');}catch{}},durationMs));return get(row.faultId);
 }
 async function before(op,id){
  const row=current(id);if(!row||operation[row.kind]!==op)return;
  if(row.kind==='DELAY_RESULT'){
   row.metrics.delayedReportCount++;save(row);
   await new Promise(resolve=>{const set=waiters.get(row.faultId)??new Set();waiters.set(row.faultId,set);const finish=()=>{clearTimeout(timer);set.delete(finish);resolve();};const timer=setTimeout(finish,Math.max(0,Date.parse(row.expiresAt)-clock()));set.add(finish);});
  }else{row.metrics.injectedFailureCount++;save(row);fail('FAULT_INJECTED_'+row.kind,503);}
 }
 function success(op,id){
  if(operation[current(id)?.kind]===op)return;
  const row=[...receipts.values()].reverse().find(r=>r.nodeId===id&&operation[r.kind]===op&&r.endedAt&&!r.recoveredAt&&r.status!=='INTERRUPTED'&&(r.metrics.injectedFailureCount>0||r.metrics.delayedReportCount>0));if(!row)return;
  row.recoveredAt=new Date(clock()).toISOString();row.metrics.recoveryTimeMs=Math.max(0,clock()-Date.parse(row.endedAt));delete row.metrics.missingReasons.recoveryTimeMs;try{save(row);}catch{}
 }
 function observeOffline(id){const row=current(id);if(!row||row.kind!=='HEARTBEAT_LOSS'||row.detectedAt||row.metrics.injectedFailureCount===0)return;row.detectedAt=new Date(clock()).toISOString();row.metrics.detectionTimeMs=Math.max(0,clock()-Date.parse(row.startedAt));delete row.metrics.missingReasons.detectionTimeMs;try{save(row);}catch{}}
 function capture(event){
  const ok=trace.captureCanonical(event);const row=current(event.actor);
  if(row?.kind==='DUPLICATE_EVENT'){
   const second=trace.captureCanonical(event);row.metrics.duplicateObservationCount++;row.observationAccepted=ok&&second;try{save(row);}catch{}
  }return ok;
 }
 return {start,stop,get,before,success,observeOffline,capture,storeState:()=>storeState,storeReason:()=>storeReason,list:()=>({faults:[...receipts.values()].slice(-128).map(copy),retentionTruncated:receipts.size>128,broken:copy(broken),storeState,storeReason,kinds:FAULT_KINDS,maxDurationMs:30000,automaticResume:false}),close(){closed=true;for(const row of [...active.values()])try{stop(row.faultId,'PROCESS_CLOSE');}catch{}}};
}
