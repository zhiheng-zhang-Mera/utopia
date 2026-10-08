// THE CROSS-MACHINE CAPABILITIES ARE SYSTEM-LEVEL, NOT BOUND TO TWO MACHINES.
//
// Both channels answer one question - "may THIS node take THIS work?" - and the answer is decided by a CAPABILITY NAME a
// node advertises and by a NODE ID the caller names. Nothing may depend on which machines happen to exist, how many
// there are, what they are called, or what they are called *today*. That is a property worth checking rather than
// asserting, because the failure mode is silent: a roster or a hostname baked into a decision keeps working perfectly
// on the machines it was written for and quietly refuses (or accepts) work on every other one.
//
// So this file checks it two ways. The SOURCE must not carry a deployment identity or a hostname-keyed decision, and
// the BEHAVIOUR must work for nodes whose ids are arbitrary, in numbers that are not two.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {startAgent} from '../agents/reference-node/agent.mjs';
import {NODE_TASK_CAPABILITIES} from '../services/dev-gateway/node-task-capabilities.mjs';
import {AGENT_NODE_CAPABILITIES, claimJob, registerNode, reportJob} from '../scripts/agent-job.mjs';

const V={'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const OWNER='host-indep-owner';
const NODE_TOKEN='host-indep-node';
const owner={...V,Authorization:'Bearer '+OWNER,'Content-Type':'application/json'};
const nodeHeaders={...V,Authorization:'Bearer '+NODE_TOKEN,'Content-Type':'application/json'};

// Ids deliberately unrelated to any deployment: not the dev-host id, not the opposite-host id, not a `dev-` prefix.
const LAB_NODES=['node-alpha','node-bravo','node-charlie'];

const jobSpec=i=>({title:`job ${i}`,instruction:'say what you observed on this machine',purpose:'prove eligibility follows the capability, not the machine name'});

test('HOST-INDEP 1: no capability surface carries a deployment identity or decides anything by hostname',()=>{
  // The files that ARE the two capabilities: their contracts, the far-side CLI, the two owner surfaces, and the one
  // module that decides "does this node implement what this task needs". A host identity in any of these would be a
  // binding; a hostname-keyed branch in any of these would be the same binding wearing a disguise.
  const surfaces=[
    'contracts/city-agent-job-v1/job.mjs','contracts/city-agent-job-v1/index.mjs',
    'contracts/city-remote-operation-v1/operation.mjs',
    'scripts/agent-job.mjs','apps/web/agent-jobs.js','apps/web/remote-operation.js',
    'services/dev-gateway/node-task-capabilities.mjs',
  ];
  // Identities of the machines this programme happens to run on. These must never appear in a capability.
  const identities=[/mera-alianware/i, /\bmega-rep\b/i, /\bdev-[0-9a-f]{8,}/i, /172\.31\.\d+\.\d+/, /\bAlien-PC\b/i];
  for(const surface of surfaces){
    const text=readFileSync(resolve(import.meta.dirname,'..',surface),'utf8');
    for(const identity of identities)assert.ok(!identity.test(text),`${surface} carries a deployment identity: ${identity}`);
    // A decision made by comparing the local hostname to a literal is the same binding, so it is refused outright.
    assert.ok(!/hostname\(\s*\)[^;\n]{0,40}(===|==|!==)/.test(text),`${surface} decides something by hostname`);
  }
  // And the capability vocabulary itself must be capability NAMES, not machine names.
  for(const [taskType,capability] of Object.entries(NODE_TASK_CAPABILITIES)){
    assert.match(capability,/^[a-z][a-z0-9.-]+\.v\d+$/,`${taskType} must require a versioned capability name, got ${capability}`);
  }
});

test('HOST-INDEP 2: the agent-job channel works for ANY node that advertises the capability, in any number',async t=>{
  const dir=await mkdtemp(resolve('.scratch-host-indep-'));
  const app=await createGateway({dir:resolve(dir,'city'),port:0,token:OWNER,nodeToken:NODE_TOKEN,roomsDisabled:true,
    agentJob:{enabled:true},heartbeatTimeout:600000});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:12,retryDelay:60});});

  // A node the City has never heard of, advertising the capability, is all it takes.
  for(const id of LAB_NODES)await registerNode({url:app.url,token:NODE_TOKEN,id,displayName:id});
  // NEGATIVE CONTROL, and the reason this file is not just a smoke test: a node with an equally arbitrary id that does
  // NOT advertise the capability must never be handed this work, however healthy it is. If eligibility were decided by
  // name or by a roster, this node would be treated as a worker.
  const INCAPABLE='node-incapable';
  await fetch(app.url+'/api/v0/node/register',{method:'POST',headers:nodeHeaders,
    body:JSON.stringify({id:INCAPABLE,displayName:INCAPABLE,capabilities:['task.execute.safe','filesystem.temp']})});

  const dispatch=i=>fetch(app.url+'/api/v0/actions',{method:'POST',headers:owner,body:JSON.stringify({route:'CITY_TASK',
    target:'city.task',operation:'AGENT_JOB',input:{job:jobSpec(i)},idempotencyKey:randomUUID()})});
  const taskOf=async id=>((await (await fetch(app.url+'/api/v0/tasks',{headers:owner})).json()).tasks??[]).find(t=>t.id===id)??null;

  // THREE jobs, taken by THREE different arbitrarily-named nodes - so nothing here can be a fixed pair of machines.
  const taken=new Set();
  for(let i=0;i<LAB_NODES.length;i++){
    const created=(await (await dispatch(i)).json()).action;
    assert.equal(created.status,'QUEUED',JSON.stringify(created.error??null));
    // The incapable node asks first and is offered nothing.
    const refused=await fetch(app.url+'/api/v0/node/claim',{method:'POST',headers:nodeHeaders,body:JSON.stringify({id:INCAPABLE})});
    assert.equal((await refused.json()).task,null,'a node without the capability must be offered nothing');
    // Then each lab node takes one, in turn.
    const claimed=await claimJob({url:app.url,token:NODE_TOKEN,id:LAB_NODES[i]});
    assert.equal(claimed.id,created.backendRef.taskId,`${LAB_NODES[i]} must be able to take work`);
    await reportJob({url:app.url,token:NODE_TOKEN,id:LAB_NODES[i],taskId:claimed.id,jobDigest:claimed.job.jobDigest,
      state:'SUCCEEDED',evidence:'OBSERVED_HERE',summary:`answered by ${LAB_NODES[i]}`});
    taken.add(claimed.assignedNodeId??LAB_NODES[i]);
    assert.equal((await taskOf(claimed.id)).state,'COMPLETED');
  }
  assert.equal(taken.size,LAB_NODES.length,'three jobs must be answerable by three different machines');

  // And OWNER TARGETING is by id, not by membership of any set: an id the City was told about a moment ago is a valid
  // named target, and a name it has never seen is refused by name rather than silently rerouted.
  const unknown=await (await fetch(app.url+'/api/v0/actions',{method:'POST',headers:owner,body:JSON.stringify({route:'CITY_TASK',
    target:'city.task',operation:'AGENT_JOB',input:{targetDeviceRef:'node-never-registered',job:jobSpec('x')},idempotencyKey:randomUUID()})})).json();
  assert.equal(unknown.action.status,'REFUSED');
  assert.equal(unknown.action.error.code,'TARGET_DEVICE_UNKNOWN');
  const targeted=(await (await fetch(app.url+'/api/v0/actions',{method:'POST',headers:owner,body:JSON.stringify({route:'CITY_TASK',
    target:'city.task',operation:'AGENT_JOB',input:{targetDeviceRef:LAB_NODES[2],job:jobSpec('targeted')},idempotencyKey:randomUUID()})})).json()).action;
  assert.equal(targeted.status,'QUEUED');
  const claimed=await claimJob({url:app.url,token:NODE_TOKEN,id:LAB_NODES[2]});
  assert.equal(claimed.id,targeted.backendRef.taskId,'a named id is a valid target the moment it is known');
});

