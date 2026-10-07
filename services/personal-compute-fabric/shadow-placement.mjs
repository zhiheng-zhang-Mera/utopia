// PCF-723: the safety shield, shadow decisions, held-out evaluation and the fallback to a proven strategy.
//
// The workbook's central constraint is negative, and it is the reason this module exists rather than a learned ranker
// alone: A LEARNER MAY ONLY REORDER A SET THAT WAS ALREADY DECIDED TO BE ELIGIBLE. It may not add a candidate, may not
// remove one, and may not touch trust, consent, strict-target, review gates or cost authorization. So the shield takes
// the eligible set as an INPUT and can only permute it - if a scorer's output cannot be reconciled with that set, the
// shield refuses and the deterministic order stands.
//
// Two more properties are structural:
//   * a SHADOW decision compares the learner against the incumbent WITHOUT dispatching anything. It returns what would
//     have happened, and carries `dispatched: false` so a caller cannot mistake it for a decision that took effect.
//   * held-out evaluation refuses to score a workload that appears in the training trace. Training and testing on the
//     same trace is the classic way an evaluation flatters itself, so it is a refusal rather than a warning.
import {requireThat as ok, text, finite, freeze} from './validation.mjs';

export const SHIELD_REFUSALS = Object.freeze({
  NOT_A_PERMUTATION: 'SHIELD_NOT_A_PERMUTATION',
  ELIGIBLE_SET_CHANGED: 'SHIELD_ELIGIBLE_SET_CHANGED',
  PROTECTED_FIELD: 'SHIELD_PROTECTED_FIELD',
  LOW_CONFIDENCE: 'SHIELD_LOW_CONFIDENCE',
  INPUT_OUT_OF_RANGE: 'SHIELD_INPUT_OUT_OF_RANGE',
  TIMEOUT: 'SHIELD_TIMEOUT',
  COST_EXCEEDED: 'SHIELD_COST_EXCEEDED',
  DRIFT: 'SHIELD_DRIFT',
});

/** Fields a learner may NEVER influence. Listed so a change to this list is a visible decision, not an oversight. */
export const PROTECTED_FIELDS = Object.freeze(['trusted', 'trust', 'consent', 'consentRef', 'strictTarget', 'strict_target', 'targetDeviceRef', 'reviewGate', 'reviewRequired', 'costAuthorization', 'feeMinor', 'budget']);
export const CONFIDENCE_FLOOR = 0.6;
export const MAX_COST_MINOR = 0;
export const INPUT_RANGE = Object.freeze({maxProbability: 1, minProbability: 0, maxLatencyMs: 60000});

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const ref = value => text(value) && value.length <= 256;

/** A candidate as the shield sees it: identity, the decision inputs, and the incumbent's own deterministic rank. */
const normaliseCandidate = candidate => {
  ok(isPlainObject(candidate) && ref(candidate.candidateRef) && finite(candidate.deterministicRank), 'SHIELD_CANDIDATE_REQUIRED');
  return freeze({...candidate, candidateRef: candidate.candidateRef, deterministicRank: candidate.deterministicRank});
};

/**
 * Rank the ELIGIBLE set. `scorer` may only influence the ORDER of the candidates it is given: the returned set is
 * compared against the input as a set, and any difference (an added candidate, a dropped one, an unknown reference) is
 * refused rather than quietly applied.
 */
