// PCF-701 contract: observeResources(sample, context) -> ResourceObservation
//
// PURE. No I/O, no timers, no ambient clock: everything that affects the result arrives as an argument, so the same
// call always returns the same object and a recording can be replayed. The workbook's first rule is why this file
// exists:
//
//   A RESOURCE NUMBER IS NEVER INVENTED. A missing value, a NaN, a negative number, a wrong unit or an out-of-range
//   value does NOT become 0. It becomes a named presence (UNKNOWN / UNSUPPORTED) with a reason, because "the disk is
//   0% full" and "the disk could not be read" are different facts, and placement decisions must tell them apart. An
//   absent OPTIONAL adapter (GPU, battery, network quality) is UNSUPPORTED, not zero.
//
// Data problems are RECORDED, never thrown: a hostile or broken sample must not take a collector down. Programming
// problems (a context without a usable receivedAt) do throw, because a caller that cannot say when it received the
// sample cannot produce a freshness judgement at all.

export const OBSERVATION_SCHEMA_VERSION = 1;

/** Expected unit and legal range per dimension. A sample whose unit disagrees is rejected rather than converted by
 *  guesswork: silently turning 3 GiB into 3 bytes is exactly how a wrong unit becomes a wrong placement. */
export const DIMENSIONS = Object.freeze({
  cpu: {unit: 'ratio', min: 0, max: 1},
  memory: {unit: 'bytes', min: 0},
  disk: {unit: 'bytes', min: 0},
  queue: {unit: 'count', min: 0},
  vram: {unit: 'bytes', min: 0},
  networkRtt: {unit: 'milliseconds', min: 0},
  networkThroughput: {unit: 'bytes_per_second', min: 0},
  battery: {unit: 'ratio', min: 0, max: 1},
  thermal: {unit: 'celsius'},
});

/** OBSERVED = a number we read; ESTIMATED = derived from other measurements; DECLARED = the user or config said so;
 *  UNKNOWN = the dimension exists but no value is available; UNSUPPORTED = no adapter provides it at all. */
export const PRESENCE = Object.freeze({OBSERVED: 'OBSERVED', ESTIMATED: 'ESTIMATED', DECLARED: 'DECLARED', UNKNOWN: 'UNKNOWN', UNSUPPORTED: 'UNSUPPORTED'});

/** FRESH/STALE/EXPIRED come from age against the TTL; UNKNOWN means the age itself could not be established. */
export const FRESHNESS = Object.freeze({FRESH: 'FRESH', STALE: 'STALE', EXPIRED: 'EXPIRED', UNKNOWN: 'UNKNOWN'});

export const SAMPLE_REASONS = Object.freeze({
  MISSING_VALUE: 'MISSING_VALUE',
  NOT_A_NUMBER: 'NOT_A_NUMBER',
  NEGATIVE: 'NEGATIVE',
  WRONG_UNIT: 'WRONG_UNIT',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  REBOOT_EPOCH: 'REBOOT_EPOCH',
  UNKNOWN_DIMENSION: 'UNKNOWN_DIMENSION',
  CLOCK_ROLLBACK: 'CLOCK_ROLLBACK',
  NO_ADAPTER: 'NO_ADAPTER',
});

export class ObservationError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'ObservationError';
    this.code = code;
  }
}

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

/** Age, made monotonic by hand: when the host clock steps backwards the age must not step backwards with it, or a
 *  genuinely old observation would look permanently fresh. `previousAgeMs` is the age the SAME dimension had at the
 *  previous collection, so age never decreases across a rollback, and age is never negative even for a sample that
 *  claims to come from the future. */
const ageOf = (observedAt, receivedAt, previousAgeMs) => {
  if (!isFiniteNumber(observedAt)) return null;
  const raw = Math.max(receivedAt - observedAt, 0);
  return isFiniteNumber(previousAgeMs) ? Math.max(raw, previousAgeMs) : raw;
};

const freshnessOf = (ageMs, ttlMs, staleAfterMs, clockRollback) => {
  if (ageMs === null) return FRESHNESS.UNKNOWN;
  // A rollback may never UPGRADE a value to FRESH: carried-over data is STALE at best, so a backwards clock cannot be
  // used to keep stale values alive.
  if (ageMs <= ttlMs) return clockRollback ? FRESHNESS.STALE : FRESHNESS.FRESH;
  if (ageMs <= staleAfterMs) return FRESHNESS.STALE;
  return FRESHNESS.EXPIRED;
};

