import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const output='.runtime/evidence/wave3/windows';fs.mkdirSync(output,{recursive:true});
const config=JSON.parse(fs.readFileSync('.runtime/local-config.json')),{url}=JSON.parse(fs.readFileSync('.runtime/processes.json'));
const browser=await chromium.launch({channel:'msedge',headless:false}),page=await browser.newPage({locale:'en-US',viewport:{width:1440,height:1050}});
const report={sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Headed Windows Edge, real Theme Build controls, public prompt, local Gateway',rows:[]};
const save=()=>fs.writeFileSync(output+'/runs.json',JSON.stringify(report,null,2)+'\n');
try{
 await page.goto(url);await page.locator('#token').fill(config.token);await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Services"]').click();await page.locator('[data-service="presentation.theme.lab"]').click();await page.locator('#theme-operation').selectOption('build');await page.locator('#theme-prompt').fill('blue research compact no persona');
 for(const [name,observation,injectFailure]of [['observed-offline','desktop',false],['unobserved-offline','none',false],['unobserved-fallback','none',true]]){
  await page.locator('#theme-observation').selectOption(observation);await page.locator('#theme-failure').setChecked(injectFailure);
  const response=page.waitForResponse(r=>r.url().endsWith('/capabilities/presentation.theme.lab/invoke'));await page.locator('#service-invoke').click();const row=await(await response).json();assert.equal(row.status,'COMPLETED');
  await page.locator('#service-state').filter({hasText:'COMPLETED'}).waitFor();await page.waitForFunction(()=>document.querySelector('#theme-preview')?.naturalWidth>0);assert.ok((await page.locator('#service-id').textContent()).includes(row.invocationId));assert.ok((await page.locator('#service-summary').textContent()).includes(row.result.packageDigest));assert.equal(row.result.globalThemeApply,false);assert.equal(row.result.validation.ok,true);assert.equal(row.result.observed,observation==='desktop');
  await page.locator('#service-editor').screenshot({path:output+'/'+name+'.png'});report.rows.push({case:name,invocationId:row.invocationId,resultDigest:row.resultDigest,result:row.result,previewAndPackageDigestVisible:true,pass:true});save();
 }
 const last=report.rows.at(-1);await page.reload();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Services"]').click();await page.locator('[data-invocation="'+last.invocationId+'"]').click();await page.waitForFunction(d=>document.querySelector('#service-summary')?.textContent.includes(d),last.result.packageDigest);await page.waitForFunction(()=>document.querySelector('#theme-preview')?.naturalWidth>0);report.historyDetailAfterReload=true;
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=error.message.split('\n')[0];process.exitCode=1;}finally{save();await browser.close();console.log(JSON.stringify({status:report.status,cases:report.rows.length,output,error:report.error}));}
