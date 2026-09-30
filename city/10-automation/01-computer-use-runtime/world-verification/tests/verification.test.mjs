/**
 * UTOPIA · 10-automation / Computer Use Runtime — verification suite.
 *
 * Restates DS-Hns `app/computer-use/verification.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the three-way verdict rule, the
 * `any`/`all` modes, the dominant-kind order, every evaluator branch and every
 * message. The clock and the digest are injected, so `checkedAt` is a pinned
 * number and the world-change digest is reproducible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PINNED_AT, PINNED_HASH, pinnedClock, vworld } from './fixtures.mjs';
import { evaluateEffect, createVerifier, findControl, targetPresent, verifyFactsFrom } from '../verification.mjs';
import { meaningfulChange as findMeaningful, evidenceDigest } from '../world-state.mjs';
import { VERDICTS, VERIFICATION_KINDS } from '../contracts.mjs';

/** A verifier whose verdicts carry a pinned `checkedAt`. */
function verifier() {
  return createVerifier({ clock: pinnedClock(PINNED_AT), hash: PINNED_HASH });
}

/** A verifier whose clock advances, so two calls cannot share a `checkedAt` by accident. */
function steppingVerifier() {
  let value = PINNED_AT;
  return createVerifier({
    clock: {
      now() {
        value += 5;
        return value;
      },
    },
    hash: PINNED_HASH,
  });
}

/**
 * One declared effect. The donor's `any`/`all` keys select *which* effects are
 * listed; the `all` *mode* is declared separately, as `expectedEffect.mode`, so
 * the two are kept apart here exactly as the donor keeps them apart.
 */
function actionWithAny(effects, extra = {}) {
  return { type: 'CLICK', expectedEffect: { any: effects, ...extra } };
}

function actionWithAll(effects, extra = {}) {
  return { type: 'CLICK', expectedEffect: { all: effects, ...extra } };
}

const sameWorld = () => [vworld(), vworld()];

test('a controller that reported failure settles the verdict without reading the world', async () => {
  const result = await verifier().verify({
    action: actionWithAny([]),
    before: null,
    after: null,
    receipt: { ok: false, error: 'the click was swallowed' },
  });
  assert.equal(result.verdict, VERDICTS.FAILURE);
  assert.equal(result.kind, VERIFICATION_KINDS.NONE);
  assert.deepEqual(result.evidence, [{ kind: 'receipt', ok: false, detail: 'the click was swallowed' }]);
  assert.equal(result.checkedAt, PINNED_AT);

  // `ok: false` without an error message is not treated as established failure.
  const noError = await verifier().verify({ action: { type: 'CLICK' }, before: null, after: null, receipt: { ok: false } });
  assert.equal(noError.verdict, VERDICTS.UNKNOWN);
  assert.equal(noError.kind, VERIFICATION_KINDS.DIRECT);
  assert.deepEqual(noError.evidence, [{ kind: 'world-change', ok: null, detail: 'no comparable observation' }]);
});

test('with no declared effect: a first observation is unknown, never a success', async () => {
  // The donor's change check is a *comparison*: with no `before` there is nothing
  // to compare against, so the honest verdict is `unknown` rather than success.
  const first = await verifier().verify({ action: { type: 'CLICK' }, before: null, after: vworld() });
  assert.equal(first.verdict, VERDICTS.UNKNOWN);
  assert.equal(first.kind, VERIFICATION_KINDS.DIRECT);
  assert.deepEqual(first.evidence, [{ kind: 'world-change', ok: null, detail: 'no comparable observation' }]);
  assert.equal(first.checkedAt, PINNED_AT);

  // A real field difference between two readable observations is a change.
  const fieldChanged = await verifier().verify({ action: { type: 'CLICK' }, before: vworld({ url: 'https://example.test/a' }), after: vworld({ url: 'https://example.test/b' }) });
  assert.equal(fieldChanged.verdict, VERDICTS.SUCCESS);
  assert.deepEqual(fieldChanged.evidence, [{ kind: 'world-change', ok: true, detail: ['url'] }]);

  const failure = await verifier().verify({ action: { type: 'CLICK' }, before: vworld(), after: vworld() });
  assert.equal(failure.verdict, VERDICTS.FAILURE);
  assert.equal(failure.kind, VERIFICATION_KINDS.DIRECT);
  assert.deepEqual(failure.evidence, [{ kind: 'world-change', ok: false, detail: [] }]);
});

test('with no declared effect: the DOM revision is evidence for the digest but is deliberately not a meaningful field', async () => {
  const before = vworld({ revision: 7, signature: 'sig' });
  const after = vworld({ revision: 8, signature: 'sig' });
  const result = await verifier().verify({ action: { type: 'CLICK' }, before, after });
  assert.equal(result.verdict, VERDICTS.SUCCESS);
  assert.deepEqual(result.kind, VERIFICATION_KINDS.DIRECT);
  assert.deepEqual(result.evidence, [{ kind: 'world-change', ok: true, detail: ['DOM revision or event stream changed'] }]);
  // Nothing meaningful moved — `revision` is not one of the 13 fields — so only
  // the evidence digest separates the two observations.
  assert.deepEqual(findMeaningful(before, after), { changed: false, fields: [], meaningful: false });
  assert.notEqual(evidenceDigest(before, { hash: PINNED_HASH }), evidenceDigest(after, { hash: PINNED_HASH }));

  // The same revision, the same signature: no evidence, so no success.
  const identical = await verifier().verify({ action: { type: 'CLICK' }, before: vworld({ revision: 7, signature: 'sig' }), after: vworld({ revision: 7, signature: 'sig' }) });
  assert.equal(identical.verdict, VERDICTS.FAILURE);
  assert.deepEqual(identical.evidence, [{ kind: 'world-change', ok: false, detail: [] }]);
});

test('with no declared effect: a missing observation on either side is unknown, never a verdict', async () => {
  const missingBefore = await verifier().verify({ action: { type: 'CLICK' }, before: null, after: vworld() });
  assert.equal(missingBefore.verdict, VERDICTS.UNKNOWN);
  assert.equal(missingBefore.kind, VERIFICATION_KINDS.DIRECT);
  assert.deepEqual(missingBefore.evidence, [{ kind: 'world-change', ok: null, detail: 'no comparable observation' }]);

  const missingAfter = await verifier().verify({ action: { type: 'CLICK' }, before: vworld(), after: null });
  assert.equal(missingAfter.verdict, VERDICTS.UNKNOWN);
  assert.equal(missingAfter.kind, VERIFICATION_KINDS.DIRECT);
  assert.deepEqual(missingAfter.evidence, [{ kind: 'world-change', ok: null, detail: 'no comparable observation' }]);
});

