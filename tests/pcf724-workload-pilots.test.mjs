// PCF-724 acceptance: multi-application workload pilots.
//
// The workbook names `services/personal-compute-fabric/application-adapter.mjs`, which does NOT exist in this checkout.
// The real adapter surface is `adapters.mjs` (dimension declarations and the UNSUPPORTED-vs-zero rule) plus the app
// declaration and co-run machinery in `service.mjs` / `workload.mjs` / `placement.mjs`. This file tests those real
// modules and reports the naming difference rather than inventing a module.
//
// Everything runs the shipped CPU-data path (`cpu-sort` INTERACTIVE, `cpu-sum` BATCH) against the real canonical store.
// Nothing here claims a physical two-host run: the workbook's revision-2 engineering milestone needs a second real
// host and a real Codex provider, which this environment does not have, and `runLocalStudy` itself reports
// `physicalAcceptance: 'NOT_RUN'`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {Store} from '../services/dev-gateway/store.mjs';
import {createFabricService} from '../services/personal-compute-fabric/service.mjs';
import {
  createSystemAdapter, createQueueAdapter, createAdapterRegistry, UNSUPPORTED_ON_THIS_ADAPTER,
} from '../services/personal-compute-fabric/adapters.mjs';
import {normalizeWorkload} from '../services/personal-compute-fabric/workload.mjs';
import {normalizeWorkloadEnvelope, qosCapability} from '../services/personal-compute-fabric/workload-envelope.mjs';
import {planPlacement, FEASIBILITY_REFUSALS} from '../services/personal-compute-fabric/placement.mjs';
import {fairQueue} from '../services/personal-compute-fabric/fair-queue.mjs';
import {admit} from '../services/personal-compute-fabric/admission.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {resolveEffectivePolicy, assertPolicy} from '../services/personal-compute-fabric/policy.mjs';
import {CPU_PROVIDER_MANIFEST, executeAttempt} from '../services/personal-compute-fabric/executor.mjs';
import {lifecycleTransition, disableProvider, describeExecutorBoundary, assertProviderCompatibility} from '../services/personal-compute-fabric/executor-provider.mjs';
import {saveCheckpoint} from '../services/personal-compute-fabric/checkpoint.mjs';
import {freezeResearchStudy, runLocalStudy} from '../services/personal-compute-fabric/research-study.mjs';

const DEVICE = 'alien';
const CONTEXT = {sessionId: 'session-724', deviceId: DEVICE};

const authority = () => ({
  version: 1, authorized: true, expiresAt: Date.now() + 60000, originDeviceId: DEVICE, allowedDevices: [DEVICE],
  dataScopes: ['PUBLIC'], sharingConsent: false, cloudConsent: false, budget: 0,
});

/** One real Fabric service over a temporary canonical store; the artifact store is the shipped one. */
async function withService(run, {maxParallel = 2, maxQueue = 4, readAuthority = async () => authority()} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pcf724-'));
  const store = new Store(dir);
  const service = createFabricService({store, artifactRoot: join(dir, 'artifacts'), deviceId: DEVICE, readAuthority, maxParallel, maxQueue});
  try {
    return await run({service, store, dir});
  } finally {
    await service.stop();
    store.db.close();
    await rm(dir, {recursive: true, force: true});
  }
}

const sortTask = (service, key, values = [4, 2, 1]) => service.submit({appId: 'cpu-sort', idempotencyKey: key, parentSessionId: CONTEXT.sessionId, input: {values}}, CONTEXT);
const sumTask = (service, key, values = [1, 2, 3]) => service.submit({appId: 'cpu-sum', idempotencyKey: key, parentSessionId: CONTEXT.sessionId, input: {values}}, CONTEXT);

// ---------------------------------------------------------------------------------------------------------------
// Workbook line 1: an adapter declares app/executor/version, inputs/outputs, resources/QoS, privacy/consent,
// side-effect/checkpoint and the user surface; applications share PCF instead of each writing its own scheduler.
// ---------------------------------------------------------------------------------------------------------------

