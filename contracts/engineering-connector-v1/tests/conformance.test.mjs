// EM-002 conformance suite — connector adapter framework + managed-process runtime.
//
// Covers the workbook's acceptance lines: one malformed connector cannot prevent the others from
// loading; the runtime hosts at least two synthetic manifests with different capabilities;
// undeclared capability/method calls are refused; restarts are bounded and terminal safe mode
// exists; logs are bounded and secrets redactable by caller policy; and adding a connector is
// registration/manifest code rather than a foreman-core conditional.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 ADAPTER_STAGES, CAPABILITY_ENTRY_SPEC, CONNECTOR_CONTRACT_VERSION, CONNECTOR_FAILURE_CODES,
 ConnectorError, DEFAULT_REDACTION_POLICY, ENGINEERING_CONNECTOR_CONTRACT, PIPELINE_STAGES,
 RUNTIME_KINDS, RUNTIME_STATES, authorizeInvocation,
 createManagedProcessRuntime, createProcessPortDouble, declaredCapabilities, findRawSecretFields,
 loadConnectors, mediateConnectorPermissions, registerAdapter, runAdapterPipeline,
 validateConnectorManifest
} from '../index.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const T_LATER = '2026-09-30T12:01:00.000Z';
const T_MS = Date.parse(TS);
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const syntheticManifest = (overrides = {}) => ({
  connector_version: CONNECTOR_CONTRACT_VERSION,
  connector_kind: 'synthetic-alpha',
  display_name: 'Synthetic alpha worker',
  runtime_kind: 'NODE',
  entry_ref: 'workers/alpha.mjs',
  capabilities: [{ capability_id: 'engineering.execute', capability_version: 1, methods: ['run'] }],
  needs: [{ need_id: 'engineering.execute.invoke', reason: 'runs the requested job' }],
  limits: { startup_timeout_ms: 5000, heartbeat_interval_ms: 30000, max_restarts: 2, max_log_bytes: 64 },
  provenance: { detection_evidence: 'alpha marker found', selected_adapter_ref: 'adapter-alpha', runtime_kind: 'NODE' },
  ...overrides,
});

const goodAdapter = (overrides = {}) => registerAdapter({
  adapter_ref: 'adapter-alpha',
  runtime_kind: 'NODE',
  detector: () => ({ matched: true, score: 10, evidence: 'alpha marker found' }),
  adapt: () => ({ raw: 'alpha' }),
  validate: () => true,
  standardize: () => syntheticManifest(),
  ...overrides,
});

/* ------------------------------------------------- 1. manifest & mediation */

test('a connector manifest declares runtime, capabilities, needs and budgets', () => {
  const manifest = syntheticManifest();
  assert.deepEqual(validateConnectorManifest(manifest), { ok: true, errors: [] });
  assert.deepEqual(declaredCapabilities(manifest), ['engineering.execute@1']);
  assert.deepEqual([...RUNTIME_KINDS], ['NODE', 'PYTHON', 'EXE', 'CLI']);
  assert.equal(validateConnectorManifest(syntheticManifest({ runtime_kind: 'RUBY' })).ok, false);
  assert.equal(validateConnectorManifest(syntheticManifest({ capabilities: [] })).ok, false);
  assert.equal(validateConnectorManifest(syntheticManifest({ capabilities: [{ capability_id: 'a', capability_version: 1, methods: [] }] })).ok, false);
  assert.equal(validateConnectorManifest(syntheticManifest({ connector_version: 9 })).ok, false);
  assert.equal(validateConnectorManifest(syntheticManifest({ mood: 'happy' })).ok, false);
  assert.equal(validateConnectorManifest(syntheticManifest({ limits: { startup_timeout_ms: 0, heartbeat_interval_ms: 1, max_restarts: 0, max_log_bytes: 1 } })).ok, false);
});

