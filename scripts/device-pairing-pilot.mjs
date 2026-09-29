import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const adb=process.env.ADB||'adb';
const cmd=(...a)=>execFileSync(adb,a,{timeout:30000,maxBuffer:8*1024*1024}).toString();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const mode=process.argv[2]||'mdns',runs=Number(process.argv[3]||5);
const scenario=process.argv[4]||'pairing',prefix=scenario==='pairing'?mode:mode+'-'+scenario;
if(!['mdns','ble','manual'].includes(mode))throw pilotError('Use mdns, ble, manual; QR requires physical camera');
const {url}=JSON.parse(readFileSync('.runtime/processes.json')),config=JSON.parse(readFileSync('.runtime/local-config.json'));
const headers={Authorization:'Bearer '+config.token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const nodes=()=>{cmd('shell','uiautomator','dump','/sdcard/utopia-pilot.xml');const xml=cmd('shell','cat','/sdcard/utopia-pilot.xml');return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));};
function pilotError(message){const e=new Error(message);e.pilotCode=message;return e;}
function tapNode(n){if(!n?.bounds)throw pilotError('UI element missing');const b=n.bounds.match(/\d+/g).map(Number);if(b.length!==4||b[2]<=b[0]||b[3]<=b[1])throw pilotError('UI target has zero bounds');cmd('shell','input','tap',String((b[0]+b[2])>>1),String((b[1]+b[3])>>1));}
async function tap(text){let n;for(let i=0;i<4;i++){n=nodes().find(n=>n.text===text);if(n)break;cmd('shell','input','swipe','540','1850','540','1000','350');}if(!n)throw pilotError('UI element missing: '+text);tapNode(n);await wait(400);}
function dismissSavePrompt(list){const later=list.find(n=>n.text==='以后');if(later){tapNode(later);return nodes();}return list;}
async function focusField(index){
 for(let retry=0;retry<3;retry++){
  const list=dismissSavePrompt(nodes()),field=list.filter(n=>n.class==='android.widget.EditText')[index];
  if(field){try{tapNode(field);}catch(e){if(e.pilotCode!=='UI target has zero bounds')throw e;}}
  else cmd('shell','input','swipe','540','1700','540','1100','250');
  await wait(250);
  const check=nodes().filter(n=>n.class==='android.widget.EditText')[index];if(check?.focused==='true')return;
 }
 throw pilotError('INPUT_FOCUS_NOT_CONFIRMED');
}
function type(value){if(!nodes().some(n=>n.class==='android.widget.EditText'&&n.focused==='true'))throw pilotError('INPUT_FOCUS_LOST');cmd('shell','input','text',value);}
function imeVisible(){const state=cmd('shell','dumpsys','input_method');return /(?:mInputShown|isInputViewShown|mIsInputViewShown)=true/.test(state);}
async function hideImeSafely(){if(imeVisible()){cmd('shell','input','keyevent','4');await wait(350);}const list=dismissSavePrompt(nodes());if(!list.some(n=>n.package==='city.utopia.control'))throw pilotError('APP_NOT_FOREGROUND_AFTER_INPUT');}
function diagnostic(run){
 const labels=new Set(['UTOPIA','Settings','Find your City / 找到你的城市','Find your City / 找到你的城市'.replaceAll('&','&amp;'),'Nearby Cities (LAN)','Nearby via Bluetooth','Manual connection','Pair','Connect','Pairing…','Short pairing code','Save and connect','ONLINE','OFFLINE','RECONNECTING','Bluetooth disabled','以后']);
 try{const list=nodes();const data={timestamp:new Date().toISOString(),appUiPresent:list.some(n=>n.package==='city.utopia.control'),imeVisible:imeVisible(),nodes:list.map(n=>({class:n.class,bounds:n.bounds,focused:n.focused==='true',enabled:n.enabled==='true',isApp:n.package==='city.utopia.control',label:n.class==='android.widget.EditText'||n.password==='true'?null:labels.has(n.text)?n.text:n.text?.includes('HTTP 403')?'HTTP 403':null}))};writeFileSync('.runtime/evidence/v0.2/'+prefix+'-failure-'+run+'.json',JSON.stringify(data,null,2));}catch{writeFileSync('.runtime/evidence/v0.2/'+prefix+'-failure-'+run+'.json',JSON.stringify({timestamp:new Date().toISOString(),diagnostic:'UNAVAILABLE'}));}
}
mkdirSync('.runtime/evidence/v0.2',{recursive:true});
const archiveTag=new Date().toISOString().replace(/[:.]/g,'-');
for(const suffix of ['-runs.json','-events.jsonl']){const path='.runtime/evidence/v0.2/'+prefix+suffix;if(existsSync(path))copyFileSync(path,'.runtime/evidence/v0.2/'+prefix+'-prior-'+archiveTag+suffix);}
const rows=[];
const codeSha=execFileSync('git',['rev-parse','HEAD']).toString().trim();
const installed=cmd('shell','pm','path','city.utopia.control').trim().replace(/^package:/,'');
const apkSha256=cmd('shell','sha256sum',installed).trim().split(/\s/)[0];
const localHash=createHash('sha256').update(readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex');
if(apkSha256!==localHash)throw pilotError('Install the current APK before running pilots');
for(let i=0;i<runs;i++){
 const start=new Date().toISOString();let error=null;
 try{
  cmd('shell','am','force-stop','city.utopia.control');cmd('shell','am','start','-n','city.utopia.control/.MainActivity');await wait(2500);dismissSavePrompt(nodes());
  cmd('shell','input','tap','970','2195');await tap('Clear pairing / Find your City');
  const session=await(await fetch(url+'/api/v0/pairing/session',{method:'POST',headers,body:'{}'})).json();
  await tap(mode==='mdns'?'Nearby Cities (LAN)':mode==='ble'?'Nearby via Bluetooth':'Manual connection');
  if(mode==='manual'){
   await focusField(0);cmd('shell','input','keyevent','KEYCODE_MOVE_END');for(let j=0;j<7;j++)cmd('shell','input','keyevent','KEYCODE_DEL');type(url);
   await focusField(1);type(config.token);await hideImeSafely();await tap('Save and connect');
  }else{
   let found=false;for(let j=0;j<6;j++){if(nodes().some(n=>n.text==='Pair')){found=true;break;}await wait(1000);}if(!found)throw pilotError('Discovery timeout');
   await tap('Pair');cmd('shell','input','swipe','540','1850','540','1050','350');
   await focusField(0);type(scenario==='wrong-code'?(session.shortCode==='000000'?'111111':'000000'):session.shortCode);await hideImeSafely();await tap('Connect');
  }
  if(scenario==='wrong-code'){
   cmd('shell','input','swipe','540','800','540','1850','350');
   const n=nodes();if(!n.some(x=>x.text?.includes('HTTP 403'))||n.some(x=>x.text==='ONLINE'))throw pilotError('Wrong code rejection missing');
  }else {let online=false;for(let j=0;j<5;j++){const n=dismissSavePrompt(nodes());if(n.some(x=>x.text==='Alien-PC')&&n.some(x=>x.text==='ONLINE')){online=true;break;}await wait(1000);}if(!online)throw pilotError('Online device timeout');}
 }catch(e){error=e.pilotCode||'DRIVER_OR_PLATFORM_ERROR';diagnostic(i+1);}
 rows.push({mode,scenario,run:i+1,codeSha,apkSha256,start,end:new Date().toISOString(),success:!error,errorClass:error,driver:'ADB UI; no discovery injection'});
 writeFileSync('.runtime/evidence/v0.2/'+prefix+'-runs.json',JSON.stringify(rows,null,2));
 console.log(mode,i+1,error||'PASS');if(error)break;
}
const log=cmd('exec-out','run-as','city.utopia.control','cat','files/pairing-events.jsonl');
writeFileSync('.runtime/evidence/v0.2/'+prefix+'-events.jsonl',log);
console.log('APK SHA256',createHash('sha256').update(readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex'));