test('with no declared effect: receipt signals are appended and receipt.changed can carry the verdict', async () => {
  const before = vworld();
  const after = vworld();
  const carried = await verifier().verify({
    action: { type: 'CLICK' },
    before,
    after,
    receipt: { changed: true, signals: [{ kind: 'receipt', ok: true, detail: 'backend says it landed' }] },
  });
  assert.equal(carried.verdict, VERDICTS.SUCCESS);
  assert.deepEqual(carried.evidence, [
    { kind: 'world-change', ok: false, detail: [] },
    { kind: 'receipt', ok: true, detail: 'backend says it landed' },
  ]);

  // changed: false is not `=== true`, so it does not carry a success.
  const notCarried = await verifier().verify({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), receipt: { changed: false } });
  assert.equal(notCarried.verdict, VERDICTS.FAILURE);
});

test('any mode: one observed effect is success, none observed is failure', async () => {
  const [before, after] = sameWorld();
  const success = await verifier().verify({ action: actionWithAny([{ url_matches: 'example' }, { event: 'never_happens' }]), before, after: vworld({ url: 'https://example.test/next' }) });
  assert.equal(success.verdict, VERDICTS.SUCCESS);
  assert.equal(success.kind, VERIFICATION_KINDS.NAVIGATION);

  const failure = await verifier().verify({
    action: actionWithAny([{ dom_mutated: true }, { event: 'never_happens' }]),
    before: vworld({ revision: 5 }),
    after: vworld({ revision: 5 }),
  });
  assert.equal(failure.verdict, VERDICTS.FAILURE);
  assert.equal(failure.kind, VERIFICATION_KINDS.EVENT);
});

test('any mode: unknown only when nothing at all was checkable, otherwise a checked failure wins', async () => {
  const bothUncheckable = vworld({ revision: null, url: null });
  const allUnknown = await verifier().verify({
    action: actionWithAny([{ dom_mutated: true }, { navigation: true }]),
    before: bothUncheckable,
    after: vworld({ revision: null, url: null }),
  });
  assert.equal(allUnknown.verdict, VERDICTS.UNKNOWN);
  assert.equal(allUnknown.kind, VERIFICATION_KINDS.NAVIGATION);
  assert.deepEqual(allUnknown.evidence, [
    { ok: null, verificationKind: 'event', detail: 'the page does not report a DOM revision' },
    { ok: null, verificationKind: 'navigation', detail: 'no page is attached' },
  ]);

  const checkedFailure = await verifier().verify({
    action: actionWithAny([{ dom_mutated: true }, { navigation: true }]),
    before: vworld({ revision: 5, url: 'https://example.test/a' }),
    after: vworld({ revision: 5, url: 'https://example.test/a' }),
  });
  assert.equal(checkedFailure.verdict, VERDICTS.FAILURE);
  assert.equal(checkedFailure.kind, VERIFICATION_KINDS.NAVIGATION);
  assert.deepEqual(checkedFailure.evidence, [
    { ok: false, verificationKind: 'event', detail: 'DOM revision unchanged (5)' },
    { ok: false, verificationKind: 'navigation', detail: 'URL unchanged (https://example.test/a)' },
  ]);
});

test('all mode is declared by expectedEffect.mode, not by the `all` key alone', async () => {
  const effects = [{ url_matches: 'example' }, { event: 'window_changed' }];
  const navigatedOnly = vworld({ url: 'https://example.test/next' });

  // Without `mode: 'all'` the donor defaults to `any`, so the one observed effect
  // carries the verdict even though the event is missing.
  const defaultAny = await verifier().verify({ action: actionWithAll(effects), before: vworld(), after: navigatedOnly });
  assert.equal(defaultAny.verdict, VERDICTS.SUCCESS);

  // With `mode: 'all'` every listed effect must hold.
  const allMode = await verifier().verify({ action: actionWithAll(effects, { mode: 'all' }), before: vworld(), after: navigatedOnly });
  assert.equal(allMode.verdict, VERDICTS.FAILURE);
  assert.equal(allMode.kind, VERIFICATION_KINDS.NAVIGATION);
  assert.deepEqual(allMode.evidence, [
    { ok: true, verificationKind: 'navigation', detail: 'url matches example' },
    { ok: false, verificationKind: 'event', detail: 'event not observed: window_changed' },
  ]);

  // Both effects observed: success.
  const allHold = await verifier().verify({
    action: actionWithAll(effects, { mode: 'all' }),
    before: vworld(),
    after: vworld({ url: 'https://example.test/next', systemEvents: [{ type: 'window_changed' }] }),
  });
  assert.equal(allHold.verdict, VERDICTS.SUCCESS);
  assert.equal(allHold.kind, VERIFICATION_KINDS.NAVIGATION);

  // One effect uncheckable and none failing: unknown, not a verdict.
  const oneUnknown = await verifier().verify({
    action: actionWithAll([{ url_matches: 'example' }, { dom_mutated: true }], { mode: 'all' }),
    before: vworld({ revision: null }),
    after: vworld({ url: 'https://example.test/next', revision: null }),
  });
  assert.equal(oneUnknown.verdict, VERDICTS.UNKNOWN);
  assert.equal(oneUnknown.kind, VERIFICATION_KINDS.NAVIGATION);

  // Every effect uncheckable: unknown, with the event kind (the highest kind present).
  const allUnknown = await verifier().verify({
    action: actionWithAll([{ dom_mutated: true }, { value_equals: 'x' }], { mode: 'all' }),
    before: vworld({ revision: null }),
    after: vworld({ revision: null }),
  });
  assert.equal(allUnknown.verdict, VERDICTS.UNKNOWN);
  assert.equal(allUnknown.kind, VERIFICATION_KINDS.EVENT);
  assert.deepEqual(allUnknown.evidence, [
    { ok: null, verificationKind: 'event', detail: 'the page does not report a DOM revision' },
    { ok: null, verificationKind: 'state', detail: 'no value could be read' },
  ]);
});

test('the declared mode wins over the action default, and neither beats an explicit effectMode', async () => {
  const effects = [{ url_matches: 'example' }, { event: 'window_changed' }];
  const navigatedOnly = vworld({ url: 'https://example.test/next' });

  // The action declares `mode: 'all'`, so one missing event fails the step.
  const allFromAction = await verifier().verify({ action: actionWithAll(effects, { mode: 'all' }), before: vworld(), after: navigatedOnly });
  assert.equal(allFromAction.verdict, VERDICTS.FAILURE, 'the action declared mode all, so one missing event fails it');

  // effectMode is read first, so it overrides that declaration.
  const anyOverride = await verifier().verify({ action: actionWithAll(effects, { mode: 'all' }), before: vworld(), after: navigatedOnly, effectMode: 'any' });
  assert.equal(anyOverride.verdict, VERDICTS.SUCCESS, 'effectMode=any overrides the action declaration');

  // The action declares nothing, so effectMode=all supplies the mode.
  const allOverride = await verifier().verify({ action: actionWithAny(effects), before: vworld(), after: navigatedOnly, effectMode: 'all' });
  assert.equal(allOverride.verdict, VERDICTS.FAILURE, 'effectMode=all supplies the mode the action did not declare');

  // And with no declaration anywhere, the donor default is `any`.
  const defaultAny = await verifier().verify({ action: actionWithAny(effects), before: vworld(), after: navigatedOnly });
  assert.equal(defaultAny.verdict, VERDICTS.SUCCESS, 'the default mode is any');
});

