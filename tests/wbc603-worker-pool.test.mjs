import test from 'node:test';import assert from 'node:assert/strict';
import {createWorkerPoolBackend} from '../services/dev-gateway/execution-backend/worker-pool.mjs';
import {createExecutionBackendRegistry} from '../contracts/execution-backend-v1/index.mjs';
import {nodeDescriptor} from '../contracts/node-descriptor-v1/index.mjs';
test('pool registers dormant without adapter or I/O and refuses direct or registry work',()=>{
 const pool=createWorkerPoolBackend();const registry=createExecutionBackendRegistry();registry.register(pool);
 assert.equal(pool.readiness().state,'ABSENT');assert.deepEqual(pool.endpoints(),[]);
 assert.throws(()=>pool.claim({nodeId:'pool-a'}),{code:'BACKEND_DORMANT'});
 assert.throws(()=>registry.active('WORKER_POOL'),{code:'BACKEND_DORMANT'});
});
test('explicit pool narrows canonical endpoints by membership, role and descriptor readiness',()=>{
 let calls=0;const canonical={endpoints:()=>[{endpointRef:'pool-a',ready:true},{endpointRef:'windows',ready:true}],claim:args=>{calls++;return{task:{id:'task'},endpointRef:args.nodeId};},dispatch:()=>{},report:()=>{},control:()=>{}};
 let ready=true;const pool=createWorkerPoolBackend({enabled:true,canonical,memberRefs:['pool-a'],descriptors:()=>[nodeDescriptor({nodeId:'pool-a',roles:['EXECUTION_NODE','SERVER_NODE'],availability:{acceptingWork:ready}})]});
 assert.equal(pool.readiness().state,'READY');assert.equal(pool.endpoints().length,1);
 assert.throws(()=>pool.claim({nodeId:'windows'}),{code:'UNKNOWN_ENDPOINT'});assert.equal(calls,0);
 ready=false;assert.throws(()=>pool.claim({nodeId:'pool-a'}),{code:'ENDPOINT_NOT_READY'});assert.equal(calls,0);
 ready=true;assert.equal(pool.claim({nodeId:'pool-a'}).task.id,'task');assert.equal(calls,1);
});
test('enabled pool with missing canonical adapter fails typed unavailable',()=>{
 const pool=createWorkerPoolBackend({enabled:true});assert.equal(pool.readiness().state,'ABSENT');assert.throws(()=>pool.claim({nodeId:'pool-a'}),{code:'BACKEND_UNAVAILABLE'});
});
test('pool control must not cancel work held by an unrelated standard endpoint',()=>{
 let changed=false;const canonical={endpoints:()=>[],dispatch(){},claim(){},report(){},control(){changed=true;}};
 const pool=createWorkerPoolBackend({enabled:true,canonical,memberRefs:['pool-a'],taskFor:()=>({id:'foreign',assignedNodeId:'windows'})});
 assert.throws(()=>pool.control({taskId:'foreign',endpointRef:'pool-a'}),{code:'NOT_TASK_HOLDER'});assert.equal(changed,false);
});
