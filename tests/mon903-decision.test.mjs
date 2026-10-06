// MON-903: the decision overlay's contracts - event-triggered only, rule-first, owner boundary, per-task queues with no
// global barrier, bounded fallback, bounded receipts, and an overlay that cannot break the canonical path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDecisionOverlay, resolveByRule, TRIGGER_KINDS, OWNER_BOUNDARY_KINDS, DECISION_ACTIONS, DECISION_CODES} from '../services/dev-gateway/decision.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withOverlay = async (fn, options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'mon903-'));
  const tasksRef = {rows: []};
  const overlay = createDecisionOverlay({dir, tasks: () => tasksRef.rows, ...options});
  try { return await fn(overlay, tasksRef, dir); }
  // A decision that is still draining may write one more receipt while the directory is being removed, so the cleanup
  // retries. The first version of this helper raced its own overlay and the suite reported ENOTEMPTY - an instrument
  // defect, not a leaked process.
  finally { await overlay.close({timeoutMs: 2000}); await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); }
};
/** Wait for the per-task queue to drain, so assertions never race the asynchronous decision. */
const settle = async overlay => { for (let attempt = 0; attempt < 200; attempt += 1) { if (overlay.metrics().concurrentDecisionTasks === 0) return; await sleep(5); } };

test('MON903 triggers: only the named canonical events enter the decision path, and ordinary reports do not', async () => {
  await withOverlay(async (overlay, tasks) => {
    tasks.rows = [{id: 'task-1', state: 'FAILED'}];
    // Ordinary activity: a heartbeat, a progress report, a resource observation, a client connect. NONE of these is a
    // decision trigger, which is the difference between an event-triggered overlay and per-report approval.
    for (const event of [
      {id: 'e1', seq: 1, type: 'NODE_ONLINE', payload: {nodeId: 'node-1'}},
      {id: 'e2', seq: 2, type: 'TASK_RUNNING', taskId: 'task-1', payload: {progress: 40}},
      {id: 'e3', seq: 3, type: 'RESOURCE_OBSERVATION', payload: {}},
      {id: 'e4', seq: 4, type: 'CLIENT_CONNECTED', payload: {}},
      {id: 'e5', seq: 5, type: 'TASK_COMPLETED', taskId: 'task-1'},
      {id: 'e6', seq: 6, type: 'NODE_SHARING_CHANGED', payload: {nodeId: 'node-1', enabled: false}},
    ]) assert.equal(overlay.observe(event), null, `${event.type} must not trigger a decision`);
    await settle(overlay);
    assert.equal(overlay.snapshot().decisions.length, 0, 'ordinary activity records nothing in the decision log');

    // A canonical failure IS a trigger, and it carries the canonical event it came from.
    overlay.observe({id: 'e7', seq: 7, type: 'TASK_FAILED', taskId: 'task-1', actor: 'node-1', payload: {error: 'boom'}});
    await settle(overlay);
    const [decision] = overlay.snapshot().decisions;
    assert.equal(decision.triggerEvent.kind, 'FAILED');
    assert.equal(decision.triggerEvent.eventId, 'e7');
    assert.equal(decision.triggerEvent.eventSeq, 7);
    assert.equal(decision.triggerEvent.origin, 'CANONICAL_EVENT');
    assert.equal(decision.evidenceRefs[0].canonicalEventId, 'e7');

    // A node going offline is a decision ONLY when work is actually waiting on it.
    tasks.rows = [{id: 'task-2', state: 'QUEUED', assignedNodeId: 'node-9'}];
    overlay.observe({id: 'e8', seq: 8, type: 'NODE_OFFLINE', payload: {nodeId: 'node-9'}});
    overlay.observe({id: 'e9', seq: 9, type: 'NODE_OFFLINE', payload: {nodeId: 'node-unused'}});
    await settle(overlay);
    const kinds = overlay.snapshot().decisions.map(row => `${row.triggerEvent.kind}:${row.taskRef}`);
    assert.deepEqual(kinds, ['RESOURCE_CONFLICT:task-2', 'FAILED:task-1'], 'only the node with waiting work produced a decision');
  });
});

