import {refuse} from '../../contracts/capability-bridge-v1/protocol.mjs';

export const MAX_INVOCATION_SUMMARIES=500;
export const MAX_INVOCATION_DETAILS=50;
export const SNAPSHOT_INVOCATIONS=50;
export const MAX_LIST_INVOCATIONS=200;
const fields=['invocationId','capabilityId','operationId','inputClass','inputBytes','startedAt','finishedAt','status','resultDigest','errorCode'];

// All migration and retention changes commit together. A bad legacy row leaves
// the old history intact and prevents the bridge from starting with partial data.
export function createInvocationStore(store){
 const db=store.db;
 function summary(row,available){
  if(!row||typeof row!=='object'||typeof row.invocationId!=='string'||!row.invocationId||!['RUNNING','COMPLETED','FAILED','INTERRUPTED'].includes(row.status))throw Error('Invalid invocation history');
  return {...Object.fromEntries(fields.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]])),resultAvailable:available};
 }
 function write(row){
  const hasResult=Object.hasOwn(row,'result');
  if(hasResult){
   if(row.result!=null)db.prepare('INSERT INTO invocation_details(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(row.invocationId,JSON.stringify({invocationId:row.invocationId,result:row.result}));
   else db.prepare('DELETE FROM invocation_details WHERE id=?').run(row.invocationId);
  }
  const available=!!db.prepare('SELECT 1 FROM invocation_details WHERE id=?').get(row.invocationId);
  const value=summary(row,available);
  db.prepare('INSERT INTO invocations(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(row.invocationId,JSON.stringify(value));
  return value;
 }
 function prune(){
  // Running invocations are limited to two by the bridge and kept ahead of
  // terminal rows even when an older job finishes after many newer jobs.
  db.prepare("DELETE FROM invocations WHERE id NOT IN (SELECT id FROM invocations ORDER BY (json_extract(json,'$.status')='RUNNING') DESC,rowid DESC LIMIT ?)").run(MAX_INVOCATION_SUMMARIES);
  db.exec('DELETE FROM invocation_details WHERE id NOT IN (SELECT id FROM invocations)');
  db.prepare('DELETE FROM invocation_details WHERE id NOT IN (SELECT id FROM invocation_details ORDER BY rowid DESC LIMIT ?)').run(MAX_INVOCATION_DETAILS);
  db.exec("UPDATE invocations SET json=json_set(json,'$.resultAvailable',json('false')) WHERE id NOT IN (SELECT id FROM invocation_details) AND json_extract(json,'$.resultAvailable')=1");
 }
 store.atomic(()=>{
  db.exec('CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS invocation_details(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
  for(const stored of db.prepare('SELECT id,json FROM invocations ORDER BY rowid').iterate()){
   const row=JSON.parse(stored.json);
   if(row.invocationId!==stored.id)throw Error('Invalid invocation identity');
   write(row);
  }
  prune();
 });
 return {
  save:row=>store.atomic(()=>{
   write(row);
   // Recency follows the latest state transition, so a slow job's freshly
   // completed result cannot be evicted merely because it started earlier.
   db.prepare('UPDATE invocations SET rowid=(SELECT coalesce(max(rowid),0)+1 FROM invocations) WHERE id=?').run(row.invocationId);
   prune();
  }),
  list(limit=SNAPSHOT_INVOCATIONS){
   const n=Number(limit);if(!Number.isSafeInteger(n)||n<1)refuse('INVALID_LIMIT');
   return db.prepare('SELECT json FROM (SELECT rowid,json FROM invocations ORDER BY rowid DESC LIMIT ?) ORDER BY rowid').all(Math.min(n,MAX_LIST_INVOCATIONS)).map(r=>JSON.parse(r.json));
  },
  get(id){const stored=db.prepare('SELECT json FROM invocations WHERE id=?').get(id);if(!stored)return null;const detail=db.prepare('SELECT json FROM invocation_details WHERE id=?').get(id);return{...JSON.parse(stored.json),result:detail?JSON.parse(detail.json).result:null};},
 };
}
