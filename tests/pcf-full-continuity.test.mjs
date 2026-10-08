import test from 'node:test';import assert from 'node:assert/strict';
import {planRecovery} from '../services/personal-compute-fabric/recovery.mjs';
import {reconcileExecution} from '../services/personal-compute-fabric/supervisor.mjs';
import {evaluateInterference} from '../services/personal-compute-fabric/interference.mjs';
import {projectOrigin} from '../services/personal-compute-fabric/origin-projection.mjs';
import {createOriginAgentBridge} from '../services/personal-compute-fabric/origin-agent-bridge.mjs';
import {bindEngineeringExecutor} from '../services/personal-compute-fabric/engineering-executor-adapter.mjs';
import {CONNECTOR_PORT} from '../contracts/engineering-reference-connectors-v1/reference-connectors.mjs';
test('705: side-effect unknown/strict target/still-live worker cannot silently retry',()=>{
 const context={authorized:true,previousStopped:true,checkpointCompatible:true,cooldownUntil:0,now:100};
 assert.equal(planRecovery({retryClass:'PURE'},context).action,'RETRY');assert.equal(planRecovery({retryClass:'CHECKPOINTABLE'},context).action,'RESTORE');
 for(const change of [{retryClass:'NON_RETRYABLE'},{retryClass:'SIDE_EFFECT_UNKNOWN'},{retryClass:'MAGIC'},{retryClass:'PURE',strictTargetDeviceId:'mech'}])assert.equal(planRecovery(change,{...context,newDeviceId:'alien'}).action,'ATTENTION');
 assert.equal(planRecovery({retryClass:'PURE'},{...context,previousStopped:false}).action,'ATTENTION');
});
test('712: reconciliation is bounded and proposes, never invents task/stop proof or repeats live start',()=>{
 assert.deepEqual(reconcileExecution({reservations:[],attempts:[]},[],1000),[]);
 const snapshot={reservations:[{id:'r',state:'LEASED',expiresAt:2000,taskId:'T'}],attempts:[]};assert.equal(reconcileExecution(snapshot,[],1000)[0].action,'START_APPROVED_ATTEMPT');
 assert.equal(reconcileExecution({...snapshot,attempts:[{taskId:'T',state:'RUNNING',holder:'h',bootId:'b'}]},[{holder:'h',bootId:'b',alive:true}],1000).length,0);
 assert.equal(reconcileExecution({...snapshot,attempts:[{taskId:'T',state:'RUNNING',holder:'h',bootId:'b'}]},[],1000)[0].action,'ATTENTION_UNKNOWN_WORKER');
});
test('713: stale SLO observations and unknown preference cannot trigger irreversible/paid/offload change',()=>{
 const settings={enabled:true,targetMs:100,cooldownMs:50,minimumDwellMs:50,allowedOptions:['REDUCE_PARALLELISM']},state={lastChangedAt:0,level:0};
 assert.equal(evaluateInterference(settings,{observedAt:90,validUntil:200,latencyMs:150},state,100).action,'REDUCE_PARALLELISM');
 assert.equal(evaluateInterference(settings,{observedAt:90,validUntil:99,latencyMs:150},state,100).action,'REMEASURE');
 assert.equal(evaluateInterference({...settings,allowedOptions:['PAID_CLOUD']},{observedAt:90,validUntil:200,latencyMs:150},state,100).action,'SLO_UNSATISFIABLE');
});
test('714: origin projection requires current session ownership and bounded gap-aware deduplicated cursor',()=>{
 const task={id:'T',actionId:'A',originDeviceId:'alien',parentSessionId:'S',state:'COMPLETED',pcfResult:{value:42}};const auth={authorized:true,sessionId:'S',deviceId:'alien'};
 const events=[{seq:3,taskId:'T',type:'done'},{seq:3,taskId:'T',type:'done'}];const p=projectOrigin(task,events,{auth,after:0,limit:10});assert.equal(p.gap,true);assert.equal(p.events.length,1);assert.equal(p.result.value,42);
 assert.throws(()=>projectOrigin(task,events,{auth:{...auth,sessionId:'other'},after:0,limit:10}));
});
test('728: bridge uses canonical methods; result delivery is distinct from explicit session consumption',async()=>{
 const task={id:'T',actionId:'A',originDeviceId:'alien',parentSessionId:'S',state:'COMPLETED',pcfResult:{digest:'a'.repeat(64)}};let consumed=false;
 const bridge=createOriginAgentBridge({submit:async()=>task,get:async()=>task,cancel:async()=>task,markConsumed:async()=>{consumed=true;}},{authorize:async c=>c.sessionId==='S'&&c.deviceId==='alien'});
 const context={sessionId:'S',deviceId:'alien'};assert.equal((await bridge.collect('T',context)).consumed,false);assert.equal(consumed,false);await bridge.acknowledge('T',context,task.pcfResult.digest);assert.equal(consumed,true);await assert.rejects(()=>bridge.collect('T',{...context,sessionId:'other'}));
});
test('727: actual ConnectorPort methods required; missing runtime stays unavailable, no CPU substitution',async()=>{
 const connector=Object.fromEntries(CONNECTOR_PORT.methods.map(k=>[k,async()=>({state:'UNKNOWN'})]));connector.readiness=async()=>({state:'NOT_READY'});
 const adapter=bindEngineeringExecutor(connector,{id:'codex',version:1});assert.equal((await adapter.readiness()).state,'NOT_READY');await assert.rejects(()=>adapter.submit({}));assert.throws(()=>bindEngineeringExecutor({submit:()=>{}},{id:'fake',version:1}));
});