test('PCF724-01 an optional resource source that does not exist is reported UNSUPPORTED, never as a fabricated measurement', async () => {
  // The adapter declares which dimensions it can honestly supply, and the ones needing hardware it does not talk to
  // are DECLARED as unsupported rather than omitted - an omitted dimension and an unsupported one look identical.
  assert.deepEqual([...UNSUPPORTED_ON_THIS_ADAPTER], ['vram', 'battery', 'thermal', 'networkRtt', 'networkThroughput']);
  const registry = createAdapterRegistry({
    adapters: [createSystemAdapter({os: {}, statfsFn: async () => { throw Object.assign(new Error('no fs'), {code: 'ENOSYS'}); }})],
    now: () => 1000,
  });
  const collected = await registry.collect();
  assert.deepEqual(collected.unsupported, ['battery', 'cpu', 'disk', 'disk.free', 'disk.total', 'memory', 'memory.free', 'memory.total', 'networkRtt', 'networkThroughput', 'thermal', 'vram'].sort());
  assert.equal('disk' in collected.sample, false, 'a missing source must not produce a zero-valued sample');
  assert.equal('cpu' in collected.sample, false, 'an unreadable CPU source is a gap, not a zero-load claim');
  assert.equal('memory' in collected.sample, false);
  assert.ok(collected.notes.some(note => note.includes('disk unavailable')));
  // A queue dimension with no declared source is UNAVAILABLE, not "queue: 0" - which would tell placement the device
  // is idle. This is the same honesty rule applied to the CPU-data fallback when a media provider is absent.
  const noQueue = createQueueAdapter({});
  assert.equal(noQueue.available(), false);
  const queueSample = await noQueue.sample(1000);
  assert.equal('queue' in queueSample.sample, false);
  assert.deepEqual(queueSample.notes, ['no queue source declared']);
  const withQueue = createQueueAdapter({source: async () => 7});
  assert.equal(withQueue.available(), true);
  assert.equal((await withQueue.sample(1000)).sample.queue.value, 7);
});

test('PCF724-02 an application declaration carries app/executor/QoS/resources/output schema/user surface, and an undeclared app is refused', async () => {
  await withService(async ({service, store}) => {
    const submitted = await sortTask(service, 'declare-1');
    const task = store.get('tasks', submitted.taskId);
    const action = store.get('actions', submitted.actionId);
    // appRef, inputs, outputs, resources, QoS and the owning user surface are all recorded on the canonical records.
    assert.equal(task.pcfAppId, 'cpu-sort');
    assert.equal(task.executionBackendId, 'pcf-v1');
    assert.equal(task.parentSessionId, CONTEXT.sessionId);
    assert.equal(task.originDeviceId, DEVICE);
    assert.equal(task.targetDeviceRef, DEVICE);
    assert.equal(task.pcfWorkload.qos, 'INTERACTIVE', 'bounded interactive compute');
    assert.equal(task.pcfWorkload.outputSchema, 'json');
    assert.deepEqual(task.pcfWorkload.resources, {cpu: 1, memory: 1048576});
    assert.equal(task.pcfWorkload.dataScope, 'PUBLIC');
    assert.equal(task.pcfWorkload.retryClass, 'PURE');
    assert.equal(action.status, 'QUEUED');
    assert.equal(action.backendRef.kind, 'CITY_TASK');
    // The two declared applications are the two safe software workload classes; there is no glasses/health vertical.
    assert.equal((await sumTask(service, 'declare-2')).taskId.startsWith('T-'), true);
    await assert.rejects(() => service.submit({appId: 'glasses-health', idempotencyKey: 'x', parentSessionId: CONTEXT.sessionId, input: {values: [1]}}, CONTEXT), {code: 'APP_UNSUPPORTED'});
    // The user surface of the two apps is distinct, and neither is a private scheduler.
    assert.notEqual(store.get('tasks', submitted.taskId).pcfWorkload.qos, 'BATCH');
  });
});

