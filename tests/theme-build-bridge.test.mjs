import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {chromium} from 'playwright';
import {createThemeArtifacts} from '../services/capability-bridge/theme-artifacts.mjs';
const headers={Authorization:'Bearer theme-test','X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'};
const input={prompt:'blue research compact no persona',observationPreset:'desktop',injectFailure:false};
test('theme artifact retention is bounded and restart removes abandoned sandbox work',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-artifact-retention-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const artifacts=createThemeArtifacts(root),ids=[];
 for(let n=0;n<10;n++){const id='I-00000000-0000-0000-0000-'+String(n).padStart(12,'0');ids.push(id);const dir=artifacts.allocate(id);fs.mkdirSync(path.join(dir,'package'));fs.writeFileSync(path.join(dir,'package','manifest.json'),'{}');artifacts.finish(id,true);}
 assert.equal(fs.readdirSync(root).length,8);
 const abandoned='I-00000000-0000-0000-0000-999999999999';fs.mkdirSync(path.join(artifacts.allocate(abandoned),'.build-partial'));
 createThemeArtifacts(root);assert.equal(fs.existsSync(path.join(root,abandoned)),false);assert.equal(fs.readdirSync(root).length,8);
});
test('D9 Bridge builds retained sandbox artifacts with canonical bounded results and typed refusal',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-build-bridge-'));let g=await createGateway({dir,port:0,token:'theme-test',nodeToken:'theme-node'});t.after(async()=>{await g.close();fs.rmSync(dir,{recursive:true,force:true});});
 const invoke=async body=>(await fetch(g.url+'/api/v0/capabilities/presentation.theme.lab/invoke',{method:'POST',headers,body:JSON.stringify({operationId:'build',input:body})})).json();
 const a=await invoke(input),b=await invoke(input);assert.equal(a.status,'COMPLETED',JSON.stringify(a));assert.equal(b.status,'COMPLETED');assert.equal(a.resultDigest,b.resultDigest);assert.equal(a.result.validation.ok,true);assert.equal(a.result.globalThemeApply,false);
 for(const key of ['intentDigest','planDigest','packageDigest','contentDigest','validationDigest'])assert.match(a.result[key],/^[0-9a-f]{64}$/);
 assert.ok(a.result.previewPngBase64);assert.ok(JSON.stringify(a.result).length<100000);assert.ok(!JSON.stringify(a.result).includes(dir));
 assert.ok(fs.existsSync(path.join(dir,'theme-packages',a.invocationId,'package','manifest.json')));
 const snapshot=await(await fetch(g.url+'/api/v0/city',{headers})).json();assert.ok(snapshot.invocations.every(row=>!('result' in row)));
 const fallback=await invoke({...input,observationPreset:'none',injectFailure:true});assert.equal(fallback.status,'COMPLETED');assert.equal(fallback.result.degraded,true);assert.ok(fallback.result.fallback.degraded_assets.length>0);
 for(const [body,code]of [[{...input,outDir:'../escape'},'OUTPUT_PATH_FORBIDDEN'],[{...input,targetSurface:'protected_external_surface'},'PROTECTED_SURFACE'],[{...input,observation:{}},'INVALID_OBSERVATION']]){const rejected=await invoke(body);assert.equal(rejected.status,'FAILED');assert.equal(rejected.errorCode,code);}
 await g.close();g=await createGateway({dir,port:0,token:'theme-test',nodeToken:'theme-node'});const detail=await(await fetch(g.url+'/api/v0/capability-invocations/'+a.invocationId,{headers})).json();assert.equal(detail.resultDigest,a.resultDigest);assert.equal(detail.result.packageDigest,a.result.packageDigest);
});
test('Windows Theme Build uses real prompt, observation, fallback controls and digest summary',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-build-web-')),g=await createGateway({dir,port:0,token:'theme-test',nodeToken:'theme-node'}),browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
 try{const page=await browser.newPage({locale:'en-US'});await page.goto(g.url);await page.locator('#token').fill('theme-test');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Services"]').click();await page.locator('[data-service="presentation.theme.lab"]').click();await page.locator('#theme-operation').selectOption('build');await page.locator('#theme-prompt').fill(input.prompt);await page.locator('#theme-observation').selectOption('desktop');await page.locator('#service-invoke').click();await page.locator('#service-state').filter({hasText:'COMPLETED'}).waitFor({timeout:30000});await page.waitForFunction(()=>document.querySelector('#theme-preview')?.naturalWidth>0);assert.match(await page.locator('#service-summary').textContent(),/Package|包/);
 }finally{await browser.close();await g.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('unavailable artifact storage yields a terminal typed failure, not orphaned RUNNING history',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-build-storage-')),g=await createGateway({dir,port:0,token:'theme-test',nodeToken:'theme-node'});t.after(async()=>{await g.close();fs.rmSync(dir,{recursive:true,force:true});});
 const root=path.join(dir,'theme-packages');fs.rmSync(root,{recursive:true});fs.writeFileSync(root,'storage unavailable');
 const response=await fetch(g.url+'/api/v0/capabilities/presentation.theme.lab/invoke',{method:'POST',headers,body:JSON.stringify({operationId:'build',input})});const row=await response.json();assert.equal(row.status,'FAILED');assert.equal(row.errorCode,'BUILD_STORAGE_UNAVAILABLE');
 const snapshot=await(await fetch(g.url+'/api/v0/city',{headers})).json();assert.equal(snapshot.invocations.at(-1).status,'FAILED');
});
