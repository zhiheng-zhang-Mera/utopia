// Conformance tests for RF-007 — versioned capability registry + addressing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AVAILABILITY_STATES, CapabilityError, DEFAULT_EXECUTION, EXCLUSIVITY, LOSS_REASONS,
  createCapabilityRegistry, parseCapabilityId,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const AT = ms => new Date(Date.parse(T0) + ms).toISOString();

function registryAt() {
  const state = { ms: 0 };
  const clock = () => AT(state.ms);
  clock.advance = ms => { state.ms += ms; return clock(); };
  return { registry: createCapabilityRegistry({ clock }), clock };
}

const CAMERA = 'camera.capture@1';
const SCREEN = 'screen.stream@1';

const advertiseCamera = (registry, overrides = {}) => registry.advertise({
  node_ref: 'device:phone-b',
  installation_ref: 'installation:phone',
  capability_id: CAMERA,
  supported_versions: [1],
  constraints: { max_width: 1920, max_height: 1080, requires_foreground: false },
  execution: { exclusivity: 'EXCLUSIVE', queueable: false, requires_live_session: true, default_expiry_ms: 30000 },
  endpoint_ref: 'endpoint:camera-1',
  adapter_ref: 'adapter:android-camera-v3',
  ...overrides,
});

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof CapabilityError, `expected a CapabilityError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('two heterogeneous devices advertise different implementations of one logical capability', () => {
  const { registry } = registryAt();
  assert.deepEqual(parseCapabilityId('camera.capture@1'), { capability_id: CAMERA, namespace: 'camera', name: 'capture', major: 1, device_specific: false, os_specific: false });
  assert.equal(parseCapabilityId('filesystem.read@2').name, 'read');
  assert.equal(failure(() => parseCapabilityId('phone_camera')).code, 'INVALID_CAPABILITY_ID');
  assert.equal(failure(() => parseCapabilityId('camera.capture')).code, 'INVALID_CAPABILITY_ID', 'an unversioned capability is not addressable');
  assert.equal(failure(() => parseCapabilityId('Camera.Capture@1')).code, 'INVALID_CAPABILITY_ID');
  assert.equal(failure(() => parseCapabilityId('camera.capture@0')).code, 'INVALID_CAPABILITY_ID');

  const phone = advertiseCamera(registry, { adapter_ref: 'adapter:android-camera-v3' });
  const desktop = advertiseCamera(registry, {
    node_ref: 'device:desktop-c',
    installation_ref: 'installation:desktop',
    adapter_ref: 'adapter:v4l2-capture',
    implementation_ref: 'impl:linux-v4l2',
    supported_versions: [1, 2],
    constraints: { max_width: 3840, max_height: 2160, requires_foreground: false },
  });
  assert.equal(phone.capability_id, CAMERA);
  assert.equal(desktop.capability_id, CAMERA, 'the same logical capability');
  assert.notEqual(phone.adapter_ref, desktop.adapter_ref);
  assert.equal(phone.device_class, null, 'a descriptor names no device class');
  assert.equal(phone.os_specific_method, null);
  assert.equal(phone.permission_granted, false);
  assert.equal(phone.advertisement_is_permission, false);
  assert.equal(phone.canonical_device_identity, 'device:phone-b', 'domain registries reference the canonical RF device identity');

  const lookup = registry.lookup({ capability_id: CAMERA });
  assert.equal(lookup.advertisement_count, 2);
  assert.equal(lookup.heterogeneous_implementations, true, 'different implementations under one logical capability');
  assert.equal(lookup.permission_granted, false);
  assert.deepEqual(lookup.advertisements.map(entry => entry.node_ref), ['device:phone-b', 'device:desktop-c']);
  assert.equal(failure(() => registry.lookup({ capability_id: SCREEN })).code, 'UNKNOWN_CAPABILITY');
  assert.equal(failure(() => registry.advertise({ node_ref: 'x', capability_id: CAMERA, supported_versions: [2], endpoint_ref: 'e', adapter_ref: 'a' })).code, 'INVALID_VERSIONS', 'the id major must be advertised');
  assert.equal(failure(() => registry.advertise({ node_ref: 'x', capability_id: CAMERA, supported_versions: [], endpoint_ref: 'e', adapter_ref: 'a' })).code, 'INVALID_VERSIONS');
});

test('callers resolve a compatible version without knowing the device class', () => {
  const { registry } = registryAt();
  advertiseCamera(registry);
  advertiseCamera(registry, { node_ref: 'device:desktop-c', adapter_ref: 'adapter:v4l2-capture', supported_versions: [1, 2] });

  const highest = registry.resolve({ capability_id: CAMERA });
  assert.equal(highest.found, true);
  assert.equal(highest.negotiated_major, 2, 'the highest mutually available major is chosen deterministically');
  assert.equal(highest.node_ref, 'device:desktop-c');
  assert.equal(highest.permission_granted, false, 'resolving grants nothing');
  assert.equal(highest.permission_decision_required, true);
  assert.equal(highest.capability_is_not_permission, true);
  assert.equal(highest.negotiated_deterministically, true);
  assert.equal(highest.device_class, null);

  const exact = registry.resolve({ capability_id: CAMERA, requested_major: 1 });
  assert.equal(exact.negotiated_major, 1);
  assert.equal(exact.candidate_count, 2, 'both nodes offer major 1, so the deterministic tie-break applies');
  assert.equal(exact.node_ref, 'device:desktop-c', 'tie-break by node_ref, then advertisement version');
  assert.equal(registry.resolve({ capability_id: CAMERA, requested_major: 2 }).node_ref, 'device:desktop-c');

  // Across trusted nodes only: an untrusted advertisement is examined but never chosen.
  const trustedOnly = registry.resolveAcrossTrusted({ capability_id: CAMERA, requested_major: 1, trusted_nodes: ['device:phone-b'] });
  assert.equal(trustedOnly.node_ref, 'device:phone-b');
  assert.equal(trustedOnly.candidates.some(candidate => candidate.node_ref === 'device:desktop-c' && candidate.trusted === false), true);
  assert.equal(failure(() => registry.resolveAcrossTrusted({ capability_id: CAMERA, trusted_nodes: [] })).code, 'INVALID_REQUEST');
  const untrusted = failure(() => registry.resolve({ capability_id: CAMERA, requested_major: 1, trusted_nodes: ['device:unrelated'] }));
  assert.equal(untrusted.code, 'NOT_TRUSTED');
  assert.equal(failure(() => registry.resolve({ capability_id: SCREEN })).code, 'UNKNOWN_CAPABILITY');

  // Constraints are honoured, and an unsatisfiable request is refused rather than downgraded.
  assert.equal(registry.resolve({ capability_id: CAMERA, requested_major: 1, constraints: { max_width: 1280 } }).found, true);
  const unsatisfied = failure(() => registry.resolve({ capability_id: CAMERA, requested_major: 1, constraints: { max_width: 7680 } }));
  assert.equal(unsatisfied.code, 'CONSTRAINT_UNSATISFIED');
  assert.equal(failure(() => registry.resolve({ capability_id: CAMERA, constraints: { max_width: 0 } })).code, 'INVALID_CONSTRAINTS');
  assert.equal(failure(() => registry.resolve({ capability_id: CAMERA, constraints: { zoom: 4 } })).code, 'INVALID_CONSTRAINTS');
});

test('an unsupported version fails explicitly instead of being coerced', () => {
  const { registry } = registryAt();
  advertiseCamera(registry);
  const incompatible = failure(() => registry.resolve({ capability_id: CAMERA, requested_major: 3 }));
  assert.equal(incompatible.code, 'INCOMPATIBLE_VERSION');
  assert.equal(incompatible.status, 409);
  assert.deepEqual(incompatible.supported_versions, [1]);
  assert.equal(incompatible.requested_major, 3);
  assert.equal(incompatible.coerced, false, 'no best-effort coercion');
  assert.equal(incompatible.best_effort_downgrade, false);
  assert.equal(incompatible.candidates.some(candidate => candidate.excluded_reason === 'INCOMPATIBLE_VERSION'), true);

  // Version 2 is offered by another node; asking for 3 still fails rather than picking 2.
  advertiseCamera(registry, { node_ref: 'device:desktop-c', adapter_ref: 'a2', supported_versions: [1, 2] });
  const stillIncompatible = failure(() => registry.resolve({ capability_id: CAMERA, requested_major: 3 }));
  assert.equal(stillIncompatible.code, 'INCOMPATIBLE_VERSION');
  assert.deepEqual(stillIncompatible.supported_versions, [1, 2]);
  assert.equal(failure(() => registry.invoke({ capability_id: CAMERA, requested_major: 3, permission_decision: { granted: true }, invocation_ref: 'i1' })).code, 'INCOMPATIBLE_VERSION');
});

test('capability loss invalidates new invocations and stays visible in state', () => {
  const { registry, clock } = registryAt();
  advertiseCamera(registry);
  assert.equal(registry.invoke({ capability_id: CAMERA, requested_major: 1, permission_decision: { granted: true, policy_ref: 'policy:user' }, invocation_ref: 'inv:before' }).executed, false);

  const lost = registry.withdraw({ node_ref: 'device:phone-b', capability_id: CAMERA, reason: 'OS_PERMISSION_REVOKED' });
  assert.equal(lost.availability, 'UNAVAILABLE');
  assert.equal(lost.visible_through_state, true);
  assert.equal(lost.new_invocations_invalidated, true);
  assert.equal(lost.loss.reason, 'OS_PERMISSION_REVOKED');
  assert.equal(lost.loss.previous_availability, 'AVAILABLE');
  assert.equal(lost.loss_reason, 'OS_PERMISSION_REVOKED', 'the loss reason is visible on the advertisement too');
  assert.deepEqual([...LOSS_REASONS].includes('HARDWARE_REMOVED'), true);
  assert.equal(failure(() => registry.withdraw({ node_ref: 'device:phone-b', capability_id: CAMERA, reason: 'BECAUSE' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => registry.withdraw({ node_ref: 'device:other', capability_id: CAMERA })).code, 'UNKNOWN_CAPABILITY');

  // The loss is visible in presence/capability state rather than the capability silently vanishing.
  const snapshot = registry.snapshot({ node_ref: 'device:phone-b' });
  assert.deepEqual(snapshot.available_capabilities, []);
  assert.equal(snapshot.capabilities.length, 1, 'the advertisement remains visible as unavailable');
  assert.equal(snapshot.loss_count, 1);
  assert.equal(snapshot.losses[0].reason, 'OS_PERMISSION_REVOKED');
  assert.equal(snapshot.capability_is_availability_metadata, true);
  assert.equal(snapshot.permission_granted, false);

  // New invocations fail, and resolving reports availability rather than a stale success.
  assert.equal(failure(() => registry.invoke({ capability_id: CAMERA, requested_major: 1, permission_decision: { granted: true }, invocation_ref: 'inv:after' })).code, 'CAPABILITY_UNAVAILABLE');
  const unavailable = failure(() => registry.resolve({ capability_id: CAMERA, requested_major: 1 }));
  assert.equal(unavailable.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(unavailable.availability[0].loss_reason, 'OS_PERMISSION_REVOKED');

  // Regaining the capability is a visible versioned change.
  const regained = advertiseCamera(registry, { availability: 'AVAILABLE' });
  assert.equal(regained.availability, 'AVAILABLE');
  assert.equal(regained.advertisement_version, 2, 're-advertising bumps the advertisement version');
  assert.equal(regained.advertisement_ref, lost.advertisement_ref, 'it is the same advertisement, versioned');
  assert.equal(regained.loss_reason, null);
  assert.equal(registry.invoke({ capability_id: CAMERA, requested_major: 1, permission_decision: { granted: true }, invocation_ref: 'inv:regained' }).ticket_ref.length > 0, true);

  // Expiry is also a loss of availability, reported honestly.
  clock.advance(400000);
  assert.equal(registry.snapshot({ node_ref: 'device:phone-b' }).available_capabilities.length, 0);
  const expired = failure(() => registry.resolve({ capability_id: CAMERA, requested_major: 1 }));
  assert.equal(expired.code, 'CAPABILITY_UNAVAILABLE');
});

test('exclusive/shared/background and live/queue metadata survive serialization and versioning', () => {
  const { registry } = registryAt();
  const advertisement = advertiseCamera(registry);
  assert.deepEqual(advertisement.execution, { exclusivity: 'EXCLUSIVE', queueable: false, requires_live_session: true, default_expiry_ms: 30000 });
  assert.deepEqual([...EXCLUSIVITY], ['EXCLUSIVE', 'SHARED', 'BACKGROUND_CAPABLE']);
  assert.deepEqual({ ...DEFAULT_EXECUTION }, { exclusivity: 'SHARED', queueable: false, requires_live_session: false, default_expiry_ms: null });

  // Defaults are applied, never invented per call site.
  const screen = registry.advertise({ node_ref: 'device:desktop-c', capability_id: SCREEN, supported_versions: [1], endpoint_ref: 'endpoint:screen', adapter_ref: 'adapter:webrtc-screen' });
  assert.deepEqual(screen.execution, { ...DEFAULT_EXECUTION });
  const background = registry.advertise({
    node_ref: 'device:node-d',
    capability_id: 'filesystem.read@1',
    supported_versions: [1],
    endpoint_ref: 'endpoint:fs',
    adapter_ref: 'adapter:node-fs',
    execution: { exclusivity: 'BACKGROUND_CAPABLE', queueable: true, requires_live_session: false, default_expiry_ms: 120000 },
  });
  assert.equal(background.execution.queueable, true);
  assert.equal(failure(() => registry.advertise({ node_ref: 'x', capability_id: CAMERA, supported_versions: [1], endpoint_ref: 'e', adapter_ref: 'a', execution: { exclusivity: 'SOMETIMES' } })).code, 'INVALID_EXECUTION');
  assert.equal(failure(() => registry.advertise({ node_ref: 'x', capability_id: CAMERA, supported_versions: [1], endpoint_ref: 'e', adapter_ref: 'a', execution: { priority: 'high' } })).code, 'INVALID_EXECUTION');

  // A wire round-trip preserves everything, including the execution metadata.
  const wire = registry.toWire({ node_ref: 'device:node-d', capability_id: 'filesystem.read@1' });
  const parsed = createCapabilityRegistry({ clock: () => T0 });
  const accepted = parsed.fromWire({ wire });
  assert.deepEqual(accepted.accepted_capabilities, ['filesystem.read@1']);
  assert.equal(accepted.execution_metadata_preserved, true);
  assert.equal(accepted.coerced, false);
  const restored = parsed.lookup({ capability_id: 'filesystem.read@1' }).advertisements[0];
  assert.deepEqual(restored.execution, background.execution, 'execution semantics survive serialization');
  assert.deepEqual(restored.supported_versions, [1]);
  assert.equal(restored.advertisement_version, background.advertisement_version);
  assert.equal(restored.adapter_ref, background.adapter_ref);
  assert.equal(restored.constraints.requires_foreground, undefined);

  // A wire payload from another contract version, or with tampered metadata, is refused.
  assert.equal(failure(() => parsed.fromWire({ wire: { wire_version: 99, capabilities: [] } })).code, 'INCOMPATIBLE_CONTRACT');
  assert.equal(failure(() => parsed.fromWire({ wire: { ...wire, capabilities: [{ ...wire.capabilities[0], execution: { exclusivity: 'WHATEVER' } }] } })).code, 'INVALID_WIRE');
  assert.equal(failure(() => parsed.fromWire({ wire: { ...wire, capabilities: [{ ...wire.capabilities[0], capability_id: 'not-a-capability' }] } })).code, 'INVALID_CAPABILITY_ID');
  assert.equal(failure(() => parsed.fromWire({})).code, 'INVALID_WIRE');
  assert.equal(failure(() => registry.toWire({ node_ref: 'device:none', capability_id: CAMERA })).code, 'UNKNOWN_CAPABILITY');
});

test('an advertised capability is availability metadata, never permission', () => {
  const { registry } = registryAt();
  advertiseCamera(registry);
  const resolved = registry.resolve({ capability_id: CAMERA, requested_major: 1 });
  assert.equal(resolved.permission_granted, false);
  assert.equal(registry.lookup({ capability_id: CAMERA }).permission_granted, false);
  assert.equal(registry.snapshot({ node_ref: 'device:phone-b' }).permission_granted, false);

  // Invocation requires an explicit permission decision, and the ticket is not an execution.
  assert.equal(failure(() => registry.invoke({ capability_id: CAMERA, requested_major: 1, invocation_ref: 'inv:1' })).code, 'PERMISSION_DECISION_REQUIRED');
  const denied = failure(() => registry.invoke({ capability_id: CAMERA, requested_major: 1, invocation_ref: 'inv:1', permission_decision: { granted: false, policy_ref: 'policy:owner' } }));
  assert.equal(denied.code, 'PERMISSION_NOT_GRANTED');
  assert.equal(denied.policy_ref, 'policy:owner');
  const ticket = registry.invoke({ capability_id: CAMERA, requested_major: 1, invocation_ref: 'inv:1', permission_decision: { granted: true, policy_ref: 'policy:owner' } });
  assert.equal(ticket.permission_granted, true);
  assert.equal(ticket.permission_policy_ref, 'policy:owner');
  assert.equal(ticket.executed, false, 'the registry does not execute; it addresses');
  assert.equal(ticket.external_side_effect, false);
  assert.equal(ticket.exclusive, true, 'execution semantics travel with the ticket');
  assert.equal(ticket.requires_live_session, true);
  assert.equal(ticket.queueable, false);
  assert.equal(ticket.default_expiry_ms, 30000);
  assert.equal(ticket.negotiated_major, 1);
  assert.equal(ticket.canonical_device_identity, 'device:phone-b');
  assert.equal(failure(() => registry.invoke({ capability_id: CAMERA, invocation_ref: '' })).code, 'INVALID_REQUEST');
  assert.throws(() => { ticket.executed = true; }, TypeError, 'tickets are frozen');
});

test('the registry is strict, frozen and free of ambient state', () => {
  const { registry } = registryAt();
  const advertisement = advertiseCamera(registry);
  assert.throws(() => { advertisement.availability = 'AVAILABLE'; }, TypeError);
  assert.equal(Object.isFrozen(advertisement.execution), true);
  assert.equal(failure(() => createCapabilityRegistry({ clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(failure(() => registry.advertise({ node_ref: '', capability_id: CAMERA, supported_versions: [1], endpoint_ref: 'e', adapter_ref: 'a' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => registry.advertise({ node_ref: 'x', capability_id: CAMERA, supported_versions: [1, 1], endpoint_ref: 'e', adapter_ref: 'a' })).code, 'INVALID_VERSIONS');
  assert.equal(failure(() => registry.advertise({ node_ref: 'x', capability_id: CAMERA, supported_versions: [1], endpoint_ref: 'e', adapter_ref: 'a', ttl_ms: 99999999 })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => registry.advertise({ node_ref: 'x', capability_id: CAMERA, supported_versions: [1], endpoint_ref: 'e', adapter_ref: 'a', availability: 'MAYBE' })).code, 'INVALID_REQUEST');
  assert.deepEqual([...AVAILABILITY_STATES], ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN']);

  const other = registryAt().registry;
  advertiseCamera(other);
  assert.equal(other.advertisements().length, 1);
  assert.equal(registry.advertisements().length, 1, 'registries share no state');
  assert.equal(registry.advertisements()[0].node_ref, 'device:phone-b');
  assert.equal(registry.journal().some(entry => entry.event === 'CAPABILITY_ADVERTISED'), true);
  assert.equal(registry.policy().policy_ref, 'policy:rf-capability-default');
  assert.equal(registry.parser === undefined, true);
});

// ---------------------------------------------------------------- Alien Correction regressions
// Each test below fails against the Development head and passes against the corrected head.

test('canonical execution metadata is decided by own keys, not the prototype chain', () => {
  const { registry } = registryAt();
  const advertiseWith = execution => () => registry.advertise({
    node_ref: 'device:proto', capability_id: CAMERA, supported_versions: [1],
    endpoint_ref: 'endpoint:proto', adapter_ref: 'adapter:proto', execution,
  });
  // `priority` is not on Object.prototype and was already refused; these names are inherited from
  // Object.prototype, so `key in DEFAULT_EXECUTION` used to accept them as canonical.
  for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.equal(failure(advertiseWith({ [key]: 'not-canonical' })).code, 'INVALID_EXECUTION', `${key} is not canonical execution metadata`);
  }
  assert.deepEqual(registry.advertisements(), [], 'no non-canonical execution metadata was admitted');
});

test('a malformed or impossible caller instant is refused as a typed error', () => {
  const { registry } = registryAt();
  const badInstants = ['garbage', '2026-01-01', '', '2026-13-45T99:99:99Z', 123, {}];
  for (const at of badInstants) {
    const refused = failure(() => registry.advertise({
      node_ref: 'device:clock', capability_id: CAMERA, supported_versions: [1],
      endpoint_ref: 'e', adapter_ref: 'a', at,
    }));
    assert.equal(refused.code, 'INVALID_REQUEST', `advertise at=${String(at)}`);
  }
  advertiseCamera(registry);
  for (const at of badInstants) {
    assert.equal(failure(() => registry.advertisements({ at })).code, 'INVALID_REQUEST', `advertisements at=${String(at)}`);
    assert.equal(failure(() => registry.resolve({ capability_id: CAMERA, at })).code, 'INVALID_REQUEST', `resolve at=${String(at)}`);
    assert.equal(failure(() => registry.lookup({ capability_id: CAMERA, at })).code, 'INVALID_REQUEST', `lookup at=${String(at)}`);
    assert.equal(failure(() => registry.snapshot({ node_ref: 'device:phone-b', at })).code, 'INVALID_REQUEST', `snapshot at=${String(at)}`);
    assert.equal(failure(() => registry.withdraw({ node_ref: 'device:phone-b', capability_id: CAMERA, at })).code, 'INVALID_REQUEST', `withdraw at=${String(at)}`);
    assert.equal(failure(() => registry.invoke({ capability_id: CAMERA, invocation_ref: 'inv:at', permission_decision: { granted: true }, at })).code, 'INVALID_REQUEST', `invoke at=${String(at)}`);
    assert.equal(failure(() => registry.fromWire({ wire: { wire_version: 1, capabilities: [] }, at })).code, 'INVALID_REQUEST', `fromWire at=${String(at)}`);
  }
  assert.throws(
    () => createCapabilityRegistry({ clock: () => '2026-13-45T99:99:99Z' }).advertisements(),
    error => error instanceof CapabilityError && error.code === 'INVALID_CLOCK',
    'a shape-valid but impossible clock instant is refused too',
  );
});

test('an expired advertisement cannot be invoked by naming an earlier instant', () => {
  const registry = createCapabilityRegistry({ clock: () => '2027-01-01T00:00:00Z' });
  registry.advertise({
    node_ref: 'device:phone-b', capability_id: CAMERA, supported_versions: [1],
    endpoint_ref: 'e', adapter_ref: 'a', at: '2026-01-01T00:00:00Z', ttl_ms: 1000,
  });
  const refused = failure(() => registry.invoke({
    capability_id: CAMERA, node_ref: 'device:phone-b', invocation_ref: 'inv:backdated',
    permission_decision: { granted: true, policy_ref: 'policy:user' },
    at: '2026-01-01T00:00:00.500Z',
  }));
  assert.equal(refused.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(refused.expired_at_requested_instant, false, 'the backdated instant alone would have allowed the invocation');
  assert.equal(refused.expired_at_registry_clock, true, 'the registry clock refuses it');
});

test('a refused wire payload leaves the registry untouched', () => {
  const { registry } = registryAt();
  const good = {
    node_ref: 'device:wire-a', capability_id: CAMERA, supported_versions: [1], advertisement_version: 1,
    availability: 'AVAILABLE', endpoint_ref: 'endpoint:a', adapter_ref: 'adapter:a',
    observed_at: T0, expires_at: '2026-01-01T01:00:00Z',
  };
  const refused = failure(() => registry.fromWire({
    wire: { wire_version: 1, capabilities: [good, { ...good, node_ref: 'device:wire-b', availability: 'NOT_A_STATE' }] },
  }));
  assert.equal(refused.code, 'INVALID_WIRE');
  assert.deepEqual(registry.advertisements(), [], 'no partially applied snapshot survived the refusal');
  assert.equal(registry.journal().some(entry => entry.event === 'WIRE_ACCEPTED'), false);
});

test('a wire snapshot may not replace newer state or silently clear a recorded loss', () => {
  const { registry } = registryAt();
  const advertised = advertiseCamera(registry, { at: T0, ttl_ms: 600000 });
  const wireOf = version => ({
    wire: {
      wire_version: 1,
      capabilities: [{
        advertisement_ref: advertised.advertisement_ref, advertisement_version: version,
        node_ref: 'device:phone-b', capability_id: CAMERA, supported_versions: [1],
        availability: 'AVAILABLE', endpoint_ref: 'endpoint:camera-1', adapter_ref: 'adapter:android-camera-v3',
        observed_at: T0, expires_at: '2026-01-01T01:00:00Z',
      }],
    },
  });

  registry.fromWire(wireOf(2));
  assert.equal(registry.advertisements()[0].advertisement_version, 2, 'a genuinely newer snapshot is accepted');
  assert.equal(failure(() => registry.fromWire(wireOf(1))).code, 'ADVERTISEMENT_VERSION_CONFLICT', 'an older snapshot may not overwrite a newer one');
  assert.equal(registry.advertisements()[0].advertisement_version, 2);

  registry.withdraw({ node_ref: 'device:phone-b', capability_id: CAMERA, reason: 'HARDWARE_REMOVED', at: T0 });
  assert.equal(registry.advertisements()[0].availability, 'UNAVAILABLE');
  assert.equal(failure(() => registry.fromWire(wireOf(2))).code, 'ADVERTISEMENT_VERSION_CONFLICT', 'a same-version replay may not clear a recorded loss');
  assert.equal(registry.advertisements()[0].availability, 'UNAVAILABLE', 'the recorded loss stayed visible');

  registry.fromWire(wireOf(3));
  assert.equal(registry.advertisements()[0].availability, 'AVAILABLE', 'a real regain carries a bumped version');
});

test('the wire path enforces the same validation as direct advertisement', () => {
  const { registry } = registryAt();
  const base = {
    node_ref: 'device:wire', capability_id: CAMERA, supported_versions: [1], advertisement_version: 1,
    availability: 'AVAILABLE', endpoint_ref: 'endpoint:w', adapter_ref: 'adapter:w',
    observed_at: T0, expires_at: '2026-01-01T01:00:00Z',
  };
  const send = overrides => () => registry.fromWire({ wire: { wire_version: 1, capabilities: [{ ...base, ...overrides }] } });

  assert.equal(failure(send({ supported_versions: ['x', 2] })).code, 'INVALID_WIRE', 'a version list advertise would refuse');
  assert.equal(failure(send({ supported_versions: [2] })).code, 'INVALID_WIRE', 'the id major must be offered');
  assert.equal(failure(send({ supported_versions: [1, 1] })).code, 'INVALID_WIRE', 'duplicate versions');
  assert.equal(failure(send({ supported_versions: [0] })).code, 'INVALID_WIRE', 'zero is not a major');
  assert.equal(failure(send({ advertisement_version: -5 })).code, 'INVALID_WIRE', 'advertisement versions are positive');
  assert.equal(failure(send({ advertisement_version: 1.5 })).code, 'INVALID_WIRE');
  assert.equal(failure(send({ node_ref: undefined })).code, 'INVALID_WIRE');
  assert.equal(failure(send({ endpoint_ref: undefined })).code, 'INVALID_WIRE');
  assert.equal(failure(send({ adapter_ref: undefined })).code, 'INVALID_WIRE');
  assert.equal(failure(send({ expires_at: undefined })).code, 'INVALID_WIRE', 'an advertisement with no expiry would never expire');
  assert.equal(failure(send({ expires_at: 'garbage' })).code, 'INVALID_WIRE');
  assert.equal(failure(send({ observed_at: 'garbage' })).code, 'INVALID_WIRE');
  assert.equal(failure(send({ capability_id: 'camera.capture' })).code, 'INVALID_CAPABILITY_ID');
  assert.deepEqual(registry.advertisements(), [], 'every refusal left state untouched');

  const duplicated = failure(() => registry.fromWire({ wire: { wire_version: 1, capabilities: [{ ...base }, { ...base }] } }));
  assert.equal(duplicated.code, 'INVALID_WIRE', 'one payload may not carry two current advertisements for one key');
  assert.deepEqual(registry.advertisements(), []);
});

test('a capability id whose major is not a safe integer is not addressable', () => {
  const { registry } = registryAt();
  const unbounded = `camera.capture@${'9'.repeat(400)}`;
  assert.equal(failure(() => parseCapabilityId(unbounded)).code, 'INVALID_CAPABILITY_ID', 'an unbounded digit run is not a version');
  assert.equal(failure(() => registry.lookup({ capability_id: unbounded })).code, 'INVALID_CAPABILITY_ID');
  assert.equal(failure(() => parseCapabilityId('camera.capture@9007199254740993')).code, 'INVALID_CAPABILITY_ID', 'a major beyond Number.MAX_SAFE_INTEGER must not be silently rounded');
});

test('a declared canonical execution field is never silently downgraded', () => {
  const { registry } = registryAt();
  const declared = {};
  Object.defineProperty(declared, 'exclusivity', { value: 'EXCLUSIVE', enumerable: false });
  const advertised = registry.advertise({
    node_ref: 'device:nonenum', capability_id: CAMERA, supported_versions: [1],
    endpoint_ref: 'endpoint:n', adapter_ref: 'adapter:n', execution: declared,
  });
  assert.equal(advertised.execution.exclusivity, 'EXCLUSIVE', 'a declared exclusivity must not be dropped for being non-enumerable');
  assert.equal(registry.invoke({ capability_id: CAMERA, node_ref: 'device:nonenum', invocation_ref: 'inv:n', permission_decision: { granted: true } }).exclusive, true);

  const smuggled = {};
  Object.defineProperty(smuggled, 'priority', { value: 'high', enumerable: false });
  assert.equal(failure(() => registry.advertise({
    node_ref: 'device:nonenum2', capability_id: CAMERA, supported_versions: [1],
    endpoint_ref: 'e', adapter_ref: 'a', execution: smuggled,
  })).code, 'INVALID_EXECUTION', 'a non-enumerable non-canonical key is still not canonical');
});

test('the advertisement TTL ceiling cannot be lifted by the caller', () => {
  for (const policy of [{ max_ttl_ms: Infinity }, { max_ttl_ms: 0 }, { max_ttl_ms: '3600000' }, { default_ttl_ms: 7200000, max_ttl_ms: 3600000 }, 'nonsense']) {
    assert.equal(failure(() => createCapabilityRegistry({ clock: () => T0, policy })).code, 'INVALID_REQUEST', `policy ${JSON.stringify(policy)}`);
  }
  const bounded = createCapabilityRegistry({ clock: () => T0, policy: { default_ttl_ms: 30000, max_ttl_ms: 60000 } });
  assert.equal(bounded.advertise({ node_ref: 'device:bounded', capability_id: CAMERA, supported_versions: [1], endpoint_ref: 'e', adapter_ref: 'a' }).expires_at, '2026-01-01T00:00:30.000Z', 'the configured default is honoured');
  const advertiseTtl = ttl_ms => () => bounded.advertise({ node_ref: 'device:bounded', capability_id: CAMERA, supported_versions: [1], endpoint_ref: 'e', adapter_ref: 'a', ttl_ms });
  assert.equal(failure(advertiseTtl(60001)).code, 'INVALID_REQUEST', 'a caller cannot exceed the configured ceiling');
  assert.equal(advertiseTtl(60000)().expires_at, '2026-01-01T00:01:00.000Z');
});

test('the advertisements() surface is frozen like every other descriptor surface', () => {
  const { registry } = registryAt();
  advertiseCamera(registry);
  const listed = registry.advertisements();
  assert.throws(() => { listed[0].permission_granted = true; }, TypeError);
  assert.throws(() => { listed[0].availability = 'UNAVAILABLE'; }, TypeError);
  assert.equal(registry.advertisements()[0].permission_granted, false, 'internal state is unaffected by a local edit attempt');
});
