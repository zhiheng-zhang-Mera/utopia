// PCF-721 — controlled systems study, CONTRACT half (workbook: PCF-721-controlled-systems-study.md).
//
// `tests/pcf721-study.test.mjs` already covers the real local study run (trials, canonical refs, trace replay, digests,
// source identity, report persistence). This file is the CONTRACT half and deliberately does NOT re-run that study:
//
//   line 45  freeze hypotheses, conditions, repetitions/stopping, analysis, hardware/cache/network controls and the
//            failure-counting rule before the pilot; compare compatible / capability-only / load-only / PCF policies
//            under an identical safety floor;
//   line 46  bind every trial to the exact runtime/policy/executor/input identity; a simulated or recorded trace is NOT
//            a real run and a counterfactual difference is NOT a measured benefit;
//   line 47  inject the declared fault classes through the real REX fault API (disconnection, worker crash, stale,
//            duplicate, storage failure), keep controller restart separate from worker failover, and never call it HA;
//   line 48  controlled ablation and an independent rebuild; failure, no-benefit and unfavourable samples are KEPT;
//   line 49  the artifact pack: manifest, sanitized dataset, commands, raw refs/digests, environment/versions,
//            statistical output and limitations, with cold/warm cache handling reproducible;
//   line 51  acceptance: no real runner/export means no COMPLETE, and simulation cannot replace execution.
//
// No product file was changed for these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {freezeStudy, toResearchEvent, createResearchAdapter, replayDecisions} from '../services/personal-compute-fabric/research-adapter.mjs';
import {freezeResearchStudy} from '../services/personal-compute-fabric/research-study.mjs';
import {planPlacement, PLACEMENT_STRATEGIES} from '../services/personal-compute-fabric/placement.mjs';
import {resolveEffectivePolicy} from '../services/personal-compute-fabric/policy.mjs';
import {assessOptionalReadiness} from '../services/personal-compute-fabric/optional-readiness.mjs';
import {buildArtifact, artifactFiles, checksumsFor, metricsCsv, NOT_MEASURED} from '../services/dev-gateway/research/artifact.mjs';
import {createFaultController, FAULT_KINDS} from '../services/dev-gateway/research/faults.mjs';
import {Store} from '../services/dev-gateway/store.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {admit, claimAttempt, recordOwnedProcess} from '../services/personal-compute-fabric/admission.mjs';
import {recoverStoppedAttempt} from '../services/personal-compute-fabric/recovery-controller.mjs';
import {reconcileExecution} from '../services/personal-compute-fabric/supervisor.mjs';
import {planRecovery} from '../services/personal-compute-fabric/recovery.mjs';
import {createFabricService} from '../services/personal-compute-fabric/service.mjs';

const SHA = 'a'.repeat(40);
const FAR = 4e12;
const HOUR = 3600000;
// A frozen study configuration of the shape the runner accepts; each test perturbs exactly one clause of it.
const study = () => ({version: 1, id: 'pcf-study', repetitions: 3, stopAfterMs: 60000, softwareSha: SHA,
  workloads: ['cpu-sort', 'cpu-sum'], hypotheses: ['The fabric does not reduce completion latency'], evidenceClass: 'ACTUAL_LOCAL_CPU',
  inputs: {'cpu-sort': {values: [3, 1, 2]}, 'cpu-sum': {values: [3, 1, 2]}},
  controls: {hardware: 'host-local workbench', cache: 'UNCONTROLLED: cold cache not enforced', network: 'NO_REMOTE_EXECUTION'},
  analysis: 'DESCRIPTIVE_ONLY', failureCounting: 'KEEP_ALL'});
const studyPolicy = Object.freeze({version: 1, authorized: true, originDeviceId: 'alien', mode: 'TRUSTED_PERSONAL_FABRIC',
  allowedDevices: ['alien', 'linux-1'], dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: FAR});
const studyWorkload = (extra = {}) => ({taskId: 'T', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S', appId: 'cpu-sum', dataScope: 'PUBLIC', capabilities: ['cpu.json'],
  kind: 'CPU_JSON', resources: {cpu: 1}, deadlineAt: FAR, writeScope: [], qos: 'BATCH', ...extra});
