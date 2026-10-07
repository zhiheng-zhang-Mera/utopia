import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEngineeringRuntime,buildCodexInvocation,bindEngineeringRuntime} from '../services/personal-compute-fabric/engineering-runtime.mjs';
test('fixed invocation never accepts arbitrary argv or latest session',()=>{
 const plan=buildCodexInvocation({workspace:'D:/isolated',prompt:'hello'});
 assert.deepEqual(plan.args,['exec','--ignore-user-config','--json','--sandbox','workspace-write','--cd','D:/isolated','-']);
 assert.throws(()=>buildCodexInvocation({workspace:'x',prompt:'x',resumeSession:'--last'}),/OWNED_SESSION/);
});
test('unapproved provider remains NOT_RUN and unknown attachment refused',async()=>{
 const runtime=createEngineeringRuntime({executable:process.execPath});
 assert.equal((await runtime.readiness()).state,'NOT_READY');
 await assert.rejects(runtime.startOrAttach({backendSessionId:'foreign'}),/OWNED_SESSION/);
 await assert.rejects(runtime.submit({}),/REAL_PROVIDER_UNAVAILABLE/);
});
test('real subprocess fixture captures JSONL exit and refuses duplicate attempt',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'pcf727-'));
 try {
 const runtime=createEngineeringRuntime({executable:process.execPath,fixtureArgs:['-e','process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"owned"})+"\\n");process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n")'],componentFixture:true,validateWorkspace:async()=>({baseSha:'a'.repeat(40),workspace}),approved:true,hostId:'fixture',bootId:'boot'});
 const request={taskId:'t',attemptId:'a',isolatedWorktree:workspace,baseSha:'a'.repeat(40),approved:true,prompt:'test'};
 const submitted=await runtime.submit(request);const result=await runtime.wait(submitted.sessionId);
 assert.equal(result.state,'SUCCEEDED');assert.equal(result.exitCode,0);assert.equal(result.backendSessionId,'owned');assert.equal(result.evidenceClass,'REAL_SUBPROCESS_COMPONENT_FIXTURE');
 await assert.rejects(runtime.submit(request),/DUPLICATE_ATTEMPT/);
 } finally {await rm(workspace,{recursive:true,force:true});}
});
test('bounded malformed stream fails and cancellation waits for process close',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'pcf727-'));
 try {
 for(const script of ['process.stdout.write("x".repeat(100));setInterval(()=>{},1000)','setInterval(()=>{},1000)']){
 const runtime=createEngineeringRuntime({executable:process.execPath,fixtureArgs:['-e',script],componentFixture:true,validateWorkspace:async()=>({baseSha:'a'.repeat(40),workspace}),approved:true,maxBytes:32});
 const run=await runtime.submit({taskId:'t',attemptId:script,isolatedWorktree:workspace,baseSha:'a'.repeat(40),approved:true,prompt:'test'});
 if(script.startsWith('set'))await runtime.control({sessionId:run.sessionId,operation:'CANCEL'});
 const result=await runtime.wait(run.sessionId);assert.notEqual(result.state,'SUCCEEDED');assert.equal(result.processClosed,true);
 }
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('adapter binds real ConnectorPort inventory without claiming readiness',async()=>{
 const adapter=bindEngineeringRuntime({});assert.equal((await adapter.readiness()).state,'NOT_READY');assert.equal(adapter.evidenceClass,'CONNECTOR_CONTRACT_ONLY_UNTIL_REAL_PROVIDER_RUN');
});
test('nonzero exit and invalid JSONL do not become success',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'pcf727-'));
 try{for(const script of ['process.exit(3)','process.stdout.write("bad\\n")']){
 const runtime=createEngineeringRuntime({executable:process.execPath,fixtureArgs:['-e',script],componentFixture:true,validateWorkspace:async()=>({baseSha:'a'.repeat(40),workspace}),approved:true});
 const run=await runtime.submit({taskId:'t',attemptId:script,isolatedWorktree:workspace,baseSha:'a'.repeat(40),approved:true,prompt:'test'});const result=await runtime.wait(run.sessionId);assert.equal(result.state,'FAILED');assert.equal(result.processClosed,true);
 }}finally{await rm(workspace,{recursive:true,force:true});}
});
test('caller mutation across workspace validation cannot change verified execution',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'pcf727-'));let release;const gate=new Promise(resolve=>{release=resolve;});let validated;
 try{
 const runtime=createEngineeringRuntime({executable:process.execPath,fixtureArgs:['-e','process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"owned"})+"\\n"+JSON.stringify({type:"turn.completed"})+"\\n")'],componentFixture:true,approved:true,validateWorkspace:async request=>{validated=request;await gate;return {baseSha:request.baseSha,workspace};}});
 const request={taskId:'original',attemptId:'original-attempt',isolatedWorktree:workspace,baseSha:'a'.repeat(40),approved:true,prompt:'safe'};
 const pending=runtime.submit(request);request.taskId='changed';request.attemptId='changed';request.baseSha='b'.repeat(40);request.isolatedWorktree='Z:/unvalidated';request.prompt='changed';release();
 const receipt=await pending;const result=await runtime.wait(receipt.sessionId);assert.equal(validated.taskId,'original');assert.equal(Object.isFrozen(validated),true);assert.equal(result.taskId,'original');assert.equal(result.attemptId,'original-attempt');assert.equal(result.baseSha,'a'.repeat(40));assert.equal(result.worktree,workspace);assert.equal(result.state,'SUCCEEDED');assert.equal(result.unknownSideEffects,true);
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('production cannot inject a workspace validator or provider fixture argv',()=>{
 assert.throws(()=>createEngineeringRuntime({validateWorkspace:async()=>({})}),/FIXTURE_ONLY/);
 assert.throws(()=>createEngineeringRuntime({componentFixture:true,executable:'codex',fixtureArgs:['exec']}),/FIXTURE_EXECUTABLE/);
});
test('owned start is persisted before stdin and durable exit precedes collection',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'pcf727-'));let release;const gate=new Promise(resolve=>{release=resolve;});let started=false,persisted=false;
 try{
 const runtime=createEngineeringRuntime({executable:process.execPath,componentFixture:true,approved:true,fixtureArgs:['-e','process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"owned"})+"\\n"+JSON.stringify({type:"turn.completed"})+"\\n"))'],validateWorkspace:async r=>({baseSha:r.baseSha,workspace}),onStart:async receipt=>{assert.ok(receipt.pid>0);started=true;await gate;},persistReceipt:async receipt=>{assert.equal(started,true);assert.equal(receipt.processClosed,true);persisted=true;}});
 const pending=runtime.submit({taskId:'t',attemptId:'a',approved:true,baseSha:'a'.repeat(40),isolatedWorktree:workspace,prompt:'safe'});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(started,true);assert.equal(persisted,false);release();const run=await pending;await runtime.wait(run.sessionId);assert.equal((await runtime.result({sessionId:run.sessionId})).durableReceipt,true);assert.equal(persisted,true);
 }finally{release?.();await rm(workspace,{recursive:true,force:true});}
});
test('receipt disk failure is ATTENTION and cannot be collected',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'pcf727-'));try{
 const runtime=createEngineeringRuntime({executable:process.execPath,componentFixture:true,approved:true,fixtureArgs:['-e','process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"owned"})+"\\n"+JSON.stringify({type:"turn.completed"})+"\\n")'],validateWorkspace:async r=>({baseSha:r.baseSha,workspace}),onStart:async()=>{},persistReceipt:async()=>{throw Error('disk failed');}});
 const run=await runtime.submit({taskId:'t',attemptId:'a',approved:true,baseSha:'a'.repeat(40),isolatedWorktree:workspace,prompt:'safe'});assert.equal((await runtime.wait(run.sessionId)).state,'ATTENTION');await assert.rejects(runtime.result({sessionId:run.sessionId}),/DURABLE_RECEIPT_REQUIRED/);
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('owner start refusal closes the owned process without delivering stdin',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'pcf727-'));try{
 const runtime=createEngineeringRuntime({executable:process.execPath,componentFixture:true,approved:true,fixtureArgs:['-e','process.stdin.resume();process.stdin.on("data",()=>process.stdout.write("unexpected\\n"))'],validateWorkspace:async r=>({baseSha:r.baseSha,workspace}),onStart:async()=>{throw Error('owner unavailable');},persistReceipt:async()=>{}});
 const run=await runtime.submit({taskId:'t',attemptId:'a',approved:true,baseSha:'a'.repeat(40),isolatedWorktree:workspace,prompt:'safe'});const receipt=await runtime.wait(run.sessionId);assert.equal(receipt.processClosed,true);assert.equal(receipt.ownedStartPersisted,false);assert.equal(receipt.reason,'OWNED_START_PERSISTENCE_FAILED');assert.equal(receipt.eventCount,0);assert.equal(receipt.state,'FAILED');
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('never-settling owner start has a bounded ATTENTION receipt and abort fence',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'pcf727-'));let callbackContext;try{
 const runtime=createEngineeringRuntime({executable:process.execPath,componentFixture:true,approved:true,callbackTimeoutMs:30,timeoutMs:200,fixtureArgs:['-e','process.stdin.resume()'],validateWorkspace:async r=>({baseSha:r.baseSha,workspace}),onStart:async(_receipt,context)=>{callbackContext=context;await new Promise(()=>{});},persistReceipt:async()=>{}});
 const receipt=await runtime.submit({taskId:'t',attemptId:'a',approved:true,baseSha:'a'.repeat(40),isolatedWorktree:workspace,prompt:'safe'});const result=await runtime.wait(receipt.sessionId);assert.equal(result.state,'ATTENTION');assert.equal(result.processClosed,true);assert.equal(callbackContext.signal.aborted,true);assert.equal(callbackContext.isCurrent(),false);await assert.rejects(runtime.result({sessionId:receipt.sessionId}),/DURABLE_RECEIPT_REQUIRED/);
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('late receipt persistence cannot turn callback timeout into success',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'pcf727-'));let release,context;const late=new Promise(resolve=>{release=resolve;});try{
 const runtime=createEngineeringRuntime({executable:process.execPath,componentFixture:true,approved:true,callbackTimeoutMs:30,fixtureArgs:['-e','process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"owned"})+"\\n"+JSON.stringify({type:"turn.completed"})+"\\n")'],validateWorkspace:async r=>({baseSha:r.baseSha,workspace}),onStart:async()=>{},persistReceipt:async(_receipt,ctx)=>{context=ctx;await late;assert.equal(ctx.isCurrent(),false);}});
 const run=await runtime.submit({taskId:'t',attemptId:'a',approved:true,baseSha:'a'.repeat(40),isolatedWorktree:workspace,prompt:'safe'});const result=await runtime.wait(run.sessionId);assert.equal(result.state,'ATTENTION');assert.equal(result.reason,'RECEIPT_PERSISTENCE_TIMEOUT');assert.equal(context.signal.aborted,true);release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await runtime.wait(run.sessionId)).state,'ATTENTION');await assert.rejects(runtime.result({sessionId:run.sessionId}),/DURABLE_RECEIPT_REQUIRED/);
 }finally{release?.();await rm(workspace,{recursive:true,force:true});}
});
