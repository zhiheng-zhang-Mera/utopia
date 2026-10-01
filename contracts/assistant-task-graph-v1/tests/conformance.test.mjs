// Conformance tests for BA-006 — authoritative task graph + ownership/executor separation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskGraph, TaskGraphError, isIsoInstant } from '../index.mjs';

const NOW = '2026-01-01T00:00:00Z';
const graphAt = (instant = NOW) => createTaskGraph({ now: () => instant });

const baseTask = (overrides = {}) => ({
  task_id: 'task-1',
  scope: 'GLOBAL',
  scope_ref: null,
  requester_ref: 'user:owner-1',
  owner_ref: 'assistant:butler-a',
  ...overrides,
});

const acceptedHandoff = (overrides = {}) => ({
  contract_version: 1,
  handoff_id: 'handoff-1',
  task_ref: 'task-1',
  task_version: 1,
  kind: 'RESPONSIBILITY_TRANSFER',
  from: { assistant_ref: 'assistant:butler-a', device_ref: 'device:alpha' },
  to: { assistant_ref: 'assistant:butler-b', device_ref: null },
  reason: 'butler-b takes over coordination',
  checkpoint_ref: 'checkpoint:7',
  evidence_refs: ['evidence:1'],
  commitments: [],
  blocker_refs: [],
  executor_ref: null,
  lease_ref: null,
  required_capabilities: [],
  audience_scope: 'user:owner-1',
  created_at: NOW,
  state: 'ACCEPTED',
  ...overrides,
});