test('the dominant kind follows the donor order, and a failed effect keeps its kind', async () => {
  const result = await verifier().verify({
    action: actionWithAny([{ event: 'a' }, { checked_equals: true }]),
    before: vworld(),
    after: vworld(),
  });
  assert.equal(result.verdict, VERDICTS.FAILURE);
  assert.equal(result.kind, VERIFICATION_KINDS.EVENT, 'event outranks state');

  const stateWins = await verifier().verify({
    action: actionWithAny([{ checked_equals: true }, { url_matches: 'x' }]),
    before: vworld(),
    after: vworld({ url: 'https://example.test/x' }),
  });
  assert.equal(stateWins.verdict, VERDICTS.SUCCESS);
  assert.equal(stateWins.kind, VERIFICATION_KINDS.NAVIGATION, 'navigation outranks state');

  const noKind = await verifier().verify({ action: actionWithAny([{ unsupported_signal: 1 }]), before: vworld(), after: vworld() });
  assert.equal(noKind.verdict, VERDICTS.UNKNOWN);
  assert.equal(noKind.kind, VERIFICATION_KINDS.NONE);
});

test('an effect shape the donor does not know is unknown and names its keys', async () => {
  const result = await evaluateEffect({ unsupported_signal: 1, other: 2 }, { action: { type: 'CLICK' }, before: vworld(), after: vworld(), facts: {} });
  assert.deepEqual(result, { ok: null, verificationKind: VERIFICATION_KINDS.NONE, detail: 'unsupported expected effect: unsupported_signal, other' });

  const empty = await evaluateEffect({}, { action: { type: 'CLICK' }, before: vworld(), after: vworld(), facts: {} });
  assert.deepEqual(empty, { ok: null, verificationKind: VERIFICATION_KINDS.NONE, detail: 'unsupported expected effect: ' });
});

test('PRESERVED DONOR DEFECT: collectEffects reads `any`/`all` as arrays only, so an effectMode of `all` over a non-array declaration checks nothing', async () => {
  // The donor declares `expectedEffect.all` as an array and reads it as one. A
  // declaration shaped as `{ all: { ... } }` therefore yields no effects at all,
  // and the verifier silently falls back to "did anything change" — reporting a
  // `direct` verdict even though `effectMode: 'all'` was asked for.
  const result = await verifier().verify({
    action: { type: 'CLICK', expectedEffect: { all: { url_matches: 'example' } } },
    before: vworld(),
    after: vworld({ url: 'https://example.test/elsewhere' }),
    effectMode: 'all',
  });
  assert.equal(result.verdict, VERDICTS.SUCCESS);
  assert.equal(result.kind, VERIFICATION_KINDS.DIRECT);
  assert.deepEqual(result.evidence, [{ kind: 'world-change', ok: true, detail: ['url'] }]);

  // The same declaration with no change at all is a plain failure, not `all`.
  const unchanged = await verifier().verify({
    action: { type: 'CLICK', expectedEffect: { all: { url_matches: 'example' } } },
    before: vworld(),
    after: vworld(),
  });
  assert.equal(unchanged.verdict, VERDICTS.FAILURE);
  assert.equal(unchanged.kind, VERIFICATION_KINDS.DIRECT);

  // And an override given as a non-array behaves the same way.
  const override = await verifier().verify({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), expectedEffect: { all: { url_matches: 'example' } } });
  assert.equal(override.verdict, VERDICTS.FAILURE);
  assert.equal(override.kind, VERIFICATION_KINDS.DIRECT);

  // `any`/`all` as arrays is the shape the donor actually reads.
  const arrayShape = await verifier().verify({
    action: { type: 'CLICK' },
    before: vworld(),
    after: vworld({ url: 'https://example.test/elsewhere' }),
    expectedEffect: { all: [{ url_matches: 'example' }] },
  });
  assert.equal(arrayShape.kind, VERIFICATION_KINDS.NAVIGATION);
  assert.equal(arrayShape.verdict, VERDICTS.SUCCESS);
});

test('PRESERVED DONOR DEFECT: target_appears/target_disappears always report "could not be located" because the donor calls targetPresent(action, after)', async () => {
  const action = { type: 'CLICK', target: { ref: 'c-1' } };
  const afterWithTarget = vworld({ controls: [{ ref: 'c-1' }] });
  const afterWithoutTarget = vworld({ controls: [{ ref: 'c-2' }] });

  // Called the way the signature declares it, the helper answers correctly...
  assert.equal(targetPresent(afterWithTarget, action), true);
  assert.equal(targetPresent(afterWithoutTarget, action), false);

  // ...but the evaluator passes `(action, after)`, so the action is read as the
  // world. The action has no `controls`/`ax`, so the guard returns null and the
  // effect can never be observed, whatever the target actually did.
  const appeared = await evaluateEffect({ target_appears: true }, { action, before: vworld(), after: afterWithTarget, facts: {} });
  assert.deepEqual(appeared, { ok: null, verificationKind: 'direct', detail: 'the target could not be located after the action' });
  const didNotAppear = await evaluateEffect({ target_appears: true }, { action, before: vworld(), after: afterWithoutTarget, facts: {} });
  assert.deepEqual(didNotAppear, { ok: null, verificationKind: 'direct', detail: 'the target could not be located after the action' });
  const disappeared = await evaluateEffect({ target_disappears: true }, { action, before: afterWithTarget, after: afterWithoutTarget, facts: {} });
  assert.deepEqual(disappeared, { ok: null, verificationKind: 'direct', detail: 'the target could not be located after the action' });
  const stillThere = await evaluateEffect({ target_disappears: true }, { action, before: afterWithTarget, after: afterWithTarget, facts: {} });
  assert.deepEqual(stillThere, { ok: null, verificationKind: 'direct', detail: 'the target could not be located after the action' });

  // Through the verifier the same two effects are therefore always `unknown`,
  // and `unknown` never rounds up to success.
  const verdict = await verifier().verify({ action: actionWithAny([{ target_appears: true }]), before: vworld(), after: afterWithTarget });
  assert.equal(verdict.verdict, VERDICTS.UNKNOWN);
  assert.equal(verdict.kind, VERIFICATION_KINDS.DIRECT);
  const withSuccess = await verifier().verify({ action: actionWithAny([{ target_appears: true }, { url_matches: 'example' }]), before: vworld(), after: vworld({ url: 'https://example.test/x', controls: [{ ref: 'c-1' }] }) });
  assert.equal(withSuccess.verdict, VERDICTS.SUCCESS, 'another observed effect can still carry the verdict');

  // A target-less effect is still unknown for the same reason: no action target
  // to read, and the action-as-world has no control arrays either.
  const noTarget = await evaluateEffect({ target_appears: true }, { action: { type: 'CLICK' }, before: vworld(), after: vworld(), facts: {} });
  assert.deepEqual(noTarget, { ok: null, verificationKind: 'direct', detail: 'the target could not be located after the action' });
});

