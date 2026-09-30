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
 JOB_REJECTION_CODES, JOB_STATES, TERMINAL_JOB_STATES, admitJob, artifactProvenance, assertJobEnvelope,
 attachArtifact, createJobRecord, findRawSecretFields, jobSummary, reconcileEvents, applyEvent,
 applyResult, validateArtifactEnvelope, validateEventEnvelope, validateResultEnvelope
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
