import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScenarioRunner} from '../services/dev-gateway/scenario-runner.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const original={state:'INTERRUPTED',campaignId:'campaign-aaaaaaaa-0000-0000-0000-000000000000',scenarioId:'WAIT',runs:[],repetitions:1,warmup:0,totalRuns:1,campaignSeed:'seed',timeout:30,limits:{},context:{target:'old'},startedAt:0};
async function fixture(extra={},options={}){
 const dir=await mkdtemp(join(tmpdir(),'rex803-critic-'));
 await writeFile(join(dir,'scenario-campaign.json'),JSON.stringify({...original,...extra}));
 const runner=createScenarioRunner({dir,scenarios:[{id:'WAIT'}],runOnce:async()=>({state:'MEASURED'}),...options});
 return {runner,cleanup:async()=>{await runner.close();await rm(dir,{recursive:true,force:true});}};
}
test('critic: unavailable topology on resume preserves original unfinished campaign',async()=>{
 const f=await fixture({}, {readiness:()=>({state:'OFFLINE'})});
 try{
  assert.throws(()=>f.runner.start({scenarioId:'WAIT',repetitions:1,resume:true}),e=>e.code==='TOPOLOGY_NOT_READY');
  assert.equal(f.runner.unfinished()?.campaignId,original.campaignId);
 }finally{await f.cleanup();}
});
test('critic: resume readiness checks persisted execution context',async()=>{
 let executed=0;
 const f=await fixture({}, {readiness:context=>({state:context?.target==='new'?'READY':'OFFLINE'}),runOnce:async()=>{executed++;return {state:'MEASURED'};}});
 try{
  assert.throws(()=>f.runner.start({scenarioId:'WAIT',repetitions:1,resume:true,context:{target:'new'}}),e=>e.code==='TOPOLOGY_NOT_READY');
  assert.equal(executed,0);
 }finally{await f.cleanup();}
});
test('critic: malformed persisted bounds cannot bypass resumed repetition and timeout limits',async()=>{
 const f=await fixture({totalRuns:3,timeout:0});
 try{
  assert.equal(f.runner.unfinished()?.unreadable,true);
  assert.throws(()=>f.runner.start({scenarioId:'WAIT',repetitions:1,resume:true}),e=>e.code==='RESUME_CONFLICT');
 }finally{await f.cleanup();}
});
test('critic: bounded close uses elapsed wall time with frozen research clock',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex803-critic-'));let release;
 const runner=createScenarioRunner({dir,scenarios:[{id:'WAIT'}],clock:()=>0,runOnce:()=>new Promise(resolve=>{release=resolve;})});
 try{
  runner.start({scenarioId:'WAIT',repetitions:1,timeout:150});
  await sleep(2);
  const bounded=await Promise.race([runner.close({timeoutMs:10}).then(()=>true),sleep(40).then(()=>false)]);
  assert.equal(bounded,true,'close must return within wall-clock bound even when injected clock is frozen');
 }finally{
  release?.({state:'MEASURED'});
  await runner.close();
  await rm(dir,{recursive:true,force:true});
 }
});
