import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
test('Windows Services invokes real document, knowledge, skill, evidence and theme adapters',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'utopia-services-'));const g=await createGateway({dir,port:0,token:'service-test',nodeToken:'service-node'});
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});
 try{
  await page.goto(g.url);await page.locator('#token').fill('service-test');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();
  await page.locator('[data-page="Services"]').click();
  await page.locator('[data-service="planning.document.intake"]').click();
  await page.locator('#service-file').setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('Utopia shared knowledge')});
  await page.locator('#service-invoke').click();await page.locator('#service-state').filter({hasText:'COMPLETED'}).waitFor();
  assert.match(await page.locator('#service-summary').innerText(),/Utopia shared knowledge/);
  await page.locator('#document-to-knowledge').click();await page.locator('#service-invoke').click();await page.locator('#service-state').filter({hasText:'COMPLETED'}).waitFor();
  assert.match(await page.locator('#service-summary').innerText(),/Utopia shared knowledge/);
  for(const id of ['engineering.skill.inspect','research.evidence.review','presentation.theme.lab']){
   await page.locator('[data-service="'+id+'"]').click();await page.locator('#service-invoke').click();await page.locator('#service-state').filter({hasText:'COMPLETED'}).waitFor();
  }
  assert.ok(await page.locator('#theme-preview').getAttribute('src'));
  await page.locator('[data-service="research.evidence.review"]').click();await page.locator('#service-tamper').click();await page.locator('#service-state').filter({hasText:'FAILED'}).waitFor();assert.match(await page.locator('#service-summary').innerText(),/ARTIFACT_HASH_MISMATCH/);
 }finally{await browser.close();await g.close();await rm(dir,{recursive:true,force:true});}
});
