import {requireThat as ok,text,digest,copy,freeze} from './validation.mjs';
import {normalizeWorkload} from './workload.mjs';
import {assertPolicy} from './policy.mjs';
export function compileExecutionCapsule(workload,spec,now){
  const w=normalizeWorkload(workload),s=copy(spec);for(const k of ['attemptId','executorDeviceId','bootId','providerId'])ok(text(s[k]),'CAPSULE_'+k);
  ok(Number.isSafeInteger(s.epoch)&&s.epoch>0&&digest(s.inputDigest),'CAPSULE_BINDING');ok(now<w.deadlineAt,'DEADLINE_EXPIRED');
  assertPolicy(s.policy,{deviceId:s.executorDeviceId,dataScope:w.dataScope,fee:s.fee??0,cloud:s.cloud??false},now);
  // PCF-726 bullet 1: the capsule preserves a reference to the independence floor that applied to this work. The floor
  // itself belongs to the review-independence programme, so it is never invented here: a task that declares one carries
  // it verbatim, and a task that declares none says NOT_DECLARED rather than fabricating a governance fact.
  const independenceFloorRef=s.independenceFloorRef??null;
  ok(independenceFloorRef===null||text(independenceFloorRef),'CAPSULE_INDEPENDENCE_FLOOR_INVALID');
  return freeze({...w,version:1,attemptId:s.attemptId,epoch:s.epoch,executorDeviceId:s.executorDeviceId,bootId:s.bootId,providerId:s.providerId,inputDigest:s.inputDigest,policyVersion:s.policy.version,fee:s.fee??0,cloud:s.cloud??false,
    independenceFloorRef,independenceFloorStatus:independenceFloorRef===null?'NOT_DECLARED':'DECLARED'});
}

/** The independence floor the capsule was compiled under, or an explicit statement that none was declared. */
export function independenceFloorOf(capsule){
  ok(capsule&&typeof capsule==='object','CAPSULE_REQUIRED');
  return freeze({declared:typeof capsule.independenceFloorRef==='string'&&capsule.independenceFloorRef.length>0,
    independenceFloorRef:capsule.independenceFloorRef??null,status:capsule.independenceFloorStatus??'NOT_DECLARED'});
}

/**
 * An independence requirement is only satisfied by the floor the capsule actually declares. A capsule with no declared
 * floor cannot be presented as meeting one, which is the difference between "nobody recorded it" and "it was met".
 */
export function assertIndependenceFloor(capsule,{requiredFloorRef}={}){
  const floor=independenceFloorOf(capsule);
  ok(text(requiredFloorRef),'INDEPENDENCE_FLOOR_REQUIRED');
  ok(floor.declared&&floor.independenceFloorRef===requiredFloorRef,'INDEPENDENCE_FLOOR_NOT_SATISFIED:'+(floor.independenceFloorRef??'NOT_DECLARED'));
  return freeze({satisfied:true,independenceFloorRef:requiredFloorRef});
}
export function validateResultEnvelope(capsule,receipt,{policy,now}){
  const r=copy(receipt);ok(r.version===1,'RECEIPT_VERSION');
  for(const k of ['taskId','actionId','parentSessionId','attemptId','epoch','executorDeviceId','bootId','providerId','inputDigest','policyVersion'])ok(r[k]===capsule[k],'RECEIPT_BINDING_'+k);
  ok(policy.version===capsule.policyVersion,'POLICY_CHANGED');assertPolicy(policy,{deviceId:capsule.executorDeviceId,dataScope:capsule.dataScope,fee:capsule.fee,cloud:capsule.cloud},now);
  ok(['SUCCEEDED','FAILED','CANCELLED','UNKNOWN'].includes(r.outcome),'OUTCOME_UNKNOWN');ok(Number.isInteger(r.exitCode)||r.exitCode===null,'EXIT_CODE_UNKNOWN');
  if(r.outcome==='SUCCEEDED')ok(r.exitCode===0&&digest(r.outputDigest),'OUTPUT_NOT_PROVEN');
  return freeze(r);
}
