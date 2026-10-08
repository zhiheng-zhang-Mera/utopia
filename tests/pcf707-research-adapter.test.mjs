// PCF-707 acceptance: the workbook's own list for the research-trace sidecar.
//
// The workbook names: duplicate and out-of-order events, a schema with missing fields, a closed collector, a full
// buffer, sensitive fields, and a wrong run/head binding - plus the measured cost of instrumentation on/off and the
// requirement that replaying two policies over the same input produces a RECOMPUTABLE difference. All of it runs
// against the real trace collector and the real placement path; nothing here is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTraceCollector} from '../services/research-trace/index.mjs';
import {toResearchEvent, createResearchAdapter, replayDecisions, measureInstrumentationOverhead, EVIDENCE_CLASSES, PHASES} from '../services/personal-compute-fabric/research-adapter.mjs';
import {planPlacement} from '../services/personal-compute-fabric/placement.mjs';

const receipt = (extra = {}) => ({version: 1, taskId: 'T-1', actionId: 'A-1', parentSessionId: 'S-1', attemptId: 'ATT-1', epoch: 3,
  executorDeviceId: 'alien', bootId: 'boot-1', providerId: 'cpu', inputDigest: 'a'.repeat(64), policyVersion: 7,
  outcome: 'SUCCEEDED', exitCode: 0, outputDigest: 'b'.repeat(64), ...extra});
const context = (extra = {}) => ({evidenceClass: 'ACTUAL_EXECUTION', observedAt: '2026-10-07T10:00:00.000Z',
  phases: {queue: 5, transfer: 10, execution: 30, recovery: 0}, observationRefs: ['observation:alien@1'],
  decisionReasons: ['LOCAL_FIRST', 'CAPABILITY_MATCH'], policyVersion: 7, runtimeRef: 'runtime:local-cpu@1', ...extra});

test('PCF707-01 the workbook fields are all recorded, and phases are measured or NOT_OBSERVED', () => {
  const event = toResearchEvent(receipt({reservationId: 'RES-1'}), context({ownerIntervention: 'APPROVAL', retryIndex: 1, dropped: 2, missing: ['experimentRef']}));
  assert.equal(event.kind, 'PCF_RESEARCH_EVENT');
  assert.equal(event.evidenceClass, 'ACTUAL_EXECUTION');
  // task/action/attempt/reservation identities.
  assert.equal(event.refs.taskRef, 'T-1');
  assert.equal(event.refs.actionRef, 'A-1');
  assert.equal(event.refs.attemptRef, 'ATT-1');
  assert.equal(event.refs.reservationRef, 'RES-1');
  assert.equal(event.refs.deviceRef, 'alien');
  assert.equal(event.refs.bootRef, 'boot-1');
  assert.equal(event.refs.providerRef, 'cpu');
  // policy/runtime versions and observation refs.
  assert.equal(event.versions.policyVersion, 7);
  assert.equal(event.refs.policyRef, 'policy:7');
  assert.equal(event.refs.runtimeRef, 'runtime:local-cpu@1');
  assert.deepEqual(event.refs.observationRefs, ['observation:alien@1']);
  // decision reasons, the four phases, Owner intervention and the missing/dropped counts.
  assert.deepEqual(event.decision.reasons, ['LOCAL_FIRST', 'CAPABILITY_MATCH']);
  assert.deepEqual(PHASES, ['queue', 'transfer', 'execution', 'recovery']);
  assert.deepEqual(event.phases.queue, {state: 'MEASURED', ms: 5});
  assert.deepEqual(event.phases.execution, {state: 'MEASURED', ms: 30});
  assert.equal(event.ownerIntervention, 'APPROVAL');
  assert.deepEqual(event.missing, ['experimentRef']);
  assert.equal(event.dropped, 2);
  // A phase nobody observed is NOT_OBSERVED with a null value, never an invented 0.
  const partial = toResearchEvent(receipt(), {evidenceClass: 'ACTUAL_EXECUTION', observedAt: '2026-10-07T10:00:00.000Z', phases: {execution: 12}});
  assert.deepEqual(partial.phases.recovery, {state: 'NOT_OBSERVED', ms: null});
  assert.ok(partial.missing.includes('phases.queue') && partial.missing.includes('phases.transfer') && partial.missing.includes('phases.recovery'));
  assert.equal(partial.traceProjection.metrics.latencyMs, 12, 'only measured time is reported as latency');
});

