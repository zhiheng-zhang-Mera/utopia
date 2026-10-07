import {randomUUID} from 'node:crypto';
import {normalizeTraceRecord,canonicalEventRecord,METRIC_NAMES} from './schema.mjs';
import {createFileStorage} from './storage.mjs';
export {normalizeTraceRecord,canonicalEventRecord} from './schema.mjs';
export function createTraceCollector({directory,recordLimit=256,byteLimit=2097152,queueLimit=64,clock=Date.now,monotonic=()=>process.hrtime.bigint(),softwareRefs={},sourceStreamRef='canonical-default',storage}={}){
 if(!Number.isInteger(recordLimit)||recordLimit<1||recordLimit>1024||!Number.isInteger(queueLimit)||queueLimit<1||queueLimit>256||!Number.isInteger(byteLimit)||byteLimit<1024||byteLimit>16777216)throw new Error('Invalid bounded trace limits');
 const runId='trace-'+randomUUID(),collectorEpoch='epoch-'+randomUUID();
 const io=storage??createFileStorage(directory,byteLimit);
 let rows=[],queue=[],storageState='LOADING',closed=false,droppedRecords=0,retentionTruncated=false,draining=null,previousSourceSeq=null,previousSourceAt=null;
 const seen=new Set(),failures=[],preload=[];
 const failure=(code)=>{let capturedAt=null;try{capturedAt=new Date(clock()).toISOString();}catch{}failures.push({code:typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code)?code:'COLLECTOR_FAILURE',capturedAt});if(failures.length>16)failures.shift();};
 const loadedState=Promise.resolve().then(()=>io.load()).then(result=>{const loaded=Array.isArray(result)?result:result?.records;if(result?.retentionTruncated===true)retentionTruncated=true;if(!Array.isArray(loaded))throw Object.assign(new Error('Invalid trace storage'),{code:'TRACE_STORAGE_INVALID'});if(loaded.length>recordLimit)retentionTruncated=true;for(const line of loaded.slice(-recordLimit)){const normalized=normalizeTraceRecord(line.raw,line.context);if(JSON.stringify(normalized)!==JSON.stringify(line.normalized))throw Object.assign(new Error('Trace replay mismatch'),{code:'TRACE_REPLAY_MISMATCH'});rows.push(line);seen.add(normalized.eventId);if(line.context.sourceStreamRef===sourceStreamRef&&normalized.sourceSeq!=null){previousSourceSeq=Math.max(previousSourceSeq??0,normalized.sourceSeq??0)||null;if(previousSourceAt==null||Date.parse(normalized.timestamp)>Date.parse(previousSourceAt))previousSourceAt=normalized.timestamp;}}storageState='READY';}).catch(error=>{storageState='FAILED';failure(error?.code??'COLLECTOR_LOAD_FAILED');});
 const ready=loadedState.then(()=>{for(const item of preload.splice(0))record(item.raw,item.capture);});
 function drain(){if(draining)return;draining=ready.then(async()=>{while(queue.length){const line=queue.shift();try{const result=await io.append(JSON.stringify(line)+'\n');if(result?.rotated)retentionTruncated=true;}catch(error){storageState='FAILED';failure(error?.code??'COLLECTOR_WRITE_FAILED');}}}).finally(()=>{draining=null;if(queue.length)drain();});}
 function record(raw,capture){if(closed&&!capture)return false;try{
  if(storageState==='LOADING'){if(preload.length>=queueLimit){droppedRecords++;return false;}const captured={capturedAt:new Date(clock()).toISOString(),monotonicNs:String(monotonic())};normalizeTraceRecord(raw,{runId,collectorEpoch,...captured,softwareRefs});preload.push({raw:JSON.parse(JSON.stringify(raw)),capture:captured});return true;}
  const context={runId,collectorEpoch,sourceStreamRef,capturedAt:capture?.capturedAt??new Date(clock()).toISOString(),monotonicNs:capture?.monotonicNs??String(monotonic()),previousSourceSeq:raw?.sourceSeq==null?null:previousSourceSeq,previousSourceAt:raw?.sourceSeq==null?null:previousSourceAt,duplicate:seen.has(raw?.eventId),softwareRefs};
  const normalized=normalizeTraceRecord(raw,context);const line=JSON.parse(JSON.stringify({raw,context,normalized}));rows.push(line);seen.add(normalized.eventId);
  if(rows.length>recordLimit){const evicted=rows.shift();if(!rows.some(row=>row.normalized.eventId===evicted.normalized.eventId))seen.delete(evicted.normalized.eventId);retentionTruncated=true;}
  if(normalized.sourceSeq!=null)previousSourceSeq=Math.max(previousSourceSeq??0,normalized.sourceSeq);
  if(normalized.sourceSeq!=null&&(previousSourceAt==null||Date.parse(normalized.timestamp)>Date.parse(previousSourceAt)))previousSourceAt=normalized.timestamp;
  if(queue.length>=queueLimit){droppedRecords++;return false;}queue.push(line);drain();return true;
 }catch(error){failure(error?.code??'COLLECTOR_NORMALIZE_FAILED');return false;}}
 function snapshot(){const normalized=rows.map(row=>row.normalized);const partial=storageState!=='READY'||droppedRecords>0||retentionTruncated||failures.length>0||normalized.some(row=>row.annotations.length>0||row.missingFields.length>0);return JSON.parse(JSON.stringify({schemaVersion:1,runId,experimentRunRef:null,experimentRunReason:'NOT_OBSERVABLE: recording run is not an experiment execution run',recording:!closed,storageState,completeness:partial?'PARTIAL':'COMPLETE',droppedRecords,retentionTruncated,counterScope:'CURRENT_COLLECTOR_EPOCH_AND_RETAINED_WINDOW',recordedTypes:[...new Set(normalized.map(row=>row.type))],failures,metricsAvailability:Object.fromEntries(METRIC_NAMES.map(k=>[k,{available:normalized.some(row=>row.metrics[k].value!=null),reason:normalized.some(row=>row.metrics[k].value!=null)?null:'NOT_OBSERVABLE: no retained measurement'}])),records:normalized}));}
 async function flush(timeoutMs=1000){let timer;const bounded=Math.max(1,Math.min(Number(timeoutMs)||1,5000));try{return await Promise.race([ready.then(()=>draining??Promise.resolve()).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),bounded);})]);}finally{clearTimeout(timer);}}
 // ---------------------------------------------------------------------------------------------------------------
 // LOOKUP BY ID, AGAINST THE DURABLE STORE RATHER THAN THE RETAINED WINDOW.
 //
 // The window is a READ CONVENIENCE: `snapshot()` returns the newest `recordLimit` records. A published pointer older
 // than that window is invisible through the snapshot even though its bytes are still on disk, and the difference
 // matters to anyone outside this process. An artifact package publishes exact trace pointers as part of its evidence;
 // a reproduction host holding them could compare NOTHING, be told "0 inconsistencies", and have no way to tell that
 // from having compared everything. Measured, not hypothesised: 206 published pointers, 0 resolvable through the
 // snapshot, 206 of 206 present in the durable files.
 //
 // So this answers about SPECIFIC ids, read-only and bounded, and it never claims the store is complete: it reports
 // what the store held and whether the store itself was truncated.
 //
 // The `trace:` prefix that published pointers carry is stripped here on purpose. It was the exact thing that made a
 // hand check of this store report "0 of 206 present" while the bytes sat in front of it, and a client should not have
 // to know which form a given surface happens to use.
 const TRACE_LOOKUP_LIMIT=1024;
 async function lookup(eventIds,{include='PRESENCE_ONLY'}={}){
  const wanted=[...new Set((Array.isArray(eventIds)?eventIds:[]).map(id=>typeof id==='string'?id.trim().replace(/^trace:/,''):'').filter(Boolean))];
  if(wanted.length===0)throw Object.assign(new Error('trace lookup needs at least one eventId'),{code:'TRACE_LOOKUP_IDS_REQUIRED'});
  if(wanted.length>TRACE_LOOKUP_LIMIT)throw Object.assign(new Error(`trace lookup is bounded to ${TRACE_LOOKUP_LIMIT} ids`),{code:'TRACE_LOOKUP_TOO_MANY_IDS'});
  let loaded;
  try{loaded=await io.load();}
  catch(error){throw Object.assign(new Error('the trace store could not be read'),{code:error?.code==='TRACE_STORAGE_OVERSIZE'?'TRACE_LOOKUP_STORE_OVERSIZE':'TRACE_LOOKUP_STORE_UNREADABLE'});}
  const lines=Array.isArray(loaded)?loaded:(loaded?.records??[]);
  const wantedSet=new Set(wanted),found=new Map();
  for(const line of lines){const id=line?.normalized?.eventId;if(id&&wantedSet.has(id)&&!found.has(id))found.set(id,line.normalized);}
  const present=wanted.filter(id=>found.has(id));
  return {storeScope:'DURABLE_TRACE_FILES',requested:wanted.length,include,
   found:include==='RECORDS'?present.map(id=>({eventId:id,record:found.get(id)})):present,
   absent:wanted.filter(id=>!found.has(id)),
   retainedWindow:{recordLimit,retained:rows.length},
   // An id absent from BOTH is the only absence that means the record is really gone; absent-from-window alone is a
   // read-surface fact, and the two are kept apart so nobody reads one as the other.
   storeTruncated:loaded?.retentionTruncated===true||retentionTruncated,storageState};
 }
 return {runId,record,captureCanonical(event){try{return record(canonicalEventRecord(event));}catch(error){failure(error?.code??'COLLECTOR_CAPTURE_FAILED');return false;}},snapshot,lookup,flush,async close(timeoutMs=100){closed=true;return flush(timeoutMs);}};
}
