import {requireThat as ok,text,strings,finite,copy,freeze} from './validation.mjs';
export function normalizeWorkload(input){
  const w=copy(input);ok(w.version===1,'WORKLOAD_VERSION');
  for(const key of ['taskId','actionId','originDeviceId','parentSessionId','appId','kind','outputSchema'])ok(text(w[key]),'WORKLOAD_'+key);
  ok(strings(w.capabilities)&&Array.isArray(w.inputRefs)&&w.inputRefs.length<=256&&strings(w.writeScope),'WORKLOAD_LIST');
  ok(['INTERACTIVE','SOFT_DEADLINE','BATCH','BACKGROUND'].includes(w.qos),'QOS_UNKNOWN');
  ok(['PURE','IDEMPOTENT','CHECKPOINTABLE','NON_RETRYABLE','SIDE_EFFECT_UNKNOWN'].includes(w.retryClass),'RETRY_CLASS_UNKNOWN');
  ok(['PUBLIC','PERSONAL','CONFIDENTIAL'].includes(w.dataScope),'DATA_SCOPE_UNKNOWN');
  ok(w.resources&&Object.keys(w.resources).length>0&&Object.keys(w.resources).every(k=>['cpu','memory','disk','vram'].includes(k))&&Object.values(w.resources).every(finite),'RESOURCES_INVALID');
  ok(finite(w.deadlineAt),'DEADLINE_INVALID');if(w.qos==='SOFT_DEADLINE')ok(['REFUSE','RUN_LATE','DEGRADE'].includes(w.missPolicy),'MISS_POLICY_REQUIRED');
  return freeze(w);
}
