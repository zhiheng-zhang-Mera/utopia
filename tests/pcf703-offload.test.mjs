// PCF-703 acceptance (plan half): the explicit versioned DAG, the canonical stage runner and the offload decision.
//
// The stream half of this workbook lives in tests/pcf703-bounded-stream.test.mjs. This file is the workbook-named
// acceptance file and covers the other three bullets: a plan is DECLARED (never inferred from free text), stage
// execution runs through PCF-704 admission, the PCF-710 executor and PCF-709 artifacts while keeping one canonical
// task/action/origin/session, and an unprofitable or unauthorised offload is the approved local path or a typed
// refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileExecutionPlan, executeStages, stageOrder, runExecutionPlan, EXECUTION_PLAN_VERSION, STAGE_DECLARATIONS} from '../services/personal-compute-fabric/pipeline.mjs';
import {chooseTransport, STREAM_LIMITS} from '../services/personal-compute-fabric/bounded-stream.mjs';
import {Store} from '../services/dev-gateway/store.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {createArtifactStore} from '../services/personal-compute-fabric/artifacts.mjs';
import {resolveEffectivePolicy} from '../services/personal-compute-fabric/policy.mjs';
import {CPU_PROVIDER_REF} from '../services/personal-compute-fabric/executor.mjs';
import {cpus, freemem, platform} from 'node:os';

const stage = (id, dependsOn = [], extra = {}) => ({id, dependsOn, writeScope: [], inputSchema: 'cpu-json-v1', outputSchema: 'cpu-json-v1',
  resources: {cpu: {amount: 1, unit: 'millicores'}}, permissions: ['process:own-child'], sideEffects: 'NONE', deadlineAt: null,
  checkpoint: {resumable: false, capabilityRef: null}, placement: {strategy: 'COMPOSITE'}, executor: {providerRef: CPU_PROVIDER_REF, providerVersion: 1}, ...extra});
const request = (stages, extra = {}) => ({version: EXECUTION_PLAN_VERSION, stages, ...extra});
const values = Array.from({length: 64}, (_, index) => 64 - index);

test('PCF703-01 a self-describing plan must declare every stage field, and an undeclared one is refused by name', () => {
  const plan = compileExecutionPlan(request([stage('extract'), stage('sum', ['extract'])]));
  assert.equal(plan.declaration, 'SELF_DESCRIBING_V2');
  assert.equal(plan.selfDescribing, true);
  assert.deepEqual(plan.notSelfDescribing, []);
  assert.deepEqual(plan.stages[0].resources, {cpu: {amount: 1, unit: 'millicores'}});
  assert.deepEqual(plan.stages[0].checkpoint, {resumable: false, capabilityRef: null});
  assert.deepEqual(plan.stages[0].executor, {providerRef: CPU_PROVIDER_REF, providerVersion: 1});
  // Every stage declaration the workbook names is covered by one broken variant below.
  assert.deepEqual(STAGE_DECLARATIONS, ['inputSchema', 'outputSchema', 'resources', 'permissions', 'sideEffects', 'deadlineAt', 'checkpoint', 'placement', 'executor']);
  const broken = [
    [{inputSchema: undefined}, /STAGE_SCHEMA_REQUIRED/],
    [{outputSchema: undefined}, /STAGE_SCHEMA_REQUIRED/],
    [{resources: undefined}, /STAGE_RESOURCES_REQUIRED/],
    [{resources: {cpu: {amount: 1, unit: 'cores'}}}, /STAGE_RESOURCE_UNIT_CONFLICT/],
    [{resources: {gpu: {amount: 1, unit: 'devices'}}}, /STAGE_RESOURCE_KIND_UNKNOWN/],
    [{permissions: undefined}, /STAGE_PERMISSIONS_REQUIRED/],
    [{sideEffects: 'MAYBE'}, /STAGE_SIDE_EFFECTS_UNKNOWN/],
    [{deadlineAt: 'soon'}, /STAGE_DEADLINE_INVALID/],
    [{checkpoint: {resumable: true, capabilityRef: null}}, /STAGE_CHECKPOINT_INVALID/],
    [{placement: {strategy: 'LEARNED'}}, /STAGE_PLACEMENT_UNKNOWN/],
    [{executor: undefined}, /STAGE_EXECUTOR_REQUIRED/],
    [{executor: {providerRef: 'x', providerVersion: 0}}, /STAGE_EXECUTOR_REQUIRED/],
  ];
  for (const [override, expected] of broken) assert.throws(() => compileExecutionPlan(request([{...stage('s'), ...override}])), expected, JSON.stringify(override));
  // An undeclared FIELD is refused too, so a generated plan cannot smuggle an extra instruction into execution.
  assert.throws(() => compileExecutionPlan(request([{...stage('s'), shellCommand: 'rm -rf /'}])), /STAGE_UNKNOWN_FIELD:shellCommand/);
  assert.throws(() => compileExecutionPlan(request([{...stage('s'), prompt: 'split this program however you like'}])), /STAGE_UNKNOWN_FIELD:prompt/);
  // A version nobody declared is refused rather than treated as the newest one.
  assert.throws(() => compileExecutionPlan({version: 3, stages: [stage('s')]}), /DAG_VERSION_OR_LIMIT/);
});

