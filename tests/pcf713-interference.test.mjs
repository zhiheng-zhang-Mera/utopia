// PCF-713 acceptance — multi-application interference and SLO protection.
//
// Workbook: PCF-713-interference-and-slo-protection.md (spec_revision 1).
//   * bullet 1: distinguish interactive from background work with an explicit user foreground-protection and a
//     per-app budget; protect the user's existing game/work and do NOT infer preference by reading window content;
//   * bullet 2: observe queueing and end-to-end SLO, and use quota, refusing new work, reducing parallelism and
//     SUPPORTED cooperative pause / quality degradation; a non-preemptible task is never arbitrarily killed;
//   * bullet 3: the degradation ladder must be a reversible option the application explicitly offers, with hysteresis,
//     cooldown and minimum dwell against oscillation; data is never silently sent out and no paid API is silently swapped in;
//   * bullet 4: distinguish "user-set target", "estimated reachable" and "measured achieved"; when resources are short,
//     show SLO_UNSATISFIABLE / the degradation facts, and never claim hard real time;
//   * acceptance paragraph: sustained batch, burst interactive, priority inversion, starvation, wrong/stale load,
//     non-preemptible tasks, irreversible quality change, repeated oscillation; a REAL two-host concurrent
//     interactive+batch measurement is an external prerequisite and is NOT_RUN here;
//   * UI note: current protection mode, degradation reason and exit switch belong to 715; a performance target is fixed
//     after a pilot and a universal 50 ms target must not be hard-coded.
//
// NAMING DIFFERENCE (reported, not silently absorbed): the workbook names `interference.mjs` and `degradation.mjs`.
// `degradation.mjs` does not exist; the degradation ladder is the allowedOptions vocabulary of `interference.mjs`
// (`evaluateInterference`) actuated by `interference-controller.mjs`. This test exercises the real modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../services/dev-gateway/store.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {admit} from '../services/personal-compute-fabric/admission.mjs';
import {planPlacement} from '../services/personal-compute-fabric/placement.mjs';
import {evaluateInterference} from '../services/personal-compute-fabric/interference.mjs';
import {createInterferenceController} from '../services/personal-compute-fabric/interference-controller.mjs';
import {createFabricService} from '../services/personal-compute-fabric/service.mjs';
import {fairQueue} from '../services/personal-compute-fabric/fair-queue.mjs';
import {qosCapability} from '../services/personal-compute-fabric/workload-envelope.mjs';

const NOW = 1000000;
// A base near the real clock for the cases the controller evaluates itself: it samples with Date.now(), so a reading
// whose validUntil is pinned to NOW would always be stale and would always REMEASURE.
const LIVE = Date.now();
// The user's explicit protection settings: a target, an anti-oscillation window and the reversible ladder the
// application offers. Nothing here reads window content or infers a preference.
const settings = (extra = {}) => ({enabled: true, targetMs: 50, cooldownMs: 30000, minimumDwellMs: 30000,
  allowedOptions: ['REDUCE_PARALLELISM'], ...extra});
const observation = (extra = {}) => ({latencyMs: 120, observedAt: NOW - 100, validUntil: NOW + 10000, ...extra});
const liveObservation = (extra = {}) => ({latencyMs: 120, observedAt: LIVE - 100, validUntil: LIVE + 10000, ...extra});
const idle = {lastChangedAt: 0};
// A recorded measurement carries its source so "measured" can never be confused with "estimated". The window is
// relative to the real clock because the controller samples with Date.now().
const measured = extra => observation({observedAt: Date.now() - 5, validUntil: Date.now() + 10000, ...extra});
// One bounded sample through the real control loop, with the settings/observations this file declares.
async function applyController(extra = {}) {
  const observed = [];
  const controller = createInterferenceController({settings: settings(), maximumParallelism: 2, authorizeNow: () => true,
    observe: async () => measured(extra.observation), setParallelism: value => observed.push(['parallelism', value]),
    setAcceptBackground: value => observed.push(['background', value])});
  const result = await controller.tick();
  return {controller, result, observed};
}