test('implied state: FOCUS and SWITCH_WINDOW are verified against the window that is in front', async () => {
  const focus = { type: 'FOCUS', target: { window: { handle: 1001, title: 'Example Form', processId: 4242 } } };
  const success = await verifier().verify({ action: focus, before: vworld(), after: vworld({ foreground: { handle: 1001, title: 'Example Form', processId: 4242 } }) });
  assert.equal(success.verdict, VERDICTS.SUCCESS);
  assert.equal(success.kind, VERIFICATION_KINDS.FOCUS);
  assert.deepEqual(success.evidence, [{ kind: 'focus-state', ok: true, detail: 'focus is on Example Form#1001' }]);

  const wrongWindow = await verifier().verify({ action: focus, before: vworld(), after: vworld({ foreground: { handle: 2002, title: 'Somewhere Else', processId: 9 } }) });
  assert.equal(wrongWindow.verdict, VERDICTS.FAILURE);
  assert.deepEqual(wrongWindow.evidence, [{ kind: 'focus-state', ok: false, detail: 'focus is on Somewhere Else#2002, not on the requested window' }]);

  // The title match is a case-insensitive substring and the process id is compared loosely.
  const loose = await verifier().verify({
    action: { type: 'SWITCH_WINDOW', target: { window: { title: 'example', processId: '4242' } } },
    before: vworld(),
    after: vworld({ foreground: { handle: 1, title: 'EXAMPLE FORM', processId: 4242 } }),
  });
  assert.equal(loose.verdict, VERDICTS.SUCCESS);

  // A mismatching process id is a failure even when the handle agrees.
  const wrongProcess = await verifier().verify({
    action: { type: 'FOCUS', target: { window: { handle: 1001, processId: 1 } } },
    before: vworld(),
    after: vworld({ foreground: { handle: 1001, title: 'Example Form', processId: 4242 } }),
  });
  assert.equal(wrongProcess.verdict, VERDICTS.FAILURE);

  // The foreground is also read from the window list when `foreground` is absent.
  const fromList = await verifier().verify({
    action: { type: 'FOCUS', target: { window: { handle: 1001 } } },
    before: vworld(),
    after: vworld({ windows: [{ handle: 1001, title: 'Listed', foreground: true }] }),
  });
  assert.equal(fromList.verdict, VERDICTS.SUCCESS);
  assert.deepEqual(fromList.evidence, [{ kind: 'focus-state', ok: true, detail: 'focus is on Listed#1001' }]);

  // No foreground window at all is unknown, not a failure.
  const noForeground = await verifier().verify({ action: focus, before: vworld(), after: vworld() });
  assert.equal(noForeground.verdict, VERDICTS.UNKNOWN);
  assert.equal(noForeground.kind, VERIFICATION_KINDS.FOCUS);
  assert.deepEqual(noForeground.evidence, [{ kind: 'focus-state', ok: null, detail: 'no foreground window could be observed' }]);
});

test('implied state: a window action without a target window falls through to the world-change check', async () => {
  const result = await verifier().verify({ action: { type: 'FOCUS' }, before: vworld(), after: vworld() });
  assert.equal(result.verdict, VERDICTS.FAILURE);
  assert.equal(result.kind, VERIFICATION_KINDS.DIRECT);
  assert.deepEqual(result.evidence, [{ kind: 'world-change', ok: false, detail: [] }]);

  const focusNoAfter = await verifier().verify({ action: { type: 'FOCUS' }, before: vworld(), after: null });
  assert.equal(focusNoAfter.verdict, VERDICTS.UNKNOWN);
  assert.deepEqual(focusNoAfter.evidence, [{ kind: 'world-change', ok: null, detail: 'no comparable observation' }]);

  const noAction = await verifier().verify({ action: null, before: vworld(), after: vworld() });
  assert.equal(noAction.verdict, VERDICTS.FAILURE);
  assert.equal(noAction.kind, VERIFICATION_KINDS.DIRECT);

  // An unrelated action type never reaches the implied check.
  const unrelated = await verifier().verify({ action: { type: 'CLICK', target: { window: { handle: 1 } } }, before: vworld(), after: vworld() });
  assert.equal(unrelated.kind, VERIFICATION_KINDS.DIRECT);
});

test('implied state: CLOSE_WINDOW is verified by the window being gone', async () => {
  const action = { type: 'CLOSE_WINDOW', target: { window: { handle: 1001 } } };
  const success = await verifier().verify({ action, before: vworld(), after: vworld({ windows: [{ handle: 1002 }] }) });
  assert.equal(success.verdict, VERDICTS.SUCCESS);
  assert.equal(success.kind, VERIFICATION_KINDS.STATE);
  assert.deepEqual(success.evidence, [{ kind: 'window-state', ok: true, detail: 'the window is gone' }]);

  const failure = await verifier().verify({ action, before: vworld(), after: vworld({ windows: [{ handle: 1001, title: 'Example Form' }] }) });
  assert.equal(failure.verdict, VERDICTS.FAILURE);
  assert.deepEqual(failure.evidence, [{ kind: 'window-state', ok: false, detail: 'the window is still open' }]);

  // The title is a case-insensitive substring when no handle is given.
  const byTitle = await verifier().verify({
    action: { type: 'CLOSE_WINDOW', target: { window: { title: 'background' } } },
    before: vworld(),
    after: vworld({ windows: [{ handle: 9, title: 'Some Background Window' }] }),
  });
  assert.equal(byTitle.verdict, VERDICTS.FAILURE);

  // No target window: the implied check declines, and the world-change check answers.
  const noTarget = await verifier().verify({ action: { type: 'CLOSE_WINDOW' }, before: vworld(), after: vworld() });
  assert.equal(noTarget.kind, VERIFICATION_KINDS.DIRECT);
  assert.equal(noTarget.verdict, VERDICTS.FAILURE);
});

