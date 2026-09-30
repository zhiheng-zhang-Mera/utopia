/**
 * UTOPIA · City Core — global task lifecycle walker.
 *
 * Ported from the Codex-Boss donor `src/shared/candidate-gate.ts` §35 @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * Two rules are carried over exactly and must not be softened:
 *
 *   - an event the current state does not allow is REFUSED, never silently
 *     applied, and the refusal states the allowed set;
 *   - the forward move lands on the next state in the declared order, so
 *     `advanceLifecycle` cannot jump over a state even if a caller asks it to.
 *
 * Repair is the only backward move and it is exactly one step. ACCEPTED is
 * terminal: no event leaves it.
 */

import { createHash } from 'node:crypto';
import {
  BACKWARD_EVENTS,
  FORWARD_EVENTS,
  TASK_LIFECYCLE,
  TASK_TRANSITIONS,
  TaskLifecycleError,
  isLifecycleEvent,
  isLifecycleState,
} from './contracts.mjs';

export { CANDIDATE_GATE_VERSION } from './contracts.mjs';

/**
 * Walks one event and returns the resulting state plus the reason.
 *
 * The forward branch is keyed by the event name but lands on the *next declared
 * state*, which is the donor's ordering guarantee. A refused event returns the
 * current state unchanged with `accepted: false` and the allowed transitions, so
 * a caller can report the refusal instead of guessing.
 */
export function advanceLifecycle(current, event) {
  if (!isLifecycleState(current)) throw new TaskLifecycleError(`advanceLifecycle: unknown state ${current}`);
  if (!isLifecycleEvent(event)) throw new TaskLifecycleError(`advanceLifecycle: unknown event ${event}`);

  const forward = FORWARD_EVENTS[current];
  if (forward === event) {
    const next = TASK_LIFECYCLE[TASK_LIFECYCLE.indexOf(current) + 1];
    return {
      accepted: true,
      state: next,
      reason: `${current} --${event}--> ${next}`,
      allowed: TASK_TRANSITIONS[current],
    };
  }

  const back = BACKWARD_EVENTS[current].find(([name]) => name === event);
  if (back) {
    return {
      accepted: true,
      state: back[1],
      reason: `${current} --${event}--> ${back[1]} (repair)`,
      allowed: TASK_TRANSITIONS[current],
    };
  }

  return {
    accepted: false,
    state: current,
    reason: `${event} is not legal from ${current}; the lifecycle is ${TASK_LIFECYCLE.join(' → ')} and transitions are ${TASK_TRANSITIONS[current].join(', ') || 'none'}`,
    allowed: TASK_TRANSITIONS[current],
  };
}

/**
 * A stable id for a candidate record, so a repair can point back at the record it
 * repairs. Ported from the donor's `candidateIdFor`, including its canonical form:
 * the task id, then the requirements SORTED, joined by NUL, hashed with SHA-256 and
 * truncated to 16 hex characters. Sorting is what makes the id independent of the
 * order the caller happened to list requirements in.
 */
export function candidateIdFor(taskId, requirements) {
  if (typeof taskId !== 'string' || !taskId.trim()) throw new TaskLifecycleError('candidateIdFor: taskId is required');
  const joined = [taskId, ...[...(requirements ?? [])].sort()].join('\u0000');
  return `cand-${contentHashOf(joined).slice(0, 16)}`;
}

/** The donor's `contentHashOf` (workbook.ts): SHA-256 of the UTF-8 text, lowercase hex. */
function contentHashOf(content) {
  return createHash('sha256').update(Buffer.from(String(content), 'utf8')).digest('hex');
}
