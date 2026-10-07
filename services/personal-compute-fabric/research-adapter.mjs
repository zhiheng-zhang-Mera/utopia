// PCF-707: the PCF -> REX research-trace adapter.
//
// This module is a SIDECAR. It converts a PCF receipt into one research event, projects that event onto the existing
// research-trace schema, and can replay policies through the real placement path. It deliberately owns none of the
// research institute's machinery: the collector, the normalizer and the export stay where they are.
//
// Three honesty rules are enforced here rather than documented:
//
//   1. EVIDENCE CLASS IS A MARK, NOT A CLAIM. An ACTUAL_EXECUTION event must carry the identities a real run has
//      (attempt epoch, input digest). A simulated or counterfactual event is marked as such and its performance
//      claim is NONE, because a different decision on the same trace is not a measured performance gain.
//   2. WHAT THE TRACE SCHEMA CANNOT CARRY IS REPORTED, NOT DROPPED. The REX schema has closed key sets, so the
//      attempt/reservation refs, the phase timings and the evidence class have no slot in it; they are listed in
//      `notRepresentable` instead of being silently lost, and the private fields are redacted by name.
//   3. THE SIDECAR FAILS BOUNDED. A capture that cannot be recorded increments a drop counter and returns false; it
//      never throws into the caller's execution path, so an unrelated task cannot be blocked by trace trouble.
import {createHash} from 'node:crypto';
import {canonicalEventRecord} from '../research-trace/schema.mjs';
import {requireThat as ok, copy, freeze, text, strings} from './validation.mjs';

export const RESEARCH_EVENT_VERSION = 1;
export const EVIDENCE_CLASSES = Object.freeze(['ACTUAL_EXECUTION', 'RECORDED_TRACE', 'SIMULATED', 'COUNTERFACTUAL_ESTIMATE']);
export const PHASES = Object.freeze(['queue', 'transfer', 'execution', 'recovery']);
export const INTERVENTIONS = Object.freeze(['AUTHENTICATION', 'APPROVAL', 'ENVIRONMENT', 'POLICY', 'REQUIREMENTS', 'EXTERNAL_STATE', 'CORRECTION', 'OTHER', 'NOT_OBSERVABLE']);
export const OUTCOMES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']);
export const REPLAY_MODES = Object.freeze(['BASELINE', 'PROPOSED', 'ABLATION']);
// Redacted BY KEY NAME: the adapter never needs the value to do its job, so it never keeps it.
const SENSITIVE = /(secret|token|password|passwd|credential|authorisation|authorization|api[-_]?key|private[-_]?key|cookie)/i;
const REF = /^[A-Za-z0-9_./:@#-]+$/;
const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && REF.test(value);
const refList = value => Array.isArray(value) && value.length <= 64 && value.every(ref);
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');

/** Redact sensitive values by key name, recording WHICH keys were redacted without keeping what they held. */
function redact(value, redacted) {
  if (Array.isArray(value)) return value.map(entry => redact(entry, redacted));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE.test(key)) { output[key] = '[REDACTED]'; if (!redacted.includes(key)) redacted.push(key); continue; }
      output[key] = redact(entry, redacted);
    }
    return output;
  }
  return value;
}

/**
 * Convert one validated PCF receipt into one research event.
 *
 * `context` carries everything the receipt itself does not own: the declared evidence class, the phase timings that
 * were actually observed, the observation refs, the decision reasons and the counts of what went missing.
 */