const blankState = (spec, {reason, presence, observedAt = null, receivedAt = null, seq = null, ageMs = null, ttlMs = null, dimension = null} = {}) => ({
  dimension, value: null, unit: spec.unit, presence: presence ?? PRESENCE.UNKNOWN, freshness: FRESHNESS.UNKNOWN,
  ageMs, observedAt, receivedAt, sequence: seq, source: null, ttlMs, reason,
});

/**
 * Turn one raw sample plus its reception context into a ResourceObservation.
 *
 * sample:  { [dimension]: {value, unit, observedAt, bootId?, sequence?, presence?, source?} }; a bare number is read as
 *          {value} with the dimension's expected unit and the context's receivedAt.
 * context: { receivedAt (epoch ms, REQUIRED), bootId?, ttlMs? = 5000, staleAfterMs? = ttlMs*3, source?,
 *            unsupported?: string[], previous?: ResourceObservation }
 *          `previous` supplies sequence numbers, ages and drop counters, which is what lets out-of-order samples, a
 *          reboot and a backwards clock be detected without any global state.
 */
export const observeResources = (sample = {}, context = {}) => {
  if (!isFiniteNumber(context.receivedAt)) throw new ObservationError('CONTEXT_INVALID', 'context.receivedAt must be a finite epoch-millisecond number');
  const receivedAt = context.receivedAt;
  const ttlMs = isFiniteNumber(context.ttlMs) ? context.ttlMs : 5000;
  const staleAfterMs = isFiniteNumber(context.staleAfterMs) ? context.staleAfterMs : ttlMs * 3;
  const bootId = context.bootId ?? null;
  const previous = context.previous ?? null;
  const declaredUnsupported = Array.isArray(context.unsupported) ? context.unsupported : [];
  // A rollback is a property of the COLLECTION, not of one dimension: the receiving clock moved backwards relative to
  // the previous collection it recorded.
  const clockRollback = Boolean(previous && isFiniteNumber(previous.receivedAt) && receivedAt < previous.receivedAt);

  const dimensions = {};
  const counters = {accepted: 0, rejected: 0, outOfOrder: 0, unknown: 0, unsupported: 0};
  let latestObservedAt = null;

  const reject = (dimension, spec, reason, {observedAt = null, seq = null} = {}) => {
    counters.rejected += 1;
    if (reason === SAMPLE_REASONS.OUT_OF_ORDER) counters.outOfOrder += 1;
    const previousAgeMs = previous?.dimensions?.[dimension]?.ageMs;
    dimensions[dimension] = blankState(spec, {
      dimension, reason, presence: PRESENCE.UNKNOWN, observedAt, seq, receivedAt, ttlMs,
      ageMs: ageOf(observedAt, receivedAt, isFiniteNumber(previousAgeMs) ? previousAgeMs : null),
    });
  };

  for (const [dimension, spec] of Object.entries(DIMENSIONS)) {
    const raw = sample[dimension];
    const prev = previous?.dimensions?.[dimension] ?? null;
    const previousAgeMs = prev && isFiniteNumber(prev.ageMs) ? prev.ageMs : null;

    if (raw === undefined || raw === null) {
      // Absent from the sample: UNSUPPORTED when the caller declared no adapter, otherwise UNKNOWN. NEVER zero.
      const noAdapter = declaredUnsupported.includes(dimension);
      dimensions[dimension] = blankState(spec, {dimension, presence: noAdapter ? PRESENCE.UNSUPPORTED : PRESENCE.UNKNOWN, reason: noAdapter ? SAMPLE_REASONS.NO_ADAPTER : SAMPLE_REASONS.MISSING_VALUE, receivedAt, ttlMs});
      if (noAdapter) counters.unsupported += 1; else counters.unknown += 1;
      continue;
    }

    const record = typeof raw === 'number' ? {value: raw} : raw;
    const value = record.value;
    const unit = record.unit ?? spec.unit;
    const observedAt = isFiniteNumber(record.observedAt) ? record.observedAt : receivedAt;
    const seq = isFiniteNumber(record.sequence) ? record.sequence : null;
    const recordBootId = record.bootId ?? bootId;
    const rejectHere = reason => reject(dimension, spec, reason, {observedAt, seq});

    // 1. Epoch: a sample from another boot is not mixed into this boot's history at all.
    if (bootId !== null && recordBootId !== null && recordBootId !== bootId) { rejectHere(SAMPLE_REASONS.REBOOT_EPOCH); continue; }
    // 2. Value sanity, in the order a reviewer would try them.
    if (value === undefined || value === null) { rejectHere(SAMPLE_REASONS.MISSING_VALUE); continue; }
    if (!isFiniteNumber(value)) { rejectHere(SAMPLE_REASONS.NOT_A_NUMBER); continue; }
    if (value < 0) { rejectHere(SAMPLE_REASONS.NEGATIVE); continue; }
    if (unit !== spec.unit) { rejectHere(SAMPLE_REASONS.WRONG_UNIT); continue; }
    if (value < spec.min || (spec.max !== undefined && value > spec.max)) { rejectHere(SAMPLE_REASONS.OUT_OF_RANGE); continue; }
    // 3. Ordering per dimension: an older sequence must not overwrite a newer value.
    if (seq !== null && prev && isFiniteNumber(prev.sequence) && seq < prev.sequence) { rejectHere(SAMPLE_REASONS.OUT_OF_ORDER); continue; }
    // 4. A sample dated after its own reception: recorded, but never called fresh.
    if (observedAt > receivedAt) { rejectHere(SAMPLE_REASONS.CLOCK_ROLLBACK); continue; }

    const ageMs = ageOf(observedAt, receivedAt, previousAgeMs);
    counters.accepted += 1;
    latestObservedAt = latestObservedAt === null ? observedAt : Math.max(latestObservedAt, observedAt);
    dimensions[dimension] = {
      dimension, value, unit,
      presence: record.presence && PRESENCE[record.presence] ? record.presence : PRESENCE.OBSERVED,
      freshness: freshnessOf(ageMs, ttlMs, staleAfterMs, clockRollback),
      ageMs, observedAt, receivedAt, sequence: seq,
      source: record.source ?? context.source ?? null,
      ttlMs,
      reason: clockRollback ? SAMPLE_REASONS.CLOCK_ROLLBACK : undefined,
    };
  }

  // A dimension the sample carries that this contract does not know: recorded as UNSUPPORTED, never silently dropped.
  for (const [dimension, record] of Object.entries(sample)) {
    if (DIMENSIONS[dimension]) continue;
    counters.unsupported += 1;
    dimensions[dimension] = {
      dimension, value: null, unit: typeof record === 'object' && record ? record.unit ?? null : null,
      presence: PRESENCE.UNSUPPORTED, freshness: FRESHNESS.UNKNOWN, ageMs: null, observedAt: null, receivedAt,
      sequence: null, source: null, ttlMs, reason: SAMPLE_REASONS.UNKNOWN_DIMENSION,
    };
  }

  return Object.freeze({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    receivedAt,
    observedAt: latestObservedAt,
    bootId,
    source: context.source ?? null,
    ttlMs,
    staleAfterMs,
    clockRollback,
    dimensions: Object.freeze(dimensions),
    counters: Object.freeze({...counters}),
    dropped: isFiniteNumber(previous?.dropped) ? previous.dropped : 0,
  });
};

