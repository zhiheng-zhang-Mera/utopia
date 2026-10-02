import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
const adb=process.env.ADB||'adb';
const cmd=(...a)=>execFileSync(adb,a,{timeout:30000,maxBuffer:8*1024*1024}).toString();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const headers={Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const snapshot=async()=>{const r=await fetch(url+'/api/v0/city',{headers});return r.json();};
const codeSha=execFileSync('git',['rev-parse','HEAD']).toString().trim();
const apkPath=cmd('shell','pm','path','city.utopia.control').trim().replace(/^package:/,'');
const apkSha256=cmd('shell','sha256sum',apkPath).trim().split(/\s/)[0];
const localApkSha256=createHash('sha256').update(readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex');
const installedApkMatchesLocal=apkSha256===localApkSha256;
if(!/^[a-f0-9]{64}$/.test(apkSha256)||!installedApkMatchesLocal)throw Error('INSTALLED_APK_MISMATCH');
const before=await snapshot();
// Geometry-independent navigation, replacing a hard-coded `input tap 108 2195` whose y-coordinate
// assumed roughly a 1080x2400 device and therefore landed off-screen on any other host. This was the
// only host-specific assumption in the harness: the tap on the target itself was already
// bounds-derived, so only the ROUTE to it needed fixing. Two behaviours, both measured rather than
// assumed: if the target is already on screen nothing is tapped, and otherwise the nav entry leading
// there is found BY ITS LABEL and tapped at its own centre, so the route survives both a different
// device geometry and the redesigned five-entry bar.
const dumpUi=()=>{cmd('shell','uiautomator','dump','/sdcard/utopia-task.xml');return cmd('shell','cat','/sdcard/utopia-task.xml');};
const nodeByText=(source,text)=>[...source.matchAll(/<node\s+([^>]+)>/g)].find(m=>m[1].includes('text="'+text+'"'));
const centreOf=(tag)=>{const b=tag.match(/bounds="([^"]+)"/)[1].match(/\d+/g).map(Number);return [String((b[0]+b[2])>>1),String((b[1]+b[3])>>1)];};
let xml=dumpUi();
if(!nodeByText(xml,'Run Test Task')){
  // Candidates are ordered by where the target is KNOWN to render, read from the source rather than
  // guessed: the Run Test Task button is emitted for `page in listOf("Home","Tasks")`, so Home comes
  // first and Activity - which a blind "task-ish page" guess would pick - is last.
  const route=['Home','Tasks','首页','任务','Activity','Actions','行动','操作记录'].map(t=>nodeByText(xml,t)).find(Boolean);
  if(!route)throw Error('no route to the task surface was found in the current UI; refusing to tap blindly');
  cmd('shell','input','tap',...centreOf(route[1]));
  await wait(1500);
  xml=dumpUi();
}
const node=nodeByText(xml,'Run Test Task');
if(!node)throw Error('Run Test Task is not visible');
const startedAt=new Date().toISOString();cmd('shell','input','tap',...centreOf(node[1]));
// Every poll is recorded as a raw observation, and the summary booleans below are COMPUTED from this
// sequence rather than asserted alongside it. Mech's RS-290 addendum made the point that the recovery
// evidence is auditable only because it carries its observations, while this success path was
// summary-only - "its booleans cannot be checked against raw data the way the recovery path's can".
// Recording the sequence here makes both halves of the E2E claim checkable the same way: a reader can
// recompute `success` from the record and detect a summary that contradicts its own observations.
const observations=[];
let task,after;for(let i=0;i<30;i++){await wait(1000);after=await snapshot();task=after.tasks.find(t=>!before.tasks.some(p=>p.id===t.id));observations.push({at:new Date().toISOString(),poll:i,state:task?task.state:null,eventCount:task?after.events.filter(e=>e.taskId===task.id).length:0});if(task&&['COMPLETED','FAILED'].includes(task.state))break;}
if(!task)throw Error('No new task observed');cmd('shell','uiautomator','dump','/sdcard/utopia-task.xml');xml=cmd('shell','cat','/sdcard/utopia-task.xml');
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({locale:'en-US'});
try{
 await page.goto(url);await page.locator('#token').fill(config.token);await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();
 await page.locator('[data-task="'+task.id+'"]').first().click();const web=await page.locator('#detail').innerText();
 const androidObservation={at:new Date().toISOString(),surface:'android',taskVisible:xml.includes(task.id),completionVisible:xml.includes('COMPLETED')};
 const webObservation={at:new Date().toISOString(),surface:'web',taskVisible:web.includes(task.id),completionVisible:web.includes('COMPLETED')};
 observations.push(androidObservation,webObservation);
 const terminalObservation=observations.find(o=>['COMPLETED','FAILED'].includes(o.state));
 const result={codeSha,apkSha256,localApkSha256,installedApkMatchesLocal,startedAt,completedAt:terminalObservation?terminalObservation.at:new Date().toISOString(),taskId:task.id,state:task.state,androidShowsTaskAndCompletion:androidObservation.taskVisible&&androidObservation.completionVisible,webShowsTaskAndCompletion:webObservation.taskVisible&&webObservation.completionVisible,eventTypes:after.events.filter(e=>e.taskId===task.id).map(e=>e.type),resultAvailable:!!task.result,checkpointAvailable:!!task.lastCheckpoint,scope:'Android UI submitted task; real reference node; Web UI observes same task identity and completion'};
 const texts=[...xml.matchAll(/text=(?:"([^"]*)"|'([^']*)')/g)].map(m=>(m[1]??m[2]).replace(/&quot;/g,'"').replace(/&amp;/g,'&')).filter(Boolean);
 let androidResult=null;try{androidResult=JSON.parse(texts[texts.indexOf('Result')+1]);}catch{}
 const webResult=JSON.parse(await page.locator('#detail h3').filter({hasText:'Result'}).locator('xpath=following-sibling::pre[1]').innerText());
 result.artifactSha256=task.result?.sha256||null;
 result.androidResultMatches=!!androidResult&&androidResult.sha256===task.result?.sha256&&androidResult.bytes===task.result?.bytes&&androidResult.cleaned===true;
 result.webResultMatches=webResult.sha256===task.result?.sha256&&webResult.bytes===task.result?.bytes&&webResult.cleaned===true;
 // Derived from the observation sequence, so a summary that contradicts its own record is impossible: a
 // COMPLETED state must have been OBSERVED during the poll sequence (not merely be the last reading),
 // no FAILED state may appear anywhere in it, and both surfaces must have shown the completion in the
 // observations recorded above. This is the same discipline the recovery pilot's rows already satisfy.
 const observedStates=observations.filter(o=>o.state).map(o=>o.state);
 result.observedStates=observedStates;
 result.terminalObservedAt=terminalObservation?terminalObservation.at:null;
 result.observations=observations;
 result.success=observedStates.includes('COMPLETED')&&!observedStates.includes('FAILED')&&result.androidShowsTaskAndCompletion&&result.webShowsTaskAndCompletion&&result.androidResultMatches&&result.webResultMatches&&result.checkpointAvailable;
 writeFileSync('.runtime/evidence/v0.2/task-regression.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