test('a connector manifest has no credential slot, and raw secrets are refused', () => {
  // A manifest declares *needs*; it never carries a credential. Because every object in the
  // contract is strict, a credential or secret slot is refused as an undeclared field, which is
  // stronger than allowing a slot and sanitising it later.
  assert.equal(validateConnectorManifest(syntheticManifest({ credential_ref: 'secure-handle://1' })).ok, false);
  assert.equal(validateConnectorManifest(syntheticManifest({ needs: [{ need_id: 'x', reason: 'y', access_token: 'raw' }] })).ok, false);
  assert.equal(validateConnectorManifest(syntheticManifest({ provenance: { detection_evidence: 'x', selected_adapter_ref: 'a', runtime_kind: 'NODE', api_key: 'raw' } })).ok, false);
  // the raw-secret scan is defence in depth for any future permissive field, including nested
  assert.deepEqual(findRawSecretFields({ a: { b: { api_key: 'x' } } }, ''), ['.a.b.api_key']);
  assert.deepEqual(findRawSecretFields({ credential_ref: 'h', session_handle: 'h' }, ''), []);
  assert.equal(DEFAULT_REDACTION_POLICY.patterns.length, 0);
});

test('policy decides permissions and an adapter can never grant itself one', () => {
  const manifest = syntheticManifest();
  const mediated = mediateConnectorPermissions(manifest, { granted: ['engineering.execute.invoke'], refused: [{ need_id: 'network.bind', code: 'NOT_ALLOWED' }] });
  assert.deepEqual([...mediated.granted], ['engineering.execute.invoke']);
  assert.deepEqual(mediated.refused, [{ need_id: 'network.bind', code: 'NOT_ALLOWED' }]);
  assert.equal(mediated.adapterGrantsAuthority, false);
  assert.equal(mediated.effectiveIsIntersection, true);
  // a grant outside the declaration is refused rather than silently accepted
  expectCode(() => mediateConnectorPermissions(manifest, { granted: ['ssh.root'] }), 'UNDECLARED_NEED_GRANT');
  // a need nobody decided stays visibly undecided
  assert.deepEqual([...mediateConnectorPermissions(syntheticManifest(), {}).undecided], ['engineering.execute.invoke']);
});

test('undeclared capability or method calls are refused', () => {
  const manifest = syntheticManifest();
  const permission = mediateConnectorPermissions(manifest, { granted: ['engineering.execute.invoke'] });
  assert.deepEqual(authorizeInvocation(manifest, permission, { capabilityId: 'engineering.execute', method: 'run' }).method, 'run');
  expectCode(() => authorizeInvocation(manifest, permission, { capabilityId: 'engineering.delete-repo', method: 'run' }), 'CAPABILITY_NOT_DECLARED');
  expectCode(() => authorizeInvocation(manifest, permission, { capabilityId: 'engineering.execute', method: 'destroy' }), 'METHOD_NOT_DECLARED');
  // a declared capability whose need was not granted is refused too
  const ungranted = mediateConnectorPermissions(manifest, {});
  expectCode(() => authorizeInvocation(manifest, ungranted, { capabilityId: 'engineering.execute', method: 'run' }), 'UNDECLARED_NEED_GRANT');
});

/* ------------------------------------------------- 2. adapter pipeline */

test('the pipeline runs detect, select, adapt, validate, standardize and unify', () => {
  const result = runAdapterPipeline({ adapters: [goodAdapter()], observation: { marker: 'alpha' } });
  assert.deepEqual([...PIPELINE_STAGES], ['DETECT', 'SELECT', 'ADAPT', 'VALIDATE', 'STANDARDIZE', 'UNIFY']);
  assert.deepEqual([...ADAPTER_STAGES], ['detector', 'adapt', 'validate', 'standardize']);
  assert.equal(result.selected, 'adapter-alpha');
  assert.equal(result.unified.length, 1);
  assert.deepEqual(result.failures, []);
  // provenance is written by the pipeline, so an adapter cannot forge it
  assert.equal(result.unified[0].provenance.selected_adapter_ref, 'adapter-alpha');
  assert.equal(result.unified[0].provenance.detection_evidence, 'alpha marker found');
  assert.equal(result.unified[0].provenance.runtime_kind, 'NODE');
});

