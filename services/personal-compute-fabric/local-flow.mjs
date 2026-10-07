// Explicit local candidate harness; no remote, provider or physical acceptance claim.
import {randomUUID} from 'node:crypto';import {platform,freemem,cpus} from 'node:os';
import {normalizeWorkload} from './workload.mjs';import {resolveEffectivePolicy,assertPolicy} from './policy.mjs';import {planPlacement} from './placement.mjs';import {admit,claimAttempt,commitResult,recordOwnedProcess} from './admission.mjs';
import {compileExecutionCapsule,validateResultEnvelope} from './execution-capsule.mjs';import {executeCpu} from './executor.mjs';import {sha256} from './artifacts.mjs';import {requireThat as ok} from './validation.mjs';
export async function executeApprovedLocal({owner,artifacts,workload,input,authority,deviceId,signal,inputRef:providedInputRef=null,generation=0}){
 const now=Date.now(),w=normalizeWorkload(workload);ok(deviceId===w.originDeviceId,'LOCAL_HARNESS_CANNOT_EXECUTE_REMOTE');
 const currentAuthority=async()=>typeof authority==='function'?await authority():authority;
 const policy=resolveEffectivePolicy({},await currentAuthority(),now),bootId='PROCESS_EPOCH:'+process.pid,provider={version:1,id:'pcf-fixed-cpu-v1',platform:platform(),capabilities:['cpu.json'],workloadKinds:['CPU_JSON'],isolation:'COOPERATIVE',ready:true};
 const candidate={deviceId,bootId,trusted:true,authorized:true,sharing:true,executorReady:true,platform:platform(),provider,free:{cpu:cpus().length,memory:freemem()},observationVersion:1,observedAt:now,validUntil:now+10000,queueMs:0,cost:{inputMs:[0,10],coldStartMs:[0,2000],executeMs:[0,5000],returnMs:[0,10]}};
 // Store and verify actual bytes before dispatch. Estimates above are explicit bounds, not measurements.
 const bytes=Buffer.from(JSON.stringify(input)),inputRef=providedInputRef??await artifacts.publish(bytes,{owner:w.parentSessionId,dataScope:w.dataScope,expiresAt:w.deadlineAt,schema:'cpu-json-v1'},now);
 const refreshed=resolveEffectivePolicy({},await currentAuthority(),Date.now());ok(refreshed.version===policy.version,'POLICY_CHANGED');const proposal=planPlacement(w,[candidate],refreshed,Date.now());const reservation=admit(owner,{workload:w,proposal,policy,candidate,idempotencyKey:'local:'+w.taskId+':'+generation,ttlMs:10000,appQuota:{cpu:2,memory:512*1024*1024},now}).reservation;
 const attempt=claimAttempt(owner,{reservationId:reservation.id,holder:'local:'+process.pid,bootId,now:Date.now()});
 let result,capsule,processLaunched=false;
 try{
  capsule=compileExecutionCapsule(w,{attemptId:attempt.id,epoch:attempt.epoch,executorDeviceId:deviceId,bootId,providerId:provider.id,inputDigest:inputRef.digest,policy:refreshed},Date.now());
  const startPolicy=resolveEffectivePolicy({},await currentAuthority(),Date.now());ok(startPolicy.version===capsule.policyVersion,'POLICY_CHANGED');assertPolicy(startPolicy,{deviceId,dataScope:w.dataScope,fee:0},Date.now());
  const verified=JSON.parse((await artifacts.read(inputRef,{caller:w.parentSessionId},Date.now())).toString());ok(sha256(bytes)===capsule.inputDigest,'INPUT_DIGEST');
  result=await executeCpu({...verified,deadlineMs:Math.min(5000,w.deadlineAt-Date.now()),signal,onStart:processIdentity=>{processLaunched=true;return recordOwnedProcess(owner,{taskId:w.taskId,attemptId:attempt.id,epoch:attempt.epoch,holder:attempt.holder,bootId,processIdentity});}});
  const outputRef=result.outcome==='SUCCEEDED'?await artifacts.publish(Buffer.from(JSON.stringify(result.output)),{owner:w.parentSessionId,dataScope:w.dataScope,expiresAt:Date.now()+86400000,schema:w.outputSchema},Date.now()):null;
  const receipt={version:1,taskId:w.taskId,actionId:w.actionId,parentSessionId:w.parentSessionId,attemptId:attempt.id,epoch:attempt.epoch,executorDeviceId:deviceId,bootId,providerId:provider.id,inputDigest:inputRef.digest,outputDigest:outputRef?.digest??null,digest:outputRef?.digest??null,policyVersion:policy.version,outcome:result.outcome,exitCode:result.exitCode,outputRef,pid:result.pid,evidenceClass:'ACTUAL_LOCAL_CPU'};
  validateResultEnvelope(capsule,receipt,{policy:resolveEffectivePolicy({},await currentAuthority(),Date.now()),now:Date.now()});
  commitResult(owner,{...receipt,holder:attempt.holder,now:Date.now()});return {capsule,receipt,output:result.output};
 }catch(error){
  // A process that never started, or whose owned close receipt arrived, has a known stop.
  // All other failures retain their reservation for authoritative reconciliation.
  if(!processLaunched||result){try{commitResult(owner,{taskId:w.taskId,attemptId:attempt.id,epoch:attempt.epoch,holder:attempt.holder,bootId,outcome:result?.outcome==='CANCELLED'?'CANCELLED':'FAILED',outputDigest:null,reason:error.code??error.message,pid:result?.pid??null,now:Date.now()});}catch(cleanupError){error.canonicalCleanup=cleanupError.code??cleanupError.message;}}
  throw Object.assign(error,{pcfTaskId:w.taskId,pcfAttemptId:attempt.id});
 }
}