test('effect: event is found by type or name, failed without an observation, unknown with no after world', async () => {
  const hit = await evaluateEffect({ event: 'window_changed' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ systemEvents: [{ type: 'window_changed' }] }), facts: {} });
  assert.deepEqual(hit, { ok: true, verificationKind: 'event', detail: 'event observed: window_changed' });

  const byName = await evaluateEffect({ event: 'focus_changed' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ systemEvents: [{ name: 'focus_changed' }] }), facts: {} });
  assert.equal(byName.ok, true);

  const miss = await evaluateEffect({ event: 'window_changed' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld(), facts: {} });
  assert.deepEqual(miss, { ok: false, verificationKind: 'event', detail: 'event not observed: window_changed' });

  const blind = await evaluateEffect({ event: 'window_changed' }, { action: { type: 'CLICK' }, before: vworld(), after: null, facts: {} });
  assert.deepEqual(blind, { ok: null, verificationKind: 'event', detail: 'no observation to search for the event' });

  // A null entry in the event stream is skipped rather than throwing.
  const nullEntry = await evaluateEffect({ event: 'window_changed' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ systemEvents: [null, { name: 'window_changed' }] }), facts: {} });
  assert.equal(nullEntry.ok, true);
});

test('effect: dom_mutated compares the DOM revision, and needs one on both sides', async () => {
  const moved = await evaluateEffect({ dom_mutated: true }, { action: { type: 'CLICK' }, before: vworld({ revision: 3 }), after: vworld({ revision: 4 }), facts: {} });
  assert.deepEqual(moved, { ok: true, verificationKind: 'event', detail: 'DOM revision 3 -> 4' });

  const still = await evaluateEffect({ dom_mutated: true }, { action: { type: 'CLICK' }, before: vworld({ revision: 3 }), after: vworld({ revision: 3 }), facts: {} });
  assert.deepEqual(still, { ok: false, verificationKind: 'event', detail: 'DOM revision unchanged (3)' });

  const unversioned = await evaluateEffect({ dom_mutated: true }, { action: { type: 'CLICK' }, before: vworld({ revision: null }), after: vworld({ revision: 3 }), facts: {} });
  assert.deepEqual(unversioned, { ok: null, verificationKind: 'event', detail: 'the page does not report a DOM revision' });

  const noWorld = await evaluateEffect({ dom_mutated: true }, { action: { type: 'CLICK' }, before: null, after: vworld({ revision: 3 }), facts: {} });
  assert.deepEqual(noWorld, { ok: null, verificationKind: 'event', detail: 'no comparable DOM revision' });
});

test('effect: navigation and url_changed compare URLs, and url_matches is a lowercase substring', async () => {
  const navigated = await evaluateEffect({ navigation: true }, { action: { type: 'CLICK' }, before: vworld({ url: 'https://example.test/a' }), after: vworld({ url: 'https://example.test/b' }), facts: {} });
  assert.deepEqual(navigated, { ok: true, verificationKind: 'navigation', detail: 'https://example.test/a -> https://example.test/b' });

  const same = await evaluateEffect({ url_changed: true }, { action: { type: 'CLICK' }, before: vworld({ url: 'https://example.test/a' }), after: vworld({ url: 'https://example.test/a' }), facts: {} });
  assert.deepEqual(same, { ok: false, verificationKind: 'navigation', detail: 'URL unchanged (https://example.test/a)' });

  const detached = await evaluateEffect({ navigation: true }, { action: { type: 'CLICK' }, before: vworld({ url: 'https://example.test/a' }), after: vworld({ url: null }), facts: {} });
  assert.deepEqual(detached, { ok: null, verificationKind: 'navigation', detail: 'no page is attached' });

  const noWorld = await evaluateEffect({ navigation: true }, { action: { type: 'CLICK' }, before: null, after: null, facts: {} });
  assert.deepEqual(noWorld, { ok: null, verificationKind: 'navigation', detail: 'no comparable URL' });

  const matches = await evaluateEffect({ url_matches: 'EXAMPLE.test/B' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ url: 'https://example.test/b' }), facts: {} });
  assert.deepEqual(matches, { ok: true, verificationKind: 'navigation', detail: 'url matches EXAMPLE.test/B' });

  const doesNotMatch = await evaluateEffect({ url_matches: 'nope' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ url: 'https://example.test/b' }), facts: {} });
  assert.deepEqual(doesNotMatch, { ok: false, verificationKind: 'navigation', detail: 'url https://example.test/b does not match nope' });

  const noUrl = await evaluateEffect({ url_matches: 'nope' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ url: null }), facts: {} });
  assert.deepEqual(noUrl, { ok: null, verificationKind: 'navigation', detail: 'no page is attached' });
});

test('effect: toast and text_appears read controls, the accessibility tree, then the DOM', async () => {
  const control = { ref: 'c-9', role: 'button', name: 'File Saved' };
  const viaControl = await evaluateEffect({ toast: 'file saved' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ controls: [control] }), facts: {} });
  assert.deepEqual(viaControl, { ok: true, verificationKind: 'direct', detail: 'text visible: file saved' });

  const viaAx = await evaluateEffect({ text_appears: 'saved' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ ax: [{ role: 'status', name: 'Saved' }] }), facts: {} });
  assert.deepEqual(viaAx, { ok: true, verificationKind: 'direct', detail: 'text appeared: saved' });

  const viaDom = await evaluateEffect(
    { toast: 'saved', selector: '#toast' },
    { action: { type: 'CLICK' }, before: vworld(), after: vworld({ controls: [], ax: [] }), facts: { domText: (selector) => (selector === '#toast' ? 'Changes SAVED' : null) } },
  );
  assert.deepEqual(viaDom, { ok: true, verificationKind: 'direct', detail: 'text visible: saved' });

  // The DOM hook is asked with `body` when the effect names no selector.
  let asked = null;
  await evaluateEffect({ toast: 'saved' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld(), facts: { domText: (selector) => { asked = selector; return 'nothing'; } } });
  assert.equal(asked, 'body');

  const notVisible = await evaluateEffect({ toast: 'saved' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld(), facts: { domText: () => 'nothing here' } });
  assert.deepEqual(notVisible, { ok: false, verificationKind: 'direct', detail: 'text not visible: saved' });

  const didNotAppear = await evaluateEffect({ text_appears: 'saved' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ controls: [{ ref: 'c-1', name: 'Save' }] }), facts: {} });
  assert.deepEqual(didNotAppear, { ok: false, verificationKind: 'direct', detail: 'text did not appear: saved' });

  const blind = await evaluateEffect({ toast: 'saved' }, { action: { type: 'CLICK' }, before: vworld(), after: null, facts: {} });
  assert.deepEqual(blind, { ok: null, verificationKind: 'direct', detail: 'no observation to read' });

  // PRESERVED DONOR QUIRK: with no DOM hook and no readable world the answer is
  // `false` (not unknown), because a world object was supplied.
  const emptyWorld = await evaluateEffect({ toast: 'saved' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld(), facts: {} });
  assert.deepEqual(emptyWorld, { ok: false, verificationKind: 'direct', detail: 'text not visible: saved' });
});

