// WBC-601 — STANDARD_DEVICES backend behaviour.
//
// Two kinds of test live here, and the difference matters:
//
//   1. The backend's own additions — readiness words, candidate endpoints, dispatch/control refusals. These are
//      new surface area, so they are asserted directly.
//   2. The *decision procedure*, which is NOT new. For that half the assertions are differential: the backend is
//      handed the real targeting guards (`claimAllowedByTarget` / `withheldTasks` from the frozen MESH-301
//      module) and the real Core verdict (`acceptsWork`), and its answer is compared against the exact result
//      the pre-seam route produced for the same facts. A test that re-stated the expected answer would pass
//      even if both implementations were wrong in the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDARD_DEVICES_BACKEND_ID,
  createStandardDevicesBackend,
  reportEventName,
  reportTransitionAllowed,
} from '../services/dev-gateway/execution-backend/standard-devices.mjs';
import { REQUIRED_TASK_CAPABILITIES } from '../services/dev-gateway/server.mjs';
import { claimAllowedByTarget, withheldTasks } from '../services/dev-gateway/targeting.mjs';
import { acceptsWork } from '../city/00-foundation/01-city-core/fleet-routing/index.mjs';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const testFail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** The gateway's own node shape, copied verbatim from the route so the Core is asked the same question. */
const claimNodeFor = node => ({
  nodeId: node.id,
  state: node.online ? 'READY' : 'OFFLINE',
  capabilities: node.capabilities,
  lastHeartbeatAt: Date.parse(node.lastHeartbeatAt) || 0,
  seq: 0,
});

const node = (overrides = {}) => ({
  id: 'Mech-Win',
  displayName: 'Mech-Win',
  online: true,
  sharingEnabled: true,
  capabilities: [...REQUIRED_TASK_CAPABILITIES],
  lastHeartbeatAt: new Date().toISOString(),
  metadata: { platform: 'win32' },
  ...overrides,
});

const task = (overrides = {}) => ({
  id: 'Q-1',
  type: 'CHECKPOINT_DEMO',
  state: 'QUEUED',
  progress: 0,
  assignedNodeId: null,
  ...overrides,
});

/** A fake canonical store with the real atomic-mutation shape, plus a change log for transition assertions. */
function harness({ nodes = [], tasks = [], handoffAllowed = () => true } = {}) {
  const tables = { nodes: [...nodes], tasks: [...tasks] };
  const events = [];
  const assignments = [];
  const store = {
    list: table => tables[table],
    get: (table, id) => tables[table].find(row => row.id === id) ?? null,
    atomic: run => run(),
    put: (table, row) => { const index = tables[table].findIndex(existing => existing.id === row.id); if (index >= 0) tables[table][index] = row; else tables[table].push(row); return row; },
  };
  const backend = createStandardDevicesBackend({
    store,
    terminal: TERMINAL,
    claimNodeFor,
    requiredCapabilities: REQUIRED_TASK_CAPABILITIES,
    claimAllowedByTarget,
    handoffClaimAllowed: handoffAllowed,
    noteAssignment: args => assignments.push(args),
    withheldTasks,
    changeTask: (subject, state, patch = {}, event = `TASK_${state}`) => {
      Object.assign(subject, patch, { state, updatedAt: new Date().toISOString() });
      store.put('tasks', subject);
      events.push({ event, taskId: subject.id, patch });
      return subject;
    },
    requireRecord: (table, id) => store.get(table, id) ?? testFail(404, 'Not found'),
    fail: testFail,
  });
  return { store, backend, events, assignments, tables };
}

test('STANDARD_DEVICES is the enabled long-term default and claims exactly the profile it wraps', () => {
  const { backend } = harness();
  assert.equal(backend.backendId, STANDARD_DEVICES_BACKEND_ID);
  assert.equal(backend.profile, 'STANDARD_DEVICES');
  assert.equal(backend.kind, 'DEVICE_FLEET');
  assert.equal(backend.mode, 'enabled', 'the compatibility baseline may not be switchable off');
  assert.deepEqual([...backend.requiredCapabilities], [...REQUIRED_TASK_CAPABILITIES]);
});

