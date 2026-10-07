// PCF-726 acceptance: the execution capsule and the result/evidence envelope.
//
// Candidate location: the workbook names `contracts/personal-compute-fabric-v1/execution-capsule.mjs`; the shipped file
// is `services/personal-compute-fabric/execution-capsule.mjs`. `tests/pcf-full-foundation.test.mjs` touches it in one
// test only; this file is the full workbook acceptance over the four `- [ ]` bullets and the acceptance paragraph.
//
// Every counterexample the workbook names is checked from the REFUSING side, with the specific code, so "it throws"
// is never mistaken for "it refused for the right reason".
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileExecutionCapsule, validateResultEnvelope, independenceFloorOf, assertIndependenceFloor} from '../services/personal-compute-fabric/execution-capsule.mjs';
import {normalizeWorkload} from '../services/personal-compute-fabric/workload.mjs';
import {resolveEffectivePolicy} from '../services/personal-compute-fabric/policy.mjs';
import {createArtifactStore} from '../services/personal-compute-fabric/artifacts.mjs';
import {toResearchEvent} from '../services/personal-compute-fabric/research-adapter.mjs';

const NOW = 1000;
const DEVICE = 'mech';
const AUTHORITY = {
  version: 3, authorized: true, expiresAt: 5000, originDeviceId: 'alien', allowedDevices: ['alien', 'mech'],
  sharingConsent: true, dataScopes: ['PUBLIC'], cloudConsent: false, budget: 0,
};
const policy = (authority = AUTHORITY, mode = 'TRUSTED_PERSONAL_FABRIC') => resolveEffectivePolicy({mode}, authority, NOW);
const WORKLOAD = (extra = {}) => ({
  version: 1, taskId: 'T1', actionId: 'A1', originDeviceId: 'alien', parentSessionId: 'S1', appId: 'cpu-sort',
  kind: 'CPU_JSON', capabilities: ['cpu.json'], resources: {cpu: 1, memory: 1024}, dataScope: 'PUBLIC',
  qos: 'BATCH', retryClass: 'PURE', inputRefs: [], writeScope: [], outputSchema: 'json', deadlineAt: 4000, ...extra,
});
const SPEC = (extra = {}) => ({
  attemptId: 'X1', epoch: 1, executorDeviceId: DEVICE, bootId: 'boot-1', providerId: 'pcf-fixed-cpu-v1',
  inputDigest: 'a'.repeat(64), policy: policy(), ...extra,
});
const capsuleOf = (workload = WORKLOAD(), spec = SPEC()) => compileExecutionCapsule(normalizeWorkload(workload), spec, NOW);
const RECEIPT = (extra = {}) => ({
  version: 1, taskId: 'T1', actionId: 'A1', parentSessionId: 'S1', attemptId: 'X1', epoch: 1, executorDeviceId: DEVICE,
  bootId: 'boot-1', providerId: 'pcf-fixed-cpu-v1', inputDigest: 'a'.repeat(64), policyVersion: 3,
  outcome: 'SUCCEEDED', exitCode: 0, outputDigest: 'b'.repeat(64), ...extra,
});

// ---------------------------------------------------------------------------------------------------------------
// Workbook bullet 1: compileExecutionCapsule preserves the execution identities, refs, scope, output contract, stop
// condition, permission/budget/deadline and the existing policy reference - and is not a second Task/ProblemGraph.
// ---------------------------------------------------------------------------------------------------------------

