// GAI-002 conformance suite — provider / model / account registry.
//
// Acceptance: provider/model/account identities remain distinct under multiple accounts; stale
// capability metadata is visible as stale/unknown; channel readiness can differ between WEB and API;
// missing model/provider/account produces typed absence; raw secret/cookie/token material is rejected
// from canonical records; the registry works with synthetic providers and hard-codes no identities.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 ABSENCE_CODES, AVAILABILITY_REASONS, CAPABILITY_FACTS, CHANNELS, CHANNEL_READINESS, ENABLEMENT,
 FRESHNESS, GAI_REGISTRY_CONTRACT, REASON_SOURCES, SELECTABLE_REASON,
 RegistryError, SECURE_HANDLE_STORE_PORT, SUBJECT_KINDS, SUPPORT_LEVELS, capabilityOf,
 channelReadiness, createDeterministicHandleStoreDouble, createProviderRegistry, findRawSecretFields,
 findRawSecretValues, findReservedKeyPaths, isSecretFieldName, normalizeFieldName,
 freshnessOf, validateModelDescriptor, validateProviderAccount, validateProviderDescriptor
} from '../index.mjs';

const T0 = Date.parse('2026-09-30T12:00:00.000Z');
const T_LATER = Date.parse('2026-09-30T12:05:00.000Z');
const ISO = ms => new Date(ms).toISOString();
const TTL = 60_000;
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const providerRecord = (overrides = {}) => ({
  registry_version: 1,
  provider_ref: 'provider-alpha',
  display_name: 'Synthetic Alpha',
  enablement: 'ENABLED',
  region: null,
  channels: [{ channel: 'WEB', readiness: 'READY' }, { channel: 'API', readiness: 'AUTH_REQUIRED' }],
  capabilities: { TEXT: 'SUPPORTED', VISION: 'UNSUPPORTED' },
  observed_at: ISO(T0),
  source: { kind: 'PROBED', ref: 'probe-1' },
  ttl_ms: TTL,
  ...overrides,
});

const modelRecord = (overrides = {}) => ({
  registry_version: 1,
  model_ref: 'model-alpha',
  provider_ref: 'provider-alpha',
  display_name: 'Synthetic Alpha Large',
  enablement: 'ENABLED',
  channels: [{ channel: 'WEB', readiness: 'READY' }],
  capabilities: { TEXT: 'SUPPORTED', LONG_CONTEXT: 'SUPPORTED', TOOLS: 'UNKNOWN' },
  context_window: 128000,
  observed_at: ISO(T0),
  source: { kind: 'PROBED', ref: 'probe-1' },
  ttl_ms: TTL,
  ...overrides,
});

const accountRecord = (overrides = {}) => ({
  registry_version: 1,
  account_ref: 'account-alpha-1',
  provider_ref: 'provider-alpha',
  display_name: 'Alpha account one',
  enablement: 'ENABLED',
  status: 'AUTHENTICATED',
  channel_handles: { WEB: { handle_ref: 'handle:profile:1', kind: 'BROWSER_PROFILE' }, API: { handle_ref: 'handle:credential:1', kind: 'API_CREDENTIAL' } },
  capabilities: { TEXT: 'SUPPORTED' },
  observed_at: ISO(T0),
  source: { kind: 'CONFIGURED', ref: 'config-1' },
  ttl_ms: TTL,
  ...overrides,
});

const freshRegistry = (clockMs = T0) => createProviderRegistry({ handleStore: createDeterministicHandleStoreDouble(), clock: () => clockMs });

/* -------------------------------------------------- 1. identities */

