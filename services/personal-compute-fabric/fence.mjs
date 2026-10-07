// PCF-712 (fencing half): the fence epoch and the idempotent start/report/commit gate.
//
// The candidate already reconciles a snapshot against live observations and runs a bounded supervisor loop. What it did
// NOT have is the explicit fence the workbook names, and the property that fence exists for: EVERY start, report and
// result commit must prove it belongs to the CURRENT holder of the attempt. Without that, a worker that was replaced
// (a drain, a crash, a taken-over lease) can still report success and have it recorded - the classic stale-writer bug.
//
// Two rules are enforced structurally rather than documented:
//   * a fence is not a counter alone. It is `{holderRef, bootRef, epoch, attemptRef}`: an epoch that matches while the
//     holder does not is still a stale writer, so the holder is compared too;
//   * a holder change ADVANCES the epoch, and an advance never goes backwards. A replayed or out-of-order event can
//     therefore not rewind a fence and resurrect an old holder.
import {requireThat as ok, text, finite, freeze} from './validation.mjs';

export const FENCE_REFUSALS = Object.freeze({
  STALE_EPOCH: 'FENCE_STALE_EPOCH',
  WRONG_HOLDER: 'FENCE_WRONG_HOLDER',
  WRONG_BOOT: 'FENCE_WRONG_BOOT',
  WRONG_ATTEMPT: 'FENCE_WRONG_ATTEMPT',
  NOT_INITIALIZED: 'FENCE_NOT_INITIALIZED',
  PERSISTENCE_FAILED: 'FENCE_PERSISTENCE_FAILED',
});

const ref = value => text(value) && value.length <= 256;
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** A durable holder record: which worker holds which attempt, under which epoch and boot. */
export function createFence({holderRef, bootRef, attemptRef, epoch = 1, since = 0} = {}) {
  ok(ref(holderRef), 'FENCE_HOLDER_REQUIRED');
  ok(ref(bootRef), 'FENCE_BOOT_REQUIRED');
  ok(ref(attemptRef), 'FENCE_ATTEMPT_REQUIRED');
  ok(Number.isSafeInteger(epoch) && epoch >= 1, 'FENCE_EPOCH_REQUIRED');
  ok(finite(since), 'FENCE_SINCE_REQUIRED');
  return freeze({fenceVersion: 1, holderRef, bootRef, attemptRef, epoch, since});
}

/**
 * A holder change: the SAME attempt moves to a new holder (a restart, a takeover, a re-lease). The epoch advances by
 * exactly one and never goes backward, so two concurrent advances cannot produce the same epoch.
 */
export function advanceFence(current, {holderRef, bootRef, now = Date.now()} = {}) {
  ok(isPlainObject(current), FENCE_REFUSALS.NOT_INITIALIZED);
  ok(ref(holderRef) && ref(bootRef), 'FENCE_HOLDER_REQUIRED');
  if (current.holderRef === holderRef && current.bootRef === bootRef) {
    // Re-registering the same holder and boot is NOT a change: returning the same fence keeps the operation idempotent
    // rather than burning an epoch on a retry.
    return current;
  }
  return createFence({holderRef, bootRef, attemptRef: current.attemptRef, epoch: current.epoch + 1, since: now});
}

/**
 * The gate every start, report and commit goes through. Each mismatch has its OWN code, so a refusal says which fact
 * disagreed instead of one opaque denial.
 */
export function assertFenced(current, claim) {
  ok(isPlainObject(current), FENCE_REFUSALS.NOT_INITIALIZED);
  ok(isPlainObject(claim), 'FENCE_CLAIM_REQUIRED');
  // A claim must be COMPLETE before it is compared: an empty object would otherwise be reported as a wrong attempt,
  // which names the wrong problem.
  ok(ref(claim.attemptRef) && Number.isSafeInteger(claim.epoch) && ref(claim.holderRef) && ref(claim.bootRef), 'FENCE_CLAIM_INCOMPLETE');
  ok(claim.attemptRef === current.attemptRef, FENCE_REFUSALS.WRONG_ATTEMPT + ':' + String(claim.attemptRef) + '!=' + current.attemptRef);
  ok(claim.epoch === current.epoch, FENCE_REFUSALS.STALE_EPOCH + ':' + String(claim.epoch) + '!=' + current.epoch);
  // Epoch alone is not enough: a different holder that happened to learn the epoch must still be refused.
  ok(claim.holderRef === current.holderRef, FENCE_REFUSALS.WRONG_HOLDER + ':' + String(claim.holderRef) + '!=' + current.holderRef);
  ok(claim.bootRef === current.bootRef, FENCE_REFUSALS.WRONG_BOOT + ':' + String(claim.bootRef) + '!=' + current.bootRef);
  return true;
}

