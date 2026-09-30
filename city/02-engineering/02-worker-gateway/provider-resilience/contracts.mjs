/**
 * UTOPIA · Worker Gateway — provider-resilience contracts.
 *
 * Closed vocabularies and value shapes for the provider health breaker and the
 * semantic-outcome vocabulary it feeds. Everything here is data plus small
 * validators: there is no file, no clock and no network in this module, so a
 * breaker record and an outcome evaluation can be read years later without the
 * machinery that produced them.
 *
 * Donor (read-only): Codex-Boss `electron/commander/circuit-breaker.ts` and
 * `src/shared/provider-outcome.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * What the donor's `circuit-breaker.ts` imports and what happened to it:
 *   - `PROVIDER_TECHNICAL_KINDS` is a module-private `ReadonlySet` in the donor.
 *     It is exported here as data (`PROVIDER_TECHNICAL_KINDS`), so a caller can
 *     inspect the technical set instead of only asking about one kind at a time.
 *   - `InterruptionKind` / `interruptions` come from the donor's
 *     `electron/commander/interruption.ts`. That whole vocabulary is carried
 *     over as `INTERRUPTION_KINDS` so a non-technical kind can be named; the
 *     donor's classifier and recovery ladder (`classifyInterruption`,
 *     `recoveryFor`) are NOT ported — DEFERRED, see DONOR.json.
 *   - `RuntimeId` comes from the donor's `../runtimes/runtime.ts`. Here a runtime
 *     id is plain text; no runtime registry exists in this module.
 *   - `readJson` / `writeJson` from `./durable-json` are NOT carried over.
 *     PERSISTENCE IS DEFERRED: the breaker accepts and returns serializable
 *     snapshots (`breakerSnapshot()`) and never reads or writes a file.
 *
 * Vocabulary:
 *   interruption kind      how a provider call was interrupted (donor's full set)
 *   provider-technical     the six kinds that mean the PROVIDER is unhealthy
 *   circuit state          CLOSED / OPEN / HALF_OPEN as reported by the breaker
 *   stored record          the durable half of a runtime's health, or its absence
 *   snapshot               a serializable copy a caller may persist and restore
 *   semantic outcome       what the OUTPUT achieved, separate from whether the
 *                          CALL worked (donor `src/shared/provider-outcome.ts`)
 */

import {
  NON_SEMANTIC_RUNTIME_CODES,
  OUTCOME_EVALUATOR_VERSION,
  SEMANTIC_OUTCOMES,
} from './provider-outcome.mjs';

/* ------------------------------------------------------------------ *
 * Interruption vocabulary (donor: electron/commander/interruption.ts)
 * ------------------------------------------------------------------ */

/**
 * Every interruption kind the donor can name, in the donor's own order.
 *
 * The donor declares these in the `interruptions` tuple of
 * `electron/commander/interruption.ts` and its breaker consumes them as
 * `InterruptionKind` values. The list is carried over whole so that the
 * non-technical kinds (user, auth, quota, side-effect, unknown) can be named
 * rather than only asserted absent.
 */
export const INTERRUPTION_KINDS = Object.freeze([
  'RATE_LIMIT',
  'QUOTA_EXHAUSTED',
  'CREDIT_EXHAUSTED',
  'SESSION_EXPIRED',
  'AUTH_EXPIRED',
  'NETWORK_FAILURE',
  'PROVIDER_5XX',
  'TOOL_TIMEOUT',
  'BROWSER_CRASH',
  'PROCESS_CRASH',
  'RESOURCE_EXHAUSTED',
  'DEPENDENCY_FAILURE',
  'HUMAN_APPROVAL_REQUIRED',
  'UNKNOWN_INTERRUPTION',
]);

/** `INTERRUPTION_KINDS` as a lookup Set, in the donor's declaration order. */
export const INTERRUPTION_KIND_SET = Object.freeze(new Set(INTERRUPTION_KINDS));

