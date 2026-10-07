// PCF-708 acceptance: the versioned workload envelope and execution attempt.
//
// Every requirement here is checked in BOTH directions: the envelope that satisfies it is accepted, and the input that
// violates it is refused BY NAME. A validator that only ever sees good input proves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKLOAD_ENVELOPE_VERSION, QOS_CLASSES, MISS_POLICIES, RETRY_SAFETY, RESOURCE_UNITS, ENVELOPE_LIMITS,
  normalizeWorkloadEnvelope, qosCapability, retrySafetyCapabilities, envelopeExtensionOf, createExecutionAttempt, assertAttemptCurrent,
} from '../services/personal-compute-fabric/workload-envelope.mjs';
import {normalizeWorkload} from '../services/personal-compute-fabric/workload.mjs';

const SHA = 'a'.repeat(40);
const draft = overrides => ({
  envelopeVersion: WORKLOAD_ENVELOPE_VERSION,
  taskId: 'T-1', actionId: 'A-1', originDeviceId: 'dev-origin', parentSessionId: 'sess-1', appId: 'cpu-sort',
  targetDeviceRef: null,
  executor: {providerRef: 'pcf-fixed-cpu-v1', providerVersion: 1, providerManifestRef: 'manifest:' + SHA},
  inputSchema: 'cpu-json-v1', outputSchema: 'json',
  capabilities: ['cpu.json'], inputRefs: ['artifact:input'], writeScope: [],
  platform: {os: ['win32'], arch: ['x64']},
  resources: {cpu: {amount: 1000, unit: 'millicores'}, memory: {amount: 1048576, unit: 'bytes'}},
  qos: 'BATCH', deadlineAt: null, missPolicy: null,
  retrySafety: 'SIDE_EFFECT_FREE', dataScope: 'PUBLIC',
  consent: {required: false, scopeRef: null},
  privilegeRequests: [],
  ...overrides,
});
const refusal = (overrides, code) => assert.throws(() => normalizeWorkloadEnvelope(draft(overrides)), new RegExp(code), `expected refusal ${code}`);

test('PCF708-01 a complete envelope is accepted and frozen, and every declared requirement survives normalization', () => {
  const envelope = normalizeWorkloadEnvelope(draft());
  assert.equal(envelope.envelopeVersion, WORKLOAD_ENVELOPE_VERSION);
  assert.equal(envelope.taskId, 'T-1');
  assert.deepEqual(envelope.resources.cpu, {amount: 1000, unit: 'millicores'});
  assert.ok(Object.isFrozen(envelope), 'an accepted envelope is frozen so a later stage cannot mutate it');
  assert.deepEqual(envelope.platform, {os: ['win32'], arch: ['x64']});
});

test('PCF708-02 QoS is one of the four classes, and a deadline without an explicit miss policy is refused', () => {
  assert.deepEqual(QOS_CLASSES, ['INTERACTIVE', 'SOFT_DEADLINE', 'BATCH', 'BACKGROUND']);
  for (const qos of QOS_CLASSES) assert.equal(normalizeWorkloadEnvelope(draft({qos})).qos, qos);
  refusal({qos: 'REALTIME'}, 'ENVELOPE_QOS_UNKNOWN');
  // A soft deadline MUST NOT be silently defaulted: the caller says what a miss means.
  refusal({qos: 'SOFT_DEADLINE', deadlineAt: Date.now() + 1000}, 'ENVELOPE_MISS_POLICY_REQUIRED');
  const soft = normalizeWorkloadEnvelope(draft({qos: 'SOFT_DEADLINE', deadlineAt: Date.now() + 1000, missPolicy: 'REFUSE'}));
  assert.equal(soft.missPolicy, 'REFUSE');
  // A miss policy with no deadline is equally unfinished.
  refusal({missPolicy: 'REFUSE'}, 'ENVELOPE_MISS_POLICY_WITHOUT_DEADLINE');
  for (const missPolicy of MISS_POLICIES) assert.equal(normalizeWorkloadEnvelope(draft({deadlineAt: Date.now() + 1000, missPolicy})).missPolicy, missPolicy);
});

