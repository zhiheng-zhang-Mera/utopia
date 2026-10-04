// WBC-602 — Node Role / Capability / Resource Descriptor contract conformance and legacy translation.
//
// The tests that matter most here are the ones that try to BREAK backward compatibility: an old record with no
// new fields, a record with no telemetry, an entity that is not a node at all, and a task that asks for a
// resource nobody ever measured. Each has exactly one acceptable outcome, and "unavailable" is not it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LEGACY_ROLES,
  NODE_DESCRIPTOR_CONTRACT_VERSION,
  NODE_ROLES,
  NO_TASK_REQUIREMENTS,
  NodeDescriptorError,
  RESOURCE_KINDS,
  absent,
  assertNodeDescriptor,
  availabilityFrom,
  describeAndroidControlSurface,
  describeControlSurface,
  describeLegacyNode,
  explainRequirementFit,
  isExecutionEndpoint,
  measurement,
  nodeDescriptor,
  taskRequirements,
} from '../node-descriptor.mjs';

/** A node record exactly as the gateway wrote it BEFORE this contract existed. */
const legacyRecord = (overrides = {}) => ({
  id: 'Mech-Win',
  devicePrincipalId: 'Mech-Win',
  displayName: 'Mech-Win',
  metadata: { platform: 'win32' },
  agentVersion: '0.2.0',
  capabilities: ['task.execute.safe', 'filesystem.temp'],
  sharingEnabled: true,
  online: true,
  lastHeartbeatAt: '2026-10-05T00:00:00.000Z',
  ...overrides,
});

test('the role vocabulary is the one the workbook names, and the legacy default is narrow', () => {
  assert.deepEqual([...NODE_ROLES], ['EXECUTION_NODE', 'CONTROL_SURFACE', 'VALIDATION_NODE', 'SERVER_NODE', 'STORAGE_NODE', 'ACCELERATOR_NODE']);
  assert.deepEqual([...DEFAULT_LEGACY_ROLES], ['EXECUTION_NODE']);
  assert.deepEqual([...RESOURCE_KINDS], ['cpu', 'memory', 'disk', 'gpu', 'network']);
  assert.equal(NODE_DESCRIPTOR_CONTRACT_VERSION, 1);
  assert.throws(() => nodeDescriptor({ nodeId: 'n', roles: ['WORKER'] }), error => error.code === 'INVALID_ROLE');
});

test('an old node record with no new fields still yields a usable descriptor, and says the role was defaulted', () => {
  const descriptor = describeLegacyNode(legacyRecord());
  assertNodeDescriptor(descriptor);
  assert.equal(descriptor.nodeId, 'Mech-Win');
  assert.equal(descriptor.contractVersion, NODE_DESCRIPTOR_CONTRACT_VERSION);
  assert.deepEqual([...descriptor.roles], ['EXECUTION_NODE']);
  assert.equal(descriptor.roleSource, 'LEGACY_DEFAULT', 'a defaulted role must be distinguishable from a declared one');
  assert.equal(descriptor.isExecutionResource, true);
  assert.equal(isExecutionEndpoint(descriptor), true);
  assert.deepEqual([...descriptor.capabilities], ['filesystem.temp', 'task.execute.safe']);
  assert.equal(descriptor.availability.acceptingWork, true);
  assert.equal(descriptor.availability.state, 'ONLINE');
  assert.equal(descriptor.trustRef.authority, 'CITY_NODE_REGISTRY');
  assert.equal(descriptor.trustRef.descriptorIsNotAuthority, true);
});

test('the current Alien/Mech/Android role truth is expressible without registering Android as a worker', () => {
  const alien = describeLegacyNode(legacyRecord({ id: 'Alien-Win', roles: ['EXECUTION_NODE', 'VALIDATION_NODE'] }));
  const mech = describeLegacyNode(legacyRecord({ id: 'Mech-Win', roles: ['EXECUTION_NODE', 'VALIDATION_NODE'] }));
  const android = describeAndroidControlSurface({ clientRef: 'android-PERM00', clientLabel: 'Android PERM00' });
  assert.deepEqual([...alien.roles], ['EXECUTION_NODE', 'VALIDATION_NODE']);
  assert.deepEqual([...mech.roles], ['EXECUTION_NODE', 'VALIDATION_NODE']);
  assert.equal(alien.roleSource, 'DECLARED');
  assert.deepEqual([...android.roles], ['CONTROL_SURFACE']);
  assert.equal(android.roleSource, 'CONTROL_SURFACE_ONLY');
  assert.equal(android.isExecutionResource, false);
  assert.equal(android.platform, 'android');
  assert.equal(isExecutionEndpoint(android), false);
  // Two distinct worker identities stay distinct, and neither is identified by platform or display name.
  assert.notEqual(alien.nodeId, mech.nodeId);
  assert.equal(describeLegacyNode(legacyRecord({ id: 'X', displayName: 'Alien-Win' })).nodeId, 'X', 'a display name is not an identity');
});

