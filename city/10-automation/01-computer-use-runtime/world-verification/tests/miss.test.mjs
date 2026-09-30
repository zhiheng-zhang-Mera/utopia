/**
 * UTOPIA · 10-automation / Computer Use Runtime — miss detection suite.
 *
 * Restates DS-Hns `app/computer-use/miss.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: every signal, the order signals are
 * collected in, the soft/conditional/hard ladder that decides whether a signal
 * can carry a miss, and the donor's defects. The evidence digest is injected so
 * "did the evidence move?" is decided by a pinned digest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PINNED_HASH, vworld } from './fixtures.mjs';
import { MISS_SIGNALS, detectMiss } from '../miss.mjs';
import { evidenceDigest } from '../world-state.mjs';

const OPTIONS = { hash: PINNED_HASH };

/** Two worlds that differ in nothing at all, including their evidence digest. */
function sameWorld(overrides = {}) {
  return [vworld(overrides), vworld(overrides)];
}

test('MISS_SIGNALS is the donor list, in the donor order, frozen', () => {
  assert.deepEqual([...MISS_SIGNALS], [
    'no_state_change',
    'focus_unchanged',
    'control_state_unchanged',
    'expected_event_missing',
    'visual_identical',
    'active_element_unchanged',
    'controller_reported_noop',
  ]);
  assert.equal(Object.isFrozen(MISS_SIGNALS), true);
  assert.throws(() => { MISS_SIGNALS.push('nope'); }, TypeError);
});

test('PRESERVED DONOR DEFECT: a missing observation returns a `no_observation` signal that is not in MISS_SIGNALS', async () => {
  const report = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: null }, OPTIONS);
  assert.deepEqual(report, {
    missed: false,
    confidence: 'unknown',
    signals: ['no_observation'],
    details: { reason: 'the world state could not be observed after the action' },
  });
  // The signal the donor reports here is outside its own closed vocabulary.
  assert.equal(MISS_SIGNALS.includes('no_observation'), false);
  assert.equal(MISS_SIGNALS.includes(report.signals[0]), false);
});

test('controller_reported_noop comes from a failed, retryable receipt or an explicit controller miss', async () => {
  const [before, after] = sameWorld();

  const retryable = detectMiss({ action: { type: 'CLICK' }, before, after, receipt: { ok: false, retryable: true } }, OPTIONS);
  assert.equal(retryable.signals.includes('controller_reported_noop'), true);

  const notRetryable = detectMiss({ action: { type: 'CLICK' }, before, after: vworld() , receipt: { ok: false, retryable: false } }, OPTIONS);
  assert.equal(notRetryable.signals.includes('controller_reported_noop'), false);

  const silentNoChange = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), receipt: { changed: false, silent: true } }, OPTIONS);
  assert.equal(silentNoChange.signals.includes('controller_reported_noop'), true);

  const loudNoChange = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), receipt: { changed: false, silent: false } }, OPTIONS);
  assert.equal(loudNoChange.signals.includes('controller_reported_noop'), false);

  const missed = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), receipt: { missed: true, detail: 'overlay swallowed the click' } }, OPTIONS);
  assert.equal(missed.signals.includes('controller_reported_noop'), true);
  assert.equal(missed.details.controllerMiss, 'overlay swallowed the click');

  const missedNoDetail = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), receipt: { missed: true } }, OPTIONS);
  assert.equal(missedNoDetail.details.controllerMiss, true);
});

test('no_state_change is raised when nothing meaningful moved and the evidence did not move either', async () => {
  const report = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld() }, OPTIONS);
  assert.equal(report.missed, true);
  assert.deepEqual(report.signals, ['no_state_change']);
  assert.deepEqual(report.details.unchangedFields, []);
  assert.equal(report.confidence, 'medium');

  // The same test with the donor's own default digest: still a miss.
  const donorDigest = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld() });
  assert.deepEqual(donorDigest.signals, ['no_state_change']);

  // A meaningful field changed: not a miss, and no signal at all.
  const moved = detectMiss({ action: { type: 'CLICK' }, before: vworld({ url: 'https://example.test/a' }), after: vworld({ url: 'https://example.test/b' }) }, OPTIONS);
  assert.deepEqual(moved, { missed: false, confidence: 'low', signals: [], details: {} });
  assert.equal(moved.details.unchangedFields, undefined);
});

