import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
test('Research: reconnecting the same credential and City preserves its draft',async()=>{
 const dir=await mkdtemp(resolve('.scratch-research-reconnect-'));let app,browser;
 try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage();page.setDefaultTimeout(5000);
  await page.goto(app.url);await page.locator('#token').fill('owner');await page.locator('#connect').click();await page.locator('#connection.online').waitFor();await page.locator('[data-page="Research"]').click();await page.waitForFunction(()=>!document.querySelector('#research-manifest')?.disabled);
  const draft='{"softwareRefs":["utopia@main"],"question":"Preserve this unfinished draft"}';await page.locator('#research-manifest').fill(draft);
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await page.waitForFunction(()=>document.querySelector('#research-register')?.disabled);
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.locator('#connection.online').waitFor();assert.equal(await page.locator('#research-manifest').inputValue(),draft);
  const scopes=await page.evaluate(async()=>{
   const {renderResearch}=await import('/research.js');const host=document.createElement('div');document.body.append(host);let release;
   const api=async(path)=>path.endsWith('/validate')?new Promise(r=>release=r):{research:{capabilityVocabulary:[]},experiments:[]};
   renderResearch(host,true,api,'credential-A|City-A');await new Promise(r=>setTimeout(r,0));const editor=host.querySelector('#research-manifest');editor.value='{"question":"keep"}';editor.dispatchEvent(new Event('input'));host.querySelector('#research-validate').click();
   host.replaceChildren();renderResearch(host,true,api,'credential-A|City-A');const retained=host.querySelector('#research-manifest').value,enabled=!host.querySelector('#research-validate').disabled;
   release({validation:'OLD_SCOPE_RESPONSE'});await new Promise(r=>setTimeout(r,0));const leaked=host.textContent.includes('OLD_SCOPE_RESPONSE');renderResearch(host,true,api,'credential-B|City-A');const otherDraft=host.querySelector('#research-manifest').value;return {retained,enabled,leaked,otherDraft};
  });assert.deepEqual(scopes,{retained:'{"question":"keep"}',enabled:true,leaked:false,otherDraft:''});
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
