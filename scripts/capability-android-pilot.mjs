import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {cmd,tree,tap,top,fill,chooseFile,pause,scroll} from './android-ui-driver.mjs';
const phase=process.argv[2]??'documents',path='.runtime/v03/android/'+phase+'.json';mkdirSync('.runtime/v03/android',{recursive:true});
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const snapshot=async()=>{const r=await fetch(url+'/api/v0/city',{headers:{Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'}});return r.json();};
const apkPath=cmd('shell','pm','path','city.utopia.control').trim().replace(/^package:/,'');
const apkSha256=cmd('shell','sha256sum',apkPath).trim().split(/\s/)[0];
const report=existsSync(path)?JSON.parse(readFileSync(path)):{phase,codeSha:execFileSync('git',['rev-parse','HEAD']).toString().trim(),apkSha256,startedAt:new Date().toISOString(),rows:[]};if(report.apkSha256!==apkSha256)throw Error('APK_CHANGED_NEW_SERIES_REQUIRED');
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({locale:'en-US'});
let selected='Document Intake';
async function select(name){await top();if(selected!==name){await tap(selected);await tap(name);selected=name;}}
const save=()=>writeFileSync(path,JSON.stringify(report,null,2));
const passed=name=>report.rows.some(r=>r.case===name&&r.pass);
async function invoke(name,expected='COMPLETED',button='Run service',inputFile=null){
 const before=new Set((await snapshot()).invocations.map(i=>i.invocationId));await tap(button);let row;
 for(let i=0;i<25;i++){await pause(400);row=(await snapshot()).invocations.find(i=>!before.has(i.invocationId));if(row&&row.status!=='RUNNING')break;}
 if(!row)throw Error('NO_UI_INVOCATION:'+name);
 let nodes=await tree(),texts=nodes.map(n=>n.text).join('\n');for(let i=0;i<3&&!texts.includes(row.invocationId);i++){await scroll('down',nodes);nodes=await tree();texts=nodes.map(n=>n.text).join('\n');}
 const uiId=texts.includes(row.invocationId),uiDigest=row.resultDigest?texts.includes(row.resultDigest):true,uiStatus=texts.includes(row.status);
 await page.reload();await page.locator('[data-page="Services"]').click();await page.locator('[data-invocation="'+row.invocationId+'"]').click();await page.locator('#service-state').filter({hasText:row.status}).waitFor();
 const webIdentity=await page.locator('#service-id').innerText();const windows=JSON.parse(readFileSync('.runtime/v03/windows/runs.json')).rows.find(r=>r.case===name);
 const digestMatch=windows?.resultDigest?windows.resultDigest===row.resultDigest:null;
 const result={case:name,invocationId:row.invocationId,capabilityId:row.capabilityId,operationId:row.operationId,startedAt:row.startedAt,finishedAt:row.finishedAt,latencyMs:Date.parse(row.finishedAt)-Date.parse(row.startedAt),inputClass:row.inputClass??null,inputBytes:row.inputBytes??null,status:row.status,expected,resultDigest:row.resultDigest,errorCode:row.errorCode,androidIdVisible:uiId,androidDigestVisible:uiDigest,androidStatusVisible:uiStatus,webSameInvocationVisible:webIdentity.includes(row.invocationId)&&(!row.resultDigest||webIdentity.includes(row.resultDigest)),canonicalDigestMatchesWindows:digestMatch,inputSha256:inputFile?createHash('sha256').update(readFileSync('.runtime/v03/fixtures/'+inputFile)).digest('hex'):null,integrityRoot:row.result?.bundle?.integrityRoot??null};result.pass=result.status===expected&&uiId&&uiDigest&&uiStatus&&result.webSameInvocationVisible&&digestMatch!==false;report.rows.push(result);save();console.log(name,result.pass?'PASS':'FAIL');if(!result.pass)throw Error('ANDROID_CASE_FAILED:'+name);return row;
}
try{
 await page.goto(url);await page.locator('#token').fill(config.token);await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();
 await tap('Services');await top();const nodes=await tree();selected=['Document Intake','Knowledge Query','Skill Inspect','Evidence Review','Theme Lab'].find(name=>nodes.some(n=>n.text===name))??'Document Intake';
 if(phase==='documents')for(const name of ['sample.txt','sample.json','sample.yaml','sample.docx','sample.xlsx','sample.pdf']){if(passed(name))continue;await select('Document Intake');await chooseFile(name);await invoke(name,'COMPLETED','Run service',name);}
 if(phase==='knowledge'){
  await select('Document Intake');await chooseFile('sample.txt');await invoke('document-for-knowledge','COMPLETED','Run service','sample.txt');await tap('Query this document');selected='Knowledge Query';await invoke('document-to-knowledge');
 }
 if(phase==='skills'){
  await select('Skill Inspect');
  for(const ref of ['owner/repo','owner/repo@main','https://github.com/owner/repo/tree/main/skills/demo','https://github.com/owner/repo/blob/main/skills/demo/SKILL.md','https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md','owner/repo@main/../../escape']){const name='skill-ref:'+ref;if(passed(name))continue;await top();await fill('GitHub reference',ref);await invoke(name,ref.includes('..')?'FAILED':'COMPLETED');}
  await top();await tap('Action: inspect');await tap('validate');
  for(const name of ['valid-SKILL.md','malformed-SKILL.md']){await top();await chooseFile(name,'Choose SKILL.md');await invoke(name,name.startsWith('valid')?'COMPLETED':'FAILED');}
  await top();await tap('Action: validate');await tap('archive');
  for(const name of ['valid.tar','unsafe.tar']){await top();await chooseFile(name,'Choose archive');await invoke(name,name==='valid.tar'?'COMPLETED':'FAILED');}
 }
 if(phase==='evidence-theme'){
  await select('Evidence Review');if(!passed('evidence-review'))await invoke('evidence-review');await top();if(!passed('evidence-tamper'))await invoke('evidence-tamper','FAILED','Tamper Test');
  await select('Theme Lab');if(!passed('theme-generate'))await invoke('theme-generate');
 }
 report.status='PASS';delete report.failure;report.finishedAt=new Date().toISOString();save();
}catch(e){report.status='FAIL';report.failure=String(e.message).split('\n')[0];save();console.log(report.failure);process.exitCode=1;}
finally{await browser.close();}