test('fleet readiness distinguishes "no device at all" from "devices present, none accepting work"', () => {
  // No Workbench exists and no device has joined: the honest word is UNAVAILABLE with a named reason, not a
  // crash and not a silent READY.
  const empty = harness();
  const emptyReadiness = empty.backend.readiness();
  assert.equal(emptyReadiness.state, 'UNAVAILABLE');
  assert.equal(emptyReadiness.reason, 'NO_EXECUTION_ENDPOINT_REGISTERED');
  assert.deepEqual(empty.backend.endpoints(), []);

  // A device that is registered but offline, and one that cannot run the work: both present, neither usable.
  const unavailable = harness({ nodes: [node({ id: 'A', online: false }), node({ id: 'B', capabilities: ['task.execute.safe'] })] });
  const unavailableReadiness = unavailable.backend.readiness();
  assert.equal(unavailableReadiness.state, 'UNAVAILABLE');
  assert.equal(unavailableReadiness.reason, 'NO_ENDPOINT_ACCEPTS_WORK');
  assert.equal(unavailableReadiness.endpointCount, 2);
  // The two different causes are both stated: a surface must not have to guess why nothing is running.
  assert.match(unavailableReadiness.detail, /ENDPOINT_OFFLINE/);
  assert.match(unavailableReadiness.detail, /MISSING_CAPABILITY:filesystem\.temp/);

  // One usable device is enough.
  const usable = harness({ nodes: [node({ id: 'A', online: false }), node({ id: 'B' })] });
  const usableReadiness = usable.backend.readiness();
  assert.equal(usableReadiness.state, 'READY');
  assert.equal(usableReadiness.ready, true);
  assert.equal(usableReadiness.reason, null);
  assert.equal(usableReadiness.readyEndpointCount, 1);
});

test('an endpoint row is a truthful view: offline, capability-less and sharing-off are different facts', () => {
  const { backend } = harness({
    nodes: [
      node({ id: 'Ready' }),
      node({ id: 'Offline', online: false }),
      node({ id: 'NoCap', capabilities: [] }),
      node({ id: 'SharedOff', sharingEnabled: false }),
    ],
  });
  const rows = backend.endpoints();
  assert.deepEqual(rows.map(row => row.endpointRef), ['NoCap', 'Offline', 'Ready', 'SharedOff']);
  const reason = id => rows.find(row => row.endpointRef === id).readinessReason;
  assert.equal(reason('Ready'), null);
  assert.equal(reason('Offline'), 'ENDPOINT_OFFLINE');
  assert.equal(reason('SharedOff'), 'SHARING_DISABLED_BY_OWNER');
  assert.match(reason('NoCap'), /^MISSING_CAPABILITY:/);
  assert.equal(rows.find(row => row.endpointRef === 'Ready').ready, true);
  assert.equal(rows.every(row => row.isWorker === true && row.isControlSurface === false), true);
  // A legacy node record written before this contract has no sharing field and must stay usable.
  assert.equal(rows.find(row => row.endpointRef === 'Ready').sharingEnabled, true);
});

