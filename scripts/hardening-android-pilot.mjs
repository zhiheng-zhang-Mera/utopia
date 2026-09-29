import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tree,cmd,tap,top,scroll,chooseFile,pause} from './android-ui-driver.mjs';
const output=(process.env.UTOPIA_ANDROID_EVIDENCE_DIR??'.runtime/evidence/v0.3-hardening/android')+'/'+Date.now();mkdirSync(output,{recursive:true});
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const windows=JSON.parse(readFileSync((process.env.UTOPIA_WINDOWS_EVIDENCE_DIR??'.runtime/evidence/v0.3-hardening/windows')+'/runs.json'));
const call=async path=>{const response=await fetch(url+'/api/v0/'+path,{headers:{Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'}});assert.ok(response.ok);return response.json();};
const installed=cmd('shell','pm','path','city.utopia.control').trim().replace(/^package:/,'');
const apkSha256=cmd('shell','sha256sum',installed).trim().split(/\s/)[0];
assert.equal(apkSha256,createHash('sha256').update(readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex'));
const report={startedAt:new Date().toISOString(),codeSha:execFileSync('git',['rev-parse','HEAD']).toString().trim(),apkSha256,rows:[],scope:'Physical Android UI, generated/public inputs only'};
const save=()=>writeFileSync(output+'/runs.json',JSON.stringify(report,null,2));
let selected;
async function select(name){await top();if(selected!==name){await tap(selected);await tap(name);selected=name;}}
async function visibleResult(id,hash,extra=''){
 let text='',nodes;for(let i=0;i<7;i++){nodes=await tree();text+='\n'+nodes.map(n=>n.text||n['content-desc']||'').join('\n');if(text.includes(id)&&text.includes(hash)&&(!extra||text.includes(extra)))return{nodes,text};await scroll('down',nodes);}
 throw Error('RESULT_NOT_VISIBLE:'+id);
}
async function invoke(name,extra){
 const before=new Set((await call('city')).invocations.map(i=>i.invocationId));await tap('Run service');let row;
 for(let i=0;i<30;i++){await pause(300);row=(await call('city')).invocations.find(i=>!before.has(i.invocationId));if(row&&row.status!=='RUNNING')break;}
 assert.equal(row?.status,'COMPLETED');const expected=windows.rows.find(r=>r.case===name);assert.equal(row.resultDigest,expected.resultDigest);
 await visibleResult(row.invocationId,row.resultDigest,extra);const detail=await call('capability-invocations/'+row.invocationId);assert.equal(detail.resultAvailable,true);
 report.rows.push({case:name,invocationId:row.invocationId,resultDigest:row.resultDigest,status:row.status,canonicalDigestMatchesWindows:true,androidIdentityAndContentVisible:true,pass:true});save();return row;
}
try{
 cmd('shell','am','start','-W','-n','city.utopia.control/.MainActivity');
 await tap('Services');await top();selected=['Document Intake','Knowledge Query','Skill Inspect','Evidence Review','Theme Lab'].find(name=>false);const nodes=await tree();selected=['Document Intake','Knowledge Query','Skill Inspect','Evidence Review','Theme Lab'].find(name=>nodes.some(n=>n.text===name));assert.ok(selected);
 await select('Document Intake');await chooseFile('sample.txt');await invoke('sample.txt','Sections:');await tap('Query this document');selected='Knowledge Query';await invoke('document-to-knowledge','Utopia');
 await select('Skill Inspect');await invoke('skill-ref:owner/repo@main','Show result details');
 await select('Evidence Review');await invoke('evidence-review','Integrity root:');
 await select('Theme Lab');await invoke('theme-generate','Validation:');
 for(const [name,label] of [['theme-generate','Theme Lab'],['evidence-review','Evidence Review']]){
  const expected=windows.rows.find(r=>r.case===name);await top();await tap('COMPLETED · '+expected.invocationId,{attempts:8});selected=label;await top();await visibleResult(expected.invocationId,expected.resultDigest,name==='theme-generate'?'Theme preview':'Integrity root:');
  if(name==='evidence-review'){await tap('Show result details');let content='';for(let i=0;i<5&&!content.includes('sha256');i++){const nodes=await tree();content+='\n'+nodes.map(n=>n.text??'').join('\n');if(!content.includes('sha256'))await scroll('down',nodes);}assert.ok(content.includes('sha256'));}
  await tree();writeFileSync(output+'/'+name+'.png',execFileSync(process.env.ADB||'adb',['exec-out','screencap','-p'],{windowsHide:true}));
  report.rows.push({case:'open-Windows-history:'+name,invocationId:expected.invocationId,resultDigest:expected.resultDigest,androidIdentityAndContentVisible:true,pass:true});save();
 }
 report.status='PASS';
}catch(error){report.status='FAIL';report.failure=String(error.message).split('\n')[0];process.exitCode=1;}
report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({output,status:report.status,rows:report.rows.length,failure:report.failure}));
