// PCF-712 acceptance ??durable supervision and reconciliation (the supervision/reconcile/replay half).
//
// The fencing half of this workbook is already covered by tests/pcf712-fencing.test.mjs; this file does not repeat it.
// Workbook: PCF-712-durable-supervision-and-fencing.md (spec_revision 2).
//   * bullet 1: event subscription plus a BOUNDED reconcile timer, idempotent replay/lost-event handling, low-cost
//     idle waiting that invents no fake task;
//   * bullet 2: reservation/attempt/commit-token relations persisted under the EXISTING canonical owner; no second PCF
//     task database; the single-writer seam is explicit and fault-injected;
//   * bullet 3: every holder change increments the fence epoch and start/report/result-commit all check attempt+epoch;
//     a failed persistence step must not be hidden by executing first and booking afterwards;
//   * bullet 4: after crash/restart reconcile canonical tasks, real worker boot identity, outstanding reservations and
//     receipts; unknown external effects go to 705; a timeout is NOT proof old workers stopped;
//   * acceptance paragraph: crashes before/during/after writes, duplicate events, surviving old workers, late epochs,
//     duplicate supervisors, unwritable storage, broken event streams, idle pools; one canonical writer only; uncertain
//     authority fails closed; restart leaks no reservation and commits no result twice;
//   * revision 2: reconcileExecution proposes execution-lifecycle actions ONLY - FR keeps engineering goals and
//     Review-to-Repair, and a duplicate wake/live process/re-registration/lost lease/old-epoch receipt produces no
//     duplicate effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../services/dev-gateway/store.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {admit, claimAttempt, commitResult, release, recordOwnedProcess} from '../services/personal-compute-fabric/admission.mjs';
import {planPlacement} from '../services/personal-compute-fabric/placement.mjs';
import {reconcileExecution, startSupervision} from '../services/personal-compute-fabric/supervisor.mjs';
import {createFence, advanceFence, claimOf, assertFenced, createEventApplicator, reconcileAfterRestart} from '../services/personal-compute-fabric/fence.mjs';

// Real wall-clock instants: the supervision loop uses Date.now(), so fixtures are relative to real time rather than to
// a small hand-picked epoch - a reservation that looks fresh at t=1000 is long expired against a real clock.
const T0 = Date.now();
const policy = {version: 1, authorized: true, originDeviceId: 'alien', mode: 'TRUSTED_PERSONAL_FABRIC',
  allowedDevices: ['alien'], dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: T0 + 600000};
const workload = (taskId, appId = 'one') => ({taskId, actionId: 'A-' + taskId, originDeviceId: 'alien', parentSessionId: 'S',
  appId, dataScope: 'PUBLIC', kind: 'CPU_JSON', capabilities: ['cpu.json'], resources: {cpu: 1, memory: 10},
  deadlineAt: T0 + 400000, writeScope: [], qos: 'BATCH'});
const candidate = {deviceId: 'alien', bootId: 'boot-1', trusted: true, authorized: true, executorReady: true, sharing: true,
  platform: 'win32', provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'},
  observationVersion: 1, observedAt: T0, validUntil: T0 + 600000, free: {cpu: 4, memory: 100}, queueMs: 10,
  cost: {inputMs: [1, 2], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2]}};
// Two distinct apps: the per-app quota is one CPU unit, so two outstanding reservations for the SAME app would be
// refused by APP_QUOTA - a fact this file checks explicitly in PCF712-06 rather than tripping over.
const request = (taskId, appId) => ({workload: workload(taskId, appId), proposal: planPlacement(workload(taskId, appId), [candidate], policy, T0), policy, candidate,
  idempotencyKey: 'k-' + taskId, ttlMs: 60000, appQuota: {cpu: 1, memory: 100}, now: T0});

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pcf712-supervision-'));
  let store = new Store(dir);
  const task = (id, state = 'QUEUED') => { store.put('tasks', {id, state, actionId: 'A-' + id, originDeviceId: 'alien', parentSessionId: 'S'}); };
  try {
    task('T');
    // `owner` is created per call, so a test that reopens the database must take the fresh adapter from `reopen()`.
    await fn({dir, task, reopen: () => { store.db.close(); store = new Store(dir); return {store, owner: createCanonicalStateAdapter(store)}; },
      get store() { return store; }, get owner() { return createCanonicalStateAdapter(store); }});
  } finally { try { store.db.close(); } catch { /* already closed by reopen() */ } await rm(dir, {recursive: true, force: true}); }
}

