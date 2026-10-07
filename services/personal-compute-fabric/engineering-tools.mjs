import {requireThat as ok,copy} from './validation.mjs';
/** Versioned caller facade; authorization, canonical ownership and terminals belong to service. */
export function createEngineeringTools(service,{sessionId,deviceId,authorize}={}){
 for(const name of ['submit','inspect','cancel','collect','acknowledge'])ok(typeof service?.[name]==='function','CANONICAL_METHOD_'+name);
 ok(typeof sessionId==='string'&&sessionId.length>0&&typeof deviceId==='string'&&deviceId.length>0&&typeof authorize==='function','CALLER_CONFIGURATION');
 const context=Object.freeze({sessionId,deviceId});
 async function invoke(name,args){ok(await authorize(context),'ORIGIN_UNAUTHORIZED');return copy(await service[name](...args));}
 return Object.freeze({version:1,
  async submitRemoteJob(capsule){ok(capsule?.parentSessionId===sessionId,'CALLER_BINDING');return invoke('submit',[copy(capsule),context]);},
  inspectRemoteJob:(ref,cursor)=>invoke('inspect',[ref,context,cursor]),
  cancelRemoteJob:ref=>invoke('cancel',[ref,context]),
  collectRemoteResult:ref=>invoke('collect',[ref,context]),
  acknowledgeRemoteResult:(ref,digest)=>invoke('acknowledge',[ref,context,digest]),
 });
}