test('claim reproduces the frozen decision for every negative control the pre-seam route covered', () => {
  // Baseline: one online capable device and one untargeted queued task -> assigned, exactly as before.
  const baseline = harness({ nodes: [node()], tasks: [task()] });
  const claimed = baseline.backend.claim({ nodeId: 'Mech-Win' });
  assert.equal(claimed.task.id, 'Q-1');
  assert.equal(claimed.task.state, 'ASSIGNED');
  assert.equal(claimed.task.assignedNodeId, 'Mech-Win');
  assert.deepEqual(baseline.events.map(entry => entry.event), ['TASK_ASSIGNED']);
  assert.deepEqual(baseline.assignments, [{ subjectRef: 'Q-1', deviceRef: 'Mech-Win' }]);
  // The same facts, answered by the Core the way the healthy-path route answered them.
  assert.equal(acceptsWork(claimNodeFor(node()), { requiredCapabilities: REQUIRED_TASK_CAPABILITIES }), true);

  // Untargeted task, but the device cannot run it: nothing is assigned and nothing is silently reassigned.
  const incapable = harness({ nodes: [node({ capabilities: ['task.execute.safe'] })], tasks: [task()] });
  const incapableClaim = incapable.backend.claim({ nodeId: 'Mech-Win' });
  assert.equal(incapableClaim.task, null);
  assert.equal(incapableClaim.withheld, undefined, 'the task is not withheld from this device, it is unplaceable');
  assert.equal(acceptsWork(claimNodeFor(node({ capabilities: ['task.execute.safe'] })), { requiredCapabilities: REQUIRED_TASK_CAPABILITIES }), false);

  // STRICT TARGET AT AN AWAY DEVICE (MESH-301 gate 6): withheld from the asking device, never reassigned.
  const strictAway = harness({
    nodes: [node({ id: 'Mech-Win', online: false }), node({ id: 'Alien-Win' })],
    tasks: [task({ targetDeviceRef: 'Mech-Win', targetStateAtCreation: 'OFFLINE' })],
  });
  const strictAwayClaim = strictAway.backend.claim({ nodeId: 'Alien-Win' });
  assert.equal(strictAwayClaim.task, null, 'the online device must not take a task the user aimed elsewhere');
  assert.equal(strictAwayClaim.withheld.length, 1);
  // The withheld row names BOTH sides: which device the task is held FOR, and which device asked. A row that
  // only said "not yours" would leave a surface unable to explain whose task it is.
  assert.equal(strictAwayClaim.withheld[0].reason, 'STRICT_TARGET_BOUND');
  assert.equal(strictAwayClaim.withheld[0].heldFor, 'Mech-Win');
  assert.equal(strictAwayClaim.withheld[0].askedBy, 'Alien-Win');
  assert.deepEqual(strictAway.events, []);
  // And the identical verdict from the frozen guard itself, so this test cannot agree with a wrong copy.
  assert.equal(claimAllowedByTarget({ state: 'QUEUED', targetDeviceRef: 'Mech-Win' }, 'Alien-Win'), false);
  assert.equal(withheldTasks({ tasks: [{ id: 'Q-1', state: 'QUEUED', targetDeviceRef: 'Mech-Win' }], deviceRef: 'Alien-Win', terminal: TERMINAL })[0].reason, 'STRICT_TARGET_BOUND');

  // A strict target that HAS returned to the same device is claimable again.
  const strictBack = harness({ nodes: [node({ id: 'Mech-Win' })], tasks: [task({ targetDeviceRef: 'Mech-Win', targetStateAtCreation: 'OFFLINE' })] });
  assert.equal(strictBack.backend.claim({ nodeId: 'Mech-Win' }).task.id, 'Q-1');

  // BUSY: an endpoint already holding unfinished work is offered nothing, so two tasks cannot land on one
  // device even when a second task is queued.
  const busy = harness({ nodes: [node()], tasks: [task({ id: 'Q-running', state: 'RUNNING', assignedNodeId: 'Mech-Win' }), task({ id: 'Q-next' })] });
  const busyClaim = busy.backend.claim({ nodeId: 'Mech-Win' });
  assert.equal(busyClaim.task, null);
  assert.equal(busyClaim.busy, true);
  assert.equal(busy.tables.tasks.find(entry => entry.id === 'Q-next').state, 'QUEUED');

  // SHARING WITHDRAWN BY THE OWNER: the device stays online and discoverable but takes nothing.
  const sharing = harness({ nodes: [node({ sharingEnabled: false })], tasks: [task()] });
  assert.equal(sharing.backend.claim({ nodeId: 'Mech-Win' }).task, null);
  assert.equal(sharing.store.get('nodes', 'Mech-Win').online, true);

  // A task already carried by ANOTHER device is not stolen.
  const otherHolder = harness({ nodes: [node()], tasks: [task({ state: 'RUNNING', assignedNodeId: 'Alien-Win' })] });
  assert.equal(otherHolder.backend.claim({ nodeId: 'Mech-Win' }).task, null);

  // The handoff reservation guard is consulted, and its refusal is honoured rather than overridden.
  const reserved = harness({ nodes: [node()], tasks: [task({ handoffTargetRef: 'Alien-Win' })], handoffAllowed: () => false });
  assert.equal(reserved.backend.claim({ nodeId: 'Mech-Win' }).task, null);
  const reservedAllowed = harness({ nodes: [node()], tasks: [task({ handoffTargetRef: 'Alien-Win' })], handoffAllowed: () => true });
  assert.equal(reservedAllowed.backend.claim({ nodeId: 'Mech-Win' }).task.id, 'Q-1');
});

