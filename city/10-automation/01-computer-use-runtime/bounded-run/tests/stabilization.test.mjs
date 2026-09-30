/**
 * UTOPIA · 10-automation / Computer Use Runtime — stabilization suite.
 *
 * Restates the DS-Hns donor `app/computer-use/stabilization.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the complete signal vocabulary and
 * its hyphenated aliases, the normalization that drops unknown names, the dynamic
 * cooldown ladder including its navigation jump and its ceiling, the settle
 * verdicts (stable / updated / reobserve / wait_state), the bounded grace, and the
 * post-action signal derivation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStabilizer,
  SIGNALS,
  SIGNAL_LIST,
  SIGNAL_ALIASES,
  normalizeSignals,
} from '../stabilization.mjs';

/**
 * A virtual clock: the first read is 0 and every following read advances by
 * `stepMs`, so elapsed time is a deterministic function of how many times the
 * stabilizer looked at the clock.
 */
function virtualClock(stepMs = 1) {
  let current = 0;
  const sleeps = [];
  return {
    now() {
      const value = current;
      current += stepMs;
      return value;
    },
    async sleep(ms) {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
  };
}

/** A minimal world observation that reports no instability reasons. */
function quietWorld() {
  return { revision: 1, axSignature: 'ax', signature: 'w', windowSignature: 'win', dialogSignature: 'd', loading: false };
}

test('the donor vocabulary is eight signals, in order', () => {
  assert.deepEqual(SIGNALS, {
    UI_CHANGING: 'uiChanging',
    TARGET_MOVED: 'targetMoved',
    PREVIOUS_MISS: 'previousMiss',
    WINDOW_CHANGED: 'windowChanged',
    ANIMATION_DETECTED: 'animationDetected',
    NAVIGATION_PENDING: 'navigationPending',
    MODAL_APPEARED: 'modalAppeared',
    TARGET_DETACHED: 'targetDetached',
  });
  assert.deepEqual(SIGNAL_LIST, [
    'uiChanging',
    'targetMoved',
    'previousMiss',
    'windowChanged',
    'animationDetected',
    'navigationPending',
    'modalAppeared',
    'targetDetached',
  ]);
  assert.equal(SIGNAL_LIST.length, 8);
});

test('the donor aliases map every hyphenated name, including "animation"', () => {
  assert.deepEqual(SIGNAL_ALIASES, {
    'ui-changing': 'uiChanging',
    'target-moved': 'targetMoved',
    'previous-miss': 'previousMiss',
    'window-changed': 'windowChanged',
    animation: 'animationDetected',
    'navigation-pending': 'navigationPending',
    'modal-appeared': 'modalAppeared',
    'target-detached': 'targetDetached',
  });
  assert.equal(Object.keys(SIGNAL_ALIASES).length, 8);
  // Every alias points at a member of the vocabulary.
  for (const value of Object.values(SIGNAL_ALIASES)) assert.ok(SIGNAL_LIST.includes(value));
});

test('normalizeSignals starts from every signal false and accumulates unknown names', () => {
  assert.deepEqual(normalizeSignals(), {
    signals: {
      uiChanging: false,
      targetMoved: false,
      previousMiss: false,
      windowChanged: false,
      animationDetected: false,
      navigationPending: false,
      modalAppeared: false,
      targetDetached: false,
    },
    unknown: [],
  });
  assert.deepEqual(normalizeSignals(null), normalizeSignals());
  assert.deepEqual(normalizeSignals(false), normalizeSignals());
  assert.deepEqual(normalizeSignals('ui-changing'), normalizeSignals());
});

test('normalizeSignals accepts the hyphenated array recovery emits, canonical names and unknowns', () => {
  const hyphenated = normalizeSignals(['ui-changing', 'target-moved', 'previous-miss', 'window-changed']);
  assert.deepEqual(hyphenated.signals, {
    uiChanging: true,
    targetMoved: true,
    previousMiss: true,
    windowChanged: true,
    animationDetected: false,
    navigationPending: false,
    modalAppeared: false,
    targetDetached: false,
  });
  assert.deepEqual(hyphenated.unknown, []);

  assert.deepEqual(normalizeSignals(['animation']).signals.animationDetected, true);
  assert.deepEqual(normalizeSignals(['navigation-pending', 'modal-appeared', 'target-detached']).signals, {
    uiChanging: false,
    targetMoved: false,
    previousMiss: false,
    windowChanged: false,
    animationDetected: false,
    navigationPending: true,
    modalAppeared: true,
    targetDetached: true,
  });
  // A canonical name is accepted verbatim too.
  assert.equal(normalizeSignals(['modalAppeared']).signals.modalAppeared, true);
  // An unrecognised name is dropped and reported, never silently falsified.
  const unknown = normalizeSignals(['ui-changing', 'not-a-signal', 7]);
  assert.equal(unknown.signals.uiChanging, true);
  assert.deepEqual(unknown.unknown, ['not-a-signal', '7']);
});

test('normalizeSignals accepts an object, including a mixed one, and only reports truthy unknowns', () => {
  const object = normalizeSignals({ uiChanging: 1, previousMiss: 'yes', targetMoved: false });
  assert.equal(object.signals.uiChanging, true);
  assert.equal(object.signals.previousMiss, true);
  assert.equal(object.signals.targetMoved, false);
  assert.equal(object.signals.animationDetected, false);
  assert.deepEqual(object.unknown, []);

  const mixed = normalizeSignals({ 'target-moved': true, windowChanged: true, mystery: true, quietMystery: false });
  assert.equal(mixed.signals.targetMoved, true);
  assert.equal(mixed.signals.windowChanged, true);
  assert.deepEqual(mixed.unknown, ['mystery']);

  const aliased = normalizeSignals(['previous-miss']);
  const canonical = normalizeSignals({ previousMiss: true });
  assert.deepEqual(aliased.signals, canonical.signals);
});

test('the dynamic cooldown starts at the base and adds one step per active signal', () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  assert.deepEqual(stabilizer.dynamicCooldown(), { ms: 80, signals: [], ceiling: 'soft', exhausted: false });
  assert.deepEqual(stabilizer.dynamicCooldown({ uiChanging: true }), { ms: 160, signals: ['ui-changing'], ceiling: 'soft', exhausted: false });
  assert.deepEqual(stabilizer.dynamicCooldown({ targetMoved: true }), { ms: 160, signals: ['target-moved'], ceiling: 'soft', exhausted: false });
  assert.deepEqual(stabilizer.dynamicCooldown({ previousMiss: true }), { ms: 160, signals: ['previous-miss'], ceiling: 'soft', exhausted: false });
  assert.deepEqual(stabilizer.dynamicCooldown({ windowChanged: true }), { ms: 160, signals: ['window-changed'], ceiling: 'soft', exhausted: false });
  assert.deepEqual(stabilizer.dynamicCooldown({ animationDetected: true }), { ms: 160, signals: ['animation'], ceiling: 'soft', exhausted: false });
  assert.deepEqual(stabilizer.dynamicCooldown({ modalAppeared: true }), { ms: 160, signals: ['modal-appeared'], ceiling: 'soft', exhausted: false });
  assert.deepEqual(stabilizer.dynamicCooldown({ targetDetached: true }), { ms: 160, signals: ['target-detached'], ceiling: 'soft', exhausted: false });
});

