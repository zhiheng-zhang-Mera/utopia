// Conformance tests for EM-008 闁?credential references + persistent connector profiles/sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_MODES, AUTH_STATUSES, PERSISTABLE_MODES, SECURE_HANDLE_STORE_PORT, AuthProfileError,
  createAuthProfileLayer, findSecretFields, isIsoInstant, looksLikeSecretValue, redact,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-01-01T01:00:00Z';
const SECRET = 'sk-live-0123456789abcdefghijklmnop';

/** Deterministic neutral 00-Foundation `SecureHandleStorePort` double: values never leave the store. */
function createHandleStoreDouble() {
  const handles = new Map();
  let counter = 0;
  return Object.freeze({
    putHandle({ kind, value }) {
      if (typeof kind !== 'string' || kind === '') throw new Error('a handle needs a kind');
      if (typeof value !== 'string' || value === '') throw new Error('a handle needs a value');
      counter += 1;
      const handle_ref = `handle:${kind}:${counter}`;
      handles.set(handle_ref, { kind, value, state: 'ACTIVE' });
      return { handle_ref, kind };
    },
    resolveHandle(handle_ref) {
      const entry = handles.get(handle_ref);
      if (!entry) throw new Error(`unknown handle ${String(handle_ref)}`);
      if (entry.state !== 'ACTIVE') throw new Error(`handle ${handle_ref} is ${entry.state}`);
      return { handle_ref, kind: entry.kind, value: entry.value };
    },
    revokeHandle(handle_ref) {
      const entry = handles.get(handle_ref);
      if (!entry) return { handle_ref, revoked: false };
      entry.state = 'REVOKED';
      return { handle_ref, revoked: true };
    },
    __size: () => handles.size,
  });
}

const layerAt = (now = T0, handleStore = createHandleStoreDouble()) => ({
  store: handleStore,
  layer: createAuthProfileLayer({ handleStore, clock: () => now }),
});

