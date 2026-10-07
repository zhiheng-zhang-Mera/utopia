// PCF-722: control-plane continuity and HA - as a CONTRACT THAT REFUSES TO CLAIM AVAILABILITY.
//
// This workbook is an optional, independently gated item: its prerequisites are a really available control node, real
// storage/replication and a verifiable fencing substrate, plus an Owner-approved fault-test scope. None of those exist
// on this project, so the module's whole job is to be fail-closed and to keep every claim typed:
//
//   * RPO/RTO are TARGETS and stay unverified. A caller cannot declare its own SLO "verified"; only evidence from a
//     real fault test can, and that evidence is a reference the module never invents.
//   * automatic promotion needs a PROVEN arbiter/lease substrate that is independent of both nodes. Without it the
//     answer is a refusal plus the manual verifiable-fence path, never a hopeful promotion.
//   * two nodes in a partition cannot both become primary: promotion is granted against a lease that exactly one
//     holder can own, and a returning old leader is fenced by epoch rather than trusted.
//   * clock skew, storage lag beyond the RPO target, an unproven fence and a simultaneous controller+worker fault each
//     refuse promotion for their own reason.
//   * the AUTOMATIC_HA marker is only released on real-fault evidence plus a single-writer proof. A document review is
//     explicitly NOT implementation progress.
//   * a missing substrate keeps this workbook at NOT_RUN and does NOT block CORE_V1.
//
// Nothing here copies one JSON directory onto another and calls that a consistency protocol: the substrate is injected
// and must carry verified evidence, and no storage evolution is performed by this module at all.
import {requireThat as ok, text, strings, finite, copy, freeze} from './validation.mjs';

export const CONTINUITY_CONTRACT_VERSION = 1;
export const CONTINUITY_STATES = Object.freeze(['NOT_RUN', 'BLOCKED', 'READY_FOR_MANUAL_PROMOTION', 'AUTOMATIC_HA_PROVEN']);
export const HANDOVER_KINDS = Object.freeze(['PLANNED_MAINTENANCE', 'MANUAL_FENCED_STANDBY', 'AUTOMATIC_FAILOVER']);
export const FAULT_CLASSES = Object.freeze(['CONTROLLER_CRASH', 'NODE_LOSS', 'SYMMETRIC_PARTITION', 'ASYMMETRIC_PARTITION', 'STORAGE_LAG', 'STORAGE_LOSS', 'CONTROLLER_AND_WORKER_FAULT']);
export const SUBSTRATE_KINDS = Object.freeze(['INDEPENDENT_ARBITER', 'STRONG_LEASE_STORE']);
export const PROMOTION_REFUSALS = Object.freeze({
  NO_SUBSTRATE: 'NO_PROVEN_SUBSTRATE',
  NO_QUORUM: 'QUORUM_UNAVAILABLE',
  LEASE_HELD_ELSEWHERE: 'LEASE_HELD_ELSEWHERE',
  DUPLICATE_PROMOTION: 'DUPLICATE_PROMOTION',
  CLOCK_SKEW: 'CLOCK_SKEW_EXCEEDS_LEASE_MARGIN',
  STORAGE_LAG: 'RPO_TARGET_EXCEEDED',
  FENCE_NOT_PROVEN: 'FENCE_NOT_PROVEN',
  BOTH_FAULTED: 'CONTROLLER_AND_WORKER_FAULT_REQUIRES_MANUAL_VERIFICATION',
});
/** A lease is only safe to reason about when the clocks agree to well inside the lease margin. */
export const MAX_CLOCK_SKEW_MS = 2000;
const HANDOVER_STEPS = Object.freeze(['drain', 'durabilityCheck', 'epochAssignment', 'canary', 'rollback']);
const SECRET_SHAPED = /(secret|token|password|passwd|credential[-_]?value|-----BEGIN|ghp_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,})/i;
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Is this substrate a PROVEN, independent arbiter? Anything less is not a legal basis for automatic promotion. */
export function assessSubstrate(substrate) {
  if (!isPlainObject(substrate)) return freeze({sufficient: false, reason: PROMOTION_REFUSALS.NO_SUBSTRATE, detail: 'no substrate was declared'});
  if (!SUBSTRATE_KINDS.includes(substrate.kind)) return freeze({sufficient: false, reason: PROMOTION_REFUSALS.NO_SUBSTRATE, detail: 'an unrecognised substrate is not a proven one'});
  if (substrate.evidence?.verified !== true || !text(substrate.evidence.reference)) return freeze({sufficient: false, reason: PROMOTION_REFUSALS.NO_SUBSTRATE, detail: 'a substrate without separately verified evidence is a claim, not a substrate'});
  if (!strings(substrate.independentOf) || substrate.independentOf.length === 0) return freeze({sufficient: false, reason: PROMOTION_REFUSALS.NO_SUBSTRATE, detail: 'the substrate does not declare which nodes it is independent of'});
  return freeze({sufficient: true, kind: substrate.kind, reference: substrate.evidence.reference, independentOf: [...substrate.independentOf]});
}

