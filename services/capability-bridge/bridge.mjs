import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {registry} from './registry.mjs';
import {createInvocationStore} from './invocation-store.mjs';
import {createThemeArtifacts} from './theme-artifacts.mjs';
import {canonical,digest,objectInput,refuse} from '../../contracts/capability-bridge-v1/protocol.mjs';
// City Core (MB-003). The per-capability degradation latch is owned by the migrated
// provider-resilience breaker instead of an ad-hoc Set. Utopia's policy travels as data:
// failureThreshold 1 opens the breaker on the first provider-technical failure, and the
// cooldown is the donor's maximum, so nothing closes it again inside a gateway process
// lifetime — which is exactly the permanent latch this replaced.
import {createCircuitBreaker} from '../../city/02-engineering/02-worker-gateway/provider-resilience/index.mjs';
const PROVIDER_TECHNICAL_ERROR_CODES=['ENGINE_UNAVAILABLE','ADAPTER_UNAVAILABLE'];
const CIRCUIT_COOLDOWN_MS=604800000;

export function createBridge(store,emit,{execute,artifactRoot}={}){
 const history=createInvocationStore(store);
 const workers=new Set();let closed=false;
 // The Core breaker owns the degradation decision. Nothing ever observes a success for a
 // degraded capability, because a degraded capability is refused before dispatch, so the
 // breaker stays open for the lifetime of the process — the same permanent latch the
 // ad-hoc Set provided, now decided by the migrated state machine.
 const circuit=createCircuitBreaker({options:{failureThreshold:1,cooldownMs:CIRCUIT_COOLDOWN_MS,now:Date.now}});
 const degraded=capabilityId=>circuit.state(capabilityId)!=='CLOSED';
 const descriptors=()=>registry().map(c=>degraded(c.capabilityId)?{...c,bridgeState:'DEGRADED'}:c);
 const save=row=>history.save(row);
 for(const row of store.list('invocations'))if(row.status==='RUNNING'){
  save({...row,status:'INTERRUPTED',finishedAt:new Date().toISOString(),errorCode:'GATEWAY_RESTARTED'});
  emit('CAPABILITY_FAILED',null,{invocationId:row.invocationId,errorCode:'GATEWAY_RESTARTED'});
 }
 const artifacts=artifactRoot?createThemeArtifacts(artifactRoot):null;
 // The theme-artifact store is created during City construction. When its root cannot be prepared the store
 // reports UNAVAILABLE and every theme-lab build fails typed instead of the City refusing to start; this accessor
 // is how that state reaches health and the capability surface. `NOT_CONFIGURED` means no artifact root was wired
 // at all, which is a deployment choice, not a fault - hence its own word rather than a fake READY.
 const artifactStore=()=>({state:artifacts?artifacts.state():'NOT_CONFIGURED',reason:artifacts?artifacts.reason():null});
 return {registry:descriptors,list:history.list,get:history.get,artifactStore,
 async invoke(capabilityId,request){
  objectInput(request);const descriptor=descriptors().find(c=>c.capabilityId===capabilityId);if(!descriptor)refuse('CAPABILITY_NOT_FOUND',404);
  if(descriptor.bridgeState!=='AVAILABLE')refuse('BRIDGE_PENDING',409);
  if(!descriptor.operations.some(o=>o.operationId===request.operationId))refuse('OPERATION_BLOCKED');
  objectInput(request.input);if(workers.size>=2)refuse('BUSY',429);
  const invocationId='I-'+randomUUID(),startedAt=new Date().toISOString();
  let row={invocationId,capabilityId,operationId:request.operationId,inputBytes:Buffer.byteLength(JSON.stringify(request.input)),inputClass:descriptor.inputKind??request.operationId,startedAt,finishedAt:null,status:'RUNNING',resultDigest:null,errorCode:null,result:null};
  save(row);emit('CAPABILITY_INVOKED',null,{invocationId,capabilityId,operationId:row.operationId});
  let themeSandbox,outcome;
  try{if(capabilityId==='presentation.theme.lab'&&request.operationId==='build'){if(!artifacts)throw Error('BUILD_STORAGE_UNAVAILABLE');themeSandbox=artifacts.allocate(invocationId);}}
  catch{outcome={errorCode:'BUILD_STORAGE_UNAVAILABLE'};}
  try{outcome??=execute?await execute({capabilityId,operationId:request.operationId,input:request.input}):await new Promise(resolve=>{
   const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{capabilityId,operationId:request.operationId,input:request.input,context:{themeSandbox}},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:128}});workers.add(worker);
   let settled=false;const done=async value=>{if(settled)return;settled=true;clearTimeout(timer);await worker.terminate();workers.delete(worker);resolve(value);};
   const timer=setTimeout(()=>done({errorCode:'EXECUTION_TIMEOUT'}),20000);
   worker.stdout.resume();worker.stderr.resume();
   worker.once('message',done);worker.once('error',()=>done({errorCode:'ADAPTER_UNAVAILABLE'}));worker.once('exit',code=>{if(!settled)done({errorCode:closed?'GATEWAY_RESTARTED':'ADAPTER_UNAVAILABLE'});});
  });}catch{outcome={errorCode:'ADAPTER_UNAVAILABLE'};}
  if(closed){if(themeSandbox)try{artifacts.finish(invocationId,false);}catch{}return row;}
  if(outcome.result&&Buffer.byteLength(JSON.stringify(outcome.result))>3*1024*1024){outcome.errorCode='RESULT_TOO_LARGE';delete outcome.result;}
  if(themeSandbox)try{artifacts.finish(invocationId,!outcome.errorCode);}catch{outcome={errorCode:'BUILD_STORAGE_UNAVAILABLE'};}
  row={...row,finishedAt:new Date().toISOString(),status:outcome.errorCode?'FAILED':'COMPLETED',errorCode:outcome.errorCode??null,result:outcome.errorCode?null:canonical(outcome.result),resultDigest:outcome.errorCode?null:digest(outcome.result)};
  if(PROVIDER_TECHNICAL_ERROR_CODES.includes(row.errorCode))circuit.observeFailure(capabilityId);
  save(row);emit(outcome.errorCode?'CAPABILITY_FAILED':'CAPABILITY_COMPLETED',null,{invocationId,capabilityId,status:row.status,resultDigest:row.resultDigest,errorCode:row.errorCode});return history.get(invocationId);
 },close(){closed=true;for(const w of workers)w.terminate();}};
}