test('the dynamic cooldown climbs in the donor signal order and stops at the soft ceiling', () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  // 80 base + 4 steps = 400, exactly the soft ceiling.
  const atCeiling = stabilizer.dynamicCooldown({ uiChanging: true, targetMoved: true, previousMiss: true, windowChanged: true });
  assert.deepEqual(atCeiling, {
    ms: 400,
    signals: ['ui-changing', 'target-moved', 'previous-miss', 'window-changed'],
    ceiling: 'soft',
    exhausted: true,
  });
  // One more step would exceed it: clamped to the ceiling, reported as soft-max.
  const clamped = stabilizer.dynamicCooldown({ uiChanging: true, targetMoved: true, previousMiss: true, windowChanged: true, modalAppeared: true });
  assert.deepEqual(clamped, {
    ms: 400,
    signals: ['ui-changing', 'target-moved', 'previous-miss', 'window-changed', 'modal-appeared'],
    ceiling: 'soft-max',
    exhausted: true,
  });
  // All seven short signals: still the soft ceiling.
  const all = stabilizer.dynamicCooldown({
    uiChanging: true,
    targetMoved: true,
    previousMiss: true,
    windowChanged: true,
    animationDetected: true,
    modalAppeared: true,
    targetDetached: true,
  });
  assert.equal(all.ms, 400);
  assert.equal(all.ceiling, 'soft-max');
  assert.deepEqual(all.signals, ['ui-changing', 'target-moved', 'previous-miss', 'window-changed', 'animation', 'modal-appeared', 'target-detached']);
});

