/**
 * UTOPIA · 10-automation / Computer Use Runtime — progress heartbeat suite.
 *
 * Restates DS-Hns `app/computer-use/progress.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the five accepted kinds, every
 * refusal and its exact reason, the ring bound, the no-op streak, and the one
 * rule the module exists for — progress counts only verified effects. The clock
 * is injected, so every recorded instant is a pinned number.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PINNED_AT, PINNED_HASH, vworld } from './fixtures.mjs';
import {
  EVIDENCE_KINDS,
  PROGRESS_KINDS,
  PROGRESS_KIND_LIST,
  createProgressTracker,
} from '../progress.mjs';
import { createVerifier } from '../verification.mjs';

/** A tracker with a clock that reads the same instant every time. */
function tracker(options = {}) {
  return createProgressTracker({ now: () => PINNED_AT, ...options });
}

/** A tracker with a clock that advances on every read. */
function steppingTracker(step = 10, options = {}) {
  let at = PINNED_AT;
  return createProgressTracker({ now: () => { at += step; return at; }, ...options });
}

test('PROGRESS_KINDS, PROGRESS_KIND_LIST and EVIDENCE_KINDS are the donor vocabulary, frozen', async () => {
  assert.deepEqual(PROGRESS_KINDS, {
    VERIFIED_EFFECT: 'verified-effect',
    SUBPROCESS_EXIT: 'subprocess-exit',
    FILE_OPERATION: 'file-operation',
    STATE_TRANSITION: 'state-transition',
    CRITERIA_SATISFIED: 'criteria-satisfied',
  });
  assert.deepEqual([...PROGRESS_KIND_LIST], [
    'verified-effect',
    'subprocess-exit',
    'file-operation',
    'state-transition',
    'criteria-satisfied',
  ]);
  assert.deepEqual([...EVIDENCE_KINDS], ['file', 'process', 'navigation', 'state', 'focus', 'event', 'visual']);
  assert.equal(Object.isFrozen(PROGRESS_KINDS), true);
  assert.equal(Object.isFrozen(PROGRESS_KIND_LIST), true);
  assert.equal(Object.isFrozen(EVIDENCE_KINDS), true);
  assert.throws(() => { PROGRESS_KIND_LIST.push('nope'); }, TypeError);
  // The tracker hands the same frozen vocabulary back.
  assert.equal(tracker().PROGRESS_KINDS, PROGRESS_KINDS);
});

/**
 * Assert that a claim is refused: `progress()` returns null and nothing is
 * recorded — the ring, the last progress instant and the last progress record
 * are all untouched. `accept` is internal to the donor tracker, so every policy
 * assertion goes through the public surface.
 */
function assertRefused(t, kind, detail) {
  const before = t.history();
  const lastProgressAt = t.lastProgressAt;
  const lastProgress = t.status().lastProgress;
  assert.equal(t.progress(kind, detail), null);
  assert.deepEqual(t.history(), before);
  assert.equal(t.lastProgressAt, lastProgressAt);
  assert.equal(t.status().lastProgress, lastProgress);
}

test('verified-effect is accepted only on a success verdict whose evidence kind proves the effect landed', async () => {
  const t = tracker();

  for (const kind of EVIDENCE_KINDS) {
    const recorded = t.progress(PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'success', kind });
    assert.equal(recorded.kind, 'verified-effect');
    assert.equal(recorded.at, PINNED_AT);
    assert.equal(recorded.step, null);
    assert.deepEqual(recorded.detail, { verdict: 'success', kind });
  }

  // A "direct" world-change inference is deliberately excluded.
  assertRefused(t, PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'success', kind: 'direct' });
  assertRefused(t, PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'success', kind: 'none' });

  // Any verdict other than `success` is refused, including a missing one.
  assertRefused(t, PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'failure', kind: 'file' });
  assertRefused(t, PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'unknown', kind: 'file' });
  assertRefused(t, PROGRESS_KINDS.VERIFIED_EFFECT, { kind: 'file' });
  assertRefused(t, PROGRESS_KINDS.VERIFIED_EFFECT);

  // A missing evidence kind is accepted: only a *wrong* one is refused.
  assert.equal(t.progress(PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'success' }).kind, 'verified-effect');
});