export function toResearchEvent(pcfReceipt, context = {}) {
  ok(pcfReceipt && typeof pcfReceipt === 'object' && !Array.isArray(pcfReceipt), 'RESEARCH_EVENT_RECEIPT_REQUIRED');
  const redactedKeys = [];
  const input = copy(redact(pcfReceipt, redactedKeys));
  ok(input.version === 1, 'RESEARCH_EVENT_RECEIPT_VERSION');
  for (const key of ['taskId', 'actionId', 'attemptId', 'executorDeviceId', 'bootId', 'providerId']) ok(text(input[key]), 'RESEARCH_EVENT_MISSING_' + key);
  ok(OUTCOMES.includes(input.outcome), 'RESEARCH_EVENT_OUTCOME_UNKNOWN');
  const evidenceClass = context.evidenceClass ?? 'ACTUAL_EXECUTION';
  ok(EVIDENCE_CLASSES.includes(evidenceClass), 'RESEARCH_EVENT_EVIDENCE_CLASS_UNKNOWN');
  // An ACTUAL claim has to carry the identities a real attempt has; without them it is a simulation wearing an
  // execution label, which is exactly the substitution the workbook forbids.
  if (evidenceClass === 'ACTUAL_EXECUTION') ok(Number.isSafeInteger(input.epoch) && input.epoch > 0 && /^[a-f0-9]{64}$/.test(input.inputDigest ?? ''), 'RESEARCH_EVENT_NOT_ACTUAL');
  if (evidenceClass === 'RECORDED_TRACE') ok(ref(context.sourceRunRef), 'RESEARCH_EVENT_SOURCE_RUN_REQUIRED');
  // A wrong run or head binding is refused rather than recorded as if it belonged to this experiment.
  if (context.runRef !== undefined) ok(context.runRef === context.expectedRunRef, 'RESEARCH_EVENT_RUN_MISMATCH');
  if (context.headSha !== undefined && context.expectedHeadSha !== undefined) ok(context.headSha === context.expectedHeadSha, 'RESEARCH_EVENT_HEAD_MISMATCH');
  const timestamp = typeof context.observedAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(context.observedAt) && Number.isFinite(Date.parse(context.observedAt)) ? context.observedAt : null;
  ok(timestamp !== null, 'RESEARCH_EVENT_TIMESTAMP_REQUIRED');
  const intervention = context.ownerIntervention ?? null;
  ok(intervention === null || INTERVENTIONS.includes(intervention), 'RESEARCH_EVENT_INTERVENTION_UNKNOWN');
  ok(context.observationRefs === undefined || refList(context.observationRefs), 'RESEARCH_EVENT_OBSERVATION_REF_INVALID');
  ok(context.decisionReasons === undefined || refList(context.decisionReasons), 'RESEARCH_EVENT_DECISION_REASON_INVALID');
  const observationRefs = context.observationRefs ?? [];
  const decisionReasons = context.decisionReasons ?? [];
  // Phases are recorded with their measured value or explicitly as NOT_OBSERVED - never as an invented 0.
  const phases = {};
  const phaseMissing = [];
  for (const name of PHASES) {
    const measured = Number.isFinite(context.phases?.[name]) && context.phases[name] >= 0 ? context.phases[name] : null;
    phases[name] = freeze({state: measured === null ? 'NOT_OBSERVED' : 'MEASURED', ms: measured});
    if (measured === null) phaseMissing.push('phases.' + name);
  }
  const missing = [...new Set([...(Array.isArray(context.missing) ? context.missing.filter(text) : []), ...phaseMissing])];
  const dropped = Number.isSafeInteger(context.dropped) && context.dropped >= 0 ? context.dropped : 0;
  const measuredMs = PHASES.reduce((sum, name) => sum + (phases[name].ms ?? 0), 0);
  const anyPhaseMeasured = PHASES.some(name => phases[name].state === 'MEASURED');
  const refs = freeze({taskRef: input.taskId, actionRef: input.actionId, attemptRef: input.attemptId, reservationRef: input.reservationId ?? null,
    deviceRef: input.executorDeviceId, bootRef: input.bootId, originSessionRef: input.parentSessionId ?? null, providerRef: input.providerId,
    policyRef: 'policy:' + (context.policyVersion ?? input.policyVersion), runtimeRef: context.runtimeRef ?? null,
    sourceRunRef: context.sourceRunRef ?? null, observationRefs: freeze([...observationRefs]), replayRef: context.replayRef ?? null});
  const identity = {taskId: input.taskId, attemptId: input.attemptId, outcome: input.outcome, epoch: input.epoch ?? null, evidenceClass, observedAt: timestamp};
  return freeze({kind: 'PCF_RESEARCH_EVENT', schemaVersion: RESEARCH_EVENT_VERSION, evidenceClass,
    eventId: 'pcf-research-' + sha256(identity).slice(0, 32), type: 'PCF_ATTEMPT_RECEIPT', observedAt: timestamp,
    sourceClock: context.sourceClock ?? 'CANONICAL_EVENT_WALL_UTC', outcome: input.outcome, refs,
    versions: freeze({policyVersion: context.policyVersion ?? input.policyVersion ?? null, runtimeRef: context.runtimeRef ?? null,
      providerManifestVersion: context.providerManifestVersion ?? null, envelopeVersion: context.envelopeVersion ?? null}),
    decision: freeze({reasons: freeze([...decisionReasons]), strategy: context.strategy ?? null, replayRef: context.replayRef ?? null}),
    phases: freeze(phases),
    measurement: freeze({class: evidenceClass, performanceClaim: evidenceClass === 'ACTUAL_EXECUTION' ? 'MEASURED_LOCALLY' : 'NONE',
      note: evidenceClass === 'ACTUAL_EXECUTION' ? 'local measurement of this attempt only; not a cross-host or statistical claim' : 'a decision difference on the same trace is not a real performance gain'}),
    ownerIntervention: intervention, missing: freeze(missing), dropped,
    privacy: freeze({redactedKeys: freeze([...new Set([...redactedKeys, ...(Array.isArray(context.redactedKeys) ? context.redactedKeys.filter(text) : [])])].sort()),
      policy: 'KEYS_MATCHING_SENSITIVE_PATTERN_REDACTED_BY_NAME; raw input bytes are never carried'}),
    // Everything the closed REX schema has no key for, named instead of silently discarded.
    notRepresentable: freeze(['refs.attemptRef', 'refs.reservationRef', 'refs.bootRef', 'refs.runtimeRef', 'refs.observationRefs', 'phases', 'evidenceClass', 'dropped', 'ownerIntervention', 'privacy']),
    traceProjection: freeze({eventId: 'pcf-attempt-' + sha256({attemptId: input.attemptId, outcome: input.outcome}).slice(0, 32), type: 'PCF_ATTEMPT_RECEIPT', timestamp,
      sourceClock: context.sourceClock ?? 'CANONICAL_EVENT_WALL_UTC',
      ...(Number.isSafeInteger(context.sourceSeq) && context.sourceSeq > 0 ? {sourceSeq: context.sourceSeq} : {}),
      canonicalRefs: freeze({taskRef: input.taskId, actionRef: input.actionId, deviceRef: input.executorDeviceId}),
      dimensions: freeze({providerRef: input.providerId, sourceWorkbook: 'PCF-707',
        ...(intervention === null || intervention === 'NOT_OBSERVABLE' ? {} : {ownerInterventionReason: intervention}),
        ...(ref(context.failureCode) ? {failureCode: context.failureCode} : {}),
        ...(ref(context.recoveryRef) ? {recoveryRef: context.recoveryRef} : {}),
        ...(Number.isSafeInteger(context.retryIndex) && context.retryIndex >= 0 ? {retryIndex: context.retryIndex} : {})}),
      metrics: freeze(anyPhaseMeasured ? {latencyMs: measuredMs} : {})})});
}