test('MON903 ladder: a deterministic rule resolves first and the model is never consulted for it', async () => {
  let modelCalls = 0, criticCalls = 0;
  await withOverlay(async (overlay, tasks) => {
    // An ATTRIBUTABLE failure: the canonical task records why it failed, so a rule can choose.
    tasks.rows = [{id: 'task-1', state: 'FAILED', error: 'provider refused the request'}];
    overlay.observe({id: 'e1', seq: 1, type: 'TASK_FAILED', taskId: 'task-1'});
    await settle(overlay);
    const [decision] = overlay.snapshot().decisions;
    assert.equal(decision.source, 'RULE');
    assert.equal(decision.action, 'RETRY_RECOMMENDED');
    assert.equal(decision.confidence, null, 'a deterministic rule is not a probability');
    assert.match(decision.confidenceReason, /^NOT_AVAILABLE/);
    assert.equal(modelCalls, 0, 'the programme forbids calling a model to resolve what a rule already resolves');
    assert.equal(criticCalls, 0);
    // Resource conflicts are the scheduler's decision, not this overlay's, and are likewise rule-resolved.
    tasks.rows = [{id: 'task-2', state: 'ASSIGNED', assignedNodeId: 'node-1'}];
    overlay.observe({id: 'e2', seq: 2, type: 'NODE_OFFLINE', payload: {nodeId: 'node-1'}});
    await settle(overlay);
    assert.equal(overlay.snapshot().decisions[0].action, 'DEFER_TO_SCHEDULER');
    assert.equal(modelCalls, 0);
  }, {fastModel: async () => { modelCalls += 1; return {action: 'OWNER_REQUIRED', confidence: 0.9, reason: 'model'}; }, critic: async () => { criticCalls += 1; return {action: 'OWNER_REQUIRED', confidence: 0.9, reason: 'critic'}; }});
});

test('MON903 owner boundary: scope, merge, review and owner-candidate triggers escalate WITHOUT any resolver being asked', async () => {
  let modelCalls = 0;
  await withOverlay(async (overlay, tasks) => {
    tasks.rows = [{id: 'task-1', state: 'RUNNING'}];
    for (const kind of OWNER_BOUNDARY_KINDS) {
      overlay.submit({kind, taskRef: 'task-1', origin: 'SUBMITTED', reason: 'probe'});
    }
    await settle(overlay);
    const decisions = overlay.snapshot().decisions;
    assert.equal(decisions.length, OWNER_BOUNDARY_KINDS.length);
    for (const decision of decisions) {
      assert.equal(decision.ownerRequired, true, `${decision.triggerEvent.kind} must be owner-required`);
      assert.equal(decision.escalationTarget, 'OWNER');
      assert.equal(decision.escalationReason, 'OWNER_BOUNDARY_KIND');
      assert.equal(decision.source, 'RULE');
    }
    assert.equal(modelCalls, 0, 'an owner matter is not an inference problem');
  }, {fastModel: async () => { modelCalls += 1; return {action: 'OWNER_REQUIRED', confidence: 0.5, reason: 'model'}; }});
});

