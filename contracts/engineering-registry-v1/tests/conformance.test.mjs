// EM-004 conformance suite — connector capability / probe / auth / instance registry.
//
// Acceptance: two instances of one connector type remain distinct; stale probe data is visible as
// stale and not silently healthy; auth READY cannot be inferred from a live process; a capability
// mismatch produces a typed refusal before execution; the registry survives a probe throwing or
// timing out; no raw credential material is stored in registry records.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 AUTH_STATUSES, CAPABILITY_FACTS, ENGINEERING_REGISTRY_CONTRACT, HEALTH_STATES, MAX_CLOCK_SKEW_MS,
 MAX_PROBE_TTL_MS, PROCESS_STATES, READINESS, REGISTRY_CODES, RegistryError, SUPPORT_LEVELS,
 assertConnectorDescriptor, assertConnectorInstance, assertRequirements, assertUsable, capabilityOf,
 createConnectorRegistry, findRawSecretFields, findRawSecretValues, isIsoInstant, matchRequirements,
 probeEvidenceSource, probeFreshness, processReadiness, recordDepthExceeded, usability,
 validateCapabilityManifest, validateConnectorDescriptor, validateConnectorInstance
} from '../index.mjs';

const T0 = Date.parse('2026-09-30T12:00:00.000Z');
const ISO = ms => new Date(ms).toISOString();
const TTL = 30_000;
const DEVICE = 'dev-11111111111111111111111111111111';
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const manifest = (capabilities = {}) => ({ registry_version: 1, capabilities: { FILESYSTEM: 'SUPPORTED', SHELL: 'SUPPORTED', GIT: 'SUPPORTED', ...capabilities } });

const descriptor = (overrides = {}) => ({
  registry_version: 1,
  connector_kind: 'worker-code',
  display_name: 'Code worker',
  runtime_kind: 'NODE',
  capability_manifest: manifest(),
  declared_at: ISO(T0),
  ...overrides,
});

const instance = (overrides = {}) => ({
  registry_version: 1,
  instance_ref: 'instance-1',
  connector_kind: 'worker-code',
  device_ref: DEVICE,
  account_ref: null,
  installation_ref: 'ins-1',
  process: { state: 'RUNNING', pid_ref: 'pid-1' },
  auth: { status: 'READY', handle_ref: 'handle:credential:1' },
  health: 'HEALTHY',
  capability_manifest: manifest(),
  probe: { observed_at: ISO(T0), source: { kind: 'PROBED', ref: 'probe-1' }, ttl_ms: TTL, version: '1.2.3', installed: true, attachable: true },
  ...overrides,
});

const registryAt = (clockMs = T0) => {
  const registry = createConnectorRegistry({ clock: () => clockMs });
  registry.registerDescriptor(descriptor());
  return registry;
};

/* ------------------------------------------------ 1. descriptor vs instance */

test('one connector kind may have two distinct instances', () => {
  const registry = registryAt();
  registry.registerInstance(instance());
  registry.registerInstance(instance({ instance_ref: 'instance-2', account_ref: 'account-2', installation_ref: 'ins-2', device_ref: null }));
  const listed = registry.listInstances();
  assert.deepEqual(listed.map(entry => entry.instance_ref), ['instance-1', 'instance-2']);
  assert.equal(new Set(listed.map(entry => entry.instance_ref)).size, 2);
  assert.deepEqual(listed.map(entry => entry.connector_kind), ['worker-code', 'worker-code']);
  assert.equal(listed[1].device_ref, null, 'an instance may be local-only');
  assert.equal(registry.listDescriptors().length, 1, 'the descriptor is shared, the instances are not');
  expectCode(() => registry.registerInstance(instance()), 'DUPLICATE_INSTANCE');
  expectCode(() => registry.registerInstance(instance({ instance_ref: 'instance-3', connector_kind: 'worker-unknown' })), 'UNKNOWN_CONNECTOR_KIND');
  assert.equal(registry.getInstance('instance-missing').code, 'UNKNOWN_INSTANCE');
  assert.equal(registry.getDescriptor('worker-missing').code, 'UNKNOWN_CONNECTOR_KIND');
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.descriptor_and_instance_are_distinct, true);
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.one_kind_many_instances, true);
});

