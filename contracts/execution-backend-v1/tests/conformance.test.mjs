// WBC-601 — Execution Backend Contract v1 conformance.
//
// These tests pin the parts of the contract that make the seam *checkable* rather than merely present: the
// version, the profile vocabulary, and the rule that a backend must be a complete port before it may be
// registered. They deliberately do not test any behaviour of STANDARD_DEVICES — that lives beside the
// implementation, because a contract test that asserts an implementation's policy stops being a contract test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_KINDS,
  BACKEND_MODES,
  DEFAULT_EXECUTION_PROFILE,
  EXECUTION_BACKEND_CONTRACT_VERSION,
  EXECUTION_BACKEND_CODES,
  EXECUTION_PROFILES,
  ExecutionBackendError,
  READINESS_STATES,
  REQUIRED_PORT_METHODS,
  assertExecutionBackendPort,
  createExecutionBackendRegistry,
  describeExecutionBackend,
  describeReadiness,
  executionEndpoint,
} from '../execution-backend.mjs';

const conformingPort = (overrides = {}) => ({
  contractVersion: EXECUTION_BACKEND_CONTRACT_VERSION,
  backendId: 'standard-devices',
  kind: 'DEVICE_FLEET',
  profile: DEFAULT_EXECUTION_PROFILE,
  mode: 'enabled',
  readiness: () => describeReadiness({ state: 'READY' }),
  endpoints: () => [],
  dispatch: () => ({ task: null }),
  claim: () => ({ task: null }),
  report: () => ({ task: null }),
  control: () => ({ task: null }),
  ...overrides,
});

test('the default profile is STANDARD_DEVICES and the future profiles are declared but not default', () => {
  assert.equal(DEFAULT_EXECUTION_PROFILE, 'STANDARD_DEVICES');
  assert.deepEqual([...EXECUTION_PROFILES], ['STANDARD_DEVICES', 'WORKER_POOL', 'HYBRID']);
  assert.equal(EXECUTION_BACKEND_CONTRACT_VERSION, 1);
  assert.deepEqual([...BACKEND_KINDS], ['DEVICE_FLEET', 'WORKER_POOL', 'COMPOSITE']);
  assert.deepEqual([...BACKEND_MODES], ['enabled', 'dormant']);
  assert.ok(READINESS_STATES.includes('ABSENT'), 'an absent future backend needs its own honest word');
  assert.ok(EXECUTION_BACKEND_CODES.includes('BACKEND_DORMANT'));
  assert.deepEqual([...REQUIRED_PORT_METHODS], ['readiness', 'endpoints', 'dispatch', 'claim', 'report', 'control']);
});

test('a port must be complete before it may be registered, and the missing piece is named', () => {
  // A backend that cannot report results is not a backend, however well it can dispatch.
  const { report, ...incomplete } = conformingPort();
  assert.throws(() => assertExecutionBackendPort(incomplete), error => {
    assert.ok(error instanceof ExecutionBackendError);
    assert.equal(error.code, 'INVALID_BACKEND');
    assert.match(error.message, /report/);
    return true;
  });
  assert.throws(() => assertExecutionBackendPort(conformingPort({ contractVersion: 2 })), error => {
    assert.equal(error.code, 'INCOMPATIBLE_CONTRACT');
    return true;
  });
  assert.throws(() => assertExecutionBackendPort(conformingPort({ backendId: 'Standard Devices' })), error => {
    assert.equal(error.code, 'INVALID_BACKEND');
    return true;
  });
  assert.throws(() => assertExecutionBackendPort(conformingPort({ profile: 'SERVER_FARM' })), error => {
    assert.equal(error.code, 'INVALID_PROFILE');
    return true;
  });
  assert.throws(() => assertExecutionBackendPort(conformingPort({ mode: 'maybe' })), error => {
    assert.equal(error.code, 'INVALID_BACKEND');
    return true;
  });
  // The conforming port is returned unchanged, so callers may wire `assertExecutionBackendPort(x)` inline.
  const port = conformingPort();
  assert.equal(assertExecutionBackendPort(port), port);
});

