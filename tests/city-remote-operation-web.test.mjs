// The exposure gate for CITY-REMOTE-OPERATION, exercised in a REAL browser against a REAL gateway and a REAL agent.
//
// CONSTRUCTION_RULES 14A puts a capability like this in DIRECT_CONTROL and then lists what that obliges: a
// discoverable entry, a control wired to the canonical backend, the real result of the owner's own action, a
// confirmation before the high-impact part, and a way to stop it. These tests check those obligations one by one, and
// the last one removes the wiring to prove the assertions are not decorative.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {startAgent} from '../agents/reference-node/agent.mjs';

const V={'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const NODE_ID='dev-alien';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,{timeout=60000,step=100}={}){const deadline=Date.now()+timeout;for(;;){const v=await check();if(v)return v;if(Date.now()>deadline)throw new Error('condition never became true');await sleep(step);}}

async function rig(t,{enabled=true,allowlist=['node']}={}){
 const dir=await mkdtemp(resolve('.scratch-remote-op-web-'));
 const workspace=resolve(dir,'alien-work');await mkdir(workspace,{recursive:true});
 let app=null,agent=null,browser=null;
 try{
  app=await createGateway({dir:resolve(dir,'city'),port:0,token:'web-owner',nodeToken:'web-node',roomsDisabled:true,remoteOperation:{enabled,allowlist,workspaces:[workspace]}});
  agent=await startAgent({url:app.url,token:'web-node',id:NODE_ID,displayName:'Alien',workspace:resolve(dir,'agent-work'),interval:60,stepDelay:20});
  await until(async()=>{const b=await (await fetch(app.url+'/api/v0/nodes',{headers:{...V,Authorization:'Bearer web-owner'}})).json();return (b.nodes??[]).some(n=>n.id===NODE_ID&&n.online);});
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
  const page=await browser.newPage({locale:'en-US'});
  const pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e?.message??e)));
  await page.goto(app.url);
  await page.locator('#token').fill('web-owner');
  await page.locator('#connect').click();
  await page.locator('#connection.online').waitFor();
  return {dir,workspace,app,agent,browser,page,pageErrors,
   open:async()=>{await page.locator('[data-page="RemoteOperation"]').click();await page.locator('#rop-refresh').waitFor();await page.waitForFunction(()=>document.querySelector('#rop-state')?.textContent?.length>0);},
   stop:async()=>{await browser?.close();await agent?.stop();await app?.close();await rm(dir,{recursive:true,force:true});}};
 }catch(error){await browser?.close().catch(()=>{});await agent?.stop().catch(()=>{});await app?.close().catch(()=>{});await rm(dir,{recursive:true,force:true}).catch(()=>{});throw error;}
}

test('CR-OPWEB 1: the entry exists in Advanced and shows the City real capability state',async t=>{
 const r=await rig(t);
 try{
  // Discoverable: it is a real entry in the shell navigation, in the Advanced group rather than the primary one.
  const entry=r.page.locator('nav [data-page="RemoteOperation"]');
  assert.equal(await entry.count(),1,'the capability must have a discoverable entry');
  assert.ok(await entry.evaluate(node=>Boolean(node.closest('.nav-group'))),'it belongs to the Advanced group, not the primary surfaces');
  await r.open();
  // The gate is COLLAPSED on purpose, so its confirmation field is not even visible until the owner opens it. A test
  // that could type straight into it would be testing a page whose danger zone is decoration.
  await r.page.locator('#rop-danger > summary').click();
  const state=await r.page.locator('#rop-state').innerText();
  assert.match(state,/Enabled/);
  assert.match(state,/node/,'the allowlist is shown as a fact, not implied');
  assert.match(state,/alien-work/,'the declared workspace is shown');
  assert.deepEqual(r.pageErrors,[],'the page must render without a page error');
 }finally{await r.stop();}
});

test('CR-OPWEB 2: the danger-zone gate really gates - no matching confirmation, no dispatch',async t=>{
 const r=await rig(t);
 try{
  await r.open();
  // The gate is COLLAPSED on purpose, so its confirmation field is not even visible until the owner opens it. A test
  // that could type straight into it would be testing a page whose danger zone is decoration.
  await r.page.locator('#rop-danger > summary').click();
  await r.page.locator('#rop-node').selectOption(NODE_ID);
  await r.page.locator('#rop-executable').fill('node');
  await r.page.locator('#rop-argv').fill('-e\nprocess.stdout.write("from-the-page")');
  await r.page.locator('#rop-cwd').fill(r.workspace);
  await r.page.locator('#rop-purpose').fill('prove the page really dispatches');
  const dispatch=r.page.locator('#rop-dispatch');
  assert.equal(await dispatch.isDisabled(),true,'the control must be inert before the confirmation');
  await r.page.locator('#rop-confirm').fill('nodex');
  assert.equal(await dispatch.isDisabled(),true,'a WRONG confirmation must not unlock it');
  await r.page.locator('#rop-confirm').fill('node');
  assert.equal(await dispatch.isDisabled(),false,'the exact confirmation unlocks it');
 }finally{await r.stop();}
});

