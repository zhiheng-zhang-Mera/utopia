// UXI-391 — the ownership-transfer EXECUTION bridge.
//
// THE GAP THIS CLOSES: `planRoute()` decides and never acts (`executed: false` is part of its own contract),
// and nothing consumed that decision. So `REMOTE_HANDOFF` was a surface state with no execution behind it -
// the planner picked an alternate device and the task stayed owned by the device that had died. The City
// already had the vocabulary for moving a claim safely (`city-core/fleet-routing/assignment-guard.mjs`) and
// NOTHING imported it, which is the same "vocabulary without a user" defect that guard's own header complains
// about for the RS-202 assignment states.
//
// WHAT THIS DELIBERATELY IS NOT:
//   - it does NOT plan. The device comes from the planner; this module never recomputes or second-guesses the
//     choice, and it never lets the UI pick a device;
//   - it does NOT act on any stage but `ALTERNATE_DEVICE`, which RS-202 reaches only once the USER has
//     declined the provider switch - so a transfer cannot happen without the user's own recorded intent;
//   - it never fabricates an outcome. A refused transfer changes nothing and says REFUSED; a caller that
//     cannot complete the move must leave the task non-terminal or explicitly failed, never COMPLETED;
//   - it proves ownership transfer with WAIT and claims nothing about exactly-once for side-effecting task
//     types (the workbook forbids that generalisation).
import { createAssignmentGuard } from '../../city/00-foundation/01-city-core/fleet-routing/assignment-guard.mjs';

export const HANDOFF_OUTCOMES = Object.freeze(['NOT_APPLICABLE', 'TRANSFERRED', 'REFUSED']);

export function createHandoffBridge({guard = createAssignmentGuard()} = {}) {
  /**
   * Record that a device now holds the task, so a later transfer has a current holder to move FROM.
   *
   * Idempotent for the same device on purpose: a node re-claiming the task it already holds (a retry after a
   * dropped response) must not look like a conflict. Anything held by a DIFFERENT device is reported as a
   * conflict rather than silently overwritten, because that is the double-execution case.
   */
  function noteAssignment({subjectRef, deviceRef}) {
    if (guard.holder(subjectRef) === deviceRef) {
      return Object.freeze({outcome: 'IDEMPOTENT', deviceRef});
    }
    const claimed = guard.claim({subjectRef, deviceRef});
    return Object.freeze({outcome: claimed.outcome, deviceRef, heldBy: guard.holder(subjectRef)});
  }

  /** True when `deviceRef` may take this task: nobody else holds it and it is not reserved for someone else. */
  function claimAllowed({subjectRef, deviceRef, reservedFor = null}) {
    if (typeof reservedFor === 'string' && reservedFor.length > 0 && reservedFor !== deviceRef) return false;
    const holder = guard.holder(subjectRef);
    return holder === null || holder === deviceRef;
  }

  /**
   * Execute the transfer the planner decided, exactly once, guarded.
   *
   * The guard is what makes this a compare-and-set rather than a hope: only the CURRENT holder may hand the
   * subject on, and the epoch is bumped, so the previous holder's late retry is no longer idempotent and
   * cannot reclaim work that has moved.
   */
  function consider({task, decided}) {
    if (!decided || decided.stage !== 'ALTERNATE_DEVICE') {
      return Object.freeze({outcome: 'NOT_APPLICABLE', reason: decided?.stage ?? 'NO_DECISION'});
    }
    const from = typeof task?.assignedNodeId === 'string' && task.assignedNodeId.length > 0 ? task.assignedNodeId : null;
    const to = typeof decided.chosenDeviceRef === 'string' && decided.chosenDeviceRef.length > 0 ? decided.chosenDeviceRef : null;
    if (from === null || to === null) {
      return Object.freeze({outcome: 'REFUSED', reason: 'NO_TRANSFER_ENDPOINTS', from, to});
    }
    if (from === to) {
      return Object.freeze({outcome: 'REFUSED', reason: 'SAME_DEVICE', from, to});
    }
    if (typeof task?.handoffTargetRef === 'string' && task.handoffTargetRef === to) {
      // Already transferred: a repeated decline (or a duplicate request) must be a no-op, not a second move.
      return Object.freeze({outcome: 'REFUSED', reason: 'ALREADY_TRANSFERRED', from, to});
    }
    const moved = guard.transfer({subjectRef: task.id, fromDeviceRef: from, toDeviceRef: to});
    if (moved.outcome !== 'TRANSFERRED') {
      return Object.freeze({outcome: 'REFUSED', reason: moved.outcome, detail: moved.detail ?? null, from, to});
    }
    return Object.freeze({outcome: 'TRANSFERRED', from, to, epoch: moved.epoch});
  }

  /**
   * Drop the guard's hold on a subject, so a released reservation really frees the work.
   *
   * WHY THIS EXISTS AND WHY IT WAS MISSING: clearing the task's `handoffTargetRef` releases the PERSISTED
   * reservation, but the in-memory assignment guard still named the dead device as the holder, and
   * `claimAllowed` therefore went on refusing every other device. My own scenario-3 test caught exactly that:
   * the reservation cleared and the run stayed unclaimable. Only the recorded holder may release, which is the
   * guard's own rule.
   */
  function releaseReservation({subjectRef, deviceRef}) {
    return guard.release({subjectRef, deviceRef});
  }

  return Object.freeze({
    consider,
    noteAssignment,
    claimAllowed,
    releaseReservation,
    holder: subjectRef => guard.holder(subjectRef),
    epoch: subjectRef => guard.epoch(subjectRef),
    stats: () => guard.stats(),
  });
}