test('PCF703-02 the legacy plan still compiles, but it is labelled and it cannot be executed canonically', async () => {
  const legacy = compileExecutionPlan({version: 1, stages: [{id: 'a', dependsOn: [], writeScope: []}, {id: 'b', dependsOn: ['a'], writeScope: []}]});
  assert.equal(legacy.declaration, 'LEGACY_V1_NOT_SELF_DESCRIBING');
  assert.equal(legacy.selfDescribing, false);
  assert.deepEqual(legacy.notSelfDescribing.map(entry => entry.stageId), ['a', 'b']);
  assert.ok(legacy.notSelfDescribing[0].missing.includes('resources'));
  assert.ok(legacy.notSelfDescribing[0].missing.includes('placement'));
  // PCF-708 requires the legacy shape to keep working on the callback seam...
  const output = await runExecutionPlan(legacy, async (entry, inputs) => entry.id === 'b' ? inputs.a + 1 : 1, {concurrency: 2});
  assert.equal(output.b, 2);
  // ...but a stage whose resources and placement were never declared cannot be admitted to a real machine.
  await assert.rejects(() => executeStages({plan: legacy, stages: []}), /PLAN_NOT_SELF_DESCRIBING/);
});

test('PCF703-03 the DAG itself stays explicit, acyclic, bounded and free of unordered write conflicts', () => {
  assert.deepEqual(stageOrder(request([stage('c', ['a', 'b']), stage('a'), stage('b')])).map(entry => entry.id), ['a', 'b', 'c']);
  assert.throws(() => compileExecutionPlan(request([stage('a', ['b']), stage('b', ['a'])])), /DAG_CYCLE_OR_MISSING/);
  assert.throws(() => compileExecutionPlan(request([stage('a', ['ghost'])])), /DAG_CYCLE_OR_MISSING/);
  assert.throws(() => compileExecutionPlan(request([stage('a'), stage('a')])), /STAGE_DUPLICATE:a/);
  assert.throws(() => compileExecutionPlan(request([stage('a', [], {writeScope: ['repo']}), stage('b', [], {writeScope: ['repo/src']})])), /PARALLEL_WRITE_CONFLICT/);
  // Two writers on one path are fine when the order IS declared.
  assert.equal(compileExecutionPlan(request([stage('a', [], {writeScope: ['repo']}), stage('b', ['a'], {writeScope: ['repo/src']})])).stages.length, 2);
  assert.throws(() => compileExecutionPlan(request(Array.from({length: 65}, (_, index) => stage('s' + index)))), /DAG_VERSION_OR_LIMIT/);
  // A stalled plan must not hang: a dependency that can never be satisfied is refused at compile time.
  assert.throws(() => compileExecutionPlan(request([stage('a', ['b']), stage('b', ['a'])])), /DAG_CYCLE_OR_MISSING/);
});

