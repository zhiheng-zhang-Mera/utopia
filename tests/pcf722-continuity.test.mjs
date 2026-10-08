// PCF-722 acceptance: control-plane continuity and HA.
//
// The workbook names: partition, asymmetric link loss, clock skew, an old leader coming back, storage lag, duplicate
// promotion, a fencing failure and a simultaneous controller+worker fault - and it is equally explicit about the other
// direction: the automatic-HA marker is only released by real-fault evidence plus a single-writer proof, a document
// review is NOT implementation progress, and a missing substrate keeps this workbook at NOT_RUN without blocking
// CORE_V1. Most of these tests assert a REFUSAL, because that is the only honest answer available here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {declareFailureModel, assessSubstrate, assessPromotion, fenceOldWriter, planHandover, releaseAutomaticHaClaim, continuityStatus,
  MAX_CLOCK_SKEW_MS, PROMOTION_REFUSALS, FAULT_CLASSES, HANDOVER_KINDS} from '../services/personal-compute-fabric/controller-continuity.mjs';

const model = (extra = {}) => ({version: 1, faults: Object.fromEntries(FAULT_CLASSES.map(name => [name, 'declared semantics for ' + name])),
  rpo: {maxDataLossBytes: 4096, unit: 'bytes'}, rto: {targetMs: 30000, unit: 'milliseconds'},
  promotionAuthority: ['owner:zhiheng'], oldWriterInvalidation: 'LEASE_EXPIRY_AND_EPOCH_FENCE', reentry: 'REJOIN_AS_STANDBY_AFTER_FENCE',
  replicaLagSemantics: 'REPLICA_LAG_IS_UNBOUNDED_UNLESS_LEASED', ...extra});
const substrate = (extra = {}) => ({kind: 'INDEPENDENT_ARBITER', evidence: {verified: true, reference: 'arbiter-attestation-2026-10'}, independentOf: ['node-a', 'node-b'], ...extra});
const cluster = (extra = {}) => ({observers: [{node: 'node-b', reachable: true}], currentPrimary: 'node-a', primaryFenced: true, ...extra});
const lease = (extra = {}) => ({holder: 'node-b', expiresAt: 2000, epoch: 7, holderClockMs: 1000, ...extra});
const storage = (extra = {}) => ({replicaLagBytes: 0, ...extra});
const assess = (extra = {}) => assessPromotion({model: model(), substrate: substrate(), cluster: cluster(), lease: lease(), storage: storage(), candidate: 'node-b', now: 1000, ...extra});

test('PCF722-01 the failure model is fixed first, and an SLO cannot declare itself verified', () => {
  const fixed = declareFailureModel(model());
  assert.equal(fixed.rpo.verified, false);
  assert.equal(fixed.rto.verified, false);
  assert.equal(fixed.slaVerified, false);
  assert.match(fixed.rpo.verificationRequirement, /a declaration is not verification/);
  // Every fault class the workbook names has to be declared semantics, not a blank.
  assert.deepEqual(FAULT_CLASSES, ['CONTROLLER_CRASH', 'NODE_LOSS', 'SYMMETRIC_PARTITION', 'ASYMMETRIC_PARTITION', 'STORAGE_LAG', 'STORAGE_LOSS', 'CONTROLLER_AND_WORKER_FAULT']);
  for (const missing of FAULT_CLASSES) {
    const faults = {...model().faults};
    delete faults[missing];
    assert.throws(() => declareFailureModel(model({faults})), /FAILURE_MODEL_INCOMPLETE/, missing + ' must be declared');
  }
  // Handing in a pre-verified target is refused rather than quietly downgraded.
  assert.throws(() => declareFailureModel(model({rpo: {maxDataLossBytes: 1, unit: 'bytes', verified: true}})), /SLO_CANNOT_BE_SELF_VERIFIED/);
  assert.throws(() => declareFailureModel(model({rto: {targetMs: 1, unit: 'milliseconds', verified: true}})), /SLO_CANNOT_BE_SELF_VERIFIED/);
  assert.throws(() => declareFailureModel(model({rpo: {maxDataLossBytes: 1, unit: 'megabytes'}})), /FAILURE_MODEL_RPO/);
  assert.throws(() => declareFailureModel(model({promotionAuthority: []})), /FAILURE_MODEL_AUTHORITY/);
  assert.throws(() => declareFailureModel(model({version: 2})), /FAILURE_MODEL_VERSION/);
});