/* ------------------------------------------------ 2. stale probe */

test('stale probe data is visible as stale and never silently healthy', () => {
  const registry = registryAt(T0 + TTL + 1);
  registry.registerInstance(instance());
  const record = registry.getInstance('instance-1').instance;
  assert.equal(probeFreshness(record, T0 + TTL + 1), 'STALE');
  assert.deepEqual(processReadiness(record, T0 + TTL + 1), { readiness: 'UNKNOWN', freshness: 'STALE', reason: 'STALE_PROBE' });
  // the remembered capability is not reported as current
  assert.deepEqual(capabilityOf(record, 'GIT', T0 + TTL + 1), { fact: 'GIT', level: 'UNKNOWN', freshness: 'STALE' });
  const verdict = usability(record, T0 + TTL + 1);
  assert.equal(verdict.usable, false);
  assert.equal(verdict.blockers.includes('STALE_PROBE'), true);
  assert.equal(registry.snapshot().instances[0].usable, false);
  assert.equal(registry.listInstances({ usableOnly: true }).length, 0, 'a stale instance is not offered as usable');
  // exactly at the boundary the probe is still fresh; one millisecond later it is not
  assert.equal(probeFreshness(record, T0 + TTL), 'FRESH');
  assert.equal(probeFreshness(record, T0 + TTL + 1), 'STALE');
  assert.equal(probeFreshness(instance({ probe: { ...instance().probe, observed_at: 'not-an-instant' } }), T0), 'UNKNOWN');
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.stale_probe_is_visible, true);
});

/* ------------------------------------------------ 3. auth is its own fact */

test('auth READY is never inferred from a live process', () => {
  const running = instance({ auth: { status: 'MISSING', handle_ref: null } });
  const process = processReadiness(running, T0);
  assert.equal(process.readiness, 'READY', 'the process itself is attachable');
  const verdict = usability(running, T0);
  assert.equal(verdict.usable, false, 'a running process with missing auth is not usable');
  assert.equal(verdict.blockers.includes('AUTH_MISSING'), true);
  assert.equal(verdict.auth_status, 'MISSING');
  expectCode(() => assertUsable(running, T0), 'AUTH_NOT_READY');
  for (const status of ['MISSING', 'EXPIRED', 'NEEDS_USER', 'REFRESHING', 'UNAVAILABLE', 'UNKNOWN']) {
    assert.equal(usability(instance({ auth: { status, handle_ref: null } }), T0).usable, false, status);
  }
  assert.equal(usability(instance(), T0).usable, true);
  // auth, health and process readiness are three independent facts
  assert.equal(usability(instance({ health: 'DEGRADED' }), T0).blockers.includes('HEALTH_DEGRADED'), true);
  assert.equal(usability(instance({ process: { state: 'STOPPED', pid_ref: null } }), T0).blockers.includes('PROCESS_NOT_READY'), true);
  assert.equal(usability(instance({ process: { state: 'CRASHED', pid_ref: null } }), T0).usable, false);
  assert.equal(processReadiness(instance({ probe: { ...instance().probe, attachable: false } }), T0).reason, 'NOT_ATTACHABLE');
  assert.deepEqual([...AUTH_STATUSES], ['READY', 'MISSING', 'EXPIRED', 'NEEDS_USER', 'REFRESHING', 'UNAVAILABLE', 'UNKNOWN']);
  assert.deepEqual([...READINESS], ['READY', 'NOT_READY', 'UNKNOWN']);
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.auth_inferable_from_a_live_process, false);
});

/* ------------------------------------------------ 4. capability matching */

