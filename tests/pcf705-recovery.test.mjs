// PCF-705 acceptance: recovery and safe re-placement.
//
// Workbook: dc/mission-book/mission-group/personal-compute-fabric/PCF-705-recovery-and-safe-replacement.md
// (English mirror under en/). Every test names the workbook line it covers. The workbook's own list is exercised
// here: disconnection before and after commit, late results, damaged and incompatible checkpoints, revoked consent,
// duplicate recovery events, oscillating load and an offline strict target - each as a typed refusal by code, never
// as "it throws".
//
// The physical half of the workbook ("双机真断链/进程崩溃的安全样本") needs two hosts and is marked NOT_RUN. The retry
// budget this header used to call NOT_IMPLEMENTED was implemented by PCF series completion increment 14 and is asserted
// below by code (RETRY_BUDGET_EXHAUSTED / _INVALID, DATA_LOCATION_INCOMPATIBLE, MIGRATION_COST_UNKNOWN and the
// hysteresis refusal); the stale note contradicted those assertions and the series' "no NOT_IMPLEMENTED remains" claim.
// Corrected during the four-series integration acceptance, which is where the contradiction was measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../services/dev-gateway/store.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {admit, claimAttempt, commitResult} from '../services/personal-compute-fabric/admission.mjs';
import {planPlacement, FEASIBILITY_REFUSALS} from '../services/personal-compute-fabric/placement.mjs';
import {planRecovery, migrationBenefit} from '../services/personal-compute-fabric/recovery.mjs';
import {recoverStoppedAttempt} from '../services/personal-compute-fabric/recovery-controller.mjs';
import {reconcileExecution} from '../services/personal-compute-fabric/supervisor.mjs';
import {createArtifactStore, sha256} from '../services/personal-compute-fabric/artifacts.mjs';
import {saveCheckpoint, restoreCheckpoint} from '../services/personal-compute-fabric/checkpoint.mjs';

