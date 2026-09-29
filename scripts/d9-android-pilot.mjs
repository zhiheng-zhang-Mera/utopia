import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tree,cmd,tap,top,fill,scroll,pause} from './android-ui-driver.mjs';
const output='.runtime/evidence/wave3/android/'+Date.now();fs.mkdirSync(output,{recursive:true});
async function selectTheme(){cmd('shell','am','start','-W','-n','city.utopia.control/.MainActivity');await tap('Services');await top();const nodes=await tree(),selected=['Document Intake','Knowledge Query','Skill Inspect','Evidence Review','Theme Lab'].find(name=>nodes.some(n=>n.text===name));if(selected!=='Theme Lab'){await tap(selected);await tap('Theme Lab');}await top();}
await selectTheme();
if(process.argv.includes('--probe')){await tap('Theme action: generate',{attempts:2});console.log('Theme build controls found');process.exit(0);}
const config=JSON.parse(fs.readFileSync('.runtime/local-config.json')),{url}=JSON.parse(fs.readFileSync('.runtime/processes.json'));
const windows=JSON.parse(fs.readFileSync('.runtime/evidence/wave3/windows/runs.json'));
const call=async endpoint=>{const r=await fetch(url+'/api/v0/'+endpoint,{headers:{Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'}});assert.ok(r.ok);return r.json();};
const installed=cmd('shell','pm','path','city.utopia.control').trim().replace(/^package:/,''),apkSha256=cmd('shell','sha256sum',installed).trim().split(/\s/)[0];assert.equal(apkSha256,createHash('sha256').update(fs.readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex'));
const report={sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),apkSha256,scope:'Physical Android native controls, generated/public prompt, same input as Windows',rows:[]};
const save=()=>fs.writeFileSync(output+'/runs.json',JSON.stringify(report,null,2)+'\n');
try{
 await tap('Theme action: generate');await tap('build');await fill('Theme prompt','blue research compact no persona');let observation='none',failure=false;
 for(const [name,desired,inject]of [['observed-offline','desktop',false],['unobserved-offline','none',false],['unobserved-fallback','none',true]]){
  await top();if(observation!==desired){await tap('Observation: '+observation);await tap(desired);observation=desired;}if(failure!==inject){await tap('Test image failure');failure=inject;}
  const before=new Set((await call('city')).invocations.map(i=>i.invocationId));await tap('Run service');let row;
  for(let attempt=0;attempt<60;attempt++){await pause(300);row=(await call('city')).invocations.find(i=>!before.has(i.invocationId));if(row&&row.status!=='RUNNING')break;}
  assert.equal(row?.status,'COMPLETED',row?.errorCode);const detail=await call('capability-invocations/'+row.invocationId),expected=windows.rows.find(r=>r.case===name);assert.equal(row.resultDigest,expected.resultDigest);
  for(const key of ['intentDigest','planDigest','packageDigest','contentDigest','validationDigest'])assert.equal(detail.result[key],expected.result[key],key);
  let visible='';for(let i=0;i<7;i++){const nodes=await tree();visible+='\n'+nodes.map(n=>n.text||n['content-desc']||'').join('\n');if(visible.includes(row.invocationId)&&visible.includes('Theme preview')&&visible.includes(detail.result.packageDigest))break;await scroll('down',nodes);}
  assert.ok(visible.includes(row.invocationId));assert.ok(visible.includes('Theme preview'));assert.ok(visible.includes(detail.result.packageDigest));
  await tree();fs.writeFileSync(output+'/'+name+'.png',execFileSync(process.env.ADB||'adb',['exec-out','screencap','-p'],{windowsHide:true}));report.rows.push({case:name,invocationId:row.invocationId,resultDigest:row.resultDigest,result:detail.result,canonicalDigestMatchesWindows:true,nativeIdentityPreviewAndPackageDigestVisible:true,pass:true});save();
 }
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=error.message;throw error;}finally{save();console.log(JSON.stringify({status:report.status,cases:report.rows.length,output}));}
