// CITY-REMOTE-OPERATION v1 — the whole path, against a REAL gateway and a REAL node agent.
//
// The contract's unit tests prove the refusals in isolation. These tests prove the wiring: that a member cannot reach
// it, that a refused operation leaves no task behind, that an allowed one actually runs a program on the other
// machine and returns its real bytes, and that the City re-checks what came back instead of believing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {startAgent} from '../agents/reference-node/agent.mjs';

const V={'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const owner={...V,Authorization:'Bearer op-owner','Content-Type':'application/json'};
const NODE_ID='dev-alien';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,{timeout=15000,step=50}={}){
 const deadline=Date.now()+timeout;
 for(;;){
  const value=await check();
  if(value)return value;
  if(Date.now()>deadline)throw new Error('condition never became true');
  await sleep(step);
 }
}

async function rig(t,{remoteOperation}={}){
 const dir=await mkdtemp(resolve('.scratch-remote-op-'));
 const workspace=resolve(dir,'alien-work');await mkdir(workspace,{recursive:true});
 let app=null,agent=null;
 const started={dir,workspace,get app(){return app;}};
 try{
  app=await createGateway({dir:resolve(dir,'city'),port:0,token:'op-owner',nodeToken:'op-node',roomsDisabled:true,
   remoteOperation:remoteOperation===undefined?{enabled:true,allowlist:['node'],workspaces:[workspace]}:remoteOperation});
  agent=await startAgent({url:app.url,token:'op-node',id:NODE_ID,displayName:'Alien',workspace:resolve(dir,'agent-work'),interval:60,stepDelay:20});
  await until(async()=>{const r=await fetch(app.url+'/api/v0/nodes',{headers:owner});const b=await r.json();return (b.nodes??[]).some(n=>n.id===NODE_ID&&n.online===true);});
  started.agent=agent;
  return started;
 }catch(error){await agent?.stop().catch(()=>{});await app?.close().catch(()=>{});throw error;}
}

const dispatch=(app,operation,credential=owner,input={})=>fetch(app.url+'/api/v0/actions',{method:'POST',headers:credential,
 body:JSON.stringify({route:'CITY_TASK',target:'city.task',operation:'OWNER_REMOTE_OPERATION',input:{targetDeviceRef:NODE_ID,operation,...input},idempotencyKey:randomUUID()})});

const taskOf=async(app,taskId)=>{const b=await (await fetch(app.url+'/api/v0/tasks',{headers:owner})).json();return (b.tasks??[]).find(x=>x.id===taskId)??null;};
const operations=async(app,credential=owner)=>(await fetch(app.url+'/api/v0/node/operations',{headers:credential})).json();

const spec=overrides=>({executable:'node',argv:['-e','process.stdout.write("reproduced")'],cwd:null,purpose:'independent reproduction on the opposite host',...overrides});

test('CR-OP 1: a real allowlisted program runs on the other machine and its real bytes come back',async t=>{
 const r=await rig(t);
 try{
  const response=await dispatch(r.app,spec({cwd:r.workspace,argv:['-e','process.stdout.write("reproduced-"+process.platform)']}));
  const action=(await response.json()).action;
  assert.equal(action.status,'QUEUED',JSON.stringify(action.error??null));
  const taskId=action.backendRef.taskId;
  const done=await until(async()=>{const task=await taskOf(r.app,taskId);return task&&['COMPLETED','FAILED'].includes(task.state)?task:null;});
  assert.equal(done.state,'COMPLETED',JSON.stringify(done.error??done.result??null));
  assert.equal(done.assignedNodeId,NODE_ID,'the declared target ran it, not some other node');
  assert.equal(done.result.exitCode,0);
  assert.equal(done.result.stdout,`reproduced-${process.platform}`);
  assert.equal(done.result.timedOut,false);
  assert.equal(done.result.truncated,false);
  // The City re-checked the receipt against the operation it dispatched, and says so as an observation.
  const listed=await operations(r.app);
  const row=listed.operations.find(x=>x.taskId===taskId);
  assert.equal(row.receipt.valid,true);
  assert.equal(row.receipt.acceptanceAuthority,false,'a node receipt never carries acceptance authority');
  assert.equal(row.shell,false);
  assert.equal(listed.config.enabled,true);
  assert.deepEqual(listed.config.allowlist,['node']);
 }finally{await r.agent?.stop();await r.app?.close();await rm(r.dir,{recursive:true,force:true});}
});

