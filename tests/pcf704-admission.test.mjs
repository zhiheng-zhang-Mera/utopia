// PCF-704 acceptance: atomic admission, reservations and the fair queue.
//
// Workbook: dc/mission-book/mission-group/personal-compute-fabric/PCF-704-admission-reservations-and-fairness.md
// (English mirror under en/). Every test names the workbook line it covers, and the assertions are the workbook's own
// counterexamples - "it throws" is never the check, the typed refusal and the resource arithmetic are.
//
// Two workbook sentences cannot be settled in this checkout and are marked rather than dropped: bounded contention on
// two real hosts (NOT_RUN: one host here) and the "at least one foreground budget" reservation (NOT_IMPLEMENTED: the
// admission path consumes the candidate's whole observed free vector and defines no foreground reserve).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../services/dev-gateway/store.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {admit, release, claimAttempt, commitResult} from '../services/personal-compute-fabric/admission.mjs';
import {planPlacement, feasibility, FEASIBILITY_REFUSALS} from '../services/personal-compute-fabric/placement.mjs';
import {fairQueue} from '../services/personal-compute-fabric/fair-queue.mjs';
import {buildFabricProjection} from '../services/personal-compute-fabric/presentation.mjs';
import {normalizeExecutionProvider, describeExecutorBoundary} from '../services/personal-compute-fabric/executor-provider.mjs';

const NOW = 1000;
const policy = {version: 7, authorized: true, originDeviceId: 'alien', mode: 'TRUSTED_PERSONAL_FABRIC', allowedDevices: ['alien', 'mech', 'ghost'], dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: 5000};
const workload = (taskId, extra = {}) => ({taskId, actionId: 'A-' + taskId, originDeviceId: 'alien', parentSessionId: 'S', appId: 'one', dataScope: 'PUBLIC', kind: 'CPU_JSON', capabilities: ['cpu.json'], resources: {cpu: 1, memory: 10}, deadlineAt: 4000, writeScope: [], qos: 'BATCH', ...extra});
const candidate = (deviceId = 'alien', extra = {}) => ({deviceId, bootId: 'boot-' + deviceId, trusted: true, authorized: true, executorReady: true, sharing: true, platform: 'win32',
  provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'}, observationVersion: 1, observedAt: 900, validUntil: 3000,
  free: {cpu: 2, memory: 100}, queueMs: 10, cost: {inputMs: [1, 2], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2]}, ...extra});
const task = (taskId, extra = {}) => ({id: taskId, state: 'QUEUED', actionId: 'A-' + taskId, originDeviceId: 'alien', parentSessionId: 'S', ...extra});
const request = (w, cand = candidate(), extra = {}) => ({workload: w, proposal: planPlacement(w, [cand], policy, NOW), policy, candidate: cand,
  idempotencyKey: 'key:' + w.taskId, ttlMs: 1000, appQuota: {cpu: 64, memory: 10000}, now: NOW, ...extra});
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pcf704-'));
  const store = new Store(dir);
  try { await run(store, createCanonicalStateAdapter(store)); }
  finally { store.db.close(); await rm(dir, {recursive: true, force: true}); }
}

// Workbook sub-task 1: "明确资源向量与可用/已预留量；candidate预估不等于reservation" and the acceptance clause
// "容量不足不部分占死". A proposal is an estimate; only the canonical reservation binds capacity.
test('PCF704-01 a placement estimate is not a reservation, and admission binds the reserved capacity', async () => {
  await fixture(async (store, owner) => {
    const w = workload('T1');
    const only = candidate('alien', {free: {cpu: 1, memory: 10}});
    const proposal = planPlacement(w, [only], policy, NOW);
    assert.equal(proposal.state, 'PROPOSED');
    assert.equal(proposal.reservation, undefined, 'the proposal carries no reservation identity');
    assert.equal(owner.snapshot().reservations.length, 0, 'planning alone reserves nothing');
    store.put('tasks', task('T1'));
    const admitted = admit(owner, request(w, only));
    assert.equal(admitted.reservation.state, 'LEASED');
    assert.equal(admitted.reservation.expiresAt, 2000, 'the TTL is capped by the proposal expiry');
    assert.deepEqual(admitted.reservation.resources, {cpu: 1, memory: 10});
    assert.match(admitted.reservation.id, /^[a-f0-9-]{36}$/);
    assert.equal(owner.snapshot().reservations.length, 1);
    // Available (free) versus reserved: the one free unit is now held, so a second task is refused by name.
    store.put('tasks', task('T2'));
    assert.throws(() => admit(owner, request(workload('T2'), only)), {code: 'CAPACITY_RESERVED'});
    assert.equal(owner.snapshot().reservations.length, 1);
    // Releasing the hold is what makes the unit available again - not a new estimate.
    release(owner, {reservationId: admitted.reservation.id, now: 1500});
    assert.equal(admit(owner, request(workload('T2'), only)).reservation.deviceId, 'alien');
  });
});

