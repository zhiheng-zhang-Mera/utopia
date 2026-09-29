/**
 * UTOPIA · City Core — adaptive routing expected-utility scorer.
 *
 * Ported from the Codex-Boss donor `src/shared/adaptive-routing.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The stable, deterministic layer keeps ALL hard eligibility (required capability,
 * availability, explicit pin/exclude, budget). The adaptive scorer may only SOFT-RANK
 * candidates the hard layer already approved — it never admits a candidate the hard
 * layer excluded.
 *
 * ExpectedUtility =
 *   P(fullCompletion | task, model) * ExpectedVerifiedQuality * GoalFidelity
 *   − RestrictionImpact − PipelineBlockingRisk − LatencyCost − ResourceCost
 *
 * Nothing here mentions a provider brand: the scorer learns a conditional completion
 * probability, never "provider X is bad/good". These are the scoring rules only; no
 * learned profile store, no rerank seam and no scheduler loop is carried over.
 */

import { UTILITY_WEIGHTS } from './contracts.mjs';


/**
 * Clamp to 0..1, treating anything non-finite as 0.
 *
 * A non-finite input is never treated as a favourable value, so a NaN cannot become a
 * perfect score by accident.
 *
 * @param {number} value
 * @returns {number}
 */
export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Pure expected-utility computation.
 *
 * Every substantive input is clamped to 0..1 before use, so an out-of-range prediction
 * can neither inflate nor deflate the score beyond the honest scale.
 *
 *   blockingRisk = 1 - clamp01(runtimeReliability)
 *   latencyCost  = latencyMs undefined ? 0 : clamp01(latencyMs / latencyScaleMs)
 *   resourceCost = resourceCost undefined ? 0 : clamp01(resourceCost)
 *   utility      = completion*quality*goalFidelity - restriction
 *                  - blockingRisk*pipelineBlockingRisk
 *                  - latencyCost*latencyCostWeight
 *                  - resourceCost*resourceCostWeight
 *
 * The result is rounded with `Number(x.toFixed(4))`.
 *
 * @param {{completion: number, quality: number, goalFidelity: number, restrictionImpact: number,
 *          runtimeReliability: number, latencyMs?: number, resourceCost?: number}} input
 * @returns {number}
 */
export function expectedUtility(input) {
  const completion = clamp01(input.completion);
  const quality = clamp01(input.quality);
  const goalFidelity = clamp01(input.goalFidelity);
  const restriction = clamp01(input.restrictionImpact);
  const blockingRisk = clamp01(1 - clamp01(input.runtimeReliability));
  const latencyCost =
    input.latencyMs === undefined ? 0 : clamp01(input.latencyMs / UTILITY_WEIGHTS.latencyScaleMs);
  const resourceCost = input.resourceCost === undefined ? 0 : clamp01(input.resourceCost);
  const utility =
    completion * quality * goalFidelity -
    restriction -
    blockingRisk * UTILITY_WEIGHTS.pipelineBlockingRisk -
    latencyCost * UTILITY_WEIGHTS.latencyCost -
    resourceCost * UTILITY_WEIGHTS.resourceCost;
  return Number(utility.toFixed(4));
}
