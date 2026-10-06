import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {startAgent} from '../agents/reference-node/agent.mjs';
test('Research Web starts real canonical campaign, observes progress and failed or excluded receipts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex803-web-'));const app=await createGateway({dir,port:0,token:'ctl',nodeToken:'node',roomsDisabled:true});
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});let agent;
 try{
  agent=await startAgent({url:app.url,token:'node',id:'host',workspace:join(dir,'worker'),interval:5,stepDelay:5,telemetryEnabled:false});
  await page.goto(app.url);await page.locator('#token').fill('ctl');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Research"]').click();
  await page.locator('#campaign-scenario').waitFor({timeout:2000});
  const city=await (await fetch(app.url+'/api/v0/city',{headers:{Authorization:'Bearer ctl','X-City-Api-Version':'0','X-City-Schema-Version':'0'}})).json();
  const m={experimentId:'web-campaign',question:'Do safe tasks repeat?',topology:'SINGLE_CITY',hosts:['host'],workers:['host'],controlSurfaces:[city.controlSurfaces[0].clientRef],variables:{independent:['target'],dependent:['latency'],controls:['type']},repetitions:2,seedPolicy:'PER_REPETITION',baseSeed:19,requiredCapabilities:['research.evidence.review'],stopConditions:[{kind:'MAX_REPETITIONS',value:2}],artifactPolicy:{retention:'SUMMARY_ONLY'},acceptance:{primary:'2 runs complete'},softwareRefs:['utopia@1a26d7499d3de39b19c3136c3032e8ccd9343428']};
  await page.locator('#research-manifest').fill(JSON.stringify(m));await page.locator('#research-register').click();await page.locator('[data-experiment="web-campaign"]').waitFor();await page.locator('[data-experiment="web-campaign"]').click();
  await page.locator('#campaign-experiment').fill('web-campaign');await page.locator('#campaign-repetitions').fill('2');await page.locator('#campaign-warmups').fill('1');await page.locator('#campaign-timeout').fill('2000');await page.locator('#campaign-start').click();
  await page.locator('#campaign-output').filter({hasText:'COMPLETED'}).waitFor();assert.equal(app.store.list('tasks').filter(t=>t.state==='COMPLETED').length,3);assert.match(await page.locator('#campaign-output').innerText(),/WARMUP/);
  await mkdir('evidence/raw/mission-book/REX-803',{recursive:true});await page.screenshot({path:'evidence/raw/mission-book/REX-803/research-campaign.png',fullPage:true});
 }finally{await browser.close();await agent?.stop();await app.close();await rm(dir,{recursive:true,force:true});}
});
