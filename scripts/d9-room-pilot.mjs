// Run against the accepted incubator commit; promotion intentionally retires it.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {createRoomHubServer,HOST} from '../apps/rooms/hub/server.mjs';
const output=path.resolve('.runtime/evidence/wave3/room');fs.mkdirSync(output,{recursive:true});
const hub=await createRoomHubServer({runtimeDir:path.join(output,'runtime'),only:['theme-builder-lab']});await new Promise(resolve=>hub.listen(0,HOST,resolve));
const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
const record={scope:'D9 Room product pilot; generated public prompts only',sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),browser:'Chromium/Edge',cases:[],globalThemeApply:false};
try{
 const page=await browser.newPage({viewport:{width:1440,height:1050}});await page.goto(`http://${HOST}:${hub.address().port}/#theme-builder-lab`);
 await page.locator('#tb-prompt').fill('blue research compact no persona');await page.locator('#tb-intent').click();await page.locator('#tb-report').filter({hasText:'steel_blue'}).waitFor();record.cases.push({case:'prompt-intent',status:'PASS',intent:JSON.parse(await page.locator('#tb-report').textContent())});
 for(const [name,observation,failure]of [['observed-offline','desktop',false],['unobserved-fallback','none',true]]){
  await page.locator('#tb-observation').selectOption(observation);await page.locator('#tb-failure').setChecked(failure);await page.locator('#tb-plan').click();await page.locator('#tb-report').filter({hasText:'surface_plan'}).waitFor();const plan=JSON.parse(await page.locator('#tb-report').textContent());
  await page.locator('#tb-build').click();await page.locator('#tb-status').filter({hasText:'PASS'}).waitFor({timeout:60000});await page.waitForFunction(()=>document.querySelector('#tb-preview')?.naturalWidth>0);
  const result=JSON.parse(await page.locator('#tb-report').textContent());if(result.observed!==(observation==='desktop')||result.globalThemeApply!==false)throw Error('untruthful result');if(failure&&(!result.degraded||!result.fallback.degraded_assets.length))throw Error('fallback missing');
  await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});record.cases.push({case:name,status:'PASS',plan,result,previewVisible:true});
 }
 record.status='PASS';fs.writeFileSync(path.join(output,'room-pilot.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({status:record.status,cases:record.cases.length,sourceSha:record.sourceSha}));
}finally{await browser.close();await new Promise(resolve=>hub.close(resolve));}
