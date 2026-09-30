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
 findRawSecretValues, findReservedKeyPaths, isSecretFieldName, normalizeFieldName,
 loadConnectors, mediateConnectorPermissions, registerAdapter, runAdapterPipeline, validateConnectorManifest
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

/* ---------------------------------------------------------------------------
 * CORRECTION (host Alien, EM-002 Correction stage) — adversarial regressions.
 *
 * Every assertion below failed before the repair. The theme is the same one that has
 * now recurred in six contracts in this repository: guards that test the *spelling*
 * of a name, the *presence* of a key, or an adapter's *own claim*, rather than the
 * property they exist to protect.
 * --------------------------------------------------------------------------- */

test('undeclared keys inherited from Object.prototype are refused at every level', () => {
  const clean = syntheticManifest();
  assert.equal(validateConnectorManifest(clean).ok, true, 'the control manifest is accepted');
  // `key in spec` walked the prototype chain, so every one of these was a canonical field.
  for (const key of ['toString', 'valueOf', 'hasOwnProperty', 'constructor', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
    const result = validateConnectorManifest({ ...clean, [key]: 'SMUGGLED' });
    assert.equal(result.ok, false, `manifest.${key} must not be accepted`);
    assert.ok(result.errors.some((error) => error.includes(key)), JSON.stringify(result.errors));
  }
  // Nested, one level down: the same checkShape runs for each sub-spec.
  assert.equal(validateConnectorManifest({ ...clean, limits: { ...clean.limits, toString: 'x' } }).ok, false);
  assert.equal(validateConnectorManifest({ ...clean, provenance: { ...clean.provenance, hasOwnProperty: 'x' } }).ok, false);
  assert.equal(validateConnectorManifest({ ...clean, capabilities: [{ ...clean.capabilities[0], valueOf: 'x' }] }).ok, false);
  assert.equal(validateConnectorManifest({ ...clean, needs: [{ ...clean.needs[0], constructor: 'x' }] }).ok, false);
  // A `__proto__` own key arrives as data; `JSON.parse` is how.
  const rawOwnProto = JSON.parse(JSON.stringify(clean).replace('{', '{"__proto__":{"isAdmin":true},'));
  assert.equal(validateConnectorManifest(rawOwnProto).ok, false);
  assert.equal(findReservedKeyPaths(JSON.parse('{"a":{"__proto__":{"x":1}}}')).length, 1);
  assert.deepEqual(findReservedKeyPaths({ a: 1 }), []);
});

test('a secret-shaped name is refused in its plural and compound spellings', () => {
  const caught = ['token', 'credential', 'api_key', 'apiKey', 'credentials', 'tokens', 'secrets',
    'apiKeys', 'api_keys', 'privateKeys', 'sessionKeys', 'refreshTokens', 'accessTokens',
    'authToken', 'bearerToken', 'clientSecret', 'accountCredential', 'tokenValue', 'passwordHash'];
  for (const key of caught) {
    assert.equal(isSecretFieldName(key), true, `${key} must be treated as secret-shaped`);
    assert.equal(findRawSecretFields({ [key]: 'RAW' }).length, 1, `${key} must be caught`);
  }
  // The reference forms the contract allows are still allowed.
  for (const key of ['credential_ref', 'api_key_handle', 'access_token_id', 'session_handle', 'token_id']) {
    assert.equal(isSecretFieldName(key), false, `${key} is a permitted reference`);
    assert.deepEqual(findRawSecretFields({ [key]: 'handle:x' }), []);
  }
  // Value-aware in one direction only: a secret-shaped name holding a number is a quantity.
  assert.deepEqual(findRawSecretFields({ max_tokens: 4096, input_tokens: 10 }), []);
  assert.equal(findRawSecretFields({ max_tokens: 'many' }).length, 1);
  assert.equal(normalizeFieldName('authToken'), 'auth_token');
});

test('raw credential bytes are refused in any field, not only a secret-shaped one', () => {
  const live = 'sk-live-9f8e7d6c5b4a39281706';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  const clean = syntheticManifest();
  // Both of these are DECLARED text fields, so a name scan alone never inspects them - even though
  // `entry_ref` names a connector entry point and `detection_evidence` lands in auditable provenance.
  for (const [label, patch] of [
    ['display_name', { display_name: live }],
    ['entry_ref', { entry_ref: live }],
    ['provenance.detection_evidence (jwt)', { provenance: { ...clean.provenance, detection_evidence: jwt } }],
    ['provenance.detection_evidence (pem)', { provenance: { ...clean.provenance, detection_evidence: pem } }],
  ]) {
    const result = validateConnectorManifest({ ...clean, ...patch });
    assert.equal(result.ok, false, `${label} must be refused`);
    assert.ok(result.errors.some((error) => error.includes('raw credential bytes')), JSON.stringify(result.errors));
  }
  assert.deepEqual(findRawSecretValues({ entry_ref: 'workers/alpha.mjs', display_name: 'Synthetic alpha worker' }), []);
  assert.equal(validateConnectorManifest(clean).ok, true);
});

test('a connector cannot forge the runtime kind it won', () => {
  const declared = RUNTIME_KINDS[0];
  const forged = RUNTIME_KINDS.find((kind) => kind !== declared);
  const forger = registerAdapter({
    adapter_ref: 'adapter-forger', runtime_kind: declared,
    detector: () => ({ matched: true, score: 1, evidence: 'claimed a match' }),
    adapt: () => ({}), validate: () => true,
    standardize: () => syntheticManifest({ runtime_kind: forged, provenance: { ...syntheticManifest().provenance, runtime_kind: forged, selected_adapter_ref: 'adapter-someone-else' } }),
  });
  const result = runAdapterPipeline({ adapters: [forger], observation: {} });
  assert.equal(result.unified.length, 1, 'the manifest still ships, with the kind corrected');
  // Provenance is written from the registration, exactly as selected_adapter_ref already was.
  assert.equal(result.unified[0].runtime_kind, declared, 'the declared kind is authoritative');
  assert.equal(result.unified[0].provenance.runtime_kind, declared);
  assert.equal(result.unified[0].provenance.selected_adapter_ref, 'adapter-forger');
  // And the overstep is recorded rather than silently absorbed.
  assert.ok(result.failures.some((failure) => failure.code === 'ADAPTER_RUNTIME_KIND_MISMATCH'), JSON.stringify(result.failures));
  // An honest adapter records nothing.
  const honest = registerAdapter({
    adapter_ref: 'adapter-honest', runtime_kind: declared,
    detector: () => ({ matched: true, score: 1, evidence: 'honest' }),
    adapt: () => ({}), validate: () => true, standardize: () => syntheticManifest(),
  });
  const clean = runAdapterPipeline({ adapters: [honest], observation: {} });
  assert.deepEqual(clean.failures, []);
  assert.equal(clean.unified[0].runtime_kind, declared);
});

test('a nullish adapter cannot stop the other connectors from loading', () => {
  const good = registerAdapter({
    adapter_ref: 'adapter-good', runtime_kind: RUNTIME_KINDS[0],
    detector: () => ({ matched: true, score: 1, evidence: 'good' }),
    adapt: () => ({}), validate: () => true, standardize: () => syntheticManifest(),
  });
  // The catch block itself threw on a nullish entry, so the failure detail is now null-safe: a
  // `null` in the adapters array stopped the whole pipeline, which is the opposite of isolation.
  for (const entry of [null, undefined]) {
    const alone = runAdapterPipeline({ adapters: [entry], observation: {} });
    assert.equal(alone.unified.length, 0);
    assert.equal(alone.failures.length, 1);
    assert.ok(alone.failures[0].detail.startsWith(entry === null ? 'null:' : 'undefined:'), alone.failures[0].detail);
    const together = runAdapterPipeline({ adapters: [entry, good], observation: {} });
    assert.equal(together.unified.length, 1, 'the good adapter still loads');
    assert.equal(together.selected, 'adapter-good');
  }
  // The other malformed shapes were already isolated and must stay that way.
  for (const entry of [42, 'x', {}, []]) {
    assert.equal(runAdapterPipeline({ adapters: [entry, good], observation: {} }).unified.length, 1);
  }
  const loaded = loadConnectors({ adapters: [null, good], observations: [{}, {}] });
  // It used to throw outright. Both observations resolve to the same connector kind, so the
  // duplicate-kind rule keeps one manifest - which is the documented behaviour, not a defect.
  assert.equal(loaded.loaded, 1);
  assert.ok(loaded.failures.some((failure) => failure.stage === 'DETECT'), 'the null adapter is a recorded failure');
  assert.ok(loaded.failures.some((failure) => failure.code === 'DUPLICATE_CONNECTOR_KIND'));
});

test('a manifest carrying a reserved prototype key is refused at unify', () => {
  const protoAdapter = registerAdapter({
    adapter_ref: 'adapter-proto', runtime_kind: RUNTIME_KINDS[0],
    detector: () => ({ matched: true, score: 1, evidence: 'e' }),
    adapt: () => ({}), validate: () => true,
    standardize: () => JSON.parse(JSON.stringify(syntheticManifest()).replace('{', '{"__proto__":{"isAdmin":true},')),
  });
  const result = runAdapterPipeline({ adapters: [protoAdapter], observation: {} });
  // It used to reach the caller with an own `__proto__` key and Object.keys listing it.
  assert.equal(result.unified.length, 0);
  assert.ok(result.failures.some((failure) => failure.code === 'INVALID_CONNECTOR_MANIFEST'), JSON.stringify(result.failures));
  assert.ok(result.failures[0].detail.includes('__proto__'));
});

test('heartbeat freshness is measured in one unit, whatever the clock returns', () => {
  // The module's own clock returns an ISO string, and freshness compared Date.parse(last) against
  // that raw string, so the difference was NaN and nothing was ever stale: a three-hour-old
  // heartbeat read as fresh against a thirty-second budget, and the whole HEARTBEAT_LOST -> DEGRADED
  // path was dead code. The author's test only passed by mixing a numeric `now` with a string `last`,
  // which is a combination the module never produces.
  const isoClock = () => '2026-09-30T12:00:00.000Z';
  const runtime = createManagedProcessRuntime({ spawnProcess: createProcessPortDouble({ script: [{ ready: true }] }), clock: isoClock });
  runtime.start({ manifest: syntheticManifest(), instanceRef: 'health-iso' });
  runtime.heartbeat('health-iso', { at: '2026-09-30T12:00:00.000Z' });
  assert.deepEqual(runtime.checkHealth('health-iso', { now: '2026-09-30T12:00:10.000Z' }), { instanceRef: 'health-iso', state: 'READY', stale: false, code: null });
  const stale = runtime.checkHealth('health-iso', { now: '2026-09-30T15:00:00.000Z' });
  assert.equal(stale.stale, true, 'a three-hour-old heartbeat is stale against a 30s budget');
  assert.equal(stale.code, 'HEARTBEAT_LOST');
  assert.equal(stale.state, 'DEGRADED');
  // An instant that was supplied but cannot be read fails closed rather than reading as fresh.
  expectCode(() => runtime.checkHealth('health-iso', { now: 'not-an-instant' }), 'INVALID_TIMESTAMP');
});

test('a heartbeat cannot resurrect a process that was killed', () => {
  // One DEGRADED bucket held two incompatible causes, so a process killed by its startup timeout was
  // promoted to READY by the next pulse with no process, no new spawn and a dead handle.
  const failing = createProcessPortDouble({ script: [{ ready: false, reason: 'never became ready' }] });
  const runtime = createManagedProcessRuntime({ spawnProcess: failing, clock: () => TS });
  const started = runtime.start({ manifest: syntheticManifest(), instanceRef: 'killed' });
  assert.equal(started.state, 'DEGRADED');
  assert.equal(started.code, 'STARTUP_TIMEOUT');
  const pulsed = runtime.heartbeat('killed', { at: T_LATER });
  assert.equal(pulsed.state, 'DEGRADED', 'a heartbeat clears heartbeat loss, not a spawn failure');
  assert.equal(pulsed.degrade_reason, 'STARTUP_TIMEOUT');
  expectCode(() => runtime.invoke('killed', { capabilityId: 'engineering.execute', method: 'run' }), 'RUNTIME_NOT_STARTED');
  // A genuine heartbeat loss is still recoverable by a pulse on a live handle.
  const live = createProcessPortDouble({ script: [{ ready: true }] });
  const rt = createManagedProcessRuntime({ spawnProcess: live, clock: () => TS });
  rt.start({ manifest: syntheticManifest(), instanceRef: 'live' });
  rt.heartbeat('live', { at: TS });
  assert.equal(rt.checkHealth('live', { now: T_MS + 60000 }).stale, true);
  assert.equal(rt.heartbeat('live', { at: T_LATER }).state, 'READY');
});

test('start persists the mediated intersection and bounds the spawn request', () => {
  const port = createProcessPortDouble({ script: [{ ready: true }] });
  const runtime = createManagedProcessRuntime({ spawnProcess: port, clock: () => TS });
  // An undeclared grant is refused here too: start() used to copy the decision verbatim, so the same
  // decision the mediator refuses was accepted and published in provenance.
  expectCode(() => runtime.start({ manifest: syntheticManifest(), instanceRef: 'undeclared', policyDecision: { granted: ['ssh.root'], refused: [] } }), 'UNDECLARED_NEED_GRANT');
  const started = runtime.start({
    manifest: syntheticManifest(), instanceRef: 'mediated',
    policyDecision: { granted: ['engineering.execute.invoke', 'engineering.execute.invoke'], refused: [{ need_id: 'unused.need', code: 'NOT_NEEDED' }] },
  });
  assert.equal(started.state, 'READY');
  // The port is told the execution bounds, so an unbounded request is no longer expressible.
  const request = port.__spawned[port.__spawned.length - 1].request;
  assert.equal(request.startup_timeout_ms, syntheticManifest().limits.startup_timeout_ms);
  assert.equal(request.max_log_bytes, syntheticManifest().limits.max_log_bytes);
  assert.equal(request.stdio, 'pipe');
  assert.equal(request.shell, false);
  // A malformed refusal is a typed error, not a TypeError out of a validator.
  expectCode(() => mediateConnectorPermissions(syntheticManifest(), { refused: [null] }), 'INVALID_CONNECTOR_MANIFEST');
  expectCode(() => mediateConnectorPermissions(syntheticManifest(), { refused: [{ code: 'X' }] }), 'INVALID_CONNECTOR_MANIFEST');
});

test('one adapter producing un-copyable output cannot stop the others loading', () => {
  const good = registerAdapter({
    adapter_ref: 'adapter-healthy', runtime_kind: RUNTIME_KINDS[0],
    detector: () => ({ matched: true, score: 1, evidence: 'healthy' }),
    adapt: () => ({}), validate: () => true, standardize: () => syntheticManifest(),
  });
  const uncopyable = registerAdapter({
    adapter_ref: 'adapter-uncopyable', runtime_kind: RUNTIME_KINDS[0],
    detector: () => ({ matched: true, score: 2, evidence: 'wins selection' }),
    adapt: () => ({}), validate: () => true, standardize: () => ({ ...syntheticManifest(), handler: () => 1 }),
  });
  // structuredClone raises DataCloneError on a function-valued property, and the copy sat outside
  // every guard: one adapter made runAdapterPipeline and loadConnectors throw outright.
  const result = runAdapterPipeline({ adapters: [uncopyable, good], observation: {} });
  assert.equal(result.selected, 'adapter-uncopyable');
  assert.equal(result.unified.length, 0);
  assert.ok(result.failures.some((failure) => failure.code === 'ADAPTER_INVALID_OUTPUT'), JSON.stringify(result.failures));
  const loaded = loadConnectors({ adapters: [uncopyable, good], observations: [{}] });
  assert.equal(loaded.loaded, 0, 'the un-copyable adapter produced no manifest, but nothing threw');
  assert.ok(loaded.failures.some((failure) => failure.code === 'ADAPTER_INVALID_OUTPUT'));
  assert.deepEqual(runAdapterPipeline({ adapters: [good], observation: {} }).failures, [], 'the healthy adapter is unaffected');
});

test('a connector entry reference is confined to its own root', () => {
  // entry_ref is what the runtime hands to the process port to execute, and it was validated only as
  // "nonempty text", so all of these passed strict validation.
  for (const ref of ['../../../../etc/passwd', 'C:\\Windows\\System32\\cmd.exe', '/bin/sh -c "id"', 'a\u0000b', '-flag']) {
    const result = validateConnectorManifest(syntheticManifest({ entry_ref: ref }));
    assert.equal(result.ok, false, `${JSON.stringify(ref)} must be refused`);
    assert.ok(result.errors.some((error) => error.includes('entry_ref')), JSON.stringify(result.errors));
  }
  for (const ref of ['workers/alpha.mjs', 'sub/dir/worker.mjs']) {
    assert.equal(validateConnectorManifest(syntheticManifest({ entry_ref: ref })).ok, true, `${ref} is a legitimate entry reference`);
  }
});
