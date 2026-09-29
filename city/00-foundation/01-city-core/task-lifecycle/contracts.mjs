/**
 * UTOPIA · City Core — global task lifecycle vocabulary.
 *
 * Ported from the Codex-Boss donor `src/shared/candidate-gate.ts` §35 @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The donor's §35 rule is the reason this state machine exists at all: a task may
 * not jump from RUNNING to COMPLETED. It walks
 * RUNNING → IMPLEMENTED → VERIFYING → REVIEWING → CANDIDATE → ACCEPTED, and
 * CANDIDATE is a real state with a real meaning — all the code is done, but no
 * release permission has been granted yet. A repair moves exactly one step back.
 *
 * The edge tables are the contract. Nothing here infers a transition from a name,
 * a score or a caller's optimism: an event the current state does not allow is
 * refused and the refusal carries the allowed set.
 *
 * Pure: no fs, no network, no clock, no process. Time arrives as a parameter.
 */

/** The donor's stable version string for this gate. */
export const CANDIDATE_GATE_VERSION = 'candidate-gate-1';

/** §35: the lifecycle, in order. Index order is load-bearing (see advanceLifecycle). */
export const TASK_LIFECYCLE = ['RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING', 'CANDIDATE', 'ACCEPTED'];

/**
 * The legal edges. `ACCEPTED` is terminal: no transition leaves it, so a released
 * task can never be walked back into work by an event.
 */
export const TASK_TRANSITIONS = {
  RUNNING: ['IMPLEMENTED'],
  IMPLEMENTED: ['VERIFYING', 'RUNNING'],
  VERIFYING: ['REVIEWING', 'IMPLEMENTED'],
  REVIEWING: ['CANDIDATE', 'VERIFYING'],
  CANDIDATE: ['ACCEPTED', 'REVIEWING'],
  ACCEPTED: [],
};

/** The named events that drive the lifecycle. */
export const LIFECYCLE_EVENTS = ['IMPLEMENTED', 'VERIFIED', 'REVIEWED', 'CANDIDATED', 'ACCEPTED', 'REPAIR'];

/** The event that moves a state forward. */
export const FORWARD_EVENTS = {
  RUNNING: 'IMPLEMENTED',
  IMPLEMENTED: 'VERIFIED',
  VERIFYING: 'REVIEWED',
  REVIEWING: 'CANDIDATED',
  CANDIDATE: 'ACCEPTED',
  ACCEPTED: null,
};

/** The event that sends a state back, and where it lands. */
export const BACKWARD_EVENTS = {
  RUNNING: [],
  IMPLEMENTED: [['REPAIR', 'RUNNING']],
  VERIFYING: [['REPAIR', 'IMPLEMENTED']],
  REVIEWING: [['REPAIR', 'VERIFYING']],
  CANDIDATE: [['REPAIR', 'REVIEWING']],
  ACCEPTED: [],
};

/** The terminal states: nothing leaves them. */
export const TERMINAL_LIFECYCLE_STATES = TASK_LIFECYCLE.filter((state) => TASK_TRANSITIONS[state].length === 0);

/** True when `state` is a declared lifecycle state. */
export function isLifecycleState(state) {
  return TASK_LIFECYCLE.includes(state);
}

/** True when `event` is a declared lifecycle event. */
export function isLifecycleEvent(event) {
  return LIFECYCLE_EVENTS.includes(event);
}

/** Raised when a lifecycle step or record is structurally unusable. */
export class TaskLifecycleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskLifecycleError';
    this.code = 'TASK_LIFECYCLE_INVALID';
  }
}

/**
 * One step of the walk: which state was entered, when, what justified it, and the
 * evidence pointers that justify it. A step without evidence is still a step — the
 * donor records the pointer list rather than requiring it to be non-empty, and we
 * keep that, because the Guardian (§36, see the `audit-ledger` module) is what
 * refuses an unevidenced acceptance.
 */
export function lifecycleStep({ state, at, reason, evidence = [] }) {
  if (!isLifecycleState(state)) throw new TaskLifecycleError(`lifecycleStep: unknown state ${state}`);
  if (typeof at !== 'string' || !at.trim()) throw new TaskLifecycleError('lifecycleStep: at must be a non-empty string');
  if (typeof reason !== 'string' || !reason.trim()) throw new TaskLifecycleError('lifecycleStep: reason must be a non-empty string');
  if (!Array.isArray(evidence) || evidence.some((item) => typeof item !== 'string')) {
    throw new TaskLifecycleError('lifecycleStep: evidence must be a list of strings');
  }
  return { state, at, reason, evidence: [...evidence] };
}

/**
 * §35's meaning of CANDIDATE made explicit: recording the state is not a
 * promotion. `awaiting_release_permission` is true for every state except
 * ACCEPTED, so the record itself says who is still owed a decision.
 */
export function candidateRecordFor({ task_id, state, requirements, completion_evidence, guardian, steps, now }) {
  if (typeof task_id !== 'string' || !task_id.trim()) throw new TaskLifecycleError('candidateRecordFor: task_id is required');
  if (!isLifecycleState(state)) throw new TaskLifecycleError(`candidateRecordFor: unknown state ${state}`);
  return {
    schemaVersion: 1,
    version: CANDIDATE_GATE_VERSION,
    task_id,
    state,
    requirements: [...(requirements ?? [])],
    completion_evidence: [...(completion_evidence ?? [])],
    guardian,
    steps: [...(steps ?? [])],
    awaiting_release_permission: state !== 'ACCEPTED',
    // The donor defaults to the Unix epoch rather than "now" so a record built
    // without a clock is deterministic; the caller supplies the real time.
    created_at: now ?? new Date(0).toISOString(),
  };
}
