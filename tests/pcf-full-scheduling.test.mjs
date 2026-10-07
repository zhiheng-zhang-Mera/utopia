import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../services/dev-gateway/store.mjs';
import {planPlacement} from '../services/personal-compute-fabric/placement.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {admit,release,claimAttempt,commitResult} from '../services/personal-compute-fabric/admission.mjs';
const policy={version:1,authorized:true,originDeviceId:'alien',mode:'TRUSTED_PERSONAL_FABRIC',allowedDevices:['alien','mech'],dataScopes:['PUBLIC'],sharingConsent:true,cloudConsent:false,budget:0,expiresAt:5000};
const w={taskId:'T',appId:'one',originDeviceId:'alien',dataScope:'PUBLIC',kind:'CPU_JSON',capabilities:['cpu.json'],resources:{cpu:1,memory:10},deadlineAt:4000,writeScope:[],qos:'BATCH'};
const candidate=(id,extra={})=>({deviceId:id,bootId:'b',trusted:true,authorized:true,executorReady:true,sharing:true,platform:'win32',provider:{id:'cpu',ready:true,capabilities:['cpu.json'],workloadKinds:['CPU_JSON'],isolation:'COOPERATIVE'},observationVersion:1,observedAt:900,validUntil:3000,free:{cpu:2,memory:100},queueMs:10,cost:{inputMs:[1,2],coldStartMs:[0,1],executeMs:[10,20],returnMs:[1,2]},...extra});
test('702: feasibility precedes ranking; stale/unknown/untrusted/strict/capability constraints cannot win',()=>{
  const p=planPlacement(w,[candidate('mech'),candidate('alien')],policy,1000);assert.equal(p.deviceId,'alien');assert.deepEqual(p.cost.intervalMs,[22,35]);
  for(const change of [{trusted:false},{authorized:false},{executorReady:false},{validUntil:999},{free:{cpu:undefined,memory:100}},{provider:{ready:true,capabilities:[],workloadKinds:['CPU_JSON']}}])assert.equal(planPlacement(w,[candidate('mech',change)],policy,1000).state,'REFUSED');
  assert.equal(planPlacement({...w,strictTargetDeviceId:'ghost'},[candidate('alien')],policy,1000).state,'REFUSED');
});
test('704/712: canonical CAS admission, idempotence, epoch fencing, commit and restart preserve one task truth',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pcf-cas-'));let store;
  try{
    store=new Store(dir);store.put('tasks',{id:'T',state:'QUEUED'});store.put('tasks',{id:'T2',state:'QUEUED'});
    let owner=createCanonicalStateAdapter(store);const p=planPlacement(w,[candidate('alien')],policy,1000);
    const request={workload:w,proposal:p,policy,candidate:candidate('alien'),idempotencyKey:'k',ttlMs:1000,appQuota:{cpu:1,memory:100},now:1000};
    const first=admit(owner,request);assert.equal(first.version,1);assert.equal(admit(owner,request).reservation.id,first.reservation.id);
    assert.throws(()=>admit(owner,{...request,workload:{...w,taskId:'T2'},idempotencyKey:'k2',expectedVersion:0}));
    assert.throws(()=>admit(owner,{...request,workload:{...w,taskId:'T2'},proposal:{...p,taskId:'T2'},idempotencyKey:'k2',expectedVersion:1}));
    const a=claimAttempt(owner,{reservationId:first.reservation.id,holder:'worker',bootId:'b',now:1100});
    assert.throws(()=>claimAttempt(owner,{reservationId:first.reservation.id,holder:'other',bootId:'b',now:1100}));
    store.db.close();store=new Store(dir);owner=createCanonicalStateAdapter(store);
    assert.equal(owner.snapshot().reservations.length,1);
    assert.throws(()=>commitResult(owner,{taskId:'T',attemptId:a.id,epoch:a.epoch-1,holder:'worker',bootId:'b',outcome:'SUCCEEDED',outputDigest:'a'.repeat(64),now:1200}));
    commitResult(owner,{taskId:'T',attemptId:a.id,epoch:a.epoch,holder:'worker',bootId:'b',outcome:'SUCCEEDED',outputDigest:'a'.repeat(64),now:1200});
    assert.equal(store.get('tasks','T').state,'SUCCEEDED');assert.equal(owner.snapshot().reservations.length,0);
    assert.throws(()=>release(owner,{reservationId:first.reservation.id,now:1200}));
  }finally{store?.db.close();await rm(dir,{recursive:true,force:true});}
});
test('704: changed policy/version or observation cannot be admitted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pcf-deny-'));const s=new Store(dir);try{s.put('tasks',{id:'T',state:'QUEUED'});const owner=createCanonicalStateAdapter(s),p=planPlacement(w,[candidate('alien')],policy,1000);const r={workload:w,proposal:p,policy,candidate:candidate('alien'),idempotencyKey:'k',ttlMs:1000,appQuota:{cpu:2,memory:100},now:1000};
 for(const change of [{policy:{...policy,version:2}},{candidate:candidate('alien',{observationVersion:2})},{now:3001},{ttlMs:0}])assert.throws(()=>admit(owner,{...r,...change}));assert.equal(owner.snapshot().reservations.length,0);
 }finally{s.db.close();await rm(dir,{recursive:true,force:true});}
});
