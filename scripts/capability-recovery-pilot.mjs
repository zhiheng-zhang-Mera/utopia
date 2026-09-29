import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {cmd,tree,top,pause} from './android-ui-driver.mjs';
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const snapshot=async()=>{const r=await fetch(url+'/api/v0/city',{headers:{Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'}});return r.json();};
const report={codeSha:execFileSync('git',['rev-parse','HEAD']).toString().trim(),startedAt:new Date().toISOString(),checks:[]};
mkdirSync('.runtime/v03/recovery',{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:false}),page=await browser.newPage({locale:'en-US'});
const check=(name,pass,details={})=>{report.checks.push({name,pass,...details});if(!pass)throw Error(name);};
const texts=nodes=>nodes.map(n=>n.text).join('\n');
function runEnabled(nodes){const text=nodes.find(n=>n.text==='Run service');let n=text;while(n&&n.clickable!=='true')n=n.parent;return n?.enabled==='true';}
try{
 await page.goto(url);await page.locator('#token').fill(config.token);await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Services"]').click();
 const before=await snapshot(),retained=before.invocations.filter(r=>r.status==='COMPLETED').map(r=>({id:r.invocationId,digest:r.resultDigest}));
 await top();cmd('shell','svc','wifi','disable');let nodes;
 for(let i=0;i<8;i++){await pause(1000);nodes=await tree();if(texts(nodes).includes('Cached · offline'))break;}
 check('android-wifi-offline-disabled',texts(nodes).includes('Cached · offline')&&!runEnabled(nodes));
 check('windows-authority-remains-online',(await page.locator('#connection').innerText()).includes('ONLINE'));
 cmd('shell','svc','wifi','enable');
 for(let i=0;i<12;i++){await pause(1000);nodes=await tree();if(texts(nodes).includes('Live City authority'))break;}
 check('android-wifi-reconnected',texts(nodes).includes('Live City authority')&&runEnabled(nodes));
 const afterWifi=await snapshot();check('wifi-no-duplicate-invocations',afterWifi.invocations.length===before.invocations.length);
 execFileSync('powershell',['-NoProfile','-File','scripts/restart-gateway.ps1'],{windowsHide:true,timeout:30000,stdio:'ignore'});
 await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor({timeout:30000});let after;
 for(let i=0;i<15;i++){await pause(1000);try{after=await snapshot();nodes=await tree();if(texts(nodes).includes('Live City authority'))break;}catch{}}
 check('gateway-city-and-results-preserved',after?.cityId===before.cityId&&retained.every(r=>after.invocations.some(i=>i.invocationId===r.id&&i.resultDigest===r.digest&&i.status==='COMPLETED')),{retainedCount:retained.length});
 check('android-gateway-reconnected',texts(nodes).includes('Live City authority')&&runEnabled(nodes));
 report.status='PASS';
}catch(e){report.status='FAIL';report.failure=String(e.message).split('\n')[0];process.exitCode=1;}
finally{cmd('shell','svc','wifi','enable');report.finishedAt=new Date().toISOString();writeFileSync('.runtime/v03/recovery/connectivity.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report));}