test('PCF707-02 the trace projection is schema-valid, and what the closed schema cannot carry is named', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf707-schema-'));
  let collector;
  try {
    collector = createTraceCollector({directory: join(dir, 'trace'), queueLimit: 8, recordLimit: 16, softwareRefs: {softwareSha: 'c'.repeat(40)}});
    const adapter = createResearchAdapter(collector, {enabled: true});
    assert.equal(adapter.captureReceipt(receipt(), context()), true, 'the projection is accepted by the real normalizer');
    assert.equal(await collector.flush(), true);
    const record = collector.snapshot().records[0];
    assert.equal(record.type, 'PCF_ATTEMPT_RECEIPT');
    assert.equal(record.canonicalRefs.taskRef, 'T-1');
    assert.equal(record.canonicalRefs.actionRef, 'A-1');
    assert.equal(record.canonicalRefs.deviceRef, 'alien');
    assert.equal(record.dimensions.providerRef, 'cpu');
    assert.equal(record.dimensions.sourceWorkbook, 'PCF-707');
    assert.equal(record.dimensions.ownerInterventionReason, undefined);
    assert.equal(record.metrics.latencyMs.value, 45);
    assert.deepEqual(record.clocks.source, 'CANONICAL_EVENT_WALL_UTC');
    // The trace schema reports its OWN missing fields, and the PCF event reports the ones it cannot hand over.
    assert.ok(record.missingFields.includes('experimentRef'));
    assert.ok(record.missingFields.includes('experimentRunRef'));
    const event = toResearchEvent(receipt(), context());
    assert.ok(event.notRepresentable.includes('refs.attemptRef'));
    assert.ok(event.notRepresentable.includes('phases'));
    assert.ok(event.notRepresentable.includes('evidenceClass'));
    // The projection carries only keys the closed schema allows - proven by it normalizing without an error.
    assert.deepEqual(Object.keys(event.traceProjection).sort(), ['canonicalRefs', 'dimensions', 'eventId', 'metrics', 'sourceClock', 'timestamp', 'type']);
  } finally { await collector?.close(); await rm(dir, {recursive: true, force: true}); }
});

test('PCF707-03 the same receipt twice is a DUPLICATE, and a regressed sequence is OUT_OF_ORDER', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf707-order-'));
  let collector;
  try {
    collector = createTraceCollector({directory: join(dir, 'trace'), queueLimit: 8, recordLimit: 16});
    const adapter = createResearchAdapter(collector, {enabled: true});
    adapter.captureReceipt(receipt(), context({sourceSeq: 2}));
    adapter.captureReceipt(receipt(), context({sourceSeq: 2}));
    // A different attempt with an EARLIER sequence is out of order, and a skipped sequence is a gap.
    adapter.captureReceipt(receipt({attemptId: 'ATT-0'}), context({sourceSeq: 1}));
    adapter.captureReceipt(receipt({attemptId: 'ATT-9'}), context({sourceSeq: 6}));
    assert.equal(await collector.flush(), true);
    const records = collector.snapshot().records;
    assert.equal(records.length, 4);
    assert.ok(records[1].annotations.includes('DUPLICATE_EVENT'), 'the repeat is marked, not silently merged');
    assert.ok(records[2].annotations.includes('OUT_OF_ORDER_EVENT'));
    assert.ok(records[3].annotations.includes('SOURCE_SEQUENCE_GAP'));
    assert.equal(collector.snapshot().completeness, 'PARTIAL', 'annotated records make the recording partial, and it says so');
  } finally { await collector?.close(); await rm(dir, {recursive: true, force: true}); }
});

test('PCF707-04 a closed collector or a full buffer degrades boundedly and never breaks the caller', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf707-bounded-'));
  let collector;
  try {
    collector = createTraceCollector({directory: join(dir, 'trace')});
    const adapter = createResearchAdapter(collector, {enabled: true});
    assert.equal(adapter.captureReceipt(receipt(), context()), true);
    await collector.close();
    // Closed: the capture is refused, counted, and returns false instead of throwing into the execution path.
    assert.equal(adapter.captureReceipt(receipt({attemptId: 'ATT-CLOSED'}), context()), false);
    assert.equal(adapter.snapshot().dropped >= 1, true);
    // A full buffer is the same shape: the sidecar says false and the counter moves.
    const full = createResearchAdapter({record: () => false}, {enabled: true});
    assert.equal(full.captureReceipt(receipt(), context()), false);
    assert.deepEqual(full.snapshot(), {enabled: true, dropped: 1, captured: 0, events: 1});
    // A sidecar that throws is not allowed to propagate either.
    const broken = createResearchAdapter({record: () => { throw Object.assign(new Error('sidecar down'), {code: 'SIDECAR_DOWN'}); }}, {enabled: true});
    assert.equal(broken.captureReceipt(receipt(), context()), false);
    assert.equal(broken.snapshot().dropped, 1);
    // A malformed receipt is a caller error and IS reported as one, rather than being recorded as a good event.
    const strict = createResearchAdapter(collector, {enabled: true});
    assert.equal(strict.captureReceipt({...receipt(), epoch: 0}, context()), false);
    // Disabled instrumentation records nothing and counts nothing.
    const off = createResearchAdapter(collector, {enabled: false});
    assert.equal(off.captureReceipt(receipt(), context()), false);
    assert.deepEqual(off.snapshot(), {enabled: false, dropped: 0, captured: 0, events: 0});
  } finally { await collector?.close(); await rm(dir, {recursive: true, force: true}); }
});

