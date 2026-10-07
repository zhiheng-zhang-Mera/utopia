// PCF-728 workbook acceptance: originating-agent remote-job and result-return bridge.
// Workbook: dc/mission-book/mission-group/personal-compute-fabric/PCF-728-originating-agent-remote-job-bridge.md
// Real modules under test: services/personal-compute-fabric/engineering-tools.mjs (the versioned caller
// facade named by the workbook), origin-agent-bridge.mjs, origin-projection.mjs, the canonical
// service/admission/store owners, and recovery.mjs. tests/pcf728-tools.test.mjs and
// tests/pcf728-canonical-flow.test.mjs already own the facade forwarding and the component-fixture flow,
// so this file covers the workbook's own acceptance list: a staged receipt, the result read back as an
// explicit input, bounded offline recovery, one canonical terminal under retry/duplicate/late/cancel
// races, and output that is data rather than an instruction.
//
// NOT_RUN on this host (external prerequisite, no attempt made): the workbook's real Alien-origin ->
// Mech-execution -> same Alien parent-session consumption, the reverse direction, and the two-host
// "dispatched" stage of the remote worker port all need a second physical host.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../services/dev-gateway/store.mjs';
import {createFabricService} from '../services/personal-compute-fabric/service.mjs';
import {createEngineeringTools} from '../services/personal-compute-fabric/engineering-tools.mjs';
import {createOriginAgentBridge} from '../services/personal-compute-fabric/origin-agent-bridge.mjs';
import {projectOrigin} from '../services/personal-compute-fabric/origin-projection.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {commitResult} from '../services/personal-compute-fabric/admission.mjs';
import {planRecovery} from '../services/personal-compute-fabric/recovery.mjs';
import {compileExecutionPlan, stageOrder, executeStages} from '../services/personal-compute-fabric/pipeline.mjs';
import {terminal} from '../contracts/city-control-v0/protocol.mjs';

const sessionId = 'alien-parent-session';
const deviceId = 'alien-host';