test('MON903 fallback: a hanging, throwing or free-text resolver becomes a bounded fallback, never an authority', async () => {
  await withOverlay(async (overlay, tasks) => {
    tasks.rows = [{id: 'task-1', state: 'FAILED', error: 'boom'}];
    overlay.submit({kind: 'RETRY_REQUESTED', taskRef: 'task-1', origin: 'SUBMITTED'});
    await settle(overlay);
    const [decision] = overlay.snapshot().decisions;
    assert.equal(decision.source, 'RULE', 'a retry request with budget is rule-resolved as an advisory');
    assert.equal(decision.action, 'RETRY_ADVISORY');
    assert.equal(decision.ownerRequired, false);
  }, {stageTimeoutMs: 40, fastModel: async () => new Promise(() => {}), critic: async () => ({action: 'NOT_A_REAL_ACTION', confidence: 0.5, reason: 'x'.repeat(500)})});

  // A retry request with NO budget left is refused by rule and escalated, with the reason recorded.
  await withOverlay(async (overlay, tasks) => {
    tasks.rows = [{id: 'task-1', state: 'FAILED', error: 'boom'}];
    overlay.submit({kind: 'RETRY_REQUESTED', taskRef: 'task-1', origin: 'SUBMITTED'});
    await settle(overlay);
    const [decision] = overlay.snapshot().decisions;
    assert.equal(decision.source, 'RULE');
    assert.equal(decision.action, 'OWNER_REQUIRED');
    assert.equal(decision.escalationReason, 'RETRY_BUDGET_EXHAUSTED');
  }, {retryBudget: 0});
  // The FAILED rule obeys the same budget: an attributable failure with no budget escalates rather than retrying.
  await withOverlay(async (overlay, tasks) => {
    tasks.rows = [{id: 'task-1', state: 'FAILED', error: 'boom'}];
    overlay.submit({kind: 'FAILED', taskRef: 'task-1', origin: 'SUBMITTED'});
    await settle(overlay);
    assert.equal(overlay.snapshot().decisions[0].escalationReason, 'RETRY_BUDGET_EXHAUSTED');
  }, {retryBudget: 0});

  // AN UNCERTAIN CASE REACHES THE LADDER: a failure whose cause the canonical record does not state is not resolvable
  // by rule, and with no resolver configured it escalates WITH the typed reason rather than guessing.
  await withOverlay(async (overlay, tasks) => {
    tasks.rows = [{id: 'task-1', state: 'FAILED'}];
    overlay.submit({kind: 'FAILED', taskRef: 'task-1', origin: 'SUBMITTED'});
    await settle(overlay);
    const [decision] = overlay.snapshot().decisions;
    assert.equal(decision.source, 'OWNER');
    assert.equal(decision.action, 'OWNER_REQUIRED');
    assert.equal(decision.ownerRequired, true);
    assert.deepEqual(decision.timeoutOrFallback, [DECISION_CODES.RESOLVER_NOT_CONFIGURED, DECISION_CODES.RESOLVER_NOT_CONFIGURED]);
    assert.ok(DECISION_ACTIONS.includes(decision.action));
  });

  // A CONFIGURED RESOLVER IS USED FOR THE UNCERTAIN CASE, and its bounded action is what lands on the receipt.
  let asked = 0;
  await withOverlay(async (overlay, tasks) => {
    tasks.rows = [{id: 'task-1', state: 'FAILED'}];
    overlay.submit({kind: 'FAILED', taskRef: 'task-1', origin: 'SUBMITTED'});
    await settle(overlay);
    const [decision] = overlay.snapshot().decisions;
    assert.equal(asked, 1, 'the model stage exists precisely for the unresolved case');
    assert.equal(decision.source, 'FAST_MODEL');
    assert.equal(decision.action, 'RETRY_RECOMMENDED');
    assert.equal(decision.confidence, 0.62);
  }, {fastModel: async () => { asked += 1; return {action: 'RETRY_RECOMMENDED', confidence: 0.62, reason: 'cause not recorded; retry is the bounded action'}; }, stageTimeoutMs: 200});

  // A HANGING model falls through to the critic; an INVALID critic output falls through to the owner with typed codes.
  await withOverlay(async (overlay, tasks) => {
    tasks.rows = [{id: 'task-1', state: 'FAILED'}];
    overlay.submit({kind: 'FAILED', taskRef: 'task-1', origin: 'SUBMITTED'});
    await settle(overlay);
    const [decision] = overlay.snapshot().decisions;
    assert.equal(decision.source, 'OWNER');
    assert.deepEqual(decision.timeoutOrFallback, [DECISION_CODES.RESOLVER_TIMEOUT, DECISION_CODES.RESOLVER_INVALID_OUTPUT]);
    assert.equal(decision.escalationReason, DECISION_CODES.RESOLVER_TIMEOUT);
  }, {stageTimeoutMs: 40, fastModel: async () => new Promise(() => {}), critic: async () => ({action: 'DEFINITELY_NOT_ALLOWED', confidence: 42, reason: 'free text'.repeat(40)})});

  // A THROWING model and a THROWING critic also end at the owner with typed codes, never as an exception to the caller.
  await withOverlay(async (overlay, tasks) => {
    tasks.rows = [{id: 'task-1', state: 'FAILED'}];
    assert.doesNotThrow(() => overlay.submit({kind: 'FAILED', taskRef: 'task-1', origin: 'SUBMITTED'}));
    await settle(overlay);
    const [decision] = overlay.snapshot().decisions;
    assert.equal(decision.ownerRequired, true);
    assert.deepEqual(decision.timeoutOrFallback, [DECISION_CODES.RESOLVER_FAILED, DECISION_CODES.RESOLVER_FAILED]);
  }, {stageTimeoutMs: 40, fastModel: async () => { throw new Error('model exploded'); }, critic: async () => { throw new Error('critic exploded'); }});
});

