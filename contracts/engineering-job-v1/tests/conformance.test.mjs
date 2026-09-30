// EM-003 conformance suite — job / event / result / artifact protocol.
//
// Acceptance: autonomous jobs do not require operations[]; scripted jobs lacking an executable
// specification are refused/blocked honestly; partial/progress events cannot mark a job terminal;
// a terminal result cannot be resurrected by replay; artifact references preserve job/device/
// connector provenance; late and duplicate events are deterministic and idempotent.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 ACTIVE_JOB_STATES, ARTIFACT_KINDS, ENGINEERING_JOB_PROTOCOL, EXECUTION_MODES, FILE_STATUSES,
 JOB_REJECTION_CODES, JOB_STATES, TERMINAL_JOB_STATES, MAX_CHANGED_FILES, admitJob, artifactProvenance,
 assertJobEnvelope, attachArtifact, createJobRecord, envelopeDepthExceeded, findRawSecretFields,
 jobSummary, reconcileEvents, applyEvent, applyResult, validateArtifactEnvelope, validateEventEnvelope,
 validateResultEnvelope
} from '../index.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const LATER = '2026-09-30T12:01:00.000Z';
const DIGEST = 'sha256:' + 'a'.repeat(64);
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const baseJob = (overrides = {}) => ({
  contract_version: 1,
  route: 'ENGINEERING',
  job_ref: 'job-1',
  city_task_ref: 'city-task-1',
  objective: 'Make the failing test pass without changing the public API',
  execution_mode: 'AUTONOMOUS_AGENT',
  target: { repo_ref: 'repo-utopia', branch_ref: 'em/EM-003', workspace_ref: 'ws-1' },
  context_refs: ['context-1'],
  scope: { include_refs: ['contracts/'], exclude_refs: ['apps/android/'] },
  acceptance: { criteria_refs: ['acceptance-1'], required_checks: ['pnpm test'] },
  permissions: { policy_context_ref: 'policy-context-1', required_needs: ['engineering.execute.invoke'] },
  risk_class: 'LOW',
  device_policy: { placement: 'LOCAL_ALLOWED', execution_device_ref: null },
  state: 'SUBMITTED',
  job_version: 1,
  idempotency_key: 'job-key-1',
  created_at: TS,
  updated_at: TS,
  ...overrides,
});

const baseEvent = (overrides = {}) => ({
  contract_version: 1,
  event_id: 'event-1',
  job_ref: 'job-1',
  job_version: 1,
  sequence: 1,
  stage: 'EXECUTION',
  state: 'RUNNING',
  partial: { progress_percent: 40, summary: 'building' },
  source: { connector_ref: 'connector-1', device_ref: 'device-1' },
  caused_by_event_ref: null,
  at: TS,
  ...overrides,
});

const baseResult = (overrides = {}) => ({
  contract_version: 1,
  result_ref: 'result-1',
  job_ref: 'job-1',
  job_version: 2,
  terminal_status: 'SUCCEEDED',
  status_code: 'TESTS_GREEN',
  summary: 'contracts added',
  changed_files: [{ path: 'contracts/a.mjs', status: 'ADDED', digest: DIGEST }],
  tests: [{ name: 'pnpm test', status: 'PASS' }],
  git: { commit_ref: 'abc1234', branch_ref: 'em/EM-003', pr_ref: null },
  acceptance: { status: 'PASS', evidence_refs: ['evidence-1'] },
  warnings: [],
  controller_decisions: [{ decision: 'PROCEED', reason: 'all checks green' }],
  produced_at: LATER,
  ...overrides,
});

const baseArtifact = (overrides = {}) => ({
  contract_version: 1,
  artifact_ref: 'artifact-1',
  job_ref: 'job-1',
  kind: 'PATCH',
  digest: DIGEST,
  media_type: 'text/x-diff',
  size_bytes: 1024,
  storage_ref: 'storage-1',
  provenance: { device_ref: 'device-1', connector_ref: 'connector-1', event_ref: 'event-1' },
  produced_at: LATER,
  ...overrides,
});

/* ------------------------------------------------- 1. execution modes */