test('provider, model and account identities stay distinct across multiple accounts', () => {
  const registry = freshRegistry();
  registry.upsertProvider(providerRecord());
  registry.upsertModel(modelRecord());
  registry.upsertAccount(accountRecord());
  registry.upsertAccount(accountRecord({ account_ref: 'account-alpha-2', display_name: 'Alpha account two', status: 'UNAUTHENTICATED' }));

  assert.deepEqual(registry.listAccounts({ providerRef: 'provider-alpha' }).map(entry => entry.account_ref), ['account-alpha-1', 'account-alpha-2']);
  assert.deepEqual(registry.listProviders().map(entry => entry.provider_ref), ['provider-alpha']);
  assert.deepEqual(registry.listModels({ providerRef: 'provider-alpha' }).map(entry => entry.model_ref), ['model-alpha']);
  // an account reference may not be reused as a provider or model identity
  expectCode(() => registry.upsertAccount(accountRecord({ provider_ref: 'provider-beta' })), 'UNKNOWN_PROVIDER');
  registry.upsertProvider(providerRecord({ provider_ref: 'provider-beta', display_name: 'Synthetic Beta' }));
  expectCode(() => registry.upsertAccount(accountRecord({ account_ref: 'provider-alpha', provider_ref: 'provider-beta' })), 'IDENTITY_COLLISION');
  expectCode(() => registry.upsertAccount(accountRecord({ account_ref: 'model-alpha' })), 'IDENTITY_COLLISION');
  // a model belongs to exactly one provider
  expectCode(() => registry.upsertModel(modelRecord({ provider_ref: 'provider-beta' })), 'IDENTITY_COLLISION');
  assert.equal(GAI_REGISTRY_CONTRACT.account_identity_is_provider_identity, false);
  assert.equal(GAI_REGISTRY_CONTRACT.multiple_accounts_per_provider, true);
});

/* -------------------------------------------------- 2. freshness */

test('stale capability metadata is visible as stale and reads as unknown', () => {
  const registry = freshRegistry();
  registry.upsertProvider(providerRecord());
  assert.deepEqual(registry.capability({ subject: 'PROVIDER', ref: 'provider-alpha', fact: 'TEXT' }), {
    found: true, code: null, fact: 'TEXT', level: 'SUPPORTED', freshness: 'FRESH',
  });
  assert.equal(capabilityOf(providerRecord(), 'TEXT', T0).level, 'SUPPORTED');
  // past the ttl the same fact is STALE and its level collapses to UNKNOWN, never the remembered value
  const stale = capabilityOf(providerRecord(), 'TEXT', T0 + TTL + 1);
  assert.deepEqual(stale, { fact: 'TEXT', level: 'UNKNOWN', freshness: 'STALE' });
  assert.equal(freshnessOf(providerRecord(), T0 + TTL + 1), 'STALE');
  assert.equal(freshnessOf(providerRecord({ observed_at: 'not-an-instant' }), T0), 'UNKNOWN');
  const registryStale = freshRegistry(T0 + TTL + 1);
  registryStale.upsertProvider(providerRecord());
  const reported = registryStale.freshness({ subject: 'PROVIDER', ref: 'provider-alpha' });
  assert.equal(reported.freshness, 'STALE');
  assert.equal(reported.source.kind, 'PROBED');
  assert.equal(registryStale.capability({ subject: 'PROVIDER', ref: 'provider-alpha', fact: 'TEXT' }).level, 'UNKNOWN');
  // an unverified fact is UNKNOWN, never assumed true
  assert.equal(capabilityOf(providerRecord(), 'CODE', T0).level, 'UNKNOWN');
  assert.deepEqual([...SUPPORT_LEVELS], ['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN']);
  assert.deepEqual([...FRESHNESS], ['FRESH', 'STALE', 'UNKNOWN']);
  assert.equal(GAI_REGISTRY_CONTRACT.unknown_capability_default, 'UNKNOWN');
  assert.equal(GAI_REGISTRY_CONTRACT.stale_capability_reads_as, 'UNKNOWN');
});

/* -------------------------------------------------- 3. channels */

test('WEB and API readiness are answered independently and may differ', () => {
  const registry = freshRegistry();
  registry.upsertProvider(providerRecord());
  const web = registry.readiness({ subject: 'PROVIDER', ref: 'provider-alpha', channel: 'WEB' });
  const api = registry.readiness({ subject: 'PROVIDER', ref: 'provider-alpha', channel: 'API' });
  assert.equal(web.readiness, 'READY');
  assert.equal(api.readiness, 'AUTH_REQUIRED');
  assert.notEqual(web.readiness, api.readiness);
  // a channel the record does not declare is UNKNOWN rather than assumed available
  registry.upsertModel(modelRecord());
  assert.equal(registry.readiness({ subject: 'MODEL', ref: 'model-alpha', channel: 'API' }).readiness, 'UNKNOWN');
  assert.equal(channelReadiness(providerRecord(), 'API', T0 + TTL + 1).readiness, 'UNKNOWN', 'stale channel readiness is unknown');
  assert.deepEqual([...CHANNELS], ['WEB', 'API']);
  assert.equal(CHANNEL_READINESS.includes('AUTH_REQUIRED'), true);
  expectCode(() => channelReadiness(providerRecord(), 'TELEPATHY', T0), 'INVALID_REGISTRY_RECORD');
  // filtering by channel is how routing asks without choosing
  assert.deepEqual(registry.listProviders({ channel: 'WEB' }).map(entry => entry.provider_ref), ['provider-alpha']);
  assert.deepEqual(registry.listProviders({ channel: 'API' }).map(entry => entry.provider_ref), ['provider-alpha']);
});

