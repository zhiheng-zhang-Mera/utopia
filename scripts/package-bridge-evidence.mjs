import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='evidence/raw/v0.3';mkdirSync(root,{recursive:true});
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const snapshot=await(await fetch(url+'/api/v0/city',{headers:{Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'}})).json();
const sources=[['windows/runs.json','windows-runs.json'],['windows/pre-strict-archive-runs.json','windows-archive-refusal-before-fix.json'],['android/documents.json','android-documents.json'],['android/knowledge.json','android-knowledge.json'],['android/skills.json','android-skills.json'],['android/evidence-theme.json','android-evidence-theme.json'],['android/knowledge-temporary.json','android-knowledge-temporary.json'],['android/documents-download-provider-attempt.json','android-picker-provider-attempt.json'],['android/skills-input-driver-attempt.json','android-input-driver-attempt.json'],['android/skills-line-end-attempt.json','android-line-end-attempt.json'],['recovery/connectivity.json','connectivity-recovery.json'],['recovery/interruption.json','interruption-recovery.json']];
for(const [source,target]of sources){
 const path='.runtime/v03/'+source;if(!existsSync(path))continue;const report=JSON.parse(readFileSync(path));
 for(const row of report.rows??[]){const authority=snapshot.invocations.find(i=>i.invocationId===row.invocationId);if(!authority)continue;
  for(const key of ['capabilityId','operationId','startedAt','finishedAt','inputClass','inputBytes'])row[key]=authority[key]??row[key]??null;
  row.latencyMs=authority.finishedAt?Date.parse(authority.finishedAt)-Date.parse(authority.startedAt):null;
  row.metricsSource='persisted Gateway invocation; latency is server execution, not UI end-to-end';
  if(authority.result?.bundle){const b=authority.result.bundle;row.integrityRoot=b.integrityRoot;row.decision=b.decision;row.claimStatuses=b.claims?.map(c=>c.status)??[];row.artifactCount=b.artifacts?.length??null;row.claimCount=b.claims?.length??null;}
 }
 writeFileSync(root+'/'+target,JSON.stringify(report,null,2));
}
for(const name of ['evidence.png','theme.png'])if(existsSync('.runtime/v03/windows/'+name))copyFileSync('.runtime/v03/windows/'+name,root+'/windows-'+name);
for(const name of ['theme.png','evidence.png'])if(existsSync('.runtime/v03/android/'+name))copyFileSync('.runtime/v03/android/'+name,root+'/android-'+name);
const files=readdirSync(root).filter(n=>n!=='manifest.json').sort().map(file=>({file,sha256:createHash('sha256').update(readFileSync(root+'/'+file)).digest('hex')}));
writeFileSync(root+'/manifest.json',JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),files,limitations:['Generated public fixtures only. No tokens, device identifiers or original private inputs are included.','Earlier failed attempts are retained; a passing retry does not erase them.','Missing historical metrics remain null. Server latency excludes client and operator time.']},null,2));
console.log(JSON.stringify({files:files.length}));