test('a capability mismatch is a typed refusal before execution', () => {
  const capable = instance({ capability_manifest: manifest({ VISION: 'SUPPORTED', GIT: 'SUPPORTED' }) });
  assert.equal(matchRequirements(capable, ['GIT', 'VISION'], T0).matched, true);
  // an explicitly unsupported fact is a missing capability, and the refusal is typed
  const unsupported = matchRequirements(instance({ capability_manifest: manifest({ BROWSER: 'UNSUPPORTED' }) }), ['BROWSER'], T0);
  assert.equal(unsupported.matched, false);
  assert.equal(unsupported.code, 'CAPABILITY_MISMATCH');
  assert.deepEqual([...unsupported.missing], ['BROWSER']);
  expectCode(() => assertRequirements(instance({ capability_manifest: manifest({ BROWSER: 'UNSUPPORTED' }) }), ['BROWSER'], T0), 'CAPABILITY_MISMATCH');
  // a fact nobody verified is *unknown*, which is a different mismatch from unsupported
  const absent = matchRequirements(capable, ['BROWSER'], T0);
  assert.equal(absent.matched, false);
  assert.deepEqual([...absent.missing], []);
  assert.deepEqual([...absent.unknown], ['BROWSER']);
  // an UNKNOWN fact is not assumed true either: it is an unverified mismatch
  const unverified = matchRequirements(instance({ capability_manifest: manifest({ VISION: 'UNKNOWN' }) }), ['VISION'], T0);
  assert.equal(unverified.matched, false);
  assert.deepEqual([...unverified.unknown], ['VISION']);
  assert.equal(unverified.detail.includes('unverified'), true);
  // a stale probe makes even a supported fact unverified
  assert.equal(matchRequirements(capable, ['GIT'], T0 + TTL + 1).matched, false);
  assert.equal(capabilityOf(capable, 'GIT', T0).level, 'SUPPORTED');
  assert.equal(capabilityOf(instance({ capability_manifest: manifest({ VISION: 'UNKNOWN' }) }), 'VISION', T0).level, 'UNKNOWN');
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.unknown_capability_default, 'UNKNOWN');
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.capability_mismatch_is_a_typed_refusal, true);
  assert.deepEqual([...SUPPORT_LEVELS], ['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN']);
});

/* ------------------------------------------------ 5. probe isolation */

test('the registry survives a probe that throws or times out', () => {
  const registry = registryAt();
  registry.registerInstance(instance({ instance_ref: 'instance-good' }));
  registry.registerInstance(instance({ instance_ref: 'instance-throws' }));
  registry.registerInstance(instance({ instance_ref: 'instance-slow' }));
  const fresh = { probe: { observed_at: ISO(T0 + 1000), source: { kind: 'PROBED', ref: 'probe-2' }, ttl_ms: TTL, version: '1.2.4', installed: true, attachable: true }, health: 'HEALTHY' };
  const outcomes = registry.probeAll([
    { instanceRef: 'instance-throws', probe: () => { throw new RegistryError('PROBE_FAILED', 'worker exploded'); } },
    { instanceRef: 'instance-slow', probe: () => null },
    { instanceRef: 'instance-good', probe: () => fresh },
    { instanceRef: 'instance-missing', probe: () => fresh },
    { instanceRef: 'instance-good', probe: 'not-a-function' },
  ]);
  assert.deepEqual(outcomes.outcomes.map(entry => [entry.instance_ref, entry.code]), [
    ['instance-throws', 'PROBE_FAILED'],
    ['instance-slow', 'PROBE_TIMEOUT'],
    ['instance-good', null],
    ['instance-missing', 'UNKNOWN_INSTANCE'],
    ['instance-good', 'PROBE_FAILED'],
  ]);
  // the surviving instance was updated, and the failing ones did not become healthy
  const good = registry.getInstance('instance-good').instance;
  assert.equal(good.probe.version, '1.2.4');
  assert.equal(registry.getInstance('instance-throws').instance.probe.version, '1.2.3', 'a failed probe does not rewrite facts');
  assert.equal(registry.listInstances().length, 3, 'the registry still holds every instance');
  // only genuine probe failures are counted: a caller error (unknown instance, non-function) is reported in the outcomes but is not a probe failure
  assert.equal(registry.snapshot().probe_failures.length, 2);
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.probe_failure_is_isolated, true);
  expectCode(() => registry.probeAll('not-an-array'), 'INVALID_REGISTRY_RECORD');
});

/* ------------------------------------------------ 6. no secrets */