test('PRESERVED DONOR DEFECT: the verified-effect claim reads `detail.kind`, never the verifier\'s `verificationKind`', async () => {
  const t = tracker();
  assert.equal(EVIDENCE_KINDS.includes('direct'), false);

  // The verifier labels its result `verificationKind`. Handing that result
  // straight to the tracker therefore checks the wrong field: `detail.kind` is
  // absent, no evidence kind is examined, and a `direct` world-change success —
  // exactly what the policy exists to refuse — is recorded as progress.
  const rawResult = { verdict: 'success', kind: undefined, verificationKind: 'direct', evidence: [] };
  assert.equal(t.progress(PROGRESS_KINDS.VERIFIED_EFFECT, rawResult).kind, 'verified-effect');

  // Conversely, the one field that *is* read must never say `direct`: the
  // natural way to pass a real verification result is refused.
  const naturalPass = { verdict: 'success', kind: 'direct', verificationKind: 'direct' };
  assertRefused(t, PROGRESS_KINDS.VERIFIED_EFFECT, naturalPass);

  // And the record keeps only the progress kind, never the evidence kind that
  // justified it, so a consumer cannot tell the two apart afterwards.
  const record = t.progress(PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'success', kind: 'file', verificationKind: 'direct' });
  assert.equal(record.kind, 'verified-effect');
  assert.equal(record.detail.kind, 'file');
  assert.equal(record.verificationKind, undefined);
});

test('an unknown progress kind is refused', async () => {
  const fresh = tracker();
  assertRefused(fresh, 'made-up');
  assertRefused(fresh, '');
  assertRefused(fresh, undefined);
  assertRefused(fresh, null);
  assertRefused(fresh, 42);
  // Nothing was recorded at all, so the tracker still reports no progress.
  assert.deepEqual(fresh.history(), []);
  assert.equal(fresh.hasProgress(), false);
  assert.equal(fresh.lastProgressAt, null);

  // The closed list is what refuses them: every listed kind is accepted with a
  // well-formed claim.
  const t = tracker();
  for (const kind of PROGRESS_KIND_LIST) {
    const detail = kind === PROGRESS_KINDS.VERIFIED_EFFECT
      ? { verdict: 'success', kind: 'file' }
      : kind === PROGRESS_KINDS.SUBPROCESS_EXIT
        ? { exited: true, exitCode: 0 }
        : kind === PROGRESS_KINDS.FILE_OPERATION
          ? { verified: true }
          : kind === PROGRESS_KINDS.STATE_TRANSITION
            ? { state: 'OBSERVING' }
            : { satisfied: true };
    assert.equal(t.progress(kind, detail).kind, kind);
  }
});

test('subprocess-exit needs an exit, and an exit without a code only counts when signalled', async () => {
  const t = tracker();

  assertRefused(t, PROGRESS_KINDS.SUBPROCESS_EXIT, { exited: false });
  assertRefused(t, PROGRESS_KINDS.SUBPROCESS_EXIT, { exited: true });
  assertRefused(t, PROGRESS_KINDS.SUBPROCESS_EXIT, { exited: true, exitCode: null });

  assert.equal(t.progress(PROGRESS_KINDS.SUBPROCESS_EXIT, { exited: true, exitCode: 0 }).kind, 'subprocess-exit');
  assert.equal(t.progress(PROGRESS_KINDS.SUBPROCESS_EXIT, { exited: true, signalled: true }).kind, 'subprocess-exit');
  // `exited` is only checked against `false`, so an absent flag is not a refusal.
  assert.equal(t.progress(PROGRESS_KINDS.SUBPROCESS_EXIT, { exitCode: 3 }).kind, 'subprocess-exit');
});