// Workbook acceptance: "两个并发请求抢最后一份资源只有一个成功" plus sub-task 1's "并发CAS/单写者等价语义".
test('PCF704-02 two requests for the last unit: one wins, the loser is refused by capacity or by the CAS version', async () => {
  await fixture(async (store, owner) => {
    store.put('tasks', task('T1'));
    store.put('tasks', task('T2'));
    const only = candidate('alien', {free: {cpu: 1, memory: 10}});
    // Both requests were built from the same observation of a single free unit.
    const first = admit(owner, request(workload('T1'), only, {expectedVersion: 0}));
    assert.equal(first.version, 1);
    assert.equal(first.reservation.deviceId, 'alien');
    assert.throws(() => admit(owner, request(workload('T2'), only)), {code: 'CAPACITY_RESERVED'});
    assert.equal(owner.snapshot().reservations.length, 1, 'the losing request left no reservation');
    // Single-writer equivalence: two requests that both carry the same expected canonical version cannot both commit.
    store.put('tasks', task('T3'));
    store.put('tasks', task('T4'));
    const roomy = candidate('alien', {free: {cpu: 8, memory: 100}});
    const at = owner.snapshot().version;
    admit(owner, request(workload('T3'), roomy, {expectedVersion: at}));
    assert.throws(() => admit(owner, request(workload('T4'), roomy, {expectedVersion: at})), {code: 'STALE_CANONICAL_VERSION'});
    assert.equal(owner.snapshot().reservations.length, 2, 'the fenced request did not reserve anything');
  });
});

// Workbook acceptance: "重复admit不重复扣账" and sub-task 1's "幂等准入".
test('PCF704-03 repeated admission under one idempotency key does not double charge', async () => {
  await fixture(async (store, owner) => {
    for (const id of ['T1', 'T2', 'T3', 'T4']) store.put('tasks', task(id));
    const two = candidate('alien', {free: {cpu: 2, memory: 20}});
    const first = admit(owner, request(workload('T1'), two));
    const replay = admit(owner, request(workload('T1'), two));
    assert.equal(replay.reservation.id, first.reservation.id);
    assert.equal(owner.snapshot().reservations.length, 1, 'the replay created no second charge');
    // Had the replay double charged, the second unit would be gone and T2 would be refused.
    admit(owner, request(workload('T2'), two));
    assert.equal(owner.snapshot().reservations.reduce((sum, entry) => sum + entry.resources.cpu, 0), 2);
    assert.throws(() => admit(owner, request(workload('T3'), two)), {code: 'CAPACITY_RESERVED'});
    // Reusing the key for other work is a conflict, not a silent second reservation.
    assert.throws(() => admit(owner, request(workload('T4'), two, {idempotencyKey: 'key:T1'})), {code: 'IDEMPOTENCY_CONFLICT'});
    // The TTL and key inputs are bounded, and a bad one reserves nothing.
    for (const bad of [{ttlMs: 0}, {ttlMs: 60001}, {ttlMs: Infinity}, {idempotencyKey: ''}]) {
      assert.throws(() => admit(owner, request(workload('T4'), two, bad)), {code: 'RESERVATION_INPUT'});
    }
    assert.equal(owner.snapshot().reservations.length, 2);
  });
});

