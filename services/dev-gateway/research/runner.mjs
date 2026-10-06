import {mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deriveSeed} from '../../../contracts/experiment-manifest-v1/manifest.mjs';
import {taskTypes,terminal} from '../../../contracts/city-control-v0/protocol.mjs';

const copy=v=>JSON.parse(JSON.stringify(v));
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const bounded=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
// Campaigns are research receipts, never task execution state. All work belongs to adapter's canonical store.
export function createScenarioRunner({dir,registry,adapter,trace,pollMs=25,clock=Date.now}={}){
 mkdirSync(dir,{recursive:true});const records=new Map(),jobs=new Map();let closed=false;
 const persist=row=>{const path=join(dir,row.campaignId+'.json');writeFileSync(path+'.tmp',JSON.stringify(row,null,2));renameSync(path+'.tmp',path);};
 const summary=row=>({successfulRuns:row.runs.filter(r=>!r.warmup&&r.outcome==='COMPLETED').length,failedRuns:row.runs.filter(r=>!r.warmup&&['FAILED','TIMEOUT','INFRASTRUCTURE_FAILURE'].includes(r.outcome)).length,excludedRuns:row.runs.filter(r=>r.exclusionReason!=null).length,measuredRuns:row.runs.filter(r=>!r.warmup&&r.endedAt!=null).length});
 const save=row=>{row.summary=summary(row);persist(row);};
 const get=id=>{const row=records.get(id);if(!row)fail('CAMPAIGN_NOT_FOUND',404);return copy(row);};
 const cancelTask=run=>{if(!run?.taskRef)return;try{const task=adapter.get(run.taskRef);if(task&&!terminal.includes(task.state))adapter.cancel(run.taskRef);}catch{run.cleanupFailure='CANONICAL_CANCEL_FAILED';}};
 const recordTrace=(row,run)=>{try{if(trace?.record({eventId:row.campaignId+'-'+run.index,type:'RESEARCH_RUN_RECEIPT',timestamp:run.endedAt,sourceClock:'HOST_WALL_UTC',canonicalRefs:run.taskRef?{taskRef:run.taskRef}:{},dimensions:{experimentRef:row.experimentId,experimentRunRef:row.campaignId+'-'+run.index},metrics:{latencyMs:run.durationMs}})===false)row.traceFailure='TRACE_RECORD_FAILED';}catch{row.traceFailure='TRACE_RECORD_FAILED';}};
 for(const name of readdirSync(dir).filter(n=>/^campaign-[a-f0-9-]+\.json$/.test(n))){
  const row=JSON.parse(readFileSync(join(dir,name),'utf8'));
  if(row.status==='RUNNING'){
   const run=row.runs.at(-1);if(run&&!run.endedAt){
    const owned=adapter.owned?.(row.campaignId+'-'+run.index)??[];
    if(!run.taskRef&&owned.length===1)run.taskRef=owned[0].id;
    for(const task of owned)cancelTask({taskRef:task.id});
    cancelTask(run);Object.assign(run,{outcome:'INTERRUPTED',exclusionReason:'PROCESS_RESTART',endedAt:new Date(clock()).toISOString(),durationMs:null});}
   row.status='INTERRUPTED';row.stopReason='PROCESS_RESTART';row.endedAt=new Date(clock()).toISOString();save(row);
  }records.set(row.campaignId,row);
 }
 function start(experimentId,options){
  if(closed)fail('RUNNER_CLOSED',409);
  const manifest=registry.get(experimentId);if(manifest.status!=='VALIDATED')fail('EXPERIMENT_NOT_VALIDATED');
  const m=manifest.manifest;
  if(!m.workers?.length)fail('EXPERIMENT_WORKER_REQUIRED');
  const o={...options};
  if(!taskTypes.includes(o.scenario)||!bounded(o.repetitions,1,Math.min(m.repetitions,1000))||!bounded(o.warmups,0,100)||!bounded(o.timeoutMs,1,300000)||o.resumePolicy!=='INTERRUPT'||Object.keys(o).some(k=>!['scenario','repetitions','warmups','timeoutMs','resumePolicy','targetDeviceRef'].includes(k)))fail('INVALID_CAMPAIGN');
  if(o.targetDeviceRef!=null&&(!m.workers.includes(o.targetDeviceRef)||typeof o.targetDeviceRef!=='string'))fail('INVALID_CAMPAIGN_TARGET');
  if(!m.softwareRefs.some(ref=>typeof ref==='string'?/^utopia@[a-f0-9]{40}$/.test(ref):ref.component==='utopia'&&/^[a-f0-9]{40}$/.test(ref.commitSha)))fail('EXACT_SOFTWARE_IDENTITY_REQUIRED');
  if([...records.values()].some(r=>r.experimentId===experimentId&&r.status==='RUNNING'))fail('CAMPAIGN_ALREADY_RUNNING',409);
  const readiness=adapter.readiness(m);if(!readiness.ready)fail('TOPOLOGY_NOT_READY: '+readiness.missing.join(','),409);
  const wallLimit=Math.min(3600000,...m.stopConditions.filter(s=>s.kind==='MAX_WALL_CLOCK_MS').map(s=>s.value));
  const row={schemaVersion:1,campaignId:'campaign-'+randomUUID(),experimentId,manifestDigest:manifest.digest??null,softwareRefs:m.softwareRefs,options:o,readiness,startedAt:new Date(clock()).toISOString(),endedAt:null,status:'RUNNING',stopReason:null,runs:[],summary:{},resumePolicy:'INTERRUPT'};
  records.set(row.campaignId,row);save(row);const job={stop:false,wake:null,promise:null};jobs.set(row.campaignId,job);
  // Defer work until after start returns its receipt; no campaign blocks another request.
  job.promise=Promise.resolve().then(async()=>{
   const startClock=clock();
   for(let index=0;index<o.warmups+o.repetitions;index++){
    if(job.stop||closed||row.status!=='RUNNING')break;
    if(clock()-startClock>=wallLimit){row.stopReason='MAX_WALL_CLOCK_MS';break;}
    const warmup=index<o.warmups,repetition=warmup?index:index-o.warmups;
    const readinessNow=adapter.readiness(m);
    const run={index,repetition,warmup,seed:deriveSeed({...m,repetition,variant:m.variables.independent[repetition%m.variables.independent.length]}),startedAt:new Date(clock()).toISOString(),endedAt:null,taskRef:null,outcome:null,exclusionReason:warmup?'WARMUP':null,durationMs:null};
    row.runs.push(run);const begin=clock();save(row);
    try{
     if(!readinessNow.ready){run.outcome='EXCLUDED';run.exclusionReason='TOPOLOGY_NOT_READY';}
     else{
      run.targetDeviceRef=o.targetDeviceRef??m.workers[run.seed%m.workers.length];
      run.seedApplication=o.targetDeviceRef?'EXPLICIT_DECLARED_WORKER_TARGET_SEED_NOT_APPLIED':'DETERMINISTIC_DECLARED_WORKER_SELECTION';
      const task=adapter.create(o.scenario,{targetDeviceRef:run.targetDeviceRef,researchRunRef:row.campaignId+'-'+run.index});run.taskRef=task.id;save(row);
      while(true){
       if(row.status!=='RUNNING')return;
       const current=adapter.get(run.taskRef);
       if(!current){run.outcome='INFRASTRUCTURE_FAILURE';run.exclusionReason='CANONICAL_TASK_MISSING';break;}
       if(job.stop||closed){cancelTask(run);run.outcome='CANCELLED';run.exclusionReason='MANUAL_STOP';break;}
       if(clock()-begin>=o.timeoutMs||clock()-startClock>=wallLimit){cancelTask(run);run.outcome='TIMEOUT';run.exclusionReason=clock()-startClock>=wallLimit?'CAMPAIGN_WALL_LIMIT':'RUN_TIMEOUT';break;}
       if(terminal.includes(current.state)){run.outcome=current.state;if(current.state==='CANCELLED')run.exclusionReason='CANONICAL_TASK_CANCELLED';break;}
       await new Promise(resolve=>{const timer=setTimeout(()=>{job.wake=null;resolve();},pollMs);job.wake=()=>{clearTimeout(timer);job.wake=null;resolve();};});
      }
     }
    }catch{for(const task of adapter.owned?.(row.campaignId+'-'+run.index)??[])cancelTask({taskRef:task.id});cancelTask(run);run.outcome='INFRASTRUCTURE_FAILURE';run.exclusionReason='CANONICAL_ADAPTER_FAILURE';}
    if(row.status!=='RUNNING')return;
    run.endedAt=new Date(clock()).toISOString();run.durationMs=Math.max(0,clock()-begin);recordTrace(row,run);save(row);
    const stop=m.stopConditions.find(s=>(s.kind==='MAX_FAILURES'&&row.summary.failedRuns>=s.value)||(s.kind==='MIN_SUCCESSFUL_RUNS'&&row.summary.successfulRuns>=s.value)||(s.kind==='MAX_REPETITIONS'&&row.summary.measuredRuns>=s.value));
    if(stop){row.stopReason=stop.kind;break;}
    if(clock()-startClock>=wallLimit){row.stopReason='MAX_WALL_CLOCK_MS';break;}
   }
   if(row.status==='RUNNING'){row.status=job.stop||closed?'CANCELLED':'COMPLETED';row.stopReason??=job.stop||closed?'MANUAL_STOP':'REPETITIONS_FINISHED';row.endedAt=new Date(clock()).toISOString();save(row);}
  }).catch(()=>{row.status='INFRASTRUCTURE_FAILURE';row.stopReason='RECEIPT_STORAGE_OR_RUNNER_FAILURE';try{save(row);}catch{}}).finally(()=>jobs.delete(row.campaignId));
  return get(row.campaignId);
 }
 function stop(id){const row=records.get(id);if(!row)fail('CAMPAIGN_NOT_FOUND',404);const job=jobs.get(id);if(job){job.stop=true;job.wake?.();}return get(id);}
 return {start,stop,get,list:()=>({campaigns:[...records.values()].map(copy),scenarios:taskTypes,resumePolicy:'INTERRUPT'}),async close(){closed=true;for(const job of jobs.values()){job.stop=true;job.wake?.();}await Promise.all([...jobs.values()].map(j=>j.promise));}};
}