test('PCF722-02 without a proven independent substrate nothing is promoted, and the workbook stays NOT_RUN', () => {
  // Nothing declared at all.
  assert.equal(assessPromotion({model: model(), candidate: 'node-b', now: 1000}).reason, PROMOTION_REFUSALS.NO_SUBSTRATE);
  // Declared but unproven: a self-declared arbiter is a claim, not a substrate.
  for (const bad of [{kind: 'INDEPENDENT_ARBITER'}, {kind: 'TWO_JSON_DIRECTORIES', evidence: {verified: true, reference: 'x'}, independentOf: ['node-a']},
    {kind: 'INDEPENDENT_ARBITER', evidence: {verified: false, reference: 'x'}, independentOf: ['node-a', 'node-b']},
    {kind: 'INDEPENDENT_ARBITER', evidence: {verified: true, reference: 'x'}, independentOf: []}]) {
    assert.equal(assessSubstrate(bad).sufficient, false, JSON.stringify(bad));
    assert.equal(assessPromotion({model: model(), substrate: bad, cluster: cluster(), lease: lease(), storage: storage(), candidate: 'node-b', now: 1000}).automaticPromotion, false);
  }
  // A substrate that is one of the two nodes is not independent of them.
  const status = continuityStatus({substrate: {kind: 'STRONG_LEASE_STORE'}});
  assert.equal(status.state, 'NOT_RUN');
  assert.equal(status.automaticHa, false);
  assert.equal(status.manualPathAvailable, true);
  assert.equal(status.coreV1Blocked, false, 'a missing optional prerequisite must not block CORE_V1');
  assert.match(status.note, /does not block CORE_V1/);
  // With a proven substrate the state moves, but automatic HA still is NOT claimed.
  const ready = continuityStatus({substrate: substrate()});
  assert.equal(ready.state, 'READY_FOR_MANUAL_PROMOTION');
  assert.equal(ready.automaticHa, false);
  assert.match(ready.note, /still needs real-fault evidence/);
});

test('PCF722-03 a partition cannot produce two primaries: no quorum and a live lease both refuse', () => {
  // Symmetric partition: this node sees nobody, so it cannot claim a majority.
  const split = assess({cluster: cluster({observers: [{node: 'node-b', reachable: false}], currentPrimary: 'node-a', primaryFenced: false})});
  assert.equal(split.state, 'REFUSED');
  assert.equal(split.reason, PROMOTION_REFUSALS.NO_QUORUM);
  assert.equal(split.automaticPromotion, false);
  assert.equal(split.requiredAction, 'MANUAL_VERIFIABLE_FENCE');
  // Asymmetric link loss: this node sees the other one, but the other one's lease is still live.
  const asymmetric = assess({cluster: cluster({observers: [{node: 'node-b', reachable: true}], asymmetric: true}), lease: lease({holder: 'node-a', expiresAt: 5000, holderClockMs: 1000})});
  assert.equal(asymmetric.reason, PROMOTION_REFUSALS.LEASE_HELD_ELSEWHERE);
  // The same refusal covers a live lease that has not expired yet, whoever holds it.
  assert.equal(assess({lease: lease({holder: 'node-c', expiresAt: 1500})}).reason, PROMOTION_REFUSALS.LEASE_HELD_ELSEWHERE);
  // An unproven fence on a different recorded primary is refused even with quorum.
  assert.equal(assess({cluster: cluster({currentPrimary: 'node-a', primaryFenced: false})}).reason, PROMOTION_REFUSALS.FENCE_NOT_PROVEN);
});