/**
 * Fix the failure model before anything else. Every SLO is recorded as an UNVERIFIED target, and a caller that tries to
 * hand in a pre-verified SLO is refused: verification comes from a real fault test, not from a declaration.
 */
export function declareFailureModel(input = {}) {
  const model = copy(input);
  ok(isPlainObject(model), 'FAILURE_MODEL_REQUIRED');
  ok(model.version === CONTINUITY_CONTRACT_VERSION, 'FAILURE_MODEL_VERSION');
  ok(isPlainObject(model.faults) && FAULT_CLASSES.every(name => text(model.faults[name])), 'FAILURE_MODEL_INCOMPLETE');
  ok(isPlainObject(model.rpo) && finite(model.rpo.maxDataLossBytes) && model.rpo.unit === 'bytes', 'FAILURE_MODEL_RPO');
  ok(isPlainObject(model.rto) && finite(model.rto.targetMs) && model.rto.unit === 'milliseconds', 'FAILURE_MODEL_RTO');
  // A target is a target. Asking for it to be recorded as verified is refused rather than quietly downgraded.
  ok(model.rpo.verified !== true && model.rto.verified !== true, 'SLO_CANNOT_BE_SELF_VERIFIED');
  ok(strings(model.promotionAuthority) && model.promotionAuthority.length > 0, 'FAILURE_MODEL_AUTHORITY');
  ok(text(model.oldWriterInvalidation) && text(model.reentry) && text(model.replicaLagSemantics), 'FAILURE_MODEL_SEMANTICS');
  return freeze({...model, rpo: freeze({maxDataLossBytes: model.rpo.maxDataLossBytes, unit: 'bytes', verified: false,
      verificationRequirement: 'a real fault test with recorded evidence; a declaration is not verification'}),
    rto: freeze({targetMs: model.rto.targetMs, unit: 'milliseconds', verified: false,
      verificationRequirement: 'a real fault test with recorded evidence; a declaration is not verification'}),
    slaVerified: false});
}

/**
 * The promotion decision. It is deliberately the place where the answer is most often "no".
 *
 * `cluster` describes what each node can currently see; `lease` is the substrate's current lease; `storage` carries the
 * replica lag. Nothing here promotes on a promise: a lease must be owned, unexpired, fenced from the old holder and
 * readable with clocks that agree.
 */
