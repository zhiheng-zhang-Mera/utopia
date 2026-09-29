import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {digest} from '../contracts/capability-bridge-v1/protocol.mjs';

// Run once against the existing local runtime, before the new Gateway starts.
// The private backup never enters the delivery set. The report stores metadata only.
const output='.runtime/evidence/v0.3-hardening';mkdirSync(output,{recursive:true});mkdirSync('.runtime/backups',{recursive:true});
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const headers={Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const call=async path=>{const response=await fetch(url+'/api/v0/'+path,{headers,signal:AbortSignal.timeout(4000)});assert.ok(response.ok);return response.json();};
const metadata=row=>Object.fromEntries(['invocationId','capabilityId','operationId','inputClass','inputBytes','startedAt','finishedAt','status','resultDigest','errorCode'].filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));
const beforeDb=new DatabaseSync('.runtime/city.sqlite',{readOnly:true});
const before=beforeDb.prepare('SELECT json FROM invocations ORDER BY rowid').all().map(r=>JSON.parse(r.json));
assert.ok(before.every(r=>r.status!=='RUNNING'),'wait for live work before the migration pilot');
await backup(beforeDb,'.runtime/backups/city-pre-hardening-'+Date.now()+'.sqlite');beforeDb.close();
const cityBefore=await call('city');
const report={startedAt:new Date().toISOString(),codeSha:execFileSync('git',['rev-parse','HEAD']).toString().trim(),legacyRows:before.length,inlineResultRows:before.filter(r=>Object.hasOwn(r,'result')).length,privateBackupCreated:true,checks:[]};
async function restart(){execFileSync('powershell',['-NoProfile','-File','scripts/restart-gateway.ps1'],{windowsHide:true,timeout:30000,stdio:'ignore'});for(let i=0;i<50;i++){try{return await call('city');}catch{await new Promise(r=>setTimeout(r,300));}}throw Error('GATEWAY_RESTART_TIMEOUT');}
try{
 const after=await restart();assert.equal(after.cityId,cityBefore.cityId);
 assert.ok(after.invocations.length<=50);assert.ok(after.invocations.every(r=>!Object.hasOwn(r,'result')));
 const db=new DatabaseSync('.runtime/city.sqlite',{readOnly:true});
 try{
  const summaries=db.prepare('SELECT json FROM invocations ORDER BY rowid').all().map(r=>JSON.parse(r.json));
  assert.equal(summaries.length,Math.min(500,before.length));
  for(const old of before.slice(-500)){const row=summaries.find(r=>r.invocationId===old.invocationId);assert.deepEqual(metadata(row),metadata(old));}
  report.checks.push({name:'legacy-metadata-preserved',pass:true,count:summaries.length});
  const details=db.prepare('SELECT json FROM invocation_details').all().map(r=>JSON.parse(r.json));assert.ok(details.length<=50);
  for(const detail of details)assert.equal(digest(detail.result),summaries.find(r=>r.invocationId===detail.invocationId).resultDigest);
  report.checks.push({name:'retained-detail-digests',pass:true,count:details.length});
  report.summaryCount=summaries.length;report.detailCount=details.length;report.snapshotSummaryBytes=Buffer.byteLength(JSON.stringify(after.invocations));
 }finally{db.close();}
 const again=await restart();assert.deepEqual(again.invocations,after.invocations);assert.equal(again.cityId,after.cityId);
 assert.equal(again.capabilities.filter(c=>c.bridgeState==='AVAILABLE').length,5);
 report.checks.push({name:'idempotent-restart',pass:true},{name:'summary-only-snapshot',pass:true},{name:'five-capabilities-available',pass:true});
 report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.message;process.exitCode=1;}
report.finishedAt=new Date().toISOString();writeFileSync(output+'/runtime-migration.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
