/**
 * UTOPIA · Worker Gateway — per-runtime provider health breaker.
 *
 * PURE port of Codex-Boss `electron/commander/circuit-breaker.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, minus persistence.
 *
 * The donor's `CircuitBreaker` class mixes the state machine with `readJson` /
 * `writeJson` persistence from `./durable-json`. PERSISTENCE IS DEFERRED: none of
 * that is carried over. This module never reads or writes a file. It instead
 * accepts a serializable snapshot (`state`) and returns one (`snapshot()`), so
 * the caller owns durable storage — `loadCircuitSnapshot()` performs exactly the
 * donor's constructor validation on a value it was handed, and `snapshot()`
 * produces exactly the donor's `{schemaVersion: 1, records[]}` payload plus the
 * in-memory probe counters the donor never persisted.
 *
 * Also gone: `Date.now` and the mutable class instance. The clock is an injected
 * `now()` parameter and the whole breaker state is a value: every observing call
 * returns the next core state, so the same snapshot and the same clock reading
 * always produce the same result and a historical record can be replayed.
 *
 * The donor's law is preserved exactly (plan §9): repeated provider-technical
 * failures trip a runtime OPEN for a cooldown; after the cooldown HALF_OPEN
 * admits at most one probe whose outcome decides CLOSED (success) or OPEN
 * (failure). A broken provider is isolated instead of dragging the whole
 * dispatch path down. Human/auth/quota/side-effect states never trip the breaker.
 */

import {
  CIRCUIT_DEFAULTS,
  CIRCUIT_SCHEMA_VERSION,
  CircuitOptionError,
  CircuitRecordError,
  NON_TECHNICAL_INTERRUPTION_KINDS,
  PROVIDER_TECHNICAL_KIND_SET,
  PROVIDER_TECHNICAL_KINDS,
  breakerEntry,
  breakerSnapshot,
  circuitBreakerOptions,
  emptySnapshot,
  requireRuntimeId,
  storedProbe,
  storedRecord,
} from './contracts.mjs';

/* ------------------------------------------------------------------ *
 * Interruption classification (donor: circuit-breaker.ts lines 10-16)
 * ------------------------------------------------------------------ */

/**
 * Interruptions that mean the provider itself is unhealthy. User/auth, quota and
 * side-effect states are excluded: they have their own gates (budget reset, human
 * reconciliation) and must not trip the provider health breaker.
 *
 * The donor has this as a module-private `ReadonlySet`; it is exported as data so
 * a caller can inspect the set as well as ask about one kind.
 */
export { PROVIDER_TECHNICAL_KINDS };

/**
 * True only for the donor's six-kind technical set. An unlisted kind — including
 * a kind this module does not know at all — is false, never a throw and never a
 * default-true.
 *
 * @param {string} kind
 * @returns {boolean}
 */
export function providerTechnicalInterruption(kind) {
  return typeof kind === 'string' && PROVIDER_TECHNICAL_KIND_SET.has(kind);
}

/* ------------------------------------------------------------------ *
 * Pure core
 * ------------------------------------------------------------------ */

/**
 * The donor's constructor validation, applied to a snapshot a caller supplies.
 * Fail-closed, exactly as the donor is: a wrong schema version, a non-array
 * `records`, or one malformed record throws, and a malformed record is never
 * repaired into a valid one.
 *
 * @param {unknown} snapshot
 * @returns {Readonly<{schemaVersion: 1, records: readonly object[], probes: readonly object[]}>}
 */
export function loadCircuitSnapshot(snapshot) {
  return breakerSnapshot(snapshot);
}

/** @returns {Readonly<{schemaVersion: 1, records: readonly object[], probes: readonly object[]}>} */
export function emptyCircuitSnapshot() {
  return emptySnapshot();
}

function coreFromSnapshot(snapshot) {
  const loaded = loadCircuitSnapshot(snapshot);
  const records = new Map();
  for (const record of loaded.records) records.set(record.runtimeId, record);
  const halfOpenProbes = new Map();
  for (const probe of loaded.probes) halfOpenProbes.set(probe.runtimeId, probe.probes);
  return { records, halfOpenProbes };
}

