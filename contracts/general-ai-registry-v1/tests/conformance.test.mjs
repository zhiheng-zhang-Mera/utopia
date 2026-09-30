// GAI-002 conformance suite — provider / model / account registry.
//
// Acceptance: provider/model/account identities remain distinct under multiple accounts; stale
// capability metadata is visible as stale/unknown; channel readiness can differ between WEB and API;
// missing model/provider/account produces typed absence; raw secret/cookie/token material is rejected
// from canonical records; the registry works with synthetic providers and hard-codes no identities.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 ABSENCE_CODES, CAPABILITY_FACTS, CHANNELS, CHANNEL_READINESS, FRESHNESS, GAI_REGISTRY_CONTRACT,
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