test('file-operation needs `verified: true`, and criteria-satisfied needs `satisfied: true`', async () => {
  const t = tracker();

  assertRefused(t, PROGRESS_KINDS.FILE_OPERATION, {});
  assertRefused(t, PROGRESS_KINDS.FILE_OPERATION, { verified: 'true' });
  assert.equal(t.progress(PROGRESS_KINDS.FILE_OPERATION, { verified: true, operation: 'write' }).kind, 'file-operation');
  assert.equal(t.progress(PROGRESS_KINDS.FILE_OPERATION, { verified: true }).kind, 'file-operation');

  assertRefused(t, PROGRESS_KINDS.CRITERIA_SATISFIED, {});
  assertRefused(t, PROGRESS_KINDS.CRITERIA_SATISFIED, { satisfied: 'yes' });
  assert.equal(t.progress(PROGRESS_KINDS.CRITERIA_SATISFIED, { satisfied: true, criterion: 'form saved' }).kind, 'criteria-satisfied');
  assert.equal(t.progress(PROGRESS_KINDS.CRITERIA_SATISFIED, { satisfied: true }).kind, 'criteria-satisfied');
});

test('state-transition needs a state, and refuses a state the run was already in', async () => {
  const t = tracker();

  assertRefused(t, PROGRESS_KINDS.STATE_TRANSITION, {});
  assertRefused(t, PROGRESS_KINDS.STATE_TRANSITION, { state: '' });
  assertRefused(t, PROGRESS_KINDS.STATE_TRANSITION, { state: 'VERIFYING', repeat: true });
  assert.equal(t.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'VERIFYING' }).kind, 'state-transition');
  assert.equal(t.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 42 }).kind, 'state-transition');
});

test('a heartbeat and an issued action are never progress; only progress() moves lastProgressAt', async () => {
  const t = steppingTracker();

  const first = t.heartbeat({ note: 'still here' });
  assert.equal(first.alive, true);
  assert.equal(first.at, PINNED_AT + 10);
  assert.equal(first.heartbeats, 1);
  assert.equal(first.lastProgressAt, null);
  assert.equal(first.lastActionAt, null);
  assert.equal(first.sinceProgressMs, null);
  assert.equal(first.note, 'still here');
  assert.equal(t.hasProgress(), false);

  const second = t.heartbeat();
  assert.equal(second.heartbeats, 2);
  assert.equal(second.at, PINNED_AT + 20);

  const issued = t.action({ step: 4 });
  assert.equal(issued.at, PINNED_AT + 30);
  assert.equal(issued.step, 4);
  assert.equal(t.hasProgress(), false, 'issuing an action is not progress');
  assert.equal(t.lastProgressAt, null);

  const recorded = t.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'OBSERVING' });
  assert.equal(recorded.at, PINNED_AT + 40);
  assert.equal(t.lastProgressAt, PINNED_AT + 40);
  assert.equal(t.hasProgress(), true);
  assert.deepEqual(t.history().map((entry) => entry.kind), ['state-transition']);

  // A heartbeat after progress reports the gap since it — and the read itself
  // advances the injected clock.
  const later = t.heartbeat();
  assert.equal(later.lastProgressAt, PINNED_AT + 40);
  assert.equal(later.at, PINNED_AT + 50);
  assert.equal(later.sinceProgressMs, PINNED_AT + 60 - (PINNED_AT + 40));
  assert.equal(later.heartbeats, 3);

  // An issued action moves only `lastActionAt`.
  t.action();
  assert.equal(t.lastProgressAt, PINNED_AT + 40);
});

