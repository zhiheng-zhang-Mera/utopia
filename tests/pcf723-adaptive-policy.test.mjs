// PCF-723 acceptance: the POLICY LIFECYCLE half of the adaptive-placement research workbook.
//
// The workbook names `services/personal-compute-fabric/adaptive-policy.mjs`, which does NOT exist in this checkout. The
// functionality lives in `shadow-placement.mjs` (the shield, the confidence/input/cost/timeout/drift gates, the stage
// ladder and rollback) and `research-adapter.mjs` (evidence grades and version traceability for a research artifact).
// This file tests those real modules and reports the naming difference rather than inventing a module.
//
// The shadow-decision half is already covered by `tests/pcf723-shadow-placement.test.mjs`; this file covers what that
// one does not: EVIDENCE GRADES, VERSION TRACEABILITY, the refusals that gate the learner's order, the fact that a
// refused learner still yields the verified deterministic order, and the two negative constraints the workbook states
// in prose - a learned policy may not freeze core behaviour and may not probe user permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIELD_REFUSALS, PROTECTED_FIELDS, CONFIDENCE_FLOOR, MAX_COST_MINOR, INPUT_RANGE,
  applySafetyShield, assertNoProtectedFieldChange, assertScorerHealthy,
  shadowDecision, advancePolicyStage, rollbackPolicy, POLICY_STAGES,
} from '../services/personal-compute-fabric/shadow-placement.mjs';
import {
  toResearchEvent, replayDecisions, EVIDENCE_CLASSES, REPLAY_MODES,
} from '../services/personal-compute-fabric/research-adapter.mjs';
import {planPlacement} from '../services/personal-compute-fabric/placement.mjs';

const RECEIPT = (extra = {}) => ({
  version: 1, taskId: 'T-1', actionId: 'A-1', parentSessionId: 'S-1', attemptId: 'ATT-1', epoch: 3,
  executorDeviceId: 'alien', bootId: 'boot-1', providerId: 'pcf-fixed-cpu-v1', inputDigest: 'a'.repeat(64),
  policyVersion: 7, outcome: 'SUCCEEDED', exitCode: 0, outputDigest: 'b'.repeat(64), ...extra,
});
const CONTEXT = extra => ({
  evidenceClass: 'ACTUAL_EXECUTION', observedAt: '2026-10-07T10:00:00.000Z', policyVersion: 7,
  phases: {queue: 5, transfer: 10, execution: 30, recovery: 0}, ...extra,
});

const eligible = [
  {candidateRef: 'A', deterministicRank: 1},
  {candidateRef: 'B', deterministicRank: 2},
  {candidateRef: 'C', deterministicRank: 3},
];
const DETERMINISTIC = ['A', 'B', 'C'];