// Workbook acceptance: "失败/取消/过期无泄漏", plus the code's own rule that a timeout is not proof of a stop.
test('PCF704-04 failure, cancellation and expiry leave no reservation behind - and a RUNNING timeout is not a release', async () => {
  await fixture(async (store, owner) => {
    const one = candidate('alien', {free: {cpu: 1, memory: 10}});
    // A FAILED outcome releases the hold.
    store.put('tasks', task('F'));
    const failed = admit(owner, request(workload('F'), one));
    const failedAttempt = claimAttempt(owner, {reservationId: failed.reservation.id, holder: 'h', bootId: 'boot-alien', now: 1100});
    commitResult(owner, {taskId: 'F', attemptId: failedAttempt.id, epoch: failedAttempt.epoch, holder: 'h', bootId: 'boot-alien', outcome: 'FAILED', reason: 'EXECUTOR_EXIT', now: 1200});
    assert.equal(owner.snapshot().reservations.length, 0);
    assert.equal(store.get('tasks', 'F').state, 'FAILED');
    // A CANCELLED outcome releases the hold too.
    store.put('tasks', task('C'));
    const cancelled = admit(owner, request(workload('C'), one));
    const cancelledAttempt = claimAttempt(owner, {reservationId: cancelled.reservation.id, holder: 'h', bootId: 'boot-alien', now: 1100});
    commitResult(owner, {taskId: 'C', attemptId: cancelledAttempt.id, epoch: cancelledAttempt.epoch, holder: 'h', bootId: 'boot-alien', outcome: 'CANCELLED', now: 1200});
    assert.equal(owner.snapshot().reservations.length, 0);
    assert.equal(store.get('tasks', 'C').state, 'CANCELLED');
    // An explicit cancellation release works once, and only once.
    store.put('tasks', task('R'));
    const released = admit(owner, request(workload('R'), one));
    release(owner, {reservationId: released.reservation.id, now: 1300});
    assert.equal(owner.snapshot().reservations.length, 0);
    assert.throws(() => release(owner, {reservationId: released.reservation.id, now: 1400}), {code: 'RESERVATION_UNKNOWN'});
    // An expired LEASE no longer charges capacity.
    store.put('tasks', task('E'));
    const expiredLease = admit(owner, request(workload('E'), one, {ttlMs: 500}));
    store.put('tasks', task('E2'));
    const tookTheUnit = admit(owner, request(workload('E2'), one, {now: 1600}));
    assert.equal(tookTheUnit.reservation.deviceId, 'alien');
    release(owner, {reservationId: tookTheUnit.reservation.id, now: 2000});
    release(owner, {reservationId: expiredLease.reservation.id, now: 2000});
    // But an expired RUNNING reservation stays charged: timeout is not proof that the holder stopped.
    store.put('tasks', task('RUN'));
    const running = admit(owner, request(workload('RUN'), one, {ttlMs: 500, now: 1600}));
    assert.equal(running.reservation.expiresAt, 2100);
    claimAttempt(owner, {reservationId: running.reservation.id, holder: 'h', bootId: 'boot-alien', now: 1700});
    assert.throws(() => release(owner, {reservationId: running.reservation.id, now: 1800}), {code: 'RUNNING_REQUIRES_STOP_PROOF'});
    store.put('tasks', task('NEXT'));
    assert.throws(() => admit(owner, request(workload('NEXT'), one, {now: 2500})), {code: 'CAPACITY_RESERVED'});
    assert.equal(owner.snapshot().reservations[0].state, 'RUNNING');
  });
});

// Workbook sub-task 2: "多阶段/多资源请求采用有界 all-or-nothing 预留...禁止长期 hold-and-wait 死锁" and the acceptance
// clause "容量不足不部分占死". A partly-satisfied request must roll back completely and must not block the queue.
test('PCF704-05 an under-capacity multi-resource request is all-or-nothing: no partial hold, no deadlock', async () => {
  await fixture(async (store, owner) => {
    for (const id of ['H', 'BIG', 'SMALL', 'Q']) store.put('tasks', task(id));
    const big = candidate('alien', {free: {cpu: 8, memory: 12}});
    admit(owner, request(workload('H', {resources: {cpu: 1, memory: 10}}), big));
    assert.equal(owner.snapshot().reservations.length, 1);
    // cpu fits (1+1 <= 8) but memory does not (10+5 > 12): the whole request is refused, not half-taken.
    assert.throws(() => admit(owner, request(workload('BIG', {resources: {cpu: 1, memory: 5}}), big)), {code: 'CAPACITY_RESERVED'});
    assert.equal(owner.snapshot().reservations.length, 1, 'no partial reservation survived the rollback');
    assert.ok(!owner.snapshot().reservations.some(entry => entry.taskId === 'BIG'));
    // Nothing is deadlocked: what does fit is admitted immediately afterwards.
    admit(owner, request(workload('SMALL', {resources: {cpu: 1, memory: 2}}), big));
    assert.equal(owner.snapshot().reservations.length, 2);
    // The per-application quota is checked in the same transaction under the same all-or-nothing rule.
    assert.throws(() => admit(owner, request(workload('Q', {resources: {cpu: 1, memory: 5}}), big, {appQuota: {cpu: 8, memory: 4}})), {code: 'APP_QUOTA'});
    assert.equal(owner.snapshot().reservations.length, 2);
    // Spec rev 2: an unknown hard requirement is not guessed as satisfied and never becomes a reservation.
    const blind = candidate('alien', {free: {cpu: 8}});
    const unknown = planPlacement(workload('U'), [blind], policy, NOW);
    assert.equal(unknown.state, 'REFUSED');
    assert.equal(unknown.decisions[0].code, FEASIBILITY_REFUSALS.RESOURCE_UNKNOWN);
    assert.equal(unknown.decisions[0].remedy, 'REMEASURE_REQUIRED');
    assert.throws(() => admit(owner, {...request(workload('U'), blind), proposal: unknown}), {code: 'PROPOSAL_BINDING'});
    assert.equal(owner.snapshot().reservations.length, 2);
  });
});

