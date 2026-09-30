/**
 * UTOPIA · Worker Gateway — provider outcome suite.
 *
 * Restates the Codex-Boss donor `src/shared/provider-outcome.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, including the acceptance cases the
 * donor proves in `tests/unit/engine-phase-1.test.ts` (A02–A08). The donor's
 * `OutcomeEvaluator` service (which gates evaluation behind adaptive flags and
 * lives in `electron/learning/outcome-evaluator`) is NOT ported, so its two cases
 * are replaced by the pure `createEvaluationRevision` case below, which is the
 * same rule without the flag service around it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NON_SEMANTIC_RUNTIME_CODES,
  OUTCOME_AXES,
  OUTCOME_EVALUATOR_VERSION,
  RUNTIME_STATUSES,
  SEMANTIC_OUTCOMES,
  createEvaluationRevision,
  deriveSemanticEvaluation,
  detectGoalDrift,
  isNonSemanticRuntimeCode,
  isSemanticOutcome,
  semanticEvaluation,
} from '../provider-outcome.mjs';

/** The donor test's `ok()` helper: a successful call carrying signals. */
function ok(signals = {}, content = 'a usable answer') {
  return { runtimeStatus: 'SUCCESS', content, signals };
}

test('covers all 11 semantic outcomes with a continuous axis mapping', () => {
  assert.equal(SEMANTIC_OUTCOMES.length, 11);
  assert.equal(new Set(SEMANTIC_OUTCOMES).size, 11, 'no duplicates');
  for (const outcome of SEMANTIC_OUTCOMES) {
    const axes = OUTCOME_AXES[outcome];
    assert.ok(axes, `${outcome} has an axis mapping`);
    for (const key of ['completion', 'goalFidelity', 'restrictionImpact', 'sanitizationImpact', 'pipelineBlocking']) {
      assert.ok(axes[key] >= 0, `${outcome}.${key} is at least 0`);
      assert.ok(axes[key] <= 1, `${outcome}.${key} is at most 1`);
    }
  }
  // the donor Engine book §6 examples hold
  assert.equal(OUTCOME_AXES.FULL_COMPLETION.completion, 1);
  assert.equal(OUTCOME_AXES.HARD_REFUSAL.restrictionImpact, 1);
  assert.ok(OUTCOME_AXES.PARTIAL_REFUSAL.restrictionImpact > OUTCOME_AXES.SOFT_RESTRICTION.restrictionImpact);
  assert.ok(OUTCOME_AXES.HEAVY_SANITIZATION.sanitizationImpact > OUTCOME_AXES.HEAVY_SANITIZATION.restrictionImpact);
  // UNCLASSIFIED is the neutral row: no penalty anywhere
  for (const key of ['completion', 'goalFidelity', 'restrictionImpact', 'sanitizationImpact', 'pipelineBlocking']) {
    assert.equal(OUTCOME_AXES.UNCLASSIFIED[key], 0, `UNCLASSIFIED.${key} is neutral`);
  }
  assert.equal(OUTCOME_EVALUATOR_VERSION, 'semantic-evaluator-1.0.0');
  assert.equal(isSemanticOutcome('HARD_REFUSAL'), true);
  assert.equal(isSemanticOutcome('REFUSAL'), false);
  assert.equal(isSemanticOutcome(undefined), false);
});

test('A02: runtime SUCCESS + normal completion ⇒ FULL_COMPLETION', () => {
  const evaluation = deriveSemanticEvaluation(ok({ deliverablesCovered: 1 }));
  assert.equal(evaluation.outcome, 'FULL_COMPLETION');
  assert.equal(evaluation.axes.completion, 1);
  assert.equal(evaluation.runtimeAttributable, false);
  assert.equal(evaluation.penalizesSemanticProfile, true);
  assert.equal(evaluation.confidence, 0.7);
  assert.deepEqual(evaluation.reasons, ['no refusal/restriction/format/verification/drift signal observed']);
});

test('A03: runtime SUCCESS + explicit refusal ⇒ HARD_REFUSAL without being a runtime failure', () => {
  const evaluation = deriveSemanticEvaluation(ok({ refusal: true }, "I can't help with that."));
  assert.equal(evaluation.outcome, 'HARD_REFUSAL');
  assert.equal(evaluation.runtimeAttributable, false, 'a refusal is not a runtime crash');
  assert.equal(evaluation.axes.restrictionImpact, 1);
  assert.equal(evaluation.axes.completion, 0);
});

test('A04: partial completion and partial refusal are distinguishable', () => {
  const partialCompletion = deriveSemanticEvaluation(ok({ deliverablesCovered: 0.5 }));
  const partialRefusal = deriveSemanticEvaluation(ok({ partialRefusal: true }));
  assert.equal(partialCompletion.outcome, 'PARTIAL_COMPLETION');
  assert.equal(partialRefusal.outcome, 'PARTIAL_REFUSAL');
  assert.ok(partialRefusal.axes.restrictionImpact > partialCompletion.axes.restrictionImpact);
});

