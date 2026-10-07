import {requireThat as ok} from './validation.mjs';
export function reconcileExecution(snapshot,observations,now){
 ok(snapshot.reservations.length<=256&&snapshot.attempts.length<=256&&observations.length<=256,'RECONCILE_LIMIT');const actions=[];
 for(const r of snapshot.reservations){const attempt=snapshot.attempts.find(a=>a.taskId===r.taskId&&a.state==='RUNNING');if(attempt){const live=observations.find(o=>o.holder===attempt.holder&&o.bootId===attempt.bootId);if(live?.alive!==true)actions.push({action:'ATTENTION_UNKNOWN_WORKER',taskId:r.taskId,attemptId:attempt.id});continue;}if(r.state==='LEASED')actions.push({action:r.expiresAt>now?'START_APPROVED_ATTEMPT':'RELEASE_EXPIRED_LEASE',taskId:r.taskId,reservationId:r.id});}
 return actions;
}
export function startSupervision({snapshot,observations,reconcile,intervalMs=1000,signal}){
 ok(typeof snapshot==='function'&&typeof observations==='function'&&typeof reconcile==='function'&&intervalMs>=250&&intervalMs<=60000,'SUPERVISOR_CONFIG');let stopped=false,timer=null,running=false;
 async function tick(){if(stopped||signal?.aborted||running)return;running=true;try{await reconcile(reconcileExecution(await snapshot(),await observations(),Date.now()));}finally{running=false;if(!stopped&&!signal?.aborted)timer=setTimeout(()=>tick().catch(()=>stop()),intervalMs);}}
 function stop(){stopped=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);}signal?.addEventListener('abort',stop,{once:true});tick().catch(()=>stop());return {stop,wake:()=>tick()};
}