test('registry records refuse raw credential material and keep handles only', () => {
  assert.equal(validateConnectorInstance(instance()).ok, true);
  const withSecret = validateConnectorInstance(instance({ auth: { status: 'READY', credential: 'raw-bytes' } }));
  assert.equal(withSecret.ok, false);
  assert.equal(withSecret.errors.some(error => error.includes('raw secret')), true);
  assert.equal(validateConnectorInstance(instance({ api_key: 'raw' })).ok, false);
  assert.equal(validateConnectorInstance(instance({ auth: { status: 'EXPIRED', handle_ref: 'handle:credential:9' } })).ok, true);
  assert.equal(validateConnectorDescriptor(descriptor({ secret_token: 'raw' })).ok, false);
  assert.deepEqual(findRawSecretFields({ a: { session_key: 'x' } }, ''), ['.a.session_key']);
  assert.deepEqual(findRawSecretFields({ handle_ref: 'h', installation_ref: 'i' }, ''), []);
  // the snapshot reports that a handle exists, never its value
  const registry = registryAt();
  registry.registerInstance(instance({ auth: { status: 'READY', handle_ref: 'handle:credential:secret-name' } }));
  const snapshot = registry.snapshot();
  assert.equal(snapshot.instances[0].capability_handle_present, true);
  assert.equal(JSON.stringify(snapshot).includes('handle:credential:secret-name'), false);
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.raw_credentials_in_records, false);
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.stores_secrets, false);
});

/* ------------------------------------------------ 7. shape and fit */

test('records are strict, and eligibility reports fit without choosing a host', () => {
  assert.equal(validateConnectorDescriptor(descriptor({ registry_version: 2 })).ok, false);
  assert.equal(validateConnectorDescriptor(descriptor({ capability_manifest: manifest({ TELEPATHY: 'SUPPORTED' }) })).ok, false);
  assert.equal(validateConnectorDescriptor(descriptor({ capability_manifest: manifest({ GIT: 'MAYBE' }) })).ok, false);
  assert.equal(validateConnectorDescriptor(descriptor({ mood: 'happy' })).ok, false);
  assert.equal(validateCapabilityManifest({ registry_version: 1, capabilities: {} }).length, 0);
  assert.equal(validateConnectorInstance(instance({ device_ref: 'not-a-device' })).ok, false);
  assert.equal(validateConnectorInstance(instance({ process: { state: 'VIBING', pid_ref: null } })).ok, false);
  assert.equal(validateConnectorInstance(instance({ health: 'FINE' })).ok, false);
  assert.equal(validateConnectorInstance(instance({ probe: { observed_at: ISO(T0) } })).ok, false);

  const registry = registryAt();
  registry.registerInstance(instance({ instance_ref: 'instance-local', capability_manifest: manifest({ FILESYSTEM: 'SUPPORTED' }) }));
  registry.registerInstance(instance({ instance_ref: 'instance-remote', device_ref: 'dev-22222222222222222222222222222222', capability_manifest: manifest({ FILESYSTEM: 'SUPPORTED', BROWSER: 'SUPPORTED' }) }));
  const eligible = registry.eligibleInstances({ requirements: ['FILESYSTEM'] });
  assert.deepEqual(eligible.map(entry => entry.instance_ref), ['instance-local', 'instance-remote']);
  assert.equal(eligible.every(entry => entry.match.matched === true), true);
  const browserOnly = registry.eligibleInstances({ requirements: ['BROWSER'] });
  assert.deepEqual(browserOnly.filter(entry => entry.match.matched).map(entry => entry.instance_ref), ['instance-remote']);
  assert.equal(browserOnly.find(entry => entry.instance_ref === 'instance-local').match.code, 'CAPABILITY_MISMATCH');
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.chooses_remote_host, false);
  assert.equal(ENGINEERING_REGISTRY_CONTRACT.discovers_trust, undefined);
  assert.deepEqual([...PROCESS_STATES].includes('RUNNING'), true);
  assert.deepEqual([...HEALTH_STATES], ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);
  assert.equal(CAPABILITY_FACTS.includes('COMPUTER_USE'), true);
  assert.equal(new Set(REGISTRY_CODES).size, REGISTRY_CODES.length);
  assert.equal(new RegistryError('X', 'y').status, 409);
});

/* --------------------------------- 8. regressions (Correction, host Alien) */

// Every refusal is paired with the legitimate neighbour that must still pass, so no guard can be
// satisfied by refusing everything.

