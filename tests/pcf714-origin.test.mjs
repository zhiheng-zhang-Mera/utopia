// PCF-714 — origin-surface continuity (workbook: PCF-714-origin-surface-continuity.md).
//
// The workbook's own counterexamples are the test subjects here, not the happy path:
//   line 45  remote execution/recovery changes only the ATTEMPT; task/action/origin stay identical, and the origin sees
//            progress, placement reasons, results, artifacts, errors and attention and can cancel/respond;
//   line 46  an offline origin keeps the canonical result; reconnect catches up by bounded seq/cursor, a gap is named
//            for reconciliation, and duplicate events never duplicate the result or ring twice;
//   line 47  a takeover on another authorized surface reuses the existing assistant handoff/attention rules, creates no
//            new task and shares no unauthorized context;
//   line 48  cancel/approval/remote-completion races resolve through ONE terminal truth, a late cancel cannot claim the
//            external effect was withdrawn, and recent-device notification follows the existing policy (no broadcast);
//   line 50  the acceptance command's scenarios: disconnect/reconnect, reordered duplicates, device rebinding, expired
//            access, asynchronous result+cancel, simultaneous attention responses, and no metadata for unauthorized ends;
//   line 56  (spec revision 2) origin-surface VISIBILITY is measured separately from originating-agent CONSUMPTION, and
//            authorized ownership is checked across restart/page/device switch instead of trusting a hostname as the
//            session identity.
//
// Every module imported here is the real implementation. No product file was changed for these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../services/dev-gateway/store.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {admit, claimAttempt, commitResult, recordOwnedProcess} from '../services/personal-compute-fabric/admission.mjs';
import {planPlacement} from '../services/personal-compute-fabric/placement.mjs';
import {resolveEffectivePolicy, assertPolicy} from '../services/personal-compute-fabric/policy.mjs';
import {recoverStoppedAttempt} from '../services/personal-compute-fabric/recovery-controller.mjs';
import {reconcileExecution} from '../services/personal-compute-fabric/supervisor.mjs';
import {planRecovery} from '../services/personal-compute-fabric/recovery.mjs';
import {projectOrigin} from '../services/personal-compute-fabric/origin-projection.mjs';
import {createOriginAgentBridge} from '../services/personal-compute-fabric/origin-agent-bridge.mjs';
import {buildFabricProjection} from '../services/personal-compute-fabric/presentation.mjs';
import {createHandoffBridge} from '../services/dev-gateway/handoff.mjs';
import {createAttentionBridge, rankRecentDevices, MAX_RECENT_DEVICES} from '../contracts/engineering-attention-v1/attention.mjs';

const FAR = 4e12; // far-future authority/deadline instant; a real clock is injected where a clock matters.
const AUTH = Object.freeze({authorized: true, sessionId: 'S', deviceId: 'alien'});

// The canonical fixtures below are built through the real admission path (policy -> placement -> admit -> claimAttempt)
// so an "attempt" in these tests is a genuine canonical attempt, not a hand-written row.
const policy = Object.freeze({version: 1, authorized: true, originDeviceId: 'alien', mode: 'TRUSTED_PERSONAL_FABRIC',
  allowedDevices: ['alien', 'mech', 'phone'], dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: FAR});
const workload = (taskId = 'T') => ({version: 1, taskId, actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S', appId: 'cpu-sum',
  kind: 'CPU_JSON', outputSchema: 'json', capabilities: ['cpu.json'], inputRefs: [], resources: {cpu: 1, memory: 10},
  deadlineAt: FAR, writeScope: [], qos: 'BATCH', retryClass: 'PURE', dataScope: 'PUBLIC'});
const candidate = (deviceId, extra = {}) => ({deviceId, bootId: 'b-' + deviceId, trusted: true, authorized: true, executorReady: true, sharing: true,
  platform: 'win32', provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'},
  observationVersion: 1, observedAt: 900, validUntil: FAR, free: {cpu: 2, memory: 100}, queueMs: 10,
  cost: {inputMs: [1, 1], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2]}, ...extra});

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pcf714-'));
  const store = new Store(dir);
  try { return await fn({dir, store, owner: createCanonicalStateAdapter(store)}); }
  finally { store.db.close(); await rm(dir, {recursive: true, force: true}); }
}