test('an autonomous job needs an objective and bounded constraints, not an operation list', () => {
  assert.deepEqual(admitJob(baseJob()), {
    admitted: true, code: null,
    detail: 'AUTONOMOUS_AGENT plans its own operations from the objective',
    honest_blocker: false, errors: [],
  });
  assert.equal(admitJob(baseJob({ execution_mode: 'INTERACTIVE_AGENT' })).admitted, true);
  assert.equal(assertJobEnvelope(baseJob()).job_ref, 'job-1');
  // requiring operations of an autonomous agent would force the wrong execution model onto it
  const scripted = admitJob(baseJob({ execution_mode: 'AUTONOMOUS_AGENT', operations: ['run-tests'] }));
  assert.equal(scripted.admitted, false);
  assert.equal(scripted.code, 'AUTONOMOUS_MUST_NOT_PRESENT_OPERATIONS');
  assert.deepEqual([...EXECUTION_MODES], ['AUTONOMOUS_AGENT', 'SCRIPTED_EXECUTOR', 'INTERACTIVE_AGENT']);
  assert.equal(ENGINEERING_JOB_PROTOCOL.autonomous_jobs_require_operations, false);
});

test('a scripted job without an executable specification is refused honestly, not admitted', () => {
  const blocked = admitJob(baseJob({ execution_mode: 'SCRIPTED_EXECUTOR' }));
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.code, 'SCRIPTED_SPEC_REQUIRED');
  assert.equal(blocked.honest_blocker, true, 'the caller is told this is a blocker, not a malformed document');
  const scripted = admitJob(baseJob({ execution_mode: 'SCRIPTED_EXECUTOR', operations: ['run-tests', 'collect-diff'] }));
  assert.equal(scripted.admitted, true);
  assert.equal(ENGINEERING_JOB_PROTOCOL.scripted_jobs_require_operations, true);
  expectCode(() => assertJobEnvelope(baseJob({ execution_mode: 'SCRIPTED_EXECUTOR' })), 'SCRIPTED_SPEC_REQUIRED');
});

test('the job envelope is strict about route, vocabulary and secrets', () => {
  assert.equal(admitJob(baseJob({ route: 'CITY_TASK' })).admitted, false);
  assert.equal(admitJob(baseJob({ contract_version: 2 })).admitted, false);
  assert.equal(admitJob(baseJob({ execution_mode: 'SMART_MODE' })).admitted, false);
  assert.equal(admitJob(baseJob({ risk_class: 'EXTREME' })).admitted, false);
  assert.equal(admitJob(baseJob({ device_policy: { placement: 'SOMEWHERE', execution_device_ref: null } })).admitted, false);
  assert.equal(admitJob(baseJob({ mood: 'happy' })).admitted, false);
  assert.equal(admitJob(baseJob({ target: { repo_ref: 'r' } })).admitted, false);
  assert.equal(admitJob(baseJob({ permissions: { policy_context_ref: 'p', required_needs: [], credential: 'raw' } })).admitted, false);
  assert.deepEqual(findRawSecretFields({ a: { b: { api_key: 'x' } } }, ''), ['.a.b.api_key']);
  assert.deepEqual(findRawSecretFields({ credential_ref: 'h' }, ''), []);
  assert.equal(new Set(JOB_REJECTION_CODES).size, JOB_REJECTION_CODES.length);
  assert.deepEqual([...TERMINAL_JOB_STATES], ['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']);
  assert.deepEqual([...ACTIVE_JOB_STATES], ['SUBMITTED', 'QUEUED', 'RUNNING', 'BLOCKED']);
  assert.equal(JOB_STATES.includes('SUCCEEDED'), true);
});

/* ------------------------------------------------- 2. events */

test('a partial or progress event can never mark a job terminal', () => {
  const partialTerminal = validateEventEnvelope(baseEvent({ state: 'SUCCEEDED', partial: { progress_percent: 99, summary: 'almost' } }));
  assert.equal(partialTerminal.ok, false);
  assert.equal(partialTerminal.errors.some(error => error.includes('cannot mark a job terminal')), true);
  // a genuine completion event carries full progress
  assert.equal(validateEventEnvelope(baseEvent({ state: 'SUCCEEDED', partial: { progress_percent: 100, summary: 'done' } })).ok, true);
  const record = createJobRecord(baseJob());
  expectCode(() => applyEvent(record, baseEvent({ state: 'SUCCEEDED', partial: { progress_percent: 99, summary: 'almost' } })), 'INVALID_EVENT');
  assert.equal(ENGINEERING_JOB_PROTOCOL.partial_events_can_end_a_job, false);
});