test('PCF712-01 events replay idempotently and a lost event stays visible as a bounded reconcile target (workbook bullet 1)', () => {
  const applicator = createEventApplicator();
  assert.equal(applicator.apply({seq: 0}).outcome, 'APPLIED');
  assert.equal(applicator.apply({seq: 1}).outcome, 'APPLIED');
  // A duplicate event must not produce a second effect.
  assert.equal(applicator.apply({seq: 1}).outcome, 'DUPLICATE_IGNORED');
  assert.equal(applicator.highest(), 1);
  // A broken event stream leaves the missing sequences visible instead of pretending it was continuous.
  assert.equal(applicator.apply({seq: 4}).outcome, 'APPLIED');
  assert.deepEqual(applicator.gaps(), [2, 3]);
  // A late (out-of-order) event is applied once and does not move the high-water mark backwards.
  assert.equal(applicator.apply({seq: 3}).outcome, 'APPLIED');
  assert.equal(applicator.highest(), 4);
  // An out-of-order event fills nothing: the gap left by the jump (2) and the sequence that arrived late (3) both stay
  // visible as unreconciled, so a consumer sees a broken stream rather than a complete one.
  assert.deepEqual(applicator.snapshot().gaps, [2, 3]);
  // Each gap is reconciled explicitly - and reconciling a gap that does not exist says so rather than inventing one.
  assert.equal(applicator.reconcileGap(2).reconciled, true);
  assert.deepEqual(applicator.gaps(), [3]);
  assert.equal(applicator.reconcileGap(9).reason, 'NO_SUCH_GAP');
  // Replaying an already-reconciled gap is still a duplicate, not a new effect.
  assert.equal(applicator.apply({seq: 2}).outcome, 'DUPLICATE_IGNORED');
  assert.throws(() => applicator.apply({seq: 'x'}), {code: 'EVENT_SEQ_REQUIRED'});
});

test('PCF712-02 an idle pool is a bounded no-op wait: no fake task and no invented stop proof (workbook bullet 1/acceptance)', async () => {
  assert.deepEqual(reconcileExecution({reservations: [], attempts: []}, [], T0), []);
  // A LEASED reservation with nobody running is the only case that may propose a start.
  assert.deepEqual(reconcileExecution({reservations: [{id: 'r', state: 'LEASED', expiresAt: T0 + 5000, taskId: 'T'}], attempts: []}, [], T0),
    [{action: 'START_APPROVED_ATTEMPT', taskId: 'T', reservationId: 'r'}]);
  // Bounded authority: an oversized snapshot is refused rather than reconciled partially.
  assert.throws(() => reconcileExecution({reservations: new Array(257).fill({id: 'r'}), attempts: []}, [], T0), {code: 'RECONCILE_LIMIT'});
  assert.throws(() => reconcileExecution({reservations: [], attempts: []}, new Array(257).fill({}), T0), {code: 'RECONCILE_LIMIT'});
  // The loop wakes on demand, announces an empty pool, and can be stopped. It runs without any Owner chat page.
  const observed = [];
  const supervisor = startSupervision({
    intervalMs: 250,
    snapshot: async () => ({reservations: [], attempts: []}),
    observations: async () => [],
    reconcile: async actions => observed.push(actions),
  });
  await supervisor.wake();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, [[]], 'an idle pool produced exactly one empty reconcile, not a fabricated task');
  supervisor.stop();
  // Configuration outside the published bounds is refused by name rather than silently clamped.
  assert.throws(() => startSupervision({intervalMs: 100, snapshot: () => ({}), observations: () => [], reconcile: () => {}}), {code: 'SUPERVISOR_CONFIG'});
});