export function applySafetyShield({eligible = [], scorer, context = {}} = {}) {
  ok(Array.isArray(eligible), 'SHIELD_ELIGIBLE_REQUIRED');
  const candidates = eligible.map(normaliseCandidate);
  const eligibleRefs = candidates.map(c => c.candidateRef);
  ok(new Set(eligibleRefs).size === eligibleRefs.length, 'SHIELD_DUPLICATE_CANDIDATE');
  // Deterministic order is the FALLBACK and it exists before any learner is consulted.
  const deterministic = [...candidates].sort((a, b) => a.deterministicRank - b.deterministicRank || a.candidateRef.localeCompare(b.candidateRef)).map(c => c.candidateRef);
  if (typeof scorer !== 'function') return freeze({applied: false, reason: 'NO_SCORER', order: deterministic, fallback: deterministic, dispatched: false});
  let proposal;
  try { proposal = scorer(candidates, context); }
  catch (error) {
    // A learner that throws, times out or is unavailable falls back to the proven order; it never blocks the caller.
    const reason = error?.code && Object.values(SHIELD_REFUSALS).includes(error.code) ? error.code : 'SCORER_FAILED';
    return freeze({applied: false, reason, detail: String(error?.message ?? error).slice(0, 200), order: deterministic, fallback: deterministic, dispatched: false});
  }
  // A MALFORMED proposal is treated exactly like a failed scorer: it falls back to the proven order instead of throwing
  // out of the shield. My first version let this escape as an exception, which meant a bad learner could block the
  // caller - the one thing the fallback exists to prevent.
  if (!Array.isArray(proposal) || !proposal.every(ref)) {
    return freeze({applied: false, reason: 'PROPOSAL_MALFORMED', detail: `scorer returned ${Array.isArray(proposal) ? 'a non-reference array' : typeof proposal}`, order: deterministic, fallback: deterministic, dispatched: false});
  }
  // The ONLY thing a learner may do is reorder. Both directions of a set difference are refusals, so neither an added
  // nor a dropped candidate can slip through.
  const proposed = [...proposal];
  if (proposed.length !== eligibleRefs.length || new Set(proposed).size !== proposed.length) {
    return freeze({applied: false, reason: SHIELD_REFUSALS.NOT_A_PERMUTATION, detail: `proposal length ${proposed.length} vs eligible ${eligibleRefs.length}`, order: deterministic, fallback: deterministic, dispatched: false});
  }
  const missing = eligibleRefs.filter(x => !proposed.includes(x));
  const added = proposed.filter(x => !eligibleRefs.includes(x));
  if (missing.length || added.length) {
    return freeze({applied: false, reason: SHIELD_REFUSALS.ELIGIBLE_SET_CHANGED, detail: `missing ${JSON.stringify(missing)} added ${JSON.stringify(added)}`, order: deterministic, fallback: deterministic, dispatched: false});
  }
  return freeze({applied: true, reason: null, detail: null, order: proposed, fallback: deterministic, dispatched: false});
}

/**
 * Reject any attempt by a learner to influence a protected field. Callers pass the patch a learner wants applied to a
 * candidate; a protected key - present even with an unchanged value - is refused, because the attempt itself is the
 * problem and silently ignoring it would hide a bug elsewhere.
 */
export function assertNoProtectedFieldChange(patch = {}) {
  ok(isPlainObject(patch), 'SHIELD_PATCH_REQUIRED');
  const touched = Object.keys(patch).filter(key => PROTECTED_FIELDS.includes(key));
  ok(touched.length === 0, SHIELD_REFUSALS.PROTECTED_FIELD + ':' + touched.join(','));
  return true;
}

/** Validate a scorer's stated confidence and inputs before trusting its order. Each failure has its own code. */
export function assertScorerHealthy({confidence, latencyMs = 0, costMinor = 0, drifted = false} = {}) {
  ok(finite(confidence) && confidence >= INPUT_RANGE.minProbability && confidence <= INPUT_RANGE.maxProbability, SHIELD_REFUSALS.INPUT_OUT_OF_RANGE + ':confidence');
  ok(finite(latencyMs) && latencyMs >= 0 && latencyMs <= INPUT_RANGE.maxLatencyMs, SHIELD_REFUSALS.INPUT_OUT_OF_RANGE + ':latencyMs');
  ok(finite(costMinor) && costMinor >= 0, SHIELD_REFUSALS.INPUT_OUT_OF_RANGE + ':costMinor');
  ok(drifted !== true, SHIELD_REFUSALS.DRIFT);
  ok(costMinor <= MAX_COST_MINOR, SHIELD_REFUSALS.COST_EXCEEDED + ':' + costMinor);
  ok(confidence >= CONFIDENCE_FLOOR, SHIELD_REFUSALS.LOW_CONFIDENCE + ':' + confidence);
  return true;
}

/**
 * A SHADOW decision: run the learner against the incumbent on a live-shaped input and report the DIFFERENCE, without
 * dispatching either. `dispatched: false` is not decoration - it is what stops a shadow from being read as an action.
 */
