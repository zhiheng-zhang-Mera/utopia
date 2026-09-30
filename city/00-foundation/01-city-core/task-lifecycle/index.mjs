/**
 * UTOPIA · City Core — task-lifecycle module entry point.
 *
 * Cluster B of MB-001: global task identity + lifecycle. Donor provenance,
 * the exact ported behaviour and every deliberate difference are recorded in
 * `./DONOR.json`; the walker itself is documented in `./task-lifecycle.mjs`.
 */

export {
  BACKWARD_EVENTS,
  CANDIDATE_GATE_VERSION,
  FORWARD_EVENTS,
  LIFECYCLE_EVENTS,
  TASK_LIFECYCLE,
  TASK_TRANSITIONS,
  TERMINAL_LIFECYCLE_STATES,
  TaskLifecycleError,
  candidateRecordFor,
  isLifecycleEvent,
  isLifecycleState,
  lifecycleStep,
} from './contracts.mjs';

export { advanceLifecycle, candidateIdFor } from './task-lifecycle.mjs';
