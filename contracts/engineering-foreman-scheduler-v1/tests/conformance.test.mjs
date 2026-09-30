// Conformance tests for EM-010 闂?foreman queue / DAG / resource scheduling / worker pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_MODES, ForemanError, NODE_STATES, PLACEMENTS, createForemanScheduler, scopesOverlap,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const AT = ms => new Date(Date.parse(T0) + ms).toISOString();

function schedulerAt(policy = {}) {
  const state = { ms: 0 };
  const clock = () => AT(state.ms);
  clock.advance = ms => { state.ms += ms; return clock(); };
  const scheduler = createForemanScheduler({ localDeviceRef: 'device:local', clock, policy });
  scheduler.registerWorker({ worker_ref: 'worker:local', device_ref: 'device:local', capabilities: ['BUILD', 'TEST'], max_concurrent: 4 });
  scheduler.registerWorker({ worker_ref: 'worker:remote', device_ref: 'device:remote', capabilities: ['BUILD'], max_concurrent: 4 });
  return { scheduler, clock };
}

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof ForemanError, `expected a ForemanError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

const graph = (nodes, overrides = {}) => ({ graph_ref: 'graph:1', task_ref: 'task:1', nodes, ...overrides });

const node = (overrides = {}) => ({ node_id: 'a', capability_required: 'BUILD', ...overrides });

test('a DAG is validated and only dependency-satisfied work is runnable', () => {
  const { scheduler } = schedulerAt();
  assert.deepEqual([...NODE_STATES], ['PENDING', 'BLOCKED_ON_DEPS', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'INTERRUPTED', 'CANCELLED']);
  assert.deepEqual([...RUN_MODES], ['SERIAL', 'PARALLEL']);
  assert.deepEqual([...PLACEMENTS], ['LOCAL_FIRST', 'REMOTE_ALLOWED']);

  const submitted = scheduler.submitGraph(graph([
    node({ node_id: 'a' }),
    node({ node_id: 'd' }),
    node({ node_id: 'b', depends_on: ['a'] }),
    node({ node_id: 'c', depends_on: ['b'] }),
  ]));
  assert.equal(submitted.node_count, 4);
  assert.equal(submitted.dependency_satisfied_only, true);
  assert.equal(submitted.owns_task_truth, false, 'the scheduler references Shared Task Core truth, it does not own it');
  assert.equal(submitted.overrides_task_core_authority, false);
  assert.equal(scheduler.node('a').state, 'READY');
  assert.equal(scheduler.node('b').state, 'BLOCKED_ON_DEPS');

  // Independent nodes may run concurrently; dependents cannot start early.
  const first = scheduler.schedule();
  assert.deepEqual([...first.runnable].sort(), ['a', 'd'], 'two dependency-free nodes are admitted together');
  assert.equal(failure(() => scheduler.dispatch({ node_id: 'b' })).code, 'DEPENDENCY_NOT_SATISFIED');
  const dispatchedA = scheduler.dispatch({ node_id: 'a' });
  assert.equal(dispatchedA.state, 'RUNNING');
  const dispatchedD = scheduler.dispatch({ node_id: 'd' });
  assert.equal(dispatchedD.state, 'RUNNING');
  assert.equal(scheduler.metrics().by_state.RUNNING, 2, 'independent nodes really do run at the same time');

  // A dependency-gated node becomes runnable only when its dependency succeeded.
  const completedA = scheduler.completeAttempt({ attempt_ref: dispatchedA.attempt_ref, outcome: 'SUCCEEDED', result_ref: 'result:a' });
  assert.equal(completedA.state, 'SUCCEEDED');
  const second = scheduler.schedule();
  assert.deepEqual([...second.runnable], ['b'], 'only the next link of the chain is admitted');
  assert.equal(scheduler.node('c').state, 'BLOCKED_ON_DEPS', 'the grandchild still waits');

  // A failed dependency blocks its dependents rather than running them.
  const dispatchedB = scheduler.dispatch({ node_id: 'b' });
  scheduler.completeAttempt({ attempt_ref: dispatchedB.attempt_ref, outcome: 'FAILED', error: { code: 'COMPILE_ERROR' } });
  const third = scheduler.schedule();
  assert.equal(third.blocked.some(entry => entry.reason === 'DEPENDENCY_FAILED'), true);
  assert.equal(scheduler.node('c').state, 'BLOCKED');
  assert.equal(scheduler.completeAttempt({ attempt_ref: dispatchedD.attempt_ref, outcome: 'SUCCEEDED' }).state, 'SUCCEEDED', 'an unrelated node is unaffected by the failure');

  // Malformed graphs are refused with distinct codes.
  assert.equal(failure(() => scheduler.submitGraph(graph([node({ node_id: 'x', depends_on: ['nope'] })]))).code, 'UNKNOWN_DEPENDENCY');
  assert.equal(failure(() => scheduler.submitGraph(graph([node({ node_id: 'x' }), node({ node_id: 'x' })]))).code, 'DUPLICATE_NODE');
  assert.equal(failure(() => scheduler.submitGraph(graph([node({ node_id: 'x', depends_on: ['y'] }), node({ node_id: 'y', depends_on: ['x'] })]))).code, 'DAG_CYCLE');
  assert.equal(failure(() => scheduler.submitGraph(graph([node({ node_id: 'x', depends_on: ['x'] })]))).code, 'DAG_CYCLE');
  assert.equal(failure(() => scheduler.submitGraph(graph([node({ node_id: 'x', nickname: 'n' })]))).code, 'INVALID_GRAPH');
  assert.equal(failure(() => scheduler.submitGraph({ graph_ref: 'g', nodes: [] })).code, 'INVALID_GRAPH');
  assert.equal(failure(() => scheduler.submitGraph(graph([node({ node_id: 'x' })], { graph_ref: '' }))).code, 'INVALID_GRAPH');
});

test('two writers cannot hold the same protected scope at once, and conflicts are reported not merged', () => {
  const { scheduler } = schedulerAt();
  assert.equal(scopesOverlap('scope:src/core', 'scope:src/core'), true);
  assert.equal(scopesOverlap('scope:src/', 'scope:src/core/file.ts'), true, 'a directory scope protects everything beneath it');
  assert.equal(scopesOverlap('scope:src/core', 'scope:src/other'), false);
  assert.equal(scopesOverlap('file:a.ts', 'scope:a.ts'), false, 'different scope kinds do not overlap');
  assert.equal(scopesOverlap(null, 'scope:a'), false);

  scheduler.submitGraph(graph([
    node({ node_id: 'w1', write_scope: 'scope:src/core', exclusive_writes: true }),
    node({ node_id: 'w2', write_scope: 'scope:src/core/file.ts', exclusive_writes: true }),
    node({ node_id: 'w3', write_scope: 'scope:tests/', exclusive_writes: true }),
  ]));
  const first = scheduler.dispatch({ node_id: 'w1' });
  assert.equal(first.state, 'RUNNING');

  const conflict = failure(() => scheduler.dispatch({ node_id: 'w2' }));
  assert.equal(conflict.code, 'WRITE_CONFLICT');
  assert.equal(conflict.auto_merged, false, 'an unsafe overlap is never auto-merged');
  assert.equal(conflict.deferred, true);
  assert.equal(conflict.conflicts[0].node_id, 'w1');
  assert.equal(scheduler.node('w2').state, 'READY', 'the conflicting node is deferred, not failed');

  // A disjoint scope may proceed at the same time.
  assert.equal(scheduler.dispatch({ node_id: 'w3' }).state, 'RUNNING');
  const scheduled = scheduler.schedule();
  assert.equal(scheduled.write_conflicts_auto_merged, 0);
  assert.equal(scheduled.blocked.some(entry => entry.node_id === 'w2' && entry.reason === 'WRITE_CONFLICT'), true);

  // Once the writer finishes, the deferred node may run.
  scheduler.completeAttempt({ attempt_ref: first.attempt_ref, outcome: 'SUCCEEDED' });
  assert.equal(scheduler.schedule().runnable.includes('w2'), true);
  assert.equal(scheduler.metrics().write_conflicts_auto_merged, 0);
});

test('resource pressure scales workers down and pauses new work without failing completed work', () => {
  const { scheduler } = schedulerAt({ max_workers: 4, min_workers: 1, scale_up_after_ticks: 2, pressure_pause_threshold: 0.9 });
  scheduler.submitGraph(graph([
    node({ node_id: 'a' }),
    node({ node_id: 'b' }),
    node({ node_id: 'c' }),
  ]));
  scheduler.dispatch({ node_id: 'a' });
  scheduler.completeAttempt({ attempt_ref: 'attempt:a:1', outcome: 'SUCCEEDED', result_ref: 'result:a' });
  assert.equal(scheduler.runMode(), 'PARALLEL');
  assert.equal(scheduler.workerTarget(), 4);

  // High pressure pauses new work immediately.
  const pressured = scheduler.observeResources({ pressure: 0.95, queue_depth: 2 });
  assert.equal(pressured.paused, true);
  assert.equal(pressured.worker_target, 0, 'a paused scheduler admits no workers');
  assert.equal(pressured.new_work_admitted, false);
  assert.equal(pressured.scales_down_immediately, true);
  assert.deepEqual(pressured.completed_work_failed_by_pressure, [], 'completed work is never failed by pressure');
  assert.equal(scheduler.node('a').state, 'SUCCEEDED');
  assert.equal(scheduler.runMode(), 'SERIAL');
  assert.equal(failure(() => scheduler.dispatch({ node_id: 'b' })).code, 'PAUSED_BY_RESOURCE_PRESSURE');
  assert.equal(scheduler.schedule().paused, true);
  assert.equal(scheduler.metrics().completed_work_falsely_failed.length, 0);

  // Relief scales back up only after sustained ticks (hysteresis).
  const mid = scheduler.observeResources({ pressure: 0.5 });
  assert.equal(mid.paused, false);
  assert.equal(mid.raw_target, 2);
  assert.equal(mid.relief_ticks, 0);
  const relief1 = scheduler.observeResources({ pressure: 0.1 });
  assert.equal(relief1.target_changed, false, 'one quiet tick does not scale all the way up');
  assert.equal(relief1.relief_ticks, 1);
  const relief2 = scheduler.observeResources({ pressure: 0.1 });
  assert.equal(relief2.target_changed, true);
  assert.equal(relief2.worker_target, 4);
  assert.equal(failure(() => scheduler.observeResources({ pressure: 2 })).code, 'INVALID_REQUEST');
});

test('one-worker serial mode uses the same lifecycle and acceptance path', () => {
  const { scheduler } = schedulerAt({ max_workers: 1, min_workers: 1 });
  scheduler.submitGraph(graph([
    node({ node_id: 'a', acceptance: ['tests/unit.test.mjs'] }),
    node({ node_id: 'b', depends_on: ['a'] }),
  ]));
  assert.equal(scheduler.runMode(), 'SERIAL');
  const first = scheduler.schedule();
  assert.deepEqual(first.runnable, ['a'], 'serial mode admits one node on the same code path');
  assert.equal(first.run_mode, 'SERIAL');

  const dispatched = scheduler.dispatch({ node_id: 'a' });
  // The same acceptance requirement applies in serial mode.
  assert.equal(failure(() => scheduler.completeAttempt({ attempt_ref: dispatched.attempt_ref, outcome: 'SUCCEEDED' })).code, 'ACCEPTANCE_NOT_RUN');
  const completed = scheduler.completeAttempt({ attempt_ref: dispatched.attempt_ref, outcome: 'SUCCEEDED', result_ref: 'result:a', acceptance_ref: 'acceptance:a' });
  assert.equal(completed.state, 'SUCCEEDED');
  assert.equal(completed.acceptance_evidence_present, true);
  const second = scheduler.schedule();
  assert.deepEqual(second.runnable, ['b'], 'the dependent is admitted next on the identical path');
  assert.equal(scheduler.dispatch({ node_id: 'b' }).state, 'RUNNING');
  assert.equal(scheduler.node('a').result_ref, 'result:a');
});

test('bounded retry and reassignment never duplicate a terminal result or an external effect', () => {
  const { scheduler } = schedulerAt({ max_attempts: 2 });
  scheduler.submitGraph(graph([
    node({ node_id: 'a', max_attempts: 2, action_key: 'effect:1' }),
    node({ node_id: 'b', capability_required: 'TEST' }),
  ]));

  const first = scheduler.dispatch({ node_id: 'a' });
  const stalled = scheduler.reportSignal({ node_id: 'a', kind: 'STALL' });
  assert.equal(stalled.retry_allowed, true);
  assert.equal(stalled.bounded, true);
  assert.equal(stalled.attempts_remaining, 1);
  assert.equal(scheduler.node('a').state, 'READY');

  // Reassignment picks a capable worker and never repeats a completed effect.
  const reassigned = scheduler.reassign({ node_id: 'a', reason: 'WORKER_LOST' });
  assert.equal(reassigned.reassigned, true);
  assert.equal(reassigned.attempt_number, 2);
  assert.equal(reassigned.worker_ref, 'worker:local', 'only a worker advertising the required capability is chosen');
  const completed = scheduler.completeAttempt({ attempt_ref: reassigned.attempt_ref, outcome: 'SUCCEEDED', result_ref: 'result:a' });
  assert.equal(completed.result_ref, 'result:a');

  // A terminal node refuses a second result and any further dispatch.
  const duplicate = failure(() => scheduler.completeAttempt({ attempt_ref: reassigned.attempt_ref, outcome: 'SUCCEEDED', result_ref: 'result:other' }));
  assert.equal(duplicate.code, 'DUPLICATE_TERMINAL_RESULT');
  assert.equal(duplicate.executed, false);
  assert.equal(failure(() => scheduler.dispatch({ node_id: 'a' })).code, 'TERMINAL_RESULT_IMMUTABLE');
  assert.equal(failure(() => scheduler.reassign({ node_id: 'a' })).code, 'TERMINAL_RESULT_IMMUTABLE');

  // Reloading a graph silently would discard queue state, so it must be asked for explicitly.
  assert.equal(failure(() => scheduler.submitGraph(graph([node({ node_id: 'a2', action_key: 'effect:1' })]))).code, 'GRAPH_ALREADY_LOADED');
  scheduler.submitGraph({ ...graph([node({ node_id: 'a2', action_key: 'effect:1' })]), replace: true });
  // A later node carrying the same action key cannot repeat the external effect.
  const repeat = failure(() => scheduler.dispatch({ node_id: 'a2' }));
  assert.equal(repeat.code, 'DUPLICATE_SIDE_EFFECT');
  assert.equal(repeat.repeated, false);
  assert.equal(scheduler.evidence().completed_effects.length, 1, 'the completed effect is remembered beyond the graph that produced it');

  // Exhausting the attempt budget blocks the node honestly rather than retrying forever.
  const { scheduler: bounded } = schedulerAt({ max_attempts: 1 });
  bounded.submitGraph(graph([node({ node_id: 'x', max_attempts: 1 })]));
  bounded.dispatch({ node_id: 'x' });
  const exhausted = bounded.reportSignal({ node_id: 'x', kind: 'CRASH' });
  assert.equal(exhausted.retry_allowed, false);
  assert.equal(exhausted.state, 'BLOCKED');
  assert.equal(exhausted.reason, 'REASSIGNMENT_EXHAUSTED');
  assert.equal(exhausted.requires_attention, true);
  assert.equal(exhausted.falsely_failed, false, 'an exhausted node is blocked for attention, not falsely failed');
  assert.equal(failure(() => bounded.reassign({ node_id: 'x' })).code, 'REASSIGNMENT_EXHAUSTED');
  assert.equal(failure(() => bounded.reportSignal({ node_id: 'x', kind: 'MELTED' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bounded.dispatch({ node_id: 'nope' })).status, 404);
});

test('worker selection is capability and placement based with no provider-name branching', () => {
  const { scheduler } = schedulerAt({ placement: 'LOCAL_FIRST' });
  scheduler.submitGraph(graph([
    node({ node_id: 'build', capability_required: 'BUILD' }),
    node({ node_id: 'test', capability_required: 'TEST' }),
    node({ node_id: 'none', capability_required: 'TELEPATHY' }),
  ]));

  const build = scheduler.selectWorker({ node_id: 'build' });
  assert.equal(build.selected, true);
  assert.equal(build.worker_ref, 'worker:local', 'LOCAL_FIRST prefers the local device');
  assert.equal(build.local_first_satisfied, true);
  assert.equal(build.capability_based, true);
  assert.equal(build.provider_name_branching, false, 'selection never branches on a provider name');

  const test_worker = scheduler.selectWorker({ node_id: 'test' });
  assert.equal(test_worker.worker_ref, 'worker:local', 'only the local worker advertises TEST');
  const impossible = scheduler.selectWorker({ node_id: 'none' });
  assert.equal(impossible.selected, false);
  assert.equal(impossible.reason, 'NO_CAPABLE_WORKER');
  assert.equal(failure(() => scheduler.dispatch({ node_id: 'none' })).code, 'NO_CAPABLE_WORKER');

  // A remote-only capability goes remote rather than failing.
  const remote = createForemanScheduler({ localDeviceRef: 'device:local', clock: () => T0, policy: { placement: 'LOCAL_FIRST' } });
  remote.registerWorker({ worker_ref: 'worker:remote', device_ref: 'device:remote', capabilities: ['DEPLOY'] });
  remote.submitGraph(graph([node({ node_id: 'deploy', capability_required: 'DEPLOY' })]));
  const chosen = remote.selectWorker({ node_id: 'deploy' });
  assert.equal(chosen.worker_ref, 'worker:remote');
  assert.equal(chosen.local_first_satisfied, false, 'local-first is a preference, not a hard requirement');

  // An unauthenticated worker is not eligible.
  const unauth = createForemanScheduler({ localDeviceRef: 'device:local', clock: () => T0 });
  unauth.registerWorker({ worker_ref: 'worker:unauth', device_ref: 'device:local', capabilities: ['BUILD'], auth_ready: false });
  unauth.submitGraph(graph([node({ node_id: 'b' })]));
  assert.equal(unauth.selectWorker({ node_id: 'b' }).reason, 'NO_CAPABLE_WORKER');
});

test('a controlled restart keeps completed work and never resumes stale state as success', () => {
  const { scheduler } = schedulerAt();
  scheduler.submitGraph(graph([
    node({ node_id: 'done' }),
    node({ node_id: 'mid' }),
    node({ node_id: 'waiting', depends_on: ['done'] }),
  ]));
  const doneAttempt = scheduler.dispatch({ node_id: 'done' });
  scheduler.completeAttempt({ attempt_ref: doneAttempt.attempt_ref, outcome: 'SUCCEEDED', result_ref: 'result:done', acceptance_ref: 'acceptance:done' });
  const midAttempt = scheduler.dispatch({ node_id: 'mid' });
  assert.equal(midAttempt.state, 'RUNNING');

  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.nodes.find(entry => entry.node_id === 'done').state, 'SUCCEEDED');

  const resumed = scheduler.resumeFrom({ snapshot });
  assert.deepEqual(resumed.preserved_terminal_nodes, ['done'], 'completed work stays completed');
  assert.deepEqual(resumed.interrupted_nodes, ['mid'], 'running work becomes INTERRUPTED, not failed and not succeeded');
  assert.deepEqual(resumed.completed_work_failed_by_restart, []);
  assert.equal(resumed.resume_is_not_success, true);
  assert.equal(resumed.stale_local_state_used_as_authority, false);
  assert.equal(scheduler.node('done').state, 'SUCCEEDED');
  assert.equal(scheduler.node('done').result_ref, 'result:done');
  assert.equal(scheduler.node('mid').state, 'INTERRUPTED');
  assert.equal(scheduler.node('mid').blocker, 'INTERRUPTED_BY_RESTART');
  assert.deepEqual(scheduler.schedule().runnable, ['waiting'], 'only genuinely runnable work is admitted');

  // Interrupted work resumes only after explicit revalidation.
  assert.equal(failure(() => scheduler.dispatch({ node_id: 'mid' })).code, 'INTERRUPTED_REQUIRES_REVALIDATION', 'interrupted work needs revalidation before it may run');
  const refused = scheduler.revalidateInterrupted({ node_id: 'mid', revalidated: false });
  assert.equal(refused.resumed, false);
  assert.equal(refused.reason, 'REVALIDATION_REFUSED');
  const accepted = scheduler.revalidateInterrupted({ node_id: 'mid', revalidated: true });
  assert.equal(accepted.resumed, true);
  assert.equal(scheduler.node('mid').state, 'READY');
  assert.equal(scheduler.dispatch({ node_id: 'mid' }).state, 'RUNNING');
  assert.equal(failure(() => scheduler.revalidateInterrupted({ node_id: 'mid', revalidated: true })).code, 'INVALID_TRANSITION');

  // Metrics and evidence are inspectable, and the module state is isolated and frozen.
  const metrics = scheduler.metrics();
  assert.equal(metrics.by_state.RUNNING, 1, 'only the revalidated node is running');
  assert.equal(metrics.by_state.SUCCEEDED, 1);
  assert.equal(metrics.by_state.READY, 1, 'the dependent node is admitted but not dispatched by the scheduler');
  assert.equal(metrics.owns_task_truth, false);
  assert.equal(metrics.workers.length, 2);
  assert.equal(metrics.completed_work_falsely_failed.length, 0);
  assert.equal(scheduler.evidence().evidence_refs.some(entry => entry.result_ref === 'result:done'), true);
  assert.throws(() => { metrics.paused = true; }, TypeError, 'metrics are frozen');
  assert.throws(() => { scheduler.node('done').state = 'RUNNING'; }, TypeError);
  const other = schedulerAt().scheduler;
  assert.equal(other.metrics().node_count, 0, 'schedulers share no state');
  assert.equal(scheduler.policy().policy_ref, 'policy:em-foreman-default');
  assert.equal(scheduler.journal().some(entry => entry.event === 'QUEUE_RESUMED'), true);
  assert.equal(failure(() => createForemanScheduler({ clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(failure(() => scheduler.completeAttempt({ attempt_ref: 'attempt:nope', outcome: 'SUCCEEDED' })).code, 'UNKNOWN_ATTEMPT');
  assert.equal(failure(() => scheduler.cancelNode({ node_id: 'done' })).code, 'TERMINAL_RESULT_IMMUTABLE');
});
