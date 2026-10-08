// PCF-708 acceptance (workbook-named file): the versioned WorkloadEnvelope, the ExecutionAttempt, and legacy survival.
//
// The workbook's own acceptance paragraph is the contract here: a legacy task round-trips with its identity and
// semantics intact; providerRef/handoffTargetRef are NOT treated as a strict target; empty, negative and infinite
// resources, a past deadline, an unknown enum, a fake control-worker capability and an oversized payload are all
// handled correctly. The deeper per-field suite lives in tests/pcf708-workload-envelope.test.mjs; this file is the one
// the workbook names, and it is written from the refusing side wherever a refusal is what "correct" means.
import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKLOAD_ENVELOPE_VERSION, QOS_CLASSES, MISS_POLICIES, RETRY_SAFETY, ENVELOPE_FIELDS, ENVELOPE_LIMITS, RESOURCE_UNITS,
  normalizeWorkloadEnvelope, envelopeExtensionOf, createExecutionAttempt, assertAttemptCurrent} from '../services/personal-compute-fabric/workload-envelope.mjs';
import {normalizeWorkload} from '../services/personal-compute-fabric/workload.mjs';
import {compileExecutionCapsule} from '../services/personal-compute-fabric/execution-capsule.mjs';
import {resolveEffectivePolicy} from '../services/personal-compute-fabric/policy.mjs';

const envelope = (overrides = {}) => ({
  envelopeVersion: WORKLOAD_ENVELOPE_VERSION,
  taskId: 'T-1', actionId: 'A-1', originDeviceId: 'dev-origin', parentSessionId: 'sess-1', appId: 'cpu-sort', targetDeviceRef: null,
  executor: {providerRef: 'pcf-fixed-cpu-v1', providerVersion: 1, providerManifestRef: 'manifest:' + 'a'.repeat(40)},
  inputSchema: 'cpu-json-v1', outputSchema: 'json', capabilities: ['cpu.json'], inputRefs: ['artifact:input'], writeScope: [],
  platform: {os: ['win32'], arch: ['x64']}, resources: {cpu: {amount: 1000, unit: 'millicores'}}, qos: 'BATCH', deadlineAt: null, missPolicy: null,
  retrySafety: 'SIDE_EFFECT_FREE', dataScope: 'PUBLIC', consent: {required: false, scopeRef: null}, privilegeRequests: [], ...overrides,
});
const legacy = {version: 1, taskId: 'T-legacy', actionId: 'A-legacy', originDeviceId: 'dev-origin', parentSessionId: 'sess-legacy', appId: 'app',
  kind: 'CPU_JSON', capabilities: ['cpu.json'], resources: {cpu: 1}, dataScope: 'PUBLIC', qos: 'BATCH', retryClass: 'PURE', inputRefs: [], writeScope: [],
  outputSchema: 'json', deadlineAt: 4000, targetDeviceRef: null, providerRef: 'pcf-fixed-cpu-v1', handoffTargetRef: 'worker-node-7'};

test('PCF708-01 a legacy task round-trips with its identity and semantics intact, and its missing extension is reported', () => {
  const normalized = normalizeWorkload(legacy);
  for (const key of ['taskId', 'actionId', 'originDeviceId', 'parentSessionId', 'appId', 'kind', 'dataScope', 'qos', 'inputRefs', 'writeScope']) {
    assert.deepEqual(normalized[key], legacy[key], key + ' must survive the round trip unchanged');
  }
  const extension = envelopeExtensionOf(legacy);
  assert.equal(extension.legacy, true, 'a task with no envelope fields is LEGACY, not silently upgraded');
  assert.equal(extension.envelope, null, 'no envelope is invented for it');
  assert.deepEqual(extension.presentFields, []);
  // An envelope task is not legacy, and the fields that exist only on the envelope are what decides that.
  assert.equal(envelopeExtensionOf(envelope()).legacy, false);
  assert.deepEqual(envelopeExtensionOf(envelope()).presentFields, ['envelopeVersion', 'executor', 'retrySafety', 'privilegeRequests']);
  // inputSchema/outputSchema are shared with the legacy shape, so they must NOT be the discriminator.
  assert.equal(envelopeExtensionOf({...legacy, inputSchema: 'cpu-json-v1', outputSchema: 'json'}).legacy, true);
});

