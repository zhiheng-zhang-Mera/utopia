/**
 * UTOPIA · City Core — fleet model and routing suite.
 *
 * The heartbeat windows, the first-fit join order, the capability gate and the three
 * dropout outcomes restate the Codex-Boss donor `src/shared/fleet.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. `now` is always passed in, so the suite
 * never reads a clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSIGNMENT_STATES,
  DEGRADED_AFTER_MS,
  FLEET_HEARTBEAT_INTERVAL_MS,
  FLEET_NODE_STATES,
  OFFLINE_AFTER_MS,
  acceptsWork,
  assignmentState,
  fleetAssignment,
  fleetNode,
  fleetNodeStateFor,
  fleetTask,
  handleNodeDropout,
  routeTask,
} from '../index.mjs';

const NOW = 1_700_000_000_000;

/** A node whose heartbeat lands at `age` milliseconds before NOW. */
function node(nodeId, state = 'READY', capabilities = [], age = 0) {
  return { nodeId, state, capabilities, lastHeartbeatAt: NOW - age, seq: 1 };
}

function assignment(overrides = {}) {
  return {
    taskId: 'task-1',
    requiredCapabilities: [],
    state: 'RUNNING',
    nodeId: 'node-a',
    attempts: 0,
    history: ['assigned:node-a'],
    ...overrides,
  };
}

test('the heartbeat windows are the donor constants', () => {
  assert.equal(FLEET_HEARTBEAT_INTERVAL_MS, 5000);
  assert.equal(DEGRADED_AFTER_MS, 2 * 5000);
  assert.equal(OFFLINE_AFTER_MS, 6 * 5000);
  assert.deepEqual(FLEET_NODE_STATES, ['READY', 'DEGRADED', 'OFFLINE', 'FAILED', 'DISABLED']);
  assert.deepEqual(ASSIGNMENT_STATES, ['QUEUED', 'ASSIGNED', 'RUNNING', 'CHECKPOINTED', 'COMPLETED', 'FAILED']);
  assert.throws(() => assignmentState('PENDING'), TypeError);
});

test('node state is derived from the heartbeat age at exact boundaries', () => {
  // just under / exactly at / over each threshold
  assert.equal(fleetNodeStateFor(NOW, { lastHeartbeatAt: NOW }), 'READY');
  assert.equal(fleetNodeStateFor(NOW, { lastHeartbeatAt: NOW - 1 }), 'READY');
  assert.equal(fleetNodeStateFor(NOW, { lastHeartbeatAt: NOW - (DEGRADED_AFTER_MS - 1) }), 'READY');
  assert.equal(fleetNodeStateFor(NOW, { lastHeartbeatAt: NOW - DEGRADED_AFTER_MS }), 'DEGRADED');
  assert.equal(fleetNodeStateFor(NOW, { lastHeartbeatAt: NOW - (DEGRADED_AFTER_MS + 1) }), 'DEGRADED');
  assert.equal(fleetNodeStateFor(NOW, { lastHeartbeatAt: NOW - (OFFLINE_AFTER_MS - 1) }), 'DEGRADED');
  assert.equal(fleetNodeStateFor(NOW, { lastHeartbeatAt: NOW - OFFLINE_AFTER_MS }), 'OFFLINE');
  assert.equal(fleetNodeStateFor(NOW, { lastHeartbeatAt: NOW - (OFFLINE_AFTER_MS + 1) }), 'OFFLINE');
  // a heartbeat in the future is not degraded
  assert.equal(fleetNodeStateFor(NOW, { lastHeartbeatAt: NOW + 60_000 }), 'READY');
});

test('work is accepted by state and by every required capability, never by assumption', () => {
  const task = { taskId: 'task-1', requiredCapabilities: ['compute', 'gpu'] };
  assert.equal(acceptsWork(node('n', 'READY', ['compute', 'gpu']), task), true);
  assert.equal(acceptsWork(node('n', 'DEGRADED', ['compute', 'gpu']), task), true, 'DEGRADED nodes still accept work');
  assert.equal(acceptsWork(node('n', 'OFFLINE', ['compute', 'gpu']), task), false);
  assert.equal(acceptsWork(node('n', 'FAILED', ['compute', 'gpu']), task), false);
  assert.equal(acceptsWork(node('n', 'DISABLED', ['compute', 'gpu']), task), false);
  assert.equal(acceptsWork(node('n', 'READY', ['compute']), task), false, 'a missing capability is never assumed');
  assert.equal(acceptsWork(node('n', 'READY', []), { taskId: 't', requiredCapabilities: [] }), true);
});

