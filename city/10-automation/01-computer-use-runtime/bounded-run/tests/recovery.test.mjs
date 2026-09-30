/**
 * UTOPIA · 10-automation / Computer Use Runtime — recovery ladder suite.
 *
 * Restates the DS-Hns donor `app/computer-use/recovery.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the documented rungs, the closed
 * verdict vocabulary, the exact reason string each decision carries, the
 * `USER_ACTION_CODES` rung that is checked before the retry rung, the alternative
 * interaction mapping by intent, and the bounded exhausted case.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRecoveryController,
  alternativeAction,
  alternativeController,
  mapType,
  RECOVERY_STEPS,
  RECOVERY_VERDICTS,
  VERDICT_BY_STEP,
  USER_ACTION_CODES,
  exhaustedError,
} from '../recovery.mjs';
import { STALL_RECOVERY_LADDER } from '../stall.mjs';
import { CODES, ComputerUseError } from '../contracts.mjs';

/** A deterministic clock so every `at` is literal. */
function stepNow() {
  let tick = 0;
  return () => tick++;
}

/**
 * `assert.deepEqual` is loose about types, and the donor decision objects mix
 * numbers, strings and `null`. These two helpers compare the donor's own values
 * with `Object.is` semantics, so a `0` can never pass as a `'0'`.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExact(actual, expected, label) {
  if (isPlainObject(actual) && isPlainObject(expected)) {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: keys`);
    for (const key of Object.keys(expected)) assertExact(actual[key], expected[key], `${label}.${key}`);
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let index = 0; index < expected.length; index += 1) assertExact(actual[index], expected[index], `${label}[${index}]`);
    return;
  }
  assert.ok(Object.is(actual, expected), `${label}: expected ${String(expected)} but got ${String(actual)}`);
}

const RETRYABLE_ERROR = Object.freeze({ code: 'SOMETHING', message: 'it broke' });

test('the documented rungs are the donor seven, in order', () => {
  assert.deepEqual(RECOVERY_STEPS, ['retry', 'revalidate', 'reobserve', 'alternative_action', 'replan', 'escalate', 'fail']);
});

test('the verdict vocabulary is the donor five and VERDICT_BY_STEP has exactly the donor four keys', () => {
  assert.deepEqual(RECOVERY_VERDICTS, {
    RETRYABLE: 'RETRYABLE',
    ALTERNATIVE_AVAILABLE: 'ALTERNATIVE_AVAILABLE',
    REPLAN_REQUIRED: 'REPLAN_REQUIRED',
    USER_ACTION_REQUIRED: 'USER_ACTION_REQUIRED',
    FAILED: 'FAILED',
  });
  assert.deepEqual(VERDICT_BY_STEP, {
    retry: 'RETRYABLE',
    alternative_action: 'ALTERNATIVE_AVAILABLE',
    replan: 'REPLAN_REQUIRED',
    escalate: 'REPLAN_REQUIRED',
    fail: 'FAILED',
  });
  assert.deepEqual(Object.keys(VERDICT_BY_STEP), ['retry', 'alternative_action', 'replan', 'escalate', 'fail']);
});

test('USER_ACTION_CODES is the donor nine, in the donor order', () => {
  assert.deepEqual(USER_ACTION_CODES, [
    'DESTRUCTIVE_NEEDS_CONFIRMATION',
    'DESTRUCTIVE_FORBIDDEN',
    'SAFETY_REFUSED',
    'MODAL_BLOCKING',
    'WORKSPACE_UNAVAILABLE',
    'WORKSPACE_MISMATCH',
    'CAPABILITY_NOT_ALLOWED',
    'CAPABILITY_UNAVAILABLE',
    'STATE_INTEGRITY_UNCERTAIN',
  ]);
  assert.equal(USER_ACTION_CODES.length, 9);
});

test('every USER_ACTION_CODE is checked before the retry rung and is terminal', () => {
  const controller = createRecoveryController({ now: stepNow() });
  for (const code of USER_ACTION_CODES) {
    const decision = controller.decide({
      action: { type: 'CLICK', retry: { maxAttempts: 5 } },
      attempt: 1,
      error: { code, message: 'refused' },
    });
    assert.equal(decision.step, 'fail', code);
    assert.equal(decision.verdict, 'USER_ACTION_REQUIRED', code);
    assert.equal(decision.terminal, true, code);
    assert.equal(decision.reason, `${code} needs a decision the runtime may not make: refused`, code);
  }
  // The same code is re-decided identically on a later attempt.
  const again = controller.decide({ action: { type: 'CLICK' }, attempt: 9, error: { code: 'SAFETY_REFUSED' } });
  assert.equal(again.reason, 'SAFETY_REFUSED needs a decision the runtime may not make: the action was refused');
});

test('rung 0 wins over the retry rung even when a retry would be allowed', () => {
  const controller = createRecoveryController({ now: () => 0 });
  const decision = controller.decide({
    action: { type: 'CLICK', retry: { maxAttempts: 5 } },
    attempt: 1,
    error: { code: 'DESTRUCTIVE_NEEDS_CONFIRMATION', message: 'confirm the delete' },
  });
  assert.equal(decision.step, 'fail');
  assert.equal(decision.verdict, 'USER_ACTION_REQUIRED');
  assert.equal(decision.attemptsAllowed, 5);
});

test('a non-retryable failure fails without spending the ladder', () => {
  const controller = createRecoveryController({ now: () => 0 });
  const decision = controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: { code: 'CONTRACT_INVALID', retryable: false } });
  assert.deepEqual(decision, {
    attempt: 1,
    attemptsAllowed: 2,
    retryable: false,
    recoveryRounds: 0,
    maxRecoveryRounds: 4,
    code: 'CONTRACT_INVALID',
    at: 0,
    step: 'fail',
    verdict: 'FAILED',
    reason: 'failure CONTRACT_INVALID is not retryable',
    terminal: true,
  });
});

test('the explicit retryable override is honoured in both directions', () => {
  const controller = createRecoveryController({ now: () => 0 });
  const forcedRetryable = controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: { code: 'NOPE', retryable: false }, retryable: true });
  assert.equal(forcedRetryable.step, 'retry');
  assert.equal(forcedRetryable.retryable, true);

  const forcedNot = controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: { code: 'MAYBE', retryable: true }, retryable: false });
  assert.equal(forcedNot.step, 'fail');
  assert.equal(forcedNot.reason, 'failure MAYBE is not retryable');
});

test('an absent error is retryable, and an error with no code fails by its code-less message', () => {
  const controller = createRecoveryController({ now: () => 0 });
  const noError = controller.decide({ action: { type: 'CLICK' }, attempt: 1 });
  assert.equal(noError.step, 'retry');
  assert.equal(noError.code, null);
  assert.equal(noError.reason, 'attempt 1 of 2 failed (unknown) - revalidate the target and retry');

  const noCode = controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: { retryable: false } });
  assert.equal(noCode.step, 'fail');
  assert.equal(noCode.reason, 'failure unknown is not retryable');
});

test('the attempt counts down against the action retry policy, not the controller default', () => {
  const controller = createRecoveryController({ maxRetriesPerAction: 4, now: () => 0 });
  const first = controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR });
  assert.equal(first.attemptsAllowed, 4);
  assert.equal(first.verdict, 'RETRYABLE');
  assert.equal(first.step, 'retry');
  assert.equal(first.revalidate, true);
  assertExact(first.cooldownSignals, [], 'first.cooldownSignals');
  assert.equal(first.visualLevel, 0);

  const actionPolicy = controller.decide({ action: { type: 'CLICK', retry: { maxAttempts: 3 } }, attempt: 1, error: RETRYABLE_ERROR });
  assert.equal(actionPolicy.attemptsAllowed, 3);
  assert.equal(actionPolicy.reason, 'attempt 1 of 3 failed (SOMETHING) - revalidate the target and retry');

  const lastAttempt = controller.decide({ action: { type: 'CLICK', retry: { maxAttempts: 3 } }, attempt: 3, error: RETRYABLE_ERROR, usedChannel: 'dom' });
  assert.notEqual(lastAttempt.step, 'retry');
});

test('the retry rung escalates the visual level only after the first attempt', () => {
  const controller = createRecoveryController({ now: () => 0 });
  assert.equal(controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR, visualLevel: 0 }).visualLevel, 0);
  // attempt 2 of 2 is the last attempt, so the escalation is only observable on an
  // action whose own policy allows a third attempt.
  assert.equal(controller.decide({ action: { type: 'CLICK' }, attempt: 2, error: RETRYABLE_ERROR, visualLevel: 0 }).step, 'replan');
  const escalated = controller.decide({ action: { type: 'CLICK', retry: { maxAttempts: 4 } }, attempt: 3, error: RETRYABLE_ERROR, visualLevel: 0 });
  assert.equal(escalated.step, 'retry');
  assert.equal(escalated.attemptsAllowed, 4);
  assert.equal(escalated.visualLevel, 1);
  // The default round ceiling is attemptsAllowed + 2, so attempt 3 of 4 still has
  // rounds left.
  assert.equal(escalated.maxRecoveryRounds, 6);
});

test('nextVisualLevel climbs one rung and stops at the injected ceiling', () => {
  const controller = createRecoveryController({ visualLevelCeiling: 3, now: () => 0 });
  assert.equal(controller.nextVisualLevel(0), 1);
  assert.equal(controller.nextVisualLevel(2), 3);
  assert.equal(controller.nextVisualLevel(3), 3);
  // A non-integer level is treated as NONE, as in the donor.
  assert.equal(controller.nextVisualLevel('x'), 1);
  assert.equal(controller.nextVisualLevel(0, 1), 1);
  assert.equal(controller.nextVisualLevel(0, 0), 0);

  const ceilingOne = createRecoveryController({ visualLevelCeiling: 1, now: () => 0 });
  assert.equal(ceilingOne.nextVisualLevel(0), 1);
  assert.equal(ceilingOne.nextVisualLevel(1), 1);
  // The exhausted branches report the ceiling as the level to escalate to; the
  // non-retryable branch does not report a level at all, exactly as in the donor.
  const failed = ceilingOne.decide({ action: { type: 'CLICK' }, attempt: 1, error: { code: 'CONTRACT_INVALID' }, retryable: false });
  assert.equal(failed.step, 'fail');
  assert.equal(failed.reason, 'failure CONTRACT_INVALID is not retryable');
  assert.equal(failed.visualLevel, undefined);
  const exhaustedRounds = ceilingOne.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR, recoveryRounds: 5, maxRecoveryRounds: 4 });
  assert.equal(exhaustedRounds.step, 'fail');
  assert.equal(exhaustedRounds.visualLevel, 1);
  const exhaustedRecoveries = ceilingOne.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR, recoveryRounds: 5, maxRecoveryRounds: 4, visualLevel: 2 });
  assert.equal(exhaustedRecoveries.visualLevel, 1);
  const exhaustedBudget = createRecoveryController({ visualLevelCeiling: 1, maxStallRecoveries: 1, now: () => 0 })
    .decide({ action: { type: 'KEY_PRESS', retry: { maxAttempts: 1 } }, attempt: 1, error: RETRYABLE_ERROR, stallRecoveries: 2 });
  assert.equal(exhaustedBudget.step, 'fail');
  assert.equal(exhaustedBudget.reason, 'recovery budget exhausted (2/1 stall recoveries) - failing with context');
  assert.equal(exhaustedBudget.visualLevel, 1);
});

test('the cooldown signals are the donor mapping, de-duplicated', () => {
  const controller = createRecoveryController({ now: () => 0 });
  const cases = [
    [{ code: CODES.TARGET_STALE }, ['target-moved']],
    [{ code: CODES.UI_UNSTABLE }, ['ui-changing']],
    [{ code: CODES.WINDOW_MISMATCH }, ['window-changed']],
    [{ code: CODES.VERIFICATION_FAILED }, ['previous-miss']],
    [{ code: CODES.ACTION_MISSED }, ['previous-miss']],
    [{ code: 'PLAIN' }, []],
  ];
  for (const [error, expected] of cases) {
    const decision = controller.decide({ action: { type: 'CLICK' }, attempt: 1, error, visualLevel: 3 });
    assert.deepEqual(decision.cooldownSignals, expected, error.code);
  }
  // A miss report adds the signal only when it actually missed, and a code that
  // already implies it does not double it.
  assert.deepEqual(
    controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: { code: CODES.TARGET_STALE }, miss: { missed: true }, visualLevel: 3 }).cooldownSignals,
    ['target-moved', 'previous-miss'],
  );
  assert.deepEqual(
    controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: { code: CODES.ACTION_MISSED }, miss: { missed: true }, visualLevel: 3 }).cooldownSignals,
    ['previous-miss'],
  );
  assert.deepEqual(
    controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR, miss: { missed: false }, visualLevel: 3 }).cooldownSignals,
    [],
  );
});

test('the alternative rung converts the same intent to the cheapest untried channel', () => {
  const controller = createRecoveryController({ now: () => 0 });
  const action = { type: 'CLICK', id: 'a1', description: 'primary', target: { ref: 'node-1' }, params: {}, retry: { maxAttempts: 2, allowAlternative: true } };
  const decision = controller.decide({ action, attempt: 2, error: RETRYABLE_ERROR, usedChannel: 'dom', visualLevel: 0 });

  assert.equal(decision.step, 'alternative_action');
  assert.equal(decision.verdict, 'ALTERNATIVE_AVAILABLE');
  assert.equal(decision.terminal, undefined);
  assert.equal(decision.revalidate, true);
  assert.deepEqual(decision.cooldownSignals, ['previous-miss']);
  assert.equal(decision.visualLevel, 1);
  assert.equal(decision.reason, 'retries are exhausted - switching CLICK to ACCESSIBILITY_INVOKE (different interaction channel)');
  assert.deepEqual(decision.alternative, {
    type: 'ACCESSIBILITY_INVOKE',
    id: 'a1#alt2',
    description: 'primary (alternative via accessibility)',
    target: { ref: 'node-1' },
    params: { __channel: 'accessibility' },
    channel: 'accessibility',
    retry: { maxAttempts: 1, allowAlternative: true },
  });
  assert.equal(alternativeController(decision.alternative), 'desktop');
});

test('the alternative rung is skipped when the action forbids an alternative', () => {
  const controller = createRecoveryController({ now: () => 0 });
  const decision = controller.decide({
    action: { type: 'CLICK', target: { ref: 'n' }, retry: { maxAttempts: 2, allowAlternative: false } },
    attempt: 2,
    error: RETRYABLE_ERROR,
  });
  assert.equal(decision.step, 'replan');
  assert.equal(decision.verdict, 'REPLAN_REQUIRED');
});

test('the alternative rung is skipped when the retry policy is absent (donor condition)', () => {
  const controller = createRecoveryController({ now: () => 0 });
  const decision = controller.decide({ action: { type: 'CLICK', target: { ref: 'n' } }, attempt: 2, error: RETRYABLE_ERROR, usedChannel: 'dom' });
  assert.equal(decision.step, 'replan');
  assert.equal(decision.reason, 'no alternative interaction exists for CLICK - re-observe and replan');
  assert.equal(decision.revalidate, true);
  assert.equal(decision.reobserve, true);
  assert.deepEqual(decision.cooldownSignals, ['previous-miss']);
});

test('the replan rung reports, and runs out at maxStallRecoveries', () => {
  const controller = createRecoveryController({ maxStallRecoveries: 2, now: () => 0 });
  const first = controller.decide({ action: { type: 'CLICK' }, attempt: 2, error: RETRYABLE_ERROR, stallRecoveries: 0 });
  assert.equal(first.step, 'replan');
  assert.equal(first.reason, 'no alternative interaction exists for CLICK - re-observe and replan');

  const second = controller.decide({ action: { type: 'CLICK' }, attempt: 2, error: RETRYABLE_ERROR, stallRecoveries: 1 });
  assert.equal(second.step, 'replan');

  const exhausted = controller.decide({ action: { type: 'CLICK' }, attempt: 2, error: RETRYABLE_ERROR, stallRecoveries: 2, visualLevel: 1 });
  assertExact(exhausted, {
    attempt: 2,
    attemptsAllowed: 2,
    retryable: true,
    recoveryRounds: 0,
    maxRecoveryRounds: 4,
    code: 'SOMETHING',
    at: 0,
    step: 'fail',
    verdict: 'FAILED',
    reason: 'recovery budget exhausted (2/2 stall recoveries) - failing with context',
    terminal: true,
    visualLevel: 3,
  }, 'exhausted');
});

test('an action that cannot be converted names the action type on the replan rung', () => {
  const controller = createRecoveryController({ now: () => 0 });
  // KEY_PRESS is a gui-only action with no intent in the donor's conversion table,
  // and its policy has already spent its single attempt, so the donor reaches the
  // replan rung with the action's own type in the reason.
  const decision = controller.decide({ action: { type: 'KEY_PRESS', retry: { maxAttempts: 1 } }, attempt: 1, error: RETRYABLE_ERROR });
  assert.equal(decision.step, 'replan');
  assert.equal(decision.reason, 'no alternative interaction exists for KEY_PRESS - re-observe and replan');

  // With no action at all the retry rung only closes once the controller's own
  // default budget is spent, and then the donor's fallback phrase is used.
  const noAction = controller.decide({ action: null, attempt: 1, error: RETRYABLE_ERROR });
  assert.equal(noAction.step, 'retry');
  assert.equal(noAction.attemptsAllowed, 2);
  const noActionLate = controller.decide({ action: null, attempt: 2, error: RETRYABLE_ERROR });
  assert.equal(noActionLate.step, 'replan');
  assert.equal(noActionLate.reason, 'no alternative interaction exists for the action - re-observe and replan');

  // A one-attempt controller closes the retry rung immediately.
  const single = createRecoveryController({ maxRetriesPerAction: 1, now: () => 0 });
  const singleNoAction = single.decide({ action: null, attempt: 1, error: RETRYABLE_ERROR });
  assert.equal(singleNoAction.step, 'replan');
  assert.equal(singleNoAction.reason, 'no alternative interaction exists for the action - re-observe and replan');
});

test('a CLICK with no target still converts, because vision click pixels', () => {
  const controller = createRecoveryController({ now: () => 0 });
  const decision = controller.decide({ action: { type: 'CLICK', retry: { maxAttempts: 1 } }, attempt: 1, error: RETRYABLE_ERROR, usedChannel: 'dom' });
  assert.equal(decision.step, 'alternative_action');
  assert.equal(decision.reason, 'retries are exhausted - switching CLICK to CLICK (different interaction channel)');
  assert.equal(decision.alternative.channel, 'vision');
  assert.equal(decision.alternative.type, 'CLICK');
});

test('the round budget is checked before every other rung and defaults to attemptsAllowed + 2', () => {
  const controller = createRecoveryController({ maxRetriesPerAction: 2, now: () => 0 });
  const decision = controller.decide({
    action: { type: 'CLICK', retry: { maxAttempts: 5 } },
    attempt: 1,
    error: RETRYABLE_ERROR,
    recoveryRounds: 7,
  });
  assert.equal(decision.maxRecoveryRounds, 7);
  assert.equal(decision.step, 'fail');
  assert.equal(decision.verdict, 'FAILED');
  assert.equal(decision.reason, 'the recovery ladder for this step is exhausted (7/7 rounds) - failing with context');
  assert.equal(decision.visualLevel, 3);

  const justBelow = controller.decide({ action: { type: 'CLICK', retry: { maxAttempts: 5 } }, attempt: 1, error: RETRYABLE_ERROR, recoveryRounds: 6, maxRecoveryRounds: 7 });
  assert.equal(justBelow.step, 'retry');

  const explicit = controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR, recoveryRounds: 3, maxRecoveryRounds: 3 });
  assert.equal(explicit.reason, 'the recovery ladder for this step is exhausted (3/3 rounds) - failing with context');
});

test('decisions() returns every decision in order, as a copy', () => {
  const controller = createRecoveryController({ now: () => 0 });
  controller.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR });
  controller.decide({ action: { type: 'CLICK' }, attempt: 2, error: RETRYABLE_ERROR });
  const decisions = controller.decisions();
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions.map((entry) => entry.step), ['retry', 'replan']);
  decisions.length = 0;
  assert.equal(controller.decisions().length, 2);
});

test('the controller reports its own bounds', () => {
  const controller = createRecoveryController({ maxRetriesPerAction: 3, maxStallRecoveries: 1 });
  assert.equal(controller.maxRetriesPerAction, 3);
  assert.equal(controller.maxStallRecoveries, 1);
  const defaults = createRecoveryController();
  assert.equal(defaults.maxRetriesPerAction, 2);
  assert.equal(defaults.maxStallRecoveries, 2);
});

test('stallStep walks the donor ladder one rung at a time and ends terminal at fail_with_context', () => {
  const controller = createRecoveryController({ now: stepNow() });
  const seen = [];
  for (let index = 0; index < STALL_RECOVERY_LADDER.length; index += 1) {
    const decision = controller.stallStep(index);
    seen.push(decision.ladderStep);
    assert.equal(decision.step, 'stall');
    assert.equal(decision.index, index);
    assert.equal(decision.description, STALL_RECOVERY_LADDER[index].description);
    assert.equal(decision.reason, `stall recovery rung ${index + 1}/8: ${STALL_RECOVERY_LADDER[index].step}`);
    assert.equal(decision.terminal, STALL_RECOVERY_LADDER[index].step === 'fail_with_context');
    // `stallStep` reads the clock once, so the step counter is the literal `at`.
    assert.equal(decision.at, index);
  }
  assert.deepEqual(seen, STALL_RECOVERY_LADDER.map((rung) => rung.step));
});

test('stallStep clamps an out-of-range index to the ends of the ladder', () => {
  const controller = createRecoveryController({ now: () => 0 });
  assert.equal(controller.stallStep(-5).ladderStep, 'structured_reobserve');
  assert.equal(controller.stallStep(-5).index, 0);
  assert.equal(controller.stallStep(99).ladderStep, 'fail_with_context');
  assert.equal(controller.stallStep(99).index, 7);
  assert.equal(controller.stallStep(99).terminal, true);
  // The donor's `Math.min(Number(index) || 0, …)` guard absorbs NaN, so a
  // non-numeric or absent index takes the first rung rather than throwing.
  assert.equal(controller.stallStep('nonsense').ladderStep, 'structured_reobserve');
  assert.equal(controller.stallStep(undefined).ladderStep, 'structured_reobserve');
  assert.equal(controller.stallStep(null).ladderStep, 'structured_reobserve');
  assert.equal(controller.stallStep('3').index, 3);
});

test('a fractional stall index throws the donor TypeError', () => {
  const controller = createRecoveryController({ now: () => 0 });
  // Donor defect, preserved: `Math.min` keeps 2.9 as 2.9, the array read is
  // `undefined`, and the rung read throws. A fractional index is not a rung.
  assert.throws(() => controller.stallStep(2.9), TypeError);
  assert.throws(() => controller.stallStep(2.9), /Cannot read properties of undefined \(reading 'step'\)/);
  // 2.0 is a legal index an integer-valued float can reach.
  assert.equal(controller.stallStep(2.0).index, 2);
});

test('mapType is the donor intent × channel table', () => {
  assert.equal(mapType('activate', 'dom'), 'DOM_CLICK');
  assert.equal(mapType('activate', 'accessibility'), 'ACCESSIBILITY_INVOKE');
  assert.equal(mapType('activate', 'gui'), 'CLICK');
  assert.equal(mapType('activate', 'vision'), 'CLICK');
  assert.equal(mapType('set-text', 'dom'), 'DOM_TYPE');
  assert.equal(mapType('set-text', 'accessibility'), 'ACCESSIBILITY_SET_VALUE');
  assert.equal(mapType('set-text', 'gui'), 'TYPE');
  assert.equal(mapType('focus', 'dom'), 'FOCUS');
  assert.equal(mapType('focus', 'accessibility'), 'FOCUS');
  assert.equal(mapType('focus', 'gui'), 'FOCUS');
  assert.equal(mapType('select', 'dom'), 'DOM_SELECT');
  assert.equal(mapType('select', 'accessibility'), 'SELECT');
  assert.equal(mapType('select', 'gui'), 'SELECT');
  assert.equal(mapType('scroll', 'dom'), 'SCROLL');
  assert.equal(mapType('scroll', 'gui'), 'SCROLL');
  // Every rung the donor leaves out answers null.
  assert.equal(mapType('scroll', 'accessibility'), null);
  assert.equal(mapType('scroll', 'vision'), null);
  assert.equal(mapType('set-text', 'vision'), null);
  assert.equal(mapType('unknown-intent', 'dom'), null);
  assert.equal(mapType(undefined, 'dom'), null);
});

test('alternativeAction is null for a null action and picks the intent per action type', () => {
  assert.equal(alternativeAction(null), null);
  assert.equal(alternativeAction(undefined), null);
  const typed = alternativeAction({ type: 'TYPE', target: { ref: 'n' }, params: {}, retry: { maxAttempts: 2 } }, { attempt: 1, usedChannel: 'dom' });
  assert.equal(typed.type, 'ACCESSIBILITY_SET_VALUE');
  assert.equal(typed.channel, 'accessibility');
  assert.equal(typed.id, null);
  assert.equal(typed.description, 'alternative via accessibility');
  assert.equal(typed.retry.maxAttempts, 1);
  const noRetry = alternativeAction({ type: 'TYPE', target: { ref: 'n' } }, { attempt: 3, usedChannel: 'dom' });
  assert.equal(noRetry.retry, null);
  assert.equal(noRetry.id, null);
});

test('alternativeAction never offers dom or accessibility for a visual target', () => {
  const visual = alternativeAction(
    { type: 'CLICK', target: { visual: { paint: { color: '#fff' } } }, params: {} },
    { attempt: 1, usedChannel: 'gui', point: { x: 5, y: 6 } },
  );
  assert.equal(visual.type, 'CLICK');
  assert.equal(visual.channel, 'vision');
  assert.deepEqual(visual.params, { __channel: 'vision' });

  // Without a point a gui alternative cannot be built, and no structured channel
  // is allowed for a visual target, so there is nothing left.
  assert.equal(
    alternativeAction({ type: 'CLICK', target: { visual: {} }, params: {} }, { attempt: 1, usedChannel: 'vision' }),
    null,
  );
});

test('alternativeAction respects the contract capabilities and the used channel', () => {
  const action = { type: 'CLICK', target: { ref: 'n' }, params: {} };
  // Only the desktop capability is allowed: dom is dropped, accessibility stays.
  const allowed = alternativeAction(action, { attempt: 1, usedChannel: null, allowedCapabilities: ['desktop'] });
  assert.equal(allowed.channel, 'accessibility');
  // The used channel is never offered again.
  assert.equal(alternativeAction(action, { attempt: 1, usedChannel: 'dom' }).channel, 'accessibility');
  assert.equal(alternativeAction(action, { attempt: 1, usedChannel: 'dom' }).params.__channel, 'accessibility');
  // An empty allow-list is treated as "no constraint" by the donor.
  assert.equal(alternativeAction(action, { attempt: 1, usedChannel: 'dom', allowedCapabilities: [] }).channel, 'accessibility');
  // Nothing allowed at all: no alternative.
  assert.equal(alternativeAction(action, { attempt: 1, allowedCapabilities: ['filesystem'] }), null);
  // The capability a channel needs is read from the channel, not from the action:
  // a contract that allows only the shell capability leaves nothing to convert to.
  assert.equal(alternativeAction(action, { attempt: 1, allowedCapabilities: ['shell'] }), null);
  // A browser capability is carried by dom *and* api; dom is the first candidate.
  assert.equal(alternativeAction(action, { attempt: 1, usedChannel: 'accessibility', allowedCapabilities: ['browser'] }).channel, 'dom');
});

test('alternativeAction prefers the cheapest remaining channel and builds the gui point', () => {
  const chosen = alternativeAction({ type: 'CLICK', target: { ref: 'n' }, params: {} }, { attempt: 1, usedChannel: 'accessibility' });
  assert.equal(chosen.channel, 'dom');
  assert.equal(chosen.type, 'DOM_CLICK');

  const guiOnly = alternativeAction(
    { type: 'CLICK', target: { ref: 'n' }, params: {} },
    { attempt: 1, usedChannel: 'dom', point: { x: 11, y: 12 } },
  );
  // accessibility precedes gui, so the gui point is only carried when the gui
  // channel is the one being built.
  assert.equal(guiOnly.channel, 'accessibility');

  // A DOM_TYPE action has no gui rung in the donor's plan, so the resolved point
  // cannot buy a coordinate click here.
  const domType = alternativeAction(
    { type: 'DOM_TYPE', target: { ref: 'n' }, params: {} },
    { attempt: 1, usedChannel: 'dom', resolved: { point: { x: 3, y: 4 } } },
  );
  assert.equal(domType.channel, 'accessibility');
  assert.equal(domType.type, 'ACCESSIBILITY_SET_VALUE');

  // A gui rung that swallows the resolved point is no rung at all.
  const pointless = alternativeAction(
    { type: 'DOM_TYPE', target: { ref: 'n' }, params: {} },
    { attempt: 1, usedChannel: 'accessibility' },
  );
  assert.equal(pointless.channel, 'dom');

  const guiPick = alternativeAction(
    { type: 'CLICK', target: { ref: 'n' }, params: {} },
    { attempt: 1, usedChannel: null, allowedCapabilities: ['desktop'] },
  );
  // dom is dropped by the contract, accessibility is the cheapest left.
  assert.equal(guiPick.channel, 'accessibility');
});

test('alternativeController reads the channel from either shape and answers null otherwise', () => {
  assert.equal(alternativeController({ channel: 'dom' }), 'browser');
  assert.equal(alternativeController({ params: { __channel: 'gui' } }), 'desktop');
  assert.equal(alternativeController({ params: { __channel: 'file' } }), 'file');
  assert.equal(alternativeController({ params: { __channel: 'vision' } }), 'vision');
  assert.equal(alternativeController({ channel: 'nope' }), null);
  assert.equal(alternativeController({}), null);
  assert.equal(alternativeController(null), null);
});

test('exhaustedError is the donor PLAN_EXHAUSTED failure carrying the decision context', () => {
  const decision = { reason: 'recovery budget exhausted', attempt: 3, code: 'SOMETHING' };
  const error = exhaustedError(decision);
  assert.ok(error instanceof ComputerUseError);
  assert.equal(error.name, 'ComputerUseError');
  assert.equal(error.code, 'PLAN_EXHAUSTED');
  assert.equal(error.message, 'recovery budget exhausted');
  assert.deepEqual(error.details, { attempts: 3, code: 'SOMETHING' });
  assert.equal(error.retryable, false);
  assert.equal(error.controllerId, null);
  assert.equal(error.state, null);
  assert.deepEqual(error.toJSON(), {
    code: 'PLAN_EXHAUSTED',
    message: 'recovery budget exhausted',
    retryable: false,
    controllerId: null,
    state: null,
    details: { attempts: 3, code: 'SOMETHING' },
  });

  const bare = exhaustedError({ attempt: 1 });
  assert.equal(bare.message, 'the recovery ladder is exhausted');
  assert.deepEqual(bare.details, { attempts: 1, code: null });
});

test('a decision is stamped with the injected clock, and the default clock is a step clock', () => {
  const injected = createRecoveryController({ now: () => 1234 });
  assert.equal(injected.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR }).at, 1234);
  assert.equal(injected.stallStep(0).at, 1234);

  const first = createRecoveryController();
  const second = createRecoveryController();
  assert.equal(first.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR }).at, 0);
  assert.equal(second.decide({ action: { type: 'CLICK' }, attempt: 1, error: RETRYABLE_ERROR }).at, 0);
  assert.equal(first.stallStep(0).at, 1);
});