test('PCF712-03 the supervision loop proposes a start from canonical state and does not re-propose the live attempt on a duplicate wake (workbook bullet 3/revision 2)', async () => {
  await withStore(async ({owner}) => {
    admit(owner, request('T', 'one'));
    const seen = [];
    const runLoop = async () => {
      const supervisor = startSupervision({
        intervalMs: 250,
        snapshot: async () => owner.snapshot(),
        // The worker's real boot identity is asserted by the observation, not assumed.
        observations: async () => [{holder: 'worker', bootId: 'boot-1', alive: true}],
        reconcile: async actions => { seen.push(...actions); },
      });
      await supervisor.wake();
      await new Promise(resolve => setImmediate(resolve));
      supervisor.stop();
    };
    await runLoop();
    // The first wake proposes the start of the canonically approved attempt.
    assert.deepEqual(seen.map(action => action.action), ['START_APPROVED_ATTEMPT']);
    const reservationId = seen[0].reservationId;
    claimAttempt(owner, {reservationId, holder: 'worker', bootId: 'boot-1', now: T0 - 500});
    assert.equal(owner.snapshot().attempts.length, 1);
    // Duplicate wake: the attempt is RUNNING under a LIVE worker, so no second start may be proposed. This is the
    // duplicate-effect failure revision 2 forbids.
    seen.length = 0;
    await runLoop();
    assert.deepEqual(seen, [], 'a duplicate wake proposed no second lifecycle action');
    assert.equal(owner.snapshot().attempts.length, 1, 'the duplicate wake did not create a second attempt');
  });
});

test('PCF712-04 only one canonical writer is valid: a divergent or unwritable writer fails closed (workbook bullet 2/acceptance)', async () => {
  await withStore(async ({store, owner, task, reopen}) => {
    admit(owner, request('T', 'one'));
    // CAS: a second writer holding a stale version cannot mutate canonical state.
    assert.throws(() => owner.transaction(owner.snapshot().version + 1, () => ({})), {code: 'STALE_CANONICAL_VERSION'});
    // The reservations/attempts live under the EXISTING canonical owner, and no second PCF task database is created.
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    assert.ok(tables.includes('tasks') && tables.includes('actions') && tables.includes('settings'));
    assert.equal(tables.filter(name => /pcf[_-]?(task|attempt|reservation|lease|token)/i.test(name)).length, 0, 'no second task database was invented');
    // The durable relation is one settings row under the canonical owner.
    assert.deepEqual(store.db.prepare("SELECT key FROM settings WHERE key='pcf.execution.v1'").all().map(row => row.key), ['pcf.execution.v1']);
    // Restart preserves the reservation/attempt relation exactly. The old adapter names a CLOSED database, so the
    // fresh one from reopen() is what must be used from here on - a stale writer is exactly what this rejects.
    const restarted = reopen();
    assert.equal(restarted.owner.snapshot().reservations.length, 1, 'the restart preserved the outstanding reservation');
    // The adapter left over the closed database is a stale writer: it cannot serve a second, divergent truth.
    assert.throws(() => owner.snapshot(), {code: 'ERR_INVALID_STATE'});
    // Storage fault injection: a WRITE that cannot be persisted refuses with the storage's own code and leaves the
    // canonical version untouched - it is never booked as if it had succeeded.
    task('T2');
    const versionBefore = restarted.owner.snapshot().version;
    const realAtomic = restarted.store.atomic.bind(restarted.store);
    restarted.store.atomic = () => { throw Object.assign(new Error('the canonical store is read-only'), {code: 'SQLITE_READONLY'}); };
    assert.throws(() => admit(restarted.owner, request('T2', 'one')), {code: 'SQLITE_READONLY'});
    restarted.store.atomic = realAtomic;
    assert.equal(restarted.owner.snapshot().version, versionBefore, 'the failed write did not advance canonical state');
    assert.equal(restarted.owner.snapshot().reservations.length, 1);
  });
});