test('late, duplicate and out-of-order events are deterministic and idempotent', () => {
  const record = createJobRecord(baseJob());
  const first = baseEvent({ event_id: 'event-1', sequence: 1, state: 'QUEUED', partial: { progress_percent: 0, summary: 'queued' } });
  const third = baseEvent({ event_id: 'event-3', sequence: 3, state: 'RUNNING', partial: { progress_percent: 60, summary: 'running' }, caused_by_event_ref: 'event-1' });
  const second = baseEvent({ event_id: 'event-2', sequence: 2, state: 'RUNNING', partial: { progress_percent: 20, summary: 'started' }, caused_by_event_ref: 'event-1' });

  const outcome = reconcileEvents(record, [third, first, second, first]);
  assert.deepEqual(outcome.applied.map(entry => entry.event_id), ['event-1', 'event-2', 'event-3']);
  assert.deepEqual(outcome.ignored, [{ event_id: 'event-1', reason: 'DUPLICATE_EVENT' }]);
  assert.equal(outcome.record.state, 'RUNNING');
  assert.equal(outcome.record.last_sequence, 3);
  // the same batch in a different input order produces the same record
  const reordered = reconcileEvents(record, [second, third, first]);
  assert.deepEqual(reordered.record.applied_events, outcome.record.applied_events);
  assert.deepEqual(reordered.record.state, outcome.record.state);
  // a late event (already-passed sequence) is ignored with its reason, and a gap is reported
  const late = applyEvent(outcome.record, baseEvent({ event_id: 'event-late', sequence: 2, state: 'BLOCKED', partial: { progress_percent: 30, summary: 'late' } }));
  assert.equal(late.applied, false);
  assert.equal(late.reason, 'LATE_EVENT');
  assert.equal(late.record.ignored_events.at(-1).reason, 'LATE_EVENT');
  const gap = applyEvent(record, baseEvent({ event_id: 'event-gap', sequence: 5, state: 'RUNNING', partial: { progress_percent: 10, summary: 'jumped' } }));
  assert.equal(gap.applied, true);
  assert.equal(gap.reason, 'APPLIED_AFTER_GAP');
  assert.equal(gap.record.applied_events.at(-1).gap_before, true);
  // an event for another job is refused outright
  expectCode(() => applyEvent(record, baseEvent({ job_ref: 'job-9' })), 'INVALID_EVENT');
  expectCode(() => reconcileEvents(record, 'not-an-array'), 'INVALID_EVENT');
});

/* ------------------------------------------------- 3. results */

test('a terminal result is final and cannot be resurrected by replay', () => {
  const record = createJobRecord(baseJob());
  const running = reconcileEvents(record, [baseEvent({ event_id: 'e1', sequence: 1, state: 'RUNNING', partial: { progress_percent: 50, summary: 'running' } })]).record;
  const finished = applyResult(running, baseResult());
  assert.equal(finished.applied, true);
  assert.equal(finished.record.state, 'SUCCEEDED');
  assert.equal(jobSummary(finished.record).is_terminal, true);
  assert.equal(jobSummary(finished.record).acceptance, 'PASS');

  // the same result replayed is an idempotent no-op
  const replay = applyResult(finished.record, baseResult());
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, 'DUPLICATE_RESULT');
  assert.equal(replay.record.result.result_ref, 'result-1');

  // a different result can never move the job again
  expectCode(() => applyResult(finished.record, baseResult({ result_ref: 'result-2', terminal_status: 'FAILED', acceptance: { status: 'FAIL', evidence_refs: [] } })), 'TERMINAL_JOB_IS_FINAL');
  // neither can an event
  const afterTerminal = applyEvent(finished.record, baseEvent({ event_id: 'e2', sequence: 2, state: 'RUNNING', partial: { progress_percent: 90, summary: 'resurrected' } }));
  assert.equal(afterTerminal.applied, false);
  assert.equal(afterTerminal.reason, 'TERMINAL_JOB_IS_FINAL');
  assert.equal(afterTerminal.record.state, 'SUCCEEDED');
  assert.equal(ENGINEERING_JOB_PROTOCOL.terminal_state_is_final, true);
});

