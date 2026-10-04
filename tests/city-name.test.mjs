import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {chromium} from 'playwright';
const headers={'X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json',Authorization:'Bearer owner'};
test('custom City name is canonical across snapshot, pairing, discovery descriptor and restart',async()=>{
 const dir=await mkdtemp(resolve('.scratch-city-name-'));let app;
 try{
  app=await createGateway({dir,port:0,token:'owner',nodeToken:'node'});
  const cityId=app.store.cityId;
  const rename=await fetch(app.url+'/api/v0/city/name',{method:'PATCH',headers,body:JSON.stringify({displayName:'悉尼花园'})});
  assert.equal(rename.status,200);
  for(const route of ['city','pairing/info']) {
   const body=await (await fetch(app.url+'/api/v0/'+route,{headers})).json();
   assert.equal(body.displayName,'悉尼花园');assert.equal(body.descriptor.displayName,'悉尼花园');
  }
  assert.equal((await fetch(app.url+'/api/v0/city/name',{method:'PATCH',headers,body:'{"displayName":" "}'})).status,400);
  await app.close();app=await createGateway({dir,port:0,token:'owner',nodeToken:'node'});
  assert.equal(app.store.cityId,cityId);
  assert.equal((await (await fetch(app.url+'/api/v0/pairing/info',{headers})).json()).displayName,'悉尼花园');
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
test('Settings changes the visible City name and keeps editing stable across snapshots',async()=>{
 const dir=await mkdtemp(resolve('.scratch-city-name-web-'));let app,browser;
 try{
  app=await createGateway({dir,port:0,token:'owner',nodeToken:'node'});
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
  const page=await browser.newPage({locale:'en-US'});await page.goto(app.url+'/#token=owner');
  await page.locator('#connection.online').waitFor();await page.locator('[data-page="Settings"]').click();
  const name=page.locator('#city-name');await name.fill('墨尔本城市');await name.focus();
  await page.waitForTimeout(3500);assert.equal(await name.inputValue(),'墨尔本城市');assert.equal(await name.evaluate(el=>el===document.activeElement),true);
  await page.getByRole('button',{name:'Save City name',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#city-display-name').textContent==='墨尔本城市');
  await page.locator('[data-page="Pairing"]').click();assert.match(await page.locator('#view').innerText(),/墨尔本城市/);
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