function emptyCore() {
  return { records: new Map(), halfOpenProbes: new Map() };
}

function recordOf(core, runtimeId) {
  return core.records.get(runtimeId);
}

/**
 * Derive the reported state of one runtime, exactly as the donor does: an absent
 * record is CLOSED, and a stored OPEN whose `openedAt` is set and whose cooldown
 * has elapsed is reported HALF_OPEN.
 *
 * @param {{records: Map<string, object>}} core
 * @param {string} runtimeId
 * @param {number} now
 * @param {number} cooldownMs
 * @returns {'CLOSED'|'OPEN'|'HALF_OPEN'}
 */
export function stateOf(core, runtimeId, now, cooldownMs) {
  const record = recordOf(core, runtimeId);
  if (!record) return 'CLOSED';
  if (record.state === 'OPEN' && record.openedAt !== undefined && now - record.openedAt >= cooldownMs) return 'HALF_OPEN';
  return record.state;
}

/**
 * Current health state of one runtime. Absent record ⇒ CLOSED; a stored OPEN
 * whose cooldown elapsed is reported HALF_OPEN.
 *
 * @param {{core: object, now: () => number, cooldownMs: number}} breaker
 * @param {string} runtimeId
 * @returns {'CLOSED'|'OPEN'|'HALF_OPEN'}
 */
export function state(breaker, runtimeId) {
  requireRuntimeId(runtimeId);
  return stateOf(breaker.core, runtimeId, breaker.now(), breaker.cooldownMs);
}

/** True while the breaker is tripped and the cooldown has NOT yet elapsed. */
export function isOpen(breaker, runtimeId) {
  return state(breaker, runtimeId) === 'OPEN';
}
/**
 * Dispatch gate. False while OPEN; once the cooldown elapses HALF_OPEN admits a
 * bounded probe, at most one per runtime, and the counter survives until a
 * success, a failed probe, a cancellation or a reset.
 *
 * Returns the core state alongside the verdict so the probe counter is part of
 * the same value the caller persists.
 *
 * @returns {{core: object, admitted: boolean}}
 */
export function admit(breaker, runtimeId) {
  requireRuntimeId(runtimeId);
  const current = stateOf(breaker.core, runtimeId, breaker.now(), breaker.cooldownMs);
  if (current === 'CLOSED') return { core: breaker.core, admitted: true };
  if (current === 'OPEN') return { core: breaker.core, admitted: false };
  const probes = breaker.core.halfOpenProbes.get(runtimeId) ?? 0;
  if (probes >= 1) return { core: breaker.core, admitted: false };
  const halfOpenProbes = new Map(breaker.core.halfOpenProbes);
  halfOpenProbes.set(runtimeId, probes + 1);
  return { core: { ...breaker.core, halfOpenProbes }, admitted: true };
}

/**
 * A verified provider success closes the breaker and clears the failure streak
 * and the probe counter.
 *
 * The donor compares the STORED record state here (`current.state !== "CLOSED"`),
 * not the derived state, so a success that arrives after the cooldown while the
 * record still says OPEN also closes it. That is preserved deliberately.
 *
 * @returns {{core: object, state: 'CLOSED'}}
 */
export function observeSuccess(breaker, runtimeId) {
  requireRuntimeId(runtimeId);
  const timestamp = breaker.now();
  const core = breaker.core;
  const current = recordOf(core, runtimeId);
  let records = core.records;
  if (!current || current.state !== 'CLOSED' || current.consecutiveFailures !== 0) {
    records = new Map(core.records);
    records.set(runtimeId, {
      runtimeId,
      state: 'CLOSED',
      consecutiveFailures: 0,
      updatedAt: new Date(timestamp).toISOString(),
    });
  }
  const halfOpenProbes = new Map(core.halfOpenProbes);
  halfOpenProbes.delete(runtimeId);
  return { core: { records, halfOpenProbes }, state: 'CLOSED' };
}