test('a control surface can never be promoted to a worker by any field it carries', () => {
  // The negative control the workbook asks the review to attack: this must be refused by the CONTRACT, not by
  // the discipline of whoever builds the descriptor.
  assert.throws(() => nodeDescriptor({ nodeId: 'android-1', roles: ['CONTROL_SURFACE', 'EXECUTION_NODE'], isExecutionResource: false }), error => error.code === 'INVALID_ROLE');
  assert.throws(() => describeControlSurface({ clientRef: 'web-1' }) && assertNodeDescriptor({ ...describeControlSurface({ clientRef: 'web-1' }), roles: ['EXECUTION_NODE'] }), error => error.code === 'INVALID_ROLE');
  // Capabilities and resources do not change the answer either: a control surface that advertises the very
  // capabilities Utopia places work on is still not an execution endpoint.
  const loaded = describeControlSurface({ clientRef: 'android-2' });
  assert.equal(loaded.capabilities.length, 0);
  assert.equal(isExecutionEndpoint(loaded), false);
  assert.equal(isExecutionEndpoint({ ...loaded, capabilities: ['task.execute.safe', 'filesystem.temp'] }), false);
  assert.equal(isExecutionEndpoint(undefined), false);
  assert.equal(isExecutionEndpoint(null), false);
});

test('a missing measurement is UNKNOWN, never zero and never unavailable', () => {
  const noTelemetry = describeLegacyNode(legacyRecord());
  for (const kind of ['cpu', 'memory', 'disk']) {
    for (const [field, value] of Object.entries(noTelemetry.resources[kind])) {
      assert.equal(value.presence, 'UNKNOWN', `${kind}.${field} must be UNKNOWN when nothing was measured`);
      assert.equal(value.value, null);
      assert.ok(value.reason, `${kind}.${field} must state why it is unknown`);
    }
  }
  assert.equal(measurement(undefined).presence, 'UNKNOWN');
  assert.equal(measurement(null).presence, 'UNKNOWN');
  assert.equal(measurement(-1).reason, 'MALFORMED_MEASUREMENT', 'a negative measurement is malformed, not a small one');
  assert.equal(measurement(0).presence, 'KNOWN', 'a real zero is a real measurement');
  assert.equal(measurement(0).value, 0);
  assert.equal(absent().presence, 'UNSUPPORTED');
  // GPU is not modelled by this release, and the descriptor says so rather than reporting a measurement.
  assert.equal(noTelemetry.resources.gpu.presence, 'UNSUPPORTED');
});

test('real telemetry projects into the descriptor with its own timestamp, without inventing fields', () => {
  const record = legacyRecord({
    telemetry: {
      observedAt: '2026-10-05T00:00:05.000Z',
      cpu: { usagePercent: 12.5 },
      memory: { usedBytes: 8_000_000_000, totalBytes: 16_000_000_000 },
      disk: { usedBytes: null, freeBytes: 100_000_000_000, totalBytes: 500_000_000_000 },
      uptimeSeconds: 1234,
    },
  });
  const descriptor = describeLegacyNode(record);
  assert.equal(descriptor.resources.observedAt, '2026-10-05T00:00:05.000Z');
  assert.equal(descriptor.resources.memory.totalBytes.presence, 'KNOWN');
  assert.equal(descriptor.resources.memory.totalBytes.value, 16_000_000_000);
  assert.equal(descriptor.resources.cpu.loadPercent.value, 12.5);
  // The telemetry contract does not carry CPU cores, so the descriptor says UNKNOWN instead of guessing from
  // the platform or the hostname.
  assert.equal(descriptor.resources.cpu.cores.presence, 'UNKNOWN');
  assert.equal(descriptor.resources.disk.freeBytes.presence, 'KNOWN');
  assert.equal(descriptor.resources.disk.usedBytes.presence, 'UNKNOWN');
});