const NOW = 1000;
const policy = {version: 7, authorized: true, originDeviceId: 'alien', mode: 'TRUSTED_PERSONAL_FABRIC', allowedDevices: ['alien', 'mech', 'ghost'], dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: 5000};
const workload = (taskId, extra = {}) => ({taskId, actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S', appId: 'one', dataScope: 'PUBLIC', kind: 'CPU_JSON', capabilities: ['cpu.json'], resources: {cpu: 1, memory: 10}, deadlineAt: 4000, writeScope: [], qos: 'BATCH', ...extra});
const candidate = (deviceId = 'alien', extra = {}) => ({deviceId, bootId: 'b', trusted: true, authorized: true, executorReady: true, sharing: true, platform: 'win32',
  provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'}, observationVersion: 1, observedAt: 900, validUntil: 3000,
  free: {cpu: 2, memory: 100}, queueMs: 10, cost: {inputMs: [1, 2], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2]}, ...extra});
// One canonical attempt in flight: task T (fenced at epoch 1, attempt X) with its RUNNING reservation.
async function fixture(run, {retryClass = 'PURE', deadlineAt = Date.now() + 60000} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pcf705-'));
  const store = new Store(dir);
  const owner = createCanonicalStateAdapter(store);
  try {
    store.put('tasks', {id: 'T', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S', state: 'RUNNING', pcfAttemptId: 'X', pcfEpoch: 1, pcfWorkload: {retryClass, deadlineAt}});
    owner.transaction(undefined, state => {
      state.epoch = 1;
      state.reservations = [{id: 'R', key: 'key:T', taskId: 'T', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S', appId: 'one', deviceId: 'alien', bootId: 'b', resources: {cpu: 1}, state: 'RUNNING', expiresAt: 99999}];
      state.attempts = [{id: 'X', reservationId: 'R', taskId: 'T', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S', holder: 'h', bootId: 'b', epoch: 1, state: 'RUNNING', processIdentity: {pid: 123, host: 'fixture', startedAt: 10}}];
      return {};
    });
    await run(store, owner);
  } finally { store.db.close(); await rm(dir, {recursive: true, force: true}); }
}
const recoveryArgs = owner => ({owner, taskId: 'T', attemptId: 'X', epoch: 1,
  authorize: async () => true, proveStopped: async () => ({stopped: true, attemptId: 'X', epoch: 1, pid: 123, startedAt: 10, bootId: 'b'})});

// Workbook sub-task 1: "planRecovery... 区分 retry-safe、checkpoint-resumable、non-retryable、SIDE_EFFECT_UNKNOWN；
// 不得把任何 FAILED 都重跑".
test('PCF705-01 planRecovery separates retry-safe and checkpoint-resumable from everything it refuses', () => {
  const base = {authorized: true, previousStopped: true, checkpointCompatible: false, cooldownUntil: 0, now: 100, newDeviceId: 'alien'};
  const compatible = {...base, checkpointCompatible: true};
  const pure = planRecovery({taskId: 'T', retryClass: 'PURE'}, base);
  assert.equal(pure.action, 'RETRY');
  assert.equal(pure.newAttemptRequired, true, 'a re-run is proposed as a NEW attempt, never as a replay');
  assert.equal(pure.taskId, 'T');
  assert.equal(planRecovery({taskId: 'T', retryClass: 'IDEMPOTENT'}, base).action, 'RETRY');
  assert.equal(planRecovery({taskId: 'T', retryClass: 'CHECKPOINTABLE'}, compatible).action, 'RESTORE');
  assert.equal(planRecovery({taskId: 'T', retryClass: 'CHECKPOINTABLE'}, compatible).newAttemptRequired, true);
  // A checkpointable task whose checkpoint is NOT compatible is not restored.
  assert.equal(planRecovery({taskId: 'T', retryClass: 'CHECKPOINTABLE'}, base).action, 'ATTENTION');
  // FAILED is not universal retry permission: every other class is refused, and the refusal names the task.
  for (const retryClass of ['NON_RETRYABLE', 'SIDE_EFFECT_UNKNOWN', 'MAGIC', undefined]) {
    const plan = planRecovery({taskId: 'T', retryClass}, compatible);
    assert.equal(plan.action, 'ATTENTION');
    assert.notEqual(plan.action, 'RETRY');
    assert.notEqual(plan.action, 'RESTORE');
    assert.equal(plan.taskId, 'T');
  }
  // LIMITATION (reported, not fixed): the plan's refusal REASON does not separate NON_RETRYABLE from
  // SIDE_EFFECT_UNKNOWN - both arrive as SIDE_EFFECT_OR_COMPATIBILITY_UNKNOWN - so the caller's declared retryClass
  // is the only place that distinction survives. The safety half (neither is ever re-run) is what is asserted above.
  assert.equal(planRecovery({retryClass: 'NON_RETRYABLE'}, compatible).reason, planRecovery({retryClass: 'SIDE_EFFECT_UNKNOWN'}, compatible).reason);
  assert.equal(planRecovery({retryClass: 'NON_RETRYABLE'}, compatible).reason, 'SIDE_EFFECT_OR_COMPATIBILITY_UNKNOWN');
});

// Workbook sub-task 2 "检查...consent...及冷却期" plus sub-task 3's hysteresis sentence.
test('PCF705-02 an unproven stop, a revoked consent and a cooldown are ATTENTION/WAIT, never a re-run', () => {
  const base = {authorized: true, previousStopped: true, now: 1000, cooldownUntil: 0, newDeviceId: 'alien'};
  // Consent/authority is re-checked, and a revocation stops recovery rather than being remembered as granted.
  assert.equal(planRecovery({taskId: 'T', retryClass: 'PURE'}, {...base, authorized: false}).reason, 'AUTHORITY_REQUIRED');
  assert.equal(planRecovery({taskId: 'T', retryClass: 'PURE'}, {...base, authorized: undefined}).reason, 'AUTHORITY_REQUIRED');
  // A worker that is merely unreachable is not a worker that stopped.
  assert.equal(planRecovery({taskId: 'T', retryClass: 'PURE'}, {...base, previousStopped: false}).reason, 'OLD_HOLDER_STOP_NOT_PROVEN');
  assert.equal(planRecovery({taskId: 'T', retryClass: 'PURE'}, {...base, previousStopped: undefined}).reason, 'OLD_HOLDER_STOP_NOT_PROVEN');
  // The task identity travels with the refusal, so attention can be attached to the right episode.
  assert.equal(planRecovery({taskId: 'T9', retryClass: 'PURE'}, {...base, authorized: false}).taskId, 'T9');
  // The cooldown IS the hysteresis: within it the plan WAITs with a bound instead of bouncing between two machines.
  const cooling = planRecovery({taskId: 'T', retryClass: 'PURE'}, {...base, cooldownUntil: 2000});
  assert.equal(cooling.action, 'WAIT');
  assert.equal(cooling.until, 2000);
  assert.equal(planRecovery({taskId: 'T', retryClass: 'PURE'}, {...base, now: 1999, cooldownUntil: 2000}).action, 'WAIT');
  assert.equal(planRecovery({taskId: 'T', retryClass: 'PURE'}, {...base, now: 2000, cooldownUntil: 2000}).action, 'RETRY');
  // Authority is checked before the cooldown: waiting out a cooldown cannot make a revoked task runnable.
  assert.equal(planRecovery({taskId: 'T', retryClass: 'PURE'}, {...base, authorized: false, cooldownUntil: 2000}).reason, 'AUTHORITY_REQUIRED');
  // Oscillating load produces the same plan for the same facts - the decision carries no hidden per-call state.
  assert.deepEqual(planRecovery({taskId: 'T', retryClass: 'PURE'}, base), planRecovery({taskId: 'T', retryClass: 'PURE'}, base));
  assert.deepEqual(planRecovery({taskId: 'T', retryClass: 'PURE'}, {...base, cooldownUntil: 2000}), cooling);
});

// Workbook sub-task 3: "strict-target任务不因掉线而自动换目标" and the acceptance clause "strict target离线".
test('PCF705-03 a strict target that goes offline stays bound and is not silently re-placed', () => {
  const context = {authorized: true, previousStopped: true, now: 1000, cooldownUntil: 0, checkpointCompatible: true, newDeviceId: 'mech'};
  const strict = {taskId: 'T', retryClass: 'PURE', strictTargetDeviceId: 'ghost'};
  const elsewhere = planRecovery(strict, context);
  assert.equal(elsewhere.action, 'ATTENTION');
  assert.equal(elsewhere.reason, 'STRICT_TARGET_NEW_APPROVAL_REQUIRED');
  // Staying on the bound target is a normal retry.
  assert.equal(planRecovery(strict, {...context, newDeviceId: 'ghost'}).action, 'RETRY');
  // The placement half agrees: with the strict target offline there is no substitute winner.
  const proposal = planPlacement(workload('T', {strictTargetDeviceId: 'ghost'}), [candidate('mech'), candidate('alien')], policy, NOW);
  assert.equal(proposal.state, 'REFUSED');
  assert.equal(proposal.deviceId, null);
  assert.equal(proposal.decisions.length, 2);
  assert.ok(proposal.decisions.every(entry => entry.code === FEASIBILITY_REFUSALS.STRICT_TARGET));
});

// Workbook sub-task 2: "对允许的恢复创建新attempt，保持task/action/origin" and the acceptance clause about an allowed
// recovery satisfying the original contract.
test('PCF705-04 an authorised recovery creates a NEW attempt and preserves task/action/origin identity', async () => {
  await fixture(async (store, owner) => {
    const result = await recoverStoppedAttempt(recoveryArgs(owner));
    assert.equal(result.requeued, true);
    assert.equal(result.taskId, 'T');
    const requeued = store.get('tasks', 'T');
    assert.equal(requeued.state, 'QUEUED');
    assert.equal(requeued.actionId, 'A', 'the action identity is unchanged');
    assert.equal(requeued.originDeviceId, 'alien', 'the origin identity is unchanged');
    assert.equal(requeued.parentSessionId, 'S', 'the originating session is unchanged');
    assert.equal(requeued.pcfGeneration, 1, 'the retry is a new generation of the SAME task');
    assert.equal(requeued.pcfAttemptId, null);
    assert.equal(requeued.pcfEpoch, null);
    assert.deepEqual(requeued.pcfRecovery, {sourceAttemptId: 'X', reason: 'OWNED_STOP_PROVEN', at: requeued.pcfRecovery.at});
    const old = owner.snapshot().attempts.find(entry => entry.id === 'X');
    assert.equal(old.state, 'FAILED');
    assert.equal(old.epoch, 1, 'the old attempt keeps its own epoch as evidence');
    assert.equal(old.stopProof.stopped, true);
    assert.equal(owner.snapshot().reservations.length, 0, 'the stopped holder no longer charges capacity');
    // A new attempt is created through admission, with a different attempt id and a higher epoch.
    const admitted = admit(owner, {workload: workload('T'), proposal: planPlacement(workload('T'), [candidate()], policy, NOW), policy, candidate: candidate(), idempotencyKey: 'key:T:1', ttlMs: 1000, appQuota: {cpu: 8, memory: 100}, now: NOW});
    const attempt = claimAttempt(owner, {reservationId: admitted.reservation.id, holder: 'h2', bootId: 'b', now: 1100});
    assert.notEqual(attempt.id, 'X');
    assert.equal(attempt.epoch, 2);
    assert.equal(attempt.taskId, 'T');
    assert.equal(attempt.actionId, 'A');
    assert.equal(attempt.originDeviceId, 'alien');
    assert.equal(attempt.parentSessionId, 'S');
    assert.equal(owner.snapshot().attempts.filter(entry => entry.state === 'RUNNING').length, 1);
  });
});

// Workbook acceptance: "commit前...失联" and sub-task 4's "副作用未知先核验" - an absence of evidence is not a stop.
test('PCF705-05 before commit: a timeout, a PID or a stale epoch is never accepted as stop proof', async () => {
  await fixture(async (store, owner) => {
    // No observation at all: the supervisor reports an unknown worker, it does not release or restart the task.
    const actions = reconcileExecution({reservations: [{id: 'R', taskId: 'T', state: 'RUNNING', expiresAt: 99999}], attempts: [{id: 'X', taskId: 'T', state: 'RUNNING', holder: 'h', bootId: 'b'}]}, [], 1000);
    assert.deepEqual(actions, [{action: 'ATTENTION_UNKNOWN_WORKER', taskId: 'T', attemptId: 'X'}]);
    const proofs = [
      async () => ({stopped: false}),
      async () => ({stopped: true, attemptId: 'X', epoch: 1}),                                             // PID and boot missing
      async () => ({stopped: true, attemptId: 'X', epoch: 1, pid: 999, startedAt: 10, bootId: 'b'}),        // a different process
      async () => ({stopped: true, attemptId: 'X', epoch: 1, pid: 123, startedAt: 11, bootId: 'b'}),        // a recycled PID
      async () => ({stopped: true, attemptId: 'X', epoch: 1, pid: 123, startedAt: 10, bootId: 'other'}),    // another boot
      async () => ({stopped: true, attemptId: 'OTHER', epoch: 1, pid: 123, startedAt: 10, bootId: 'b'}),    // another attempt
      async () => ({stopped: true, attemptId: 'X', epoch: 2, pid: 123, startedAt: 10, bootId: 'b'}),        // another epoch
    ];
    for (const proveStopped of proofs) {
      await assert.rejects(() => recoverStoppedAttempt({...recoveryArgs(owner), proveStopped}), {code: 'EXECUTION_STOP_NOT_PROVEN'});
    }
    // A stale epoch in the event itself, and a revoked authority, are their own refusals.
    await assert.rejects(() => recoverStoppedAttempt({...recoveryArgs(owner), epoch: 2}), {code: 'RECOVERY_ATTEMPT'});
    await assert.rejects(() => recoverStoppedAttempt({...recoveryArgs(owner), authorize: async () => false}), {code: 'RECOVERY_UNAUTHORIZED'});
    await assert.rejects(() => recoverStoppedAttempt({...recoveryArgs(owner), proveStopped: undefined}), {code: 'RECOVERY_CONFIGURATION'});
    // Nothing was released, requeued or re-run by any of those refusals.
    assert.equal(store.get('tasks', 'T').state, 'RUNNING');
    assert.equal(owner.snapshot().reservations.length, 1, 'the reservation is retained for authoritative reconciliation');
    assert.equal(owner.snapshot().attempts[0].state, 'RUNNING');
  });
});

// Workbook acceptance: "commit后失联" and "重复recovery事件".
test('PCF705-06 after commit: nothing is recovered, and a duplicate event or late result cannot run twice', async () => {
  await fixture(async (store, owner) => {
    const receipt = {taskId: 'T', attemptId: 'X', epoch: 1, holder: 'h', bootId: 'b', outcome: 'SUCCEEDED', outputDigest: 'a'.repeat(64), now: 2000};
    assert.equal(commitResult(owner, receipt).committed, true);
    assert.equal(store.get('tasks', 'T').state, 'COMPLETED');
    assert.equal(owner.snapshot().reservations.length, 0, 'a committed result releases the reservation');
    assert.equal(owner.snapshot().completedKeys.length, 1);
    // A recovery event that arrives after the commit has no running attempt to recover.
    await assert.rejects(() => recoverStoppedAttempt(recoveryArgs(owner)), {code: 'RECOVERY_ATTEMPT'});
    // A duplicate or late report of the same result is fenced and produces no second effect.
    assert.throws(() => commitResult(owner, {...receipt, now: 2100}), {code: 'ATTEMPT_FENCED'});
    assert.equal(owner.snapshot().completedKeys.length, 1, 'the key was not recorded twice');
    assert.equal(owner.snapshot().attempts.filter(entry => entry.state === 'SUCCEEDED').length, 1);
    // The task cannot be re-run behind the committed truth either: admission refuses a terminal task.
    assert.throws(() => admit(owner, {workload: workload('T'), proposal: planPlacement(workload('T'), [candidate()], policy, NOW), policy, candidate: candidate(), idempotencyKey: 'key:T:again', ttlMs: 1000, appQuota: {cpu: 8, memory: 100}, now: NOW}), {code: 'CANONICAL_TASK_NOT_EXECUTABLE'});
  });
  // The controller refuses even an idempotent/checkpointable task: no generic exactly-once is promised.
  await fixture(async (store, owner) => {
    await assert.rejects(() => recoverStoppedAttempt(recoveryArgs(owner)), {code: 'RECOVERY_RETRY_UNSAFE'});
    assert.equal(store.get('tasks', 'T').state, 'RUNNING', 'the refused recovery changed nothing');
    assert.equal(owner.snapshot().reservations.length, 1);
    assert.equal(owner.snapshot().attempts[0].state, 'RUNNING');
  }, {retryClass: 'CHECKPOINTABLE'});
  // A task whose declared deadline has passed is not recovered into a run that cannot meet its contract.
  await fixture(async (store, owner) => {
    await assert.rejects(() => recoverStoppedAttempt(recoveryArgs(owner)), {code: 'RECOVERY_DEADLINE'});
    assert.equal(store.get('tasks', 'T').state, 'RUNNING');
    assert.equal(owner.snapshot().reservations.length, 1);
  }, {deadlineAt: Date.now() - 1000});
});

// Workbook acceptance: "checkpoint损坏、不兼容executor" and "允许恢复的任务最终结果与原始输入契约一致".
test('PCF705-07 a damaged or incompatible checkpoint is refused by name, and a resumed run still matches the contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pcf705-cp-'));
  try {
    const store = createArtifactStore({root, maxBytes: 100000, maxItems: 20, authorize: () => true});
    const compute = (start, end, sum) => { let value = sum; for (let index = start; index < end; index += 1) value = (value + index * index) % 1000000007; return value; };
    const binding = {taskId: 'T', attemptId: 'old', inputDigest: sha256('input'), providerVersion: '1', stageId: 'cpu', owner: 'S', dataScope: 'PUBLIC', expiresAt: 100000,
      executorVersion: 'cpu-v1', runtimeVersion: 'node24', modelVersion: 'NOT_APPLICABLE_CPU', platform: 'portable-js-integer', dependencyDigest: sha256('no-dependencies'), workloadKind: 'CPU'};
    const approval = {approved: true, sourceAttemptId: 'old', targetFence: 'fence-2', validateFence: async (target, request) => target.attemptId === 'new' && request.sourceBinding.attemptId === 'old' && request.targetFence === 'fence-2'};
    const ref = await saveCheckpoint(store, {sideEffects: 'NONE', cursor: 500, sum: compute(0, 500, 0)}, binding, 1);
    // The allowed recovery produces the SAME result as an uninterrupted run of the same input.
    const resumed = await restoreCheckpoint(store, ref, {...binding, attemptId: 'new'}, 2, approval);
    assert.equal(sha256(String(compute(resumed.cursor, 1000, resumed.sum))), sha256(String(compute(0, 1000, 0))));
    // A second restore claim for the same task/attempt pair is refused even from a restarted store.
    const restarted = createArtifactStore({root, maxBytes: 100000, maxItems: 20, authorize: () => true});
    await assert.rejects(restoreCheckpoint(restarted, ref, {...binding, attemptId: 'new'}, 3, approval), {code: 'CHECKPOINT_RESTORE_ALREADY_CLAIMED'});
    // A fence that does not accept the target is refused, without consuming the claim.
    await assert.rejects(restoreCheckpoint(store, ref, {...binding, attemptId: 'new3'}, 4, {...approval, validateFence: async () => false}), {code: 'CHECKPOINT_FENCE_REJECTED'});
    // An executor/runtime/model/dependency the checkpoint was not written for is refused, per binding key.
    for (const [key, value] of [['executorVersion', 'cpu-v2'], ['runtimeVersion', 'node25'], ['modelVersion', 'MODEL-OTHER'], ['platform', 'win32'], ['dependencyDigest', sha256('other')], ['inputDigest', sha256('other-input')]]) {
      await assert.rejects(restoreCheckpoint(store, ref, {...binding, attemptId: 'new', [key]: value}, 5, approval), {code: 'CHECKPOINT_BINDING_' + key});
    }
    // A missing compatibility field cannot be silently treated as compatible.
    for (const key of ['executorVersion', 'runtimeVersion', 'modelVersion', 'platform', 'dependencyDigest']) {
      await assert.rejects(restoreCheckpoint(store, ref, {...binding, attemptId: 'new', [key]: undefined}, 6, approval), {code: 'CHECKPOINT_COMPATIBILITY_REQUIRED'});
    }
    // A checkpoint whose blob was damaged after it was written fails its digest rather than being restored.
    const damagedBinding = {...binding, taskId: 'T2', attemptId: 'dmg'};
    const damaged = await saveCheckpoint(store, {sideEffects: 'NONE', cursor: 1}, damagedBinding, 1);
    await writeFile(join(root, damaged.id + '.blob'), Buffer.alloc(damaged.size, 0x21));
    await assert.rejects(restoreCheckpoint(store, damaged, damagedBinding, 2), {code: 'ARTIFACT_DIGEST'});
    // A checkpoint that claims side effects, or a committed state, or a newer schema is refused by name.
    await assert.rejects(saveCheckpoint(store, {sideEffects: 'WRITES', cursor: 1}, binding, 7), {code: 'CHECKPOINT_SIDE_EFFECT_UNKNOWN'});
    const crafted = (payload, now) => store.publish(Buffer.from(JSON.stringify(payload)), {owner: 'S', dataScope: 'PUBLIC', expiresAt: 100000, schema: 'pcf-checkpoint-v1'}, now);
    const sideEffects = await crafted({version: 1, binding, state: {sideEffects: 'WRITES', cursor: 1}}, 8);
    await assert.rejects(restoreCheckpoint(store, sideEffects, binding, 9), {code: 'CHECKPOINT_INCOMPATIBLE'});
    const committed = await crafted({version: 1, binding, state: {sideEffects: 'NONE', committed: true}}, 10);
    await assert.rejects(restoreCheckpoint(store, committed, binding, 11), {code: 'CHECKPOINT_ALREADY_COMMITTED'});
    const future = await crafted({version: 2, binding, state: {sideEffects: 'NONE'}}, 12);
    await assert.rejects(restoreCheckpoint(store, future, binding, 13), {code: 'CHECKPOINT_INCOMPATIBLE'});
  } finally { await rm(root, {recursive: true, force: true}); }
});

// Workbook sub-task 4: "副作用未知先核验或隔离，必要attention带事实和范围，不承诺通用exactly-once".
test('PCF705-08 an unknown external effect is quarantined with attention, never reported as success', async () => {
  await fixture(async (store, owner) => {
    const unknown = {taskId: 'T', attemptId: 'X', epoch: 1, holder: 'h', bootId: 'b', outcome: 'UNKNOWN', reason: 'PROCESS_TREE_TERMINATION_NOT_PROVEN', now: 2000};
    const first = commitResult(owner, unknown);
    assert.equal(first.committed, false);
    assert.equal(first.attention, 'SIDE_EFFECT_UNKNOWN');
    const task = store.get('tasks', 'T');
    assert.equal(task.state, 'RUNNING', 'an unknown effect is not a result and not a failure');
    assert.equal(task.pcfAttention, 'SIDE_EFFECT_UNKNOWN', 'the attention carries the fact and stays on the task');
    assert.equal(task.result, undefined, 'no result is claimed');
    assert.notEqual(task.state, 'COMPLETED');
    // The reservation and the attempt are retained: the effect may or may not have happened.
    assert.equal(owner.snapshot().reservations.length, 1);
    assert.equal(owner.snapshot().attempts[0].state, 'RUNNING');
    assert.equal(owner.snapshot().attempts[0].pendingOutcome, 'UNKNOWN');
    // A replayed unknown report produces no second effect.
    const replay = commitResult(owner, {...unknown, now: 2100});
    assert.equal(replay.committed, false);
    assert.equal(replay.attention, 'SIDE_EFFECT_UNKNOWN');
    assert.equal(store.get('tasks', 'T').state, 'RUNNING');
    // Recovery is refused while the outcome is pending, and the supervisor hands the case to attention.
    await assert.rejects(() => recoverStoppedAttempt(recoveryArgs(owner)), {code: 'RECOVERY_ATTEMPT'});
    const actions = reconcileExecution({reservations: [{id: 'R', taskId: 'T', state: 'RUNNING', expiresAt: 99999}], attempts: [{id: 'X', taskId: 'T', state: 'RUNNING', holder: 'h', bootId: 'b', pendingOutcome: 'UNKNOWN'}]}, [], 3000);
    assert.deepEqual(actions, [{action: 'ATTENTION_UNCERTAIN_OUTCOME', taskId: 'T', attemptId: 'X'}]);
  });
});

// Workbook sub-task 2: "检查数据位置、executor/schema/model兼容、目标资格、consent、retry budget及冷却期".
// FIXED: planRecovery now takes a retry budget and a data-location input and refuses on both.
test('PCF705 sub-task 2: a retry budget bounds repeated recovery', () => {
  const base = {authorized: true, previousStopped: true, now: 100, cooldownUntil: 0};
  const workload = {taskId: 'T', retryClass: 'PURE'};
  assert.equal(planRecovery(workload, {...base, retryBudget: {maxAttempts: 3, used: 0}}).action, 'RETRY');
  assert.deepEqual(planRecovery(workload, {...base, retryBudget: {maxAttempts: 3, used: 2}}).budget, {maxAttempts: 3, used: 2, remaining: 1});
  const exhausted = planRecovery(workload, {...base, retryBudget: {maxAttempts: 3, used: 3}});
  assert.equal(exhausted.action, 'ATTENTION');
  assert.equal(exhausted.reason, 'RETRY_BUDGET_EXHAUSTED');
  assert.equal(exhausted.budget.remaining, 0);
  // A malformed budget is refused rather than read as "unlimited".
  for (const bad of [{maxAttempts: 0, used: 0}, {maxAttempts: 'lots', used: 0}, {maxAttempts: 3, used: -1}, {}]) {
    assert.equal(planRecovery(workload, {...base, retryBudget: bad}).reason, 'RETRY_BUDGET_INVALID', JSON.stringify(bad));
  }
  // No budget declared keeps the legacy behaviour: it is not a budget of zero.
  assert.equal(planRecovery(workload, base).action, 'RETRY');
  assert.equal(planRecovery(workload, base).budget, undefined);
  // The budget is checked BEFORE the cooldown, so an exhausted task asks for attention instead of waiting on a timer.
  assert.equal(planRecovery(workload, {...base, now: 50, cooldownUntil: 200, retryBudget: {maxAttempts: 1, used: 1}}).reason, 'RETRY_BUDGET_EXHAUSTED');
  const waiting = planRecovery(workload, {...base, now: 50, cooldownUntil: 200});
  assert.equal(waiting.action, 'WAIT');
  assert.equal(waiting.until, 200);
  // Data location is a hard input: recovering onto a device that cannot reach the inputs is not a recovery.
  assert.equal(planRecovery(workload, {...base, dataLocationCompatible: false}).reason, 'DATA_LOCATION_INCOMPATIBLE');
  assert.equal(planRecovery(workload, {...base, dataLocationCompatible: true}).action, 'RETRY');
});

// Workbook sub-task 3: "搬迁收益必须覆盖传输/冷启动/丢弃工作成本" - the hysteresis half of that line is implemented as
// the cooldown (asserted in PCF705-02). FIXED: the benefit half is now priced and gated.
test('PCF705 sub-task 3: a migration is proposed only when its benefit covers transfer, cold start and discarded work', () => {
  // Every component is priced, and a missing one is named rather than treated as zero.
  const unknown = migrationBenefit({costs: {transferMs: 100, coldStartMs: 200}, benefitMs: 10_000});
  assert.equal(unknown.proposed, false);
  assert.equal(unknown.reason, 'MIGRATION_COST_UNKNOWN');
  assert.deepEqual(unknown.missing, ['discardedWorkMs']);
  assert.equal(unknown.totalCostMs, null, 'an incomplete cost is not a total');
  assert.match(unknown.note, /an unmeasured cost is not a free cost/);
  // The saving must cover the FULL cost...
  const insufficient = migrationBenefit({costs: {transferMs: 100, coldStartMs: 200, discardedWorkMs: 5000}, benefitMs: 5000});
  assert.equal(insufficient.reason, 'MIGRATION_BENEFIT_INSUFFICIENT');
  assert.equal(insufficient.totalCostMs, 5300);
  assert.equal(insufficient.netMs, -300);
  // ...and beat it by the hysteresis margin, or two machines trade the same task back and forth.
  const marginal = migrationBenefit({costs: {transferMs: 100, coldStartMs: 200, discardedWorkMs: 5000}, benefitMs: 6000});
  assert.equal(marginal.reason, 'MIGRATION_BENEFIT_BELOW_HYSTERESIS');
  assert.equal(marginal.netMs, 700);
  assert.match(marginal.note, /risk oscillation/);
  const worthIt = migrationBenefit({costs: {transferMs: 100, coldStartMs: 200, discardedWorkMs: 5000}, benefitMs: 20_000});
  assert.equal(worthIt.proposed, true);
  assert.equal(worthIt.netMs, 14_700);
  assert.throws(() => migrationBenefit({costs: {transferMs: 1, coldStartMs: 1, discardedWorkMs: 1}}), {code: 'MIGRATION_BENEFIT_REQUIRED'});
  assert.throws(() => migrationBenefit({benefitMs: 1}), {code: 'MIGRATION_COSTS_REQUIRED'});
  // The plan consults it: a move to another device without a priced benefit is refused, and with one it carries the
  // arithmetic into the proposal.
  const workload = {taskId: 'T', retryClass: 'PURE', originDeviceId: 'alien'};
  const base = {authorized: true, previousStopped: true, cooldownUntil: 0, now: 100, newDeviceId: 'mech'};
  assert.throws(() => planRecovery(workload, base), {code: 'MIGRATION_BENEFIT_REQUIRED'});
  const refused = planRecovery(workload, {...base, migration: {costs: {transferMs: 100, coldStartMs: 200, discardedWorkMs: 5000}, benefitMs: 5000}});
  assert.equal(refused.action, 'ATTENTION');
  assert.equal(refused.reason, 'MIGRATION_BENEFIT_INSUFFICIENT');
  const proposed = planRecovery(workload, {...base, migration: {costs: {transferMs: 100, coldStartMs: 200, discardedWorkMs: 5000}, benefitMs: 20_000}});
  assert.equal(proposed.action, 'RETRY');
  assert.equal(proposed.migration.netMs, 14_700);
  // Staying on the origin device is not a migration and needs no benefit arithmetic.
  assert.equal(planRecovery(workload, {...base, newDeviceId: 'alien'}).action, 'RETRY');
  assert.equal(planRecovery(workload, {...base, newDeviceId: 'alien'}).migration, undefined);
});

// Workbook closing paragraph: "双机真断链/进程崩溃的安全样本...same taskId、不同attempt/fence、恢复时间及重复副作用检查".
test('PCF705 acceptance: disconnection and process-crash samples on two real hosts', {skip: 'NOT_RUN: requires a second physical host and a real link/process-crash sample (workbook "双机真断链/进程崩溃的安全样本，保存same taskId、不同attempt/fence、恢复时间及重复副作用检查") - this checkout has one host and no second device, and no VM/live-process migration is claimed by PCF-705; the same-taskId/different-attempt-and-fence property is covered on the canonical store in PCF705-04.'}, () => {
  assert.fail('two physical hosts are required for this workbook sentence');
});
