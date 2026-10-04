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
 assert.equal(await page.locator('.badge.ONLINE').count(),0);
 }finally{await browser?.close();await agent?.stop();await app?.close();await rm(dir,{recursive:true,force:true});}
});