test('a pending navigation jumps the cooldown to the navigation budget', () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  assert.deepEqual(stabilizer.dynamicCooldown({ navigationPending: true }), {
    ms: 800,
    signals: ['navigation-pending'],
    ceiling: 'navigation',
  });
  const withOthers = stabilizer.dynamicCooldown({ uiChanging: true, previousMiss: true, navigationPending: true });
  assert.equal(withOthers.ms, 800);
  assert.equal(withOthers.ceiling, 'navigation');
  assert.deepEqual(withOthers.signals, ['ui-changing', 'previous-miss', 'navigation-pending']);
  // A navigation wins over the escalate ceiling too.
  assert.equal(stabilizer.dynamicCooldown({ escalate: true, navigationPending: true }).ms, 800);
});

test('the escalate flag uses the hard ceiling, and the injected limits are honoured', () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  // 80 base + 5 steps = 480, still under the 500 ms hard ceiling, so the hard
  // ceiling is only reachable from a larger injected step.
  assert.equal(stabilizer.dynamicCooldown({ escalate: true, uiChanging: true, targetMoved: true, previousMiss: true, windowChanged: true, modalAppeared: true }).ms, 480);
  assert.equal(stabilizer.dynamicCooldown({ escalate: true }).ceiling, 'soft');
  assert.equal(stabilizer.dynamicCooldown({ escalate: true, uiChanging: true }).ms, 160);

  const tuned = createStabilizer({ clock: virtualClock(), limits: { cooldownBaseMs: 10, cooldownStepMs: 1, cooldownSoftMaxMs: 12 } });
  assert.deepEqual(tuned.dynamicCooldown({ uiChanging: true }), { ms: 11, signals: ['ui-changing'], ceiling: 'soft', exhausted: false });
  assert.deepEqual(tuned.dynamicCooldown({ uiChanging: true, targetMoved: true }), { ms: 12, signals: ['ui-changing', 'target-moved'], ceiling: 'soft', exhausted: true });
  assert.deepEqual(tuned.dynamicCooldown({ uiChanging: true, targetMoved: true, previousMiss: true }), { ms: 12, signals: ['ui-changing', 'target-moved', 'previous-miss'], ceiling: 'soft-max', exhausted: true });
});

test('signalInputs turns a signal set into the cooldown input, carrying the reasons', () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  const inputs = stabilizer.signalInputs({
    stable: false,
    reasons: ['target bounding box moved', 'window state changed'],
    previousMiss: true,
    targetDetached: true,
  });
  assert.deepEqual(inputs, {
    uiChanging: true,
    targetMoved: true,
    previousMiss: true,
    windowChanged: false,
    animationDetected: false,
    navigationPending: false,
    modalAppeared: false,
    targetDetached: true,
  });
  assert.deepEqual(stabilizer.signalInputs({ stable: true, reasons: [] }), {
    uiChanging: false,
    targetMoved: false,
    previousMiss: false,
    windowChanged: false,
    animationDetected: false,
    navigationPending: false,
    modalAppeared: false,
    targetDetached: false,
  });
});

