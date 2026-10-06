import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
const out=resolve('evidence/raw/mission-book/MON-903/alien-review');await mkdir(out,{recursive:true});
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const dir=await mkdtemp(resolve('.scratch-mon903-capture-'));let app,browser;
try{
 app=await createGateway({dir,port:0,token:'review-owner',nodeToken:'review-node',roomsDisabled:true});
 const request=async(path,body,token='review-owner')=>{const response=await fetch(app.url+'/api/v0/'+path,{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});if(!response.ok)throw Error(path+': '+response.status);return response.json();};
 await request('node/register',{id:'capture-node',displayName:'Review worker',capabilities:['task.execute.safe','filesystem.temp']},'review-node');
 await request('tasks',{type:'WAIT'});const {task}=await request('node/claim',{id:'capture-node'},'review-node');
 await request('node/report',{id:'capture-node',taskId:task.id,state:'RUNNING',progress:40},'review-node');
 await request('node/report',{id:'capture-node',taskId:task.id,state:'FAILED',progress:60,error:'Fixture endpoint refused work'},'review-node');
 await request('monitor/decisions',{kind:'SCOPE_CHANGE',taskRef:task.id,reason:'Bounded review fixture scope change'});
 for(let i=0;i<100&&app.decisions.metrics().concurrentDecisionTasks;i++)await new Promise(r=>setTimeout(r,5));
 const records=await request('monitor/decisions');
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US',viewport:{width:1600,height:1000}});page.setDefaultTimeout(5000);
 await page.goto(app.url);await page.locator('#token').fill('review-owner');await page.locator('#connect').click();await page.locator('#connection.online').waitFor();await page.locator('[data-page="Decisions"]').click();await page.locator('#dec-table tbody tr').first().waitFor();await page.locator('details[data-provenance] summary').first().click();
 await page.screenshot({path:resolve(out,'decision-provenance.png'),fullPage:true});
 await writeFile(resolve(out,'runtime-capture.json'),JSON.stringify({sourceSha,host:process.env.COMPUTERNAME,measuredAt:new Date().toISOString(),fixture:'REAL_ISOLATED_GATEWAY_CANONICAL_STORE',surface:'HEADLESS_EDGE_WEB',cityId:app.store.cityId,canonicalTask:app.store.get('tasks',task.id),decisionWindow:records.window,metrics:records.metrics,unrelatedTaskBlockingMeasurement:'NOT_RUN_IN_THIS_CAPTURE; see independent per-task tests',realModelProvider:'NOT_RUN',physicalAndroid:'NOT_RUN',physicalCrossDevice:'NOT_RUN'},null,2)+'\n');
 console.log(JSON.stringify({sourceSha,decisions:records.window.decisions.length,ownerRequired:records.metrics.ownerRequired}));
}finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