test('effect: text_disappears is ok when the text is gone, failed while it is visible', async () => {
  const gone = await evaluateEffect({ text_disappears: 'saving' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ controls: [{ ref: 'c-1', name: 'Save' }] }), facts: {} });
  assert.deepEqual(gone, { ok: true, verificationKind: 'direct', detail: 'text disappeared: saving' });

  const stillThere = await evaluateEffect({ text_disappears: 'saving' }, { action: { type: 'CLICK' }, before: vworld(), after: vworld({ controls: [{ ref: 'c-1', name: 'Saving…' }] }), facts: {} });
  assert.deepEqual(stillThere, { ok: false, verificationKind: 'direct', detail: 'text still visible: saving' });

  const blind = await evaluateEffect({ text_disappears: 'saving' }, { action: { type: 'CLICK' }, before: vworld(), after: null, facts: {} });
  assert.deepEqual(blind, { ok: null, verificationKind: 'direct', detail: 'no observation to read' });
});

test('effect: control_state_changed compares the target control field by field', async () => {
  const target = { ref: 'c-1' };
  const changed = await evaluateEffect({ control_state_changed: true }, {
    action: { type: 'CLICK', target },
    before: vworld({ controls: [{ ref: 'c-1', value: 'a', checked: false }] }),
    after: vworld({ controls: [{ ref: 'c-1', value: 'b', checked: false }] }),
    facts: {},
  });
  assert.deepEqual(changed, { ok: true, verificationKind: 'state', detail: 'the target control changed state' });

  const unchanged = await evaluateEffect({ control_state_changed: true }, {
    action: { type: 'CLICK', target },
    before: vworld({ controls: [{ ref: 'c-1', value: 'a' }] }),
    after: vworld({ controls: [{ ref: 'c-1', value: 'a' }] }),
    facts: {},
  });
  assert.deepEqual(unchanged, { ok: false, verificationKind: 'state', detail: 'the target control did not change state' });

  // A `checked` flip is a change too.
  const flipped = await evaluateEffect({ control_state_changed: true }, {
    action: { type: 'CLICK', target },
    before: vworld({ controls: [{ ref: 'c-1', checked: false }] }),
    after: vworld({ controls: [{ ref: 'c-1', checked: true }] }),
    facts: {},
  });
  assert.equal(flipped.ok, true);

  const notComparable = await evaluateEffect({ control_state_changed: true }, {
    action: { type: 'CLICK', target },
    before: vworld({ controls: [{ ref: 'c-1' }] }),
    after: vworld({ controls: [{ ref: 'c-2' }] }),
    facts: {},
  });
  assert.deepEqual(notComparable, { ok: null, verificationKind: 'state', detail: 'the target could not be compared' });
});

test('effect: value_equals prefers the focused element value, then the target control value', async () => {
  const target = { ref: 'c-1' };
  const focused = await evaluateEffect({ value_equals: 'typed' }, { action: { type: 'TYPE', target }, before: vworld(), after: vworld({ focusedElement: { ref: 'c-1', value: 'typed' } }), facts: {} });
  assert.deepEqual(focused, { ok: true, verificationKind: 'state', detail: 'value is typed' });

  const fromControl = await evaluateEffect({ value_equals: 12 }, { action: { type: 'TYPE', target }, before: vworld(), after: vworld({ controls: [{ ref: 'c-1', value: 12 }] }), facts: {} });
  assert.deepEqual(fromControl, { ok: true, verificationKind: 'state', detail: 'value is 12' });

  const wrong = await evaluateEffect({ value_equals: 12 }, { action: { type: 'TYPE', target }, before: vworld(), after: vworld({ controls: [{ ref: 'c-1', value: 13 }] }), facts: {} });
  assert.deepEqual(wrong, { ok: false, verificationKind: 'state', detail: 'value is 13, expected 12' });

  const noValue = await evaluateEffect({ value_equals: 'x' }, { action: { type: 'TYPE', target }, before: vworld(), after: vworld({ controls: [{ ref: 'c-1' }] }), facts: {} });
  assert.deepEqual(noValue, { ok: null, verificationKind: 'state', detail: 'no value could be read' });

  // A focused element with `value: undefined` falls back to the control lookup.
  const fallback = await evaluateEffect({ value_equals: 'control' }, { action: { type: 'TYPE', target }, before: vworld(), after: vworld({ focusedElement: { ref: 'c-1' }, controls: [{ ref: 'c-1', value: 'control' }] }), facts: {} });
  assert.equal(fallback.ok, true);

  const nullValue = await evaluateEffect({ value_equals: 'x' }, { action: { type: 'TYPE', target }, before: vworld(), after: vworld({ focusedElement: { ref: 'c-1', value: null } }), facts: {} });
  assert.equal(nullValue.ok, null);
});

test('effect: checked_equals reads the checkbox state and is unknown without one', async () => {
  const target = { ref: 'c-1' };
  const yes = await evaluateEffect({ checked_equals: true }, { action: { type: 'CLICK', target }, before: vworld(), after: vworld({ controls: [{ ref: 'c-1', checked: 1 }] }), facts: {} });
  assert.deepEqual(yes, { ok: true, verificationKind: 'state', detail: 'checked=true' });

  const no = await evaluateEffect({ checked_equals: false }, { action: { type: 'CLICK', target }, before: vworld(), after: vworld({ controls: [{ ref: 'c-1', checked: true }] }), facts: {} });
  assert.deepEqual(no, { ok: false, verificationKind: 'state', detail: 'checked=true' });

  const missing = await evaluateEffect({ checked_equals: true }, { action: { type: 'CLICK', target }, before: vworld(), after: vworld({ controls: [{ ref: 'c-1' }] }), facts: {} });
  assert.deepEqual(missing, { ok: null, verificationKind: 'state', detail: 'no checkbox state could be read' });

  const noControl = await evaluateEffect({ checked_equals: true }, { action: { type: 'CLICK', target }, before: vworld(), after: vworld(), facts: {} });
  assert.equal(noControl.ok, null);
});