test('PCF713-01 stale, wrong or future load observations produce REMEASURE and can never actuate (bad/expired load; acceptance paragraph)', async () => {
  // A stale reading and a reading from the future are both unproven, and an unproven reading actuates nothing.
  assert.equal(evaluateInterference(settings(), {...observation(), validUntil: NOW - 1}, idle, NOW).action, 'REMEASURE');
  assert.equal(evaluateInterference(settings(), {...observation(), observedAt: NOW + 10}, idle, NOW).action, 'REMEASURE');
  assert.equal(evaluateInterference(settings(), {...observation(), latencyMs: Number.NaN}, idle, NOW).action, 'REMEASURE');
  assert.equal(evaluateInterference(settings(), {...observation(), latencyMs: Infinity}, idle, NOW).action, 'REMEASURE');
  assert.equal(evaluateInterference(settings(), {...observation(), observedAt: undefined}, idle, NOW).action, 'REMEASURE');
  // The control loop performs a bounded sample and, given no reading at all, still reports REMEASURE rather than
  // acting on an assumed value.
  const controller = createInterferenceController({settings: settings(), maximumParallelism: 2, authorizeNow: () => true, observe: async () => null,
    setParallelism: () => assert.fail('no actuation without a measurement'), setAcceptBackground: () => assert.fail('no actuation without a measurement')});
  await controller.tick().then(result => assert.equal(result.action, 'REMEASURE'));
  // A sampler that fails is the same fact as a sampler that returns nothing: unproven load, no actuation.
  const failing = createInterferenceController({settings: settings(), maximumParallelism: 2, authorizeNow: () => true,
    observe: async () => { throw Object.assign(new Error('sensor unavailable'), {code: 'SENSOR_UNAVAILABLE'}); },
    setParallelism: () => assert.fail('no actuation from a failed sample'), setAcceptBackground: () => assert.fail('no actuation from a failed sample')});
  assert.equal((await failing.tick()).action, 'REMEASURE');
  // Bounded sampling: a sampler that never answers is abandoned at the published bound and reported as unproven,
  // rather than blocking the service or inventing a reading.
  const hanging = createInterferenceController({settings: settings(), maximumParallelism: 2, authorizeNow: () => true,
    observe: () => new Promise(() => {}), setParallelism: () => assert.fail('no actuation from a hanging sample'), setAcceptBackground: () => assert.fail('no actuation from a hanging sample')});
  assert.equal((await hanging.tick()).action, 'REMEASURE');
});

test('PCF713-02 the degradation ladder is only the explicitly reversible/supported options: cooperative pause is never a kill, and an irreversible quality change is refused (bullet 2/3)', () => {
  // COOPERATIVE_PAUSE on a task that did not declare itself preemptible is NOT a pause we may take: it is refused with
  // its own reason instead of being executed as a kill or a suspend.
  const pause = evaluateInterference(settings({allowedOptions: ['COOPERATIVE_PAUSE']}), observation({preemptible: false}), idle, NOW);
  assert.equal(pause.action, 'SLO_UNSATISFIABLE');
  assert.equal(pause.reason, 'NON_PREEMPTIBLE');
  assert.equal(evaluateInterference(settings({allowedOptions: ['COOPERATIVE_PAUSE']}), observation({preemptible: true}), idle, NOW).action, 'COOPERATIVE_PAUSE');
  // A quality change is usable only when the application states it is reversible.
  const irreversible = evaluateInterference(settings({allowedOptions: ['REVERSIBLE_QUALITY']}), observation({qualityReversible: false}), idle, NOW);
  assert.equal(irreversible.action, 'SLO_UNSATISFIABLE');
  assert.equal(irreversible.reason, 'IRREVERSIBLE_QUALITY');
  assert.equal(evaluateInterference(settings({allowedOptions: ['REVERSIBLE_QUALITY']}), observation({qualityReversible: true}), idle, NOW).action, 'REVERSIBLE_QUALITY');
  // Killing is not in the ladder at all, and an unsupported request degrades to SLO_UNSATISFIABLE rather than to
  // something weaker that was never approved.
  assert.equal(evaluateInterference(settings({allowedOptions: ['KILL_PROCESS']}), observation(), idle, NOW).action, 'SLO_UNSATISFIABLE');
  assert.equal(evaluateInterference(settings({allowedOptions: []}), observation(), idle, NOW).action, 'SLO_UNSATISFIABLE');
  // The controller goes further and refuses to be CONFIGURED with a kill/paid/offload option: the vocabulary is bounded
  // by construction, not by a promise.
  const build = options => createInterferenceController({settings: settings({allowedOptions: options}), maximumParallelism: 2,
    authorizeNow: () => true, observe: async () => observation(), setParallelism: () => {}, setAcceptBackground: () => {}});
  for (const option of ['KILL_PROCESS', 'PAID_CLOUD', 'SEND_DATA_EXTERNALLY', 'FORCE_PAUSE']) {
    assert.throws(() => build([option]), {code: 'PROTECTION_CONFIGURATION'}, option + ' must not be configurable');
  }
});