test('a result must be honest: success needs acceptance, and versions must line up', () => {
  assert.equal(validateResultEnvelope(baseResult()).ok, true);
  const unaccepted = validateResultEnvelope(baseResult({ acceptance: { status: 'NOT_REQUIRED', evidence_refs: [] } }));
  assert.equal(unaccepted.ok, false);
  assert.equal(unaccepted.errors.some(error => error.includes('requires acceptance.status PASS')), true);
  assert.equal(validateResultEnvelope(baseResult({ tests: [{ name: 'pnpm test', status: 'FAIL' }] })).ok, false);
  assert.equal(validateResultEnvelope(baseResult({ terminal_status: 'RUNNING' })).ok, false);
  assert.equal(validateResultEnvelope(baseResult({ git: { commit_ref: null } })).ok, false);
  const record = createJobRecord(baseJob({ job_version: 3 }));
  expectCode(() => applyResult(record, baseResult({ job_version: 2 })), 'RESULT_VERSION_MISMATCH');
  expectCode(() => applyResult(record, baseResult({ job_ref: 'job-9' })), 'RESULT_JOB_MISMATCH');
  // an honest failure with no acceptance evidence is valid
  assert.equal(validateResultEnvelope(baseResult({ terminal_status: 'FAILED', status_code: 'TESTS_RED', acceptance: { status: 'FAIL', evidence_refs: [] }, tests: [{ name: 'pnpm test', status: 'FAIL' }] })).ok, true);
});

/* ------------------------------------------------- 4. artifacts */

test('artifact references preserve job, device and connector provenance', () => {
  const record = createJobRecord(baseJob());
  const attached = attachArtifact(record, baseArtifact());
  assert.equal(attached.applied, true);
  const provenance = artifactProvenance(attached.record.artifacts[0]);
  assert.deepEqual(provenance, {
    artifact_ref: 'artifact-1', job_ref: 'job-1', device_ref: 'device-1',
    connector_ref: 'connector-1', event_ref: 'event-1', digest: DIGEST, kind: 'PATCH',
  });
  assert.deepEqual(attached.record.artifacts.map(entry => entry.artifact_ref), ['artifact-1']);
  // a duplicate reference is idempotent
  assert.deepEqual(attachArtifact(attached.record, baseArtifact()), { record: attached.record, applied: false, reason: 'DUPLICATE_ARTIFACT' });
  // provenance is mandatory and the digest must be a digest
  assert.equal(validateArtifactEnvelope(baseArtifact({ provenance: { device_ref: 'device-1' } })).ok, false);
  assert.equal(validateArtifactEnvelope(baseArtifact({ digest: 'not-a-digest' })).ok, false);
  assert.equal(validateArtifactEnvelope(baseArtifact({ kind: 'SCREENSHOT', media_type: 'image/png' })).ok, true);
  expectCode(() => attachArtifact(record, baseArtifact({ job_ref: 'job-9' })), 'INVALID_ARTIFACT');
  assert.equal(ENGINEERING_JOB_PROTOCOL.artifact_provenance_required, true);
  assert.equal(ARTIFACT_KINDS.includes('TEST_REPORT'), true);
  assert.equal(FILE_STATUSES.includes('RENAMED'), true);
});

test('the protocol publishes its guarantees and stays transport neutral', () => {
  assert.equal(ENGINEERING_JOB_PROTOCOL.transport_neutral, true);
  assert.equal(ENGINEERING_JOB_PROTOCOL.late_and_duplicate_events_are_idempotent, true);
  assert.equal(ENGINEERING_JOB_PROTOCOL.execution_modes.length, 3);
  const record = createJobRecord(baseJob());
  const summary = jobSummary(record);
  assert.equal(summary.is_active, true);
  assert.equal(summary.is_terminal, false);
  assert.deepEqual(summary.artifacts, []);
  assert.equal(summary.result_ref, null);
  expectCode(() => jobSummary({}), 'INVALID_ENGINEERING_JOB');
  // cross-device carriage may use RF envelopes, but the Engineering envelope is the canonical one
  assert.equal(validateEventEnvelope(baseEvent({ transport: 'RF_STREAM' })).ok, false);
});

