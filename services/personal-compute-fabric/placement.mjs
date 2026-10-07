import {assertPolicy} from './policy.mjs';import {describeExecutorBoundary} from './executor-provider.mjs';
import {estimateCost} from './cost-model.mjs';import {finite,freeze} from './validation.mjs';
export function feasibility(workload,candidate,policy,now){
 try{assertPolicy(policy,{deviceId:candidate.deviceId,dataScope:workload.dataScope,fee:candidate.fee??0,cloud:candidate.cloud??false},now);}catch(e){return e.code;}
 if(!candidate.trusted||!candidate.authorized||!candidate.executorReady||!candidate.sharing)return 'EXECUTOR_NOT_AUTHORIZED_OR_READY';
 if(workload.strictTargetDeviceId&&workload.strictTargetDeviceId!==candidate.deviceId)return 'STRICT_TARGET';
 if(workload.platform&&workload.platform!==candidate.platform)return 'PLATFORM';
 if(!finite(candidate.observedAt)||candidate.observedAt>now||!finite(candidate.validUntil)||now>=candidate.validUntil||!Number.isSafeInteger(candidate.observationVersion))return 'REMEASURE';
 if(!candidate.provider?.ready||!workload.capabilities.every(c=>candidate.provider.capabilities?.includes(c))||!candidate.provider.workloadKinds?.includes(workload.kind))return 'CAPABILITY';
 if(workload.requireHardIsolation){try{describeExecutorBoundary(candidate.provider,{requireHardIsolation:true});}catch{return 'ISOLATION';}}
 if(Object.entries(workload.resources).some(([k,v])=>!finite(v)||!finite(candidate.free?.[k])||candidate.free[k]<v))return 'RESOURCE_UNKNOWN_OR_INSUFFICIENT';
 return null;
}
export function planPlacement(workload,candidates,policy,now,{strategy='COMPOSITE',limit=32}={}){
 if(!['FIXED','CAPABILITY','LOAD','COMPOSITE'].includes(strategy)||!Number.isInteger(limit)||limit<1||limit>128)throw new RangeError('PLACEMENT_OPTIONS');
 if(!Array.isArray(candidates)||candidates.length>128)throw new RangeError('CANDIDATE_LIMIT');
 const refused=[],eligible=[];for(const c of candidates){const reason=feasibility(workload,c,policy,now);if(reason){refused.push({deviceId:c.deviceId,reason});continue;}const cost=estimateCost(c);if(strategy==='COMPOSITE'&&cost.state==='UNKNOWN'){refused.push({deviceId:c.deviceId,reason:'COST_UNKNOWN'});continue;}eligible.push({candidate:c,cost});}
 eligible.sort((a,b)=>{const localA=a.candidate.deviceId===workload.originDeviceId,localB=b.candidate.deviceId===workload.originDeviceId;if(localA!==localB)return localA?-1:1;const score=c=>strategy==='LOAD'?c.candidate.queueMs:strategy==='COMPOSITE'?c.cost.intervalMs[1]:0;return score(a)-score(b)||a.candidate.deviceId.localeCompare(b.candidate.deviceId);});
 const winner=eligible[0];if(!winner)return freeze({state:'REFUSED',taskId:workload.taskId,reasons:refused.slice(0,limit)});
 return freeze({state:'PROPOSED',taskId:workload.taskId,deviceId:winner.candidate.deviceId,bootId:winner.candidate.bootId,providerId:winner.candidate.provider.id,observationVersion:winner.candidate.observationVersion,policyVersion:policy.version,validUntil:Math.min(winner.candidate.validUntil,policy.expiresAt,workload.deadlineAt),cost:winner.cost,strategy,candidates:eligible.slice(0,limit).map(x=>x.candidate.deviceId),reasons:refused.slice(0,limit)});
}
