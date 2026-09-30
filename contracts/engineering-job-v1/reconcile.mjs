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

/**
 * The record is canonical state, so *every* level of it must be immutable. `Object.freeze` alone only
 * freezes the top level: with a shallow freeze a caller could rewrite `record.job.job_ref` so the
 * record accepted another job's event, push into `event_ids` so a real event was suppressed as a
 * duplicate, or edit a stored artifact's provenance and have `artifactProvenance()` report the
 * forgery. Cycle-safe via the frozen check.
 */
const deepFreeze = value => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
};

/**
 * A content digest over the *whole* value, used to tell "the same thing arrived twice" from
 * "something else arrived under the same name". Idempotency that compares only a caller-chosen
 * `*_ref` cannot distinguish those, and silently reports the second as a harmless duplicate.
 */
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};
const contentDigest = value => {
  const text = canonical(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * Admit a job into a record. The admission verdict is kept, so a blocked job stays explainable.
 *
 * A record is born by *admission* — the job is starting — so it may not be born terminal. A job
 * envelope that declares SUCCEEDED/FAILED/CANCELLED/REFUSED produces an unearned terminal state with
 * `result: null`, which `jobSummary` then reports as a finished job with no terminal status, no
 * acceptance and no evidence, and which makes `applyResult` refuse the genuine result with
 * `TERMINAL_JOB_IS_FINAL ... already succeeded with undefined`. Terminal state is reached only by
 * applying a result, which is the one path that requires evidence.
 */
export function createJobRecord(job) {
  const admission = admitJob(job);
  if (!admission.admitted) throw new EngineeringJobError(admission.code, admission.detail);
  if (TERMINAL_JOB_STATES.includes(job.state)) {
    throw new EngineeringJobError('INVALID_ENGINEERING_JOB', `a job record cannot be created already terminal (${job.state}); terminal state is reached only by applying a result`);
  }
  return deepFreeze({
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

const nextRecord = (record, patch) => deepFreeze({ ...clone(record), ...patch });

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

  const ignored = reason => {
    // Recording an ignored decision must not itself be replay-sensitive: the same duplicate or late
    // event applied twice leaves the record identical, so reapplication stays idempotent while the
    // first occurrence is still visible to an auditor.
    const already = record.ignored_events.some(entry => entry.event_id === event.event_id && entry.reason === reason);
    const next = already ? record : nextRecord(record, { ignored_events: [...record.ignored_events, { event_id: event.event_id, reason, at: event.at }] });
    return { record: next, applied: false, reason };
  };
  // A duplicate is an ignored decision too, and the record is the canonical audit surface: without
  // this the durable state could not distinguish "arrived once" from "arrived twice", because only
  // the batch result reported it and `jobSummary` reads the record.
  if (record.event_ids.includes(event.event_id)) return ignored('DUPLICATE_EVENT');
  if (TERMINAL_JOB_STATES.includes(record.state)) return ignored('TERMINAL_JOB_IS_FINAL');
  // An event from a superseded incarnation of the job must never act on the current one: `sequence`
  // is only monotonic *within* a job version, so a stale event with a higher sequence could otherwise
  // walk the state backwards or terminally fail a job that is still running.
  if (event.job_version < record.job_version) return ignored('STALE_JOB_VERSION');
  if (event.sequence <= record.last_sequence) return ignored('LATE_EVENT');

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
  // The ordering pass reads `sequence` from every entry, so the batch shape must be checked first:
  // sorting on unvalidated input dereferenced `null` and escaped the contract's error taxonomy as an
  // untyped TypeError.
  const malformed = events.findIndex(entry => !isPlainObject(entry));
  if (malformed !== -1) throw new EngineeringJobError('INVALID_EVENT', `events[${malformed}] must be an event object`);
  // Deterministic and total: sequence first, then event id, and equal ids compare equal.
  const ordered = [...events].sort((left, right) => (left.sequence - right.sequence) || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0));
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
 * says the job already finished. "The same result" is decided by content, not by the caller-chosen
 * `result_ref`: comparing the ref alone reported a rewritten result as a harmless replay and left
 * the first-arrived version on the record.
 *
 * Finality is gated on a **recorded result**, not on the job state. A 100 % event may legitimately
 * announce a terminal state (D7), but that announcement carries no evidence — and gating on the state
 * meant the job became final with `result: null`, after which its own honest result was refused with
 * `TERMINAL_JOB_IS_FINAL ... already succeeded with undefined`. A terminal state without a result is
 * an announcement; the result is what makes it final.
 */
export function applyResult(record, result) {
  const verdict = validateResultEnvelope(result);
  if (!verdict.ok) throw new EngineeringJobError('INVALID_RESULT', verdict.errors.slice(0, 3).join('; '));
  if (result.job_ref !== record.job.job_ref) throw new EngineeringJobError('RESULT_JOB_MISMATCH', `${result.job_ref} != ${record.job.job_ref}`);
  if (record.result !== null) {
    if (record.result.result_ref === result.result_ref) {
      if (contentDigest(record.result) === contentDigest(result)) return { record, applied: false, reason: 'DUPLICATE_RESULT' };
      throw new EngineeringJobError('TERMINAL_JOB_IS_FINAL', `job ${record.job.job_ref} already finished as ${record.state}; result ${result.result_ref} does not match the recorded one, so it is not a replay`);
    }
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

/**
 * Attach an artifact. Provenance is mandatory and is copied, never inherited from the caller's object.
 *
 * A repeat is recognised by content and by the `sha256` digest the envelope already carries — keying
 * on `artifact_ref` alone reported a *different* artifact as already attached, so a changed payload
 * was silently dropped while the caller was told it was a duplicate.
 */
export function attachArtifact(record, artifact) {
  const verdict = validateArtifactEnvelope(artifact);
  if (!verdict.ok) throw new EngineeringJobError('INVALID_ARTIFACT', verdict.errors.slice(0, 3).join('; '));
  if (artifact.job_ref !== record.job.job_ref) throw new EngineeringJobError('INVALID_ARTIFACT', `artifact ${artifact.artifact_ref} belongs to ${artifact.job_ref}`);
  const existing = record.artifacts.find(entry => entry.artifact_ref === artifact.artifact_ref);
  if (existing) {
    if (existing.digest === artifact.digest && contentDigest(existing) === contentDigest(artifact)) {
      return { record, applied: false, reason: 'DUPLICATE_ARTIFACT' };
    }
    throw new EngineeringJobError('INVALID_ARTIFACT', `artifact ${artifact.artifact_ref} is already attached with digest ${existing.digest}; refusing to keep the recorded artifact silently when the replayed one differs`);
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