test('stabilitySignals reports the donor reasons, and only them', () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  assert.deepEqual(stabilizer.stabilitySignals(null, null), { stable: false, reasons: ['no observation'] });

  const previous = { revision: 1, axSignature: 'ax1', signature: 's1', windowSignature: 'w1', dialogSignature: 'd1' };
  const current = { revision: 2, axSignature: 'ax2', signature: 's2', windowSignature: 'w2', dialogSignature: 'd2' };
  assert.deepEqual(stabilizer.stabilitySignals(previous, current), {
    stable: false,
    reasons: ['DOM changed', 'accessibility tree changed', 'window state changed', 'dialogs changed', 'world state changed'],
  });

  assert.deepEqual(stabilizer.stabilitySignals(null, { loading: true }).reasons, ['page still loading']);
  assert.deepEqual(stabilizer.stabilitySignals(null, { readyState: 'loading' }).reasons, ['page still loading']);
  assert.deepEqual(stabilizer.stabilitySignals(null, quietWorld()), { stable: true, reasons: [] });
  assert.deepEqual(stabilizer.stabilitySignals(null, quietWorld(), { miss: { missed: true } }).reasons, ['previous action missed']);
  assert.deepEqual(stabilizer.stabilitySignals(null, quietWorld(), { animation: true }).reasons, ['animation detected']);
  assert.deepEqual(stabilizer.stabilitySignals(null, quietWorld(), { currentResolution: { disabled: true } }).reasons, ['target is disabled']);
  assert.deepEqual(stabilizer.stabilitySignals(null, quietWorld(), { currentResolution: { visible: false } }).reasons, ['target is not visible']);
  assert.deepEqual(
    stabilizer.stabilitySignals(null, quietWorld(), {
      previousResolution: { bbox: { x: 0, y: 0, width: 10, height: 10 } },
      currentResolution: { bbox: { x: 5, y: 0, width: 10, height: 10 } },
    }).reasons,
    ['target bounding box moved'],
  );
  // A null revision is not a revision change in the donor.
  assert.deepEqual(stabilizer.stabilitySignals({ revision: null }, { revision: 9 }).reasons, []);
});

test('detectSignals expands the same reasons into the named vocabulary', () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  const detected = stabilizer.detectSignals(
    { revision: 1, signature: 'a', windowSignature: 'w1', dialogSignature: 'd1' },
    { revision: 2, signature: 'b', windowSignature: 'w2', dialogSignature: 'd2', loading: true },
    { miss: { missed: true } },
  );
  assert.equal(detected.stable, false);
  assert.equal(detected.uiChanging, true);
  assert.equal(detected.previousMiss, true);
  assert.equal(detected.windowChanged, true);
  assert.equal(detected.navigationPending, true);
  assert.equal(detected.modalAppeared, true);
  assert.equal(detected.targetDetached, false);
  assert.equal(detected.targetMoved, false);
  assert.deepEqual(detected.reasons, ['page still loading', 'DOM changed', 'window state changed', 'dialogs changed', 'world state changed', 'previous action missed']);

  const detached = stabilizer.detectSignals(null, { revision: 1 }, { currentResolution: { visible: false } });
  assert.equal(detached.targetDetached, true);
  assert.equal(detached.uiChanging, true);
  assert.equal(stabilizer.detectSignals(null, quietWorld()).uiChanging, false);
});

test('postActionSignals reads only the receipt and the two observations', () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  const derived = stabilizer.postActionSignals({
    receipt: { changed: true },
    previousWorld: { revision: 1, signature: 'a', windowSignature: 'w1' },
    world: { revision: 2, signature: 'b', windowSignature: 'w2' },
  });
  assert.equal(derived.changed, true);
  assert.equal(derived.signals.windowChanged, true);
  assert.equal(derived.signals.stable, false);
  assert.deepEqual(derived.reasons, ['dom revision changed', 'world state changed', 'window changed']);

  const quiet = stabilizer.postActionSignals({ receipt: {}, previousWorld: quietWorld(), world: quietWorld() });
  assert.equal(quiet.changed, false);
  assert.equal(quiet.signals.stable, true);
  assert.deepEqual(quiet.reasons, []);

  const loading = stabilizer.postActionSignals({ world: { loading: true, dialogs: [{ id: 1 }] } });
  assert.equal(loading.signals.loading, true);
  assert.equal(loading.signals.modalAppeared, true);
  assert.deepEqual(loading.reasons, ['still loading', 'a dialog is open']);

  const carried = stabilizer.postActionSignals({ signals: ['navigation-pending', 'animation', 'previous-miss'] });
  assert.deepEqual(carried.reasons, ['navigation pending', 'animation detected', 'the previous attempt missed']);
  assert.equal(carried.changed, false);
  assert.equal(carried.signals.stable, false);
});

