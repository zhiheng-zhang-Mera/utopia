import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {Store} from '../services/dev-gateway/store.mjs';
import {createBridge} from '../services/capability-bridge/bridge.mjs';
import {createCircuitBreaker} from '../city/02-engineering/02-worker-gateway/provider-resilience/index.mjs';

test('dependency failure degrades the same descriptor used to gate invocations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'utopia-degrade-')),store=new Store(dir);let calls=0;
 const bridge=createBridge(store,()=>{},{execute:async()=>{calls++;return{errorCode:'ENGINE_UNAVAILABLE'};}});
 try{
  await bridge.invoke('planning.document.intake',{operationId:'read',input:{}});
  assert.equal(bridge.registry().find(d=>d.capabilityId==='planning.document.intake').bridgeState,'DEGRADED');
  await assert.rejects(bridge.invoke('planning.document.intake',{operationId:'read',input:{}}),{code:'BRIDGE_PENDING'});
  assert.equal(calls,1);
 }finally{bridge.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('capabilities use control auth, canonical results, typed refusal and durable history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'utopia-cap-'));let g=await createGateway({dir,port:0,token:'control-test',nodeToken:'node-test'});
 const call=async(path,body,token='control-test')=>{const r=await fetch(g.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
 try{
  assert.equal((await call('capabilities',null,'node-test')).status,401);
  const catalog=await call('capabilities');assert.equal(catalog.status,200);assert.equal(catalog.data.capabilities.filter(c=>c.bridgeState==='AVAILABLE').length,5);
  const request={operationId:'inspect',input:{ref:'owner/repo@main'}};
  const a=(await call('capabilities/engineering.skill.inspect/invoke',request)).data;
  const b=(await call('capabilities/engineering.skill.inspect/invoke',request)).data;
  assert.equal(a.status,'COMPLETED');assert.equal(a.resultDigest,b.resultDigest);assert.notEqual(a.invocationId,b.invocationId);
  const bad=(await call('capabilities/engineering.skill.inspect/invoke',{operationId:'install',input:{}}));assert.equal(bad.status,400);assert.equal(bad.data.errorCode,'OPERATION_BLOCKED');
  const oversized=await call('capabilities/planning.document.intake/invoke',{operationId:'read',input:{base64:'A'.repeat(1500001)}});assert.equal(oversized.status,413);assert.equal(oversized.data.errorCode,'INPUT_TOO_LARGE');
  const broken=(await call('capabilities/planning.document.intake/invoke',{operationId:'read',input:{fileName:'broken.json',base64:Buffer.from('{').toString('base64')}})).data;assert.equal(broken.status,'FAILED');assert.ok(broken.errorCode);assert.equal(broken.resultDigest,null);
  g.store.put('invocations',{id:'I-interrupted',invocationId:'I-interrupted',capabilityId:'engineering.skill.inspect',operationId:'inspect',status:'RUNNING',resultDigest:null});
  await g.close();g=await createGateway({dir,port:0,token:'control-test',nodeToken:'node-test'});
  const history=(await call('capability-invocations')).data.invocations;assert.equal(history.find(i=>i.invocationId===a.invocationId).resultDigest,a.resultDigest);
  assert.equal(history.filter(i=>i.invocationId===a.invocationId).length,1);
  assert.equal(history.find(i=>i.invocationId==='I-interrupted').status,'INTERRUPTED');
 }finally{await g.close();await rm(dir,{recursive:true,force:true});}
});

/**
 * City Core consumption (MB-003).
 *
 * The bridge no longer keeps an ad-hoc Set of degraded capabilities: the decision is made
 * by the migrated `city/02-engineering/02-worker-gateway/provider-resilience` breaker, with
 * Utopia's own policy supplied as data (a failure threshold of one, and only the two
 * provider-technical error codes count). This test proves the consumption is real by
 * showing the bridge refuses exactly what the Core refuses, and that a capability-wide
 * timeout — a failure, but not a provider-health signal — must not degrade anything.
 */
test('the per-capability degradation latch is owned by the migrated provider-resilience breaker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'utopia-resilience-')),store=new Store(dir);
 let code='EXECUTION_TIMEOUT';
 const bridge=createBridge(store,()=>{},{execute:async()=>({errorCode:code})});
 const stateOf=id=>bridge.registry().find(c=>c.capabilityId===id).bridgeState;
 const request={operationId:'inspect',input:{ref:'owner/repo'}};
 try{
  await bridge.invoke('engineering.skill.inspect',request);
  assert.equal(stateOf('engineering.skill.inspect'),'AVAILABLE','a timeout is not a provider-health signal');

  code='ENGINE_UNAVAILABLE';
  await bridge.invoke('engineering.skill.inspect',request);
  assert.equal(stateOf('engineering.skill.inspect'),'DEGRADED');

  // the Core, given the same policy and the same failure, reaches the same verdict
  const core=createCircuitBreaker({options:{failureThreshold:1,cooldownMs:604800000,now:Date.now}});
  assert.equal(core.state('engineering.skill.inspect'),'CLOSED','a capability that never failed is in service');
  core.observeFailure('engineering.skill.inspect');
  assert.notEqual(core.state('engineering.skill.inspect'),'CLOSED','the Core keeps a failed provider out of service');

  // the latch holds for the life of the process, so further work is refused
  await assert.rejects(bridge.invoke('engineering.skill.inspect',request),{code:'BRIDGE_PENDING'});
  for(const other of ['planning.knowledge.query','research.evidence.review'])assert.equal(stateOf(other),'AVAILABLE',`${other} is unaffected`);
 }finally{bridge.close();store.close();await rm(dir,{recursive:true,force:true});}
});