/**
 * The interruption kinds that mean the provider itself is unhealthy.
 *
 * Exported data, where the donor's `PROVIDER_TECHNICAL_KINDS` is a module-private
 * `ReadonlySet` reachable only through `providerTechnicalInterruption(kind)`.
 * User/auth, quota/credit/rate-limit, session, dependency, human-approval and
 * unknown kinds are deliberately absent: they have their own gates (budget reset,
 * human reconciliation) and must not trip the provider health breaker.
 */
export const PROVIDER_TECHNICAL_KINDS = Object.freeze([
  'NETWORK_FAILURE',
  'PROVIDER_5XX',
  'TOOL_TIMEOUT',
  'BROWSER_CRASH',
  'PROCESS_CRASH',
  'RESOURCE_EXHAUSTED',
]);

/** `PROVIDER_TECHNICAL_KINDS` as a lookup Set. */
export const PROVIDER_TECHNICAL_KIND_SET = Object.freeze(new Set(PROVIDER_TECHNICAL_KINDS));

/** Interruption kinds the donor's breaker must never treat as provider-technical. */
export const NON_TECHNICAL_INTERRUPTION_KINDS = Object.freeze(
  INTERRUPTION_KINDS.filter((kind) => !PROVIDER_TECHNICAL_KIND_SET.has(kind)),
);

/**
 * Every closed vocabulary this module publishes, for a caller that wants to
 * enumerate them without importing each name.
 */
export const CLOSED_VOCABULARIES = Object.freeze({
  interruptionKinds: INTERRUPTION_KINDS,
  providerTechnicalKinds: PROVIDER_TECHNICAL_KINDS,
  circuitStates: Object.freeze(['CLOSED', 'OPEN', 'HALF_OPEN']),
  semanticOutcomes: SEMANTIC_OUTCOMES,
  nonSemanticRuntimeCodes: NON_SEMANTIC_RUNTIME_CODES,
  outcomeEvaluatorVersion: OUTCOME_EVALUATOR_VERSION,
});

/* ------------------------------------------------------------------ *
 * Circuit-breaker vocabulary and value shapes
 * ------------------------------------------------------------------ */

/**
 * The three states the breaker reports.
 *
 * Only `CLOSED` and `OPEN` are ever stored; `HALF_OPEN` is derived when an OPEN
 * record's cooldown has elapsed (donor `CircuitBreaker.state`).
 */
export const CIRCUIT_STATES = Object.freeze(['CLOSED', 'OPEN', 'HALF_OPEN']);

/** The two states a stored record may carry. */
export const STORED_CIRCUIT_STATES = Object.freeze(['CLOSED', 'OPEN']);

/** Snapshot schema version — the donor's `CircuitBreakerFile.schemaVersion`. */
export const CIRCUIT_SCHEMA_VERSION = 1;

/**
 * Donor defaults: 3 consecutive provider-technical failures trip the breaker,
 * and an OPEN breaker cools down for 60_000 ms before one probe is admitted.
 */
export const CIRCUIT_DEFAULTS = Object.freeze({ failureThreshold: 3, cooldownMs: 60000 });

/** Inclusive bounds the donor clamps `failureThreshold` to. */
export const FAILURE_THRESHOLD_BOUNDS = Object.freeze({ min: 1, max: 20 });

/** Inclusive bounds the donor clamps `cooldownMs` to (7 days). */
export const COOLDOWN_MS_BOUNDS = Object.freeze({ min: 1, max: 604800000 });

/** Raised when breaker options are not integers, or fail an internal invariant. */
export class CircuitOptionError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'CircuitOptionError';
  }
}

/** Raised when a stored record, probe or snapshot has the wrong shape. */
export class CircuitRecordError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'CircuitRecordError';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Require a runtime id. The donor relies on the `RuntimeId` type at compile time;
 * a plain-JS module validates the boundary instead of trusting it, and never
 * coerces a non-string into a runtime id.
 */