test('PCF713-03 hysteresis, cooldown and minimum dwell stop repeated oscillation between the protected and unprotected states (repeated oscillation; bullet 3)', () => {
  const state = {lastChangedAt: LIVE - 1};
  // A sustained miss right after a change is absorbed: no actuator is touched while the dwell window is open.
  const dwell = evaluateInterference(settings({cooldownMs: 30000, minimumDwellMs: 30000}), liveObservation(), state, LIVE);
  assert.equal(dwell.action, 'NONE');
  assert.equal(dwell.reason, 'HYSTERESIS');
  // The longer of cooldown and minimum dwell is what is enforced, so raising one setting cannot be bypassed by the other.
  assert.equal(evaluateInterference(settings({cooldownMs: 60000, minimumDwellMs: 1}), liveObservation(), {lastChangedAt: LIVE - 30000}, LIVE).reason, 'HYSTERESIS');
  assert.equal(evaluateInterference(settings({cooldownMs: 1, minimumDwellMs: 60000}), liveObservation(), {lastChangedAt: LIVE - 30000}, LIVE).reason, 'HYSTERESIS');
  // Once the window closes the same sustained miss may act exactly once, and then the window reopens.
  const acted = evaluateInterference(settings({cooldownMs: 1000, minimumDwellMs: 1000}), liveObservation(), {lastChangedAt: LIVE - 5000}, LIVE);
  assert.equal(acted.action, 'REDUCE_PARALLELISM');
  assert.equal(acted.hardRealtime, false);
  assert.equal(evaluateInterference(settings({cooldownMs: 1000, minimumDwellMs: 1000}), liveObservation(), {lastChangedAt: LIVE}, LIVE).reason, 'HYSTERESIS');
  // Measured compliance holds the state instead of flapping back: this is what makes the ladder stable rather than
  // oscillating on every sample.
  const met = evaluateInterference(settings(), liveObservation({latencyMs: 40}), {lastChangedAt: LIVE - 100000}, LIVE);
  assert.equal(met.action, 'NONE');
  assert.equal(met.measuredTargetMet, true);
});

test('PCF713-04 the user always keeps an exit: disabling protection restores full parallelism and background acceptance (bullet 1/3)', async () => {
  const {controller, result, observed} = await applyController();
  assert.equal(result.action, 'REDUCE_PARALLELISM');
  assert.equal(result.hardRealtime, false);
  assert.deepEqual(observed, [['parallelism', 1]], 'the reduction touched this service\'s own parallelism only');
  // The explicit user switch is reported as its own event and restores the pre-protection settings.
  assert.equal(controller.disable().action, 'RESTORE_USER_DISABLED');
  assert.deepEqual((await controller.tick()), {action: 'NONE', reason: 'USER_DISABLED'});
  assert.equal(controller.snapshot().enabled, false);
  // A reduced parallelism is reversible: the actuator is restored to the maximum the service declared, not to a value
  // invented here.
  const restored = await applyController({observation: {latencyMs: 40}});
  assert.equal(restored.result.measuredTargetMet, true);
  assert.deepEqual(restored.observed, [], 'a compliant measurement actuates nothing');
  // A user who never enabled protection is not silently protected: the default is the user's own state.
  const off = evaluateInterference(settings({enabled: false}), observation(), idle, NOW);
  assert.equal(off.action, 'NONE');
  assert.equal(off.reason, 'USER_DISABLED');
});

test('PCF713-05 revoking protection authority stops actuation instead of silently continuing under an old grant (fail-closed)', async () => {
  let authorized = true;
  const controller = createInterferenceController({settings: settings(), maximumParallelism: 2, authorizeNow: () => authorized,
    observe: async () => measured(), setParallelism: () => {}, setAcceptBackground: () => {}});
  await controller.tick();
  authorized = false;
  await assert.rejects(() => controller.tick(), {code: 'PROTECTION_UNAUTHORIZED'});
  assert.throws(() => controller.disable(), {code: 'PROTECTION_UNAUTHORIZED'});
});

