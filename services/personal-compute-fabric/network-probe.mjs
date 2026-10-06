// PCF-701 network measurement: RTT and throughput are properties of a PATH, never of "the LAN".
//
// The workbook is explicit: a network measurement must be per path, and "the local network is up" may not stand in
// for an RTT or a bandwidth figure. This module therefore keys every measurement by an explicit path identity
// (`{from, to}` plus an optional route), never returning a number for a path it did not measure: an unmeasured path
// answers UNKNOWN with a reason, and a failed one keeps its failure, its attempt count and its backoff.
//
// Budget and deadline discipline is the same as the collector's: a probe that never returns cannot freeze its caller.
export const PROBE_STATUS = Object.freeze({MEASURED: 'MEASURED', THROTTLED: 'THROTTLED', TIMEOUT: 'TIMEOUT', FAILED: 'FAILED', UNKNOWN: 'UNKNOWN'});
export const PROBE_REASONS = Object.freeze({NEVER_MEASURED: 'NEVER_MEASURED', BUDGET_EXCEEDED: 'BUDGET_EXCEEDED', PROBE_FAILED: 'PROBE_FAILED', BOUNCED: 'BOUNCED', THROTTLED: 'THROTTLED', INVALID_RESULT: 'INVALID_RESULT'});

export class ProbeError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'ProbeError';
    this.code = code;
  }
}

const pathKey = path => {
  if (!path || typeof path !== 'object') throw new ProbeError('PATH_INVALID', 'a network path must be an object');
  const {from, to, route = null} = path;
  if (!from || !to) throw new ProbeError('PATH_INVALID', 'a network path needs both ends: {from, to}');
  return `${from}->${to}${route ? `@${route}` : ''}`;
};

/**
 * @param measure   async (path) => milliseconds. The ONLY way this module learns a latency. Injected so a test can
 *                  make it slow, failing or hostile without touching a real network.
 * @param now       injectable wall clock; monotonic injectable tick clock for budget accounting.
 * @param budgetMs  per-attempt deadline: on expiry the caller stops waiting and the path becomes TIMEOUT.
 * @param minIntervalMs per-path throttle; backoffBaseMs/maxBackoffMs exponential backoff after failures.
 */