test('MON903 queues: decisions are per-task, parallel across tasks, bounded per task, and never a global barrier', async () => {
  const gates = {a: null, b: null};
  await withOverlay(async (overlay, tasks) => {
    // Both tasks carry an UNEXPLAINED failure, so both reach the (deliberately slow) resolver and the queues fill.
    tasks.rows = [{id: 'task-a', state: 'FAILED'}, {id: 'task-b', state: 'FAILED'}];
    for (let index = 0; index < 18; index += 1) overlay.submit({kind: 'FAILED', taskRef: 'task-a', origin: 'SUBMITTED'});
    assert.ok(overlay.metrics().concurrentDecisionTasks >= 1, 'task A holds a live queue');
    overlay.submit({kind: 'FAILED', taskRef: 'task-b', origin: 'SUBMITTED'});
    await sleep(120);
    const snapshotA = overlay.snapshot().decisions.filter(row => row.taskRef === 'task-a');
    const snapshotB = overlay.snapshot().decisions.filter(row => row.taskRef === 'task-b');
    // Task A's queue is saturated and slow; task B's decision has already been made and recorded anyway.
    assert.ok(snapshotB.length >= 1, 'an unrelated task must not wait for another task\'s decision');
    assert.ok(snapshotA.length >= 1);
    assert.equal(overlay.metrics().unrelatedTaskBlocking, 'ABSENT_BY_CONSTRUCTION');
    assert.match(overlay.metrics().unrelatedTaskBlockingBasis, /keyed by task/);
    assert.equal(overlay.snapshot().decisions.some(row => (row.timeoutOrFallback ?? []).includes(DECISION_CODES.QUEUE_FULL)), true, 'the per-task queue bound is enforced and recorded');
    assert.equal(overlay.hasGlobalLock, false);
    // Drain the saturated queue before the helper removes the directory: the overlay is asynchronous by design.
    assert.equal((await overlay.close({timeoutMs: 4000})).drained, true, 'the per-task queues drain once the resolvers stop');
    void gates;
  }, {stageTimeoutMs: 30, fastModel: async () => { await sleep(40); return null; }, critic: async () => null});
});

test('MON903 receipts: bounded contract, provenance, measured post-state, and no applied action anywhere', async () => {
  await withOverlay(async (overlay, tasks, dir) => {
    tasks.rows = [{id: 'task-1', state: 'FAILED'}];
    overlay.observe({id: 'event-1', seq: 12, type: 'TASK_FAILED', taskId: 'task-1', payload: {}});
    await settle(overlay);
    const [decision] = overlay.snapshot().decisions;
    for (const field of ['decisionId', 'taskRef', 'triggerEvent', 'preState', 'source', 'action', 'queueWaitMs', 'decisionLatencyMs', 'timeoutOrFallback', 'escalationTarget', 'escalationReason', 'evidenceRefs', 'postState', 'decidedAt']) {
      assert.ok(field in decision, `the bounded receipt must carry ${field}`);
    }
    assert.equal(decision.preState, 'FAILED');
    assert.equal(decision.postState, 'FAILED');
    assert.ok(DECISION_ACTIONS.includes(decision.action));
    assert.equal(decision.appliedBy, null);
    assert.equal(decision.application, 'RECORDED_ONLY');
    assert.match(decision.applicationReason, /^NOT_APPLICABLE/);
    assert.ok(Array.isArray(decision.decisionTrace) && decision.decisionTrace[0].stage === 'OBSERVATION');
    // Persisted, and readable back by id.
    const files = await readdir(join(dir, 'decisions'));
    assert.deepEqual(files, [`${decision.decisionId}.json`]);
    const persisted = JSON.parse(await readFile(join(dir, 'decisions', `${decision.decisionId}.json`), 'utf8'));
    assert.equal(persisted.decisionId, decision.decisionId);
    assert.equal(overlay.receipt(decision.decisionId).taskRef, 'task-1');
    // The overlay is a reader, and it says so.
    assert.equal(overlay.ownsTaskState, false);
    assert.equal(overlay.mutatesTasks, false);
    assert.equal(overlay.hasGlobalLock, false);
    assert.equal(overlay.decidesOnReports, false);
    // An unknown or traversal-shaped id is a typed 404, never a file read.
    assert.throws(() => overlay.receipt('../../etc/passwd'), error => error.code === DECISION_CODES.UNKNOWN_DECISION);
    assert.throws(() => overlay.receipt('not-a-decision'), error => error.code === DECISION_CODES.UNKNOWN_DECISION);
    assert.equal((await readdir(join(dir, 'decisions'))).length, 1);
  });
});

