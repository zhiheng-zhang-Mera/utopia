// CITY-AGENT-JOB v1 — the channel that lets the City hand a request to a remote AGENT.
//
// The contract's refusals are proved in isolation first, then the WIRING is proved against a REAL gateway with a real
// node credential: that a member cannot reach it, that an incapable node is never handed a job, that a report bound to
// a different job is refused BEFORE it becomes the task's stored result, that an expired job is not handed out, and
// that what the owner reads back is the agent's claim labelled as a claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {normalizeAgentJob, validateAgentJobReport, jobDigest, isJobExpired, AGENT_JOB_EXPOSURE,
  MAX_DEADLINE_MS, EVIDENCE_CLASSES, consumptionReceipt, validateConsumptionRequest} from '../contracts/city-agent-job-v1/job.mjs';
import {AGENT_NODE_CAPABILITIES, claimJob, describeClaimedJob, registerNode, reportJob, saveClaimedJob, sha256File} from '../scripts/agent-job.mjs';

const V={'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const OWNER_TOKEN='job-owner';
const NODE_TOKEN='job-node';
const owner={...V,Authorization:'Bearer '+OWNER_TOKEN,'Content-Type':'application/json'};
const nodeHeaders={...V,Authorization:'Bearer '+NODE_TOKEN,'Content-Type':'application/json'};
const NODE_ID='dev-opposite-agent';

const jobSpec=overrides=>({title:'Reproduce REX-890 on the opposite host',instruction:'Run the listed commands and report what happened, including anything that did not run.',
  purpose:'independent reproduction on the machine the City cannot see into',...overrides});

// ----------------------------------------------------------------------------------------------------------------
// The contract, in isolation.
// ----------------------------------------------------------------------------------------------------------------

// Windows refuses to remove a directory while any handle inside it is still open, and the City's OWN shutdown gives
// its trace drain a fixed, bounded budget (`researchTrace.close(100)`), so a busy run can still be flushing when
// `close()` returns. That surfaced as an ENOTEMPTY out of the TEARDOWN of a test whose assertions had all passed -
// a false red in the only place a false red is hardest to read. `rm` retries those Windows errno values itself.
const rmScratch = dir => rm(dir, {recursive: true, force: true, maxRetries: 12, retryDelay: 60});

test('CAJ 1: a job is refused by name when it cannot be acted on, and never silently half-normalised',()=>{
  const enabled={enabled:true};
  const refuses=(code,spec,options=enabled)=>{
    assert.throws(()=>normalizeAgentJob(spec,options),error=>error.code===code,`expected ${code} for ${JSON.stringify(spec)}`);
  };
  refuses('AGENT_JOB_DISABLED',jobSpec(),{enabled:false});
  refuses('AGENT_JOB_DISABLED',jobSpec(),{});
  refuses('JOB_SPEC_REQUIRED',undefined);
  refuses('JOB_SPEC_REQUIRED',[]);
  refuses('JOB_TITLE_REQUIRED',jobSpec({title:''}));
  // An unexplained request to an autonomous agent is refused BY PRESENCE, exactly as `purpose` is for a program.
  refuses('JOB_INSTRUCTION_REQUIRED',jobSpec({instruction:'   '}));
  refuses('JOB_PURPOSE_REQUIRED',jobSpec({purpose:''}));
  // A credential is refused by NAME before its value is looked at, because the shape of the mistake is the key.
  refuses('JOB_INPUT_CREDENTIAL_REFUSED',jobSpec({inputs:[{name:'api_token',text:'x'}]}));
  // Real token shapes, with the characters that really follow them. The first version of this pattern ended in `\b`
  // after `ghp_`, so it matched nothing a real token looks like; each of these is a regression guard for that.
  for(const secret of ['use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push','run with github_pat_11ABCDEFG0abcdefghij',
    'export OPENAI=sk-abcdefghijklmnopqrstuvwx','header Authorization: Bearer abcdefghijklmnop.qrstuvwx']){
    refuses('JOB_INPUT_CREDENTIAL_REFUSED',jobSpec({inputs:[{name:'note',text:secret}]}));
  }
  // A credential shape must be refused in EVERY STORED FIELD, not only in `inputs`. Measured on a live City
  // 2026-10-08: the same shape in `inputs[].text` was refused while in `instruction` and in `purpose` it was ACCEPTED,
  // the job went QUEUED, and the stored record contained it - so the check protected the field nobody types a token
  // into and missed the two somebody would. Title, instruction, purpose and expect are all persisted.
  for(const [field,spec] of [['title',jobSpec({title:'push with ghp_abcdefghijklmnopqrstuvwxyz0123456789'})],
    ['instruction',jobSpec({instruction:'clone the repo using ghp_abcdefghijklmnopqrstuvwxyz0123456789'})],
    ['purpose',jobSpec({purpose:'authenticate with ghp_abcdefghijklmnopqrstuvwxyz0123456789'})],
    ['expect',jobSpec({expect:'the report shows ghp_abcdefghijklmnopqrstuvwxyz0123456789'})]]){
    refuses('JOB_CREDENTIAL_REFUSED',spec);
  }
  // The same four shapes that `inputs` already rejected must be rejected in a statement too, so the rule is not one
  // pattern applied to one field.
  for(const secret of ['run with github_pat_11ABCDEFG0abcdefghij','export OPENAI=sk-abcdefghijklmnopqrstuvwx',
    'header Authorization: Bearer abcdefghijklmnop.qrstuvwx']){
    refuses('JOB_CREDENTIAL_REFUSED',jobSpec({instruction:'do this: '+secret}));
  }
  // And a statement that merely names the WORD token is still fine: the rule is about values, not vocabulary.
  assert.ok(normalizeAgentJob(jobSpec({instruction:'Read the token file yourself and report the count.'}),enabled));
  refuses('JOB_INPUTS_INVALID',jobSpec({inputs:[{name:'both',text:'a',ref:'b'}]}));
  refuses('JOB_INPUTS_INVALID',jobSpec({inputs:[{name:'neither'}]}));
  refuses('JOB_INPUT_TOO_LONG',jobSpec({inputs:[{name:'big',text:'x'.repeat(16001)}]}));
  refuses('JOB_DEADLINE_INVALID',jobSpec({deadlineMs:0}));
  refuses('JOB_DEADLINE_INVALID',jobSpec({deadlineMs:-5}));
  refuses('JOB_DEADLINE_EXCEEDS_LIMIT',jobSpec({deadlineMs:MAX_DEADLINE_MS+1}));
  // A field the City does not model is refused rather than ignored: silently dropping half of what the owner asked for
  // is worse than being told the field is not understood.
  refuses('JOB_UNKNOWN_FIELD',jobSpec({env:{PATH:'D:/evil'}}));
  const ok=normalizeAgentJob(jobSpec({inputs:[{name:'ref',ref:'docs/en/README.md'},{name:'note',text:'headless host'}]}),enabled);
  assert.equal(ok.schemaVersion,1);
  assert.equal(ok.jobDigest,jobDigest({schemaVersion:1,title:ok.title,instruction:ok.instruction,purpose:ok.purpose,inputs:ok.inputs,expect:ok.expect,deadlineMs:ok.deadlineMs}),
    'the digest covers the frozen body, so two different jobs cannot share one');
  assert.ok(Object.isFrozen(ok));
});

test('CAJ 2: the report validator checks the SHAPE and the HONESTY of a claim, never its truth',()=>{
  const job=normalizeAgentJob(jobSpec(),{enabled:true});
  const good={jobDigest:job.jobDigest,state:'SUCCEEDED',evidence:'OBSERVED_HERE',summary:'ran it',artifacts:[{name:'metrics.csv',sha256:'a'.repeat(64)}]};
  const verdict=validateAgentJobReport(job,good);
  assert.equal(verdict.valid,true);
  // The one fact every accepted report carries: the City did not verify this, and the report cannot pretend it did.
  assert.equal(verdict.acceptanceAuthority,false);
  assert.equal(verdict.verification,'AGENT_OBSERVATION_NOT_CITY_VERIFICATION');
  const fails=(code,report)=>assert.equal(validateAgentJobReport(job,report).code,code);
  fails('REPORT_REQUIRED',undefined);
  fails('REPORT_JOB_MISMATCH',{...good,jobDigest:'b'.repeat(64)});
  fails('REPORT_STATE_INVALID',{...good,state:'ALMOST'});
  fails('REPORT_EVIDENCE_CLASS_REQUIRED',{...good,evidence:undefined});
  fails('REPORT_SUMMARY_REQUIRED',{...good,summary:undefined});
  fails('REPORT_ARTIFACT_DIGEST_REQUIRED',{...good,artifacts:[{name:'x'}]});
  fails('REPORT_ARTIFACTS_INVALID',{...good,artifacts:[{name:'',sha256:'a'.repeat(64)}]});
  // "I did nothing" is a legitimate answer; "I did nothing" AND "I succeeded" is two contradictory statements.
  fails('REPORT_SUCCEEDED_BUT_NOT_DONE',{...good,evidence:'NOT_DONE'});
  fails('REPORT_FAILURE_REASON_REQUIRED',{...good,state:'FAILED',evidence:'OBSERVED_HERE'});
  assert.equal(validateAgentJobReport(job,{...good,state:'FAILED',evidence:'NOT_DONE',reason:'the tool is absent'}).valid,true);
  for(const evidence of EVIDENCE_CLASSES)assert.ok(typeof evidence==='string');
  assert.equal(AGENT_JOB_EXPOSURE.defaultEnabled,false,'the channel is off unless the owner turns it on');
  assert.equal(AGENT_JOB_EXPOSURE.cancellable,true);
});

test('CAJ 3: expiry is decided by a deadline the City clamped, and an unfinished job is the only kind that can expire',()=>{
  const job=normalizeAgentJob(jobSpec({deadlineMs:60000}),{enabled:true});
  const created=new Date(Date.now()-61000).toISOString();
  assert.equal(isJobExpired({...job,createdAt:created}),true);
  assert.equal(isJobExpired({...job,createdAt:new Date().toISOString()}),false);
  assert.equal(isJobExpired({...job,createdAt:created,state:'SUCCEEDED'}),false,'a finished job does not expire afterwards');
  assert.equal(isJobExpired({...job,createdAt:'not-a-date'}),false,'an unreadable timestamp is not silently treated as expired');
});

// ----------------------------------------------------------------------------------------------------------------
// The wiring, against a real gateway.
// ----------------------------------------------------------------------------------------------------------------

async function rig(t,{agentJob}={}){
  const dir=await mkdtemp(resolve('.scratch-agent-job-'));
  const app=await createGateway({dir:resolve(dir,'city'),port:0,token:OWNER_TOKEN,nodeToken:NODE_TOKEN,roomsDisabled:true,
    agentJob:agentJob===undefined?{enabled:true}:agentJob});
  t.after(async()=>{await app.close();await rmScratch(dir);});
  return {dir,app};
}

const register=async(app,id,capabilities)=>fetch(app.url+'/api/v0/node/register',{method:'POST',headers:nodeHeaders,
  body:JSON.stringify({id,displayName:id,capabilities,metadata:{platform:process.platform}})});

const dispatch=(app,options={},credential=owner)=>fetch(app.url+'/api/v0/actions',{method:'POST',headers:credential,
  body:JSON.stringify({route:'CITY_TASK',target:'city.task',operation:'AGENT_JOB',
    input:{targetDeviceRef:options.targetDeviceRef===undefined?NODE_ID:options.targetDeviceRef,job:options.job??jobSpec()},
    idempotencyKey:randomUUID()})});

const jobs=async(app,credential=owner)=>(await fetch(app.url+'/api/v0/node/jobs',{headers:credential})).json();
const taskOf=async(app,taskId)=>{const b=await (await fetch(app.url+'/api/v0/tasks',{headers:owner})).json();return (b.tasks??[]).find(x=>x.id===taskId)??null;};
const claim=async(app,id)=>fetch(app.url+'/api/v0/node/claim',{method:'POST',headers:nodeHeaders,body:JSON.stringify({id})});

test('CAJ 4: an owner-dispatched job reaches a capable node and the agent report comes back labelled as a claim',async t=>{
  const {app}=await rig(t);
  await register(app,NODE_ID,AGENT_NODE_CAPABILITIES);
  const action=(await (await dispatch(app)).json()).action;
  assert.equal(action.status,'QUEUED',JSON.stringify(action.error??null));
  const taskId=action.backendRef.taskId;
  // The City holds the normalised job, and the node it hands it to is the one that advertised the capability.
  const claimed=await claimJob({url:app.url,token:NODE_TOKEN,id:NODE_ID});
  assert.equal(claimed.id,taskId);
  assert.equal(claimed.job.title,jobSpec().title);
  assert.equal(describeClaimedJob(claimed).jobDigest,claimed.job.jobDigest);
  const digest=claimed.job.jobDigest;
  const artifactPath=resolve(await mkdtemp(resolve('.scratch-agent-artifact-')),'report.md');
  await writeFile(artifactPath,'reproduced on the opposite host');
  const sent=await reportJob({url:app.url,token:NODE_TOKEN,id:NODE_ID,taskId,jobDigest:digest,state:'SUCCEEDED',
    evidence:'OBSERVED_HERE',summary:'the harness ran and all four metrics agreed',artifactEntries:['report.md='+artifactPath]});
  assert.equal(sent.state,'COMPLETED');
  const task=await taskOf(app,taskId);
  assert.equal(task.state,'COMPLETED');
  assert.equal(task.result.evidence,'OBSERVED_HERE');
  assert.equal(task.result.artifacts[0].sha256,sha256File(artifactPath),'the digest is of real bytes on this machine');
  // What the owner reads is the agent's claim WITH the City's statement about what kind of claim it is.
  const listed=await jobs(app);
  assert.equal(listed.config.enabled,true);
  assert.equal(listed.exposure.exposureClass,'DIRECT_CONTROL');
  const row=listed.jobs.find(x=>x.taskId===taskId);
  assert.equal(row.reportValidation.valid,true);
  assert.equal(row.reportValidation.acceptanceAuthority,false,'an agent report never becomes a City verification');
  assert.equal(row.job.purpose,jobSpec().purpose);
  assert.equal(row.deadline.expired,false);
});

test('CAJ 5: an incapable node is never handed a job, and the owner can see WHAT it lacks',async t=>{
  // The measured failure this pins is the one the sibling channel already hit once: an older agent that answers a
  // question it was never asked. Eligibility is per task TYPE, at dispatch and again at claim.
  const {app}=await rig(t);
  const OLD='dev-old-agent';
  assert.equal((await register(app,OLD,['task.execute.safe','filesystem.temp'])).status,200,'an older agent registers as itself');
  const action=(await (await dispatch(app,{targetDeviceRef:OLD})).json()).action;
  assert.equal(action.status,'QUEUED','a named machine that is merely not updated yet is waited for, not swapped');
  const taskId=action.backendRef.taskId;
  const row=(await jobs(app)).jobs.find(x=>x.taskId===taskId);
  assert.equal(row.targetStateAtCreation,'INELIGIBLE');
  assert.match(String(row.targetStateDetail),/NODE_MISSING_CAPABILITY:city\.agent-job\.v1/);
  const refused=await (await claim(app,OLD)).json();
  assert.equal(refused.task,null,'an incapable node must not be handed the job');
  assert.equal((await taskOf(app,taskId)).state,'QUEUED','the job waits for a capable node instead of being consumed');
  // And the gate WITHHOLDS rather than breaks: an untargeted job goes to the capable node.
  await register(app,NODE_ID,AGENT_NODE_CAPABILITIES);
  const untargeted=(await (await dispatch(app,{targetDeviceRef:null})).json()).action;
  const taken=await claimJob({url:app.url,token:NODE_TOKEN,id:NODE_ID});
  assert.equal(taken.id,untargeted.backendRef.taskId,'the capable node is the one that takes it');
});

test('CAJ 6: a report bound to a DIFFERENT job is refused before it becomes the stored result',async t=>{
  const {app}=await rig(t);
  await register(app,NODE_ID,AGENT_NODE_CAPABILITIES);
  const first=(await (await dispatch(app,{job:jobSpec({title:'First question'})})).json()).action.backendRef.taskId;
  const second=(await (await dispatch(app,{job:jobSpec({title:'Second question'})})).json()).action.backendRef.taskId;
  const claimed=await claimJob({url:app.url,token:NODE_TOKEN,id:NODE_ID});
  assert.equal(claimed.id,first);
  const wrongDigest=(await jobOf(app,second)).jobDigest;
  const response=await fetch(app.url+'/api/v0/node/report',{method:'POST',headers:nodeHeaders,body:JSON.stringify({id:NODE_ID,taskId:first,state:'COMPLETED',progress:100,
    result:{jobDigest:wrongDigest,state:'SUCCEEDED',evidence:'OBSERVED_HERE',summary:'answered the other question'}})});
  assert.equal(response.status,422);
  assert.match(JSON.stringify(await response.json()),/REPORT_JOB_MISMATCH/);
  // THE POINT OF THE TEST: the refusal happened BEFORE persistence, so the canonical task holds no unchecked claim.
  const after=await taskOf(app,first);
  assert.notEqual(after.state,'COMPLETED','an unverified claim must not reach the task');
  assert.equal(after.result,null,'nothing was stored');
  // A report that simply OMITS the digest must not slip past the check either.
  const omitted=await fetch(app.url+'/api/v0/node/report',{method:'POST',headers:nodeHeaders,body:JSON.stringify({id:NODE_ID,taskId:first,state:'COMPLETED',progress:100,
    result:{state:'SUCCEEDED',evidence:'OBSERVED_HERE',summary:'no digest at all'}})});
  assert.equal(omitted.status,422);
  assert.match(JSON.stringify(await omitted.json()),/REPORT_JOB_MISMATCH/);
  assert.equal((await taskOf(app,first)).result,null);
});

test('CAJ 7: a report may not contradict the state it is written as, and may not decide what the City decides',async t=>{
  const {app}=await rig(t);
  await register(app,NODE_ID,AGENT_NODE_CAPABILITIES);
  const dispatched=(await (await dispatch(app)).json()).action;
  const taskId=dispatched.backendRef.taskId;
  const claimed=await claimJob({url:app.url,token:NODE_TOKEN,id:NODE_ID});
  const send=body=>fetch(app.url+'/api/v0/node/report',{method:'POST',headers:nodeHeaders,body:JSON.stringify({id:NODE_ID,taskId,...body})});
  // The agent says SUCCEEDED while the task is told FAILED: two contradictory statements, and the City refuses to pick.
  const contradiction=await send({state:'FAILED',progress:100,result:{jobDigest:claimed.job.jobDigest,state:'SUCCEEDED',evidence:'OBSERVED_HERE',summary:'ran fine'}});
  assert.equal(contradiction.status,409);
  assert.match(JSON.stringify(await contradiction.json()),/REPORT_TASK_STATE_MISMATCH/);
  // An agent reports an OUTCOME. Cancellation is the owner's decision and expiry is the City's.
  for(const state of ['CANCELLED','EXPIRED']){
    const refused=await send({state:'CANCELLED',progress:100,result:{jobDigest:claimed.job.jobDigest,state,evidence:'INFERRED',summary:'not mine to decide'}});
    assert.equal(refused.status,409,`${state} must not be reportable`);
    assert.match(JSON.stringify(await refused.json()),/REPORT_STATE_NOT_AGENT_DECIDABLE/);
  }
  assert.equal((await taskOf(app,taskId)).state,'ASSIGNED','every refusal left the task exactly where it was');
  assert.equal((await taskOf(app,taskId)).result,null);
});

test('CAJ 8: a job past its deadline is not handed out, and is REPORTED as expired without rewriting the task',async t=>{
  const {app}=await rig(t);
  await register(app,NODE_ID,AGENT_NODE_CAPABILITIES);
  // deadlineMs of 1 ms is the smallest bound the contract allows, so the deadline is certainly past by the time the
  // node asks. Nothing here waits on a clock that could be slow.
  const action=(await (await dispatch(app,{job:jobSpec({deadlineMs:1})})).json()).action;
  const taskId=action.backendRef.taskId;
  await new Promise(r=>setTimeout(r,30));
  const refused=await (await claim(app,NODE_ID)).json();
  assert.equal(refused.task,null,'a request that can no longer be answered in time is not handed to an agent');
  const row=(await jobs(app)).jobs.find(x=>x.taskId===taskId);
  assert.equal(row.deadline.expired,true);
  assert.equal(row.deadline.projectedState,'EXPIRED');
  // The projection is a PROJECTION: the canonical task still says what it says, because no scheduler ran and pretending
  // otherwise would be the City inventing a state transition it never performed.
  assert.equal(row.state,'QUEUED');
  assert.equal((await taskOf(app,taskId)).state,'QUEUED');
  // The owner's stop is a real state change, through the ONE canonical route every task already uses.
  const cancelled=await fetch(app.url+`/api/v0/tasks/${encodeURIComponent(taskId)}/cancel`,{method:'POST',headers:owner,body:'{}'});
  assert.equal(cancelled.status,200,JSON.stringify(await cancelled.clone().json().catch(()=>null)));
  assert.equal((await taskOf(app,taskId)).state,'CANCELLED');
});

test('CAJ 9: a member cannot dispatch a job or read the job surface, and a City that never enabled it refuses by name',async t=>{
  const {app}=await rig(t);
  await register(app,NODE_ID,AGENT_NODE_CAPABILITIES);
  const enrollment=await (await fetch(app.url+'/api/v0/device/enroll',{method:'POST',headers:owner,body:JSON.stringify({displayName:'Member'})})).json();
  const session=(await (await fetch(app.url+'/api/v0/device/session',{method:'POST',headers:V,
    body:JSON.stringify({installationId:enrollment.installation.installationId,instanceId:enrollment.installation.instanceId,...enrollment.credential})})).json()).credential;
  assert.ok(session,'the fixture member must really have a session');
  const member={...V,Authorization:'Bearer '+session,'Content-Type':'application/json'};
  const refused=await dispatch(app,{},member);
  assert.equal(refused.status,403);
  assert.match(JSON.stringify(await refused.json()),/AGENT_JOB_OWNER_REQUIRED/);
  assert.equal((await fetch(app.url+'/api/v0/node/jobs',{headers:member})).status,403);
  assert.equal((await jobs(app)).jobs.length,0,'a member attempt leaves no job behind');

  const off=await rig(t,{agentJob:{enabled:false}});
  await register(off.app,NODE_ID,AGENT_NODE_CAPABILITIES);
  const body=await (await dispatch(off.app)).json();
  assert.equal(body.action.status,'REFUSED');
  assert.equal(body.action.error.code,'AGENT_JOB_DISABLED');
  assert.ok(!body.action.backendRef.taskId,'a refused job must not create a task');
});

test('CAJ 10: the opposite-side CLI drives the whole channel, and a claim with no work is not a failure',async t=>{
  const {app}=await rig(t);
  // Exactly what an agent on the far machine runs first: register, then poll.
  const registered=await registerNode({url:app.url,token:NODE_TOKEN,id:NODE_ID,displayName:'Alien (agent-driven)'});
  assert.equal(registered.id,NODE_ID);
  assert.ok(registered.capabilities.includes('city.agent-job.v1'));
  assert.equal(await claimJob({url:app.url,token:NODE_TOKEN,id:NODE_ID}),null,'an idle agent finds no work, and that is not an error');
  const dispatched=(await (await dispatch(app)).json()).action;
  const claimed=await claimJob({url:app.url,token:NODE_TOKEN,id:NODE_ID});
  assert.equal(claimed.id,dispatched.backendRef.taskId);
  // The digest survives the two separate processes an agent runs, because `claim` writes it down.
  const stateFile=resolve(await mkdtemp(resolve('.scratch-agent-state-')),'claimed.json');
  saveClaimedJob(claimed,stateFile);
  const {readClaimedJob}=await import('../scripts/agent-job.mjs');
  assert.deepEqual(readClaimedJob(stateFile),{taskId:claimed.id,jobDigest:claimed.job.jobDigest});
  const reported=await reportJob({url:app.url,token:NODE_TOKEN,id:NODE_ID,taskId:claimed.id,jobDigest:readClaimedJob(stateFile).jobDigest,
    state:'FAILED',evidence:'NOT_DONE',summary:'the tool the job names is not installed on this machine',reason:'the tool the job names is not installed on this machine'});
  assert.equal(reported.state,'FAILED');
  assert.equal(reported.reportedState,'FAILED');
  // A NOT_DONE claim is a legitimate answer and lands as a FAILED task with the agent's own words attached.
  const task=await taskOf(app,claimed.id);
  assert.equal(task.state,'FAILED');
  assert.equal(task.result.evidence,'NOT_DONE');
  assert.match(task.result.reason,/not installed/);
  // The CLI refuses to make a claim it was not given the evidence class for, and refuses to decide the City's business.
  await assert.rejects(()=>reportJob({url:app.url,token:NODE_TOKEN,id:NODE_ID,taskId:claimed.id,jobDigest:'x',state:'SUCCEEDED',evidence:'PROBABLY',summary:'s'}),
    error=>error.code==='AGENT_JOB_EVIDENCE_REQUIRED');
  await assert.rejects(()=>reportJob({url:app.url,token:NODE_TOKEN,id:NODE_ID,taskId:claimed.id,jobDigest:'x',state:'EXPIRED',evidence:'INFERRED',summary:'s'}),
    error=>error.code==='AGENT_JOB_STATE_NOT_AGENT_DECIDABLE');
  await assert.rejects(()=>reportJob({url:app.url,token:NODE_TOKEN,id:NODE_ID,taskId:claimed.id,jobDigest:undefined,state:'SUCCEEDED',evidence:'INFERRED',summary:'s'}),
    error=>error.code==='AGENT_JOB_DIGEST_REQUIRED');
});

// The digest a dispatched task was normalised to, read back from the owner's own view of the job surface.
async function jobOf(app,taskId){
  const row=(await jobs(app)).jobs.find(x=>x.taskId===taskId);
  return {jobDigest:row?.jobDigest??null};
}
// The raw claim route, with NO heartbeat first - what the CLI would have sent if it never heartbeat.
const rawClaim=async(app,id)=>((await (await fetch(app.url+'/api/v0/node/claim',{method:'POST',headers:nodeHeaders,body:JSON.stringify({id})})).json()).task)??null;
const nodeOnline=async(app,id)=>((await (await fetch(app.url+'/api/v0/nodes',{headers:owner})).json()).nodes??[]).find(n=>n.id===id)?.online===true;

test('CAJ 11: a far-side node goes offline unless it heartbeats, and CLAIMING is what keeps it live',async t=>{
  // MEASURED FAILURE THIS PINS. The first version of the far-side CLI registered and then only claimed. The City marks
  // a node offline once its own heartbeat timeout has passed and never hands an offline node work, so on a real machine
  // the channel would have gone quiet one timeout after registering - and a quiet channel looks EXACTLY like a City
  // with nothing to do. It was found by a browser test failing under load: the machine had dropped out of the owner's
  // own target list. The City's timeout is shortened here so its own rule is what is under test, not a wall-clock wait.
  const dir=await mkdtemp(resolve('.scratch-agent-job-live-'));
  const app=await createGateway({dir:resolve(dir,'city'),port:0,token:OWNER_TOKEN,nodeToken:NODE_TOKEN,roomsDisabled:true,
    agentJob:{enabled:true},heartbeatTimeout:250});
  t.after(async()=>{await app.close();await rmScratch(dir);});
  await registerNode({url:app.url,token:NODE_TOKEN,id:NODE_ID});
  const dispatched=(await (await dispatch(app)).json()).action;
  assert.equal(await nodeOnline(app,NODE_ID),true,'a freshly registered node is online');
  // The City's sweep runs once a second, so this waits for a tick that sees the timeout already passed.
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  await sleep(1400);
  assert.equal(await nodeOnline(app,NODE_ID),false,'with no heartbeat the City stops believing in this machine');
  // An offline node is not handed work, and the raw route (no heartbeat) proves it is the LIVENESS that did that.
  assert.equal(await rawClaim(app,NODE_ID),null,'an offline node is offered nothing');
  // ...and the job is still there, waiting, rather than having been consumed by an unanswerable claim.
  const still=(await jobs(app)).jobs.find(x=>x.taskId===dispatched.backendRef.taskId);
  assert.equal(still.state,'QUEUED');
  assert.equal(still.assignedNodeId,null);
  // CLAIMING THROUGH THE CLI STILL WORKS, because claiming heartbeats first.
  const claimed=await claimJob({url:app.url,token:NODE_TOKEN,id:NODE_ID});
  assert.equal(claimed.id,dispatched.backendRef.taskId,'the CLI must keep its own node alive well enough to be given work');
  assert.equal(await nodeOnline(app,NODE_ID),true);
  // And `heartbeat` on its own does the same for a machine that is busy answering rather than polling.
  await sleep(1400);
  assert.equal(await nodeOnline(app,NODE_ID),false,'a busy machine drops out unless it keeps saying it is there');
  const {heartbeatNode}=await import('../scripts/agent-job.mjs');
  assert.equal((await heartbeatNode({url:app.url,token:NODE_TOKEN,id:NODE_ID})).online,true);
  assert.equal(await nodeOnline(app,NODE_ID),true);
});

test('CAJ 12: the CLI really runs as a COMMAND - which is the only way the far side ever uses it',async t=>{
  // MEASURED FAILURE THIS PINS. Every test above imports the CLI's functions, so all of them passed while the PROGRAM
  // did nothing at all: the entry-point guard compared `import.meta.url` against a hand-built `'file://'+path`, which on
  // Windows is `file://D:\...` where Node's own form is `file:///D:/...`, so the guard never matched and the process
  // exited 0 in silence. The first run against the live City is what exposed it - and a hand-run tool that silently does
  // nothing is the worst failure mode here, because "I ran it" and "nothing happened" look identical to the operator.
  const dir=await mkdtemp(resolve('.scratch-agent-job-cli-'));
  const app=await createGateway({dir:resolve(dir,'city'),port:0,token:OWNER_TOKEN,nodeToken:NODE_TOKEN,roomsDisabled:true,
    agentJob:{enabled:true},heartbeatTimeout:600000});
  t.after(async()=>{await app.close();await rmScratch(dir);});
  const script=resolve(import.meta.dirname,'..','scripts','agent-job.mjs');
  const stateFile=resolve(dir,'claimed.json');
  const execFileAsync=promisify(execFile);
  const run=async args=>{
    try{const r=await execFileAsync(process.execPath,[script,...args],{cwd:dir,timeout:30000,
      env:{...process.env,CITY_URL:app.url,CITY_NODE_TOKEN:NODE_TOKEN,CITY_NODE_ID:NODE_ID}});
      return {code:0,stdout:r.stdout,stderr:r.stderr};}
    catch(error){return {code:error.code??1,stdout:error.stdout??'',stderr:error.stderr??''};}
  };

  // A pure command really produces its answer, and the answer is the one an independent computation gives.
  const file=resolve(dir,'note.txt');await writeFile(file,'a real file whose bytes are digested');
  const digest=await run(['digest','--file',file]);
  assert.equal(digest.code,0,digest.stderr);
  assert.equal(digest.stdout.trim(),sha256File(file),'the command must print the digest it computed');

  // Register really registers, over the real City.
  const registered=await run(['register','--display-name','Mega-rep (agent-job CLI)']);
  assert.equal(registered.code,0,registered.stderr);
  const registration=JSON.parse(registered.stdout);
  assert.equal(registration.registered,NODE_ID);
  assert.ok(registration.capabilities.includes('city.agent-job.v1'));
  assert.equal(await nodeOnline(app,NODE_ID),true);

  // An idle poll is exit 3 - distinguishable from a broken invocation, which is the whole reason it is not 0 or 1.
  const idle=await run(['claim','--state-file',stateFile]);
  assert.equal(idle.code,3,idle.stderr);
  assert.equal(JSON.parse(idle.stdout).task,null);

  // A REAL TWO-PROCESS HANDOFF: `claim` writes the job digest down and `report` reads it back, because an agent runs
  // those as two separate commands and cannot be trusted to carry a digest by hand.
  const dispatched=(await (await dispatch(app)).json()).action;
  const claimed=await run(['claim','--state-file',stateFile]);
  assert.equal(claimed.code,0,claimed.stderr);
  const claimPayload=JSON.parse(claimed.stdout);
  assert.equal(claimPayload.taskId,dispatched.backendRef.taskId);
  assert.equal(claimPayload.jobDigest,(await jobOf(app,dispatched.backendRef.taskId)).jobDigest);
  const reported=await run(['report','--state-file',stateFile,'--state','SUCCEEDED','--evidence','OBSERVED_HERE',
    '--summary','ran through the real command line','--artifact','note.txt='+file]);
  assert.equal(reported.code,0,reported.stderr);
  const task=await taskOf(app,dispatched.backendRef.taskId);
  assert.equal(task.state,'COMPLETED');
  assert.equal(task.result.summary,'ran through the real command line');
  assert.equal(task.result.artifacts[0].sha256,sha256File(file),'the digest is of the real file the command was given');
});

test('CAJ 13: taking delivery of a report is its own recorded act, and it is an acknowledgement - not a verification',async t=>{
  const {app}=await rig(t);
  await register(app,NODE_ID,AGENT_NODE_CAPABILITIES);
  const dispatched=(await (await dispatch(app)).json()).action;
  const taskId=dispatched.backendRef.taskId;
  const claimed=await claimJob({url:app.url,token:NODE_TOKEN,id:NODE_ID});
  const consume=(body,credential=owner)=>fetch(app.url+`/api/v0/node/jobs/${encodeURIComponent(taskId)}/consumed`,{method:'POST',headers:credential,body:JSON.stringify(body??{})});
  const rowOf=async()=>(await jobs(app)).jobs.find(x=>x.taskId===taskId);

  // NOTHING TO COLLECT YET is named, not silently accepted: a job with no report has nothing to take delivery of, and
  // the three states stay distinguishable - nothing to collect / waiting to be collected / collected.
  assert.equal((await rowOf()).consumptionState,'NOTHING_TO_COLLECT','a claimed job with no report has nothing to collect');
  const early=await consume({});
  assert.equal(early.status,409);
  assert.match(JSON.stringify(await early.json()),/CONSUMPTION_REQUIRES_A_REPORT/);
  assert.equal((await rowOf()).consumption,null);

  // The agent answers, then the OWNER takes delivery.
  await reportJob({url:app.url,token:NODE_TOKEN,id:NODE_ID,taskId,jobDigest:claimed.job.jobDigest,state:'SUCCEEDED',
    evidence:'OBSERVED_HERE',summary:'the four metrics agreed on the opposite host'});
  assert.equal((await rowOf()).consumptionState,'AWAITING_COLLECTION','an answer nobody has taken is exactly the one that gets asked for twice');
  const taken=await consume({note:'read on the development host'});
  assert.equal(taken.status,200,JSON.stringify(await taken.clone().json().catch(()=>null)));
  const first=(await taken.json());
  assert.equal(first.idempotent,false);
  const receipt=first.consumption;
  // The receipt says WHAT IT IS, on its face: an acknowledgement by a reader, never a verification of the work.
  assert.equal(receipt.authority,'ACKNOWLEDGEMENT_NOT_VERIFICATION');
  assert.equal(receipt.verification,'AGENT_OBSERVATION_NOT_CITY_VERIFICATION');
  assert.equal(receipt.agentConsumption,false,'a caller acknowledging a result is not the agent consuming it');
  assert.equal(receipt.taskId,taskId);
  assert.equal(receipt.jobDigest,claimed.job.jobDigest);
  assert.equal(receipt.note,'read on the development host');
  // BOUND TO THE EXACT REPORT: the City derives the digest from the report it HOLDS, so the receipt cannot be moved to a
  // different answer. Checked against an independent computation of the stored report rather than against itself.
  const stored=(await taskOf(app,taskId)).result;
  assert.equal(receipt.reportDigest,jobDigest(stored),'the receipt must bind to the stored bytes');
  assert.equal((await rowOf()).consumptionState,'COLLECTED');
  assert.equal((await rowOf()).consumption.receiptDigest,receipt.receiptDigest);

  // IDEMPOTENT: repeating returns the receipt that was RECORDED, with the same digest and the same timestamp.
  const again=(await (await consume({})).json());
  assert.equal(again.idempotent,true);
  assert.equal(again.consumption.receiptDigest,receipt.receiptDigest);
  assert.equal(again.consumption.consumedAt,receipt.consumedAt);
  // A DIFFERENT note is REFUSED rather than allowed to rewrite a recorded act - the same rule this City follows for
  // every other user decision.
  const rewritten=await consume({note:'a different story'});
  assert.equal(rewritten.status,409);
  assert.match(JSON.stringify(await rewritten.json()),/CONSUMPTION_ALREADY_RECORDED/);
  assert.equal((await taskOf(app,taskId)).consumptionNote,'read on the development host');

  // A MEMBER CANNOT TAKE DELIVERY, and a task that is not an agent job cannot be collected at all.
  const enrollment=await (await fetch(app.url+'/api/v0/device/enroll',{method:'POST',headers:owner,body:JSON.stringify({displayName:'Member'})})).json();
  const session=(await (await fetch(app.url+'/api/v0/device/session',{method:'POST',headers:V,
    body:JSON.stringify({installationId:enrollment.installation.installationId,instanceId:enrollment.installation.instanceId,...enrollment.credential})})).json()).credential;
  const member={...V,Authorization:'Bearer '+session,'Content-Type':'application/json'};
  const refused=await consume({},member);
  assert.equal(refused.status,403);
  assert.match(JSON.stringify(await refused.json()),/AGENT_JOB_OWNER_REQUIRED/);
  const notAJob=(await (await fetch(app.url+'/api/v0/tasks',{method:'POST',headers:owner,body:JSON.stringify({type:'WAIT'})})).json()).id;
  const wrong=await fetch(app.url+`/api/v0/node/jobs/${encodeURIComponent(notAJob)}/consumed`,{method:'POST',headers:owner,body:'{}'});
  assert.equal(wrong.status,409);
  assert.match(JSON.stringify(await wrong.json()),/NOT_AN_AGENT_JOB/);
});

test('CAJ 14: the receipt is DERIVED, so it can be recomputed instead of trusted',()=>{
  const job=normalizeAgentJob(jobSpec(),{enabled:true});
  const report={jobDigest:job.jobDigest,state:'SUCCEEDED',evidence:'OBSERVED_HERE',summary:'s',artifacts:[]};
  const args={taskId:'Q-x',job,report,consumedAt:'2026-10-08T00:00:00.000Z',consumedBy:'dev-host',note:'n'};
  const a=consumptionReceipt(args),b=consumptionReceipt({...args});
  assert.equal(a.receiptDigest,b.receiptDigest,'the same facts must give the same receipt');
  // Any field that changes the meaning changes the digest - including the report it is bound to.
  assert.notEqual(consumptionReceipt({...args,note:'other'}).receiptDigest,a.receiptDigest);
  assert.notEqual(consumptionReceipt({...args,report:{...report,summary:'different'}}).receiptDigest,a.receiptDigest);
  assert.ok(Object.isFrozen(a));
  assert.equal(a.reportDigest,jobDigest(report));
  // The request validator refuses by name rather than throwing, and re-applies the SAME report validation the City used
  // when the report arrived - a receipt cannot be issued for something that was never accepted.
  assert.equal(validateConsumptionRequest(job,undefined).code,'CONSUMPTION_REQUIRES_A_REPORT');
  assert.equal(validateConsumptionRequest(undefined,report).code,'JOB_REQUIRED');
  assert.equal(validateConsumptionRequest(job,{...report,jobDigest:'0'.repeat(64)}).code,'REPORT_JOB_MISMATCH');
  assert.equal(validateConsumptionRequest(job,report).ok,true);
});
