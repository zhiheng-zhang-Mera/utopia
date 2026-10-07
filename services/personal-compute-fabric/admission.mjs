import {randomUUID} from 'node:crypto';import {feasibility} from './placement.mjs';import {requireThat as ok,finite,text,copy,freeze,digest} from './validation.mjs';
export function admit(owner,r){
 const {workload:w,proposal:p,policy,candidate:c,now}=r;ok(p.state==='PROPOSED'&&p.taskId===w.taskId&&p.deviceId===c.deviceId&&p.providerId===c.provider.id&&p.bootId===c.bootId,'PROPOSAL_BINDING');
 ok(now<p.validUntil&&p.policyVersion===policy.version&&p.observationVersion===c.observationVersion,'STALE_PROPOSAL');ok(feasibility(w,c,policy,now)===null,'REVALIDATION_FAILED');
 ok(text(r.idempotencyKey)&&finite(r.ttlMs)&&r.ttlMs>0&&r.ttlMs<=60000,'RESERVATION_INPUT');
 return owner.transaction(r.expectedVersion,(s,{getTask})=>{
  const prior=s.reservations.find(x=>x.key===r.idempotencyKey);if(prior){ok(prior.taskId===w.taskId&&prior.deviceId===c.deviceId&&JSON.stringify(prior.resources)===JSON.stringify(w.resources),'IDEMPOTENCY_CONFLICT');return {reservation:copy(prior)};}
  ok(!s.completedKeys.includes(r.idempotencyKey),'IDEMPOTENCY_TERMINAL');const task=getTask(w.taskId);ok(task&&['QUEUED','RUNNING'].includes(task.state),'CANONICAL_TASK_NOT_EXECUTABLE');
  ok(s.reservations.length<256,'QUEUE_FULL');ok(!s.reservations.some(x=>x.taskId===w.taskId),'TASK_ALREADY_RESERVED');
  // Expired RUNNING reservations remain charged until the holder is fenced/stopped; timeout is not proof of stop.
  const active=s.reservations.filter(x=>x.state==='RUNNING'||x.expiresAt>now);
  for(const [key,value]of Object.entries(w.resources)){
   const deviceUsed=active.filter(x=>x.deviceId===c.deviceId).reduce((sum,x)=>sum+(x.resources[key]??0),0);const appUsed=active.filter(x=>x.appId===w.appId).reduce((sum,x)=>sum+(x.resources[key]??0),0);
   ok(finite(r.appQuota?.[key])&&appUsed+value<=r.appQuota[key],'APP_QUOTA');ok(deviceUsed+value<=c.free[key],'CAPACITY_RESERVED');
  }
  ok(!active.some(x=>x.writeScope.some(path=>w.writeScope.some(other=>path===other||path.startsWith(other+'/')||other.startsWith(path+'/')))),'WRITE_SCOPE_CONFLICT');
  const reservation={id:randomUUID(),key:r.idempotencyKey,taskId:w.taskId,appId:w.appId,deviceId:c.deviceId,bootId:c.bootId,providerId:c.provider.id,resources:copy(w.resources),writeScope:[...w.writeScope],policyVersion:policy.version,expiresAt:Math.min(now+r.ttlMs,p.validUntil),state:'LEASED'};s.reservations.push(reservation);return {reservation:copy(reservation)};
 });
}
export function release(owner,{reservationId,now}){return owner.transaction(undefined,s=>{const index=s.reservations.findIndex(x=>x.id===reservationId);ok(index>=0,'RESERVATION_UNKNOWN');ok(s.reservations[index].state!=='RUNNING','RUNNING_REQUIRES_STOP_PROOF');s.reservations.splice(index,1);return {released:true};});}
export function claimAttempt(owner,{reservationId,holder,bootId,now}){const result=owner.transaction(undefined,(s,{getTask,putTask})=>{const r=s.reservations.find(x=>x.id===reservationId);ok(r&&r.state==='LEASED'&&now<r.expiresAt&&r.bootId===bootId&&text(holder),'LEASE_INVALID');ok(s.attempts.length<256,'ATTEMPT_LIMIT');const t=getTask(r.taskId);ok(t&&t.state==='QUEUED','TASK_NOT_QUEUED');r.state='RUNNING';const a={id:randomUUID(),reservationId:r.id,taskId:r.taskId,holder,bootId,epoch:++s.epoch,state:'RUNNING'};s.attempts.push(a);putTask({...t,state:'RUNNING',pcfAttemptId:a.id,pcfEpoch:a.epoch});return {attempt:copy(a)};});return freeze(result.attempt);}
export function commitResult(owner,r){return owner.transaction(undefined,(s,{getTask,putTask})=>{const a=s.attempts.find(x=>x.id===r.attemptId);ok(a&&a.state==='RUNNING'&&a.taskId===r.taskId&&a.epoch===r.epoch&&a.holder===r.holder&&a.bootId===r.bootId,'ATTEMPT_FENCED');ok(['SUCCEEDED','FAILED','CANCELLED','UNKNOWN'].includes(r.outcome),'RESULT_INVALID');if(r.outcome==='SUCCEEDED')ok(digest(r.outputDigest),'DIGEST_REQUIRED');const t=getTask(r.taskId);ok(t?.pcfAttemptId===a.id&&t.pcfEpoch===a.epoch&&t.state==='RUNNING','CANONICAL_ATTEMPT_CHANGED');a.state=r.outcome;const reservation=s.reservations.find(x=>x.id===a.reservationId);ok(reservation,'RESERVATION_UNKNOWN');s.completedKeys.push(reservation.key);if(s.completedKeys.length>1024)s.completedKeys.shift();s.reservations=s.reservations.filter(x=>x.id!==a.reservationId);putTask({...t,state:r.outcome,pcfResult:copy(r)});return {committed:true};});}