// Workbook sub-task 3: "有界队列、per-app配额..." and the acceptance clause "queue full显式披露".
test('PCF704-06 per-app quota, a full queue and overlapping write scopes are disclosed by name', async () => {
  await fixture(async (store, owner) => {
    for (const id of ['A1', 'A2', 'B1', 'C1', 'W1', 'W2']) store.put('tasks', task(id));
    const room = candidate('alien', {free: {cpu: 8, memory: 100}});
    const quota = {cpu: 1, memory: 100};
    admit(owner, request(workload('A1', {appId: 'chat'}), room, {appQuota: quota}));
    // The quota is per application: a second task of the same app is refused ...
    assert.throws(() => admit(owner, request(workload('A2', {appId: 'chat'}), room, {appQuota: quota})), {code: 'APP_QUOTA'});
    // ... while another application still gets the device.
    admit(owner, request(workload('B1', {appId: 'batch'}), room, {appQuota: quota}));
    // One task cannot hold two reservations.
    admit(owner, request(workload('C1'), room));
    assert.throws(() => admit(owner, request(workload('C1'), room, {idempotencyKey: 'another'})), {code: 'TASK_ALREADY_RESERVED'});
    // Overlapping write scopes conflict instead of both being admitted.
    admit(owner, request(workload('W1', {writeScope: ['work/a']}), room));
    assert.throws(() => admit(owner, request(workload('W2', {writeScope: ['work/a/b']}), room)), {code: 'WRITE_SCOPE_CONFLICT'});
  });
  // A bounded queue says it is full instead of dropping work silently.
  await fixture(async (store, owner) => {
    const room = candidate('alien', {free: {cpu: 1000, memory: 100000}});
    const quota = {cpu: 1000, memory: 100000};
    const fill = id => admit(owner, request(workload(id, {resources: {cpu: 1, memory: 1}}), room, {appQuota: quota})).reservation;
    let last = null;
    for (let index = 0; index < 256; index += 1) {
      store.put('tasks', task('Q' + index));
      last = fill('Q' + index);
    }
    assert.equal(last.expiresAt, 2000, 'all 256 permitted reservations were admitted');
    store.put('tasks', task('QOVER'));
    assert.throws(() => admit(owner, request(workload('QOVER', {resources: {cpu: 1, memory: 1}}), room, {appQuota: quota})), {code: 'QUEUE_FULL'});
    // The refused work is really absent: one release makes room for it again.
    release(owner, {reservationId: last.id, now: 1500});
    assert.equal(fill('QOVER').taskId, 'QOVER');
  });
});