test('PCF712-05 a failed persistence step is not hidden by executing first: the fence is checked at start, report and commit (workbook bullet 3/revision 2)', async () => {
  await withStore(async ({owner, store}) => {
    const reservation = admit(owner, request('T', 'one')).reservation;
    const started = claimAttempt(owner, {reservationId: reservation.id, holder: 'worker', bootId: 'boot-1', now: T0 + 10});
    assert.equal(started.epoch, 1);
    // The durable fence record for this attempt matches the canonical attempt.
    const fence = createFence({holderRef: 'worker', bootRef: 'boot-1', attemptRef: started.id, epoch: started.epoch, since: T0 + 10});
    assert.equal(assertFenced(fence, claimOf(fence)), true);
    // Ownership of the process must be recorded before the process is trusted; a second binding for the same attempt
    // is refused rather than silently replacing the recorded identity.
    recordOwnedProcess(owner, {taskId: 'T', attemptId: started.id, epoch: started.epoch, holder: 'worker', bootId: 'boot-1', processIdentity: {pid: 4242, host: 'fixture', startedAt: T0 + 10}});
    assert.throws(() => recordOwnedProcess(owner, {taskId: 'T', attemptId: started.id, epoch: started.epoch, holder: 'worker', bootId: 'boot-1', processIdentity: {pid: 4243, host: 'fixture', startedAt: T0 + 11}}), {code: 'PROCESS_ALREADY_BOUND'});
    // A persistence step that fails during the result commit must not have recorded the effect. The commit refuses with
    // the storage's own code, and the canonical task is left RUNNING rather than optimistically COMPLETED.
    const realAtomic = store.atomic.bind(store);
    store.atomic = () => { throw Object.assign(new Error('the canonical store is read-only'), {code: 'SQLITE_READONLY'}); };
    assert.throws(() => commitResult(owner, {taskId: 'T', attemptId: started.id, epoch: started.epoch, holder: 'worker', bootId: 'boot-1', outcome: 'SUCCEEDED', outputDigest: 'a'.repeat(64), now: T0 + 20}), {code: 'SQLITE_READONLY'});
    store.atomic = realAtomic;
    assert.equal(store.get('tasks', 'T').state, 'RUNNING', 'a failed commit did not book a success it never persisted');
    assert.equal(owner.snapshot().attempts[0].state, 'RUNNING');
    // The real commit, once storage recovers, is recorded exactly once.
    commitResult(owner, {taskId: 'T', attemptId: started.id, epoch: started.epoch, holder: 'worker', bootId: 'boot-1', outcome: 'SUCCEEDED', outputDigest: 'a'.repeat(64), now: T0 + 30});
    assert.equal(store.get('tasks', 'T').state, 'COMPLETED');
    assert.equal(owner.snapshot().reservations.length, 0);
    assert.deepEqual(owner.snapshot().completedKeys, ['k-T']);
  });
});