test('one malformed connector cannot prevent another connector from loading', () => {
  const throwing = registerAdapter({
    adapter_ref: 'adapter-broken',
    runtime_kind: 'CLI',
    detector: () => { throw Object.assign(new Error('detector exploded'), { code: 'BOOM' }); },
    adapt: () => ({}),
    validate: () => true,
    standardize: () => syntheticManifest(),
  });
  const invalidDetector = registerAdapter({
    adapter_ref: 'adapter-invalid-detector',
    runtime_kind: 'PYTHON',
    detector: () => 'not an object',
    adapt: () => ({}),
    validate: () => true,
    standardize: () => syntheticManifest(),
  });
  const invalidStandardizer = registerAdapter({
    adapter_ref: 'adapter-invalid-manifest',
    runtime_kind: 'EXE',
    detector: () => ({ matched: true, score: 5, evidence: 'broken manifest' }),
    adapt: () => ({}),
    validate: () => true,
    standardize: () => ({ connector_version: 1, connector_kind: 'broken' }),
  });
  const loading = loadConnectors({
    adapters: [throwing, invalidDetector, invalidStandardizer, goodAdapter()],
    observations: [{ marker: 'alpha' }],
  });
  assert.equal(loading.loaded, 1, 'the healthy connector still loaded');
  assert.equal(loading.unified[0].connector_kind, 'synthetic-alpha');
  const codes = loading.failures.map(failure => failure.code);
  assert.equal(codes.includes('ADAPTER_DETECT_FAILED'), true);
  assert.equal(codes.includes('ADAPTER_INVALID_OUTPUT'), true);
  assert.equal(codes.every(code => CONNECTOR_FAILURE_CODES.includes(code)), true);
  // and every failure names the stage that produced it
  assert.equal(loading.failures.every(failure => typeof failure.stage === 'string' && failure.adapter_ref !== undefined), true);
  // a malformed manifest from the *winning* adapter is caught at UNIFY, again as data
  const onlyBad = loadConnectors({ adapters: [invalidStandardizer], observations: [{ marker: 'broken' }] });
  assert.equal(onlyBad.loaded, 0);
  assert.equal(onlyBad.failures.some(failure => failure.stage === 'UNIFY' && failure.code === 'INVALID_CONNECTOR_MANIFEST'), true);
  // and the healthy connector still loads on its own
  assert.equal(loadConnectors({ adapters: [goodAdapter()], observations: [{ marker: 'alpha' }] }).loaded, 1);
  assert.equal(ENGINEERING_CONNECTOR_CONTRACT.adapter_fault_isolation, true);
});

test('loading two synthetic connectors with different capabilities needs no core change', () => {
  const beta = {
    connector_version: CONNECTOR_CONTRACT_VERSION,
    connector_kind: 'synthetic-beta',
    display_name: 'Synthetic beta worker',
    runtime_kind: 'PYTHON',
    entry_ref: 'workers/beta.py',
    capabilities: [
      { capability_id: 'engineering.test', capability_version: 1, methods: ['run-tests'] },
      { capability_id: 'engineering.report', capability_version: 2, methods: ['summarise'] },
    ],
    needs: [{ need_id: 'engineering.test.invoke', reason: 'runs the suite' }],
    limits: { startup_timeout_ms: 8000, heartbeat_interval_ms: 15000, max_restarts: 1, max_log_bytes: 128 },
    provenance: { detection_evidence: 'beta marker found', selected_adapter_ref: 'adapter-beta', runtime_kind: 'PYTHON' },
  };
  const betaAdapter = registerAdapter({
    adapter_ref: 'adapter-beta',
    runtime_kind: 'PYTHON',
    detector: observation => ({ matched: observation?.marker === 'beta', score: 7, evidence: 'beta marker found' }),
    adapt: () => ({ raw: 'beta' }),
    validate: () => ({ ok: true }),
    standardize: () => beta,
  });
  const alphaAdapter = registerAdapter({
    adapter_ref: 'adapter-alpha',
    runtime_kind: 'NODE',
    detector: observation => ({ matched: observation?.marker === 'alpha', score: 7, evidence: 'alpha marker found' }),
    adapt: () => ({ raw: 'alpha' }),
    validate: () => true,
    standardize: () => syntheticManifest(),
  });
  const loading = loadConnectors({ adapters: [betaAdapter, alphaAdapter], observations: [{ marker: 'alpha' }, { marker: 'beta' }] });
  assert.equal(loading.loaded, 2);
  assert.deepEqual(loading.unified.map(manifest => manifest.connector_kind).sort(), ['synthetic-alpha', 'synthetic-beta']);
  assert.deepEqual(declaredCapabilities(loading.unified.find(manifest => manifest.connector_kind === 'synthetic-beta')), ['engineering.report@2', 'engineering.test@1']);
  assert.equal(ENGINEERING_CONNECTOR_CONTRACT.new_connector_requires_core_change, false);
  // selection is a declared rule, not a per-connector conditional: the higher score wins
  const higher = registerAdapter({
    adapter_ref: 'adapter-alpha-loud',
    runtime_kind: 'NODE',
    detector: () => ({ matched: true, score: 99, evidence: 'louder match' }),
    adapt: () => ({}),
    validate: () => true,
    standardize: () => syntheticManifest({ connector_kind: 'synthetic-alpha-loud' }),
  });
  assert.equal(runAdapterPipeline({ adapters: [alphaAdapter, higher], observation: {} }).selected, 'adapter-alpha-loud');
  expectCode(() => registerAdapter({ adapter_ref: 'x', runtime_kind: 'NODE', detector: () => ({}), adapt: () => ({}), validate: () => true }), 'INVALID_ADAPTER_REGISTRATION');
  expectCode(() => loadConnectors({ adapters: [], observations: 'not-an-array' }), 'INVALID_ADAPTER_REGISTRATION');
  assert.equal(runAdapterPipeline({ adapters: [], observation: {} }).noAdapterSelected, true);
  assert.equal(new ConnectorError('X', 'y').status, 400);
});