test('PCF708-02 providerRef and handoffTargetRef are not strict targets', () => {
  // The envelope's targetDeviceRef stays what the caller declared; nothing reinterprets a provider or handoff ref as one.
  assert.equal(normalizeWorkloadEnvelope(envelope()).targetDeviceRef, null);
  assert.equal(normalizeWorkloadEnvelope(envelope({targetDeviceRef: 'dev-node-7'})).targetDeviceRef, 'dev-node-7');
  const normalizedLegacy = normalizeWorkload(legacy);
  assert.notEqual(normalizedLegacy.targetDeviceRef, 'pcf-fixed-cpu-v1');
  assert.notEqual(normalizedLegacy.targetDeviceRef, 'worker-node-7');
  // A strict target is only ever the declared targetDeviceRef, so a provider/handoff ref cannot pin a placement.
  const pinned = normalizeWorkloadEnvelope(envelope({targetDeviceRef: 'dev-node-7'}));
  assert.equal(pinned.targetDeviceRef, 'dev-node-7');
  assert.equal(pinned.executor.providerRef, 'pcf-fixed-cpu-v1');
  assert.notEqual(pinned.targetDeviceRef, pinned.executor.providerRef);
});

test('PCF708-03 resources must be real, unit-consistent amounts - empty, negative and infinite are all refused', () => {
  const cases = [
    [{resources: undefined}, /ENVELOPE_RESOURCES_REQUIRED/],
    [{resources: {}}, /ENVELOPE_RESOURCES_REQUIRED/],
    [{resources: {cpu: {amount: -1, unit: 'millicores'}}}, /ENVELOPE_RESOURCE_AMOUNT_INVALID/],
    [{resources: {cpu: {amount: Infinity, unit: 'millicores'}}}, /ENVELOPE_RESOURCE_AMOUNT_INVALID/],
    [{resources: {cpu: {amount: NaN, unit: 'millicores'}}}, /ENVELOPE_RESOURCE_AMOUNT_INVALID/],
    [{resources: {cpu: {amount: '1000', unit: 'millicores'}}}, /ENVELOPE_RESOURCE_AMOUNT_INVALID/],
    [{resources: {cpu: {amount: 1}}}, /ENVELOPE_RESOURCE_UNIT_REQUIRED/],
    [{resources: {cpu: {amount: 1, unit: 'cores'}}}, /ENVELOPE_RESOURCE_UNIT_CONFLICT/],
    [{resources: {gpu: {amount: 1, unit: 'devices'}}}, /ENVELOPE_RESOURCE_KIND_UNKNOWN/],
  ];
  for (const [override, expected] of cases) assert.throws(() => normalizeWorkloadEnvelope(envelope(override)), expected, JSON.stringify(override));
  // Zero is an amount, not a missing one: it is accepted, because "no memory beyond the weights" is a real declaration.
  assert.equal(normalizeWorkloadEnvelope(envelope({resources: {cpu: {amount: 0, unit: 'millicores'}}})).resources.cpu.amount, 0);
  assert.deepEqual(RESOURCE_UNITS.cpu, 'millicores');
});

