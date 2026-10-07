// PCF-723 acceptance: the safety shield, shadow decisions, held-out evaluation and the fallback.
//
// The negative constraint is the whole point: a learner may only REORDER an already-eligible set. Every way of escaping
// that - adding a candidate, dropping one, renaming one, touching a protected field, scoring badly, drifting, costing
// money, timing out - is checked from the refusing side.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIELD_REFUSALS, PROTECTED_FIELDS, CONFIDENCE_FLOOR, MAX_COST_MINOR,
  applySafetyShield, assertNoProtectedFieldChange, assertScorerHealthy,
  shadowDecision, evaluateHeldOut, advancePolicyStage, rollbackPolicy, POLICY_STAGES,
} from '../services/personal-compute-fabric/shadow-placement.mjs';

const eligible = [
  {candidateRef: 'A', deterministicRank: 1, trusted: true, dataScope: 'PUBLIC'},
  {candidateRef: 'B', deterministicRank: 2, trusted: true, dataScope: 'PUBLIC'},
  {candidateRef: 'C', deterministicRank: 3, trusted: true, dataScope: 'PUBLIC'},
];

test('PCF723-01 a learner may REORDER the eligible set, and the fallback order exists before it is consulted', () => {
  const shielded = applySafetyShield({eligible, scorer: () => ['C', 'A', 'B']});
  assert.equal(shielded.applied, true);
  assert.deepEqual(shielded.order, ['C', 'A', 'B']);
  assert.deepEqual(shielded.fallback, ['A', 'B', 'C'], 'the deterministic order is computed independently of the learner');
  assert.equal(shielded.dispatched, false, 'the shield ranks; it never dispatches');
  // With no scorer at all the deterministic order is returned, not an error.
  const bare = applySafetyShield({eligible});
  assert.equal(bare.applied, false);
  assert.equal(bare.reason, 'NO_SCORER');
  assert.deepEqual(bare.order, ['A', 'B', 'C']);
});

test('PCF723-02 the shield refuses to ADD a candidate, DROP one, or rename one', () => {
  // Adding: a learner cannot introduce a candidate that was not eligible.
  const added = applySafetyShield({eligible, scorer: () => ['A', 'B', 'C', 'D']});
  assert.equal(added.applied, false);
  assert.equal(added.reason, SHIELD_REFUSALS.NOT_A_PERMUTATION);
  assert.deepEqual(added.order, ['A', 'B', 'C'], 'the deterministic order stands when the proposal is refused');
  // Renaming: a different reference is an addition AND a removal.
  const renamed = applySafetyShield({eligible, scorer: () => ['A', 'B', 'X']});
  assert.equal(renamed.reason, SHIELD_REFUSALS.ELIGIBLE_SET_CHANGED);
  assert.match(renamed.detail, /missing \["C"\] added \["X"\]/);
  // Dropping while keeping the length correct (duplicating another) is caught too.
  const dropped = applySafetyShield({eligible, scorer: () => ['A', 'A', 'B']});
  assert.equal(dropped.applied, false);
  // An empty proposal for a non-empty eligible set is refused.
  assert.equal(applySafetyShield({eligible, scorer: () => []}).applied, false);
  assert.throws(() => applySafetyShield({eligible: [{candidateRef: 'A', deterministicRank: 1}, {candidateRef: 'A', deterministicRank: 2}]}), /SHIELD_DUPLICATE_CANDIDATE/);
});

test('PCF723-03 a learner can never touch trust, consent, strict target, review gate or cost authorization', () => {
  for (const field of ['trusted', 'consent', 'strictTarget', 'reviewRequired', 'costAuthorization']) {
    assert.ok(PROTECTED_FIELDS.includes(field), `${field} must be protected`);
    assert.throws(() => assertNoProtectedFieldChange({[field]: true}), new RegExp(SHIELD_REFUSALS.PROTECTED_FIELD), `${field} must be refused`);
  }
  // Refused even when the value is UNCHANGED: the attempt itself is the problem, and ignoring it would hide a bug.
  assert.throws(() => assertNoProtectedFieldChange({trusted: true}), /SHIELD_PROTECTED_FIELD:trusted/);
  // An ordinary ordering hint is fine.
  assert.equal(assertNoProtectedFieldChange({score: 0.9, note: 'prefer less queueing'}), true);
});

test('PCF723-04 a scorer that throws, times out or is unavailable falls back to the proven order and blocks nothing', () => {
  const throwing = applySafetyShield({eligible, scorer: () => { throw new Error('model exploded'); }});
  assert.equal(throwing.applied, false);
  assert.equal(throwing.reason, 'SCORER_FAILED');
  assert.match(throwing.detail, /model exploded/);
  assert.deepEqual(throwing.order, ['A', 'B', 'C'], 'a broken learner does not freeze the caller');
  const timedOut = applySafetyShield({eligible, scorer: () => { throw Object.assign(new Error('too slow'), {code: SHIELD_REFUSALS.TIMEOUT}); }});
  assert.equal(timedOut.reason, SHIELD_REFUSALS.TIMEOUT);
  // A malformed proposal must ALSO fall back rather than escaping as a throw: a bad learner cannot block the caller.
  const malformed = applySafetyShield({eligible, scorer: () => 'not-an-array'});
  assert.equal(malformed.applied, false);
  assert.equal(malformed.reason, 'PROPOSAL_MALFORMED');
  assert.deepEqual(malformed.order, ['A', 'B', 'C']);
  const badRefs = applySafetyShield({eligible, scorer: () => [1, 2, 3]});
  assert.equal(badRefs.reason, 'PROPOSAL_MALFORMED');
  assert.deepEqual(badRefs.order, ['A', 'B', 'C']);
});