/* ------------------------------------------------- 3. managed-process runtime */

test('the runtime hosts two synthetic connectors with different capabilities', () => {
  const port = createProcessPortDouble({ script: [{ ready: true }, { ready: true }] });
  const runtime = createManagedProcessRuntime({ spawnProcess: port, clock: () => TS });
  const alpha = runtime.start({ manifest: syntheticManifest(), instanceRef: 'instance-alpha', policyDecision: { granted: ['engineering.execute.invoke'], refused: [] } });
  const betaManifest = syntheticManifest({
    connector_kind: 'synthetic-beta', runtime_kind: 'PYTHON', entry_ref: 'workers/beta.py',
    capabilities: [{ capability_id: 'engineering.test', capability_version: 1, methods: ['run-tests'] }],
    needs: [],
  });
  const beta = runtime.start({ manifest: betaManifest, instanceRef: 'instance-beta' });
  assert.equal(alpha.started, true);
  assert.equal(beta.started, true);
  assert.deepEqual(runtime.listInstances(), ['instance-alpha', 'instance-beta']);
  assert.equal(runtime.invoke('instance-alpha', { capabilityId: 'engineering.execute', method: 'run' }).ok, true);
  assert.equal(runtime.invoke('instance-beta', { capabilityId: 'engineering.test', method: 'run-tests' }).ok, true);
  // capabilities do not leak between instances
  expectCode(() => runtime.invoke('instance-beta', { capabilityId: 'engineering.execute', method: 'run' }), 'CAPABILITY_NOT_DECLARED');
  const provenance = runtime.provenance('instance-alpha');
  assert.deepEqual(provenance.granted_permissions, ['engineering.execute.invoke']);
  assert.equal(provenance.runtime_kind, 'NODE');
  assert.equal(provenance.selected_adapter_ref, 'adapter-alpha');
  assert.equal(provenance.host, 'local');
  assert.equal(ENGINEERING_CONNECTOR_CONTRACT.runtime_kinds.length, 4);
});

test('startup is bounded and a process that never becomes ready is stopped, not awaited', () => {
  const port = createProcessPortDouble({ script: [{ ready: false, reason: 'no ready signal' }] });
  const runtime = createManagedProcessRuntime({ spawnProcess: port, clock: () => TS });
  const started = runtime.start({ manifest: syntheticManifest(), instanceRef: 'instance-slow' });
  assert.equal(started.started, false);
  assert.equal(started.code, 'STARTUP_TIMEOUT');
  assert.equal(runtime.state('instance-slow').state, 'DEGRADED');
  assert.equal(port.__spawned.length, 1);
  expectCode(() => runtime.invoke('instance-slow', { capabilityId: 'engineering.execute', method: 'run' }), 'RUNTIME_NOT_STARTED');
  assert.equal(runtime.state('instance-slow').failures.some(failure => failure.code === 'STARTUP_TIMEOUT'), true);
});