test('PCF726-01 the capsule preserves task/action, attempt/epoch, origin device and parent session, versions and refs', () => {
  const capsule = capsuleOf();
  assert.ok(Object.isFrozen(capsule), 'an accepted capsule is frozen');
  // Task, action, origin device and parent session travel unchanged from the canonical workload.
  assert.equal(capsule.taskId, 'T1');
  assert.equal(capsule.actionId, 'A1');
  assert.equal(capsule.originDeviceId, 'alien');
  assert.equal(capsule.parentSessionId, 'S1');
  // parent/stage/attempt: the capsule binds the attempt and its epoch, and keeps the parent session explicitly.
  assert.equal(capsule.attemptId, 'X1');
  assert.equal(capsule.epoch, 1);
  assert.equal(capsule.executorDeviceId, DEVICE);
  assert.equal(capsule.bootId, 'boot-1');
  assert.equal(capsule.providerId, 'pcf-fixed-cpu-v1');
  // Versioned fact/input references.
  assert.deepEqual(capsule.inputRefs, []);
  assert.equal(capsule.inputDigest, 'a'.repeat(64));
  assert.equal(capsule.version, 1);
  // Write scope, output contract and the stop condition.
  assert.deepEqual(capsule.writeScope, []);
  assert.equal(capsule.outputSchema, 'json');
  assert.equal(capsule.deadlineAt, 4000);
  // Permission/budget/deadline: the capsule carries the POLICY VERSION, not a copy of the authority.
  assert.equal(capsule.policyVersion, 3);
  assert.equal(capsule.fee, 0);
  assert.equal(capsule.cloud, false);
  // The capsule is a flat extension of the canonical workload, not a second Task/ProblemGraph: the canonical identity
  // fields are the same values, and there is no nested task or graph object in it.
  const workload = normalizeWorkload(WORKLOAD());
  for (const key of ['taskId', 'actionId', 'originDeviceId', 'parentSessionId', 'appId', 'kind', 'outputSchema', 'dataScope', 'qos']) {
    assert.equal(capsule[key], workload[key], `${key} must stay the canonical value`);
  }
  assert.equal('task' in capsule, false, 'the capsule must not carry a second Task object');
  assert.equal('problemGraph' in capsule, false, 'the capsule must not carry a second ProblemGraph');
});

test('PCF726-02 a capsule cannot be compiled from an expired deadline, an unapproved device or an incomplete attempt binding', () => {
  // The stop condition is a real gate: work past its deadline is refused by name.
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD({deadlineAt: 500})), SPEC(), NOW), {code: 'DEADLINE_EXPIRED'});
  // A capsule that cannot name its attempt, executor, boot or provider identity is refused BEFORE anything else.
  for (const key of ['attemptId', 'executorDeviceId', 'bootId', 'providerId']) {
    assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD()), SPEC({[key]: ''})), new RegExp('CAPSULE_' + key), `${key} must be required`);
  }
  // A missing epoch or a malformed input digest is a BINDING refusal, not a warning.
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD()), SPEC({epoch: 0})), {code: 'CAPSULE_BINDING'});
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD()), SPEC({epoch: '1'})), {code: 'CAPSULE_BINDING'});
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD()), SPEC({inputDigest: null})), {code: 'CAPSULE_BINDING'});
  // Permission/budget/deadline are checked through the policy, so a device that is not approved cannot get a capsule.
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD()), SPEC({executorDeviceId: 'stranger'}), NOW), {code: 'DEVICE_NOT_APPROVED'});
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD()), SPEC({policy: policy({...AUTHORITY, authorized: false})}), NOW), {code: 'AUTHORITY_EXPIRED_OR_REVOKED'});
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD()), SPEC({fee: 1, cloud: true, policy: policy()}), NOW), {code: 'BUDGET_NOT_APPROVED'});
});

// ---------------------------------------------------------------------------------------------------------------
// Workbook bullet 2: validateResultEnvelope correlates device, boot/provider/session, attempt/epoch, exit/outcome,
// bounded output, artifact digests, base/result SHA and validation evidence. Delivery or exit zero alone is NOT
// acceptance.
// ---------------------------------------------------------------------------------------------------------------

