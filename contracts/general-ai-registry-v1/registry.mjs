// Provider / model / account registry (GAI-002).
//
// Discovery state only: it answers what exists, what each provider/model/account supports and how
// fresh that answer is. It never logs in, never executes a request and never chooses a provider.
//
// Handles (browser-profile and credential references) are stored through the neutral
// `SecureHandleStorePort`; this module deliberately owns no credential store of its own.
import {
  ABSENCE_CODES, CAPABILITY_FACTS, CHANNELS, ENABLEMENT, RegistryError, assertModelDescriptor,
  assertProviderAccount, assertProviderDescriptor, capabilityOf, channelReadiness, freshnessOf
} from './records.mjs';

/** The neutral storage primitive. General AI must not grow its own credential engine. */
/**
 * The identities this module ships with: none. The published `hard_coded_identities` count is
 * derived from this constant rather than written as a literal, because a literal `0` cannot fail —
 * it certified "no hard-coded identities" while testing nothing, and the Development report offered
 * it as the evidence for exactly that claim.
 */
export const BUILT_IN_IDENTITIES = Object.freeze([]);

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
export function createDeterministicHandleStoreDouble({ epoch = 1 } = {}) {
  const handles = new Map();
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new RegistryError('HANDLE_STORE_REQUIRED', 'a handle store epoch must be a positive integer');
  /**
   * Deterministic, dependency-free digest (FNV-1a). The reference is content-addressed, so the same
   * value in the same epoch always mints the same reference and two different values cannot share
   * one. A counter could not do this: it restarted at 0 in each store instance, so
   * `handle:API_CREDENTIAL:1` named two different secrets across sessions — and a canonical account
   * record persists that reference, so after recovery it resolved to the other session's bytes.
   * (This is a deterministic double; the real neutral port owns the real guarantee.)
   */
  const digest = (text) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return Object.freeze({
    epoch,
    putHandle({ kind, value }) {
      if (typeof kind !== 'string' || kind.trim() === '') throw new RegistryError('HANDLE_STORE_REQUIRED', 'a handle needs a kind');
      if (typeof value !== 'string' || value === '') throw new RegistryError('HANDLE_STORE_REQUIRED', 'a handle needs a value');
      const handleRef = `handle:${kind}:${epoch}:${digest(`${kind}\u0000${value}`)}`;
      handles.set(handleRef, { kind, value, state: 'ACTIVE', epoch });
      return { handle_ref: handleRef, kind };
    },
    resolveHandle(handleRef) {
      const entry = handles.get(handleRef);
      if (!entry) throw new RegistryError('HANDLE_STORE_REQUIRED', `unknown handle ${String(handleRef)}`);
      // A reference minted in another epoch must not resolve here: that is the whole point of the
      // epoch, and it is what stops a persisted reference from naming a later session's secret.
      if (entry.epoch !== epoch) {
        throw new RegistryError('HANDLE_STORE_REQUIRED', `handle ${handleRef} was minted in epoch ${entry.epoch} and cannot be resolved in epoch ${epoch}`);
      }
      if (entry.state !== 'ACTIVE') throw new RegistryError('HANDLE_STORE_REQUIRED', `handle ${handleRef} is ${entry.state}`);
      return { handle_ref: handleRef, kind: entry.kind, value: entry.value };
    },
    revokeHandle(handleRef) {
      const entry = handles.get(handleRef);
      // An unknown reference is reported, not silently treated as "nothing to revoke": a caller
      // could not otherwise tell "already gone" from "never existed".
      if (!entry) return { handle_ref: handleRef, revoked: false, code: 'UNKNOWN_HANDLE' };
      entry.state = 'REVOKED';
      return { handle_ref: handleRef, revoked: true, code: null };
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

  /**
   * One identity index for the whole registry: reference -> { kind, parent_ref }.
   *
   * Uniqueness used to be checked in exactly one direction — an account reference against providers
   * and models — and only where it happened to be written, so: one reference could name a provider
   * and a model at the same time; a provider could be admitted under an already-taken account or
   * model reference; and an existing account could be **silently re-pointed at another provider** on
   * the update path (which also removed it from the original provider's listing). A reference
   * identifies exactly one record, and a record's parent binding is immutable.
   */
  const identities = new Map();
  const claimIdentity = (kind, ref, parentRef = null) => {
    // A removed reference is not free for the taking. Without this guard an upsert would happily
    // re-register a tombstoned ref, and every reference still holding it would silently start meaning
    // a DIFFERENT record — the residual-reference failure this task is asked to defend against.
    if (retired.has(ref)) {
      throw new RegistryError(`RETIRED_${kind.toUpperCase()}`, `${ref} was removed by the user; restore it explicitly before registering it again, so a removed identity is never silently reused`);
    }
    const existing = identities.get(ref);
    if (existing && existing.kind !== kind) {
      throw new RegistryError('IDENTITY_COLLISION', `${ref} is already a ${existing.kind} reference and cannot also be a ${kind} reference`);
    }
    if (existing && existing.parent_ref !== null && parentRef !== null && existing.parent_ref !== parentRef) {
      throw new RegistryError('IDENTITY_COLLISION', `${ref} already belongs to ${existing.parent_ref} and cannot be re-pointed at ${parentRef}`);
    }
    identities.set(ref, Object.freeze({ kind, parent_ref: parentRef ?? existing?.parent_ref ?? null }));
  };

  const absent = (code, detail) => ({ found: false, code, detail, subject: null });
  const present = (subject, record) => ({ found: true, code: null, detail: null, subject, record: clone(record) });

  /** One place maps a subject kind to its typed absence code, so no query can report the wrong one. */
  const ABSENCE_BY_SUBJECT = Object.freeze({ PROVIDER: 'UNKNOWN_PROVIDER', MODEL: 'UNKNOWN_MODEL', ACCOUNT: 'UNKNOWN_ACCOUNT' });
  const RETIRED_BY_SUBJECT = Object.freeze({ PROVIDER: 'RETIRED_PROVIDER', MODEL: 'RETIRED_MODEL', ACCOUNT: 'RETIRED_ACCOUNT' });

  /**
   * Tombstones for user-removed references (RS-201).
   *
   * Removing a record does NOT free its reference. Two failure modes are closed by that:
   *   - a removed reference stays distinguishable from one that was never registered, so a surface can
   *     say "you removed this" instead of "never heard of it"; and
   *   - the reference cannot be silently reused, so a later record can never inherit the identity of a
   *     removed one and make an old reference quietly mean something new.
   */
  const retired = new Map();

  const mapFor = subject => {
    if (subject === 'PROVIDER') return providers;
    if (subject === 'MODEL') return models;
    if (subject === 'ACCOUNT') return accounts;
    throw new RegistryError('INVALID_REGISTRY_RECORD', `${subject} is not a registry subject`);
  };

  /**
   * Which records would be left pointing at nothing if this one were removed. Only a provider can have
   * dependents, and removal REFUSES rather than cascading: a silent cascade would delete models and
   * accounts the user never asked to delete, and any other order would leave a dangling reference.
   */
  const dependentsOf = (subject, ref) => {
    if (subject !== 'PROVIDER') return [];
    return [
      ...[...models.values()].filter(entry => entry.provider_ref === ref).map(entry => entry.model_ref),
      ...[...accounts.values()].filter(entry => entry.provider_ref === ref).map(entry => entry.account_ref),
    ].sort();
  };

  /** A retired reference is absent for a REASON, and the reason outlives the record. */
  const absenceCodeFor = (subject, ref) => {
    if (ref !== undefined && ref !== null && retired.has(ref)) {
      return RETIRED_BY_SUBJECT[subject] ?? 'INVALID_REGISTRY_RECORD';
    }
    return ABSENCE_BY_SUBJECT[subject] ?? 'INVALID_REGISTRY_RECORD';
  };

  const registry = {
    // ---- admission -------------------------------------------------------
    upsertProvider(record) {
      assertProviderDescriptor(record);
      claimIdentity('provider', record.provider_ref);
      const previous = providers.get(record.provider_ref);
      providers.set(record.provider_ref, clone(record));
      return { provider_ref: record.provider_ref, updated: Boolean(previous), created: !previous };
    },

    upsertModel(record) {
      assertModelDescriptor(record);
      if (!providers.has(record.provider_ref)) throw new RegistryError('UNKNOWN_PROVIDER', `model ${record.model_ref} names provider ${record.provider_ref}, which is not registered`);
      claimIdentity('model', record.model_ref, record.provider_ref);
      models.set(record.model_ref, clone(record));
      return { model_ref: record.model_ref, provider_ref: record.provider_ref };
    },

    upsertAccount(record) {
      assertProviderAccount(record);
      if (!providers.has(record.provider_ref)) throw new RegistryError('UNKNOWN_PROVIDER', `account ${record.account_ref} names provider ${record.provider_ref}, which is not registered`);
      // An account is its own identity: several accounts may exist for one provider, and an account
      // reference may never be reused as a provider or model reference — nor be re-pointed at another
      // provider, which the index now refuses on the update path as well as on create.
      claimIdentity('account', record.account_ref, record.provider_ref);
      accounts.set(record.account_ref, clone(record));
      return { account_ref: record.account_ref, provider_ref: record.provider_ref };
    },

    // ---- reversible user control (RS-201) --------------------------------
    /**
     * Turn a record on or off. Reversible and non-destructive: a user may disable a provider, a model
     * or an account and turn it back on later without losing its identity, its handles, or when it was
     * last observed. Disabling is neither deletion nor unavailability — a DISABLED record keeps all its
     * facts, and the reason it cannot be used is the user's choice, not a probe result.
     */
    setEnablement({ subject, ref, enablement }) {
      if (!ENABLEMENT.includes(enablement)) {
        throw new RegistryError('INVALID_REGISTRY_RECORD', `${String(enablement)} is not an enablement (${ENABLEMENT.join(', ')})`);
      }
      const map = mapFor(subject);
      const existing = map.get(ref);
      if (!existing) return absent(absenceCodeFor(subject, ref), `${subject} ${String(ref)} is not registered`);
      const updated = Object.freeze({ ...existing, enablement });
      map.set(ref, updated);
      return present(subject, updated);
    },

    /**
     * Remove a record the USER no longer wants. Deliberately three things it is not:
     *   - NOT triggered by unavailability. This contract never removes a provider because it is down,
     *     region-blocked or logged out; that is forbidden outright, and a removal only ever happens
     *     because a user asked for one.
     *   - NOT a cascade. A provider that still has models or accounts is refused with HAS_DEPENDENTS
     *     and the dependents NAMED, so a removal can never leave a reference pointing at nothing.
     *   - NOT a freed reference. A tombstone keeps the ref claimed, so a later record cannot silently
     *     inherit the identity of the removed one and make an old reference mean something new.
     */
    remove({ subject, ref }) {
      const map = mapFor(subject);
      const record = map.get(ref);
      if (!record) return absent(absenceCodeFor(subject, ref), `${subject} ${String(ref)} is not registered`);
      const dependents = dependentsOf(subject, ref);
      if (dependents.length > 0) {
        return Object.freeze({
          found: true,
          removed: false,
          code: 'HAS_DEPENDENTS',
          detail: `${String(ref)} still has ${dependents.length} dependent record(s): ${dependents.join(', ')}`,
          subject,
          dependents: Object.freeze(dependents),
        });
      }
      map.delete(ref);
      retired.set(ref, Object.freeze({ kind: subject }));
      return Object.freeze({ found: true, removed: true, code: null, detail: null, subject, retired_ref: ref });
    },

    /** Whether a reference was removed by a user, so a caller can tell that apart from a typo. */
    isRetired(ref) { return retired.has(ref); },
    listRetired() { return Object.freeze([...retired.keys()].sort()); },

    /**
     * Clear a tombstone. This is the ONLY way a removed reference becomes registerable again, and it is
     * a separate explicit act precisely so that reuse can never arrive as a side effect of an upsert.
     * It restores nothing on its own — the record was removed, so the caller must register it afresh.
     */
    restore({ subject, ref }) {
      mapFor(subject);
      const was = retired.get(ref);
      if (!was) {
        return Object.freeze({ found: false, restored: false, code: null, detail: `${String(ref)} was not removed`, subject });
      }
      retired.delete(ref);
      identities.delete(ref);
      return Object.freeze({ found: true, restored: true, code: null, detail: null, subject, restored_ref: ref, was_kind: was.kind });
    },

    // ---- typed absence ---------------------------------------------------
    getProvider(providerRef) {
      const record = providers.get(providerRef);
      return record ? present('PROVIDER', record) : absent(absenceCodeFor('PROVIDER', providerRef), `provider ${String(providerRef)} is not registered`);
    },
    getModel(modelRef) {
      const record = models.get(modelRef);
      return record ? present('MODEL', record) : absent(absenceCodeFor('MODEL', modelRef), `model ${String(modelRef)} is not registered`);
    },
    getAccount(accountRef) {
      const record = accounts.get(accountRef);
      return record ? present('ACCOUNT', record) : absent(absenceCodeFor('ACCOUNT', accountRef), `account ${String(accountRef)} is not registered`);
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
      if (!record) return absent(absenceCodeFor(subject, ref), `${subject} ${String(ref)} is not registered`);
      return { found: true, code: null, ...capabilityOf(record, fact, now()) };
    },
    readiness({ subject, ref, channel }) {
      const record = registry.__recordFor(subject, ref);
      if (!record) return absent(absenceCodeFor(subject, ref), `${subject} ${String(ref)} is not registered`);
      return { found: true, code: null, ...channelReadiness(record, channel, now()) };
    },
    freshness({ subject, ref }) {
      const record = registry.__recordFor(subject, ref);
      // This used to hard-code UNKNOWN_PROVIDER whatever the subject was, so a missing model or
      // account was reported as a missing provider while capability/readiness answered correctly.
      if (!record) return absent(absenceCodeFor(subject, ref), `${subject} ${String(ref)} is not registered`);
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
        hard_coded_identities: BUILT_IN_IDENTITIES.length,
      });
    },
  };

  return Object.freeze(registry);
}

export { ABSENCE_CODES, CHANNELS, RegistryError };
