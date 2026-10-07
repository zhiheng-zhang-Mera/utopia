import {randomUUID} from 'node:crypto';import {feasibility} from './placement.mjs';import {requireThat as ok,finite,text,copy,freeze,digest} from './validation.mjs';
const plain=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
export function admit(owner,r){
 const {workload:w,proposal:p,policy,candidate:c,now}=r;ok(p.state==='PROPOSED'&&p.taskId===w.taskId&&p.deviceId===c.deviceId&&p.providerId===c.provider.id&&p.bootId===c.bootId,'PROPOSAL_BINDING');
 ok(now<p.validUntil&&p.policyVersion===policy.version&&p.observationVersion===c.observationVersion,'STALE_PROPOSAL');ok(feasibility(w,c,policy,now)===null,'REVALIDATION_FAILED');
 ok(text(r.idempotencyKey)&&finite(r.ttlMs)&&r.ttlMs>0&&r.ttlMs<=60000,'RESERVATION_INPUT');
 // PCF-704 rev 2: "at least one foreground budget". A caller that declares foreground protection must reserve at
 // least one unit per resource, and a BATCH/BACKGROUND reservation may not spend the reserved part of the app quota -
 // so interactive work always has a slot even when background work is queued behind it. A caller that declares NO
 // reserve keeps the legacy behaviour exactly (PCF-708's rule about callers without the extension). This is a
 // REQUEST-shape check, so it is made before the canonical transaction is opened.
 const reserve=r.foregroundReserve??null;
 if(reserve){ok(plain(reserve),'FOREGROUND_RESERVE_INVALID');for(const [key,amount]of Object.entries(reserve)){ok(Number.isSafeInteger(amount)&&amount>=1,'FOREGROUND_RESERVE_MINIMUM:'+key);ok(finite(r.appQuota?.[key]),'FOREGROUND_RESERVE_UNAUTHORISED:'+key);ok(amount<=r.appQuota[key],'FOREGROUND_RESERVE_EXCEEDS_QUOTA:'+key);}}
 return owner.transaction(r.expectedVersion,(s,{getTask})=>{
  const task=getTask(w.taskId);ok(task&&['QUEUED','RUNNING'].includes(task.state),'CANONICAL_TASK_NOT_EXECUTABLE');for(const key of ['actionId','originDeviceId','parentSessionId'])ok(task[key]===w[key]&&text(w[key]),'CANONICAL_OWNERSHIP_'+key);if(task.pcfAppId!==undefined)ok(task.pcfAppId===w.appId,'CANONICAL_APP_AUTHORITY');if(task.targetDeviceRef)ok(task.targetDeviceRef===c.deviceId,'CANONICAL_STRICT_TARGET');
  const prior=s.reservations.find(x=>x.key===r.idempotencyKey);if(prior){ok(prior.taskId===w.taskId&&prior.deviceId===c.deviceId&&prior.actionId===w.actionId&&prior.originDeviceId===w.originDeviceId&&prior.parentSessionId===w.parentSessionId&&JSON.stringify(prior.resources)===JSON.stringify(w.resources),'IDEMPOTENCY_CONFLICT');return {reservation:copy(prior)};}
  ok(!s.completedKeys.includes(r.idempotencyKey),'IDEMPOTENCY_TERMINAL');
  ok(s.reservations.length<256,'QUEUE_FULL');ok(!s.reservations.some(x=>x.taskId===w.taskId),'TASK_ALREADY_RESERVED');
  // Expired RUNNING reservations remain charged until the holder is fenced/stopped; timeout is not proof of stop.
  const active=s.reservations.filter(x=>x.state==='RUNNING'||x.expiresAt>now);
  const foreground=['INTERACTIVE','SOFT_DEADLINE'].includes(w.qos);
  for(const [key,value]of Object.entries(w.resources)){
   const deviceUsed=active.filter(x=>x.deviceId===c.deviceId).reduce((sum,x)=>sum+(x.resources[key]??0),0);const appUsed=active.filter(x=>x.appId===w.appId).reduce((sum,x)=>sum+(x.resources[key]??0),0);
   const held=foreground?0:(reserve?.[key]??0);
   ok(finite(r.appQuota?.[key])&&appUsed+value<=r.appQuota[key]-held,held>0?'FOREGROUND_RESERVE_HELD:'+key:'APP_QUOTA');ok(deviceUsed+value<=c.free[key],'CAPACITY_RESERVED');
  }
  ok(!active.some(x=>x.writeScope.some(path=>w.writeScope.some(other=>path===other||path.startsWith(other+'/')||other.startsWith(path+'/')))),'WRITE_SCOPE_CONFLICT');
  const reservation={id:randomUUID(),key:r.idempotencyKey,taskId:w.taskId,actionId:w.actionId,originDeviceId:w.originDeviceId,parentSessionId:w.parentSessionId,appId:w.appId,deviceId:c.deviceId,bootId:c.bootId,providerId:c.provider.id,resources:copy(w.resources),writeScope:[...w.writeScope],policyVersion:policy.version,expiresAt:Math.min(now+r.ttlMs,p.validUntil),state:'LEASED'};s.reservations.push(reservation);return {reservation:copy(reservation)};
 });
}
export function release(owner,{reservationId,now}){return owner.transaction(undefined,s=>{const index=s.reservations.findIndex(x=>x.id===reservationId);ok(index>=0,'RESERVATION_UNKNOWN');ok(s.reservations[index].state!=='RUNNING','RUNNING_REQUIRES_STOP_PROOF');s.reservations.splice(index,1);return {released:true};});}
export function claimAttempt(owner,{reservationId,holder,bootId,now}){const result=owner.transaction(undefined,(s,{getTask,putTask})=>{const r=s.reservations.find(x=>x.id===reservationId);ok(r&&r.state==='LEASED'&&now<r.expiresAt&&r.bootId===bootId&&text(holder),'LEASE_INVALID');ok(s.attempts.length<256,'ATTEMPT_LIMIT');const t=getTask(r.taskId);ok(t&&t.state==='QUEUED','TASK_NOT_QUEUED');for(const key of ['actionId','originDeviceId','parentSessionId'])ok(t[key]===r[key],'CANONICAL_OWNERSHIP_CHANGED');r.state='RUNNING';const a={id:randomUUID(),reservationId:r.id,taskId:r.taskId,actionId:r.actionId,originDeviceId:r.originDeviceId,parentSessionId:r.parentSessionId,holder,bootId,epoch:++s.epoch,state:'RUNNING'};s.attempts.push(a);putTask({...t,state:'RUNNING',pcfAttemptId:a.id,pcfEpoch:a.epoch});return {attempt:copy(a)};});return freeze(result.attempt);}
export function commitResult(owner,r){return owner.transaction(undefined,(s,{getTask,putTask})=>{const a=s.attempts.find(x=>x.id===r.attemptId);ok(a&&a.state==='RUNNING'&&a.taskId===r.taskId&&a.epoch===r.epoch&&a.holder===r.holder&&a.bootId===r.bootId,'ATTEMPT_FENCED');ok(['SUCCEEDED','FAILED','CANCELLED','UNKNOWN'].includes(r.outcome),'RESULT_INVALID');if(r.outcome==='SUCCEEDED')ok(digest(r.outputDigest),'DIGEST_REQUIRED');const t=getTask(r.taskId);ok(t?.pcfAttemptId===a.id&&t.pcfEpoch===a.epoch&&t.state==='RUNNING','CANONICAL_ATTEMPT_CHANGED');for(const key of ['actionId','originDeviceId','parentSessionId'])ok(t[key]===a[key],'CANONICAL_OWNERSHIP_CHANGED');
 // An UNKNOWN outcome is STICKY against a TERMINAL claim: the side effect of that attempt is still unverified, so a
 // later report may not overwrite it with success or a cancellation. Without this a late cancel could pretend the
 // external effect was withdrawn and leave two contradicting terminal truths side by side (task.state=CANCELLED next to
 // pcfAttention=SIDE_EFFECT_UNKNOWN). A REPEATED unknown report is not a terminal claim - it is an idempotent re-report
 // and stays allowed. Lifting the unknown needs explicit verification evidence, which is PCF-705's job.
 if(a.pendingOutcome==='UNKNOWN'&&r.outcome!=='UNKNOWN'){ok(r.verification&&text(r.verification.verifiedBy)&&text(r.verification.evidenceRef),'OUTCOME_UNKNOWN_REQUIRES_VERIFICATION');a.pendingOutcome='VERIFIED';a.verification=copy(r.verification);}
 if(r.outcome==='UNKNOWN'){a.pendingOutcome='UNKNOWN';putTask({...t,pcfAttention:'SIDE_EFFECT_UNKNOWN',pcfResult:copy(r)});return {committed:false,attention:'SIDE_EFFECT_UNKNOWN'};}a.state=r.outcome;const reservation=s.reservations.find(x=>x.id===a.reservationId);ok(reservation,'RESERVATION_UNKNOWN');s.completedKeys.push(reservation.key);if(s.completedKeys.length>1024)s.completedKeys.shift();s.reservations=s.reservations.filter(x=>x.id!==a.reservationId);putTask({...t,state:r.outcome==='SUCCEEDED'?'COMPLETED':r.outcome,progress:r.outcome==='SUCCEEDED'?100:t.progress,result:r.outcome==='SUCCEEDED'?{kind:'PCF_RESULT',digest:r.outputDigest,artifactId:r.outputRef?.id??null,summary:'Result available to the originating session.'}:null,error:r.outcome==='SUCCEEDED'?null:(r.reason??r.outcome),pcfResult:copy(r)});const live=s.attempts.filter(x=>x.state==='RUNNING'),terminal=s.attempts.filter(x=>x.state!=='RUNNING').slice(-Math.max(0,128-live.length));s.attempts=[...terminal,...live];return {committed:true};});}

