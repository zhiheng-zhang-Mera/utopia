/**
 * UTOPIA · City Core — adaptive expected-utility suite.
 *
 * The formula, the clamping, the optional latency/resource terms and the rounding
 * restate the Codex-Boss donor `src/shared/adaptive-routing.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_POLICY_VERSION,
  NEUTRAL_PRIOR,
  UTILITY_WEIGHTS,
  adaptiveCandidateScore,
  adaptiveRerankCandidate,
  adaptiveRerankResult,
  adaptiveRoutingDecision,
  clamp01,
  expectedUtility,
  utilityInputs,
} from '../index.mjs';

/** The donor's neutral prior, expressed as utility inputs with a perfect runtime. */
const NEUTRAL = {
  completion: NEUTRAL_PRIOR.completion,
  quality: NEUTRAL_PRIOR.quality,
  goalFidelity: NEUTRAL_PRIOR.goalFidelity,
  restrictionImpact: NEUTRAL_PRIOR.restrictionImpact,
  runtimeReliability: 1,
};

test('the policy constants are the donor constants', () => {
  assert.equal(ADAPTIVE_POLICY_VERSION, 'adaptive-policy-1.0.0');
  assert.deepEqual(NEUTRAL_PRIOR, {
    completion: 0.5,
    quality: 0.5,
    goalFidelity: 0.5,
    restrictionImpact: 0.15,
    runtimeReliability: 0.8,
  });
  assert.deepEqual(UTILITY_WEIGHTS, {
    pipelineBlockingRisk: 0.5,
    latencyCost: 0.2,
    resourceCost: 0.1,
    latencyScaleMs: 10_000,
  });
});

test('clamp01 clamps the range and treats a non-finite value as zero', () => {
  assert.equal(clamp01(0), 0);
  assert.equal(clamp01(0.25), 0.25);
  assert.equal(clamp01(1), 1);
  assert.equal(clamp01(-0.0001), 0);
  assert.equal(clamp01(-7), 0);
  assert.equal(clamp01(1.0001), 1);
  assert.equal(clamp01(42), 1);
  assert.equal(clamp01(Number.NaN), 0, 'a NaN is never a favourable value');
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 0);
  assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
});

test('expectedUtility scores the neutral prior exactly', () => {
  // 0.5*0.5*0.5 - 0.15 = -0.025, and no latency or resource term is charged
  assert.equal(expectedUtility(NEUTRAL), -0.025);
  assert.equal(expectedUtility({ ...NEUTRAL, latencyMs: 0, resourceCost: 0 }), -0.025);
  // the donor's default reliability of 0.8 does charge its blocking risk
  assert.equal(expectedUtility({ ...NEUTRAL, runtimeReliability: NEUTRAL_PRIOR.runtimeReliability }), -0.125);
});

test('expectedUtility charges the latency term only when latency is defined', () => {
  assert.equal(expectedUtility({ ...NEUTRAL, latencyMs: 1000 }), -0.045);
  assert.equal(expectedUtility({ ...NEUTRAL, latencyMs: 5000 }), -0.125);
  assert.equal(expectedUtility({ ...NEUTRAL, latencyMs: UTILITY_WEIGHTS.latencyScaleMs }), -0.225);
  assert.equal(expectedUtility({ ...NEUTRAL, latencyMs: 40_000 }), -0.225, 'the latency cost saturates at 1');
  assert.equal(expectedUtility({ ...NEUTRAL, latencyMs: -1000 }), -0.025, 'a negative latency clamps to zero cost');
  assert.equal(expectedUtility({ ...NEUTRAL, latencyMs: undefined }), -0.025);
  assert.equal(expectedUtility({ ...NEUTRAL, latencyMs: Number.NaN }), -0.025, 'a non-finite latency clamps to zero');
  assert.equal(expectedUtility(NEUTRAL), expectedUtility({ ...NEUTRAL, latencyMs: undefined }));
});

test('expectedUtility charges the resource term only when it is defined', () => {
  assert.equal(expectedUtility({ ...NEUTRAL, resourceCost: 0.5 }), -0.075);
  assert.equal(expectedUtility({ ...NEUTRAL, resourceCost: 1 }), -0.125);
  assert.equal(expectedUtility({ ...NEUTRAL, resourceCost: -1 }), -0.025);
  assert.equal(expectedUtility({ ...NEUTRAL, resourceCost: 5 }), -0.125, 'the resource cost saturates at 1');
  assert.equal(expectedUtility({ ...NEUTRAL, resourceCost: Number.NaN }), -0.025);
  assert.equal(
    expectedUtility({ ...NEUTRAL, latencyMs: 5000, resourceCost: 0.5 }),
    -0.175,
    'both optional terms stack',
  );
});