test('PCF708-04 an unknown enum, a past deadline and a fake control-worker capability are each handled correctly', () => {
  for (const qos of QOS_CLASSES) assert.equal(normalizeWorkloadEnvelope(envelope({qos})).qos, qos);
  // CHECKPOINT_RESUMABLE is the one capability that must carry a backing reference, so it is given one here and
  // asserted as a refusal without one in PCF708-05.
  for (const retrySafety of RETRY_SAFETY) {
    const extra = retrySafety === 'CHECKPOINT_RESUMABLE' ? {checkpointCapabilityRef: 'capability:checkpoint-v1'} : {};
    assert.equal(normalizeWorkloadEnvelope(envelope({retrySafety, ...extra})).retrySafety, retrySafety);
  }
  for (const missPolicy of MISS_POLICIES) assert.equal(normalizeWorkloadEnvelope(envelope({deadlineAt: 4_000_000_000_000, missPolicy})).missPolicy, missPolicy);
  assert.deepEqual(QOS_CLASSES, ['INTERACTIVE', 'SOFT_DEADLINE', 'BATCH', 'BACKGROUND'], 'the four classes, and no latency promise among them');
  // A deadline with no miss policy is an unfinished request; a miss policy with no deadline is a contradiction.
  assert.throws(() => normalizeWorkloadEnvelope(envelope({deadlineAt: 4_000_000_000_000})), /ENVELOPE_MISS_POLICY_REQUIRED/);
  assert.throws(() => normalizeWorkloadEnvelope(envelope({deadlineAt: null, missPolicy: 'REFUSE'})), /ENVELOPE_MISS_POLICY_WITHOUT_DEADLINE/);
  // A NEGATIVE deadline is refused by the envelope...
  assert.throws(() => normalizeWorkloadEnvelope(envelope({deadlineAt: -1})), /ENVELOPE_DEADLINE_INVALID/);
  // ...and a deadline that has already PASSED is refused where a clock actually exists: the envelope is pure and has no
  // clock, so the refusal belongs to admission/capsule compilation, and that is where it is asserted.
  const now = Date.now();
  const past = normalizeWorkloadEnvelope(envelope({deadlineAt: now - 1000, missPolicy: 'REFUSE'}));
  const policy = resolveEffectivePolicy({}, {version: 1, authorized: true, expiresAt: now + 60000, originDeviceId: 'dev-origin', allowedDevices: ['dev-origin'],
    dataScopes: ['PUBLIC'], sharingConsent: false, cloudConsent: false, budget: 0}, now);
  assert.throws(() => compileExecutionCapsule(normalizeWorkload({...legacy, deadlineAt: now - 1000}), {attemptId: 'X', epoch: 1, executorDeviceId: 'dev-origin',
    bootId: 'boot', providerId: 'pcf-fixed-cpu-v1', inputDigest: 'a'.repeat(64), policy}, now), /DEADLINE_EXPIRED/);
  assert.ok(past.deadlineAt < now, 'the envelope carries the past deadline honestly instead of hiding it');
  // A control principal cannot be promoted into a worker: the normalized envelope is a CLOSED projection, so a
  // controller/worker-role field simply cannot travel into execution. Its key set is asserted, not assumed.
  const smuggled = normalizeWorkloadEnvelope(envelope({workerRole: 'WORKER', controlPrincipal: 'android:control-1', role: 'CONTROL'}));
  // checkpointCapabilityRef is the one declared field that only appears when it is actually declared, so the closed set
  // is compared with that condition made explicit rather than assumed.
  assert.deepEqual(Object.keys(smuggled).sort(), ENVELOPE_FIELDS.filter(key => key !== 'checkpointCapabilityRef').sort(), 'the envelope carries exactly its declared fields');
  assert.deepEqual(Object.keys(normalizeWorkloadEnvelope(envelope({retrySafety: 'CHECKPOINT_RESUMABLE', checkpointCapabilityRef: 'capability:checkpoint-v1'}))).sort(), [...ENVELOPE_FIELDS].sort());
  for (const forbidden of ['workerRole', 'controlPrincipal', 'role']) assert.equal(Object.hasOwn(smuggled, forbidden), false, forbidden + ' cannot be carried');
  assert.equal(Object.hasOwn(smuggled, 'capabilities'), true, 'the only way to declare worker ability is the capability list');
});

test('PCF708-05 a checkpoint claim needs a capability reference, and the retry-safety capabilities stay independent', () => {
  assert.deepEqual(RETRY_SAFETY, ['SIDE_EFFECT_FREE', 'IDEMPOTENT_KEYED', 'CHECKPOINT_RESUMABLE', 'NON_RETRYABLE', 'UNKNOWN_EFFECT']);
  // "I can checkpoint" is not evidence: the claim needs a backing capability reference.
  assert.throws(() => normalizeWorkloadEnvelope(envelope({retrySafety: 'CHECKPOINT_RESUMABLE'})), /ENVELOPE_CHECKPOINT_CAPABILITY_REQUIRED/);
  const backed = normalizeWorkloadEnvelope(envelope({retrySafety: 'CHECKPOINT_RESUMABLE', checkpointCapabilityRef: 'capability:checkpoint-v1'}));
  assert.equal(backed.checkpointCapabilityRef, 'capability:checkpoint-v1');
  // Each capability is declared independently: declaring one does not imply another.
  assert.equal(normalizeWorkloadEnvelope(envelope({retrySafety: 'SIDE_EFFECT_FREE'})).retrySafety, 'SIDE_EFFECT_FREE');
  assert.equal(normalizeWorkloadEnvelope(envelope({retrySafety: 'UNKNOWN_EFFECT'})).retrySafety, 'UNKNOWN_EFFECT', 'a known unknown is a first-class state');
  assert.throws(() => normalizeWorkloadEnvelope(envelope({retrySafety: 'PROBABLY_FINE'})), /ENVELOPE_RETRY_SAFETY_UNKNOWN/);
  // An unverified privilege request is refused rather than carried hopefully.
  assert.throws(() => normalizeWorkloadEnvelope(envelope({privilegeRequests: [{name: 'camera.raw'}]})), /ENVELOPE_PRIVILEGE_UNVERIFIED/);
  assert.equal(normalizeWorkloadEnvelope(envelope({privilegeRequests: [{name: 'filesystem.write', verifiedHandleRef: 'handle:1'}]})).privilegeRequests.length, 1);
});

