import '../rooms/theme-builder-lab/tests/core.test.mjs';
import '../rooms/theme-builder-lab/tests/parity.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestHub} from './harness.mjs';

test('D9 Room browser performs intent, observed/unobserved plan, build, preview and fallback',async()=>{
 const hub=await startTestHub(),browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
 try{
  const page=await browser.newPage();await page.goto(hub.base+'/#theme-builder-lab');
  await page.locator('#tb-prompt').fill('blue research compact no persona');await page.locator('#tb-intent').click();await page.locator('#tb-report').filter({hasText:'steel_blue'}).waitFor();
  await page.locator('#tb-observation').selectOption('desktop');await page.locator('#tb-plan').click();await page.locator('#tb-report').filter({hasText:'observed'}).waitFor();
  await page.locator('#tb-build').click();await page.locator('#tb-status').filter({hasText:'PASS'}).waitFor({timeout:30000});
  assert.equal(await page.locator('#tb-preview').evaluate(img=>img.complete&&img.naturalWidth>0),true);assert.match(await page.locator('#tb-report').textContent(),/packageDigest/);
  await page.locator('#tb-observation').selectOption('none');await page.locator('#tb-failure').check();await page.locator('#tb-build').click();await page.locator('#tb-status').filter({hasText:'PASS'}).waitFor({timeout:30000});
  const report=JSON.parse(await page.locator('#tb-report').textContent());assert.equal(report.degraded,true);assert.ok(report.fallback.degraded_assets.length>0);assert.equal(report.globalThemeApply,false);
 }finally{await browser.close();await hub.stop();}
});
