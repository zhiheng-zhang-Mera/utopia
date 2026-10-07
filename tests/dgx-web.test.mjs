import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {draft} from './fixtures/dgx-case.mjs';
test('DGX007 Web discovers governance, imports case and traces L0 to exact L2 evidence without task mutation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-web-'));const app=await createGateway({dir,port:0,token:'web-dgx',nodeToken:'node-dgx',roomsDisabled:true});let browser;
 try{
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});
  await page.goto(app.url);await page.locator('#token').fill('web-dgx');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();
  await page.locator('[data-page="Governance"]').click();await page.locator('#governance-import-details').click();
  const input=draft();input.snapshot.accepted_requirements=['<img src=x onerror="window.dgxInjected=true">'];input.graph.accepted_requirements=[...input.snapshot.accepted_requirements];
  await page.locator('#governance-draft').fill(JSON.stringify(input));await page.locator('#governance-create').click();
  await page.locator('#governance-l0').filter({hasText:'NOT_RUN'}).waitFor();assert.match(await page.locator('#governance-l0').innerText(),/PCF unavailable/);assert.equal(await page.evaluate(()=>window.dgxInjected),undefined);
  await page.locator('#governance-l2-toggle').click();assert.match(await page.locator('#governance-l2').innerText(),new RegExp('a'.repeat(40)));
  assert.equal(app.store.list('tasks').length,0);
  await page.locator('[data-page="Home"]').click();await page.locator('[data-page="Governance"]').click();await page.locator('[data-governance-case="case-1"]').waitFor();
  await page.locator('[data-governance-case="case-1"]').click();await page.locator('#governance-l0').filter({hasText:'NOT_RUN'}).waitFor();
 }finally{await browser?.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
