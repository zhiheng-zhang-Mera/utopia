import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
test('Services: an old invocation cannot mark a new editor busy or clear its newer invocation',async()=>{
 const dir=await mkdtemp(resolve('.scratch-services-nav-'));let app,browser;
 try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage();await page.goto(app.url);
  const result=await page.evaluate(async()=>{
   const {renderServices}=await import('/services.js');const host=document.createElement('div');document.body.replaceChildren(host);
   const city={capabilities:[{capabilityId:'theme',inputKind:'theme',bridgeState:'AVAILABLE',operations:[{operationId:'generate'}]}],invocations:[]};let releaseOld,releaseNew,calls=0;
   const api=()=>++calls===1?new Promise(r=>releaseOld=r):new Promise(r=>releaseNew=r);
   renderServices(host,city,true,api);host.querySelector('[data-service]').click();host.querySelector('#service-invoke').click();
   host.replaceChildren();renderServices(host,city,true,api);const reentered=host.querySelector('#service-state').textContent;
   host.querySelector('#service-invoke').click();releaseOld({status:'COMPLETED',capabilityId:'theme'});await new Promise(r=>setTimeout(r,0));
   const whileNew=host.querySelector('#service-state').textContent,disabled=host.querySelector('#service-invoke').disabled;
   releaseNew?.({status:'COMPLETED',capabilityId:'theme'});await new Promise(r=>setTimeout(r,0));return {calls,reentered,whileNew,disabled,finished:host.querySelector('#service-state').textContent};
  });assert.deepEqual(result,{calls:2,reentered:'',whileNew:'RUNNING',disabled:true,finished:'COMPLETED'});
 }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