export function assessPromotion({model, substrate, cluster, lease, storage, candidate, now} = {}) {
  const fixed = declareFailureModel(model);
  const arbiter = assessSubstrate(substrate);
  const evaluate = (decision, reason, detail, extra = {}) => freeze({kind: 'PromotionAssessment', state: decision,
    automaticPromotion: decision === 'GRANTED_AUTOMATIC', reason, detail, requiredAction: decision === 'GRANTED_AUTOMATIC' ? 'NONE' : 'MANUAL_VERIFIABLE_FENCE',
    automaticHa: false, ...extra});
  if (!arbiter.sufficient) return evaluate('REFUSED', arbiter.reason, arbiter.detail);
  ok(isPlainObject(cluster) && Array.isArray(cluster.observers) && isPlainObject(lease) && isPlainObject(storage) && text(candidate), 'PROMOTION_INPUT');
  ok(finite(now), 'PROMOTION_INPUT');
  // A controller crash together with a worker fault is never an automatic promotion: the outcome is unknown and a
  // human has to establish it.
  if (cluster.controllerAndWorkerFault === true) return evaluate('REFUSED', PROMOTION_REFUSALS.BOTH_FAULTED, 'a simultaneous controller and worker fault has an unknown outcome');
  // Clock skew larger than the lease margin makes every expiry decision unsound.
  if (finite(lease.holderClockMs) && Math.abs(lease.holderClockMs - now) > MAX_CLOCK_SKEW_MS) return evaluate('REFUSED', PROMOTION_REFUSALS.CLOCK_SKEW, 'the lease holder clock and this node differ by more than ' + MAX_CLOCK_SKEW_MS + 'ms');
  // Quorum: a node that cannot see a majority may not promote itself, whatever it believes about the other node.
  const quorum = Number.isSafeInteger(cluster.quorum) && cluster.quorum > 0 ? cluster.quorum : Math.floor((cluster.observers.length + 1) / 2) + 1;
  if (cluster.observers.filter(observer => observer.reachable === true).length + 1 < quorum) return evaluate('REFUSED', PROMOTION_REFUSALS.NO_QUORUM, 'this node cannot reach a majority, so a partition could make two primaries');
  // A live lease held by somebody else is the whole point of having a lease: refusing here is what prevents split brain.
  if (lease.holder && lease.holder !== candidate && finite(lease.expiresAt) && now < lease.expiresAt) return evaluate('REFUSED', PROMOTION_REFUSALS.LEASE_HELD_ELSEWHERE, 'another holder still owns an unexpired lease');
  // The same promotion applied twice is not two primaries, but a promotion while a primary is already recorded is.
  if (cluster.currentPrimary === candidate && lease.holder === candidate) return evaluate('REFUSED', PROMOTION_REFUSALS.DUPLICATE_PROMOTION, 'this node is already the recorded primary; a repeat promotion is not a second writer');
  if (cluster.currentPrimary && cluster.currentPrimary !== candidate && cluster.primaryFenced !== true) return evaluate('REFUSED', PROMOTION_REFUSALS.FENCE_NOT_PROVEN, 'the previous primary has not been fenced, so it could still write');
  // Replica lag beyond the declared RPO target is data loss, and it is reported as such rather than absorbed.
  if (finite(storage.replicaLagBytes) && storage.replicaLagBytes > fixed.rpo.maxDataLossBytes) return evaluate('REFUSED', PROMOTION_REFUSALS.STORAGE_LAG, 'replica lag exceeds the declared RPO target; promoting here loses data');
  // The old writer must be provably unable to write: an expired lease, or an acknowledgement that it stopped.
  const fenced = lease.holder === candidate ? true : (finite(lease.expiresAt) && now >= lease.expiresAt) || cluster.oldWriterAcknowledgedStop === true;
  if (!fenced) return evaluate('REFUSED', PROMOTION_REFUSALS.FENCE_NOT_PROVEN, 'the old writer has neither an expired lease nor a recorded stop');
  return evaluate('GRANTED_AUTOMATIC', null, 'lease owned, quorum reached, old writer fenced and storage inside the RPO target',
    {automaticPromotion: true, automaticHa: false, requiredAction: 'RECORD_EPOCH_AND_CANARY',
      epoch: Number.isSafeInteger(lease.epoch) ? lease.epoch + 1 : null,
      note: 'this is a promotion grant only: the AUTOMATIC_HA marker still needs real-fault and single-writer evidence'});
}

/** A returning old primary is fenced by EPOCH, not by trust, and its writes are refused while it is stale. */
export function fenceOldWriter({lease, returning, now} = {}) {
  ok(isPlainObject(lease) && isPlainObject(returning) && finite(now), 'FENCE_INPUT');
  const enumerated = Number.isSafeInteger(lease.epoch) && Number.isSafeInteger(returning.epoch);
  const stale = enumerated && returning.epoch < lease.epoch;
  const fenced = stale || (finite(lease.expiresAt) && now >= lease.expiresAt);
  return freeze({fenced, staleEpoch: stale, reason: fenced ? (stale ? 'STALE_EPOCH_WRITE_REFUSED' : 'LEASE_EXPIRED_WRITE_REFUSED') : 'FENCE_NOT_PROVEN',
    requiredAction: fenced ? 'REJOIN_AS_STANDBY_AFTER_FENCE' : 'MANUAL_VERIFIABLE_FENCE',
    acceptsWrites: !fenced, automaticHa: false});
}

/**
 * A staged handover. The steps are the workbook's, each with an evidence reference; a handover that skips one is
 * refused. Credentials travel as HANDLES only - a raw secret in the plan is refused outright, not redacted.
 */