// Workbook acceptance "queue full显式披露", observer side. The admission refusal above works; reading the canonical
// state back at that same depth does not, and that gap is recorded here rather than described in prose only.
test('PCF704 acceptance: an observer can read the canonical state while the queue is full', () => {
  // FIXED: the snapshot bound is now the STORE's own declared limit instead of the 64 KiB untrusted-INPUT guard, so the
  // observer side of "queue full is explicitly disclosed" can actually read a queue at the depth admission permits.
  const dir = mkdtempSync(join(tmpdir(), 'pcf704-observer-'));
  try {
    const store = new Store(dir);
    try {
      store.put('tasks', {id: 'T-full', state: 'QUEUED', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S'});
      const owner = createCanonicalStateAdapter(store);
      const state = owner.snapshot();
      // 256 full reservation records are what admission itself allows; the row is written directly because admitting
      // them one by one is covered elsewhere and would only re-test admission, not the observer.
      const synthetic = {version: 1, epoch: 0, attempts: [], completedKeys: [],
        reservations: Array.from({length: 256}, (_, index) => ({id: 'r' + index, key: 'k' + index, taskId: 'T' + index, actionId: 'A',
          originDeviceId: 'alien', parentSessionId: 'S', appId: 'app', deviceId: 'alien', bootId: 'boot', providerId: 'cpu',
          resources: {cpu: 1, memory: 1048576}, writeScope: [], policyVersion: 1, expiresAt: 9_999_999_999_999, state: 'LEASED'}))};
      store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('pcf.execution.v1', JSON.stringify(synthetic));
      const observed = owner.snapshot();
      assert.equal(observed.reservations.length, 256, 'every reservation is visible at the permitted queue depth');
      assert.equal(Buffer.byteLength(JSON.stringify(observed)) > 65536, true, 'the state really is larger than the untrusted-input guard');
      // ...and the store's own bound is still a TYPED refusal rather than a silent truncation.
      assert.throws(() => owner.snapshot({maxBytes: 64}), {code: /^SNAPSHOT_LIMIT:/});
      assert.equal(state.reservations.length, 0, 'the read is a point-in-time projection and holds no execution authority');
    } finally { store.db.close(); }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

// Workbook sub-task 3: "公平轮转/aging、优先级和 deadline refusal；'提高交互优先级'不能无限饿死后台".
test('PCF704-07 sustained small work cannot starve a background task: bounded rotation with aging, no priority input', () => {
  const queued = (id, appId, queuedAt, qos = 'BATCH') => ({id, appId, queuedAt, qos});
  const mixed = [queued('c1', 'chat', 100), queued('c2', 'chat', 110), queued('c3', 'chat', 120), queued('b1', 'batch', 105), queued('b2', 'batch', 115)];
  // Rotation: the application served last waits, so one application cannot hold the head of the queue.
  assert.deepEqual(fairQueue(mixed, {lastAppId: 'chat', now: 200, agingMs: 30000}).map(entry => entry.id), ['b1', 'c1', 'b2', 'c2', 'c3']);
  // There is no priority input at all: a fresh INTERACTIVE task cannot overtake an older BACKGROUND one.
  const priority = [queued('bg', 'batch', 100, 'BACKGROUND'), queued('fg', 'chat', 101, 'INTERACTIVE')];
  assert.deepEqual(fairQueue(priority, {lastAppId: 'chat', now: 200, agingMs: 30000}).map(entry => entry.id), ['bg', 'fg']);
  assert.deepEqual(fairQueue(priority, {lastAppId: null, now: 200, agingMs: 30000}).map(entry => entry.id), ['bg', 'fg']);
  // Aging promotes a long wait past the rotation rule, so a stream of fresh work cannot hold a slot forever: the same
  // two heads flip order only because the de-prioritised one has now waited past agingMs.
  const aging = [queued('alphaYoung', 'alpha', 30000), queued('betaOlder', 'beta', 20000)];
  assert.deepEqual(fairQueue(aging, {lastAppId: 'beta', now: 45000, agingMs: 30000}).map(entry => entry.id), ['alphaYoung', 'betaOlder']);
  assert.deepEqual(fairQueue(aging, {lastAppId: 'beta', now: 55000, agingMs: 30000}).map(entry => entry.id), ['betaOlder', 'alphaYoung']);
  // Bounded and typed: the limit is disclosed rather than silently dropping the tail.
  assert.throws(() => fairQueue(Array.from({length: 257}, (_, index) => queued('t' + index, 'app', index)), {now: 1000}), {code: 'FAIR_QUEUE_LIMIT'});
  assert.throws(() => fairQueue([queued('x', 'app', 100)], {now: 1000, maxItems: 300}), {code: 'FAIR_QUEUE_LIMIT'});
  assert.throws(() => fairQueue([{id: 'x', appId: 'app', queuedAt: 2000}], {now: 1000}), {code: 'QUEUE_RECORD'});
  assert.throws(() => fairQueue([{id: 'x', queuedAt: 100}], {now: 1000}), {code: 'QUEUE_RECORD'});
  // Deterministic tie-break: equal queue times are ordered by identity, never by arrival order.
  assert.deepEqual(fairQueue([queued('z', 'app', 100), queued('a', 'app', 100)], {now: 200}).map(entry => entry.id), ['a', 'z']);
});

// Workbook sub-task 4: "检查准入时的 policy/revocation/state/telemetry版本。估计过期应重算而不是用旧 freeSlots 强行启动"
// and the acceptance clause "旧版本拒绝".
test('PCF704-08 a stale policy, observation or estimate is refused and re-measured, never forced through', async () => {
  await fixture(async (store, owner) => {
    const w = workload('S');
    store.put('tasks', task('S'));
    const fresh = candidate('alien');
    const base = {...request(w, fresh)};
    // An older policy version than the one the proposal was computed from.
    assert.throws(() => admit(owner, {...base, policy: {...policy, version: 8}}), {code: 'STALE_PROPOSAL'});
    // A newer observation of the same device supersedes the estimate the proposal was ranked on.
    assert.throws(() => admit(owner, {...base, candidate: candidate('alien', {observationVersion: 2})}), {code: 'STALE_PROPOSAL'});
    // Past the proposal's own expiry the estimate is stale even when nothing else changed.
    assert.throws(() => admit(owner, {...base, now: 3001}), {code: 'STALE_PROPOSAL'});
    // Revocation and a shrunk free reading between planning and admission are revalidation failures, not stale ones.
    assert.throws(() => admit(owner, {...base, candidate: candidate('alien', {authorized: false})}), {code: 'REVALIDATION_FAILED'});
    assert.throws(() => admit(owner, {...base, candidate: candidate('alien', {trusted: false})}), {code: 'REVALIDATION_FAILED'});
    assert.throws(() => admit(owner, {...base, candidate: candidate('alien', {free: {cpu: 0, memory: 0}})}), {code: 'REVALIDATION_FAILED'});
    // A proposal computed for other work, or one that was itself refused, cannot be admitted at all.
    assert.throws(() => admit(owner, {...base, proposal: planPlacement(workload('OTHER'), [fresh], policy, NOW)}), {code: 'PROPOSAL_BINDING'});
    assert.throws(() => admit(owner, {...base, proposal: planPlacement(w, [candidate('alien', {trusted: false})], policy, NOW)}), {code: 'PROPOSAL_BINDING'});
    assert.equal(owner.snapshot().reservations.length, 0, 'no refused admission left a reservation behind');
    // A re-measured estimate is the only thing that admits.
    assert.equal(admit(owner, base).reservation.deviceId, 'alien');
    // Deadline refusal: a workload whose declared deadline has passed is refused, not launched against a stale
    // free-slot estimate (the proposal expiry is the minimum of candidate validity, policy expiry and the deadline).
    store.put('tasks', task('D'));
    const late = workload('D', {deadlineAt: 900});
    const lateProposal = planPlacement(late, [candidate('alien')], policy, NOW);
    assert.equal(lateProposal.state, 'PROPOSED');
    assert.equal(lateProposal.validUntil, 900);
    assert.throws(() => admit(owner, {...request(late, candidate('alien')), proposal: lateProposal}), {code: 'STALE_PROPOSAL'});
  });
});

// Workbook spec rev 2: "queued/leased/running/draining分开", "未知硬资源不得猜满足" and sub-task 1's honest limit
// "逻辑配额不宣称OS隔离". The reservation state machine and the projection are checked together.
test('PCF704-09 spec-rev2: LEASED and RUNNING are distinct, and a logical reservation is not an isolation proof', async () => {
  await fixture(async (store, owner) => {
    store.put('tasks', task('L'));
    const admitted = admit(owner, request(workload('L'), candidate('alien', {free: {cpu: 2, memory: 20}})));
    assert.equal(admitted.reservation.state, 'LEASED');
    assert.equal(owner.snapshot().attempts.length, 0, 'a lease is not yet a running attempt');
    assert.equal(store.get('tasks', 'L').state, 'QUEUED');
    const attempt = claimAttempt(owner, {reservationId: admitted.reservation.id, holder: 'worker', bootId: 'boot-alien', now: 1100});
    assert.equal(attempt.state, 'RUNNING');
    const snapshot = owner.snapshot();
    assert.equal(snapshot.reservations[0].state, 'RUNNING');
    assert.equal(snapshot.attempts[0].state, 'RUNNING');
    assert.equal(store.get('tasks', 'L').state, 'RUNNING');
    assert.equal(store.get('tasks', 'L').pcfAttemptId, attempt.id);
    // The lease is bound to one boot and cannot be claimed twice or from a different boot.
    assert.throws(() => claimAttempt(owner, {reservationId: admitted.reservation.id, holder: 'worker', bootId: 'boot-other', now: 1200}), {code: 'LEASE_INVALID'});
    assert.throws(() => claimAttempt(owner, {reservationId: admitted.reservation.id, holder: 'other', bootId: 'boot-alien', now: 1200}), {code: 'LEASE_INVALID'});
    // The projection counts the leased/running split and does not present sharing as execution readiness.
    const projection = buildFabricProjection(snapshot, {backendConfigured: true, serviceState: 'RUNNING'});
    assert.equal(projection.reservations, 1);
    assert.equal(projection.running, 1);
    assert.equal(projection.sharingDoesNotImplyExecutionReadiness, true);
    assert.equal(projection.controls.scope, 'APPROVED_LOCAL_CPU_ONLY');
    assert.equal(projection.controls.reason, 'OPPOSITE_HOST_ACCEPTANCE_PENDING');
    // A reservation is a logical quota, not OS isolation: the provider boundary stays COOPERATIVE.
    const boundary = describeExecutorBoundary(normalizeExecutionProvider({version: 1, id: 'cpu', platform: 'win32', capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE', ready: true}));
    assert.equal(boundary.enforcement, 'COOPERATIVE');
    // An unmeasured resource reading is REMEASURE at ranking time and revalidated at admission - never "free".
    const unmeasured = planPlacement(workload('U2', {resources: {cpu: 1, vram: 8}}), [candidate('alien')], policy, NOW);
    assert.equal(unmeasured.state, 'REFUSED');
    assert.equal(unmeasured.decisions[0].code, FEASIBILITY_REFUSALS.RESOURCE_UNKNOWN);
    assert.equal(unmeasured.decisions[0].remedy, 'REMEASURE_REQUIRED');
    assert.equal(feasibility(workload('U2', {resources: {cpu: 1, vram: 8}}), candidate('alien'), policy, NOW), FEASIBILITY_REFUSALS.RESOURCE_UNKNOWN);
  });
});

// Workbook sub-task 1: "持久恢复接712" - the reservation is canonical durable state, not a second in-memory pool.
test('PCF704-10 a reservation survives a store restart because it lives in the canonical owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf704-restart-'));
  let store = new Store(dir);
  try {
    store.put('tasks', task('T1'));
    const first = admit(createCanonicalStateAdapter(store), request(workload('T1')));
    const reservationId = first.reservation.id;
    assert.equal(first.version, 1);
    store.db.close();
    store = new Store(dir);
    const reopened = createCanonicalStateAdapter(store);
    const snapshot = reopened.snapshot();
    assert.equal(snapshot.version, 1, 'the canonical version is durable, so 712 CAS still fences across a restart');
    assert.equal(snapshot.reservations.length, 1);
    assert.equal(snapshot.reservations[0].id, reservationId);
    assert.equal(snapshot.reservations[0].state, 'LEASED');
    // The reopened owner is the same single writer: a fenced admission against the old version is refused.
    assert.throws(() => admit(reopened, request(workload('T1'), candidate('alien', {free: {cpu: 1, memory: 10}}), {expectedVersion: 0})), {code: 'STALE_CANONICAL_VERSION'});
  } finally { store.db.close(); await rm(dir, {recursive: true, force: true}); }
});

// Workbook spec rev 2: "至少保留一个foreground预算". FIXED: admission now holds a declared foreground reserve so a
// BATCH/BACKGROUND reservation can never spend the last unit an interactive task needs. The reserve is DECLARED by the
// caller (a workload without the extension keeps its legacy behaviour, per PCF-708), and when declared it must be at
// least one unit - which is exactly what the spec sentence asks for.
test('PCF704 spec-rev2: at least one foreground budget is reserved against admission', async () => {
  await fixture(async (store, owner) => {
    // One roomy device, so the reserve is what decides each case rather than the device's own free vector.
    const big = candidate('alien', {free: {cpu: 64, memory: 100000}});
    // A quota of 1 cpu with a one-unit reserve: interactive work may take it, batch work may not.
    store.put('tasks', task('T-batch'));
    store.put('tasks', task('T-interactive'));
    const batch = request(workload('T-batch', {qos: 'BATCH', appId: 'batch'}), big, {foregroundReserve: {cpu: 1}, appQuota: {cpu: 1, memory: 10}});
    const held = (() => { try { return admit(owner, batch); } catch (error) { return error; } })();
    assert.equal(held.code, 'FOREGROUND_RESERVE_HELD:cpu');
    const interactive = request(workload('T-interactive', {qos: 'INTERACTIVE', appId: 'chat'}), big, {foregroundReserve: {cpu: 1}, appQuota: {cpu: 1, memory: 10}});
    assert.equal(admit(owner, interactive).reservation.state, 'LEASED', 'the reserve is there for interactive work');
    // With a quota of 2 and a reserve of 1, one batch unit fits and the second does not (same app, so the quota is shared).
    store.put('tasks', task('T-batch-1'));
    store.put('tasks', task('T-batch-2'));
    const quota = {foregroundReserve: {cpu: 1}, appQuota: {cpu: 2, memory: 10}};
    assert.equal(admit(owner, request(workload('T-batch-1', {qos: 'BACKGROUND', appId: 'batch2'}), big, {...quota, idempotencyKey: 'k1'})).reservation.state, 'LEASED');
    const second = (() => { try { return admit(owner, request(workload('T-batch-2', {qos: 'BACKGROUND', appId: 'batch2'}), big, {...quota, idempotencyKey: 'k2'})); } catch (error) { return error; } })();
    assert.equal(second.code, 'FOREGROUND_RESERVE_HELD:cpu', 'the last unit stays unspendable by background work');
    // A declared reserve must be real: zero, negative or non-integer is refused, and a reserve larger than the quota is
    // not a reserve at all.
    for (const bad of [{cpu: 0}, {cpu: -1}, {cpu: 1.5}]) {
      const attempt = (() => { try { return admit(owner, request(workload('T-bad-' + JSON.stringify(bad), {appId: 'bad' + JSON.stringify(bad)}), big, {foregroundReserve: bad, appQuota: {cpu: 2, memory: 10}})); } catch (error) { return error; } })();
      assert.match(attempt.code, /FOREGROUND_RESERVE_MINIMUM:cpu/, JSON.stringify(bad));
    }
    const oversized = (() => { try { return admit(owner, request(workload('T-over', {appId: 'over'}), big, {foregroundReserve: {cpu: 3}, appQuota: {cpu: 2, memory: 10}})); } catch (error) { return error; } })();
    assert.equal(oversized.code, 'FOREGROUND_RESERVE_EXCEEDS_QUOTA:cpu');
    // Reserving the whole quota is a coherent (if extreme) declaration: everything is reserved for interactive work.
    store.put('tasks', task('T-all-fg'));
    store.put('tasks', task('T-none-bg'));
    assert.equal(admit(owner, request(workload('T-all-fg', {qos: 'INTERACTIVE', appId: 'allres'}), big, {foregroundReserve: {cpu: 1}, appQuota: {cpu: 1, memory: 10}, idempotencyKey: 'fg'})).reservation.state, 'LEASED');
    const allReserved = (() => { try { return admit(owner, request(workload('T-none-bg', {qos: 'BATCH', appId: 'allres'}), big, {foregroundReserve: {cpu: 1}, appQuota: {cpu: 1, memory: 10}, idempotencyKey: 'bg'})); } catch (error) { return error; } })();
    assert.equal(allReserved.code, 'FOREGROUND_RESERVE_HELD:cpu');
    const unquotaed = (() => { try { return admit(owner, request(workload('T-unquotaed', {appId: 'unq'}), big, {foregroundReserve: {memory: 1}, appQuota: {cpu: 2}})); } catch (error) { return error; } })();
    assert.equal(unquotaed.code, 'FOREGROUND_RESERVE_UNAUTHORISED:memory');
    // A caller that declares no reserve is unchanged: the legacy quota path still applies.
    store.put('tasks', task('T-legacy'));
    assert.equal(admit(owner, request(workload('T-legacy', {appId: 'legacy'}), big, {appQuota: {cpu: 1, memory: 10}})).reservation.state, 'LEASED');
  });
});

// Workbook acceptance, second paragraph: "真实双机施加有界竞争，比较观测、reservation与实际执行占用".
test('PCF704 acceptance: bounded contention measured on two real hosts', {skip: 'NOT_RUN: requires a second physical host over a real link (workbook "真实双机施加有界竞争，比较观测、reservation与实际执行占用") - this checkout is one host with no second device, so observations, reservations and actual execution cannot be compared across machines; the single-host admission and fairness properties are covered above.'}, () => {
  assert.fail('two physical hosts are required for this workbook sentence');
});