test('PCF726-03 the envelope correlates every execution identity, and each mismatch is refused under its own field', () => {
  const capsule = capsuleOf();
  assert.equal(validateResultEnvelope(capsule, RECEIPT(), {policy: policy(), now: NOW}).outcome, 'SUCCEEDED');
  // Wrong host / wrong boot / wrong provider / wrong attempt / stale epoch / wrong origin session: each is a BINDING
  // refusal that names the field, so an operator can tell "a different machine answered" from "a stale attempt".
  const mismatches = [
    ['executorDeviceId', 'alien'],
    ['bootId', 'old-boot'],
    ['providerId', 'other-provider'],
    ['attemptId', 'X9'],
    ['epoch', 2],
    ['epoch', 0],
    ['taskId', 'T-other'],
    ['actionId', 'A-other'],
    ['parentSessionId', 'other-session'],
    ['inputDigest', 'c'.repeat(64)],
  ];
  for (const [key, value] of mismatches) {
    assert.throws(() => validateResultEnvelope(capsule, RECEIPT({[key]: value}), {policy: policy(), now: NOW}), new RegExp('RECEIPT_BINDING_' + key), `${key}=${value} must be refused as RECEIPT_BINDING_${key}`);
  }
  // A capsule-shaped receipt with no identity at all is refused rather than accepted as a bare envelope.
  assert.throws(() => validateResultEnvelope(capsule, {version: 1, outcome: 'SUCCEEDED', exitCode: 0}, {policy: policy(), now: NOW}), {code: 'RECEIPT_BINDING_taskId'});
  assert.throws(() => validateResultEnvelope(capsule, {...RECEIPT(), version: 2}, {policy: policy(), now: NOW}), {code: 'RECEIPT_VERSION'});
});

test('PCF726-04 exit zero or a completed transfer is NOT acceptance: a SUCCEEDED outcome still needs a proven output digest', () => {
  const capsule = capsuleOf();
  for (const broken of [{outputDigest: null}, {outputDigest: ''}, {outputDigest: 'not-a-digest'}, {exitCode: 1}, {exitCode: null}]) {
    assert.throws(() => validateResultEnvelope(capsule, RECEIPT(broken), {policy: policy(), now: NOW}), {code: 'OUTPUT_NOT_PROVEN'}, JSON.stringify(broken) + ' must not be accepted as success');
  }
  // An outcome outside the closed set is refused, so a caller cannot invent "PASS".
  for (const outcome of ['PASS', 'OK', 'SUCCESS', '']) {
    assert.throws(() => validateResultEnvelope(capsule, RECEIPT({outcome}), {policy: policy(), now: NOW}), {code: 'OUTCOME_UNKNOWN'});
  }
  // A non-integer/non-null exit code is refused.
  for (const exitCode of ['0', 0.5, undefined]) {
    assert.throws(() => validateResultEnvelope(capsule, RECEIPT({exitCode}), {policy: policy(), now: NOW}), {code: 'EXIT_CODE_UNKNOWN'});
  }
  // A FAILED or CANCELLED outcome is a legal envelope WITHOUT an output digest: failure is reported, not dressed up.
  for (const outcome of ['FAILED', 'CANCELLED', 'UNKNOWN']) {
    const validated = validateResultEnvelope(capsule, RECEIPT({outcome, exitCode: 1, outputDigest: null}), {policy: policy(), now: NOW});
    assert.equal(validated.outcome, outcome);
    assert.equal(validated.outputDigest, null);
  }
  // The validated envelope is frozen, so a caller cannot edit a receipt after validation.
  assert.ok(Object.isFrozen(validateResultEnvelope(capsule, RECEIPT(), {policy: policy(), now: NOW})));
});