test('unknown fields are refused even when named after Object.prototype members', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const bad = Object.defineProperty({ ...descriptor() }, name, { value: 'SMUGGLED', enumerable: true, configurable: true, writable: true });
    assert.equal(validateConnectorDescriptor(bad).ok, false, `descriptor.${name} must not be canonical`);
    const badInstance = Object.defineProperty({ ...instance() }, name, { value: 'SMUGGLED', enumerable: true, configurable: true, writable: true });
    assert.equal(validateConnectorInstance(badInstance).ok, false, `instance.${name} must not be canonical`);
  }
  const hidden = { ...descriptor() };
  Object.defineProperty(hidden, 'transport', { value: 'RF', enumerable: false, configurable: true, writable: true });
  assert.equal(validateConnectorDescriptor(hidden).ok, false, 'a non-enumerable own field must be refused too');
  // neighbours: an ordinary unknown field is still refused, and clean records are still admitted
  assert.equal(validateConnectorDescriptor({ ...descriptor(), transport: 'RF' }).ok, false);
  assert.equal(validateConnectorDescriptor(descriptor()).ok, true);
  assert.equal(validateConnectorInstance(instance()).ok, true);
  assert.equal({}.SMUGGLED, undefined, 'no prototype pollution');
});

test('a future-dated probe is never fresh, and never silently usable', () => {
  const year = 365 * 24 * 3600 * 1000;
  const replayed = instance({ probe: { ...instance().probe, observed_at: ISO(T0 + 10 * year), ttl_ms: 1 } });
  // freshness gates capability, readiness, usability and requirement matching
  assert.equal(probeFreshness(replayed, T0), 'STALE', 'a probe dated ten years ahead is not current evidence');
  assert.equal(capabilityOf(replayed, 'SHELL', T0).level, 'UNKNOWN');
  assert.equal(processReadiness(replayed, T0).readiness, 'UNKNOWN');
  assert.equal(usability(replayed, T0).usable, false);
  expectCode(() => assertUsable(replayed, T0), 'STALE_PROBE');
  assert.equal(matchRequirements(replayed, ['SHELL'], T0).matched, false);
  assert.equal(registryAt().listInstances({ usableOnly: true }).length, 0);
  // neighbour: an ordinary clock skew ahead by a minute is NOT invalidated
  const skewed = instance({ probe: { ...instance().probe, observed_at: ISO(T0 + 60_000) } });
  assert.equal(probeFreshness(skewed, T0), 'FRESH');
  assert.equal(60_000 < MAX_CLOCK_SKEW_MS, true);
  // neighbours: the original boundaries are unchanged
  assert.equal(probeFreshness(instance(), T0 + TTL), 'FRESH');
  assert.equal(probeFreshness(instance(), T0 + TTL + 1), 'STALE');
  assert.equal(probeFreshness(instance({ probe: { ...instance().probe, observed_at: 'not-an-instant' } }), T0), 'UNKNOWN');
});

test('the typed refusal names the blocker that actually applies', () => {
  const unhealthy = instance({ health: 'UNHEALTHY' });
  assert.deepEqual([...usability(unhealthy, T0).blockers], ['HEALTH_UNHEALTHY']);
  expectCode(() => assertUsable(unhealthy, T0), 'HEALTH_NOT_READY');
  expectCode(() => assertUsable(instance({ auth: { status: 'EXPIRED', handle_ref: null } }), T0), 'AUTH_NOT_READY');
  expectCode(() => assertUsable(instance({ process: { state: 'STOPPED', pid_ref: null } }), T0), 'PROCESS_NOT_READY');
  expectCode(() => assertUsable(instance({ probe: { ...instance().probe, attachable: false } }), T0), 'PROCESS_NOT_READY');
  // neighbours: a healthy instance is still usable, and a stale one is still reported as stale first
  assert.equal(assertUsable(instance(), T0).usable, true);
  expectCode(() => assertUsable(instance({ health: 'UNHEALTHY', probe: { ...instance().probe, observed_at: ISO(T0 - TTL - 1) } }), T0), 'STALE_PROBE');
});

