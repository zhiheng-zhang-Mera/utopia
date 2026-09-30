// Conformance tests for RF-010 鈥?Fabric policy boundary + public API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_BOUNDARIES, FabricError, POLICY_AXES, PUBLIC_PORTS, TRANSPORT_ADAPTER, createFabricApi, intersectPolicy,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const DEVICE = 'device:phone';
const SESSION = 'session:1';

/** A mock adapter and a "real/local" adapter must both satisfy the same public API. */
function adapterFor(kind) {
  const calls = { discover: 0, connect: 0, invoke: 0, subscribe: 0, openStream: 0, disconnect: 0, pair: 0 };
  const devices = [{ device_ref: DEVICE, installation_ref: 'installation:1', presence_state: 'ONLINE' }];
  const capabilities = [{ capability_id: 'camera.capture@1', capability_version: 1 }, { capability_id: 'filesystem.read@1', capability_version: 1 }];
  return {
    kind,
    calls,
    transport: {
      discover() { calls.discover += 1; return kind === 'mock' ? devices : devices.map(device => ({ ...device, transport_hint: 'lan' })); },
      pair() { calls.pair += 1; return { trust_state: 'TRUSTED', pairing_ref: 'pairing:1' }; },
      connect({ device_ref }) { calls.connect += 1; return { session_ref: SESSION, device_ref, transport_class: kind === 'mock' ? 'MOCK' : 'LAN_DIRECT' }; },
      listCapabilities() { return capabilities; },
      invoke() { calls.invoke += 1; return { invocation_ref: 'invocation:1', result_ref: 'result:1' }; },
      subscribe() { calls.subscribe += 1; return { accepted: true }; },
      openStream() { calls.openStream += 1; return { accepted: true }; },
      getPresence({ device_ref }) { return device_ref === DEVICE ? { state: 'ONLINE', last_seen_at: T0 } : { state: 'UNKNOWN', last_seen_at: null }; },
      disconnect() { calls.disconnect += 1; return { disconnected: true }; },
    },
  };
}

const allowAll = { evaluate: () => ({ owner_user: true, caller_assistant: true, device_capability: true, task_action_grant: true }) };
const denyAxis = axis => ({ evaluate: () => ({ owner_user: true, caller_assistant: true, device_capability: true, task_action_grant: true, [axis]: false }) });

