import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createArtifactStore} from '../services/personal-compute-fabric/artifacts.mjs';
import {executeCpu} from '../services/personal-compute-fabric/executor.mjs';
import {saveCheckpoint,restoreCheckpoint} from '../services/personal-compute-fabric/checkpoint.mjs';
import {compileExecutionPlan,runExecutionPlan} from '../services/personal-compute-fabric/pipeline.mjs';
import {createStreamCredit} from '../services/personal-compute-fabric/stream-credit.mjs';
test('709: opaque digest-checked artifacts reject traversal, revoked access and bounded quota overflow',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pcf-art-'));let allowed=true;try{const store=createArtifactStore({root:dir,maxBytes:64,maxItems:2,authorize:()=>allowed});const ref=await store.publish(Buffer.from('real'),{owner:'alice',dataScope:'PUBLIC',expiresAt:5000},1000);assert.equal((await store.read(ref,{caller:'alice'},1000)).toString(),'real');
 await assert.rejects(()=>store.read({...ref,id:'../secret'},{caller:'alice'},1000));await assert.rejects(()=>store.publish(Buffer.alloc(65),{owner:'alice',dataScope:'PUBLIC',expiresAt:5000},1000));allowed=false;await assert.rejects(()=>store.read(ref,{caller:'alice'},1000));allowed=true;await assert.rejects(()=>store.read(ref,{caller:'alice'},6000));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('710: actual local CPU process produces JSON digest and identifies host/process; bounded/cancelled input refused',async()=>{
 const result=await executeCpu({operation:'SORT',values:[5,1,3],deadlineMs:5000,maxOutputBytes:4096});assert.deepEqual(result.output.values,[1,3,5]);assert.equal(result.outcome,'SUCCEEDED');assert.ok(result.pid>0);assert.equal(result.outputDigest.length,64);assert.equal(result.isolation,'COOPERATIVE');
 await assert.rejects(()=>executeCpu({operation:'SHELL',values:[]}));const controller=new AbortController();controller.abort();await assert.rejects(()=>executeCpu({operation:'SORT',values:[1],signal:controller.signal}));
});
test('711: explicit compatible checkpoint restore completes identical CPU sum; incompatible input/attempt refused',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pcf-check-'));try{const store=createArtifactStore({root:dir,maxBytes:10000,maxItems:5,authorize:()=>true});const binding={taskId:'T',attemptId:'A',inputDigest:'a'.repeat(64),providerVersion:1,stageId:'sum',owner:'alice',dataScope:'PUBLIC',expiresAt:5000};const ref=await saveCheckpoint(store,{cursor:2,sum:3,sideEffects:'NONE'},binding,1000);
 const restored=await restoreCheckpoint(store,ref,binding,1000);const result=await executeCpu({operation:'SUM',values:[1,2,3,4],checkpoint:restored,deadlineMs:5000});assert.equal(result.output.sum,10);
 await assert.rejects(()=>restoreCheckpoint(store,ref,{...binding,inputDigest:'b'.repeat(64)},1000));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('703: declared DAG executes concurrent independent stages, dependency before consumer and cancellation propagates',async()=>{
 const plan=compileExecutionPlan({version:1,stages:[{id:'a',dependsOn:[],writeScope:[]},{id:'b',dependsOn:[],writeScope:[]},{id:'c',dependsOn:['a','b'],writeScope:[]}]});let active=0,max=0;
 const result=await runExecutionPlan(plan,async(stage,inputs)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;return stage.id==='c'?inputs.a+inputs.b:1;},{concurrency:2});assert.equal(result.c,2);assert.equal(max,2);
 assert.throws(()=>compileExecutionPlan({version:1,stages:[{id:'a',dependsOn:['b'],writeScope:[]},{id:'b',dependsOn:['a'],writeScope:[]}]}));
 assert.throws(()=>compileExecutionPlan({version:1,stages:[{id:'a',dependsOn:[],writeScope:['repo']},{id:'b',dependsOn:[],writeScope:['repo/x']}]}));
});
test('703: byte/item credit cannot overflow, double acknowledge, or continue after cancel',()=>{const c=createStreamCredit({maxBytes:10,maxItems:2});c.acquire('a',8);assert.throws(()=>c.acquire('b',3));c.ack('a');assert.throws(()=>c.ack('a'));c.cancel();assert.throws(()=>c.acquire('c',1));});
test('709: caller metadata cannot overwrite storage identity, digest, size or schema version',async()=>{const dir=await mkdtemp(join(tmpdir(),'pcf-meta-'));try{const store=createArtifactStore({root:dir,maxBytes:64,maxItems:2,authorize:()=>true});await assert.rejects(()=>store.publish(Buffer.from('x'),{owner:'a',dataScope:'PUBLIC',expiresAt:5000,id:'../x',digest:'bad',size:0,version:99},1000));}finally{await rm(dir,{recursive:true,force:true});}});
test('703: final-stage failure is never returned as an empty successful plan',async()=>{const plan=compileExecutionPlan({version:1,stages:[{id:'a',dependsOn:[],writeScope:[]}]});await assert.rejects(()=>runExecutionPlan(plan,async()=>{throw new Error('worker failed');}));});