/* --------------------------------- 10. regressions (Correction, host Alien) */

// The author's strictness test above uses the name `transport`, which is not an Object.prototype
// member — which is exactly why the hole below survived. Every refusal is paired with the legitimate
// neighbour that must still pass, so no guard can be satisfied by refusing everything.

test('unknown fields are refused even when named after Object.prototype members', () => {
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
  assert.equal(prototypeNames.length >= 12, true);
  for (const name of prototypeNames) {
    const job = { ...baseJob() };
    Object.defineProperty(job, name, { value: 'RF_STREAM', enumerable: true, configurable: true, writable: true });
    const verdict = admitJob(job);
    assert.equal(verdict.admitted, false, `job.${name} must not be part of the canonical contract`);
    assert.equal(verdict.errors.some(error => error.startsWith(`job.${name}`)), true, `job.${name} must be named as the offending field`);
  }
  // ...at every nesting level, not only at the top
  assert.equal(validateResultEnvelope(baseResult({ git: { commit_ref: 'abc1234', branch_ref: 'b', pr_ref: null, constructor: 'x' } })).ok, false);
  assert.equal(validateEventEnvelope(baseEvent({ source: { connector_ref: 'c', device_ref: 'd', toString: 'x' } })).ok, false);
  assert.equal(validateArtifactEnvelope(baseArtifact({ provenance: { device_ref: 'd', connector_ref: 'c', event_ref: null, valueOf: 1 } })).ok, false);
  // neighbours: an ordinary unknown field is still refused, and a clean envelope is still admitted
  assert.equal(admitJob(baseJob({ transport: 'RF_STREAM' })).admitted, false);
  assert.equal(admitJob(baseJob()).admitted, true);
  assert.equal(validateResultEnvelope(baseResult()).ok, true);
  assert.equal(createJobRecord(baseJob()).job.job_ref, 'job-1');
});

test('a job record cannot be born terminal, and success is only reached through a result', () => {
  for (const state of TERMINAL_JOB_STATES) {
    expectCode(() => createJobRecord(baseJob({ state })), 'INVALID_ENGINEERING_JOB');
  }
  // neighbour: a record starts active, and its terminal state always arrives with a result
  const record = createJobRecord(baseJob());
  assert.equal(jobSummary(record).is_terminal, false);
  const finished = applyResult(record, baseResult()).record;
  assert.equal(jobSummary(finished).is_terminal, true);
  assert.equal(jobSummary(finished).terminal_status, 'SUCCEEDED');
  assert.equal(jobSummary(finished).acceptance, 'PASS');
  assert.equal(jobSummary(finished).result_ref, 'result-1');
});

test('an event from a superseded job version never acts on the current job', () => {
  const record = createJobRecord(baseJob());
  const advanced = applyEvent(record, baseEvent({ event_id: 'event-v2', job_version: 2, sequence: 2 })).record;
  assert.equal(advanced.job_version, 2);
  assert.equal(advanced.state, 'RUNNING');
  // a stale incarnation cannot walk the state backwards...
  const backwards = applyEvent(advanced, baseEvent({ event_id: 'event-stale', job_version: 1, sequence: 9, state: 'QUEUED' }));
  assert.equal(backwards.applied, false);
  assert.equal(backwards.reason, 'STALE_JOB_VERSION');
  assert.equal(backwards.record.state, 'RUNNING');
  // ...nor terminally fail a job that is still running
  const staleTerminal = applyEvent(advanced, baseEvent({ event_id: 'event-stale-fail', job_version: 1, sequence: 10, state: 'FAILED', partial: { progress_percent: 100, summary: 'old incarnation died' } }));
  assert.equal(staleTerminal.applied, false);
  assert.equal(staleTerminal.record.state, 'RUNNING');
  // neighbours: the current version still applies, and a forward version is how the record advances
  assert.equal(applyEvent(advanced, baseEvent({ event_id: 'event-v2-next', job_version: 2, sequence: 3 })).applied, true);
  assert.equal(applyEvent(advanced, baseEvent({ event_id: 'event-v3', job_version: 3, sequence: 3 })).record.job_version, 3);
});

