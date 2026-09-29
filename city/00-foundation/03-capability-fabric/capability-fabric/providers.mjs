/**
 * UTOPIA · City Service Network — provider lifecycle.
 *
 * A provider record answers four *separate* questions, and the whole point of
 * this module is that they stay separate:
 *
 *   registered  does a provider record exist at all?
 *   enabled     is it switched on?
 *   loaded      did its load hook complete?
 *   healthy     did its last health answer say it works?
 *
 * A provider can be registered and disabled; enabled and fail to load; loaded
 * and unhealthy. Collapsing those into one boolean loses exactly the
 * information an operator needs, which is why the donor never collapsed them
 * either.
 *
 * This module is deliberately filesystem-free: it never reads a manifest, a
 * config file or a directory. Composition arrives as plain data, which is what
 * makes the fabric testable in isolation and what keeps it out of the
 * 01 Customs admission boundary.
 *
 * Donor provenance: DS-Hns `app/core/plugin-manager/index.cjs` and
 * `app/core/health-supervisor/index.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973.
 *
 * Adapter vs. migration (recorded in DONOR.json): the donor's `loadOne` calls a
 * provider hook and catches its throw; here the caller supplies the effect and
 * the outcome, because a pure-migration module in this repository must not
 * execute a provider's code. The *state machine* — the order of the refusal
 * checks, the containment of a failing hook, the release of everything a
 * provider provided on unload, and the derived-state order — is the donor's.
 */

import { FAULT_LEVELS, HEALTH_STATUS, PROVIDER_STATES } from './contracts.mjs';

/** The derived-state order, evaluated exactly as the donor evaluated it. */
export function deriveProviderState(record) {
  if (record === null || typeof record !== 'object') return 'not-registered';
  if (record.registered !== true) return 'not-registered';
  if (record.enabled !== true) return 'disabled';
  if (record.loaded !== true) return 'enabled';
  if (record.healthy === false) return 'unhealthy';
  if (record.healthy === true) return 'healthy';
  return 'loaded';
}

/** The aggregate verdict a set of provider records gives. */
export function aggregateHealth(records) {
  const list = [...records];
  const unhealthy = list.filter((record) => record.healthy === false);
  const fatal = unhealthy.filter((record) => record.faultLevel === FAULT_LEVELS[2]);
  const loaded = list.filter((record) => record.loaded === true);
  const unknown = loaded.filter((record) => record.healthy === null);
  return Object.freeze({
    status: fatal.length ? 'blocked' : unhealthy.length ? 'degraded' : 'healthy',
    providers: list.length,
    loaded: loaded.length,
    unhealthy: Object.freeze(unhealthy.map((record) => Object.freeze({ owner: record.owner, level: record.faultLevel, reason: record.health ? record.health.reason : null }))),
    fatal: Object.freeze(fatal.map((record) => record.owner)),
    unknown: Object.freeze(unknown.map((record) => record.owner)),
  });
}

/**
 * How the runtime reacts to one provider's health.
 *
 * The fault level is the provider's own declaration: a cache failing must not
 * be treated like a corrupt workspace. The donor's evaluation order is
 * preserved exactly — healthy and unknown first, then fatal, then soft, then
 * the restart budget — because the order *is* the contract: a fatal provider is
 * never restarted, and a soft one never consumes the budget.
 */
export function reactionFor({ healthy, healthReason, faultLevel, attempts, maxRestarts }) {
  const level = FAULT_LEVELS.includes(faultLevel) ? faultLevel : 'degraded';
  if (healthy === true) return Object.freeze({ action: 'none', level, reason: 'the provider reports healthy' });
  if (healthy === null) return Object.freeze({ action: 'none', level, reason: healthReason || 'the provider reports no health' });
  if (level === 'fatal') return Object.freeze({ action: 'stop', level, reason: `a fatal provider fault: ${healthReason || 'unhealthy'}` });
  if (level === 'soft') return Object.freeze({ action: 'ignore', level, reason: `a soft failure, continuing: ${healthReason || 'unhealthy'}` });
  if (attempts >= maxRestarts) {
    return Object.freeze({ action: 'degrade', level, reason: `still unhealthy after ${attempts} restart(s): ${healthReason || 'unhealthy'}` });
  }
  return Object.freeze({ action: 'restart', level, reason: `restarting the provider (attempt ${attempts + 1}/${maxRestarts})` });
}

/**
 * Normalize a health answer into one shape, always.
 *
 * An unrecognised or absent answer is `UNKNOWN` — never `HEALTHY`, because
 * "nobody said" and "it works" are not the same claim.
 */
export function normalizeHealth(result, now = Date.now()) {
  const source = result && typeof result === 'object' ? result : {};
  const status = HEALTH_STATUS.includes(source.status) ? source.status : 'UNKNOWN';
  return Object.freeze({
    status,
    reason: typeof source.reason === 'string' && source.reason ? source.reason : status === 'HEALTHY' ? 'reported healthy' : 'no health was reported',
    latencyMs: Number.isFinite(source.latencyMs) ? source.latencyMs : null,
    detail: source.detail && typeof source.detail === 'object' ? { ...source.detail } : null,
    at: new Date(now).toISOString(),
  });
}

