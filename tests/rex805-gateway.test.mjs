import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {WebSocket} from 'ws';
import {createGateway} from '../services/dev-gateway/server.mjs';
const workers=['replay-worker-a','replay-worker-b'];
const call=async(app,path,body,credential='owner')=>{const response=await fetch(`${app.url}/api/v0/${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
const withCity=async fn=>{const dir=await mkdtemp(resolve('.scratch-rex805-gateway-'));let app,socket;try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});socket=new WebSocket(`${app.url.replace('http','ws')}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=replay-web&clientLabel=ReplayFixture`,['city-token.'+Buffer.from('owner').toString('base64url')]);await new Promise((yes,no)=>{socket.once('open',yes);socket.once('error',no);});for(const id of workers)assert.equal((await call(app,'node/register',{id,displayName:id,capabilities:['task.execute.safe','filesystem.temp'],roles:['EXECUTION_NODE'],metadata:{platform:'win32'}},'node')).status,200);await fn(app,dir);}finally{socket?.close();await app?.close();await rm(dir,{recursive:true,force:true});}};
const manifest={experimentId:'replay-original',question:'Does disabling seeded alternate-device selection change the real canonical task placement?',topology:'TWO_HOST_MESH',hosts:workers,workers,controlSurfaces:['replay-web'],variables:{independent:['scenario'],dependent:['assignment'],controls:['taskType']},repetitions:3,seedPolicy:'PER_REPETITION',baseSeed:7,requiredCapabilities:['research.evidence.review'],stopConditions:[{kind:'MAX_REPETITIONS',value:3},{kind:'MAX_FAILURES',value:3}],artifactPolicy:{retention:'BOUNDED_TRACE'},acceptance:{primary:'canonical task placement'},softwareRefs:['utopia@'+'0'.repeat(40)]};
const execute=async(app,id)=>{const until=Date.now()+10000;while(Date.now()<until){const progress=app.campaigns.progress();if(progress.state!=='RUNNING'){assert.equal(progress.state,'COMPLETED');return app.campaigns.receipt(id);}for(const worker of workers){const claim=await call(app,'node/claim',{id:worker},'node');const task=claim.body.task;if(task){await call(app,'node/report',{id:worker,taskId:task.id,state:'RUNNING',progress:50},'node');await call(app,'node/report',{id:worker,taskId:task.id,state:'COMPLETED',progress:100,result:{scenarioInput:'WAIT'}},'node');}}await new Promise(r=>setTimeout(r,5));}assert.fail('bounded campaign did not finish');};

test('REX805 real canonical original/replay/ablation preserve selected seed and change target policy only',async()=>withCity(async(app,dir)=>{
 assert.equal((await call(app,'research/experiments',{manifest})).status,200);
 const originalStart=await call(app,'research/campaigns',{experimentId:manifest.experimentId,scenarioId:'WAIT',repetitions:3,seed:'original'});assert.equal(originalStart.status,200);
 const original=await execute(app,originalStart.body.started.campaignId);assert.equal(original.runs[1].result.assignedNodeId,workers[1]);
 const originalFile=resolve(dir,'research','campaigns',original.campaignId+'.json'),before=await readFile(originalFile);
 const selected={sourceCampaignId:original.campaignId,sourceRunIndex:1,mode:'REPLAY',disabledMechanisms:[]};
 const replayStart=await call(app,'research/replays',selected);assert.equal(replayStart.status,200,JSON.stringify(replayStart.body));
 const countBeforeBusy=(await call(app,'research/experiments')).body.experiments.length;
 const busy=await call(app,'research/replays',selected);assert.equal(busy.status,409);assert.equal(busy.body.errorCode,'REPLAY_BUSY');assert.equal((await call(app,'research/experiments')).body.experiments.length,countBeforeBusy);
 const replay=await execute(app,replayStart.body.started.campaignId);assert.equal(replay.runs[0].seed,original.runs[1].seed);assert.equal(replay.runs[0].result.assignedNodeId,workers[1]);assert.notEqual(replay.context.experimentId,original.context.experimentId);
 const ablationStart=await call(app,'research/replays',{...selected,mode:'ABLATION',disabledMechanisms:['alternate-device']});assert.equal(ablationStart.status,200,JSON.stringify(ablationStart.body));
 const ablation=await execute(app,ablationStart.body.started.campaignId);assert.equal(ablation.runs[0].seed,original.runs[1].seed);assert.equal(ablation.runs[0].result.assignedNodeId,workers[0]);
 const comparison=await call(app,`research/replays/${ablation.campaignId}`);assert.equal(comparison.status,200);assert.equal(comparison.body.comparison.controlledInputsMatch,true);assert.equal(comparison.body.comparison.placementChanged,true);assert.equal(comparison.body.comparison.causalPerformanceClaim,false);
 for(const [record,target] of [[replay,workers[1]],[ablation,workers[0]]]){const task=app.store.get('tasks',record.runs[0].result.taskRef);assert.equal(task.targetDeviceRef,target);assert.equal(task.state,'COMPLETED');assert.equal(task.researchRunRef,record.campaignId+':0');}
 assert.deepEqual(await readFile(originalFile),before);
 const rejected=await call(app,'research/replays',{...selected,mode:'ABLATION',disabledMechanisms:['retry']});assert.equal(rejected.status,422);assert.equal(rejected.body.errorCode,'ABLATION_UNSUPPORTED');
}));

test('REX805 replay API is Owner-only and lists truthful bounded mechanism support',async()=>withCity(async app=>{
 const worker=await call(app,'research/replays',undefined,'node');assert.equal(worker.status,401);
 const owner=await call(app,'research/replays');assert.equal(owner.status,200);assert.deepEqual(owner.body.mechanisms.filter(entry=>entry.supported).map(entry=>entry.id),['alternate-device']);assert.equal(owner.body.mechanisms.find(entry=>entry.id==='versioned-rule-view').versionedSnapshotRequired,true);
}));
