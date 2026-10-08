import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveEffectivePolicy, assertPolicy} from '../services/personal-compute-fabric/policy.mjs';
import {normalizeExecutionProvider, describeExecutorBoundary} from '../services/personal-compute-fabric/executor-provider.mjs';
import {normalizeWorkload} from '../services/personal-compute-fabric/workload.mjs';
import {compileExecutionCapsule, validateResultEnvelope} from '../services/personal-compute-fabric/execution-capsule.mjs';

const now=1000;
const authority={version:3, authorized:true, expiresAt:5000, originDeviceId:'alien', allowedDevices:['alien','mech'], sharingConsent:true, dataScopes:['PUBLIC'], cloudConsent:false, budget:0};
const provider={version:1,id:'cpu', platform:'win32', capabilities:['cpu.json'], workloadKinds:['CPU_JSON'], isolation:'COOPERATIVE', ready:true};
const workload={version:1,taskId:'T1',actionId:'A1',originDeviceId:'alien',parentSessionId:'S1',appId:'app',kind:'CPU_JSON',capabilities:['cpu.json'],resources:{cpu:1,memory:1024},dataScope:'PUBLIC',qos:'BATCH',retryClass:'PURE',inputRefs:[],writeScope:[],outputSchema:'json',deadlineAt:4000};
const policy=()=>resolveEffectivePolicy({mode:'TRUSTED_PERSONAL_FABRIC'},authority,now);
const capsule=()=>compileExecutionCapsule(normalizeWorkload(workload),{attemptId:'X1',epoch:1,executorDeviceId:'mech',bootId:'boot',providerId:'cpu',inputDigest:'a'.repeat(64),policy:policy()},now);

test('706: remote work requires independent authorization, sharing, data scope, expiry and budget',()=>{
  assertPolicy(policy(),{deviceId:'mech',dataScope:'PUBLIC',fee:0},now);
  for(const change of [{authorized:false},{sharingConsent:false},{expiresAt:999},{dataScopes:[]}])
    assert.throws(()=>assertPolicy(resolveEffectivePolicy({mode:'TRUSTED_PERSONAL_FABRIC'},{...authority,...change},now),{deviceId:'mech',dataScope:'PUBLIC',fee:0},now));
  assert.throws(()=>assertPolicy(policy(),{deviceId:'mech',dataScope:'PUBLIC',fee:1,cloud:true},now));
  assert.throws(()=>assertPolicy(policy(),{deviceId:'mech',dataScope:'PUBLIC',fee:0},5000));
  assert.throws(()=>resolveEffectivePolicy({mode:'APPROVED_CLOUD',budget:100},authority,now));
});
test('706: default policy remains origin-only; requests cannot broaden authority',()=>{
  const p=resolveEffectivePolicy({},authority,now);
  assertPolicy(p,{deviceId:'alien',dataScope:'PUBLIC',fee:0},now);
  assert.throws(()=>assertPolicy(p,{deviceId:'mech',dataScope:'PUBLIC',fee:0},now));
  assert.throws(()=>resolveEffectivePolicy({mode:'TRUSTED_PERSONAL_FABRIC',allowedDevices:['stranger']},authority,now));
});
test('725: provider capabilities are typed; cooperative process cannot claim hard isolation',()=>{
  const p=normalizeExecutionProvider(provider);
  assert.equal(describeExecutorBoundary(p).enforcement,'COOPERATIVE');
  assert.throws(()=>normalizeExecutionProvider({...provider,isolation:'MAGIC'}));
  assert.throws(()=>normalizeExecutionProvider({...provider,version:2}));
  assert.throws(()=>describeExecutorBoundary(p,{requireHardIsolation:true}));
});
test('708: canonical identity preserved; numeric/resource/QoS/version/depth inputs fail closed',()=>{
  const w=normalizeWorkload(workload);assert.equal(w.taskId,'T1');assert.ok(Object.isFrozen(w.resources));
  for(const change of [{version:99},{resources:{cpu:-1,memory:0}},{resources:{cpu:1,memory:NaN}},{qos:'MAGIC'},{retryClass:'MAGIC'},{parentSessionId:''}]) assert.throws(()=>normalizeWorkload({...workload,...change}));
  const nested={};let p=nested;for(let i=0;i<40;i++){p.child={};p=p.child;}
  assert.throws(()=>normalizeWorkload({...workload,metadata:nested}));
});
test('726: capsule binds immutable task/session/attempt/host/boot/epoch/digest; receipt is untrusted',()=>{
  const c=capsule();assert.ok(Object.isFrozen(c));
  const receipt={version:1,taskId:'T1',actionId:'A1',parentSessionId:'S1',attemptId:'X1',epoch:1,executorDeviceId:'mech',bootId:'boot',providerId:'cpu',inputDigest:'a'.repeat(64),outputDigest:'b'.repeat(64),outcome:'SUCCEEDED',exitCode:0,policyVersion:3};
  assert.equal(validateResultEnvelope(c,receipt,{policy:policy(),now}).outcome,'SUCCEEDED');
  for(const change of [{epoch:0},{parentSessionId:'other'},{bootId:'old'},{inputDigest:'c'.repeat(64)},{outputDigest:null},{exitCode:1},{outcome:'PASS'},{policyVersion:2}]) assert.throws(()=>validateResultEnvelope(c,{...receipt,...change},{policy:policy(),now}));
  assert.throws(()=>validateResultEnvelope(c,receipt,{policy:policy(),now:6000}));
});
