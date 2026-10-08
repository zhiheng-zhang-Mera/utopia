import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngineeringTools} from '../services/personal-compute-fabric/engineering-tools.mjs';
test('facade forwards canonical receipts and keeps delivered distinct from consumed',async()=>{
 const calls=[];const service=Object.fromEntries(['submit','inspect','cancel','collect','acknowledge'].map(name=>[name,async(...args)=>{calls.push([name,...args]);return {taskId:'t',delivered:name==='collect',consumed:name==='acknowledge'};}]));
 const tools=createEngineeringTools(service,{sessionId:'s',deviceId:'d',authorize:async()=>true});
 await tools.submitRemoteJob({parentSessionId:'s'});assert.equal((await tools.collectRemoteResult('t')).consumed,false);assert.equal((await tools.acknowledgeRemoteResult('t','digest')).consumed,true);assert.equal(calls.length,3);
 await assert.rejects(tools.submitRemoteJob({parentSessionId:'foreign'}),/CALLER_BINDING/);
});
test('each invocation rechecks current authority including retrieval',async()=>{
 let allowed=true;const service=Object.fromEntries(['submit','inspect','cancel','collect','acknowledge'].map(name=>[name,async()=>({})]));const tools=createEngineeringTools(service,{sessionId:'s',deviceId:'d',authorize:async()=>allowed});allowed=false;
 await assert.rejects(tools.collectRemoteResult('t'),/ORIGIN_UNAUTHORIZED/);
});
