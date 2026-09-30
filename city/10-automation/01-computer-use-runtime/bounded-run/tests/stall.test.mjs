/**
 * UTOPIA · 10-automation / Computer Use Runtime — stall detector suite.
 *
 * Restates the DS-Hns donor `app/computer-use/stall.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the threshold (three consecutive
 * actions without a meaningful state change), what counts as progress (a
 * meaningful change *or* a changed signature), the bounded recovery count and the
 * ladder in order, whose last rung is FAIL_WITH_CONTEXT.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStallDetector, STALL_RECOVERY_LADDER } from '../stall.mjs';

test('the donor ladder is eight rungs, in order, each with its exact description', () => {
  assert.equal(STALL_RECOVERY_LADDER.length, 8);
  assert.deepEqual(STALL_RECOVERY_LADDER, [
    { step: 'structured_reobserve', description: 'rebuild the world state from structured sources only' },
    { step: 'window_check', description: 'verify the expected window is still present and in front' },
    { step: 'target_re_resolution', description: 're-resolve the target from scratch through the full ladder' },
    { step: 'targeted_screenshot', description: 'capture the smallest region that could explain the stall' },
    { step: 'alternative_interaction', description: 'use a different interaction channel for the same intent' },
    { step: 'replan', description: 'ask the planner for a different next action' },
    { step: 'full_screenshot', description: 'escalate to a full-screen capture, once' },
    { step: 'fail_with_context', description: 'stop and report everything observed' },
  ]);
  assert.deepEqual(STALL_RECOVERY_LADDER.map((rung) => rung.step), [
    'structured_reobserve',
    'window_check',
    'target_re_resolution',
    'targeted_screenshot',
    'alternative_interaction',
    'replan',
    'full_screenshot',
    'fail_with_context',
  ]);
});

test('the donor thresholds are 3 consecutive actions and 2 recoveries', () => {
  const detector = createStallDetector();
  assert.equal(detector.threshold, 3);
  assert.equal(detector.maxRecoveries, 2);
});

test('the stall fires exactly at the third consecutive action without progress, not before', () => {
  let tick = 0;
  const detector = createStallDetector({ now: () => tick++ });

  // Each `record` reads the clock three times while the streak is running: the
  // `stalledSince` stamp, the record's own `at`, and the elapsed read.
  const first = detector.record({ actionType: 'CLICK', changed: false });
  assert.equal(first.consecutive, 1);
  assert.equal(first.stalled, false);
  assert.equal(first.stalledSinceMs, 2);
  assert.equal(first.threshold, 3);
  assert.equal(first.recoveries, 0);
  assert.equal(first.exhausted, false);

  const second = detector.record({ actionType: 'CLICK', changed: false });
  assert.equal(second.consecutive, 2);
  assert.equal(second.stalled, false);
  assert.equal(second.stalledSinceMs, 2);

  const third = detector.record({ actionType: 'CLICK', changed: false });
  assert.equal(third.consecutive, 3);
  assert.equal(third.stalled, true);
  assert.equal(third.stalledSinceMs, 4);

  const fourth = detector.record({ actionType: 'CLICK', changed: false });
  assert.equal(fourth.consecutive, 4);
  assert.equal(fourth.stalled, true);
  assert.equal(fourth.stalledSinceMs, 6);
  assert.equal(fourth.step, 4);
  assert.equal(detector.consecutive, 4);
});

test('a meaningful change resets the streak and clears stalledSince', () => {
  let tick = 0;
  const detector = createStallDetector({ now: () => tick++ });
  detector.record({ changed: false });
  detector.record({ changed: false });
  const recovered = detector.record({ changed: true, meaningful: true });
  assert.equal(recovered.meaningful, true);
  assert.equal(recovered.consecutive, 0);
  assert.equal(recovered.stalled, false);
  assert.equal(recovered.stalledSinceMs, 0);

  const after = detector.record({ changed: false });
  assert.equal(after.consecutive, 1);
  assert.equal(after.stalledSinceMs, 2);
});

test('an explicit meaningful flag overrides changed, in both directions', () => {
  const detector = createStallDetector({ now: () => 0 });
  const suppressed = detector.record({ changed: true, meaningful: false });
  assert.equal(suppressed.meaningful, false);
  assert.equal(suppressed.consecutive, 1);

  const forced = detector.record({ changed: false, meaningful: true });
  assert.equal(forced.meaningful, true);
  assert.equal(forced.consecutive, 0);
});

test('a changed signature is progress even with no meaningful change, but only once a signature is known', () => {
  let tick = 0;
  const detector = createStallDetector({ now: () => tick++ });

  // The first signature has nothing to compare against: the donor counts this as
  // no progress.
  assert.equal(detector.record({ signature: 'world-a' }).consecutive, 1);
  // Same signature again: still no progress.
  assert.equal(detector.record({ signature: 'world-a' }).consecutive, 2);
  // A different signature is progress.
  const changed = detector.record({ signature: 'world-b' });
  assert.equal(changed.consecutive, 0);

  // A null signature neither advances `lastSignature` nor breaks the streak.
  assert.equal(detector.record({ signature: null }).consecutive, 1);
  assert.equal(detector.record({ signature: 'world-b' }).consecutive, 2);
  assert.equal(detector.record({ signature: 'world-b' }).consecutive, 3);
});

test('the record shape is the donor shape, with its own defaults', () => {
  const detector = createStallDetector({ now: () => 42 });
  const entry = detector.record({});
  assert.deepEqual(entry, {
    at: 42,
    step: 1,
    actionType: null,
    meaningful: false,
    consecutive: 1,
    fields: [],
    verification: null,
    stalled: false,
    stalledSinceMs: 0,
    threshold: 3,
    recoveries: 0,
    exhausted: false,
  });

  const explicit = detector.record({ step: 7, actionType: 'TYPE', fields: ['value'], verification: 'state' });
  assert.equal(explicit.step, 7);
  assert.equal(explicit.actionType, 'TYPE');
  assert.deepEqual(explicit.fields, ['value']);
  assert.equal(explicit.verification, 'state');
  // The step defaults to the history length + 1, so it is the second record.
  assert.equal(detector.record({}).step, 3);
});

test('the detector accepts injected thresholds and thresholds them exactly', () => {
  const detector = createStallDetector({ consecutiveActions: 1, maxRecoveries: 1, now: () => 0 });
  assert.equal(detector.threshold, 1);
  assert.equal(detector.maxRecoveries, 1);
  assert.equal(detector.record({ changed: false }).stalled, true);
  const recovery = detector.registerRecovery();
  assert.deepEqual(recovery, { recoveries: 1, remaining: 0, exhausted: true });
  assert.equal(detector.recoveries, 1);
  assert.equal(detector.exhausted, true);
});

test('every recovery is counted and the ladder ends at maxRecoveries', () => {
  const detector = createStallDetector({ maxRecoveries: 2, now: () => 0 });
  assert.equal(detector.exhausted, false);
  assert.deepEqual(detector.registerRecovery(), { recoveries: 1, remaining: 1, exhausted: false });
  assert.equal(detector.exhausted, false);
  assert.deepEqual(detector.registerRecovery(), { recoveries: 2, remaining: 0, exhausted: true });
  assert.equal(detector.exhausted, true);
  // Past the bound the count keeps rising and `remaining` stays pinned at 0.
  assert.deepEqual(detector.registerRecovery(), { recoveries: 3, remaining: 0, exhausted: true });
  assert.equal(detector.record({ changed: false }).exhausted, true);
});

test('reset clears the streak and the signature but keeps the recovery count', () => {
  const detector = createStallDetector({ now: () => 0 });
  detector.record({ changed: false, signature: 'world-a' });
  detector.record({ changed: false, signature: 'world-a' });
  detector.registerRecovery();
  detector.reset();
  assert.equal(detector.consecutive, 0);
  assert.equal(detector.recoveries, 1);
  // Because `lastSignature` was cleared, the next signature cannot be progress.
  assert.equal(detector.record({ signature: 'world-b' }).consecutive, 1);
  assert.equal(detector.history().length, 3);
});

test('history is a bounded copy: 250 records keep the newest 200', () => {
  const detector = createStallDetector({ now: () => 0 });
  for (let index = 1; index <= 250; index += 1) detector.record({ step: index, changed: true });
  const history = detector.history();
  assert.equal(history.length, 200);
  assert.equal(history[0].step, 51);
  assert.equal(history[199].step, 250);
  // The copy is not the live array.
  history.length = 0;
  assert.equal(detector.history().length, 200);
});

test('the default clock is deterministic: no wall clock is read', () => {
  const first = createStallDetector();
  const second = createStallDetector();
  const a = first.record({ changed: false });
  const b = second.record({ changed: false });
  assert.deepEqual(a, b);
  assert.equal(a.at, 1);
  assert.equal(a.stalledSinceMs, 2);
  assert.equal(first.record({ changed: false }).at, 4);
  assert.equal(second.record({ changed: false }).at, 4);
  assert.equal(first.record({ changed: false }).stalled, true);
  assert.equal(second.record({ changed: false }).stalled, true);
});