test('PCF707-05 sensitive fields are redacted by name, and no raw input is carried', () => {
  const event = toResearchEvent(receipt({token: 'ghp_NOT_A_REAL_TOKEN', password: 'hunter2', nested: {apiKey: 'sk-not-real', keep: 'visible'}}), context());
  const text = JSON.stringify(event);
  for (const secret of ['ghp_NOT_A_REAL_TOKEN', 'hunter2', 'sk-not-real']) assert.ok(!text.includes(secret), secret + ' must not survive the adapter');
  // The redacted key NAMES are reported (sorted, so two events are comparable) and the values are gone.
  assert.deepEqual(event.privacy.redactedKeys, ['apiKey', 'password', 'token']);
  assert.ok(event.privacy.policy.includes('raw input bytes are never carried'));
  assert.equal(JSON.parse(text).nested === undefined, true, 'the redacted receipt is not echoed back at all');
});

test('PCF707-06 an ACTUAL label needs real identities, and a simulation cannot claim a measured gain', () => {
  // The execution label without the identities a real attempt has is refused outright.
  assert.throws(() => toResearchEvent(receipt({epoch: 0}), context()), /RESEARCH_EVENT_NOT_ACTUAL/);
  assert.throws(() => toResearchEvent(receipt({inputDigest: null}), context()), /RESEARCH_EVENT_NOT_ACTUAL/);
  assert.throws(() => toResearchEvent(receipt(), context({evidenceClass: 'REAL_RUN'})), /RESEARCH_EVENT_EVIDENCE_CLASS_UNKNOWN/);
  // Each class is marked, and only the actual one may claim a local measurement.
  for (const evidenceClass of EVIDENCE_CLASSES) {
    const event = toResearchEvent(receipt(), context({evidenceClass, sourceRunRef: 'run:42'}));
    assert.equal(event.evidenceClass, evidenceClass);
    assert.equal(event.measurement.performanceClaim, evidenceClass === 'ACTUAL_EXECUTION' ? 'MEASURED_LOCALLY' : 'NONE');
    if (evidenceClass !== 'ACTUAL_EXECUTION') assert.ok(event.measurement.note.includes('not a real performance gain'));
  }
  // A recorded trace without the run it came from is refused rather than passed off as this run's evidence.
  assert.throws(() => toResearchEvent(receipt(), context({evidenceClass: 'RECORDED_TRACE'})), /RESEARCH_EVENT_SOURCE_RUN_REQUIRED/);
  assert.throws(() => toResearchEvent(receipt(), context({ownerIntervention: 'MAYBE'})), /RESEARCH_EVENT_INTERVENTION_UNKNOWN/);
  assert.throws(() => toResearchEvent(receipt({outcome: 'PROBABLY_FINE'}), context()), /RESEARCH_EVENT_OUTCOME_UNKNOWN/);
});

test('PCF707-07 a wrong run or head binding is refused instead of recorded against this experiment', () => {
  assert.throws(() => toResearchEvent(receipt(), context({runRef: 'run:1', expectedRunRef: 'run:2'})), /RESEARCH_EVENT_RUN_MISMATCH/);
  assert.throws(() => toResearchEvent(receipt(), context({headSha: 'd'.repeat(40), expectedHeadSha: 'e'.repeat(40)})), /RESEARCH_EVENT_HEAD_MISMATCH/);
  // A matching binding is recorded with the same identities it was checked against.
  const bound = toResearchEvent(receipt(), context({runRef: 'run:1', expectedRunRef: 'run:1', headSha: 'd'.repeat(40), expectedHeadSha: 'd'.repeat(40), sourceSeq: 4}));
  assert.equal(bound.traceProjection.sourceSeq, 4);
  // A callback that cannot be observed is left unmeasured instead of being guessed.
  assert.throws(() => toResearchEvent(receipt(), context({observationRefs: ['not a ref!']})), /RESEARCH_EVENT_OBSERVATION_REF_INVALID/);
  assert.throws(() => toResearchEvent(receipt(), {evidenceClass: 'ACTUAL_EXECUTION'}), /RESEARCH_EVENT_TIMESTAMP_REQUIRED/);
});

