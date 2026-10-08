import {randomUUID} from 'node:crypto';
import {admit,claimAttempt,commitResult,recordOwnedProcess} from './admission.mjs';
import {normalizeWorkload} from './workload.mjs';
import {planPlacement} from './placement.mjs';
import {resolveEffectivePolicy,assertPolicy} from './policy.mjs';
import {compileExecutionCapsule,validateResultEnvelope} from './execution-capsule.mjs';
import {executeCpu} from './executor.mjs';
import {sha256} from './artifacts.mjs';
import {requireThat as ok,copy,text} from './validation.mjs';

// Candidate canonical port only. All authentication, grants, observations and artifacts are injected.
export function createRemoteWorkerPort({enabled=false,owner,taskFor,readAuthority,authorizeWorker,observations,artifacts,verifyClosed,validateAuthorityBoundary,requestStop=async()=>({requested:false,reason:'NOT_WIRED'}),now=Date.now}){
 ok(typeof enabled==='boolean','REMOTE_OPT_IN');
 if(enabled)ok(owner&&[taskFor,readAuthority,authorizeWorker,observations,verifyClosed,validateAuthorityBoundary].every(f=>typeof f==='function')&&artifacts,'REMOTE_CONFIGURATION');
 const guard=()=>ok(enabled,'REMOTE_NOT_ENABLED');
 // This callback must read current owner+worker facts together from the existing authority.
 // It runs synchronously inside canonical transactions, or immediately before data delivery.
 function boundary({workload=null,capsule=null,principal,policyVersion=null,grantVersion,phase}){
  ok(Number.isSafeInteger(grantVersion)&&grantVersion>=0,'GRANT_VERSION');
  const result=validateAuthorityBoundary({workload,capsule,principal:copy(principal),policyVersion,grantVersion,phase});
  ok(result===true,'AUTHORITY_BOUNDARY');
 }
 function scopedOwner(binding){return {...owner,transaction(version,mutate){return owner.transaction(version,(state,ops)=>{boundary(binding);return mutate(state,ops);});}};}
 const policyFor=async workload=>resolveEffectivePolicy({mode:'TRUSTED_PERSONAL_FABRIC'},await readAuthority({sessionId:workload.parentSessionId,deviceId:workload.originDeviceId}),now());
 async function worker(principal,deviceId){guard();ok(principal&&principal.deviceId===deviceId&&text(principal.bootId)&&text(principal.instanceId),'WORKER_BINDING');const grant=await authorizeWorker(copy(principal));ok(grant?.authorized===true&&['deviceId','bootId','instanceId'].every(k=>grant[k]===principal[k]),'WORKER_UNAUTHORIZED');return grant;}
 async function held(args){const grant=await worker(args.principal,args.nodeId??args.endpointRef);const task=taskFor(args.taskId);ok(task?.executionBackendId==='pcf-v1'&&task.pcfRemote,'REMOTE_TASK_UNKNOWN');const remote=task.pcfRemote;ok(['deviceId','bootId','instanceId'].every(k=>remote.principal[k]===args.principal[k]),'WORKER_BINDING');ok(remote.claimNonce&&(!args.claimNonce||args.claimNonce===remote.claimNonce),'CLAIM_NONCE');const policy=await policyFor(remote.capsule);ok(policy.version===remote.capsule.policyVersion,'POLICY_CHANGED');assertPolicy(policy,{deviceId:args.principal.deviceId,dataScope:remote.capsule.dataScope,fee:0},now());boundary({capsule:remote.capsule,principal:args.principal,policyVersion:policy.version,grantVersion:grant.version,phase:'held'});return {task,remote,policy,grant};}
 const api={
  evidenceClass:'SIMULATED_TOPOLOGY+ACTUAL_LOCAL_PROCESSES',
  async workerStatus({nodeId,principal}){const grant=await worker(principal,nodeId);const observed=observations().find(c=>c.deviceId===nodeId);ok(observed&&observed.bootId===principal.bootId&&observed.instanceId===principal.instanceId&&now()<observed.validUntil,'WORKER_OBSERVATION_STALE');boundary({principal,grantVersion:grant.version,phase:'workerStatus'});return {descriptor:{availability:{sharingEnabled:observed.sharing===true,acceptingWork:observed.executorReady===true}},candidate:'NOT_WIRED'};},
  endpoints(){if(!enabled)return [];return observations().map(c=>({endpointRef:c.deviceId,nodeId:c.deviceId,ready:c.executorReady===true&&c.authorized===true&&c.sharing===true&&c.trusted===true&&now()<c.validUntil,readinessReason:null}));},
  async dispatch({endpointRef,taskId,workload,idempotencyKey}){
   guard();const w=normalizeWorkload(workload);ok(w.taskId===taskId,'DISPATCH_TASK_BINDING');const task=taskFor(taskId);ok(task?.executionBackendId==='pcf-v1','REMOTE_TASK_UNKNOWN');
   const candidate=observations().find(c=>c.deviceId===endpointRef);ok(candidate,'ENDPOINT_UNKNOWN');const principal={deviceId:endpointRef,bootId:candidate.bootId,instanceId:candidate.instanceId};await worker(principal,endpointRef);
   const policy=await policyFor(w),proposal=planPlacement(w,[candidate],policy,now(),{strategy:'CAPABILITY'});const inputRef=w.inputRefs[0];ok(w.inputRefs.length===1&&inputRef,'INPUT_BINDING');const bytes=await artifacts.read(inputRef,{caller:w.parentSessionId},now());ok(sha256(bytes)===inputRef.digest,'INPUT_DIGEST');
   // Recheck after asynchronous reads before admitting work to the canonical owner.
   const grant=await worker(principal,endpointRef);const current=await policyFor(w);ok(current.version===policy.version,'POLICY_CHANGED');
   const binding={workload:w,principal,policyVersion:current.version,grantVersion:grant.version,phase:'dispatch'};const guardedOwner=scopedOwner(binding);
   const reservation=admit(guardedOwner,{workload:w,proposal,policy:current,candidate,idempotencyKey,ttlMs:10000,appQuota:{cpu:8,memory:536870912},now:now()}).reservation;
   const holder='remote:'+principal.deviceId+':'+principal.instanceId;
   const attempt=claimAttempt(guardedOwner,{reservationId:reservation.id,holder,bootId:principal.bootId,now:now()});
   const capsule=compileExecutionCapsule(w,{attemptId:attempt.id,epoch:attempt.epoch,executorDeviceId:endpointRef,bootId:principal.bootId,providerId:candidate.provider.id,inputDigest:inputRef.digest,policy:current},now());
   guardedOwner.transaction(undefined,(_,{getTask,putTask})=>{const t=getTask(taskId);ok(t?.pcfAttemptId===attempt.id&&t.pcfEpoch===attempt.epoch,'ATTEMPT_FENCED');putTask({...t,assignedNodeId:endpointRef,pcfRemote:{capsule,principal,holder,inputRef,claimNonce:null,stopRequested:false}});return {};});
   return {taskId,attemptId:attempt.id,epoch:attempt.epoch,endpointRef};
  },
  async claim({nodeId,endpointRef=nodeId,principal}){
   await worker(principal,endpointRef);const pending=owner.snapshot().attempts.filter(a=>a.state==='RUNNING').map(a=>taskFor(a.taskId)).filter(t=>t?.pcfRemote?.principal.deviceId===endpointRef);
   const task=pending.find(t=>!t.pcfRemote.claimNonce);if(!task){ok(!pending.length,'CLAIM_ALREADY_DELIVERED');return {task:null};}
   ok(['bootId','instanceId'].every(k=>task.pcfRemote.principal[k]===principal[k]),'WORKER_BINDING');const policy=await policyFor(task.pcfRemote.capsule);ok(policy.version===task.pcfRemote.capsule.policyVersion,'POLICY_CHANGED');assertPolicy(policy,{deviceId:endpointRef,dataScope:task.pcfRemote.capsule.dataScope},now());
   const grant=await worker(principal,endpointRef);
   return scopedOwner({capsule:task.pcfRemote.capsule,principal,policyVersion:policy.version,grantVersion:grant.version,phase:'claim'}).transaction(undefined,(_,{getTask,putTask})=>{const t=getTask(task.id);ok(t?.state==='RUNNING'&&t.pcfEpoch===task.pcfEpoch&&!t.pcfRemote.claimNonce,'CLAIM_ALREADY_DELIVERED');const updated={...t,pcfRemote:{...t.pcfRemote,claimNonce:randomUUID()}};putTask(updated);return {task:updated};});
  },
  async input(args){const {remote,policy,grant}=await held(args);ok(args.claimNonce===remote.claimNonce,'CLAIM_NONCE');const bytes=await artifacts.read(remote.inputRef,{caller:remote.capsule.parentSessionId},now());ok(sha256(bytes)===remote.capsule.inputDigest,'INPUT_DIGEST');boundary({capsule:remote.capsule,principal:args.principal,policyVersion:policy.version,grantVersion:grant.version,phase:'inputDelivery'});return JSON.parse(bytes.toString());},
  async processStarted(args,processIdentity){const {remote,policy,grant}=await held(args);ok(args.claimNonce===remote.claimNonce,'CLAIM_NONCE');return recordOwnedProcess(scopedOwner({capsule:remote.capsule,principal:args.principal,policyVersion:policy.version,grantVersion:grant.version,phase:'processStarted'}),{taskId:args.taskId,attemptId:remote.capsule.attemptId,epoch:remote.capsule.epoch,holder:remote.holder,bootId:remote.principal.bootId,processIdentity});},
  async report(args){
   const {task,remote,policy,grant:heldGrant}=await held(args);ok(task.state==='RUNNING','ATTEMPT_FENCED');
   if(args.state==='RUNNING'){ok(!args.result,'LEGACY_RESULT_REFUSED');boundary({capsule:remote.capsule,principal:args.principal,policyVersion:policy.version,grantVersion:heldGrant.version,phase:'runningDelivery'});return task;}
   const receipt=args.result?.receipt;ok(receipt,'CLOSED_RECEIPT_REQUIRED');ok(args.result.claimNonce===remote.claimNonce,'CLAIM_NONCE');validateResultEnvelope(remote.capsule,receipt,{policy,now:now()});
   ok(task.pcfProcessIdentity?.pid===receipt.pid&&receipt.processClosed===true&&await verifyClosed(receipt,args.principal),'PROCESS_STOP_NOT_PROVEN');
   let outputRef=null;
   if(receipt.outcome==='SUCCEEDED'){
    const encoded=args.result.outputBase64;ok(typeof encoded==='string'&&encoded.length<=1398104,'OUTPUT_BOUNDS');const bytes=Buffer.from(encoded,'base64');ok(bytes.toString('base64')===encoded&&sha256(bytes)===receipt.outputDigest,'OUTPUT_DIGEST');JSON.parse(bytes.toString());
    outputRef=await artifacts.publish(bytes,{owner:remote.capsule.parentSessionId,dataScope:remote.capsule.dataScope,expiresAt:now()+86400000,schema:remote.capsule.outputSchema},now());ok(outputRef.digest===receipt.outputDigest,'OUTPUT_DIGEST');
   }
   const grant=await worker(args.principal,args.nodeId??args.endpointRef);const latestPolicy=await policyFor(remote.capsule);validateResultEnvelope(remote.capsule,receipt,{policy:latestPolicy,now:now()});
   commitResult(scopedOwner({capsule:remote.capsule,principal:args.principal,policyVersion:latestPolicy.version,grantVersion:grant.version,phase:'reportCommit'}),{...receipt,outputRef,holder:remote.holder,now:now()});return taskFor(task.id);
  },
  async control(args){const {task,remote,policy,grant}=await held(args);ok(task.state==='RUNNING','ATTEMPT_FENCED');scopedOwner({capsule:remote.capsule,principal:args.principal,policyVersion:policy.version,grantVersion:grant.version,phase:'control'}).transaction(undefined,(_,{getTask,putTask})=>{const t=getTask(task.id);ok(t?.pcfEpoch===remote.capsule.epoch,'ATTEMPT_FENCED');putTask({...t,pcfRemote:{...t.pcfRemote,stopRequested:true}});return {};});const result=await requestStop({taskId:task.id,attemptId:remote.capsule.attemptId,principal:args.principal});return {taskId:task.id,state:'RUNNING',stopRequested:true,stopped:false,transport:result};},
  async collect(taskId,context){guard();const task=taskFor(taskId);ok(task?.executionBackendId==='pcf-v1'&&task.parentSessionId===context.sessionId&&task.originDeviceId===context.deviceId,'ORIGIN_UNAUTHORIZED');const policy=await policyFor(task.pcfRemote.capsule);assertPolicy(policy,{deviceId:task.originDeviceId,dataScope:task.pcfRemote.capsule.dataScope},now());ok(task.state==='COMPLETED'&&task.pcfResult?.outputRef,'RESULT_NOT_READY');const bytes=await artifacts.read(task.pcfResult.outputRef,{caller:context.sessionId},now());const grant=await worker(task.pcfRemote.principal,task.pcfRemote.principal.deviceId);boundary({capsule:task.pcfRemote.capsule,principal:task.pcfRemote.principal,policyVersion:policy.version,grantVersion:grant.version,phase:'collectDelivery'});return {taskId,output:JSON.parse(bytes.toString()),digest:task.pcfResult.outputDigest};},
 };
 return Object.freeze(api);
}

