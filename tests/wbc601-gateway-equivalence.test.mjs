// WBC-601 — gateway equivalence for the execution backend seam.
//
// The claim this task has to defend is not "a port exists". It is "wrapping the Windows path in a port did not
// change what the Windows path does". So this file drives the REAL gateway over HTTP — the same routes the real
// Alien/Mech agents use — and then hands the exact facts the gateway acted on to the STANDARD_DEVICES port, and
// requires both to reach the same decision. The gateway's own store is the source for the port's input, so the
// two cannot be compared over different data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway, REQUIRED_TASK_CAPABILITIES } from '../services/dev-gateway/server.mjs';
import { createStandardDevicesBackend } from '../services/dev-gateway/execution-backend/standard-devices.mjs';
import { claimAllowedByTarget, withheldTasks } from '../services/dev-gateway/targeting.mjs';
import { acceptsWork } from '../city/00-foundation/01-city-core/fleet-routing/index.mjs';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** The gateway's own node shape, restated only because the route no longer exports it. */
const claimNodeFor = node => ({
  nodeId: node.id,
  state: node.online ? 'READY' : 'OFFLINE',
  capabilities: node.capabilities,
  lastHeartbeatAt: Date.parse(node.lastHeartbeatAt) || 0,
  seq: 0,
});

const testFail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/**
 * The port, rebuilt over the LIVE gateway store, with the frozen guards.
 *
 * `changeTask` writes through the gateway's store so the port's decisions are visible in the same canonical
 * truth the HTTP routes read — a comparison against a private copy of the state would prove nothing.
 */
function portOverLiveGateway(app) {
  const store = app.store;
  return createStandardDevicesBackend({
    store,
    terminal: TERMINAL,
    claimNodeFor,
    requiredCapabilities: REQUIRED_TASK_CAPABILITIES,
    claimAllowedByTarget,
    handoffClaimAllowed: () => true,
    noteAssignment: () => {},
    withheldTasks,
    changeTask: (task, state, patch = {}) => {
      Object.assign(task, patch, { state, updatedAt: new Date().toISOString() });
      store.put('tasks', task);
      return task;
    },
    requireRecord: (table, id) => store.get(table, id) ?? testFail(404, 'Not found'),
    fail: testFail,
  });
}