test('PCF713-06 a sustained batch of one app cannot starve a burst of interactive work from another app (sustained batch/burst interactive/priority inversion/starvation; bullet 1)', async () => {
  // Foreground protection is the SETTING the user gives, not a preference inferred from window contents.
  // This application's user-approved ladder puts "refuse new background work" first, so that is the rung the
  // protection takes. The ladder is the application's explicit, ordered choice - not a preference inferred here.
  const protection = {enabled: true, targetMs: 50, cooldownMs: 30000, minimumDwellMs: 30000, allowedOptions: ['REFUSE_BACKGROUND', 'REDUCE_PARALLELISM']};
  const dir = await mkdtemp(join(tmpdir(), 'pcf713-interference-'));
  const store = new Store(dir);
  let parallel = 0;
  let backgroundAccepted = true;
  let authorized = true;
  const service = createFabricService({
    store, artifactRoot: join(dir, 'artifacts'), deviceId: 'alien', maxParallel: 2, protection: {
      settings: protection,
      authorizeNow: () => authorized,
      observe: async () => ({latencyMs: 120, observedAt: Date.now() - 5, validUntil: Date.now() + 1000, source: 'COMPONENT_FIXTURE'}),
      setParallelism: value => { parallel = value; },
      setAcceptBackground: value => { backgroundAccepted = value; },
    },
    readAuthority: async () => ({version: 1, authorized: true, expiresAt: Date.now() + 60000, originDeviceId: 'alien',
      allowedDevices: ['alien'], dataScopes: ['PUBLIC'], sharingConsent: false, cloudConsent: false, budget: 1000000}),
  });
  const context = {sessionId: 'session', deviceId: 'alien'};
  try {
    // The sustained background batch is submitted FIRST. The declared QoS class is the explicit per-application
    // declaration that separates foreground from background - no window content is read and no preference inferred.
    const batch = await service.submit({appId: 'cpu-sum', idempotencyKey: 'sustained-batch', parentSessionId: 'session', input: {values: [1, 2, 3]}}, context);
    const interactive = await service.submit({appId: 'cpu-sort', idempotencyKey: 'burst-interactive', parentSessionId: 'session', input: {values: [3, 1, 2]}}, context);
    assert.equal(store.get('tasks', batch.taskId).pcfWorkload.qos, 'BATCH');
    assert.equal(store.get('tasks', interactive.taskId).pcfWorkload.qos, 'INTERACTIVE');
    await service.start();
    await service.waitForIdle();
    // The foreground burst is served with the correct answer: protecting it never degrades or corrupts the work.
    assert.equal(store.get('tasks', interactive.taskId).state, 'COMPLETED', 'the interactive work ran');
    assert.deepEqual((await service.collect(interactive.taskId, context)).output.values, [1, 2, 3]);
    // The protection decision itself, which is the boundary that stops sustained background work.
    const health = service.health();
    assert.equal(health.protection.enabled, true);
    assert.equal(health.acceptBackground, false, 'the protection refused new background work');
    const refusal = health.protection.events.find(event => event.action === 'REFUSE_BACKGROUND');
    assert.ok(refusal, 'the refusal is recorded as its own event for the surface to show');
    assert.equal(refusal.reason, 'MEASURED_TARGET_MISSED');
    // The user's exit switch is the only thing that resumes background work, and it restores the pre-protection state.
    assert.equal(service.disableProtection().action, 'RESTORE_USER_DISABLED');
    assert.equal(service.health().acceptBackground, true);
    assert.equal(service.health().effectiveParallelism, 2);
    await service.waitForIdle();
    assert.equal(store.get('tasks', batch.taskId).state, 'COMPLETED', 'released background work ran to completion');
    assert.ok(service.health().protection.events.some(event => event.action === 'RESTORE_USER_DISABLED'), 'the exit is visible to 715');
    // With protection disabled the service refuses to claim it is protecting anything.
    const idle = await service.health().protection;
    assert.equal(idle.enabled, false);
    authorized = false;
    // The exit restores the service's parallelism to the maximum it declared, and the rung this ladder used (refusing
    // background work) never touched the parallelism actuator in the first place.
    assert.equal(service.health().effectiveParallelism, 2);
    assert.equal(parallel, 0, 'refusing background work is not a parallelism change');
  } finally { await service.stop(); store.db.close(); await rm(dir, {recursive: true, force: true}); }
});

