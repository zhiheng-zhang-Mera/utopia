import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {Store} from '../services/dev-gateway/store.mjs';

test('Windows history loads detail explicitly, retains it across snapshots and fences late selections',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'utopia-services-history-'));const store=new Store(dir);
 store.db.exec('CREATE TABLE invocations(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
 store.put('invocations',{id:'I-expired',invocationId:'I-expired',capabilityId:'planning.document.intake',operationId:'read',status:'COMPLETED',resultDigest:'retained-public-digest',resultAvailable:false});store.close();
 const g=await createGateway({dir,port:0,token:'detail-test',nodeToken:'detail-node'});
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});
 const detailRequests=[];page.on('request',r=>{if(r.url().includes('/capability-invocations/'))detailRequests.push(r.url());});
 try{
  await page.goto(g.url);await page.locator('#token').fill('detail-test');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Services"]').click();
  await page.locator('[data-service="planning.document.intake"]').click();await page.locator('#service-file').setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('Generated detail survives refresh')});await page.locator('#service-invoke').click();await page.locator('#service-state').filter({hasText:'COMPLETED'}).waitFor();
  const id=(await page.locator('#service-id').textContent()).trim().split(/\s+/)[0];
  await page.locator('[data-service="presentation.theme.lab"]').click();
  await page.locator(`[data-invocation="${id}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#service-summary')?.textContent.includes('Generated detail survives refresh'));
  assert.equal(detailRequests.length,1,'history selection must request one retained detail');
  await page.evaluate(async()=>{const m=await import('/services.js');const r=await fetch('/api/v0/city',{headers:{Authorization:'Bearer detail-test','X-City-Api-Version':'0','X-City-Schema-Version':'0'}});m.renderServices(document.querySelector('#services-shell').parentElement,await r.json(),true,async path=>{const r=await fetch('/api/v0/'+path,{headers:{Authorization:'Bearer detail-test','X-City-Api-Version':'0','X-City-Schema-Version':'0'}});return r.json();});});
  assert.match(await page.locator('#service-summary').innerText(),/Generated detail survives refresh/);assert.equal(detailRequests.length,1,'snapshots do not repeatedly fetch large payloads');
  await page.evaluate(async id=>{const m=await import('/services.js');const r=await fetch('/api/v0/city',{headers:{Authorization:'Bearer detail-test','X-City-Api-Version':'0','X-City-Schema-Version':'0'}});const city=await r.json();city.invocations=city.invocations.map(i=>i.invocationId===id?{...i,status:'RUNNING',resultAvailable:false,resultDigest:null}:i);m.renderServices(document.querySelector('#services-shell').parentElement,city,true,async path=>{const r=await fetch('/api/v0/'+path,{headers:{Authorization:'Bearer detail-test','X-City-Api-Version':'0','X-City-Schema-Version':'0'}});return r.json();});},id);
  assert.equal(await page.locator('#service-state').innerText(),'COMPLETED','stale RUNNING snapshot cannot regress a completed detail');
  assert.match(await page.locator('#service-summary').innerText(),/Generated detail survives refresh/);
  await page.locator(`[data-invocation="${id}"]`).click();await page.waitForFunction(()=>document.querySelector('#service-state')?.textContent==='COMPLETED');
  assert.match(await page.locator('#service-summary').innerText(),/Generated detail survives refresh/,'completed detail wins over cached RUNNING summary');
  await page.locator('[data-invocation="I-expired"]').click();await page.waitForFunction(()=>document.querySelector('#service-summary')?.textContent.includes('Digest retained'));
  assert.equal(await page.locator('#service-state').innerText(),'COMPLETED');assert.match(await page.locator('#service-id').innerText(),/retained-public-digest/);assert.equal(await page.locator('#document-to-knowledge').isVisible(),false);
  await page.route('**/capability-invocations/'+id,async route=>{await new Promise(r=>setTimeout(r,400));await route.continue();});
  await page.locator(`[data-invocation="${id}"]`).click();await page.locator('[data-service="presentation.theme.lab"]').click();await page.waitForTimeout(700);
  assert.equal(await page.locator('#service-state').innerText(),'','late detail cannot replace a new service view');
 }finally{await browser.close();await g.close();await rm(dir,{recursive:true,force:true});}
});
test('Windows Services invokes real document, knowledge, skill, evidence and theme adapters',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'utopia-services-'));const g=await createGateway({dir,port:0,token:'service-test',nodeToken:'service-node'});
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});
 try{
  await page.goto(g.url);await page.locator('#token').fill('service-test');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();
  await page.locator('[data-page="Services"]').click();
  await page.locator('[data-service="planning.document.intake"]').click();
  await page.locator('#service-file').setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('Utopia shared knowledge')});
  await page.locator('#service-invoke').click();await page.locator('#service-state').filter({hasText:'COMPLETED'}).waitFor();
  assert.match(await page.locator('#service-summary').innerText(),/Utopia shared knowledge/);
  await page.locator('#document-to-knowledge').click();await page.locator('#service-invoke').click();await page.locator('#service-state').filter({hasText:'COMPLETED'}).waitFor();
  assert.match(await page.locator('#service-summary').innerText(),/Utopia shared knowledge/);
  for(const id of ['engineering.skill.inspect','research.evidence.review','presentation.theme.lab']){
   await page.locator('[data-service="'+id+'"]').click();await page.locator('#service-invoke').click();await page.locator('#service-state').filter({hasText:'COMPLETED'}).waitFor();
  }
  assert.ok(await page.locator('#theme-preview').getAttribute('src'));
  await page.locator('[data-service="research.evidence.review"]').click();await page.locator('#service-tamper').click();await page.locator('#service-state').filter({hasText:'FAILED'}).waitFor();assert.match(await page.locator('#service-summary').innerText(),/ARTIFACT_HASH_MISMATCH/);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/capabilities/*/invoke',async route=>{await new Promise(r=>setTimeout(r,500));await route.continue();});
  await page.locator('[data-service="presentation.theme.lab"]').click();await page.locator('#service-invoke').click();
  await page.locator('[data-page="Home"]').click();await page.waitForTimeout(1200);
  assert.deepEqual(errors,[],'late completion must not mutate a detached Services editor');
  await page.locator('[data-page="Services"]').click();
  assert.equal(await page.locator('#service-state').innerText(),'','late result stays in shared history, not a different view');
  const pendingGate=await page.evaluate(async()=>{
   const {renderServices}=await import('/services.js');const container=document.createElement('div');document.body.replaceChildren(container);
   const city={capabilities:[{capabilityId:'available',name:'Theme',inputKind:'theme',bridgeState:'AVAILABLE',operations:[{operationId:'generate'}]},{capabilityId:'future',name:'Future',bridgeState:'BRIDGE_PENDING',operations:[]}],invocations:[]};
   let calls=0;renderServices(container,city,true,async()=>{calls++;await new Promise(r=>setTimeout(r,100));return {status:'COMPLETED'};});
   container.querySelector('[data-service="available"]').click();container.querySelector('#service-invoke').click();container.querySelector('[data-service="future"]').click();await new Promise(r=>setTimeout(r,160));
   const disabled=container.querySelector('#service-invoke').disabled;
   container.querySelector('[data-service="available"]').click();container.querySelector('#service-invoke').click();await new Promise(r=>setTimeout(r,160));return {disabled,calls};
  });
  assert.deepEqual(pendingGate,{disabled:true,calls:2},'late completion must preserve pending gate and leave available services usable');
 }finally{await browser.close();await g.close();await rm(dir,{recursive:true,force:true});}
});