test('PCF712-06 after a restart, outstanding reservations are reconciled without leaking or doubling them, and an unproven stop is handed to 705 (workbook bullet 4/acceptance)', async () => {
  await withStore(async ({owner, task, reopen}) => {
    // A LEASED reservation that was never claimed (app 'one'), and a RUNNING attempt (app 'two') whose worker cannot
    // be observed. Different apps because a second reservation for the same app is refused by its own per-app quota.
    admit(owner, request('T', 'one'));
    task('T2');
    const held = admit(owner, request('T2', 'two')).reservation;
    claimAttempt(owner, {reservationId: held.id, holder: 'worker', bootId: held.bootId, now: T0 - 500});
    // A third reservation for the FIRST app is refused while its earlier lease is still outstanding: the quota is not
    // silently reset by work that has not been proven stopped.
    task('T3');
    assert.throws(() => admit(owner, request('T3', 'one')), {code: 'APP_QUOTA'});
    const restarted = reopen();
    const snapshot = restarted.owner.snapshot();
    assert.equal(snapshot.reservations.length, 2, 'restart neither dropped nor duplicated an outstanding reservation');
    assert.equal(snapshot.attempts.length, 1);
    // The supervisor sees no boot identity for the running attempt and refuses to invent evidence for a stop. The
    // unclaimed lease is not forgotten either: its start is proposed while it is still live.
    const actions = reconcileExecution(snapshot, [], T0 + 5);
    assert.deepEqual(actions, [
      {action: 'START_APPROVED_ATTEMPT', taskId: 'T', reservationId: snapshot.reservations.find(r => r.taskId === 'T').id},
      {action: 'ATTENTION_UNKNOWN_WORKER', taskId: 'T2', attemptId: snapshot.attempts[0].id},
    ]);
    // The running attempt is not stopped by a timeout, and its UNPROVEN stop goes to the repair book.
    const dispositions = reconcileAfterRestart({
      reservations: snapshot.reservations,
      attempts: snapshot.attempts.map(attempt => ({...attempt, attemptRef: attempt.id})),
      observations: [], now: T0 + 5,
    });
    assert.equal(dispositions.inferredStopped, false);
    assert.deepEqual(dispositions.findings.map(finding => finding.disposition), ['STOP_NOT_PROVEN']);
    assert.ok(dispositions.findings.every(finding => finding.stopProven === false));
    assert.equal(dispositions.findings[0].handTo, 'PCF-705');
    // A LIVE worker is reported running. The real canonical attempt record is fed straight in: admission names these
    // facts `holder`/`bootId` while a fence claim names them `holderRef`/`bootRef`, and the reconciliation must read the
    // canonical record it is actually given rather than only one spelling of it.
    const live = snapshot.attempts.map(attempt => ({...attempt, attemptRef: attempt.id}));
    const alive = reconcileAfterRestart({reservations: [], attempts: live, observations: [{holder: 'worker', bootId: 'boot-1', alive: true}], now: T0 + 5});
    assert.deepEqual(alive.findings.map(finding => finding.disposition), ['STILL_RUNNING']);
    // An identity that is genuinely unreadable is its own disposition handed to 705 - neither "alive" nor "stopped",
    // because nothing can be matched and nothing may be concluded.
    const unreadable = reconcileAfterRestart({reservations: [], attempts: [{taskId: 'T2', attemptRef: 'a', state: 'RUNNING'}], observations: [{holder: 'worker', bootId: 'boot-1', alive: true}], now: T0 + 5});
    assert.deepEqual(unreadable.findings.map(finding => finding.disposition), ['IDENTITY_UNREADABLE']);
    assert.equal(unreadable.findings[0].handTo, 'PCF-705');
    const uncertain = reconcileAfterRestart({reservations: [], attempts: live.map(attempt => ({...attempt, pendingOutcome: 'UNKNOWN'})), observations: [], now: T0 + 5});
    assert.equal(uncertain.findings[0].disposition, 'UNCERTAIN_SIDE_EFFECT');
    assert.equal(uncertain.findings[0].handTo, 'PCF-705');
    // Releasing the running reservation requires proven stop, so the restart cannot silently free it.
    assert.throws(() => release(restarted.owner, {reservationId: held.id, now: T0 + 6}), {code: 'RUNNING_REQUIRES_STOP_PROOF'});
    // The restart leaked nothing: exactly the two reservations it recovered are still charged.
    assert.equal(restarted.owner.snapshot().reservations.length, 2);
  });
});