test('evidence that moved suppresses no_state_change even when no meaningful field did', async () => {
  const report = detectMiss({ action: { type: 'CLICK' }, before: vworld({ revision: 5, signature: 'sig' }), after: vworld({ revision: 6, signature: 'sig' }) }, OPTIONS);
  assert.deepEqual(report, { missed: false, confidence: 'low', signals: [], details: {} });
  // The digest is what moved.
  assert.notEqual(evidenceDigest(vworld({ revision: 5, signature: 'sig' }), OPTIONS), evidenceDigest(vworld({ revision: 6, signature: 'sig' }), OPTIONS));
});

test('a failed verification contributes expected_event_missing, focus_unchanged and control_state_unchanged', async () => {
  const [before, after] = sameWorld();
  const verification = {
    verdict: 'failure',
    kind: 'event',
    checkedAt: 0,
    evidence: [
      { kind: 'world-change', ok: false, detail: [] },
      { ok: false, verificationKind: 'event', detail: 'event not observed: window_changed' },
      { ok: false, verificationKind: 'focus', detail: 'focus unchanged (null)' },
      { ok: false, verificationKind: 'state', detail: 'the target control did not change state' },
    ],
  };
  const report = detectMiss({ action: { type: 'CLICK' }, before, after, verification }, OPTIONS);
  assert.deepEqual(report.signals, ['no_state_change', 'expected_event_missing', 'focus_unchanged', 'control_state_unchanged']);
  assert.equal(report.missed, true);
  assert.equal(report.confidence, 'high');

  // A successful verification can never produce a miss.
  const success = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), verification: { verdict: 'success', evidence: [{ ok: false, verificationKind: 'event' }] } }, OPTIONS);
  assert.equal(success.missed, false);
  assert.deepEqual(success.signals, ['no_state_change']);
  assert.equal(success.confidence, 'medium');

  // An `unknown` verdict is not a failure verdict, so it contributes nothing.
  const unknown = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), verification: { verdict: 'unknown', evidence: [{ ok: false, verificationKind: 'event' }] } }, OPTIONS);
  assert.deepEqual(unknown.signals, ['no_state_change']);

  // Only a false entry of the matching kind counts.
  const trueEntries = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), verification: { verdict: 'failure', evidence: [{ ok: true, verificationKind: 'event' }, { ok: null, verificationKind: 'focus' }, null] } }, OPTIONS);
  assert.deepEqual(trueEntries.signals, ['no_state_change']);

  // The world-change entry only adds no_state_change when it is absent.
  const withoutWorldChange = detectMiss({ action: { type: 'CLICK' }, before: vworld({ url: 'a' }), after: vworld({ url: 'b' }), verification: { verdict: 'failure', evidence: [{ kind: 'world-change', ok: false }] } }, OPTIONS);
  assert.deepEqual(withoutWorldChange.signals, ['no_state_change']);

  // No evidence array at all is tolerated.
  const noEvidence = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), verification: { verdict: 'failure' } }, OPTIONS);
  assert.deepEqual(noEvidence.signals, ['no_state_change']);
});

