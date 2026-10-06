import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {resolve} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';import {createHeadlessAgent} from '../services/headless-node-agent/agent.mjs';
import {createWorkerPoolBackend} from '../services/dev-gateway/execution-backend/worker-pool.mjs';import {describeLegacyNode} from '../contracts/node-descriptor-v1/index.mjs';
const headers=t=>({Authorization:'Bearer '+t,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'});
async function fixture(fn){const dir=await mkdtemp(resolve('.scratch-wbc603-'));let app;try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',hostDeviceId:'pool-a',roomsDisabled:true});const request=async(path,body,{signal}={})=>{const r=await fetch(app.url+'/api/v0/'+path,{method:'POST',headers:headers(path.startsWith('tasks/')||path==='node/sharing'?'owner':'node'),body:JSON.stringify(body),signal});const x=await r.json();if(!r.ok)throw Object.assign(new Error(x.error),{code:x.errorCode??'GATEWAY_REFUSAL',status:r.status});return x;};const task=async()=>{const r=await fetch(app.url+'/api/v0/tasks',{method:'POST',headers:headers('owner'),body:JSON.stringify({type:'CHECKPOINT_DEMO'})});return await r.json();};await fn({app,request,task});}finally{await app?.close();await rm(dir,{recursive:true,force:true});}}
const options=request=>({identity:{id:'pool-a',displayName:'Bounded pool test'},roles:['EXECUTION_NODE','SERVER_NODE'],capabilities:['task.execute.safe','filesystem.temp'],credentialHandle:'fixture:opaque-handle',controlHandle:'fixture:control-handle',request});
async function waitFor(predicate){for(let i=0;i<500;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Bounded fixture condition did not occur');}
test('agent construction has no I/O; drain prevents new claim; canary uses canonical state and result',()=>fixture(async({app,request,task})=>{
 let calls=0;const agent=createHeadlessAgent(options((...args)=>{calls++;return request(...args);}));assert.equal(calls,0);await agent.register();const created=await task();await agent.drain();assert.equal(app.store.get('nodes','pool-a').sharingEnabled,false);assert.equal(await agent.runOne(async()=>({ok:true})),null);assert.equal(app.store.get('tasks',created.id).state,'QUEUED');await agent.resume();const result=await agent.runOne(async(_,{progress})=>{await progress(50);return{canary:'PASS'};});assert.equal(result.state,'COMPLETED');assert.deepEqual(app.store.get('tasks',created.id).result,{canary:'PASS'});assert.equal(app.executionProfile,'STANDARD_DEVICES');
}));
test('crash and restart use canonical interruption refusal rather than duplicate execution',()=>fixture(async({app,request,task})=>{
 const old=createHeadlessAgent(options(request));await old.register();const created=await task();let release;const gate=new Promise(r=>{release=r;});let executions=0;const running=old.runOne(async()=>{executions++;await gate;return{late:true};});await waitFor(()=>executions===1&&app.store.get('tasks',created.id).state==='RUNNING');old.abandon();const fresh=createHeadlessAgent(options(request));await fresh.register();assert.equal(app.store.get('tasks',created.id).state,'FAILED');release();await running;assert.equal(executions,1);assert.equal(await fresh.runOne(async()=>{executions++;}),null);assert.equal(executions,1);assert.equal(app.store.get('tasks',created.id).result,null);
}));
test('unknown protocol and unavailable adapter are typed refusals without a startup loop',async()=>{
 assert.throws(()=>createHeadlessAgent({...options(()=>{}),protocolVersion:2}),{code:'INCOMPATIBLE_PROTOCOL'});
 const agent=createHeadlessAgent(options(async()=>{throw Object.assign(new Error('offline'),{code:'OFFLINE'});}));await assert.rejects(agent.register(),{code:'OFFLINE'});assert.equal(agent.status().registered,false);
});
test('executor failure after progress remains canonical FAILED and drain permits held completion',()=>fixture(async({app,request,task})=>{
 const agent=createHeadlessAgent(options(request));await agent.register();const created=await task();
 const failed=await agent.runOne(async(_,{progress})=>{await progress(50);throw Error('secret must not leak');});
 assert.equal(failed.state,'FAILED');assert.equal(failed.progress,50);assert.equal(app.store.get('tasks',created.id).error.includes('secret'),false);
 const second=await task();const done=await agent.runOne(async()=>{await agent.drain();return{done:true};});assert.equal(done.state,'COMPLETED');assert.equal(app.store.get('tasks',second.id).state,'COMPLETED');
}));
test('cancel aborts held executor and late result never replaces terminal state',()=>fixture(async({app,request,task})=>{
 const agent=createHeadlessAgent(options(request));await agent.register();const created=await task();let release,signal;const gate=new Promise(r=>{release=r;});
 const running=agent.runOne(async(_,hooks)=>{signal=hooks.signal;await hooks.progress(25);await gate;return{late:true};});
 await waitFor(()=>app.store.get('tasks',created.id).progress===25);
 const cancelled=await agent.cancel();assert.equal(cancelled.state,'CANCELLED');assert.equal(signal.aborted,true);release();await running;assert.equal(app.store.get('tasks',created.id).result,null);
}));
test('delayed old-task cancel cannot abort a later task or admit work while control pending',async()=>{
 let next=1,releaseCancel;const cancelGate=new Promise(r=>{releaseCancel=r;});
 const request=async(path,body)=>{if(path==='node/descriptor')return{descriptor:{availability:{sharingEnabled:true}}};if(path==='node/sharing')return{};if(path==='node/register')return{};if(path==='node/claim')return{task:{id:'q'+next++,state:'ASSIGNED',progress:0}};if(path==='node/report')return{id:body.taskId,state:body.state,progress:body.progress};if(path.startsWith('tasks/')){await cancelGate;return{id:'q1',state:'CANCELLED'};}};
 const agent=createHeadlessAgent(options(request));await agent.register();let releaseFirst,firstEntered=false;const firstGate=new Promise(r=>{releaseFirst=r;});const first=agent.runOne(async()=>{firstEntered=true;await firstGate;return{};});await waitFor(()=>firstEntered);
 const cancel=agent.cancel();releaseFirst();await first;
 assert.equal(await agent.runOne(async()=>({})),null);assert.equal(next,2);releaseCancel();await cancel;
 const second=await agent.runOne(async(_,{signal})=>{assert.equal(signal.aborted,false);return{};});assert.equal(second.id,'q2');assert.equal(second.state,'COMPLETED');
});
test('stop during unresolved claim refuses busy and preserves assignment for subsequent stop',async()=>{
 let releaseClaim;const gate=new Promise(r=>{releaseClaim=r;});let cancelled=0;
 const request=async(path,body)=>{if(path==='node/descriptor')return{descriptor:{availability:{sharingEnabled:true}}};if(path==='node/sharing')return{};if(path==='node/register')return{};if(path==='node/claim'){await gate;return{task:{id:'q1',state:'ASSIGNED',progress:0}};}if(path==='node/report')return{id:'q1',state:body.state,progress:body.progress};if(path.startsWith('tasks/')){cancelled++;return{id:'q1',state:'CANCELLED'};}};
 const agent=createHeadlessAgent(options(request));await agent.register();let releaseExecutor,entered=false;const executorGate=new Promise(r=>{releaseExecutor=r;});const running=agent.runOne(async()=>{entered=true;await executorGate;return{};});
 await assert.rejects(agent.stop(),{code:'AGENT_BUSY'});assert.equal(agent.status().stopped,false);releaseClaim();await waitFor(()=>entered);await agent.stop();releaseExecutor();await running;assert.equal(cancelled,1);assert.equal(agent.status().stopped,true);
});
test('explicit bounded pool adapter executes canonical canary, then absent pool leaves standard work usable',()=>fixture(async({app,request,task})=>{
 const canonical=app.executionBackend();let pool=createWorkerPoolBackend({enabled:true,canonical,memberRefs:['pool-a'],taskFor:id=>app.store.get('tasks',id),descriptors:()=>app.store.list('nodes').map(n=>describeLegacyNode(n,{availability:{acceptingWork:canonical.endpoints().find(e=>e.endpointRef===n.id)?.ready===true}}))});
 const routed=async(path,body,context)=>path==='node/claim'&&pool?pool.claim({nodeId:body.id}):request(path,body,context);
 const agent=createHeadlessAgent({...options(routed),resources:{cpu:{cores:4},memory:{totalBytes:4096,usedBytes:1024}}});await agent.register();await agent.heartbeat();
 const descriptor=describeLegacyNode(app.store.get('nodes','pool-a'));assert.deepEqual(descriptor.roles,['EXECUTION_NODE','SERVER_NODE']);assert.equal(descriptor.resources.cpu.cores.value,4);assert.equal(pool.readiness().state,'READY');
 const canary=await task();const completed=await agent.runOne(async()=>({poolCanary:'PASS'}));assert.equal(completed.id,canary.id);assert.equal(app.store.get('tasks',canary.id).result.poolCanary,'PASS');
 pool=null;const standard=createHeadlessAgent({...options(request),identity:{id:'standard-a',displayName:'Existing standard device'}});await standard.register();const ordinary=await task();const done=await standard.runOne(async()=>({standard:'PASS'}));assert.equal(done.id,ordinary.id);assert.equal(app.store.get('tasks',ordinary.id).state,'COMPLETED');assert.equal(app.executionProfile,'STANDARD_DEVICES');
}));