test('PCF722-04 clock skew, storage lag, duplicate promotion and a fencing failure each refuse for their own reason', () => {
  assert.equal(assess({lease: lease({holderClockMs: 1000 + MAX_CLOCK_SKEW_MS + 1})}).reason, PROMOTION_REFUSALS.CLOCK_SKEW);
  assert.equal(assess({storage: storage({replicaLagBytes: 4097})}).reason, PROMOTION_REFUSALS.STORAGE_LAG);
  assert.equal(assess({cluster: cluster({currentPrimary: 'node-b'}), lease: lease({holder: 'node-b'})}).reason, PROMOTION_REFUSALS.DUPLICATE_PROMOTION);
  // A fencing failure: quorum, no lag, no rival primary, but the old writer has neither an expired lease nor a stop.
  const unfenced = assess({cluster: cluster({currentPrimary: null, primaryFenced: false}), lease: lease({holder: null, expiresAt: 5000})});
  assert.equal(unfenced.reason, PROMOTION_REFUSALS.FENCE_NOT_PROVEN);
  assert.equal(unfenced.requiredAction, 'MANUAL_VERIFIABLE_FENCE');
  // A controller fault together with a worker fault has an unknown outcome and never promotes automatically.
  const both = assess({cluster: cluster({controllerAndWorkerFault: true})});
  assert.equal(both.reason, PROMOTION_REFUSALS.BOTH_FAULTED);
  assert.equal(both.automaticPromotion, false);
  // Only the fully clean case grants, and even then it grants a PROMOTION, not automatic HA.
  const granted = assess({lease: lease({holder: 'node-b'})});
  assert.equal(granted.state, 'GRANTED_AUTOMATIC');
  assert.equal(granted.automaticPromotion, true);
  assert.equal(granted.automaticHa, false, 'a promotion grant is not an availability claim');
  assert.equal(granted.epoch, 8, 'the new epoch is explicit and one ahead of the lease epoch');
  assert.match(granted.note, /AUTOMATIC_HA marker still needs/);
});

test('PCF722-05 an old leader coming back is fenced by epoch, and its writes are refused while it is stale', () => {
  const stale = fenceOldWriter({lease: {holder: 'node-b', epoch: 8, expiresAt: 5000}, returning: {node: 'node-a', epoch: 7}, now: 1000});
  assert.equal(stale.fenced, true);
  assert.equal(stale.staleEpoch, true);
  assert.equal(stale.acceptsWrites, false, 'resurrected old leader writes are refused');
  assert.equal(stale.reason, 'STALE_EPOCH_WRITE_REFUSED');
  assert.equal(stale.requiredAction, 'REJOIN_AS_STANDBY_AFTER_FENCE');
  // Resuming after an expired lease is also refused, and a same-epoch writer with a live lease is not fenced at all.
  assert.equal(fenceOldWriter({lease: {holder: 'node-b', epoch: 8, expiresAt: 1000}, returning: {node: 'node-b', epoch: 8}, now: 1000}).reason, 'LEASE_EXPIRED_WRITE_REFUSED');
  const unproven = fenceOldWriter({lease: {holder: 'node-b', epoch: 8, expiresAt: 5000}, returning: {node: 'node-b', epoch: 8}, now: 1000});
  assert.equal(unproven.fenced, false);
  assert.equal(unproven.reason, 'FENCE_NOT_PROVEN');
  assert.equal(unproven.acceptsWrites, true);
  assert.equal(unproven.automaticHa, false);
});

