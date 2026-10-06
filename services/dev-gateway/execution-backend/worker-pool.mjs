import {ExecutionBackendError,describeReadiness} from '../../../contracts/execution-backend-v1/index.mjs';
import {assertNodeDescriptor,isExecutionEndpoint} from '../../../contracts/node-descriptor-v1/index.mjs';

/** Explicit narrowing adapter; never owns tasks, credentials, discovery or a timer. */
export function createWorkerPoolBackend({enabled=false,canonical=null,memberRefs=[],descriptors=()=>[],taskFor=null}={}) {
 if(typeof enabled!=='boolean'||!Array.isArray(memberRefs)||memberRefs.some(x=>typeof x!=='string'||!x)||typeof descriptors!=='function')throw new ExecutionBackendError('INVALID_BACKEND','Invalid pool configuration');
 const members=new Set(memberRefs);
 const bound=()=>canonical&&['endpoints','dispatch','claim','report','control'].every(m=>typeof canonical[m]==='function');
 function endpoints(){
  if(!enabled||!bound())return[];
  const facts=descriptors();if(!Array.isArray(facts))throw new ExecutionBackendError('INVALID_BACKEND','Descriptor array required');
  const seen=new Set();for(const d of facts){assertNodeDescriptor(d);if(seen.has(d.nodeId))throw new ExecutionBackendError('INVALID_BACKEND','Duplicate descriptor identity');seen.add(d.nodeId);}
  return canonical.endpoints().filter(e=>members.has(e.endpointRef)).map(e=>{
   const d=facts.find(x=>x.nodeId===e.endpointRef);
   const eligible=d&&isExecutionEndpoint(d)&&d.availability.acceptingWork===true;
   return {...e,kind:'POOL_NODE',ready:e.ready===true&&eligible===true,readinessReason:e.ready!==true?e.readinessReason:eligible===true?null:'POOL_DESCRIPTOR_NOT_READY'};
  });
 }
 function readiness(){
  if(!enabled||!bound())return describeReadiness({state:'ABSENT',reason:enabled?'POOL_ADAPTER_ABSENT':'POOL_DORMANT',endpointCount:0,readyEndpointCount:0});
  try{const rows=endpoints(),ready=rows.filter(x=>x.ready).length;return describeReadiness({state:ready?'READY':rows.length?'UNAVAILABLE':'ABSENT',reason:ready?null:rows.length?'POOL_ENDPOINTS_NOT_READY':'POOL_ENDPOINTS_ABSENT',endpointCount:rows.length,readyEndpointCount:ready});}
  catch{return describeReadiness({state:'UNKNOWN',reason:'POOL_DESCRIPTOR_INVALID',endpointCount:0,readyEndpointCount:0});}
 }
 function guard(ref,accepting){
  if(!enabled)throw new ExecutionBackendError('BACKEND_DORMANT','Worker Pool is explicitly dormant');
  if(!bound())throw new ExecutionBackendError('BACKEND_UNAVAILABLE','Canonical adapter absent');
  if(!members.has(ref))throw new ExecutionBackendError('UNKNOWN_ENDPOINT','Endpoint is not an explicitly configured pool member');
  if(accepting){const row=endpoints().find(x=>x.endpointRef===ref);if(!row||!row.ready)throw new ExecutionBackendError('ENDPOINT_NOT_READY','Pool member not ready');}
 }
 return Object.freeze({contractVersion:1,backendId:'worker-pool',profile:'WORKER_POOL',kind:'WORKER_POOL',mode:enabled?'enabled':'dormant',readiness,endpoints,
  dispatch(args={}){guard(args.endpointRef,true);return canonical.dispatch(args);},
  claim(args={}){guard(args.endpointRef??args.nodeId,true);return canonical.claim(args);},
  report(args={}){guard(args.endpointRef??args.nodeId,false);return canonical.report(args);},
  control(args={}){const ref=args.endpointRef??args.nodeId;guard(ref,false);if(typeof taskFor!=='function')throw new ExecutionBackendError('BACKEND_UNAVAILABLE','Canonical task lookup required for control');const task=taskFor(args.taskId);if(!task||task.assignedNodeId!==ref)throw new ExecutionBackendError('NOT_TASK_HOLDER','Control endpoint does not hold canonical task');return canonical.control(args);}
 });
}
