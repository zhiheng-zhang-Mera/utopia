// PCF-701 service: a bounded, rate-limited resource telemetry collector.
//
// It exists to make four failure modes impossible rather than merely unlikely:
//
//   1. AN UNBOUNDED BUFFER. History is a fixed-size ring; when it is full the OLDEST entry is dropped and the drop is
//      counted and readable (`stats().dropped`), so "we lost data" is never silent.
//   2. AN UNBOUNDED PROBE RATE. `minIntervalMs` throttles collection; a throttled call returns the previous
//      observation and does not invoke the sampler at all.
//   3. A PROBE THAT NEVER RETURNS. `budgetMs` bounds every attempt. On timeout the collector resolves with an
//      UNKNOWN observation - no invented values - and the abandoned promise is fenced off: a later collect() still
//      works, because a slow or hung adapter must not freeze its caller.
//   4. COLLECTING THINGS NOBODY AUTHORISED. The sampler is injected by the caller and this service only ever looks at
//      the dimensions the observations contract declares. It never enumerates processes, never reads window contents
//      and never touches personal files; an unknown dimension that a provider does send is recorded as UNSUPPORTED
//      with no value, never stored as data.
//
// Every clock is injected (`now`, `monotonic`), so a test can move time backwards or make a probe hang without any
// real waiting, and the measured overhead is reproducible.
import {observeResources, PRESENCE, SAMPLE_REASONS, ObservationError} from '../../contracts/personal-compute-fabric-v1/observations.mjs';

export const COLLECT_STATUS = Object.freeze({OBSERVED: 'OBSERVED', THROTTLED: 'THROTTLED', TIMEOUT: 'TIMEOUT', SAMPLE_FAILED: 'SAMPLE_FAILED'});

const unknownObservation = (context, reason) => {
  const observation = observeResources({}, context);
  if (!reason) return observation;
  const dimensions = {};
  for (const [dimension, state] of Object.entries(observation.dimensions)) dimensions[dimension] = {...state, reason};
  return Object.freeze({...observation, dimensions: Object.freeze(dimensions)});
};

/**
 * @param sample     async () => rawSample. The ONLY way this service learns anything about the host.
 * @param now        () => epoch ms. Injected so a test can step the clock (including backwards).
 * @param monotonic  () => monotonic ms. Injected so overhead is measurable and never uses the wall clock.
 * @param bufferLimit ring capacity (default 60).
 * @param minIntervalMs throttle window (default 1000); budgetMs per-attempt deadline (default 250).
 */