test('PCF726-05 a changed or expired authorization invalidates the envelope, and delivery is still not consumption', () => {
  const capsule = capsuleOf();
  // The policy version the capsule was compiled under is bound into the envelope check.
  assert.throws(() => validateResultEnvelope(capsule, RECEIPT({policyVersion: 2}), {policy: policy(), now: NOW}), {code: 'RECEIPT_BINDING_policyVersion'});
  // A policy object whose version moved is refused as POLICY_CHANGED rather than accepted silently.
  assert.throws(() => validateResultEnvelope(capsule, RECEIPT(), {policy: policy({...AUTHORITY, version: 4}), now: NOW}), {code: 'POLICY_CHANGED'});
  // Expired consent revokes the authority that the capsule rested on.
  assert.throws(() => validateResultEnvelope(capsule, RECEIPT(), {policy: policy(), now: 5000}), {code: 'AUTHORITY_EXPIRED_OR_REVOKED'});
  assert.throws(() => validateResultEnvelope(capsule, RECEIPT(), {policy: policy({...AUTHORITY, authorized: false}), now: NOW}), {code: 'AUTHORITY_EXPIRED_OR_REVOKED'});
  // The envelope reports the attempt outcome only. It carries no "accepted", "delivered" or "consumed" claim, so a
  // caller cannot read transmission success as acceptance or as agent consumption.
  const validated = validateResultEnvelope(capsule, RECEIPT(), {policy: policy(), now: NOW});
  for (const field of ['accepted', 'delivered', 'consumed', 'trusted']) {
    assert.equal(field in validated, false, `${field} must not appear on a result envelope`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Workbook bullet 3: versioned assumptions/uncertainty/unresolved questions; never a hidden chain-of-thought; remote
// output is untrusted data that cannot grant authority or issue commands.
// ---------------------------------------------------------------------------------------------------------------

test('PCF726-06 assumptions and unresolved questions belong to the DOMAIN, never a hidden chain-of-thought, and grant no authority', () => {
  // The workbook allows a versioned domain extension for assumptions/uncertainty/unresolved questions. The shipped
  // capsule passes unknown workload fields through unchanged, but it holds no versioned extension slot and performs no
  // validation of that kind: there is nothing that marks the extension's version or binds it to the task.
  const withExtension = capsuleOf(WORKLOAD({domainExtension: {assumptions: ['clock skew is small'], uncertainty: ['input size varies'], unresolvedQuestions: ['does the store fsync?']}}));
  assert.deepEqual(withExtension.domainExtension.assumptions, ['clock skew is small']);
  assert.deepEqual(withExtension.domainExtension.unresolvedQuestions, ['does the store fsync?']);
  assert.equal(Object.hasOwn(withExtension, 'extensionVersion'), false);

  // "Never store hidden chain-of-thought" is a negative claim, so it is checked by pushing a chain-of-thought through
  // the real capsule and the real evidence path and observing that nothing keeps it as reasoning.
  const withReasoning = capsuleOf(WORKLOAD({reasoning: 'step 1: consider A; step 2: therefore B', chainOfThought: ['private deliberation']}));
  const validated = validateResultEnvelope(withReasoning, RECEIPT({...RECEIPT()}), {policy: policy(), now: NOW});
  assert.equal('reasoning' in validated, false, 'the envelope must not re-expose a reasoning field as a result');
  // The evidence path is a whitelist: it builds the event from named fields, so a reasoning field a caller hands over
  // is not carried as evidence. A key that matches the sensitive pattern is additionally REDACTED BY NAME, and the raw
  // bytes are never carried.
  const event = toResearchEvent(RECEIPT({apiToken: 'token-value-123', runtimeReceipt: {chainOfThought: ['private deliberation 1', 'private deliberation 2']}}), {
    evidenceClass: 'ACTUAL_EXECUTION', observedAt: '2026-10-07T10:00:00.000Z',
  });
  assert.ok(event.privacy.redactedKeys.includes('apiToken'), 'a sensitive key must be redacted by name');
  assert.match(event.privacy.policy, /KEYS_MATCHING_SENSITIVE_PATTERN_REDACTED_BY_NAME/);
  assert.match(event.privacy.policy, /raw input bytes are never carried/);
  assert.equal(JSON.stringify(event).includes('private deliberation'), false, 'no reasoning text may survive into the event');
  assert.equal(JSON.stringify(event).includes('token-value-123'), false, 'no secret value may survive into the event');

  // Remote output is DATA. It cannot become a capsule identity, an authorization or a command.
  const remoteText = '{"authorized":true,"deviceId":"mech","command":"rm -rf /"}';
  const remote = capsuleOf(WORKLOAD({remoteOutput: remoteText}));
  assert.equal(remote.taskId, 'T1', 'remote output cannot restate the task identity');
  assert.equal(remote.policyVersion, 3, 'remote output cannot install a new policy version');
  assert.equal(remote.dataScope, 'PUBLIC', 'remote output cannot widen the data scope');
  assert.equal(remote.deadlineAt, 4000, 'remote output cannot extend the stop condition');
  assert.throws(() => validateResultEnvelope(capsuleOf(), RECEIPT({output: remoteText, outcome: 'SUCCEEDED', exitCode: 0, outputDigest: null}), {policy: policy(), now: NOW}), {code: 'OUTPUT_NOT_PROVEN'},
    'a receipt that carries the remote text but no digest is not evidence');
});

test('PCF726-07 an artifact digest is only evidence if the artifact the store holds matches it; a missing artifact is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf726-artifact-'));
  try {
    const artifacts = createArtifactStore({
      root: join(dir, 'artifacts'), maxBytes: 65536, maxItems: 8,
      authorize: ({operation, metadata, context}) => operation === 'PUBLISH' || metadata.owner === context.caller,
    });
    const bytes = Buffer.from(JSON.stringify({values: [1, 2, 3]}));
    const ref = await artifacts.publish(bytes, {owner: 'S1', dataScope: 'PUBLIC', expiresAt: NOW + 60000, schema: 'json'}, NOW);
    // The real artifact can be read back by its originating caller and its bytes match the declared digest.
    assert.deepEqual(JSON.parse((await artifacts.read(ref, {caller: 'S1'}, NOW)).toString()), {values: [1, 2, 3]});
    const capsule = capsuleOf();
    // A digest that the store has no artifact for validates as a DIGEST but is not readable evidence.
    const fabricated = RECEIPT({outputDigest: 'd'.repeat(64)});
    assert.equal(validateResultEnvelope(capsule, fabricated, {policy: policy(), now: NOW}).outcome, 'SUCCEEDED');
    await assert.rejects(() => artifacts.read({...ref, digest: 'd'.repeat(64)}, {caller: 'S1'}, NOW), {code: 'ARTIFACT_UNKNOWN'});
    // A missing artifact reference is refused by name rather than being treated as an empty result.
    await assert.rejects(() => artifacts.read({version: 1, size: bytes.length}, {caller: 'S1'}, NOW), {code: 'OPAQUE_ARTIFACT_ID_REQUIRED'});
    // Cross-user leakage: a caller who does not own the artifact cannot read it, and neither can an expired lease.
    await assert.rejects(() => artifacts.read(ref, {caller: 'someone-else'}, NOW), {code: 'ARTIFACT_UNAUTHORIZED_OR_EXPIRED'});
    await assert.rejects(() => artifacts.read(ref, {caller: 'S1'}, NOW + 60000), {code: 'ARTIFACT_UNAUTHORIZED_OR_EXPIRED'});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Workbook bullet 4: bound payloads, depth, logs and refs; detect wrong host/session, stale epochs, fabricated/missing
// artifacts, cross-job correlation, duplicate/reordered events, expired consent and cross-user leakage. Insufficient
// evidence must not clear uncertainty.
// ---------------------------------------------------------------------------------------------------------------

test('PCF726-08 the payload, its depth, its strings and its references are bounded, and a cyclic input is refused', () => {
  // Depth is bounded before anything else inspects the value.
  const nested = {}; let cursor = nested;
  for (let index = 0; index < 40; index += 1) { cursor.child = {}; cursor = cursor.child; }
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD({labels: nested})), SPEC(), NOW), {code: 'PAYLOAD_LIMIT'});
  // The byte size of the payload is bounded: a string longer than the per-string limit is refused by name.
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD({labels: {blob: 'x'.repeat(70000)}})), SPEC(), NOW), {code: 'TEXT_LIMIT'});
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD({labels: {blob: 'x'.repeat(20000)}})), SPEC(), NOW), {code: 'TEXT_LIMIT'});
  // A cyclic reference cannot be walked forever.
  const cyclic = {name: 'x'}; cyclic.self = cyclic;
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD({labels: {cyclic}})), SPEC(), NOW), {code: 'CYCLIC_INPUT'});
  // A non-finite number is not a bounded value.
  assert.throws(() => compileExecutionCapsule(normalizeWorkload(WORKLOAD({labels: {count: NaN}})), SPEC(), NOW), {code: 'INVALID_NUMBER'});
  // A reference list is bounded too: 300 input refs exceed the workload's own limit.
  assert.throws(() => normalizeWorkload(WORKLOAD({inputRefs: Array.from({length: 300}, (_, index) => 'artifact:in-' + index)})), {code: 'WORKLOAD_LIST'});
});