/* -------------------------------------------------- 4. typed absence */

test('a missing provider, model or account produces typed absence, not a throw', () => {
  const registry = freshRegistry();
  registry.upsertProvider(providerRecord());
  registry.upsertModel(modelRecord());
  assert.deepEqual(registry.getProvider('provider-missing'), { found: false, code: 'UNKNOWN_PROVIDER', detail: 'provider provider-missing is not registered', subject: null });
  assert.equal(registry.getModel('model-missing').code, 'UNKNOWN_MODEL');
  assert.equal(registry.getAccount('account-missing').code, 'UNKNOWN_ACCOUNT');
  assert.equal(registry.getProvider('provider-alpha').found, true);
  // a model/account that exists under another provider is a distinct typed answer
  registry.upsertProvider(providerRecord({ provider_ref: 'provider-beta' }));
  assert.equal(registry.modelOfProvider('model-alpha', 'provider-beta').code, 'MODEL_NOT_IN_PROVIDER');
  registry.upsertAccount(accountRecord());
  assert.equal(registry.accountOfProvider('account-alpha-1', 'provider-beta').code, 'ACCOUNT_NOT_IN_PROVIDER');
  assert.equal(registry.modelOfProvider('model-alpha', 'provider-alpha').found, true);
  assert.equal(registry.capability({ subject: 'MODEL', ref: 'model-missing', fact: 'TEXT' }).code, 'UNKNOWN_MODEL');
  assert.equal(registry.readiness({ subject: 'ACCOUNT', ref: 'account-missing', channel: 'WEB' }).code, 'UNKNOWN_ACCOUNT');
  assert.equal(new Set(ABSENCE_CODES).size, ABSENCE_CODES.length);
  // an unregistered provider cannot be referenced by a model or account
  expectCode(() => registry.upsertModel(modelRecord({ model_ref: 'model-orphan', provider_ref: 'provider-missing' })), 'UNKNOWN_PROVIDER');
  assert.deepEqual([...SUBJECT_KINDS], ['PROVIDER', 'MODEL', 'ACCOUNT']);
});

/* -------------------------------------------------- 5. secrets */

test('canonical records refuse raw secret material and keep handles only', () => {
  assert.equal(validateProviderDescriptor(providerRecord()).ok, true);
  const withApiKey = validateProviderDescriptor(providerRecord({ api_key: 'sk-raw' }));
  assert.equal(withApiKey.ok, false);
  assert.equal(withApiKey.errors.some(error => error.includes('raw secret')), true);
  assert.equal(validateProviderAccount(accountRecord({ channel_handles: { WEB: { handle_ref: 'h', kind: 'k' }, API: { credential: 'raw-bytes' } } })).ok, false);
  assert.equal(validateModelDescriptor(modelRecord({ session_token: 'raw' })).ok, false);
  assert.deepEqual(findRawSecretFields({ a: { b: { access_token: 'x' } } }, ''), ['.a.b.access_token']);
  assert.deepEqual(findRawSecretFields({ credential_ref: 'h', profile_ref: 'p' }, ''), []);
  // the registry itself stores only what the neutral handle store returns
  const handleStore = createDeterministicHandleStoreDouble();
  const registry = createProviderRegistry({ handleStore, clock: () => T0 });
  const stored = registry.storeHandle({ kind: 'BROWSER_PROFILE', value: 'cookie-bytes-that-must-not-be-stored' });
  assert.equal(stored.stored_in_registry, false);
  assert.equal(stored.port, 'SecureHandleStorePort');
  assert.equal(stored.handle_ref.startsWith('handle:BROWSER_PROFILE:'), true);
  assert.equal(JSON.stringify(registry.snapshot()).includes('cookie-bytes-that-must-not-be-stored'), false);
  assert.equal(registry.resolveHandle(stored.handle_ref).value, 'cookie-bytes-that-must-not-be-stored', 'only the store can resolve the bytes');
  registry.revokeHandle(stored.handle_ref);
  expectCode(() => registry.resolveHandle(stored.handle_ref), 'HANDLE_STORE_REQUIRED');
  assert.equal(SECURE_HANDLE_STORE_PORT.general_ai_may_define_its_own_store, false);
  assert.equal(SECURE_HANDLE_STORE_PORT.stores_raw_bytes_in_registry, false);
  expectCode(() => createProviderRegistry({ handleStore: {} }), 'HANDLE_STORE_REQUIRED');
  assert.equal(GAI_REGISTRY_CONTRACT.raw_secrets_in_records, false);
  assert.equal(GAI_REGISTRY_CONTRACT.general_ai_owns_credential_store, false);
});

