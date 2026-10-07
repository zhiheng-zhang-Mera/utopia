import {requireThat as ok,copy} from './validation.mjs';
export function createOriginAgentBridge(canonical,{authorize}){
 for(const key of ['submit','get','cancel','markConsumed'])ok(typeof canonical[key]==='function','CANONICAL_METHOD_'+key);ok(typeof authorize==='function','ORIGIN_AUTHORITY_REQUIRED');
 async function access(id,context){ok(await authorize(context),'ORIGIN_UNAUTHORIZED');const task=await canonical.get(id);ok(task&&task.parentSessionId===context.sessionId&&task.originDeviceId===context.deviceId,'SESSION_BINDING');return task;}
 return {
  async submitRemoteJob(spec,context){ok(await authorize(context),'ORIGIN_UNAUTHORIZED');ok(spec.parentSessionId===context.sessionId&&spec.originDeviceId===context.deviceId,'SESSION_BINDING');return canonical.submit(copy(spec),context);},
  async inspect(id,context){return copy(await access(id,context));},
  async cancel(id,context){await access(id,context);return canonical.cancel(id,context);},
  async collect(id,context){const task=await access(id,context);ok(task.state==='SUCCEEDED'&&task.pcfResult,'RESULT_NOT_READY');return {taskId:task.id,result:copy(task.pcfResult),delivered:true,consumed:task.pcfConsumedSessionId===context.sessionId};},
  async acknowledge(id,context,digest){const task=await access(id,context);ok(task.state==='SUCCEEDED'&&task.pcfResult?.digest===digest,'CONSUMPTION_DIGEST');return canonical.markConsumed(id,context,digest);},
 };
}