test('effect: focus_changed and window_changed compare the two observations', async () => {
  const focusMoved = await evaluateEffect({ focus_changed: true }, { action: { type: 'CLICK' }, before: vworld({ focusedRef: 'c-1' }), after: vworld({ focusedRef: 'c-2' }), facts: {} });
  assert.deepEqual(focusMoved, { ok: true, verificationKind: 'focus', detail: 'focus c-1 -> c-2' });

  const focusSame = await evaluateEffect({ focus_changed: true }, { action: { type: 'CLICK' }, before: vworld({ focusedRef: 'c-1' }), after: vworld({ focusedRef: 'c-1' }), facts: {} });
  assert.deepEqual(focusSame, { ok: false, verificationKind: 'focus', detail: 'focus unchanged (c-1)' });

  const focusBlind = await evaluateEffect({ focus_changed: true }, { action: { type: 'CLICK' }, before: vworld(), after: null, facts: {} });
  assert.deepEqual(focusBlind, { ok: null, verificationKind: 'focus', detail: 'no comparable focus state' });

  const windowMoved = await evaluateEffect({ window_changed: true }, { action: { type: 'CLICK' }, before: vworld({ activeWindow: 'A', activeWindowHandle: '1' }), after: vworld({ activeWindow: 'B', activeWindowHandle: '2' }), facts: {} });
  assert.deepEqual(windowMoved, { ok: true, verificationKind: 'state', detail: 'window A -> B' });

  const windowSame = await evaluateEffect({ window_changed: true }, { action: { type: 'CLICK' }, before: vworld({ activeWindowHandle: '1' }), after: vworld({ activeWindowHandle: '1' }), facts: {} });
  assert.deepEqual(windowSame, { ok: false, verificationKind: 'state', detail: 'the active window did not change' });

  const windowBlind = await evaluateEffect({ window_changed: true }, { action: { type: 'CLICK' }, before: null, after: vworld(), facts: {} });
  assert.deepEqual(windowBlind, { ok: null, verificationKind: 'state', detail: 'no comparable window state' });
});

test('effect: file facts are unknown without the controller and otherwise answered', async () => {
  const context = (facts, before = vworld(), action = { type: 'FILE_WRITE', params: { path: '/tmp/out.txt' } }) => ({ action, before, after: vworld(), facts });

  const noController = await evaluateEffect({ file_created: '/tmp/out.txt' }, context({}));
  assert.deepEqual(noController, { ok: null, verificationKind: 'file', detail: 'the file controller is unavailable' });
  const noMissingController = await evaluateEffect({ file_missing: '/tmp/out.txt' }, context({}));
  assert.equal(noMissingController.detail, 'the file controller is unavailable');
  const noModifiedController = await evaluateEffect({ file_modified: '/tmp/out.txt' }, context({}));
  assert.equal(noModifiedController.detail, 'the file controller is unavailable');

  const created = await evaluateEffect({ file_created: '/tmp/out.txt' }, context({ fileExists: async () => true }));
  assert.deepEqual(created, { ok: true, verificationKind: 'file', detail: 'file exists: /tmp/out.txt' });
  const missing = await evaluateEffect({ file_exists: '/tmp/out.txt' }, context({ fileExists: async () => false }));
  assert.deepEqual(missing, { ok: false, verificationKind: 'file', detail: 'file missing: /tmp/out.txt' });

  const gone = await evaluateEffect({ file_missing: '/tmp/out.txt' }, context({ fileExists: async () => false }));
  assert.deepEqual(gone, { ok: true, verificationKind: 'file', detail: 'file is gone: /tmp/out.txt' });
  const stillThere = await evaluateEffect({ file_missing: '/tmp/out.txt' }, context({ fileExists: async () => true }));
  assert.deepEqual(stillThere, { ok: false, verificationKind: 'file', detail: 'file still exists: /tmp/out.txt' });

  // file_modified: true takes the path from the action, and the baseline from
  // the pre-action observation's capturedAt.
  let seenSince = null;
  const modified = await evaluateEffect({ file_modified: true }, context({ fileModifiedSince: async (_path, since) => { seenSince = since; return true; } }, vworld({ capturedAt: 1234 })));
  assert.deepEqual(modified, { ok: true, verificationKind: 'file', detail: 'file was modified: /tmp/out.txt' });
  assert.equal(seenSince, 1234);

  const explicitSince = await evaluateEffect({ file_modified: '/tmp/out.txt', since: 99 }, context({ fileModifiedSince: async () => true }));
  assert.equal(explicitSince.ok, true);

  const notModified = await evaluateEffect({ file_modified: '/tmp/out.txt' }, context({ fileModifiedSince: async () => false }));
  assert.deepEqual(notModified, { ok: false, verificationKind: 'file', detail: 'file was not modified: /tmp/out.txt' });

  const noPath = await evaluateEffect({ file_modified: true }, context({ fileModifiedSince: async () => true }, vworld(), { type: 'FILE_WRITE', params: {} }));
  assert.deepEqual(noPath, { ok: null, verificationKind: 'file', detail: 'no path was given for the file_modified expectation' });

  const noMtime = await evaluateEffect({ file_modified: '/tmp/out.txt' }, context({ fileModifiedSince: async () => null }));
  assert.deepEqual(noMtime, { ok: null, verificationKind: 'file', detail: 'no file mtime could be read' });
});

test('effect: process facts read the recorded shell result', async () => {
  const context = (facts) => ({ action: { type: 'SHELL_EXEC' }, before: vworld(), after: vworld(), facts });

  const noShell = await evaluateEffect({ process_exited: true }, context({}));
  assert.deepEqual(noShell, { ok: null, verificationKind: 'process', detail: 'no shell result has been recorded' });
  const noExitCode = await evaluateEffect({ exit_code: 0 }, context({}));
  assert.deepEqual(noExitCode, { ok: null, verificationKind: 'process', detail: 'no exit code has been recorded' });
  const noExitCodeField = await evaluateEffect({ exit_code: 0 }, context({ lastShell: { exited: true } }));
  assert.equal(noExitCodeField.ok, null);
  const noOutput = await evaluateEffect({ stdout_matches: 'ok' }, context({}));
  assert.equal(noOutput.detail, 'no shell result has been recorded');
  const noCaptured = await evaluateEffect({ stderr_matches: 'ok' }, context({ lastShell: { stderr: null } }));
  assert.deepEqual(noCaptured, { ok: null, verificationKind: 'process', detail: 'no captured output' });

  const exited = await evaluateEffect({ process_exited: true }, context({ lastShell: { exited: true, exitCode: 0 } }));
  assert.deepEqual(exited, { ok: true, verificationKind: 'process', detail: 'process exited with 0' });
  const running = await evaluateEffect({ process_exited: true }, context({ lastShell: { exited: false } }));
  assert.deepEqual(running, { ok: false, verificationKind: 'process', detail: 'the process has not exited' });

  const code = await evaluateEffect({ exit_code: 2 }, context({ lastShell: { exitCode: 2 } }));
  assert.deepEqual(code, { ok: true, verificationKind: 'process', detail: 'exit code 2' });
  const wrongCode = await evaluateEffect({ exit_code: 2 }, context({ lastShell: { exitCode: 1 } }));
  assert.deepEqual(wrongCode, { ok: false, verificationKind: 'process', detail: 'exit code 1, expected 2' });

  const stdout = await evaluateEffect({ stdout_matches: 'DONE' }, context({ lastShell: { stdout: 'all Done here' } }));
  assert.deepEqual(stdout, { ok: true, verificationKind: 'process', detail: 'output matches DONE' });
  const stderr = await evaluateEffect({ stderr_matches: 'warn' }, context({ lastShell: { stderr: 'a WARNING appeared' } }));
  assert.equal(stderr.ok, true);
  const noMatch = await evaluateEffect({ stdout_matches: 'done' }, context({ lastShell: { stdout: 'nope' } }));
  assert.deepEqual(noMatch, { ok: false, verificationKind: 'process', detail: 'output does not match done' });
});

