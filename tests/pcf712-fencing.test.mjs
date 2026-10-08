// PCF-712 acceptance: the fence epoch, the fenced start/report/commit gate, idempotent replay and crash reconciliation.
//
// The property that matters: a worker whose ownership was REPLACED must not be able to report success. That is checked
// from every direction - a stale epoch, the right epoch under a different holder, the right holder under a different
// boot, and the wrong attempt - because a fence that only compares the epoch is not a fence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FENCE_REFUSALS, createFence, advanceFence, assertFenced, claimOf, persistFenceBeforeAction,
  createEventApplicator, reconcileAfterRestart,
} from '../services/personal-compute-fabric/fence.mjs';

const base = {holderRef: 'worker-A', bootRef: 'boot-1', attemptRef: 'att-1', epoch: 1, since: 1000};

test('PCF712-01 a fence carries holder, boot, attempt and epoch, and every field is required', () => {
  const fence = createFence(base);
  assert.equal(fence.epoch, 1);
  assert.equal(fence.holderRef, 'worker-A');
  assert.ok(Object.isFrozen(fence));
  assert.throws(() => createFence({...base, holderRef: ''}), /FENCE_HOLDER_REQUIRED/);
  assert.throws(() => createFence({...base, bootRef: null}), /FENCE_BOOT_REQUIRED/);
  assert.throws(() => createFence({...base, attemptRef: undefined}), /FENCE_ATTEMPT_REQUIRED/);
  assert.throws(() => createFence({...base, epoch: 0}), /FENCE_EPOCH_REQUIRED/);
});

test('PCF712-02 a holder change advances the epoch exactly once, and re-registering the same holder does NOT burn one', () => {
  const first = createFence(base);
  const moved = advanceFence(first, {holderRef: 'worker-B', bootRef: 'boot-2', now: 2000});
  assert.equal(moved.epoch, 2, 'a holder change advances the fence');
  assert.equal(moved.holderRef, 'worker-B');
  assert.equal(moved.attemptRef, first.attemptRef, 'the attempt identity is unchanged by a holder change');
  // The same holder and boot re-registering is a RETRY, not a change: the fence must stay put so the retry is not
  // mistaken for a new epoch by an in-flight report.
  const retry = advanceFence(moved, {holderRef: 'worker-B', bootRef: 'boot-2', now: 3000});
  assert.equal(retry.epoch, moved.epoch);
  const movedAgain = advanceFence(retry, {holderRef: 'worker-C', bootRef: 'boot-3', now: 4000});
  assert.equal(movedAgain.epoch, 3);
});

test('PCF712-03 the gate refuses a stale epoch, a wrong holder, a wrong boot and a wrong attempt, EACH BY NAME', () => {
  const fence = createFence(base);
  const claim = claimOf(fence);
  assert.equal(assertFenced(fence, claim), true);
  // A worker from before the change.
  assert.throws(() => assertFenced(fence, {...claim, epoch: 0}), /FENCE_STALE_EPOCH/);
  // This is the one a counter-only check would MISS: the correct epoch under a different holder.
  assert.throws(() => assertFenced(fence, {...claim, holderRef: 'worker-impostor'}), /FENCE_WRONG_HOLDER/);
  // The right holder and epoch, but a different boot: a restarted process reusing a holder name is not the same worker.
  assert.throws(() => assertFenced(fence, {...claim, bootRef: 'boot-old'}), /FENCE_WRONG_BOOT/);
  assert.throws(() => assertFenced(fence, {...claim, attemptRef: 'att-other'}), /FENCE_WRONG_ATTEMPT/);
  // A claim missing fields names ITS OWN problem rather than being reported as a wrong attempt.
  assert.throws(() => assertFenced(fence, {}), /FENCE_CLAIM_INCOMPLETE/);
  assert.throws(() => assertFenced(fence, {...claim, epoch: '1'}), /FENCE_CLAIM_INCOMPLETE/);
  assert.throws(() => assertFenced(null, claim), /FENCE_NOT_INITIALIZED/);
});

