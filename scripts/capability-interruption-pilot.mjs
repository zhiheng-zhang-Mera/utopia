import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {buildDocx} from '../city/09-planning-knowledge/02-document-intake/document-readers/samples.mjs';
const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const snapshot=async()=>{const r=await fetch(url+'/api/v0/city',{headers:{Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'}});return r.json();};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={codeSha:execFileSync('git',['rev-parse','HEAD']).toString().trim(),startedAt:new Date().toISOString(),attempts:[]};
mkdirSync('.runtime/v03/recovery',{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:false}),page=await browser.newPage({locale:'en-US'});
try{
 await page.goto(url);await page.locator('#token').fill(config.token);await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Services"]').click();
 const bytes=Buffer.from(await buildDocx({paragraphs:Array.from({length:24000},(_,i)=>'Utopia generated recovery paragraph '+i)}));report.inputBytes=bytes.length;
 for(let attempt=0;attempt<3;attempt++){
  await page.locator('[data-service="planning.document.intake"]').click();await page.locator('#service-file').setInputFiles({name:'recovery.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:bytes});
  const old=new Set((await snapshot()).invocations.map(r=>r.invocationId));await page.locator('#service-invoke').click();let running;
  for(let i=0;i<100;i++){const row=(await snapshot()).invocations.find(r=>!old.has(r.invocationId));if(row){running=row;break;}await sleep(10);}
  if(!running)throw Error('NO_UI_INVOCATION');const observation={invocationId:running.invocationId,observedStatus:running.status,observedAt:new Date().toISOString()};report.attempts.push(observation);
  if(running.status!=='RUNNING')continue;
  execFileSync('powershell',['-NoProfile','-File','scripts/restart-gateway.ps1'],{windowsHide:true,timeout:30000,stdio:'ignore'});
  let after;for(let i=0;i<30;i++){await sleep(500);try{after=(await snapshot()).invocations.find(r=>r.invocationId===running.invocationId);if(after)break;}catch{}}
  Object.assign(observation,{recoveredStatus:after?.status,errorCode:after?.errorCode,resultDigest:after?.resultDigest});
  if(after?.status==='INTERRUPTED'&&after.errorCode==='GATEWAY_RESTARTED'&&!after.resultDigest){await page.reload();await page.locator('[data-page="Services"]').click();await page.locator('[data-invocation="'+after.invocationId+'"]').click();await page.locator('#service-state').filter({hasText:'INTERRUPTED'}).waitFor();observation.webInterruptedVisible=true;if(process.env.ADB){const {top,tap,tree,scroll}=await import('./android-ui-driver.mjs');await top();await tap('INTERRUPTED · '+after.invocationId);let nodes=await tree();for(let j=0;j<3&&!nodes.some(n=>n.text==='GATEWAY_RESTARTED');j++){await scroll('down',nodes);nodes=await tree();}observation.androidInterruptedVisible=nodes.some(n=>n.text==='INTERRUPTED')&&nodes.some(n=>n.text==='GATEWAY_RESTARTED');if(!observation.androidInterruptedVisible)throw Error('ANDROID_INTERRUPTION_NOT_VISIBLE');}report.status='PASS';break;}
  await page.reload();await page.locator('[data-page="Services"]').click();
 }
 if(report.status!=='PASS')throw Error('INTERRUPTION_NOT_OBSERVED');
}catch(e){report.status='FAIL';report.failure=String(e.message).split('\n')[0];process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();writeFileSync('.runtime/v03/recovery/interruption.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify(report));}