test('HOST-INDEP 3: the remote-operation channel likewise runs on ANY named node, with real programs',async t=>{
  // Same property for the OTHER capability, and with real execution rather than a report: two agents with arbitrary ids
  // and their own workspaces, each named in turn, each running a real program. Nothing about "which machine" is
  // consulted except the id the owner wrote.
  const dir=await mkdtemp(resolve('.scratch-host-indep-op-'));
  const workspaces=[];
  for(const id of ['lab-one','lab-two']){const ws=resolve(dir,id);await mkdir(ws,{recursive:true});workspaces.push(ws);}
  const app=await createGateway({dir:resolve(dir,'city'),port:0,token:OWNER,nodeToken:NODE_TOKEN,roomsDisabled:true,
    remoteOperation:{enabled:true,allowlist:['node'],workspaces}});
  const agents=[];
  t.after(async()=>{for(const a of agents)await a.stop().catch(()=>{});await app.close();
    await rm(dir,{recursive:true,force:true,maxRetries:12,retryDelay:60});});
  const ids=['lab-one','lab-two'];
  for(let i=0;i<ids.length;i++)agents.push(await startAgent({url:app.url,token:NODE_TOKEN,id:ids[i],displayName:ids[i],
    workspace:workspaces[i],interval:60,stepDelay:20}));

  const taskOf=async id=>((await (await fetch(app.url+'/api/v0/tasks',{headers:owner})).json()).tasks??[]).find(t=>t.id===id)??null;
  const until=async(check,timeout=20000)=>{const deadline=Date.now()+timeout;for(;;){const v=await check();if(v)return v;
    if(Date.now()>deadline)throw new Error('condition never became true');await new Promise(r=>setTimeout(r,60));}};

  for(let i=0;i<ids.length;i++){
    const created=(await (await fetch(app.url+'/api/v0/actions',{method:'POST',headers:owner,body:JSON.stringify({route:'CITY_TASK',
      target:'city.task',operation:'OWNER_REMOTE_OPERATION',idempotencyKey:randomUUID(),
      input:{targetDeviceRef:ids[i],operation:{executable:'node',argv:['-e',`process.stdout.write(${JSON.stringify(ids[i])})`],
        cwd:workspaces[i],purpose:`run on ${ids[i]} because the owner named it`}}})})).json()).action;
    assert.equal(created.status,'QUEUED',JSON.stringify(created.error??null));
    const done=await until(async()=>{const task=await taskOf(created.backendRef.taskId);
      return task&&['COMPLETED','FAILED'].includes(task.state)?task:null;});
    assert.equal(done.state,'COMPLETED',JSON.stringify(done.error??done.result??null));
    assert.equal(done.assignedNodeId,ids[i],'the node the owner NAMED is the one that ran it');
    assert.equal(done.result.stdout,ids[i],'and the real program output comes back');
  }
});
