import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createScenarioRunner} from '../services/dev-gateway/scenario-runner.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const scenarios=[{id:'WAIT'},{id:'OTHER'}];
const make=(dir,options={})=>createScenarioRunner({dir,scenarios,runOnce:async()=>({state:'MEASURED'}),...options});

test('REX803 Alien: malformed interrupted state degrades instead of preventing construction',async()=>{
 const dir=await mkdtemp(resolve('.scratch-rex803-alien-'));
 try{
  await writeFile(resolve(dir,'scenario-campaign.json'),JSON.stringify({state:'RUNNING',campaignId:'broken'}));
  let runner; assert.doesNotThrow(()=>{runner=make(dir);});
  assert.equal(runner.unfinished().unreadable,true);
  assert.equal(runner.storeState(),'UNAVAILABLE');
  assert.throws(()=>runner.start({scenarioId:'WAIT',repetitions:1,resume:true}),e=>e.code==='RESUME_CONFLICT');
  await runner.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('REX803 Alien: resume cannot rename the scenario while executing the old campaign',async()=>{
 const dir=await mkdtemp(resolve('.scratch-rex803-alien-'));let runner;
 try{
  await writeFile(resolve(dir,'scenario-campaign.json'),JSON.stringify({state:'INTERRUPTED',campaignId:'campaign-aaaaaaaa-0000-0000-0000-000000000000',scenarioId:'WAIT',runs:[],repetitions:1,warmup:0,totalRuns:1,campaignSeed:'seed',timeout:30,limits:{},context:null,startedAt:0}));
  runner=make(dir);
  assert.throws(()=>runner.start({scenarioId:'OTHER',repetitions:1,resume:true}),e=>e.code==='RESUME_CONFLICT');
  await runner.close();
 }finally{if(runner)await runner.close();await rm(dir,{recursive:true,force:true});}
});

test('REX803 Alien: a timed-out run keeps its own cleanup scope after the next run begins',async()=>{
 const dir=await mkdtemp(resolve('.scratch-rex803-alien-'));let firstControl,secondControl,resolveSecond;const reasons=[];
 let runner;
 try{
  runner=make(dir,{runOnce:({index,control})=>{
   if(index===0){firstControl=control;return new Promise(()=>{});}
   secondControl=control;return new Promise(r=>{resolveSecond=r;});
  }});
  runner.start({scenarioId:'WAIT',repetitions:2,timeout:60});
  for(let n=0;n<100&&!secondControl;n++)await sleep(2);
  assert.ok(secondControl,'second run has begun after first timeout');
  firstControl.onCancel(reason=>reasons.push(reason));
  assert.deepEqual(reasons,['run timed out'],'late cleanup belongs to the timed-out run and fires immediately');
  assert.equal(firstControl.cancelled(),true);
  assert.equal(firstControl.reason(),'run timed out');
  resolveSecond({state:'MEASURED'});
  await runner.close();
 }finally{if(resolveSecond)resolveSecond({state:'MEASURED'});if(runner)await runner.close();await rm(dir,{recursive:true,force:true});}
});

test('REX803 Alien: contradictory run measurement cannot manufacture an early successful stop',async()=>{
 const dir=await mkdtemp(resolve('.scratch-rex803-alien-'));let runner;
 try{
  await writeFile(resolve(dir,'scenario-campaign.json'),JSON.stringify({state:'INTERRUPTED',campaignId:'campaign-bbbbbbbb-0000-0000-0000-000000000000',scenarioId:'WAIT',runs:[{index:0,state:'FAILED',measured:true,warmup:false}],repetitions:2,warmup:0,totalRuns:2,campaignSeed:'seed',timeout:30,limits:{minSuccessfulRuns:1},context:null,startedAt:0}));
  runner=make(dir);
  assert.equal(runner.unfinished().unreadable,true,'state FAILED cannot count as a successful measurement');
  assert.throws(()=>runner.start({scenarioId:'WAIT',repetitions:2,resume:true}),e=>e.code==='RESUME_CONFLICT');
 }finally{if(runner)await runner.close();await rm(dir,{recursive:true,force:true});}
});