test('A05: runtime TIMEOUT ⇒ UNCLASSIFIED with no restriction penalty', () => {
  const evaluation = deriveSemanticEvaluation({ runtimeStatus: 'RETRYABLE_FAILURE', runtimeFailureCode: 'TIMEOUT' });
  assert.equal(evaluation.outcome, 'UNCLASSIFIED');
  assert.equal(evaluation.axes.restrictionImpact, 0);
  assert.equal(evaluation.axes.goalFidelity, 0);
  assert.equal(evaluation.confidence, 0);
  assert.equal(evaluation.runtimeAttributable, true);
  assert.equal(evaluation.penalizesSemanticProfile, false);
  assert.ok(evaluation.reasons.join(' ').includes('no semantic conclusion'));
  assert.ok(
    evaluation.reasons.includes('runtime-layer fault excluded from semantic evidence'),
    'a listed runtime code is named as a runtime-layer fault',
  );
});

test('A06: AUTH_REQUIRED ⇒ no capability/restriction penalty', () => {
  const evaluation = deriveSemanticEvaluation({ runtimeStatus: 'RETRYABLE_FAILURE', runtimeFailureCode: 'AUTH_REQUIRED' });
  assert.equal(evaluation.outcome, 'UNCLASSIFIED');
  assert.equal(evaluation.axes.restrictionImpact, 0);
  assert.equal(evaluation.penalizesSemanticProfile, false);
});

test('A07: PAGE_CHANGED ⇒ no semantic negative evidence', () => {
  const evaluation = deriveSemanticEvaluation({ runtimeStatus: 'PERMANENT_FAILURE', runtimeFailureCode: 'PAGE_CHANGED' });
  assert.equal(evaluation.outcome, 'UNCLASSIFIED');
  assert.equal(evaluation.penalizesSemanticProfile, false);
  assert.equal(evaluation.axes.completion, 0);
  assert.equal(evaluation.axes.restrictionImpact, 0);
});

test('A08: goal drift is recorded when the worker silently changes scope', () => {
  const drift = detectGoalDrift({ deliverables: ['migration report', 'rollback plan'] }, 'Instead of the requested migration report I produced a short summary.');
  assert.equal(drift.drifted, true);
  assert.ok(
    drift.evidence.some((entry) => entry.startsWith('scope-change marker:')),
    'the marker is reported with its source pattern',
  );
  const evaluation = deriveSemanticEvaluation(ok({ driftEvidence: drift.evidence }));
  assert.equal(evaluation.outcome, 'GOAL_DRIFT');
  assert.ok(evaluation.axes.goalFidelity < 0.5);
  assert.deepEqual(evaluation.reasons.slice(0, 1), ['goal drift evidence recorded']);
  assert.ok(evaluation.reasons.length > 1, 'the drift evidence itself is carried in the reasons');
});

test('format failure is distinguished from provider restriction', () => {
  const format = deriveSemanticEvaluation(ok({ formatOk: false }));
  const restriction = deriveSemanticEvaluation(ok({ refusal: true }));
  assert.equal(format.outcome, 'FORMAT_FAILURE');
  assert.equal(format.axes.restrictionImpact, 0, 'our contract issue, not the model’s');
  assert.ok(restriction.axes.restrictionImpact > 0);
});

test('deterministic verification failure outranks provider behaviour signals', () => {
  const evaluation = deriveSemanticEvaluation(ok({ verificationPassed: false, softRestriction: true }));
  assert.equal(evaluation.outcome, 'VERIFICATION_FAILURE');
  assert.equal(evaluation.axes.verificationScore, 0);
  assert.equal(evaluation.axes.restrictionImpact, 0);
  assert.equal(evaluation.confidence, 0.9);
});

test('an unobservable success is UNCLASSIFIED rather than a fabricated completion', () => {
  const evaluation = deriveSemanticEvaluation({ runtimeStatus: 'SUCCESS', content: '   ' });
  assert.equal(evaluation.outcome, 'UNCLASSIFIED');
  assert.equal(evaluation.penalizesSemanticProfile, false);
  assert.deepEqual(evaluation.reasons, ['call succeeded but produced no content to evaluate']);
});

