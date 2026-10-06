import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
const manifest={experimentId:'web-visible-experiment',question:'Can an experiment be described before execution?',topology:'SINGLE_CITY',hosts:['review-host'],workers:[],controlSurfaces:['review-web'],variables:{independent:['target'],dependent:['completion'],controls:['taskType']},repetitions:2,seedPolicy:'PER_REPETITION',baseSeed:19,requiredCapabilities:['research.evidence.review'],stopConditions:[{kind:'MAX_REPETITIONS',value:2}],artifactPolicy:{retention:'SUMMARY_ONLY'},acceptance:{primary:'Descriptions are inspected without task execution'},softwareRefs:['utopia@8f8c521fc299d622093776615b653457d8833f96']};
test('CEX790 Web reports validated but unfiled registration and degraded store',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cex790-store-web-'));let app,browser;
 try{
  await writeFile(join(dir,'research'),'file where the store directory belongs');
  app=await createGateway({dir,port:0,token:'web-review',nodeToken:'web-node',roomsDisabled:true});
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
  const page=await browser.newPage({locale:'en-US'});
  await page.goto(app.url);await page.locator('#token').fill('web-review');await page.locator('#connect').click();
  await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Research"]').click();
  await page.waitForFunction(()=>document.querySelector('#research-vocabulary')?.textContent.includes('capabilityVocabulary') && !document.querySelector('#research-register')?.disabled);
  assert.match(await page.locator('#research-list').innerText(),/storage is unavailable/i);
  await page.locator('#research-manifest').fill(JSON.stringify(manifest));await page.locator('#research-register').click();
  await page.waitForFunction(()=>document.querySelector('#research-result')?.textContent.includes('"registered": true') && !document.querySelector('#research-register')?.disabled);
  const receipt=JSON.parse(await page.locator('#research-result').innerText());
  assert.equal(receipt.persisted,false);assert.ok(receipt.persistFailure);
  assert.equal(await page.locator('[data-experiment]').count(),0);assert.equal(app.store.list('tasks').length,0);
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
test('Web Research discovers imports validates registers and inspects canonical experiments without running',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex801-web-'));const app=await createGateway({dir,port:0,token:'web-review',nodeToken:'web-node',roomsDisabled:true});
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});
 try {
  await page.goto(app.url);await page.locator('#token').fill('web-review');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();
  await page.locator('[data-page="Research"]').click();await page.waitForFunction(()=>document.querySelector('#research-vocabulary')?.textContent.includes('capabilityVocabulary'));
  await page.locator('#research-import').setInputFiles({name:'experiment.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))});
  await page.locator('#research-result').filter({hasText:'"imported": true'}).waitFor();assert.equal(app.store.list('tasks').length,0);
  await page.locator('#research-validate').click();await page.locator('#research-result').filter({hasText:'"registeredNothing": true'}).waitFor();
  assert.equal(await page.locator('[data-experiment]').count(),0);
  await page.locator('#research-register').click();await page.locator('[data-experiment="web-visible-experiment"]').waitFor();
  await page.locator('[data-experiment="web-visible-experiment"]').click();await page.locator('#research-result').filter({hasText:manifest.question}).waitFor();
  assert.equal(app.store.list('tasks').length,0);
  await page.locator('#research-manifest').fill(JSON.stringify({...manifest,softwareRefs:['utopia@main']}));
  await page.locator('#research-validate').click();await page.locator('#research-result').filter({hasText:'MALFORMED_SOFTWARE_REF'}).waitFor();
  assert.match(await page.locator('#research-manifest').inputValue(),/utopia@main/);
  await page.screenshot({path:'.runtime/evidence/mission-book/REX-801/research-web.png',fullPage:true});
  await page.locator('[data-page="Home"]').click();await page.locator('[data-page="Research"]').click();await page.locator('#research-result').filter({hasText:'MALFORMED_SOFTWARE_REF'}).waitFor();
  // Disconnect state disables mutation and retains the draft.
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await page.waitForFunction(()=>document.querySelector('#research-register')?.disabled===true);
  assert.match(await page.locator('#research-manifest').inputValue(),/utopia@main/);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});

test('a failed list refresh cannot hide a successful canonical registration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex801-web-'));const app=await createGateway({dir,port:0,token:'web-review',nodeToken:'web-node',roomsDisabled:true});
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});
 try {
  await page.goto(app.url);await page.locator('#token').fill('web-review');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();
  await page.locator('[data-page="Research"]').click();await page.waitForFunction(()=>!document.querySelector('#research-register')?.disabled);
  await page.locator('#research-manifest').fill(JSON.stringify(manifest));
  await page.route('**/api/v0/research/experiments',route=>route.request().method()==='GET'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({apiVersion:0,schemaVersion:0,error:'refresh failed'})}):route.continue());
  await page.locator('#research-register').click();await page.locator('#research-error').filter({hasText:'refresh failed'}).waitFor();
  assert.match(await page.locator('#research-result').innerText(),/"registered": true/);
  assert.match(await page.locator('#research-result').innerText(),/web-visible-experiment/);
  const canonical=await fetch(app.url+'/api/v0/research/experiments/web-visible-experiment',{headers:{Authorization:'Bearer web-review','X-City-Api-Version':'0','X-City-Schema-Version':'0'}});
  assert.equal(canonical.status,200);assert.equal(app.store.list('tasks').length,0);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
