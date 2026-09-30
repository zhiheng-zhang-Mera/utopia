// Provider / model / account registry (GAI-002).
//
// Discovery state only: it answers what exists, what each provider/model/account supports and how
// fresh that answer is. It never logs in, never executes a request and never chooses a provider.
//
// Handles (browser-profile and credential references) are stored through the neutral
// `SecureHandleStorePort`; this module deliberately owns no credential store of its own.
import {
  ABSENCE_CODES, CAPABILITY_FACTS, CHANNELS, RegistryError, assertModelDescriptor, assertProviderAccount,
  assertProviderDescriptor, capabilityOf, channelReadiness, freshnessOf
} from './records.mjs';

/** The neutral storage primitive. General AI must not grow its own credential engine. */
export const SECURE_HANDLE_STORE_PORT = Object.freeze({
  interface: 'SecureHandleStorePort',
  version: 1,
  methods: Object.freeze(['putHandle', 'resolveHandle', 'revokeHandle']),
  owner: 'neutral 00-Foundation SecureHandleStorePort',
  stores_raw_bytes_in_registry: false,
  general_ai_may_define_its_own_store: false,
});

/**
 * Deterministic handle-store double: handles are opaque, values never leave it, and resolving a
 * revoked handle fails. Sibling GAI tasks use this instead of a real credential store.
 */
export function createDeterministicHandleStoreDouble() {
  const handles = new Map();
  let counter = 0;
  return Object.freeze({
    putHandle({ kind, value }) {
      if (typeof kind !== 'string' || kind.trim() === '') throw new RegistryError('HANDLE_STORE_REQUIRED', 'a handle needs a kind');
      if (typeof value !== 'string' || value === '') throw new RegistryError('HANDLE_STORE_REQUIRED', 'a handle needs a value');
      counter += 1;
      const handleRef = `handle:${kind}:${counter}`;
      handles.set(handleRef, { kind, value, state: 'ACTIVE' });
      return { handle_ref: handleRef, kind };
    },
    resolveHandle(handleRef) {
      const entry = handles.get(handleRef);
      if (!entry) throw new RegistryError('HANDLE_STORE_REQUIRED', `unknown handle ${String(handleRef)}`);
      if (entry.state !== 'ACTIVE') throw new RegistryError('HANDLE_STORE_REQUIRED', `handle ${handleRef} is ${entry.state}`);
      return { handle_ref: handleRef, kind: entry.kind, value: entry.value };
    },
    revokeHandle(handleRef) {
      const entry = handles.get(handleRef);
      if (!entry) return { handle_ref: handleRef, revoked: false };
      entry.state = 'REVOKED';
      return { handle_ref: handleRef, revoked: true };
    },
    /** Introspection for tests: how many handles exist, never their values. */
    __size: () => handles.size,
  });
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));

