import {requireThat as ok,text,digest,copy,freeze} from './validation.mjs';
import {normalizeWorkload} from './workload.mjs';
import {assertPolicy} from './policy.mjs';
export function compileExecutionCapsule(workload,spec,now){
  const w=normalizeWorkload(workload),s=copy(spec);for(const k of ['attemptId','executorDeviceId','bootId','providerId'])ok(text(s[k]),'CAPSULE_'+k);
  ok(Number.isSafeInteger(s.epoch)&&s.epoch>0&&digest(s.inputDigest),'CAPSULE_BINDING');ok(now<w.deadlineAt,'DEADLINE_EXPIRED');
  assertPolicy(s.policy,{deviceId:s.executorDeviceId,dataScope:w.dataScope,fee:s.fee??0,cloud:s.cloud??false},now);
  return freeze({...w,version:1,attemptId:s.attemptId,epoch:s.epoch,executorDeviceId:s.executorDeviceId,bootId:s.bootId,providerId:s.providerId,inputDigest:s.inputDigest,policyVersion:s.policy.version,fee:s.fee??0,cloud:s.cloud??false});
}
export function validateResultEnvelope(capsule,receipt,{policy,now}){
  const r=copy(receipt);ok(r.version===1,'RECEIPT_VERSION');
  for(const k of ['taskId','actionId','parentSessionId','attemptId','epoch','executorDeviceId','bootId','providerId','inputDigest','policyVersion'])ok(r[k]===capsule[k],'RECEIPT_BINDING_'+k);
  ok(policy.version===capsule.policyVersion,'POLICY_CHANGED');assertPolicy(policy,{deviceId:capsule.executorDeviceId,dataScope:capsule.dataScope,fee:capsule.fee,cloud:capsule.cloud},now);
  ok(['SUCCEEDED','FAILED','CANCELLED','UNKNOWN'].includes(r.outcome),'OUTCOME_UNKNOWN');ok(Number.isInteger(r.exitCode)||r.exitCode===null,'EXIT_CODE_UNKNOWN');
  if(r.outcome==='SUCCEEDED')ok(r.exitCode===0&&digest(r.outputDigest),'OUTPUT_NOT_PROVEN');
  return freeze(r);
}