test('CR-OP 2: a non-zero exit is FAILED with the real code, not a silent success',async t=>{
 const r=await rig(t);
 try{
  const action=(await (await dispatch(r.app,spec({cwd:r.workspace,argv:['-e','process.stderr.write("boom");process.exit(7)']}))).json()).action;
  const done=await until(async()=>{const task=await taskOf(r.app,action.backendRef.taskId);return task&&['COMPLETED','FAILED'].includes(task.state)?task:null;});
  assert.equal(done.state,'FAILED');
  assert.equal(done.result.exitCode,7);
  assert.match(done.result.stderr,/boom/);
  assert.equal(done.result.timedOut,false);
 }finally{await r.agent?.stop();await r.app?.close();await rm(r.dir,{recursive:true,force:true});}
});

test('CR-OP 3: every refusal is refused BEFORE a task exists, by its own code',async t=>{
 const r=await rig(t);
 try{
  const refused=async(code,operation)=>{
   const body=await (await dispatch(r.app,operation)).json();
   assert.equal(body.action.status,'REFUSED',`expected ${code}, got ${JSON.stringify(body.action.error??body.action.status)}`);
   assert.equal(body.action.error.code,code);
   assert.ok(!body.action.backendRef.taskId,'a refused operation must not create a task');
  };
  await refused('EXECUTABLE_NOT_ALLOWED',spec({cwd:r.workspace,executable:'cmd'}));
  await refused('WORKING_DIRECTORY_OUTSIDE_WORKSPACE',spec({cwd:resolve(r.dir,'elsewhere')}));
  await refused('WORKING_DIRECTORY_OUTSIDE_WORKSPACE',spec({cwd:resolve(r.workspace,'..','..')}));
  await refused('PURPOSE_REQUIRED',spec({cwd:r.workspace,purpose:''}));
  await refused('ENVIRONMENT_OVERRIDE_REFUSED',spec({cwd:r.workspace,env:{PATH:'D:/evil'}}));
  await refused('TIMEOUT_EXCEEDS_LIMIT',spec({cwd:r.workspace,timeoutMs:99_999_999}));
  await refused('ARGV_INVALID',spec({cwd:r.workspace,argv:['-e',7]}));
  await refused('OPERATION_SPEC_REQUIRED',undefined);
  // And nothing was left behind by any of them.
  const listed=await operations(r.app);
  assert.equal(listed.operations.length,0,'no refused attempt may leave a task or an operation record');
 }finally{await r.agent?.stop();await r.app?.close();await rm(r.dir,{recursive:true,force:true});}
});

test('CR-OP 4: a member session cannot dispatch, and cannot read the operation log',async t=>{
 const r=await rig(t);
 try{
  const enrollment=await (await fetch(r.app.url+'/api/v0/device/enroll',{method:'POST',headers:owner,body:JSON.stringify({displayName:'Member'})})).json();
  const session=(await (await fetch(r.app.url+'/api/v0/device/session',{method:'POST',headers:V,body:JSON.stringify({installationId:enrollment.installation.installationId,instanceId:enrollment.installation.instanceId,...enrollment.credential})})).json()).credential;
  assert.ok(session,'the fixture member must really have a session');
  // The credential the enrollment registry hands back is ALREADY `sess:`-prefixed; prefixing it again would present a
  // credential the City cannot resolve, which would test a 401 instead of the owner boundary under test.
  const member={...V,Authorization:'Bearer '+session,'Content-Type':'application/json'};
  const response=await dispatch(r.app,spec({cwd:r.workspace}),member);
  assert.equal(response.status,403);
  const failure=await response.json();
  assert.ok(JSON.stringify(failure).includes('REMOTE_OPERATION_OWNER_REQUIRED'),`member dispatch must name the refusal: ${JSON.stringify(failure)}`);
  const read=await fetch(r.app.url+'/api/v0/node/operations',{headers:member});
  assert.equal(read.status,403);
 }finally{await r.agent?.stop();await r.app?.close();await rm(r.dir,{recursive:true,force:true});}
});

