import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';

const out=resolve(process.argv[2]??'evidence/raw/mission-book/MON-902/alien-review');
await mkdir(out,{recursive:true});
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const dir=await mkdtemp(resolve('.scratch-mon902-capture-'));let app,browser;
try{
 app=await createGateway({dir,port:0,token:'review-fixture-owner',nodeToken:'review-fixture-node',roomsDisabled:true});
 const headers={Authorization:'Bearer review-fixture-owner','Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'};
 const request=async(path,body,auth=headers)=>{const response=await fetch(app.url+'/api/v0/'+path,{headers:auth,...(body?{method:'POST',body:JSON.stringify(body)}:{})});if(!response.ok)throw Error(path+': '+response.status);return response.json();};
 await request('node/register',{id:'review-node',displayName:'Review node',capabilities:['task.execute.safe','filesystem.temp']},{...headers,Authorization:'Bearer review-fixture-node'});
 const task=await request('tasks',{type:'WAIT'});
 await request('node/claim',{id:'review-node'},{...headers,Authorization:'Bearer review-fixture-node'});
 const {graph}=await request('monitor/graph');
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
 const page=await browser.newPage({locale:'en-US',viewport:{width:1365,height:900}});page.setDefaultTimeout(5000);
 await page.goto(app.url);await page.locator('#token').fill('review-fixture-owner');await page.locator('#connect').click();await page.locator('#connection.online').waitFor();
 await page.locator('[data-page="Monitor"]').click();await page.locator('.monitor-panel[data-loaded="true"]').waitFor();
 await page.locator('.monitor-panel [data-monitor-node="'+task.id+'"]').first().click();
 await page.locator('.monitor-inspector [data-monitor-edge]').first().click();
 const button=page.locator('.monitor-inspector [data-evidence]').first();const ref=await button.getAttribute('data-evidence');await button.click();
 const record=JSON.parse(await page.locator('#monitor-evidence pre').innerText());
 if(record.source!=='CANONICAL_GATEWAY_STORE'||record.reference!==ref)throw Error('Exact reference reconciliation failed');
 await page.screenshot({path:resolve(out,'three-step-evidence.png'),fullPage:true});
 await writeFile(resolve(out,'runtime-capture.json'),JSON.stringify({sourceSha,host:process.env.COMPUTERNAME,measuredAt:new Date().toISOString(),fixture:'REAL_ISOLATED_GATEWAY_CANONICAL_STORE',surface:'HEADLESS_EDGE_WEB',cityId:graph.projectionOf.cityId,taskId:task.id,evidenceRef:ref,navigationStepsToEvidence:3,steps:['overview task','assignment path','canonical event evidence'],nodeCount:graph.nodes.length,visibleNodeCount:graph.visibleNodeIds.length,edgeCount:graph.edges.length,activeRiskPresent:graph.summary.activeRiskPresent,edgeReasons:graph.edges.map(e=>({type:e.type,reason:e.reason})),physicalAndroid:'NOT_RUN',exactEvidence:record},null,2)+'\n');
 console.log(JSON.stringify({sourceSha,evidenceRef:ref,navigationStepsToEvidence:3}));
}finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