const studyCandidate = (deviceId, extra = {}) => ({deviceId, bootId: 'b-' + deviceId, trusted: true, authorized: true, executorReady: true, sharing: true,
  platform: 'win32', provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'},
  observationVersion: 1, observedAt: 900, validUntil: FAR, free: {cpu: 8, memory: 100}, queueMs: 5,
  cost: {inputMs: [1, 1], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2]}, ...extra});

test('PCF-721 line 45: hypotheses, conditions, repetitions/stopping, analysis, controls and the failure-counting rule freeze before the pilot and cannot be relabelled', () => {
  const input = study();
  const frozen = freezeResearchStudy(input);
  // The frozen configuration is DETACHED: editing the caller's object afterwards cannot change the study.
  input.inputs['cpu-sort'].values[0] = 9;
  input.controls.cache = 'warm';
  input.workloads.push('cpu-sum');
  assert.equal(frozen.inputs['cpu-sort'].values[0], 3);
  assert.equal(frozen.controls.cache, 'UNCONTROLLED: cold cache not enforced');
  assert.equal(frozen.workloads.length, 2);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.inputs) && Object.isFrozen(frozen.controls));
  // The failure-counting rule is not a reporting preference: dropping failures is refused outright.
  assert.throws(() => freezeResearchStudy({...study(), failureCounting: 'DROP_FAILURES'}), {code: 'STUDY_ANALYSIS'});
  assert.throws(() => freezeResearchStudy({...study(), analysis: 'SIGNIFICANCE_TEST'}), {code: 'STUDY_ANALYSIS'});
  // Simulation is a declared evidence class but never a runnable study label.
  assert.equal(freezeStudy({...study(), evidenceClass: 'SIMULATED'}).evidenceClass, 'SIMULATED');
  assert.throws(() => freezeResearchStudy({...study(), evidenceClass: 'SIMULATED'}), {code: 'STUDY_LOCAL_ONLY'});
  assert.throws(() => freezeResearchStudy({...study(), evidenceClass: 'ACTUAL_CROSS_HOST'}), {code: 'STUDY_LOCAL_ONLY'});
  // Conditions: at least two distinct real software workloads, and every declared control must actually be stated.
  assert.throws(() => freezeResearchStudy({...study(), workloads: ['cpu-sort', 'cpu-sort']}), {code: 'STUDY_WORKLOADS'});
  assert.throws(() => freezeResearchStudy({...study(), workloads: ['cpu-sort', 'glasses-trace']}), {code: 'STUDY_WORKLOADS'});
  assert.throws(() => freezeResearchStudy({...study(), controls: {hardware: 'h', cache: '', network: 'n'}}), {code: 'STUDY_CONTROLS'});
  // Every trial's input identity is declared up front, bounded, and the same shape the frozen digest covers.
  assert.throws(() => freezeResearchStudy({...study(), inputs: {'cpu-sort': {values: [1]}}}), {code: 'STUDY_INPUTS'});
  assert.throws(() => freezeResearchStudy({...study(), inputs: {'cpu-sort': {values: ['x']}, 'cpu-sum': {values: [1]}}}), {code: 'STUDY_INPUTS'});
  // Stopping/repetition bounds and the exact source identity are part of the freeze, not of the report.
  for (const change of [{repetitions: 0}, {repetitions: 1001}, {stopAfterMs: 0}, {stopAfterMs: HOUR + 1}, {softwareSha: 'main'}, {hypotheses: []}, {version: 2}]) {
    assert.throws(() => freezeResearchStudy({...study(), ...change}), {code: 'STUDY_INVALID'});
  }
});

