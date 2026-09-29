import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const adb=process.env.ADB||'adb';
const cmd=(...a)=>execFileSync(adb,a,{timeout:25000,maxBuffer:8*1024*1024}).toString();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const kind=process.argv[2],count=Number(process.argv[3]||3);
if(!['wifi','gateway','node'].includes(kind))throw Error('Use wifi, gateway, node');
const config=JSON.parse(readFileSync('.runtime/local-config.json'));let processes=JSON.parse(readFileSync('.runtime/processes.json'));
const headers={Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const codeSha=execFileSync('git',['rev-parse','HEAD']).toString().trim();
const apkPath=cmd('shell','pm','path','city.utopia.control').trim().replace(/^package:/,'');
const apkSha256=cmd('shell','sha256sum',apkPath).trim().split(/\s/)[0];
const localApkSha256=createHash('sha256').update(readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex');
const installedApkMatchesLocal=apkSha256===localApkSha256;
if(!/^[a-f0-9]{64}$/.test(apkSha256)||!installedApkMatchesLocal)throw Error('INSTALLED_APK_MISMATCH');
const snapshot=async()=>{const r=await fetch(processes.url+'/api/v0/city',{headers,signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('Snapshot '+r.status);return r.json();};
const env={...process.env,CITY_HOST:new URL(processes.url).hostname,CITY_PORT:new URL(processes.url).port,CITY_URL:processes.url,CITY_TOKEN:config.token,CITY_NODE_TOKEN:config.nodeToken,CITY_DATA:resolve('.runtime'),CITY_WORKSPACE:resolve('.runtime/workspace')};
function restart(which){const main=which==='gateway'?'services/dev-gateway/main.mjs':'agents/reference-node/main.mjs';const child=spawn(process.execPath,[main],{env,cwd:process.cwd(),detached:true,windowsHide:true,stdio:['ignore',openSync('.runtime/'+which+'.log','a'),openSync('.runtime/'+which+'-error.log','a')]});child.unref();processes[which==='gateway'?'gatewayPid':'agentPid']=child.pid;writeFileSync('.runtime/processes.json',JSON.stringify(processes));}
function tree(){cmd('shell','uiautomator','dump','/sdcard/utopia-recovery.xml');return cmd('shell','cat','/sdcard/utopia-recovery.xml');}
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();await page.goto(processes.url);await page.getByLabel('Pairing token').fill(config.token);await page.getByRole('button',{name:'Connect',exact:true}).click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();
const rows=[];let serviceStopped=false;mkdirSync('.runtime/evidence/v0.2',{recursive:true});
try{for(let i=0;i<count;i++){
 const before=await snapshot(),row={kind,run:i+1,codeSha,apkSha256,localApkSha256,installedApkMatchesLocal,disconnectAt:new Date().toISOString(),offlineObservedAt:null,restoreAt:null,onlineObservedAt:null,historyPreserved:null,cityIdentityPreserved:null,observations:[]};
 if(kind==='wifi')cmd('shell','svc','wifi','disable');else {
  const pid=processes[kind==='gateway'?'gatewayPid':'agentPid'];
  const actual=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}' | Select-Object CommandLine | ConvertTo-Json -Compress`],{windowsHide:true}).toString());
  const expected=kind==='gateway'?'services/dev-gateway/main.mjs':'agents/reference-node/main.mjs';
  if(!actual?.CommandLine?.includes(expected))throw Error('Recorded process identity mismatch');
  process.kill(pid);serviceStopped=true;
 }
 let offline=false;
 for(let j=0;j<5;j++){await wait(2000);const androidCaptureStartedAt=new Date().toISOString();const xml=tree(),at=new Date().toISOString();const appNodes=[...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>m[1]).filter(n=>/package="city\.utopia\.control"/.test(n));const androidUiPresent=appNodes.some(n=>/text="UTOPIA"/.test(n));const android=appNodes.flatMap(n=>[...n.matchAll(/text="(ONLINE|OFFLINE|UNKNOWN|RECONNECTING)[^"]*"/g)].map(m=>m[1]));const web=await page.locator('#connection').innerText();const webNode=await page.locator('.device-card .badge').first().innerText();row.observations.push({androidCaptureStartedAt,at,androidUiPresent,android,web,webNode});if(androidUiPresent && (kind==='node'?(android.includes('OFFLINE') && webNode==='OFFLINE'):(!android.includes('ONLINE') && android.some(s=>['OFFLINE','UNKNOWN','RECONNECTING'].includes(s)) && (kind!=='gateway'||webNode==='UNKNOWN')))){offline=true;row.offlineObservedAt=at;writeFileSync(`.runtime/evidence/v0.2/${kind}-${i+1}-offline.xml`,xml);break;}}
 row.restoreAt=new Date().toISOString();if(kind==='wifi')cmd('shell','svc','wifi','enable');else {restart(kind);serviceStopped=false;}
 let online=false;
 for(let j=0;j<8;j++){await wait(2000);const androidCaptureStartedAt=new Date().toISOString();const xml=tree(),at=new Date().toISOString();const appNodes=[...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>m[1]).filter(n=>/package="city\.utopia\.control"/.test(n));const androidUiPresent=appNodes.some(n=>/text="UTOPIA"/.test(n));const android=appNodes.flatMap(n=>[...n.matchAll(/text="(ONLINE|OFFLINE|UNKNOWN|RECONNECTING)[^"]*"/g)].map(m=>m[1]));const web=await page.locator('#connection').innerText();const webNode=await page.locator('.device-card .badge').first().innerText();row.observations.push({androidCaptureStartedAt,at,androidUiPresent,android,web,webNode});if(androidUiPresent&&android.filter(s=>s==='ONLINE').length>=2&&!android.includes('OFFLINE')&&web==='ONLINE'&&webNode==='ONLINE'){online=true;row.onlineObservedAt=at;break;}}
 const after=await snapshot();row.cityIdentityPreserved=before.cityId===after.cityId;row.historyPreserved=before.tasks.every(t=>after.tasks.some(x=>x.id===t.id&&x.state===t.state))&&before.events.every(e=>after.events.some(x=>x.id===e.id));row.success=offline&&online&&row.cityIdentityPreserved&&row.historyPreserved;rows.push(row);writeFileSync('.runtime/evidence/v0.2/'+kind+'-recovery.json',JSON.stringify(rows,null,2));console.log(kind,i+1,row.success?'PASS':'FAIL');if(!row.success)break;
}}finally{if(kind==='wifi')cmd('shell','svc','wifi','enable');if(serviceStopped)restart(kind);await browser.close();}