test('PCF703-04 stage execution goes through 704 admission, the 710 executor and 709 artifacts under one task truth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf703-stages-'));
  let store;
  try {
    store = new Store(dir);
    store.put('tasks', {id: 'T-1', state: 'QUEUED', actionId: 'A-1', originDeviceId: 'alien', parentSessionId: 'S-1'});
    const owner = createCanonicalStateAdapter(store);
    const artifacts = createArtifactStore({root: join(dir, 'artifacts'), maxBytes: 16777216, maxItems: 128, authorize: () => true});
    const now = Date.now();
    const policy = resolveEffectivePolicy({}, {version: 7, authorized: true, expiresAt: now + 60000, originDeviceId: 'alien', allowedDevices: ['alien'],
      dataScopes: ['PUBLIC'], sharingConsent: false, cloudConsent: false, budget: 0}, now);
    const candidate = {deviceId: 'alien', bootId: 'boot-1', trusted: true, authorized: true, executorReady: true, sharing: true, platform: platform(),
      provider: {version: 1, id: CPU_PROVIDER_REF, ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'},
      observationVersion: 1, observedAt: now, validUntil: now + 30000, free: {cpu: cpus().length, memory: freemem()}, queueMs: 0,
      cost: {inputMs: [0, 10], coldStartMs: [0, 2000], executeMs: [0, 5000], returnMs: [0, 10]}};
    const workload = {version: 1, taskId: 'T-1', actionId: 'A-1', originDeviceId: 'alien', parentSessionId: 'S-1', appId: 'app', kind: 'CPU_JSON',
      capabilities: ['cpu.json'], resources: {cpu: 1, memory: 1048576}, dataScope: 'PUBLIC', qos: 'BATCH', retryClass: 'PURE', inputRefs: [], writeScope: [], outputSchema: 'json', deadlineAt: now + 60000};
    const envelope = {envelopeVersion: 2, taskId: 'T-1', actionId: 'A-1', originDeviceId: 'alien', parentSessionId: 'S-1', appId: 'app', targetDeviceRef: 'alien',
      executor: {providerRef: CPU_PROVIDER_REF, providerVersion: 1, providerManifestRef: 'manifest:' + CPU_PROVIDER_REF}, inputSchema: 'cpu-json-v1', outputSchema: 'cpu-json-v1',
      capabilities: ['cpu.json'], inputRefs: [], writeScope: [], platform: {os: [platform()], arch: [process.arch]}, qos: 'BATCH', retrySafety: 'SIDE_EFFECT_FREE',
      dataScope: 'PUBLIC', consent: {required: false, scopeRef: null}, resources: {cpu: {amount: 1, unit: 'millicores'}}, deadlineAt: now + 60000, missPolicy: 'REFUSE',
      privilegeRequests: [], labels: {}};
    const plan = compileExecutionPlan(request([stage('sort'), stage('sum', ['sort'], {resources: {cpu: {amount: 1, unit: 'millicores'}}})]));
    const report = await executeStages({plan, owner, artifacts, workload, policy, candidate, envelope, deviceId: 'alien', bootId: 'boot-1', holder: 'alien',
      stages: [{stageId: 'sort', operation: 'SORT', values}, {stageId: 'sum', operation: 'SUM', values: [1, 2, 3, 4]}]});
    assert.equal(report.state, 'COMPLETED');
    assert.equal(report.completedStages, 2);
    assert.equal(report.notRunStages, 0);
    assert.equal(report.oneTaskTruth, true);
    assert.equal(report.concurrentStages, false, 'one canonical task means one reservation at a time, and the report says so');
    assert.deepEqual(report.canonical, {taskId: 'T-1', actionId: 'A-1', originDeviceId: 'alien', parentSessionId: 'S-1'});
    assert.deepEqual(report.finalOutput.sum, 10);
    // Each stage kept its own attempt, and the canonical task stayed a single truth through both of them.
    assert.notEqual(report.stages[0].attemptId, report.stages[1].attemptId);
    assert.equal(report.stages[1].epoch > report.stages[0].epoch, true, 'every stage is a new attempt with a new epoch');
    assert.equal(store.get('tasks', 'T-1').state, 'COMPLETED');
    assert.equal(store.get('tasks', 'T-1').actionId, 'A-1', 'canonical ownership is unchanged by the stages');
    assert.equal(store.get('tasks', 'T-1').originDeviceId, 'alien');
    // Inputs and outputs really travelled through the artifact store, with digests on both sides.
    for (const entry of report.stages) {
      assert.equal(entry.inputDigest.length, 64);
      assert.equal(entry.outputDigest.length, 64);
      assert.equal(entry.outputRef.digest, entry.outputDigest);
    }
    assert.equal(owner.snapshot().reservations.length, 0, 'every stage released its reservation');
    assert.equal(owner.snapshot().attempts.length, 2);
  } finally { store?.db.close(); await rm(dir, {recursive: true, force: true}); }
});

