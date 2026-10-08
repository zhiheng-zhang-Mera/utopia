import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {enrollWithCity} from '../apps/client/device-enrollment.mjs';

const V={'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const owner={...V,Authorization:'Bearer wiring-owner','Content-Type':'application/json'};
const campaignId='campaign-5face000-0000-4000-8000-000000000001';
async function rig(run){
 const dir=await mkdtemp(resolve('.scratch-rex807-wiring-'));let app,browser;
 try{
  await mkdir(resolve(dir,'research','campaigns'),{recursive:true});
  await writeFile(resolve(dir,'research','campaigns',campaignId+'.json'),JSON.stringify({
   campaignId,scenarioId:'WAIT',state:'COMPLETED',reason:'REPETITIONS_FINISHED',repetitions:1,warmup:0,totalRuns:1,startedAt:1000,finishedAt:8000,
   runs:[{index:0,state:'MEASURED',seed:7,warmup:false,measured:true,durationMs:7000,result:{taskRef:'Q-held',state:'COMPLETED',assignedNodeId:'worker',result:{waitedMs:6000}}}],
   context:{experimentId:'held-exp',manifestIdentity:'held-id',manifest:{topology:'TWO_HOST_MESH',hosts:['worker'],workers:['worker'],controlSurfaces:['surface'],repetitions:1,seedPolicy:'PER_REPETITION',baseSeed:1,stopConditions:[],acceptance:{},softwareRefs:[]}},
   summary:{planned:1,accounted:1,warmup:0,measured:1,timedOut:0,failed:0,excluded:0,cancelled:0,skipped:0,interrupted:0,terminalAccountingComplete:true}
  }));
  app=await createGateway({dir,port:0,token:'wiring-owner',nodeToken:'wiring-node',roomsDisabled:true});
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
  const page=await browser.newPage({locale:'en-US',acceptDownloads:true});
  const enter=async(token='wiring-owner')=>{await page.goto(app.url);await page.locator('#token').fill(token);await page.locator('#connect').click();await page.locator('#connection.online').waitFor();await page.locator('[data-page="Research"]').click();await page.waitForFunction(()=>document.querySelector('#research-refresh')&&!document.querySelector('#research-refresh').disabled);};
  await run({app,page,enter,dir});
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}

test('REX807 shipped CSV bytes equal the gateway metricsCsv rather than its JSON envelope',()=>rig(async({app,page,enter})=>{
 const expected=await(await fetch(app.url+'/api/v0/research/artifacts?format=csv',{headers:owner})).json();
 await enter();await page.locator('#research-export > summary').click();
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#research-export-csv').click()]);
 const text=await readFile(await download.path(),'utf8');
 assert.equal(text,expected.metricsCsv);
 assert.match(text,/^metric,scope,value,reason,n,provenance\n/);
}));

test('REX807 shipped metrics and source disclosures come from the held artifact',()=>rig(async({app,page,enter})=>{
 const body=await(await fetch(app.url+'/api/v0/research/artifacts',{headers:owner})).json();
 await enter();
 const metrics=await page.locator('#research-metrics-body').innerText();
 for(const row of body.artifact.metrics){
  assert.ok(metrics.includes(row.metric),row.metric+' must be visible');
  assert.equal(await page.locator(`[data-metric="${row.metric}"] strong`).textContent(),typeof row.value==='object'?JSON.stringify(row.value):String(row.value),row.metric+' value matches the held artifact');
 }
 assert.match(metrics,/NOT_MEASURED/);
 assert.match(await page.locator('#research-alerts').innerText(),/could not be measured/);
 await page.locator('#research-technical > summary').click();
 const details=await page.locator('#research-technical-body').textContent();
 assert.ok(details.includes(campaignId),'raw receipt provenance survives in technical details');
 for(const exclusion of body.artifact.exclusions)assert.ok((await page.locator('#research-alerts').innerText()).includes(exclusion.why),'source exclusion is visible');
}));

test('REX807 a real admitted member never receives an owner export claim or enabled export',()=>rig(async({app,page,enter})=>{
 const session=await(await fetch(app.url+'/api/v0/pairing/session',{method:'POST',headers:owner,body:'{}'})).json();
 const invite={cityId:session.descriptor.cityId,sessionId:session.pairingSessionId,secret:new URLSearchParams(session.qrPayload.split('?')[1]).get('secret'),method:'qr'};
 const enrolled=await enrollWithCity({endpoint:app.url,invite,displayName:'Read-only member',platform:'web'});
 await enter(enrolled.session.credential);
 const status=await page.locator('#research-export-status').textContent();
 assert.doesNotMatch(status,/Owner session detected/);
 assert.match(status,/Owner session required/);
 assert.equal(await page.locator('#research-export-json').isDisabled(),true);
 assert.equal((await fetch(app.url+'/api/v0/research/artifacts',{headers:{...V,Authorization:'Bearer '+enrolled.session.credential}})).status,403);
}));

test('REX807 failed campaign read stays visibly unknown, then a successful refresh clears it',()=>rig(async({page,enter})=>{
 await page.route('**/api/v0/research/campaigns',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'campaign diagnostic unavailable',errorCode:'CAMPAIGN_READ_FAILED',apiVersion:0,schemaVersion:0})}));
 await enter();
 assert.match(await page.locator('#research-alerts').innerText(),/campaign diagnostic unavailable/);
 assert.doesNotMatch(await page.locator('#research-run').innerText(),/No run is live/);
 await page.unroute('**/api/v0/research/campaigns');
 await page.locator('#research-refresh').click();
 await page.waitForFunction(()=>!document.querySelector('#research-refresh').disabled);
 assert.doesNotMatch(await page.locator('#research-alerts').innerText(),/campaign diagnostic unavailable/);
}));

