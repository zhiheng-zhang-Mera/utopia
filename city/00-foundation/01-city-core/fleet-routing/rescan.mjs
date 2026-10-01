// Bounded, event-driven re-scan for eligibility (RS-202 step 4).
//
// Step 4 asks for a re-scan that is EVENT-DRIVEN FIRST, with the ~20-minute figure used only as an
// upper bound, and that never dead-waits. Three properties implement that, and each exists because of a
// specific failure the workbook or the review list names:
//
//   - EVENT FIRST, CEILING AS BACKSTOP. A caller waits on a signal, not on a clock. The ceiling exists
//     only so that a missed or never-sent event degrades into a re-scan instead of hanging forever.
//   - A SIGNAL IS NOT A WAKE-UP. A signal that does not actually change eligibility must NOT resolve the
//     waiter. Otherwise a chatty producer turns every notification into a re-scan, which is the
//     "re-scan storm" the review list names, and the waiter is woken to discover nothing changed.
//   - NO POLLING. There is no interval, no tick and no loop here. `stats()` counts event wakes against
//     ceiling wakes so the claim "event-driven" is measurable rather than asserted.
export const RESCAN_CONTRACT_VERSION = 1;

/** Why a wait ended. `CEILING` means "re-scan because we ran out of patience", not "nothing will work". */
export const RESCAN_WAKE_REASONS = Object.freeze(['IMMEDIATE', 'EVENT', 'CEILING', 'CANCELLED']);

export const DEFAULT_RESCAN_POLICY = Object.freeze({
  policy_ref: 'policy:rs-rescan-default',
  /** An UPPER BOUND used as policy. It is deliberately not an interval and is never the mechanism. */
  ceiling_ms: 1200000,
  immediate_if_eligible: true,
});

export function createRescanCoordinator({ policy = DEFAULT_RESCAN_POLICY, now = () => Date.now() } = {}) {
  const config = { ...DEFAULT_RESCAN_POLICY, ...(policy && typeof policy === 'object' ? policy : {}) };
  const waiters = new Map();
  const counters = { waits: 0, immediate: 0, event_wakes: 0, ceiling_wakes: 0, cancelled: 0, ignored_signals: 0 };
  let nextId = 1;

  const settle = (entry, wake, extra = {}) => {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    waiters.delete(entry.id);
    entry.resolve(Object.freeze({
      rescan_version: RESCAN_CONTRACT_VERSION,
      key: entry.key,
      wake,
      event_driven: wake === 'EVENT' || wake === 'IMMEDIATE',
      /** A ceiling wake means the caller should re-scan; it never means the work has failed. */
      rescan_required: wake !== 'CANCELLED',
      /** Held open deliberately: routing and re-scan do not decide that a task is over. */
      terminal_failure: false,
      waited_ms: Math.max(0, now() - entry.startedAt),
      ...extra,
    }));
  };

  /**
   * Wait until `isEligible()` is true, an event says something changed, or the ceiling is reached.
   *
   * Resolves rather than rejects in every case, including cancellation, because a re-scan coordinator
   * that throws into the caller's main path would be the dead-wait it exists to prevent.
   */
  function awaitEligibility({ key, isEligible = () => false, ceilingMs = config.ceiling_ms } = {}) {
    counters.waits += 1;
    // The predicate is caller-supplied and may read telemetry, so it can throw. Guarding it HERE as well
    // as in signal() is not redundant: without this the immediate path would throw out of the function
    // and reject into the caller's main path, which is exactly the dead-wait/failure this coordinator
    // exists to prevent. A predicate that cannot answer is treated as "not eligible yet", never as true.
    let alreadyEligible = false;
    if (config.immediate_if_eligible) {
      try { alreadyEligible = isEligible() === true; } catch { alreadyEligible = false; }
    }
    if (alreadyEligible) {
      counters.immediate += 1;
      return Promise.resolve(Object.freeze({
        rescan_version: RESCAN_CONTRACT_VERSION,
        key, wake: 'IMMEDIATE', event_driven: true, rescan_required: false,
        terminal_failure: false, waited_ms: 0,
      }));
    }
    return new Promise(resolve => {
      const id = nextId++;
      const entry = { id, key, isEligible, resolve, settled: false, startedAt: now(), timer: null };
      entry.timer = setTimeout(() => {
        counters.ceiling_wakes += 1;
        settle(entry, 'CEILING', { detail: `no event arrived within the ${ceilingMs}ms ceiling; re-scan rather than keep waiting` });
      }, Number.isSafeInteger(ceilingMs) && ceilingMs > 0 ? ceilingMs : config.ceiling_ms);
      waiters.set(id, entry);
    });
  }

  /**
   * Tell the coordinator something happened. It re-evaluates every waiter for that key and wakes ONLY
   * the ones whose eligibility actually changed; the rest are counted and left waiting, which is what
   * keeps a noisy producer from becoming a re-scan storm.
   */
  function signal(key, detail = null) {
    let woken = 0;
    for (const entry of [...waiters.values()]) {
      if (entry.key !== key) continue;
      let eligible = false;
      try { eligible = entry.isEligible() === true; } catch { eligible = false; }
      if (!eligible) { counters.ignored_signals += 1; continue; }
      counters.event_wakes += 1;
      settle(entry, 'EVENT', { detail });
      woken += 1;
    }
    return Object.freeze({ key, woken, ignored: [...waiters.values()].filter(entry => entry.key === key).length });
  }

  return Object.freeze({
    awaitEligibility,
    signal,
    /** Cancel every wait. Used when the caller stops caring; resolves rather than rejects. */
    cancelAll(detail = 'the caller stopped waiting') {
      let cancelled = 0;
      for (const entry of [...waiters.values()]) { counters.cancelled += 1; settle(entry, 'CANCELLED', { detail }); cancelled += 1; }
      return cancelled;
    },
    pending: () => waiters.size,
    stats: () => Object.freeze({ ...counters }),
    policy: () => Object.freeze({ ...config }),
  });
}