test('PCF723-05 low confidence, drift, an out-of-range input, a timeout budget and any cost each refuse with their own code', () => {
  assert.equal(assertScorerHealthy({confidence: 0.9, latencyMs: 10, costMinor: 0}), true);
  assert.equal(CONFIDENCE_FLOOR, 0.6);
  assert.throws(() => assertScorerHealthy({confidence: 0.2}), /SHIELD_LOW_CONFIDENCE/);
  assert.throws(() => assertScorerHealthy({confidence: 1.5}), /SHIELD_INPUT_OUT_OF_RANGE:confidence/);
  assert.throws(() => assertScorerHealthy({confidence: 0.9, latencyMs: 999999}), /SHIELD_INPUT_OUT_OF_RANGE:latencyMs/);
  assert.throws(() => assertScorerHealthy({confidence: 0.9, drifted: true}), /SHIELD_DRIFT/);
  // This project authorizes NO spend, so any cost at all is a refusal rather than a threshold.
  assert.equal(MAX_COST_MINOR, 0);
  assert.throws(() => assertScorerHealthy({confidence: 0.9, costMinor: 1}), /SHIELD_COST_EXCEEDED/);
});

test('PCF723-06 a shadow decision reports the DIFFERENCE and dispatches nothing', () => {
  const shadow = shadowDecision({eligible, scorer: () => ['C', 'A', 'B'], candidateSha: 'a'.repeat(40), policyVersion: 3, modelVersion: 7});
  assert.equal(shadow.shadow, true);
  assert.equal(shadow.dispatched, false, 'a shadow is not an action');
  assert.equal(shadow.changed, true);
  assert.deepEqual(shadow.incumbentOrder, ['A', 'B', 'C']);
  assert.deepEqual(shadow.shadowedOrder, ['C', 'A', 'B']);
  assert.equal(shadow.differences.length, 3, 'every position where the two orders disagree is reported');
  assert.deepEqual(shadow.differences[0], {position: 0, incumbent: 'A', shadowed: 'C'});
  assert.match(shadow.reasonForChange, /reordered 3 position/);
  // A shadow that agrees with the incumbent says so, rather than reporting an empty difference silently.
  const same = shadowDecision({eligible, scorer: () => ['A', 'B', 'C'], candidateSha: 'a'.repeat(40), policyVersion: 3, modelVersion: 7});
  assert.equal(same.changed, false);
  assert.equal(same.reasonForChange, 'no reordering');
  // Versions are mandatory: an unexplainable change is not acceptable.
  assert.throws(() => shadowDecision({eligible, scorer: () => ['A', 'B', 'C'], candidateSha: 'a'.repeat(40)}), /SHADOW_VERSIONS_REQUIRED/);
});

test('PCF723-07 evaluation REFUSES to test on what it trained on', () => {
  const training = [{workloadRef: 'W-1'}, {workloadRef: 'W-2'}];
  const heldOut = [{workloadRef: 'W-3'}, {workloadRef: 'W-4'}];
  const evaluation = evaluateHeldOut({trainingTrace: training, heldOutWorkloads: heldOut, score: () => 0.5});
  assert.equal(evaluation.size, 2);
  assert.equal(evaluation.mean, 0.5);
  assert.equal(evaluation.evidenceClass, 'HELD_OUT_EVALUATION');
  assert.equal(evaluation.analysis, 'DESCRIPTIVE_ONLY');
  // The overlap case is a refusal, and it names the offending workload.
  assert.throws(() => evaluateHeldOut({trainingTrace: training, heldOutWorkloads: [{workloadRef: 'W-2'}], score: () => 0.9}), /TRAIN_TEST_OVERLAP:W-2/);
  assert.throws(() => evaluateHeldOut({trainingTrace: training, heldOutWorkloads: ['W-1'], score: () => 0.9}), /TRAIN_TEST_OVERLAP:W-1/);
  assert.throws(() => evaluateHeldOut({trainingTrace: training, heldOutWorkloads: heldOut, score: () => NaN}), /EVALUATION_SCORE_INVALID/);
});

test('PCF723-08 the admission ladder cannot be skipped, a canary needs Owner approval, and rollback needs none', () => {
  assert.deepEqual(POLICY_STAGES, ['OFFLINE_EVALUATED', 'SHADOW_OBSERVED', 'CANARY_APPROVED', 'ENABLED_REVERSIBLE']);
  const shadowed = advancePolicyStage('OFFLINE_EVALUATED', 'SHADOW_OBSERVED');
  assert.equal(shadowed.stage, 'SHADOW_OBSERVED');
  assert.equal(shadowed.reversible, true);
  // Skipping straight to enabled is refused.
  assert.throws(() => advancePolicyStage('OFFLINE_EVALUATED', 'ENABLED_REVERSIBLE'), /POLICY_STAGE_SKIPPED/);
  // A canary without a named Owner approval is refused, and so is an unbounded share.
  assert.throws(() => advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED'), /CANARY_OWNER_APPROVAL_REQUIRED/);
  assert.throws(() => advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED', {ownerApprovalRef: 'owner:1', canaryShare: 0.9}), /CANARY_SHARE_INVALID/);
  const canary = advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED', {ownerApprovalRef: 'owner:1', canaryShare: 0.1});
  assert.equal(canary.canaryShare, 0.1);
  assert.equal(canary.rollbackTo, 'SHADOW_OBSERVED');
  // Rolling back is always available and restores the proven order without asking anyone.
  const rolled = rollbackPolicy();
  assert.equal(rolled.enabled, false);
  assert.equal(rolled.revertedTo, 'DETERMINISTIC_FALLBACK');
});