export function recordOwnedProcess(owner,{taskId,attemptId,epoch,holder,bootId,processIdentity}){
 ok(Number.isInteger(processIdentity?.pid)&&processIdentity.pid>0&&text(processIdentity.host)&&finite(processIdentity.startedAt),'PROCESS_IDENTITY');
 return owner.transaction(undefined,(s,{getTask,putTask})=>{const a=s.attempts.find(x=>x.id===attemptId);const t=getTask(taskId);ok(a?.state==='RUNNING'&&a.taskId===taskId&&a.epoch===epoch&&a.holder===holder&&a.bootId===bootId&&t?.pcfAttemptId===attemptId&&t.pcfEpoch===epoch&&t.state==='RUNNING','ATTEMPT_FENCED');ok(!a.processIdentity,'PROCESS_ALREADY_BOUND');a.processIdentity=copy(processIdentity);putTask({...t,pcfProcessIdentity:copy(processIdentity)});return {recorded:true};});
}

/**
 * PCF-703 stage progress: finish ONE stage of a multi-stage plan without terminating the canonical task.
 *
 * The canonical contract has exactly one terminal outcome per task, so a pipeline cannot commit SUCCEEDED after its
 * first stage - that would publish the task as COMPLETED while stages were still pending. This primitive keeps ONE task
 * truth instead: the attempt becomes STAGED (it really ran and really finished), the reservation is released so the
 * next stage can be admitted, and the task returns to QUEUED with the completed stage recorded. The task's identity
 * (id/actionId/originDeviceId/parentSessionId) is never touched, so canonical ownership is unchanged by the stages.
 */