test('effect: visual_change needs the vision controller and can answer unknown', async () => {
  const context = (facts) => ({ action: { type: 'SCREENSHOT_REGION' }, before: vworld(), after: vworld(), facts });

  const unavailable = await evaluateEffect({ visual_change: true }, context({}));
  assert.deepEqual(unavailable, { ok: null, verificationKind: 'visual', detail: 'the vision controller is unavailable' });

  const changed = await evaluateEffect({ visual_change: true }, context({ visualChange: async () => true }));
  assert.deepEqual(changed, { ok: true, verificationKind: 'visual', detail: 'the observed region changed' });
  const unchanged = await evaluateEffect({ visual_change: true }, context({ visualChange: async () => false }));
  assert.deepEqual(unchanged, { ok: false, verificationKind: 'visual', detail: 'the observed region is unchanged' });
  const incomparable = await evaluateEffect({ visual_change: true }, context({ visualChange: async () => null }));
  assert.deepEqual(incomparable, { ok: null, verificationKind: 'visual', detail: 'no visual comparison was possible' });
});

test('findControl resolves a target by ref, selector, semantic text or accessibility name', async () => {
  const control = { ref: 'c-1', selector: '#save', name: 'Save File' };
  const axNode = { ref: 'ax-1', name: 'Accessible Save' };
  const world = vworld({ controls: [control], ax: [axNode] });
  assert.deepEqual(findControl(world, { target: { ref: 'c-1' } }), control);
  assert.deepEqual(findControl(world, { target: { selector: '#save' } }), control);
  assert.deepEqual(findControl(world, { target: { semantic: { text: 'save file' } } }), control);
  assert.deepEqual(findControl(world, { target: { accessibility: { name: 'accessible' } } }), axNode);
  // The control pool is searched first, so a control whose name merely contains
  // the accessible name wins over the accessibility node.
  assert.deepEqual(findControl(world, { target: { accessibility: { name: 'save' } } }), control);
  // With no matching control the accessibility tree answers.
  const axOnly = vworld({ controls: [], ax: [axNode] });
  assert.deepEqual(findControl(axOnly, { target: { accessibility: { name: 'accessible save' } } }), axNode);
  assert.equal(findControl(world, { target: { ref: 'nope' } }), null);
  assert.equal(findControl(world, { target: {} }), null);
  assert.equal(findControl(world, {}), null);
  assert.equal(findControl(null, { target: { ref: 'c-1' } }), null);
});

test('PRESERVED DONOR DEFECT: targetPresent only answers null when the world has no controls AND no ax array', async () => {
  const world = vworld({ controls: [{ ref: 'c-1' }], ax: [] });
  assert.equal(targetPresent(world, { target: { ref: 'c-1' } }), true);
  assert.equal(targetPresent(world, { target: { ref: 'c-2' } }), false);
  assert.equal(targetPresent(world, {}), null);
  assert.equal(targetPresent(null, { target: { ref: 'c-1' } }), null);
  // An empty `controls` array is truthy, so this is `false`, not `null`.
  assert.equal(targetPresent(vworld({ controls: [], ax: [] }), { target: { ref: 'c-1' } }), false);
  // Only a world that carries neither array reaches the donor's null return.
  assert.equal(targetPresent({ signature: 'x' }, { target: { ref: 'c-1' } }), null);
  // And a world carrying only `ax` clears the guard even with no controls field.
  assert.equal(targetPresent({ ax: [] }, { target: { ref: 'c-1' } }), false);
});

test('verifyFactsFrom digests the state with the same evidence digest', async () => {
  const state = vworld({ revision: 11, signature: 'sig-a' });
  assert.deepEqual(verifyFactsFrom(state), verifyFactsFrom(state));
  assert.equal(verifyFactsFrom(state).worldDigest, evidenceDigest(state));
  assert.notEqual(verifyFactsFrom(state).worldDigest, verifyFactsFrom(vworld({ revision: 12, signature: 'sig-a' })).worldDigest);
  assert.deepEqual(verifyFactsFrom(null), { worldDigest: null });
  assert.match(verifyFactsFrom(state).worldDigest, /^[0-9a-f]{16}$/);
});

test('the verdict is always one of exactly three values and every call is deterministic', async () => {
  const cases = [
    { action: actionWithAny([{ url_matches: 'example' }]), before: vworld(), after: vworld({ url: 'https://example.test/x' }) },
    { action: actionWithAny([{ url_matches: 'example' }]), before: vworld(), after: vworld({ url: 'https://example.test/y' }) },
    { action: actionWithAny([{ url_matches: 'example' }]), before: null, after: null },
    { action: { type: 'CLICK', expectedEffect: { all: [] } }, before: vworld(), after: vworld() },
  ];
  for (const input of cases) {
    const first = await verifier().verify(input);
    const second = await verifier().verify(input);
    assert.ok(Object.values(VERDICTS).includes(first.verdict), `verdict must be success/failure/unknown, got ${first.verdict}`);
    assert.deepEqual(first, second, 'two identical verifications must produce the same result');
    assert.equal(first.checkedAt, PINNED_AT);
  }
});

test('the injected clock is the only source of checkedAt', async () => {
  const first = await steppingVerifier().verify({ action: { type: 'CLICK' }, before: vworld(), after: vworld() });
  assert.equal(first.checkedAt, PINNED_AT + 5);
  const withClock = createVerifier({ clock: pinnedClock(42) });
  const result = await withClock.verify({ action: { type: 'CLICK' }, before: vworld(), after: vworld() });
  assert.equal(result.checkedAt, 42);

  // No clock injected: the port records null rather than reading the wall clock.
  const noClock = await createVerifier().verify({ action: { type: 'CLICK' }, before: vworld(), after: vworld() });
  assert.equal(noClock.checkedAt, null);
});