test('PCF708-06 payload size, nesting depth and cyclic input are bounded before anything reads them', () => {
  assert.deepEqual(ENVELOPE_LIMITS.maxNestingDepth, 8);
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 40; index++) { cursor.child = {}; cursor = cursor.child; }
  assert.throws(() => normalizeWorkloadEnvelope(envelope({labels: {deep}})), /ENVELOPE_NESTING_EXCEEDED/);
  assert.throws(() => normalizeWorkloadEnvelope(envelope({labels: {long: 'x'.repeat(ENVELOPE_LIMITS.maxLabelLength + 1)}})), /ENVELOPE_LABELS_INVALID/);
  assert.throws(() => normalizeWorkloadEnvelope(envelope({capabilities: Array.from({length: ENVELOPE_LIMITS.maxCapabilities + 1}, (_, index) => 'cap-' + index)})), /ENVELOPE_CAPABILITIES_REQUIRED/);
  assert.throws(() => normalizeWorkloadEnvelope(envelope({inputRefs: Array.from({length: ENVELOPE_LIMITS.maxInputs + 1}, (_, index) => 'artifact:' + index)})), /ENVELOPE_INPUT_REFS_INVALID/);
  const cyclic = {name: 'x'};
  cyclic.self = cyclic;
  assert.throws(() => normalizeWorkloadEnvelope(envelope({labels: {cyclic}})), /ENVELOPE_CYCLE/);
  // A host object that is not plain data (a live handle, a class instance) is refused rather than walked.
  assert.throws(() => normalizeWorkloadEnvelope(envelope({labels: {when: new Date(0)}})), /ENVELOPE_PLAIN_DATA_REQUIRED/);
});

test('PCF708-07 version upgrade and downgrade are explicit: a future version is refused, a legacy task keeps its path', () => {
  assert.equal(WORKLOAD_ENVELOPE_VERSION, 2);
  assert.throws(() => normalizeWorkloadEnvelope(envelope({envelopeVersion: 1})), /ENVELOPE_VERSION_UNSUPPORTED/, 'the legacy number is not the envelope number');
  assert.throws(() => normalizeWorkloadEnvelope(envelope({envelopeVersion: 3})), /ENVELOPE_VERSION_UNSUPPORTED/, 'a newer caller is told why instead of being coerced');
  assert.throws(() => normalizeWorkloadEnvelope(envelope({envelopeVersion: undefined})), /ENVELOPE_VERSION_REQUIRED/);
  assert.throws(() => normalizeWorkloadEnvelope(envelope({envelopeVersion: '2'})), /ENVELOPE_VERSION_REQUIRED/);
  // The downgrade path is the legacy one: a task without the extension never enters the envelope contract at all.
  assert.equal(envelopeExtensionOf(legacy).legacy, true);
  assert.doesNotThrow(() => normalizeWorkload(legacy));
});

test('PCF708-08 the ExecutionAttempt inherits the envelope identity and a late report from another epoch is refused', () => {
  const e = normalizeWorkloadEnvelope(envelope());
  const attempt = createExecutionAttempt(e, {attemptRef: 'attempt-1', epoch: 4, executorDeviceRef: 'dev-origin', bootRef: 'boot-1', startedAt: 1000});
  assert.equal(attempt.taskId, e.taskId);
  assert.equal(attempt.actionId, e.actionId);
  assert.equal(attempt.originDeviceId, e.originDeviceId);
  assert.equal(attempt.parentSessionId, e.parentSessionId);
  assert.equal(attempt.epoch, 4);
  assert.deepEqual(attempt.executor, e.executor);
  assert.equal(assertAttemptCurrent(attempt, {...attempt}), true);
  // A report from an older epoch, or for an attempt nobody knows, is refused rather than merged.
  assert.throws(() => assertAttemptCurrent({...attempt, epoch: 3}, attempt), /ATTEMPT_STALE_EPOCH/);
  assert.throws(() => assertAttemptCurrent({...attempt, attemptRef: 'attempt-ghost'}, attempt), /ATTEMPT_UNKNOWN/);
  assert.throws(() => createExecutionAttempt(e, {attemptRef: 'attempt-1', epoch: -1, executorDeviceRef: 'dev-origin', bootRef: 'boot-1', startedAt: 1000}), /ATTEMPT_EPOCH_REQUIRED/);
  assert.throws(() => createExecutionAttempt(e, {attemptRef: 'attempt-1', epoch: 1, executorDeviceRef: '', bootRef: 'boot-1', startedAt: 1000}), /ATTEMPT_EXECUTOR_REQUIRED/);
  assert.throws(() => createExecutionAttempt(e, {attemptRef: 'attempt-1', epoch: 1, executorDeviceRef: 'dev-origin', bootRef: 'boot-1', startedAt: -1}), /ATTEMPT_START_REQUIRED/);
});