test('PCF712-04 after a take-over the PREVIOUS worker can no longer report success', () => {
  const first = createFence({...base, holderRef: 'worker-A', bootRef: 'boot-A'});
  const stale = claimOf(first);
  const taken = advanceFence(first, {holderRef: 'worker-B', bootRef: 'boot-B', now: 2000});
  // The old worker's report is refused on two independent grounds, and the epoch is reported first.
  assert.throws(() => assertFenced(taken, stale), /FENCE_STALE_EPOCH/);
  // Even if it somehow learned the new epoch, its holder and boot still disagree.
  assert.throws(() => assertFenced(taken, {...stale, epoch: taken.epoch}), /FENCE_WRONG_HOLDER/);
  // The current holder succeeds.
  assert.equal(assertFenced(taken, claimOf(taken)), true);
});

test('PCF712-05 persistence happens BEFORE the action, and a persistence failure means the action did NOT run', () => {
  const fence = createFence(base);
  const claim = claimOf(fence);
  const recorded = [];
  const okRun = persistFenceBeforeAction(fence, claim, value => recorded.push(value.epoch));
  assert.equal(okRun.executed, true);
  assert.deepEqual(recorded, [1], 'the fence was durably recorded before the action was allowed');
  // A store that throws must NOT let the action proceed: booking after the fact is what the workbook forbids.
  const failed = persistFenceBeforeAction(fence, claim, () => { throw new Error('disk full'); });
  assert.equal(failed.executed, false);
  assert.equal(failed.reason, FENCE_REFUSALS.PERSISTENCE_FAILED);
  assert.match(failed.detail, /disk full/);
  // And a stale claim never reaches the action either.
  assert.throws(() => persistFenceBeforeAction(fence, {...claim, epoch: 0}, () => recorded.push('should not happen')), /FENCE_STALE_EPOCH/);
  assert.deepEqual(recorded, [1]);
});

test('PCF712-06 event replay is idempotent, and a LOST event stays visible as a gap until reconciled', () => {
  const applicator = createEventApplicator();
  assert.equal(applicator.apply({seq: 0}).outcome, 'APPLIED');
  assert.equal(applicator.apply({seq: 1}).outcome, 'APPLIED');
  // A duplicate must not produce a second result.
  assert.equal(applicator.apply({seq: 1}).outcome, 'DUPLICATE_IGNORED');
  assert.equal(applicator.highest(), 1);
  // A jump leaves the missing sequences visible rather than pretending the stream was continuous.
  assert.equal(applicator.apply({seq: 4}).outcome, 'APPLIED');
  assert.deepEqual(applicator.gaps(), [2, 3]);
  // A gap can be reconciled explicitly, and reconciling a gap that does not exist says so.
  assert.equal(applicator.reconcileGap(2).reconciled, true);
  assert.deepEqual(applicator.gaps(), [3]);
  assert.equal(applicator.reconcileGap(9).reason, 'NO_SUCH_GAP');
  assert.throws(() => applicator.apply({seq: 'x'}), /EVENT_SEQ_REQUIRED/);
  // An out-of-order (late) event is APPLIED once, not ignored, and does not disturb the highest sequence.
  assert.equal(applicator.apply({seq: 3}).outcome, 'APPLIED');
  assert.equal(applicator.highest(), 4);
});