// The transport resolves the existing authenticated handle on every call; body id grants nothing.
export function createRemoteWorkerRequest({port,canonical=port,authenticate}){
 ok(typeof authenticate==='function','AUTHENTICATED_TRANSPORT_REQUIRED');
 return async(path,body,context)=>{const principal=await authenticate(context);ok(principal?.deviceId===body.id||path.startsWith('tasks/'),'WORKER_BINDING');
  if(path==='node/register'||path==='node/heartbeat'||path==='node/descriptor')return canonical.workerStatus({nodeId:body.id,principal});
  if(path==='node/claim')return port.claim({nodeId:body.id,principal});
  if(path==='node/report')return port.report({...body,nodeId:body.id,principal});
  if(/^tasks\/[^/]+\/cancel$/.test(path))return port.control({nodeId:principal.deviceId,principal,taskId:decodeURIComponent(path.split('/')[1])});
  throw Object.assign(new Error('REMOTE_ROUTE_NOT_WIRED'),{code:'REMOTE_ROUTE_NOT_WIRED'});
 };
}

// Only the fixed CPU application is executable. executeCpu records PID before stdin and resolves after close.
export function createRemoteCpuExecutor({port,principal,onClosed=async()=>{}}){
 return async(task,{signal})=>{
  const remote=task.pcfRemote,args={taskId:task.id,nodeId:principal.deviceId,principal,claimNonce:remote.claimNonce};const input=await port.input(args);
  const result=await executeCpu({...input,deadlineMs:Math.min(5000,remote.capsule.deadlineAt-Date.now()),signal,onStart:identity=>port.processStarted(args,identity)});
  const bytes=result.output===null?null:Buffer.from(JSON.stringify(result.output));const receipt={...remote.capsule,version:1,outcome:result.outcome,exitCode:result.exitCode,outputDigest:bytes?sha256(bytes):null,pid:result.pid,processClosed:true};
  await onClosed(receipt);return {claimNonce:remote.claimNonce,receipt,outputBase64:bytes?.toString('base64')??null};
 };
}
