// MON-903 on a REAL gateway: a canonical failure becomes a bounded decision receipt with provenance, ordinary activity
// stays out of the decision path, the submit surface is owner-only, and no decision can change what the City executes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const headers = token => ({Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const ask = async (app, path, body, token = 'owner') => {
  const response = await fetch(app.url + '/api/v0/' + path, {method: body ? 'POST' : 'GET', headers: headers(token), body: body ? JSON.stringify(body) : undefined});
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return {status: response.status, body: parsed};
};
const withCity = async (fn, options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'mon903-route-'));
  let app = null;
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true, ...options});
    return await fn(app, dir);
  } finally { await app?.close(); await rm(dir, {recursive: true, force: true}); }
};
const registerWorker = (app, id) => ask(app, 'node/register', {id, displayName: id, metadata: {platform: 'reference'}, capabilities: ['task.execute.safe', 'filesystem.temp']}, 'node');
/** Drive one task to a terminal state through the canonical routes, exactly as a real endpoint does. */
const runTask = async (app, nodeId, {fail = false} = {}) => {
  const task = (await ask(app, 'tasks', {type: 'WAIT'})).body;
  assert.equal((await ask(app, 'node/claim', {id: nodeId}, 'node')).status, 200);
  await ask(app, 'node/report', {id: nodeId, taskId: task.id, state: 'RUNNING', progress: 40}, 'node');
  const terminal = await ask(app, 'node/report', {id: nodeId, taskId: task.id, state: fail ? 'FAILED' : 'COMPLETED', progress: 100, ...(fail ? {error: 'endpoint reported a refusal'} : {result: {ok: true}})}, 'node');
  assert.equal(terminal.status, 200);
  return task;
};
const decisionsFor = app => app.decisions.snapshot(50).decisions;
const settle = async app => { for (let attempt = 0; attempt < 200; attempt += 1) { if (app.decisions.metrics().concurrentDecisionTasks === 0 && decisionsFor(app).length > 0) return; await sleep(5); } };

test('MON903 route: a canonical failure becomes a decision receipt with canonical provenance, and the task itself is untouched', async () => {
  await withCity(async app => {
    await registerWorker(app, 'node-a');
    await ask(app, 'node/heartbeat', {id: 'node-a'}, 'node');
    const before = app.store.list('tasks').length;
    const task = await runTask(app, 'node-a', {fail: true});
    await settle(app);
    const decisions = decisionsFor(app);
    assert.equal(decisions.length, 1, 'exactly one decision came out of one failure');
    const [decision] = decisions;
    assert.equal(decision.triggerEvent.kind, 'FAILED');
    assert.equal(decision.triggerEvent.origin, 'CANONICAL_EVENT');
    assert.equal(decision.taskRef, task.id);
    assert.equal(decision.preState, 'FAILED');
    assert.equal(decision.postState, 'FAILED');
    assert.equal(decision.source, 'RULE');
    assert.equal(decision.action, 'RETRY_RECOMMENDED');
    assert.equal(decision.ownerRequired, false);
    assert.equal(decision.appliedBy, null, 'a decision is never reported as a performed action');
    // The evidence pointer names the CANONICAL event, so the provenance chain is answerable from the City's own log.
    assert.equal(decision.evidenceRefs.length, 1);
    const canonical = app.store.events().find(event => event.id === decision.evidenceRefs[0].canonicalEventId);
    assert.ok(canonical, 'the cited canonical event exists');
    assert.equal(canonical.type, 'TASK_FAILED');
    assert.equal(canonical.taskId, task.id);
    assert.equal(decision.evidenceRefs[0].seq, canonical.seq);
    // The decision changed nothing: same task count, same terminal state, no retry was created and no task was rewritten.
    assert.equal(app.store.list('tasks').length, before + 1);
    assert.equal(app.store.get('tasks', task.id).state, 'FAILED');
    assert.equal(app.store.get('tasks', task.id).error, 'endpoint reported a refusal');
    assert.equal(decisions.some(row => row.action === 'RETRY_RECOMMENDED' && row.application !== 'RECORDED_ONLY'), false);
    // It is persisted, listed by the route, and readable by id.
    const listed = await ask(app, 'monitor/decisions');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.window.decisions.length, 1);
    assert.equal(listed.body.metrics.decisions, 1);
    assert.equal(listed.body.metrics.autoResolutionRate, 1);
    assert.equal(listed.body.metrics.unrelatedTaskBlocking, 'ABSENT_BY_CONSTRUCTION');
    assert.equal(listed.body.metrics.autoResolved, 1);
    // The wire envelope keeps its own schema version: the decision window is nested precisely so its own
    // `schemaVersion` cannot overwrite the protocol's - a collision this task's browser probe found.
    assert.equal(listed.body.schemaVersion, 0);
    assert.equal(listed.body.apiVersion, 0);
    assert.equal(listed.body.window.schemaVersion, 1);
    const one = await ask(app, 'monitor/decisions/' + decision.decisionId);
    assert.equal(one.status, 200);
    assert.equal(one.body.decision.decisionId, decision.decisionId);
  });
});