test('focus_unchanged also comes from a focus action that left the focused ref alone', async () => {
  const focus = detectMiss({ action: { type: 'FOCUS' }, before: vworld({ focusedRef: 'c-1', url: 'a' }), after: vworld({ focusedRef: 'c-1', url: 'b' }) }, OPTIONS);
  assert.deepEqual(focus.signals, ['focus_unchanged']);
  assert.equal(focus.missed, true);
  assert.equal(focus.confidence, 'medium');

  const select = detectMiss({ action: { type: 'SELECT' }, before: vworld({ focusedRef: 'c-1', url: 'a' }), after: vworld({ focusedRef: 'c-1', url: 'b' }) }, OPTIONS);
  assert.deepEqual(select.signals, ['focus_unchanged']);

  // The focus did move: no signal.
  const moved = detectMiss({ action: { type: 'FOCUS' }, before: vworld({ focusedRef: 'c-1', url: 'a' }), after: vworld({ focusedRef: 'c-2', url: 'b' }) }, OPTIONS);
  assert.deepEqual(moved, { missed: false, confidence: 'low', signals: [], details: {} });

  // A non-focus action does not raise it.
  const click = detectMiss({ action: { type: 'CLICK' }, before: vworld({ focusedRef: 'c-1', url: 'a' }), after: vworld({ focusedRef: 'c-1', url: 'b' }) }, OPTIONS);
  assert.deepEqual(click.signals, []);
});

test('active_element_unchanged is raised for a typing action and is too soft to carry a miss on its own', async () => {
  const typing = (type) => detectMiss({ action: { type }, before: vworld({ focusedRef: 'c-1', url: 'a' }), after: vworld({ focusedRef: 'c-1', url: 'b' }) }, OPTIONS);

  for (const type of ['TYPE', 'DOM_TYPE', 'ACCESSIBILITY_SET_VALUE', 'KEY_PRESS', 'HOTKEY']) {
    const report = typing(type);
    assert.deepEqual(report.signals, ['active_element_unchanged'], `${type} must raise active_element_unchanged`);
    assert.equal(report.missed, false, `${type}: a stuck active element is a hint, never a verdict`);
    assert.equal(report.confidence, 'medium');
  }

  // A non-typing action does not raise it.
  const click = typing('CLICK');
  assert.deepEqual(click.signals, []);

  // It is dropped from the `hard` set but still listed in `signals`.
  const withHardSignal = detectMiss({
    action: { type: 'TYPE' },
    before: vworld({ focusedRef: 'c-1' }),
    after: vworld({ focusedRef: 'c-1' }),
    receipt: { ok: false, retryable: true },
  }, OPTIONS);
  assert.deepEqual(withHardSignal.signals, ['controller_reported_noop', 'no_state_change', 'active_element_unchanged']);
  assert.equal(withHardSignal.missed, true);
  assert.equal(withHardSignal.confidence, 'high');
});

test('visual_identical only carries a miss when the evidence did not move', async () => {
  const [before, after] = sameWorld();
  const identical = detectMiss({ action: { type: 'CLICK' }, before, after, visualDigestBefore: 'v1', visualDigestAfter: 'v1' }, OPTIONS);
  // The unchanged world supplies no_state_change as well, and both are hard
  // (the conditional visual signal qualifies because the evidence did not move).
  assert.deepEqual(identical.signals, ['no_state_change', 'visual_identical']);
  assert.equal(identical.missed, true);
  assert.equal(identical.confidence, 'high');

  // The evidence moved (DOM revision), so the conditional signal is dropped —
  // and the moved evidence also suppresses no_state_change.
  const moved = detectMiss({
    action: { type: 'CLICK' },
    before: vworld({ revision: 5, signature: 'sig' }),
    after: vworld({ revision: 6, signature: 'sig' }),
    visualDigestBefore: 'v1',
    visualDigestAfter: 'v1',
  }, OPTIONS);
  assert.deepEqual(moved.signals, ['visual_identical']);
  assert.equal(moved.missed, false, 'an identical screenshot is only evidence of a miss when nothing else moved either');
  assert.equal(moved.confidence, 'medium');

  // Different digests raise nothing of their own — the unchanged world still
  // supplies no_state_change.
  const different = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), visualDigestBefore: 'v1', visualDigestAfter: 'v2' }, OPTIONS);
  assert.deepEqual(different.signals, ['no_state_change']);
  assert.equal(different.missed, true);
  assert.equal(different.confidence, 'medium');

  // Only one side supplied: no comparison is attempted, and `visual_identical`
  // is not raised.
  const half = detectMiss({ action: { type: 'CLICK' }, before: vworld(), after: vworld(), visualDigestBefore: 'v1', visualDigestAfter: null }, OPTIONS);
  assert.deepEqual(half.signals, ['no_state_change']);
  assert.equal(half.signals.includes('visual_identical'), false);
});

