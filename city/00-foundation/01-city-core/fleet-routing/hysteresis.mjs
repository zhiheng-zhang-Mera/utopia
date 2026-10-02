// Anti-flap and hysteresis for routing decisions (RS-202 step 5).
//
// Step 5 asks for hysteresis that stops a task being thrown back and forth between devices and
// providers. Two damping rules do the work, and each defeats a different oscillation:
//
//   - PERSISTENCE. A switch needs the SAME alternative observed `min_consecutive_confirmations` times
//     running. One odd reading never moves anything, which is what stops a single noisy sample from
//     relocating work.
//   - DWELL. Even a persistent alternative must wait `min_dwell_ms` since the last switch. This is the
//     rule that actually kills flapping: under persistence alone, A B A B never accumulates, but a
//     genuinely alternating pool can still switch once per pair. The dwell bounds the switch RATE.
//
// The first selection is not a flap and is adopted immediately - damping an initial choice would just
// add latency for nothing. Every decision is reported with its reason so a suppressed switch is
// explainable rather than silently swallowed.
export const FLAP_CONTRACT_VERSION = 1;

export const FLAP_DECISIONS = Object.freeze(['ADOPTED', 'HOLD', 'SWITCH', 'SUPPRESSED']);

export const DEFAULT_ANTI_FLAP_POLICY = Object.freeze({
  policy_ref: 'policy:rs-anti-flap-default',
  /** Mirrors the foreman's own "N consecutive ticks" precedent rather than inventing a new shape. */
  min_consecutive_confirmations: 2,
  /** A switch rate limit. Without it, a persistently alternating pool still flaps once per pair. */
  min_dwell_ms: 30000,
});

export function createAntiFlap({ policy = DEFAULT_ANTI_FLAP_POLICY, now = () => Date.now() } = {}) {
  const config = { ...DEFAULT_ANTI_FLAP_POLICY, ...(policy && typeof policy === 'object' ? policy : {}) };
  const subjects = new Map();
  const counters = { considerations: 0, adopted: 0, held: 0, switched: 0, suppressed: 0 };

  const stateFor = ref => {
    if (!subjects.has(ref)) subjects.set(ref, { current: null, pending: null, confirmations: 0, lastSwitchAt: null, switches: 0 });
    return subjects.get(ref);
  };

  function consider({ subjectRef, candidateRef = null, eligible = true, reason = null } = {}) {
    counters.considerations += 1;
    const state = stateFor(subjectRef);
    const base = { flap_version: FLAP_CONTRACT_VERSION, subject_ref: subjectRef, candidate_ref: candidateRef, eligible, reason };

    // Nothing is available. Holding is the only safe answer: swapping to nothing is not a decision.
    if (!eligible || candidateRef === null) {
      counters.held += 1;
      return Object.freeze({ ...base, decision: 'HOLD', current_ref: state.current, confirmations: 0, detail: 'no eligible candidate to move to' });
    }

    // The first selection is an adoption, not a flap.
    if (state.current === null) {
      state.current = candidateRef; state.pending = candidateRef; state.confirmations = 1; state.lastSwitchAt = now(); state.switches += 1;
      counters.adopted += 1;
      return Object.freeze({ ...base, decision: 'ADOPTED', current_ref: state.current, confirmations: 1, detail: 'first selection; adopting immediately rather than adding latency to a non-flap' });
    }

    // The candidate is already where we are: nothing to do, and any pending alternative is stale.
    if (candidateRef === state.current) {
      state.pending = null; state.confirmations = 0;
      counters.held += 1;
      return Object.freeze({ ...base, decision: 'HOLD', current_ref: state.current, confirmations: 0, detail: 'the current selection is still the observed best' });
    }

    // A different alternative. Persistence is counted per ALTERNATIVE, so an oscillating pool never
    // accumulates: A then B resets to 1 each time and the switch is never earned.
    if (state.pending !== candidateRef) { state.pending = candidateRef; state.confirmations = 1; }
    else { state.confirmations += 1; }

    if (state.confirmations < config.min_consecutive_confirmations) {
      counters.held += 1;
      return Object.freeze({
        ...base, decision: 'HOLD', current_ref: state.current, confirmations: state.confirmations,
        detail: `${candidateRef} seen ${state.confirmations}/${config.min_consecutive_confirmations} time(s); one reading never moves work`,
      });
    }

    // Persistence is satisfied. Now the dwell bounds how often we are allowed to act on it.
    const since = state.lastSwitchAt === null ? Number.POSITIVE_INFINITY : now() - state.lastSwitchAt;
    if (since < config.min_dwell_ms) {
      counters.suppressed += 1;
      return Object.freeze({
        ...base, decision: 'SUPPRESSED', current_ref: state.current, confirmations: state.confirmations,
        since_last_switch_ms: Math.max(0, since),
        detail: `${candidateRef} is persistent but the last switch was ${Math.max(0, since)}ms ago, inside the ${config.min_dwell_ms}ms dwell; suppressing to bound the switch rate`,
      });
    }

    state.current = candidateRef; state.pending = null; state.confirmations = 0; state.lastSwitchAt = now(); state.switches += 1;
    counters.switched += 1;
    return Object.freeze({ ...base, decision: 'SWITCH', current_ref: state.current, confirmations: 0, detail: `${candidateRef} persistent and past the dwell; switching` });
  }

  return Object.freeze({
    consider,
    current: subjectRef => stateFor(subjectRef).current,
    /** How many times this subject has ACTUALLY moved. A damped pool shows a small number here. */
    switches: subjectRef => subjects.get(subjectRef)?.switches ?? 0,
    stats: () => Object.freeze({ ...counters }),
    policy: () => Object.freeze({ ...config }),
  });
}