/**
 * The existing bounded adapter, extended with the receipt path. Every capture is best-effort by construction: a
 * failure is counted and reported, never thrown at the caller.
 */
export function createResearchAdapter(collector, {enabled = false} = {}) {
  let dropped = 0, captured = 0, events = 0;
  const attempt = work => { try { return work(); } catch { dropped++; return false; } };
  return {
    capture(event, {providerId} = {}) {
      if (!enabled) return false;
      return attempt(() => {
        const raw = canonicalEventRecord(event);
        if (providerId) raw.dimensions = {providerRef: providerId, sourceWorkbook: 'PCF-707'};
        const accepted = collector.record(raw);
        if (!accepted) dropped++;
        return accepted;
      });
    },
    /** Convert a receipt and record its trace projection, returning whether it was accepted. */
    captureReceipt(receipt, context = {}) {
      if (!enabled) return false;
      return attempt(() => {
        const event = toResearchEvent(receipt, context);
        events++;
        const accepted = collector.record(event.traceProjection);
        if (accepted) captured++; else dropped++;
        return accepted;
      });
    },
    snapshot() { return {enabled, dropped, captured, events}; },
  };
}

export function freezeStudy(input) {
  const s = copy(input);
  ok(s.version === 1 && text(s.id) && Number.isSafeInteger(s.repetitions) && s.repetitions > 0 && s.repetitions <= 1000 && s.stopAfterMs > 0 && s.stopAfterMs <= 3600000 && typeof s.softwareSha === 'string' && /^[a-f0-9]{40}$/.test(s.softwareSha) && strings(s.workloads) && s.workloads.length >= 2 && strings(s.hypotheses) && s.hypotheses.length > 0 && ['ACTUAL_LOCAL_CPU','ACTUAL_CROSS_HOST','SIMULATED'].includes(s.evidenceClass), 'STUDY_INVALID');
  return freeze(s);
}

