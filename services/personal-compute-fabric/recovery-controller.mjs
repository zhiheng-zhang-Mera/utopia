import {requireThat as ok,copy} from './validation.mjs';
// A timeout is never stop proof. The injected controller must own the exact process identity.
export async function recoverStoppedAttempt({owner,taskId,attemptId,epoch,proveStopped,authorize}){
 ok(typeof proveStopped==='function'&&typeof authorize==='function','RECOVERY_CONFIGURATION');
 const initial=owner.snapshot(),attempt=initial.attempts.find(a=>a.id===attemptId);
 ok(attempt?.taskId===taskId&&attempt.epoch===epoch&&attempt.state==='RUNNING'&&!attempt.pendingOutcome,'RECOVERY_ATTEMPT');
 ok(attempt.processIdentity,'RECOVERY_PROCESS_UNKNOWN');
 const authorized=await authorize(copy(attempt));ok(authorized===true,'RECOVERY_UNAUTHORIZED');
 const proof=await proveStopped(copy(attempt));ok(proof?.stopped===true&&proof.attemptId===attemptId&&proof.epoch===epoch&&proof.pid===attempt.processIdentity.pid&&proof.startedAt===attempt.processIdentity.startedAt&&proof.bootId===attempt.bootId,'EXECUTION_STOP_NOT_PROVEN');
 ok(await authorize(copy(attempt))===true,'RECOVERY_UNAUTHORIZED');
 return owner.transaction(undefined,(s,{getTask,putTask})=>{
  const a=s.attempts.find(x=>x.id===attemptId),t=getTask(taskId);ok(a?.state==='RUNNING'&&!a.pendingOutcome&&a.epoch===epoch&&t?.pcfAttemptId===attemptId&&t.pcfEpoch===epoch&&t.state==='RUNNING','ATTEMPT_FENCED');
  ok(t.pcfWorkload?.retryClass==='PURE','RECOVERY_RETRY_UNSAFE');ok(t.pcfWorkload.deadlineAt>Date.now(),'RECOVERY_DEADLINE');
  a.state='FAILED';a.stopProof=copy(proof);const reservation=s.reservations.find(x=>x.id===a.reservationId);ok(reservation,'RESERVATION_UNKNOWN');s.completedKeys.push(reservation.key);s.completedKeys=s.completedKeys.slice(-1024);s.reservations=s.reservations.filter(x=>x.id!==a.reservationId);
  putTask({...t,state:'QUEUED',pcfAttemptId:null,pcfEpoch:null,pcfProcessIdentity:null,pcfAttention:null,pcfGeneration:(t.pcfGeneration??0)+1,pcfRecovery:{sourceAttemptId:attemptId,reason:'OWNED_STOP_PROVEN',at:Date.now()}});return {requeued:true,taskId};
 });
}