test('a replayed result is recognised by its content, not by its ref', () => {
  const finished = applyResult(createJobRecord(baseJob()), baseResult()).record;
  const replay = applyResult(finished, baseResult());
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, 'DUPLICATE_RESULT');
  assert.equal(replay.record.state, 'SUCCEEDED');
  // a rewritten result under the same ref is not a replay, and must not be passed off as one
  const rewritten = baseResult({ terminal_status: 'FAILED', acceptance: { status: 'FAIL', evidence_refs: [] }, summary: 'actually failed' });
  expectCode(() => applyResult(finished, rewritten), 'TERMINAL_JOB_IS_FINAL');
  // neighbours: an unrelated second result is refused, and a fresh job still accepts its result
  expectCode(() => applyResult(finished, baseResult({ result_ref: 'result-2' })), 'TERMINAL_JOB_IS_FINAL');
  assert.equal(applyResult(createJobRecord(baseJob()), baseResult({ result_ref: 'result-2' })).applied, true);
});

test('a replayed artifact is recognised by its content and digest', () => {
  const attached = attachArtifact(createJobRecord(baseJob()), baseArtifact()).record;
  const replay = attachArtifact(attached, baseArtifact());
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, 'DUPLICATE_ARTIFACT');
  // same ref, different payload: refusing is the honest answer, and the digest is available to say so
  const changed = baseArtifact({ digest: 'sha256:' + 'b'.repeat(64), size_bytes: 2048, kind: 'SCREENSHOT' });
  expectCode(() => attachArtifact(attached, changed), 'INVALID_ARTIFACT');
  assert.equal(attached.artifacts[0].digest, DIGEST);
  // neighbours: a different artifact with the same digest still attaches, and provenance is copied
  const second = baseArtifact({ artifact_ref: 'artifact-2' });
  assert.equal(attachArtifact(attached, second).applied, true);
  const provenance = artifactProvenance(second);
  assert.equal(provenance.device_ref, 'device-1');
  assert.equal(provenance.connector_ref, 'connector-1');
  assert.equal(provenance.job_ref, 'job-1');
});

test('a malformed batch is refused with a typed contract error', () => {
  const record = createJobRecord(baseJob());
  // the ordering pass reads `sequence`, so a null entry used to escape as an untyped TypeError
  for (const batch of [[null, null], [baseEvent(), null], [baseEvent(), 42], [undefined, undefined]]) {
    const error = expectCode(() => reconcileEvents(record, batch), 'INVALID_EVENT');
    assert.equal(error.name, 'EngineeringJobError');
  }
  assert.equal(expectCode(() => reconcileEvents(record, [baseEvent(), null]), 'INVALID_EVENT').detail.includes('events[1]'), true);
  expectCode(() => reconcileEvents(record, 'not-an-array'), 'INVALID_EVENT');
  // neighbours: a well-formed batch still reconciles, and equal ids still compare equal
  assert.equal(reconcileEvents(record, [baseEvent()]).applied.length, 1);
  assert.equal(reconcileEvents(record, [baseEvent({ event_id: 'b', sequence: 2 }), baseEvent({ event_id: 'a', sequence: 1 })]).applied.length, 2);
});

test('an ignored duplicate is recorded on the record, once, and stays idempotent', () => {
  const record = createJobRecord(baseJob());
  const applied = applyEvent(record, baseEvent());
  assert.equal(applied.applied, true);
  assert.deepEqual([...applied.record.ignored_events], []);
  const duplicate = applyEvent(applied.record, baseEvent());
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reason, 'DUPLICATE_EVENT');
  assert.deepEqual(duplicate.record.ignored_events.map(entry => entry.reason), ['DUPLICATE_EVENT']);
  // replaying the duplicate does not grow the record: the audit is visible but not replay-sensitive
  const again = applyEvent(duplicate.record, baseEvent());
  assert.equal(again.record.ignored_events.length, 1);
  assert.deepEqual(jobSummary(again.record).ignored_events, duplicate.record.ignored_events);
  // neighbour: a late event is still recorded alongside it, with its own reason
  const late = applyEvent(again.record, baseEvent({ event_id: 'event-late', sequence: 1 }));
  assert.deepEqual(late.record.ignored_events.map(entry => entry.reason), ['DUPLICATE_EVENT', 'LATE_EVENT']);
});