test('the auditable snapshot cannot be rewritten by its reader', () => {
  const registry = registryAt();
  registry.registerInstance(instance());
  registry.probeAll([{ instanceRef: 'instance-1', probe: () => { throw new Error('boom'); } }]);
  const snapshot = registry.snapshot();
  assert.equal(snapshot.probe_failures.length, 1);
  assert.equal(Object.isFrozen(snapshot.probe_failures[0]), true);
  assert.throws(() => { snapshot.probe_failures[0].code = 'REWRITTEN'; }, TypeError);
  assert.equal(registry.snapshot().probe_failures[0].code, 'PROBE_FAILED', 'the registry record is unchanged');
  // neighbours: the failure is still recorded and visible, and a successful probe is still ok
  assert.equal(snapshot.probe_failures[0].instance_ref, 'instance-1');
  const clean = registryAt();
  clean.registerInstance(instance());
  const ok = clean.probeAll([{ instanceRef: 'instance-1', probe: () => ({ probe: { ...instance().probe }, health: 'DEGRADED' }) }]);
  assert.equal(ok.outcomes[0].ok, true);
  assert.equal(clean.getInstance('instance-1').instance.health, 'DEGRADED');
  assert.deepEqual([...clean.snapshot().probe_failures], []);
});

test('a partial probe update leaves the fields it does not mention alone', () => {
  const registry = registryAt();
  registry.registerInstance(instance());
  // observing only health must not wipe the probe block
  const updated = registry.updateProbe('instance-1', { health: 'DEGRADED' });
  assert.equal(updated.health, 'DEGRADED');
  assert.deepEqual(updated.probe, instance().probe, 'the probe block is untouched');
  assert.equal(updated.auth.status, 'READY');
  // a patch that carries no fact at all is refused rather than reported as a successful no-op
  expectCode(() => registry.updateProbe('instance-1', {}), 'INVALID_REGISTRY_RECORD');
  expectCode(() => registry.updateProbe('instance-1', { nonsense: 1 }), 'INVALID_REGISTRY_RECORD');
  // neighbours: a full patch still applies, and an invalid patch is still refused without half-applying
  const fresh = registry.updateProbe('instance-1', { probe: { ...instance().probe, version: '2.0.0' }, health: 'HEALTHY' });
  assert.equal(fresh.probe.version, '2.0.0');
  assert.equal(fresh.health, 'HEALTHY');
  expectCode(() => registry.updateProbe('instance-1', { probe: { ...instance().probe, observed_at: 'nonsense' } }), 'INVALID_REGISTRY_RECORD');
  assert.equal(registry.getInstance('instance-1').instance.probe.version, '2.0.0', 'the refusal left the record intact');
});