test('PCF-721 line 46: every trial binds the exact runtime/policy/executor/input identity, and neither a simulation nor a recorded trace may claim a measured result', () => {
  const receipt = {version: 1, taskId: 'T', actionId: 'A', attemptId: 'X', executorDeviceId: 'linux-1', bootId: 'boot-1', providerId: 'linux-worker',
    outcome: 'SUCCEEDED', epoch: 4, inputDigest: 'b'.repeat(64), apiToken: 'SECRET-VALUE-MUST-NOT-SURVIVE'};
  const context = {observedAt: '2026-10-07T12:00:00.000Z', policyVersion: 3, runtimeRef: 'runtime:node-24.14.0', phases: {queue: 12},
    runRef: 'study:1', expectedRunRef: 'study:1', headSha: SHA, expectedHeadSha: SHA, sourceRunRef: 'study:0'};
  const event = toResearchEvent(receipt, context);
  // The identity a reviewer needs to rebuild the trial is carried: task/action/attempt, executor device+boot, provider,
  // policy and runtime.
  assert.deepEqual({taskRef: event.refs.taskRef, actionRef: event.refs.actionRef, attemptRef: event.refs.attemptRef,
    deviceRef: event.refs.deviceRef, bootRef: event.refs.bootRef, providerRef: event.refs.providerRef,
    policyRef: event.refs.policyRef, runtimeRef: event.refs.runtimeRef}, {taskRef: 'T', actionRef: 'A', attemptRef: 'X',
    deviceRef: 'linux-1', bootRef: 'boot-1', providerRef: 'linux-worker', policyRef: 'policy:3', runtimeRef: 'runtime:node-24.14.0'});
  assert.equal(event.measurement.performanceClaim, 'MEASURED_LOCALLY');
  // A measurement that was not taken is NOT_OBSERVED with a null value, never an invented zero, and it is named as missing.
  assert.deepEqual({transfer: event.phases.transfer.state, transferMs: event.phases.transfer.ms, execution: event.phases.execution.state},
    {transfer: 'NOT_OBSERVED', transferMs: null, execution: 'NOT_OBSERVED'});
  assert.ok(event.missing.includes('phases.execution'));
  // Counterexample: an execution label without attempt identity is a simulation wearing an execution label.
  assert.throws(() => toResearchEvent({...receipt, epoch: undefined}, context), {code: 'RESEARCH_EVENT_NOT_ACTUAL'});
  assert.throws(() => toResearchEvent({...receipt, inputDigest: undefined}, context), {code: 'RESEARCH_EVENT_NOT_ACTUAL'});
  // Counterexample: a trace recorded from a different run, or from a different source head, is refused rather than
  // recorded as if it belonged to this study.
  assert.throws(() => toResearchEvent(receipt, {...context, runRef: 'study:2'}), {code: 'RESEARCH_EVENT_RUN_MISMATCH'});
  assert.throws(() => toResearchEvent(receipt, {...context, headSha: 'c'.repeat(40)}), {code: 'RESEARCH_EVENT_HEAD_MISMATCH'});
  assert.throws(() => toResearchEvent(receipt, {...context, observedAt: undefined}), {code: 'RESEARCH_EVENT_TIMESTAMP_REQUIRED'});
  assert.throws(() => toResearchEvent({...receipt, outcome: 'PROBABLY'}, context), {code: 'RESEARCH_EVENT_OUTCOME_UNKNOWN'});
  // A simulated decision and a recorded trace carry NO performance claim at all.
  for (const evidenceClass of ['SIMULATED', 'COUNTERFACTUAL_ESTIMATE']) {
    const simulated = toResearchEvent(receipt, {...context, evidenceClass});
    assert.equal(simulated.evidenceClass, evidenceClass);
    assert.equal(simulated.measurement.performanceClaim, 'NONE');
  }
  const recorded = toResearchEvent(receipt, {...context, evidenceClass: 'RECORDED_TRACE'});
  assert.equal(recorded.measurement.performanceClaim, 'NONE');
  assert.equal(recorded.refs.sourceRunRef, 'study:0');
  assert.throws(() => toResearchEvent(receipt, {...context, evidenceClass: 'RECORDED_TRACE', sourceRunRef: undefined}), {code: 'RESEARCH_EVENT_SOURCE_RUN_REQUIRED'});
  // Privacy: a value under a sensitive key is redacted BY NAME and the value itself never reaches the event.
  assert.ok(event.privacy.redactedKeys.includes('apiToken'));
  assert.ok(!JSON.stringify(event).includes('SECRET-VALUE-MUST-NOT-SURVIVE'));
  // What the closed REX schema cannot carry is named instead of silently dropped, and its projection keeps only the
  // references it actually has a slot for.
  assert.ok(event.notRepresentable.includes('phases') && event.notRepresentable.includes('evidenceClass'));
  assert.deepEqual(event.traceProjection.canonicalRefs, {taskRef: 'T', actionRef: 'A', deviceRef: 'linux-1'});
  // Contract-only development may remain separate, but a disabled sidecar records nothing and cannot manufacture evidence.
  const disabled = createResearchAdapter({record: () => true}, {enabled: false});
  assert.equal(disabled.capture({id: 'e', type: 'TASK_CREATED', timestamp: '2026-10-07T12:00:00.000Z', seq: 1, taskId: 'T'}), false);
  assert.deepEqual(disabled.snapshot(), {enabled: false, dropped: 0, captured: 0, events: 0});
});