const apiWith = ({ kind = 'mock', policy = allowAll, transport = null } = {}) => {
  const adapter = adapterFor(kind);
  const api = createFabricApi({ transport: transport ?? adapter.transport, policy, clock: () => T0 });
  return { api, adapter };
};

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof FabricError, `expected a FabricError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('the public surface is frozen and a mock or real adapter satisfies it unchanged', () => {
  assert.deepEqual([...PUBLIC_PORTS], ['discover', 'pair', 'connect', 'resolveDevice', 'listCapabilities', 'invoke', 'subscribe', 'openStream', 'getPresence', 'revokeDevice', 'disconnect']);
  assert.equal(TRANSPORT_ADAPTER.upper_layers_may_depend_on_concrete_transport, false);
  assert.equal(TRANSPORT_ADAPTER.exposes_transport_specifics, false);
  assert.deepEqual([...POLICY_AXES], ['OWNER_USER', 'CALLER_ASSISTANT', 'DEVICE_CAPABILITY', 'TASK_ACTION_GRANT']);

  // The same caller code runs against both adapters and sees the same normalized surface.
  const runAgainst = kind => {
    const { api, adapter } = apiWith({ kind });
    const discovered = api.discover({ query: { kind: 'ANY' } });
    const device = api.resolveDevice({ device_ref: DEVICE });
    const capabilities = api.listCapabilities({ device_ref: DEVICE });
    const session = api.connect({ device_ref: DEVICE, capability_id: 'camera.capture@1' });
    const invoked = api.invoke({ device_ref: DEVICE, capability_id: 'camera.capture@1', session_ref: session.session_ref, action_ref: 'action:1' });
    const subscription = api.subscribe({ device_ref: DEVICE, topic: 'capability.changed' });
    const stream = api.openStream({ device_ref: DEVICE, capability_id: 'filesystem.read@1' });
    const presence = api.getPresence({ device_ref: DEVICE });
    return { api, adapter, discovered, device, capabilities, session, invoked, subscription, stream, presence };
  };
  const mock = runAgainst('mock');
  const real = runAgainst('local');

  for (const run of [mock, real]) {
    assert.equal(run.device.canonical_device_identity, DEVICE);
    assert.equal(run.capabilities.capabilities.length, 2);
    assert.equal(run.session.authenticated, true);
    assert.equal(run.invoked.policy_granted, true);
    assert.equal(run.subscription.is_rpc, false);
    assert.equal(run.stream.state, 'OPEN');
    assert.equal(run.presence.reachable, true);
  }
  // Transport hints never leak through the boundary.
  assert.equal(JSON.stringify(mock.discovered).includes('transport_hint'), false);
  assert.equal(real.discovered.devices[0].transport_hint, undefined, 'the adapter had a transport hint but the public result does not expose it');
  assert.equal(mock.discovered.transport_specifics_exposed, false);
  assert.equal(real.invoked.transport_specifics_exposed, false);
  assert.equal(mock.session.transport_class, 'HIDDEN_FROM_CALLER');
  assert.equal(JSON.stringify(mock.api.boundary()).includes('LAN'), false);
  assert.equal(mock.api.boundary().transport_specifics_exposed, false);
  assert.equal(ADAPTER_BOUNDARIES.UTOPIA_ACTION_ROOM.owns_task_orchestration, false);
  assert.equal(ADAPTER_BOUNDARIES.BUTLER_EMBODIMENT_BUS.owns_task_ownership, false);
  assert.equal(ADAPTER_BOUNDARIES.GAI_ENDPOINT.owns_provider_registry, false);
  assert.equal(ADAPTER_BOUNDARIES.ENGINEERING_CONNECTOR.owns_connector_registry, false);
  assert.equal(failure(() => createFabricApi({ transport: {} })).code, 'INVALID_ADAPTER');
  assert.equal(failure(() => createFabricApi({ transport: adapterFor('mock').transport, clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(failure(() => createFabricApi({ transport: adapterFor('mock').transport, policy: {} })).code, 'INVALID_POLICY');
});

test('policy denial stays a denial even on a perfect authenticated session', () => {
  const session = apiWith().api;
  const denied = apiWith({ policy: denyAxis('owner_user') });
  const connected = denied.api.connect({ device_ref: DEVICE });
  assert.equal(connected.authenticated, true, 'the session is perfectly valid');
  assert.equal(connected.session_is_permission, false);

  const refusal = failure(() => denied.api.invoke({ device_ref: DEVICE, capability_id: 'camera.capture@1', session_ref: connected.session_ref, action_ref: 'action:1' }));
  assert.equal(refusal.code, 'POLICY_DENIED');
  assert.equal(refusal.denied_axes.includes('OWNER_USER'), true);
  assert.equal(refusal.session_valid, true);
  assert.equal(refusal.denied_despite_valid_session, true, 'a valid session does not soften a policy denial');
  assert.equal(refusal.executed, false);
  assert.equal(denied.adapter.calls.invoke, 0, 'the transport was never asked to act');

  // Every axis is required, and each missing axis is named.
  for (const axis of ['owner_user', 'caller_assistant', 'device_capability', 'task_action_grant']) {
    const partial = apiWith({ policy: denyAxis(axis) });
    const attempt = failure(() => partial.api.invoke({ device_ref: DEVICE, capability_id: 'camera.capture@1' }));
    assert.equal(attempt.code, 'POLICY_DENIED', `${axis} must be required`);
    assert.equal(attempt.denied_axes.length, 1);
  }

  // Presence and trusted-device state contribute nothing on their own.
  const decision = intersectPolicy({ ownerUser: true, callerAssistant: true, deviceCapability: true, taskActionGrant: false, session: 'AUTHENTICATED', presence: 'ONLINE' });
  assert.equal(decision.granted, false);
  assert.equal(decision.session_is_permission, false);
  assert.equal(decision.presence_is_permission, false);
  assert.equal(decision.trusted_device_is_permission, false);
  assert.equal(decision.foreground_is_permission, false);
  assert.equal(decision.permission_is_intersectional, true);
  assert.deepEqual(decision.denied_axes, ['TASK_ACTION_GRANT']);
  assert.equal(intersectPolicy({ ownerUser: true, callerAssistant: true, deviceCapability: true, taskActionGrant: true }).granted, true);
});

test('an advertised capability without effective permission cannot execute', () => {
  const denied = apiWith({ policy: denyAxis('device_capability') });
  const listed = denied.api.listCapabilities({ device_ref: DEVICE });
  assert.equal(listed.capabilities.some(capability => capability.capability_id === 'camera.capture@1'), true, 'the capability is advertised');
  assert.equal(listed.capability_is_availability_metadata, true);
  assert.equal(listed.permission_granted, false);
  assert.equal(listed.capabilities[0].advertisement_is_permission, false);
  assert.equal(failure(() => denied.api.invoke({ device_ref: DEVICE, capability_id: 'camera.capture@1' })).code, 'POLICY_DENIED');
  assert.equal(denied.adapter.calls.invoke, 0);

  // An unadvertised capability is refused before policy even matters.
  const allowed = apiWith();
  const missing = failure(() => allowed.api.invoke({ device_ref: DEVICE, capability_id: 'telepathy.read@1' }));
  assert.equal(missing.code, 'CAPABILITY_NOT_ADVERTISED');
  assert.equal(missing.advertised, false);
  assert.equal(failure(() => allowed.api.invoke({ device_ref: DEVICE, capability_id: 'camera.capture@1', capability_version: 2 })).code, 'NOT_SUPPORTED_BY_VERSION');
  assert.equal(allowed.adapter.calls.invoke, 0);
});

test('foreground-sensitive resources are enforced locally without Fabric deciding ownership', () => {
  const { api, adapter } = apiWith();
  const first = api.invoke({ device_ref: DEVICE, capability_id: 'camera.capture@1', resource_class: 'CAMERA', action_ref: 'action:camera-a' });
  assert.equal(first.policy_granted, true);
  assert.equal(first.fabric_owns_task_ownership, false);

  // An exclusive foreground resource cannot be taken by a second action.
  const conflict = failure(() => api.invoke({ device_ref: DEVICE, capability_id: 'camera.capture@1', resource_class: 'CAMERA', action_ref: 'action:camera-b' }));
  assert.equal(conflict.code, 'FOREGROUND_CONFLICT');
  assert.equal(conflict.foreground_owner, 'action:camera-a');
  assert.equal(conflict.fabric_decides_ownership, false, 'Fabric enforces the device-local rule, it does not choose an owner');

  // Releasing the claim lets the other action proceed, and only the holder may release it.
  assert.equal(failure(() => api.releaseForeground({ device_ref: DEVICE, action_ref: 'action:someone-else' })).code, 'FOREGROUND_CONFLICT');
  assert.equal(api.releaseForeground({ device_ref: DEVICE, action_ref: 'action:camera-a' }).released, true);
  assert.equal(api.invoke({ device_ref: DEVICE, capability_id: 'camera.capture@1', resource_class: 'CAMERA', action_ref: 'action:camera-b' }).policy_granted, true);
  assert.equal(api.releaseForeground({ device_ref: DEVICE }).released, true);
  assert.equal(api.releaseForeground({ device_ref: DEVICE }).released, false, 'releasing an unheld resource is a no-op, not an error');

  // A capability requiring local confirmation surfaces that instead of executing.
  const confirming = createFabricApi({
    transport: {
      ...adapterFor('mock').transport,
      listCapabilities: () => [{ capability_id: 'camera.capture@1', capability_version: 1, requires_user_confirmation: true }],
    },
    policy: allowAll,
    clock: () => T0,
  });
  const needsConfirmation = failure(() => confirming.invoke({ device_ref: DEVICE, capability_id: 'camera.capture@1', resource_class: 'CAMERA', action_ref: 'action:c' }));
  assert.equal(needsConfirmation.code, 'USER_CONFIRMATION_REQUIRED');
  assert.equal(needsConfirmation.delivered_locally, true);
  assert.equal(needsConfirmation.executed, false);

  // A non-foreground resource needs no claim at all.
  const plain = api.invoke({ device_ref: DEVICE, capability_id: 'filesystem.read@1', resource_class: 'FILES', action_ref: 'action:read' });
  assert.equal(plain.policy_granted, true);
  assert.equal(adapter.calls.invoke >= 3, true);
});

test('Fabric holds no task graph, no assistant state and no competing identity namespace', () => {
  const { api } = apiWith();
  const boundary = api.boundary();
  assert.equal(boundary.fabric_owns_task_truth, false);
  assert.equal(boundary.fabric_owns_assistant_state, false);
  assert.equal(boundary.fabric_decides_task_ownership, false);
  assert.equal(boundary.fabric_decides_assistant_ownership, false);
  assert.equal(boundary.fabric_chooses_best_device, false, 'choosing the best device is an orchestration decision');
  assert.equal(boundary.fabric_reasons_or_plans, false);
  assert.equal(boundary.canonical_device_namespace, 'REMOTE_FABRIC_DEVICE');
  assert.equal(boundary.upper_layers_must_reference_canonical_identity, true);
  assert.equal(boundary.session_is_permission, false);

  assert.equal(failure(() => api.storeTaskGraph()).code, 'FABRIC_DOES_NOT_OWN_TASK_TRUTH');
  assert.equal(failure(() => api.storeTaskGraph()).owned_by, 'SHARED_TASK_CORE');
  assert.equal(failure(() => api.storeAssistantState()).code, 'FABRIC_DOES_NOT_OWN_ASSISTANT_STATE');
  assert.equal(failure(() => api.storeAssistantState()).owned_by, 'ASSISTANT_CORE');

  // Resolving with a competing namespace is refused rather than tolerated.
  const competing = failure(() => api.resolveDevice({ device_ref: DEVICE, competing_namespace: 'PHONE_CAMERA_V2' }));
  assert.equal(competing.code, 'COMPETING_IDENTITY_NAMESPACE');
  assert.equal(competing.canonical_namespace, 'REMOTE_FABRIC_DEVICE');
  const resolved = api.resolveDevice({ device_ref: DEVICE });
  assert.equal(resolved.address_is_identity, false);
  assert.equal(resolved.identity_is_network_derived, false);

  // A handoff or foreground change transfers no ownership and no permission.
  const session = api.connect({ device_ref: DEVICE });
  const invoked = api.invoke({ device_ref: DEVICE, capability_id: 'filesystem.read@1', session_ref: session.session_ref, action_ref: 'action:x' });
  assert.equal(invoked.fabric_owns_task_ownership, false);
  assert.equal(invoked.fabric_owns_assistant_state, false);
  const disconnected = api.disconnect({ device_ref: DEVICE, session_ref: session.session_ref });
  assert.equal(disconnected.task_ownership_changed, false);
  assert.equal(disconnected.trust_revoked, false, 'disconnecting is not revoking');
  assert.equal(disconnected.device_still_trusted, true);
  assert.equal(api.sessions().length, 0);

  // Revocation is what removes the device, and it closes sessions and streams.
  const second = apiWith();
  const stream = second.api.openStream({ device_ref: DEVICE, capability_id: 'filesystem.read@1' });
  assert.equal(stream.state, 'OPEN');
  const revoked = second.api.revokeDevice({ device_ref: DEVICE, reason: 'USER_REVOKED' });
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.sessions_closed, true);
  assert.equal(revoked.requires_revocation_not_just_disconnect, true);
  assert.equal(second.adapter.calls.disconnect, 1);
  const afterRevocation = failure(() => second.api.connect({ device_ref: DEVICE }));
  assert.equal(afterRevocation.code, 'DEVICE_REVOKED');
  assert.equal(afterRevocation.session_would_not_help, true);
  assert.equal(failure(() => second.api.getPresence({ device_ref: DEVICE })).code, 'DEVICE_REVOKED');
  assert.equal(second.api.getPresence({ device_ref: 'device:other' }).state, 'UNKNOWN', 'an unknown device is reported honestly');
});

test('integration seams are recorded without importing a sibling branch', () => {
  const { api } = apiWith();
  const seams = api.integrationSeams();
  assert.equal(seams.seams.length, 12, 'RF-001..RF-009 plus BA-003/BA-008/BA-009');
  assert.deepEqual(seams.seams.slice(0, 9).map(seam => seam.task), ['RF-001', 'RF-002', 'RF-003', 'RF-004', 'RF-005', 'RF-006', 'RF-007', 'RF-008', 'RF-009']);
  assert.deepEqual(seams.seams.slice(9).map(seam => seam.task), ['BA-003', 'BA-008', 'BA-009']);
  assert.equal(seams.sibling_branches_imported, 0);
  assert.equal(seams.fabric_depends_on_unfinished_siblings, false);
  assert.equal(seams.seams.find(seam => seam.task === 'RF-009').consumed_as.includes('reachability only'), true);
  assert.equal(seams.seams.find(seam => seam.task === 'BA-009').consumed_as.includes('policy'), true);

  // The boundary is frozen and the module holds no ambient state.
  assert.throws(() => { api.boundary().fabric_owns_task_truth = true; }, TypeError);
  assert.throws(() => { seams.seams[0].task = 'RF-999'; }, TypeError);
  const other = apiWith().api;
  assert.equal(other.sessions().length, 0);
  assert.equal(api.publicPorts().length, 11);
  assert.equal(api.apiVersion(), 1);
  assert.equal(api.transportAdapter().interface, 'FabricTransportAdapter');
  assert.equal(api.transportAdapter().methods.includes('invoke'), true);
  assert.equal(api.policyConfig().policy_ref, 'policy:rf-fabric-default');
  // The journal records the calls this instance actually served.
  const journalSession = api.connect({ device_ref: DEVICE });
  api.invoke({ device_ref: DEVICE, capability_id: 'filesystem.read@1', resource_class: 'FILES', session_ref: journalSession.session_ref, action_ref: 'action:journal' });
  assert.equal(api.journal().some(entry => entry.event === 'INVOKED'), true);
  assert.equal(failure(() => api.resolveDevice({})).code, 'INVALID_REQUEST');
  assert.equal(failure(() => api.subscribe({ device_ref: DEVICE })).code, 'INVALID_REQUEST');
});