/* -------------------------------------------------- 6. synthetic, no hard-coded identities */

test('the registry starts empty and works entirely with synthetic providers', () => {
  const registry = freshRegistry();
  assert.deepEqual(registry.listProviders(), [], 'no identity is hard-coded');
  assert.deepEqual(registry.listModels(), []);
  assert.deepEqual(registry.listAccounts(), []);
  assert.equal(registry.snapshot().hard_coded_identities, 0);
  // a second, differently shaped synthetic provider registers without touching the registry
  registry.upsertProvider(providerRecord());
  registry.upsertProvider(providerRecord({
    provider_ref: 'provider-gamma', display_name: 'Synthetic Gamma',
    channels: [{ channel: 'API', readiness: 'READY' }], capabilities: { CODE: 'SUPPORTED' }, source: { kind: 'USER_REPORTED', ref: 'owner-note-1' },
  }));
  registry.upsertModel(modelRecord());
  registry.upsertModel(modelRecord({ model_ref: 'model-gamma', provider_ref: 'provider-gamma', channels: [{ channel: 'API', readiness: 'READY' }], capabilities: { CODE: 'SUPPORTED' }, context_window: null }));
  assert.deepEqual(registry.listProviders().map(entry => entry.provider_ref), ['provider-alpha', 'provider-gamma']);
  assert.deepEqual(registry.listModels({ fact: 'CODE', level: 'SUPPORTED' }).map(entry => entry.model_ref), ['model-gamma']);
  assert.deepEqual(registry.listModels({ providerRef: 'provider-gamma', channel: 'API' }).map(entry => entry.model_ref), ['model-gamma']);
  assert.deepEqual(registry.listModels({ channel: 'WEB' }).map(entry => entry.model_ref), ['model-alpha']);
  assert.equal(registry.snapshot().registry_version, 1);
  assert.equal(GAI_REGISTRY_CONTRACT.logs_in, false);
  assert.equal(GAI_REGISTRY_CONTRACT.executes_requests, false);
  assert.equal(GAI_REGISTRY_CONTRACT.selects_provider_for_a_task, false);
  assert.equal(CAPABILITY_FACTS.includes('VISION'), true);
  assert.equal(new RegistryError('X', 'y').status, 400);
});

test('registry records are strict about their shape', () => {
  assert.equal(validateProviderDescriptor(providerRecord({ registry_version: 2 })).ok, false);
  assert.equal(validateProviderDescriptor(providerRecord({ channels: [] })).ok, false);
  assert.equal(validateProviderDescriptor(providerRecord({ channels: [{ channel: 'WEB', readiness: 'MAYBE' }] })).ok, false);
  assert.equal(validateProviderDescriptor(providerRecord({ channels: [{ channel: 'WEB', readiness: 'READY' }, { channel: 'WEB', readiness: 'READY' }] })).ok, false);
  assert.equal(validateProviderDescriptor(providerRecord({ capabilities: { TELEPATHY: 'SUPPORTED' } })).ok, false);
  assert.equal(validateProviderDescriptor(providerRecord({ capabilities: { TEXT: 'PROBABLY' } })).ok, false);
  assert.equal(validateProviderDescriptor(providerRecord({ mood: 'happy' })).ok, false);
  assert.equal(validateProviderDescriptor(providerRecord({ observed_at: 'yesterday' })).ok, false);
  assert.equal(validateProviderDescriptor(providerRecord({ source: { kind: 'GUESSED', ref: 'x' } })).ok, false);
  assert.equal(validateModelDescriptor(modelRecord({ context_window: 0 })).ok, false);
  assert.equal(validateProviderAccount(accountRecord({ status: 'MAYBE' })).ok, false);
  assert.equal(validateProviderAccount(accountRecord({ channel_handles: { TELEPATHY: null } })).ok, false);
});

