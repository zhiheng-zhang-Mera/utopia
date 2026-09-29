import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {chromium} from 'playwright';
const exec=promisify(execFile),adb=process.env.ADB||'adb';
const command=async(...a)=>(await exec(adb,a,{timeout:30000,maxBuffer:8*1024*1024})).stdout;
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const headers={Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const dir='.runtime/evidence/v0.2';mkdirSync(dir,{recursive:true});
const codeSha=(await exec('git',['rev-parse','HEAD'])).stdout.trim();
const apkPath=(await command('shell','pm','path','city.utopia.control')).trim().replace(/^package:/,'');
const apkSha256=(await command('shell','sha256sum',apkPath)).trim().split(/\s/)[0];
const localApkSha256=createHash('sha256').update(readFileSync('apps/android/app/build/outputs/apk/debug/app-debug.apk')).digest('hex');
const installedApkMatchesLocal=apkSha256===localApkSha256;
if(!/^[a-f0-9]{64}$/.test(apkSha256)||!installedApkMatchesLocal)throw Error('INSTALLED_APK_MISMATCH');
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}});
let webTelemetry=null;
page.on('response',async r=>{if(r.url()===url+'/api/v0/city'&&r.ok()){try{webTelemetry=(await r.json()).nodes.find(n=>n.id==='alien-reference-node')?.telemetry;}catch{}}});
await page.goto(url);await page.getByLabel('Pairing token').fill(config.token);await page.getByRole('button',{name:'Connect',exact:true}).click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();
await page.locator('[data-page="Devices"]').click();await page.getByRole('button',{name:'Alien-PC',exact:true}).click();
await command('shell','input','tap','324','2195');await command('shell','input','tap','380','525');
const samples=[];let sampling=false;
async function sample(){if(sampling)return;sampling=true;try{const s=await(await fetch(url+'/api/v0/city',{headers})).json();samples.push({sampleTimestamp:new Date().toISOString(),host:s.nodes.find(n=>n.id==='alien-reference-node')?.telemetry,web:webTelemetry,webDisplayedMetrics:await page.locator('#detail .metrics').innerText()});}finally{sampling=false;}}
const timer=setInterval(()=>sample().catch(()=>{}),250);await sample();
try{
 await command('shell','uiautomator','dump','/sdcard/utopia-telemetry.xml');const xml=await command('shell','cat','/sdcard/utopia-telemetry.xml');
 writeFileSync(dir+'/android-telemetry.xml',xml);await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:dir+'/web-devices.png',fullPage:true});
 const screen=await exec(adb,['exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:8*1024*1024});writeFileSync(dir+'/android-devices.png',screen.stdout);
 const texts=[...xml.matchAll(/text="([^"]*)"/g)].map(m=>m[1]);const observed=texts.find(t=>t.startsWith('Observed: '))?.slice(10)||null;
 const matched=samples.find(s=>s.host?.observedAt===observed),webMatched=samples.some(s=>s.host?.observedAt===s.web?.observedAt&&JSON.stringify(s.host)===JSON.stringify(s.web));
 const data={codeSha,apkSha256,localApkSha256,installedApkMatchesLocal,sampledAt:new Date().toISOString(),androidObservedAt:observed,androidHostTimestampMatched:!!matched,webHostExactSampleMatched:webMatched,androidDisplayedMetrics:texts.filter(t=>/^(CPU:|Memory:|Disk:|Uptime:|Observed:)/.test(t)),samples,limitations:['Snapshots sampled every250ms; Android values are formatted display observations, not simultaneous atomic capture.','This single-machine observation does not establish cross-platform precision or performance.']};
 writeFileSync(dir+'/telemetry-consistency.json',JSON.stringify(data,null,2));console.log(JSON.stringify({androidHostTimestampMatched:!!matched,webHostExactSampleMatched:webMatched}));
}finally{clearInterval(timer);await browser.close();}
