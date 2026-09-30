/**
 * UTOPIA · City · Host Health Station — safe points.
 *
 * Ported from the donor `dsh-health-scheduler` src/core/safe-point.js @ 985e2b7;
 * see DONOR.json for the porting ledger. Behaviour is unchanged.
 *
 * Safe points.
 *
 * The scheduler asks "is now a good moment?" and does not store the answer. Task
 * state, checkpoints and resume belong to DS-Hns Core; this module only relays
 * the question to whoever is authoritative and folds their answers together.
 *
 * The one rule that matters: an unanswered question is not a `yes`. When no
 * source is registered, or a source is silent, the registry reports
 * {@link SafePointReading.safe} as `null` — unknown — and a configuration that
 * requires a safe point treats unknown as "not safe".
 *
 * @module host-health-station/safe-point
 */
/** Rank of a state; higher is busier. */
const STATE_RANK = Object.freeze({
  idle: 0,
  busy: 1,
  critical: 2,
  unknown: 3,
});
/**
 * Fold readings into one answer, worst-first.
 * @param {object[]} readings - one reading per source.
 * @returns {object} the folded answer; `safe` is `false` if any source refuses, `null` if any is silent, `true` only if all confirm.
 */
export function foldReadiness(readings) {
  if (readings.length === 0) {
    return {
      safe: null,
      reason: 'no_safe_point_source',
      estimated_state: 'unknown',
      sources: [],
      summary: 'no safe-point source registered; readiness unknown',
    };
  }
  const sorted = [...readings].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const unsafe = sorted.find((reading) => reading.safe === false);
  const worst = sorted.reduce((acc, reading) => (STATE_RANK[reading.estimatedState] > STATE_RANK[acc] ? reading.estimatedState : acc), 'idle');
  if (unsafe !== undefined) {
    return {
      safe: false,
      reason: unsafe.reason,
      estimated_state: worst,
      sources: sorted,
      summary: `unsafe: ${unsafe.source} reports ${unsafe.reason}`,
    };
  }
  const unknown = sorted.find((reading) => reading.safe === null);
  if (unknown !== undefined) {
    return {
      safe: null,
      reason: unknown.reason,
      estimated_state: 'unknown',
      sources: sorted,
      summary: `unknown: ${unknown.source} reports ${unknown.reason}`,
    };
  }
  return {
    safe: true,
    reason: 'safe_point_reached',
    estimated_state: worst,
    sources: sorted,
    summary: sorted.map((reading) => `${reading.source}:safe(${reading.reason})`).join(', '),
  };
}
/**
 * A registry of safe-point sources.
 *
 * Sources are registered by adapters (DS-Hns Core bridge, the restart plugin's
 * checkpoint gate, a test double). A source that throws is contained: it
 * contributes an `unknown` reading, and the scheduler keeps monitoring.
 */
export class SafePointRegistry {
  providers = new Map();
  /** Register a source. Returns a disposer. */
  register(provider) {
    this.providers.set(provider.id, provider);
    return () => {
      if (this.providers.get(provider.id) === provider)
        this.providers.delete(provider.id);
    };
  }
  /** Registered source ids, sorted. */
  sources() {
    return [...this.providers.keys()].sort();
  }
  /** Whether any source is registered at all. */
  get isEmpty() {
    return this.providers.size === 0;
  }
  /**
   * Ask every source, containing failures.
   *
   * @param timeoutMs - per-source budget; a source that overruns is reported
   *   unknown and does not delay the tick.
   */
  async readiness(timeoutMs = 1_000) {
    if (this.providers.size === 0)
      return foldReadiness([]);
    const entries = [...this.providers.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const readings = await Promise.all(entries.map((provider) => this.ask(provider, timeoutMs)));
    return foldReadiness(readings);
  }
  async ask(provider, timeoutMs) {
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve(provider.readiness()),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({
            source: provider.id,
            safe: null,
            reason: 'safe_point_timeout',
            estimatedState: 'unknown',
            detail: `no answer within ${timeoutMs} ms`,
          }), timeoutMs);
        }),
      ]);
      return result;
    }
    catch (error) {
      return {
        source: provider.id,
        safe: null,
        reason: 'safe_point_source_failed',
        estimatedState: 'unknown',
        detail: error.message,
      };
    }
    finally {
      if (timer !== undefined)
        clearTimeout(timer);
    }
  }
}
