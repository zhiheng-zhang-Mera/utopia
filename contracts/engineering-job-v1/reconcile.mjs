// Job state reconciliation: late, duplicate and out-of-order events, and terminal immutability
// (EM-003).
//
// Every rule here is deterministic: the same event stream applied to the same record always
// produces the same state, and a decision that is ignored records *why* it was ignored. A job is
// never resurrected from a terminal state, and a partial/progress event can never end one.
import {
  ACTIVE_JOB_STATES, EngineeringJobError, JOB_STATES, TERMINAL_JOB_STATES,
  validateArtifactEnvelope, validateEventEnvelope, validateResultEnvelope, admitJob
} from './envelopes.mjs';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => (value === undefined ? undefined : structuredClone(value));

/** Admit a job into a record. The admission verdict is kept, so a blocked job stays explainable. */
export function createJobRecord(job) {
  const admission = admitJob(job);
  if (!admission.admitted) throw new EngineeringJobError(admission.code, admission.detail);
  return Object.freeze({
    job: clone(job),
    state: job.state,
    job_version: job.job_version,
    last_sequence: 0,
    event_ids: [],
    applied_events: [],
    ignored_events: [],
    artifacts: [],
    result: null,
  });
}

const nextRecord = (record, patch) => ({ ...clone(record), ...patch });

/**
 * Apply one event.
 *
 * - a duplicate `event_id` is a no-op (idempotent);
 * - an event at or below the last applied sequence is a *late* duplicate, kept as ignored with its
 *   reason rather than silently re-applied;
 * - a forward gap is accepted and recorded as a gap, so out-of-order arrival does not lose state;
 * - a terminal job ignores anything that would change its state.
 */
export function applyEvent(record, event) {
  const verdict = validateEventEnvelope(event);
  if (!verdict.ok) throw new EngineeringJobError('INVALID_EVENT', verdict.errors.slice(0, 3).join('; '));
  if (event.job_ref !== record.job.job_ref) throw new EngineeringJobError('INVALID_EVENT', `event ${event.event_id} belongs to ${event.job_ref}, not ${record.job.job_ref}`);

  if (record.event_ids.includes(event.event_id)) {
    return { record, applied: false, reason: 'DUPLICATE_EVENT' };
  }
  if (TERMINAL_JOB_STATES.includes(record.state)) {
    const ignored = { record: nextRecord(record, { ignored_events: [...record.ignored_events, { event_id: event.event_id, reason: 'TERMINAL_JOB_IS_FINAL', at: event.at }] }) };
    return { record: ignored.record, applied: false, reason: 'TERMINAL_JOB_IS_FINAL' };
  }
  if (event.sequence <= record.last_sequence) {
    const ignored = nextRecord(record, { ignored_events: [...record.ignored_events, { event_id: event.event_id, reason: 'LATE_EVENT', at: event.at }] });
    return { record: ignored, applied: false, reason: 'LATE_EVENT' };
  }

  // A gap is any forward jump that is not exactly the next sequence: a stream that starts at 5, or
  // resumes at 9, has holes, and recording that is more useful than quietly accepting the jump.
  const gap = event.sequence !== record.last_sequence + 1;
  const applied = {
    event_id: event.event_id,
    sequence: event.sequence,
    stage: event.stage,
    state: event.state,
    at: event.at,
    gap_before: gap,
  };
  const next = nextRecord(record, {
    state: event.state,
    job_version: Math.max(record.job_version, event.job_version),
    last_sequence: event.sequence,
    event_ids: [...record.event_ids, event.event_id],
    applied_events: [...record.applied_events, applied],
  });
  return { record: next, applied: true, reason: gap ? 'APPLIED_AFTER_GAP' : 'APPLIED' };
}

