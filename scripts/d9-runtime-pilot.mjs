import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const config=JSON.parse(fs.readFileSync('.runtime/local-config.json')),{url}=JSON.parse(fs.readFileSync('.runtime/processes.json'));
const headers={Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'};
const call=async(path,input)=>{const r=await fetch(url+'/api/v0/'+path,{headers,...(input?{method:'POST',body:JSON.stringify(input)}:{})});assert.ok(r.ok);return r.json();};
const report={sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Live local Gateway; generated/public refusal inputs and non-destructive restart',refusals:[]};
const packages=()=>fs.readdirSync('.runtime/theme-packages',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort();
try{
 const before=await call('city');const theme=before.capabilities.find(c=>c.capabilityId==='presentation.theme.lab');assert.equal(theme.bridgeState,'AVAILABLE');assert.ok(theme.operations.some(o=>o.operationId==='build'));const builds=before.invocations.filter(r=>r.operationId==='build'&&r.status==='COMPLETED');assert.ok(builds.length>=6);const ids=packages();assert.ok(ids.length<=8);
 for(const [input,errorCode]of [[{outDir:'../escape'},'OUTPUT_PATH_FORBIDDEN'],[{targetSurface:'protected_external_surface'},'PROTECTED_SURFACE'],[{observation:{}},'INVALID_OBSERVATION']]){const row=await call('capabilities/presentation.theme.lab/invoke',{operationId:'build',input:{prompt:'blue research compact no persona',...input}});assert.equal(row.status,'FAILED');assert.equal(row.errorCode,errorCode);report.refusals.push({errorCode,status:row.status,invocationId:row.invocationId,pass:true});}
 assert.deepEqual(packages(),ids);
 execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/restart-gateway.ps1'],{stdio:'ignore',windowsHide:true});let after;
 for(let i=0;i<30;i++){try{after=await call('city');break;}catch{await new Promise(r=>setTimeout(r,300));}}
 assert.ok(after);assert.ok(after.invocations.every(r=>!('result'in r)));for(const old of builds){const row=after.invocations.find(r=>r.invocationId===old.invocationId);assert.equal(row?.status,old.status);assert.equal(row?.resultDigest,old.resultDigest);const detail=await call('capability-invocations/'+old.invocationId);assert.equal(detail.resultDigest,old.resultDigest);assert.equal(detail.result.validation.ok,true);}
 assert.deepEqual(packages(),ids);report.successfulBuildsRetained=builds.length;report.packageDirectoriesRetained=ids.length;report.summaryOnlySnapshot=true;report.detailsPreserved=true;report.status='PASS';
}catch(error){report.status='FAIL';report.error=error.message;process.exitCode=1;}finally{fs.writeFileSync('.runtime/evidence/wave3/runtime-restart-refusals.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,refusals:report.refusals.length,buildsRetained:report.successfulBuildsRetained,error:report.error}));}