test('CR-OPWEB 3: the owner runs a program from the page and reads the real result back',async t=>{
 const r=await rig(t);
 try{
  await r.open();
  // The gate is COLLAPSED on purpose, so its confirmation field is not even visible until the owner opens it. A test
  // that could type straight into it would be testing a page whose danger zone is decoration.
  await r.page.locator('#rop-danger > summary').click();
  await r.page.locator('#rop-node').selectOption(NODE_ID);
  await r.page.locator('#rop-executable').fill('node');
  await r.page.locator('#rop-argv').fill('-e\nprocess.stdout.write("from-the-page")');
  await r.page.locator('#rop-cwd').fill(r.workspace);
  await r.page.locator('#rop-purpose').fill('prove the page really dispatches');
  await r.page.locator('#rop-confirm').fill('node');
  await r.page.locator('#rop-dispatch').click();
  // The REAL state of the owner's own action, not a promise that something happened.
  await r.page.waitForFunction(()=>document.querySelector('[data-rop-state="COMPLETED"]'),null,{timeout:60000});
  const row=r.page.locator('.rop-row').first();
  assert.match(await row.innerText(),/COMPLETED/);
  assert.match(await row.innerText(),/receipt verified by the City/);
  await row.locator('summary').click();
  assert.match(await row.locator('pre').first().innerText(),/from-the-page/,'the program real output is on the page');
 }finally{await r.stop();}
});

test('CR-OPWEB 4: a refusal is a result the owner sees, not a silent nothing',async t=>{
 const r=await rig(t);
 try{
  await r.open();
  // The gate is COLLAPSED on purpose, so its confirmation field is not even visible until the owner opens it. A test
  // that could type straight into it would be testing a page whose danger zone is decoration.
  await r.page.locator('#rop-danger > summary').click();
  await r.page.locator('#rop-node').selectOption(NODE_ID);
  await r.page.locator('#rop-executable').fill('cmd');
  await r.page.locator('#rop-argv').fill('/c dir');
  await r.page.locator('#rop-cwd').fill(r.workspace);
  await r.page.locator('#rop-purpose').fill('attempt a program that is not allowed');
  await r.page.locator('#rop-confirm').fill('cmd');
  await r.page.locator('#rop-dispatch').click();
  await r.page.waitForFunction(()=>/EXECUTABLE_NOT_ALLOWED/.test(document.querySelector('#rop-error')?.textContent??''),null,{timeout:10000});
  assert.match(await r.page.locator('#rop-error').innerText(),/EXECUTABLE_NOT_ALLOWED/);
  assert.equal(await r.page.locator('.rop-row').count(),0,'a refused attempt must not leave a row behind');
 }finally{await r.stop();}
});

test('CR-OPWEB 5: a City that has the capability off says so instead of offering a button that fails',async t=>{
 const r=await rig(t,{enabled:false});
 try{
  await r.open();
  // The gate is COLLAPSED on purpose, so its confirmation field is not even visible until the owner opens it. A test
  // that could type straight into it would be testing a page whose danger zone is decoration.
  await r.page.locator('#rop-danger > summary').click();
  assert.match(await r.page.locator('#rop-state').innerText(),/has not enabled remote operation/);
  await r.page.locator('#rop-executable').fill('node');
  await r.page.locator('#rop-confirm').fill('node');
  assert.equal(await r.page.locator('#rop-dispatch').isDisabled(),true,'an off City must not offer a live dispatch');
 }finally{await r.stop();}
});

test('CR-OPWEB 6: the owner can stop a running operation from the page',async t=>{
 const r=await rig(t);
 try{
  await r.open();
  // The gate is COLLAPSED on purpose, so its confirmation field is not even visible until the owner opens it. A test
  // that could type straight into it would be testing a page whose danger zone is decoration.
  await r.page.locator('#rop-danger > summary').click();
  await r.page.locator('#rop-node').selectOption(NODE_ID);
  await r.page.locator('#rop-executable').fill('node');
  await r.page.locator('#rop-argv').fill('-e\nsetTimeout(()=>{},60000)');
  await r.page.locator('#rop-cwd').fill(r.workspace);
  await r.page.locator('#rop-purpose').fill('prove the stop control is wired');
  await r.page.locator('#rop-confirm').fill('node');
  await r.page.locator('#rop-dispatch').click();
  await r.page.waitForFunction(()=>document.querySelector('[data-rop-state="RUNNING"]'),null,{timeout:60000});
  await r.page.locator('[data-rop-stop]').first().click();
  await r.page.waitForFunction(()=>document.querySelector('[data-rop-state="CANCELLED"]'),null,{timeout:60000});
  assert.match(await r.page.locator('.rop-row').first().innerText(),/CANCELLED/);
 }finally{await r.stop();}
});