test('a calendar-impossible instant is refused, not merely shape-checked', () => {
  assert.equal(validateEventEnvelope(baseEvent({ at: '2026-13-45T99:99:99Z' })).ok, false);
  assert.equal(validateEventEnvelope(baseEvent({ at: '2026-02-30T00:00:00.000Z' })).ok, false);
  assert.equal(validateResultEnvelope(baseResult({ produced_at: '2026-02-30T00:00:00.000Z' })).ok, false);
  assert.equal(validateArtifactEnvelope(baseArtifact({ produced_at: '2026-13-01T00:00:00.000Z' })).ok, false);
  assert.equal(admitJob(baseJob({ created_at: '2026-13-01T00:00:00.000Z' })).admitted, false);
  // neighbours: both accepted spellings of a real instant still pass
  assert.equal(validateEventEnvelope(baseEvent({ at: TS })).ok, true);
  assert.equal(validateEventEnvelope(baseEvent({ at: '2026-09-30T12:00:00Z' })).ok, true);
  assert.equal(validateEventEnvelope(baseEvent({ at: LATER })).ok, true);
  assert.equal(validateResultEnvelope(baseResult()).ok, true);
});

test('a terminal announcement without a result is completed by the honest result', () => {
  // a 100 % event may announce a terminal state (the validator blesses that shape above), but the
  // announcement carries no evidence: gating finality on the *state* made the job final with
  // result: null and then refused its own result with "already succeeded with undefined"
  const announced = applyEvent(createJobRecord(baseJob()), baseEvent({ state: 'SUCCEEDED', partial: { progress_percent: 100, summary: 'done' } })).record;
  assert.equal(announced.state, 'SUCCEEDED');
  assert.equal(announced.result, null);
  assert.equal(jobSummary(announced).terminal_status, null);
  const completed = applyResult(announced, baseResult());
  assert.equal(completed.applied, true, 'the result that makes the job final must still be accepted');
  assert.equal(completed.record.result.result_ref, 'result-1');
  assert.equal(completed.record.state, 'SUCCEEDED');
  const summary = jobSummary(completed.record);
  assert.equal(summary.is_terminal, true);
  assert.equal(summary.terminal_status, 'SUCCEEDED');
  assert.equal(summary.acceptance, 'PASS');
  // evidence wins over an announcement: the recorded result, not the event, sets the terminal status
  const announcedSuccess = applyEvent(createJobRecord(baseJob()), baseEvent({ state: 'SUCCEEDED', partial: { progress_percent: 100, summary: 'done' } })).record;
  const failed = applyResult(announcedSuccess, baseResult({ terminal_status: 'FAILED', acceptance: { status: 'FAIL', evidence_refs: [] } }));
  assert.equal(failed.record.state, 'FAILED');
  // neighbour: once a result is recorded, finality is unchanged
  expectCode(() => applyResult(completed.record, baseResult({ result_ref: 'result-2' })), 'TERMINAL_JOB_IS_FINAL');
  const afterResult = applyEvent(completed.record, baseEvent({ event_id: 'event-after', sequence: 5, state: 'RUNNING' }));
  assert.equal(afterResult.applied, false);
  assert.equal(afterResult.reason, 'TERMINAL_JOB_IS_FINAL');
  assert.equal(afterResult.record.state, 'SUCCEEDED');
});