/** Freshness re-evaluated at a later `now` without touching the sample: callers ask "is this still fresh", they never
 *  re-derive a value. The age is floored by the recorded age so a backwards clock cannot make data look newer. */
export const freshnessAt = (observation, now) => {
  if (!isFiniteNumber(now)) throw new ObservationError('CONTEXT_INVALID', 'freshnessAt needs a finite epoch-millisecond now');
  const out = {};
  for (const [dimension, state] of Object.entries(observation.dimensions)) {
    if (state.ageMs === null || state.observedAt === null) { out[dimension] = FRESHNESS.UNKNOWN; continue; }
    const ageMs = Math.max(now - state.observedAt, state.ageMs);
    const ttl = state.ttlMs ?? observation.ttlMs;
    out[dimension] = freshnessOf(ageMs, ttl, observation.staleAfterMs ?? ttl * 3, observation.clockRollback);
  }
  return Object.freeze(out);
};

/** A dimension whose presence is not a number must not be read as one: returns the value or null, never a fallback. */
export const valueOrNull = (observation, dimension) => {
  const state = observation.dimensions?.[dimension];
  if (!state) return null;
  if (state.presence !== PRESENCE.OBSERVED && state.presence !== PRESENCE.ESTIMATED && state.presence !== PRESENCE.DECLARED) return null;
  return isFiniteNumber(state.value) ? state.value : null;
};