export function commitStageResult(owner,{taskId,attemptId,epoch,holder,bootId,stageId,outputDigest,now}={}){
 ok(text(stageId),'STAGE_ID_REQUIRED');ok(digest(outputDigest),'DIGEST_REQUIRED');
 return owner.transaction(undefined,(s,{getTask,putTask})=>{
  const a=s.attempts.find(x=>x.id===attemptId);
  ok(a&&a.state==='RUNNING'&&a.taskId===taskId&&a.epoch===epoch&&a.holder===holder&&a.bootId===bootId,'ATTEMPT_FENCED');
  const t=getTask(taskId);ok(t?.pcfAttemptId===attemptId&&t.pcfEpoch===epoch&&t.state==='RUNNING','CANONICAL_ATTEMPT_CHANGED');
  for(const key of ['actionId','originDeviceId','parentSessionId'])ok(t[key]===a[key],'CANONICAL_OWNERSHIP_CHANGED');
  a.state='STAGED';
  const reservation=s.reservations.find(x=>x.id===a.reservationId);ok(reservation,'RESERVATION_UNKNOWN');
  s.completedKeys.push(reservation.key);if(s.completedKeys.length>1024)s.completedKeys.shift();
  s.reservations=s.reservations.filter(x=>x.id!==a.reservationId);
  const stages=[...(t.pcfStages??[]),{stageId,attemptId,epoch,outputDigest,completedAt:finite(now)?now:null}];
  putTask({...t,state:'QUEUED',pcfAttemptId:null,pcfEpoch:null,pcfStages:stages,progress:null});
  return {committed:true,stage:{stageId,attemptId,epoch,outputDigest},stages:stages.length};
 });
}