test('status reports the stall-facing view, falling back to lastActionAt before any progress', async () => {
  const t = steppingTracker();

  assert.deepEqual(t.status(), {
    lastProgressAt: null,
    lastActionAt: null,
    lastVerifiedEffectAt: null,
    sinceProgressMs: null,
    sinceActionMs: null,
    sinceVerifiedEffectMs: null,
    noOpStreak: 0,
    heartbeats: 0,
    lastProgress: null,
  });

  t.action();
  // No progress yet: the stall window is measured from the last issued action
  // (and each clock read advances the injected clock).
  const afterAction = t.status();
  assert.equal(afterAction.lastActionAt, PINNED_AT + 20);
  assert.equal(afterAction.sinceProgressMs, PINNED_AT + 30 - (PINNED_AT + 20));
  assert.equal(afterAction.sinceActionMs, PINNED_AT + 30 - (PINNED_AT + 20));

  const recorded = t.progress(PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'success', kind: 'file', step: 2 });
  assert.equal(recorded.step, 2);
  const status = t.status();
  assert.equal(status.lastVerifiedEffectAt, PINNED_AT + 40);
  assert.equal(status.lastProgressAt, PINNED_AT + 40);
  assert.equal(status.sinceVerifiedEffectMs, PINNED_AT + 50 - (PINNED_AT + 40));
  assert.deepEqual(status.lastProgress, {
    kind: 'verified-effect',
    at: PINNED_AT + 40,
    detail: { verdict: 'success', kind: 'file', step: 2 },
  });

  // A non-verified kind does not move `lastVerifiedEffectAt`.
  t.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'ACTING' });
  assert.equal(t.status().lastVerifiedEffectAt, PINNED_AT + 40);
  assert.equal(t.status().lastProgressAt, PINNED_AT + 60);
});

test('noOp counts a repeated identical signature and flags repetition at the repeat window', async () => {
  const t = tracker();

  assert.deepEqual(t.noOp('sig-a'), { repeated: false, streak: 1, signature: 'sig-a' });
  assert.deepEqual(t.noOp('sig-a'), { repeated: false, streak: 2, signature: 'sig-a' });
  assert.deepEqual(t.noOp('sig-a'), { repeated: true, streak: 3, signature: 'sig-a' });
  assert.deepEqual(t.noOp('sig-b'), { repeated: false, streak: 1, signature: 'sig-b' });
  // A null signature never repeats, however often it is used.
  assert.deepEqual(t.noOp(null), { repeated: false, streak: 1, signature: null });
  assert.deepEqual(t.noOp(null), { repeated: false, streak: 1, signature: null });
  assert.deepEqual(t.noOp(), { repeated: false, streak: 1, signature: null });
  assert.equal(t.noOpStreak, 1);

  // The window is configurable.
  const quick = tracker({ repeatWindow: 2 });
  quick.noOp('x');
  assert.deepEqual(quick.noOp('x'), { repeated: true, streak: 2, signature: 'x' });

  // A non-null signature is stringified, so 7 and '7' are the same no-op — but
  // the streak only flags repetition once it reaches the window of three.
  const stringy = tracker();
  assert.equal(stringy.noOp(7).signature, '7');
  assert.deepEqual(stringy.noOp('7'), { repeated: false, streak: 2, signature: '7' });
  assert.deepEqual(stringy.noOp('7'), { repeated: true, streak: 3, signature: '7' });
});

test('recorded progress clears the no-op streak and forgets the last no-op signature', async () => {
  const t = tracker();
  t.noOp('sig-a');
  t.noOp('sig-a');
  assert.equal(t.noOpStreak, 2);

  t.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'ACTING' });
  assert.equal(t.noOpStreak, 0);
  // The signature is forgotten, so the next identical no-op starts a new streak.
  assert.deepEqual(t.noOp('sig-a'), { repeated: false, streak: 1, signature: 'sig-a' });
});

test('history is a bounded copy of the ring, defaulting to 200 records', async () => {
  const t = tracker({ ringSize: 3 });
  for (const state of ['A', 'B', 'C', 'D']) {
    t.progress(PROGRESS_KINDS.STATE_TRANSITION, { state });
  }
  assert.deepEqual(t.history().map((entry) => entry.detail.state), ['B', 'C', 'D']);
  assert.deepEqual(t.history().map((entry) => entry.step), [null, null, null]);

  // `history()` hands out a copy: mutating it cannot reach the ring.
  const copy = t.history();
  copy.push({ kind: 'forged' });
  assert.equal(t.history().length, 3);

  const defaulted = tracker();
  for (let index = 0; index < 205; index += 1) defaulted.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: `S${index}` });
  assert.equal(defaulted.history().length, 200);
  assert.equal(defaulted.history()[0].detail.state, 'S5');

  // A ring size that is not a positive integer falls back to 200.
  const ignored = tracker({ ringSize: 0 });
  ignored.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'A' });
  assert.equal(ignored.history().length, 1);
});