test('the confidence ladder is low for no signal, medium for one and high for more', async () => {
  const low = detectMiss({ action: { type: 'CLICK' }, before: vworld({ url: 'a' }), after: vworld({ url: 'b' }) }, OPTIONS);
  assert.equal(low.confidence, 'low');
  assert.deepEqual(low.signals, []);

  const medium = detectMiss({ action: { type: 'FOCUS' }, before: vworld({ focusedRef: 'c-1', url: 'a' }), after: vworld({ focusedRef: 'c-1', url: 'b' }) }, OPTIONS);
  assert.equal(medium.confidence, 'medium');

  const high = detectMiss({
    action: { type: 'FOCUS' },
    before: vworld({ focusedRef: 'c-1' }),
    after: vworld({ focusedRef: 'c-1' }),
    receipt: { missed: true },
  }, OPTIONS);
  assert.equal(high.confidence, 'high');
  assert.deepEqual(high.signals, ['controller_reported_noop', 'no_state_change', 'focus_unchanged']);
  assert.equal(high.missed, true);
});

test('signals are reported once each, in the donor order', async () => {
  // Every source is made to fire at once: a no-op receipt, an unchanged world, a
  // failed verification naming all three kinds, a focus action on the same ref,
  // a typing action on the same ref and an identical screenshot.
  const report = detectMiss({
    action: { type: 'TYPE' },
    before: vworld({ focusedRef: 'c-1' }),
    after: vworld({ focusedRef: 'c-1' }),
    receipt: { ok: false, retryable: true, missed: true, changed: false, silent: true },
    verification: {
      verdict: 'failure',
      evidence: [
        { kind: 'world-change', ok: false },
        { ok: false, verificationKind: 'event' },
        { ok: false, verificationKind: 'focus' },
        { ok: false, verificationKind: 'state' },
      ],
    },
    visualDigestBefore: 'v1',
    visualDigestAfter: 'v1',
  }, OPTIONS);

  assert.deepEqual(report.signals, [
    'controller_reported_noop',
    'no_state_change',
    'expected_event_missing',
    'focus_unchanged',
    'control_state_unchanged',
    'active_element_unchanged',
    'visual_identical',
  ]);
  assert.equal(report.missed, true);
  assert.equal(report.confidence, 'high');
  assert.equal(report.details.controllerMiss, true);
  assert.deepEqual(report.details.unchangedFields, []);
});

test('detectMiss is deterministic across two identical calls', async () => {
  const input = {
    action: { type: 'TYPE' },
    before: vworld({ focusedRef: 'c-1' }),
    after: vworld({ focusedRef: 'c-1' }),
    receipt: { missed: true, detail: 'swallowed' },
    visualDigestBefore: 'v1',
    visualDigestAfter: 'v1',
  };
  assert.deepEqual(detectMiss(input, OPTIONS), detectMiss(input, OPTIONS));
  assert.deepEqual(detectMiss(input), detectMiss(input));

  // The donor's own sha1 digest is the default, and it is not the injected one.
  const donorWorld = { signature: 'sig', revision: 1, systemEvents: [], focusedElement: null };
  const defaultDigest = evidenceDigest(donorWorld);
  assert.equal(defaultDigest, createHash('sha1').update('{"events":[],"revision":1,"signature":"sig","value":null}').digest('hex').slice(0, 16));
  assert.notEqual(evidenceDigest(donorWorld, OPTIONS), defaultDigest);
});