test('PCF708-03 this project publishes NO hard real-time guarantee, and says so instead of implying one', () => {
  const capability = qosCapability(draft({qos: 'INTERACTIVE', deadlineAt: Date.now() + 50, missPolicy: 'DEGRADE'}));
  assert.equal(capability.hardRealTimeGuarantee, false);
  assert.equal(capability.qos, 'INTERACTIVE');
  assert.match(capability.statement, /explicit miss policy DEGRADE/);
  assert.match(qosCapability(draft()).statement, /no deadline declared/);
});

test('PCF708-04 retry safety is an independent declared capability, and a checkpoint claim needs a provider reference', () => {
  assert.deepEqual(RETRY_SAFETY, ['SIDE_EFFECT_FREE', 'IDEMPOTENT_KEYED', 'CHECKPOINT_RESUMABLE', 'NON_RETRYABLE', 'UNKNOWN_EFFECT']);
  for (const retrySafety of RETRY_SAFETY.filter(x => x !== 'CHECKPOINT_RESUMABLE')) {
    assert.equal(retrySafetyCapabilities(draft({retrySafety})).retrySafety, retrySafety);
  }
  // A worker claiming "I can checkpoint" is NOT evidence, so the claim requires a capability reference.
  refusal({retrySafety: 'CHECKPOINT_RESUMABLE'}, 'ENVELOPE_CHECKPOINT_CAPABILITY_REQUIRED');
  const declared = retrySafetyCapabilities(draft({retrySafety: 'CHECKPOINT_RESUMABLE', checkpointCapabilityRef: 'cap:' + SHA}));
  assert.equal(declared.checkpointResumable, true);
  assert.equal(declared.selfDeclaredOnly, false);
  refusal({retrySafety: 'MAYBE'}, 'ENVELOPE_RETRY_SAFETY_UNKNOWN');
});

test('PCF708-05 an unknown schema version, a unit conflict and a malformed resource requirement are typed refusals', () => {
  refusal({envelopeVersion: 99}, 'ENVELOPE_VERSION_UNSUPPORTED');
  refusal({envelopeVersion: '2'}, 'ENVELOPE_VERSION_REQUIRED');
  // A requirement without a unit is not a requirement.
  refusal({resources: {cpu: {amount: 1}}}, 'ENVELOPE_RESOURCE_UNIT_REQUIRED:cpu');
  // The unit must be the published one for that kind, or the numbers cannot be compared at all.
  refusal({resources: {memory: {amount: 1, unit: 'megabytes'}}}, 'ENVELOPE_RESOURCE_UNIT_CONFLICT:memory');
  assert.equal(RESOURCE_UNITS.memory, 'bytes');
  refusal({resources: {gpu: {amount: 1, unit: 'devices'}}}, 'ENVELOPE_RESOURCE_KIND_UNKNOWN:gpu');
  refusal({resources: {cpu: {amount: 'lots', unit: 'millicores'}}}, 'ENVELOPE_RESOURCE_AMOUNT_INVALID:cpu');
  refusal({resources: {}}, 'ENVELOPE_RESOURCES_REQUIRED');
  refusal({resources: {cpu: {amount: -1, unit: 'millicores'}}}, 'ENVELOPE_RESOURCE_AMOUNT_INVALID:cpu');
});

test('PCF708-06 an unverified privilege request is refused, and payload size and nesting are bounded', () => {
  // A privilege request that names no verified handle is refused rather than carried hopefully.
  refusal({privilegeRequests: [{name: 'filesystem.write'}]}, 'ENVELOPE_PRIVILEGE_UNVERIFIED');
  assert.equal(normalizeWorkloadEnvelope(draft({privilegeRequests: [{name: 'filesystem.write', verifiedHandleRef: 'handle:1'}]})).privilegeRequests.length, 1);
  // Depth is bounded before anything else inspects the value.
  let deep = {leaf: true};
  for (let i = 0; i < ENVELOPE_LIMITS.maxNestingDepth + 3; i += 1) deep = {nested: deep};
  refusal({labels: {tooDeep: deep}}, 'ENVELOPE_NESTING_EXCEEDED');
  // A cyclic payload cannot be walked forever.
  const cyclic = {name: 'x'};
  cyclic.self = cyclic;
  refusal({labels: {cyclic}}, 'ENVELOPE_CYCLE');
});

