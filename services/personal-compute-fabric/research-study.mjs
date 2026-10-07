import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Store} from '../dev-gateway/store.mjs';
import {createTraceCollector} from '../research-trace/index.mjs';
import {createFabricService} from './service.mjs';
import {freezeStudy,createResearchAdapter} from './research-adapter.mjs';
import {planPlacement} from './placement.mjs';
import {requireThat as ok,copy,freeze} from './validation.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function freezeResearchStudy(input){
 const config=freezeStudy(input);
 ok(config.evidenceClass==='ACTUAL_LOCAL_CPU','STUDY_LOCAL_ONLY');
 ok(config.workloads.length===2&&new Set(config.workloads).size===2&&config.workloads.every(x=>['cpu-sort','cpu-sum'].includes(x)),'STUDY_WORKLOADS');
 ok(config.analysis==='DESCRIPTIVE_ONLY'&&config.failureCounting==='KEEP_ALL','STUDY_ANALYSIS');
 ok(config.controls&&['hardware','cache','network'].every(k=>typeof config.controls[k]==='string'&&config.controls[k].length>0),'STUDY_CONTROLS');
 ok(config.inputs&&Object.keys(config.inputs).length===2&&config.workloads.every(w=>config.inputs[w]&&Object.keys(config.inputs[w]).length===1&&Array.isArray(config.inputs[w].values)&&config.inputs[w].values.length<=1024&&config.inputs[w].values.every(Number.isFinite)),'STUDY_INPUTS');
 return config;
}
/** Pure counterfactual only. Every strategy goes through the existing feasibility/policy shield. */
export function comparePolicies({workload,candidates,policy,now}){
 const conditions=['FIXED','CAPABILITY','LOAD','COMPOSITE'].map(strategy=>({strategy,dispatchAllowed:false,result:planPlacement(workload,candidates,policy,now,{strategy})}));
 // Removing the cost ranking is the capability-only ablation; safety is never disabled.
 return freeze({evidenceClass:'COUNTERFACTUAL_SIMULATION',conditions,ablation:{disabledMechanisms:['cost-ranking'],dispatchAllowed:false,result:planPlacement(workload,candidates,policy,now,{strategy:'CAPABILITY'})}});
}
export function summarizeTrials(trials){
 const completed=trials.filter(t=>t.state==='COMPLETED'),durations=completed.map(t=>t.durationMs).sort((a,b)=>a-b);
 return {planned:trials.length,completed:completed.length,failed:trials.filter(t=>t.state==='FAILED').length,notRun:trials.filter(t=>t.state==='NOT_RUN').length,other:trials.filter(t=>!['COMPLETED','FAILED','NOT_RUN'].includes(t.state)).length,latencyMs:{n:durations.length,min:durations[0]??null,max:durations.at(-1)??null,mean:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:null},analysis:'DESCRIPTIVE_ONLY',unmeasured:['cpuPercent','memoryBytes','SLO','recovery','observerOverhead','clockSkew']};
}
import {readFile,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const gitExec=promisify(execFile);
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
/** Observes the actual checkout, with bounded digest-only dirty evidence. */
export async function readSourceIdentity({root=sourceRoot}={}){
 const git=async args=>(await gitExec('git',args,{cwd:root,maxBuffer:1048576})).stdout;
 const head=(await git(['rev-parse','HEAD'])).trim();
 const status=await git(['status','--porcelain=v1','-z']);
 const changed=await git(['diff','HEAD','--name-only','-z','--no-ext-diff']);
 const untracked=await git(['ls-files','-o','--exclude-standard','-z']);
 // Index identity distinguishes staged changes even when the status and worktree bytes stay constant.
 const indexDiff=await git(['diff','--cached','--binary','--no-ext-diff','HEAD']);
 const indexDiffDigest=createHash('sha256').update(indexDiff).digest('hex');
 const files=[...new Set((changed+untracked).split('\0').filter(Boolean))].sort();
 ok(files.length<=256,'STUDY_SNAPSHOT_LIMIT');let bytes=0;const dirtyFiles=[];
 for(const path of files){try{const info=await stat(join(root,path));ok(info.isFile()&&info.size<=16777216&&(bytes+=info.size)<=33554432,'STUDY_SNAPSHOT_LIMIT');dirtyFiles.push({path,digest:createHash('sha256').update(await readFile(join(root,path))).digest('hex')});}catch(error){if(error.code!=='ENOENT')throw error;dirtyFiles.push({path,digest:null,state:'DELETED'});}}
 const clean=status.length===0;return {head,clean,state:clean?'CLEAN_EXACT_SHA':'DIRTY_COMPONENT_SNAPSHOT',dirtyFiles,indexDiffDigest,snapshotDigest:hash({head,status,dirtyFiles,indexDiffDigest}),frozenSource:clean};
}
export async function runLocalStudy(input,{directory,deviceId='local-cpu',readAuthority,allowDirtySnapshot=false}={}){
 const config=freezeResearchStudy(input);ok(typeof directory==='string'&&directory.length>0,'STUDY_DIRECTORY');
 const runId='pcf-study-'+randomUUID(),configDigest=hash(config),context={sessionId:runId,deviceId};
 const trials=[];for(let repetition=0;repetition<config.repetitions;repetition++)for(const appId of config.workloads)trials.push({repetition,appId,evidenceClass:'ACTUAL_LOCAL_CPU',inputDigest:hash(config.inputs[appId]),taskRef:null,actionRef:null,processId:null,output:null,error:'NOT_STARTED',state:'NOT_RUN',durationMs:null});
 const infrastructureFailures=[];let sourceIdentity=null,sourceAfter=null,store,collector,adapter,service;
 const fail=(phase,error)=>infrastructureFailures.push({phase,code:String(error.code??'STUDY_INFRASTRUCTURE_FAILURE'),message:String(error.message??error)});
 const traceDirectory=join(directory,runId+'-trace');let trace={directory:traceDirectory,replayValidated:false,recordCount:0,completeness:'NOT_RUN',droppedRecords:0,retentionTruncated:false,adapter:null,failures:[]};
 let sourceSeq=0;const started=performance.now();
 try{
  await mkdir(directory,{recursive:true});sourceIdentity=await readSourceIdentity();
  ok(config.softwareSha===sourceIdentity.head,'STUDY_SOURCE_MISMATCH');ok(sourceIdentity.clean||allowDirtySnapshot===true,'STUDY_SOURCE_DIRTY');
  await writeFile(join(directory,runId+'-manifest.json'),JSON.stringify({runId,configDigest,config,sourceIdentity},null,2),{flag:'wx'});
  store=new Store(join(directory,runId+'-canonical'));
  const softwareRefs={implementationSha:sourceIdentity.head,configRef:runId};if(sourceIdentity.clean)softwareRefs.softwareSha=sourceIdentity.head;
  collector=createTraceCollector({directory:traceDirectory,recordLimit:1024,queueLimit:256,byteLimit:16777216,softwareRefs});adapter=createResearchAdapter(collector,{enabled:true});
  const authority=readAuthority??(async()=>({version:1,authorized:true,expiresAt:Date.now()+60000,originDeviceId:deviceId,allowedDevices:[deviceId],dataScopes:['PUBLIC'],sharingConsent:false,cloudConsent:false,budget:0}));
  service=createFabricService({store,artifactRoot:join(directory,runId+'-artifacts'),deviceId,readAuthority:authority,maxParallel:1});
  ok(await collector.flush(),'STUDY_TRACE_FLUSH_TIMEOUT');await service.start();
  for(const trial of trials){
   if(performance.now()-started>=config.stopAfterMs){trial.error='STOP_CONDITION';continue;}
   const begin=performance.now();let submitted;
   try{
    submitted=await service.submit({appId:trial.appId,idempotencyKey:runId+':'+trial.repetition+':'+trial.appId,parentSessionId:runId,input:copy(config.inputs[trial.appId]),deadlineAt:Date.now()+Math.max(1,Math.floor(config.stopAfterMs-(performance.now()-started)))},context);
    trial.taskRef=submitted.taskId;trial.actionRef=submitted.actionId;
    await service.waitForIdle();const task=await service.inspect(submitted.taskId,context);let result=null;
    if(task.state==='COMPLETED'){result=await service.collect(task.id,context);await service.acknowledge(task.id,context,result.digest);}
    Object.assign(trial,{processId:task.pcfProcessIdentity?.pid??null,state:task.state,durationMs:performance.now()-begin,output:result?.output??null,outputDigest:result?.digest??null,error:task.error??null});
   }catch(error){Object.assign(trial,{state:'FAILED',durationMs:performance.now()-begin,error:String(error.code??error.message)});}
   for(const event of store.events(sourceSeq)){adapter.capture(event,{providerId:'pcf-local-cpu'});sourceSeq=event.seq;}
   ok(await collector.flush(),'STUDY_TRACE_FLUSH_TIMEOUT');
  }
 }catch(error){fail('SETUP_OR_TRACE',error);for(const trial of trials)if(trial.state==='NOT_RUN'&&trial.error==='NOT_STARTED')trial.error='INFRASTRUCTURE_STOP:'+String(error.code??'UNKNOWN');}
 // Cleanup steps are independent: one failed stop/flush must not prevent report retention.
 for(const [phase,cleanup]of [['SERVICE_STOP',()=>service?.stop()],['COLLECTOR_CLOSE',async()=>{if(collector)ok(await collector.close(5000),'STUDY_TRACE_CLOSE_TIMEOUT');}],['STORE_CLOSE',()=>store?.db.close()]])try{await cleanup();}catch(error){fail(phase,error);}
 if(collector)try{
  const observed=collector.snapshot();trace={...trace,recordCount:observed.records.length,completeness:observed.completeness,droppedRecords:observed.droppedRecords,retentionTruncated:observed.retentionTruncated,adapter:adapter.snapshot(),failures:observed.failures};
  const replay=createTraceCollector({directory:traceDirectory,recordLimit:1024,queueLimit:256,byteLimit:16777216});try{ok(await replay.flush(5000),'STUDY_REPLAY_FLUSH_TIMEOUT');const replayed=replay.snapshot();trace.replayValidated=replayed.storageState==='READY'&&JSON.stringify(replayed.records)===JSON.stringify(observed.records);if(!trace.replayValidated)fail('TRACE_REPLAY',Object.assign(new Error('Trace replay mismatch'),{code:'STUDY_TRACE_REPLAY_FAILED'}));}finally{await replay.close();}
 }catch(error){fail('TRACE_REPLAY',error);}
 try{sourceAfter=await readSourceIdentity();if(sourceIdentity&&sourceAfter.snapshotDigest!==sourceIdentity.snapshotDigest)fail('SOURCE_AFTER',Object.assign(new Error('Source changed during study'),{code:'STUDY_SOURCE_CHANGED'}));}catch(error){fail('SOURCE_AFTER',error);}
 const report={version:1,runId,configDigest,sourceIdentity,sourceAfter,evidenceClass:'ACTUAL_LOCAL_CPU',trials,summary:summarizeTrials(trials),
  // PCF-721 line 49: clock-skew handling has to be REPRODUCIBLE from the pack. Durations are measured with the
  // monotonic clock, so they cannot be skewed by a wall-clock step, and the one thing this host cannot measure - the
  // skew BETWEEN hosts - is recorded as NOT_MEASURED with what it would take, instead of being left absent.
  clocks:{perTrialSource:'HOST_WALL_UTC_FOR_TIMESTAMPS',durationSource:'PROCESS_HRTIME_MONOTONIC',
    durationHandling:'per-trial durations are monotonic differences, never wall-clock subtraction',
    crossHostSkew:{status:'NOT_MEASURED',reason:'SINGLE_HOST_HAS_NO_INDEPENDENT_REFERENCE',requires:'a second host with an independent clock source and a recorded comparison'}},
  infrastructureFailures,trace,physicalAcceptance:'NOT_RUN',requiredEvidence:{mechIndependentRebuild:'NOT_RUN',rexRunnerFaultReplayExport:'NOT_RUN',mixedEngineeringMLWorkloads:'NOT_RUN',crossHost:'NOT_RUN',statisticalBenefit:'NOT_RUN'}};
 try{await writeFile(join(directory,runId+'-report.json'),JSON.stringify(report,null,2),{flag:'wx'});}catch(error){fail('REPORT_WRITE',error);throw Object.assign(new Error('Study report persistence failed; recover in-memory ledger from error.report'),{code:'STUDY_REPORT_WRITE_FAILED',cause:error,report});}
 return report;
}
