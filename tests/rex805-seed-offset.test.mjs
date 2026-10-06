import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createScenarioRunner, runSeed} from '../services/dev-gateway/scenario-runner.mjs';

const withDir = async fn => {const dir=await mkdtemp(resolve('.scratch-rex805-seed-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};
const settle=async runner=>{for(let i=0;i<100&&runner.progress().state==='RUNNING';i++)await new Promise(r=>setTimeout(r,5));return runner.progress();};
const options=dir=>({dir,scenarios:[{id:'WAIT'}],runOnce:async({seed})=>({state:'MEASURED',result:{seed}})});

test('REX805 selected index1 preserves original derived seed under new run index0',async()=>withDir(async dir=>{
 const runner=createScenarioRunner(options(dir));
 runner.start({scenarioId:'WAIT',repetitions:1,seed:'original',seedIndexOffset:1});
 const progress=await settle(runner);
 assert.equal(progress.measured[0].index,0);
 assert.equal(progress.measured[0].seed,runSeed('original',1));
 assert.equal(progress.seedIndexOffset,1);
 assert.equal(runner.receipt(progress.campaignId).seedIndexOffset,1);
 await runner.close();
}));

test('REX805 offset is bounded, typed and checked before creating work',async()=>withDir(async dir=>{
 const runner=createScenarioRunner(options(dir));
 for(const offset of [-1,20000,1.1,'1'])assert.throws(()=>runner.start({scenarioId:'WAIT',repetitions:1,seedIndexOffset:offset}),{code:'SEED_INDEX_INVALID'});
 assert.equal(runner.progress().state,'IDLE');
 await runner.close();
}));

test('REX805 interrupted recovery and resume retain offset and refuse offset drift',async()=>withDir(async dir=>{
 const record={campaignId:'campaign-00000000-0000-0000-0000-000000000005',scenarioId:'WAIT',state:'RUNNING',reason:null,repetitions:2,warmup:0,totalRuns:2,runs:[],timeout:1000,startedAt:Date.now(),campaignSeed:'original',seedIndexOffset:7,limits:{},context:null};
 await writeFile(resolve(dir,'scenario-campaign.json'),JSON.stringify(record));
 const runner=createScenarioRunner(options(dir));
 assert.equal(runner.progress().notMeasured[0].seed,runSeed('original',7));
 assert.throws(()=>runner.start({scenarioId:'WAIT',repetitions:2,seed:'original',timeout:1000,resume:true,seedIndexOffset:8}),{code:'RESUME_CONFLICT'});
 runner.start({scenarioId:'WAIT',repetitions:2,seed:'original',timeout:1000,resume:true,seedIndexOffset:7});
 assert.equal((await settle(runner)).measured[0].seed,runSeed('original',8));
 await runner.close();
}));
