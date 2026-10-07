// Proposal only: the caller must reauthorize and obtain a new canonical fenced attempt.
export function planRecovery(workload,context){
 const attention=reason=>({action:'ATTENTION',reason,taskId:workload.taskId??null});
 if(context.authorized!==true)return attention('AUTHORITY_REQUIRED');if(context.previousStopped!==true)return attention('OLD_HOLDER_STOP_NOT_PROVEN');
 if(workload.strictTargetDeviceId&&context.newDeviceId!==workload.strictTargetDeviceId)return attention('STRICT_TARGET_NEW_APPROVAL_REQUIRED');
 if(context.now<context.cooldownUntil)return {action:'WAIT',until:context.cooldownUntil};
 if(['PURE','IDEMPOTENT'].includes(workload.retryClass))return {action:'RETRY',taskId:workload.taskId??null,newAttemptRequired:true};
 if(workload.retryClass==='CHECKPOINTABLE'&&context.checkpointCompatible===true)return {action:'RESTORE',taskId:workload.taskId??null,newAttemptRequired:true};
 return attention('SIDE_EFFECT_OR_COMPATIBILITY_UNKNOWN');
}