test('a task requirement is never satisfied or failed by telemetry nobody collected', () => {
  const requirements = taskRequirements({ requiredCapabilities: ['task.execute.safe'], resourceMinima: { memory: 8_000_000_000, cpu: 4 } });
  // No telemetry at all: the fit is UNDECIDED and says which resources are unknown. It does not say "no".
  const blind = explainRequirementFit(requirements, describeLegacyNode(legacyRecord()));
  assert.equal(blind.fits, false);
  assert.ok(blind.reasons.includes('RESOURCE_UNKNOWN:memory'));
  assert.ok(blind.reasons.includes('RESOURCE_UNKNOWN:cpu'));
  assert.equal(blind.decided, false, 'unknown resources mean no decision was taken');
  assert.equal(blind.schedulingAuthority, 'NONE');

  // Measured and sufficient: fits, no reasons.
  const measured = describeLegacyNode(legacyRecord({ telemetry: { observedAt: '2026-10-05T00:00:05.000Z', cpu: { usagePercent: 1 }, memory: { usedBytes: 1, totalBytes: 32_000_000_000 }, disk: { usedBytes: 1, freeBytes: 2, totalBytes: 3 } } }));
  const fits = explainRequirementFit(taskRequirements({ requiredCapabilities: ['task.execute.safe'], resourceMinima: { memory: 8_000_000_000 } }), measured);
  assert.equal(fits.fits, true);
  assert.deepEqual([...fits.reasons], []);

  // Measured and insufficient: that IS a decision, and it is a different one from "unknown".
  const small = explainRequirementFit(taskRequirements({ resourceMinima: { memory: 64_000_000_000 } }), measured);
  assert.ok(small.reasons.includes('RESOURCE_BELOW_MINIMUM:memory'));

  // Missing capability is the one requirement that IS decidable without telemetry.
  assert.ok(explainRequirementFit(taskRequirements({ requiredCapabilities: ['gpu.render'] }), measured).reasons.includes('MISSING_CAPABILITY:gpu.render'));
  // A control surface is never a fit for execution, whatever its capabilities say.
  assert.ok(explainRequirementFit(NO_TASK_REQUIREMENTS, describeAndroidControlSurface({ clientRef: 'android-1' })).reasons.includes('NOT_AN_EXECUTION_RESOURCE'));
  // A legacy task carries no requirements and asks for nothing.
  assert.deepEqual([...NO_TASK_REQUIREMENTS.requiredCapabilities], []);
  assert.equal(NO_TASK_REQUIREMENTS.requirementsAreOptional, true);
  assert.throws(() => taskRequirements({ resourceMinima: { memory: -1 } }), error => error.code === 'INVALID_REQUIREMENTS');
});

test('availability is told, not derived, and serialization/restart keeps the descriptor stable', () => {
  const offline = describeLegacyNode(legacyRecord({ online: false }), {
    availability: availabilityFrom({ acceptingWork: false, state: 'OFFLINE', reason: 'ENDPOINT_OFFLINE', sharingEnabled: true }),
  });
  assert.equal(offline.availability.acceptingWork, false);
  assert.equal(offline.availability.reason, 'ENDPOINT_OFFLINE');
  assert.equal(offline.health.state, 'UNREACHABLE');

  const sharedOff = describeLegacyNode(legacyRecord({ sharingEnabled: false }));
  assert.equal(sharedOff.availability.acceptingWork, false);
  assert.equal(sharedOff.availability.reason, 'SHARING_DISABLED_BY_OWNER');
  assert.equal(sharedOff.availability.sharingEnabled, false);

  // Stability: the descriptor survives a JSON round trip (a restart, a stored snapshot, a wire copy) unchanged,
  // which is what makes it safe to compare two observations of the same node.
  const first = describeLegacyNode(legacyRecord({ telemetry: { observedAt: '2026-10-05T00:00:05.000Z', cpu: { usagePercent: 3 }, memory: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, freeBytes: 1, totalBytes: 2 } } }));
  const roundTripped = JSON.parse(JSON.stringify(first));
  assert.deepEqual(roundTripped, first);
  assert.equal(first.resources.memory.totalBytes.value, roundTripped.resources.memory.totalBytes.value);
  // And the order of roles/capabilities never depends on the order they were supplied in.
  assert.deepEqual([...describeLegacyNode(legacyRecord({ roles: ['VALIDATION_NODE', 'EXECUTION_NODE'], capabilities: ['b', 'a'] })).roles], ['EXECUTION_NODE', 'VALIDATION_NODE']);
  assert.deepEqual([...describeLegacyNode(legacyRecord({ capabilities: ['b', 'a'] })).capabilities], ['a', 'b']);
});

test('descriptor validation refuses the shapes that would make a descriptor unusable', () => {
  assert.throws(() => assertNodeDescriptor(null), error => error instanceof NodeDescriptorError);
  assert.throws(() => assertNodeDescriptor({ contractVersion: 2, nodeId: 'n', roles: [], resources: {} }), error => error.code === 'INCOMPATIBLE_CONTRACT');
  assert.throws(() => assertNodeDescriptor({ contractVersion: 1, nodeId: 'n', roles: ['EXECUTION_NODE'], isExecutionResource: false, resources: {} }), error => error.code === 'INVALID_ROLE');
  assert.throws(() => assertNodeDescriptor({ contractVersion: 1, nodeId: 'n', roles: [], isExecutionResource: true, resources: {} }), error => error.code === 'INVALID_DESCRIPTOR');
  assert.throws(() => describeLegacyNode({ displayName: 'no id' }), error => error.code === 'INVALID_DESCRIPTOR');
  assert.throws(() => describeControlSurface({}), error => error.code === 'INVALID_DESCRIPTOR');
});