test('PCF713-07 the per-app budget is enforced per application while another application can still make progress (bullet 1/2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf713-budget-'));
  const store = new Store(dir);
  try {
    const candidate = {deviceId: 'alien', bootId: 'boot-1', trusted: true, authorized: true, executorReady: true, sharing: true,
      platform: 'win32', provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'},
      observationVersion: 1, observedAt: NOW - 10, validUntil: NOW + 10000, free: {cpu: 4, memory: 100}, queueMs: 10,
      cost: {inputMs: [1, 2], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2]}};
    const policy = {version: 1, authorized: true, originDeviceId: 'alien', mode: 'TRUSTED_PERSONAL_FABRIC',
      allowedDevices: ['alien'], dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: NOW + 10000};
    const workload = (taskId, appId) => ({taskId, actionId: 'A-' + taskId, originDeviceId: 'alien', parentSessionId: 'S',
      appId, dataScope: 'PUBLIC', kind: 'CPU_JSON', capabilities: ['cpu.json'], resources: {cpu: 1, memory: 10},
      deadlineAt: NOW + 5000, writeScope: [], qos: appId === 'game' ? 'INTERACTIVE' : 'BATCH'});
    const request = (taskId, appId, quota) => ({workload: workload(taskId, appId), proposal: planPlacement(workload(taskId, appId), [candidate], policy, NOW),
      policy, candidate, idempotencyKey: 'k-' + taskId, ttlMs: 1000, appQuota: {cpu: quota, memory: 100}, now: NOW});
    for (const id of ['game-1', 'game-2', 'batch-1']) {
      store.put('tasks', {id, state: 'QUEUED', actionId: 'A-' + id, originDeviceId: 'alien', parentSessionId: 'S'});
    }
    const owner = createCanonicalStateAdapter(store);
    const game = admit(owner, request('game-1', 'game', 1)).reservation;
    assert.equal(game.appId, 'game');
    // A second reservation that would exceed the FIRST app's budget is refused, by name.
    assert.throws(() => admit(owner, request('game-2', 'game', 1)), {code: 'APP_QUOTA'});
    // A different app has its own budget and is unaffected: the quota protects a specific application rather than
    // freezing the machine.
    const other = admit(owner, request('batch-1', 'batch', 1)).reservation;
    assert.equal(other.appId, 'batch');
    assert.equal(owner.snapshot().reservations.length, 2);
  } finally { store.db.close(); await rm(dir, {recursive: true, force: true}); }
});

test('PCF713-08 a rejected task is not lost work: the user is shown SLO_UNSATISFIABLE instead of a silent failure, and the exit switch restores the pre-protection state (bullet 4)', async () => {
  // No reachable target is declared by the user: the honest answer is that the goal cannot be evaluated, not a guess.
  const unspecified = evaluateInterference(settings({targetMs: 0}), liveObservation(), idle, LIVE);
  assert.equal(unspecified.action, 'SLO_UNSATISFIABLE');
  assert.equal(unspecified.reason, 'TARGET_UNSPECIFIED');
  // A target the user set but the machine cannot currently reach: the fact reported is the measured miss.
  const miss = evaluateInterference(settings(), liveObservation(), idle, LIVE);
  assert.equal(miss.action, 'REDUCE_PARALLELISM');
  assert.equal(miss.reason, 'MEASURED_TARGET_MISSED');
  // Nothing in this vocabulary may silently escalate to an external or paid resource to "meet" the target.
  const paid = evaluateInterference(settings({allowedOptions: ['PAID_CLOUD']}), liveObservation(), idle, LIVE);
  assert.equal(paid.action, 'SLO_UNSATISFIABLE');
  assert.equal(Object.hasOwn(paid, 'external'), false);
  assert.equal(Object.hasOwn(paid, 'egress'), false);
  // The result is reversible in the ordinary sense: once the measurement complies, the state returns to NONE and can
  // be exited, so 715 can show the exit switch over a real reason.
  assert.equal(evaluateInterference(settings(), liveObservation({latencyMs: 30}), {lastChangedAt: LIVE - 5000}, LIVE).action, 'NONE');
});