test('settle returns stable on the first observation when nothing is moving', async () => {
  const clock = virtualClock();
  const stabilizer = createStabilizer({ clock });
  const result = await stabilizer.settle({
    action: { stabilization: { minimumMs: 0, maximumMs: 300 } },
    previous: null,
    observe: async () => quietWorld(),
  });
  assert.equal(result.kind, 'settle');
  assert.equal(result.verdict, 'stable');
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.revalidation.verdict, 'unknown');
  assert.deepEqual(clock.sleeps, []);
});

test('settle spends the bounded minimum before the first observation', async () => {
  const clock = virtualClock();
  const stabilizer = createStabilizer({ clock });
  const result = await stabilizer.settle({ action: null, previous: null, observe: async () => quietWorld() });
  assert.deepEqual(clock.sleeps, [50]);
  assert.equal(result.verdict, 'stable');
  // The virtual clock reads 0, then 51 after the sleep, then 52 for the elapsed
  // read, so the donor's `clock.now() - startedAt` is 52.
  assert.equal(result.waitedMs, 52);
});

test('settle clamps a minimum above the ceiling to the ceiling', async () => {
  const clock = virtualClock();
  const stabilizer = createStabilizer({ clock });
  const result = await stabilizer.settle({
    action: { stabilization: { minimumMs: 900, maximumMs: 20 } },
    previous: null,
    observe: async () => quietWorld(),
  });
  assert.deepEqual(clock.sleeps, [20]);
  assert.equal(result.verdict, 'stable');
});

test('settle answers reobserve for a stale target and for one that vanished', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  const stale = await stabilizer.settle({
    action: { stabilization: { minimumMs: 0, maximumMs: 300 } },
    previous: { point: { x: 0, y: 0 } },
    observe: async () => quietWorld(),
    locateTarget: async () => ({ point: { x: 100, y: 0 } }),
  });
  assert.equal(stale.verdict, 'reobserve');
  assert.equal(stale.revalidation.verdict, 'stale');
  assert.equal(stale.reason, 'target moved 100px during the settle window - re-observe before acting');
  assert.equal(stale.resolved.point.x, 100);

  const missing = await stabilizer.settle({
    action: { stabilization: { minimumMs: 0, maximumMs: 300 } },
    previous: { point: { x: 0, y: 0 } },
    observe: async () => quietWorld(),
    locateTarget: async () => null,
  });
  assert.equal(missing.verdict, 'reobserve');
  assert.equal(missing.revalidation.verdict, 'missing');
  assert.equal(missing.reason, 'the target could not be re-resolved during the settle window - re-observe before acting');
});

test('settle reports the donor `updated` verdict when the refreshed coordinate is the only change', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  let probe = 0;
  const updated = await stabilizer.settle({
    // The first observation compares against a world one revision behind, so it is
    // unstable and the loop takes a second probe.
    world: { revision: 1 },
    action: { stabilization: { minimumMs: 0, maximumMs: 300 } },
    previous: { point: { x: 0, y: 0 } },
    observe: async () => ({ revision: 2 }),
    locateTarget: async () => {
      probe += 1;
      // Inside the donor's 3–10 px update band.
      return { point: { x: 5, y: 0 } };
    },
  });
  assert.equal(updated.verdict, 'updated');
  assert.equal(updated.revalidation.verdict, 'updated');
  assert.equal(updated.revalidation.movement, 5);
  assert.equal(updated.attempts, 2);
  assert.equal(probe, 2);
  // The first observation reported the DOM change; the returned signal set is the
  // one from the probe that settled, which is the second.
  assert.deepEqual(updated.signals.reasons, []);
  // A box that moved by 1 px keeps the `stable` verdict because the box movement
  // is the one reason that does not block the settle.
  const movedBox = await stabilizer.settle({
    action: { stabilization: { minimumMs: 0, maximumMs: 300 } },
    previous: { bbox: { x: 0, y: 0, width: 10, height: 10 } },
    observe: async () => quietWorld(),
    locateTarget: async () => ({ bbox: { x: 1, y: 0, width: 10, height: 10 } }),
  });
  assert.equal(movedBox.verdict, 'stable');
  assert.ok(movedBox.signals.reasons.includes('target bounding box moved'));
});