export function createProviderRegistry({ handleStore, clock = () => null } = {}) {
  if (!handleStore || typeof handleStore.putHandle !== 'function' || typeof handleStore.resolveHandle !== 'function') {
    throw new RegistryError('HANDLE_STORE_REQUIRED', 'the neutral SecureHandleStorePort is required; this module must not own a credential store');
  }
  const providers = new Map();
  const models = new Map();
  const accounts = new Map();
  const now = () => clock();

  const absent = (code, detail) => ({ found: false, code, detail, subject: null });
  const present = (subject, record) => ({ found: true, code: null, detail: null, subject, record: clone(record) });

  const registry = {
    // ---- admission -------------------------------------------------------
    upsertProvider(record) {
      assertProviderDescriptor(record);
      const previous = providers.get(record.provider_ref);
      providers.set(record.provider_ref, clone(record));
      return { provider_ref: record.provider_ref, updated: Boolean(previous), created: !previous };
    },

    upsertModel(record) {
      assertModelDescriptor(record);
      if (!providers.has(record.provider_ref)) throw new RegistryError('UNKNOWN_PROVIDER', `model ${record.model_ref} names provider ${record.provider_ref}, which is not registered`);
      if (models.has(record.model_ref)) {
        const existing = models.get(record.model_ref);
        if (existing.provider_ref !== record.provider_ref) {
          throw new RegistryError('IDENTITY_COLLISION', `model ${record.model_ref} already belongs to ${existing.provider_ref}`);
        }
      }
      models.set(record.model_ref, clone(record));
      return { model_ref: record.model_ref, provider_ref: record.provider_ref };
    },

    upsertAccount(record) {
      assertProviderAccount(record);
      if (!providers.has(record.provider_ref)) throw new RegistryError('UNKNOWN_PROVIDER', `account ${record.account_ref} names provider ${record.provider_ref}, which is not registered`);
      // An account is its own identity: several accounts may exist for one provider, and an account
      // reference may never be reused as a provider or model reference.
      if (providers.has(record.account_ref) || models.has(record.account_ref)) {
        throw new RegistryError('IDENTITY_COLLISION', `account ${record.account_ref} collides with an existing provider or model identity`);
      }
      accounts.set(record.account_ref, clone(record));
      return { account_ref: record.account_ref, provider_ref: record.provider_ref };
    },

    // ---- typed absence ---------------------------------------------------
    getProvider(providerRef) {
      const record = providers.get(providerRef);
      return record ? present('PROVIDER', record) : absent('UNKNOWN_PROVIDER', `provider ${String(providerRef)} is not registered`);
    },
    getModel(modelRef) {
      const record = models.get(modelRef);
      return record ? present('MODEL', record) : absent('UNKNOWN_MODEL', `model ${String(modelRef)} is not registered`);
    },
    getAccount(accountRef) {
      const record = accounts.get(accountRef);
      return record ? present('ACCOUNT', record) : absent('UNKNOWN_ACCOUNT', `account ${String(accountRef)} is not registered`);
    },

    /** A model that exists but belongs to another provider is a distinct, typed answer. */
    modelOfProvider(modelRef, providerRef) {
      const found = models.get(modelRef);
      if (!found) return absent('UNKNOWN_MODEL', `model ${String(modelRef)} is not registered`);
      if (found.provider_ref !== providerRef) return absent('MODEL_NOT_IN_PROVIDER', `model ${modelRef} belongs to ${found.provider_ref}`);
      return present('MODEL', found);
    },
    accountOfProvider(accountRef, providerRef) {
      const found = accounts.get(accountRef);
      if (!found) return absent('UNKNOWN_ACCOUNT', `account ${String(accountRef)} is not registered`);
      if (found.provider_ref !== providerRef) return absent('ACCOUNT_NOT_IN_PROVIDER', `account ${accountRef} belongs to ${found.provider_ref}`);
      return present('ACCOUNT', found);
    },

    // ---- queries ---------------------------------------------------------
    listProviders({ channel = null } = {}) {
      if (channel !== null && !CHANNELS.includes(channel)) throw new RegistryError('INVALID_REGISTRY_RECORD', `${channel} is not a channel`);
      return [...providers.values()]
        .filter(record => channel === null || channelReadiness(record, channel, now()).supported)
        .map(clone).sort((a, b) => a.provider_ref.localeCompare(b.provider_ref));
    },
    listModels({ providerRef = null, fact = null, level = 'SUPPORTED', channel = null } = {}) {
      if (fact !== null && !CAPABILITY_FACTS.includes(fact)) throw new RegistryError('INVALID_REGISTRY_RECORD', fact + ' is not a capability fact');
      return [...models.values()]
        .filter(record => providerRef === null || record.provider_ref === providerRef)
        .filter(record => fact === null || capabilityOf(record, fact, now()).level === level)
        .filter(record => channel === null || channelReadiness(record, channel, now()).supported)
        .map(clone).sort((a, b) => a.model_ref.localeCompare(b.model_ref));
    },
    listAccounts({ providerRef = null } = {}) {
      return [...accounts.values()]
        .filter(record => providerRef === null || record.provider_ref === providerRef)
        .map(clone).sort((a, b) => a.account_ref.localeCompare(b.account_ref));
    },

    /** Capability and readiness answers carry their freshness, so a caller cannot read a stale fact as current. */
    capability({ subject, ref, fact }) {
      const record = registry.__recordFor(subject, ref);
      if (!record) return absent(subject === 'PROVIDER' ? 'UNKNOWN_PROVIDER' : subject === 'MODEL' ? 'UNKNOWN_MODEL' : 'UNKNOWN_ACCOUNT', `${subject} ${String(ref)} is not registered`);
      return { found: true, code: null, ...capabilityOf(record, fact, now()) };
    },
    readiness({ subject, ref, channel }) {
      const record = registry.__recordFor(subject, ref);
      if (!record) return absent(subject === 'PROVIDER' ? 'UNKNOWN_PROVIDER' : subject === 'MODEL' ? 'UNKNOWN_MODEL' : 'UNKNOWN_ACCOUNT', `${subject} ${String(ref)} is not registered`);
      return { found: true, code: null, ...channelReadiness(record, channel, now()) };
    },
    freshness({ subject, ref }) {
      const record = registry.__recordFor(subject, ref);
      if (!record) return absent('UNKNOWN_PROVIDER', `${subject} ${String(ref)} is not registered`);
      return { found: true, code: null, freshness: freshnessOf(record, now()), observed_at: record.observed_at, source: clone(record.source) };
    },
    __recordFor(subject, ref) {
      if (subject === 'PROVIDER') return providers.get(ref) ?? null;
      if (subject === 'MODEL') return models.get(ref) ?? null;
      if (subject === 'ACCOUNT') return accounts.get(ref) ?? null;
      throw new RegistryError('INVALID_REGISTRY_RECORD', `${subject} is not a registry subject`);
    },

    // ---- handles ---------------------------------------------------------
    /** Persist a browser-profile or credential value and keep only the returned handle. */
    storeHandle({ kind, value }) {
      const stored = handleStore.putHandle({ kind, value });
      return { handle_ref: stored.handle_ref, kind: stored.kind, stored_in_registry: false, port: SECURE_HANDLE_STORE_PORT.interface };
    },
    resolveHandle(handleRef) { return handleStore.resolveHandle(handleRef); },
    revokeHandle(handleRef) { return handleStore.revokeHandle(handleRef); },

    /** An auditable snapshot: identities, capabilities, readiness and freshness. Never handle values. */
    snapshot() {
      return Object.freeze({
        registry_version: 1,
        providers: registry.listProviders(),
        models: registry.listModels(),
        accounts: registry.listAccounts(),
        hard_coded_identities: 0,
      });
    },
  };

  return Object.freeze(registry);
}

export { ABSENCE_CODES, CHANNELS, RegistryError };