test('PCF722-06 a staged handover needs every step, bounds its refs and copies no raw secret', () => {
  const steps = {drain: 'drain:evidence-1', durabilityCheck: 'durability:evidence-1', epochAssignment: 'epoch:9', canary: 'canary:evidence-1', rollback: 'rollback:evidence-1'};
  const plan = planHandover({kind: 'PLANNED_MAINTENANCE', model: model(), steps, refs: {taskRefs: ['task:1'], artifactRefs: ['artifact:1'], credentialRefs: ['credential-handle:enrollment']}});
  assert.equal(plan.handoverKind, 'PLANNED_MAINTENANCE');
  assert.equal(plan.automaticHa, false, 'planned maintenance is not automatic high availability');
  assert.equal(plan.automaticHaClaim, 'NOT_CLAIMED');
  assert.equal(plan.drainBeforeSwitch, true);
  assert.equal(plan.epochExplicit, true);
  assert.equal(plan.rollbackAvailable, true);
  assert.equal(plan.signOff.separatePerKind, true);
  assert.deepEqual(plan.boundedRefCounts, {tasks: 1, artifacts: 1, credentials: 1});
  // A manual fenced standby is not automatic either; only the automatic kind may even be pending the marker.
  assert.equal(planHandover({kind: 'MANUAL_FENCED_STANDBY', model: model(), steps, refs: {}}).automaticHa, false);
  assert.equal(planHandover({kind: 'AUTOMATIC_FAILOVER', model: model(), steps, refs: {}}).automaticHaClaim, 'PENDING_REAL_FAULT_AND_SINGLE_WRITER_EVIDENCE');
  assert.equal(HANDOVER_KINDS.length, 3);
  // A skipped step is refused by name.
  for (const missing of Object.keys(steps)) {
    const partial = {...steps};
    delete partial[missing];
    assert.throws(() => planHandover({kind: 'PLANNED_MAINTENANCE', model: model(), steps: partial, refs: {}}), new RegExp('HANDOVER_STEP_REQUIRED:' + missing), missing);
  }
  // Credentials are handles. A raw secret in the plan is refused outright instead of being copied.
  for (const secret of ['ghp_ABCDEFGHIJKLMNOP', 'sk-ABCDEFGHIJKLMNOP', '-----BEGIN PRIVATE KEY-----']) {
    assert.throws(() => planHandover({kind: 'AUTOMATIC_FAILOVER', model: model(), steps, refs: {credentialRefs: [secret]}}), /HANDOVER_RAW_SECRET_REFUSED/, secret);
  }
  assert.throws(() => planHandover({kind: 'ROLLING_RESTART', model: model(), steps, refs: {}}), /HANDOVER_KIND_UNKNOWN/);
});

test('PCF722-07 the automatic-HA marker needs real-fault and single-writer evidence; a document review is not implementation', () => {
  const base = {model: model(), substrate: substrate()};
  // A design note, a simulation or a review keeps it BLOCKED, whatever it says about itself.
  for (const kind of ['DOCUMENT_REVIEW', 'SIMULATED', 'DESIGN_NOTE', undefined]) {
    const blocked = releaseAutomaticHaClaim({...base, faultEvidence: kind ? {kind, reference: 'doc-1'} : null, singleWriterProof: {verified: true, reference: 'proof-1'}});
    assert.equal(blocked.released, false, String(kind));
    assert.equal(blocked.state, 'BLOCKED');
    assert.equal(blocked.reason, 'DOCUMENT_REVIEW_IS_NOT_IMPLEMENTATION');
    assert.equal(blocked.automaticHa, false);
  }
  // Real fault evidence without a single-writer proof is still not enough.
  const halfProven = releaseAutomaticHaClaim({...base, faultEvidence: {kind: 'REAL_FAULT', reference: 'fault-run-2026-10'}, singleWriterProof: {verified: false, reference: 'claim'}});
  assert.equal(halfProven.released, false);
  assert.equal(halfProven.reason, 'SINGLE_WRITER_NOT_PROVEN');
  // Without a substrate the answer is NOT_RUN, not BLOCKED, and it says it does not block CORE_V1.
  const noSubstrate = releaseAutomaticHaClaim({model: model(), substrate: null, faultEvidence: {kind: 'REAL_FAULT', reference: 'x'}, singleWriterProof: {verified: true, reference: 'y'}});
  assert.equal(noSubstrate.state, 'NOT_RUN');
  assert.equal(noSubstrate.coreV1Blocked, false);
  // Only both together release the marker - and even then the SLOs stay targets.
  const released = releaseAutomaticHaClaim({...base, faultEvidence: {kind: 'REAL_FAULT', reference: 'fault-run-2026-10'}, singleWriterProof: {verified: true, reference: 'single-writer-run-2026-10'}});
  assert.equal(released.released, true);
  assert.equal(released.state, 'AUTOMATIC_HA_PROVEN');
  assert.equal(released.automaticHa, true);
  assert.equal(released.sloVerified, false, 'the fault test proves the tested scenarios, not the SLO targets');
  assert.match(released.note, /remain targets/);
});