test('settle answers wait_state when the ceiling is reached while the UI keeps changing', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock(1) });
  const result = await stabilizer.settle({
    action: { stabilization: { minimumMs: 0, maximumMs: 50 } },
    previous: null,
    observe: async () => ({ revision: 1, signature: 'changing', loading: true }),
  });
  assert.equal(result.verdict, 'wait_state');
  assert.equal(result.reason, 'the UI was still changing when the settle ceiling was reached');
  assert.ok(result.attempts >= 1);
  assert.ok(result.waitedMs >= 50);
});

test('settle merges the caller-carried signals into every cooldown it spends', async () => {
  const clock = virtualClock();
  const stabilizer = createStabilizer({ clock });
  const result = await stabilizer.settle({
    action: { stabilization: { minimumMs: 0, maximumMs: 300 } },
    previous: null,
    // A missed previous attempt is carried, so the cooldown reacts to it from the
    // first observation even though nothing new was detected.
    signals: ['previous-miss'],
    observe: async () => quietWorld(),
  });
  assert.equal(result.verdict, 'stable');
  assert.equal(result.signals.previousMiss, true);
  // The carried signal is state, not a cooldown: the first observation is already
  // stable, so exactly one probe is taken.
  assert.equal(result.attempts, 1);
});

test('waitFor polls until the condition holds and reports what it saw', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock(10) });
  const result = await stabilizer.waitFor(async ({ attempt }) => attempt >= 3, { timeoutMs: 1000, pollMs: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.value, true);
  assert.equal(result.timedOut, undefined);
});

test('waitFor times out at its ceiling and is bounded, not unbounded', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock(10) });
  const result = await stabilizer.waitFor(async () => false, { timeoutMs: 50, pollMs: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(result.waitedMs >= 50);
  // Each round reads the clock three times (elapsed for the probe, the timeout
  // test and the poll clamp), so a step clock advances 30 ms per round and the
  // 50 ms ceiling is reached on the second probe.
  assert.equal(result.attempts, 2);
  assert.equal(result.waitedMs, 65);
});

test('grace is bounded by the grace ceiling and reflects the action budget', async () => {
  const clock = virtualClock();
  const stabilizer = createStabilizer({ clock });
  const fallback = await stabilizer.grace(null);
  assert.deepEqual(fallback, { kind: 'grace', waitedMs: 151, requestedMs: 150, appliedMs: 150 });

  const fromAction = await stabilizer.grace({ stabilization: { minimumMs: 50 } });
  assert.equal(fromAction.requestedMs, 130);
  assert.equal(fromAction.appliedMs, 130);

  const override = await stabilizer.grace({ stabilization: { minimumMs: 900 } }, 40);
  assert.equal(override.requestedMs, 40);
  assert.equal(override.appliedMs, 40);

  const clamped = await stabilizer.grace(null, 9000);
  assert.equal(clamped.requestedMs, 9000);
  assert.equal(clamped.appliedMs, 250);
  assert.deepEqual(clock.sleeps, [150, 130, 40, 250]);
});

test('afterAction returns quiet once the minimum is spent and nothing is pending', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  const result = await stabilizer.afterAction({
    action: { stabilization: { minimumMs: 0, maximumMs: 100 } },
    receipt: { changed: false },
    observe: async () => quietWorld(),
  });
  assert.equal(result.kind, 'grace');
  assert.equal(result.verdict, 'quiet');
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.reasons, []);
});

test('afterAction ends the moment the effect is observable', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  const result = await stabilizer.afterAction({
    action: null,
    observe: async () => quietWorld(),
    landed: async () => true,
  });
  assert.equal(result.verdict, 'landed');
  assert.equal(result.attempts, 1);
});

test('afterAction is bounded by the grace ceiling when the world never settles', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock(1) });
  let revision = 0;
  const result = await stabilizer.afterAction({
    action: { stabilization: { maximumMs: 100 } },
    observe: async () => {
      revision += 1;
      return { revision, signature: `s${revision}`, windowSignature: 'w', dialogSignature: 'd', loading: true };
    },
  });
  assert.equal(result.kind, 'grace');
  assert.ok(['ceiling', 'settle-budget'].includes(result.verdict));
  assert.ok(result.waitedMs >= 100);
});