test('first-fit routing walks nodes in join order and records the placement', () => {
  const task = { taskId: 'task-1', requiredCapabilities: ['compute'] };
  const nodes = [
    node('node-1', 'READY', []),
    node('node-2', 'DEGRADED', ['compute']),
    node('node-3', 'READY', ['compute']),
  ];
  const routed = routeTask(task, nodes);
  assert.deepEqual(routed, {
    assignment: {
      taskId: 'task-1',
      requiredCapabilities: ['compute'],
      state: 'ASSIGNED',
      nodeId: 'node-2',
      attempts: 0,
      history: ['assigned:node-2'],
    },
  });
  assert.equal('note' in routed, false, 'a placed task carries no note');

  // join order decides: the same capabilities in another order choose another node
  const reordered = routeTask(task, [nodes[2], nodes[1], nodes[0]]);
  assert.equal(reordered.assignment.nodeId, 'node-3');

  // the task fields are carried through, including the checkpoint and replay flag
  const withCheckpoint = routeTask(
    { taskId: 'task-2', requiredCapabilities: [], checkpoint: { step: 3 }, replaySafe: false },
    [node('node-1', 'READY', [])],
  );
  assert.deepEqual(withCheckpoint.assignment.checkpoint, { step: 3 });
  assert.equal(withCheckpoint.assignment.replaySafe, false);
});

test('no eligible node queues the task with an honest note instead of a placement', () => {
  const task = { taskId: 'task-1', requiredCapabilities: ['gpu'] };
  const routed = routeTask(task, [node('node-1', 'FAILED', ['gpu']), node('node-2', 'READY', ['compute'])]);
  assert.deepEqual(routed, {
    assignment: {
      taskId: 'task-1',
      requiredCapabilities: ['gpu'],
      state: 'QUEUED',
      attempts: 0,
      history: ['queued: no eligible node'],
    },
    note: 'no eligible node',
  });
  assert.equal(routed.assignment.nodeId, undefined);

  const empty = routeTask(task, []);
  assert.equal(empty.assignment.state, 'QUEUED');
  assert.equal(empty.note, 'no eligible node');
});

test('dropout leaves unrelated and completed work untouched, by identity', () => {
  const other = assignment({ taskId: 'task-other', nodeId: 'node-b' });
  const completed = assignment({ taskId: 'task-done', state: 'COMPLETED' });
  const unplaced = assignment({ taskId: 'task-unplaced', nodeId: undefined, state: 'QUEUED' });
  const dropped = assignment({ taskId: 'task-mine' });

  const result = handleNodeDropout([other, completed, unplaced, dropped], 'node-a');
  assert.equal(result.length, 4);
  assert.equal(result[0], other, 'another node\'s work is the same object');
  assert.equal(result[1], completed, 'COMPLETED work is the same object even on the lost node');
  assert.equal(result[2], unplaced, 'work with no placement is the same object');
  assert.notEqual(result[3], dropped, 'the lost node\'s work is rewritten');
});

test('checkpointed work transfers back to the queue with its checkpoint', () => {
  const checkpointed = assignment({ state: 'CHECKPOINTED', attempts: 2, checkpoint: { step: 3 } });
  const [result] = handleNodeDropout([checkpointed], 'node-a');
  assert.deepEqual(result, {
    taskId: 'task-1',
    requiredCapabilities: [],
    checkpoint: { step: 3 },
    state: 'QUEUED',
    nodeId: undefined,
    attempts: 3,
    history: ['assigned:node-a', 'checkpointed:node-a transferred'],
  });
  assert.equal(result.nodeId, undefined);
  assert.deepEqual(checkpointed, assignment({ state: 'CHECKPOINTED', attempts: 2, checkpoint: { step: 3 } }), 'the input is not mutated');
});