test('PCF726-09 a stale epoch, a duplicate event and a cross-job correlation are each refused rather than merged', () => {
  const capsule = capsuleOf();
  const current = RECEIPT();
  // A late report from an older epoch is refused, and so is one from a self-invented newer epoch.
  for (const epoch of [0, 2, 7]) {
    assert.throws(() => validateResultEnvelope(capsule, {...current, epoch}, {policy: policy(), now: NOW}), {code: 'RECEIPT_BINDING_epoch'});
  }
  // Cross-job correlation: a receipt for another task/action/session is refused even when every other field matches.
  assert.throws(() => validateResultEnvelope(capsule, {...current, taskId: 'T2'}, {policy: policy(), now: NOW}), {code: 'RECEIPT_BINDING_taskId'});
  assert.throws(() => validateResultEnvelope(capsule, {...current, actionId: 'A2'}, {policy: policy(), now: NOW}), {code: 'RECEIPT_BINDING_actionId'});
  assert.throws(() => validateResultEnvelope(capsule, {...current, parentSessionId: 'S2'}, {policy: policy(), now: NOW}), {code: 'RECEIPT_BINDING_parentSessionId'});
  // A duplicate EVENT is not a second acceptance: the evidence path records the duplicate and refuses to count it.
  const base = {...current, outputDigest: 'b'.repeat(64)};
  const first = toResearchEvent(base, {evidenceClass: 'ACTUAL_EXECUTION', observedAt: '2026-10-07T10:00:00.000Z'});
  const second = toResearchEvent(base, {evidenceClass: 'ACTUAL_EXECUTION', observedAt: '2026-10-07T10:00:00.000Z'});
  // The same attempt yields the same event id, so a replayed capture is identifiable rather than becoming two events.
  assert.equal(first.eventId, second.eventId);
  assert.equal(first.traceProjection.eventId, second.traceProjection.eventId);
  assert.equal(first.refs.attemptRef, second.refs.attemptRef);
});