const expectCode = (code, fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AuthProfileError, `expected AuthProfileError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
};

const containsSecret = value => JSON.stringify(value ?? null).includes(SECRET);

test('canonical state holds handle references, never plaintext secrets', () => {
  const { store, layer } = layerAt();
  const registered = layer.registerProfile({ profile_id: 'profile:deepseek', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });
  assert.equal(registered.status, 'MISSING', 'a profile with no handle is not READY');
  assert.equal(registered.credential_ref, null);

  const bound = layer.bindSecret({ profile_id: 'profile:deepseek', expected_version: 1, secret_value: SECRET });
  assert.equal(bound.status, 'READY');
  assert.equal(bound.credential_ref, 'handle:CREDENTIAL:1', 'the canonical reference is the handle');
  assert.equal(bound.profile_ref, null);
  assert.equal(bound.session_ref, null);
  assert.equal(bound.handle_kind, 'CREDENTIAL');
  assert.equal(bound.references_only, true);
  assert.equal(bound.plaintext_fallback_used, false);
  assert.deepEqual(findSecretFields(bound), [], 'no secret-shaped field survives in canonical state');
  assert.equal(containsSecret(bound), false);
  assert.equal(store.__size(), 1, 'the value lives in the secure handle store');
  assert.equal(store.resolveHandle('handle:CREDENTIAL:1').value, SECRET, 'the store does hold the real value');
  assert.equal(layer.getProfile('profile:deepseek').handle_ref, 'handle:CREDENTIAL:1');

  // Diagnostics are references and statuses only.
  const snapshot = layer.diagnosticSnapshot();
  assert.equal(snapshot.references_only, true);
  assert.equal(containsSecret(snapshot), false);
  assert.equal(containsSecret(layer.logEntries()), false);
  assert.equal(snapshot.store_port, SECURE_HANDLE_STORE_PORT.interface);
  assert.equal(SECURE_HANDLE_STORE_PORT.engineering_may_define_its_own_store, false, 'this layer must not grow a second store');
  assert.equal(layer.getProfile('profile:unknown'), null, 'an unknown profile is a typed absence');
});

test('each auth mode maps to exactly one reference kind, and NONE needs no handle', () => {
  const { layer } = layerAt();
  const cases = [
    ['API_KEY', 'CREDENTIAL', 'credential_ref'],
    ['OAUTH', 'CREDENTIAL', 'credential_ref'],
    ['DEVICE_CODE', 'CREDENTIAL', 'credential_ref'],
    ['BROWSER_PROFILE', 'PROFILE', 'profile_ref'],
    ['DESKTOP_SESSION', 'PROFILE', 'profile_ref'],
    ['CLI_SESSION', 'SESSION', 'session_ref'],
  ];
  for (const [mode, kind, field] of cases) {
    const profile_id = `profile:${mode.toLowerCase()}`;
    layer.registerProfile({ profile_id, connector_kind: 'GENERIC_CONNECTOR', mode });
    const bound = layer.bindSecret({ profile_id, expected_version: 1, secret_value: 'opaque-handle-material-1' });
    assert.equal(bound.handle_kind, kind, `${mode} -> ${kind}`);
    assert.equal(bound[field], bound.handle_ref, `${mode} exposes ${field}`);
    const others = ['credential_ref', 'profile_ref', 'session_ref'].filter(name => name !== field);
    for (const other of others) assert.equal(bound[other], null, `${mode} must not expose ${other}`);
  }
  assert.deepEqual([...AUTH_MODES], ['API_KEY', 'OAUTH', 'DEVICE_CODE', 'CLI_SESSION', 'BROWSER_PROFILE', 'DESKTOP_SESSION', 'NONE']);
  assert.deepEqual([...AUTH_STATUSES], ['READY', 'MISSING', 'EXPIRED', 'NEEDS_USER', 'REFRESHING', 'UNAVAILABLE', 'UNKNOWN']);
  assert.deepEqual([...PERSISTABLE_MODES], ['CLI_SESSION', 'BROWSER_PROFILE', 'DESKTOP_SESSION']);

  const none = layer.registerProfile({ profile_id: 'profile:local-tool', connector_kind: 'LOCAL_TOOL', mode: 'NONE' });
  assert.equal(none.status, 'READY');
  assert.equal(none.reason, 'NO_AUTH_REQUIRED');
  assert.equal(none.handle_ref, null);
  assert.equal(none.attention_required, false);
  expectCode('MODE_REQUIRES_NO_HANDLE', () => layer.bindSecret({ profile_id: 'profile:local-tool', expected_version: 1, secret_value: SECRET }));
});

test('secret values are absent from logs and errors even when the secure store fails', () => {
  const hostile = Object.freeze({
    putHandle({ value }) { throw new Error(`store exploded while writing ${value}`); },
    resolveHandle() { throw new Error('unavailable'); },
    revokeHandle() { return { revoked: false }; },
  });
  const layer = createAuthProfileLayer({ handleStore: hostile, clock: () => T0 });
  layer.registerProfile({ profile_id: 'profile:deepseek', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });

  const failure = expectCode('SECURE_STORE_FAILED', () => layer.bindSecret({ profile_id: 'profile:deepseek', expected_version: 1, secret_value: SECRET }));
  assert.equal(failure.status, 409);
  assert.equal(containsSecret(failure.message), false, 'the store message is not echoed into the error');
  assert.equal(containsSecret(layer.logEntries()), false, 'the redacted log carries no secret value');
  assert.equal(containsSecret(layer.diagnosticSnapshot()), false);
  assert.equal(layer.getProfile('profile:deepseek').handle_ref, null, 'a failed bind records nothing');
  assert.equal(layer.getProfile('profile:deepseek').status, 'MISSING', 'a failed bind is never reported READY');
  assert.equal(layer.logEntries().some(entry => entry.event === 'SECURE_STORE_FAILED'), true);

  // Redaction is recursive and also strips secret-shaped bare values.
  const payload = { outer: { api_key: SECRET, nested: [{ password: 'hunter2', keep: 'plain' }] }, note: SECRET, handle_ref: 'handle:CREDENTIAL:1' };
  const redacted = redact(payload);
  assert.equal(containsSecret(redacted), false);
  assert.equal(redacted.outer.api_key, '[REDACTED]');
  assert.equal(redacted.outer.nested[0].password, '[REDACTED]');
  assert.equal(redacted.note, '[REDACTED]', 'a secret-shaped value is redacted even under a harmless key');
  assert.equal(redacted.handle_ref, 'handle:CREDENTIAL:1', 'handle references are not secrets');
  assert.equal(redacted.outer.nested[0].keep, 'plain');
  assert.deepEqual(findSecretFields({ a: { api_key: SECRET } }), ['record.a.api_key']);
  assert.equal(looksLikeSecretValue(SECRET), true);
  assert.equal(looksLikeSecretValue('handle:CREDENTIAL:1'), false);
});

test('an expired session becomes EXPIRED/NEEDS_USER with a job-scoped AttentionEnvelope', () => {
  let now = T0;
  const store = createHandleStoreDouble();
  const layer = createAuthProfileLayer({ handleStore: store, clock: () => now });
  layer.registerProfile({ profile_id: 'profile:cli', connector_kind: 'DEEPSEEK_CLI', mode: 'CLI_SESSION', persistence: 'PERSISTENT', expires_at: '2026-01-01T00:30:00Z' });
  layer.bindSecret({ profile_id: 'profile:cli', expected_version: 1, secret_value: 'session-blob-1' });
  assert.equal(layer.authStatusFor({ profile_id: 'profile:cli' }).status, 'READY');

  now = T1;
  const expired = layer.authStatusFor({ profile_id: 'profile:cli', job_ref: 'job:42' });
  assert.equal(expired.status, 'EXPIRED', 'an expired session is never READY');
  assert.equal(expired.reason, 'SESSION_EXPIRED');
  assert.equal(expired.freshness.expired, true);
  assert.equal(expired.freshness.fresh, false);
  assert.equal(expired.freshness.evaluated_at, T1);
  assert.equal(expired.attention_required, true);
  assert.deepEqual(Object.keys(expired.attention).sort(), ['attention_id', 'blocking', 'connector_ref', 'contract_version', 'created_at', 'job_ref', 'kind', 'question'].sort(), 'the envelope matches the EM-005 AttentionEnvelope shape exactly');
  assert.equal(expired.attention.kind, 'AUTHENTICATION');
  assert.equal(expired.attention.blocking, true);
  assert.equal(expired.attention.job_ref, 'job:42');
  assert.equal(expired.attention.created_at, T1);
  assert.equal(containsSecret(expired), false);

  // Without a job the envelope is skipped honestly rather than invented.
  const withoutJob = layer.authStatusFor({ profile_id: 'profile:cli' });
  assert.equal(withoutJob.status, 'EXPIRED');
  assert.equal(withoutJob.attention, null);
  assert.equal(withoutJob.attention_skipped_reason, 'ATTENTION_IS_JOB_SCOPED');

  // NEEDS_USER is distinct from EXPIRED and from MISSING.
  layer.registerProfile({ profile_id: 'profile:oauth', connector_kind: 'GENERIC_CONNECTOR', mode: 'OAUTH' });
  assert.equal(layer.authStatusFor({ profile_id: 'profile:oauth', job_ref: 'job:42' }).status, 'MISSING');
  const needsUser = layer.markUserActionRequired({ profile_id: 'profile:oauth' });
  assert.equal(needsUser.requires_user_action, true);
  const status = layer.authStatusFor({ profile_id: 'profile:oauth', job_ref: 'job:42' });
  assert.equal(status.status, 'NEEDS_USER');
  assert.equal(status.requires_user_action, true);
  assert.equal(status.attention.question.includes('sign in'), true);
  assert.equal(layer.authStatusFor({ profile_id: 'profile:oauth' }).attention_required, true);
});

test('restart restores permitted persistent session references, and only those', () => {
  const store = createHandleStoreDouble();
  const first = createAuthProfileLayer({ handleStore: store, clock: () => T0 });
  first.registerProfile({ profile_id: 'profile:cli', connector_kind: 'DEEPSEEK_CLI', mode: 'CLI_SESSION', persistence: 'PERSISTENT', expires_at: '2026-06-01T00:00:00Z' });
  first.bindSecret({ profile_id: 'profile:cli', expected_version: 1, secret_value: 'session-blob-1' });
  first.registerProfile({ profile_id: 'profile:browser', connector_kind: 'WEB_UI', mode: 'BROWSER_PROFILE', persistence: 'PERSISTENT' });
  first.bindSecret({ profile_id: 'profile:browser', expected_version: 1, secret_value: 'profile-dir-1' });
  first.registerProfile({ profile_id: 'profile:api', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });
  first.bindSecret({ profile_id: 'profile:api', expected_version: 1, secret_value: SECRET });
  first.registerProfile({ profile_id: 'profile:scratch', connector_kind: 'GENERIC_CONNECTOR', mode: 'CLI_SESSION' });
  first.bindSecret({ profile_id: 'profile:scratch', expected_version: 1, secret_value: 'ephemeral-session' });

  const snapshot = first.exportPersistentRefs();
  assert.deepEqual(snapshot.profiles.map(entry => entry.profile_id), ['profile:cli', 'profile:browser'], 'a bearer credential and an ephemeral session are not exported');
  assert.equal(containsSecret(snapshot), false, 'the restart snapshot carries no secret values');
  assert.deepEqual(findSecretFields(snapshot), []);

  const second = createAuthProfileLayer({ handleStore: store, clock: () => T0 });
  const restored = second.restore({ snapshot });
  assert.deepEqual(restored.restored_profiles, ['profile:cli', 'profile:browser']);
  assert.deepEqual(restored.degraded_profiles, []);
  assert.equal(restored.references_only, true);
  assert.equal(restored.plaintext_fallback_used, false);
  const cli = second.authStatusFor({ profile_id: 'profile:cli' });
  assert.equal(cli.status, 'READY', 'the persistent reference still resolves after restart');
  assert.equal(cli.session_ref, 'handle:SESSION:1');
  assert.equal(cli.persistence, 'PERSISTENT');
  assert.equal(second.getProfile('profile:api'), null, 'a non-persistent profile does not come back');
  assert.equal(second.getProfile('profile:scratch'), null);
  assert.equal(containsSecret(restored), false);

  // A snapshot carrying plaintext is refused outright, and an unusable reference degrades honestly.
  expectCode('PLAINTEXT_REFUSED', () => second.restore({ snapshot: { contract_version: 1, profiles: [{ profile_id: 'profile:x', connector_kind: 'DEEPSEEK', mode: 'API_KEY', persistence: 'PERSISTENT', api_key: SECRET }] } }));
  const orphan = createAuthProfileLayer({ handleStore: createHandleStoreDouble(), clock: () => T0 });
  const degraded = orphan.restore({ snapshot: { contract_version: 1, profiles: [{ profile_id: 'profile:gone', connector_kind: 'DEEPSEEK_CLI', mode: 'CLI_SESSION', persistence: 'PERSISTENT', handle_ref: 'handle:SESSION:99' }] } });
  assert.deepEqual(degraded.degraded_profiles, ['profile:gone']);
  assert.equal(orphan.authStatusFor({ profile_id: 'profile:gone' }).status, 'MISSING', 'an unresolvable reference is never reported READY');
  assert.equal(orphan.authStatusFor({ profile_id: 'profile:gone' }).reason, 'HANDLE_UNRESOLVABLE');
});

test('missing secure-store support degrades honestly with no plaintext fallback', () => {
  const noStore = createAuthProfileLayer({ clock: () => T0 });
  const registered = noStore.registerProfile({ profile_id: 'profile:cli', connector_kind: 'DEEPSEEK_CLI', mode: 'CLI_SESSION' });
  assert.equal(registered.store_available, false);
  assert.equal(registered.status, 'MISSING', 'without a store the answer is MISSING, not READY');
  const refused = expectCode('SECURE_STORE_REQUIRED', () => noStore.bindSecret({ profile_id: 'profile:cli', expected_version: 1, secret_value: SECRET }));
  assert.equal(refused.status, 503);
  assert.equal(containsSecret(noStore.getProfile('profile:cli')), false, 'the refusal leaves no plaintext in canonical state');
  assert.equal(noStore.getProfile('profile:cli').handle_ref, null);
  assert.equal(containsSecret(noStore.logEntries()), false);
  expectCode('SECURE_STORE_UNAVAILABLE', () => noStore.bindSecret({ profile_id: 'profile:cli', expected_version: 1, handle_ref: 'handle:SESSION:1' }));

  // A profile that had a reference but lost its store reports UNAVAILABLE, still not READY.
  const store = createHandleStoreDouble();
  const withStore = createAuthProfileLayer({ handleStore: store, clock: () => T0 });
  withStore.registerProfile({ profile_id: 'profile:cli', connector_kind: 'DEEPSEEK_CLI', mode: 'CLI_SESSION' });
  const bound = withStore.bindSecret({ profile_id: 'profile:cli', expected_version: 1, secret_value: 'session-blob-1' });
  const snapshot = { contract_version: 1, profiles: [{ profile_id: 'profile:cli', connector_kind: 'DEEPSEEK_CLI', mode: 'CLI_SESSION', persistence: 'PERSISTENT', handle_ref: bound.session_ref }] };
  const storeless = createAuthProfileLayer({ clock: () => T0 });
  storeless.restore({ snapshot });
  const status = storeless.authStatusFor({ profile_id: 'profile:cli' });
  assert.equal(status.store_available, false);
  assert.equal(status.status, 'UNAVAILABLE');
  assert.equal(status.reason, 'SECURE_STORE_UNAVAILABLE');
  assert.equal(status.attention_required, true);
  assert.equal(status.freshness.fresh, false, 'unavailable is not fresh');
});

test('legacy DeepSeek env discovery is consumable through the abstraction without becoming the schema', () => {
  const store = createHandleStoreDouble();
  const layer = createAuthProfileLayer({ handleStore: store, clock: () => T0 });
  const discovered = layer.discoverFromLegacyEnv({ env: { DEEPSEEK_API_KEY: SECRET, PATH: '/usr/bin' } });
  assert.equal(discovered.discovered, true);
  assert.equal(discovered.legacy_source, 'DEEPSEEK_API_KEY');
  assert.equal(discovered.mode, 'API_KEY');
  assert.equal(discovered.secret_stored, true);
  assert.equal(discovered.secret_returned, false, 'the discovered value is never returned to the caller');
  assert.equal(containsSecret(discovered), false);
  assert.equal(discovered.profile.credential_ref, 'handle:CREDENTIAL:1');
  assert.equal(store.resolveHandle('handle:CREDENTIAL:1').value, SECRET);
  assert.equal(discovered.profile.account_ref, null);
  assert.deepEqual(findSecretFields(discovered), []);

  // The neutral schema is the same for a connector that has nothing to do with DeepSeek .env.
  const other = layer.registerProfile({ profile_id: 'profile:local-cli', connector_kind: 'LOCAL_CODING_CLI', mode: 'CLI_SESSION', persistence: 'PERSISTENT' });
  assert.deepEqual(Object.keys(other).sort(), Object.keys(layer.registerProfile({ profile_id: 'profile:other', connector_kind: 'SOMETHING_ELSE', mode: 'DESKTOP_SESSION' })).sort(), 'one neutral record shape for every connector');
  layer.bindSecret({ profile_id: 'profile:local-cli', expected_version: 1, secret_value: 'session-blob-2' });
  assert.equal(layer.authStatusFor({ profile_id: 'profile:local-cli' }).status, 'READY');

  // A provider-specific env key cannot be smuggled into the schema.
  expectCode('PLAINTEXT_REFUSED', () => layer.registerProfile({ profile_id: 'profile:bad', connector_kind: 'DEEPSEEK', mode: 'API_KEY', deepseek_api_key: SECRET }));
  const empty = layer.discoverFromLegacyEnv({ env: { PATH: '/usr/bin' } });
  assert.equal(empty.discovered, false);
  assert.equal(empty.profile, null);
  assert.equal(containsSecret(layer.logEntries()), false);
});

test('the profile contract is declarative, versioned and lifecycle-honest', () => {
  const { store, layer } = layerAt();
  expectCode('INVALID_PROFILE', () => layer.registerProfile({ profile_id: 'p', connector_kind: 'X', mode: 'API_KEY', nickname: 'n' }), 'unknown keys are rejected');
  expectCode('PLAINTEXT_REFUSED', () => layer.registerProfile({ profile_id: 'p', connector_kind: 'X', mode: 'API_KEY', api_key: SECRET }), 'a secret-bearing input is named as such, not merely malformed');
  expectCode('INVALID_PROFILE', () => layer.registerProfile({ profile_id: 'p', connector_kind: 'X' }));
  expectCode('INVALID_PROFILE', () => layer.registerProfile({ profile_id: 'p', connector_kind: 'X', mode: 'MAGIC' }));
  expectCode('INVALID_PROFILE', () => layer.registerProfile({ profile_id: 'p', connector_kind: 'X', mode: 'API_KEY', persistence: 'FOREVER' }));
  layer.registerProfile({ profile_id: 'profile:key', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });
  expectCode('DUPLICATE_PROFILE', () => layer.registerProfile({ profile_id: 'profile:key', connector_kind: 'DEEPSEEK', mode: 'API_KEY' }));
  expectCode('MODE_NOT_PERSISTABLE', () => layer.registerProfile({ profile_id: 'profile:key2', connector_kind: 'DEEPSEEK', mode: 'API_KEY', persistence: 'PERSISTENT' }));
  expectCode('PROFILE_VERSION_CONFLICT', () => layer.bindSecret({ profile_id: 'profile:key', expected_version: 9, secret_value: SECRET }));
  expectCode('INVALID_PROFILE', () => layer.bindSecret({ profile_id: 'profile:key', expected_version: 1, secret_value: SECRET, kind: 'CREDENTIAL' }));
  expectCode('SECRET_VALUE_REQUIRED', () => layer.bindSecret({ profile_id: 'profile:key', expected_version: 1 }));
  expectCode('UNKNOWN_PROFILE', () => layer.bindSecret({ profile_id: 'profile:nope', expected_version: 1, secret_value: SECRET }));
  assert.equal(layer.getProfile('profile:key').profile_version, 1, 'refused binds did not bump the version');

  const bound = layer.bindSecret({ profile_id: 'profile:key', expected_version: 1, secret_value: SECRET });
  assert.equal(bound.profile_version, 2);
  const revoked = layer.revoke({ profile_id: 'profile:key' });
  assert.equal(revoked.status, 'MISSING');
  assert.equal(revoked.handle_ref, null);
  assert.equal(layer.logEntries().some(entry => entry.event === 'PROFILE_REVOKED' && entry.store_revoked === true), true, 'the handle is revoked in the store too');
  assert.throws(() => store.resolveHandle('handle:CREDENTIAL:1'), 'a revoked handle cannot be resolved');

  const frozen = layer.registerProfile({ profile_id: 'profile:frozen', connector_kind: 'X', mode: 'OAUTH' });
  assert.throws(() => { frozen.status = 'READY'; }, TypeError, 'records are frozen');
  assert.throws(() => createAuthProfileLayer({ clock: 'now' }), error => error.code === 'INVALID_PROFILE');
});

// ---------------------------------------------------------------- Alien Correction regressions
// Every test below fails against the Development head and passes against the corrected head.

test('a handle reference that is secret material never reaches canonical state', () => {
  const { layer } = layerAt();
  layer.registerProfile({ profile_id: 'profile:key', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });
  expectCode('PLAINTEXT_REFUSED', () => layer.bindSecret({ profile_id: 'profile:key', expected_version: 1, handle_ref: SECRET }));
  assert.equal(layer.getProfile('profile:key').handle_ref, null, 'nothing was recorded');
  assert.equal(layer.getProfile('profile:key').references_only, true);
  assert.equal(containsSecret(layer.getProfile('profile:key')), false);
  assert.equal(containsSecret(layer.diagnosticSnapshot()), false);
  assert.equal(layer.getProfile('profile:key').profile_version, 1, 'the refused bind did not bump the version');

  // A store that hands the value back instead of a handle would put plaintext straight into the record.
  const echoing = Object.freeze({ putHandle: ({ value }) => ({ handle_ref: value }), resolveHandle: () => ({ ok: true }), revokeHandle: () => ({ revoked: false }) });
  const echoingLayer = createAuthProfileLayer({ handleStore: echoing, clock: () => T0 });
  echoingLayer.registerProfile({ profile_id: 'profile:echo', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });
  expectCode('PLAINTEXT_REFUSED', () => echoingLayer.bindSecret({ profile_id: 'profile:echo', expected_version: 1, secret_value: SECRET }));
  assert.equal(containsSecret(echoingLayer.getProfile('profile:echo')), false);
  assert.equal(containsSecret(echoingLayer.diagnosticSnapshot()), false);
  assert.equal(containsSecret(echoingLayer.logEntries()), false);
});

test('binding refuses an ambiguous secret-or-handle request', () => {
  const { layer } = layerAt();
  layer.registerProfile({ profile_id: 'profile:key', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });
  expectCode('INVALID_PROFILE', () => layer.bindSecret({ profile_id: 'profile:key', expected_version: 1, secret_value: SECRET, handle_ref: 'handle:CREDENTIAL:1' }));
  assert.equal(layer.getProfile('profile:key').handle_ref, null, 'neither input was applied');
  assert.equal(layer.getProfile('profile:key').profile_version, 1);
  assert.equal(layer.bindSecret({ profile_id: 'profile:key', expected_version: 1, secret_value: SECRET }).status, 'READY');
});

test('an uninterpretable instant is never fresh, READY or recorded', () => {
  const { layer } = layerAt();
  assert.equal(isIsoInstant('2026-13-45T99:99:99Z'), false, 'a shape-valid but unparseable instant is not an instant');
  assert.equal(isIsoInstant('2026-01-01T00:00:00.000Z'), true);
  expectCode('INVALID_PROFILE', () => layer.registerProfile({ profile_id: 'profile:bad-expiry', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', expires_at: '2026-13-45T99:99:99Z' }));
  expectCode('INVALID_PROFILE', () => layer.registerProfile({ profile_id: 'profile:bad-at', connector_kind: 'X', mode: 'API_KEY', at: '2026-02-30T00:00:00Z' }));
  assert.equal(layer.getProfile('profile:bad-expiry'), null, 'nothing was registered');
  const restored = layerAt().layer;
  expectCode('INVALID_PROFILE', () => restored.restore({ snapshot: { profiles: [{ profile_id: 'q', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', expires_at: '2026-13-45T99:99:99Z' }] } }));
  expectCode('INVALID_PROFILE', () => restored.restore({ snapshot: { profiles: [{ profile_id: 'q', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT' }] }, at: '2026-02-30T00:00:00Z' }));
  assert.equal(restored.getProfile('q'), null);
  // a real expiry still expires, and no expiry is still valid
  const live = layerAt().layer;
  live.registerProfile({ profile_id: 'profile:cli', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', expires_at: '2026-01-01T00:30:00Z' });
  live.bindSecret({ profile_id: 'profile:cli', expected_version: 1, secret_value: 'blob' });
  assert.equal(live.authStatusFor({ profile_id: 'profile:cli' }).status, 'READY');
  assert.equal(live.authStatusFor({ profile_id: 'profile:cli', at: T1 }).status, 'EXPIRED');
});

test('a user-action requirement is a boolean, not a truthy flag', () => {
  const { layer } = layerAt();
  layer.registerProfile({ profile_id: 'profile:oauth', connector_kind: 'X', mode: 'OAUTH' });
  layer.markUserActionRequired({ profile_id: 'profile:oauth' });
  assert.equal(layer.getProfile('profile:oauth').requires_user_action, true);
  expectCode('INVALID_PROFILE', () => layer.markUserActionRequired({ profile_id: 'profile:oauth', required: 'yes' }));
  expectCode('INVALID_PROFILE', () => layer.markUserActionRequired({ profile_id: 'profile:oauth', required: 1 }));
  assert.equal(layer.getProfile('profile:oauth').requires_user_action, true, 'the requirement was not silently cleared');
  assert.equal(layer.authStatusFor({ profile_id: 'profile:oauth' }).status, 'NEEDS_USER');
  layer.markUserActionRequired({ profile_id: 'profile:oauth', required: false });
  assert.equal(layer.getProfile('profile:oauth').requires_user_action, false);
  assert.equal(layer.authStatusFor({ profile_id: 'profile:oauth' }).status, 'MISSING');
});

test('canonical records are plain own-key objects', () => {
  const { layer } = layerAt();
  for (const key of ['toString', 'constructor', 'valueOf']) {
    expectCode('INVALID_PROFILE', () => layer.registerProfile({ profile_id: `profile:${key}`, connector_kind: 'X', mode: 'API_KEY', [key]: 'smuggled' }));
  }
  const hidden = { profile_id: 'profile:hidden', connector_kind: 'X', mode: 'API_KEY' };
  Object.defineProperty(hidden, 'api_key', { value: SECRET, enumerable: false });
  expectCode('PLAINTEXT_REFUSED', () => layer.registerProfile(hidden), 'a hidden own secret field is still named as a secret');
  assert.deepEqual(findSecretFields(hidden), ['record.api_key'], 'the scan sees own keys, not just enumerable ones');
  const symbol = { profile_id: 'profile:sym', connector_kind: 'X', mode: 'API_KEY' };
  symbol[Symbol('extra')] = 'x';
  expectCode('INVALID_PROFILE', () => layer.registerProfile(symbol));
  class Fabricated { constructor() { this.profile_id = 'profile:class'; this.connector_kind = 'X'; this.mode = 'API_KEY'; } }
  expectCode('INVALID_PROFILE', () => layer.registerProfile(new Fabricated()));
  expectCode('INVALID_PROFILE', () => layer.registerProfile(Object.assign(Object.create({ api_key: SECRET }), { profile_id: 'profile:proto', connector_kind: 'X', mode: 'API_KEY' })));
  assert.equal(layer.getProfile('profile:hidden'), null, 'nothing was admitted');
  assert.equal(layer.diagnosticSnapshot().profiles.length, 0);
});

test('a cyclic caller value is refused instead of crashing the scan', () => {
  const { layer } = layerAt();
  const cyclic = { profile_id: 'profile:cyclic', connector_kind: 'X', mode: 'API_KEY' };
  cyclic.self = cyclic;
  expectCode('INVALID_PROFILE', () => layer.registerProfile(cyclic));
  assert.equal(layer.getProfile('profile:cyclic'), null);
  const inner = {};
  inner.self = inner;
  expectCode('INVALID_PROFILE', () => layer.restore({ snapshot: { profiles: [inner] } }));
  assert.equal(JSON.stringify(redact({ nested: cyclic })).includes('CIRCULAR'), true, 'redaction survives a cycle instead of recursing forever');
  assert.deepEqual(findSecretFields({ api_key: SECRET }), ['record.api_key']);
});

test('restore validates a snapshot entry as strictly as a registration', () => {
  const { layer } = layerAt();
  expectCode('INVALID_PROFILE', () => layer.restore({ snapshot: { profiles: [{ profile_id: 'q', mode: 'CLI_SESSION', persistence: 'PERSISTENT' }] } }));
  expectCode('INVALID_PROFILE', () => layer.restore({ snapshot: { profiles: [{ profile_id: 'q', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', handle_ref: 42 }] } }));
  expectCode('INVALID_PROFILE', () => layer.restore({ snapshot: { profiles: [{ profile_id: 'q', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', account_ref: { evil: true } }] } }));
  expectCode('INVALID_PROFILE', () => layer.restore({ snapshot: { profiles: [{ profile_id: 'q', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', profile_version: 1.5 }] } }));
  expectCode('PLAINTEXT_REFUSED', () => layer.restore({ snapshot: { profiles: [{ profile_id: 'q', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', handle_ref: SECRET }] } }));
  assert.equal(layer.getProfile('q'), null, 'nothing was restored from an invalid snapshot');
  const good = layer.restore({ snapshot: { profiles: [{ profile_id: 'q', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', handle_ref: 'handle:SESSION:1' }] } });
  assert.deepEqual(good.restored_profiles, ['q']);
  assert.equal(layer.getProfile('q').connector_kind, 'X');
  const skipped = layer.restore({ snapshot: { profiles: [{ profile_id: 'api', connector_kind: 'X', mode: 'API_KEY', persistence: 'EPHEMERAL' }] } });
  assert.deepEqual(skipped.skipped_non_persistent, ['api'], 'a non-persistent entry is still skipped rather than refused');
});

test('revocation stays observable after the handle is cleared', () => {
  const { layer } = layerAt();
  layer.registerProfile({ profile_id: 'profile:key', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });
  layer.bindSecret({ profile_id: 'profile:key', expected_version: 1, secret_value: SECRET });
  assert.equal(layer.getProfile('profile:key').revoked_at, null, 'an active profile is not marked revoked');
  const revoked = layer.revoke({ profile_id: 'profile:key' });
  assert.equal(revoked.handle_ref, null);
  assert.equal(revoked.revoked_at, T0, 'the revocation instant is part of the lifecycle record');
  assert.equal(revoked.revoked_reason, 'HANDLE_REVOKED');
  assert.equal(layer.getProfile('profile:key').revoked_at, T0, 'and it survives a later read');
  assert.equal(layer.authStatusFor({ profile_id: 'profile:key' }).status, 'MISSING');
  // re-binding clears the revocation rather than leaving a stale lifecycle marker
  assert.equal(layer.getProfile('profile:key').profile_version, 3);
  layer.bindSecret({ profile_id: 'profile:key', expected_version: 3, secret_value: SECRET });
  assert.equal(layer.getProfile('profile:key').revoked_at, null);
});

test('a rotation revokes the handle it replaces instead of abandoning it', () => {
  const { store, layer } = layerAt();
  layer.registerProfile({ profile_id: 'profile:cli', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT' });
  const first = layer.bindSecret({ profile_id: 'profile:cli', expected_version: 1, secret_value: 'session-one' });
  const second = layer.bindSecret({ profile_id: 'profile:cli', expected_version: 2, secret_value: 'session-two' });
  assert.notEqual(first.session_ref, second.session_ref);
  assert.throws(() => store.resolveHandle(first.session_ref), 'the superseded handle is no longer live');
  assert.equal(store.resolveHandle(second.session_ref).value, 'session-two');
  assert.equal(layer.logEntries().some(entry => entry.event === 'HANDLE_BOUND' && entry.previous_handle_revoked === true), true);
  // a caller-supplied reference the layer did not create is never revoked behind the caller's back
  const reused = layer.bindSecret({ profile_id: 'profile:cli', expected_version: 3, handle_ref: 'handle:SESSION:99' });
  assert.equal(reused.session_ref, 'handle:SESSION:99');
});

test('a well-shaped record may not carry a secret in a legitimate field', () => {
  const { layer } = layerAt();
  expectCode('PLAINTEXT_REFUSED', () => layer.registerProfile({ profile_id: SECRET, connector_kind: 'X', mode: 'API_KEY' }));
  expectCode('PLAINTEXT_REFUSED', () => layer.registerProfile({ profile_id: 'profile:ok', connector_kind: SECRET, mode: 'API_KEY' }));
  expectCode('PLAINTEXT_REFUSED', () => layer.registerProfile({ profile_id: 'profile:ok', connector_kind: 'X', mode: 'API_KEY', account_ref: SECRET }));
  layer.registerProfile({ profile_id: 'profile:key', connector_kind: 'X', mode: 'API_KEY' });
  expectCode('PLAINTEXT_REFUSED', () => layer.bindSecret({ profile_id: SECRET, expected_version: 1, secret_value: 'blob' }));
  assert.equal(layer.diagnosticSnapshot().profiles.length, 1, 'only the legitimate profile is in canonical state');
  assert.equal(layer.getProfile(SECRET), null);
  assert.equal(containsSecret(layer.diagnosticSnapshot()), false);
  assert.equal(containsSecret(layer.logEntries()), false);
});

test('everything the scan calls a secret is redacted', () => {
  for (const token of ['ghp_abcdefghijklmnopqrst', 'gho_abcdefghijklmnopqrst', 'AKIAabcdefghijklmnop', 'xoxb-abcdefghijklmnop', 'sk_live_abcdefghijklmnop', 'sk-abcdefghijklmnop']) {
    assert.equal(looksLikeSecretValue(token), true, token);
    assert.equal(redact({ note: token }).note, '[REDACTED]', `${token} is redacted as a bare value`);
    assert.equal(redact({ note: `store said ${token} while writing` }).note.includes(token), false, `${token} is redacted inside a message`);
    assert.equal(redact({ message: `${token}` }).message, '[REDACTED]', token);
    assert.deepEqual(findSecretFields({ note: token }), ['record.note'], token);
  }
  const redacted = redact({ keep: 'plain text', handle_ref: 'handle:CREDENTIAL:1' });
  assert.equal(redacted.keep, 'plain text', 'ordinary text is not over-redacted');
  assert.equal(redacted.handle_ref, 'handle:CREDENTIAL:1', 'a handle reference is not a secret');
  // a hostile store message carrying a separator-less token never reaches the log
  const hostile = Object.freeze({ putHandle: () => { throw new Error('failed while writing AKIAabcdefghijklmnop'); }, resolveHandle: () => ({ ok: true }), revokeHandle: () => ({ revoked: false }) });
  const layer = createAuthProfileLayer({ handleStore: hostile, clock: () => T0 });
  layer.registerProfile({ profile_id: 'p', connector_kind: 'X', mode: 'API_KEY' });
  expectCode('SECURE_STORE_FAILED', () => layer.bindSecret({ profile_id: 'p', expected_version: 1, secret_value: 'blob' }));
  assert.equal(JSON.stringify(layer.logEntries()).includes('AKIAabcdefghijklmnop'), false, 'the log carries the redaction, not the token');
});

test('a hidden own field on a snapshot entry is not copied into canonical state', () => {
  const { layer } = layerAt();
  const entry = { profile_id: 'q', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT' };
  Object.defineProperty(entry, 'account_ref', { value: SECRET, enumerable: false });
  expectCode('PLAINTEXT_REFUSED', () => layer.restore({ snapshot: { profiles: [entry] } }));
  assert.equal(layer.getProfile('q'), null);
  const hiddenHandle = { profile_id: 'r', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT' };
  Object.defineProperty(hiddenHandle, 'handle_ref', { value: SECRET, enumerable: false });
  expectCode('PLAINTEXT_REFUSED', () => layer.restore({ snapshot: { profiles: [hiddenHandle] } }));
  assert.equal(layer.getProfile('r'), null);
  const undeclared = { profile_id: 's', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT' };
  Object.defineProperty(undeclared, 'note', { value: 'extra', enumerable: false });
  expectCode('INVALID_PROFILE', () => layer.restore({ snapshot: { profiles: [undeclared] } }), 'an own-but-undeclared key is not part of the snapshot contract');
  assert.equal(layer.getProfile('s'), null);
});

test('legacy discovery never binds the key into a foreign default profile', () => {
  const { layer } = layerAt();
  layer.registerProfile({ profile_id: 'profile:default', connector_kind: 'WEB_UI', mode: 'BROWSER_PROFILE', persistence: 'PERSISTENT' });
  expectCode('INVALID_PROFILE', () => layer.discoverFromLegacyEnv({ env: { DEEPSEEK_API_KEY: SECRET } }));
  assert.equal(layer.getProfile('profile:default').handle_ref, null, 'the browser profile was not bound to an API key');
  assert.deepEqual(layer.exportPersistentRefs().profiles.map(entry => entry.handle_ref), [null], 'and the key was not exported as a session reference');
  assert.equal(containsSecret(layer.diagnosticSnapshot()), false);
  const fresh = layerAt().layer;
  const discovered = fresh.discoverFromLegacyEnv({ env: { DEEPSEEK_API_KEY: SECRET } });
  assert.equal(discovered.connector_kind, fresh.getProfile('profile:default').connector_kind, 'the descriptor is built from the record that was written');
  assert.equal(discovered.mode, 'API_KEY');
  assert.equal(discovered.profile.mode, fresh.getProfile('profile:default').mode);
});

test('a caller field is validated and stored as the same value', () => {
  const { layer } = layerAt();
  let reads = 0;
  const twoFaced = { profile_id: 'profile:two-faced', connector_kind: 'X', persistence: 'EPHEMERAL' };
  Object.defineProperty(twoFaced, 'mode', { enumerable: true, configurable: true, get() { reads += 1; return reads <= 2 ? 'API_KEY' : 'EVIL'; } });
  const registered = layer.registerProfile(twoFaced);
  assert.equal(registered.mode, 'API_KEY', 'the validated mode is the stored mode');
  assert.equal(layer.getProfile('profile:two-faced').mode, 'API_KEY');
  assert.equal(AUTH_MODES.includes(registered.mode), true);
});

test('a refused restore installs nothing and never replaces a live profile', () => {
  const { layer } = layerAt();
  const good = { profile_id: 'good', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT' };
  const bad = { profile_id: 'bad', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', expires_at: '2026-13-45T99:99:99Z' };
  expectCode('INVALID_PROFILE', () => layer.restore({ snapshot: { profiles: [good, bad] } }));
  assert.equal(layer.getProfile('good'), null, 'the valid entry before the invalid one was not installed');
  assert.equal(layer.getProfile('bad'), null);
  assert.equal(layer.logEntries().some(entry => entry.event === 'SNAPSHOT_RESTORED'), false, 'a refused restore records no success');
  layer.registerProfile({ profile_id: 'live', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT' });
  expectCode('DUPLICATE_PROFILE', () => layer.restore({ snapshot: { profiles: [{ profile_id: 'live', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT' }] } }));
  assert.equal(layer.getProfile('live').profile_version, 1, 'the live profile was not replaced');
});

test('revoke reports whether the store released the secret', () => {
  const store = createHandleStoreDouble();
  const layer = createAuthProfileLayer({ handleStore: store, clock: () => T0 });
  layer.registerProfile({ profile_id: 'profile:key', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });
  layer.bindSecret({ profile_id: 'profile:key', expected_version: 1, secret_value: SECRET });
  const revoked = layer.revoke({ profile_id: 'profile:key' });
  assert.equal(revoked.handle_released, true, 'the store confirmed the release');
  assert.equal(revoked.store_revoke_attempted, true);
  assert.equal(revoked.handle_ref, null, 'the layer still holds no reference');
  assert.equal(revoked.status, 'MISSING');
  // a store that cannot revoke is reported rather than assumed
  const weak = Object.freeze({ putHandle: ({ kind }) => ({ handle_ref: `handle:${kind}:9` }), resolveHandle: () => ({ ok: true }) });
  const weakLayer = createAuthProfileLayer({ handleStore: weak, clock: () => T0 });
  weakLayer.registerProfile({ profile_id: 'profile:weak', connector_kind: 'DEEPSEEK', mode: 'API_KEY' });
  weakLayer.bindSecret({ profile_id: 'profile:weak', expected_version: 1, secret_value: SECRET });
  const weakRevoked = weakLayer.revoke({ profile_id: 'profile:weak' });
  assert.equal(weakRevoked.store_revoke_attempted, false, 'the store was never asked');
  assert.equal(weakRevoked.handle_released, false, 'and no release is claimed');
  assert.equal(weakLayer.getProfile('profile:weak').handle_ref, null);
});

test('freshness cannot be rewound behind the layer clock', () => {
  const now = T1;
  const store = createHandleStoreDouble();
  const layer = createAuthProfileLayer({ handleStore: store, clock: () => now });
  layer.registerProfile({ profile_id: 'profile:cli', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', expires_at: '2026-01-01T00:30:00Z' });
  layer.bindSecret({ profile_id: 'profile:cli', expected_version: 1, secret_value: 'blob' });
  assert.equal(layer.authStatusFor({ profile_id: 'profile:cli' }).status, 'EXPIRED');
  expectCode('INVALID_PROFILE', () => layer.authStatusFor({ profile_id: 'profile:cli', at: T0 }), 'an expired session cannot be asked about as of before it expired');
  assert.equal(layer.authStatusFor({ profile_id: 'profile:cli' }).status, 'EXPIRED');
  assert.equal(layer.authStatusFor({ profile_id: 'profile:cli', at: '2026-01-01T02:00:00Z' }).status, 'EXPIRED', 'a later instant still expires it');
  expectCode('INVALID_PROFILE', () => layer.registerProfile({ profile_id: 'late', connector_kind: 'X', mode: 'API_KEY', at: T0 }));
  assert.equal(layer.getProfile('late'), null);
});

test('carrying a stale expiry over a new credential is observable', () => {
  const { layer } = layerAt();
  layer.registerProfile({ profile_id: 'profile:cli', connector_kind: 'X', mode: 'CLI_SESSION', persistence: 'PERSISTENT', expires_at: '2026-01-01T00:30:00Z' });
  layer.bindSecret({ profile_id: 'profile:cli', expected_version: 1, secret_value: 'one' });
  const rebound = layer.bindSecret({ profile_id: 'profile:cli', expected_version: 2, secret_value: 'two' });
  assert.equal(rebound.status, 'READY', 'the fresh credential is still valid at the registered expiry');
  assert.equal(layer.logEntries().some(entry => entry.event === 'HANDLE_BOUND' && entry.expiry_carried_over === true), true, 'the carried expiry is recorded, not silent');
  assert.equal(layer.authStatusFor({ profile_id: 'profile:cli', at: T1 }).status, 'EXPIRED', 'and it still fails closed at the recorded expiry');
  const cleared = layer.bindSecret({ profile_id: 'profile:cli', expected_version: 3, secret_value: 'three', expires_at: null });
  assert.equal(cleared.freshness.expires_at, null, 'an explicit null clears the carried expiry');
  assert.equal(cleared.status, 'READY');
  assert.equal(layer.authStatusFor({ profile_id: 'profile:cli', at: T1 }).status, 'READY', 'the new credential has no inherited expiry');
});
