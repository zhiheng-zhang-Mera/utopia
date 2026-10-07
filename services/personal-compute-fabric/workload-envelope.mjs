// PCF-708: the versioned workload envelope and execution attempt.
//
// The legacy `normalizeWorkload` stays exactly as it is, because PCF-708 requires that a legacy task missing the new
// extension fields keeps its ORIGINAL behaviour: this module is additive, never a replacement. An envelope is the
// versioned statement of what a workload needs and what it is allowed to do, and an ExecutionAttempt is the versioned
// statement of one try at it.
//
// Three rules are enforced here rather than left to callers:
//   * a QoS class is one of four names, and a deadline is never a promise of hard real time - the miss policy is an
//     EXPLICIT choice among refuse/run-late/degrade, never a default we invented;
//   * retry safety is an independent, explicitly declared capability. A worker claiming "I can checkpoint" is NOT
//     evidence, so `checkpoint_resumable` must be backed by the provider capability reference;
//   * unknown schema versions, unit conflicts, malformed resource requirements and unverified privilege requests are
//     typed refusals, not best-effort coercion.
import {requireThat as ok, text, strings, finite, freeze} from './validation.mjs';

export const WORKLOAD_ENVELOPE_VERSION = 2;

/** The four QoS classes. Nothing here implies a latency guarantee; that is the miss policy's job. */
export const QOS_CLASSES = Object.freeze(['INTERACTIVE', 'SOFT_DEADLINE', 'BATCH', 'BACKGROUND']);

/** How a deadline miss is handled. There is no default: a caller that wants a deadline must say what happens. */
export const MISS_POLICIES = Object.freeze(['REFUSE', 'RUN_LATE', 'DEGRADE']);

/** Independent, declarable retry-safety capabilities. `unknown-effect` is a first-class state, not a failure. */
export const RETRY_SAFETY = Object.freeze(['SIDE_EFFECT_FREE', 'IDEMPOTENT_KEYED', 'CHECKPOINT_RESUMABLE', 'NON_RETRYABLE', 'UNKNOWN_EFFECT']);

/** Declared resources and their unit. A requirement without a unit is not a requirement, so the unit is mandatory. */
export const RESOURCE_UNITS = Object.freeze({cpu: 'millicores', memory: 'bytes', disk: 'bytes', vram: 'bytes', acceleratorCount: 'devices', networkEgress: 'bytes', wallClockMs: 'milliseconds'});

/** Bounds are published so a caller can see the ceiling it is being held to, rather than discovering it by refusal. */
export const ENVELOPE_LIMITS = Object.freeze({maxCapabilities: 32, maxInputs: 64, maxWriteScopes: 64, maxResourceKinds: 8, maxLabelLength: 512, maxNestingDepth: 8});

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const ref = value => text(value) && value.length <= 256;
/** A provider reference is an IDENTIFIER. Free text is refused so a command line cannot travel inside an envelope. */
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const providerRef = value => text(value) && IDENTIFIER.test(value);

/** Depth and size are bounded before anything else looks at the value, so a hostile payload cannot cost unbounded work. */
function assertBounded(value, {depth = 0, seen = new Set()} = {}) {
  ok(depth <= ENVELOPE_LIMITS.maxNestingDepth, 'ENVELOPE_NESTING_EXCEEDED');
  if (value === null || typeof value !== 'object') return;
  ok(!seen.has(value), 'ENVELOPE_CYCLE');
  seen.add(value);
  if (Array.isArray(value)) { ok(value.length <= ENVELOPE_LIMITS.maxInputs * 4, 'ENVELOPE_ARRAY_TOO_LONG'); for (const item of value) assertBounded(item, {depth: depth + 1, seen}); }
  else { ok(isPlainObject(value), 'ENVELOPE_PLAIN_DATA_REQUIRED'); for (const [key, item] of Object.entries(value)) { ok(key.length <= 128, 'ENVELOPE_KEY_TOO_LONG'); assertBounded(item, {depth: depth + 1, seen}); } }
  seen.delete(value);
}

/**
 * Normalize a versioned workload envelope.
 *
 * `executor` names a provider contract (PCF-725) rather than a shell string, so an envelope can never smuggle a command
 * line through. `consent` is carried, not evaluated here: policy resolution belongs to PCF-706.
 */