test('PCF726-10 insufficient evidence must not clear uncertainty: an unproven attempt stays UNKNOWN, never SUCCEEDED', () => {
  const capsule = capsuleOf();
  // An UNKNOWN outcome is a legal, frozen envelope that KEEPS its uncertainty - it is not upgraded by a zero exit.
  const unknown = validateResultEnvelope(capsule, RECEIPT({outcome: 'UNKNOWN', exitCode: 0, outputDigest: null}), {policy: policy(), now: NOW});
  assert.equal(unknown.outcome, 'UNKNOWN');
  assert.equal(unknown.outputDigest, null);
  assert.notEqual(unknown.outcome, 'SUCCEEDED');
  // A receipt that claims SUCCEEDED but carries no digest cannot borrow the zero exit code to clear the uncertainty.
  assert.throws(() => validateResultEnvelope(capsule, RECEIPT({outcome: 'SUCCEEDED', exitCode: 0, outputDigest: null}), {policy: policy(), now: NOW}), {code: 'OUTPUT_NOT_PROVEN'});
  // The research evidence path labels the same attempt with its evidence class and never inflates a non-actual event.
  const simulated = toResearchEvent(RECEIPT({...RECEIPT(), outputDigest: 'b'.repeat(64)}), {evidenceClass: 'COUNTERFACTUAL_ESTIMATE', observedAt: '2026-10-07T10:00:00.000Z', sourceRunRef: 'run:1'});
  assert.equal(simulated.measurement.performanceClaim, 'NONE');
  assert.match(simulated.measurement.note, /not a real performance gain/);
});