export function shadowPolicy(baseline, proposedDeviceId, feasibleDevices) {
  if (baseline.state !== 'PROPOSED' || !feasibleDevices.includes(proposedDeviceId)) return {state: 'REFUSED', reason: 'SAFETY_SHIELD'};
  return {state: 'PROPOSED', mode: 'SHADOW_ONLY', baselineDeviceId: baseline.deviceId, proposedDeviceId, dispatchAllowed: false};
}

/**
 * Deterministic policy replay.
 *
 * The same workload, candidates and clock replayed through the same policy produce the same decision digest, so a
 * difference between two policies is RECOMPUTABLE rather than asserted. Experiment control is only accepted inside a
 * scope that declares itself isolated AND authorised; anything else is refused. The production policy object is never
 * touched, so looking at a report cannot change what the fabric does.
 */
export function replayDecisions({baseline, proposed, ablation = null, workload, candidates, now, scope} = {}) {
  ok(scope && typeof scope === 'object', 'REPLAY_SCOPE_REQUIRED');
  ok(scope.isolated === true, 'REPLAY_SCOPE_NOT_ISOLATED');
  ok(scope.authorised === true, 'REPLAY_SCOPE_NOT_AUTHORISED');
  ok(ref(scope.scopeRef), 'REPLAY_SCOPE_REF_REQUIRED');
  ok(typeof now === 'number' && Number.isFinite(now), 'REPLAY_CLOCK_REQUIRED');
  const policies = {BASELINE: baseline, PROPOSED: proposed, ...(ablation ? {ABLATION: ablation} : {})};
  const results = {};
  for (const [mode, policy] of Object.entries(policies)) {
    ok(policy && typeof policy.place === 'function' && ref(policy.ref), 'REPLAY_POLICY_INVALID');
    const decision = policy.place(workload, candidates, policy.value, now);
    const shape = {state: decision?.state ?? null, deviceId: decision?.deviceId ?? null, strategy: decision?.strategy ?? null,
      decisions: (decision?.decisions ?? []).map(entry => ({deviceId: entry.deviceId, code: entry.code}))};
    results[mode] = freeze({mode, policyRef: policy.ref, ...shape, decisionDigest: sha256({policyRef: policy.ref, ...shape})});
  }
  const compared = REPLAY_MODES.filter(mode => mode !== 'BASELINE' && results[mode]);
  const differences = compared.map(mode => freeze({mode, baselineDeviceId: results.BASELINE.deviceId, deviceId: results[mode].deviceId,
    decisionChanged: results[mode].decisionDigest !== results.BASELINE.decisionDigest,
    delta: results[mode].deviceId === results.BASELINE.deviceId ? 'NO_CHANGE' : 'DIFFERENT_DEVICE'}));
  return freeze({kind: 'PolicyReplay', schemaVersion: 1, scope: freeze({scopeRef: scope.scopeRef, isolated: true, authorised: true}),
    results: freeze(results), differences: freeze(differences), comparisonDigest: sha256(differences),
    productionPolicyUnchanged: true, dispatchAllowed: false, performanceClaim: 'NONE',
    note: 'decision differences are recomputable from the digests; they are not measured performance gains'});
}

/**
 * Measure what the instrumentation itself costs, on this host, with a local monotonic clock. The number is a local
 * observation of one loop and is labelled as such - it is not a general overhead claim.
 */
export function measureInstrumentationOverhead({enabled, disabled, iterations = 200} = {}) {
  ok(typeof enabled === 'function' && typeof disabled === 'function', 'OVERHEAD_INPUT');
  ok(Number.isSafeInteger(iterations) && iterations >= 10 && iterations <= 100000, 'OVERHEAD_ITERATIONS');
  const time = run => { const start = process.hrtime.bigint(); for (let index = 0; index < iterations; index++) run(index); return Number(process.hrtime.bigint() - start); };
  const disabledNs = time(disabled), enabledNs = time(enabled);
  return freeze({kind: 'InstrumentationOverhead', iterations, unit: 'ns-total', enabledNs, disabledNs, overheadNs: enabledNs - disabledNs,
    overheadPerEventNs: (enabledNs - disabledNs) / iterations, clock: 'PROCESS_HRTIME_MONOTONIC_LOCAL',
    scope: 'THIS_HOST_THIS_LOOP_ONLY', generalisable: false});
}