async function runningAttempt({store, owner, taskId = 'T', holder = 'h', bootId = 'b-alien'}) {
  store.put('tasks', {id: taskId, state: 'QUEUED', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S',
    executionBackendId: 'pcf-v1', pcfAppId: 'cpu-sum', pcfWorkload: workload(taskId)});
  store.put('actions', {id: 'A', actionId: 'A', status: 'QUEUED'});
  const proposal = planPlacement(workload(taskId), [candidate('alien')], policy, 1000);
  const reservation = admit(owner, {workload: workload(taskId), proposal, policy, candidate: candidate('alien'),
    idempotencyKey: 'k-' + taskId, ttlMs: 20000, appQuota: {cpu: 2, memory: 100}, now: 1000}).reservation;
  const attempt = claimAttempt(owner, {reservationId: reservation.id, holder, bootId, now: 1100});
  return {attempt, reservation};
}

test('PCF-714 line 45: a remote attempt is claimed without changing task/action/origin identity, and drifted ownership is refused', async () => {
  await fixture(async ({store, owner}) => {
    const {attempt} = await runningAttempt({store, owner});
    const claimed = store.get('tasks', 'T');
    // The attempt is the only thing that moved: the original task/action/origin/session references are untouched.
    assert.equal(claimed.pcfAttemptId, attempt.id);
    assert.equal(claimed.pcfEpoch, attempt.epoch);
    assert.deepEqual({id: claimed.id, actionId: claimed.actionId, originDeviceId: claimed.originDeviceId, parentSessionId: claimed.parentSessionId},
      {id: 'T', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S'});
    // Counterexample: a completion that would attach this attempt to a DIFFERENT task/action/origin is refused, not recorded.
    store.put('tasks', {...claimed, id: claimed.id, actionId: 'VICTIM-A'});
    assert.throws(() => commitResult(owner, {taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch, holder: 'h', bootId: 'b-alien',
      outcome: 'SUCCEEDED', outputDigest: 'a'.repeat(64), now: 1200}), {code: 'CANONICAL_OWNERSHIP_CHANGED'});
    assert.equal(store.get('tasks', 'T').state, 'RUNNING');
  });
});

test('PCF-714 line 45/52: recovery requeues with a new attempt while task/action/origin/session stay identical', async () => {
  await fixture(async ({store, owner}) => {
    const {attempt} = await runningAttempt({store, owner});
    recordOwnedProcess(owner, {taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch, holder: 'h', bootId: 'b-alien',
      processIdentity: {pid: 4242, host: 'alien', startedAt: 1200}});
    const requeued = await recoverStoppedAttempt({owner, taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch,
      proveStopped: async a => ({stopped: true, attemptId: a.id, epoch: a.epoch, pid: a.processIdentity.pid, startedAt: a.processIdentity.startedAt, bootId: a.bootId}),
      authorize: async () => true});
    assert.equal(requeued.requeued, true);
    const recovered = store.get('tasks', 'T');
    assert.equal(recovered.state, 'QUEUED');
    assert.equal(recovered.pcfAttemptId, null);
    assert.equal(recovered.pcfEpoch, null);
    assert.equal(recovered.pcfGeneration, 1);
    // Recovery changed the attempt generation and NOTHING about who owns the work.
    assert.deepEqual({actionId: recovered.actionId, originDeviceId: recovered.originDeviceId, parentSessionId: recovered.parentSessionId},
      {actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S'});
    // A fresh attempt for the same task/action gets a strictly newer epoch.
    const proposal = planPlacement(workload(), [candidate('alien')], policy, 2000);
    const reservation = admit(owner, {workload: workload(), proposal, policy, candidate: candidate('alien'),
      idempotencyKey: 'k2', ttlMs: 20000, appQuota: {cpu: 2, memory: 100}, now: 2000}).reservation;
    const second = claimAttempt(owner, {reservationId: reservation.id, holder: 'h2', bootId: 'b-alien', now: 2100});
    assert.ok(second.epoch > attempt.epoch);
    assert.notEqual(second.id, attempt.id);
    assert.equal(store.get('tasks', 'T').actionId, 'A');
  });
});

test('PCF-714 line 45/56: the origin sees progress, result, artifacts, errors and attention, can cancel/collect/acknowledge, and consumption is measured separately from visibility', async () => {
  await fixture(async ({store}) => {
    store.put('tasks', {id: 'T3', actionId: 'A3', originDeviceId: 'alien', parentSessionId: 'S', state: 'COMPLETED', progress: 100,
      executionBackendId: 'pcf-v1', pcfAppId: 'cpu-sum', pcfPlacementReason: 'HARD_REQUIREMENT',
      pcfResult: {value: 42, digest: 'b'.repeat(64), outputRef: 'artifact:1'}, pcfConsumedSessionId: null});
    store.put('tasks', {id: 'T4', actionId: 'A4', originDeviceId: 'alien', parentSessionId: 'S', state: 'FAILED',
      executionBackendId: 'pcf-v1', error: 'INPUT_DIGEST', pcfAttention: 'EXECUTION_STOP_NOT_PROVEN'});
    let cancelled = null;
    const bridge = createOriginAgentBridge({
      submit: async () => ({}),
      get: async id => store.get('tasks', id),
      cancel: async (id) => { cancelled = id; store.put('tasks', {...store.get('tasks', id), state: 'CANCELLED'}); return {taskId: id, state: 'CANCELLED'}; },
      markConsumed: async (id, context, digest) => { store.put('tasks', {...store.get('tasks', id), pcfConsumedSessionId: context.sessionId, consumedDigest: digest}); },
    }, {authorize: async c => c.sessionId === 'S' && c.deviceId === 'alien'});

    // Visibility: the canonical task carries progress/placement reason/artifact/error/attention and inspect returns it.
    const inspected = await bridge.inspect('T3', AUTH);
    assert.equal(inspected.progress, 100);
    assert.equal(inspected.pcfPlacementReason, 'HARD_REQUIREMENT');
    assert.equal(inspected.pcfResult.outputRef, 'artifact:1');
    const failed = await bridge.inspect('T4', AUTH);
    assert.equal(failed.error, 'INPUT_DIGEST');
    assert.equal(failed.pcfAttention, 'EXECUTION_STOP_NOT_PROVEN');
    // ...and a task with no result has no result: attention is not silently rendered as a result.
    const failedProjection = projectOrigin(store.get('tasks', 'T4'), [], {auth: AUTH, after: 0});
    assert.equal(failedProjection.result, null);
    assert.equal(failedProjection.state, 'FAILED');

    // The origin can respond: collect, acknowledge, cancel.
    const delivery = await bridge.collect('T3', AUTH);
    assert.equal(delivery.result.value, 42);
    assert.equal(delivery.delivered, true);
    assert.equal(delivery.consumed, false);
    await bridge.acknowledge('T3', AUTH, 'b'.repeat(64));
    assert.equal((await bridge.collect('T3', AUTH)).consumed, true);
    assert.equal(store.get('tasks', 'T3').pcfConsumedSessionId, 'S');
    assert.equal((await bridge.cancel('T4', AUTH)).state, 'CANCELLED');
    assert.equal(cancelled, 'T4');

    // Spec revision 2 (line 56): returned to the surface, acknowledged by the caller, consumed by the agent are three
    // different facts, and the third is not observed here at all.
    const projection = buildFabricProjection({version: 1, reservations: [], attempts: []}, {backendConfigured: true, serviceState: 'RUNNING', tasks: store.list('tasks')});
    assert.equal(projection.resultReturned, 0); // nothing was DELIVERED through the service in this fixture
    assert.equal(projection.callerAcknowledged, 1);
    assert.equal(projection.agentConsumed, 'NOT_OBSERVED');
    assert.equal(projectOrigin(store.get('tasks', 'T3'), [], {auth: AUTH, after: 0}).agentConsumed, true);
  });
});

test('PCF-714 line 46: an offline origin catches up by bounded sequence, names its gap for reconciliation and never duplicates the result', async () => {
  await fixture(async ({store}) => {
    const task = {id: 'T2', actionId: 'A2', originDeviceId: 'alien', parentSessionId: 'S', state: 'COMPLETED', pcfResult: {value: 42}};
    store.event('TASK_CREATED', 'T2', {actionId: 'A2'}, 'pcf');
    store.event('TASK_RUNNING', 'T2', {actionId: 'A2'}, 'pcf');
    store.event('TASK_CREATED', 'T-other', {actionId: 'A9'}, 'pcf');
    store.event('TASK_COMPLETED', 'T2', {actionId: 'A2'}, 'pcf');
    const offline = projectOrigin(task, [], {auth: AUTH, after: 0});
    // While the origin was away the canonical result was written anyway.
    assert.equal(offline.state, 'COMPLETED');
    assert.equal(offline.result.value, 42);
    assert.deepEqual(offline.events, []);
    assert.equal(offline.cursor, 0);

    // Bounded catch-up: the first page stops at the limit and says a reconciliation is required.
    const first = projectOrigin(task, store.events(0), {auth: AUTH, after: 0, limit: 2});
    assert.deepEqual(first.events.map(e => e.seq), [1, 2]);
    assert.equal(first.cursor, 2);
    assert.equal(first.reconcileRequired, true);
    // Cursor is forward-only and the next page starts strictly after it, with no repeats.
    const second = projectOrigin(task, store.events(0), {auth: AUTH, after: first.cursor, limit: 2});
    assert.ok(second.events.every(e => e.seq > first.cursor));
    const seen = [...first.events, ...second.events].map(e => e.seq);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual([...seen].sort((a, b) => a - b), seen);

    // A retention gap is named rather than papered over: the caller holds a stream whose first surviving seq is 2, but
    // asks to catch up from 0, so the missing seq 1 is reported instead of being skipped silently.
    const truncated = projectOrigin(task, store.events(1), {auth: AUTH, after: 0});
    assert.equal(truncated.gap, true);
    assert.equal(truncated.reconcileRequired, true);
    assert.deepEqual(truncated.events.map(e => e.seq), [2, 4]);
    // Counterexample: reordered/duplicate deliveries of the SAME seq collapse to one event and one result, so nothing is
    // re-announced. (The alert channel itself is not part of this module.)
    const duplicated = projectOrigin(task, [...store.events(0), ...store.events(0)], {auth: AUTH, after: 0});
    assert.deepEqual(duplicated.events.map(e => e.seq), [1, 2, 4]);
    assert.equal(duplicated.reconcileRequired, false);
    assert.deepEqual(duplicated.result, projectOrigin(task, store.events(0), {auth: AUTH, after: 0}).result);
    // An unbounded or negative cursor is a typed refusal, not a silent clamp.
    for (const bad of [{after: 0, limit: 0}, {after: 0, limit: 257}, {after: -1, limit: 1}, {after: 1.5, limit: 1}]) {
      assert.throws(() => projectOrigin(task, store.events(0), {auth: AUTH, ...bad}), {code: 'CURSOR_LIMIT'});
    }
  });
});

test('PCF-714 line 50/56: an unauthorized, expired or rebound surface gets neither the result nor the metadata', async () => {
  await fixture(async ({store}) => {
    const task = {id: 'T5', actionId: 'A5', originDeviceId: 'alien', parentSessionId: 'S', state: 'COMPLETED',
      pcfResult: {value: 42, digest: 'c'.repeat(64)}, pcfPlacementReason: 'LOCAL_FIRST'};
    for (const auth of [
      {...AUTH, sessionId: 'other'},                       // a different session on the same device
      {...AUTH, deviceId: 'phone'},                        // a different device with the same session
      {...AUTH, authorized: false},                        // revoked authority
      {...AUTH, sessionId: 'other', hostname: hostname()}, // a matching HOSTNAME is not a session identity
    ]) {
      const error = (() => { try { projectOrigin(task, store.events(0), {auth, after: 0}); return null; } catch (thrown) { return thrown; } })();
      assert.equal(error?.code, 'ORIGIN_UNAUTHORIZED');
      // The refusal is a refusal: it carries no result, no events and no placement reason.
      assert.equal(error.result, undefined);
      assert.equal(error.events, undefined);
      assert.equal(error.pcfPlacementReason, undefined);
    }

    // Expired access is enforced by the real authority layer that feeds the projection, and the bridge consumes it.
    const facts = {version: 1, authorized: true, originDeviceId: 'alien', allowedDevices: ['alien', 'phone'], dataScopes: ['PUBLIC'],
      sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: 2000};
    const authorizeAt = async (now, context) => {
      try { assertPolicy(resolveEffectivePolicy({mode: 'TRUSTED_PERSONAL_FABRIC'}, facts, now), {deviceId: 'alien', dataScope: 'PUBLIC'}, now); }
      catch { return false; }
      return context.sessionId === 'S' && context.deviceId === 'alien';
    };
    let now = 1000;
    const bridge = createOriginAgentBridge({submit: async () => ({}), get: async () => task, cancel: async () => ({}), markConsumed: async () => ({})},
      {authorize: context => authorizeAt(now, context)});
    assert.equal((await bridge.inspect('T5', AUTH)).id, 'T5');
    now = 3000; // the authority instant has passed
    assert.throws(() => assertPolicy(resolveEffectivePolicy({mode: 'TRUSTED_PERSONAL_FABRIC'}, facts, 3000), {deviceId: 'alien', dataScope: 'PUBLIC'}, 3000), {code: 'AUTHORITY_EXPIRED_OR_REVOKED'});
    await assert.rejects(() => bridge.inspect('T5', AUTH), {code: 'ORIGIN_UNAUTHORIZED'});
    await assert.rejects(() => bridge.collect('T5', AUTH), {code: 'ORIGIN_UNAUTHORIZED'});
    await assert.rejects(() => bridge.cancel('T5', AUTH), {code: 'ORIGIN_UNAUTHORIZED'});
    await assert.rejects(() => bridge.submitRemoteJob({parentSessionId: 'S', originDeviceId: 'alien'}, AUTH), {code: 'ORIGIN_UNAUTHORIZED'});
    // A device rebinding inside a live authorization is refused by the canonical session binding, not by a hostname.
    now = 1000;
    await assert.rejects(() => bridge.inspect('T5', {...AUTH, sessionId: 'other'}), {code: 'ORIGIN_UNAUTHORIZED'});
  });
});

test('PCF-714 line 47: taking over on another surface reuses the assistant handoff/attention rules, creates no second task and shares no unauthorized context', async () => {
  await fixture(async () => {
    const handoff = createHandoffBridge();
    assert.deepEqual(handoff.noteAssignment({subjectRef: 'T6', deviceRef: 'alien'}).outcome, 'CLAIMED');
    // A retry from the device that already holds the task is idempotent - it does not create a second task.
    assert.deepEqual(handoff.noteAssignment({subjectRef: 'T6', deviceRef: 'alien'}).outcome, 'IDEMPOTENT');
    // The transfer only happens on the user's own recorded ALTERNATE_DEVICE decision.
    assert.equal(handoff.consider({task: {id: 'T6', assignedNodeId: 'alien'}, decided: {stage: 'PROVIDER_SWITCH', chosenDeviceRef: 'mech'}}).outcome, 'NOT_APPLICABLE');
    const moved = handoff.consider({task: {id: 'T6', assignedNodeId: 'alien', handoffTargetRef: null}, decided: {stage: 'ALTERNATE_DEVICE', chosenDeviceRef: 'phone'}});
    assert.equal(moved.outcome, 'TRANSFERRED');
    assert.deepEqual({from: moved.from, to: moved.to, epoch: moved.epoch}, {from: 'alien', to: 'phone', epoch: 2});
    assert.equal(handoff.holder('T6'), 'phone');                 // same subject, same task id: no second task was made
    // A repeated declaration of the same move is refused rather than executed twice.
    assert.equal(handoff.consider({task: {id: 'T6', assignedNodeId: 'phone', handoffTargetRef: 'phone'}, decided: {stage: 'ALTERNATE_DEVICE', chosenDeviceRef: 'phone'}}).outcome, 'REFUSED');
    assert.equal(handoff.consider({task: {id: 'T6', assignedNodeId: 'phone', handoffTargetRef: null}, decided: {stage: 'ALTERNATE_DEVICE', chosenDeviceRef: 'phone'}}).reason, 'SAME_DEVICE');
    // Unauthorized context: a device the transfer is not reserved for cannot claim the subject, and the previous holder
    // cannot reclaim it after the move.
    assert.equal(handoff.claimAllowed({subjectRef: 'T6', deviceRef: 'laptop', reservedFor: 'phone'}), false);
    assert.equal(handoff.claimAllowed({subjectRef: 'T6', deviceRef: 'phone', reservedFor: 'phone'}), true);
    assert.deepEqual(handoff.noteAssignment({subjectRef: 'T6', deviceRef: 'alien'}).outcome, 'ALREADY_CLAIMED');

    // The existing attention rules decide where a live question may be answered, and the bound is 2..3 auxiliary
    // devices - never the whole device list.
    const nowMs = Date.parse('2026-10-07T12:00:00.000Z');
    const iso = ms => new Date(ms).toISOString();
    const devices = ['alien', 'mech', 'phone', 'tablet', 'laptop', 'desk'].map((device_ref, index) =>
      ({device_ref, online: true, eligible: true, last_interacted_at: iso(nowMs - index * 60000)}));
    assert.deepEqual(rankRecentDevices(devices, {currentDeviceRef: 'alien', count: MAX_RECENT_DEVICES, nowMs}), ['mech', 'phone', 'tablet']);
    assert.throws(() => rankRecentDevices(devices, {currentDeviceRef: 'alien', count: devices.length, nowMs}), {code: 'RECENT_DEVICE_LIMIT'});
    const attention = createAttentionBridge({clock: () => nowMs});
    const envelope = {contract_version: 1, attention_id: 'att-1', job_ref: 'T6', connector_ref: 'codex', kind: 'CONFIRMATION',
      question: 'approve the failover?', blocking: true, created_at: iso(nowMs)};
    const opened = attention.open(envelope, {currentDeviceRef: 'alien', devices, at: nowMs});
    assert.equal(opened.opened, true);
    assert.equal(opened.event.projections.length, MAX_RECENT_DEVICES + 1);
    assert.deepEqual(opened.event.projections.map(p => p.device_ref), ['alien', 'mech', 'phone', 'tablet']);
    assert.ok(opened.event.projections.filter(p => p.actionable).every(p => p.device_ref === 'alien'));
    // A device switch onto an ineligible surface is refused instead of silently becoming the interaction device.
    assert.throws(() => attention.open({...envelope, attention_id: 'att-2'}, {currentDeviceRef: 'tablet',
      devices: devices.map(d => d.device_ref === 'tablet' ? {...d, online: false} : d), at: nowMs}), {code: 'CURRENT_DEVICE_NOT_ELIGIBLE'});
  });
});

test('PCF-714 line 48: cancel/approval/completion races resolve through one terminal truth, and an unknown external effect stays attention', async () => {
  await fixture(async ({store, owner}) => {
    const {attempt} = await runningAttempt({store, owner});
    // A late cancel of side-effecting work is not a retry: recovery demands attention rather than claiming withdrawal.
    assert.deepEqual(planRecovery({taskId: 'T', retryClass: 'SIDE_EFFECT_UNKNOWN'}, {authorized: true, previousStopped: true, now: 0}),
      {action: 'ATTENTION', reason: 'SIDE_EFFECT_OR_COMPATIBILITY_UNKNOWN', taskId: 'T'});
    assert.equal(planRecovery({taskId: 'T', retryClass: 'PURE', strictTargetDeviceId: 'alien'}, {authorized: true, previousStopped: true, now: 0, newDeviceId: 'phone'}).reason, 'STRICT_TARGET_NEW_APPROVAL_REQUIRED');

    // The worker completes with an UNKNOWN outcome: one canonical truth that IS "unknown", not a cancelled success.
    const unknown = commitResult(owner, {taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch, holder: 'h', bootId: 'b-alien',
      outcome: 'UNKNOWN', outputDigest: null, now: 1200});
    assert.equal(unknown.attention, 'SIDE_EFFECT_UNKNOWN');
    assert.equal(unknown.committed, false);
    const task = store.get('tasks', 'T');
    assert.equal(task.state, 'RUNNING');
    assert.equal(task.pcfAttention, 'SIDE_EFFECT_UNKNOWN');
    assert.equal(owner.snapshot().reservations.length, 1); // the reservation stays charged: the effect may have happened
    const pending = owner.snapshot().attempts.find(a => a.id === attempt.id);
    assert.equal(pending.pendingOutcome, 'UNKNOWN');

    // Every reconciler agrees: an uncertain outcome is an attention item, never an automatic retry or failover.
    assert.deepEqual(reconcileExecution(owner.snapshot(), [{holder: 'h', bootId: 'b-alien', alive: true}], 2000),
      [{action: 'ATTENTION_UNCERTAIN_OUTCOME', taskId: 'T', attemptId: attempt.id}]);
    await assert.rejects(() => recoverStoppedAttempt({owner, taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch,
      proveStopped: async () => ({stopped: true}), authorize: async () => true}), {code: 'RECOVERY_ATTEMPT'});

    // The origin surface reads the canonical result as UNKNOWN rather than as a success, next to the attention.
    const projection = projectOrigin(store.get('tasks', 'T'), [], {auth: AUTH, after: 0});
    assert.equal(projection.state, 'RUNNING');
    assert.equal(projection.result.outcome, 'UNKNOWN');
    assert.equal(projection.result.outputDigest, null);
    assert.equal(store.get('tasks', 'T').pcfAttention, 'SIDE_EFFECT_UNKNOWN');
  });
});

test('PCF-714 line 48: a later terminal claim must not overwrite an uncertain (SIDE_EFFECT_UNKNOWN) outcome', async () => {
  await fixture(async ({store, owner}) => {
    const {attempt} = await runningAttempt({store, owner});
    commitResult(owner, {taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch, holder: 'h', bootId: 'b-alien', outcome: 'UNKNOWN', outputDigest: null, now: 1200});
    // An unknown external effect is terminal until an INDEPENDENT verification: a late cancel must not be able to claim
    // the effect was withdrawn while the canonical attention still says it is unknown.
    assert.throws(() => commitResult(owner, {taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch, holder: 'h', bootId: 'b-alien',
      outcome: 'CANCELLED', outputDigest: null, now: 1300}), {code: 'OUTCOME_UNKNOWN_REQUIRES_VERIFICATION'});
    assert.throws(() => commitResult(owner, {taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch, holder: 'h', bootId: 'b-alien',
      outcome: 'SUCCEEDED', outputDigest: 'a'.repeat(64), now: 1300}), {code: 'OUTCOME_UNKNOWN_REQUIRES_VERIFICATION'}, 'a later success needs the same verification');
    // Two contradicting terminal truths are impossible: the task keeps ONE state and the attention is unchanged.
    const task = store.get('tasks', 'T');
    assert.equal(task.pcfAttention, 'SIDE_EFFECT_UNKNOWN');
    assert.equal(task.state, 'RUNNING');
    assert.notEqual(task.state, 'CANCELLED');
    assert.equal(owner.snapshot().attempts[0].pendingOutcome, 'UNKNOWN');
    // The only way past it is the verification PCF-705 establishes, and it is recorded on the attempt.
    commitResult(owner, {taskId: 'T', attemptId: attempt.id, epoch: attempt.epoch, holder: 'h', bootId: 'b-alien', outcome: 'CANCELLED', outputDigest: null, now: 1400,
      verification: {verifiedBy: 'pcf-705-reconciliation', evidenceRef: 'evidence:stop-proof-1'}});
    assert.equal(store.get('tasks', 'T').state, 'CANCELLED');
    assert.deepEqual(owner.snapshot().attempts[0].verification, {verifiedBy: 'pcf-705-reconciliation', evidenceRef: 'evidence:stop-proof-1'});
    assert.equal(owner.snapshot().attempts[0].pendingOutcome, 'VERIFIED');
  });
});
