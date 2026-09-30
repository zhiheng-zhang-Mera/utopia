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