test('a raw credential is refused by value as well as by key name', () => {
  // key-shaped, including a non-enumerable own key
  assert.equal(validateConnectorInstance(instance({ auth: { status: 'READY', credential: 'raw' } })).ok, false);
  const hidden = { ...instance() };
  Object.defineProperty(hidden, 'access_token', { value: 'RAW', enumerable: false, configurable: true, writable: true });
  assert.equal(validateConnectorInstance(hidden).ok, false, 'a non-enumerable own token field must be refused');
  // value-shaped: a token in a benign field is still a stored token
  assert.equal(validateConnectorDescriptor(descriptor({ display_name: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' })).ok, false);
  assert.equal(validateConnectorInstance(instance({ installation_ref: 'sk-abcdefghijklmnopqrstuvwx' })).ok, false);
  assert.equal(validateConnectorDescriptor(descriptor({ display_name: 'AKIAIOSFODNN7EXAMPLE' })).ok, false);
  expectCode(() => assertConnectorInstance(instance({ auth: { status: 'READY', credential: 'raw' } })), 'RAW_SECRET_FORBIDDEN');
  // neighbours: handles are still fine, ordinary text is still fine, and reads stay handle-only
  assert.equal(validateConnectorInstance(instance()).ok, true);
  assert.equal(validateConnectorDescriptor(descriptor({ display_name: 'Code worker (v2) — AKIA is not always a key' })).ok, true);
  const registry = registryAt();
  registry.registerInstance(instance());
  assert.equal(JSON.stringify(registry.snapshot()).includes('handle:credential:1'), false);
});

test('a cyclic or over-deep record is refused, never a stack overflow', () => {
  const loop = [];
  loop.push(loop);
  assert.equal(validateConnectorInstance(instance({ capability_manifest: { registry_version: 1, capabilities: {}, extra: loop } })).ok, false);
  let deep = 'leaf';
  for (let index = 0; index < 200; index += 1) deep = { next: deep };
  assert.equal(recordDepthExceeded(deep), true);
  assert.equal(validateConnectorDescriptor(descriptor({ capability_manifest: { registry_version: 1, capabilities: {}, extra: deep } })).ok, false);
  // neighbours: a shallow record is still valid, and the scans still find what they should
  assert.equal(recordDepthExceeded(descriptor()), false);
  assert.deepEqual([...findRawSecretFields({ a: { session_key: 'x' } }, '')], ['.a.session_key']);
  assert.deepEqual([...findRawSecretValues({ a: 'plain text' }, '')], []);
  assert.equal(validateConnectorDescriptor(descriptor()).ok, true);
});

test('a calendar-impossible instant is refused, not merely shape-checked', () => {
  assert.equal(isIsoInstant('2026-13-45T99:99:99Z'), false);
  assert.equal(isIsoInstant('2026-02-30T00:00:00.000Z'), false);
  assert.equal(validateConnectorDescriptor(descriptor({ declared_at: '2026-13-45T99:99:99Z' })).ok, false);
  assert.equal(validateConnectorInstance(instance({ probe: { ...instance().probe, observed_at: '2026-02-30T00:00:00.000Z' } })).ok, false);
  // neighbours: both accepted spellings of a real instant still pass
  assert.equal(isIsoInstant('2026-09-30T12:00:00Z'), true);
  assert.equal(isIsoInstant('2026-09-30T12:00:00.000Z'), true);
  assert.equal(validateConnectorDescriptor(descriptor({ declared_at: '2026-09-30T12:00:00Z' })).ok, true);
});

test('a probe cannot claim to stay current indefinitely', () => {
  // an unbounded ttl made an observation authoritative for a century
  assert.equal(validateConnectorInstance(instance({ probe: { ...instance().probe, ttl_ms: Number.MAX_SAFE_INTEGER } })).ok, false);
  const century = instance({ probe: { ...instance().probe, ttl_ms: Number.MAX_SAFE_INTEGER } });
  assert.equal(probeFreshness(century, T0 + 100 * 365 * 24 * 3600 * 1000), 'STALE', 'freshness is clamped even for an unvalidated record');
  // neighbours: a real ttl is accepted, up to and including the ceiling
  assert.equal(validateConnectorInstance(instance({ probe: { ...instance().probe, ttl_ms: MAX_PROBE_TTL_MS } })).ok, true);
  assert.equal(probeFreshness(instance({ probe: { ...instance().probe, ttl_ms: MAX_PROBE_TTL_MS } }), T0 + MAX_PROBE_TTL_MS), 'FRESH');
  assert.equal(probeFreshness(instance(), T0 + TTL), 'FRESH');
});

test('a failed probe is visible on the instance and blocks dispatch', () => {
  const registry = registryAt();
  registry.registerInstance(instance());
  assert.equal(usability(registry.getInstance('instance-1').instance, T0).usable, true);
  const failed = registry.probeAll([{ instanceRef: 'instance-1', probe: () => { throw new Error('connector refused'); } }]);
  assert.equal(failed.outcomes[0].ok, false);
  const record = registry.getInstance('instance-1').instance;
  assert.equal(record.probe_failure.code, 'PROBE_FAILED', 'the failure is stamped on the instance, not only counted globally');
  assert.deepEqual([...usability(record, T0).blockers], ['PROBE_FAILED']);
  assert.equal(usability(record, T0).usable, false, 'a connector that just stopped answering is not offered as usable');
  expectCode(() => assertUsable(record, T0), 'PROBE_FAILED');
  assert.equal(registry.listInstances({ usableOnly: true }).length, 0);
  // a timeout is recorded with its own code
  registry.probeAll([{ instanceRef: 'instance-1', probe: () => null }]);
  assert.equal(registry.getInstance('instance-1').instance.probe_failure.code, 'PROBE_TIMEOUT');
  // neighbours: a successful probe clears the failure and restores usability
  const ok = registry.probeAll([{ instanceRef: 'instance-1', probe: () => ({ probe: { ...instance().probe }, health: 'HEALTHY' }) }]);
  assert.equal(ok.outcomes[0].ok, true);
  assert.equal(Object.hasOwn(registry.getInstance('instance-1').instance, 'probe_failure'), false);
  assert.equal(usability(registry.getInstance('instance-1').instance, T0).usable, true);
  // ...and the failure history remains auditable
  assert.deepEqual(registry.snapshot().probe_failures.map(entry => entry.code), ['PROBE_FAILED', 'PROBE_TIMEOUT']);
});

test('a probe that reports not-installed cannot be a running, usable worker', () => {
  const notInstalled = instance({ probe: { ...instance().probe, installed: false, attachable: true } });
  assert.equal(processReadiness(notInstalled, T0).readiness, 'NOT_READY');
  assert.equal(processReadiness(notInstalled, T0).reason, 'NOT_INSTALLED');
  assert.equal(usability(notInstalled, T0).usable, false);
  expectCode(() => assertUsable(notInstalled, T0), 'PROCESS_NOT_READY');
  // neighbours: an installed, attached, running worker is still usable
  assert.equal(processReadiness(instance(), T0).readiness, 'READY');
  assert.equal(usability(instance(), T0).usable, true);
  assert.equal(processReadiness(instance({ probe: { ...instance().probe, attachable: false } }), T0).reason, 'NOT_ATTACHABLE');
});

test('an exempted reference field must still look like a reference', () => {
  // a raw credential anywhere is refused by value, including in a reference-named field
  assert.equal(validateConnectorInstance(instance({ auth: { status: 'READY', handle_ref: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' } })).ok, false);
  assert.equal(validateConnectorDescriptor(descriptor({ installation_ref: 'sk-abcdefghijklmnopqrstuvwx' })).ok, false);
  // The `*_ref`/`*_handle`/`*_id` exemption is for references, so a secret-shaped key with a handle
  // suffix must hold something that actually looks like a reference. No canonical record field has
  // such a name, so this is exercised through the exported scan the validators use.
  assert.deepEqual([...findRawSecretFields({ credential_ref: 'handle:credential:1' }, '')], []);
  assert.deepEqual([...findRawSecretFields({ access_token_id: 'token-1' }, '')], []);
  assert.deepEqual([...findRawSecretFields({ credential_ref: 'one two' }, '')], ['.credential_ref']);
  assert.deepEqual([...findRawSecretFields({ credential_ref: 'x'.repeat(200) }, '')], ['.credential_ref']);
  assert.deepEqual([...findRawSecretFields({ credential_ref: 'blob+with=base64/chars' }, '')], ['.credential_ref']);
  // neighbours: real handles and references are accepted in the record, and a non-secret name is not flagged
  assert.equal(validateConnectorInstance(instance()).ok, true);
  assert.equal(validateConnectorInstance(instance({ auth: { status: 'EXPIRED', handle_ref: 'handle:credential:9' } })).ok, true);
  assert.equal(validateConnectorDescriptor(descriptor({ display_name: 'Code worker v2' })).ok, true);
  assert.equal(validateConnectorInstance(instance({ installation_ref: 'ins-1' })).ok, true);
  assert.deepEqual([...findRawSecretFields({ handle_ref: 'h', installation_ref: 'i' }, '')], []);
});

test('the evidence source travels with the answer', () => {
  assert.equal(usability(instance(), T0).evidence_source, 'PROBED');
  assert.equal(probeEvidenceSource(instance()), 'PROBED');
  assert.equal(probeEvidenceSource(instance({ probe: { ...instance().probe, source: { kind: 'CONFIGURED', ref: 'r' } } })), 'CONFIGURED');
  assert.equal(probeEvidenceSource(instance({ probe: { ...instance().probe, source: { kind: 'NONSENSE', ref: 'r' } } })), 'UNKNOWN');
  // neighbours: the answer itself is unchanged for an honest PROBED record
  assert.equal(capabilityOf(instance(), 'SHELL', T0).level, 'SUPPORTED');
  assert.equal(usability(instance(), T0).usable, true);
});