/**
 * A provider-technical failure counts toward the threshold; a HALF_OPEN probe
 * failure reopens.
 *
 *   - stored OPEN and the cooldown has NOT elapsed: stays OPEN and the cooldown
 *     is NOT extended (a long outage must not extend the cooldown forever);
 *   - stored OPEN and the cooldown HAS elapsed: the probe failed, so reopen with
 *     a fresh cooldown and `consecutiveFailures` set to the threshold;
 *   - otherwise: increment the streak and open at the threshold.
 *
 * @param {{core: object, now: () => number, cooldownMs: number, failureThreshold: number}} breaker
 * @param {string} runtimeId
 * @returns {{core: object, state: 'CLOSED'|'OPEN'}}
 */
export function observeFailure(breaker, runtimeId) {
  requireRuntimeId(runtimeId);
  const now = breaker.now();
  const { cooldownMs, failureThreshold } = breaker;
  const core = breaker.core;
  const current = recordOf(core, runtimeId);
  const records = new Map(core.records);

  if (current?.state === 'OPEN') {
    const elapsed = current.openedAt !== undefined && now - current.openedAt >= cooldownMs;
    // still cooling down; a long outage must not extend the cooldown forever
    if (!elapsed) return { core, state: 'OPEN' };
    // The HALF_OPEN probe failed: reopen with a fresh cooldown.
    records.set(runtimeId, {
      ...current,
      consecutiveFailures: failureThreshold,
      openedAt: now,
      updatedAt: new Date(now).toISOString(),
    });
    const halfOpenProbes = new Map(core.halfOpenProbes);
    halfOpenProbes.delete(runtimeId);
    return { core: { records, halfOpenProbes }, state: 'OPEN' };
  }

  const failures = (current?.consecutiveFailures ?? 0) + 1;
  if (failures >= failureThreshold) {
    records.set(runtimeId, {
      runtimeId,
      state: 'OPEN',
      consecutiveFailures: failures,
      openedAt: now,
      updatedAt: new Date(now).toISOString(),
    });
    const halfOpenProbes = new Map(core.halfOpenProbes);
    halfOpenProbes.delete(runtimeId);
    return { core: { records, halfOpenProbes }, state: 'OPEN' };
  }
  records.set(runtimeId, {
    runtimeId,
    state: 'CLOSED',
    consecutiveFailures: failures,
    updatedAt: new Date(now).toISOString(),
  });
  return { core: { records, halfOpenProbes: core.halfOpenProbes }, state: 'CLOSED' };
}

/**
 * User cancellation must free a consumed HALF_OPEN probe without changing
 * breaker state. The record is untouched, including when there is no record.
 *
 * @returns {{core: object}}
 */
export function cancelProbe(breaker, runtimeId) {
  requireRuntimeId(runtimeId);
  if (!breaker.core.halfOpenProbes.has(runtimeId)) return { core: breaker.core };
  const halfOpenProbes = new Map(breaker.core.halfOpenProbes);
  halfOpenProbes.delete(runtimeId);
  return { core: { ...breaker.core, halfOpenProbes } };
}

/** Remove the record and the probe for one runtime. */
export function reset(breaker, runtimeId) {
  requireRuntimeId(runtimeId);
  const records = new Map(breaker.core.records);
  const halfOpenProbes = new Map(breaker.core.halfOpenProbes);
  records.delete(runtimeId);
  halfOpenProbes.delete(runtimeId);
  return { core: { records, halfOpenProbes } };
}

/**
 * Every runtime that has a record, in insertion order, each with its CURRENT
 * state and its failure streak. A runtime with no record is not listed, because
 * an absent record is not a stored fact.
 *
 * @returns {Array<{runtimeId: string, state: 'CLOSED'|'OPEN'|'HALF_OPEN', consecutiveFailures: number}>}
 */
export function list(breaker) {
  const now = breaker.now();
  return [...breaker.core.records.values()].map((record) =>
    breakerEntry({
      runtimeId: record.runtimeId,
      state: stateOf(breaker.core, record.runtimeId, now, breaker.cooldownMs),
      consecutiveFailures: record.consecutiveFailures,
    }),
  );
}

/**
 * The serializable value a caller persists: the donor's
 * `{schemaVersion: 1, records[]}` payload plus the in-memory probe counters.
 * Copy-on-read, so persisting cannot alias the live state.
 *
 * @param {object} core
 * @returns {Readonly<{schemaVersion: 1, records: readonly object[], probes: readonly object[]}>}
 */