export function planHandover({kind, model, steps, refs} = {}) {
  const fixed = declareFailureModel(model);
  ok(HANDOVER_KINDS.includes(kind), 'HANDOVER_KIND_UNKNOWN');
  ok(isPlainObject(steps), 'HANDOVER_STEPS_REQUIRED');
  for (const name of HANDOVER_STEPS) ok(text(steps[name]), 'HANDOVER_STEP_REQUIRED:' + name);
  ok(isPlainObject(refs), 'HANDOVER_REFS_REQUIRED');
  for (const key of ['taskRefs', 'artifactRefs', 'credentialRefs']) ok(strings(refs[key] ?? []), 'HANDOVER_REFS_REQUIRED:' + key);
  const refsJson = JSON.stringify(refs);
  ok(!SECRET_SHAPED.test(refsJson), 'HANDOVER_RAW_SECRET_REFUSED');
  // Planned maintenance and a manual fenced standby are NOT automatic high availability, and they are signed off
  // separately: a human process must never be presented as automatic failover.
  const automatic = kind === 'AUTOMATIC_FAILOVER';
  return freeze({kind: 'HandoverPlan', handoverKind: kind, version: fixed.version, steps: freeze({...steps}),
    refs: freeze({taskRefs: [...(refs.taskRefs ?? [])], artifactRefs: [...(refs.artifactRefs ?? [])], credentialRefs: [...(refs.credentialRefs ?? [])]}),
    boundedRefCounts: freeze({tasks: (refs.taskRefs ?? []).length, artifacts: (refs.artifactRefs ?? []).length, credentials: (refs.credentialRefs ?? []).length}),
    automaticHa: automatic, automaticHaClaim: automatic ? 'PENDING_REAL_FAULT_AND_SINGLE_WRITER_EVIDENCE' : 'NOT_CLAIMED',
    signOff: freeze({required: true, authority: 'OWNER', separatePerKind: true, reason: automatic ? 'automatic failover must be signed off as such' : 'a human-triggered handover is not automatic HA'}),
    rollbackAvailable: true, drainBeforeSwitch: true, epochExplicit: true, note: 'no raw secret is copied; credentials are handles only'});
}

/**
 * The ONLY way the AUTOMATIC_HA marker is released. Real-fault evidence plus a single-writer proof; a document review,
 * a design note or a simulation each keep it BLOCKED, and a missing substrate keeps the workbook at NOT_RUN.
 */
export function releaseAutomaticHaClaim({model, substrate, faultEvidence, singleWriterProof} = {}) {
  const fixed = declareFailureModel(model);
  const arbiter = assessSubstrate(substrate);
  if (!arbiter.sufficient) return freeze({released: false, state: 'NOT_RUN', reason: arbiter.reason, automaticHa: false, coreV1Blocked: false,
    detail: 'the workbook stays NOT_RUN while the independent substrate is absent; this must not block CORE_V1'});
  if (!isPlainObject(faultEvidence) || faultEvidence.kind !== 'REAL_FAULT' || !text(faultEvidence.reference)) {
    return freeze({released: false, state: 'BLOCKED', reason: 'DOCUMENT_REVIEW_IS_NOT_IMPLEMENTATION', automaticHa: false,
      detail: 'only evidence from a real fault test with recorded references releases the automatic HA marker'});
  }
  if (!isPlainObject(singleWriterProof) || singleWriterProof.verified !== true || !text(singleWriterProof.reference)) {
    return freeze({released: false, state: 'BLOCKED', reason: 'SINGLE_WRITER_NOT_PROVEN', automaticHa: false,
      detail: 'automatic HA also requires a proven single-writer guarantee'});
  }
  return freeze({released: true, state: 'AUTOMATIC_HA_PROVEN', automaticHa: true, reason: null,
    faultEvidenceRef: faultEvidence.reference, singleWriterRef: singleWriterProof.reference, sloVerified: false,
    note: 'the fault test proves this declared failure model only; RPO/RTO remain targets for the tested scenarios'});
}

/** The workbook's standing status while the substrate is absent. It must never block CORE_V1. */
export function continuityStatus({substrate} = {}) {
  const arbiter = assessSubstrate(substrate);
  if (!arbiter.sufficient) return freeze({state: 'NOT_RUN', reason: arbiter.reason, detail: arbiter.detail, automaticHa: false,
    coreV1Blocked: false, manualPathAvailable: true, note: 'PCF-722 is optional and independently gated; its missing prerequisite does not block CORE_V1'});
  return freeze({state: 'READY_FOR_MANUAL_PROMOTION', reason: null, automaticHa: false, coreV1Blocked: false,
    manualPathAvailable: true, note: 'a proven substrate is present; automatic HA still needs real-fault evidence'});
}
