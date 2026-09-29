import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {Store} from '../services/dev-gateway/store.mjs';
import {createBridge} from '../services/capability-bridge/bridge.mjs';

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
  const broken=(await call('capabilities/planning.document.intake/invoke',{operationId:'read',input:{fileName:'broken.json',base64:Buffer.from('{').toString('base64')}})).data;assert.equal(broken.status,'FAILED');assert.ok(broken.errorCode);assert.equal(broken.resultDigest,null);
  g.store.put('invocations',{id:'I-interrupted',invocationId:'I-interrupted',capabilityId:'engineering.skill.inspect',operationId:'inspect',status:'RUNNING',resultDigest:null});
  await g.close();g=await createGateway({dir,port:0,token:'control-test',nodeToken:'node-test'});
  const history=(await call('capability-invocations')).data.invocations;assert.equal(history.find(i=>i.invocationId===a.invocationId).resultDigest,a.resultDigest);
  assert.equal(history.filter(i=>i.invocationId===a.invocationId).length,1);
  assert.equal(history.find(i=>i.invocationId==='I-interrupted').status,'INTERRUPTED');
 }finally{await g.close();await rm(dir,{recursive:true,force:true});}
});