test('PCF712-07 a surviving old worker and a late old-epoch receipt produce no duplicate effect (workbook bullet 3/revision 2)', async () => {
  await withStore(async ({store, owner}) => {
    const reservation = admit(owner, request('T', 'one')).reservation;
    const first = claimAttempt(owner, {reservationId: reservation.id, holder: 'worker-A', bootId: reservation.bootId, now: T0 - 500});
    // The holder moves to a new worker and boot: the epoch advances exactly once, and a retry of the same holder does
    // not burn another epoch.
    const moved = advanceFence(createFence({holderRef: 'worker-A', bootRef: 'boot-A', attemptRef: first.id, epoch: first.epoch}), {holderRef: 'worker-B', bootRef: 'boot-B', now: T0 + 20});
    assert.equal(moved.epoch, first.epoch + 1);
    assert.equal(advanceFence(moved, {holderRef: 'worker-B', bootRef: 'boot-B', now: T0 + 21}).epoch, moved.epoch);
    // The OLD worker's receipt is refused by epoch before anything is written, and the canonical task is untouched.
    const refusal = (() => { try { commitResult(owner, {taskId: 'T', attemptId: first.id, epoch: first.epoch, holder: 'worker-A', bootId: 'boot-A', outcome: 'SUCCEEDED', outputDigest: 'a'.repeat(64), now: T0 + 30}); return null; } catch (error) { return error.code; } })();
    assert.equal(refusal, 'ATTEMPT_FENCED');
    // Even with the CURRENT epoch, the old holder and boot are refused: an epoch alone is not a fence.
    assert.throws(() => commitResult(owner, {taskId: 'T', attemptId: first.id, epoch: moved.epoch, holder: 'worker-A', bootId: 'boot-A', outcome: 'SUCCEEDED', outputDigest: 'a'.repeat(64), now: T0 + 31}), {code: 'ATTEMPT_FENCED'});
    assert.equal(store.get('tasks', 'T').state, 'RUNNING');
    assert.equal(owner.snapshot().reservations.length, 1, 'the refused receipt released nothing');
    // The old worker still being alive is reported, never resolved by assuming it is gone.
    assert.deepEqual(reconcileExecution(owner.snapshot(), [{holder: 'worker-A', bootId: 'boot-A', alive: true}], T0 + 40),
      [{action: 'ATTENTION_UNKNOWN_WORKER', taskId: 'T', attemptId: first.id}]);
  });
});

test('PCF712-08 reconcileExecution proposes execution-lifecycle actions only, never engineering goals or repair (revision 2)', () => {
  const actions = reconcileExecution({
    reservations: [
      {id: 'r1', state: 'LEASED', expiresAt: T0 + 5000, taskId: 'T1'},
      {id: 'r2', state: 'LEASED', expiresAt: T0 - 500, taskId: 'T2'},
      {id: 'r3', state: 'LEASED', expiresAt: T0 + 5000, taskId: 'T3'},
      {id: 'r4', state: 'LEASED', expiresAt: T0 + 5000, taskId: 'T4'},
    ],
    attempts: [
      {id: 'a3', state: 'RUNNING', taskId: 'T3', holder: 'w', bootId: 'b'},
      {id: 'a4', state: 'RUNNING', taskId: 'T4', holder: 'w', bootId: 'b', pendingOutcome: 'UNKNOWN'},
    ],
  }, [], T0);
  assert.deepEqual(actions, [
    {action: 'START_APPROVED_ATTEMPT', taskId: 'T1', reservationId: 'r1'},
    {action: 'RELEASE_EXPIRED_LEASE', taskId: 'T2', reservationId: 'r2'},
    {action: 'ATTENTION_UNKNOWN_WORKER', taskId: 'T3', attemptId: 'a3'},
    {action: 'ATTENTION_UNCERTAIN_OUTCOME', taskId: 'T4', attemptId: 'a4'},
  ]);
  // The proposal surface is closed and bounded: no engineering goal, project selection, review/repair or merge action
  // may appear here, because FR keeps those.
  const lifecycle = new Set(['START_APPROVED_ATTEMPT', 'RELEASE_EXPIRED_LEASE', 'ATTENTION_UNKNOWN_WORKER', 'ATTENTION_UNCERTAIN_OUTCOME']);
  for (const action of actions) {
    assert.ok(lifecycle.has(action.action), action.action + ' is not an execution-lifecycle action');
    assert.ok(Object.keys(action).every(key => ['action', 'taskId', 'attemptId', 'reservationId'].includes(key)));
    assert.equal(Object.hasOwn(action, 'goal'), false);
    assert.equal(Object.hasOwn(action, 'repair'), false);
    assert.equal(Object.hasOwn(action, 'review'), false);
  }
  // Reconcile is a PROPOSAL: it never mutates the snapshot it is given.
  const input = {reservations: [{id: 'r', state: 'LEASED', expiresAt: T0 + 5000, taskId: 'T'}], attempts: []};
  const before = JSON.stringify(input);
  reconcileExecution(input, [], T0);
  assert.equal(JSON.stringify(input), before);
});