export const createTelemetryCollector = ({
  sample,
  now = () => Date.now(),
  monotonic = () => Number(process.hrtime.bigint()) / 1e6,
  ttlMs = 5000,
  staleAfterMs = ttlMs * 3,
  minIntervalMs = 1000,
  budgetMs = 250,
  bufferLimit = 60,
  bootId = null,
  unsupported = [],
  source = 'local-collector',
} = {}) => {
  if (typeof sample !== 'function') throw new ObservationError('CONFIG_INVALID', 'createTelemetryCollector needs a sample() provider');
  if (!Number.isInteger(bufferLimit) || bufferLimit < 1) throw new ObservationError('CONFIG_INVALID', 'bufferLimit must be a positive integer');

  const ring = new Array(bufferLimit).fill(null);
  let cursor = 0;          // next write position
  let size = 0;            // entries currently held
  let latest = null;
  const stats = {attempts: 0, observed: 0, throttled: 0, timeouts: 0, failures: 0, dropped: 0, droppedReasons: {}, overheadMs: {last: 0, max: 0, total: 0}};

  const push = observation => {
    if (size === bufferLimit) {
      // The ring is full: the OLDEST entry leaves and the loss is counted, with the reason attributed.
      const evicted = ring[cursor];
      stats.dropped += 1;
      const reason = evicted?.counters?.rejected ? 'REJECTED_OLDEST' : 'BUFFER_FULL';
      stats.droppedReasons[reason] = (stats.droppedReasons[reason] ?? 0) + 1;
    } else size += 1;
    ring[cursor] = observation;
    cursor = (cursor + 1) % bufferLimit;
  };

  /** Ingest a sample that was produced elsewhere. Ordering, epoch and rollback protection all come from `previous`. */
  const ingest = (rawSample, context = {}) => {
    const observation = observeResources(rawSample, {
      receivedAt: context.receivedAt ?? now(), bootId, ttlMs, staleAfterMs, source, unsupported, previous: latest,
    });
    latest = observation;
    push(observation);
    return observation;
  };

  const collect = async (context = {}) => {
    const startedAt = now();
    if (latest && startedAt - latest.receivedAt < minIntervalMs) {
      stats.throttled += 1;
      return Object.freeze({status: COLLECT_STATUS.THROTTLED, observation: latest, overheadMs: 0, dropped: stats.dropped, waitedMs: minIntervalMs - (startedAt - latest.receivedAt)});
    }
    stats.attempts += 1;
    const startedTick = monotonic();
    let timer = null;
    // The deadline races the adapter. On timeout the collector stops waiting (the executor is not frozen) and fences
    // the abandoned promise with a no-op catch, so a late rejection cannot become an unhandled rejection either.
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve({timedOut: true}), budgetMs); });
    let outcome;
    try {
      outcome = await Promise.race([Promise.resolve().then(() => sample()).then(value => ({value})), deadline]);
    } catch (error) {
      outcome = {failed: error};
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const overheadMs = monotonic() - startedTick;
    stats.overheadMs.last = overheadMs;
    stats.overheadMs.max = Math.max(stats.overheadMs.max, overheadMs);
    stats.overheadMs.total += overheadMs;

    if (outcome && outcome.timedOut) {
      stats.timeouts += 1;
      const observation = unknownObservation({receivedAt: now(), bootId, ttlMs, staleAfterMs, source, previous: latest ? {...latest, receivedAt: latest.receivedAt} : null}, 'MEASUREMENT_TIMEOUT');
      latest = observation;
      push(observation);
      return Object.freeze({status: COLLECT_STATUS.TIMEOUT, observation, overheadMs, budgetMs, dropped: stats.dropped});
    }
    if (outcome && outcome.failed) {
      stats.failures += 1;
      const observation = unknownObservation({receivedAt: now(), bootId, ttlMs, staleAfterMs, source, previous: latest}, 'SAMPLE_FAILED');
      latest = observation;
      push(observation);
      return Object.freeze({status: COLLECT_STATUS.SAMPLE_FAILED, observation, overheadMs, error: String(outcome.failed?.message ?? outcome.failed), dropped: stats.dropped});
    }
    stats.observed += 1;
    const observation = observeResources(outcome.value ?? {}, {receivedAt: now(), bootId, ttlMs, staleAfterMs, source, unsupported, previous: latest});
    // The contract's own drop counter is carried forward so a consumer reads one number, not two.
    latest = Object.freeze({...observation, dropped: stats.dropped});
    push(latest);
    return Object.freeze({status: COLLECT_STATUS.OBSERVED, observation: latest, overheadMs, dropped: stats.dropped});
  };

  /** Newest first, at most `limit`, never more than the ring holds. */
  const history = (limit = bufferLimit) => {
    const out = [];
    for (let index = 0; index < Math.min(limit, size); index += 1) out.push(ring[(cursor - 1 - index + bufferLimit * 2) % bufferLimit]);
    return out;
  };

  return Object.freeze({
    collect,
    ingest,
    latest: () => latest,
    history,
    /** A copy, so a caller cannot rewrite the counters it is reading. */
    stats: () => Object.freeze({...stats, overheadMs: Object.freeze({...stats.overheadMs}), droppedReasons: Object.freeze({...stats.droppedReasons}), buffered: size, capacity: bufferLimit}),
    /** Explicitly not a number: a caller asking "what is cpu?" gets null when cpu was never observed. */
    valueOrNull: dimension => {
      const state = latest?.dimensions?.[dimension];
      if (!state) return null;
      const numeric = state.presence === PRESENCE.OBSERVED || state.presence === PRESENCE.ESTIMATED || state.presence === PRESENCE.DECLARED;
      return numeric && Number.isFinite(state.value) ? state.value : null;
    },
    /** Everything this collector will ever look at, stated so an auditor can diff it against the workbook. */
    inspectedSurfaces: () => Object.freeze(Object.keys(latest?.dimensions ?? {})),
    reasonCodes: SAMPLE_REASONS,
  });
};