test('with no clock injected the tracker records null instants instead of reading the wall clock', async () => {
  const t = createProgressTracker();
  assert.equal(t.heartbeat().at, null);
  assert.equal(t.action().at, null);
  const recorded = t.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'A' });
  assert.equal(recorded.at, null);
  assert.equal(t.status().sinceProgressMs, null);
  assert.equal(t.status().lastProgressAt, null);
  // The progress itself is still recorded — only its instant is unavailable, so
  // `hasProgress()`, which keys off the instant, reports none.
  assert.deepEqual(t.status().lastProgress, {
    kind: 'state-transition',
    at: null,
    detail: { state: 'A' },
  });
  assert.equal(t.history().length, 1);
  assert.equal(t.hasProgress(), false);
});

test('progress counts only verified effects: a failed or unproven verification never advances progress', async () => {
  const t = tracker();
  const verifier = createVerifier({ clock: { now: () => PINNED_AT }, hash: PINNED_HASH });
  const never = vworld({ revision: 5, signature: 'sig', systemEvents: [] });
  const spinner = vworld({ revision: 6, signature: 'sig', systemEvents: [] });

  // The world never changed: the verifier fails, so the step is not progress.
  const failed = await verifier.verify({ action: { type: 'CLICK' }, before: never, after: never });
  assert.equal(failed.verdict, 'failure');
  assert.equal(t.progress(PROGRESS_KINDS.VERIFIED_EFFECT, failed), null);
  assert.equal(t.hasProgress(), false);

  // An unverifiable step is not progress either.
  const unknown = await verifier.verify({ action: { type: 'CLICK' }, before: null, after: spinner });
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(t.progress(PROGRESS_KINDS.VERIFIED_EFFECT, unknown), null);
  assert.equal(t.hasProgress(), false);

  // A cosmetic mutation satisfies the verifier as `direct`, which the progress
  // policy refuses: an effect is not the same thing as progress.
  const cosmetic = await verifier.verify({ action: { type: 'CLICK' }, before: never, after: spinner });
  assert.equal(cosmetic.verdict, 'success');
  assert.equal(cosmetic.kind, 'direct');
  assert.equal(t.progress(PROGRESS_KINDS.VERIFIED_EFFECT, cosmetic), null);
  assert.equal(t.hasProgress(), false);

  // A declared effect that really landed is progress.
  const landed = await verifier.verify({
    action: { type: 'FILE_WRITE', expectedEffect: { any: [{ file_created: '/tmp/out.txt' }] } },
    before: never,
    after: spinner,
    facts: { fileExists: async () => true },
  });
  assert.equal(landed.verdict, 'success');
  assert.equal(landed.kind, 'file');
  const recorded = t.progress(PROGRESS_KINDS.VERIFIED_EFFECT, landed);
  assert.equal(recorded.kind, 'verified-effect');
  assert.equal(t.hasProgress(), true);
  assert.equal(t.lastProgressAt, PINNED_AT);
});

test('the tracker is deterministic across two identical runs with the same injected clock', async () => {  const run = () => {
    const t = steppingTracker(5);
    t.heartbeat();
    t.action();
    t.noOp('sig');
    t.noOp('sig');
    t.progress(PROGRESS_KINDS.FILE_OPERATION, { verified: true, operation: 'write' });
    t.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'ACTING' });
    return { status: t.status(), history: t.history(), streak: t.noOpStreak, last: t.lastProgressAt };
  };
  assert.deepEqual(run(), run());
});
