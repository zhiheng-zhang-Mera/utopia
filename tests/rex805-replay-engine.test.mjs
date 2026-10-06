import test from 'node:test';
import assert from 'node:assert/strict';
import {runSeed} from '../services/dev-gateway/scenario-runner.mjs';
const module=await import('../services/dev-gateway/research/replay.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const copy=value=>JSON.parse(JSON.stringify(value));
const fixture=()=>{
 assert.equal(typeof module.createReplayEngine,'function','REX805 replay engine must exist');
 const manifest={experimentId:'original-fixture',question:'placement',workers:['worker-a','worker-b'],hosts:['worker-a','worker-b'],controlSurfaces:['android'],repetitions:3,seedPolicy:'PER_REPETITION',baseSeed:7,softwareRefs:['utopia@'+'0'.repeat(40)],variables:{independent:['scenario'],dependent:['placement'],controls:['input']},stopConditions:[{kind:'MAX_REPETITIONS',value:3}]};
 const record={experimentId:manifest.experimentId,status:'VALIDATED',manifest,digest:'identity-original'};
 const source={campaignId:'campaign-original',scenarioId:'WAIT',state:'COMPLETED',campaignSeed:'original',seedIndexOffset:0,warmup:0,timeout:1000,limits:{maxFailures:2},context:{experimentId:manifest.experimentId,manifestIdentity:record.digest,manifest:copy(manifest),targetDeviceRef:null},runs:[{index:1,seed:runSeed('original',1),state:'MEASURED',measured:true,warmup:false,result:{taskRef:'task-original',assignedNodeId:'worker-b'},durationMs:6000}]};
 const receipts=new Map([[source.campaignId,source]]),records=new Map([[record.experimentId,record]]);let count=0;
 const deps={receipt:id=>copy(receipts.get(id)),experiment:id=>copy(records.get(id)),identity:r=>r.digest,context:r=>({experimentId:r.experimentId,manifestIdentity:r.digest,manifest:copy(r.manifest),targetDeviceRef:null}),register:manifest=>{const r={experimentId:manifest.experimentId,status:'VALIDATED',manifest:copy(manifest),digest:'new-identity'};records.set(r.experimentId,r);return {record:copy(r),persisted:true};},start:options=>{const campaignId='campaign-new-'+(++count);const run={index:0,seed:runSeed(options.seed,options.seedIndexOffset),state:'MEASURED',measured:true,result:{assignedNodeId:module.replayTarget(options.context,runSeed(options.seed,options.seedIndexOffset)),taskRef:'new-task-'+count},durationMs:6100};receipts.set(campaignId,{...copy(options),campaignId,state:'COMPLETED',runs:[run]});return {campaignId};}};
 return {source,records,receipts,deps,engine:module.createReplayEngine(deps)};
};
const request={sourceCampaignId:'campaign-original',sourceRunIndex:1,mode:'REPLAY',disabledMechanisms:[]};

test('REX805 replay preserves selected seed and input with fresh identities and untouched source',()=>{
 const f=fixture(),before=JSON.stringify(f.source);const started=f.engine.start(request);const replay=f.receipts.get(started.campaignId);
 assert.notEqual(replay.context.experimentId,f.source.context.experimentId);assert.equal(replay.seedIndexOffset,1);assert.equal(replay.runs[0].seed,f.source.runs[0].seed);assert.equal(replay.runs[0].result.assignedNodeId,'worker-b');assert.equal(JSON.stringify(f.source),before);assert.equal(replay.context.replay.sourceRunRef,'campaign-original:1');assert.equal(replay.context.replay.determinism,'CONTROL_INPUTS_ONLY');
});
test('REX805 alternate-device ablation changes actual target selection and records exact mechanism',()=>{
 const f=fixture();const started=f.engine.start({...request,mode:'ABLATION',disabledMechanisms:['alternate-device']});const replay=f.receipts.get(started.campaignId);
 assert.equal(replay.runs[0].result.assignedNodeId,'worker-a');assert.equal(replay.runs[0].seed,f.source.runs[0].seed);assert.deepEqual(replay.context.replay.disabledMechanisms,['alternate-device']);
});
test('REX805 unsupported, ambiguous and ineffective ablations are refused before creating experiments',()=>{
 const f=fixture();for(const mechanisms of [['retry'],['alternate-device','retry'],[],['alternate-device','alternate-device']])assert.throws(()=>f.engine.start({...request,mode:'ABLATION',disabledMechanisms:mechanisms}),{code:'ABLATION_UNSUPPORTED'});
 assert.throws(()=>f.engine.start({...request,disabledMechanisms:['alternate-device']}),{code:'ABLATION_UNSUPPORTED'});
 f.source.context.targetDeviceRef='worker-b';assert.throws(()=>f.engine.start({...request,mode:'ABLATION',disabledMechanisms:['alternate-device']}),{code:'ABLATION_INEFFECTIVE'});assert.equal(f.records.size,1);
});
test('REX805 corrupt source identity, seed, measured outcome and index cannot be laundered into replay',()=>{
 for(const change of [s=>s.context.manifestIdentity='stale',s=>s.runs[0].seed=0,s=>s.state='RUNNING',s=>s.context.manifest.workers.reverse(),s=>s.runs[0].measured=false]){const f=fixture();change(f.source);assert.throws(()=>f.engine.start(request),{code:'REPLAY_SOURCE_INVALID'});assert.equal(f.records.size,1);}
 const f=fixture();assert.throws(()=>f.engine.start({...request,sourceRunIndex:-1}),{code:'REPLAY_SOURCE_INVALID'});assert.throws(()=>f.engine.start({...request,sourceRunIndex:99}),{code:'REPLAY_SOURCE_INVALID'});
});
test('REX805 comparisons expose policy difference and reject changed source material',()=>{
 const f=fixture();const started=f.engine.start({...request,mode:'ABLATION',disabledMechanisms:['alternate-device']});const comparison=f.engine.compare(started.campaignId);
 assert.equal(comparison.controlledInputsMatch,true);assert.equal(comparison.placementChanged,true);assert.equal(comparison.durationDeltaMs,100);assert.equal(comparison.causalPerformanceClaim,false);
 f.source.runs[0].durationMs=9999;assert.throws(()=>f.engine.compare(started.campaignId),{code:'REPLAY_SOURCE_CHANGED'});
});
test('REX805 registry persistence failure refuses execution while retaining original',()=>{
 const f=fixture();const engine=module.createReplayEngine({...f.deps,register:()=>({persisted:false})});assert.throws(()=>engine.start(request),{code:'REPLAY_STORE_UNAVAILABLE'});assert.equal(f.receipts.size,1);
});

test('REX805 unavailable fault conditions and undeclared request switches are refused explicitly',()=>{
 const f=fixture();assert.throws(()=>f.engine.start({...request,ruleSnapshot:'invented'}),{code:'REPLAY_REQUEST_INVALID'});
 f.source.scenarioId='HASH_TEMP_ARTIFACT';assert.throws(()=>f.engine.start(request),{code:'REPLAY_CONDITION_UNAVAILABLE'});f.source.scenarioId='WAIT';
 f.records.get('original-fixture').manifest.references={faultProfileRef:'fault-not-reconstructed'};
 f.source.context.manifest.references={faultProfileRef:'fault-not-reconstructed'};
 assert.throws(()=>f.engine.start(request),{code:'REPLAY_CONDITION_UNAVAILABLE'});assert.equal(f.records.size,1);
});
