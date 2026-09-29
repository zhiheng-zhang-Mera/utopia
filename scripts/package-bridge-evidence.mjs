import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='evidence/raw/v0.3';mkdirSync(root,{recursive:true});
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const snapshot=await(await fetch(url+'/api/v0/city',{headers:{Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'}})).json();
const finalWindows=JSON.parse(readFileSync('.runtime/v03/windows/runs.json'));
const sources=[['windows/runs.json','windows-runs.json'],['windows/pre-strict-archive-runs.json','windows-archive-refusal-before-fix.json'],['android/documents.json','android-documents.json'],['android/document-errors.json','android-document-errors.json'],['android/knowledge.json','android-knowledge.json'],['android/skills.json','android-skills.json'],['android/evidence-theme.json','android-evidence-theme.json'],['android/knowledge-temporary.json','android-knowledge-temporary.json'],['android/documents-download-provider-attempt.json','android-picker-provider-attempt.json'],['android/skills-input-driver-attempt.json','android-input-driver-attempt.json'],['android/skills-line-end-attempt.json','android-line-end-attempt.json'],['android/knowledge-viewport-attempt.json','android-knowledge-viewport-attempt.json'],['recovery/connectivity.json','connectivity-recovery.json'],['recovery/connectivity-driver-timeout.json','connectivity-driver-timeout.json'],['recovery/interruption.json','interruption-recovery.json']];
for(const [source,target]of sources){
 const path='.runtime/v03/'+source;if(!existsSync(path))continue;const report=JSON.parse(readFileSync(path));if(report.status==='PASS')delete report.failure;
 for(const [index,row]of (report.rows??[]).entries()){Object.assign(row,{runId:row.invocationId??`${target}:${index+1}`,codeSha:report.codeSha??null,apkSha256:report.apkSha256??null,client:source.startsWith('android/')?'Android physical device':'Windows Edge'});for(const key of ['capabilityId','operationId','inputClass','inputBytes','startedAt','finishedAt','latencyMs','errorCode','resultDigest'])row[key]??=null;const baseline=finalWindows.rows.find(w=>w.case===row.case);if(source.startsWith('android/')&&row.resultDigest&&baseline?.resultDigest){row.finalWindowsInvocationId=baseline.invocationId;row.finalWindowsCanonicalDigestMatch=row.resultDigest===baseline.resultDigest;}const authority=snapshot.invocations.find(i=>i.invocationId===row.invocationId);if(!authority)continue;
  for(const key of ['capabilityId','operationId','startedAt','finishedAt','inputClass','inputBytes'])row[key]=authority[key]??row[key]??null;
  row.latencyMs=authority.finishedAt?Date.parse(authority.finishedAt)-Date.parse(authority.startedAt):null;
  row.metricsSource='persisted Gateway invocation; latency is server execution, not UI end-to-end';
  if(authority.result?.bundle){const b=authority.result.bundle;row.integrityRoot=b.integrityRoot;row.decision=b.decision;row.claimStatuses=b.claims?.map(c=>c.status)??[];row.claimStatusCounts=row.claimStatuses.reduce((counts,status)=>(counts[status]=(counts[status]??0)+1,counts),{});row.artifactCount=b.manifest?.length??null;row.claimCount=b.claims?.length??null;}
  if(row.operationId==='tamper')row.tamperResult=authority.errorCode;
 }
 writeFileSync(root+'/'+target,JSON.stringify(report,null,2));
}
for(const name of ['evidence.png','theme.png'])if(existsSync('.runtime/v03/windows/'+name))copyFileSync('.runtime/v03/windows/'+name,root+'/windows-'+name);
for(const name of ['theme.png','evidence.png','evidence-details.png'])if(existsSync('.runtime/v03/android/'+name))copyFileSync('.runtime/v03/android/'+name,root+'/android-'+name);
if(existsSync('.runtime/v03/android/preview.json'))copyFileSync('.runtime/v03/android/preview.json',root+'/android-preview.json');
for(const ext of ['txt','json','yaml','docx','xlsx','pdf'])copyFileSync('.runtime/v03/fixtures/sample.'+ext,root+'/fixture-sample.'+ext);
const files=readdirSync(root).filter(n=>n!=='manifest.json').sort().map(file=>({file,sha256:createHash('sha256').update(readFileSync(root+'/'+file)).digest('hex')}));
writeFileSync(root+'/manifest.json',JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),files,limitations:['Generated public fixtures only. No tokens, device identifiers or original private inputs are included.','Earlier failed attempts are retained; a passing retry does not erase them.','Missing historical metrics remain null. Server latency excludes client and operator time.']},null,2));
console.log(JSON.stringify({files:files.length}));