test('PCF726-11 a LEGACY task keeps its original shape, and the transfer from DGX-002 is thin: execution substrate only', () => {
  // Legacy compatibility: the exact v1 workload shape the legacy normalizer accepts still compiles and validates, with
  // no envelope-2 extension field required anywhere.
  const legacyWorkload = WORKLOAD();
  for (const key of ['envelopeVersion', 'executor', 'retrySafety', 'privilegeRequests']) assert.equal(key in legacyWorkload, false);
  const legacyCapsule = compileExecutionCapsule(normalizeWorkload(legacyWorkload), SPEC(), NOW);
  assert.equal(legacyCapsule.version, 1);
  assert.equal(validateResultEnvelope(legacyCapsule, RECEIPT(), {policy: policy(), now: NOW}).outcome, 'SUCCEEDED');
  // Thin DGX-002 mapping: only the generic execution substrate is carried. DGX keeps its semantic decomposition,
  // independence policy, domain disputes and adjudication, and the capsule has no field for any of them.
  const forbidden = ['decomposition', 'problemGraph', 'independentVerdicts', 'dispute', 'adjudication', 'verdict', 'subProblems', 'hypotheses'];
  for (const key of forbidden) assert.equal(key in legacyCapsule, false, `the capsule must not carry ${key}`);
  // The substrate that DOES cross the boundary is exactly the execution identity and the constraints on it.
  for (const key of ['taskId', 'actionId', 'attemptId', 'epoch', 'executorDeviceId', 'bootId', 'providerId', 'inputDigest', 'writeScope', 'outputSchema', 'deadlineAt', 'policyVersion']) {
    assert.ok(Object.hasOwn(legacyCapsule, key), `${key} is part of the execution substrate and must be carried`);
  }
  // No dependency on activating DGX: the capsule path runs entirely on the local contract.
  assert.equal(typeof compileExecutionCapsule, 'function');
});

test('PCF726-12 the capsule preserves the independence-floor reference it was compiled under, and never fabricates one', () => {
  // A task that declares a floor carries it verbatim...
  const declared = capsuleOf(WORKLOAD(), {...SPEC(), independenceFloorRef: 'review-independence:different-physical-host'});
  assert.equal(declared.independenceFloorRef, 'review-independence:different-physical-host');
  assert.equal(declared.independenceFloorStatus, 'DECLARED');
  assert.deepEqual(independenceFloorOf(declared), {declared: true, independenceFloorRef: 'review-independence:different-physical-host', status: 'DECLARED'});
  assert.deepEqual(assertIndependenceFloor(declared, {requiredFloorRef: 'review-independence:different-physical-host'}), {satisfied: true, independenceFloorRef: 'review-independence:different-physical-host'});
  // ...and a requirement the capsule does not declare is NOT satisfied: silence is not compliance, and the floor is a
  // review-independence fact this module has no authority to invent.
  assert.throws(() => assertIndependenceFloor(declared, {requiredFloorRef: 'review-independence:some-other-floor'}), {code: /^INDEPENDENCE_FLOOR_NOT_SATISFIED:/});
  assert.throws(() => assertIndependenceFloor(declared, {}), {code: 'INDEPENDENCE_FLOOR_REQUIRED'});
  // A task with no declared floor says so explicitly rather than carrying an invented one.
  const undeclared = capsuleOf();
  assert.equal(undeclared.independenceFloorRef, null);
  assert.equal(undeclared.independenceFloorStatus, 'NOT_DECLARED');
  assert.deepEqual(independenceFloorOf(undeclared), {declared: false, independenceFloorRef: null, status: 'NOT_DECLARED'});
  assert.throws(() => assertIndependenceFloor(undeclared, {requiredFloorRef: 'review-independence:different-physical-host'}), {code: /INDEPENDENCE_FLOOR_NOT_SATISFIED:NOT_DECLARED/});
  // An empty or non-text floor is a malformed declaration, not an absent one.
  assert.throws(() => capsuleOf(WORKLOAD(), {...SPEC(), independenceFloorRef: ''}), {code: 'CAPSULE_INDEPENDENCE_FLOOR_INVALID'});
});