/* ---------------------------------------------------------------------------
 * CORRECTION (host Alien, GAI-002 Correction stage) — adversarial regressions.
 *
 * Every assertion below failed before the repair. This is the seventh contract in this
 * repository where a guard tested the *spelling* of a name or the mere *presence* of a
 * key rather than the property it exists to protect.
 * --------------------------------------------------------------------------- */

test('undeclared keys inherited from Object.prototype are refused', () => {
  assert.equal(validateProviderDescriptor(providerRecord()).ok, true, 'the control record is accepted');
  // `key in spec` walked the prototype chain, so every one of these was a canonical record field.
  for (const key of ['toString', 'valueOf', 'hasOwnProperty', 'constructor', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
    const result = validateProviderDescriptor(providerRecord({ [key]: 'SMUGGLED' }));
    assert.equal(result.ok, false, `${key} must not be accepted as a record field`);
    assert.ok(result.errors.some((error) => error.includes(key)), JSON.stringify(result.errors));
  }
  // A `__proto__` own key arrives as data; `JSON.parse` is how.
  const rawOwnProto = JSON.parse(JSON.stringify(providerRecord()).replace('{', '{"__proto__":{"isAdmin":true},'));
  assert.equal(validateProviderDescriptor(rawOwnProto).ok, false);
  assert.equal(validateProviderDescriptor(rawOwnProto).errors.some((error) => error.includes('reserved prototype key')), true);
  // Nested, and reported by the exported scanner.
  assert.equal(findReservedKeyPaths(JSON.parse('{"a":{"__proto__":{"x":1}}}')).length, 1);
  assert.deepEqual(findReservedKeyPaths({ a: 1 }), []);
  // An ordinary unknown field was already refused and must stay refused.
  assert.equal(validateProviderDescriptor(providerRecord({ mood: 'happy' })).ok, false);
});

test('a secret-shaped name is refused in its plural and compound spellings', () => {
  const caught = ['token', 'credential', 'apiKey', 'credentials', 'tokens', 'secrets', 'apiKeys',
    'api_keys', 'privateKeys', 'sessionKeys', 'authToken', 'bearerToken', 'clientSecret',
    'accountCredential', 'tokenValue', 'passwordHash'];
  for (const key of caught) {
    assert.equal(isSecretFieldName(key), true, `${key} must be treated as secret-shaped`);
    assert.equal(findRawSecretFields({ [key]: 'RAW' }).length, 1, `${key} must be caught`);
  }
  // The handle forms this module allows are still allowed.
  for (const key of ['credential_ref', 'api_key_handle', 'access_token_id', 'session_handle', 'token_id']) {
    assert.equal(isSecretFieldName(key), false, `${key} is a permitted handle`);
    assert.deepEqual(findRawSecretFields({ [key]: 'handle:abc' }), []);
  }
  // Value-aware in one direction only: a secret-shaped name holding a number is a quantity.
  assert.deepEqual(findRawSecretFields({ max_tokens: 1024 }), []);
  assert.equal(findRawSecretFields({ max_tokens: 'many' }).length, 1);
  assert.equal(normalizeFieldName('clientSecret'), 'client_secret');
});

test('raw credential bytes are refused in a declared text field, not only under a secret-shaped name', () => {
  const live = 'sk-live-9f8e7d6c5b4a39281706';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  // `display_name` and `source.ref` are DECLARED text fields, so a name scan never inspects them -
  // even though this module's rule is that raw secret bytes are refused from canonical records.
  for (const [label, patch] of [
    ['display_name (provider key)', { display_name: live }],
    ['display_name (jwt)', { display_name: jwt }],
    ['source.ref (pem)', { source: { kind: 'PROBED', ref: pem } }],
  ]) {
    const result = validateProviderDescriptor(providerRecord(patch));
    assert.equal(result.ok, false, `${label} must be refused`);
    assert.ok(result.errors.some((error) => error.includes('raw credential bytes')), JSON.stringify(result.errors));
  }
  assert.deepEqual(findRawSecretValues({ display_name: 'Synthetic Alpha', source: { ref: 'probe-1' } }), []);
  assert.equal(validateProviderDescriptor(providerRecord()).ok, true);
});

test('one reference cannot name two records, and a parent binding cannot be re-pointed', () => {
  const registry = freshRegistry();
  registry.upsertProvider(providerRecord({ provider_ref: 'p1' }));
  registry.upsertProvider(providerRecord({ provider_ref: 'p2' }));
  registry.upsertModel(modelRecord({ model_ref: 'm1', provider_ref: 'p1' }));
  // Uniqueness used to be checked in one direction only, so a reference could name a provider and a
  // model at the same time, and a provider could be admitted under a taken account/model reference.
  expectCode(() => registry.upsertProvider(providerRecord({ provider_ref: 'm1' })), 'IDENTITY_COLLISION');
  expectCode(() => registry.upsertModel(modelRecord({ model_ref: 'p1', provider_ref: 'p1' })), 'IDENTITY_COLLISION');
  registry.upsertAccount(accountRecord({ account_ref: 'a1', provider_ref: 'p1' }));
  expectCode(() => registry.upsertProvider(providerRecord({ provider_ref: 'a1' })), 'IDENTITY_COLLISION');
  expectCode(() => registry.upsertModel(modelRecord({ model_ref: 'a1', provider_ref: 'p1' })), 'IDENTITY_COLLISION');
  // The update path is guarded too: silently re-pointing an account at another provider used to
  // succeed and also removed it from the original provider's listing. The model path always refused
  // this, which is the asymmetry that made the account path a defect rather than a design choice.
  expectCode(() => registry.upsertAccount(accountRecord({ account_ref: 'a1', provider_ref: 'p2' })), 'IDENTITY_COLLISION');
  expectCode(() => registry.upsertModel(modelRecord({ model_ref: 'm1', provider_ref: 'p2' })), 'IDENTITY_COLLISION');
  // Re-registering the same identity under the same parent stays a legitimate idempotent update.
  assert.equal(registry.upsertProvider(providerRecord({ provider_ref: 'p1', display_name: 'Renamed' })).updated, true);
  assert.equal(registry.getAccount('a1').record.provider_ref, 'p1');
  assert.deepEqual(registry.listAccounts({ providerRef: 'p1' }).map((record) => record.account_ref), ['a1']);
});

test('a handle reference is content-addressed and epoch-scoped', () => {
  const a = createDeterministicHandleStoreDouble({ epoch: 1 });
  const b = createDeterministicHandleStoreDouble({ epoch: 1 });
  const first = a.putHandle({ kind: 'API_CREDENTIAL', value: 'secret-of-session-A' });
  const second = b.putHandle({ kind: 'API_CREDENTIAL', value: 'secret-of-session-B' });
  // A counter restarting at 0 handed `handle:API_CREDENTIAL:1` to two different secrets, and a
  // canonical account record persists that reference — so after recovery it resolved elsewhere.
  assert.notEqual(first.handle_ref, second.handle_ref, 'two different secrets must not share a handle reference');
  assert.equal(a.resolveHandle(first.handle_ref).value, 'secret-of-session-A');
  // The same value in the same epoch is the same reference (content-addressed, so retries are safe).
  assert.equal(a.putHandle({ kind: 'API_CREDENTIAL', value: 'secret-of-session-A' }).handle_ref, first.handle_ref);
  // A reference minted in another epoch must not resolve here.
  const nextEpoch = createDeterministicHandleStoreDouble({ epoch: 2 });
  expectCode(() => nextEpoch.resolveHandle(first.handle_ref), 'HANDLE_STORE_REQUIRED');
  // An unknown reference is reported rather than silently treated as "nothing to revoke".
  assert.deepEqual(a.revokeHandle('handle:nope:1:00000000'), { handle_ref: 'handle:nope:1:00000000', revoked: false, code: 'UNKNOWN_HANDLE' });
});

test('a stale or unavailable channel is not advertised as supported', () => {
  const stale = freshRegistry(T0 + TTL + 1);
  stale.upsertProvider(providerRecord({ provider_ref: 'stale-p', channels: [{ channel: 'API', readiness: 'READY' }] }));
  // `supported` was `channel === 'WEB' || channel === 'API'` in the stale branch — a tautology that
  // could not be false, so the listing API named as the routing query surface advertised a stale
  // declaration while the capability path for the same record correctly said UNKNOWN.
  assert.deepEqual(stale.listProviders({ channel: 'API' }), []);
  const readiness = stale.readiness({ subject: 'PROVIDER', ref: 'stale-p', channel: 'API' });
  assert.equal(readiness.supported, false);
  assert.equal(readiness.freshness, 'STALE');
  // UNAVAILABLE is not "supported" either, while AUTH_REQUIRED still is: the channel exists, it
  // merely needs a credential.
  const fresh = freshRegistry();
  fresh.upsertProvider(providerRecord({ provider_ref: 'p-u', channels: [{ channel: 'API', readiness: 'UNAVAILABLE' }] }));
  assert.equal(fresh.readiness({ subject: 'PROVIDER', ref: 'p-u', channel: 'API' }).supported, false);
  const authOnly = freshRegistry();
  authOnly.upsertProvider(providerRecord({ provider_ref: 'p-a', channels: [{ channel: 'API', readiness: 'AUTH_REQUIRED' }] }));
  assert.equal(authOnly.readiness({ subject: 'PROVIDER', ref: 'p-a', channel: 'API' }).supported, true);
  assert.deepEqual(authOnly.listProviders({ channel: 'API' }).map((record) => record.provider_ref), ['p-a']);
});

test('a missing subject reports its own absence code, and a future observation is not fresh', () => {
  const registry = freshRegistry();
  // freshness() hard-coded UNKNOWN_PROVIDER whatever the subject was.
  assert.equal(registry.freshness({ subject: 'MODEL', ref: 'nope' }).code, 'UNKNOWN_MODEL');
  assert.equal(registry.freshness({ subject: 'ACCOUNT', ref: 'nope' }).code, 'UNKNOWN_ACCOUNT');
  assert.equal(registry.freshness({ subject: 'PROVIDER', ref: 'nope' }).code, 'UNKNOWN_PROVIDER');
  // A record claiming an observation in the future is not evidence of anything. The bound used to be
  // one-sided, so this read FRESH in 2026 and still FRESH in 2089.
  const future = { ...providerRecord(), observed_at: '2099-01-01T00:00:00.000Z', ttl_ms: 1 };
  assert.equal(freshnessOf(future, T0), 'STALE');
  assert.equal(channelReadiness({ ...future, channels: [{ channel: 'API', readiness: 'READY' }] }, 'API', T0).supported, false);
  // A stored readiness outside the enum is re-validated rather than echoed back as supported.
  const offEnum = { ...providerRecord(), channels: [{ channel: 'API', readiness: 'TOTALLY_READY' }] };
  assert.equal(channelReadiness(offEnum, 'API', T0).readiness, 'UNKNOWN');
  assert.equal(channelReadiness(offEnum, 'API', T0).supported, false);
  // The published "no hard-coded identities" count is derived, not asserted.
  assert.equal(registry.snapshot().hard_coded_identities, 0);
});

/* ------------------------------- RS-201: user enablement, region, availability reasons */

test('RS-201: enablement is REQUIRED, so an omitted field can never read as enabled', () => {
  // The hazard this closes: if absence defaulted to enabled, a record whose disablement was lost or
  // written by an older writer would silently look available, and the scheduler would pick a provider
  // the user had switched off. Absence must not be readable as consent, on any of the three kinds.
  const { enablement: _p, ...providerWithout } = providerRecord();
  const providerResult = validateProviderDescriptor(providerWithout);
  assert.equal(providerResult.ok, false);
  assert.ok(providerResult.errors.some(entry => entry.includes('enablement') && entry.includes('required')), providerResult.errors.join('; '));
  const { enablement: _m, ...modelWithout } = modelRecord();
  assert.equal(validateModelDescriptor(modelWithout).ok, false);
  const { enablement: _a, ...accountWithout } = accountRecord();
  assert.equal(validateProviderAccount(accountWithout).ok, false);
});

test('RS-201: enablement accepts exactly the two declared states and nothing that merely looks like one', () => {
  assert.deepEqual([...ENABLEMENT], ['ENABLED', 'DISABLED']);
  assert.equal(validateProviderDescriptor(providerRecord({ enablement: 'ENABLED' })).ok, true);
  assert.equal(validateProviderDescriptor(providerRecord({ enablement: 'DISABLED' })).ok, true);
  // `true` is the specific hazard: it is exactly what a JSON writer emits for a boolean field, and a
  // validator that silently ignored an unknown type would let it through.
  for (const bad of [true, false, 'enabled', 'disabled', 'TRUE', 'PAUSED', '', null]) {
    assert.equal(validateProviderDescriptor(providerRecord({ enablement: bad })).ok, false, `enablement ${JSON.stringify(bad)} must be refused`);
  }
  // ...and a synonym key is not a way in either, because unknown keys are refused outright.
  assert.equal(validateProviderDescriptor(providerRecord({ isEnabled: true })).ok, false);
  assert.equal(validateProviderDescriptor(providerRecord({ disabled: true })).ok, false);
});

test('RS-201: DISABLED is a user choice, not a capability fact, and does not contaminate freshness', () => {
  const disabled = providerRecord({ enablement: 'DISABLED' });
  assert.equal(validateProviderDescriptor(disabled).ok, true);
  // Disabling says nothing about whether the provider works or how recently it was observed.
  assert.equal(freshnessOf(disabled, T0), 'FRESH');
  // An account can be AUTHENTICATED and DISABLED at the same time: status is observed, enablement is
  // chosen. Collapsing the two would make "user turned it off" indistinguishable from "login broke".
  assert.equal(validateProviderAccount(accountRecord({ enablement: 'DISABLED', status: 'AUTHENTICATED' })).ok, true);
  assert.equal(validateProviderAccount(accountRecord({ enablement: 'ENABLED', status: 'EXPIRED' })).ok, true);
});

test('RS-201: region is required but explicitly nullable, and is never inferred', () => {
  assert.equal(validateProviderDescriptor(providerRecord({ region: null })).ok, true);
  assert.equal(validateProviderDescriptor(providerRecord({ region: 'eu-central' })).ok, true);
  // A provider must STATE its region; null is the honest answer for a region-neutral provider, and
  // omitting the field is not allowed to mean the same thing silently.
  const { region: _r, ...withoutRegion } = providerRecord();
  const result = validateProviderDescriptor(withoutRegion);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(entry => entry.includes('region') && entry.includes('required')), result.errors.join('; '));
  for (const bad of ['', '   ', 42, {}, []]) {
    assert.equal(validateProviderDescriptor(providerRecord({ region: bad })).ok, false, `region ${JSON.stringify(bad)} must be refused`);
  }
});