test('classifies runtime codes as non-semantic', () => {
  for (const code of ['TIMEOUT', 'AUTH_REQUIRED', 'PAGE_CHANGED', 'RATE_LIMITED']) {
    assert.equal(isNonSemanticRuntimeCode(code), true, `${code} is a runtime-layer code`);
  }
  assert.equal(isNonSemanticRuntimeCode('SOME_MODEL_REFUSAL'), false);
  assert.equal(isNonSemanticRuntimeCode(undefined), false);
  assert.equal(isNonSemanticRuntimeCode(''), false);
  assert.deepEqual([...NON_SEMANTIC_RUNTIME_CODES], [
    'TIMEOUT',
    'AUTH_REQUIRED',
    'PAGE_CHANGED',
    'RATE_LIMITED',
    'BUDGET_EXHAUSTED',
    'USER_ACTION_REQUIRED',
    'UNSUPPORTED',
    'DOWN',
    'BUSY',
    'UNKNOWN',
  ]);
  assert.deepEqual([...RUNTIME_STATUSES], ['SUCCESS', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'CANCELLED']);
});

test('a SUCCESS that also carries a non-semantic code is still not model behaviour', () => {
  const evaluation = deriveSemanticEvaluation({ runtimeStatus: 'SUCCESS', runtimeFailureCode: 'PAGE_CHANGED', content: 'stale page text' });
  assert.equal(evaluation.outcome, 'UNCLASSIFIED');
  assert.equal(evaluation.runtimeAttributable, true);
  assert.equal(evaluation.penalizesSemanticProfile, false);
  assert.deepEqual(evaluation.reasons, ['runtime reported PAGE_CHANGED; not model behaviour']);
});

test('a runtime failure with no listed code is still excluded, and says so', () => {
  const evaluation = deriveSemanticEvaluation({ runtimeStatus: 'CANCELLED' });
  assert.equal(evaluation.outcome, 'UNCLASSIFIED');
  assert.equal(evaluation.runtimeAttributable, true);
  assert.deepEqual(evaluation.reasons, [
    'runtime did not succeed (CANCELLED); no semantic conclusion',
    'runtime failure excluded from semantic evidence',
  ]);
});

test('selection precedence between the non-failure signals is the donor’s', () => {
  assert.equal(deriveSemanticEvaluation(ok({ partialRefusal: true, softRestriction: true })).outcome, 'PARTIAL_REFUSAL');
  assert.equal(deriveSemanticEvaluation(ok({ heavySanitization: true, softRestriction: true })).outcome, 'HEAVY_SANITIZATION');
  assert.equal(deriveSemanticEvaluation(ok({ softRestriction: true, badQuality: true })).outcome, 'SOFT_RESTRICTION');
  assert.equal(deriveSemanticEvaluation(ok({ driftEvidence: ['dropped a deliverable'], badQuality: true })).outcome, 'GOAL_DRIFT');
  assert.equal(deriveSemanticEvaluation(ok({ deliverablesCovered: 0.5, quality: 0.1 })).outcome, 'BAD_QUALITY');
  assert.equal(deriveSemanticEvaluation(ok({ deliverablesCovered: 0.5, badQuality: true })).reasons[0], 'deliverables covered 0.5');
  assert.equal(deriveSemanticEvaluation(ok({ quality: 0.1 })).outcome, 'BAD_QUALITY');
  assert.equal(deriveSemanticEvaluation(ok({ quality: 0.34 })).outcome, 'BAD_QUALITY');
  assert.equal(deriveSemanticEvaluation(ok({ quality: 0.35 })).outcome, 'FULL_COMPLETION', 'exactly 0.35 is not below the threshold');
  assert.equal(deriveSemanticEvaluation(ok({ deliverablesCovered: 0.99 })).outcome, 'PARTIAL_COMPLETION');
});

test('an injected evaluator version is stamped on every classification', () => {
  const stamped = deriveSemanticEvaluation(ok(), 'semantic-evaluator-2.0.0');
  assert.equal(stamped.evaluatorVersion, 'semantic-evaluator-2.0.0');
  const faulted = deriveSemanticEvaluation({ runtimeStatus: 'RETRYABLE_FAILURE', runtimeFailureCode: 'TIMEOUT' }, 'semantic-evaluator-2.0.0');
  assert.equal(faulted.evaluatorVersion, 'semantic-evaluator-2.0.0');
});

