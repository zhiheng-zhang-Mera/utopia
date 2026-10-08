// A SURFACE MUST SURVIVE BEING RE-RENDERED, because it is re-rendered constantly.
//
// `app.js` calls `render()` from `refresh()`, and `refresh()` runs every four seconds AND on every event the City
// pushes over the WebSocket. Both owner surfaces therefore rebuild their DOM while the owner is using them. Measured
// failure this pins: an owner opened the Danger Zone, and the four-second tick rebuilt the page, snapped the `<details>`
// shut and dropped focus out of the field being typed into - the confirmation input was still there and no longer
// reachable. Browser tests saw the same thing from the outside as "element is not visible", which is why they were
// flaky under load in the first place: load only changed how often the tick landed mid-run.
//
// So these cases do not test a timer. They cause a REAL City event, which is the same path that closes the region in
// production, and then require the region to still be open and the owner's typing to still be there.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';

const V={'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const OWNER='surface-rebuild-owner';
const owner={...V,Authorization:'Bearer '+OWNER,'Content-Type':'application/json'};
const rmScratch = dir => rm(dir, {recursive: true, force: true, maxRetries: 12, retryDelay: 60});

async function open(t){
  const dir=await mkdtemp(resolve('.scratch-surface-rebuild-'));
  const app=await createGateway({dir:resolve(dir,'city'),port:0,token:OWNER,nodeToken:'surface-node',roomsDisabled:true,
    remoteOperation:{enabled:true,allowlist:['node'],workspaces:['C:/']},agentJob:{enabled:true}});
  const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
  t.after(async()=>{await browser.close().catch(()=>{});await app.close();await rmScratch(dir);});
  const page=await browser.newPage({locale:'en-US'});
  page.setDefaultTimeout(8000);
  await page.goto(app.url);
  await page.locator('#token').fill(OWNER);
  await page.locator('#connect').click();
  await page.locator('#connection.online').waitFor();
  // Counts only FULL page rebuilds: `#view`'s direct children being replaced. The views also refresh their own rows,
  // which mutates descendants and must not be mistaken for a rebuild.
  await page.evaluate(()=>{
    window.__rebuilds=0;
    new MutationObserver(()=>{window.__rebuilds++;}).observe(document.querySelector('#view'),{childList:true});
  });
  return {app,page,rebuild:async()=>{
    // A real event: creating a task makes the City push over the WebSocket, which calls refresh(), which calls render().
    await fetch(app.url+'/api/v0/tasks',{method:'POST',headers:owner,body:JSON.stringify({type:'WAIT'})});
    await page.waitForFunction(()=>window.__rebuilds>0,null,{timeout:10000});
  }};
}

test('SURFACE-PERSIST 1: a City event cannot close the agent-job Danger Zone or drop what was typed',async t=>{
  const {page,rebuild}=await open(t);
  await page.locator('nav [data-page="AgentJobs"]').click();
  await page.locator('#aj-refresh').waitFor();
  const details=page.locator('#aj-danger');
  assert.equal(await details.evaluate(d=>d.open),false,'the gate starts closed');
  await page.locator('#aj-danger > summary').click();
  assert.equal(await details.evaluate(d=>d.open),true);
  // Typing the title, then moving to the confirmation field - the exact moment an owner is committed to the action.
  await page.locator('#aj-title').fill('Reproduce the study on the opposite host');
  await page.locator('#aj-confirm').fill('Reproduce the study on the opposite ho');
  await page.locator('#aj-confirm').focus();
  // The caret is part of what the owner was doing. Captured before the rebuild and compared after it, rather than
  // asserted against a position computed here - the property is "unchanged", not "wherever this test guesses".
  const caretBefore=await page.locator('#aj-confirm').evaluate(el=>[el.selectionStart,el.selectionEnd]);
  assert.ok(caretBefore[0]>0,'the fixture must leave a real caret to preserve, or this proves nothing');
  await rebuild();

  assert.equal(await details.evaluate(d=>d.open),true,'a rebuild must not close a region the owner opened');
  assert.equal(await page.locator('#aj-title').inputValue(),'Reproduce the study on the opposite host');
  assert.equal(await page.locator('#aj-confirm').inputValue(),'Reproduce the study on the opposite ho');
  assert.equal(await page.locator('#aj-confirm').isVisible(),true,'the field must still be reachable');
  const focused=await page.evaluate(()=>document.activeElement?.id??null);
  assert.equal(focused,'aj-confirm','focus must stay in the field being typed into');
  const caretAfter=await page.locator('#aj-confirm').evaluate(el=>[el.selectionStart,el.selectionEnd]);
  assert.deepEqual(caretAfter,caretBefore,'the caret must be where the owner left it');
});

test('SURFACE-PERSIST 2: same for the remote-operation surface, which shares the same rebuild path',async t=>{
  const {page,rebuild}=await open(t);
  await page.locator('nav [data-page="RemoteOperation"]').click();
  await page.locator('#rop-refresh').waitFor();
  const details=page.locator('#rop-danger');
  await page.locator('#rop-danger > summary').click();
  assert.equal(await details.evaluate(d=>d.open),true);
  await page.locator('#rop-executable').fill('node');
  await page.locator('#rop-confirm').fill('nod');
  await page.locator('#rop-confirm').focus();
  await rebuild();
  assert.equal(await details.evaluate(d=>d.open),true,'a rebuild must not close this region either');
  assert.equal(await page.locator('#rop-executable').inputValue(),'node');
  assert.equal(await page.locator('#rop-confirm').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement?.id??null),'rop-confirm');
});
