/**
 * UTOPIA · Research Institute — Level-B research selection core.
 *
 * Given candidate research questions produced by repo inspection + web-AI
 * reviewers, the supervisor selects a falsifiable question whose hypothesis is
 * testable by a deterministic experiment. Decisions follow the rule
 * `evidence > vote`: novelty/feasibility heuristics may rank proposals, but a
 * hypothesis is never adopted by reviewer vote alone.
 *
 * Ported from the Codex-Boss donor `src/shared/research-levelb.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The rules that must never be softened:
 *   - a question is research-ready only when it is BOTH measurable and falsifiable
 *     (the donor's truthiness test, not an identity test);
 *   - measurable is checked before falsifiable, so a candidate that is neither is
 *     rejected with the measurable reason;
 *   - rejected candidates are reported with their reason, never silently dropped;
 *   - ranking is `(novelty ?? 0) + (feasibility ?? 0)`, and the donor's
 *     `[...ready].sort(...)` is stable, so an exact score tie keeps the earlier
 *     candidate.
 */

import { validateCandidateQuestion } from './contracts.mjs';

/** A question is research-ready only when both measurable and falsifiable. */
export function isFalsifiable(candidate) {
  return candidate.measurable && candidate.falsifiable;
}

/**
 * Selects the falsifiable candidate with the best (novelty + feasibility)
 * heuristic; unmeasurable/unfalsifiable candidates are rejected with reasons
 * (never silently dropped).
 */
export function selectFalsifiableQuestion(candidates) {
  const rejected = [];
  const ready = [];
  for (const candidate of candidates) {
    validateCandidateQuestion(candidate);
    if (!candidate.measurable) { rejected.push({ id: candidate.id, reason: 'no measurable primary metric proposed' }); continue; }
    if (!candidate.falsifiable) { rejected.push({ id: candidate.id, reason: 'hypothesis is not falsifiable' }); continue; }
    ready.push(candidate);
  }
  if (!ready.length) return { selectedId: null, rejected, reason: rejected.length ? 'no falsifiable candidate' : 'no candidates' };
  const best = [...ready].sort((a, b) => score(b) - score(a))[0];
  return { selectedId: best.id, rejected, reason: `falsifiable + measurable: ${best.question}` };
}

function score(candidate) {
  return (candidate.noveltyScore ?? 0) + (candidate.feasibilityScore ?? 0);
}