const expectCode = (code, fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TaskGraphError, `expected TaskGraphError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
};

test('one authoritative task is shared by every embodiment — never duplicated per device', () => {
  const graph = graphAt();
  const created = graph.createTask(baseTask({ checkpoint_ref: 'checkpoint:1' }));
  assert.equal(created.task_version, 1);
  assert.equal(created.owner_ref, 'assistant:butler-a');
  assert.equal(created.requester_ref, 'user:owner-1');
  assert.equal(created.executor_ref, null, 'ownership is created without an executor');
  assert.equal(created.lease, null);
  assert.equal(created.causal_log.length, 1);
  assert.equal(created.causal_log[0].kind, 'TASK_CREATED');
  assert.equal(created.causal_log[0].seq, 1);
  assert.equal(created.causal_log[0].from_version, 0);
  assert.equal(created.causal_log[0].to_version, 1);

  graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:butler-a' });
  graph.bindForeground({ device_ref: 'device:beta', assistant_ref: 'assistant:butler-a' });
  const alpha = graph.projectFor({ device_ref: 'device:alpha' });
  const beta = graph.projectFor({ device_ref: 'device:beta' });
  assert.equal(alpha.projection_count, 1);
  assert.equal(beta.projection_count, 1);
  assert.equal(alpha.projections[0].task_id, beta.projections[0].task_id, 'both devices see the same authoritative task');
  assert.equal(alpha.projections[0].task_version, beta.projections[0].task_version);
  assert.equal(alpha.projections[0].owner_ref, beta.projections[0].owner_ref);
  assert.equal(alpha.projections[0].session_is_owner, false);
  assert.equal(alpha.local_copy_is_cache, true);
  assert.equal(graph.taskCount(), 1, 'two embodiments did not create a second task');
  assert.equal(alpha.projections[0].foreground_assistant_ref, 'assistant:butler-a');

  // A device may not fork its own copy of an existing task id.
  const duplicate = expectCode('DUPLICATE_TASK', () => graph.createTask(baseTask()));
  assert.equal(duplicate.current_version, 1);

  // A stale local copy is detectable, and projections are frozen.
  const stale = graph.projectFor({ device_ref: 'device:alpha', cached_version: 0 });
  assert.equal(stale.projections[0].stale, true);
  assert.equal(graph.projectFor({ device_ref: 'device:alpha', cached_version: 1 }).projections[0].stale, false);
  assert.throws(() => { stale.projections[0].state = 'SUCCEEDED'; }, TypeError);
  assert.equal(graph.projectFor({ device_ref: 'device:unknown' }).projection_count, 1, 'global truth is readable from any embodiment');
  assert.equal(graph.projectFor({ device_ref: 'device:unknown' }).foreground_assistant_ref, null);
});

test('ownership is logical, execution is physical — sessions and devices are never the owner', () => {
  const graph = graphAt();
  expectCode('SESSION_IS_NOT_OWNER', () => graph.createTask(baseTask({ owner_ref: 'session:abc' })));
  expectCode('SESSION_IS_NOT_OWNER', () => graph.createTask(baseTask({ owner_ref: 'foreground:ui-1' })));
  expectCode('DEVICE_IS_NOT_OWNER', () => graph.createTask(baseTask({ owner_ref: 'device:alpha' })));
  expectCode('SESSION_IS_NOT_OWNER', () => graph.createTask(baseTask({ requester_ref: 'session:abc' })));
  expectCode('SESSION_IS_NOT_OWNER', () => graph.createTask(baseTask({ watchers: ['session:abc'] })));
  expectCode('INVALID_TASK', () => graph.createTask(baseTask({ scope: 'DEVICE', scope_ref: null })));
  expectCode('INVALID_TASK', () => graph.createTask(baseTask({ scope_ref: 'workspace:1' })), 'GLOBAL takes no scope_ref');
  expectCode('INVALID_TASK', () => graph.createTask(baseTask({ owner: 'assistant:butler-a' })), 'unknown keys are rejected');

  const task = graph.createTask(baseTask({ side_effect: 'EXCLUSIVE' }));
  assert.equal(task.side_effect, 'EXCLUSIVE');
  expectCode('SESSION_IS_NOT_EXECUTOR', () => graph.changeExecutor({ task_id: 'task-1', expected_version: task.task_version, executor_ref: 'session:abc', actor_ref: 'assistant:butler-a', action_key: 'action-1' }));
  expectCode('EXECUTOR_IS_NOT_A_DEVICE', () => graph.changeExecutor({ task_id: 'task-1', expected_version: task.task_version, executor_ref: 'assistant:butler-a', actor_ref: 'assistant:butler-a', action_key: 'action-1' }));
  expectCode('ACTION_KEY_REQUIRED', () => graph.changeExecutor({ task_id: 'task-1', expected_version: task.task_version, executor_ref: 'device:alpha', actor_ref: 'assistant:butler-a' }));
  assert.equal(graph.getTask('task-9'), null, 'an unknown task is a typed absence, not a throw');

  // Scopes: a DEVICE-scoped task is visible only where the scope says so, plus direct participation.
  const scoped = graph.createTask(baseTask({ task_id: 'task-dev', scope: 'DEVICE', scope_ref: 'device:beta', requester_ref: 'assistant:butler-a' }));
  assert.equal(scoped.scope_ref, 'device:beta');
  graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:butler-a' });
  graph.bindForeground({ device_ref: 'device:beta', assistant_ref: 'assistant:butler-a' });
  const alphaIds = graph.projectFor({ device_ref: 'device:alpha' }).projections.map(view => view.task_id);
  const betaIds = graph.projectFor({ device_ref: 'device:beta' }).projections.map(view => view.task_id);
  assert.deepEqual(alphaIds, ['task-1'], 'a device-scoped task is not projected onto another device');
  assert.deepEqual(betaIds, ['task-1', 'task-dev']);
  assert.deepEqual(graph.projectFor({ device_ref: 'device:beta' }).projections.find(view => view.task_id === 'task-dev').visible_because, ['DEVICE_SCOPE']);
});

test('mutations are versioned and typed, and conflicting updates keep a causal audit trail', () => {
  const graph = graphAt();
  graph.createTask(baseTask());
  const updated = graph.updateTask({ task_id: 'task-1', expected_version: 1, role: 'OWNER', actor_ref: 'assistant:butler-a', patch: { state: 'RUNNING', checkpoint_ref: 'checkpoint:2' } });
  assert.equal(updated.task_version, 2);
  assert.equal(updated.state, 'RUNNING');
  assert.equal(updated.causal_log.length, 2);
  assert.equal(updated.causal_log[1].kind, 'TASK_UPDATED');
  assert.equal(updated.causal_log[1].seq, 2);
  assert.equal(updated.causal_log[1].from_version, 1);
  assert.equal(updated.causal_log[1].to_version, 2);
  assert.equal(updated.causal_log[1].actor_ref, 'assistant:butler-a');

  // A stale (or absent) expected_version is refused with the current truth, never last-writer-wins.
  const conflict = expectCode('TASK_VERSION_CONFLICT', () => graph.updateTask({ task_id: 'task-1', expected_version: 1, role: 'OWNER', actor_ref: 'assistant:butler-a', patch: { state: 'BLOCKED' } }));
  assert.equal(conflict.current_version, 2);
  assert.equal(conflict.current_state, 'RUNNING');
  assert.equal(conflict.status, 409);
  expectCode('TASK_VERSION_CONFLICT', () => graph.updateTask({ task_id: 'task-1', role: 'OWNER', actor_ref: 'assistant:butler-a', patch: { state: 'BLOCKED' } }));
  // The refused update left no partial state and no causal entry.
  const after = graph.getTask('task-1');
  assert.equal(after.task_version, 2);
  assert.equal(after.state, 'RUNNING');
  assert.equal(after.causal_log.length, 2);

  // Role separation: a watcher may not mutate; ownership/executor fields need an explicit operation.
  expectCode('ROLE_NOT_PERMITTED', () => graph.updateTask({ task_id: 'task-1', expected_version: 2, role: 'WATCHER', actor_ref: 'device:alpha', patch: { state: 'BLOCKED' } }));
  expectCode('EXPLICIT_OPERATION_REQUIRED', () => graph.updateTask({ task_id: 'task-1', expected_version: 2, role: 'OWNER', actor_ref: 'assistant:butler-a', patch: { owner_ref: 'assistant:butler-b' } }));
  expectCode('EXPLICIT_OPERATION_REQUIRED', () => graph.updateTask({ task_id: 'task-1', expected_version: 2, role: 'SYSTEM', actor_ref: 'assistant:butler-a', patch: { executor_ref: 'device:alpha' } }));
  expectCode('INVALID_TASK', () => graph.updateTask({ task_id: 'task-1', expected_version: 2, role: 'OWNER', actor_ref: 'assistant:butler-a', patch: {} }));

  // Terminal truth is immutable.
  const done = graph.updateTask({ task_id: 'task-1', expected_version: 2, role: 'OWNER', actor_ref: 'assistant:butler-a', patch: { state: 'SUCCEEDED' } });
  assert.equal(done.state, 'SUCCEEDED');
  expectCode('TASK_TERMINAL', () => graph.updateTask({ task_id: 'task-1', expected_version: 3, role: 'OWNER', actor_ref: 'assistant:butler-a', patch: { state: 'RUNNING' } }));
  expectCode('UNKNOWN_TASK', () => graph.updateTask({ task_id: 'nope', expected_version: 1, role: 'OWNER', actor_ref: 'assistant:butler-a', patch: { state: 'RUNNING' } }));
});

test('foreground switching never changes owner, coordinator or executor', () => {
  const graph = graphAt();
  graph.createTask(baseTask());
  const executor = graph.changeExecutor({ task_id: 'task-1', expected_version: 1, executor_ref: 'device:alpha', actor_ref: 'assistant:butler-a' });
  assert.equal(executor.task.executor_ref, 'device:alpha');
  const before = graph.getTask('task-1');

  const first = graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:butler-a' });
  assert.equal(first.switched, false, 'the first binding is not a switch');
  assert.deepEqual(first.tasks_touched, []);
  const second = graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:butler-c' });
  assert.equal(second.switched, true);
  assert.equal(second.previous_foreground_assistant_ref, 'assistant:butler-a');
  assert.equal(second.ownership_changed, false);
  assert.equal(second.executor_changed, false);
  assert.deepEqual(second.role_changes, []);
  assert.equal(second.tasks_touched.length, 0, 'the switch touched no task');

  const after = graph.getTask('task-1');
  assert.equal(after.owner_ref, before.owner_ref, 'owner unchanged by the foreground switch');
  assert.equal(after.executor_ref, before.executor_ref, 'executor unchanged by the foreground switch');
  assert.equal(after.task_version, before.task_version, 'no task write happened at all');
  assert.equal(after.state, before.state);
  assert.equal(graph.taskCount(), 1);
});

test('ownership moves only through an explicit accepted handoff, and never restarts the executor', () => {
  const graph = graphAt();
  graph.createTask(baseTask());
  graph.changeExecutor({ task_id: 'task-1', expected_version: 1, executor_ref: 'device:alpha', actor_ref: 'assistant:butler-a' });
  const current = graph.getTask('task-1');

  // A plain foreground switch is not a handoff and moves nothing.
  graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:butler-b' });
  assert.equal(graph.getTask('task-1').owner_ref, 'assistant:butler-a');

  expectCode('HANDOFF_NOT_ACCEPTED', () => graph.transferOwnership({ task_id: 'task-1', expected_version: current.task_version }));
  expectCode('HANDOFF_NOT_ACCEPTED', () => graph.transferOwnership({ task_id: 'task-1', expected_version: current.task_version, handoff: acceptedHandoff({ state: 'PROPOSED', task_version: current.task_version }) }));
  expectCode('CONSULTATION_TRANSFERS_NOTHING', () => graph.transferOwnership({ task_id: 'task-1', expected_version: current.task_version, handoff: acceptedHandoff({ kind: 'CONSULTATION', task_version: current.task_version }) }));
  expectCode('HANDOFF_TASK_MISMATCH', () => graph.transferOwnership({ task_id: 'task-1', expected_version: current.task_version, handoff: acceptedHandoff({ task_ref: 'task-other', task_version: current.task_version }) }));
  expectCode('HANDOFF_STALE_VERSION', () => graph.transferOwnership({ task_id: 'task-1', expected_version: current.task_version, handoff: acceptedHandoff({ task_version: current.task_version - 1 }) }));
  expectCode('HANDOFF_TASK_MISMATCH', () => graph.transferOwnership({ task_id: 'task-1', expected_version: current.task_version, handoff: acceptedHandoff({ task_version: current.task_version, from: { assistant_ref: 'assistant:someone-else' } }) }));

  // A handoff that carries authority is refused outright — handoff transfers no authority.
  const withAuthority = expectCode('HANDOFF_TRANSFERS_NO_AUTHORITY', () => graph.transferOwnership({
    task_id: 'task-1',
    expected_version: current.task_version,
    handoff: acceptedHandoff({ task_version: current.task_version, required_capabilities: ['shell'] , grants: { shell: true } }),
  }));
  assert.ok(withAuthority.fields.some(field => field.endsWith('grants')));
  expectCode('SESSION_IS_NOT_OWNER', () => graph.transferOwnership({ task_id: 'task-1', expected_version: current.task_version, handoff: acceptedHandoff({ task_version: current.task_version, to: { assistant_ref: 'session:abc' } }) }));
  expectCode('DEVICE_IS_NOT_OWNER', () => graph.transferOwnership({ task_id: 'task-1', expected_version: current.task_version, handoff: acceptedHandoff({ task_version: current.task_version, to: { assistant_ref: 'device:alpha' } }) }));

  // Nothing above changed the task.
  assert.equal(graph.getTask('task-1').owner_ref, 'assistant:butler-a');

  const transferred = graph.transferOwnership({ task_id: 'task-1', expected_version: current.task_version, handoff: acceptedHandoff({ task_version: current.task_version }) });
  assert.equal(transferred.owner_ref, 'assistant:butler-b');
  assert.equal(transferred.previous_owner_ref, 'assistant:butler-a');
  assert.equal(transferred.executor_ref, 'device:alpha', 'execution continues on the same executor');
  assert.equal(transferred.executor_restarted, false, 'a handoff does not restart the executor');
  assert.equal(transferred.authority_transferred, false);
  assert.equal(transferred.task_version, current.task_version + 1);
  const log = transferred.task.causal_log.at(-1);
  assert.equal(log.kind, 'OWNERSHIP_TRANSFERRED');
  assert.equal(log.caused_by, 'handoff-1', 'the causal trail names the handoff that caused the change');
  assert.equal(log.actor_ref, 'assistant:butler-a');
  assert.equal(transferred.task.checkpoint_ref, 'checkpoint:7', 'the handoff checkpoint becomes the task checkpoint');
});

test('an exclusive side effect can never have two simultaneous valid executors', () => {
  const graph = graphAt();
  graph.createTask(baseTask({ side_effect: 'EXCLUSIVE' }));
  const assigned = graph.changeExecutor({ task_id: 'task-1', expected_version: 1, executor_ref: 'device:alpha', actor_ref: 'assistant:butler-a', action_key: 'action-1' });
  assert.equal(assigned.lease.lease_ref, 'lease:task-1#1');
  assert.equal(assigned.lease.lease_epoch, 1);
  assert.equal(assigned.lease.exclusive, true);
  assert.equal(assigned.concurrent_valid_executors, 1);
  assert.equal(assigned.task.lease.superseded_lease_refs.length, 0);

  // A second executor is refused while the first lease is live.
  const blocked = expectCode('EXECUTOR_ALREADY_BOUND', () => graph.changeExecutor({ task_id: 'task-1', expected_version: 2, executor_ref: 'device:beta', actor_ref: 'assistant:butler-a', action_key: 'action-1' }));
  assert.equal(blocked.current_executor_ref, 'device:alpha');
  assert.equal(blocked.current_lease_ref, 'lease:task-1#1');
  assert.equal(graph.getTask('task-1').executor_ref, 'device:alpha', 'the refused change left the single executor intact');

  // Take-over is explicit, names the exact lease, and supersedes it with a new epoch.
  expectCode('EXPECTED_LEASE_MISMATCH', () => graph.changeExecutor({ task_id: 'task-1', expected_version: 2, executor_ref: 'device:beta', actor_ref: 'assistant:butler-a', action_key: 'action-1', take_over: true, expected_lease_ref: 'lease:task-1#2' }));
  const takenOver = graph.changeExecutor({ task_id: 'task-1', expected_version: 2, executor_ref: 'device:beta', actor_ref: 'assistant:butler-a', action_key: 'action-1', take_over: true, expected_lease_ref: 'lease:task-1#1' });
  assert.equal(takenOver.lease.lease_epoch, 2);
  assert.equal(takenOver.superseded_lease_ref, 'lease:task-1#1');
  assert.equal(takenOver.previous_lease_revoked, true);
  assert.equal(takenOver.concurrent_valid_executors, 1);
  assert.deepEqual(takenOver.task.lease.superseded_lease_refs, ['lease:task-1#1']);
  assert.equal(takenOver.task.causal_log.at(-1).kind, 'EXECUTOR_SUPERSEDED');

  // The superseded executor can no longer act, and only the leased executor may submit.
  expectCode('NOT_THE_EXECUTOR', () => graph.submitExecutorResult({ task_id: 'task-1', expected_version: 3, actor_ref: 'device:alpha', lease_ref: 'lease:task-1#1', lease_epoch: 1, action_key: 'action-1', outcome: 'SUCCEEDED' }));
  expectCode('STALE_LEASE', () => graph.submitExecutorResult({ task_id: 'task-1', expected_version: 3, actor_ref: 'device:beta', lease_ref: 'lease:task-1#1', lease_epoch: 1, action_key: 'action-1', outcome: 'SUCCEEDED' }));
  expectCode('NOT_THE_EXECUTOR', () => graph.submitExecutorResult({ task_id: 'task-1', expected_version: 3, actor_ref: 'device:gamma', lease_ref: 'lease:task-1#2', lease_epoch: 2, action_key: 'action-1', outcome: 'SUCCEEDED' }));
  expectCode('INVALID_OUTCOME', () => graph.submitExecutorResult({ task_id: 'task-1', expected_version: 3, actor_ref: 'device:beta', lease_ref: 'lease:task-1#2', lease_epoch: 2, action_key: 'action-1', outcome: 'MAYBE' }));
  expectCode('ACTION_KEY_MISMATCH', () => graph.submitExecutorResult({ task_id: 'task-1', expected_version: 3, actor_ref: 'device:beta', lease_ref: 'lease:task-1#2', lease_epoch: 2, action_key: 'action-9', outcome: 'SUCCEEDED' }));

  const applied = graph.submitExecutorResult({ task_id: 'task-1', expected_version: 3, actor_ref: 'device:beta', lease_ref: 'lease:task-1#2', lease_epoch: 2, action_key: 'action-1', outcome: 'SUCCEEDED' });
  assert.equal(applied.applied_outcome, 'SUCCEEDED');
  assert.equal(applied.duplicate_side_effect, false);
  assert.deepEqual(applied.task.consumed_action_keys, ['action-1']);
  assert.equal(applied.task.executor_ref, 'device:beta');

  // Replaying the same action key is refused, so the side effect is never repeated.
  const replay = expectCode('DUPLICATE_ACTION_KEY', () => graph.submitExecutorResult({ task_id: 'task-1', expected_version: 4, actor_ref: 'device:beta', lease_ref: 'lease:task-1#2', lease_epoch: 2, action_key: 'action-1', outcome: 'SUCCEEDED' }));
  assert.equal(replay.status, 409);
  assert.equal(graph.getTask('task-1').state, 'SUCCEEDED');
});

test('device release suspends the lease, never orphans a task and never moves ownership', () => {
  const graph = graphAt();
  graph.createTask(baseTask());
  graph.createTask(baseTask({ task_id: 'task-dev', scope: 'DEVICE', scope_ref: 'device:alpha', requester_ref: 'assistant:butler-a' }));
  graph.changeExecutor({ task_id: 'task-1', expected_version: 1, executor_ref: 'device:alpha', actor_ref: 'assistant:butler-a' });
  graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:butler-a' });
  const before = graph.getTask('task-1');

  const released = graph.releaseDevice({ device_ref: 'device:alpha' });
  assert.deepEqual(released.orphaned_tasks, [], 'shutting a device down orphans no task');
  assert.deepEqual(released.ownership_changes, []);
  assert.deepEqual(released.retained_device_scoped_tasks, ['task-dev']);
  assert.deepEqual(released.suspended_lease_refs, ['lease:task-1#1']);
  assert.equal(released.released_foreground_assistant_ref, 'assistant:butler-a');

  const after = graph.getTask('task-1');
  assert.equal(after.owner_ref, before.owner_ref, 'ownership survives device shutdown');
  assert.equal(after.executor_ref, before.executor_ref);
  assert.equal(after.state, before.state);
  assert.equal(after.lease.suspended, true);
  assert.equal(after.causal_log.at(-1).kind, 'LEASE_SUSPENDED_BY_DEVICE_RELEASE');
  assert.equal(graph.taskCount(), 2, 'no task was deleted');
  assert.equal(graph.projectFor({ device_ref: 'device:alpha' }).foreground_assistant_ref, null, 'the released device keeps no foreground binding');
  assert.deepEqual(graph.projectFor({ device_ref: 'device:alpha' }).projections.map(view => view.task_id), ['task-1', 'task-dev'], 'scope-based visibility survives; the binding does not');

  // A released executor may not resume without revalidating authoritative state.
  expectCode('LEASE_SUSPENDED', () => graph.submitExecutorResult({ task_id: 'task-1', expected_version: 3, actor_ref: 'device:alpha', lease_ref: 'lease:task-1#1', lease_epoch: 1, outcome: 'SUCCEEDED' }));
  expectCode('STALE_LEASE', () => graph.revalidateLease({ task_id: 'task-1', lease_ref: 'lease:task-1#9', lease_epoch: 9, executor_ref: 'device:alpha' }));
  expectCode('NOT_THE_EXECUTOR', () => graph.revalidateLease({ task_id: 'task-1', lease_ref: 'lease:task-1#1', lease_epoch: 1, executor_ref: 'device:beta' }));
  const revalidated = graph.revalidateLease({ task_id: 'task-1', lease_ref: 'lease:task-1#1', lease_epoch: 1, executor_ref: 'device:alpha' });
  assert.equal(revalidated.revalidated, true);
  assert.equal(revalidated.task.lease.suspended, false);
  assert.equal(revalidated.task.causal_log.at(-1).kind, 'LEASE_REVALIDATED');

  // A reconnected device re-reads authoritative projections rather than trusting its local copy.
  graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:butler-a' });
  const refreshed = graph.projectFor({ device_ref: 'device:alpha', cached_version: 1 });
  assert.equal(refreshed.projection_count, 2);
  assert.equal(refreshed.projections[0].task_id, 'task-1');
  assert.equal(refreshed.projections[0].stale, true, 'a stale local copy is flagged rather than trusted');
  assert.equal(refreshed.projections[0].lease_suspended, false);
  assert.equal(refreshed.projections[0].role_of_device, 'EXECUTOR');
});

test('every contract surface is closed, frozen and free of ambient state', () => {
  const graph = graphAt();
  const task = graph.createTask(baseTask({ scope: 'ASSISTANT', scope_ref: 'assistant:butler-a' }));
  assert.throws(() => { task.state = 'RUNNING'; }, TypeError, 'records are frozen');
  assert.throws(() => { task.causal_log.push({ kind: 'FAKE' }); }, TypeError, 'the audit trail cannot be forged from outside');

  const second = graphAt();
  assert.equal(second.taskCount(), 0, 'graphs share no ambient state');
  expectCode('UNKNOWN_TASK', () => second.changeExecutor({ task_id: 'task-1', expected_version: 1, executor_ref: 'device:alpha', actor_ref: 'assistant:butler-a' }));

  // A workspace-scoped task is visible through the workspace binding, and to direct participants.
  graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:butler-a', workspace_refs: ['workspace:city'] });
  graph.bindForeground({ device_ref: 'device:beta', assistant_ref: 'assistant:butler-z', workspace_refs: [] });
  graph.createTask(baseTask({ task_id: 'task-ws', scope: 'WORKSPACE', scope_ref: 'workspace:city' }));
  assert.deepEqual(graph.projectFor({ device_ref: 'device:alpha' }).projections.map(view => view.task_id), ['task-1', 'task-ws']);
  assert.deepEqual(graph.projectFor({ device_ref: 'device:beta' }).projections.map(view => view.task_id), []);
  assert.throws(() => createTaskGraph({ now: 'not-a-function' }), error => error.code === 'INVALID_CLOCK');
  assert.equal(isIsoInstant('2026-01-01T00:00:00Z'), true);
});

// ---------------------------------------------------------------- Alien Correction regressions
// Every test below fails against the Development head and passes against the corrected head.

const T0_LOCAL = '2026-01-01T00:00:00Z';
const refuse = operation => {
  try { operation(); } catch (error) { return error; }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('the canonical contract allow-list is decided by own keys', () => {
  const graph = createTaskGraph({ now: () => T0_LOCAL });
  for (const key of ['toString', 'constructor', 'valueOf', '__proto__']) {
    assert.equal(refuse(() => graph.createTask({ ...baseTask({ task_id: `task:${key}` }), [key]: 'smuggled' })).code, 'INVALID_TASK', `${key} is not part of the canonical contract`);
  }
  assert.equal(graph.taskCount(), 0, 'nothing was admitted');
});

test('a hidden authority field in a handoff is found, and a cycle does not crash the scan', () => {
  const graph = createTaskGraph({ now: () => T0_LOCAL });
  const created = graph.createTask(baseTask({ task_id: 'task:1' }));
  const hidden = { kind: 'RESPONSIBILITY_TRANSFER', state: 'ACCEPTED', task_ref: 'task:1', task_version: created.task_version, to: { assistant_ref: 'assistant:beta' } };
  Object.defineProperty(hidden, 'grants', { value: ['camera'], enumerable: false });
  assert.equal(refuse(() => graph.transferOwnership({ task_id: 'task:1', expected_version: created.task_version, handoff: hidden })).code, 'HANDOFF_TRANSFERS_NO_AUTHORITY', 'a non-enumerable authority field is still authority');
  assert.equal(graph.getTask('task:1').owner_ref, created.owner_ref, 'the refused handoff moved no ownership');

  const cyclic = { kind: 'RESPONSIBILITY_TRANSFER', state: 'ACCEPTED', task_ref: 'task:1', task_version: created.task_version, to: { assistant_ref: 'assistant:beta' } };
  cyclic.self = cyclic;
  const moved = graph.transferOwnership({ task_id: 'task:1', expected_version: created.task_version, handoff: cyclic });
  assert.equal(moved.owner_ref, 'assistant:beta', 'a structural cycle is not authority');
});

test('a caller instant must be real, not merely well shaped', () => {
  const graph = createTaskGraph({ now: () => T0_LOCAL });
  for (const at of ['garbage', '2026-13-45T99:99:99Z', '2026-02-30T00:00:00Z', 123]) {
    assert.equal(refuse(() => graph.createTask(baseTask({ task_id: `task:${String(at)}`, at }))).code, 'INVALID_TASK', `at=${String(at)}`);
  }
  const created = graph.createTask(baseTask({ task_id: 'task:ok' }));
  assert.equal(refuse(() => graph.updateTask({ task_id: 'task:ok', expected_version: created.task_version, role: 'OWNER', actor_ref: 'assistant:alpha', patch: { state: 'RUNNING' }, at: 'garbage' })).code, 'INVALID_TASK');
  const badClock = createTaskGraph({ now: () => '2026-13-45T99:99:99Z' });
  assert.equal(refuse(() => badClock.createTask(baseTask({ task_id: 'task:clock' }))).code, 'INVALID_CLOCK', 'a shape-valid but impossible clock instant is refused too');
});

test('a refused patch changes nothing', () => {
  const graph = createTaskGraph({ now: () => T0_LOCAL });
  const created = graph.createTask(baseTask({ task_id: 'task:1' }));
  const refused = refuse(() => graph.updateTask({
    task_id: 'task:1', expected_version: created.task_version, role: 'OWNER', actor_ref: 'assistant:alpha',
    patch: { state: 'RUNNING', checkpoint_ref: 'checkpoint:1', watchers: ['session:ui'] },
  }));
  assert.equal(refused.code, 'SESSION_IS_NOT_OWNER');
  const after = graph.getTask('task:1');
  assert.equal(after.state, 'PENDING', 'the refused patch did not change the state');
  assert.equal(after.checkpoint_ref, null, 'nor the checkpoint');
  assert.equal(after.task_version, created.task_version, 'and the record was not audited');
});

test('a released executor must revalidate its lease instead of re-issuing it', () => {
  const graph = createTaskGraph({ now: () => T0_LOCAL });
  const created = graph.createTask(baseTask({ task_id: 'task:1', side_effect: 'EXCLUSIVE' }));
  const assigned = graph.changeExecutor({ task_id: 'task:1', expected_version: created.task_version, executor_ref: 'device:alpha', actor_ref: 'assistant:alpha', action_key: 'action-key:1' });
  graph.releaseDevice({ device_ref: 'device:alpha' });
  assert.equal(refuse(() => graph.submitExecutorResult({ task_id: 'task:1', expected_version: graph.getTask('task:1').task_version, actor_ref: 'device:alpha', lease_ref: assigned.lease.lease_ref, lease_epoch: assigned.lease.lease_epoch, action_key: 'action-key:1', outcome: 'SUCCEEDED' })).code, 'LEASE_SUSPENDED', 'submitting needs revalidation');
  assert.equal(refuse(() => graph.changeExecutor({ task_id: 'task:1', expected_version: graph.getTask('task:1').task_version, executor_ref: 'device:alpha', actor_ref: 'assistant:alpha', action_key: 'action-key:1' })).code, 'LEASE_SUSPENDED', 'nor may it re-issue its own lease');
  graph.revalidateLease({ task_id: 'task:1', lease_ref: assigned.lease.lease_ref, lease_epoch: assigned.lease.lease_epoch, executor_ref: 'device:alpha' });
  assert.equal(graph.submitExecutorResult({ task_id: 'task:1', expected_version: graph.getTask('task:1').task_version, actor_ref: 'device:alpha', lease_ref: assigned.lease.lease_ref, lease_epoch: assigned.lease.lease_epoch, action_key: 'action-key:1', outcome: 'SUCCEEDED' }).applied_outcome, 'SUCCEEDED');
});

test('an exclusive side effect cannot complete without a lease', () => {
  const graph = createTaskGraph({ now: () => T0_LOCAL });
  assert.equal(refuse(() => graph.createTask(baseTask({ task_id: 'task:born', side_effect: 'EXCLUSIVE', state: 'SUCCEEDED' }))).code, 'EXPLICIT_OPERATION_REQUIRED', 'an exclusive task cannot be born terminal');
  const created = graph.createTask(baseTask({ task_id: 'task:1', side_effect: 'EXCLUSIVE' }));
  assert.equal(refuse(() => graph.updateTask({ task_id: 'task:1', expected_version: created.task_version, role: 'OWNER', actor_ref: 'assistant:alpha', patch: { state: 'SUCCEEDED' } })).code, 'EXPLICIT_OPERATION_REQUIRED', 'the guarded path is the only completion route');
  assert.equal(graph.getTask('task:1').state, 'PENDING');
  const plain = graph.createTask(baseTask({ task_id: 'task:plain' }));
  assert.equal(graph.updateTask({ task_id: 'task:plain', expected_version: plain.task_version, role: 'OWNER', actor_ref: 'assistant:alpha', patch: { state: 'SUCCEEDED' } }).state, 'SUCCEEDED', 'a task with no externally visible side effect may still be completed by its owner');
});

test('a refused foreground change leaves the binding untouched', () => {
  const graph = createTaskGraph({ now: () => T0_LOCAL });
  graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:butler-a' });
  assert.equal(refuse(() => graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:attacker', at: 'garbage' })).code, 'INVALID_TASK');
  assert.equal(graph.projectFor({ device_ref: 'device:alpha' }).foreground_assistant_ref, 'assistant:butler-a', 'the refused bind changed nothing');
  assert.equal(refuse(() => graph.bindForeground({ device_ref: 'device:alpha', assistant_ref: 'assistant:attacker', workspace_refs: 'workspace:city' })).code, 'INVALID_TASK', 'a workspace set must be an array of text');
  assert.equal(graph.projectFor({ device_ref: 'device:alpha' }).foreground_assistant_ref, 'assistant:butler-a');
  assert.equal(refuse(() => graph.releaseDevice({ device_ref: 'device:alpha', at: 'garbage' })).code, 'INVALID_TASK');
  assert.equal(graph.projectFor({ device_ref: 'device:alpha' }).foreground_assistant_ref, 'assistant:butler-a', 'the refused release changed nothing');
});

test('a device release never rewrites a settled task, and a handoff checkpoint is text', () => {
  const graph = createTaskGraph({ now: () => T0_LOCAL });
  const created = graph.createTask(baseTask({ task_id: 'task:1', side_effect: 'EXCLUSIVE' }));
  const assigned = graph.changeExecutor({ task_id: 'task:1', expected_version: created.task_version, executor_ref: 'device:alpha', actor_ref: 'assistant:alpha', action_key: 'k' });
  const done = graph.submitExecutorResult({ task_id: 'task:1', expected_version: assigned.task.task_version, actor_ref: 'device:alpha', lease_ref: assigned.lease.lease_ref, lease_epoch: assigned.lease.lease_epoch, action_key: 'k', outcome: 'SUCCEEDED' });
  const before = done.task.task_version;
  graph.releaseDevice({ device_ref: 'device:alpha' });
  const after = graph.getTask('task:1');
  assert.equal(after.task_version, before, 'a settled task is not re-versioned by a release');
  assert.equal(after.causal_log.filter(entry => entry.kind === 'LEASE_SUSPENDED_BY_DEVICE_RELEASE').length, 0, 'nor audited');

  const other = createTaskGraph({ now: () => T0_LOCAL });
  const target = other.createTask(baseTask({ task_id: 'task:2' }));
  const handoff = { kind: 'RESPONSIBILITY_TRANSFER', state: 'ACCEPTED', task_ref: 'task:2', task_version: target.task_version, to: { assistant_ref: 'assistant:beta' }, checkpoint_ref: { evil: 'object' } };
  assert.equal(refuse(() => other.transferOwnership({ task_id: 'task:2', expected_version: target.task_version, handoff })).code, 'HANDOFF_NOT_ACCEPTED');
  assert.equal(other.getTask('task:2').owner_ref, target.owner_ref, 'the refused handoff moved no ownership');
});
