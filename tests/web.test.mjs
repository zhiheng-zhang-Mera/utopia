import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { startAgent } from '../agents/reference-node/agent.mjs';
test('Web control creates a real task and shows durable result',async()=>{
 const dir=await mkdtemp(resolve('.scratch-web-'));let app,agent,browser;
 try{
 app=await createGateway({host:'127.0.0.1',port:0,dir,token:'web-test',nodeToken:'node-test'});
 agent=await startAgent({url:app.url,token:'node-test',workspace:resolve(dir,'work'),stepDelay:100,interval:100});
 browser=await chromium.launch({channel:'msedge',headless:true});
 // Pin the browser locale so the first-run UI locale is English on any host
 // (the Web Control Surface now ships en and zh-CN language packs).
 const context=await browser.newContext({locale:'en-US'});const page=await context.newPage();await page.goto(app.url);
 await page.getByLabel('Pairing token').fill('web-test');await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByText('ONLINE',{exact:true}).first().waitFor();await page.getByRole('button',{name:'Run Test Task',exact:true}).click();
 await page.getByText('COMPLETED',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:/Q-/}).first().click();
 assert.match(await page.locator('#detail').innerText(),/sha256/);
 await page.reload();await page.getByText('COMPLETED',{exact:true}).first().waitFor();
 await app.close();
 await page.locator('#connection.online').waitFor({state:'hidden'});
 await page.getByText('UNKNOWN',{exact:true}).first().waitFor();
 assert.equal(await page.locator('.device-card .badge.ONLINE').count(),0);
 }finally{await browser?.close();await agent?.stop();await app?.close();await rm(dir,{recursive:true,force:true});}
});
// MON-902: the City monitor page in a REAL browser. The unit probes prove the rendering rules against string output;
// this proves the page exists, that the primary navigation reaches it, that a row opens the inspector, and that the raw
// projection vocabulary is not readable on the page (it lives behind the Technical details disclosure).
test('City monitor renders in the browser and keeps raw projection vocabulary behind its disclosure',async()=>{
 const dir=await mkdtemp(resolve('.scratch-monitor-web-'));let app,browser;
 try{
 app=await createGateway({host:'127.0.0.1',port:0,dir,token:'monitor-test',nodeToken:'node-test',roomsDisabled:true});
 // One real canonical task, created through the real route, so the graph is not describing an empty city.
 const created=await fetch(app.url+'/api/v0/tasks',{method:'POST',headers:{Authorization:'Bearer monitor-test','Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:JSON.stringify({type:'WAIT'})});
 assert.equal(created.ok,true,'the browser fixture needs a real task: '+await created.text());
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({locale:'en-US'});const page=await context.newPage();await page.goto(app.url);
 await page.getByLabel('Pairing token').fill('monitor-test');await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByText('ONLINE',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'City monitor',exact:true}).click();
 await page.locator('.monitor-panel').waitFor();
 // The page answers, and it states the standing limitation of the observation model rather than implying completeness.
 // The shell uppercases headings in CSS, and innerText reflects that, so these assertions are case-insensitive.
 const overview=await page.locator('.monitor-panel').innerText();
 assert.match(overview,/city monitor/i);
 assert.match(overview,/always true of this monitor|whether the owner is needed cannot be told from here/i);
 // A real row exists and opens the inspector with the four questions.
 const row=page.locator('.monitor-row').first();await row.waitFor();await row.click();
 const inspector=await page.locator('.monitor-inspector').innerText();
 for(const label of ['What','Why','Who','What next'])assert.match(inspector,new RegExp(label,'i'));
 // The disclosure is present and expanded on demand; the default page does not print raw projection vocabulary.
 assert.equal(await page.locator('details.monitor-technical').count()>0,true,'the technical disclosure must exist');
 assert.doesNotMatch(overview,/NOT_OBSERVABLE|TASK_FAILED|WINDOW_INCOMPLETE|RETRY_HISTORY/,'raw codes leaked into the readable page');
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