test('PCF-721 line 47: the declared fault classes are injected through the real REX fault API, scoped to one node, and a controller restart is not a worker failover', async () => {
  assert.deepEqual(FAULT_KINDS, ['HEARTBEAT_LOSS', 'PROVIDER_UNAVAILABLE', 'DELAY_RESULT', 'DUPLICATE_EVENT']);
  const dir = await mkdtemp(join(tmpdir(), 'pcf721-faults-'));
  const rows = [];
  try {
    const controller = createFaultController({dir, node: id => ({online: id === 'target'}),
      trace: {captureCanonical: entry => { rows.push(entry); return true; }}, clock: () => 1000});
    const request = kind => ({kind, nodeId: 'target', durationMs: 50, confirmation: `FAULT:${kind}:target`});

    // The declared scope: canonical node request / research observation only - no OS, network or credential operation.
    const disconnect = controller.start(request('HEARTBEAT_LOSS'));
    assert.equal(disconnect.scope, 'CANONICAL_NODE_REQUEST_OR_RESEARCH_OBSERVATION_ONLY');
    // Disconnection affects exactly the targeted node.
    await assert.rejects(() => controller.before('heartbeat', 'target'), {code: 'FAULT_INJECTED_HEARTBEAT_LOSS'});
    await controller.before('heartbeat', 'other');
    // A worker crash is a request fault for the targeted node only.
    assert.equal((() => { try { controller.start(request('PROVIDER_UNAVAILABLE')); return null; } catch (error) { return error.code; } })(), 'FAULT_TARGET_BUSY');
    // An injection without the explicit confirmation, or without duration bounds, or onto a node that is not live, is refused.
    assert.throws(() => controller.start({...request('PROVIDER_UNAVAILABLE'), confirmation: ''}), {code: 'FAULT_CONFIRMATION_REQUIRED'});
    assert.throws(() => controller.start({...request('PROVIDER_UNAVAILABLE'), durationMs: 30001}), {code: 'INVALID_FAULT'});
    assert.throws(() => controller.start({...request('PROVIDER_UNAVAILABLE'), nodeId: 'ghost', confirmation: 'FAULT:PROVIDER_UNAVAILABLE:ghost'}), {code: 'FAULT_TARGET_NOT_READY'});
    assert.equal(controller.list().automaticResume, false);
    controller.stop(disconnect.faultId);

    // A stale/delayed result is released immediately by an emergency stop instead of blocking an unrelated request.
    const delayController = createFaultController({dir: join(dir, 'delay'), node: () => ({online: true}), trace: {captureCanonical: () => true}, clock: () => 1000});
    const delayed = delayController.start(request('DELAY_RESULT'));
    let released = false;
    const waiting = delayController.before('report', 'target').then(() => { released = true; });
    await delayController.before('report', 'other');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(released, false);
    delayController.stop(delayed.faultId);
    await waiting;
    assert.equal(released, true);
    assert.equal(delayController.get(delayed.faultId).metrics.delayedReportCount, 1);
    delayController.close();

    // A duplicate affects the OBSERVATION only: the same record is observed twice and counted.
    const duplicateController = createFaultController({dir: join(dir, 'dup'), node: () => ({online: true}),
      trace: {captureCanonical: entry => { rows.push(entry); return true; }}, clock: () => 1000});
    const duplicate = duplicateController.start(request('DUPLICATE_EVENT'));
    const before = rows.length;
    duplicateController.capture({id: 'event', actor: 'target', type: 'TASK_RUNNING', taskId: 'task'});
    assert.equal(rows.length - before, 2);
    assert.equal(duplicateController.get(duplicate.faultId).metrics.duplicateObservationCount, 1);
    duplicateController.close();

    // Storage failure is a typed refusal, and a receipt this module cannot read is REPORTED rather than fatal.
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, 'obstruction');
    const unavailable = createFaultController({dir: blocked, node: () => ({online: true}), trace: {captureCanonical: () => true}});
    assert.equal(unavailable.list().storeState, 'UNAVAILABLE');
    await assert.rejects(async () => unavailable.start(request('HEARTBEAT_LOSS')), error => error.code === 'FAULT_STORE_UNAVAILABLE' && error.status === 503);
    await writeFile(join(dir, 'fault-00000000-0000-0000-0000-000000000000.json'), '{not a receipt');
    const withBroken = createFaultController({dir, node: () => ({online: true}), trace: {captureCanonical: () => true}});
    assert.deepEqual(withBroken.list().broken, [{file: 'fault-00000000-0000-0000-0000-000000000000.json', reason: 'UNREADABLE_RECEIPT'}]);

    // Controller restart: an active injection is marked INTERRUPTED with PROCESS_RESTART and is never resumed
    // automatically, so a restart does not silently become a failover.
    const restartDir = join(dir, 'restart');
    const first = createFaultController({dir: restartDir, node: () => ({online: true}), trace: {captureCanonical: () => true}});
    const active = first.start({kind: 'PROVIDER_UNAVAILABLE', nodeId: 'target', durationMs: 30000, confirmation: 'FAULT:PROVIDER_UNAVAILABLE:target'});
    const restarted = createFaultController({dir: restartDir, node: () => ({online: true}), trace: {captureCanonical: () => true}});
    assert.deepEqual({status: restarted.get(active.faultId).status, stopReason: restarted.get(active.faultId).stopReason,
      automaticResume: restarted.list().automaticResume}, {status: 'INTERRUPTED', stopReason: 'PROCESS_RESTART', automaticResume: false});
    // ...and after the restart the node's requests are accepted again: the injection died with the controller.
    await restarted.before('claim', 'target');
    restarted.close();
    first.close();
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('PCF-721 line 47: a controller restart proves nothing about the worker, worker failover demands stop proof, and neither is reported as high availability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf721-restart-'));
  const store = new Store(dir);
  try {
    const owner = createCanonicalStateAdapter(store);
    const workload = {...studyWorkload(), taskId: 'T'};
    store.put('tasks', {id: 'T', state: 'QUEUED', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S',
      executionBackendId: 'pcf-v1', pcfAppId: 'cpu-sum', pcfWorkload: {...workload, version: 1, outputSchema: 'json', retryClass: 'PURE',
        capabilities: ['cpu.json'], inputRefs: [], resources: {cpu: 1, memory: 10}, qos: 'BATCH'}});
    store.put('actions', {id: 'A', actionId: 'A'});
    const proposal = planPlacement(workload, [studyCandidate('alien')], studyPolicy, 1000);
    const reservation = admit(owner, {workload, proposal, policy: studyPolicy, candidate: studyCandidate('alien'),
      idempotencyKey: 'k', ttlMs: 20000, appQuota: {cpu: 2, memory: 100}, now: 1000}).reservation;
    const attempt = claimAttempt(owner, {reservationId: reservation.id, holder: 'worker-1', bootId: 'b-alien', now: 1100});

    // Worker failover: a worker whose liveness is unknown is an ATTENTION item - never an automatic promotion.
    assert.deepEqual(reconcileExecution(owner.snapshot(), [], 2000), [{action: 'ATTENTION_UNKNOWN_WORKER', taskId: 'T', attemptId: attempt.id}]);
    assert.deepEqual(reconcileExecution(owner.snapshot(), [{holder: 'worker-1', bootId: 'b-alien', alive: true}], 2000), []);
    // A failover needs proof that the OLD attempt stopped; a timeout or a claim is not proof.
    await assert.rejects(() => recoverStoppedAttempt({owner, taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch,
      proveStopped: async () => ({stopped: true}), authorize: async () => true}), {code: 'RECOVERY_PROCESS_UNKNOWN'});
    recordOwnedProcess(owner, {taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch, holder: 'worker-1', bootId: 'b-alien',
      processIdentity: {pid: 4242, host: 'alien', startedAt: 1200}});
    await assert.rejects(() => recoverStoppedAttempt({owner, taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch,
      proveStopped: async () => ({stopped: false}), authorize: async () => true}), {code: 'EXECUTION_STOP_NOT_PROVEN'});
    // Recovery refuses to act without current authorization as well.
    await assert.rejects(() => recoverStoppedAttempt({owner, taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch,
      proveStopped: async a => ({stopped: true, attemptId: a.id, epoch: a.epoch, pid: a.processIdentity.pid, startedAt: a.processIdentity.startedAt, bootId: a.bootId}),
      authorize: async () => false}), {code: 'RECOVERY_UNAUTHORIZED'});

    // Controller restart is a DIFFERENT event: a new controller cannot see the running process, so it raises attention
    // and leaves the canonical outcome unknown instead of declaring the work failed or failed over.
    const service = createFabricService({store, artifactRoot: join(dir, 'artifacts'), deviceId: 'alien',
      readAuthority: async () => ({version: 1, authorized: true, expiresAt: Date.now() + 60000, originDeviceId: 'alien',
        allowedDevices: ['alien'], dataScopes: ['PUBLIC'], sharingConsent: false, cloudConsent: false, budget: 0})});
    await service.start();
    const afterRestart = store.get('tasks', 'T');
    assert.deepEqual({state: afterRestart.state, attention: afterRestart.pcfAttention, result: afterRestart.pcfResult ?? null},
      {state: 'RUNNING', attention: 'EXECUTION_STOP_NOT_PROVEN', result: null});
    assert.equal(service.health().physicalAcceptance, 'NOT_RUN');
    await service.stop();

    // Recovery policy for ambiguous work: attention, not a guessed retry.
    assert.equal(planRecovery({taskId: 'T', retryClass: 'NON_RETRYABLE'}, {authorized: true, previousStopped: true, now: 0}).action, 'ATTENTION');
    assert.equal(planRecovery({taskId: 'T', retryClass: 'CHECKPOINTABLE'}, {authorized: true, previousStopped: true, checkpointCompatible: false, now: 0}).reason, 'SIDE_EFFECT_OR_COMPATIBILITY_UNKNOWN');
    assert.deepEqual(planRecovery({taskId: 'T', retryClass: 'PURE'}, {authorized: true, previousStopped: true, now: 0}),
      {action: 'RETRY', taskId: 'T', newAttemptRequired: true});
    // The implementation's own HA ledger stays NOT_PROVEN until an independent failover is actually MEASURED.
    assert.equal(assessOptionalReadiness({independentControlStorage: true, oldWriterFenced: true})['PCF-722'], 'PREREQUISITE_NOT_PROVEN');
    assert.equal(assessOptionalReadiness({})['PCF-722'], 'PREREQUISITE_NOT_PROVEN');
  } finally { store.db.close(); await rm(dir, {recursive: true, force: true}); }
});