// A real canonical owner: the existing Store plus the approved local service. Nothing here is a PCF
// task database - the canonical Task/Action rows are the only task truth.
async function withService(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pcf728-origin-'));
  const store = new Store(dir);
  let authorized = true;
  const service = createFabricService({
    store,
    artifactRoot: join(dir, 'artifacts'),
    deviceId,
    maxParallel: 2,
    readAuthority: async caller => ({
      version: 1,
      authorized: authorized && caller.sessionId === sessionId && caller.deviceId === deviceId,
      expiresAt: Date.now() + 60000,
      originDeviceId: deviceId,
      allowedDevices: [deviceId],
      dataScopes: ['PUBLIC'],
      sharingConsent: false,
      cloudConsent: false,
      budget: 0,
    }),
  });
  const context = {sessionId, deviceId};
  const authorize = async caller => authorized && caller.sessionId === sessionId && caller.deviceId === deviceId;
  try {
    await run({service, store, context, authorize, revoke: () => {authorized = false;}});
  } finally {
    await service.stop();
    store.db.close();
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
}

async function withCanonical(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pcf728-terminal-'));
  const store = new Store(dir);
  const owner = createCanonicalStateAdapter(store);
  const seed = (taskId, attemptId) => {
    store.put('tasks', {id: taskId, state: 'RUNNING', actionId: 'A-' + taskId, originDeviceId: deviceId, parentSessionId: sessionId, pcfAttemptId: attemptId, pcfEpoch: 1});
    owner.transaction(undefined, state => {
      state.reservations.push({id: 'R-' + taskId, key: 'key-' + taskId, taskId, state: 'RUNNING'});
      state.attempts.push({id: attemptId, reservationId: 'R-' + taskId, taskId, actionId: 'A-' + taskId, originDeviceId: deviceId, parentSessionId: sessionId, holder: 'holder', bootId: 'boot', epoch: 1, state: 'RUNNING'});
      return {};
    });
  };
  try {
    await run({owner, store, seed});
  } finally {
    store.db.close();
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
}

// Workbook line 49: versioned caller tools over the canonical Task/Action, bound to the originating
// session, with authority rechecked on every invocation.
test('728 versioned caller tools stay bound to the originating session and recheck authority on every call', async () => {
  await withService(async ({service, store, context, authorize, revoke}) => {
    const tools = createEngineeringTools(service, {sessionId, deviceId, authorize});
    assert.equal(tools.version, 1);
    for (const name of ['submitRemoteJob', 'inspectRemoteJob', 'cancelRemoteJob', 'collectRemoteResult']) {
      assert.equal(typeof tools[name], 'function', 'the workbook caller tool ' + name + ' exists');
    }
    await assert.rejects(async () => tools.submitRemoteJob({parentSessionId: 'other-session', appId: 'cpu-sum', idempotencyKey: 'foreign', input: {values: [1]}}), {code: 'CALLER_BINDING'});
    assert.throws(() => createEngineeringTools({}, {sessionId, deviceId, authorize}), {code: 'CANONICAL_METHOD_submit'}, 'an incomplete canonical owner is a typed configuration refusal');
    assert.throws(() => createEngineeringTools(service, {sessionId: '', deviceId, authorize}), {code: 'CALLER_CONFIGURATION'});
    assert.throws(() => createEngineeringTools(service, {sessionId, deviceId}), {code: 'CALLER_CONFIGURATION'});

    const accepted = await tools.submitRemoteJob({parentSessionId: sessionId, appId: 'cpu-sum', idempotencyKey: 'authority', input: {values: [1, 2]}});
    assert.ok(accepted.taskId);
    assert.equal(store.list('tasks').length, 1, 'the caller facade creates no separate task library');
    assert.equal(store.list('actions').length, 1, 'the caller facade reuses the canonical Action');
    revoke();
    await assert.rejects(async () => tools.inspectRemoteJob(accepted.taskId, 0), {code: 'ORIGIN_UNAUTHORIZED'});
    await assert.rejects(async () => tools.cancelRemoteJob(accepted.taskId), {code: 'ORIGIN_UNAUTHORIZED'});
    await assert.rejects(async () => tools.collectRemoteResult(accepted.taskId), {code: 'ORIGIN_UNAUTHORIZED'});
    await assert.rejects(async () => service.inspect(accepted.taskId, context), {code: 'AUTHORITY_EXPIRED_OR_REVOKED'}, 'the canonical owner refuses the revoked caller too');
  });
});

// Workbook line 49: distinguish accepted / running / result-ready / result-delivered / consumed instead
// of reporting instant success.
test('728 the receipt distinguishes accepted, running, result-ready, delivered and consumed instead of turning green at once', async () => {
  await withService(async ({service, store, context, authorize}) => {
    const tools = createEngineeringTools(service, {sessionId, deviceId, authorize});
    const accepted = await tools.submitRemoteJob({parentSessionId: sessionId, appId: 'cpu-sum', idempotencyKey: 'receipt', input: {values: [1, 2]}});
    assert.ok(accepted.taskId && accepted.actionId);
    assert.equal(accepted.replayed, false);
    assert.equal(Object.hasOwn(accepted, 'delivered'), false, 'acceptance is not delivery');
    assert.equal(Object.hasOwn(accepted, 'consumed'), false, 'acceptance is not consumption');
    const queued = await tools.inspectRemoteJob(accepted.taskId, 0);
    assert.equal(queued.state, 'QUEUED', 'accepted work is queued, not reported as running');
    assert.equal(queued.pcfResult ?? null, null, 'a queued task has no result yet');
    await assert.rejects(async () => tools.collectRemoteResult(accepted.taskId), {code: 'RESULT_NOT_READY'}, 'a result cannot be collected before it exists');

    await service.start();
    await service.waitForIdle();
    const completed = await tools.inspectRemoteJob(accepted.taskId, 0);
    assert.equal(completed.state, 'COMPLETED');
    assert.equal(completed.pcfResult.outcome, 'SUCCEEDED', 'the capsule outcome stays SUCCEEDED beside the canonical terminal');
    assert.equal(completed.pcfDeliveredSessionId ?? null, null, 'a result-ready task is not yet delivered');

    const delivered = await tools.collectRemoteResult(accepted.taskId);
    assert.equal(delivered.delivered, true);
    assert.equal(delivered.consumed, false, 'result-delivered is not consumed');
    assert.equal(delivered.output.sum, 3);
    assert.equal((await tools.inspectRemoteJob(accepted.taskId, 0)).pcfDeliveredSessionId, sessionId);
    await assert.rejects(async () => tools.acknowledgeRemoteResult(accepted.taskId, 'f'.repeat(64)), {code: 'CONSUMPTION_DIGEST'}, 'a wrong digest cannot mark consumption');
    const consumed = await tools.acknowledgeRemoteResult(accepted.taskId, delivered.digest);
    assert.equal(consumed.consumed, true);
    assert.equal((await tools.collectRemoteResult(accepted.taskId)).consumed, true, 'consumed is only true after the explicit acknowledgement');
    assert.ok(store.get('tasks', accepted.taskId).pcfConsumedSessionId === sessionId);
  });
});

// Workbook line 53: the returned result is actually read back and used as an explicit input for the next
// step; being visible in the UI is not consumption.
test('728 the originating agent reads the result back as an explicit input for the next step', async () => {
  await withService(async ({service, store, context, authorize}) => {
    const tools = createEngineeringTools(service, {sessionId, deviceId, authorize});
    const first = await tools.submitRemoteJob({parentSessionId: sessionId, appId: 'cpu-sort', idempotencyKey: 'step-1', input: {values: [3, 1, 2]}});
    await service.start();
    await service.waitForIdle();
    const result = await tools.collectRemoteResult(first.taskId);
    assert.deepEqual(result.output, {values: [1, 2, 3]});
    assert.equal(result.consumed, false, 'a visible result is not a consumed one');

    // The next step takes the returned bytes as its explicit input, not as ambient state.
    const second = await tools.submitRemoteJob({parentSessionId: sessionId, appId: 'cpu-sum', idempotencyKey: 'step-2', input: {values: result.output.values}});
    await service.waitForIdle();
    const derived = await tools.collectRemoteResult(second.taskId);
    assert.equal(derived.output.sum, 6, 'the second step consumed the first result as data');
    assert.notEqual(second.taskId, first.taskId);

    const stillOpen = await tools.collectRemoteResult(first.taskId);
    assert.equal(stillOpen.consumed, false, 'a later read does not silently become consumption');
    await tools.acknowledgeRemoteResult(first.taskId, stillOpen.digest);
    assert.equal((await tools.collectRemoteResult(first.taskId)).consumed, true, 'the same originating session records the explicit consumption');
    assert.equal(store.get('tasks', first.taskId).pcfConsumedSessionId, sessionId);
    assert.equal(store.get('tasks', second.taskId).pcfConsumedSessionId ?? null, null, 'the second task is not consumed by the first acknowledgement');
  });
});

// Workbook line 53: bounded retrieval after an origin disconnect, and no injection into a different
// unauthorized session.
test('728 origin recovery is bounded, gap-aware and refuses any other session', async () => {
  await withService(async ({service, store, context, authorize}) => {
    const accepted = await service.submit({appId: 'cpu-sum', idempotencyKey: 'recovery', input: {values: [1]}, parentSessionId: sessionId}, context);
    await service.start();
    await service.waitForIdle();
    const task = store.get('tasks', accepted.taskId);
    const events = Array.from({length: 300}, (_, index) => ({seq: index + 1, taskId: accepted.taskId, kind: 'PROGRESS'}));
    const auth = {authorized: true, deviceId, sessionId};

    const page = projectOrigin(task, events, {auth, after: 0, limit: 128});
    assert.equal(page.events.length, 128, 'offline retrieval is bounded');
    assert.equal(page.cursor, 128);
    assert.equal(page.reconcileRequired, true, 'a truncated window requires reconciliation');
    assert.equal(page.gap, false);
    assert.equal(page.agentConsumed, false);
    assert.notEqual(page.result, null, 'the result-ready payload is retrievable after a reconnect');

    const gapped = projectOrigin(task, events.filter(event => event.seq >= 10), {auth, after: 0, limit: 8});
    assert.equal(gapped.gap, true, 'a sequence gap is surfaced, not hidden');
    assert.equal(gapped.reconcileRequired, true);
    const deduped = projectOrigin(task, [{seq: 1, taskId: accepted.taskId}, {seq: 1, taskId: accepted.taskId}, {seq: 2, taskId: accepted.taskId}], {auth, after: 0, limit: 8});
    assert.equal(deduped.events.length, 2, 'a replayed sequence is not delivered twice');
    assert.equal(deduped.cursor, 2);

    for (const wrong of [{...auth, sessionId: 'other-session'}, {...auth, deviceId: 'other-host'}, {...auth, authorized: false}]) {
      assert.throws(() => projectOrigin(task, events, {auth: wrong, after: 0, limit: 8}), {code: 'ORIGIN_UNAUTHORIZED'}, 'a result is never injected into another unauthorized session');
    }
    assert.throws(() => projectOrigin(task, events, {auth, after: -1, limit: 8}), {code: 'CURSOR_LIMIT'});
    assert.throws(() => projectOrigin(task, events, {auth, after: 0, limit: 0}), {code: 'CURSOR_LIMIT'});
    assert.throws(() => projectOrigin(task, events, {auth, after: 0, limit: 257}), {code: 'CURSOR_LIMIT'});

    const delivered = await service.collect(accepted.taskId, context);
    await service.acknowledge(accepted.taskId, context, delivered.digest);
    assert.equal(projectOrigin(store.get('tasks', accepted.taskId), events, {auth, after: 0, limit: 8}).agentConsumed, true, 'consumption comes from canonical state, not from the UI');
  });
});

// Workbook line 54: retries, duplicate submits, late results and cancel races obey one canonical
// terminal; an unknown state never auto-replays a side-effecting job.
test('728 duplicate submit, cancel and late results obey one canonical terminal', async () => {
  await withService(async ({service, store, context, authorize}) => {
    const tools = createEngineeringTools(service, {sessionId, deviceId, authorize});
    const capsule = {parentSessionId: sessionId, appId: 'cpu-sum', idempotencyKey: 'duplicate', input: {values: [1, 2]}};
    const first = await tools.submitRemoteJob(capsule);
    const replay = await tools.submitRemoteJob(capsule);
    assert.equal(replay.taskId, first.taskId, 'a retried submit replays the same canonical task');
    assert.equal(replay.replayed, true);
    assert.equal(store.list('tasks').length, 1);
    assert.equal(store.list('actions').length, 1);
    await assert.rejects(async () => tools.submitRemoteJob({...capsule, input: {values: [9, 9]}}), {code: 'IDEMPOTENCY_CONFLICT'}, 'the same key with different input cannot buy a second execution');

    const cancelled = await service.cancel(first.taskId, context);
    assert.equal(cancelled.state, 'CANCELLED');
    await service.start();
    await service.waitForIdle();
    assert.equal(store.get('tasks', first.taskId).state, 'CANCELLED', 'a cancelled task cannot later complete');
    assert.ok(terminal.includes(store.get('tasks', first.taskId).state));
    const again = await service.cancel(first.taskId, context);
    assert.equal(again.alreadyTerminal, true);
    assert.equal(again.state, 'CANCELLED');
    await assert.rejects(async () => tools.collectRemoteResult(first.taskId), {code: 'RESULT_NOT_READY'}, 'a cancelled job has no result to deliver');
  });

  await withCanonical(async ({owner, store, seed}) => {
    seed('T-terminal', 'X-terminal');
    const committed = commitResult(owner, {taskId: 'T-terminal', attemptId: 'X-terminal', epoch: 1, holder: 'holder', bootId: 'boot', outcome: 'SUCCEEDED', outputDigest: 'a'.repeat(64), now: 100});
    assert.equal(committed.committed, true);
    assert.equal(store.get('tasks', 'T-terminal').state, 'COMPLETED');
    assert.ok(terminal.includes(store.get('tasks', 'T-terminal').state));
    assert.throws(() => commitResult(owner, {taskId: 'T-terminal', attemptId: 'X-terminal', epoch: 1, holder: 'holder', bootId: 'boot', outcome: 'FAILED', now: 101}), {code: 'ATTEMPT_FENCED'}, 'a late second result cannot rewrite the terminal truth');
    assert.throws(() => commitResult(owner, {taskId: 'T-terminal', attemptId: 'X-terminal', epoch: 2, holder: 'holder', bootId: 'boot', outcome: 'SUCCEEDED', outputDigest: 'b'.repeat(64), now: 102}), {code: 'ATTEMPT_FENCED'}, 'a stale epoch writer is refused');
    assert.equal(store.get('tasks', 'T-terminal').state, 'COMPLETED');
    assert.equal(store.get('tasks', 'T-terminal').pcfResult.outputDigest, 'a'.repeat(64));

    seed('T-unknown', 'X-unknown');
    const unknown = commitResult(owner, {taskId: 'T-unknown', attemptId: 'X-unknown', epoch: 1, holder: 'holder', bootId: 'boot', outcome: 'UNKNOWN', outputDigest: null, now: 200});
    assert.equal(unknown.committed, false);
    assert.equal(unknown.attention, 'SIDE_EFFECT_UNKNOWN');
    const uncertain = store.get('tasks', 'T-unknown');
    assert.equal(uncertain.state, 'RUNNING', 'an unknown effect does not become a terminal success or failure');
    assert.equal(uncertain.pcfAttention, 'SIDE_EFFECT_UNKNOWN', 'the active risk stays visible on the canonical task');
    assert.equal(owner.snapshot().reservations.length, 1, 'the reservation is retained for reconciliation, not released for a replay');
    assert.deepEqual(planRecovery({taskId: 'T-unknown', retryClass: 'SIDE_EFFECT_UNKNOWN'}, {authorized: true, previousStopped: true, now: 0, cooldownUntil: 0}), {action: 'ATTENTION', reason: 'SIDE_EFFECT_OR_COMPATIBILITY_UNKNOWN', taskId: 'T-unknown'}, 'unknown effects are never auto-replayed');
    assert.equal(planRecovery({taskId: 'T-unknown', retryClass: 'NON_RETRYABLE'}, {authorized: true, previousStopped: true, now: 0, cooldownUntil: 0}).action, 'ATTENTION');
    assert.equal(planRecovery({taskId: 'T-unknown', retryClass: 'CHECKPOINTABLE'}, {authorized: true, previousStopped: true, now: 0, cooldownUntil: 0}).action, 'ATTENTION', 'an incompatible checkpoint is not restored');
    const proposed = planRecovery({taskId: 'T-pure', retryClass: 'PURE'}, {authorized: true, previousStopped: true, now: 0, cooldownUntil: 0});
    assert.equal(proposed.action, 'RETRY');
    assert.equal(proposed.newAttemptRequired, true, 'even a safe retry needs a new fenced attempt; nothing replays by itself');
    assert.equal(planRecovery({taskId: 'T-pure', retryClass: 'PURE'}, {authorized: false, previousStopped: true, now: 0}).reason, 'AUTHORITY_REQUIRED');
    assert.equal(planRecovery({taskId: 'T-pure', retryClass: 'PURE'}, {authorized: true, previousStopped: false, now: 0}).reason, 'OLD_HOLDER_STOP_NOT_PROVEN');
  });
});

// Workbook line 49 + line 56: the bridge binds every access to the originating session and device, and a
// wrong-session or unauthorized caller is refused with its own typed code.
test('728 the origin bridge binds every access to the originating session and device', async () => {
  await withService(async ({service, context, authorize}) => {
    // The canonical facade the bridge is allowed to use. The bridge owns the originDeviceId binding, so
    // the adapter drops that field before handing the request to the canonical owner, which does not
    // accept a caller-declared origin. `get` reads through the owner context so the bridge's own
    // session/device binding guard is the thing under test.
    const canonical = {
      submit: ({originDeviceId: _origin, ...spec}, caller) => service.submit(spec, caller),
      get: taskId => service.inspect(taskId, context),
      cancel: (taskId, caller) => service.cancel(taskId, caller),
      markConsumed: (taskId, caller, digest) => service.acknowledge(taskId, caller, digest),
    };
    assert.throws(() => createOriginAgentBridge({}, {authorize}), {code: 'CANONICAL_METHOD_submit'});
    assert.throws(() => createOriginAgentBridge(canonical, {}), {code: 'ORIGIN_AUTHORITY_REQUIRED'});
    const bridge = createOriginAgentBridge(canonical, {authorize});
    const accepted = await bridge.submitRemoteJob({parentSessionId: sessionId, originDeviceId: deviceId, appId: 'cpu-sum', idempotencyKey: 'bridge', input: {values: [1, 2]}}, context);
    assert.ok(accepted.taskId);
    await assert.rejects(async () => bridge.submitRemoteJob({parentSessionId: 'someone-else', originDeviceId: deviceId, appId: 'cpu-sum', idempotencyKey: 'bridge-2', input: {values: [1]}}, context), {code: 'SESSION_BINDING'});
    await assert.rejects(async () => bridge.inspect(accepted.taskId, {sessionId: 'other-session', deviceId}), {code: 'ORIGIN_UNAUTHORIZED'});
    await assert.rejects(async () => bridge.collect(accepted.taskId, context), {code: 'RESULT_NOT_READY'});
    await service.start();
    await service.waitForIdle();
    const collected = await bridge.collect(accepted.taskId, context);
    assert.equal(collected.delivered, true);
    assert.equal(collected.consumed, false);
    assert.equal(collected.result.outcome, 'SUCCEEDED');
    assert.match(collected.result.outputDigest, /^[a-f0-9]{64}$/, 'the bridge returns the canonical receipt describing the bytes');
    assert.equal(collected.result.outputRef.digest, collected.result.outputDigest);
    await assert.rejects(async () => bridge.acknowledge(accepted.taskId, context, 'f'.repeat(64)), {code: 'CONSUMPTION_DIGEST'});

    // Defence in depth: even a caller whose authority was granted cannot address somebody else's task.
    const permissive = createOriginAgentBridge(canonical, {authorize: async () => true});
    for (const foreign of [{sessionId: 'other-session', deviceId}, {sessionId, deviceId: 'other-host'}]) {
      await assert.rejects(async () => permissive.inspect(accepted.taskId, foreign), {code: 'SESSION_BINDING'});
      await assert.rejects(async () => permissive.cancel(accepted.taskId, foreign), {code: 'SESSION_BINDING'});
      await assert.rejects(async () => permissive.collect(accepted.taskId, foreign), {code: 'SESSION_BINDING'});
      await assert.rejects(async () => permissive.acknowledge(accepted.taskId, foreign, collected.result.outputDigest), {code: 'SESSION_BINDING'});
    }
  });
});

// Workbook line 52: reuse PCF-703's explicit DAG and EM-010; preserve fixed inputs, scopes, dependencies
// and join acceptance. Semantic decomposition stays the caller's job, and overlapping writes serialize or
// are refused - never raced.
test('728 the caller reuses the explicit 703 DAG with scopes, dependencies and join acceptance', async () => {
  const stage = (id, dependsOn, writeScope) => ({id, dependsOn, writeScope, inputSchema: 'cpu-json-v1', outputSchema: 'cpu-json-v1', resources: {cpu: {amount: 1, unit: 'millicores'}}, permissions: ['process:own-child'], sideEffects: 'NONE', deadlineAt: null, checkpoint: {resumable: false, capabilityRef: null}, placement: {strategy: 'FIXED'}, executor: {providerRef: 'pcf-fixed-cpu-v1', providerVersion: 1}});
  const plan = compileExecutionPlan({version: 2, stages: [stage('sort', [], ['attempt/src']), stage('sum', ['sort'], ['attempt/src']), stage('report', [], ['attempt/other'])]});
  assert.equal(plan.selfDescribing, true);
  assert.equal(plan.declaration, 'SELF_DESCRIBING_V2');
  assert.deepEqual(stageOrder(plan).map(entry => entry.id), ['sort', 'sum', 'report'], 'the order is declared, not generated');
  assert.deepEqual(plan.stages[1].dependsOn, ['sort'], 'dependencies and input revisions are preserved');
  assert.deepEqual(plan.stages[1].writeScope, ['attempt/src']);

  // Two independent stages that share a write scope have no order, so they are refused instead of raced.
  assert.throws(() => compileExecutionPlan({version: 2, stages: [stage('a', [], ['attempt/src']), stage('b', [], ['attempt/src'])]}), {code: 'PARALLEL_WRITE_CONFLICT'});
  assert.throws(() => compileExecutionPlan({version: 2, stages: [stage('a', ['b'], []), stage('b', ['a'], [])]}), {code: 'DAG_CYCLE_OR_MISSING'});
  assert.throws(() => compileExecutionPlan({version: 2, stages: [stage('a', [], []), {...stage('b', ['a'], []), goal: 'decompose the task for me'}]}), {code: 'STAGE_UNKNOWN_FIELD:goal'}, 'a plan cannot smuggle an undeclared field into execution');
  // A legacy plan stays labelled as not self-describing, and the canonical runner refuses it outright.
  const legacy = compileExecutionPlan({version: 1, stages: [{id: 'a', dependsOn: [], writeScope: []}]});
  assert.equal(legacy.selfDescribing, false);
  assert.equal(legacy.declaration, 'LEGACY_V1_NOT_SELF_DESCRIBING');
  assert.equal(legacy.notSelfDescribing[0].missing.length, 9);
  await assert.rejects(async () => executeStages({plan: {version: 1, stages: [{id: 'a', dependsOn: [], writeScope: []}]}}), {code: 'PLAN_NOT_SELF_DESCRIBING'});
});

// Workbook line 54: output is data, not an instruction, and a result grants no merge, credential or
// budget authority.
test('728 a returned result is inert data and grants no merge, credential or budget authority', async () => {
  await withService(async ({service, store, context, authorize}) => {
    const tools = createEngineeringTools(service, {sessionId, deviceId, authorize});
    const accepted = await tools.submitRemoteJob({parentSessionId: sessionId, appId: 'cpu-sort', idempotencyKey: 'data', input: {values: [3, 1, 2]}});
    await service.start();
    await service.waitForIdle();
    const delivered = await tools.collectRemoteResult(accepted.taskId);
    assert.equal(typeof delivered.output, 'object');
    assert.deepEqual(Object.keys(delivered.output).sort(), ['values'], 'the payload is the application data, nothing else');
    for (const forbidden of ['merge', 'mergeAuthority', 'overwrite', 'credentials', 'credentialGrant', 'budget', 'budgetAuthority', 'authorize', 'command', 'script', 'shell']) {
      assert.equal(Object.hasOwn(delivered, forbidden), false, 'a result carries no ' + forbidden);
      assert.equal(Object.hasOwn(delivered.output, forbidden), false, 'the payload carries no ' + forbidden);
    }

    // The returned value is a copy: mutating it changes nothing canonical.
    delivered.output.values.push(99);
    assert.deepEqual((await tools.collectRemoteResult(accepted.taskId)).output, {values: [1, 2, 3]}, 'the canonical result is unaffected by a caller mutating its copy');
    assert.equal(store.get('tasks', accepted.taskId).pcfResult.outputDigest, delivered.digest);

    // A capsule cannot smuggle authority in either: the canonical owner accepts only its own fields.
    await assert.rejects(async () => tools.submitRemoteJob({parentSessionId: sessionId, appId: 'cpu-sum', idempotencyKey: 'grant-1', input: {values: [1]}, mergeAuthority: true}), {code: 'APP_UNSUPPORTED'});
    await assert.rejects(async () => tools.submitRemoteJob({parentSessionId: sessionId, appId: 'cpu-sum', idempotencyKey: 'grant-2', input: {values: [1]}, credentialGrant: 'token'}), {code: 'APP_UNSUPPORTED'});
    for (const appId of ['merge', 'shell', 'credentials', 'budget']) {
      await assert.rejects(async () => tools.submitRemoteJob({parentSessionId: sessionId, appId, idempotencyKey: 'grant-' + appId, input: {values: [1]}}), {code: 'APP_UNSUPPORTED'});
    }
  });
});
