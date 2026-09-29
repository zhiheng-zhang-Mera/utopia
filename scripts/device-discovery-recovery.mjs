import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

// Real UI discovery only. Run after other phone pilots: node scripts/device-discovery-recovery.mjs [all|ble|mdns]
const mode=process.argv[2]||'all';
if(!['all','ble','mdns'].includes(mode))throw Error('Use all, ble, or mdns');
const adb=process.env.ADB||'adb';
const adbCall=(...args)=>execFileSync(adb,args,{timeout:30000,maxBuffer:8*1024*1024,windowsHide:true}).toString();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const now=()=>new Date().toISOString();
const fail=code=>{const e=new Error(code);e.pilotCode=code;throw e;};
const dir=resolve('.runtime/evidence/v0.2');mkdirSync(dir,{recursive:true});
const config=JSON.parse(readFileSync('.runtime/local-config.json'));
let processes=JSON.parse(readFileSync('.runtime/processes.json'));
const origin=new URL(processes.url);if(origin.port!=='4310')fail('MAIN_GATEWAY_PORT_REQUIRED');
const headers={'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const info=async()=>{const response=await fetch(processes.url+'/api/v0/pairing/info',{headers,signal:AbortSignal.timeout(4000)});if(!response.ok)fail('PAIRING_INFO_UNAVAILABLE');return response.json();};
const initial=await info(),mainCity=initial.cityId;
if(!mainCity)fail('MAIN_CITY_ID_MISSING');
const codeSha=execFileSync('git',['rev-parse','HEAD'],{windowsHide:true}).toString().trim();
const installed=adbCall('shell','pm','path','city.utopia.control').trim().replace(/^package:/,'');
const apkSha256=adbCall('shell','sha256sum',installed).trim().split(/\s/)[0];
const expectedHash=createHash('sha256').update(readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex');
if(apkSha256!==expectedHash)fail('INSTALLED_APK_MISMATCH');
const result={codeSha,apkSha256,mainCity,startedAt:now(),driver:'ADB UI; native discovery; no injected descriptor',runs:[]};
const save=()=>writeFileSync(resolve(dir,'discovery-recovery.json'),JSON.stringify(result,null,2));
const xmlDecode=s=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const xmlEscape=s=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function tree(){adbCall('shell','uiautomator','dump','/sdcard/utopia-discovery-recovery.xml');const xml=adbCall('shell','cat','/sdcard/utopia-discovery-recovery.xml');const nodes=[...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],xmlDecode(a[2])])));return {xml,nodes};}
function safeSnapshot(frame,name){
 // Persist an allowlisted UI XML projection; omit input text and all other attributes.
 const secrets=[config.token,config.nodeToken].filter(Boolean);
 const clean=value=>{let s=value||'';for(const secret of secrets)s=s.split(secret).join('[REDACTED]');return s.replace(/utopia:\/\/pair\?[^\s]*/g,'[PAIRING_MATERIAL_REDACTED]');};
 const xml='<?xml version="1.0" encoding="UTF-8"?>\n<hierarchy>'+frame.nodes.map(n=>'<node text="'+xmlEscape(n.class==='android.widget.EditText'||n.password==='true'?'':clean(n.text))+'" class="'+xmlEscape(n.class||'')+'" bounds="'+xmlEscape(n.bounds||'')+'" enabled="'+xmlEscape(n.enabled||'')+'"/>').join('')+'</hierarchy>\n';
 writeFileSync(resolve(dir,name),xml);return name;
}
function tapNode(n){if(!n?.bounds)fail('UI_TARGET_MISSING');const bounds=n.bounds.match(/\d+/g).map(Number);adbCall('shell','input','tap',String((bounds[0]+bounds[2])>>1),String((bounds[1]+bounds[3])>>1));}
async function tap(text){const frame=tree(),node=frame.nodes.find(n=>n.text===text);tapNode(node);await sleep(500);}
async function waitFor(predicate,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){const frame=tree();if(predicate(frame.nodes))return frame;await sleep(1200);}fail('UI_OBSERVATION_TIMEOUT');}
const hasCity=nodes=>nodes.some(n=>n.text===mainCity)&&nodes.some(n=>n.text===processes.url);
async function openFind(){
 adbCall('shell','am','force-stop','city.utopia.control');adbCall('shell','am','start','-n','city.utopia.control/.MainActivity');
 await waitFor(nodes=>nodes.some(n=>n.text==='Settings'));
 // Compose navigation label reports zero bounds on the pilot handset; use its verified clickable parent center after readiness.
 adbCall('shell','input','tap','970','2195');await sleep(500);await waitFor(nodes=>nodes.some(n=>n.text==='Clear pairing / Find your City'));
 await tap('Clear pairing / Find your City');await waitFor(nodes=>nodes.some(n=>n.text==='Nearby Cities (LAN)'));
}
async function discover(kind){await tap(kind==='ble'?'Nearby via Bluetooth':'Nearby Cities (LAN)');return waitFor(hasCity,35000);}
function verifiedGatewayPid(){
 const latest=JSON.parse(readFileSync('.runtime/processes.json'));if(latest.gatewayPid!==processes.gatewayPid||latest.url!==processes.url)fail('PROCESS_RECORD_CHANGED');
 const pid=Number(processes.gatewayPid);if(!Number.isSafeInteger(pid)||pid<=0||pid===process.pid)fail('INVALID_GATEWAY_PID');
 const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; $p | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
 const actual=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,timeout:10000}).toString()||'null');
 const norm=s=>String(s||'').replaceAll('\\','/').toLowerCase();
 if(!actual||actual.ProcessId!==pid||norm(actual.ExecutablePath)!==norm(process.execPath)||!norm(actual.CommandLine).includes('services/dev-gateway/main.mjs'))fail('GATEWAY_PROCESS_IDENTITY_REJECTED');
 return pid;
}
const env={...process.env,CITY_HOST:origin.hostname,CITY_PORT:origin.port,CITY_URL:processes.url,CITY_TOKEN:config.token,CITY_NODE_TOKEN:config.nodeToken,CITY_DATA:resolve('.runtime'),CITY_WORKSPACE:resolve('.runtime/workspace'),CITY_DISCOVERY_DISABLED:'0'};
function restartGateway(){
 const out=openSync('.runtime/gateway.log','a'),err=openSync('.runtime/gateway-error.log','a');
 const child=spawn(process.execPath,['services/dev-gateway/main.mjs'],{cwd:process.cwd(),env,windowsHide:true,detached:true,stdio:['ignore',out,err]});
 child.unref();closeSync(out);closeSync(err);if(!child.pid)fail('GATEWAY_RESTART_FAILED');
 processes={...JSON.parse(readFileSync('.runtime/processes.json')),gatewayPid:child.pid};writeFileSync('.runtime/processes.json',JSON.stringify(processes,null,2));
}
async function waitGateway(){for(let i=0;i<20;i++){try{const current=await info();if(current.cityId!==mainCity)fail('CITY_IDENTITY_CHANGED');return;}catch(e){if(e.pilotCode==='CITY_IDENTITY_CHANGED')throw e;await sleep(1000);}}fail('GATEWAY_RESTART_TIMEOUT');}
let bluetoothCommand=null;
async function setBluetooth(value){
 if(!bluetoothCommand){const readHelp=(...args)=>{const r=spawnSync(adb,['shell',...args],{encoding:'utf8',windowsHide:true,timeout:10000});return (r.stdout||'')+(r.stderr||'');};const help=readHelp('cmd','bluetooth_manager','help');if(help && !help.includes('No shell command implementation'))bluetoothCommand=['cmd','bluetooth_manager'];else {const fallback=readHelp('svc','bluetooth');if(!fallback.includes('[enable|disable]'))fail('BLUETOOTH_SHELL_UNSUPPORTED');bluetoothCommand=['svc','bluetooth'];}result.bluetoothToggleDriver=bluetoothCommand.join(' ');}
 const response=spawnSync(adb,['shell',...bluetoothCommand,value],{encoding:'utf8',windowsHide:true,timeout:30000});
 const record={action:value,at:now(),exitStatus:response.status,errorClass:response.error?.code||null,observedState:null};
 (result.bluetoothToggleCommands??=[]).push(record);
 for(let i=0;i<20;i++){record.observedState=adbCall('shell','settings','get','global','bluetooth_on').trim();if(record.observedState===(value==='enable'?'1':'0'))return;await sleep(500);}
 fail('BLUETOOTH_STATE_DID_NOT_CHANGE');
}
let needsBluetoothRestore=false,needsGatewayRestore=false;
save();
try{
 for(const kind of mode==='all'?['ble','mdns']:[mode])for(let i=1;i<=2;i++){
  const row={kind,run:i,startTimestamp:now(),discoveryTimestamp:null,disabledAt:null,unavailableObservedAt:null,restoreAt:null,recoveredAt:null,retryCount:0,success:false,errorClass:null,snapshots:[]};result.runs.push(row);save();
  try{
   await openFind();const before=await discover(kind);row.discoveryTimestamp=now();row.snapshots.push(safeSnapshot(before,`${kind}-discovery-${i}-before.xml`));
   row.disabledAt=now();
   if(kind==='ble'){needsBluetoothRestore=true;await setBluetooth('disable');await sleep(17000);}
   else {const pid=verifiedGatewayPid();process.kill(pid);needsGatewayRestore=true;await sleep(3000);}
   const absent=await waitFor(nodes=>!hasCity(nodes)&&(kind!=='ble'||nodes.some(n=>n.text==='Bluetooth disabled')),35000);row.unavailableObservedAt=now();row.snapshots.push(safeSnapshot(absent,`${kind}-discovery-${i}-unavailable.xml`));save();
   row.restoreAt=now();
   if(kind==='ble'){await setBluetooth('enable');needsBluetoothRestore=false;await sleep(3000);await waitFor(nodes=>nodes.some(n=>n.text==='Bluetooth enabled · tap Nearby via Bluetooth to scan'));row.enabledRetryPromptObserved=true;}
   else {restartGateway();needsGatewayRestore=false;await waitGateway();}
   row.retryCount++;const recovered=await discover(kind);row.recoveredAt=now();row.snapshots.push(safeSnapshot(recovered,`${kind}-discovery-${i}-recovered.xml`));
   const authority=await info();row.cityIdentityPreserved=authority.cityId===mainCity;row.success=row.cityIdentityPreserved;
  }catch(e){row.errorClass=e.pilotCode||'DRIVER_OR_PLATFORM_ERROR';}
  finally{row.endTimestamp=now();save();}
  console.log(kind,i,row.success?'PASS':row.errorClass||'FAIL');if(!row.success)break;
 }
}finally{
 if(needsBluetoothRestore){try{await setBluetooth('enable');result.bluetoothRestoredAfterFailure=true;}catch{result.bluetoothRestoredAfterFailure=false;}}
 if(needsGatewayRestore){try{restartGateway();await waitGateway();result.gatewayRestoredAfterFailure=true;}catch{result.gatewayRestoredAfterFailure=false;}}
 result.finishedAt=now();save();
}
