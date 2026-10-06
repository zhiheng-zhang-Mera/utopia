import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {chromium} from 'playwright';import {createGateway} from '../services/dev-gateway/server.mjs';
test('Research Danger Zone requires explicit confirmation and offers real emergency stop',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex804-web-'));const app=await createGateway({dir,port:0,token:'ctl',nodeToken:'node',roomsDisabled:true});const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});
 try{
  await fetch(app.url+'/api/v0/node/register',{method:'POST',headers:{Authorization:'Bearer node','Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:JSON.stringify({id:'target',displayName:'Target',metadata:{platform:'reference'},capabilities:['task.execute.safe','filesystem.temp']})});
  await page.goto(app.url);await page.locator('#token').fill('ctl');await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Research"]').click();await page.locator('#fault-danger').waitFor({timeout:2000});await page.locator('#fault-danger > summary').click();
  await page.locator('#fault-node').selectOption('target');await page.locator('#fault-kind').selectOption('PROVIDER_UNAVAILABLE');await page.locator('#fault-duration').fill('3000');await page.locator('#fault-start').click();await page.locator('#fault-error').filter({hasText:'FAULT_CONFIRMATION_REQUIRED'}).waitFor();assert.equal(app.faults.list().faults.length,0);
  await page.locator('#fault-confirmation').fill('FAULT:PROVIDER_UNAVAILABLE:target');await page.locator('#fault-start').click();await page.locator('#fault-output').filter({hasText:'ACTIVE'}).waitFor();assert.equal(app.faults.list().faults[0].status,'ACTIVE');await page.locator('#fault-stop').click();await page.locator('#fault-output').filter({hasText:'STOPPED'}).waitFor();assert.equal(app.faults.list().faults[0].status,'STOPPED');
  // ADOPTED from repair/REX-804-mech-test-evidence-outside-repo (690d723), whose single hunk this is: the screenshot
  // goes to the git-ignored runtime directory, NOT to the tracked evidence path the workbook cites. The first version
  // wrote to 'evidence/raw/mission-book/REX-804/danger-zone.png', a COMMITTED artefact, so every green run silently
  // replaced the reviewed evidence of the accepted head with a freshly rendered browser image whose bytes depend on the
  // browser, fonts, DPI and viewport of whoever ran it - and left the tree dirty after passing. Evidence that changes
  // when you verify it is not evidence. The sibling REX-803 web test already writes under '.runtime/evidence/...'.
  // Measured after this change: the suite passes and `git status` stays clean.
  await mkdir('.runtime/evidence/mission-book/REX-804',{recursive:true});await page.screenshot({path:'.runtime/evidence/mission-book/REX-804/danger-zone.png',fullPage:true});
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