test('PCF708-07 the executor is a provider contract, never a command line, and consent is carried not evaluated', () => {
  refusal({executor: {providerRef: 'pcf-fixed-cpu-v1', providerVersion: 1}}, 'ENVELOPE_EXECUTOR_MANIFEST_REQUIRED');
  refusal({executor: {providerRef: 'sh -c "rm -rf /"', providerVersion: 1, providerManifestRef: 'manifest:x'}}, 'ENVELOPE_EXECUTOR_REQUIRED');
  refusal({executor: {providerRef: 'p', providerVersion: 0, providerManifestRef: 'manifest:x'}}, 'ENVELOPE_EXECUTOR_REQUIRED');
  refusal({consent: {required: true}}, 'ENVELOPE_CONSENT_REQUIRED');
  assert.equal(normalizeWorkloadEnvelope(draft({consent: {required: true, scopeRef: 'consent:1'}})).consent.scopeRef, 'consent:1');
});

test('PCF708-08 a LEGACY task keeps its original behaviour and is never given an invented envelope', () => {
  // The exact shape the legacy normalizer accepts, with none of the extension fields.
  const legacy = {version: 1, taskId: 'T-1', actionId: 'A-1', originDeviceId: 'dev-origin', parentSessionId: 'sess-1', appId: 'cpu-sort', kind: 'CPU_JSON',
    capabilities: ['cpu.json'], inputRefs: ['artifact:input'], writeScope: [], resources: {cpu: 1, memory: 1048576}, dataScope: 'PUBLIC', qos: 'BATCH',
    retryClass: 'PURE', outputSchema: 'json', deadlineAt: Date.now() + 60000};
  const normalized = normalizeWorkload(legacy); // unchanged behaviour: this still succeeds exactly as before
  assert.equal(normalized.version, 1);
  const extension = envelopeExtensionOf(legacy);
  assert.equal(extension.legacy, true, 'a legacy task reports NO envelope instead of a fabricated one');
  assert.deepEqual(extension.presentFields, []);
  assert.equal(extension.envelope, null);
  // The legacy normalizer is untouched: it still refuses its own invalid inputs with its own codes.
  assert.throws(() => normalizeWorkload({...legacy, qos: 'REALTIME'}), /QOS_UNKNOWN/);
});

test('PCF708-09 an attempt is bound to its envelope identity, epoch and boot, and a stale epoch is refused', () => {
  const envelope = normalizeWorkloadEnvelope(draft());
  const attempt = createExecutionAttempt(envelope, {attemptRef: 'att-1', epoch: 3, executorDeviceRef: 'dev-exec', bootRef: 'boot-1', startedAt: 1000});
  assert.equal(attempt.taskId, envelope.taskId);
  assert.equal(attempt.actionId, envelope.actionId);
  assert.equal(attempt.originDeviceId, envelope.originDeviceId, 'the attempt cannot restate a different origin');
  assert.equal(attempt.epoch, 3);
  assert.throws(() => createExecutionAttempt(envelope, {attemptRef: 'att-1', epoch: -1, executorDeviceRef: 'd', bootRef: 'b', startedAt: 1}), /ATTEMPT_EPOCH_REQUIRED/);
  assert.throws(() => createExecutionAttempt(envelope, {attemptRef: 'att-1', epoch: 0, executorDeviceRef: 'd', bootRef: null, startedAt: 1}), /ATTEMPT_BOOT_REQUIRED/);
  // A late report from an older epoch is identifiable rather than silently accepted.
  assert.equal(assertAttemptCurrent(attempt, attempt), true);
  assert.throws(() => assertAttemptCurrent({...attempt, epoch: 2}, attempt), /ATTEMPT_STALE_EPOCH/);
  assert.throws(() => assertAttemptCurrent({...attempt, attemptRef: 'att-other'}, attempt), /ATTEMPT_UNKNOWN/);
});