test('report keeps the same transitions, the same refusals and the same event names', () => {
  assert.equal(reportTransitionAllowed('ASSIGNED', 'RUNNING'), true);
  assert.equal(reportTransitionAllowed('ASSIGNED', 'FAILED'), true);
  assert.equal(reportTransitionAllowed('ASSIGNED', 'COMPLETED'), false, 'a task may not jump straight to success');
  assert.equal(reportTransitionAllowed('RUNNING', 'COMPLETED'), true);
  assert.equal(reportTransitionAllowed('RUNNING', 'FAILED'), true);
  assert.equal(reportEventName('ASSIGNED', 'RUNNING'), 'TASK_STARTED');
  assert.equal(reportEventName('RUNNING', 'RUNNING'), 'TASK_CHECKPOINTED', 'a checkpoint is not a restart');
  assert.equal(reportEventName('RUNNING', 'COMPLETED'), 'TASK_COMPLETED');

  const running = harness({ nodes: [node()], tasks: [task({ state: 'ASSIGNED', assignedNodeId: 'Mech-Win' })] });
  const started = running.backend.report({ taskId: 'Q-1', nodeId: 'Mech-Win', state: 'RUNNING', progress: 0, lastCheckpoint: null });
  assert.equal(started.state, 'RUNNING');
  assert.deepEqual(running.events.map(entry => entry.event), ['TASK_STARTED']);
  const checkpointed = running.backend.report({ taskId: 'Q-1', nodeId: 'Mech-Win', state: 'RUNNING', progress: 30, lastCheckpoint: { step: 'artifact-written' } });
  assert.equal(checkpointed.progress, 30);
  assert.deepEqual(running.events.map(entry => entry.event), ['TASK_STARTED', 'TASK_CHECKPOINTED']);
  const completed = running.backend.report({ taskId: 'Q-1', nodeId: 'Mech-Win', state: 'COMPLETED', progress: 100, result: { bytes: 65 } });
  assert.equal(completed.state, 'COMPLETED');
  assert.deepEqual(completed.result, { bytes: 65 });

  // Another node's task is refused with the same 403 shape.
  assert.throws(() => running.backend.report({ taskId: 'Q-1', nodeId: 'Alien-Win', state: 'RUNNING', progress: 100 }), error => error.status === 403);
  // A late report for a finished task returns the terminal task unchanged rather than failing or reopening it.
  const late = running.backend.report({ taskId: 'Q-1', nodeId: 'Mech-Win', state: 'RUNNING', progress: 100 });
  assert.equal(late.state, 'COMPLETED');

  const illegal = harness({ nodes: [node()], tasks: [task({ state: 'ASSIGNED', assignedNodeId: 'Mech-Win' })] });
  assert.throws(() => illegal.backend.report({ taskId: 'Q-1', nodeId: 'Mech-Win', state: 'COMPLETED', progress: 100 }), error => error.status === 409);
  const backwards = harness({ nodes: [node()], tasks: [task({ state: 'RUNNING', assignedNodeId: 'Mech-Win', progress: 75 })] });
  assert.throws(() => backwards.backend.report({ taskId: 'Q-1', nodeId: 'Mech-Win', state: 'RUNNING', progress: 30 }), error => error.status === 400);
  const over = harness({ nodes: [node()], tasks: [task({ state: 'RUNNING', assignedNodeId: 'Mech-Win', progress: 10 })] });
  assert.throws(() => over.backend.report({ taskId: 'Q-1', nodeId: 'Mech-Win', state: 'RUNNING', progress: 120 }), error => error.status === 400);
});

