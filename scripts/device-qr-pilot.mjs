import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Scope: real embedded camera only. User must physically aim the phone at the
// visible pairing-display window. No QR/deep-link injection, screenshots, or
// camera UI dumps. Grant camera permission interactively if prompted; this
// script does not inspect the screen after tapping Scan QR.
const count=Number(process.argv[2]||5);
if(!Number.isSafeInteger(count)||count<1||count>5)throw Error('Use a trial count from 1 to 5');
const adb=process.env.ADB||'adb';
const cmd=(...args)=>execFileSync(adb,args,{timeout:30000,maxBuffer:8*1024*1024,windowsHide:true}).toString();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const timestamp=()=>new Date().toISOString();
const failure=code=>{const e=new Error(code);e.pilotCode=code;throw e;};
const directory='.runtime/evidence/v0.2';mkdirSync(directory,{recursive:true});
const series=process.argv.find(x=>x.startsWith('--series='))?.slice('--series='.length)||'';
if(series&&!/^[a-z0-9-]{1,32}$/.test(series))throw Error('Invalid series name');
const prefix=series?'qr-'+series:'qr';
const driverSha256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const workingTreeDirty=!!execFileSync('git',['status','--porcelain'],{windowsHide:true}).toString().trim();
const codeSha=execFileSync('git',['rev-parse','HEAD'],{windowsHide:true}).toString().trim();
const installed=cmd('shell','pm','path','city.utopia.control').trim().replace(/^package:/,'');
const apkSha256=cmd('shell','sha256sum',installed).trim().split(/\s/)[0];
const localHash=createHash('sha256').update(readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex');
if(apkSha256!==localHash)failure('INSTALLED_APK_MISMATCH');
async function preCameraNodes(){
 for(let attempt=0;attempt<3;attempt++){try{cmd('shell','uiautomator','dump','/sdcard/utopia-qr-onboarding.xml');break;}catch(e){if(attempt===2)throw e;await sleep(1000);}}
 const xml=cmd('shell','cat','/sdcard/utopia-qr-onboarding.xml');
 return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));
}
function tapNode(node){if(!node?.bounds)failure('ONBOARDING_TARGET_MISSING');const b=node.bounds.match(/\d+/g).map(Number);if(b[2]<=b[0]||b[3]<=b[1])failure('ONBOARDING_TARGET_ZERO_BOUNDS');cmd('shell','input','tap',String((b[0]+b[2])>>1),String((b[1]+b[3])>>1));}
async function waitNode(text){const start=Date.now();while(Date.now()-start<30000){const node=(await preCameraNodes()).find(n=>n.text===text);if(node)return node;await sleep(600);}failure('ONBOARDING_NOT_READY_'+text.replaceAll(' ','_'));}
function activeSessionId(){try{return JSON.parse(readFileSync('.runtime/active-pairing.json')).pairingSessionId||null;}catch{return null;}}
async function refreshVisibleQr(){
 if(!existsSync('.runtime/active-pairing.json'))failure('VISIBLE_PAIRING_DISPLAY_NOT_READY');
 const old=activeSessionId();writeFileSync('.runtime/refresh-pairing','refresh');
 const start=Date.now();while(Date.now()-start<15000){await sleep(300);const current=activeSessionId();if(current&&current!==old)return;}failure('VISIBLE_PAIRING_DISPLAY_REFRESH_TIMEOUT');
}
const allowedEvents=new Set(['start','action','discovery','pairingSubmitted','authenticated','snapshotLoaded','websocketOnline','retry','pairingError','descriptorError','permissionDenied','connection_OFFLINE','connection_RECONNECTING','connection_ONLINE']);
function logEvents(){
 let output='';try{output=cmd('exec-out','run-as','city.utopia.control','cat','files/pairing-events.jsonl');}catch{return [];}
 return output.split(/\r?\n/).flatMap(line=>{try{const e=JSON.parse(line);if(e.mode!=='qr'||!allowedEvents.has(e.event)||typeof e.trialId!=='string'||!Number.isFinite(Date.parse(e.timestamp)))return [];
 return [{trialId:e.trialId,mode:'qr',event:e.event,timestamp:e.timestamp,userActions:Number.isFinite(e.userActions)?e.userActions:null,retryCount:Number.isFinite(e.retryCount)?e.retryCount:null}];}catch{return [];}});
}
const resume=process.argv.includes('--resume');
if(!resume&&existsSync(directory+'/'+prefix+'-runs.json'))failure('SERIES_EXISTS_USE_RESUME_OR_NEW_SERIES');
const rows=resume&&existsSync(directory+'/'+prefix+'-runs.json')?JSON.parse(readFileSync(directory+'/'+prefix+'-runs.json')):[];
const recordedEvents=resume&&existsSync(directory+'/'+prefix+'-events.jsonl')?readFileSync(directory+'/'+prefix+'-events.jsonl','utf8').trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x)):[];
if(rows.some(r=>r.apkSha256!==apkSha256))failure('RESUME_APK_MISMATCH_USE_NEW_SERIES');
const save=()=>{writeFileSync(directory+'/'+prefix+'-runs.json',JSON.stringify(rows,null,2));writeFileSync(directory+'/'+prefix+'-events.jsonl',recordedEvents.map(e=>JSON.stringify(e)).join('\n')+(recordedEvents.length?'\n':''));};
for(let run=rows.length+1;rows.filter(r=>r.success).length<count;run++){
 const row={mode:'qr',run,codeSha,driverSha256,workingTreeDirty,apkSha256,startTimestamp:timestamp(),discoveryTimestamp:null,pairingSubmittedTimestamp:null,authenticatedTimestamp:null,snapshotLoadedTimestamp:null,websocketOnlineTimestamp:null,trialId:null,success:false,errorClass:null,driver:'ADB onboarding plus physical camera; no QR injection',cameraLaunchRequestedAt:null};
 if(existsSync('.runtime/pairing-display-geometry.json'))row.displayGeometry=JSON.parse(readFileSync('.runtime/pairing-display-geometry.json'));
 rows.push(row);save();let cameraLaunched=false;
 try{
  row.stage='STARTING';save();cmd('shell','am','force-stop','city.utopia.control');cmd('shell','am','start','-n','city.utopia.control/.MainActivity');await sleep(2500);
  row.stage='OPEN_SETTINGS';save();
  await waitNode('Settings');cmd('shell','input','tap','970','2195');await sleep(500);
  row.stage='CLEAR_PAIRING';save();tapNode(await waitNode('Clear pairing / Find your City'));await waitNode('Scan QR');
  await refreshVisibleQr();const previousIds=new Set(logEvents().map(e=>e.trialId));
  const scan=await waitNode('Scan QR');row.cameraLaunchRequestedAt=timestamp();tapNode(scan);cameraLaunched=true;row.stage='CAMERA_LAUNCHED';save();
  // From here until app exit, only app-private allowlisted telemetry is read.
  const started=Date.now();let trialEvents=[];
  while(Date.now()-started<45000){
   const events=logEvents();if(!row.trialId)row.trialId=events.find(e=>e.event==='start'&&!previousIds.has(e.trialId))?.trialId||null;
   trialEvents=events.filter(e=>e.trialId===row.trialId);
   for(const [event,field] of [['discovery','discoveryTimestamp'],['pairingSubmitted','pairingSubmittedTimestamp'],['authenticated','authenticatedTimestamp'],['snapshotLoaded','snapshotLoadedTimestamp'],['websocketOnline','websocketOnlineTimestamp']])row[field]=trialEvents.find(e=>e.event===event)?.timestamp||null;
   if(row.discoveryTimestamp&&row.pairingSubmittedTimestamp&&row.authenticatedTimestamp&&row.snapshotLoadedTimestamp&&row.websocketOnlineTimestamp){row.success=true;break;}
   if(trialEvents.some(e=>e.event==='pairingError'||e.event==='descriptorError')){row.errorClass='QR_PAIRING_REJECTED';break;}
   await sleep(800);
  }
  recordedEvents.push(...trialEvents);
  if(!row.success&&!row.errorClass)row.errorClass=row.discoveryTimestamp?'QR_CONTROL_CONVERGENCE_TIMEOUT':'NO_CAMERA_DECODE_OBSERVED';
 }catch(e){row.errorClass=e.pilotCode||'DRIVER_OR_PLATFORM_ERROR';row.driverErrorCode=e.code||null;row.driverExitStatus=e.status??null;row.driverSignal=e.signal||null;}
 finally{
  if(cameraLaunched&&!row.success){try{cmd('shell','input','keyevent','4');cmd('shell','am','force-stop','city.utopia.control');}catch{row.cameraExitConfirmed=false;}}
  row.endTimestamp=timestamp();save();
 }
 console.log('qr',run,row.success?'PASS':row.errorClass);
 if(!row.success)break;
}