export function normalizeWorkloadEnvelope(input) {
  ok(isPlainObject(input), 'ENVELOPE_PLAIN_DATA_REQUIRED');
  assertBounded(input);
  const e = {...input};
  // An UNKNOWN version is refused with its own code so a newer caller learns why instead of being coerced downward.
  ok(Number.isSafeInteger(e.envelopeVersion), 'ENVELOPE_VERSION_REQUIRED');
  ok(e.envelopeVersion === WORKLOAD_ENVELOPE_VERSION, 'ENVELOPE_VERSION_UNSUPPORTED');
  for (const key of ['taskId', 'actionId', 'originDeviceId', 'parentSessionId', 'appId']) ok(ref(e[key]), 'ENVELOPE_' + key.toUpperCase() + '_REQUIRED');
  ok(ref(e.targetDeviceRef) || e.targetDeviceRef === null, 'ENVELOPE_TARGET_INVALID');
  ok(isPlainObject(e.executor) && providerRef(e.executor.providerRef) && Number.isSafeInteger(e.executor.providerVersion) && e.executor.providerVersion > 0, 'ENVELOPE_EXECUTOR_REQUIRED');
  // A provider manifest reference is what makes capability claims checkable later; a bare string is not a manifest.
  ok(ref(e.executor.providerManifestRef), 'ENVELOPE_EXECUTOR_MANIFEST_REQUIRED');
  for (const key of ['inputSchema', 'outputSchema']) ok(ref(e[key]), 'ENVELOPE_' + key.toUpperCase() + '_REQUIRED');
  ok(strings(e.capabilities) && e.capabilities.length > 0 && e.capabilities.length <= ENVELOPE_LIMITS.maxCapabilities, 'ENVELOPE_CAPABILITIES_REQUIRED');
  ok(Array.isArray(e.inputRefs) && e.inputRefs.length <= ENVELOPE_LIMITS.maxInputs && e.inputRefs.every(ref), 'ENVELOPE_INPUT_REFS_INVALID');
  ok(strings(e.writeScope) && e.writeScope.length <= ENVELOPE_LIMITS.maxWriteScopes, 'ENVELOPE_WRITE_SCOPE_INVALID');
  ok(isPlainObject(e.platform) && strings(e.platform.os) && strings(e.platform.arch), 'ENVELOPE_PLATFORM_REQUIRED');
  ok(QOS_CLASSES.includes(e.qos), 'ENVELOPE_QOS_UNKNOWN');
  ok(RETRY_SAFETY.includes(e.retrySafety), 'ENVELOPE_RETRY_SAFETY_UNKNOWN');
  ok(['PUBLIC', 'PERSONAL', 'CONFIDENTIAL'].includes(e.dataScope), 'ENVELOPE_DATA_SCOPE_UNKNOWN');
  // A checkpoint claim must be backed by a provider capability reference; self-declaration is not evidence.
  if (e.retrySafety === 'CHECKPOINT_RESUMABLE') ok(ref(e.checkpointCapabilityRef), 'ENVELOPE_CHECKPOINT_CAPABILITY_REQUIRED');
  ok(isPlainObject(e.consent) && typeof e.consent.required === 'boolean' && (e.consent.required ? ref(e.consent.scopeRef) : e.consent.scopeRef === null), 'ENVELOPE_CONSENT_REQUIRED');

  // Resources: each declared kind carries its unit, and a unit that disagrees with the published table is a conflict.
  ok(isPlainObject(e.resources) && Object.keys(e.resources).length > 0 && Object.keys(e.resources).length <= ENVELOPE_LIMITS.maxResourceKinds, 'ENVELOPE_RESOURCES_REQUIRED');
  const resources = {};
  for (const [kind, requirement] of Object.entries(e.resources)) {
    ok(Object.hasOwn(RESOURCE_UNITS, kind), 'ENVELOPE_RESOURCE_KIND_UNKNOWN:' + kind);
    ok(isPlainObject(requirement) && finite(requirement.amount) && requirement.amount >= 0, 'ENVELOPE_RESOURCE_AMOUNT_INVALID:' + kind);
    ok(ref(requirement.unit), 'ENVELOPE_RESOURCE_UNIT_REQUIRED:' + kind);
    ok(requirement.unit === RESOURCE_UNITS[kind], 'ENVELOPE_RESOURCE_UNIT_CONFLICT:' + kind + ':expected ' + RESOURCE_UNITS[kind]);
    resources[kind] = {amount: requirement.amount, unit: requirement.unit};
  }

  // A deadline without a miss policy is an unfinished request, and a soft deadline MUST NOT be silently defaulted.
  ok(e.deadlineAt === null || finite(e.deadlineAt), 'ENVELOPE_DEADLINE_INVALID');
  if (e.deadlineAt !== null) ok(MISS_POLICIES.includes(e.missPolicy), 'ENVELOPE_MISS_POLICY_REQUIRED');
  else ok(e.missPolicy === null, 'ENVELOPE_MISS_POLICY_WITHOUT_DEADLINE');

  // A privilege request that names no verified handle is refused rather than carried hopefully.
  ok(Array.isArray(e.privilegeRequests) && e.privilegeRequests.every(p => isPlainObject(p) && ref(p.name) && ref(p.verifiedHandleRef)), 'ENVELOPE_PRIVILEGE_UNVERIFIED');

  const labels = e.labels ?? {};
  ok(isPlainObject(labels) && Object.values(labels).every(v => typeof v === 'string' && v.length <= ENVELOPE_LIMITS.maxLabelLength), 'ENVELOPE_LABELS_INVALID');

  return freeze({
    envelopeVersion: WORKLOAD_ENVELOPE_VERSION,
    taskId: e.taskId, actionId: e.actionId, originDeviceId: e.originDeviceId, parentSessionId: e.parentSessionId, appId: e.appId,
    targetDeviceRef: e.targetDeviceRef ?? null,
    executor: {providerRef: e.executor.providerRef, providerVersion: e.executor.providerVersion, providerManifestRef: e.executor.providerManifestRef},
    inputSchema: e.inputSchema, outputSchema: e.outputSchema, capabilities: [...e.capabilities], inputRefs: [...e.inputRefs], writeScope: [...e.writeScope],
    platform: {os: [...e.platform.os], arch: [...e.platform.arch]},
    resources, qos: e.qos, deadlineAt: e.deadlineAt ?? null, missPolicy: e.missPolicy ?? null,
    retrySafety: e.retrySafety, ...(e.checkpointCapabilityRef ? {checkpointCapabilityRef: e.checkpointCapabilityRef} : {}),
    dataScope: e.dataScope, consent: {required: e.consent.required, scopeRef: e.consent.scopeRef ?? null},
    privilegeRequests: e.privilegeRequests.map(p => ({name: p.name, verifiedHandleRef: p.verifiedHandleRef})),
    labels: {...labels},
  });
}