test('RS-201: the availability reason vocabulary carries all seven required categories', () => {
  assert.deepEqual([...AVAILABILITY_REASONS], [
    'AVAILABLE', 'REGION_UNSUPPORTED', 'CREDENTIALS_MISSING', 'SESSION_EXPIRED', 'SERVICE_FAULT', 'USER_DISABLED', 'UNKNOWN',
  ]);
  // Exactly one reason permits selection, stated as data so no caller re-derives the rule.
  assert.equal(AVAILABILITY_REASONS.filter(reason => reason === SELECTABLE_REASON).length, 1);
  assert.equal(SELECTABLE_REASON, 'AVAILABLE');
  // Every reason declares provenance, and the two that existed nowhere before RS-201 are named as new
  // rather than quietly presented as if they had always been derivable.
  assert.deepEqual(Object.keys(REASON_SOURCES).sort(), [...AVAILABILITY_REASONS].sort());
  assert.equal(REASON_SOURCES.REGION_UNSUPPORTED, null);
  assert.equal(REASON_SOURCES.USER_DISABLED, null);
  for (const derived of ['AVAILABLE', 'CREDENTIALS_MISSING', 'SESSION_EXPIRED', 'SERVICE_FAULT', 'UNKNOWN']) {
    assert.equal(typeof REASON_SOURCES[derived], 'string', `${derived} should point at existing state`);
  }
});