test('PCF703-05 a failed stage stops the pipeline and everything downstream is NOT_RUN, never a silent success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf703-stage-fail-'));
  let store;
  try {
    store = new Store(dir);
    store.put('tasks', {id: 'T-2', state: 'QUEUED', actionId: 'A-2', originDeviceId: 'alien', parentSessionId: 'S-2'});
    const owner = createCanonicalStateAdapter(store);
    const artifacts = createArtifactStore({root: join(dir, 'artifacts'), maxBytes: 16777216, maxItems: 128, authorize: () => true});
    const now = Date.now();
    const policy = resolveEffectivePolicy({}, {version: 7, authorized: true, expiresAt: now + 60000, originDeviceId: 'alien', allowedDevices: ['alien'],
      dataScopes: ['PUBLIC'], sharingConsent: false, cloudConsent: false, budget: 0}, now);
    const candidate = {deviceId: 'alien', bootId: 'boot-2', trusted: true, authorized: true, executorReady: true, sharing: true, platform: platform(),
      provider: {version: 1, id: CPU_PROVIDER_REF, ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'},
      observationVersion: 1, observedAt: now, validUntil: now + 30000, free: {cpu: cpus().length, memory: freemem()}, queueMs: 0,
      cost: {inputMs: [0, 10], coldStartMs: [0, 2000], executeMs: [0, 5000], returnMs: [0, 10]}};
    const workload = {version: 1, taskId: 'T-2', actionId: 'A-2', originDeviceId: 'alien', parentSessionId: 'S-2', appId: 'app', kind: 'CPU_JSON',
      capabilities: ['cpu.json'], resources: {cpu: 1, memory: 1048576}, dataScope: 'PUBLIC', qos: 'BATCH', retryClass: 'PURE', inputRefs: [], writeScope: [], outputSchema: 'json', deadlineAt: now + 60000};
    const envelope = {envelopeVersion: 2, taskId: 'T-2', actionId: 'A-2', originDeviceId: 'alien', parentSessionId: 'S-2', appId: 'app', targetDeviceRef: 'alien',
      executor: {providerRef: CPU_PROVIDER_REF, providerVersion: 1, providerManifestRef: 'manifest:' + CPU_PROVIDER_REF}, inputSchema: 'cpu-json-v1', outputSchema: 'cpu-json-v1',
      capabilities: ['cpu.json'], inputRefs: [], writeScope: [], platform: {os: [platform()], arch: [process.arch]}, qos: 'BATCH', retrySafety: 'SIDE_EFFECT_FREE',
      dataScope: 'PUBLIC', consent: {required: false, scopeRef: null}, resources: {cpu: {amount: 1, unit: 'millicores'}}, deadlineAt: now + 60000, missPolicy: 'REFUSE',
      privilegeRequests: [], labels: {}};
    const plan = compileExecutionPlan(request([stage('first'), stage('second', ['first'])]));
    // The first stage's own overflow check makes the worker exit non-zero, and the pipeline must not paper over it.
    const report = await executeStages({plan, owner, artifacts, workload, policy, candidate, envelope, deviceId: 'alien', bootId: 'boot-2', holder: 'alien',
      stages: [{stageId: 'first', operation: 'SUM', values: [1e308, 1e308]}, {stageId: 'second', operation: 'SORT', values}]});
    assert.equal(report.state, 'FAILED');
    assert.equal(report.completedStages, 0);
    assert.equal(report.notRunStages, 1);
    assert.equal(report.finalOutput, null);
    assert.equal(report.stages[0].outcome, 'FAILED');
    assert.equal(report.stages[0].output, null);
    assert.equal(report.stages[1].outcome, 'NOT_RUN');
    assert.match(report.stages[1].reason, /UPSTREAM_STAGE_FAILED:first/);
    // The failure is a committed canonical fact, not a gap in the record.
    assert.equal(store.get('tasks', 'T-2').state, 'FAILED');
    assert.equal(owner.snapshot().reservations.length, 0);
  } finally { store?.db.close(); await rm(dir, {recursive: true, force: true}); }
});

test('PCF703-06 an unprofitable, unauthorised or oversized offload is the approved local path or a typed refusal', () => {
  // Unstable link, real transfer cost and an oversized payload each settle on the DECLARED local path when there is one.
  assert.equal(chooseTransport({authorised: true, linkStable: false, localAvailable: true}).choice, 'LOCAL');
  assert.equal(chooseTransport({authorised: true, linkStable: false, localAvailable: true}).reason, 'LINK_UNSTABLE');
  assert.equal(chooseTransport({authorised: true, linkStable: true, transportCostMinor: 1, localAvailable: true}).reason, 'TRANSFER_COST');
  assert.equal(chooseTransport({authorised: true, linkStable: true, transferBytes: STREAM_LIMITS.maxBytes + 1, localAvailable: true}).reason, 'TRANSFER_TOO_LARGE');
  // With no approved local path the answer is a refusal, and the destination is never changed silently.
  for (const input of [{authorised: false, localAvailable: false}, {authorised: true, linkStable: false, localAvailable: false},
    {authorised: true, linkStable: true, transportCostMinor: 1, localAvailable: false}]) {
    assert.equal(chooseTransport(input).choice, 'REFUSED');
    assert.equal(chooseTransport(input).permitsOffload, false);
  }
  // An undeclared local path is not an assumption this project is allowed to make.
  assert.equal(chooseTransport({authorised: false}).choice, 'REFUSED');
  assert.equal(chooseTransport({authorised: false}).localDeclared, false);
  // The only case that permits moving bytes, and it is the one with authorisation, a stable link, no cost and a fit.
  const offload = chooseTransport({authorised: true, linkStable: true, transportCostMinor: 0, transferBytes: 1024});
  assert.equal(offload.choice, 'OFFLOAD');
  assert.equal(offload.permitsOffload, true);
});