/** The QoS class as an independent, testable capability statement - not a latency promise. */
export function qosCapability(envelope) {
  const e = normalizeWorkloadEnvelope(envelope);
  const guaranteed = false; // this project publishes NO hard real-time guarantee, so it says so explicitly
  return freeze({qos: e.qos, hardRealTimeGuarantee: guaranteed, deadlineAt: e.deadlineAt, missPolicy: e.missPolicy,
    statement: e.deadlineAt === null ? 'no deadline declared' : `deadline with explicit miss policy ${e.missPolicy}`});
}

/** The declared retry-safety capabilities, with the backing reference where a claim requires one. */
export function retrySafetyCapabilities(envelope) {
  const e = normalizeWorkloadEnvelope(envelope);
  return freeze({retrySafety: e.retrySafety, checkpointResumable: e.retrySafety === 'CHECKPOINT_RESUMABLE',
    checkpointCapabilityRef: e.checkpointCapabilityRef ?? null,
    selfDeclaredOnly: e.retrySafety === 'CHECKPOINT_RESUMABLE' && !e.checkpointCapabilityRef});
}

/**
 * A legacy task (the shape `normalizeWorkload` accepts) has no envelope fields. It must keep its ORIGINAL behaviour, so
 * this reports that the envelope extension is absent instead of inventing one for it.
 */
export function envelopeExtensionOf(legacyTask = {}) {
  // Only fields that exist SOLELY on the envelope count. `inputSchema`/`outputSchema` are shared with the legacy shape,
  // so including them classified every legacy task as already extended - a defect my own test caught.
  const identifying = ['envelopeVersion', 'executor', 'retrySafety', 'privilegeRequests', 'envelopeLabels'];
  const present = identifying.filter(key => Object.hasOwn(legacyTask, key));
  const legacy = !Object.hasOwn(legacyTask, 'envelopeVersion') && !Object.hasOwn(legacyTask, 'executor') && !Object.hasOwn(legacyTask, 'retrySafety');
  return freeze({legacy, presentFields: present, envelope: null});
}

/**
 * An ExecutionAttempt: one try at an envelope, bound to the exact provider/epoch it ran under. Ordering is by epoch and
 * attempt number so a late report from an older epoch is identifiable rather than silently accepted.
 */
export function createExecutionAttempt(envelope, {attemptRef, epoch, executorDeviceRef, bootRef, startedAt, fence = null} = {}) {
  const e = normalizeWorkloadEnvelope(envelope);
  ok(ref(attemptRef), 'ATTEMPT_REF_REQUIRED');
  ok(Number.isSafeInteger(epoch) && epoch >= 0, 'ATTEMPT_EPOCH_REQUIRED');
  ok(ref(executorDeviceRef), 'ATTEMPT_EXECUTOR_REQUIRED');
  ok(ref(bootRef), 'ATTEMPT_BOOT_REQUIRED');
  ok(finite(startedAt), 'ATTEMPT_START_REQUIRED');
  // The attempt inherits the envelope's identity: it may not restate a different task, action or origin.
  return freeze({
    attemptVersion: WORKLOAD_ENVELOPE_VERSION,
    attemptRef, epoch, taskId: e.taskId, actionId: e.actionId, originDeviceId: e.originDeviceId, parentSessionId: e.parentSessionId,
    executor: {...e.executor}, executorDeviceRef, bootRef, startedAt,
    inputRefs: [...e.inputRefs], writeScope: [...e.writeScope], outputSchema: e.outputSchema, retrySafety: e.retrySafety,
    fence,
  });
}

/** A late report is one whose epoch or attempt does not match the live attempt. It is refused, never merged. */
export function assertAttemptCurrent(attempt, liveAttempt) {
  ok(attempt && liveAttempt && attempt.attemptRef === liveAttempt.attemptRef, 'ATTEMPT_UNKNOWN');
  ok(attempt.epoch === liveAttempt.epoch, 'ATTEMPT_STALE_EPOCH:' + attempt.epoch + '!=' + liveAttempt.epoch);
  return true;
}
