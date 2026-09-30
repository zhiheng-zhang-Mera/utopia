/**
 * UTOPIA · Research Institute — cross-review loop and publication mode.
 *
 * Review is not a one-shot comment: each structured objection gets a
 * response/rebuttal, sections are revised, and re-review proceeds until the
 * meta-review approves or an objection is explicitly retained. PUBLICATION mode
 * additionally requires: research contract present, sufficiency gate PASS, every
 * reviewer responded, meta-review approval. ACCEPTANCE/SMOKE mode stays on the
 * fast path.
 *
 * Ported from the Codex-Boss donor `src/shared/research-review.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The rules that must never be softened:
 *   - a response may only target an objection that exists in the round (the donor's
 *     `Unknown objection <id>` refusal);
 *   - an objection with no response is *open*, and an open objection never also
 *     reports a violation;
 *   - a major objection may not be merely retained, and every response must carry a
 *     non-blank reply;
 *   - a settled round still needs at least one revised section to be approved;
 *   - the four publication gates are reported in the donor's fixed order.
 *
 * The donor's result shapes (`ReviewVerdict`, `reviewRoundSettled`'s report) are
 * built here; the value shapes are documented in `./contracts.mjs`.
 */

export { REVIEW_ROLES } from './contracts.mjs';

/** Appends responses; validation: every response targets an existing objection. */
export function respondToObjections(round, responses) {
  for (const response of responses) {
    if (!round.objections.some((objection) => objection.id === response.objectionId)) throw new Error(`Unknown objection ${response.objectionId}`);
  }
  const merged = [...round.responses];
  for (const response of responses) {
    const index = merged.findIndex((item) => item.objectionId === response.objectionId);
    if (index >= 0) merged[index] = response; else merged.push(response);
  }
  return { ...round, responses: merged };
}

/** A round is settled when every objection has a response and each is either
 *  addressed (revisedSections) or explicitly retained (minor only). */
export function reviewRoundSettled(round) {
  const open = [];
  const violations = [];
  for (const objection of round.objections) {
    const response = round.responses.find((item) => item.objectionId === objection.id);
    if (!response) { open.push(objection.id); continue; }
    if (response.retainedReason && objection.severity === 'major') violations.push(`major objection ${objection.id} cannot be merely retained`);
    if (!response.reply?.trim()) violations.push(`objection ${objection.id} has no response`);
  }
  return { settled: open.length === 0 && violations.length === 0, open, violations };
}

/**
 * Meta-review: approve only a settled round whose revisions landed.
 *
 * An unsettled round reports its violations first and always appends the donor's
 * literal `open objections remain`, even when the only problem is a violation.
 */
export function metaReview(round) {
  const { settled, violations } = reviewRoundSettled(round);
  if (!settled) return { verdict: 'REVISE', reasons: [...violations, 'open objections remain'] };
  const revised = round.responses.some((response) => response.revisedSections.length);
  return { verdict: revised ? 'APPROVED' : 'REVISE', reasons: revised ? [] : ['no sections revised'] };
}

/** PUBLICATION mode requires the full gate chain; ACCEPTANCE/SMOKE is untouched. */
export function publicationReady(state) {
  const missing = [];
  if (!state.contractPresent) missing.push('research contract missing');
  if (!state.sufficiencyPassed) missing.push('sufficiency gate failed');
  if (!state.reviewSettled) missing.push('review round unsettled');
  if (!state.metaApproved) missing.push('meta-review not approved');
  return { ready: missing.length === 0, missing };
}