test('REX807 actual gateway unfinished and bounded history remain visible',()=>rig(async({app,page,enter,dir})=>{
 const held=JSON.parse(await readFile(resolve(dir,'research','campaigns',campaignId+'.json'),'utf8'));
 await writeFile(resolve(dir,'research','scenario-campaign.json'),JSON.stringify({...held,state:'INTERRUPTED',campaignSeed:'held',timeout:30000,limits:{}}));
 for(let i=2;i<=51;i++){
  const id='campaign-5face000-0000-4000-8000-'+String(i).padStart(12,'0');
  await writeFile(resolve(dir,'research','campaigns',id+'.json'),JSON.stringify({...held,campaignId:id}));
 }
 const actual=await(await fetch(app.url+'/api/v0/research/campaigns',{headers:owner})).json();
 assert.equal(actual.unfinished,true);assert.equal(actual.receiptWindow.truncated,true);
 await enter();
 assert.match(await page.locator('#research-alerts').innerText(),/unfinished campaign/);
 assert.match(await page.locator('#research-alerts').innerText(),/older history is omitted/);
}));

test('REX807 actual campaign storage failure cannot render an idle run',()=>rig(async({app,page,enter,dir})=>{
 await rm(resolve(dir,'research','campaigns'),{recursive:true,force:true});
 await writeFile(resolve(dir,'research','campaigns'),'not a directory');
 const actual=await(await fetch(app.url+'/api/v0/research/campaigns',{headers:owner})).json();
 assert.equal(actual.storeState,'UNAVAILABLE');
 await enter();
 assert.match(await page.locator('#research-alerts').innerText(),/Campaign storage is unavailable/);
 assert.doesNotMatch(await page.locator('#research-run').innerText(),/No run is live/);
}));

test('REX807 the primary-surface guard runs on the shipped page, not only inside its own test',()=>rig(async({page,enter})=>{
 // The workbook's claim is that the primary surfaces stay free of research controls and that this guard "is data, not a
 // convention". As shipped it was neither: researchView() was called without primarySurfaces, so view.primarySurfaces was
 // always empty and only tests/rex807-surface.test.mjs ever executed the check. The page now derives the list from the
 // REAL navigation, so this test performs the edit the guard exists to refuse - promoting Research out of the Advanced
 // group - and requires the shipped page to reject it rather than quietly render a research control on Home.
 const pageErrors=[];
 let refusePromotion=()=>{};
 const refused=new Promise(resolve=>{refusePromotion=resolve;});
 page.on('pageerror',error=>{const message=String(error?.message??error);pageErrors.push(message);if(message.includes('PRIMARY_SURFACE_POLLUTED'))refusePromotion(message);});
 await enter();
 assert.deepEqual(pageErrors,[],'the shipped page must render without a page error');
 await page.evaluate(()=>{const nav=document.querySelector('nav');nav.insertBefore(nav.querySelector('[data-page="Research"]'),nav.querySelector('.nav-group'));});
 await page.locator('#research-refresh').click();
 // The refusal escapes show(), so it arrives as a page error rather than as field text - the same shape the workbook's
 // "a later edit cannot ship unconfirmed" requirement takes everywhere else on this surface.
 const verdict=await Promise.race([refused,new Promise(resolve=>setTimeout(()=>resolve(null),10000))]);
 assert.ok(verdict,`promoting Research onto the primary nav must be refused by the page: ${pageErrors.join(' | ')}`);
}));
