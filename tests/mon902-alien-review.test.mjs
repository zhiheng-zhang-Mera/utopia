import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {buildGraph} from '../services/dev-gateway/monitor-graph.mjs';
import {monitorOverview,monitorPathPanel} from '../apps/web/monitor-graph.js';
import {createGateway} from '../services/dev-gateway/server.mjs';

const view=nodes=>({cityId:'review-city',health:'COMPLETE',nodes,edges:[],events:[],evidence:[],completeness:{tasksOmitted:0,nodesOmitted:0,eventsOmitted:0,historyGap:false},projectedAt:'2026-10-06T00:00:00Z'});
const task=(id,state='RUNNING',extra={})=>({id,kind:'TASK',state,taskType:'WAIT',...extra});
test('Alien: completed work does not imply an offline host is holding executable work or current retry/wait',()=>{
 const input=view([task('done','COMPLETED',{hostRef:'host'}),{id:'host',kind:'HOST',online:false}]);
 input.events=[{type:'TASK_TARGET_WAITING',taskRef:'done',evidenceRef:'wait'},{type:'TASK_SWITCH_DECLINED',taskRef:'done'},{type:'TASK_SWITCH_DECLINED',taskRef:'done'}];
 const graph=buildGraph(input);
 assert.ok(!graph.nodes.find(n=>n.id==='host').riskReasons.some(r=>r.code==='DEVICE_OFFLINE_HOLDING_WORK'));
 assert.ok(!graph.nodes.find(n=>n.id==='done').riskReasons.some(r=>['DEVICE_ROUTE_WAITING','PATH_REPEATED'].includes(r.code)));
});
test('Alien: missing coverage metadata cannot yield a calm graph',()=>{
 for(const metadata of [{},{health:'COMPLETE',completeness:{}},{health:'NOT_OBSERVED'}]){
  const graph=buildGraph({nodes:[],edges:[],events:[],...metadata});
  assert.equal(graph.summary.activeRiskPresent,true);assert.notEqual(graph.summary.worstRisk,'NONE');assert.equal(graph.summary.unobserved.tasks,null);
 }
});
test('Alien: collapsed normal work stays collapsed in actual rendered overview, with stable visible order',()=>{
 const nodes=Array.from({length:150},(_,i)=>task('task-'+String(i).padStart(3,'0')));
 const graph=buildGraph(view(nodes),{maxVisibleNodes:30});
 const overview=monitorOverview(graph);
 assert.ok((overview.match(/data-monitor-node=/g)||[]).length<=30,'rendering must honor collapsed clusters');
 assert.match(overview,/data-monitor-cluster/);
 const ordered=ns=>[...monitorOverview(buildGraph(view(ns))).matchAll(/data-monitor-node="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(ordered([task('b'),task('a')]),ordered([task('a'),task('b')]));
});
test('Alien: a path preserves observed event provenance and explicitly unknown timing',()=>{
 const input=view([task('t','RUNNING',{hostRef:'h'}),{kind:'HOST',id:'h',online:true}]);
 input.edges=[{from:'t',to:'h',type:'ASSIGNED_TO',reason:'Canonical task.assignedNodeId',targetPresent:true}];
 input.events=[{type:'TASK_STARTED',taskRef:'t',canonicalEventId:'event-1',evidenceRef:'event-1',timestamp:'2026-10-06T00:00:00Z'}];
 input.evidence=[{canonicalEventId:'event-1',path:'/api/v0/events',source:'CANONICAL_GATEWAY_STORE',cityId:'review-city'}];
 const graph=buildGraph(input);const edge=graph.edges[0];
 assert.ok(edge.evidenceRefs?.includes('event-1'));assert.equal(edge.durationMs,null);
 assert.match(monitorPathPanel(graph,edge.id),/event-1/);
});
test('Alien: a failure points to its matching transition, not an unrelated later event',()=>{
 const input=view([task('t','FAILED')]);input.events=[{type:'TASK_FAILED',taskRef:'t',evidenceRef:'failure'},{type:'LATER_OBSERVATION',taskRef:'t',evidenceRef:'unrelated'}];
 assert.equal(buildGraph(input).nodes.find(n=>n.id==='t').riskReasons[0].evidenceRef,'failure');
});

const headers={Authorization:'Bearer owner','Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'};
async function fixture(run){const dir=await mkdtemp(resolve('.scratch-mon902-review-'));let app,browser;try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US'});page.setDefaultTimeout(5000);await run(app,page);}finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}}
async function connect(app,page){await page.goto(app.url);await page.locator('#token').fill('owner');await page.locator('#connect').click();await page.locator('#connection.online').waitFor();}
test('Alien browser: offline invalidates a delayed monitor response',async()=>fixture(async(app,page)=>{
 const response=await fetch(app.url+'/api/v0/tasks',{method:'POST',headers,body:'{"type":"WAIT"}'});assert.equal(response.status,200);
 const graph=(await(await fetch(app.url+'/api/v0/monitor/graph',{headers})).json()).graph;
 await connect(app,page);let release;const gate=new Promise(r=>release=r);let arrived;const seen=new Promise(r=>arrived=r);
 await page.route('**/api/v0/monitor/graph',async route=>{arrived();await gate;await route.fulfill({contentType:'application/json',body:JSON.stringify({apiVersion:0,schemaVersion:0,graph})});});
 await page.locator('[data-page="Monitor"]').click();await seen;
 await page.evaluate(()=>window.dispatchEvent(new Event('offline')));release();
 await page.waitForTimeout(150);
 const text=await page.locator('#view').innerText();assert.match(text,/Reconnect|offline/i);assert.equal(await page.locator('.monitor-panel[data-loaded="true"]').count(),0);
}));
test('Alien browser: an old credential response cannot replace the new scope or another page',async()=>fixture(async(app,page)=>{
 const graph=(await(await fetch(app.url+'/api/v0/monitor/graph',{headers})).json()).graph;
 const outcome=await page.goto(app.url).then(()=>page.evaluate(async graph=>{
  const {createMonitorGraphView}=await import('/monitor-graph.js');const host=document.createElement('div');document.body.append(host);
  const view=createMonitorGraphView();let finish;const old=new Promise(r=>finish=r);let current=true;
  const options={cityId:graph.projectionOf.cityId,online:true,snapshotAt:'first',isCurrent:()=>current};
  const previous=structuredClone(graph);previous.nodes=[{id:'old-private',kind:'TASK',label:'OLD_SCOPE',state:'RUNNING',riskReasons:[]}];previous.visibleNodeIds=['old-private'];
  view.render(host,{...options,contextKey:'previous-credential',api:()=>old});
  view.render(host,{...options,contextKey:'new-credential',api:async()=>({graph})});
  await new Promise(r=>setTimeout(r,0));finish({graph:previous});await new Promise(r=>setTimeout(r,0));
  const afterScope=host.textContent;
  let finishNavigation;const navigationRequest=new Promise(r=>finishNavigation=r);
  view.render(host,{...options,contextKey:'third-credential',api:()=>navigationRequest});
  view.reset();host.textContent='OTHER_PAGE';current=false;finishNavigation({graph:previous});await new Promise(r=>setTimeout(r,0));
  return {afterScope,afterNavigation:host.textContent};
 },graph));
 assert.doesNotMatch(outcome.afterScope,/OLD_SCOPE/);assert.equal(outcome.afterNavigation,'OTHER_PAGE');
}));
test('Alien browser: a newer canonical snapshot arriving during a fetch receives a follow-up projection',async()=>fixture(async(app,page)=>{
 const graph=(await(await fetch(app.url+'/api/v0/monitor/graph',{headers})).json()).graph;
 const result=await page.goto(app.url).then(()=>page.evaluate(async graph=>{
  const {createMonitorGraphView}=await import('/monitor-graph.js');const host=document.createElement('div');document.body.append(host);
  const view=createMonitorGraphView();let finish;const first=new Promise(r=>finish=r);let calls=0;
  const fresh=structuredClone(graph);fresh.nodes=[{id:'latest',kind:'TASK',label:'LATEST_VIEW',state:'RUNNING',riskReasons:[]}];fresh.visibleNodeIds=['latest'];
  const options={contextKey:'same-scope',cityId:graph.projectionOf.cityId,online:true,isCurrent:()=>true,api:()=>++calls===1?first:Promise.resolve({graph:fresh})};
  view.render(host,{...options,snapshotAt:'before'});view.render(host,{...options,snapshotAt:'after'});finish({graph});
  await new Promise(r=>setTimeout(r,30));return {calls,text:host.textContent};
 },graph));assert.equal(result.calls,2);assert.match(result.text,/LATEST_VIEW/);
}));
test('Alien browser: heartbeat-only refresh preserves visible row identity',async()=>fixture(async(app,page)=>{
 const graph=(await(await fetch(app.url+'/api/v0/monitor/graph',{headers})).json()).graph;
 const result=await page.goto(app.url).then(()=>page.evaluate(async graph=>{
  const {createMonitorGraphView}=await import('/monitor-graph.js');const host=document.createElement('div');document.body.append(host);
  graph.nodes=[{id:'steady',kind:'TASK',label:'Steady task',state:'RUNNING',riskReasons:[]}];graph.visibleNodeIds=['steady'];
  const view=createMonitorGraphView();let count=0;
  const options={contextKey:'scope',cityId:graph.projectionOf.cityId,online:true,isCurrent:()=>true,api:async()=>{const next=structuredClone(graph);next.projectionOf.observedAt=String(++count);return {graph:next};}};
  view.render(host,{...options,snapshotAt:'one'});await new Promise(r=>setTimeout(r,0));
  const row=host.querySelector('[data-monitor-node="steady"]');
  host.querySelector('[data-monitor-node="steady"]').click();
  const proof=host.querySelector('.monitor-inspector [data-evidence]');proof.dataset.evidence='observation:health';proof.click();
  const selectedRow=host.querySelector('[data-monitor-node="steady"]');
  view.render(host,{...options,snapshotAt:'two'});await new Promise(r=>setTimeout(r,0));
  return {count,same:selectedRow===host.querySelector('[data-monitor-node="steady"]'),proof:JSON.parse(host.querySelector('#monitor-evidence pre').textContent).projection.observedAt};
 },graph));assert.equal(result.count,2);assert.equal(result.same,true);assert.equal(result.proof,'2');
}));
test('Alien browser: assignment path reaches real canonical event in three interactions',async()=>fixture(async(app,page)=>{
 const nodeHeaders={...headers,Authorization:'Bearer node'};
 const register=await fetch(app.url+'/api/v0/node/register',{method:'POST',headers:nodeHeaders,body:JSON.stringify({id:'review-node',displayName:'Review node',capabilities:['task.execute.safe','filesystem.temp']})});assert.equal(register.status,200);
 const created=await fetch(app.url+'/api/v0/tasks',{method:'POST',headers,body:'{"type":"WAIT"}'});assert.equal(created.status,200);const task=await created.json();
 const claim=await fetch(app.url+'/api/v0/node/claim',{method:'POST',headers:nodeHeaders,body:'{"id":"review-node"}'});assert.equal(claim.status,200);assert.equal((await claim.json()).task.id,task.id);
 await connect(app,page);await page.locator('[data-page="Monitor"]').click();await page.locator('.monitor-panel[data-loaded="true"]').waitFor();
 await page.locator('.monitor-panel [data-monitor-node="'+task.id+'"]').first().click();
 await page.locator('.monitor-inspector [data-monitor-edge]').first().click();
 const evidence=page.locator('.monitor-inspector [data-evidence]').first();const ref=await evidence.getAttribute('data-evidence');await evidence.click();
 assert.match(await page.locator('#monitor-evidence').innerText(),new RegExp(ref));
 assert.match(await page.locator('#monitor-evidence').innerText(),/CANONICAL_GATEWAY_STORE/);
}));
test('Alien browser: cluster expands, edge filter is reachable and evidence opens exact canonical reference',async()=>fixture(async(app,page)=>{
 for(let i=0;i<140;i++){const r=await fetch(app.url+'/api/v0/tasks',{method:'POST',headers,body:'{"type":"WAIT"}'});assert.equal(r.status,200);}
 const source=(await(await fetch(app.url+'/api/v0/monitor/graph',{headers})).json()).graph;
 const observedTasks=source.nodes.filter(n=>n.kind==='TASK').length;
 await connect(app,page);await page.locator('[data-page="Monitor"]').click();await page.locator('.monitor-panel[data-loaded="true"]').waitFor();
 assert.ok(await page.locator('.monitor-panel [data-monitor-node]').count()<observedTasks);
 const cluster=page.locator('[data-monitor-cluster]').first();await cluster.click();assert.ok(await page.locator('.monitor-panel [data-monitor-node]').count()>=observedTasks);
 await page.locator('#monitor-edge-filter').selectOption('NONE');
 await page.waitForFunction(()=>document.querySelector('#monitor-edge-filter')?.value==='NONE' && !document.querySelector('#monitor-refresh')?.disabled);
 await page.locator('.monitor-panel [data-monitor-node]').first().click();
 await page.locator('.monitor-inspector [data-evidence]').first().click();
 await page.locator('#monitor-evidence').waitFor();assert.match(await page.locator('#monitor-evidence').innerText(),/canonical|CANONICAL/);
}));
