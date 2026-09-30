/**
 * UTOPIA · Research Institute — Level-A autonomous research planning.
 *
 * Given only a project goal (no research question / experiment / benchmark), the
 * planner drafts a publishable pipeline: repo signals → candidate questions
 * (web-AI proposers) → novelty/feasibility review → falsifiable RQ selection →
 * hypothesis → experiment spec with a replication plan. Deterministic gates never
 * adopt a question by vote alone.
 *
 * Ported from the Codex-Boss donor `src/shared/research-levela.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The donor imported the TYPE
 * `CandidateQuestion` and the VALUE `isFalsifiable` from `research-levelb.ts`; that
 * value edge is preserved here as a real import from `./levelb.mjs`.
 *
 * The rules that must never be softened:
 *   - novelty rewards a question that does not overlap the repo's tested modules and
 *     penalises one that does; a multi-language surface adds one point;
 *   - feasibility gains 2 for a measurable + falsifiable question and loses 1 when
 *     the repo has no test harness at all;
 *   - both scores are clamped into [0, 5] only after those adjustments, and the gate
 *     is `< 2` on each score in the donor's order (novelty first);
 *   - replication runs are clamped into [2, 10], default 3, seed default 42.
 *
 * The clock is injected. The donor defaulted `createdAt` to the live clock
 * (`new Date().toISOString()`); this module is pure, so `now` is an option that
 * defaults to the deterministic `EPOCH_TIMESTAMP` sentinel. Pass `now` to stamp with
 * a host clock.
 */

import {
  DEFAULT_REPLICATION_RUNS,
  DEFAULT_SEED,
  EPOCH_TIMESTAMP,
  FALSIFIABLE_FEASIBILITY_BONUS,
  LEVEL_A_MIN_SCORE,
  NOVELTY_OVERLAP_CREDIT,
  NOVELTY_OVERLAP_PENALTY,
  NOVELTY_SCORE_WEIGHT,
  NO_HARNESS_FEASIBILITY_PENALTY,
  REPLICATION_RUNS_MAX,
  REPLICATION_RUNS_MIN,
  SCORE_MAX,
  SCORE_MIN,
  validateLevelAPlan,
} from './contracts.mjs';
import { isFalsifiable } from './levelb.mjs';

export { validateLevelAPlan };

/** Novelty + feasibility review of one candidate against the repo signals. */
export function noveltyReview(candidate, signals, overrides = {}) {
  const reasons = [];
  let novelty = 0;
  // Distinguish the candidate from what the repo already contains: a question
  // whose keywords appear across many tested modules is less novel.
  const overlap = signals.topModules.filter((module) => candidate.question.toLocaleLowerCase().includes(module.toLocaleLowerCase())).length;
  novelty += Math.max(0, NOVELTY_OVERLAP_CREDIT - overlap);
  if (signals.testFiles > 0 && overlap > 0) { novelty -= NOVELTY_OVERLAP_PENALTY; reasons.push('question overlaps existing tested modules'); }
  if (signals.languages.length > 1) { novelty += 1; reasons.push('cross-language surface increases feasibility breadth'); }
  novelty += (candidate.noveltyScore ?? 0) * NOVELTY_SCORE_WEIGHT + (overrides.noveltyBias ?? 0);

  let feasibility = (candidate.feasibilityScore ?? 0) + (overrides.feasibilityBias ?? 0);
  if (isFalsifiable(candidate)) { feasibility += FALSIFIABLE_FEASIBILITY_BONUS; reasons.push('measurable + falsifiable'); }
  if (signals.testFiles === 0) { feasibility -= NO_HARNESS_FEASIBILITY_PENALTY; reasons.push('no existing test harness in repo'); }
  feasibility = Math.max(SCORE_MIN, Math.min(SCORE_MAX, feasibility));
  novelty = Math.max(SCORE_MIN, Math.min(SCORE_MAX, novelty));
  return { claimId: candidate.id, noveltyScore: novelty, feasibilityScore: feasibility, reasons };
}

/** Level-A gate: a question may proceed only when novelty + feasibility both clear 2.0. */
export function levelAGate(review) {
  if (review.noveltyScore < LEVEL_A_MIN_SCORE) return { ok: false, reason: `novelty too low (${review.noveltyScore.toFixed(1)})` };
  if (review.feasibilityScore < LEVEL_A_MIN_SCORE) return { ok: false, reason: `feasibility too low (${review.feasibilityScore.toFixed(1)})` };
  return { ok: true };
}

/**
 * A deterministic experiment spec. `replicationRuns` is clamped into [2, 10] with
 * default 3, `seed` defaults to 42, and `createdAt` prefers the caller's stamp,
 * then the injected `now` (default: the epoch sentinel, so the module stays pure).
 */
export function buildExperimentSpec(input, { now = () => EPOCH_TIMESTAMP } = {}) {
  return { id: input.id, primaryMetric: input.primaryMetric, replicationRuns: Math.max(REPLICATION_RUNS_MIN, Math.min(REPLICATION_RUNS_MAX, input.replicationRuns ?? DEFAULT_REPLICATION_RUNS)), purpose: 'EXPERIMENT', command: [], seed: input.seed ?? DEFAULT_SEED, createdAt: input.createdAt ?? now() };
}