export function shadowDecision({eligible = [], scorer, context = {}, candidateSha, policyVersion, modelVersion, incumbentOrder = null} = {}) {
  ok(ref(candidateSha), 'SHADOW_CANDIDATE_SHA_REQUIRED');
  ok(Number.isSafeInteger(policyVersion) && Number.isSafeInteger(modelVersion), 'SHADOW_VERSIONS_REQUIRED');
  const shielded = applySafetyShield({eligible, scorer, context});
  const incumbent = incumbentOrder ?? shielded.fallback;
  const differences = [];
  const width = Math.max(incumbent.length, shielded.order.length);
  for (let index = 0; index < width; index += 1) {
    if (incumbent[index] !== shielded.order[index]) differences.push({position: index, incumbent: incumbent[index] ?? null, shadowed: shielded.order[index] ?? null});
  }
  return freeze({
    shadow: true, dispatched: false, applied: shielded.applied, reason: shielded.reason, detail: shielded.detail,
    shadowedOrder: shielded.order, incumbentOrder: incumbent, differences, changed: differences.length > 0,
    candidateSha, policyVersion, modelVersion,
    // The reason for any change is recorded with the versions, so a later reader can see WHAT changed and WHY.
    reasonForChange: differences.length ? `learner reordered ${differences.length} position(s) within the eligible set` : 'no reordering',
  });
}

/**
 * Held-out evaluation. A workload that appears in the training trace is REFUSED, so an evaluation cannot flatter itself
 * by testing on what it trained on.
 */
export function evaluateHeldOut({trainingTrace = [], heldOutWorkloads = [], score} = {}) {
  ok(Array.isArray(trainingTrace) && Array.isArray(heldOutWorkloads), 'EVALUATION_INPUT_REQUIRED');
  ok(typeof score === 'function', 'EVALUATION_SCORER_REQUIRED');
  const trained = new Set(trainingTrace.map(entry => (typeof entry === 'string' ? entry : entry?.workloadRef)).filter(Boolean));
  const overlapping = heldOutWorkloads.map(workload => (typeof workload === 'string' ? workload : workload?.workloadRef)).filter(workloadRef => trained.has(workloadRef));
  ok(overlapping.length === 0, 'TRAIN_TEST_OVERLAP:' + overlapping.join(','));
  const results = heldOutWorkloads.map(workload => {
    const workloadRef = typeof workload === 'string' ? workload : workload.workloadRef;
    const value = score(workload);
    ok(finite(value), 'EVALUATION_SCORE_INVALID');
    return freeze({workloadRef, score: value});
  });
  const mean = results.length ? results.reduce((sum, row) => sum + row.score, 0) / results.length : 0;
  return freeze({results, mean, size: results.length, evidenceClass: 'HELD_OUT_EVALUATION', analysis: 'DESCRIPTIVE_ONLY'});
}

/**
 * The admission ladder for a learned policy: offline evaluation, then shadow, then an Owner-approved bounded canary,
 * then a REVERSIBLE enable. A stage may not be skipped, and the canary requires a named Owner approval reference.
 */
export const POLICY_STAGES = Object.freeze(['OFFLINE_EVALUATED', 'SHADOW_OBSERVED', 'CANARY_APPROVED', 'ENABLED_REVERSIBLE']);
export function advancePolicyStage(current, next, {ownerApprovalRef = null, canaryShare = null} = {}) {
  const at = POLICY_STAGES.indexOf(current);
  const to = POLICY_STAGES.indexOf(next);
  ok(at >= 0 && to >= 0, 'POLICY_STAGE_UNKNOWN');
  ok(to === at + 1, 'POLICY_STAGE_SKIPPED:' + current + '->' + next);
  if (next === 'CANARY_APPROVED') {
    ok(ref(ownerApprovalRef), 'CANARY_OWNER_APPROVAL_REQUIRED');
    ok(finite(canaryShare) && canaryShare > 0 && canaryShare <= 0.25, 'CANARY_SHARE_INVALID');
  }
  return freeze({stage: next, reversible: true, ownerApprovalRef: ownerApprovalRef ?? null, canaryShare: canaryShare ?? null, rollbackTo: current});
}

/** Rolling back a learned policy is always available and needs no approval: it restores the proven deterministic order. */
export function rollbackPolicy() {
  return freeze({stage: 'SHADOW_OBSERVED', enabled: false, revertedTo: 'DETERMINISTIC_FALLBACK'});
}