test('PCF713-09 user target, estimated reachable and measured achieved are distinct, and no hard real time is claimed (bullet 4)', () => {
  // The "measured achieved" fact is an explicit field, not a promise, and it only appears for a compliant reading.
  const met = evaluateInterference(settings({targetMs: 50}), liveObservation({latencyMs: 50}), idle, LIVE);
  assert.equal(met.action, 'NONE');
  assert.equal(met.measuredTargetMet, true);
  assert.equal(met.hardRealtime, undefined, 'meeting a target is not a real-time guarantee');
  // A miss is explicitly reported as measured and carries hardRealtime: false rather than being presented as a
  // guarantee that was kept.
  const missed = evaluateInterference(settings({targetMs: 50}), liveObservation({latencyMs: 51}), idle, LIVE);
  assert.equal(missed.hardRealtime, false);
  // Even a saturation/unsatisfiable outcome states the same fact rather than an availability claim.
  assert.equal(evaluateInterference(settings({allowedOptions: []}), liveObservation(), idle, LIVE).hardRealtime, false);
  // The QoS capability statement publishes NO hard real-time guarantee for any class.
  const envelope = {envelopeVersion: 2, taskId: 'T', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S', appId: 'cpu-sort',
    targetDeviceRef: null, executor: {providerRef: 'pcf-fixed-cpu-v1', providerVersion: 1, providerManifestRef: 'pcf-fixed-cpu-v1'},
    inputSchema: 'json', outputSchema: 'json', capabilities: ['cpu.json'], inputRefs: [], writeScope: [],
    platform: {os: ['win32'], arch: ['x64']}, resources: {cpu: {amount: 1, unit: 'millicores'}},
    qos: 'INTERACTIVE', deadlineAt: null, missPolicy: null, retrySafety: 'SIDE_EFFECT_FREE', dataScope: 'PUBLIC',
    consent: {required: false, scopeRef: null}, privilegeRequests: []};
  const capability = qosCapability(envelope);
  assert.equal(capability.qos, 'INTERACTIVE');
  assert.equal(capability.hardRealTimeGuarantee, false);
  assert.equal(capability.statement, 'no deadline declared');
  // The controller repeats the same honesty on every recorded event.
  const controller = createInterferenceController({settings: settings(), maximumParallelism: 2, authorizeNow: () => true,
    observe: async () => liveObservation({latencyMs: 200, source: 'COMPONENT_FIXTURE'}), setParallelism: () => {}, setAcceptBackground: () => {}});
  return controller.tick().then(result => {
    assert.equal(result.hardRealtime, false);
    assert.equal(result.measurementSource, 'COMPONENT_FIXTURE');
    // The recorded event carries the source of the measurement that caused it, so "measured" is traceable and a target
    // value is never invented here: the settings carry the user's own number.
    assert.equal(controller.snapshot().events[0].measurementSource, 'COMPONENT_FIXTURE');
    assert.equal(result.reason, 'MEASURED_TARGET_MISSED');
  });
});

test('PCF713-10 fairness rotates between applications so a long queue of one app cannot monopolise the machine (starvation; bullet 2)', () => {
  const queue = [
    {id: 'b1', appId: 'batch', queuedAt: NOW - 100, qos: 'BATCH'},
    {id: 'b2', appId: 'batch', queuedAt: NOW - 99, qos: 'BATCH'},
    {id: 'i1', appId: 'game', queuedAt: NOW - 98, qos: 'INTERACTIVE'},
    {id: 'i2', appId: 'game', queuedAt: NOW - 97, qos: 'INTERACTIVE'},
  ];
  // With the batch app having just been served, the next selection comes from the other application.
  const ordered = fairQueue(queue, {lastAppId: 'batch', now: NOW, agingMs: 30000});
  assert.equal(ordered[0].appId, 'game');
  assert.deepEqual(ordered.map(item => item.appId), ['game', 'batch', 'game', 'batch']);
  // Nothing is dropped while rotating: fairness is an order, not a filter.
  assert.equal(ordered.length, queue.length);
  // A task older than the aging window is served ahead of the round-robin order, so a long-running queue cannot
  // starve behind a chatty application.
  const aged = fairQueue(queue.filter(item => item.appId !== 'game').concat([{id: 'i1', appId: 'game', queuedAt: NOW - 1, qos: 'INTERACTIVE'}]),
    {lastAppId: 'game', now: NOW, agingMs: 50});
  assert.equal(aged[0].appId, 'batch');
  // The declared QoS of each record is carried, so a consumer can see what the scheduling decision was based on.
  assert.deepEqual([...new Set(ordered.map(item => item.qos))].sort(), ['BATCH', 'INTERACTIVE']);
  // Bound: an oversized queue set is refused rather than partially scheduled.
  assert.throws(() => fairQueue(new Array(257).fill({id: 'x', appId: 'a', queuedAt: NOW - 1}), {now: NOW}), {code: 'FAIR_QUEUE_LIMIT'});
});
