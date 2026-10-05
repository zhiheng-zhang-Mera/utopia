// WBC-602 — the descriptor as the live gateway serves it.
//
// These tests drive the REAL gateway over HTTP with the REAL agent registration shape, including the shape that
// existed before this contract. What they defend is that adding a read-only descriptor changed nothing a node
// already relied on: the raw node record, the claim decision, the strict target guard and the telemetry
// freshness are all untouched, while the descriptor is available and truthful.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway, REQUIRED_TASK_CAPABILITIES } from '../services/dev-gateway/server.mjs';
import { assertNodeDescriptor, isExecutionEndpoint } from '../contracts/node-descriptor-v1/node-descriptor.mjs';

function probe(app) {
  const request = (path, body, token = 'ctl') => fetch(`${app.url}/api/v0/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request, node: (path, data) => request(`node/${path}`, data, 'node-token') };
}

/** The registration payload the pre-WBC-602 agent sent: no roles, no resources, no new fields. */
const legacyRegister = (id, overrides = {}) => ({
  id,
  displayName: id,
  metadata: { platform: 'win32' },
  agentVersion: '0.2.0',
  capabilities: [...REQUIRED_TASK_CAPABILITIES],
  ...overrides,
});

test('a node registered with the old payload still registers, claims and completes, and gains a descriptor', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc602-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request, node } = probe(app);

    // The OLD payload, byte for byte: no roles, no resources.
    assert.equal((await node('register', legacyRegister('Mech-Win'))).status, 200);

    // The pre-existing raw truth is still exactly what it was.
    const listed = await (await request('nodes')).json();
    const raw = listed.nodes.find(entry => entry.id === 'Mech-Win');
    assert.deepEqual(Object.keys(raw).filter(key => ['roles', 'resources', 'nodeDescriptor'].includes(key)), [], 'the stored node record gains no descriptor fields');
    assert.equal(raw.roles, undefined);

    // The descriptor arrives as a SIBLING field, so an old surface reading `nodes` sees no change at all.
    assert.equal(listed.nodeDescriptors.length, 1);
    const descriptor = listed.nodeDescriptors[0];
    assertNodeDescriptor(descriptor);
    assert.equal(descriptor.nodeId, 'Mech-Win');
    assert.equal(descriptor.roleSource, 'LEGACY_DEFAULT');
    assert.deepEqual([...descriptor.roles], ['EXECUTION_NODE']);
    assert.equal(descriptor.availability.acceptingWork, true);
    assert.equal(descriptor.resources.memory.totalBytes.presence, 'UNKNOWN', 'no telemetry was sent, so nothing is claimed');
    assert.equal(isExecutionEndpoint(descriptor), true);

    // The whole real flow is unchanged.
    const created = await (await request('tasks', { type: 'CHECKPOINT_DEMO' })).json();
    const claimed = await (await node('claim', { id: 'Mech-Win' })).json();
    assert.equal(claimed.task.id, created.id);
    assert.equal((await (await node('report', { id: 'Mech-Win', taskId: created.id, state: 'RUNNING', progress: 30 })).json()).state, 'RUNNING');
    assert.equal((await (await node('report', { id: 'Mech-Win', taskId: created.id, state: 'COMPLETED', progress: 100, result: { bytes: 7 } })).json()).state, 'COMPLETED');

    // A node can read the descriptor the City holds about it, and the route writes nothing.
    const before = JSON.stringify((await (await request('nodes')).json()).nodes);
    const mine = await (await node('descriptor', { id: 'Mech-Win' })).json();
    assert.equal(mine.descriptor.nodeId, 'Mech-Win');
    assert.equal(JSON.stringify((await (await request('nodes')).json()).nodes), before, 'reading a descriptor must not mutate node truth');
    // The descriptor normalises the role it projected, so a reader can tell a declared role from a defaulted one.
    assert.equal(mine.descriptor.roleSource, 'LEGACY_DEFAULT');
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the descriptor is computed at read time, so a sharing change and fresh telemetry are reflected at once', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc602-live-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request, node } = probe(app);
    const host = (await (await request('city')).json()).hostDeviceId;

    await node('register', legacyRegister(host, { displayName: 'Host' }));
    const first = (await (await request('nodes')).json()).nodeDescriptors[0];
    assert.equal(first.availability.acceptingWork, true);
    assert.equal(first.resources.observedAt, null);

    // The owner withdraws sharing: the descriptor must say so immediately, without a stored copy going stale.
    assert.equal((await request('node/sharing', { id: host, enabled: false }, 'ctl')).status, 200);
    const afterSharing = (await (await request('nodes')).json()).nodeDescriptors[0];
    assert.equal(afterSharing.availability.acceptingWork, false);
    assert.equal(afterSharing.availability.reason, 'SHARING_DISABLED_BY_OWNER');
    // Availability does not change what the node IS: it is still an execution resource, just not accepting work.
    assert.deepEqual([...afterSharing.roles], [...first.roles]);
    assert.equal(afterSharing.isExecutionResource, true);

    // An ONLINE node that cannot take work must not report acceptingWork. This is the exact self-contradiction
    // the first version of the projection produced (acceptingWork: true beside SHARING_DISABLED_BY_OWNER), so it
    // is asserted as a settled fact rather than left to the sharing case above.
    assert.equal(afterSharing.availability.state, 'ONLINE');
    // And the descriptor still states the two underlying facts separately, so a reader can tell "the owner
    // withdrew sharing" from "the node is offline" or "the node cannot run this class of work".
    assert.equal(afterSharing.availability.sharingEnabled, false);
    assert.equal(afterSharing.health.state, 'HEALTHY');

    // A heartbeat carrying real telemetry reaches the descriptor on the next read.
    const telemetry = { observedAt: new Date().toISOString(), cpu: { usagePercent: 4 }, memory: { usedBytes: 100, totalBytes: 200 }, disk: { usedBytes: 1, freeBytes: 2, totalBytes: 3 }, uptimeSeconds: 10 };
    assert.equal((await node('heartbeat', { id: host, telemetry })).status, 200);
    const afterTelemetry = (await (await request('nodes')).json()).nodeDescriptors[0];
    assert.equal(afterTelemetry.resources.observedAt, telemetry.observedAt);
    assert.equal(afterTelemetry.resources.memory.totalBytes.value, 200);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an unknown node has no descriptor, and a control surface is never among the node descriptors', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc602-scope-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request, node } = probe(app);
    await node('register', legacyRegister('Mech-Win'));

    // An id the City has never seen is a typed 404, exactly as the rest of the node route family behaves.
    assert.equal((await node('descriptor', { id: 'Not-A-Node' })).status, 404);

    // A control surface is not a node, so it does not appear in the node descriptor list at all — the
    // workbook's rule that Android must not be registered as a worker is satisfied by its ABSENCE here, not by
    // a role field someone could flip.
    const listed = await (await request('nodes')).json();
    assert.deepEqual(listed.nodeDescriptors.map(entry => entry.nodeId), ['Mech-Win']);
    assert.equal(listed.nodes.some(entry => entry.id === 'android-PERM00'), false);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('strict target still outranks every generic descriptor fact', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc602-strict-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request, node } = probe(app);
    await node('register', legacyRegister('Alien-Win'));
    await node('register', legacyRegister('Mech-Win'));

    // Two nodes that are, by descriptor, interchangeable: same roles, same capabilities, same (unknown)
    // resources. A generic capability/resource view therefore cannot tell them apart — and that is exactly
    // why it must never be allowed to override the user's target.
    const descriptors = (await (await request('nodes')).json()).nodeDescriptors;
    const shape = descriptor => JSON.stringify({ roles: descriptor.roles, capabilities: descriptor.capabilities, platform: descriptor.platform });
    assert.equal(shape(descriptors.find(entry => entry.nodeId === 'Alien-Win')), shape(descriptors.find(entry => entry.nodeId === 'Mech-Win')));

    const strict = await (await request('actions', {
      route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO',
      input: { targetDeviceRef: 'Mech-Win' }, idempotencyKey: 'wbc602-strict',
    })).json();
    const strictTaskId = strict.action?.backendRef?.taskId ?? strict.backendRef?.taskId;
    assert.ok(strictTaskId);

    // Alien, though equally capable and equally ready, is refused the task and told whose it is.
    const alienClaim = await (await node('claim', { id: 'Alien-Win' })).json();
    assert.equal(alienClaim.task, null);
    assert.equal(alienClaim.withheld.length, 1);
    assert.equal(alienClaim.withheld[0].heldFor, 'Mech-Win');
    // And the target device still gets it.
    assert.equal((await (await node('claim', { id: 'Mech-Win' })).json()).task.id, strictTaskId);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});
