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
 assert.match(await page.locator('#view').innerText(),/This device.*No computing agent connected/s);
 await page.locator('[data-page="Pairing"]').click();
 await page.getByRole('button',{name:'Generate pairing session',exact:true}).click();
 await page.locator('#pairing-qr svg').waitFor();
 // Localization must not reconnect, rotate the live session, or turn protocol state into translated logic.
 const connectionsBefore=app.store.events().filter(e=>e.type==='CLIENT_CONNECTED').length;
 const qrBefore=await page.locator('#pairing-qr svg').evaluate(el=>el.outerHTML);
 const codeBefore=await page.locator('#pairing-code').innerText();
 const sessionBefore=await page.evaluate(()=>fetch('/api/v0/pairing/info',{headers:{'X-City-Api-Version':'0','X-City-Schema-Version':'0'}}).then(r=>r.json()).then(x=>x.descriptor.pairingSessionId));
 await page.evaluate(()=>window.UtopiaI18n.setLocale('zh-CN'));
 assert.equal(await page.locator('#connection').innerText(),'在线');
 assert.equal(await page.locator('#run').isDisabled(),false);
 // JOIN-501: while a session is ACTIVE the page offers NO rotation control. The label states that the code is
 // live and expires on its own, and the button is disabled - the old "Revoke and refresh session" control was
 // the exact behaviour the Owner rule removed.
 const generate=page.locator('#generate-pairing');
 assert.equal(await generate.innerText(),'配对码有效中 · 到期自动失效');
 assert.equal(await generate.isDisabled(),true,'an ACTIVE session must not be re-generatable');
 assert.ok(await page.locator('#pairing-qr svg').evaluate((el,expected)=>el.outerHTML===expected,qrBefore),'the QR is unchanged');
 assert.equal(app.store.events().filter(e=>e.type==='CLIENT_CONNECTED').length,connectionsBefore);
 // A disabled button must also be a dead button: the client must not have sent a create. (The request counter is
 // the instrument that matters here - a disabled element can still be dispatched at synthetically.)
 const creations=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/v0/pairing/session'))creations.push(r.url());});
 await generate.click({force:true}).catch(()=>{});
 await page.waitForTimeout(400);
 assert.equal(creations.length,0,'a forced click on the ACTIVE control must not call the creation API');
 assert.equal(await page.locator('#pairing-code').count(),1);
 assert.equal(await page.evaluate(()=>fetch('/api/v0/pairing/info',{headers:{'X-City-Api-Version':'0','X-City-Schema-Version':'0'}}).then(r=>r.json()).then(x=>x.descriptor.pairingSessionId)),sessionBefore,'the canonical session did not rotate');
 await page.evaluate(()=>window.UtopiaI18n.setLocale('en'));
 assert.equal(await generate.innerText(),'Code active · expires on its own');
 assert.equal(await page.locator('#pairing-code').innerText(),codeBefore,'the code itself is unchanged by a locale change');
 assert.equal(await page.locator('#pairing-code').count(),1);
 assert.match(await page.locator('#view').innerText(),/LAN DEVELOPMENT ONLY/);
 // JOIN-501: leaving the page no longer clears the code. Navigation away and back shows the SAME session.
 await page.locator('[data-page="Devices"]').click();
 assert.equal(await page.locator('#pairing-code').count(),0);
 await page.locator('[data-page="Pairing"]').click();
 assert.equal(await page.locator('#pairing-code').count(),1,'the active code survives in-page navigation');
 assert.equal(await page.evaluate(()=>fetch('/api/v0/pairing/info',{headers:{'X-City-Api-Version':'0','X-City-Schema-Version':'0'}}).then(r=>r.json()).then(x=>x.descriptor.pairingSessionId)),sessionBefore,'and it is still the same session');
 await app.close();await page.locator('#connection.online').waitFor({state:'hidden'});
 // JOIN-501: losing the connection is not a reason to destroy the user's code either. The City going away is
 // visible as OFFLINE; the material stays until it is consumed or expires, which is when the rule says it goes.
 assert.equal(await page.locator('#connection').innerText(),'OFFLINE');
 assert.equal(await page.locator('#pairing-code').count(),1,'a disconnect must not clear an unexpired code');
 assert.equal(await generate.isDisabled(),true,'and nothing can be generated while the City is unreachable');
 assert.equal(creations.length,0,'no creation call was made at any point after the first explicit one');
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
 assert.equal(await page.locator('[data-member-card="test-device"] .badge.ONLINE').innerText(),'在线');
 assert.equal(await page.locator('[data-member-card="test-device"] .badge.在线').count(),0);
 await page.evaluate(()=>window.UtopiaI18n.setLocale('en'));
 assert.match(await page.locator('#view').innerText(),/18.0%/);
 await page.locator('[data-node="test-device"]').click();
 for(const expected of ['Agent 0.2.0','Memory','Disk','1h 1m','Capabilities','task.execute.safe','Current tasks','NODE_ONLINE'])assert.ok((await page.locator('#detail').innerText()).includes(expected));
 const stale={...telemetry,observedAt:new Date(Date.now()-15000).toISOString()};
 assert.equal((await fetch(app.url+'/api/v0/node/heartbeat',{method:'POST',headers,body:JSON.stringify({id:'test-device',telemetry:stale})})).status,200);
 await page.locator('#view .telemetry.cached').waitFor();assert.equal(await page.locator('[data-member-card="test-device"] .badge.ONLINE').count(),0);
 const node=app.store.get('nodes','test-device');app.store.put('nodes',{...node,online:false});
 await page.locator('[data-member-card="test-device"] .badge.OFFLINE').waitFor();
 await page.locator('[data-page="Pairing"]').click();await page.getByRole('button',{name:'Generate pairing session',exact:true}).click();await page.locator('#pairing-qr svg').waitFor();
 // JOIN-501: expiry removes the material, says so, and offers generation again - it does not auto-generate.
 await page.locator('#pairing-code').waitFor({state:'detached',timeout:5000});assert.match(await page.locator('#view').innerText(),/expired/);
 await page.getByRole('button',{name:'Generate pairing session',exact:true}).waitFor();
 assert.equal(await page.locator('#pairing-code').count(),0);
 await app.close();await page.locator('#connection.online').waitFor({state:'hidden'});await page.locator('[data-page="Devices"]').click();
 assert.equal(await page.locator('[data-member-card="test-device"] .badge.UNKNOWN').count(),1);assert.equal(await page.locator('#view .telemetry.fresh').count(),0);
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