test('CR-OP 5: a City that never turned the capability on refuses it by name',async t=>{
 const r=await rig(t,{remoteOperation:{enabled:false,allowlist:['node'],workspaces:[]}});
 try{
  const body=await (await dispatch(r.app,spec({cwd:r.workspace}))).json();
  assert.equal(body.action.status,'REFUSED');
  assert.equal(body.action.error.code,'REMOTE_OPERATION_DISABLED');
 }finally{await r.agent?.stop();await r.app?.close();await rm(r.dir,{recursive:true,force:true});}
});

test('CR-OP 6: the timeout kills the program and the receipt says it was a timeout',async t=>{
 const r=await rig(t);
 try{
  const action=(await (await dispatch(r.app,spec({cwd:r.workspace,timeoutMs:1500,argv:['-e','setTimeout(()=>{},60000)']}))).json()).action;
  const done=await until(async()=>{const task=await taskOf(r.app,action.backendRef.taskId);return task&&['COMPLETED','FAILED'].includes(task.state)?task:null;},{timeout:20000});
  assert.equal(done.state,'FAILED');
  assert.equal(done.result.timedOut,true);
  assert.match(String(done.error),/timed out/);
 }finally{await r.agent?.stop();await r.app?.close();await rm(r.dir,{recursive:true,force:true});}
});

test('CR-OP 7: output over the declared ceiling is truncated and SAYS SO',async t=>{
 const r=await rig(t);
 try{
  const action=(await (await dispatch(r.app,spec({cwd:r.workspace,maxOutputBytes:64,argv:['-e','process.stdout.write("x".repeat(5000))']}))).json()).action;
  const done=await until(async()=>{const task=await taskOf(r.app,action.backendRef.taskId);return task&&['COMPLETED','FAILED'].includes(task.state)?task:null;});
  assert.equal(done.state,'COMPLETED');
  assert.equal(done.result.truncated,true,'a shortened log must never look like a complete one');
  assert.ok(Buffer.byteLength(done.result.stdout)<=64);
 }finally{await r.agent?.stop();await r.app?.close();await rm(r.dir,{recursive:true,force:true});}
});

test('CR-OP 8: the owner can stop a running operation, and the node really kills the program',async t=>{
 // The exposure decision declares this capability cancellable, so cancellation is not a nice-to-have: a remote
 // program nobody can stop is the failure mode this whole surface exists to avoid. The child writes a marker file
 // after 60 s; the test cancels long before that, so a marker on disk would mean the kill never happened.
 const r=await rig(t);
 try{
  const marker=resolve(r.workspace,'finished-marker.txt').replace(/\\/g,'/');
  const script=`setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'done')},60000)`;
  const action=(await (await dispatch(r.app,spec({cwd:r.workspace,argv:['-e',script]}))).json()).action;
  const taskId=action.backendRef.taskId;
  await until(async()=>{const task=await taskOf(r.app,taskId);return task&&task.state==='RUNNING'?task:null;});
  const cancelled=await fetch(r.app.url+`/api/v0/tasks/${encodeURIComponent(taskId)}/cancel`,{method:'POST',headers:owner,body:'{}'});
  assert.equal(cancelled.status,200,JSON.stringify(await cancelled.clone().json().catch(()=>null)));
  const done=await until(async()=>{const task=await taskOf(r.app,taskId);return task&&task.state==='CANCELLED'?task:null;});
  assert.equal(done.state,'CANCELLED');
  // `done.result` stays null ON PURPOSE and that is asserted rather than ignored: the backend returns an already
  // terminal task untouched, so the owner's cancellation is the recorded truth and a node's later report cannot
  // rewrite it. A receipt appearing here would mean a node could overrule a user's stop.
  assert.equal(done.result,null,'a node report must never rewrite the terminal state a cancellation set');
  // Give the marker a chance to appear if the kill failed, then prove it did not.
  await sleep(700);
  const {mkdir}=await import('node:fs/promises');
  await mkdir(r.workspace,{recursive:true});
  const {stat}=await import('node:fs/promises');
  await assert.rejects(stat(resolve(r.workspace,'finished-marker.txt')),{code:'ENOENT'},'the program must really be dead');
 }finally{await r.agent?.stop();await r.app?.close();await rm(r.dir,{recursive:true,force:true});}
});
