// Public surface of the local-first Sub-worker placement gate (EM-006).
//
// LOCAL_FIRST: the local host is attempted first; remote fallback is proposed only for a measured
// LOCAL_BLOCKED / LOCAL_UNAVAILABLE and requires explicit user approval. Speed is never a reason.
export * from './placement.mjs';

export const ENGINEERING_PLACEMENT_CONTRACT = Object.freeze({
  id: 'engineering-placement',
  version: 1,
  placement_policy: 'LOCAL_FIRST',
  remote_fallback: 'ASK_USER',
  remote_selected_because_faster: false,
  reduces_local_concurrency_first: true,
  remote_fallback_requires_user_approval: true,
  requires_measured_blocking_reason: true,
  speed_ranking_allowed: false,
  local_attempt_required_before_dispatch: true,
  owner_moves_with_execution: false,
});