test('MON903 route: ordinary City activity produces no decisions at all', async () => {
  await withCity(async app => {
    await registerWorker(app, 'node-a');
    await ask(app, 'node/heartbeat', {id: 'node-a'}, 'node');
    await ask(app, 'node/heartbeat', {id: 'node-a'}, 'node');
    await runTask(app, 'node-a');                          // claim + RUNNING + COMPLETED
    await ask(app, 'node/descriptor', {id: 'node-a'}, 'node');
    await sleep(60);
    assert.equal(decisionsFor(app).length, 0, 'heartbeats, progress, completion and descriptors are not decisions');
    const monitor = (await ask(app, 'monitor')).body.monitor;
    assert.deepEqual(monitor.decision, [], 'the projection reports an empty decision window, not a fabricated one');
  });
});

test('MON903 route: reading is authenticated, asking for a decision is the owner\'s, and refusals are typed', async () => {
  await withCity(async app => {
    await registerWorker(app, 'node-a');
    assert.equal((await ask(app, 'monitor/decisions', undefined, 'node')).status, 401, 'a node credential is not a City credential');
    assert.equal((await fetch(app.url + '/api/v0/monitor/decisions')).status, 401, 'no credential is refused');
    const enrollment = (await ask(app, 'device/enroll', {displayName: 'Member'})).body;
    const session = (await ask(app, 'device/session', {installationId: enrollment.installation.installationId, instanceId: enrollment.installation.instanceId, ...enrollment.credential})).body.credential;
    assert.equal((await ask(app, 'monitor/decisions', undefined, session)).status, 200, 'a member may READ what the City decided');
    const asMember = await ask(app, 'monitor/decisions', {kind: 'SCOPE_CHANGE', taskRef: 'task-x'}, session);
    assert.equal(asMember.status, 403);
    assert.equal(asMember.body.errorCode, 'MONITOR_OWNER_REQUIRED');
    // An unknown kind and an unknown id are typed refusals, not 500s.
    assert.equal((await ask(app, 'monitor/decisions', {kind: 'MAKE_COFFEE'})).body.errorCode, 'DECISION_TRIGGER_INVALID');
    assert.equal((await ask(app, 'monitor/decisions/decision-00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await ask(app, 'monitor/decisions/not-an-id')).body.errorCode, 'DECISION_NOT_FOUND');
  });
});

test('MON903 route: an explicitly submitted owner-boundary trigger is recorded as owner-required and applied by nobody', async () => {
  await withCity(async app => {
    await registerWorker(app, 'node-a');
    await ask(app, 'node/heartbeat', {id: 'node-a'}, 'node');
    const task = await runTask(app, 'node-a');
    const submitted = await ask(app, 'monitor/decisions', {kind: 'SCOPE_CHANGE', taskRef: task.id, reason: 'the workbook grew a second deliverable'});
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.submitted.queued, true);
    await settle(app);
    const [decision] = decisionsFor(app);
    assert.equal(decision.triggerEvent.kind, 'SCOPE_CHANGE');
    assert.equal(decision.triggerEvent.origin, 'SUBMITTED');
    assert.equal(decision.ownerRequired, true);
    assert.equal(decision.escalationTarget, 'OWNER');
    assert.equal(decision.escalationReason, 'OWNER_BOUNDARY_KIND');
    assert.equal(decision.action, 'OWNER_REQUIRED');
    assert.equal(decision.appliedBy, null);
    // The submission itself is in the canonical event log, so "who asked" is answerable there.
    assert.ok(app.store.events().some(event => event.type === 'MONITOR_DECISION_REQUESTED'));
    // A failing decision path must not have changed the task that was already complete.
    assert.equal(app.store.get('tasks', task.id).state, 'COMPLETED');
  });
});

test('MON903 route: a decision for one task never blocks another task, and the projection carries both', async () => {
  await withCity(async app => {
    await registerWorker(app, 'node-a');
    await registerWorker(app, 'node-b');
    await ask(app, 'node/heartbeat', {id: 'node-a'}, 'node');
    await ask(app, 'node/heartbeat', {id: 'node-b'}, 'node');
    // A failing task's decision and an unrelated task's completion are independent: both are driven at the same time
    // and neither waits for the other.
    const failing = runTask(app, 'node-a', {fail: true});
    const healthy = runTask(app, 'node-b');
    const [failedTask, healthyTask] = await Promise.all([failing, healthy]);
    await sleep(80);
    assert.equal(app.store.get('tasks', healthyTask.id).state, 'COMPLETED', 'the unrelated task finished normally');
    assert.equal(app.store.get('tasks', failedTask.id).state, 'FAILED');
    assert.ok(decisionsFor(app).some(row => row.taskRef === failedTask.id), 'the failing task produced its decision');
    assert.equal(decisionsFor(app).some(row => row.taskRef === healthyTask.id), false, 'the healthy task produced no decision');
    const monitor = (await ask(app, 'monitor')).body.monitor;
    assert.equal(monitor.decision.length, decisionsFor(app).length, 'the projection carries exactly the recorded decisions');
    assert.equal(monitor.authoritative, false, 'the projection is still explicitly non-authoritative');
    assert.equal(monitor.unsupportedSources.includes('Owner escalation'), false, 'owner escalation is now an observed source');
  });
});