export const createPathProbe = ({
  measure,
  now = () => Date.now(),
  monotonic = () => Number(process.hrtime.bigint()) / 1e6,
  budgetMs = 250,
  minIntervalMs = 1000,
  backoffBaseMs = 1000,
  maxBackoffMs = 60_000,
} = {}) => {
  if (typeof measure !== 'function') throw new ProbeError('CONFIG_INVALID', 'createPathProbe needs a measure(path) function');
  const state = new Map();
  const stateFor = key => {
    if (!state.has(key)) state.set(key, {key, measurements: 0, failures: 0, consecutiveFailures: 0, lastAttemptAt: null, lastMeasuredAt: null, lastRttMs: null, backoffMs: 0, reason: PROBE_REASONS.NEVER_MEASURED});
    return state.get(key);
  };

  const measurePath = async (path, {force = false} = {}) => {
    const key = pathKey(path);
    const entry = stateFor(key);
    const startedAt = now();
    const waitMs = entry.lastAttemptAt === null ? 0 : Math.max(minIntervalMs, entry.backoffMs) - (startedAt - entry.lastAttemptAt);
    if (!force && entry.lastAttemptAt !== null && waitMs > 0) {
      return Object.freeze({path: key, status: PROBE_STATUS.THROTTLED, rttMs: null, reason: PROBE_REASONS.THROTTLED, waitMs, attempts: entry.measurements, backoffMs: entry.backoffMs, measuredAt: entry.lastMeasuredAt});
    }
    entry.lastAttemptAt = startedAt;
    const tick = monotonic();
    let timer = null;
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve({timedOut: true}), budgetMs); });
    let outcome;
    try {
      outcome = await Promise.race([Promise.resolve().then(() => measure({from: path.from, to: path.to, route: path.route ?? null})).then(value => ({value})), deadline]);
    } catch (error) {
      outcome = {failed: error};
    } finally { if (timer !== null) clearTimeout(timer); }
    const overheadMs = monotonic() - tick;
    if (outcome?.timedOut) {
      entry.failures += 1; entry.consecutiveFailures += 1;
      entry.backoffMs = Math.min(maxBackoffMs, entry.backoffMs === 0 ? backoffBaseMs : entry.backoffMs * 2);
      entry.reason = PROBE_REASONS.BUDGET_EXCEEDED;
      return Object.freeze({path: key, status: PROBE_STATUS.TIMEOUT, rttMs: null, reason: PROBE_REASONS.BUDGET_EXCEEDED, budgetMs, overheadMs, attempts: entry.measurements, backoffMs: entry.backoffMs, measuredAt: entry.lastMeasuredAt, sample: null});
    }
    if (outcome?.failed) {
      entry.failures += 1; entry.consecutiveFailures += 1;
      entry.backoffMs = Math.min(maxBackoffMs, entry.backoffMs === 0 ? backoffBaseMs : entry.backoffMs * 2);
      entry.reason = PROBE_REASONS.PROBE_FAILED;
      return Object.freeze({path: key, status: PROBE_STATUS.FAILED, rttMs: null, reason: PROBE_REASONS.PROBE_FAILED, detail: String(outcome.failed?.message ?? outcome.failed), overheadMs, attempts: entry.measurements, backoffMs: entry.backoffMs, measuredAt: entry.lastMeasuredAt, sample: null});
    }
    const rttMs = outcome?.value;
    entry.measurements += 1;
    if (typeof rttMs !== 'number' || !Number.isFinite(rttMs) || rttMs < 0) {
      // An unusable answer is a failure, not a zero: the caller must never receive 0ms for a path nobody measured.
      entry.failures += 1; entry.consecutiveFailures += 1;
      // An invalid result is a FAILURE and must therefore grow the backoff like any other; a version of this branch
      // that only set the reason left the backoff flat, and T19 caught it.
      entry.backoffMs = Math.min(maxBackoffMs, entry.backoffMs === 0 ? backoffBaseMs : entry.backoffMs * 2);
      entry.reason = PROBE_REASONS.INVALID_RESULT;
      return Object.freeze({path: key, status: PROBE_STATUS.FAILED, rttMs: null, reason: PROBE_REASONS.INVALID_RESULT, detail: `measure returned ${JSON.stringify(rttMs)}`, overheadMs, attempts: entry.measurements, backoffMs: entry.backoffMs, measuredAt: entry.lastMeasuredAt, sample: null});
    }
    entry.consecutiveFailures = 0;
    entry.backoffMs = 0;
    entry.lastRttMs = rttMs;
    entry.lastMeasuredAt = now();
    entry.reason = null;
    return Object.freeze({
      path: key, status: PROBE_STATUS.MEASURED, rttMs, reason: null, overheadMs,
      attempts: entry.measurements, backoffMs: 0, measuredAt: entry.lastMeasuredAt,
      // The observation the resource contract consumes: a measured path is the ONLY source of networkRtt.
      sample: {networkRtt: {value: rttMs, unit: 'milliseconds', observedAt: entry.lastMeasuredAt, source: `path:${key}`}},
    });
  };

  return Object.freeze({
    measurePath,
    /** What this probe knows, per path: an unmeasured path reports UNKNOWN with NEVER_MEASURED rather than 0 ms. */
    paths: () => [...state.values()].map(entry => Object.freeze({
      path: entry.key, attempts: entry.measurements, failures: entry.failures, consecutiveFailures: entry.consecutiveFailures,
      rttMs: entry.lastRttMs, backoffMs: entry.backoffMs, measuredAt: entry.lastMeasuredAt,
      status: entry.reason === null && entry.lastRttMs !== null ? PROBE_STATUS.MEASURED : entry.reason === PROBE_REASONS.NEVER_MEASURED ? PROBE_STATUS.UNKNOWN : entry.reason,
    })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    /** A path that was never probed is not a zero-latency path: callers ask first. This is a READ, so it must not
     *  create state for a path nobody measured (T18 caught the earlier version doing exactly that). */
    rttOrNull: path => state.get(pathKey(path))?.lastRttMs ?? null,
  });
};