test('dispatch and control refuse honestly instead of pretending the endpoint is ready', () => {
  const { backend, store } = harness({ nodes: [node({ id: 'Ready' }), node({ id: 'Offline', online: false })], tasks: [task({ id: 'Q-a' }), task({ id: 'Q-b', state: 'RUNNING', assignedNodeId: 'Ready' })] });

  assert.throws(() => backend.dispatch({ taskId: 'Q-a', endpointRef: 'Nobody' }), error => error.code === 'UNKNOWN_ENDPOINT' && error.status === 404);
  assert.throws(() => backend.dispatch({ taskId: 'Q-a', endpointRef: 'Offline' }), error => error.code === 'ENDPOINT_NOT_READY' && error.status === 409);
  assert.throws(() => backend.dispatch({ endpointRef: 'Ready' }), error => error.code === 'INVALID_REQUEST' && error.status === 400);
  // `Ready` currently holds RUNNING Q-b, so it is not a candidate: dispatch may not be a way around the
  // one-task-per-endpoint rule that the claim path enforces.
  assert.throws(() => backend.dispatch({ taskId: 'Q-a', endpointRef: 'Ready' }), error => error.code === 'ENDPOINT_NOT_READY' && error.status === 409);

  // Cancelling the run in flight frees the endpoint, and the same dispatch then succeeds.
  const cancelledHolder = backend.control({ taskId: 'Q-b', action: 'cancel' });
  assert.equal(cancelledHolder.task.state, 'CANCELLED');
  const moved = backend.dispatch({ taskId: 'Q-a', endpointRef: 'Ready' });
  assert.equal(moved.task.assignedNodeId, 'Ready');
  // A run makes exactly one placement. `dispatch` therefore checks the task's own state, not only the
  // endpoint's readiness: a second placement attempt is a refused transition, so two assignments of one run
  // cannot be produced through this port even when the endpoint stays free.
  const reentrant = harness({ nodes: [node({ id: 'Free' })], tasks: [task({ id: 'Q-re' })] });
  assert.equal(reentrant.backend.dispatch({ taskId: 'Q-re', endpointRef: 'Free' }).task.state, 'ASSIGNED');
  assert.equal(reentrant.backend.endpoints().find(row => row.endpointRef === 'Free').readinessReason, 'ENDPOINT_BUSY');
  // Clear the busy guard by cancelling the placed run, so the endpoint is READY again and only the task's own
  // state can refuse the second placement.
  reentrant.store.put('tasks', { ...reentrant.store.get('tasks', 'Q-re'), state: 'CANCELLED' });
  assert.equal(reentrant.backend.endpoints().find(row => row.endpointRef === 'Free').ready, true);
  assert.throws(() => reentrant.backend.dispatch({ taskId: 'Q-re', endpointRef: 'Free' }), error => error.code === 'INVALID_TRANSITION' && error.status === 409);

  assert.throws(() => backend.control({ taskId: 'Q-a', action: 'pause' }), error => error.code === 'INVALID_REQUEST');
  const cancelled = backend.control({ taskId: 'Q-a', action: 'cancel' });
  assert.equal(cancelled.task.state, 'CANCELLED');
  assert.equal(store.get('tasks', 'Q-a').state, 'CANCELLED');
  // Cancelling something already finished is a refusal, not a second cancellation.
  assert.throws(() => backend.control({ taskId: 'Q-a' }), error => error.status === 409);
  assert.throws(() => backend.control({ taskId: 'Q-nope' }), error => error.status === 404);
});

test('a probe failure is reported as UNKNOWN rather than being allowed to crash a status read', () => {
  const broken = createStandardDevicesBackend({
    store: { list: table => { if (table === 'nodes') throw new Error('store unavailable'); return []; }, get: () => null, atomic: run => run(), put: () => {} },
    terminal: TERMINAL,
    claimNodeFor,
    requiredCapabilities: REQUIRED_TASK_CAPABILITIES,
    claimAllowedByTarget: () => true,
    handoffClaimAllowed: () => true,
    noteAssignment: () => {},
    withheldTasks: () => [],
    changeTask: subject => subject,
    requireRecord: () => testFail(404, 'Not found'),
    fail: testFail,
  });
  const readiness = broken.readiness();
  assert.equal(readiness.state, 'UNKNOWN');
  assert.equal(readiness.usable, false);
  assert.equal(readiness.reason, 'READINESS_PROBE_FAILED');
  assert.match(readiness.detail, /store unavailable/);
});

test('the port refuses to be constructed without the facts it must not invent', () => {
  for (const missing of ['store', 'claimNodeFor', 'claimAllowedByTarget', 'handoffClaimAllowed', 'noteAssignment', 'withheldTasks', 'changeTask', 'requireRecord', 'fail']) {
    const complete = {
      store: { list: () => [] }, terminal: TERMINAL, claimNodeFor, requiredCapabilities: REQUIRED_TASK_CAPABILITIES,
      claimAllowedByTarget: () => true, handoffClaimAllowed: () => true, noteAssignment: () => {}, withheldTasks: () => [],
      changeTask: subject => subject, requireRecord: () => null, fail: testFail,
    };
    delete complete[missing];
    assert.throws(() => createStandardDevicesBackend(complete), error => error.code === 'INVALID_BACKEND' && error.message.includes(missing), `missing ${missing} must be refused by name`);
  }
});
