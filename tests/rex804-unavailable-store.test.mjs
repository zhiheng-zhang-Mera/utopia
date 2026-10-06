import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {chromium} from 'playwright';
import {createFaultController} from '../services/dev-gateway/research/faults.mjs';import {createGateway} from '../services/dev-gateway/server.mjs';
const headers={Authorization:'Bearer ctl','Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'};
test('REX804 unavailable receipt directory is disclosed and refuses injection without affecting observation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex804-dir-'));let controller;const events=[];
 try{
  const store=join(dir,'faults');await writeFile(store,'obstruction');
  assert.doesNotThrow(()=>{controller=createFaultController({dir:store,node:()=>({online:true}),trace:{captureCanonical:event=>{events.push(event);return true;}}});});
  assert.equal(controller.list().storeState,'UNAVAILABLE');
  assert.match(controller.list().storeReason,/EEXIST|ENOTDIR/);
  assert.throws(()=>controller.start({kind:'HEARTBEAT_LOSS',nodeId:'target',durationMs:10,confirmation:'FAULT:HEARTBEAT_LOSS:target'}),e=>e.code==='FAULT_STORE_UNAVAILABLE'&&e.status===503);
  assert.equal(controller.capture({id:'canonical',actor:'target'}),true);assert.equal(events.length,1);
 }finally{controller?.close();await rm(dir,{recursive:true,force:true});}
});
test('REX804 Web discloses unavailable fault store and prevents injection while normal task creation works',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex804-store-web-'));let app,browser;
 try{
  await mkdir(join(dir,'research'));await writeFile(join(dir,'research','faults'),'obstruction');
  app=await createGateway({dir,port:0,token:'ctl',nodeToken:'node',roomsDisabled:true});
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});
  await page.goto(app.url);await page.locator('#token').fill('ctl');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Research"]').click();await page.locator('#fault-danger > summary').click();
  await page.locator('#fault-store-status').filter({hasText:'Fault storage is unavailable'}).waitFor();
  assert.equal(await page.locator('#fault-start').isDisabled(),true);
  const created=await fetch(app.url+'/api/v0/tasks',{method:'POST',headers,body:JSON.stringify({type:'WAIT'})});assert.equal(created.status,200);assert.equal((await created.json()).state,'QUEUED');
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
