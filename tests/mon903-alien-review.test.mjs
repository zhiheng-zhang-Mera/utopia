import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createDecisionOverlay} from '../services/dev-gateway/decision.mjs';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {chromium} from 'playwright';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(overlay){for(let i=0;i<300;i++){if(!overlay.metrics().concurrentDecisionTasks)return;await sleep(5);}throw Error('Queue did not drain');}
async function fixture(run,options={}){const dir=await mkdtemp(resolve('.scratch-mon903-review-'));let overlay;try{overlay=createDecisionOverlay({dir,tasks:()=>[{id:'t',state:'FAILED'}],...options});await run(overlay,dir);}finally{await overlay?.close({timeoutMs:2000});await rm(dir,{recursive:true,force:true,maxRetries:10});}}
test('Alien: model OWNER_REQUIRED is an escalation, not auto-resolution',()=>fixture(async overlay=>{
 overlay.submit({kind:'FAILED',taskRef:'t'});await settle(overlay);const row=overlay.snapshot().decisions[0];
 assert.equal(row.action,'OWNER_REQUIRED');assert.equal(row.ownerRequired,true);assert.equal(row.escalationTarget,'OWNER');assert.equal(overlay.metrics().autoResolved,0);
},{fastModel:async()=>({action:'OWNER_REQUIRED',reason:'Needs a person'})}));
test('Alien: canonical observation cannot enqueue decisions after bounded close',()=>fixture(async overlay=>{
 await overlay.close();assert.equal(overlay.observe({type:'TASK_FAILED',taskId:'t',id:'closed-event'}),null);await settle(overlay);assert.equal(overlay.snapshot().decisions.length,0);
}));
test('Alien: retention restart preserves the newest decisions, not UUID lexical order',async()=>{
 const dir=await mkdtemp(resolve('.scratch-mon903-retention-'));let overlay;
 try{await mkdir(resolve(dir,'decisions'));for(const [id,time] of [['ffffffff-ffff-4fff-8fff-ffffffffffff','2020-01-01'],['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','2021-01-01'],['00000000-0000-4000-8000-000000000000','2022-01-01']])await writeFile(resolve(dir,'decisions','decision-'+id+'.json'),JSON.stringify({decisionId:'decision-'+id,decidedAt:time,triggerEvent:{kind:'FAILED'},taskRef:'t',source:'RULE',action:'RETRY_RECOMMENDED',ownerRequired:false}));
 overlay=createDecisionOverlay({dir,tasks:()=>[{id:'t',state:'FAILED',error:'observed'}],retentionLimit:2});
 const {decisionId}=overlay.submit({kind:'RESOURCE_CONFLICT',taskRef:'t'});await settle(overlay);await overlay.close();
 const before=overlay.snapshot().decisions.map(r=>r.decisionId);overlay=createDecisionOverlay({dir,tasks:()=>[],retentionLimit:2});
 assert.ok(overlay.snapshot().decisions.some(r=>r.decisionId===decisionId));assert.deepEqual(overlay.snapshot().decisions.map(r=>r.decisionId),before);
 }finally{await overlay?.close();await rm(dir,{recursive:true,force:true});}
});
test('Alien: queue overflow retains canonical evidence and reports failed receipt persistence',()=>fixture(async(overlay,dir)=>{
 await rm(resolve(dir,'decisions'),{recursive:true});await writeFile(resolve(dir,'decisions'),'not a directory');
 let rejected;for(let i=0;i<17;i++)rejected=overlay.submit({kind:'FAILED',taskRef:'t',eventId:'event-'+i,eventSeq:i,origin:'CANONICAL_EVENT'});
 assert.equal(rejected.queueFull,true);const row=overlay.receipt(rejected.decisionId);
 assert.equal(row.evidenceRefs[0]?.canonicalEventId,'event-16');assert.ok(row.receiptFailure);assert.ok(overlay.snapshot().failures.some(f=>f.code===row.receiptFailure));
},{fastModel:async()=>{await sleep(100);return {action:'RETRY_ADVISORY'};},stageTimeoutMs:200}));
async function browserFixture(run){const dir=await mkdtemp(resolve('.scratch-mon903-ui-review-'));let app,browser;try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});await page.goto(app.url);await run(page);}finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}}
test('Alien: canonical present-but-ineligible target is escalated, not described as recovering offline',()=>fixture(async overlay=>{
 overlay.observe({type:'TASK_TARGET_WAITING',taskId:'t',id:'waiting',payload:{targetDeviceRef:'node-a',targetState:'INELIGIBLE',reason:'target is online but cannot accept work'}});await settle(overlay);
 const row=overlay.snapshot().decisions[0];assert.equal(row.ownerRequired,true);assert.equal(row.escalationReason,'TARGET_PRESENT_BUT_INELIGIBLE');
}));
test('Alien: a timeout remains measurable when the critic subsequently resolves',()=>fixture(async overlay=>{
 overlay.submit({kind:'FAILED',taskRef:'t'});await settle(overlay);const row=overlay.snapshot().decisions[0];assert.equal(row.source,'CRITIC');assert.ok(row.timeoutOrFallback.includes('RESOLVER_TIMEOUT'));assert.equal(overlay.metrics().timeouts,1);
},{fastModel:()=>new Promise(()=>{}),critic:async()=>({action:'RETRY_ADVISORY'}),stageTimeoutMs:10}));
test('Alien Gateway: an online ineligible strict target produces an Owner decision with real event evidence',async()=>{
 const dir=await mkdtemp(resolve('.scratch-mon903-target-review-'));let app;
 try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});
  const post=async(path,body,token='owner')=>{const response=await fetch(app.url+'/api/v0/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
  await post('node/register',{id:'ineligible',displayName:'Observer only',capabilities:[]},'node');await post('node/heartbeat',{id:'ineligible'},'node');
  const action=await post('actions',{route:'CITY_TASK',target:'city.task',operation:'CHECKPOINT_DEMO',input:{targetDeviceRef:'ineligible'},idempotencyKey:'review-target'});
  const task=app.store.get('tasks',action.action.backendRef.taskId);assert.equal(task.targetStateAtCreation,'INELIGIBLE');await settle(app.decisions);
  const row=app.decisions.snapshot().decisions.find(row=>row.taskRef===task.id);assert.equal(row.ownerRequired,true);assert.equal(row.escalationReason,'TARGET_PRESENT_BUT_INELIGIBLE');
  const canonical=app.store.events().find(event=>event.id===row.evidenceRefs[0].canonicalEventId);assert.equal(canonical.type,'TASK_TARGET_WAITING');assert.equal(canonical.payload.targetState,'INELIGIBLE');assert.equal(app.store.get('tasks',task.id).state,'QUEUED');
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
const payload={window:{decisions:[{decisionId:'d',triggerEvent:{kind:'FAILED'},taskRef:'t',source:'RULE',action:'RETRY_RECOMMENDED',ownerRequired:false,decisionLatencyMs:1,queueWaitMs:0}],unsupportedSources:[],failures:[],persistence:'READY'},metrics:{decisions:1,ownerRequired:0,autoResolved:1,autoResolutionRate:1,timeouts:0,unrelatedTaskBlocking:'ABSENT_BY_CONSTRUCTION',concurrentDecisionTasks:0}};
test('Alien browser: polling preserves opened provenance and successful retry clears an old error',()=>browserFixture(async page=>{
 const result=await page.evaluate(async payload=>{
  const {createMonitorDecisionsView}=await import('/monitor-decisions.js');const host=document.createElement('div');document.body.append(host);const view=createMonitorDecisionsView();let fail=false;
  view.render(host,{contextKey:'scope',online:true,isCurrent:()=>true,api:async()=>{if(fail)throw Error('temporary failure');return payload;}});
  await new Promise(r=>setTimeout(r,0));host.querySelector('details').open=true;const details=host.querySelector('details');host.querySelector('#dec-refresh').click();await new Promise(r=>setTimeout(r,0));
  const open=host.querySelector('details').open,same=details===host.querySelector('details');fail=true;host.querySelector('#dec-refresh').click();await new Promise(r=>setTimeout(r,0));fail=false;host.querySelector('#dec-refresh').click();await new Promise(r=>setTimeout(r,0));
  const error=!!host.querySelector('#dec-error');view.reset();return {open,same,error};
 },payload);assert.equal(result.open,true);assert.equal(result.same,true);assert.equal(result.error,false);
}));
test('Alien browser: unavailable decision persistence is visible even before any write failure',()=>browserFixture(async page=>{
 const text=await page.evaluate(async payload=>{const {createMonitorDecisionsView}=await import('/monitor-decisions.js');const host=document.createElement('div');document.body.append(host);const view=createMonitorDecisionsView();payload.window.persistence='UNAVAILABLE';payload.window.persistenceReason='EEXIST';payload.window.decisions=[];view.render(host,{contextKey:'scope',online:true,isCurrent:()=>true,api:async()=>payload});await new Promise(r=>setTimeout(r,0));const text=host.textContent;view.reset();return text;},payload);
 assert.match(text,/memory|persist|store unavailable/i);
}));
test('Alien browser: frequent City rendering cannot starve bounded decision polling',()=>browserFixture(async page=>{
 const calls=await page.evaluate(async payload=>{const {createMonitorDecisionsView}=await import('/monitor-decisions.js');const host=document.createElement('div');document.body.append(host);const view=createMonitorDecisionsView();let calls=0;const options={contextKey:'steady-scope',online:true,isCurrent:()=>true,api:async()=>{calls++;return payload;}};view.render(host,options);for(let i=0;i<25;i++){await new Promise(r=>setTimeout(r,100));view.render(host,options);}view.reset();return calls;},payload);
 assert.ok(calls>=2,'a 2-second projection poll must occur despite ongoing canonical snapshot rendering');
}));