test('PCF-721 line 48/49: failure, no-benefit and unfavourable samples are retained, and the artifact pack carries provenance, limitations and checksums', () => {
  const receipt = {campaignId: 'c1', scenarioId: 's1', state: 'FINISHED', reason: 'REPETITIONS_FINISHED',
    summary: {planned: 4, accounted: 4, measured: 1, failed: 1, timedOut: 1, excluded: 0, cancelled: 0, skipped: 0, interrupted: 0},
    runs: [
      {index: 0, state: 'MEASURED', measured: true, seed: 0, durationMs: 10, result: {taskRef: 'T1', assignedNodeId: 'alien'}},
      {index: 1, state: 'FAILED', measured: false, seed: 1, reason: 'EXECUTOR_CRASHED', result: {taskRef: 'T2'}},
      {index: 2, state: 'TIMED_OUT', measured: false, seed: 2, reason: 'DEADLINE_MISSED'},
      {index: 3, state: 'MEASURED', measured: true, warmup: true, seed: 3, durationMs: 9, result: {taskRef: 'T1', assignedNodeId: 'alien'}},
    ], context: {manifest: {workers: ['alien']}}};
  const tasks = [{id: 'T1', state: 'COMPLETED', createdAt: '2026-10-07T11:59:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z', researchRunRef: 'run:1'},
    {id: 'T2', state: 'FAILED', createdAt: '2026-10-07T11:59:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z'}];
  const artifact = buildArtifact({cityId: 'city', generatedAt: '2026-10-07T12:00:00.000Z', receipts: [receipt], tasks,
    environment: {os: process.platform, node: process.version, runtime: 'ACTUAL_LOCAL_CPU'}, topology: {hosts: ['alien']},
    events: [{id: 'e1'}], sourceReadFailures: []});

  // Unfavourable samples are KEPT: the failed and timed-out runs are still rows of the normalized dataset...
  assert.deepEqual(artifact.dataset.map(row => [row.index, row.state, row.warmup]), [[0, 'MEASURED', false], [1, 'FAILED', false], [2, 'TIMED_OUT', false], [3, 'MEASURED', true]]);
  // ...with a raw pointer each, so a reviewer can re-read them from the source rather than trusting the summary.
  assert.ok(artifact.dataset.every(row => typeof row.rawPointer === 'string' && row.rawPointer.startsWith('receipt:c1#runs[')));
  // Failures are classified, not lumped: a warmup is not a failure, and a failed run is not a warmup.
  assert.deepEqual(artifact.failures.unmeasuredRuns.map(row => [row.index, row.state, row.reason]), [[1, 'FAILED', 'EXECUTOR_CRASHED'], [2, 'TIMED_OUT', 'DEADLINE_MISSED']]);
  assert.deepEqual(artifact.failures.warmupRuns.map(row => row.index), [3]);
  assert.equal(artifact.dataset.filter(row => row.measured).length, 2);

  // Statistical output carries either a value WITH provenance or NOT_MEASURED WITH a reason - there is no third state.
  assert.ok(artifact.metrics.every(row => row.value === NOT_MEASURED ? typeof row.reason === 'string' && row.reason.length > 0 : row.provenance.length > 0));
  // An unknown Owner-intervention window is NOT reported as zero.
  const interventions = artifact.metrics.find(row => row.metric === 'intervention_count');
  assert.equal(interventions.value, NOT_MEASURED);
  assert.ok(interventions.reason.includes('forbids reporting 0'));
  assert.ok(artifact.manifest.metricsNotMeasured > 0);
  assert.ok(metricsCsv(artifact).includes('NOT_MEASURED'));

  // The pack itself: manifest, sanitized dataset, raw pointers/digests, environment/versions, limitations, reproduction.
  // PLUS THE RECORDS THE POINTERS POINT AT: `raw-pointers.json` publishes `trace:<eventId>` for every trace record the
  // export scoped in, and those bytes used to live only in the City, whose trace retention is bounded (a 256-record
  // window over 2 MiB and ONE previous generation). Measured: the dev study's 206 pointers resolved 206/206 from the
  // durable store on the morning of 2026-10-08 and 0/206 the same afternoon, and the City's backup predated the study -
  // so the evidence was gone from every store while the pack went on publishing the pointers as if retrievable. A pack
  // now carries them (trace-records.jsonl) and declares how many (trace-coverage.json). Both are emitted even when
  // there are no records, so a reader never has to guess whether a file is absent or empty.
  const files = artifactFiles(artifact);
  assert.deepEqual(Object.keys(files), ['manifest.json', 'environment.json', 'topology.json', 'raw-pointers.json', 'normalized-dataset.json',
    'metrics.csv', 'failures.json', 'exclusions.json', 'tables.json', 'reproduction.json',
    'trace-records.jsonl', 'trace-coverage.json']);
  assert.equal(JSON.parse(files['environment.json']).node, process.version);
  assert.deepEqual(JSON.parse(files['raw-pointers.json']).canonicalTasks, ['task:T1', 'task:T2']);
  assert.ok(artifact.reproduction.steps.length >= 3 && artifact.reproduction.steps.some(step => step.includes('recompute')));
  assert.ok(artifact.exclusions.length > 0 && artifact.exclusions.every(entry => entry.what && entry.why && entry.wouldRequire));
  // Without at least one REAL campaign receipt there is no artifact at all: a shape with nothing behind it is refused.
  assert.throws(() => buildArtifact({receipts: []}), {code: 'ARTIFACT_NO_SOURCE'});
  assert.throws(() => buildArtifact({receipts: [{campaignId: null}]}), {code: 'ARTIFACT_INVALID_SOURCE'});

  // Checksums are emitted over the exact bytes, and the same artifact reproduces the same digests.
  const checksums = checksumsFor(files);
  for (const [name, text] of Object.entries(files)) {
    assert.equal(checksums[name].bytes, Buffer.byteLength(text));
    assert.match(checksums[name].sha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(checksumsFor(artifactFiles(artifact)), checksums);
});

test('PCF-721 line 45/48: controlled ablation and the policy comparison reuse the identical safety shield, cannot dispatch, and claim no measured benefit', () => {
  const policy = resolveEffectivePolicy({mode: 'TRUSTED_PERSONAL_FABRIC'}, studyPolicy, 1000);
  const workload = studyWorkload({fixedPriority: ['linux-1', 'alien']});
  const candidates = [studyCandidate('alien'), studyCandidate('linux-1')];
  const place = (ref, strategy) => ({ref, value: strategy, place: (w, cs, value, now) => planPlacement(w, cs, policy, now, {strategy: value})});
  const scope = {isolated: true, authorised: true, scopeRef: 'study:1'};
  const replay = replayDecisions({baseline: place('policy:fixed', 'FIXED'), proposed: place('policy:composite', 'COMPOSITE'),
    ablation: place('policy:capability', 'CAPABILITY'), workload, candidates, now: 1000, scope});

  assert.deepEqual(Object.keys(replay.results), ['BASELINE', 'PROPOSED', 'ABLATION']);
  // The compatible policy pins the first declared worker; the PCF policy and its ablation rank locally.
  assert.deepEqual(replay.results.BASELINE.deviceId, 'linux-1');
  assert.deepEqual(replay.differences.map(entry => [entry.mode, entry.delta]), [['PROPOSED', 'DIFFERENT_DEVICE'], ['ABLATION', 'DIFFERENT_DEVICE']]);
  // A decision difference is recomputable from the digests, and it is NOT a measured benefit.
  assert.equal(replay.performanceClaim, 'NONE');
  assert.equal(replay.dispatchAllowed, false);
  assert.equal(replay.productionPolicyUnchanged, true);
  assert.equal(replayDIGEST(replay), replayDIGEST(replayDecisions({baseline: place('policy:fixed', 'FIXED'), proposed: place('policy:composite', 'COMPOSITE'),
    ablation: place('policy:capability', 'CAPABILITY'), workload, candidates, now: 1000, scope})));

  // The safety/authorization floor is IDENTICAL in every strategy: an untrusted candidate is refused by all four, so the
  // capability-only ablation can never remove the shield.
  const untrusted = studyCandidate('linux-1', {trusted: false});
  for (const strategy of PLACEMENT_STRATEGIES) {
    const refused = planPlacement(workload, [untrusted], policy, 1000, {strategy});
    assert.equal(refused.state, 'REFUSED');
    assert.deepEqual(refused.decisions, [{deviceId: 'linux-1', code: 'EXECUTOR_NOT_AUTHORIZED_OR_READY', remedy: 'REQUEST_AUTHORISATION'}]);
  }
  // Experimental control is only accepted inside a scope that declares itself isolated AND authorised.
  assert.throws(() => replayDecisions({workload, candidates, now: 1000}), {code: 'REPLAY_SCOPE_REQUIRED'});
  assert.throws(() => replayDecisions({workload, candidates, now: 1000, scope: {...scope, isolated: false}}), {code: 'REPLAY_SCOPE_NOT_ISOLATED'});
  assert.throws(() => replayDecisions({workload, candidates, now: 1000, scope: {...scope, authorised: false}}), {code: 'REPLAY_SCOPE_NOT_AUTHORISED'});
  assert.throws(() => replayDecisions({workload, candidates, now: 1000, scope: {isolated: true, authorised: true}}), {code: 'REPLAY_SCOPE_REF_REQUIRED'});
  assert.throws(() => replayDecisions({workload, candidates, now: Infinity, scope}), {code: 'REPLAY_CLOCK_REQUIRED'});
  assert.throws(() => replayDecisions({baseline: {ref: 'policy:x'}, proposed: place('policy:c', 'COMPOSITE'), workload, candidates, now: 1000, scope}), {code: 'REPLAY_POLICY_INVALID'});
});

function replayDIGEST(replay) {
  return JSON.stringify({comparisonDigest: replay.comparisonDigest, results: Object.fromEntries(Object.entries(replay.results).map(([mode, value]) => [mode, value.decisionDigest]))});
}