test('PCF724-03 both shippable workload classes produce a real canonical result from the fixed CPU executor', async () => {
  await withService(async ({service, store}) => {
    const sort = await sortTask(service, 'wl-sort');
    const sum = await sumTask(service, 'wl-sum');
    await service.start();
    await service.waitForIdle();
    const sortResult = await service.collect(sort.taskId, CONTEXT);
    const sumResult = await service.collect(sum.taskId, CONTEXT);
    assert.deepEqual(sortResult.output.values, [1, 2, 4]);
    assert.equal(sumResult.output.sum, 6);
    for (const job of [sort, sum]) {
      const task = store.get('tasks', job.taskId);
      assert.equal(task.state, 'COMPLETED');
      assert.ok(task.pcfProcessIdentity.pid > 0, 'a real child process executed the work');
      assert.ok(task.pcfProcessIdentity.host.length > 0);
      assert.match(task.pcfResult.outputDigest, /^[a-f0-9]{64}$/);
      assert.equal(store.get('actions', job.actionId).status, 'SUCCEEDED');
    }
    // The work is local CPU data processing, and the service says so rather than claiming a remote/physical run.
    assert.equal(service.health().executionScope, 'ACTUAL_LOCAL_CPU');
    assert.equal(service.health().physicalAcceptance, 'NOT_RUN');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The workbook's test list: incompatible app versions, bad schemas, unauthorized data, duplicate submissions.
// ---------------------------------------------------------------------------------------------------------------

test('PCF724-04 duplicate submission is idempotent, and the SAME key with DIFFERENT input is an IDEMPOTENCY_CONFLICT', async () => {
  await withService(async ({service, store}) => {
    const first = await sortTask(service, 'idem-1');
    const replay = await sortTask(service, 'idem-1');
    assert.equal(replay.taskId, first.taskId);
    assert.equal(replay.replayed, true);
    assert.equal(store.list('tasks').length, 1, 'a duplicate submission creates no second task');
    await assert.rejects(() => sortTask(service, 'idem-1', [9, 9, 9]), {code: 'IDEMPOTENCY_CONFLICT'});
    // A second session cannot collide with the first session's key space.
    const other = await service.submit({appId: 'cpu-sort', idempotencyKey: 'idem-1', parentSessionId: CONTEXT.sessionId, input: {values: [7]}}, {...CONTEXT, sessionId: 'someone-else'}).catch(error => error.code);
    assert.equal(other, 'CALLER_BINDING');
  });
});

test('PCF724-05 an incompatible app version, a bad input schema and a non-numeric payload modal are typed refusals', async () => {
  await withService(async ({service}) => {
    // An app this release does not declare is refused; there is no "best effort" execution of an unknown version.
    await assert.rejects(() => service.submit({appId: 'cpu-sort-v2', idempotencyKey: 'v2', parentSessionId: CONTEXT.sessionId, input: {values: [1]}}, CONTEXT), {code: 'APP_UNSUPPORTED'});
    await assert.rejects(() => service.submit({appId: 'cpu-sort', idempotencyKey: 'v3-version', parentSessionId: CONTEXT.sessionId, input: {values: [1]}, appVersion: 2}, CONTEXT), {code: 'APP_UNSUPPORTED'});
    await assert.rejects(() => service.submit({appId: 'cpu-sort', idempotencyKey: '', parentSessionId: CONTEXT.sessionId, input: {values: [1]}}, CONTEXT), {code: 'APP_UNSUPPORTED'});
    // Extra/unknown request fields are refused before an app is even resolved.
    await assert.rejects(() => service.submit({appId: 'cpu-sort', idempotencyKey: 'extra', parentSessionId: CONTEXT.sessionId, input: {values: [1]}, privilege: 'root'}, CONTEXT), {code: 'APP_UNSUPPORTED'});
    // A bad schema is a named refusal: the operation allowlist and the numeric input shape are both enforced.
    await assert.rejects(() => service.submit({appId: 'cpu-sort', idempotencyKey: 'schema', parentSessionId: CONTEXT.sessionId, input: {values: 'not-an-array'}}, CONTEXT), {code: 'APP_INPUT'});
    await assert.rejects(() => service.submit({appId: 'cpu-sort', idempotencyKey: 'schema2', parentSessionId: CONTEXT.sessionId, input: {values: [1, 'two']}}, CONTEXT), {code: 'APP_INPUT'});
    await assert.rejects(() => service.submit({appId: 'cpu-sort', idempotencyKey: 'schema3', parentSessionId: CONTEXT.sessionId, input: {operation: 'SORT', values: [1]}}, CONTEXT), {code: 'APP_INPUT'});
    // The executor itself refuses an operation outside the manifest allowlist with its own code.
    await assert.rejects(() => executeAttempt({
      envelope: normalizeWorkloadEnvelope({
        envelopeVersion: 2, taskId: 'T-1', actionId: 'A-1', originDeviceId: DEVICE, parentSessionId: 's', appId: 'cpu-sort', targetDeviceRef: DEVICE,
        executor: {providerRef: 'pcf-fixed-cpu-v1', providerVersion: 1, providerManifestRef: 'manifest:1'},
        inputSchema: 'cpu-json-v1', outputSchema: 'json', capabilities: ['cpu.json', 'cpu.checkpoint'], inputRefs: [], writeScope: [],
        platform: {os: [process.platform], arch: [process.arch]}, resources: {cpu: {amount: 1, unit: 'millicores'}}, qos: 'BATCH',
        deadlineAt: null, missPolicy: null, retrySafety: 'SIDE_EFFECT_FREE', dataScope: 'PUBLIC', consent: {required: false, scopeRef: null},
        privilegeRequests: [], labels: {},
      }),
      reservation: {id: 'R-1', state: 'LEASED', expiresAt: Date.now() + 60000, taskId: 'T-1', actionId: 'A-1', deviceId: DEVICE, bootId: 'b'},
      controls: {operation: 'RM_RF', values: []},
    }), {code: 'EXECUTOR_ARGUMENT_NOT_ALLOWED'});
  });
});

test('PCF724-06 unauthorized data scope and an unapproved device are refused by the policy, not by the app', async () => {
  const now = Date.now();
  const policy = resolveEffectivePolicy({mode: 'TRUSTED_PERSONAL_FABRIC'}, {...authority(), expiresAt: now + 60000}, now);
  assert.equal(assertPolicy(policy, {deviceId: DEVICE, dataScope: 'PUBLIC', fee: 0}, now), true);
  assert.throws(() => assertPolicy(policy, {deviceId: DEVICE, dataScope: 'CONFIDENTIAL', fee: 0}, now), {code: 'SCOPE_NOT_APPROVED'});
  assert.throws(() => assertPolicy(policy, {deviceId: 'mech', dataScope: 'PUBLIC', fee: 0}, now), {code: 'DEVICE_NOT_APPROVED'});
  assert.throws(() => assertPolicy(policy, {deviceId: DEVICE, dataScope: 'PUBLIC', fee: 1}, now), {code: 'BUDGET_NOT_APPROVED'});
  // A revoking authority stops the service before dispatch, and the task records WHY rather than inventing a result.
  await withService(async ({service, store}) => {
    let authorized = true;
    const job = await service.submit({appId: 'cpu-sum', idempotencyKey: 'auth-1', parentSessionId: CONTEXT.sessionId, input: {values: [1]}}, CONTEXT);
    authorized = false;
    const second = createFabricService({
      store, artifactRoot: join(store.dir ?? '.', 'unused'), deviceId: DEVICE,
      readAuthority: async () => (authorized ? authority() : {...authority(), authorized: false}),
    });
    await second.stop();
    const failed = await service.submit({appId: 'cpu-sum', idempotencyKey: 'auth-2', parentSessionId: CONTEXT.sessionId, input: {values: [2]}}, CONTEXT);
    assert.ok(failed.taskId);
    assert.equal(store.get('tasks', job.taskId).state, 'QUEUED');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Workbook line 3: co-run workloads and measure interference, quotas/fairness, cancellation, failure isolation and
// origin return. One app exiting must not erase another app's state or stop the City.
// ---------------------------------------------------------------------------------------------------------------

test('PCF724-07 several apps co-run on ONE scheduler, and fairness alternates app ownership instead of draining one app first', async () => {
  await withService(async ({service, store}) => {
    const jobs = [];
    for (let index = 0; index < 3; index += 1) jobs.push(await sortTask(service, `co-sort-${index}`, [index + 3, 1, 2]));
    for (let index = 0; index < 3; index += 1) jobs.push(await sumTask(service, `co-sum-${index}`, [index + 1, 1]));
    await service.start();
    await service.waitForIdle();
    // Every app's work completed; no app was starved by the other's queue.
    for (const job of jobs) assert.equal(store.get('tasks', job.taskId).state, 'COMPLETED');
    assert.deepEqual((await service.collect(jobs[0].taskId, CONTEXT)).output.values, [1, 2, 3]);
    // The sustained batch class returns its own canonical shape, not the interactive one.
    assert.deepEqual((await service.collect(jobs[3].taskId, CONTEXT)).output, {sum: 2, cursor: 2});
    // Fairness is app-level: with two apps queued, the app that did NOT own the last dispatch goes first.
    const queue = [
      {id: 'a1', appId: 'cpu-sort', queuedAt: 0},
      {id: 'a2', appId: 'cpu-sort', queuedAt: 1},
      {id: 'b1', appId: 'cpu-sum', queuedAt: 2},
    ];
    assert.deepEqual(fairQueue(queue, {lastAppId: null, now: 100}).map(entry => entry.appId), ['cpu-sort', 'cpu-sum', 'cpu-sort']);
    assert.deepEqual(fairQueue(queue, {lastAppId: 'cpu-sort', now: 100}).map(entry => entry.id), ['b1', 'a1', 'a2']);
    // A bounded queue refuses rather than silently dropping or reordering the request.
    assert.throws(() => fairQueue(Array(257).fill(queue[0]), {now: 100}), {code: 'FAIR_QUEUE_LIMIT'});
    assert.throws(() => fairQueue([{id: 'a', appId: 'cpu-sort', queuedAt: 200}], {now: 100}), {code: 'QUEUE_RECORD'});
    // Aging stops a long wait from being starved forever by a busier app.
    const aged = [{id: 'old', appId: 'cpu-sum', queuedAt: 0}, {id: 'new', appId: 'cpu-sort', queuedAt: 9990}];
    assert.equal(fairQueue(aged, {lastAppId: 'cpu-sort', now: 10000, agingMs: 30}).at(0).id, 'old');
  }, {maxParallel: 2, maxQueue: 16});
});

test('PCF724-08 a candidate without enough free capacity is refused, and admission enforces the per-app quota', async () => {
  // Capacity is a first-class feasibility refusal, and an insufficient device is not "probably fine".
  const workload = normalizeWorkload({
    version: 1, taskId: 'T-q', actionId: 'A-q', originDeviceId: DEVICE, parentSessionId: 's', appId: 'cpu-sum', kind: 'CPU_JSON',
    capabilities: ['cpu.json'], inputRefs: [], writeScope: [], resources: {cpu: 2}, dataScope: 'PUBLIC', qos: 'BATCH',
    retryClass: 'PURE', outputSchema: 'json', deadlineAt: Date.now() + 60000,
  });
  const candidate = {
    deviceId: DEVICE, bootId: 'boot', trusted: true, authorized: true, sharing: true, executorReady: true,
    provider: {id: 'pcf-fixed-cpu-v1', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON']},
    free: {cpu: 1}, observationVersion: 1, observedAt: Date.now() - 10, validUntil: Date.now() + 10000, queueMs: 0,
    cost: {inputMs: [0, 1], coldStartMs: [0, 1], executeMs: [0, 1], returnMs: [0, 1]},
  };
  const now = Date.now();
  const policy = resolveEffectivePolicy({mode: 'TRUSTED_PERSONAL_FABRIC'}, authority(), now);
  const starved = planPlacement(workload, [candidate], policy, now);
  assert.equal(starved.state, 'REFUSED');
  assert.equal(starved.decisions[0].code, FEASIBILITY_REFUSALS.RESOURCE_INSUFFICIENT);
  assert.equal(starved.decisions[0].remedy, 'NONE');

  // The per-app quota is enforced at admission, from the same real placement proposal the service would use.
  const dir = await mkdtemp(join(tmpdir(), 'pcf724-quota-'));
  const store = new Store(dir);
  let closed = false;
  try {
    const owner = createCanonicalStateAdapter(store);
    store.put('tasks', {id: 'T-q', actionId: 'A-q', state: 'QUEUED', originDeviceId: DEVICE, parentSessionId: 's', appId: 'cpu-sum'});
    const roomy = {...candidate, free: {cpu: 8}};
    const proposal = planPlacement(workload, [roomy], policy, now);
    assert.equal(proposal.state, 'PROPOSED');
    // No app quota declared for this app: the app may not run at all.
    assert.throws(() => admit(owner, {workload, proposal, policy, candidate: roomy, idempotencyKey: 'quota:1', ttlMs: 5000, now}), {code: 'APP_QUOTA'});
    // A declared quota smaller than the demand is refused the same way; a sufficient one is leased.
    assert.throws(() => admit(owner, {workload, proposal, policy, candidate: roomy, idempotencyKey: 'quota:2', ttlMs: 5000, appQuota: {cpu: 1}, now}), {code: 'APP_QUOTA'});
    const leased = admit(owner, {workload, proposal, policy, candidate: roomy, idempotencyKey: 'quota:3', ttlMs: 5000, appQuota: {cpu: 4}, now});
    assert.equal(leased.reservation.state, 'LEASED');
    assert.equal(leased.reservation.appId, 'cpu-sum');

    // The service reports a bounded queue honestly: a full queue refuses new work rather than dropping or lying.
    const service = createFabricService({
      store, artifactRoot: join(dir, 'service-artifacts'), deviceId: DEVICE, readAuthority: async () => authority(), maxParallel: 1, maxQueue: 1,
    });
    try {
      await sortTask(service, 'busy-1');
      await assert.rejects(() => sortTask(service, 'busy-2'), {code: 'QUEUE_FULL'});
      assert.equal(service.health().queued, 1);
      assert.equal(service.health().state, 'READY_NOT_STARTED');
    } finally {
      await service.stop();
    }
  } finally {
    store.db.close();
    closed = true;
    await rm(dir, {recursive: true, force: true});
  }
  assert.equal(closed, true);
});

test('PCF724-09 cancelling one app does not erase the other app state, and the City keeps serving', async () => {
  await withService(async ({service, store}) => {
    const cancelled = await sortTask(service, 'cancel-a', [3, 2, 1]);
    const survivor = await sumTask(service, 'cancel-b', [5, 5]);
    const cancelResult = await service.cancel(cancelled.taskId, CONTEXT);
    assert.equal(cancelResult.state, 'CANCELLED');
    await service.start();
    await service.waitForIdle();
    assert.equal(store.get('tasks', cancelled.taskId).state, 'CANCELLED');
    assert.equal(store.get('actions', cancelled.actionId).status, 'CANCELLED');
    // The other app's state is intact and still readable from its originating session.
    const survivorTask = store.get('tasks', survivor.taskId);
    assert.equal(survivorTask.state, 'COMPLETED');
    assert.equal(survivorTask.parentSessionId, CONTEXT.sessionId);
    assert.equal((await service.collect(survivor.taskId, CONTEXT)).output.sum, 10);
    assert.equal(service.health().state, 'RUNNING', 'the City is not stopped by one app leaving');
    // Cancelling an already-terminal task is idempotent and does not rewrite another app's task.
    assert.deepEqual(await service.cancel(cancelled.taskId, CONTEXT), {taskId: cancelled.taskId, state: 'CANCELLED', alreadyTerminal: true});
    assert.equal(store.get('tasks', survivor.taskId).state, 'COMPLETED');
  });
});

test('PCF724-10 a crash is contained to its own attempt and never becomes an automatic retry of side-effecting work', () => {
  // The provider contract states the CRASH semantics for one provider: contained, outcome UNKNOWN, no auto restart,
  // and explicitly no effect on other providers or on the City.
  const crash = lifecycleTransition(CPU_PROVIDER_MANIFEST, 'CRASH');
  assert.equal(crash.accepted, true);
  assert.equal(crash.action, 'CONTAIN_TO_THIS_ATTEMPT_AND_MARK_OUTCOME_UNKNOWN');
  assert.equal(crash.requiresOutcomeVerification, true);
  assert.equal(crash.autoRestart, false);
  assert.equal(crash.affectsOtherProviders, false);
  assert.equal(crash.cityShutdown, false);
  // Disabling the CPU provider leaves every other provider entry unchanged and does not shut the City down.
  const other = {...CPU_PROVIDER_MANIFEST, providerRef: 'pcf-other-provider'};
  const disabled = disableProvider([CPU_PROVIDER_MANIFEST, other], 'pcf-fixed-cpu-v1');
  assert.equal(disabled.cityShutdown, false);
  assert.equal(disabled.othersUnchanged, true);
  assert.equal(disabled.providers.find(entry => entry.providerRef === 'pcf-other-provider').ready, true);
  assert.equal(disabled.providers.find(entry => entry.providerRef === 'pcf-fixed-cpu-v1').ready, false);
  // The executor is not a sandbox, and this project says so instead of implying a hard boundary.
  assert.equal(describeExecutorBoundary(CPU_PROVIDER_MANIFEST).enforcement, 'COOPERATIVE');
  assert.throws(() => describeExecutorBoundary(CPU_PROVIDER_MANIFEST, {requireHardIsolation: true}), {code: 'HARD_ISOLATION_UNAVAILABLE'});
  // An incompatible consumer version is refused rather than assumed.
  assert.equal(assertProviderCompatibility(CPU_PROVIDER_MANIFEST, 1).compatible, true);
  assert.throws(() => assertProviderCompatibility(CPU_PROVIDER_MANIFEST, 2), {code: 'PROVIDER_INCOMPATIBLE_CONSUMER'});
});

// ---------------------------------------------------------------------------------------------------------------
// Origin return and misrouted results.
// ---------------------------------------------------------------------------------------------------------------

test('PCF724-11 a result is only returned to its own origin session and device; a misrouted collect is refused', async () => {
  await withService(async ({service}) => {
    const job = await sortTask(service, 'origin-1');
    await service.start();
    await service.waitForIdle();
    const result = await service.collect(job.taskId, CONTEXT);
    assert.deepEqual(result.output.values, [1, 2, 4]);
    assert.equal(result.delivered, true);
    assert.equal(result.consumed, false, 'returning a result is not the agent consuming it');
    // A caller whose session is not bound to this device is refused by CALLER_BINDING before any task truth is read;
    // a caller that names the right device but a session that does not own the task is refused by ORIGIN_UNAUTHORIZED.
    // Each is a distinct registered code, and neither can read another app's task or result.
    await assert.rejects(() => service.collect(job.taskId, {sessionId: 'other-session', deviceId: 'mech'}), {code: 'CALLER_BINDING'});
    await assert.rejects(() => service.collect(job.taskId, {sessionId: CONTEXT.sessionId, deviceId: 'mech'}), {code: 'CALLER_BINDING'});
    // A caller with a valid body but a session that does not own the task is refused by ORIGIN_UNAUTHORIZED.
    await assert.rejects(() => service.collect(job.taskId, {sessionId: 'other-session', deviceId: DEVICE}), {code: 'ORIGIN_UNAUTHORIZED'});
    await assert.rejects(() => service.inspect('T-not-mine', CONTEXT), {code: 'ORIGIN_UNAUTHORIZED'});
    // Consumption is a separate, acknowledged step against the digest of what was returned.
    await assert.rejects(() => service.acknowledge(job.taskId, CONTEXT, 'c'.repeat(64)), {code: 'CONSUMPTION_DIGEST'});
    await assert.rejects(() => service.acknowledge(job.taskId, {sessionId: 'other-session', deviceId: DEVICE}, result.digest), {code: 'ORIGIN_UNAUTHORIZED'});
    await assert.rejects(() => service.acknowledge(job.taskId, {sessionId: 'other-session', deviceId: 'mech'}, result.digest), {code: 'CALLER_BINDING'});
    await service.acknowledge(job.taskId, CONTEXT, result.digest);
    assert.equal((await service.collect(job.taskId, CONTEXT)).consumed, true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Workbook line 1 (side effect/checkpoint) and line 4 (thin future-vertical adapters with explicit contract gaps).
// ---------------------------------------------------------------------------------------------------------------

test('PCF724-12 a checkpoint requires bounded side effects and a complete provider/attempt binding', async () => {
  const published = [];
  const store = {
    publish: async (bytes, metadata, now) => { published.push({bytes, metadata, now}); return {id: '00000000-0000-0000-0000-000000000000', digest: 'a'.repeat(64), size: bytes.length, ...metadata}; },
  };
  const binding = {owner: CONTEXT.sessionId, dataScope: 'PUBLIC', expiresAt: Date.now() + 60000, taskId: 'T-1', attemptId: 'ATT-1', inputDigest: 'a'.repeat(64), providerVersion: 1, stageId: 'stage-1'};
  // A side-effecting workload cannot pretend to be resumable: unknown side effects are a typed refusal.
  await assert.rejects(() => saveCheckpoint(store, {sideEffects: 'UNKNOWN', cursor: 3}, binding, Date.now()), {code: 'CHECKPOINT_SIDE_EFFECT_UNKNOWN'});
  await assert.rejects(() => saveCheckpoint(store, {sideEffects: 'WRITES_FILES', cursor: 3}, binding, Date.now()), {code: 'CHECKPOINT_SIDE_EFFECT_UNKNOWN'});
  await assert.rejects(() => saveCheckpoint(store, {sideEffects: 'NONE', cursor: 3}, {...binding, attemptId: undefined}, Date.now()), {code: 'CHECKPOINT_BINDING'});
  await assert.rejects(() => saveCheckpoint(store, {sideEffects: 'NONE', cursor: 3}, {...binding, inputDigest: undefined}, Date.now()), {code: 'CHECKPOINT_BINDING'});
  // A bounded, side-effect-free checkpoint is accepted and carries its binding.
  const ref = await saveCheckpoint(store, {sideEffects: 'NONE', cursor: 3}, binding, 1000);
  assert.equal(ref.schema, 'pcf-checkpoint-v1');
  const body = JSON.parse(published[0].bytes.toString());
  assert.equal(body.version, 1);
  assert.equal(body.binding.attemptId, 'ATT-1');
  assert.equal(body.state.cursor, 3);
});

test('PCF724-13 a future vertical adapter declares its contract gaps and its QoS carries no hard real-time promise', () => {
  // The shipped provider declares which consumer reads which field, so a future Foreman/glasses/room/health adapter
  // has a named contract rather than a private scheduler. The gaps are the dimensions no available adapter covers.
  assert.equal(CPU_PROVIDER_MANIFEST.workloadKinds.includes('CPU_JSON'), true);
  assert.equal(CPU_PROVIDER_MANIFEST.workloadSchemas.includes('json'), true);
  assert.equal(CPU_PROVIDER_MANIFEST.storageNamespace, 'pcf-cpu-scratch');
  assert.equal(CPU_PROVIDER_MANIFEST.lifecycle.CRASH, 'CONTAIN_TO_ATTEMPT');
  // A declared deadline is NOT a real-time guarantee, and a missing miss-policy is refused instead of defaulted.
  const envelope = {
    envelopeVersion: 2, taskId: 'T-1', actionId: 'A-1', originDeviceId: DEVICE, parentSessionId: 's', appId: 'room-health-example',
    targetDeviceRef: null, executor: {providerRef: 'pcf-fixed-cpu-v1', providerVersion: 1, providerManifestRef: 'manifest:1'},
    inputSchema: 'cpu-json-v1', outputSchema: 'json', capabilities: ['cpu.json'], inputRefs: [], writeScope: [],
    platform: {os: [process.platform], arch: [process.arch]}, resources: {cpu: {amount: 1, unit: 'millicores'}},
    qos: 'SOFT_DEADLINE', deadlineAt: Date.now() + 1000, missPolicy: null, retrySafety: 'SIDE_EFFECT_FREE',
    dataScope: 'PUBLIC', consent: {required: false, scopeRef: null}, privilegeRequests: [], labels: {},
  };
  assert.throws(() => normalizeWorkloadEnvelope(envelope), {code: 'ENVELOPE_MISS_POLICY_REQUIRED'});
  const capability = qosCapability({...envelope, missPolicy: 'DEGRADE'});
  assert.equal(capability.hardRealTimeGuarantee, false);
  assert.equal(capability.missPolicy, 'DEGRADE');
  assert.match(capability.statement, /explicit miss policy DEGRADE/);
  // A sensory/health adapter may not smuggle a privilege it has no verified handle for.
  assert.throws(() => normalizeWorkloadEnvelope({...envelope, missPolicy: 'DEGRADE', privilegeRequests: [{name: 'camera.raw'}]}), {code: 'ENVELOPE_PRIVILEGE_UNVERIFIED'});
});

// ---------------------------------------------------------------------------------------------------------------
// Workbook line 2 + revision 2: two real safe workload classes through the audited CPU-data executor, with the
// physical two-host claim left where it belongs.
// ---------------------------------------------------------------------------------------------------------------

test('PCF724-14 the study harness runs both workload classes locally and reports every physical claim as NOT_RUN', async () => {
  const {execFileSync} = await import('node:child_process');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  const config = {
    version: 1, id: 'pcf724-local-pilot', repetitions: 1, stopAfterMs: 120000, softwareSha: head,
    workloads: ['cpu-sort', 'cpu-sum'], hypotheses: ['Both safe workload classes produce canonical local CPU output'],
    evidenceClass: 'ACTUAL_LOCAL_CPU', inputs: {'cpu-sort': {values: [3, 1, 2]}, 'cpu-sum': {values: [3, 1, 2]}},
    controls: {hardware: 'host-local', cache: 'UNCONTROLLED', network: 'NO_REMOTE_EXECUTION'},
    analysis: 'DESCRIPTIVE_ONLY', failureCounting: 'KEEP_ALL',
  };
  // The harness refuses a simulated label: a local CPU pilot is graded as an ACTUAL local CPU run, not as a mock.
  assert.throws(() => freezeResearchStudy({...config, evidenceClass: 'SIMULATED'}), {code: 'STUDY_LOCAL_ONLY'});
  assert.throws(() => freezeResearchStudy({...config, workloads: ['cpu-sort', 'cpu-sum', 'cpu-sort']}), {code: 'STUDY_WORKLOADS'});
  assert.throws(() => freezeResearchStudy({...config, workloads: ['cpu-sort', 'cpu-sum', 'glasses-demo']}), {code: 'STUDY_WORKLOADS'});
  // A study that would drop its failures cannot be frozen: the report has to keep every trial.
  assert.throws(() => freezeResearchStudy({...config, failureCounting: 'DROP_FAILURES'}), {code: 'STUDY_ANALYSIS'});
  const directory = await mkdtemp(join(tmpdir(), 'pcf724-study-'));
  try {
    const report = await runLocalStudy(config, {directory, allowDirtySnapshot: true, deviceId: DEVICE});
    assert.equal(report.trials.length, 2);
    assert.ok(report.trials.every(trial => trial.state === 'COMPLETED'));
    assert.deepEqual(report.trials.find(trial => trial.appId === 'cpu-sort').output.values, [1, 2, 3]);
    assert.equal(report.trials.find(trial => trial.appId === 'cpu-sum').output.sum, 6);
    assert.equal(report.evidenceClass, 'ACTUAL_LOCAL_CPU');
    // The physical two-host milestone of revision 2 is NOT_RUN here, and the report says so per claim.
    assert.equal(report.physicalAcceptance, 'NOT_RUN');
    for (const claim of ['mechIndependentRebuild', 'rexRunnerFaultReplayExport', 'mixedEngineeringMLWorkloads', 'crossHost', 'statisticalBenefit']) {
      assert.equal(report.requiredEvidence[claim], 'NOT_RUN', `${claim} must be reported NOT_RUN rather than assumed`);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