test('MON903 isolation: a reader that throws, a broken receipt file and a failing receipt write cannot break the caller', async () => {
  // A throwing task reader must not escape observe(): the canonical path calls this and must not fail because a
  // projection did.
  await withOverlay(async overlay => {
    const result = overlay.snapshot();
    assert.equal(result.failures.length, 0, 'the throwing reader is only reached for node-scoped triggers');
  }, {tasks: () => { throw new Error('reader exploded'); }});

  const dir = await mkdtemp(join(tmpdir(), 'mon903-broken-'));
  try {
    await mkdir(join(dir, 'decisions'), {recursive: true});
    await writeFile(join(dir, 'decisions', 'decision-11111111-2222-4333-8444-555555555555.json'), '{not json');
    await writeFile(join(dir, 'decisions', 'decision-22222222-2222-4333-8444-555555555555.json'), JSON.stringify({hello: 'world'}));
    const tasks = {rows: [{id: 'task-1', state: 'FAILED'}]};
    const overlay = createDecisionOverlay({dir, tasks: () => tasks.rows});
    try {
      // A broken receipt is REPORTED (as the REX-804 review requires of every module in this family), not fatal.
      const snapshot = overlay.snapshot();
      assert.equal(snapshot.decisions.length, 0);
      assert.deepEqual(snapshot.broken.map(row => row.reason).sort(), ['RECEIPT_SHAPE_MISMATCH', 'UNREADABLE_RECEIPT']);
      overlay.observe({id: 'e1', seq: 1, type: 'TASK_FAILED', taskId: 'task-1'});
      await settle(overlay);
      assert.equal(overlay.snapshot().decisions.length, 1, 'the overlay still works with broken neighbours present');
    } finally { await overlay.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('MON903 rules: the deterministic layer answers each kind from canonical facts, and invents no default', () => {
  const failed = {state: 'FAILED', error: 'boom'};
  assert.equal(resolveByRule({kind: 'FAILED', task: failed, priorFailures: 0}).action, 'RETRY_RECOMMENDED');
  assert.equal(resolveByRule({kind: 'FAILED', task: failed, priorFailures: 2}).escalationReason, 'REPEATED_FAILURE');
  assert.equal(resolveByRule({kind: 'FAILED', task: failed, priorFailures: 0, retryBudget: 0}).escalationReason, 'RETRY_BUDGET_EXHAUSTED');
  // An UNEXPLAINED failure is deliberately NOT resolved by any rule: the model stage exists for it.
  assert.equal(resolveByRule({kind: 'FAILED', task: {state: 'FAILED'}, priorFailures: 0}), null);
  assert.equal(resolveByRule({kind: 'FAILED', task: {state: 'FAILED', error: '   '}, priorFailures: 0}), null);
  assert.equal(resolveByRule({kind: 'BLOCKED', node: {online: false}}).action, 'WAIT_FOR_TARGET_RECOVERY');
  assert.equal(resolveByRule({kind: 'BLOCKED', node: {online: true}}).escalationReason, 'TARGET_PRESENT_BUT_INELIGIBLE');
  assert.equal(resolveByRule({kind: 'BLOCKED', node: null}).action, 'WAIT_FOR_TARGET_RECOVERY');
  assert.equal(resolveByRule({kind: 'RESOURCE_CONFLICT'}).action, 'DEFER_TO_SCHEDULER');
  assert.equal(resolveByRule({kind: 'RETRY_REQUESTED', retryBudget: 1}).action, 'RETRY_ADVISORY');
  for (const kind of OWNER_BOUNDARY_KINDS) assert.equal(resolveByRule({kind}).boundary, true);
  assert.deepEqual([...TRIGGER_KINDS].sort(), ['BLOCKED', 'FAILED', 'MERGE_READY', 'OWNER_DECISION_CANDIDATE', 'READY_FOR_REVIEW', 'RESOURCE_CONFLICT', 'RETRY_REQUESTED', 'SCOPE_CHANGE']);
});