test('detectGoalDrift reports scope-change markers and unaddressed deliverables', () => {
  assert.deepEqual(detectGoalDrift({}, 'a summary of the work'), { drifted: false, evidence: [] });
  assert.deepEqual(detectGoalDrift({ deliverables: [] }, ''), { drifted: false, evidence: [] });

  const scope = detectGoalDrift({}, 'I replaced the requirement with a shorter one.');
  assert.equal(scope.drifted, true);
  assert.deepEqual(scope.evidence, ['scope-change marker: i (?:changed|altered|replaced) the (?:goal|objective|requirement|scope)']);

  const chinese = detectGoalDrift({}, '我把任务改成了另一件事。');
  assert.equal(chinese.drifted, true);
  assert.ok(chinese.evidence[0].startsWith('scope-change marker:'));

  const dropped = detectGoalDrift({ deliverables: ['rollback plan'] }, 'here is the migration summary');
  assert.deepEqual(dropped.evidence, ['deliverable not addressed: rollback plan']);

  const covered = detectGoalDrift({ deliverables: ['migration report'] }, 'the migration report is attached');
  assert.deepEqual(covered, { drifted: false, evidence: [] });
  assert.equal(detectGoalDrift({ deliverables: ['migration'] }, 'nothing here').drifted, true, 'the whole token must be absent to count as dropped');
  assert.deepEqual(detectGoalDrift({ deliverables: ['migration'] }, 'the migration is attached'), { drifted: false, evidence: [] });

  // Only the first three long tokens are consulted, and any one of them counts
  // as addressed — the donor's rule, not a full-text similarity check.
  const partial = detectGoalDrift({ deliverables: ['migration report'] }, 'here is the migration summary');
  assert.deepEqual(partial, { drifted: false, evidence: [] });

  // Tokens shorter than four characters are ignored entirely, so a deliverable
  // made only of short words can never be reported as dropped.
  assert.deepEqual(detectGoalDrift({ deliverables: ['a b c'] }, 'nothing here'), { drifted: false, evidence: [] });
  assert.deepEqual(detectGoalDrift({ deliverables: ['ok'] }, ''), { drifted: false, evidence: [] });
  assert.deepEqual(detectGoalDrift({ deliverables: ['a report'] }, 'here is the report'), { drifted: false, evidence: [] });

  const marker = detectGoalDrift({ deliverables: ['rollback plan'] }, 'Instead of the requested rollback plan I wrote a short note.');
  assert.deepEqual(marker.evidence, [
    'scope-change marker: instead of (?:the )?(?:requested|original)',
  ], 'a deliverable that IS addressed adds no evidence, so only the marker is reported');

  const both = detectGoalDrift({ deliverables: ['rollback plan'] }, 'Instead of the requested summary I wrote a short note.');
  assert.deepEqual(both.evidence, [
    'scope-change marker: instead of (?:the )?(?:requested|original)',
    'deliverable not addressed: rollback plan',
  ], 'an unaddressed deliverable is reported alongside the marker');
});

test('createEvaluationRevision appends a revision without overwriting the original', () => {
  const original = deriveSemanticEvaluation(ok({ deliverablesCovered: 0.5 }));
  assert.equal(original.outcome, 'PARTIAL_COMPLETION');
  const revised = deriveSemanticEvaluation(ok({ deliverablesCovered: 1 }));
  assert.equal(revised.outcome, 'FULL_COMPLETION');

  const revision = createEvaluationRevision({
    episodeId: 'ep-1',
    original,
    revised,
    reason: 'higher-version evaluator sees the missing deliverable as covered',
    revisedAt: '2026-09-10T00:00:00.000Z',
  });
  assert.equal(revision.schemaVersion, 1);
  assert.equal(revision.episodeId, 'ep-1');
  assert.equal(revision.originalOutcome, 'PARTIAL_COMPLETION', 'the original outcome is carried, not replaced');
  assert.equal(revision.originalEvaluatorVersion, original.evaluatorVersion);
  assert.equal(revision.revised.outcome, 'FULL_COMPLETION');
  assert.equal(revision.reason, 'higher-version evaluator sees the missing deliverable as covered');
  assert.equal(revision.revisedAt, '2026-09-10T00:00:00.000Z');
  assert.equal(original.outcome, 'PARTIAL_COMPLETION', 'the original evaluation object is untouched');
});

test('semanticEvaluation validates and copies an evaluation', () => {
  const original = deriveSemanticEvaluation(ok({ deliverablesCovered: 0.5 }));
  const copy = semanticEvaluation(original);
  assert.deepEqual(copy, original, 'a well-formed evaluation round-trips');
  assert.notEqual(copy, original);
  assert.notEqual(copy.axes, original.axes, 'axes are copied, not shared');
  assert.notEqual(copy.reasons, original.reasons, 'reasons are copied, not shared');

  assert.throws(() => semanticEvaluation({ ...original, outcome: 'MOSTLY_FINE' }), TypeError);
  assert.throws(() => semanticEvaluation({ ...original, confidence: 1.5 }), RangeError);
  assert.throws(() => semanticEvaluation({ ...original, axes: { ...original.axes, completion: -0.1 } }), RangeError);
  assert.throws(() => semanticEvaluation({ ...original, axes: { ...original.axes, completion: '1' } }), TypeError);
  assert.throws(() => semanticEvaluation({ ...original, axes: { completion: 1 } }), TypeError, 'a missing axis is refused');
  assert.throws(() => semanticEvaluation({ ...original, axes: { ...original.axes, mystique: 1 } }), TypeError, 'an unknown axis is refused');
});
