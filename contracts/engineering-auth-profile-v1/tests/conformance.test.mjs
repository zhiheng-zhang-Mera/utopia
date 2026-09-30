// Conformance tests for EM-008 闁?credential references + persistent connector profiles/sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_MODES, AUTH_STATUSES, PERSISTABLE_MODES, SECURE_HANDLE_STORE_PORT, AuthProfileError,
  createAuthProfileLayer, findSecretFields, looksLikeSecretValue, redact,
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
