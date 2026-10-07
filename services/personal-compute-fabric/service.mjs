import {randomUUID} from 'node:crypto';
import {createCanonicalStateAdapter} from './canonical-state-adapter.mjs';
import {createArtifactStore,sha256} from './artifacts.mjs';
import {resolveEffectivePolicy,assertPolicy} from './policy.mjs';
import {normalizeWorkload} from './workload.mjs';
import {executeApprovedLocal} from './local-flow.mjs';
import {fairQueue} from './fair-queue.mjs';
import {requireThat as ok,text,copy} from './validation.mjs';

const APPS=Object.freeze({'cpu-sort':{operation:'SORT',qos:'INTERACTIVE'},'cpu-sum':{operation:'SUM',qos:'BATCH'}});
const FINAL=['COMPLETED','FAILED','CANCELLED'];
export function createFabricService({store,artifactRoot,deviceId,readAuthority,maxParallel=2,maxQueue=128}){
 ok(store&&text(artifactRoot)&&text(deviceId)&&typeof readAuthority==='function','FABRIC_CONFIGURATION');
 ok(Number.isInteger(maxParallel)&&maxParallel>0&&maxParallel<=8&&Number.isInteger(maxQueue)&&maxQueue>0&&maxQueue<=256,'FABRIC_LIMITS');
 const owner=createCanonicalStateAdapter(store);const supervisorId=randomUUID();const running=new Map();let started=false,draining=false,stopped=false,pumping=null,lastAppId=null,lifecycleEpoch=0;
 const artifacts=createArtifactStore({root:artifactRoot,maxBytes:16777216,maxItems:512,authorize:async({operation,metadata,context})=>{
  const caller={sessionId:metadata.owner,deviceId};const facts=await readAuthority(caller);
  if(facts.authorized!==true||Date.now()>=facts.expiresAt||!facts.dataScopes?.includes(metadata.dataScope))return false;
  return operation==='PUBLISH'||context?.caller===metadata.owner;
 }});
 async function authority(context,dataScope='PUBLIC'){
  ok(text(context?.sessionId)&&context.deviceId===deviceId,'CALLER_BINDING');
  const policy=resolveEffectivePolicy({},await readAuthority(context),Date.now());assertPolicy(policy,{deviceId,dataScope,fee:0},Date.now());return policy;
 }
 async function access(taskId,context){await authority(context);const t=store.get('tasks',taskId);ok(t?.executionBackendId==='pcf-v1'&&t.parentSessionId===context.sessionId&&t.originDeviceId===context.deviceId,'ORIGIN_UNAUTHORIZED');return t;}
 function tasks(){return store.list('tasks').filter(t=>t.executionBackendId==='pcf-v1');}
 function persistFailure(task,error){store.atomic(()=>{const t=store.get('tasks',task.id);if(!t)return;const action=store.get('actions',t.actionId);if(FINAL.includes(t.state)){if(action)store.put('actions',{...action,status:t.state==='COMPLETED'?'SUCCEEDED':t.state,error:t.state==='COMPLETED'?null:{code:String(error.code??'PCF_EXECUTION_REFUSED'),message:String(error.message)},updatedAt:new Date().toISOString()});return;}if(t.pcfAttemptId&&error.pcfAttemptId!==t.pcfAttemptId)return;const uncertain=Boolean(t.pcfAttemptId);store.put('tasks',{...t,state:uncertain?'RUNNING':'FAILED',error:String(error.code??error.message),pcfAttention:String(error.code??error.message),updatedAt:new Date().toISOString()});if(action)store.put('actions',{...action,status:uncertain?'RUNNING':'FAILED',error:{code:String(error.code??'PCF_EXECUTION_REFUSED'),message:String(error.message)},updatedAt:new Date().toISOString()});});}
 async function run(task){
  const controller=new AbortController();const execution=async()=>{
   try{
    const context={sessionId:task.parentSessionId,deviceId:task.originDeviceId};await authority(context);
    const raw=await artifacts.read(task.pcfInputRef,{caller:task.parentSessionId},Date.now());const input=JSON.parse(raw.toString());
    const result=await executeApprovedLocal({owner,artifacts,workload:task.pcfWorkload,generation:task.pcfGeneration??0,input,inputRef:task.pcfInputRef,authority:()=>readAuthority(context),deviceId,signal:controller.signal});
    store.atomic(()=>{const t=store.get('tasks',task.id);const action=store.get('actions',t.actionId);if(action)store.put('actions',{...action,status:result.receipt.outcome,progress:t.state==='COMPLETED'?100:action.progress,resultRef:result.receipt.outputRef?{kind:'CITY_TASK_RESULT',id:t.id,digest:result.receipt.outputDigest,summary:'Approved local CPU application completed.'}:null,error:t.state==='COMPLETED'?null:{code:result.receipt.outcome,message:result.receipt.reason??result.receipt.outcome},updatedAt:new Date().toISOString()});store.event('TASK_'+t.state,t.id,{actionId:t.actionId,nodeId:deviceId,attemptId:result.receipt.attemptId,epoch:result.receipt.epoch,outputDigest:result.receipt.outputDigest},'pcf');});
   }catch(error){persistFailure(task,error);}finally{running.delete(task.id);}
  };
  const entry={controller,promise:null};running.set(task.id,entry);entry.promise=execution();return entry.promise;
 }
 async function pump(){
  if(!started||stopped||draining)return;if(pumping)return pumping;
  pumping=(async()=>{while(started&&!stopped&&!draining){const pending=tasks().filter(t=>t.state==='QUEUED'&&!running.has(t.id));const ordered=fairQueue(pending.map(t=>({...t,appId:t.pcfAppId,queuedAt:Date.parse(t.createdAt),qos:t.pcfWorkload.qos})),{lastAppId,now:Date.now()});for(const task of ordered){if(running.size>=maxParallel)break;lastAppId=task.pcfAppId;run(task);}if(!running.size)break;await Promise.race([...running.values()].map(x=>x.promise));}})().finally(()=>{pumping=null;});return pumping;
 }
 const api={
  async submit(spec,context){
   ok(!draining&&!stopped,'FABRIC_DRAINING');const admissionEpoch=lifecycleEpoch;const request=copy(spec);await authority(context);ok(admissionEpoch===lifecycleEpoch&&!draining&&!stopped,'FABRIC_DRAINING');
   ok(Object.keys(request).every(k=>['appId','idempotencyKey','input','parentSessionId','strictTargetDeviceId','deadlineAt'].includes(k))&&Object.hasOwn(APPS,request.appId)&&text(request.idempotencyKey)&&request.idempotencyKey.length<=128,'APP_UNSUPPORTED');
   ok(request.parentSessionId===context.sessionId,'CALLER_BINDING');ok(!request.strictTargetDeviceId||request.strictTargetDeviceId===deviceId,'REMOTE_EXECUTOR_NOT_CONFIGURED');
   ok(request.input&&Object.keys(request.input).length===1&&Array.isArray(request.input.values)&&request.input.values.length<=1024&&request.input.values.every(v=>typeof v==='number'&&Number.isFinite(v)),'APP_INPUT');
   const app=APPS[request.appId],fingerprint=sha256(Buffer.from(JSON.stringify({appId:request.appId,input:request.input,parentSessionId:context.sessionId,deviceId,target:request.strictTargetDeviceId??deviceId,deadlineAt:request.deadlineAt??null})));
   const prior=tasks().find(t=>t.pcfRequestKey===request.idempotencyKey&&t.parentSessionId===context.sessionId);if(prior){ok(prior.pcfFingerprint===fingerprint,'IDEMPOTENCY_CONFLICT');return {taskId:prior.id,actionId:prior.actionId,replayed:true};}
   ok(tasks().filter(t=>!FINAL.includes(t.state)).length<maxQueue,'QUEUE_FULL');const now=Date.now(),deadlineAt=request.deadlineAt??now+60000;ok(Number.isFinite(deadlineAt)&&deadlineAt>now&&deadlineAt<=now+3600000,'DEADLINE');
   const bytes=Buffer.from(JSON.stringify({operation:app.operation,...request.input}));const inputRef=await artifacts.publish(bytes,{owner:context.sessionId,dataScope:'PUBLIC',expiresAt:deadlineAt,schema:'cpu-json-v1'},now);
   const taskId='T-'+randomUUID(),actionId='A-'+randomUUID();const workload=normalizeWorkload({version:1,taskId,actionId,originDeviceId:deviceId,parentSessionId:context.sessionId,appId:request.appId,kind:'CPU_JSON',capabilities:['cpu.json'],resources:{cpu:1,memory:1048576},dataScope:'PUBLIC',qos:app.qos,retryClass:'PURE',inputRefs:[inputRef],writeScope:[],outputSchema:'json',deadlineAt,strictTargetDeviceId:deviceId});
   const accepted=store.atomic(()=>{ok(admissionEpoch===lifecycleEpoch&&!draining&&!stopped,'FABRIC_DRAINING');const raced=tasks().find(t=>t.pcfRequestKey===request.idempotencyKey&&t.parentSessionId===context.sessionId);if(raced){ok(raced.pcfFingerprint===fingerprint,'IDEMPOTENCY_CONFLICT');return {taskId:raced.id,actionId:raced.actionId,replayed:true};}ok(tasks().filter(t=>!FINAL.includes(t.state)).length<maxQueue,'QUEUE_FULL');const timestamp=new Date().toISOString();
    store.put('tasks',{id:taskId,type:'PCF_CPU_JSON',domain:'system',state:'QUEUED',progress:0,actionId,originDeviceId:deviceId,parentSessionId:context.sessionId,targetDeviceRef:deviceId,executionBackendId:'pcf-v1',pcfAppId:request.appId,pcfWorkload:workload,pcfInputRef:inputRef,pcfRequestKey:request.idempotencyKey,pcfFingerprint:fingerprint,createdAt:timestamp,updatedAt:timestamp});
    store.put('actions',{id:actionId,actionId,route:'CITY_TASK',requestedIntent:request.appId,status:'QUEUED',progress:0,idempotencyKey:'pcf:'+context.sessionId+':'+request.idempotencyKey,requestFingerprint:fingerprint,backendRef:{kind:'CITY_TASK',id:'city.task',taskId,operationId:'PCF_CPU_JSON'},target:{kind:'CITY_TASK',id:'city.task',operation:'PCF_CPU_JSON'},resultRef:null,error:null,createdAt:timestamp,updatedAt:timestamp,provenance:{taskId,cityTaskState:'QUEUED',history:[]}});store.event('TASK_CREATED',taskId,{actionId,nodeId:deviceId},'pcf');return {taskId,actionId,replayed:false};});
   if(started)pump();return accepted;
  },
  async start(){ok(!stopped,'FABRIC_STOPPED');owner.transaction(undefined,(s,{getTask,putTask})=>{ok(!s.supervisor||s.supervisor.id===supervisorId,'SUPERVISOR_OWNERSHIP_UNKNOWN');s.supervisor={id:supervisorId,pid:process.pid,startedAt:Date.now()};for(const a of s.attempts.filter(x=>x.state==='RUNNING')){const t=getTask(a.taskId);if(t&&!running.has(t.id))putTask({...t,pcfAttention:'EXECUTION_STOP_NOT_PROVEN'});}return {};});started=true;draining=false;pump();return api.health();},
  async waitForIdle(){await pump();while(running.size)await Promise.allSettled([...running.values()].map(x=>x.promise));},
  async drain(){lifecycleEpoch++;draining=true;await Promise.allSettled([...running.values()].map(x=>x.promise));return api.health();},
  async stop(){lifecycleEpoch++;stopped=true;draining=true;started=false;for(const x of running.values())x.controller.abort();await Promise.allSettled([...running.values()].map(x=>x.promise));owner.transaction(undefined,s=>{if(s.supervisor?.id===supervisorId)s.supervisor=null;return {};});},
  async cancel(taskId,context){const t=await access(taskId,context);if(FINAL.includes(t.state))return {taskId,state:t.state,alreadyTerminal:true};const active=running.get(taskId);if(active){active.controller.abort();await active.promise;return {taskId,state:store.get('tasks',taskId).state};}return store.atomic(()=>{const current=store.get('tasks',taskId);ok(current.state==='QUEUED','EXECUTION_STOP_NOT_PROVEN');store.put('tasks',{...current,state:'CANCELLED'});const action=store.get('actions',current.actionId);if(action)store.put('actions',{...action,status:'CANCELLED'});store.event('TASK_CANCELLED',taskId,{actionId:current.actionId},'pcf');return {taskId,state:'CANCELLED'};});},
  inspect:access,
  async collect(taskId,context){const t=await access(taskId,context);ok(t.state==='COMPLETED'&&t.pcfResult?.outputRef,'RESULT_NOT_READY');const bytes=await artifacts.read(t.pcfResult.outputRef,{caller:context.sessionId},Date.now());return {taskId,actionId:t.actionId,digest:t.pcfResult.outputDigest,output:JSON.parse(bytes.toString()),delivered:true,consumed:t.pcfConsumedSessionId===context.sessionId};},
  async acknowledge(taskId,context,digest){await access(taskId,context);return store.atomic(()=>{const t=store.get('tasks',taskId);ok(t.state==='COMPLETED'&&t.pcfResult.outputDigest===digest,'CONSUMPTION_DIGEST');store.put('tasks',{...t,pcfConsumedSessionId:context.sessionId});return {taskId,consumed:true};});},
  health(){return {state:stopped?'STOPPED':draining?'DRAINING':started?'RUNNING':'READY_NOT_STARTED',running:running.size,queued:tasks().filter(t=>t.state==='QUEUED').length,executionScope:'ACTUAL_LOCAL_CPU',physicalAcceptance:'NOT_RUN'};},
 };
 return Object.freeze(api);
}