/** Reconcile a batch: order is deterministic (sequence, then event id) and every decision is reported. */
export function reconcileEvents(record, events) {
  if (!Array.isArray(events)) throw new EngineeringJobError('INVALID_EVENT', 'events must be an array');
  const ordered = [...events].sort((left, right) => (left.sequence - right.sequence) || (left.event_id < right.event_id ? -1 : 1));
  let current = record;
  const applied = [];
  const ignored = [];
  for (const event of ordered) {
    const outcome = applyEvent(current, event);
    current = outcome.record;
    if (outcome.applied) applied.push({ event_id: event.event_id, sequence: event.sequence, reason: outcome.reason });
    else ignored.push({ event_id: event.event_id, reason: outcome.reason });
  }
  return { record: current, applied, ignored };
}

/**
 * Apply a terminal result.
 *
 * A terminal job is final: a later or replayed result can never resurrect it into an active state.
 * Re-applying the *same* result is an idempotent no-op; a different one is refused with a code that
 * says the job already finished.
 */
export function applyResult(record, result) {
  const verdict = validateResultEnvelope(result);
  if (!verdict.ok) throw new EngineeringJobError('INVALID_RESULT', verdict.errors.slice(0, 3).join('; '));
  if (result.job_ref !== record.job.job_ref) throw new EngineeringJobError('RESULT_JOB_MISMATCH', `${result.job_ref} != ${record.job.job_ref}`);
  if (record.state === 'SUCCEEDED') {
    if (record.result?.result_ref === result.result_ref) return { record, applied: false, reason: 'DUPLICATE_RESULT' };
    throw new EngineeringJobError('TERMINAL_JOB_IS_FINAL', `job ${record.job.job_ref} already succeeded with ${record.result?.result_ref}`);
  }
  if (TERMINAL_JOB_STATES.includes(record.state)) {
    if (record.result?.result_ref === result.result_ref) return { record, applied: false, reason: 'DUPLICATE_RESULT' };
    throw new EngineeringJobError('TERMINAL_JOB_IS_FINAL', `job ${record.job.job_ref} already finished as ${record.state}`);
  }
  if (result.job_version < record.job_version) throw new EngineeringJobError('RESULT_VERSION_MISMATCH', `result version ${result.job_version} < current ${record.job_version}`);
  const next = nextRecord(record, {
    state: result.terminal_status,
    job_version: result.job_version + 1,
    result: clone(result),
  });
  return { record: next, applied: true, reason: 'APPLIED' };
}

/** Attach an artifact. Provenance is mandatory and is copied, never inherited from the caller's object. */
export function attachArtifact(record, artifact) {
  const verdict = validateArtifactEnvelope(artifact);
  if (!verdict.ok) throw new EngineeringJobError('INVALID_ARTIFACT', verdict.errors.slice(0, 3).join('; '));
  if (artifact.job_ref !== record.job.job_ref) throw new EngineeringJobError('INVALID_ARTIFACT', `artifact ${artifact.artifact_ref} belongs to ${artifact.job_ref}`);
  if (record.artifacts.some(entry => entry.artifact_ref === artifact.artifact_ref)) {
    return { record, applied: false, reason: 'DUPLICATE_ARTIFACT' };
  }
  const next = nextRecord(record, { artifacts: [...record.artifacts, clone(artifact)] });
  return { record: next, applied: true, reason: 'ATTACHED' };
}

/** The record as an auditable summary: what ran, what it decided, and what it produced. */
export function jobSummary(record) {
  if (!isPlainObject(record) || !isPlainObject(record.job)) throw new EngineeringJobError('INVALID_ENGINEERING_JOB', 'a job record is required');
  return Object.freeze({
    job_ref: record.job.job_ref,
    state: record.state,
    execution_mode: record.job.execution_mode,
    is_terminal: TERMINAL_JOB_STATES.includes(record.state),
    is_active: ACTIVE_JOB_STATES.includes(record.state),
    known_states: Object.freeze([...JOB_STATES]),
    applied_events: record.applied_events.length,
    ignored_events: record.ignored_events.map(entry => ({ ...entry })),
    artifacts: record.artifacts.map(entry => entry.artifact_ref).sort(),
    result_ref: record.result?.result_ref ?? null,
    terminal_status: record.result?.terminal_status ?? null,
    acceptance: record.result?.acceptance?.status ?? null,
  });
}