export function snapshotOf(core) {
  return breakerSnapshot({
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    records: [...core.records.values()].map((record) =>
      storedRecord({
        runtimeId: record.runtimeId,
        state: record.state,
        consecutiveFailures: record.consecutiveFailures,
        ...(record.openedAt === undefined ? {} : { openedAt: record.openedAt }),
        updatedAt: record.updatedAt,
      }),
    ),
    probes: [...core.halfOpenProbes.entries()].map(([runtimeId, probes]) =>
      storedProbe({ runtimeId, probes }),
    ),
  });
}

/**
 * Snapshot of one breaker state: the value-level convenience form of
 * `snapshotOf`, for a caller holding a `{core}` rather than the factory object.
 *
 * @param {{core: object}} breaker
 */
export function snapshot(breaker) {
  return snapshotOf(breaker.core);
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

function defineBreaker(core, options) {
  let records = core.records;
  let halfOpenProbes = core.halfOpenProbes;
  const live = () => ({ records, halfOpenProbes });
  const view = () => ({
    core: live(),
    now: options.now ?? (() => {
      throw new CircuitOptionError('no clock: pass options.now (this module never calls Date.now)');
    }),
    cooldownMs: options.cooldownMs,
    failureThreshold: options.failureThreshold,
  });

  return Object.freeze({
    failureThreshold: options.failureThreshold,
    cooldownMs: options.cooldownMs,
    now: view().now,
    state: (runtimeId) => state(view(), runtimeId),
    isOpen: (runtimeId) => isOpen(view(), runtimeId),
    admit: (runtimeId) => {
      const outcome = admit(view(), runtimeId);
      halfOpenProbes = outcome.core.halfOpenProbes;
      return outcome.admitted;
    },
    observeSuccess: (runtimeId) => {
      const outcome = observeSuccess(view(), runtimeId);
      records = outcome.core.records;
      halfOpenProbes = outcome.core.halfOpenProbes;
      return outcome.state;
    },
    observeFailure: (runtimeId) => {
      const outcome = observeFailure(view(), runtimeId);
      records = outcome.core.records;
      halfOpenProbes = outcome.core.halfOpenProbes;
      return outcome.state;
    },
    cancelProbe: (runtimeId) => cancelProbe(view(), runtimeId),
    reset: (runtimeId) => reset(view(), runtimeId),
    list: () => list(view()),
    snapshot: () => snapshotOf(live()),
    /** The live core state, for a caller that persists between observations. */
    core: live,
  });
}

/**
 * Build a breaker over injected state and an injected clock.
 * Two shapes are available, and they are the same state machine:
 *
 *   - the factory object (`createCircuitBreaker`) mirrors the donor's class, so
 *     `observeFailure(runtimeId)` returns the new circuit state — CLOSED or OPEN —
 *     exactly as the donor method does, keeping its own records and probe
 *     counters as it goes; `admit(runtimeId)` returns a boolean.
 *   - the value-level exports (`state`, `admit`, `observeFailure`, ...) take an
 *     explicit `{core, now, cooldownMs, failureThreshold}` and return the next
 *     core state, so a caller can branch a what-if or replay history without
 *     mutating the breaker it is asking about.
 *
 * Neither shape reads a file. The donor's optional first `file` argument is
 * deliberately absent: this module takes no path and touches no disk.
 *
 * @param {{state?: object, options?: {failureThreshold?: number, cooldownMs?: number,
 *          now?: () => number}}} [config]
 */
export function createCircuitBreaker(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new CircuitOptionError('createCircuitBreaker expects an object');
  }
  const options = circuitBreakerOptions(config.options ?? {});
  const core = config.state === undefined ? emptyCore() : coreFromSnapshot(config.state);
  return defineBreaker(core, options);
}

/** Defaults the donor applies when an option is omitted. */
export const DEFAULTS = CIRCUIT_DEFAULTS;

/** The interruption kinds the donor's breaker must not treat as technical. */
export const NON_TECHNICAL_KINDS = NON_TECHNICAL_INTERRUPTION_KINDS;

export { CircuitOptionError, CircuitRecordError };