/** Build a real PlacementProposal so a policy change is compared through the real placement path, not a stub. */
const policyFixture = (version, allowedDevices) => ({
  version, authorized: true, expiresAt: 5000, originDeviceId: 'alien', allowedDevices,
  dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, mode: 'TRUSTED_PERSONAL_FABRIC',
});
const CANDIDATES = ['alien', 'mech'].map(deviceId => ({
  deviceId, bootId: 'boot-' + deviceId, trusted: true, authorized: true, sharing: true, executorReady: true,
  provider: {id: 'pcf-fixed-cpu-v1', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON']},
  free: {cpu: 4, memory: 1048576}, observationVersion: 1, observedAt: 1000, validUntil: 4000, queueMs: 0,
  cost: {inputMs: [0, 10], coldStartMs: [0, 2000], executeMs: [0, 5000], returnMs: [0, 10]},
}));
const WORKLOAD = {taskId: 'T-1', actionId: 'A-1', originDeviceId: 'alien', dataScope: 'PUBLIC', capabilities: ['cpu.json'], kind: 'CPU_JSON', resources: {cpu: 1}, deadlineAt: 4000};

/** A real policy object: `place` runs the shipped placement path, so the replay compares actual decisions. */
const placementPolicy = (ref, allowedDevices) => ({
  ref,
  value: policyFixture(3, allowedDevices),
  place: (workload, candidates, policy, now) => planPlacement(workload, candidates, policy, now),
});

// ---------------------------------------------------------------------------------------------------------------
// Evidence grades and version traceability (workbook line 3: offline -> shadow -> approved canary -> reversible
// enable, with every policy/model version, input and reason for change traceable; acceptance paragraph: a
// nondeployment research result stays labelled as such).
// ---------------------------------------------------------------------------------------------------------------

test('PCF723-AP-01 an evidence grade is a recorded MARK, and only an ACTUAL_EXECUTION may claim a local measurement', () => {
  assert.deepEqual(EVIDENCE_CLASSES, ['ACTUAL_EXECUTION', 'RECORDED_TRACE', 'SIMULATED', 'COUNTERFACTUAL_ESTIMATE']);
  const actual = toResearchEvent(RECEIPT(), CONTEXT());
  assert.equal(actual.evidenceClass, 'ACTUAL_EXECUTION');
  assert.equal(actual.measurement.class, 'ACTUAL_EXECUTION');
  assert.equal(actual.measurement.performanceClaim, 'MEASURED_LOCALLY');
  assert.match(actual.measurement.note, /not a cross-host or statistical claim/);
  // A simulated/counterfactual/recorded event is graded as such and its performance claim is NONE, so a research
  // artifact can never be read as a delivered runtime capability.
  for (const evidenceClass of EVIDENCE_CLASSES.filter(name => name !== 'ACTUAL_EXECUTION')) {
    const event = toResearchEvent(RECEIPT(), CONTEXT({evidenceClass, sourceRunRef: 'run:42'}));
    assert.equal(event.measurement.class, evidenceClass);
    assert.equal(event.measurement.performanceClaim, 'NONE', `${evidenceClass} must not carry a performance claim`);
    assert.match(event.measurement.note, /not a real performance gain/);
  }
  // An event whose phase window was never observed keeps the grade but reports the gap, rather than inventing a zero.
  const partial = toResearchEvent(RECEIPT(), CONTEXT({evidenceClass: 'SIMULATED', sourceRunRef: 'run:42', phases: {execution: 30}}));
  assert.equal(partial.phases.recovery.state, 'NOT_OBSERVED');
  assert.equal(partial.phases.recovery.ms, null);
});

test('PCF723-AP-02 an ACTUAL label needs real run identities, and a recorded trace needs its source run', () => {
  // A simulation wearing an execution label is the exact substitution the workbook forbids.
  assert.throws(() => toResearchEvent(RECEIPT(), CONTEXT({evidenceClass: 'REAL_RUN'})), {code: 'RESEARCH_EVENT_EVIDENCE_CLASS_UNKNOWN'});
  assert.throws(() => toResearchEvent(RECEIPT({epoch: 0}), CONTEXT()), {code: 'RESEARCH_EVENT_NOT_ACTUAL'});
  assert.throws(() => toResearchEvent(RECEIPT({inputDigest: null}), CONTEXT()), {code: 'RESEARCH_EVENT_NOT_ACTUAL'});
  assert.throws(() => toResearchEvent(RECEIPT(), {evidenceClass: 'ACTUAL_EXECUTION'}), {code: 'RESEARCH_EVENT_TIMESTAMP_REQUIRED'});
  assert.throws(() => toResearchEvent(RECEIPT(), CONTEXT({evidenceClass: 'RECORDED_TRACE'})), {code: 'RESEARCH_EVENT_SOURCE_RUN_REQUIRED'});
  // A wrong run or head binding is refused rather than recorded against this experiment.
  assert.throws(() => toResearchEvent(RECEIPT(), CONTEXT({runRef: 'run:1', expectedRunRef: 'run:2'})), {code: 'RESEARCH_EVENT_RUN_MISMATCH'});
  assert.throws(() => toResearchEvent(RECEIPT(), CONTEXT({headSha: 'a'.repeat(40), expectedHeadSha: 'b'.repeat(40)})), {code: 'RESEARCH_EVENT_HEAD_MISMATCH'});
});

test('PCF723-AP-03 every policy/model/input version of a decision is traceable, and what cannot be carried is named', () => {
  const event = toResearchEvent(RECEIPT(), CONTEXT({policyVersion: 7, runtimeRef: 'runtime:local-cpu@1', providerManifestVersion: 1, envelopeVersion: 2}));
  assert.equal(event.versions.policyVersion, 7);
  assert.equal(event.refs.policyRef, 'policy:7');
  assert.equal(event.refs.runtimeRef, 'runtime:local-cpu@1');
  assert.equal(event.versions.providerManifestVersion, 1);
  assert.equal(event.versions.envelopeVersion, 2);
  assert.equal(event.refs.attemptRef, 'ATT-1');
  assert.equal(event.refs.deviceRef, 'alien');
  assert.equal(event.refs.bootRef, 'boot-1');
  // The closed REX schema has no key for these, so they are NAMED as not-representable instead of being silently lost.
  for (const key of ['refs.attemptRef', 'refs.reservationRef', 'phases', 'evidenceClass', 'dropped', 'privacy']) {
    assert.ok(event.notRepresentable.includes(key), `${key} must be reported as not representable`);
  }
  assert.match(event.privacy.policy, /raw input bytes are never carried/);
});

test('PCF723-AP-04 a policy change is TRACEABLE as a recomputable decision difference, never as a performance gain', () => {
  const scope = {isolated: true, authorised: true, scopeRef: 'experiment:723'};
  // The shipped ranking is local-first, so two policies that permit the same set choose the same device. The replay
  // must report NO change rather than manufacture a difference for the report's sake.
  const unchanged = replayDecisions({
    baseline: placementPolicy('placement:3@v1', ['alien', 'mech']), proposed: placementPolicy('placement:3@v2', ['alien', 'mech']),
    workload: WORKLOAD, candidates: CANDIDATES, now: 1000, scope,
  });
  assert.equal(unchanged.results.BASELINE.deviceId, 'alien');
  assert.equal(unchanged.results.PROPOSED.deviceId, 'alien');
  // The comparison digest is taken over the two decision digests, which include the policy reference itself. A report
  // is therefore honest about the comparison it actually made: the DEVICE did not move (`delta`), while the two
  // conditions are not byte-identical records. Neither reading is presented as a speed-up.
  assert.equal(unchanged.differences[0].delta, 'NO_CHANGE');
  assert.equal(unchanged.differences[0].decisionChanged, true);
  assert.match(unchanged.comparisonDigest, /^[a-f0-9]{64}$/);
  assert.equal(unchanged.productionPolicyUnchanged, true, 'looking at a report cannot change what the fabric does');
  assert.equal(unchanged.dispatchAllowed, false);
  assert.equal(unchanged.performanceClaim, 'NONE');

  // A policy version that actually changes the feasible set changes the decision, and the difference is recomputable
  // from the two decision digests rather than asserted.
  const changed = replayDecisions({
    baseline: placementPolicy('placement:3@v1', ['alien']), proposed: placementPolicy('placement:4@v2', ['mech']),
    workload: WORKLOAD, candidates: CANDIDATES, now: 1000, scope,
  });
  assert.deepEqual(REPLAY_MODES, ['BASELINE', 'PROPOSED', 'ABLATION']);
  assert.equal(changed.results.BASELINE.deviceId, 'alien');
  assert.equal(changed.results.PROPOSED.deviceId, 'mech');
  assert.match(changed.results.BASELINE.decisionDigest, /^[a-f0-9]{64}$/);
  assert.match(changed.results.PROPOSED.decisionDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(changed.results.BASELINE.decisionDigest, changed.results.PROPOSED.decisionDigest);
  assert.equal(changed.differences[0].baselineDeviceId, 'alien');
  assert.equal(changed.differences[0].deviceId, 'mech');
  assert.equal(changed.differences[0].decisionChanged, true);
  assert.equal(changed.differences[0].delta, 'DIFFERENT_DEVICE');
  assert.match(changed.note, /not measured performance gains/);
  // No difference may be reported against a policy that was deleted from the running system: this is a replay.
  assert.equal(changed.scope.isolated, true);

  // Experiment control is only accepted inside a scope that declares itself isolated AND authorised.
  assert.throws(() => replayDecisions({baseline: placementPolicy('b', ['alien']), proposed: placementPolicy('p', ['mech']), workload: WORKLOAD, candidates: CANDIDATES, now: 1000, scope: {authorised: true, scopeRef: 's'}}), {code: 'REPLAY_SCOPE_NOT_ISOLATED'});
  assert.throws(() => replayDecisions({baseline: placementPolicy('b', ['alien']), proposed: placementPolicy('p', ['mech']), workload: WORKLOAD, candidates: CANDIDATES, now: 1000, scope: {isolated: true, scopeRef: 's'}}), {code: 'REPLAY_SCOPE_NOT_AUTHORISED'});
  assert.throws(() => replayDecisions({baseline: placementPolicy('b', ['alien']), proposed: placementPolicy('p', ['mech']), workload: WORKLOAD, candidates: CANDIDATES, now: 1000, scope: {isolated: true, authorised: true}}), {code: 'REPLAY_SCOPE_REF_REQUIRED'});
  assert.throws(() => replayDecisions({baseline: placementPolicy('b', ['alien']), proposed: placementPolicy('p', ['mech']), workload: WORKLOAD, candidates: CANDIDATES, scope}), {code: 'REPLAY_CLOCK_REQUIRED'});
});

test('PCF723-AP-05 a policy/model version is mandatory on a shadow decision, and the reason for a change travels with it', () => {
  const changed = shadowDecision({eligible, scorer: () => ['C', 'B', 'A'], candidateSha: 'a'.repeat(40), policyVersion: 3, modelVersion: 7});
  assert.equal(changed.policyVersion, 3);
  assert.equal(changed.modelVersion, 7);
  assert.equal(changed.candidateSha, 'a'.repeat(40));
  assert.equal(changed.changed, true);
  assert.match(changed.reasonForChange, /reordered/);
  // A version change that cannot be identified is not acceptable: the traceability requirement needs both numbers.
  assert.throws(() => shadowDecision({eligible, scorer: () => DETERMINISTIC, candidateSha: 'a'.repeat(40), modelVersion: 7}), {code: 'SHADOW_VERSIONS_REQUIRED'});
  assert.throws(() => shadowDecision({eligible, scorer: () => DETERMINISTIC, candidateSha: 'a'.repeat(40), policyVersion: 3}), {code: 'SHADOW_VERSIONS_REQUIRED'});
  assert.throws(() => shadowDecision({eligible, scorer: () => DETERMINISTIC, policyVersion: 3, modelVersion: 7}), {code: 'SHADOW_CANDIDATE_SHA_REQUIRED'});
});

// ---------------------------------------------------------------------------------------------------------------
// The fallback gates (workbook line 4: drift, low confidence, timeout, out-of-range input or excessive overhead
// fall back to the verified deterministic policy).
// ---------------------------------------------------------------------------------------------------------------

test('PCF723-AP-06 drift, low confidence, an out-of-range input, a timeout and excessive cost each REFUSE by their own code', () => {
  assert.equal(CONFIDENCE_FLOOR, 0.6);
  assert.deepEqual(INPUT_RANGE, {maxProbability: 1, minProbability: 0, maxLatencyMs: 60000});
  assert.equal(assertScorerHealthy({confidence: 0.9, latencyMs: 10, costMinor: 0}), true);
  assert.throws(() => assertScorerHealthy({confidence: 0.2}), {code: 'SHIELD_LOW_CONFIDENCE:0.2'});
  assert.throws(() => assertScorerHealthy({confidence: 0.9, drifted: true}), {code: SHIELD_REFUSALS.DRIFT});
  assert.throws(() => assertScorerHealthy({confidence: 1.5}), {code: 'SHIELD_INPUT_OUT_OF_RANGE:confidence'});
  assert.throws(() => assertScorerHealthy({confidence: -0.1}), {code: 'SHIELD_INPUT_OUT_OF_RANGE:confidence'});
  assert.throws(() => assertScorerHealthy({confidence: 0.9, latencyMs: 999999}), {code: 'SHIELD_INPUT_OUT_OF_RANGE:latencyMs'});
  assert.throws(() => assertScorerHealthy({confidence: 0.9, costMinor: -1}), {code: 'SHIELD_INPUT_OUT_OF_RANGE:costMinor'});
  // This project authorizes NO spend at all, so ANY cost is a refusal rather than a threshold.
  assert.equal(MAX_COST_MINOR, 0);
  assert.throws(() => assertScorerHealthy({confidence: 0.9, costMinor: 1}), {code: 'SHIELD_COST_EXCEEDED:1'});
  // A non-finite confidence cannot pass as "healthy" either.
  assert.throws(() => assertScorerHealthy({confidence: NaN}), {code: 'SHIELD_INPUT_OUT_OF_RANGE:confidence'});
});

test('PCF723-AP-07 a refused scorer leaves the verified deterministic order in place and blocks no caller', () => {
  // The fallback exists before the learner is consulted, and it is identical for every way a learner can fail: the
  // caller still gets the verified deterministic order and the shield itself never throws out of the call.
  const failures = [
    ['drift', () => { throw Object.assign(new Error('drifted'), {code: SHIELD_REFUSALS.DRIFT}); }, SHIELD_REFUSALS.DRIFT],
    ['low confidence', () => { throw Object.assign(new Error('too unsure'), {code: SHIELD_REFUSALS.LOW_CONFIDENCE}); }, SHIELD_REFUSALS.LOW_CONFIDENCE],
    ['timeout', () => { throw Object.assign(new Error('too slow'), {code: SHIELD_REFUSALS.TIMEOUT}); }, SHIELD_REFUSALS.TIMEOUT],
    ['out of range', () => { throw Object.assign(new Error('confidence'), {code: SHIELD_REFUSALS.INPUT_OUT_OF_RANGE}); }, SHIELD_REFUSALS.INPUT_OUT_OF_RANGE],
    ['cost', () => { throw Object.assign(new Error('cost'), {code: SHIELD_REFUSALS.COST_EXCEEDED}); }, SHIELD_REFUSALS.COST_EXCEEDED],
    ['unavailable', () => { throw new Error('model missing'); }, 'SCORER_FAILED'],
    // A scorer that reports a *qualified* refusal code (the same string the gates produce, e.g. with the offending
    // value appended) is reported as SCORER_FAILED, because only the exact published enum values are passed through.
    // The ORDER is still the verified fallback, so the caller is never blocked either way.
    ['qualified code', () => { throw Object.assign(new Error('0.1'), {code: SHIELD_REFUSALS.LOW_CONFIDENCE + ':0.1'}); }, 'SCORER_FAILED'],
  ];
  for (const [label, scorer, expected] of failures) {
    const result = applySafetyShield({eligible, scorer});
    assert.equal(result.applied, false, `${label} must not be applied`);
    assert.equal(result.reason, expected, `${label} must refuse under its own code`);
    assert.deepEqual(result.order, DETERMINISTIC, `${label} must fall back to the verified deterministic order`);
    assert.deepEqual(result.fallback, DETERMINISTIC);
    assert.equal(result.dispatched, false);
  }
  // MAX_COST_MINOR is zero because the fabric holds no spending authority for a learner; this is the workbook's
  // "the learner cannot alter spending authority" stated as a constant rather than a comment.
  assert.equal(MAX_COST_MINOR, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// The two negative constraints the workbook states in prose (line 4: without freezing core or probing privileges;
// line 2: the learner cannot alter trust, consent, strict target, review gate or spending authority).
// ---------------------------------------------------------------------------------------------------------------

test('PCF723-AP-08 no learned policy may freeze core behaviour: rollback is always available and restores the proven order', () => {
  assert.deepEqual(POLICY_STAGES, ['OFFLINE_EVALUATED', 'SHADOW_OBSERVED', 'CANARY_APPROVED', 'ENABLED_REVERSIBLE']);
  // The ladder cannot be skipped: an unreviewed learner cannot reach the enabled stage.
  assert.throws(() => advancePolicyStage('OFFLINE_EVALUATED', 'ENABLED_REVERSIBLE'), {code: 'POLICY_STAGE_SKIPPED:OFFLINE_EVALUATED->ENABLED_REVERSIBLE'});
  assert.throws(() => advancePolicyStage('SHADOW_OBSERVED', 'ENABLED_REVERSIBLE'), {code: 'POLICY_STAGE_SKIPPED:SHADOW_OBSERVED->ENABLED_REVERSIBLE'});
  // A canary needs a named Owner approval and a bounded share.
  assert.throws(() => advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED'), {code: 'CANARY_OWNER_APPROVAL_REQUIRED'});
  assert.throws(() => advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED', {ownerApprovalRef: 'owner:1', canaryShare: 0.9}), {code: 'CANARY_SHARE_INVALID'});
  assert.throws(() => advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED', {ownerApprovalRef: 'owner:1', canaryShare: 0}), {code: 'CANARY_SHARE_INVALID'});
  const canary = advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED', {ownerApprovalRef: 'owner:1', canaryShare: 0.25});
  assert.equal(canary.reversible, true);
  assert.equal(canary.rollbackTo, 'SHADOW_OBSERVED');
  // Rolling back needs no approval and restores the deterministic policy: a learned policy can never take the core
  // behaviour hostage.
  const rolled = rollbackPolicy();
  assert.equal(rolled.enabled, false);
  assert.equal(rolled.revertedTo, 'DETERMINISTIC_FALLBACK');
  assert.equal(rolled.stage, 'SHADOW_OBSERVED');
  // Even an enabled stage still carries its rollback target, so "reversible activation" is a property of the record.
  const enabled = advancePolicyStage('CANARY_APPROVED', 'ENABLED_REVERSIBLE');
  assert.equal(enabled.stage, 'ENABLED_REVERSIBLE');
  assert.equal(enabled.reversible, true);
  assert.equal(enabled.rollbackTo, 'CANARY_APPROVED');
});

test('PCF723-AP-09 no learned policy may probe user permissions: the shield refuses the feasible set and protected fields', () => {
  // The learner receives ONLY the eligible set, and the shield refuses any change to that set in EITHER direction:
  // it cannot widen what is permitted, and it cannot remove what the deterministic policy allowed.
  const widened = applySafetyShield({eligible, scorer: () => ['D', 'A', 'B', 'C']});
  assert.equal(widened.reason, SHIELD_REFUSALS.NOT_A_PERMUTATION);
  assert.deepEqual(widened.order, DETERMINISTIC);
  const narrowed = applySafetyShield({eligible, scorer: () => ['A', 'B']});
  assert.equal(narrowed.reason, SHIELD_REFUSALS.NOT_A_PERMUTATION);
  assert.deepEqual(narrowed.order, DETERMINISTIC);
  // A candidate that was filtered out before the shield is never visible to the learner, so there is nothing to probe.
  const refusedAtGate = applySafetyShield({eligible: [{candidateRef: 'A', deterministicRank: 1}], scorer: () => ['A', 'B']});
  assert.equal(refusedAtGate.applied, false);
  assert.deepEqual(refusedAtGate.order, ['A']);
  // Every permission-bearing field is refused even when the value is UNCHANGED: the ATTEMPT is the problem.
  for (const field of ['trust', 'consent', 'strictTarget', 'reviewGate', 'costAuthorization', 'budget', 'trusted', 'consentRef', 'strict_target', 'targetDeviceRef', 'reviewRequired', 'feeMinor']) {
    assert.ok(PROTECTED_FIELDS.includes(field), `${field} must be listed as protected`);
    assert.throws(() => assertNoProtectedFieldChange({[field]: true}), new RegExp('SHIELD_PROTECTED_FIELD:' + field), `${field} must be refused`);
  }
  assert.throws(() => assertNoProtectedFieldChange({score: 0.9, trusted: true}), {code: 'SHIELD_PROTECTED_FIELD:trusted'});
  // An ordinary ranking hint is not a permission change and stays allowed.
  assert.equal(assertNoProtectedFieldChange({score: 0.9, note: 'prefer less queueing'}), true);
});
