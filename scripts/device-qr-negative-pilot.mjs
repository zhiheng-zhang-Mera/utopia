import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

// Execution requires review and explicit --run. Never inject QR/deep links into Android.
// Keep the phone aimed at THIS private display. Do not run another phone driver or
// session-creating display concurrently. No browser/camera screenshots or recordings.
if(!process.argv.includes('--run')){
 console.log('Review first. Run: node scripts/device-qr-negative-pilot.mjs --run [all|expired|replaced]');
 process.exit(0);
}
const mode=process.argv.find(x=>['all','expired','replaced'].includes(x))||'all';
const displayScale=Number(process.argv.find(x=>x.startsWith('--scale='))?.split('=')[1]||1);
if(![1,2].includes(displayScale))throw Error('Display scale must be 1 or 2');
const adb=process.env.ADB||'adb',now=()=>new Date().toISOString();
const cmd=(...a)=>execFileSync(adb,a,{timeout:30000,maxBuffer:8*1024*1024,windowsHide:true}).toString();
const fail=(code,exitStatus=null)=>{const error=new Error(code);error.pilotCode=code;error.driverExitStatus=exitStatus;throw error;};
const abort=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>abort.abort());
const sleep=ms=>new Promise((resolve,reject)=>{if(abort.signal.aborted)return reject(Error('STOPPED'));const onAbort=()=>{clearTimeout(timer);reject(Error('STOPPED'));};const timer=setTimeout(()=>{abort.signal.removeEventListener('abort',onAbort);resolve();},ms);abort.signal.addEventListener('abort',onAbort,{once:true});});
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const codeSha=execFileSync('git',['rev-parse','HEAD'],{windowsHide:true}).toString().trim();
const installed=cmd('shell','pm','path','city.utopia.control').trim().replace(/^package:/,'');
const apkSha256=cmd('shell','sha256sum',installed).trim().split(/\s/)[0];
if(apkSha256!==createHash('sha256').update(readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex'))fail('INSTALLED_APK_MISMATCH');
const directory='.runtime/evidence/v0.2/qr-negative-'+now().replaceAll(':','-');mkdirSync(directory,{recursive:true});
const driverSha256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const workingTreeDirty=!!execFileSync('git',['status','--porcelain'],{windowsHide:true}).toString().trim();
const result={codeSha,driverSha256,workingTreeDirty,apkSha256,startedAt:now(),driver:'ADB onboarding plus physical camera; no QR or descriptor injection',scope:'Expired QR: two physical scans share one genuinely expired five-minute session. Replaced QR: two independent original sessions, each replaced before scanning.',fakeClock:false,shortenedTtl:false,runs:[]};
const recordedEvents=[],privateMaterials=[config.token,config.nodeToken];
function save(){for(const [file,value] of [['runs.json',JSON.stringify(result,null,2)+'\n'],['events.jsonl',recordedEvents.map(e=>JSON.stringify(e)).join('\n')+'\n']]){if(privateMaterials.some(s=>s&&value.includes(s))||/utopia:\/\/pair\?|qrSvg|qrPayload/.test(value))fail('SECRET_OUTPUT_GUARD');writeFileSync(directory+'/'+file,value);}}
async function api(path,body){const response=await fetch(url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});if(!response.ok)fail('HOST_API_REJECTED');const data=await response.json();if(data.apiVersion!==0||data.schemaVersion!==0)fail('HOST_VERSION_MISMATCH');return data;}
async function session(){const s=await api('pairing/session',{});if(Date.parse(s.expiresAt)-Date.parse(s.createdAt)!==300000)fail('DEFAULT_TTL_CHANGED');privateMaterials.push(s.shortCode,new URL(s.qrPayload).searchParams.get('secret'));return s;}
const allowed=new Set(['start','action','discovery','pairingSubmitted','authenticated','snapshotLoaded','websocketOnline','retry','pairingError','descriptorError','permissionDenied']);
function events(){let raw='';try{raw=cmd('exec-out','run-as','city.utopia.control','cat','files/pairing-events.jsonl');}catch{return [];}return raw.split(/\r?\n/).flatMap(line=>{try{const e=JSON.parse(line);return e.mode==='qr'&&allowed.has(e.event)&&typeof e.trialId==='string'&&Number.isFinite(Date.parse(e.timestamp))?[{trialId:e.trialId,mode:'qr',event:e.event,timestamp:e.timestamp,userActions:Number.isFinite(e.userActions)?e.userActions:null,retryCount:Number.isFinite(e.retryCount)?e.retryCount:null}]:[];}catch{return [];}});}
let cameraMayBeOpen=false;
function mainActivityResumed(){const raw=cmd('shell','dumpsys','activity','activities');return raw.split(/\r?\n/).some(line=>/mResumedActivity|topResumedActivity/.test(line)&&/city\.utopia\.control\/\.MainActivity|city\.utopia\.control\/city\.utopia\.control\.MainActivity/.test(line));}
async function nodes(stage='UI'){
 if(cameraMayBeOpen)fail('CAMERA_UI_INSPECTION_FORBIDDEN');
 for(let attempt=1;attempt<=3;attempt++){
  if(cameraMayBeOpen)fail('CAMERA_UI_INSPECTION_FORBIDDEN');
  try{cmd('shell','uiautomator','dump','/sdcard/utopia-qr-negative.xml');const xml=cmd('shell','cat','/sdcard/utopia-qr-negative.xml');return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));}
  catch(e){if(attempt===3)fail(stage+'_UI_DUMP_RETRIES_EXHAUSTED',Number.isInteger(e.status)?e.status:null);await sleep(1000);}
 }
}
function tap(node){if(!node?.bounds)fail('ONBOARDING_TARGET_MISSING');const b=node.bounds.match(/\d+/g).map(Number);if(b[2]<=b[0]||b[3]<=b[1])fail('ONBOARDING_TARGET_ZERO_BOUNDS');cmd('shell','input','tap',String((b[0]+b[2])>>1),String((b[1]+b[3])>>1));}
async function find(text){const start=Date.now();while(Date.now()-start<20000){const node=(await nodes('ONBOARDING')).find(n=>n.text===text);if(node)return node;await sleep(600);}fail('ONBOARDING_NOT_READY');}
async function unpair(){cmd('shell','am','force-stop','city.utopia.control');cameraMayBeOpen=false;cmd('shell','am','start','-n','city.utopia.control/.MainActivity');await sleep(2500);await find('Settings');cmd('shell','input','tap','970','2195');await sleep(500);tap(await find('Clear pairing / Find your City'));await find('Scan QR');}
let browser,page,qrBox;
async function measureRealPairingGeometry(){
 await page.goto(url+'/pairing');await page.locator('#token').fill(config.token);await page.locator('#connect').click();await page.locator('#connection.online').waitFor();
 // Setup session measures only the real UI. All test sessions are created AFTER this step.
 await page.locator('#generate-pairing').click();await page.locator('#pairing-qr svg').waitFor();await page.evaluate(()=>window.scrollTo(0,0));
 qrBox=await page.locator('#pairing-qr').boundingBox();
 if(!qrBox||Math.abs(qrBox.width-240)>1||qrBox.height<=0)fail('REAL_PAIRING_QR_GEOMETRY_UNEXPECTED');
 result.displayGeometry={displayScale,viewport:{width:1440,height:1000},qrBox,source:'Measured real authenticated Web pairing QR before test-session creation',windowPosition:'Browser default; physical alignment still requires confirmation'};save();
}
async function display(s,label){
 // Preserve the real Web QR's exact viewport box. Overlay sits outside #view so
 // ordinary polling/session expiry cannot remove the retained negative-test SVG.
 await page.evaluate(({svg,label,box,scale})=>{
  let qr=document.getElementById('private-negative-qr');if(!qr){qr=document.createElement('div');qr.id='private-negative-qr';document.body.append(qr);}
  Object.assign(qr.style,{position:'fixed',left:box.x+'px',top:box.y+'px',width:box.width+'px',height:box.height+'px',zIndex:'2147483646',background:'#fff',pointerEvents:'none',transform:'scale('+scale+')',transformOrigin:'center'});qr.innerHTML=svg;
  const image=qr.querySelector('svg');if(image){image.style.width='100%';image.style.height='100%';image.style.display='block';}
  let banner=document.getElementById('private-negative-label');if(!banner){banner=document.createElement('div');banner.id='private-negative-label';document.body.append(banner);}
  banner.textContent=label+' · PRIVATE TEST · No capture';Object.assign(banner.style,{position:'fixed',left:'0',right:'0',top:'0',padding:'8px',background:'#fff5ce',color:'#111',zIndex:'2147483647',font:'bold 14px Arial',textAlign:'center',pointerEvents:'none'});
 },{svg:s.qrSvg,label,box:qrBox,scale:displayScale});await page.bringToFront();
}
async function scan(kind,index,s,extra={}){
 const row={kind,run:index,codeSha,apkSha256,driverStartTimestamp:now(),cameraLaunchRequestedAt:null,trialId:null,rejectionObservedAt:null,returnedToMainActivity:false,uiRejectionObserved:false,noAuthenticationObserved:null,success:false,errorClass:null,stage:'PREPARING',...extra};result.runs.push(row);save();let selected=[];
 try{
  row.stage='ONBOARDING';save();await unpair();row.stage='READY_TO_SCAN';save();const prior=new Set(events().map(e=>e.trialId));const scanNode=await find('Scan QR');if(kind==='replaced'&&Date.now()>=Date.parse(s.expiresAt))fail('REPLACED_QR_EXPIRED_BEFORE_CAMERA_LAUNCH');row.cameraLaunchRequestedAt=now();row.unexpiredAtCameraLaunchRequested=kind==='replaced'?Date.parse(row.cameraLaunchRequestedAt)<Date.parse(s.expiresAt):null;cameraMayBeOpen=true;tap(scanNode);row.cameraLaunchCompletedAt=now();if(kind==='replaced'&&Date.parse(row.cameraLaunchCompletedAt)>=Date.parse(s.expiresAt))fail('REPLACED_QR_EXPIRED_DURING_CAMERA_LAUNCH');row.stage='CAMERA_LAUNCHED';save();
  const deadline=Date.now()+120000,expected=kind==='expired'?'descriptorError':'pairingError';
  while(Date.now()<deadline){const all=events();row.trialId??=all.find(e=>e.event==='start'&&!prior.has(e.trialId))?.trialId||null;selected=all.filter(e=>e.trialId===row.trialId);if(selected.some(e=>e.event===expected)){row.rejectionObservedAt=selected.find(e=>e.event===expected).timestamp;break;}if(selected.some(e=>e.event==='authenticated'))fail('UNEXPECTED_AUTHENTICATION');await sleep(700);}
  if(!row.rejectionObservedAt)fail('NO_EXPECTED_CAMERA_REJECTION_OBSERVED');if(kind==='replaced'&&Date.parse(row.rejectionObservedAt)>=Date.parse(s.expiresAt))fail('REPLACED_QR_EXPIRED_BEFORE_REJECTION');row.stage='REJECTION_EVENT_OBSERVED';save();
  const returnDeadline=Date.now()+10000;while(Date.now()<returnDeadline){if(mainActivityResumed()){row.returnedToMainActivity=true;break;}await sleep(400);}
  if(!row.returnedToMainActivity)fail('CAMERA_RETURN_NOT_CONFIRMED');cameraMayBeOpen=false;row.stage='CAMERA_RETURN_CONFIRMED';save();
  // Only after the rejection callback AND resumed MainActivity: inspect UI, never persist its tree.
  const ui=await nodes('REJECTION');row.uiRejectionLabel=kind==='expired'?(ui.some(n=>n.text==='Invalid or expired pairing QR')?'Invalid or expired pairing QR':null):(ui.some(n=>n.text==='QR session changed; scan a new QR')?'QR session changed; scan a new QR':ui.some(n=>n.text?.includes('HTTP 410'))?'HTTP 410':null);row.uiRejectionObserved=row.uiRejectionLabel!==null;
  selected=events().filter(e=>e.trialId===row.trialId);row.noAuthenticationObserved=!selected.some(e=>['authenticated','snapshotLoaded','websocketOnline'].includes(e.event));
  const state=await api('city');row.cityIdentityPreserved=state.cityId===s.descriptor.cityId;
  if(!row.uiRejectionObserved||!row.noAuthenticationObserved||!row.cityIdentityPreserved)fail('REJECTION_PROOF_INCOMPLETE');row.success=true;row.stage='REJECTION_VERIFIED';
 }catch(e){row.driverExitStatus=e.driverExitStatus??(Number.isInteger(e.status)?e.status:null);row.errorClass=e.pilotCode||(abort.signal.aborted?'INTERRUPTED':row.stage+'_DRIVER_OR_PLATFORM_ERROR');}
 finally{
  if(row.cameraLaunchRequestedAt)try{row.cameraZoomObservations=cmd('exec-out','run-as','city.utopia.control','cat','files/scan-camera-events.jsonl').split(/\r?\n/).flatMap(line=>{try{const e=JSON.parse(line);if(e.event!=='cameraZoom'||Date.parse(e.timestamp)<Date.parse(row.cameraLaunchRequestedAt))return [];return [{timestamp:e.timestamp,supported:e.supported===true,observedRatioPercent:Number.isFinite(e.observedRatioPercent)?e.observedRatioPercent:null,requestedRatioPercent:Number.isFinite(e.requestedRatioPercent)?e.requestedRatioPercent:null,focusMode:['auto','continuous-picture','continuous-video','fixed','infinity','macro','edof'].includes(e.focusMode)?e.focusMode:null}];}catch{return [];}});}catch{row.cameraZoomObservations=[];}
  recordedEvents.push(...selected);row.driverEndTimestamp=now();try{cmd('shell','am','force-stop','city.utopia.control');cameraMayBeOpen=false;}catch{row.cameraExitConfirmed=false;row.success=false;row.errorClass??='CAMERA_EXIT_UNCONFIRMED';}save();}
 console.log(kind+' camera trial '+index+': '+(row.success?'PASS':row.errorClass));return row.success;
}
save();
try{
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:false});page=await browser.newPage({viewport:{width:1440,height:1000}});await measureRealPairingGeometry();
 if(mode==='all'||mode==='expired'){
  const s=await session();await display(s,'TEST: five-minute expiry preparation — do not scan yet');
  const until=Date.parse(s.expiresAt)+1500;console.log('Waiting for genuine default five-minute expiry; position camera at private display.');
  while(Date.now()<until)await sleep(Math.min(1000,until-Date.now()));
  const info=await api('pairing/info');if(info.activeSession)fail('SESSION_STILL_ACTIVE_AFTER_REAL_WAIT');
  await display(s,'TEST: expired QR — real camera rejection trial');
  for(let i=1;i<=2;i++)if(!await scan('expired',i,s,{sharedExpiredSession:true,sessionGroup:'expired-shared-1',createdAt:s.createdAt,expiresAt:s.expiresAt,scanPreparationElapsedMs:Date.now()-Date.parse(s.createdAt)}))break;
 }
 if(mode==='all'||mode==='replaced')for(let i=1;i<=2;i++){
  const original=await session(),replacement=await session();if(original.pairingSessionId===replacement.pairingSessionId)fail('SESSION_NOT_REPLACED');
  await display(original,'TEST: replaced QR — real camera rejection trial');await sleep(15000);
  if(Date.now()>=Date.parse(original.expiresAt))fail('REPLACED_QR_ALSO_EXPIRED');
  if(!await scan('replaced',i,original,{sharedExpiredSession:false,sessionGroup:'replaced-independent-'+i,createdAt:original.createdAt,expiresAt:original.expiresAt,replacedBeforeScan:true}))break;
 }
}catch(e){result.driverExitStatus=e.driverExitStatus??(Number.isInteger(e.status)?e.status:null);result.driverError=e.pilotCode||(abort.signal.aborted?'INTERRUPTED':'DRIVER_OR_PLATFORM_ERROR');process.exitCode=1;}
finally{
 if(cameraMayBeOpen){try{cmd('shell','am','force-stop','city.utopia.control');cameraMayBeOpen=false;}catch{result.cameraExitConfirmed=false;}}
 try{await page?.evaluate(()=>{document.getElementById('private-negative-qr')?.remove();document.getElementById('private-negative-label')?.remove();});await page?.setContent('<title>Negative QR pilot closed</title><p>Test material cleared.</p>');}catch{}
 await browser?.close();result.finishedAt=now();result.status=!result.driverError&&result.runs.length===(mode==='all'?4:2)&&result.runs.every(r=>r.success)?'PASS':'INCOMPLETE';if(result.status!=='PASS')process.exitCode=1;save();console.log('Sanitized camera-negative evidence: '+directory+'/runs.json');
}
