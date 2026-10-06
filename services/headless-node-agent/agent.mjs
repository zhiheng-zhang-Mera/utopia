import {nodeDescriptor} from '../../contracts/node-descriptor-v1/index.mjs';

export const HEADLESS_AGENT_PROTOCOL_VERSION=1;
export class HeadlessAgentError extends Error {constructor(code){super(code);this.code=code;this.name='HeadlessAgentError';}}
/** No timer/discovery, task persistence or credential value. request reuses an existing authenticated transport. */
export function createHeadlessAgent({protocolVersion=1,identity,roles=['EXECUTION_NODE'],capabilities=[],resources={},credentialHandle,controlHandle=null,request,timeoutMs=5000}={}) {
 if(protocolVersion!==1)throw new HeadlessAgentError('INCOMPATIBLE_PROTOCOL');
 if(!identity||!/^[-a-zA-Z0-9]{1,80}$/.test(identity.id??'')||typeof identity.displayName!=='string'||!identity.displayName.trim()||identity.displayName.length>100||typeof credentialHandle!=='string'||!credentialHandle||credentialHandle.length>256||typeof request!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw new HeadlessAgentError('INVALID_AGENT_CONFIGURATION');
 const descriptor=nodeDescriptor({nodeId:identity.id,displayName:identity.displayName,roles,capabilities,resources,roleSource:'DECLARED'});
 if(!descriptor.isExecutionResource)throw new HeadlessAgentError('EXECUTION_ROLE_REQUIRED');
 const registration={id:identity.id,displayName:identity.displayName,roles:[...descriptor.roles],capabilities:[...descriptor.capabilities],agentVersion:'headless-v1',metadata:{platform:identity.platform??'unknown'}};
 if(Object.keys(resources).length)registration.telemetry={observedAt:resources.observedAt??new Date().toISOString(),uptimeSeconds:null,cpuCores:resources.cpu?.cores??null,cpu:{usagePercent:resources.cpu?.loadPercent??null},memory:resources.memory?{totalBytes:resources.memory.totalBytes??null,usedBytes:resources.memory.usedBytes??null,freeBytes:resources.memory.freeBytes??null}:null,disk:resources.disk?{totalBytes:resources.disk.totalBytes??null,usedBytes:resources.disk.usedBytes??null,freeBytes:resources.disk.freeBytes??null}:null};
 let registered=false,draining=false,restoreSharing=false,stopped=false,pending=false,controlPending=false,epoch=0,held=null,executionAbort=null;
 async function call(path,body,handle=credentialHandle){
  const controller=new AbortController();let timer;
  try{return await Promise.race([Promise.resolve().then(()=>request(path,body,{credentialHandle:handle,signal:controller.signal,protocolVersion:1})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new HeadlessAgentError('TRANSPORT_TIMEOUT'));},timeoutMs);})]);}
  finally{clearTimeout(timer);}
 }
 function active(){if(stopped||!registered)throw new HeadlessAgentError(stopped?'AGENT_STOPPED':'AGENT_NOT_REGISTERED');}
 async function report(task,state,progress,extra={}){return call('node/report',{id:identity.id,taskId:task.id,state,progress,...extra});}
 const api={
  protocolVersion:1,
  status:()=>({registered,draining,stopped,pending,controlPending,heldTaskId:held?.id??null,descriptor}),
  async register(){
   if(pending||held||controlPending)throw new HeadlessAgentError('AGENT_BUSY');
   const ticket=++epoch;registered=false;stopped=false;pending=true;
   try{const result=await call('node/register',registration);if(ticket!==epoch)throw new HeadlessAgentError('STALE_AGENT_OPERATION');registered=true;return result;}
   finally{if(ticket===epoch)pending=false;}
  },
  async heartbeat({telemetry}={}){active();await call('node/heartbeat',{id:identity.id,...(telemetry===undefined?{}:{telemetry})});return call('node/descriptor',{id:identity.id});},
  async runOne(execute){
   active();if(draining||pending||controlPending)return null;if(typeof execute!=='function')throw new HeadlessAgentError('INVALID_EXECUTOR');
   const ticket=epoch;pending=true;let task;
   const current=()=>ticket===epoch&&!stopped;
   try{
    const claim=await call('node/claim',{id:identity.id});if(!current())return null;
    task=claim.task;if(!task)return null;held=task;
    const started=await report(task,'RUNNING',task.progress??0);if(!current()||started.state!=='RUNNING')return started;
    let last=started.progress??0;held=started;executionAbort=new AbortController();
    const result=await execute(Object.freeze({...started}),{
     cancelled:()=>!current(),
     signal:executionAbort.signal,
     progress:async value=>{if(!current())throw new HeadlessAgentError('STALE_AGENT_OPERATION');if(!Number.isFinite(value)||value<last||value>100)throw new HeadlessAgentError('INVALID_PROGRESS');const updated=await report(task,'RUNNING',value);if(!current())throw new HeadlessAgentError('STALE_AGENT_OPERATION');held=updated;last=value;if(updated.state!=='RUNNING')throw new HeadlessAgentError('CANONICAL_TASK_TERMINAL');return updated;}
    });
    if(!current())return null;
    return await report(task,'COMPLETED',100,{result});
   }catch(error){
    if(task&&current())return await report(task,'FAILED',held?.progress??task.progress??0,{error:'Headless executor or transport failed; execution is not replayed.'});
    if(current())throw error;return null;
   }finally{if(ticket===epoch){held=null;pending=false;executionAbort=null;}}
  },
  async cancel(){
   active();if(controlPending||pending&&!held)throw new HeadlessAgentError('AGENT_BUSY');if(!held)return null;if(typeof controlHandle!=='string'||!controlHandle)throw new HeadlessAgentError('CONTROL_HANDLE_REQUIRED');
   const task=held,ticket=epoch;controlPending=true;
   try{const result=await call('tasks/'+encodeURIComponent(task.id)+'/cancel',{},controlHandle);if(ticket===epoch&&held?.id===task.id){++epoch;executionAbort?.abort();executionAbort=null;held=null;pending=false;}return result;}
   finally{controlPending=false;}
  },
  async drain(){
   active();if(controlPending)throw new HeadlessAgentError('AGENT_BUSY');if(typeof controlHandle!=='string'||!controlHandle)throw new HeadlessAgentError('CONTROL_HANDLE_REQUIRED');
   const ticket=epoch;draining=true;controlPending=true;
   try{const info=await call('node/descriptor',{id:identity.id});if(ticket!==epoch)throw new HeadlessAgentError('STALE_AGENT_OPERATION');const enabled=info.descriptor?.availability?.sharingEnabled;if(typeof enabled!=='boolean')throw new HeadlessAgentError('SHARING_STATE_UNKNOWN');if(enabled)await call('node/sharing',{id:identity.id,enabled:false},controlHandle);if(ticket!==epoch)throw new HeadlessAgentError('STALE_AGENT_OPERATION');restoreSharing=restoreSharing||enabled;return{draining:true,heldTaskId:held?.id??null};}
   finally{controlPending=false;}
  },
  async resume(){active();if(controlPending)throw new HeadlessAgentError('AGENT_BUSY');const ticket=epoch;controlPending=true;try{if(restoreSharing)await call('node/sharing',{id:identity.id,enabled:true},controlHandle);if(ticket!==epoch)throw new HeadlessAgentError('STALE_AGENT_OPERATION');restoreSharing=false;draining=false;}finally{controlPending=false;}},
  async stop(){if(stopped)return;if(controlPending||pending&&!held)throw new HeadlessAgentError('AGENT_BUSY');await api.drain();const result=held?await api.cancel():null;++epoch;executionAbort?.abort();executionAbort=null;stopped=true;registered=false;pending=false;held=null;return result;},
  // Simulated/process crash fences callbacks only. Restart registration makes interruption FAILED canonically.
  abandon(){++epoch;executionAbort?.abort();executionAbort=null;stopped=true;registered=false;pending=false;held=null;}
 };
 return Object.freeze(api);
}