/**
 * Create a bounded provider ledger.
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.maxRestarts]
 * @param {object} [options.events]
 * @param {(owner: string) => void} [options.onRelease] called when a provider is
 *   unloaded, so the registry can revoke what it provided. The ledger does not
 *   import the registry: the composition root wires the two together, which is
 *   what keeps each one readable on its own.
 */
export function createProviderLedger(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const events = options.events ?? null;
  const maxRestarts = Number.isSafeInteger(options.maxRestarts) && options.maxRestarts >= 0 ? options.maxRestarts : 2;
  const onRelease = typeof options.onRelease === 'function' ? options.onRelease : () => {};

  /** owner -> record */
  const records = new Map();
  /** owner -> restart count */
  const restarts = new Map();
  const history = [];

  const emit = (type, detail) => {
    if (events && typeof events.emit === 'function') events.emit(type, detail);
  };

  function remember(entry) {
    history.push(entry);
    if (history.length > 200) history.splice(0, history.length - 200);
    return entry;
  }

  /**
   * Register a provider.
   *
   * @returns {{ok: true, record: object} | {ok: false, code: string, reason: string}}
   */
  function register(input = {}) {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    if (!owner) return Object.freeze({ ok: false, code: 'PLUGIN_MANIFEST_INVALID', reason: 'a provider needs an owner' });
    if (records.has(owner)) {
      return Object.freeze({ ok: false, code: 'PLUGIN_DUPLICATE_ID', reason: `${owner} is already registered` });
    }
    const faultLevel = FAULT_LEVELS.includes(input.faultLevel) ? input.faultLevel : 'degraded';
    const record = Object.freeze({
      owner,
      registered: true,
      enabled: input.enabled !== false,
      loaded: false,
      healthy: null,
      health: null,
      fault: null,
      faultLevel,
      faults: Object.freeze([]),
      registeredAt: new Date(now()).toISOString(),
      loadedAt: null,
    });
    records.set(owner, record);
    restarts.set(owner, 0);
    emit('provider.registered', { owner, enabled: record.enabled, faultLevel });
    return Object.freeze({ ok: true, record });
  }

  /** Switch a provider on or off. This flips exactly one fact, as the donor did. */
  function setEnabled(owner, enabled) {
    const record = records.get(String(owner));
    if (!record) return Object.freeze({ ok: false, code: 'PLUGIN_NOT_FOUND', reason: `${owner} is not registered` });
    const next = Object.freeze({ ...record, enabled: Boolean(enabled) });
    records.set(next.owner, next);
    emit(next.enabled ? 'provider.enabled' : 'provider.disabled', { owner: next.owner });
    return Object.freeze({ ok: true, record: next });
  }

  /**
   * Load one provider.
   *
   * @returns {{ok: true, record: object, already?: true} | {ok: false, code: string, level: string, reason: string}}
   */
  function load(owner, { force = false } = {}) {
    const record = records.get(String(owner));
    if (!record) return Object.freeze({ ok: false, code: 'PLUGIN_NOT_FOUND', level: 'degraded', reason: `${owner} is not registered` });
    if (record.loaded) return Object.freeze({ ok: true, record, already: true });
    if (!record.enabled && force !== true) {
      return Object.freeze({ ok: false, code: 'PLUGIN_DISABLED', level: record.faultLevel, reason: `${record.owner} is disabled` });
    }
    const next = Object.freeze({ ...record, loaded: true, loadedAt: new Date(now()).toISOString(), healthy: null, health: null });
    records.set(next.owner, next);
    emit('provider.loaded', { owner: next.owner });
    return Object.freeze({ ok: true, record: next });
  }

  /**
   * Load every enabled provider in the order given.
   *
   * A refusal is per provider and never aborts the batch: one broken provider
   * must not be able to stop the rest of the composition from coming up.
   */
  function loadAll(owners) {
    const results = [];
    for (const owner of owners) results.push({ owner, ...load(owner) });
    return Object.freeze({
      results: Object.freeze(results.map(Object.freeze)),
      loaded: Object.freeze(results.filter((result) => result.ok === true && result.record?.loaded).map((result) => result.owner)),
      refused: Object.freeze(results.filter((result) => result.ok === false).map((result) => result.owner)),
    });
  }

  /**
   * Record that a provider's own hook threw. The provider is contained: the
   * fault is recorded at its declared level and nothing else changes.
   */
  function fault(owner, { code, phase, reason, level } = {}) {
    const record = records.get(String(owner));
    if (!record) return Object.freeze({ ok: false, code: 'PLUGIN_NOT_FOUND', reason: `${owner} is not registered` });
    const faultEntry = Object.freeze({
      code: typeof code === 'string' && code ? code : 'PLUGIN_LOAD_FAILED',
      phase: typeof phase === 'string' && phase ? phase : 'load',
      reason: String(reason ?? 'the provider failed'),
      level: FAULT_LEVELS.includes(level) ? level : record.faultLevel,
      at: new Date(now()).toISOString(),
    });
    const next = Object.freeze({
      ...record,
      loaded: false,
      loadedAt: null,
      healthy: null,
      health: null,
      fault: faultEntry,
      faults: Object.freeze([...record.faults, faultEntry]),
    });
    records.set(next.owner, next);
    emit('provider.fault', { owner: next.owner, code: faultEntry.code, level: faultEntry.level, reason: faultEntry.reason });
    return Object.freeze({ ok: true, fault: faultEntry, record: next });
  }

  /**
   * Unload one provider and release everything it held.
   *
   * The release callback runs even when the provider's own unload hook failed,
   * because a capability that outlives its provider is a lie about what is
   * available.
   */
  function unload(owner) {
    const record = records.get(String(owner));
    if (!record) return Object.freeze({ ok: false, code: 'PLUGIN_NOT_FOUND', reason: `${owner} is not registered` });
    if (!record.loaded) return Object.freeze({ ok: true, record, already: true });
    onRelease(record.owner);
    const next = Object.freeze({ ...record, loaded: false, loadedAt: null, healthy: null, health: null });
    records.set(next.owner, next);
    restarts.set(next.owner, 0);
    emit('provider.unloaded', { owner: next.owner });
    return Object.freeze({ ok: true, record: next });
  }

  /**
   * Ask a provider for its health, through a supplied probe.
   *
   * The probe may throw; a throw is `UNHEALTHY` and never escapes, exactly as
   * the donor contained a throwing `healthCheck`.
   */
  function checkHealth(owner, probe) {
    const record = records.get(String(owner));
    if (!record) return Object.freeze({ ok: false, code: 'PLUGIN_NOT_FOUND', reason: `${owner} is not registered` });
    if (!record.loaded) {
      const health = normalizeHealth({ status: 'UNKNOWN', reason: `${record.owner} is not loaded` }, now());
      records.set(record.owner, Object.freeze({ ...record, health, healthy: null }));
      return Object.freeze({ ok: true, health, record: records.get(record.owner) });
    }
    if (typeof probe !== 'function') {
      const health = normalizeHealth({ status: 'UNKNOWN', reason: 'the provider implements no health probe' }, now());
      records.set(record.owner, Object.freeze({ ...record, health, healthy: null }));
      return Object.freeze({ ok: true, health, record: records.get(record.owner) });
    }
    const started = now();
    let raw;
    try {
      raw = probe();
    } catch (error) {
      raw = { status: 'UNHEALTHY', reason: `the health probe threw: ${error && error.message ? error.message : String(error)}` };
    }
    const health = normalizeHealth({ ...(raw && typeof raw === 'object' ? raw : {}), latencyMs: Number.isFinite(raw?.latencyMs) ? raw.latencyMs : now() - started }, now());
    const healthy = health.status === 'HEALTHY' ? true : health.status === 'UNKNOWN' ? null : false;
    const record2 = Object.freeze({ ...record, health, healthy });
    records.set(record2.owner, record2);
    emit('provider.health', { owner: record2.owner, status: health.status });
    return Object.freeze({ ok: true, health, record: record2 });
  }

  /** The full lifecycle verdict for one provider. */
  function status(owner) {
    const record = records.get(String(owner));
    if (!record) return Object.freeze({ ok: false, code: 'PLUGIN_NOT_FOUND', reason: `${owner} is not registered` });
    return Object.freeze({
      ok: true,
      owner: record.owner,
      state: deriveProviderState(record),
      registered: record.registered,
      enabled: record.enabled,
      loaded: record.loaded,
      healthy: record.healthy,
      faultLevel: record.faultLevel,
      fault: record.fault,
      faults: record.faults,
      health: record.health,
      restarts: restarts.get(record.owner) || 0,
    });
  }

  function list() {
    return [...records.values()].map((record) => status(record.owner));
  }

  /** Count a restart attempt, then reload. A failed attempt still costs budget. */
  function recordRestart(owner) {
    const key = String(owner);
    const attempts = (restarts.get(key) || 0) + 1;
    restarts.set(key, attempts);
    return attempts;
  }

  return Object.freeze({
    PROVIDER_STATES,
    FAULT_LEVELS,
    HEALTH_STATUS,
    maxRestarts,
    register,
    setEnabled,
    load,
    loadAll,
    fault,
    unload,
    checkHealth,
    status,
    list,
    reactionFor: (owner) => {
      const record = records.get(String(owner));
      if (!record) return null;
      return reactionFor({
        healthy: record.healthy,
        healthReason: record.health ? record.health.reason : null,
        faultLevel: record.faultLevel,
        attempts: restarts.get(record.owner) || 0,
        maxRestarts,
      });
    },
    recordRestart,
    restartCount: (owner) => restarts.get(String(owner)) || 0,
    aggregate: () => aggregateHealth([...records.values()]),
    history: () => history.slice(),
    remember,
    has: (owner) => records.has(String(owner)),
    get: (owner) => records.get(String(owner)) ?? null,
    get size() {
      return records.size;
    },
  });
}
