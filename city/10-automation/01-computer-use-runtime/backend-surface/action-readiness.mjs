/**
 * UTOPIA · 10-automation / Computer Use Runtime — action-readiness.
 *
 * Donor: `src/shared/action-readiness.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure and unchanged in behaviour.
 *
 * R43 Phase B (R-201): web-AI action readiness gate (pure + shareable).
 *
 * Before any high-risk browser action (click / type / submit) a worker must prove
 * the page is ready along an ordered chain:
 *
 *   navigation accepted → DOM ready → target exists → visible → enabled →
 *   stable for a bounded interval → action allowed
 *
 * After the action the executor must verify the expected page/DOM/message state
 * changed; otherwise it falls into bounded retry → selector refresh → alternate
 * strategy (never an unbounded repeat of the same action). This module is the
 * deterministic decision core; the DOM executor triggers the probe scripts and
 * applies the verdicts (see `dom-page.mjs`).
 *
 * Every gate, precedence rule and retry bound below is the donor's. No clock, no
 * filesystem, no network, no randomness: readiness is decided from one injected
 * probe sample.
 */

/**
 * The ordered gate vocabulary, donor order.
 * @typedef {"NAVIGATION_ACCEPTED"|"DOM_READY"|"TARGET_EXISTS"|"TARGET_VISIBLE"|"TARGET_ENABLED"|"TARGET_STABLE"|"ACTION_ALLOWED"} ReadinessGate
 */

/** @type {readonly ReadinessGate[]} donor line 26 */
export const READINESS_GATES = Object.freeze([
  "NAVIGATION_ACCEPTED",
  "DOM_READY",
  "TARGET_EXISTS",
  "TARGET_VISIBLE",
  "TARGET_ENABLED",
  "TARGET_STABLE",
  "ACTION_ALLOWED"
]);

/**
 * Does this gate block for this sample? Private in the donor (line 58).
 *
 * Absence of a fact is "unknown ⇒ pass" for every gate except DOM_READY, which
 * blocks on any present-but-not-"complete" readyState. ACTION_ALLOWED never
 * blocks: "permission decisions are the executor's gate; default allowed".
 *
 * @param {import("./contracts.mjs").ReadinessProbeFacts} facts
 * @param {ReadinessGate} gate
 * @returns {boolean}
 */
function gateFailed(facts, gate) {
  switch (gate) {
    case "NAVIGATION_ACCEPTED":
      return facts.navigationAccepted === false; // explicit rejection blocks; absent = unknown/pass
    case "DOM_READY":
      return facts.readyState !== undefined && facts.readyState !== "complete";
    case "TARGET_EXISTS":
      return facts.found === false;
    case "TARGET_VISIBLE":
      return facts.visible === false;
    case "TARGET_ENABLED":
      return facts.enabled === false;
    case "TARGET_STABLE":
      return facts.stableSamples !== undefined && facts.stableSamples < 1;
    case "ACTION_ALLOWED":
      return false; // permission decisions are the executor's gate; default allowed
  }
}

/**
 * Decides readiness from one probe sample. A gate only blocks when the probe
 * actually reports a failing fact for it (absence of the fact is treated as
 * "unknown ⇒ pass", which keeps deterministic fakes compatible while real page
 * probes carry full facts).
 *
 * `observed` is the caller's own object, returned by reference exactly as the
 * donor returns it.
 *
 * @param {import("./contracts.mjs").ReadinessProbeFacts} facts
 * @returns {{ready: boolean, blockers: ReadinessGate[], observed: import("./contracts.mjs").ReadinessProbeFacts}}
 */
export function readinessFromProbe(facts) {
  const blockers = READINESS_GATES.filter((gate) => gateFailed(facts, gate));
  return { ready: blockers.length === 0, blockers, observed: facts };
}

/**
 * Post-action verification: the observed state must confirm the expected change.
 * `changed` wins when present; otherwise the text must contain `expected`;
 * otherwise NOT verified — "never assume".
 *
 * @param {{changed?: boolean, expected?: string, text?: string}} observed
 * @returns {boolean}
 */
export function postActionVerified(observed) {
  if (observed.changed !== undefined) return observed.changed === true;
  if (observed.expected !== undefined) return observed.text !== undefined && observed.text.includes(observed.expected);
  return false; // no evidence of change ⇒ NOT verified (never assume)
}

/**
 * Bounded escalation after a failed/unverified action: `BOUNDED_RETRY` while
 * `attempts < maxBoundedRetries`, `SELECTOR_REFRESH` for exactly one more
 * attempt, then `ALTERNATE_STRATEGY` forever.
 *
 * The donor's declared "FAILED" verdict is unreachable: every input maps to one
 * of the three returned values. Preserved (the arithmetic is the donor's own
 * `attempts < maxBoundedRetries + 1`), and pinned by a test.
 *
 * @param {number} attempts
 * @param {number} maxBoundedRetries
 * @returns {"BOUNDED_RETRY"|"SELECTOR_REFRESH"|"ALTERNATE_STRATEGY"}
 */
export function escalationAfterFailure(attempts, maxBoundedRetries) {
  if (attempts < maxBoundedRetries) return "BOUNDED_RETRY";
  if (attempts < maxBoundedRetries + 1) return "SELECTOR_REFRESH";
  return "ALTERNATE_STRATEGY";
}