test('a failing spawn is data, and a failing invocation does not crash the runtime', () => {
  const port = createProcessPortDouble({ script: [{ throws: 'ENOENT' }] });
  const runtime = createManagedProcessRuntime({ spawnProcess: port, clock: () => TS });
  const started = runtime.start({ manifest: syntheticManifest(), instanceRef: 'instance-missing' });
  assert.equal(started.started, false);
  assert.equal(started.code, 'PROCESS_SPAWN_FAILED');
  assert.equal(runtime.state('instance-missing').state, 'DEGRADED');

  const failing = createProcessPortDouble({ script: [{ ready: true }], responses: { 'engineering.execute.run': { throws: 'EXIT_1' } } });
  const runtime2 = createManagedProcessRuntime({ spawnProcess: failing, clock: () => TS });
  runtime2.start({ manifest: syntheticManifest(), instanceRef: 'instance-fail', policyDecision: { granted: ['engineering.execute.invoke'] } });
  const result = runtime2.invoke('instance-fail', { capabilityId: 'engineering.execute', method: 'run' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXIT_1');
  assert.equal(runtime2.state('instance-fail').state, 'READY', 'the runtime survives one failed invocation');
  assert.equal(runtime2.getLogs('instance-fail').entries.some(entry => entry.text.includes('failed')), true);
});

test('heartbeat freshness is bounded by the manifest interval', () => {
  const port = createProcessPortDouble({ script: [{ ready: true }] });
  const runtime = createManagedProcessRuntime({ spawnProcess: port, clock: () => TS });
  runtime.start({ manifest: syntheticManifest(), instanceRef: 'instance-hb' });
  assert.equal(runtime.checkHealth('instance-hb', { now: T_MS + 1000 }).stale, false);
  const stale = runtime.checkHealth('instance-hb', { now: T_MS + 60_000 });
  assert.equal(stale.stale, true);
  assert.equal(stale.code, 'HEARTBEAT_LOST');
  assert.equal(stale.state, 'DEGRADED');
  // a heartbeat restores readiness
  assert.equal(runtime.heartbeat('instance-hb', { at: T_LATER }).state, 'READY');
  assert.equal(runtime.checkHealth('instance-hb', { now: Date.parse(T_LATER) + 10 }).stale, false);
});

test('restarts are bounded and exhaustion is a terminal safe mode', () => {
  const port = createProcessPortDouble({ script: [{ ready: true }, { ready: true }, { ready: true }, { ready: true }, { ready: true }] });
  const runtime = createManagedProcessRuntime({ spawnProcess: port, clock: () => TS });
  runtime.start({ manifest: syntheticManifest(), instanceRef: 'instance-loop' });
  assert.equal(runtime.restart('instance-loop', { reason: 'health' }).restarted, true);
  assert.equal(runtime.restart('instance-loop', { reason: 'health' }).restarted, true);
  const exhausted = runtime.restart('instance-loop', { reason: 'health' });
  assert.equal(exhausted.restarted, false);
  assert.equal(exhausted.code, 'RESTART_BUDGET_EXHAUSTED');
  assert.equal(exhausted.state, 'SAFE_MODE');
  // safe mode is terminal: start, invoke and restart all refuse
  expectCode(() => runtime.start({ manifest: syntheticManifest(), instanceRef: 'instance-loop' }), 'RUNTIME_IN_SAFE_MODE');
  expectCode(() => runtime.invoke('instance-loop', { capabilityId: 'engineering.execute', method: 'run' }), 'RUNTIME_IN_SAFE_MODE');
  assert.equal(runtime.restart('instance-loop').code, 'RUNTIME_IN_SAFE_MODE');
  assert.equal(runtime.checkHealth('instance-loop').state, 'SAFE_MODE');
  // clearing it is an explicit operator action, and it resets the budget
  expectCode(() => runtime.clearSafeMode('instance-loop', {}), 'RUNTIME_IN_SAFE_MODE');
  const cleared = runtime.clearSafeMode('instance-loop', { operatorRef: 'owner', at: T_LATER });
  assert.equal(cleared.state, 'STOPPED');
  assert.equal(runtime.state('instance-loop').restarts, 0);
  expectCode(() => runtime.clearSafeMode('instance-loop', { operatorRef: 'owner' }), 'RUNTIME_IN_SAFE_MODE');
  assert.equal(ENGINEERING_CONNECTOR_CONTRACT.terminal_safe_mode, true);
  assert.equal(ENGINEERING_CONNECTOR_CONTRACT.restart_budget_is_bounded, true);
});

test('logs are bounded by the manifest and redactable by caller policy', () => {
  const port = createProcessPortDouble({ script: [{ ready: true }] });
  const runtime = createManagedProcessRuntime({ spawnProcess: port, clock: () => TS });
  runtime.start({ manifest: syntheticManifest(), instanceRef: 'instance-log' });
  runtime.setRedactionPolicy('instance-log', { patterns: [/ghp_[A-Za-z0-9]+/g, 'super-secret'], replacement: '[redacted]' });
  runtime.appendLog('instance-log', { stream: 'STDOUT', text: `token ghp_abcdef123456 and super-secret value`, at: TS });
  const logs = runtime.getLogs('instance-log');
  assert.equal(logs.entries.some(entry => entry.text.includes('ghp_abcdef123456')), false);
  assert.equal(logs.entries.some(entry => entry.text.includes('super-secret')), false);
  assert.equal(logs.entries.some(entry => entry.text.includes('[redacted]')), true);
  assert.equal(ENGINEERING_CONNECTOR_CONTRACT.caller_policy_may_redact, true);

  // the budget is enforced, and truncation is reported rather than hidden
  const small = runtime.start({ manifest: syntheticManifest({ connector_kind: 'synthetic-small', limits: { startup_timeout_ms: 1000, heartbeat_interval_ms: 1000, max_restarts: 0, max_log_bytes: 16 } }), instanceRef: 'instance-small' });
  assert.equal(small.started, true);
  runtime.appendLog('instance-small', { stream: 'STDOUT', text: 'x'.repeat(100), at: TS });
  const bounded = runtime.getLogs('instance-small');
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.bytes <= 16, true);
  assert.equal(bounded.entries.reduce((total, entry) => total + entry.text.length, 0) <= 16, true);
  const refused = runtime.appendLog('instance-small', { stream: 'STDOUT', text: 'more', at: TS });
  assert.equal(refused.appended, false);
  expectCode(() => runtime.appendLog('instance-small', { stream: 'SECRETS', text: 'x', at: TS }), 'INVALID_CONNECTOR_MANIFEST');
  assert.equal(ENGINEERING_CONNECTOR_CONTRACT.logs_are_bounded, true);
});

test('runtime lifecycle is honest about state and unknown instances', () => {
  const port = createProcessPortDouble({ script: [{ ready: true }] });
  const runtime = createManagedProcessRuntime({ spawnProcess: port, clock: () => TS });
  expectCode(() => runtime.state('instance-missing'), 'RUNTIME_NOT_STARTED');
  expectCode(() => runtime.invoke('instance-missing', { capabilityId: 'x', method: 'y' }), 'RUNTIME_NOT_STARTED');
  runtime.start({ manifest: syntheticManifest(), instanceRef: 'instance-stop' });
  assert.equal(runtime.stop('instance-stop').state, 'STOPPED');
  assert.equal(runtime.checkHealth('instance-stop').stale, false);
  expectCode(() => runtime.invoke('instance-stop', { capabilityId: 'engineering.execute', method: 'run' }), 'RUNTIME_NOT_STARTED');
  expectCode(() => createManagedProcessRuntime({ spawnProcess: {} }), 'PROCESS_SPAWN_FAILED');
  assert.deepEqual([...RUNTIME_STATES], ['STOPPED', 'STARTING', 'READY', 'DEGRADED', 'SAFE_MODE']);
  assert.equal(CAPABILITY_ENTRY_SPEC.methods.required, true);
});
