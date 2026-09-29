import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {registry} from './registry.mjs';
import {createInvocationStore} from './invocation-store.mjs';
import {canonical,digest,objectInput,refuse} from '../../contracts/capability-bridge-v1/protocol.mjs';

export function createBridge(store,emit,{execute}={}){
 const history=createInvocationStore(store);
 const workers=new Set(),degraded=new Set();let closed=false;
 const descriptors=()=>registry().map(c=>degraded.has(c.capabilityId)?{...c,bridgeState:'DEGRADED'}:c);
 const save=row=>history.save(row);
 for(const row of store.list('invocations'))if(row.status==='RUNNING'){
  save({...row,status:'INTERRUPTED',finishedAt:new Date().toISOString(),errorCode:'GATEWAY_RESTARTED'});
  emit('CAPABILITY_FAILED',null,{invocationId:row.invocationId,errorCode:'GATEWAY_RESTARTED'});
 }
 return {registry:descriptors,list:history.list,get:history.get,
 async invoke(capabilityId,request){
  objectInput(request);const descriptor=descriptors().find(c=>c.capabilityId===capabilityId);if(!descriptor)refuse('CAPABILITY_NOT_FOUND',404);
  if(descriptor.bridgeState!=='AVAILABLE')refuse('BRIDGE_PENDING',409);
  if(!descriptor.operations.some(o=>o.operationId===request.operationId))refuse('OPERATION_BLOCKED');
  objectInput(request.input);if(workers.size>=2)refuse('BUSY',429);
  const invocationId='I-'+randomUUID(),startedAt=new Date().toISOString();
  let row={invocationId,capabilityId,operationId:request.operationId,inputBytes:Buffer.byteLength(JSON.stringify(request.input)),inputClass:descriptor.inputKind??request.operationId,startedAt,finishedAt:null,status:'RUNNING',resultDigest:null,errorCode:null,result:null};
  save(row);emit('CAPABILITY_INVOKED',null,{invocationId,capabilityId,operationId:row.operationId});
  const outcome=execute?await execute({capabilityId,operationId:request.operationId,input:request.input}):await new Promise(resolve=>{
   const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{capabilityId,operationId:request.operationId,input:request.input},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:128}});workers.add(worker);
   let settled=false;const done=value=>{if(settled)return;settled=true;clearTimeout(timer);workers.delete(worker);worker.terminate();resolve(value);};
   const timer=setTimeout(()=>done({errorCode:'EXECUTION_TIMEOUT'}),20000);
   worker.stdout.resume();worker.stderr.resume();
   worker.once('message',done);worker.once('error',()=>done({errorCode:'ADAPTER_UNAVAILABLE'}));worker.once('exit',code=>{if(!settled)done({errorCode:closed?'GATEWAY_RESTARTED':'ADAPTER_UNAVAILABLE'});});
  });
  if(closed)return row;
  if(outcome.result&&Buffer.byteLength(JSON.stringify(outcome.result))>3*1024*1024){outcome.errorCode='RESULT_TOO_LARGE';delete outcome.result;}
  row={...row,finishedAt:new Date().toISOString(),status:outcome.errorCode?'FAILED':'COMPLETED',errorCode:outcome.errorCode??null,result:outcome.errorCode?null:canonical(outcome.result),resultDigest:outcome.errorCode?null:digest(outcome.result)};
  if(['ENGINE_UNAVAILABLE','ADAPTER_UNAVAILABLE'].includes(row.errorCode))degraded.add(capabilityId);
  save(row);emit(outcome.errorCode?'CAPABILITY_FAILED':'CAPABILITY_COMPLETED',null,{invocationId,capabilityId,status:row.status,resultDigest:row.resultDigest,errorCode:row.errorCode});return history.get(invocationId);
 },close(){closed=true;for(const w of workers)w.terminate();}};
}
