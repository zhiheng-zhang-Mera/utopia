import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
const call=async(app,path,body,credential='owner')=>{const response=await fetch(`${app.url}/api/v0/${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};

test('REX805 Web owner selects recorded run and executes real replay/ablation from Research',async()=>{
 const dir=await mkdtemp(resolve('.scratch-rex805-web-'));let app,browser,workerLoop,stop=false;
 try{
  app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});
  const workers=['web-replay-a','web-replay-b'];
  for(const id of workers)await call(app,'node/register',{id,displayName:id,capabilities:['task.execute.safe','filesystem.temp'],roles:['EXECUTION_NODE'],metadata:{platform:'win32'}},'node');
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
  const page=await browser.newPage({locale:'en-US'});page.setDefaultTimeout(15000);
  await page.goto(app.url+'/#token=owner');await page.locator('#connection.online').waitFor();
  const topology=(await call(app,'research/campaigns')).body.topology;
  const manifest={experimentId:'web-replay-original',question:'Replay on real canonical tasks',topology:'TWO_HOST_MESH',hosts:workers,workers,controlSurfaces:topology.surfaces.map(s=>s.ref),variables:{independent:['scenario'],dependent:['assignment'],controls:['input']},repetitions:3,seedPolicy:'PER_REPETITION',baseSeed:7,requiredCapabilities:['research.evidence.review'],stopConditions:[{kind:'MAX_REPETITIONS',value:3}],artifactPolicy:{retention:'BOUNDED_TRACE'},acceptance:{primary:'placement'},softwareRefs:['utopia@'+'0'.repeat(40)]};
  assert.equal((await call(app,'research/experiments',{manifest})).status,200);
  workerLoop=(async()=>{while(!stop){for(const id of workers){const task=(await call(app,'node/claim',{id},'node')).body.task;if(task){await call(app,'node/report',{id,taskId:task.id,state:'RUNNING',progress:50},'node');await call(app,'node/report',{id,taskId:task.id,state:'COMPLETED',progress:100,result:{ok:true}},'node');}}await new Promise(r=>setTimeout(r,15));}})();
  const started=(await call(app,'research/campaigns',{experimentId:manifest.experimentId,scenarioId:'WAIT',repetitions:3,seed:'original'})).body.started;
  for(let i=0;i<200&&app.campaigns.progress().state==='RUNNING';i++)await new Promise(r=>setTimeout(r,10));assert.equal(app.campaigns.progress().state,'COMPLETED');
  await page.locator('[data-page="ResearchCampaign"]').click();await page.locator('#research-campaign[data-loaded="true"]').waitFor();
  assert.equal(await page.locator('#rr-replay').count(),1,'Research must expose the replay control');
  await page.locator('#research-replay[data-loaded="true"]').waitFor();
  await page.locator('#rr-source').selectOption(started.campaignId);
  await page.waitForFunction(()=>document.querySelectorAll('#rr-run option').length===3);
  await page.locator('#rr-run').selectOption('1');await page.locator('#rr-replay').click();
  await page.waitForFunction(()=>document.querySelector('#rr-comparison')?.textContent.includes('COMPLETED'));
  assert.equal(app.campaigns.progress().measured[0].result.assignedNodeId,workers[1]);
  await page.waitForFunction(id=>document.querySelector('#rc-status')?.textContent.includes('COMPLETED')&&document.querySelector('#rc-technical')?.textContent.includes(id),app.campaigns.progress().campaignId);
  await page.locator('#rr-ablation').click();
  await page.waitForFunction(()=>document.querySelector('#rr-comparison')?.textContent.includes('ABLATION')&&document.querySelector('#rr-comparison')?.textContent.includes('COMPLETED'));
  assert.equal(app.campaigns.progress().measured[0].result.assignedNodeId,workers[0]);
  assert.match(await page.locator('#rr-caveat').innerText(),/not.*causal|not.*performance/i);
 }finally{stop=true;await workerLoop;await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});

test('REX805 Web switching source discards a delayed comparison from the previous selection',async()=>{
 const dir=await mkdtemp(resolve('.scratch-rex805-web-stale-'));let app,browser;
 try{
  app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage();await page.goto(app.url+'/');
  await page.evaluate(async()=>{
   const {createResearchReplayView}=await import('/research-replay.js');
   const host=document.createElement('div');host.id='replay-boundary-test';document.body.append(host);
   const sources=['source-a','source-b'].map(campaignId=>({campaignId,scenarioId:'WAIT',state:'COMPLETED'}));let calls=0;
   const source=campaignId=>({campaignId,context:{manifest:{workers:['a','b']}},runs:[{index:1,warmup:false,state:'MEASURED',result:{taskRef:'task'}}]});
   const api=async(path,body)=>{
    if(path==='research/replays'&&!body)return {sources};if(path==='research/replays'&&body)return {started:{campaignId:'new-run'}};
    if(path.startsWith('research/campaigns/'))return {campaign:source(path.split('/').at(-1))};
    if(path==='research/replays/new-run'){calls++;if(calls===1)return {comparison:{state:'PENDING'}};window.delayedRequested=true;return new Promise(resolve=>{window.finishOld=()=>resolve({comparison:{state:'COMPLETED',mode:'OLD_SELECTION'}});});}
   };
   const view=createResearchReplayView();window.boundaryView=view;view.render(()=>host,{contextKey:'city-a',online:true,api,isCurrent:()=>true});
  });
  await page.waitForFunction(()=>document.querySelector('#replay-boundary-test #rr-run option')!==null);await page.locator('#replay-boundary-test #rr-replay').click();
  await page.waitForFunction(()=>window.delayedRequested===true);await page.locator('#replay-boundary-test #rr-source').selectOption('source-b');
  await page.waitForFunction(()=>document.querySelector('#replay-boundary-test #rr-run option')!==null);
  await page.evaluate(()=>window.finishOld());await page.waitForTimeout(50);
  assert.equal(await page.locator('#replay-boundary-test #rr-comparison').count(),0,'old source response must not reappear after selection changed');
  await page.evaluate(()=>window.boundaryView.reset());
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