test('PCF712-07 an unproven stop is never inferred from a timeout, and uncertain side effects go to PCF-705', () => {
  const reservations = [{id: 'r1', taskId: 'T-1', state: 'LEASED', expiresAt: 5000}];
  // The worker is not observed alive, and there is NO evidence it stopped.
  const gone = reconcileAfterRestart({reservations, attempts: [{taskId: 'T-1', attemptRef: 'att-1', holderRef: 'worker-A', bootRef: 'boot-1', state: 'RUNNING'}], observations: [], now: 6000});
  assert.equal(gone.inferredStopped, false, 'absence of evidence is not evidence of a stop');
  const dispositions = gone.findings.map(f => f.disposition);
  assert.ok(dispositions.includes('STOP_NOT_PROVEN'));
  assert.ok(dispositions.includes('LEASE_EXPIRED'));
  assert.ok(gone.findings.every(f => f.stopProven === false), 'no finding claims a proven stop without evidence');
  // An uncertain side effect is a different disposition and is handed to the repair book.
  const uncertain = reconcileAfterRestart({reservations: [], attempts: [{taskId: 'T-2', attemptRef: 'att-2', holderRef: 'w', bootRef: 'b', state: 'RUNNING', pendingOutcome: 'UNKNOWN'}], observations: [], now: 1});
  assert.equal(uncertain.findings[0].disposition, 'UNCERTAIN_SIDE_EFFECT');
  assert.equal(uncertain.findings[0].handTo, 'PCF-705');
  // A live worker is reported as running, not stopped.
  const alive = reconcileAfterRestart({reservations: [], attempts: [{taskId: 'T-3', attemptRef: 'att-3', holderRef: 'w', bootRef: 'b', state: 'RUNNING'}], observations: [{holder: 'w', bootId: 'b', alive: true}], now: 1});
  assert.equal(alive.findings[0].disposition, 'STILL_RUNNING');
});

test('PCF712-08 the canonical attempt record is read with its own field names, and an unreadable identity is its own finding', () => {
  // PCF-704 admission writes `id`/`holder`/`bootId`; a fence claim says `attemptRef`/`holderRef`/`bootRef`. The same
  // facts under two names used to make every LIVE canonical worker unreadable, so reconciliation answered
  // STOP_NOT_PROVEN for a worker that was plainly running - a false negative in the one path that must not guess.
  const canonical = {id: 'att-canonical-1', taskId: 'T-4', holder: 'worker-A', bootId: 'boot-1', epoch: 9, state: 'RUNNING'};
  const alive = reconcileAfterRestart({reservations: [], attempts: [canonical], observations: [{holder: 'worker-A', bootId: 'boot-1', alive: true}], now: 1});
  assert.equal(alive.findings[0].disposition, 'STILL_RUNNING', 'a live canonical attempt is recognised as running');
  assert.equal(alive.findings[0].attemptRef, 'att-canonical-1', 'the canonical attempt id is carried through');
  // A canonical attempt whose holder is gone still yields STOP_NOT_PROVEN, not a proven stop, and keeps its lease finding.
  const gone = reconcileAfterRestart({reservations: [{id: 'r9', taskId: 'T-4', state: 'LEASED', expiresAt: 10}], attempts: [canonical], observations: [], now: 100});
  assert.deepEqual(gone.findings.map(f => f.disposition), ['STOP_NOT_PROVEN', 'LEASE_EXPIRED']);
  // An identity that cannot be read at all is neither "running" nor "stopped": it has its own disposition and goes to 705.
  const unreadable = reconcileAfterRestart({reservations: [], attempts: [{id: 'att-5', taskId: 'T-5', state: 'RUNNING'}], observations: [], now: 1});
  assert.equal(unreadable.findings[0].disposition, 'IDENTITY_UNREADABLE');
  assert.equal(unreadable.findings[0].handTo, 'PCF-705');
  assert.equal(unreadable.findings[0].stopProven, false);
  assert.match(unreadable.findings[0].detail, /neither liveness nor a stop can be established/);
  assert.equal(unreadable.inferredStopped, false);
  // Both naming schemes describe the same live worker, so the disposition is identical.
  const fenceShaped = reconcileAfterRestart({reservations: [], attempts: [{taskId: 'T-4', attemptRef: 'att-canonical-1', holderRef: 'worker-A', bootRef: 'boot-1', state: 'RUNNING'}], observations: [{holder: 'worker-A', bootId: 'boot-1', alive: true}], now: 1});
  assert.deepEqual(fenceShaped.findings, alive.findings);
});
