import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway } from '../services/dev-gateway/server.mjs';

test('Web Devices and ephemeral pairing share the authoritative Gateway',async()=>{
 const dir=await mkdtemp(resolve('.scratch-web-v02-'));let app,browser;
 try{
 app=await createGateway({host:'127.0.0.1',port:0,dir,token:'web-test',nodeToken:'node-test'});
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
 const page=await browser.newPage({locale:'en-US'});await page.goto(app.url);
 await page.getByLabel('Pairing token').fill('web-test');await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.locator('#connection.online').waitFor();
 await page.locator('[data-page="Devices"]').click({timeout:2000});
 assert.match(await page.locator('#view').innerText(),/Waiting for a runtime node/);
 await page.locator('[data-page="Pairing"]').click();
 await page.getByRole('button',{name:'Generate pairing session',exact:true}).click();
 await page.locator('#pairing-qr svg').waitFor();
 // Localization must not reconnect, rotate the live session, or turn protocol state into translated logic.
 const connectionsBefore=app.store.events().filter(e=>e.type==='CLIENT_CONNECTED').length;
 const qrBefore=await page.locator('#pairing-qr svg').evaluate(el=>el.outerHTML);
 await page.evaluate(()=>window.UtopiaI18n.setLocale('zh-CN'));
 assert.equal(await page.locator('#connection').innerText(),'在线');
 assert.equal(await page.locator('#run').isDisabled(),false);
 assert.equal(await page.locator('#generate-pairing').innerText(),'撤销并刷新会话');
 assert.ok(await page.locator('#pairing-qr svg').evaluate((el,expected)=>el.outerHTML===expected,qrBefore));
 assert.equal(app.store.events().filter(e=>e.type==='CLIENT_CONNECTED').length,connectionsBefore);
 await page.evaluate(()=>window.UtopiaI18n.setLocale('en'));
 const priorSession=await page.evaluate(()=>fetch('/api/v0/pairing/info',{headers:{'X-City-Api-Version':'0','X-City-Schema-Version':'0'}}).then(r=>r.json()).then(x=>x.descriptor.pairingSessionId));
 await page.getByRole('button',{name:'Revoke and refresh session',exact:true}).click();
 await page.locator('#pairing-qr svg').waitFor();
 const nextSession=await page.evaluate(()=>fetch('/api/v0/pairing/info',{headers:{'X-City-Api-Version':'0','X-City-Schema-Version':'0'}}).then(r=>r.json()).then(x=>x.descriptor.pairingSessionId));
 assert.notEqual(nextSession,priorSession);
 assert.equal(await page.locator('#pairing-code').count(),1);
 assert.match(await page.locator('#view').innerText(),/LAN DEVELOPMENT ONLY/);
 await page.locator('[data-page="Devices"]').click();
 assert.equal(await page.locator('#pairing-code').count(),0);
 await page.locator('[data-page="Pairing"]').click();
 assert.equal(await page.locator('#pairing-code').count(),0);
 await page.getByRole('button',{name:'Generate pairing session',exact:true}).click();
 await page.locator('#pairing-qr svg').waitFor();
 await app.close();await page.locator('#connection.online').waitFor({state:'hidden'});
 assert.equal(await page.locator('#pairing-code').count(),0);
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});

test('Web freshness, device detail, node offline and pairing expiry',async()=>{
 const dir=await mkdtemp(resolve('.scratch-web-v02-'));let app,browser;
 try{
 app=await createGateway({host:'127.0.0.1',port:0,dir,token:'web-test',nodeToken:'node-test',heartbeatTimeout:30000,pairingTtlMs:1500});
 const headers={Authorization:'Bearer node-test','Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'};
 const telemetry={observedAt:new Date().toISOString(),cpu:{usagePercent:18},memory:{usedBytes:1024**3,totalBytes:2*1024**3},disk:{usedBytes:3*1024**3,freeBytes:5*1024**3,totalBytes:8*1024**3},uptimeSeconds:3660};
 const register=await fetch(app.url+'/api/v0/node/register',{method:'POST',headers,body:JSON.stringify({id:'test-device',displayName:'Test device',metadata:{platform:'Windows'},capabilities:['task.execute.safe'],agentVersion:'0.2.0',telemetry})});assert.equal(register.status,200);
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});await page.goto(app.url);
 await page.getByLabel('Pairing token').fill('web-test');await page.getByRole('button',{name:'Connect',exact:true}).click();await page.locator('#connection.online').waitFor();
 await page.locator('[data-page="Devices"]').click();await page.locator('.telemetry.fresh').waitFor();
 await page.evaluate(()=>window.UtopiaI18n.setLocale('zh-CN'));
 assert.equal(await page.locator('#view .badge.ONLINE').innerText(),'在线');
 assert.equal(await page.locator('#view .badge.在线').count(),0);
 await page.evaluate(()=>window.UtopiaI18n.setLocale('en'));
 assert.match(await page.locator('#view').innerText(),/18.0%/);
 await page.locator('[data-node="test-device"]').click();
 for(const expected of ['Agent 0.2.0','Memory','Disk','1h 1m','Capabilities','task.execute.safe','Current tasks','NODE_ONLINE'])assert.ok((await page.locator('#detail').innerText()).includes(expected));
 const stale={...telemetry,observedAt:new Date(Date.now()-15000).toISOString()};
 assert.equal((await fetch(app.url+'/api/v0/node/heartbeat',{method:'POST',headers,body:JSON.stringify({id:'test-device',telemetry:stale})})).status,200);
 await page.locator('#view .telemetry.cached').waitFor();assert.equal(await page.locator('#view .badge.ONLINE').count(),0);
 const node=app.store.get('nodes','test-device');app.store.put('nodes',{...node,online:false});
 await page.locator('#view .badge.OFFLINE').waitFor();
 await page.locator('[data-page="Pairing"]').click();await page.getByRole('button',{name:'Generate pairing session',exact:true}).click();await page.locator('#pairing-qr svg').waitFor();
 await page.locator('#pairing-code').waitFor({state:'detached',timeout:5000});assert.match(await page.locator('#view').innerText(),/expired/);
 await app.close();await page.locator('#connection.online').waitFor({state:'hidden'});await page.locator('[data-page="Devices"]').click();
 assert.equal(await page.locator('#view .badge.UNKNOWN').count(),1);assert.equal(await page.locator('#view .telemetry.fresh').count(),0);
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