export function requireRuntimeId(value, field = 'runtimeId') {
  if (typeof value !== 'string' || value === '') {
    throw new CircuitRecordError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * The donor's clock: a parameter, never a hidden global. `Date.now` is never
 * called by this module; the caller injects the reading.
 */
export function requireClock(value, field = 'now') {
  if (typeof value !== 'function') throw new CircuitOptionError(`${field} must be a function returning milliseconds`);
  return value;
}

/**
 * Clamp one integer option exactly as the donor's `clampInt` does: a
 * non-integer throws rather than being rounded, and an out-of-range integer is
 * clamped to the nearest bound rather than rejected.
 */
export function clampCircuitOption(value, min, max) {
  if (!Number.isInteger(value)) throw new CircuitOptionError('circuit breaker option must be an integer');
  return Math.min(max, Math.max(min, value));
}

/**
 * Build the breaker's effective options. Copy-on-construct: the returned object
 * is frozen and holds only primitives, so a caller cannot change the breaker by
 * mutating what it passed in.
 *
 * @param {{failureThreshold?: number, cooldownMs?: number, now?: () => number}} [options]
 */
export function circuitBreakerOptions(options = {}) {
  if (!isPlainObject(options)) throw new CircuitOptionError('circuit breaker options must be an object');
  const failureThreshold = clampCircuitOption(
    options.failureThreshold ?? CIRCUIT_DEFAULTS.failureThreshold,
    FAILURE_THRESHOLD_BOUNDS.min,
    FAILURE_THRESHOLD_BOUNDS.max,
  );
  const cooldownMs = clampCircuitOption(
    options.cooldownMs ?? CIRCUIT_DEFAULTS.cooldownMs,
    COOLDOWN_MS_BOUNDS.min,
    COOLDOWN_MS_BOUNDS.max,
  );
  const now = options.now === undefined ? undefined : requireClock(options.now);
  return Object.freeze({ failureThreshold, cooldownMs, now });
}

/**
 * One stored runtime record, exactly as the donor persists it: only `CLOSED` and
 * `OPEN` are storable, `consecutiveFailures` is a non-negative integer, and
 * `openedAt` is present only for an OPEN record (the donor's `StoredRecord`
 * permits `openedAt?: number`, and its probe-reopen path spreads the previous
 * record, so `openedAt` may be present-but-undefined).
 *
 * Copy-on-construct: the input is validated and copied, never adopted. A
 * malformed input throws; nothing here turns invalid input into valid input.
 *
 * @param {{runtimeId: string, state: 'CLOSED'|'OPEN', consecutiveFailures: number,
 *          openedAt?: number|undefined, updatedAt: string}} record
 */
export function storedRecord(record) {
  if (!isPlainObject(record)) throw new CircuitRecordError('stored record must be an object');
  const runtimeId = requireRuntimeId(record.runtimeId, 'record.runtimeId');
  if (!STORED_CIRCUIT_STATES.includes(record.state)) {
    throw new CircuitRecordError(`record.state must be one of ${STORED_CIRCUIT_STATES.join(', ')}`);
  }
  if (!Number.isInteger(record.consecutiveFailures) || record.consecutiveFailures < 0) {
    throw new CircuitRecordError('record.consecutiveFailures must be a non-negative integer');
  }
  if (record.openedAt !== undefined && !Number.isFinite(record.openedAt)) {
    throw new CircuitRecordError('record.openedAt must be a finite number when present');
  }
  if (typeof record.updatedAt !== 'string') {
    throw new CircuitRecordError('record.updatedAt must be a string');
  }
  return Object.freeze({
    runtimeId,
    state: record.state,
    consecutiveFailures: record.consecutiveFailures,
    ...(record.openedAt === undefined ? {} : { openedAt: record.openedAt }),
    updatedAt: record.updatedAt,
  });
}

/**
 * One consumed HALF_OPEN probe counter. The donor keeps this in memory only
 * (`halfOpenProbes`), so it is never part of a stored record; a snapshot may
 * carry it so a restore can be exact.
 *
 * @param {{runtimeId: string, probes: number}} probe
 */
export function storedProbe(probe) {
  if (!isPlainObject(probe)) throw new CircuitRecordError('stored probe must be an object');
  const runtimeId = requireRuntimeId(probe.runtimeId, 'probe.runtimeId');
  if (!Number.isInteger(probe.probes) || probe.probes <= 0) {
    throw new CircuitRecordError('probe.probes must be a positive integer');
  }
  return Object.freeze({ runtimeId, probes: probe.probes });
}

/**
 * A complete, serializable breaker snapshot: the donor's `CircuitBreakerFile`
 * plus the in-memory probe counters. This module never writes it anywhere; a
 * caller decides whether and where to persist it.
 *
 * @param {{schemaVersion?: 1, records: Array<object>, probes?: Array<object>}} snapshot
 */
export function breakerSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) throw new CircuitRecordError('snapshot must be an object');
  if (snapshot.schemaVersion !== CIRCUIT_SCHEMA_VERSION) {
    throw new CircuitRecordError(`snapshot.schemaVersion must be ${CIRCUIT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(snapshot.records)) throw new CircuitRecordError('snapshot.records must be an array');
  const records = snapshot.records.map((record) => storedRecord(record));
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.runtimeId)) throw new CircuitRecordError(`snapshot repeats runtime ${record.runtimeId}`);
    seen.add(record.runtimeId);
  }
  const rawProbes = snapshot.probes ?? [];
  if (!Array.isArray(rawProbes)) throw new CircuitRecordError('snapshot.probes must be an array');
  const probes = rawProbes.map((probe) => storedProbe(probe));
  const probeRuntimes = new Set();
  for (const probe of probes) {
    if (probeRuntimes.has(probe.runtimeId)) throw new CircuitRecordError(`snapshot repeats probe ${probe.runtimeId}`);
    probeRuntimes.add(probe.runtimeId);
  }
  return Object.freeze({ schemaVersion: CIRCUIT_SCHEMA_VERSION, records: Object.freeze(records), probes: Object.freeze(probes) });
}

/** An empty snapshot: no record, no probe, no history. */
export function emptySnapshot() {
  return breakerSnapshot({ schemaVersion: CIRCUIT_SCHEMA_VERSION, records: [], probes: [] });
}

/**
 * One reported breaker state.
 *
 * @param {{runtimeId: string, state: 'CLOSED'|'OPEN'|'HALF_OPEN', consecutiveFailures: number}} entry
 */
export function breakerEntry(entry) {
  if (!isPlainObject(entry)) throw new CircuitRecordError('breaker entry must be an object');
  const runtimeId = requireRuntimeId(entry.runtimeId, 'entry.runtimeId');
  if (!CIRCUIT_STATES.includes(entry.state)) {
    throw new CircuitRecordError(`entry.state must be one of ${CIRCUIT_STATES.join(', ')}`);
  }
  if (!Number.isInteger(entry.consecutiveFailures) || entry.consecutiveFailures < 0) {
    throw new CircuitRecordError('entry.consecutiveFailures must be a non-negative integer');
  }
  return Object.freeze({ runtimeId, state: entry.state, consecutiveFailures: entry.consecutiveFailures });
}

/* ------------------------------------------------------------------ *
 * Semantic-outcome re-exports
 * ------------------------------------------------------------------ *
 * The vocabulary and the shapes live in `provider-outcome.mjs`, which is the
 * port of the donor `src/shared/provider-outcome.ts`; they are re-exported here
 * so this file is the single place a caller reads value shapes from.
 */
export {
  NON_SEMANTIC_RUNTIME_CODES,
  OUTCOME_AXES,
  OUTCOME_EVALUATOR_VERSION,
  REVISION_SCHEMA_VERSION,
  RUNTIME_STATUSES,
  SEMANTIC_OUTCOMES,
  SEMANTIC_OUTCOME_SET,
  createEvaluationRevision,
  deriveSemanticEvaluation,
  detectGoalDrift,
  isNonSemanticRuntimeCode,
  isSemanticOutcome,
} from './provider-outcome.mjs';