/** A claim derived from a fence, so a caller cannot hand-assemble one that omits a field. */
export const claimOf = fence => freeze({attemptRef: fence.attemptRef, epoch: fence.epoch, holderRef: fence.holderRef, bootRef: fence.bootRef});

/**
 * Persist BEFORE acting. A fence recorded after the side effect would leave a window in which work ran under no
 * recorded ownership, which is exactly what "persistence failure must not execute first and book later" forbids.
 */
export function persistFenceBeforeAction(current, claim, persist) {
  ok(typeof persist === 'function', 'FENCE_PERSISTENCE_REQUIRED');
  assertFenced(current, claim);
  try {
    persist(current);
  } catch (error) {
    return freeze({executed: false, reason: FENCE_REFUSALS.PERSISTENCE_FAILED, detail: String(error?.message ?? error)});
  }
  return freeze({executed: true, reason: null, detail: null});
}

/**
 * Event application with idempotent replay handling. A duplicate event must not produce a duplicate result, and a LOST
 * event must be visible as a gap rather than silently missing - the two failures are different and are reported
 * differently.
 */
export function createEventApplicator({seen = new Set()} = {}) {
  const applied = new Set(seen);
  let highest = -1;
  const gaps = [];
  return freeze({
    apply(event) {
      ok(isPlainObject(event) && Number.isSafeInteger(event.seq) && event.seq >= 0, 'EVENT_SEQ_REQUIRED');
      if (applied.has(event.seq)) return freeze({outcome: 'DUPLICATE_IGNORED', seq: event.seq});
      for (let missing = highest + 1; missing < event.seq; missing += 1) {
        if (!applied.has(missing) && !gaps.includes(missing)) gaps.push(missing);
      }
      applied.add(event.seq);
      highest = Math.max(highest, event.seq);
      return freeze({outcome: 'APPLIED', seq: event.seq});
    },
    // Gaps stay visible until explicitly reconciled: an unnoticed missing event is a silent correctness hole.
    gaps: () => freeze([...gaps].sort((a, b) => a - b)),
    reconcileGap(seq, how = 'RESOLVED_BY_REPLAY') {
      const index = gaps.indexOf(seq);
      if (index === -1) return freeze({reconciled: false, reason: 'NO_SUCH_GAP', seq});
      gaps.splice(index, 1);
      applied.add(seq);
      return freeze({reconciled: true, reason: null, seq, how});
    },
    highest: () => highest,
    snapshot: () => freeze({applied: [...applied].sort((a, b) => a - b), gaps: [...gaps].sort((a, b) => a - b), highest}),
  });
}

/**
 * Crash/restart reconciliation. An attempt whose stop is NOT PROVEN stays unknown and is handed to PCF-705 rather than
 * being assumed stopped by timeout, and an uncertain side effect is never reported as clean.
 */
export function reconcileAfterRestart({reservations = [], attempts = [], observations = [], now = Date.now()} = {}) {
  ok(Array.isArray(reservations) && reservations.length <= 256, 'RECONCILE_LIMIT');
  ok(Array.isArray(attempts) && attempts.length <= 256, 'RECONCILE_LIMIT');
  ok(Array.isArray(observations) && observations.length <= 256, 'RECONCILE_LIMIT');
  const findings = [];
  for (const attempt of attempts) {
    if (attempt.state !== 'RUNNING') continue;
    const live = observations.find(o => o.holder === attempt.holderRef && o.bootId === attempt.bootRef);
    const reservation = reservations.find(r => r.taskId === attempt.taskId);
    if (attempt.pendingOutcome === 'UNKNOWN' || attempt.sideEffectState === 'UNKNOWN') {
      findings.push(freeze({taskId: attempt.taskId, attemptRef: attempt.attemptRef, disposition: 'UNCERTAIN_SIDE_EFFECT', handTo: 'PCF-705', stopProven: false}));
      continue;
    }
    if (live?.alive === true) { findings.push(freeze({taskId: attempt.taskId, attemptRef: attempt.attemptRef, disposition: 'STILL_RUNNING', handTo: null, stopProven: false})); continue; }
    // The worker is gone, but "gone" is not "stopped": no evidence of a stop means the stop is NOT PROVEN.
    findings.push(freeze({taskId: attempt.taskId, attemptRef: attempt.attemptRef, disposition: 'STOP_NOT_PROVEN', handTo: 'PCF-705', stopProven: false}));
    if (reservation && reservation.state === 'LEASED' && reservation.expiresAt <= now) {
      findings.push(freeze({taskId: attempt.taskId, attemptRef: attempt.attemptRef, disposition: 'LEASE_EXPIRED', handTo: null, stopProven: false}));
    }
  }
  return freeze({findings, reconciledAt: now, inferredStopped: false});
}