test('PCF707-08 replaying two policies over the same input gives a recomputable difference, inside an isolated scope only', () => {
  const policy = {version: 7, authorized: true, originDeviceId: 'alien', mode: 'TRUSTED_PERSONAL_FABRIC', allowedDevices: ['alien', 'mech'], dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: 5000};
  const workload = {taskId: 'T', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S', appId: 'one', dataScope: 'PUBLIC', kind: 'CPU_JSON', capabilities: ['cpu.json'], resources: {cpu: 1}, deadlineAt: 4000, writeScope: [], qos: 'BATCH'};
  const candidate = (deviceId, extra = {}) => ({deviceId, bootId: 'b-' + deviceId, trusted: true, authorized: true, executorReady: true, sharing: true, platform: 'win32', provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'}, observationVersion: 1, observedAt: 900, validUntil: 3000, free: {cpu: 4}, queueMs: 10, cost: {inputMs: [1, 2], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2]}, ...extra});
  const candidates = [candidate('alien'), candidate('mech', {queueMs: 900})];
  const baseline = {ref: 'policy:composite', value: policy, place: (w, c, p, now) => planPlacement(w, c, p, now, {strategy: 'COMPOSITE'})};
  const proposed = {ref: 'policy:load-only', value: policy, place: (w, c, p, now) => planPlacement(w, c, p, now, {strategy: 'LOAD'})};
  const ablation = {ref: 'policy:capability-only', value: policy, place: (w, c, p, now) => planPlacement(w, c, p, now, {strategy: 'CAPABILITY'})};
  const scope = {scopeRef: 'experiment:pcf707', isolated: true, authorised: true};
  const first = replayDecisions({baseline, proposed, ablation, workload, candidates, now: 1000, scope});
  const second = replayDecisions({baseline, proposed, ablation, workload, candidates, now: 1000, scope});
  assert.deepEqual(first, second, 'the replay is deterministic, so the difference can be recomputed by a reviewer');
  assert.equal(first.results.BASELINE.deviceId, 'alien', 'local-first keeps the origin device');
  assert.equal(first.differences.find(entry => entry.mode === 'PROPOSED').delta, 'NO_CHANGE', 'load-only agrees here, and that is stated as NO_CHANGE rather than as an improvement');
  assert.equal(first.productionPolicyUnchanged, true);
  assert.equal(first.dispatchAllowed, false);
  assert.equal(first.performanceClaim, 'NONE');
  // Experiment control is refused outside an isolated AND authorised scope.
  assert.throws(() => replayDecisions({baseline, proposed, workload, candidates, now: 1000, scope: {scopeRef: 'x', isolated: true, authorised: false}}), /REPLAY_SCOPE_NOT_AUTHORISED/);
  assert.throws(() => replayDecisions({baseline, proposed, workload, candidates, now: 1000, scope: {scopeRef: 'x', isolated: false, authorised: true}}), /REPLAY_SCOPE_NOT_ISOLATED/);
  assert.throws(() => replayDecisions({baseline, proposed, workload, candidates, now: 1000, scope: {isolated: true, authorised: true}}), /REPLAY_SCOPE_REF_REQUIRED/);
  // A different strategy that really does choose another device shows up as a DIFFERENT_DEVICE difference.
  const moved = replayDecisions({baseline, proposed: {...proposed, place: (w, c, p, now) => planPlacement(w, [{...c[0], authorized: false}, c[1]], p, now, {strategy: 'COMPOSITE'})}, workload, candidates, now: 1000, scope});
  assert.equal(moved.differences[0].delta, 'DIFFERENT_DEVICE');
  assert.equal(moved.results.PROPOSED.deviceId, 'mech');
});

test('PCF707-09 the instrumentation cost is measured on this host and labelled as local only', () => {
  const measured = measureInstrumentationOverhead({iterations: 500,
    enabled: index => toResearchEvent(receipt({attemptId: 'ATT-' + index}), context()),
    disabled: () => receipt()});
  assert.equal(measured.kind, 'InstrumentationOverhead');
  assert.equal(measured.iterations, 500);
  assert.ok(Number.isFinite(measured.enabledNs) && Number.isFinite(measured.disabledNs));
  assert.ok(Number.isFinite(measured.overheadPerEventNs));
  assert.equal(measured.clock, 'PROCESS_HRTIME_MONOTONIC_LOCAL');
  assert.equal(measured.generalisable, false, 'one local loop is not a general overhead claim');
  assert.equal(measured.scope, 'THIS_HOST_THIS_LOOP_ONLY');
  assert.throws(() => measureInstrumentationOverhead({enabled: () => {}, disabled: () => {}, iterations: 1}), /OVERHEAD_ITERATIONS/);
  assert.throws(() => measureInstrumentationOverhead({enabled: null, disabled: () => {}}), /OVERHEAD_INPUT/);
});