function gatewayProbe(app) {
  const request = (path, body, token = 'ctl') => fetch(`${app.url}/api/v0/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request, node: (path, data) => request(`node/${path}`, data, 'node-token') };
}

const register = (id, capabilities = [...REQUIRED_TASK_CAPABILITIES]) => ({ id, displayName: id, metadata: { platform: 'win32' }, capabilities });

test('a City with no Workbench starts, serves and executes: the seam adds no startup dependency', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc601-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request, node } = gatewayProbe(app);

    // Startup is not gated on any backend being present: no WORKER_POOL backend exists anywhere in this
    // process, and the City is already answering.
    assert.equal((await request('health')).status, 200);
    assert.equal(app.executionProfile, 'STANDARD_DEVICES');
    assert.deepEqual(app.executionBackends.profiles(), ['STANDARD_DEVICES']);

    const health = await (await request('health')).json();
    // The gateway's own verdict must not include the execution backend. This is asserted as a RELATION rather
    // than as the literal word `healthy`: whether the Room Hub is reachable differs between a developer machine
    // (where a resident City may be serving it) and a clean runner, and a test that hard-coded either answer
    // would be asserting the environment. Recomputed here from the components the pre-seam gateway used, the
    // relation holds in both cases and is exactly the property this task promises.
    const degradedNow = health.components.gateway.state !== 'READY' || health.components.rooms.state !== 'READY';
    assert.equal(health.status, degradedNow ? 'degraded' : 'healthy', 'a City whose devices are offline is not a degraded gateway');
    assert.equal(health.components.execution.state, 'UNAVAILABLE');
    assert.equal(health.components.execution.reason, 'NO_EXECUTION_ENDPOINT_REGISTERED');
    assert.equal(health.components.execution.backendId, 'standard-devices');
    assert.equal(health.components.execution.profile, 'STANDARD_DEVICES');

    // The whole real flow still works end to end: register, create, claim, report, complete.
    await node('register', register('Mech-Win'));
    const created = await (await request('tasks', { type: 'CHECKPOINT_DEMO' })).json();
    const claimed = await (await node('claim', { id: 'Mech-Win' })).json();
    assert.equal(claimed.task.id, created.id);
    assert.equal(claimed.task.state, 'ASSIGNED');
    assert.equal((await (await node('report', { id: 'Mech-Win', taskId: created.id, state: 'RUNNING', progress: 30 })).json()).state, 'RUNNING');
    const done = await (await node('report', { id: 'Mech-Win', taskId: created.id, state: 'COMPLETED', progress: 100, result: { bytes: 65 } })).json();
    assert.equal(done.state, 'COMPLETED');
    assert.deepEqual(done.result, { bytes: 65 });

    const healthAfter = await (await request('health')).json();
    assert.equal(healthAfter.components.execution.state, 'READY', 'the one endpoint is free again now that its run finished');
    assert.equal(healthAfter.components.execution.readyEndpointCount, 1);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the port and the live route reach the same claim decision on the same facts', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc601-eq-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request, node } = gatewayProbe(app);
    const port = portOverLiveGateway(app);

    // Two real endpoints, one untargeted task, one strict task aimed at the second device.
    await node('register', register('Alien-Win'));
    await node('register', register('Mech-Win'));
    // Both endpoints are idle right now, so each row must agree with the Core asked directly about the same
    // canonical node record. (The busy case is covered below, because being placed is what makes a row busy.)
    for (const id of ['Alien-Win', 'Mech-Win']) {
      const record = app.store.get('nodes', id);
      const row = port.endpoints().find(candidate => candidate.endpointRef === id);
      assert.equal(row.online, true);
      assert.equal(row.isControlSurface, false);
      assert.equal(row.ready, true);
      assert.equal(acceptsWork(claimNodeFor(record), { requiredCapabilities: REQUIRED_TASK_CAPABILITIES }), row.readinessReason === null);
    }
    const untargeted = await (await request('tasks', { type: 'CHECKPOINT_DEMO' })).json();
    const strict = await (await request('actions', {
      route: 'CITY_TASK',
      target: 'city.task',
      operation: 'CHECKPOINT_DEMO',
      input: { targetDeviceRef: 'Mech-Win' },
      idempotencyKey: 'wbc601-strict-1',
    })).json();
    const strictTaskId = strict.action?.backendRef?.taskId ?? strict.backendRef?.taskId;
    assert.ok(strictTaskId, 'the strict task reached the canonical truth');

    // The route: Alien-Win asks for work. The strict task is Mech's, so Alien must receive the untargeted one.
    const alienClaim = await (await node('claim', { id: 'Alien-Win' })).json();
    assert.equal(alienClaim.task.id, untargeted.id);
    assert.equal(alienClaim.withheld.length, 1);
    assert.equal(alienClaim.withheld[0].taskId, strictTaskId);
    assert.equal(alienClaim.withheld[0].heldFor, 'Mech-Win');

    // The port, over the same store, asked by the other device, must land on the same task...
    const portClaim = port.claim({ nodeId: 'Mech-Win' });
    assert.equal(portClaim.endpointRef, 'Mech-Win');
    // ...and must consider exactly the tasks the route considered: the untargeted one is already assigned, so
    // the strict one is the only candidate, and it is the one the port takes.
    assert.equal(portClaim.task?.id ?? null, strictTaskId);
    assert.equal(portClaim.task.state, 'ASSIGNED');
    assert.equal(app.store.get('tasks', strictTaskId).assignedNodeId, 'Mech-Win');

    // The port's endpoint view agrees with the Core again, this time about a busy endpoint: Mech-Win now holds
    // the strict run, so it is not a claim candidate even though the Core would accept it as a healthy node.
    const mechRecord = app.store.get('nodes', 'Mech-Win');
    const mechRow = port.endpoints().find(row => row.endpointRef === 'Mech-Win');
    assert.equal(mechRow.online, true);
    assert.equal(mechRow.isControlSurface, false);
    assert.equal(mechRow.ready, false);
    assert.equal(mechRow.readinessReason, 'ENDPOINT_BUSY');
    assert.equal(acceptsWork(claimNodeFor(mechRecord), { requiredCapabilities: REQUIRED_TASK_CAPABILITIES }), true, 'the Core speaks about capability and liveness; being busy is a dispatch-layer fact');
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an offline named device is withheld by the port exactly as the route withholds it', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc601-strict-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { node } = gatewayProbe(app);

    await node('register', register('Alien-Win'));
    await node('register', register('Mech-Win'));
    // Take Mech-Win away, then aim a task at it: the task must wait rather than move to the healthy device.
    await app.close();
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const resumed = gatewayProbe(app);
    const strict = await (await resumed.request('actions', {
      route: 'CITY_TASK',
      target: 'city.task',
      operation: 'CHECKPOINT_DEMO',
      input: { targetDeviceRef: 'Mech-Win' },
      idempotencyKey: 'wbc601-strict-offline',
    })).json();
    const strictTaskId = strict.action?.backendRef?.taskId ?? strict.backendRef?.taskId;
    assert.ok(strictTaskId);
    // Re-register the healthy device so it is really online and really asking.
    await resumed.node('register', register('Alien-Win'));
    const claim = await (await resumed.node('claim', { id: 'Alien-Win' })).json();
    assert.equal(claim.task, null, 'the online device must not be given the away device\'s task');
    assert.equal(claim.withheld.length, 1);
    assert.equal(claim.withheld[0].heldFor, 'Mech-Win');

    // The port over the same canonical truth reaches the identical refusal, and names the same side.
    const portClaim = portOverLiveGateway(app).claim({ nodeId: 'Alien-Win' });
    assert.equal(portClaim.task, null);
    assert.equal(portClaim.withheld[0].taskId, strictTaskId);
    assert.equal(portClaim.withheld[0].reason, claim.withheld[0].reason);
    // And the strict task is still QUEUED and unassigned: withholding is not a reassignment in disguise.
    const stored = app.store.get('tasks', strictTaskId);
    assert.equal(stored.state, 'QUEUED');
    assert.equal(stored.assignedNodeId, null);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the City exposes which backend placed the work, and only STANDARD_DEVICES is ever enabled', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc601-surface-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request } = gatewayProbe(app);
    const city = await (await request('city')).json();
    assert.equal(city.executionBackend.profile, 'STANDARD_DEVICES');
    assert.equal(city.executionBackend.backend.backendId, 'standard-devices');
    assert.equal(city.executionBackend.backend.mode, 'enabled');
    assert.equal(city.executionBackend.backend.canExecute, true);
    assert.deepEqual(city.executionBackend.registered.map(entry => entry.profile), ['STANDARD_DEVICES']);
    // No node is present yet, so nothing is reported as an execution endpoint either: the descriptor describes
    // the backend, never a device it does not have.
    assert.deepEqual(app.executionBackends.list().map(entry => entry.backendId), ['standard-devices']);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});
