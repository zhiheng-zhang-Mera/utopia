import {finite} from './validation.mjs';
export function evaluateInterference(settings,observation,state,now){
 if(settings.enabled!==true)return {action:'NONE',reason:'USER_DISABLED'};
 if(!finite(observation.latencyMs)||!finite(observation.observedAt)||observation.observedAt>now||!finite(observation.validUntil)||now>=observation.validUntil)return {action:'REMEASURE'};
 if(!finite(settings.targetMs)||settings.targetMs===0)return {action:'SLO_UNSATISFIABLE',reason:'TARGET_UNSPECIFIED'};
 if(now-state.lastChangedAt<Math.max(settings.cooldownMs,settings.minimumDwellMs))return {action:'NONE',reason:'HYSTERESIS'};
 if(observation.latencyMs<=settings.targetMs)return {action:'NONE',measuredTargetMet:true};
 const allowed=['REDUCE_PARALLELISM','REFUSE_BACKGROUND','COOPERATIVE_PAUSE','REVERSIBLE_QUALITY'];const action=settings.allowedOptions.find(x=>allowed.includes(x));
 if(action==='COOPERATIVE_PAUSE'&&observation.preemptible!==true)return {action:'SLO_UNSATISFIABLE',reason:'NON_PREEMPTIBLE'};
 if(action==='REVERSIBLE_QUALITY'&&observation.qualityReversible!==true)return {action:'SLO_UNSATISFIABLE',reason:'IRREVERSIBLE_QUALITY'};
 return action?{action,reason:'MEASURED_TARGET_MISSED',hardRealtime:false}:{action:'SLO_UNSATISFIABLE',hardRealtime:false};
}