test('readiness refuses to be silent: only READY may omit a reason, and a bad state is typed', () => {
  assert.equal(describeReadiness({ state: 'READY' }).ready, true);
  assert.equal(describeReadiness({ state: 'READY' }).usable, true);
  assert.equal(describeReadiness({ state: 'DEGRADED', reason: 'ONE_ENDPOINT_DOWN' }).usable, true);
  assert.equal(describeReadiness({ state: 'DEGRADED', reason: 'ONE_ENDPOINT_DOWN' }).ready, false);
  // An unexplained non-ready state is exactly the kind of status a surface cannot render honestly.
  assert.throws(() => describeReadiness({ state: 'UNAVAILABLE' }), error => error.code === 'INVALID_BACKEND');
  assert.throws(() => describeReadiness({ state: 'FINE' }), error => error.code === 'INVALID_BACKEND');
});

test('a registry refuses a second backend for one profile and names the owner', () => {
  const registry = createExecutionBackendRegistry();
  registry.register(conformingPort());
  assert.equal(registry.active().backendId, 'standard-devices');
  assert.deepEqual(registry.profiles(), ['STANDARD_DEVICES']);
  // WORKER_POOL exists as a name but nobody serves it: asking must not fall back to the Windows devices.
  assert.throws(() => registry.forProfile('WORKER_POOL'), error => {
    assert.equal(error.code, 'PROFILE_NOT_REGISTERED');
    assert.equal(error.status, 404);
    return true;
  });
  assert.throws(() => registry.register(conformingPort({ backendId: 'second-devices' })), error => {
    assert.equal(error.code, 'INVALID_BACKEND');
    assert.match(error.message, /standard-devices/);
    return true;
  });
  assert.throws(() => registry.get('nope'), error => error.code === 'UNKNOWN_BACKEND');
});

test('a dormant backend is registered but may never serve ordinary work', () => {
  const registry = createExecutionBackendRegistry();
  registry.register(conformingPort({ backendId: 'workbench-pool', profile: 'WORKER_POOL', kind: 'WORKER_POOL', mode: 'dormant' }));
  registry.register(conformingPort());
  assert.equal(registry.forProfile('WORKER_POOL').mode, 'dormant');
  assert.throws(() => registry.active('WORKER_POOL'), error => {
    assert.equal(error.code, 'BACKEND_DORMANT');
    assert.equal(error.status, 409);
    return true;
  });
  // The default is unaffected by a dormant registration beside it.
  assert.equal(registry.active().profile, 'STANDARD_DEVICES');
  const described = registry.list();
  assert.deepEqual(described.map(entry => entry.backendId).sort(), ['standard-devices', 'workbench-pool']);
  assert.equal(described.find(entry => entry.backendId === 'workbench-pool').canExecute, false);
  assert.equal(describeExecutionBackend(registry.forProfile('STANDARD_DEVICES')).canExecute, true);
});

test('one backend may not silently change the profile it serves', () => {
  const registry = createExecutionBackendRegistry();
  registry.register(conformingPort());
  assert.throws(() => registry.register(conformingPort({ profile: 'HYBRID' })), error => {
    assert.equal(error.code, 'INVALID_BACKEND');
    return true;
  });
});

test('an execution endpoint view states that it is a worker, never a control surface', () => {
  const row = executionEndpoint({ endpointRef: 'Mech-Win', capabilities: ['task.execute.safe'] });
  assert.equal(row.endpointRef, 'Mech-Win');
  assert.equal(row.displayName, 'Mech-Win');
  assert.equal(row.isWorker, true);
  assert.equal(row.isControlSurface, false);
  assert.equal(row.ready, false);
  assert.equal(row.sharingEnabled, true, 'legacy nodes have no sharing flag and must default to sharing');
  assert.throws(() => executionEndpoint({}), error => error.code === 'INVALID_REQUEST');
});