test('afterAction ignores a landed check that throws, as the donor does', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  const result = await stabilizer.afterAction({
    action: { stabilization: { maximumMs: 100 } },
    observe: async () => quietWorld(),
    landed: async () => {
      throw new Error('the verifier broke');
    },
  });
  assert.equal(result.verdict, 'quiet');
});

test('the trace holds the most recent notes and is bounded', async () => {
  const stabilizer = createStabilizer({ clock: virtualClock() });
  await stabilizer.grace(null);
  await stabilizer.settle({ action: { stabilization: { minimumMs: 0, maximumMs: 300 } }, previous: null, observe: async () => quietWorld() });
  const trace = stabilizer.trace();
  assert.equal(trace.length, 2);
  assert.equal(trace[0].kind, 'grace');
  assert.equal(trace[1].kind, 'settle');
  trace.length = 0;
  assert.equal(stabilizer.trace().length, 2);
});

test('the stabilizer exposes the donor limits, thresholds and vocabulary', () => {
  const stabilizer = createStabilizer({ clock: virtualClock(), limits: { settleMinMs: 1 }, thresholds: { stablePx: 9 } });
  assert.equal(stabilizer.limits.settleMinMs, 1);
  assert.equal(stabilizer.limits.settleMaxMs, 300);
  assert.equal(stabilizer.limits.cooldownBaseMs, 80);
  assert.equal(stabilizer.limits.graceMaxMs, 250);
  assert.equal(stabilizer.limits.defaultWaitTimeoutMs, 5000);
  assert.equal(stabilizer.limits.eventPollMs, 40);
  assert.equal(stabilizer.thresholds.stablePx, 9);
  assert.equal(stabilizer.thresholds.updatePx, 10);
  assert.equal(stabilizer.SIGNALS, SIGNALS);
  assert.equal(stabilizer.SIGNAL_LIST, SIGNAL_LIST);
  assert.equal(stabilizer.normalizeSignals, normalizeSignals);
});

test('the default clock is deterministic and never reads a wall clock', async () => {
  const first = createStabilizer();
  const second = createStabilizer();
  const call = (stabilizer) => stabilizer.settle({ action: { stabilization: { minimumMs: 0, maximumMs: 300 } }, previous: null, observe: async () => quietWorld() });
  const a = await call(first);
  const b = await call(second);
  assert.deepEqual(a, b);
  assert.equal(a.verdict, 'stable');
  assert.equal(a.attempts, 1);
  assert.equal(a.waitedMs, 1);
  // Three reads per settle: the start, the elapsed read and the trace stamp.
  assert.equal(first.trace()[0].at, 2);
  // A second settle on the same stabilizer advances the same clock, and because
  // the elapsed read is always the second of the three it reports the same 1 ms.
  assert.equal((await call(first)).waitedMs, 1);
  assert.equal(first.trace().length, 2);
  assert.equal(first.trace()[1].at, 5);
});

test('the injected thresholds drive the settle verdicts', async () => {
  const wide = createStabilizer({ clock: virtualClock(), thresholds: { stablePx: 5, updatePx: 300 } });
  const stable = await wide.settle({
    action: { stabilization: { minimumMs: 0, maximumMs: 300 } },
    previous: { point: { x: 0, y: 0 } },
    observe: async () => quietWorld(),
    locateTarget: async () => ({ point: { x: 100, y: 0 } }),
  });
  // 100 px is past the donor's 10 px update band but inside the injected one, so
  // the refreshed coordinate is used instead of a re-observe.
  assert.equal(stable.verdict, 'updated');
  assert.equal(stable.revalidation.verdict, 'updated');
  assert.equal(stable.revalidation.movement, 100);
  assert.equal(stable.revalidation.reason, 'target moved 100px - using the refreshed coordinate');

  // With the donor default the same movement is stale, so the threshold really is
  // the input that decided it.
  const narrow = createStabilizer({ clock: virtualClock() });
  const reobserve = await narrow.settle({
    action: { stabilization: { minimumMs: 0, maximumMs: 300 } },
    previous: { point: { x: 0, y: 0 } },
    observe: async () => quietWorld(),
    locateTarget: async () => ({ point: { x: 100, y: 0 } }),
  });
  assert.equal(reobserve.verdict, 'reobserve');
});