test('the job record is immutable at every level, not only at the top', () => {
  const record = createJobRecord(baseJob());
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.job), true);
  assert.equal(Object.isFrozen(record.event_ids), true);
  assert.equal(Object.isFrozen(record.applied_events), true);
  // a rewritten job_ref would make the record accept another job's event
  assert.throws(() => { record.job.job_ref = 'job-ATTACKER'; }, TypeError);
  expectCode(() => applyEvent(record, baseEvent({ job_ref: 'job-ATTACKER' })), 'INVALID_EVENT');
  const attached = attachArtifact(record, baseArtifact()).record;
  assert.equal(Object.isFrozen(attached.artifacts), true);
  assert.equal(Object.isFrozen(attached.artifacts[0]), true);
  assert.equal(Object.isFrozen(attached.artifacts[0].provenance), true);
  assert.throws(() => { attached.artifacts[0].provenance.device_ref = 'device-ATTACKER'; }, TypeError);
  assert.equal(artifactProvenance(attached.artifacts[0]).device_ref, 'device-1');
  const applied = applyEvent(record, baseEvent()).record;
  assert.equal(Object.isFrozen(applied.applied_events[0]), true);
  assert.throws(() => { applied.event_ids.push('event-forged'); }, TypeError);
  // neighbours: a forger still cannot suppress a real event, and the record still reads normally
  assert.equal(applyEvent(applied, baseEvent({ event_id: 'event-2', sequence: 2 })).applied, true);
  assert.equal(jobSummary(applied).job_ref, 'job-1');
});

test('a non-enumerable own out-of-contract field is refused too', () => {
  const job = { ...baseJob() };
  Object.defineProperty(job, 'transport', { value: 'RF_STREAM', enumerable: false, configurable: true, writable: true });
  assert.deepEqual(Object.keys(job).includes('transport'), false);
  assert.equal(admitJob(job).admitted, false, 'scanning enumerable keys only left the non-enumerable one admitted');
  const event = { ...baseEvent() };
  Object.defineProperty(event, 'rf_stream_ref', { value: 'x', enumerable: false, configurable: true, writable: true });
  assert.equal(validateEventEnvelope(event).ok, false);
  // neighbours: enumerable unknown fields are still refused, and a clean envelope is still admitted
  assert.equal(admitJob(baseJob({ transport: 'RF_STREAM' })).admitted, false);
  assert.equal(admitJob(baseJob()).admitted, true);
  assert.equal(validateEventEnvelope(baseEvent()).ok, true);
});

test('the structured result arrays are bounded like their siblings', () => {
  const files = count => Array.from({ length: count }, (unused, index) => ({ path: `f${index}.mjs`, status: 'MODIFIED', digest: null }));
  assert.equal(validateResultEnvelope(baseResult({ changed_files: files(MAX_CHANGED_FILES) })).ok, true);
  assert.equal(validateResultEnvelope(baseResult({ changed_files: files(MAX_CHANGED_FILES + 1) })).ok, false);
  assert.equal(validateResultEnvelope(baseResult({ tests: Array.from({ length: 5000 }, () => ({ name: 't', status: 'PASS' })) })).ok, false);
  assert.equal(validateResultEnvelope(baseResult({ controller_decisions: Array.from({ length: 5000 }, () => ({ decision: 'd', reason: 'r' })) })).ok, false);
  // neighbours: the text arrays keep their existing caps, and a normal result still validates
  assert.equal(validateResultEnvelope(baseResult({ warnings: Array.from({ length: 33 }, () => 'w') })).ok, false);
  assert.equal(validateResultEnvelope(baseResult()).ok, true);
  assert.equal(validateResultEnvelope(baseResult({ changed_files: files(2) })).ok, true);
});

test('a cyclic or over-deep envelope is refused, never a stack overflow', () => {
  const loop = [];
  loop.push(loop);
  const cyclic = { ...baseJob(), context_refs: loop };
  const verdict = admitJob(cyclic);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.errors.every(error => typeof error === 'string'), true);
  const cyclicObject = { token: 'raw' };
  cyclicObject.self = cyclicObject;
  assert.deepEqual(findRawSecretFields(cyclicObject, ''), ['.token']);
  // depth is attacker-controlled data, so it is bounded rather than left to the stack
  let deep = 'leaf';
  for (let index = 0; index < 200; index += 1) deep = { next: deep };
  assert.equal(admitJob({ ...baseJob(), context_refs: [deep] }).admitted, false);
  assert.equal(envelopeDepthExceeded(deep), true);
  // neighbours: a shallow, acyclic envelope is unaffected, and a deep-but-legal nesting is allowed
  assert.equal(admitJob(baseJob()).admitted, true);
  assert.equal(envelopeDepthExceeded(baseJob()), false);
  assert.equal(envelopeDepthExceeded({ a: { b: { c: 'd' } } }), false);
  assert.equal(admitJob(baseJob({ context_refs: ['context-1', 'context-2'] })).admitted, true);
});