test('expectedUtility clamps every out-of-range input', () => {
  // completion, quality and goalFidelity are clamped up to 1: 1 - 0 - 0 - 0
  assert.equal(expectedUtility({ completion: 9, quality: 3, goalFidelity: 2, restrictionImpact: -4, runtimeReliability: 7 }), 1);
  // every favourable input below zero clamps to 0, and a broken runtime blocks
  assert.equal(
    expectedUtility({ completion: -1, quality: -1, goalFidelity: -1, restrictionImpact: 0, runtimeReliability: 0 }),
    -0.5,
  );
  // restriction is clamped, so an absurd restriction cannot exceed its own weight
  assert.equal(expectedUtility({ ...NEUTRAL, restrictionImpact: 50 }), 0.125 - 1);
  // a NaN input is 0, never a perfect score
  assert.equal(
    expectedUtility({ completion: Number.NaN, quality: 1, goalFidelity: 1, restrictionImpact: 0, runtimeReliability: 1 }),
    0,
  );
  // a perfect completion with a fully unreliable runtime: 1 - 0.5
  assert.equal(expectedUtility({ completion: 1, quality: 1, goalFidelity: 1, restrictionImpact: 0, runtimeReliability: 0 }), 0.5);
});

test('expectedUtility rounds to four decimals with Number(toFixed(4))', () => {
  // 1/3 * 1/3 * 1/3 = 0.037037..., rounded to 0.037
  assert.equal(
    expectedUtility({ completion: 1 / 3, quality: 1 / 3, goalFidelity: 1 / 3, restrictionImpact: 0, runtimeReliability: 1 }),
    0.037,
  );
  // 0.12345 + ... mixed rounding beyond the fourth decimal
  const value = expectedUtility({
    completion: 0.7,
    quality: 0.9,
    goalFidelity: 0.65,
    restrictionImpact: 0.04,
    runtimeReliability: 1,
    latencyMs: 333,
    resourceCost: 0.11,
  });
  assert.equal(value, Number((0.7 * 0.9 * 0.65 - 0.04 - 0 - 0.0333 * 0.2 - 0.11 * 0.1).toFixed(4)));
  assert.equal(String(value).split('.')[1]?.length <= 4, true, 'never more than four decimals');
});

test('the adaptive value shapes validate scores, decisions and rerank results', () => {
  const score = {
    runtimeId: 'runtime-a',
    eligible: true,
    expectedUtility: 0.25,
    explanation: ['hard-eligible', 'neutral prior'],
  };
  assert.deepEqual(adaptiveCandidateScore(score), score);
  assert.deepEqual(adaptiveCandidateScore({ runtimeId: 'r', eligible: false, explanation: ['hard-ineligible'] }), {
    runtimeId: 'r',
    eligible: false,
    explanation: ['hard-ineligible'],
  });
  assert.throws(() => adaptiveCandidateScore({ runtimeId: 'r', eligible: true }), TypeError, 'a score without an explanation is refused');
  assert.throws(() => adaptiveCandidateScore({ runtimeId: 'r', eligible: true, explanation: 'because' }), TypeError);
  assert.throws(() => adaptiveCandidateScore({ runtimeId: 'r', eligible: true, explanation: [], expectedUtility: 'high' }), TypeError);

  const decision = adaptiveRoutingDecision({
    decisionId: 'decision-1',
    taskId: 'task-1',
    policyVersion: ADAPTIVE_POLICY_VERSION,
    candidates: [score],
    selectedRuntimeId: 'runtime-a',
    usedFallbackRouter: false,
    exploration: { enabled: false },
  });
  assert.equal(decision.policyVersion, ADAPTIVE_POLICY_VERSION);
  assert.equal(decision.usedFallbackRouter, false);
  assert.deepEqual(decision.exploration, { enabled: false });
  assert.throws(
    () =>
      adaptiveRoutingDecision({
        decisionId: 'd',
        taskId: 't',
        policyVersion: ADAPTIVE_POLICY_VERSION,
        candidates: [],
        usedFallbackRouter: false,
        selectedRuntimeId: 7,
      }),
    TypeError,
  );
  // no selected runtime is a legitimate decision: everything scored, nothing chosen
  const undecided = adaptiveRoutingDecision({
    decisionId: 'd',
    taskId: 't',
    policyVersion: ADAPTIVE_POLICY_VERSION,
    candidates: [],
    usedFallbackRouter: true,
  });
  assert.equal(undecided.selectedRuntimeId, undefined);
  assert.equal(undecided.usedFallbackRouter, true);

  const ordered = [{ runtimeId: 'runtime-a', rank: 0, reason: 'highest expected utility' }];
  assert.deepEqual(adaptiveRerankCandidate(ordered[0]), ordered[0]);
  assert.deepEqual(adaptiveRerankResult({ ordered, decision }), { ordered, decision });
  assert.throws(() => adaptiveRerankResult({ ordered: [{ runtimeId: 'r', reason: 'x' }], decision }), TypeError);

  assert.deepEqual(utilityInputs(NEUTRAL), NEUTRAL);
  assert.deepEqual(utilityInputs({ ...NEUTRAL, latencyMs: 0 }), { ...NEUTRAL, latencyMs: 0 });
  assert.throws(() => utilityInputs({ ...NEUTRAL, completion: '0.5' }), TypeError);
  assert.throws(() => utilityInputs({ quality: 0.5 }), TypeError);
});