test('replay-safe work is reassigned; unsafe work fails without bumping attempts', () => {
  const safe = handleNodeDropout([assignment({ attempts: 1 })], 'node-a')[0];
  assert.equal(safe.state, 'QUEUED');
  assert.equal(safe.nodeId, undefined);
  assert.equal(safe.attempts, 2);
  assert.deepEqual(safe.history, ['assigned:node-a', 'reassign-after-dropout:node-a']);

  const explicitlySafe = handleNodeDropout([assignment({ replaySafe: true, attempts: 0 })], 'node-a')[0];
  assert.equal(explicitlySafe.state, 'QUEUED');
  assert.deepEqual(explicitlySafe.history, ['assigned:node-a', 'reassign-after-dropout:node-a']);

  const unsafe = handleNodeDropout([assignment({ replaySafe: false, attempts: 4 })], 'node-a')[0];
  assert.equal(unsafe.state, 'FAILED');
  assert.equal(unsafe.nodeId, undefined);
  assert.equal(unsafe.attempts, 4, 'a failure is not a retry: attempts does not move');
  assert.deepEqual(unsafe.history, ['assigned:node-a', 'failed:node-a dropped without checkpoint']);
});

test('dropout resolves each assignment independently in one pass', () => {
  const result = handleNodeDropout(
    [
      assignment({ taskId: 'a', state: 'CHECKPOINTED', attempts: 1 }),
      assignment({ taskId: 'b', nodeId: 'node-b', attempts: 1 }),
      assignment({ taskId: 'c', replaySafe: false, attempts: 5 }),
      assignment({ taskId: 'd', state: 'COMPLETED', nodeId: 'node-b' }),
    ],
    'node-a',
  );
  assert.deepEqual(result.map((item) => item.state), ['QUEUED', 'RUNNING', 'FAILED', 'COMPLETED']);
  assert.deepEqual(result.map((item) => item.attempts), [2, 1, 5, 0]);

  // dropping a node nobody works for changes nothing at all
  const untouched = [assignment({ nodeId: 'node-b' }), assignment({ state: 'COMPLETED' })];
  const untouchedResult = handleNodeDropout(untouched, 'node-absent');
  assert.deepEqual(untouchedResult, untouched);
  assert.equal(untouchedResult[0], untouched[0]);
  assert.equal(untouchedResult[1], untouched[1]);
});

test('the value shape validators accept honest records and refuse invented ones', () => {
  assert.deepEqual(fleetNode({ nodeId: 'n', state: 'READY', capabilities: ['compute'], lastHeartbeatAt: NOW }), {
    nodeId: 'n',
    state: 'READY',
    capabilities: ['compute'],
    lastHeartbeatAt: NOW,
    seq: 0,
  });
  assert.throws(() => fleetNode({ nodeId: '', state: 'READY', lastHeartbeatAt: NOW }), TypeError);
  assert.throws(() => fleetNode({ nodeId: 'n', state: 'ONLINE', lastHeartbeatAt: NOW }), TypeError);
  assert.throws(() => fleetNode({ nodeId: 'n', state: 'READY', capabilities: ['a', 'a'], lastHeartbeatAt: NOW }), TypeError);
  assert.throws(() => fleetNode({ nodeId: 'n', state: 'READY', lastHeartbeatAt: Number.NaN }), TypeError);

  assert.deepEqual(fleetTask({ taskId: 't', requiredCapabilities: ['compute'] }), {
    taskId: 't',
    requiredCapabilities: ['compute'],
  });
  assert.throws(() => fleetTask({ requiredCapabilities: [] }), TypeError);

  // an unplaced assignment serializes without a nodeId key, exactly as the donor writes it
  const cleared = handleNodeDropout([assignment()], 'node-a')[0];
  assert.equal(JSON.stringify(cleared).includes('nodeId'), false);
  assert.equal(cleared.nodeId, undefined);
  assert.deepEqual(fleetAssignment(cleared), cleared);
  assert.throws(() => fleetAssignment({ ...assignment(), attempts: -1 }), TypeError);
  assert.throws(() => fleetAssignment({ ...assignment(), history: [1] }), TypeError);
});
