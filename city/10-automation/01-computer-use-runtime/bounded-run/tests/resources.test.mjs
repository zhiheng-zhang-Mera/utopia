/**
 * UTOPIA · 10-automation / Computer Use Runtime — resource budget suite.
 *
 * Restates the DS-Hns donor `app/computer-use/resources.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: every `classifyRetention` verdict
 * including its `undefined` case, the evidence ceilings (transients first, then the
 * oldest retained), the transient TTL, the pressure-triggered `atCeiling` flag and
 * the bounded ring.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createResourceBudget, classifyRetention, DEFAULTS, TRANSIENT_TTL_MS } from '../resources.mjs';

test('the donor constants are 60s TTL and the five small ceilings', () => {
  assert.equal(TRANSIENT_TTL_MS, 60000);
  assert.deepEqual(DEFAULTS, {
    ringSize: 200,
    maxScreenshots: 32,
    maxEntries: 2000,
    transientTtlMs: 60000,
    maxEvidenceBytes: 8388608,
  });
  assert.equal(DEFAULTS.maxEvidenceBytes, 8 * 1024 * 1024);
  // The factory's own defaults are the module defaults.
  assert.deepEqual(createResourceBudget({ now: () => 0 }).limits, {
    ringSize: 200,
    maxScreenshots: 32,
    transientTtlMs: 60000,
    maxEvidenceBytes: 8388608,
  });
});

test('classifyRetention answers every donor verdict from the reason text', () => {
  assert.deepEqual(classifyRetention('stall-targeted'), {
    retention: 'failure',
    keep: false,
    transient: true,
    rationale: 'transient diagnostic capture',
  });
  assert.deepEqual(classifyRetention('recovery'), { retention: 'failure', keep: false, transient: true, rationale: 'transient diagnostic capture' });
  assert.deepEqual(classifyRetention('probe'), { retention: 'failure', keep: false, transient: true, rationale: 'transient diagnostic capture' });
  assert.deepEqual(classifyRetention('DIAGNOSTIC-capture'), { retention: 'failure', keep: false, transient: true, rationale: 'transient diagnostic capture' });
  assert.deepEqual(classifyRetention('the user asked'), { retention: 'failure', keep: false, transient: true, rationale: 'transient capture - used and dropped' });
});

test('classifyRetention answers its undocumented cases as the donor does', () => {
  // `reason === 'requested'` is kept even without the explicit flag.
  assert.deepEqual(classifyRetention('requested'), { retention: 'requested', keep: true, rationale: 'explicitly requested' });
  // An explicit request wins over everything except nothing.
  assert.deepEqual(classifyRetention('stall-targeted', { explicit: true }), { retention: 'requested', keep: true, rationale: 'explicitly requested' });
  // The mode is reported back as its own retention class.
  assert.deepEqual(classifyRetention('anything', { mode: 'debug' }), { retention: 'debug', keep: true, rationale: 'debug mode' });
  assert.deepEqual(classifyRetention('anything', { mode: 'audit' }), { retention: 'audit', keep: true, rationale: 'audit mode' });
  assert.deepEqual(classifyRetention('anything', { mode: 'normal' }), { retention: 'failure', keep: false, transient: true, rationale: 'transient capture - used and dropped' });
  // A failure run keeps the capture as failure evidence, before the diagnostic test.
  assert.deepEqual(classifyRetention('stall-targeted', { runFailed: true }), { retention: 'failure', keep: true, rationale: 'failure evidence' });
  // The retention policy wins over the failure flag.
  assert.deepEqual(classifyRetention('stall-targeted', { runFailed: true, retention: 'never' }), { retention: 'never', keep: false, rationale: 'retention policy: never' });
  assert.deepEqual(classifyRetention('anything', { retention: 'never' }), { retention: 'never', keep: false, rationale: 'retention policy: never' });
});

test('classifyRetention answers its `undefined` case: no argument at all', () => {
  assert.deepEqual(classifyRetention(undefined), { retention: 'failure', keep: false, transient: true, rationale: 'transient capture - used and dropped' });
  assert.deepEqual(classifyRetention(null), { retention: 'failure', keep: false, transient: true, rationale: 'transient capture - used and dropped' });
  assert.deepEqual(classifyRetention(''), { retention: 'failure', keep: false, transient: true, rationale: 'transient capture - used and dropped' });
  // A bare `'never'` string is *not* the never policy: only the option is.
  assert.deepEqual(classifyRetention('never'), { retention: 'failure', keep: false, transient: true, rationale: 'transient capture - used and dropped' });
  // An unknown mode falls through to the reason-based verdict.
  assert.deepEqual(classifyRetention('requested', { mode: 'nonsense' }), { retention: 'requested', keep: true, rationale: 'explicitly requested' });
});

test('registerScreenshot answers the donor `keep`, which is always true', () => {
  let tick = 0;
  const budget = createResourceBudget({ now: () => tick++ });
  const decision = budget.registerScreenshot({ bytes: 100, reason: 'explicit', step: 2, level: 'region', path: 'D:\\shot.png' });
  // Donor defect, preserved: `registerScreenshot` returns a literal `keep: true`
  // instead of the classified decision's `keep`, so a transient capture that the
  // policy drops still reports `keep: true`. The entry itself carries the real
  // answer, and the retention class is passed through untouched.
  assert.deepEqual(decision, { keep: false, retention: 'failure', rationale: 'transient capture - used and dropped', evicted: 0 });
  assert.equal(budget.screenshotCount, 1);
  assert.deepEqual(budget.screenshots(), [{
    at: 0,
    step: 2,
    reason: 'explicit',
    level: 'region',
    bytes: 100,
    retention: 'failure',
    transient: true,
    keep: false,
    path: 'D:\\shot.png',
  }]);
  assert.deepEqual(budget.snapshot(), {
    limits: { ringSize: 200, maxScreenshots: 32, transientTtlMs: 60000, maxEvidenceBytes: 8388608 },
    screenshots: 1,
    retainedScreenshots: 0,
    droppedScreenshots: 0,
    evidenceBytes: 100,
    atCeiling: false,
    pressure: [],
  });

  // A kept capture still reports `keep: true` and counts as retained.
  const kept = budget.registerScreenshot({ reason: 'final', runFailed: true, bytes: 5 });
  assert.equal(kept.keep, true);
  assert.equal(budget.snapshot().retainedScreenshots, 1);
});

test('classifyRetention stays a method on the budget, with the module function identity', () => {
  const budget = createResourceBudget({ now: () => 0 });
  assert.equal(budget.classifyRetention, classifyRetention);
});

test('an expired transient is dropped on the next enforcement, and a live one is not', () => {
  let clock = 0;
  const budget = createResourceBudget({ now: () => clock, maxScreenshots: 10, transientTtlMs: 60000 });

  clock = 1000;
  budget.registerScreenshot({ reason: 'stall-targeted', bytes: 500 });
  clock = 61500;
  // 61500 - 60000 = 1500 > 1000, so the transient is expired and dropped.
  const evicted = budget.enforce();
  assert.equal(evicted, 1);
  assert.equal(budget.screenshotCount, 0);
  assert.equal(budget.dropped, 1);
  assert.deepEqual(budget.snapshot(), {
    limits: { ringSize: 200, maxScreenshots: 10, transientTtlMs: 60000, maxEvidenceBytes: 8388608 },
    screenshots: 0,
    retainedScreenshots: 0,
    droppedScreenshots: 1,
    evidenceBytes: 0,
    // A drop alone is not pressure: with nothing left in the list and no bytes
    // retained, the donor's second condition is still false.
    atCeiling: false,
    pressure: [{ at: 61500, evicted: 1, screenshots: 0 }],
  });

  // A capture exactly at the deadline is not expired.
  const fresh = createResourceBudget({ now: () => 60000, maxScreenshots: 10, transientTtlMs: 60000 });
  fresh.registerScreenshot({ reason: 'stall-targeted', bytes: 1 });
  assert.equal(fresh.enforce(), 0);
  assert.equal(fresh.screenshotCount, 1);
});

test('a kept failure capture is never expired by the TTL', () => {
  let clock = 0;
  const budget = createResourceBudget({ now: () => clock, maxScreenshots: 10, transientTtlMs: 60000 });
  budget.registerScreenshot({ reason: 'final', runFailed: true, bytes: 900 });
  clock = 10_000_000;
  assert.equal(budget.enforce(), 0);
  assert.equal(budget.screenshotCount, 1);
  assert.equal(budget.snapshot().retainedScreenshots, 1);
});

test('the count ceiling evicts a transient before the oldest retained evidence', () => {
  let tick = 0;
  const budget = createResourceBudget({ now: () => tick++, maxScreenshots: 2 });
  budget.registerScreenshot({ reason: 'stall-targeted', bytes: 10 });
  budget.registerScreenshot({ reason: 'stall-targeted', bytes: 10 });
  assert.deepEqual(budget.screenshots().map((entry) => entry.reason), ['stall-targeted', 'stall-targeted']);

  const decision = budget.registerScreenshot({ reason: 'final', runFailed: true, bytes: 10 });
  // Donor defect, preserved: the eviction order is snapshotted before the loop, so
  // once the first eviction brings the list back to the ceiling the loop stops —
  // exactly one capture is dropped per over-ceiling registration, even though two
  // candidates were ranked.
  assert.equal(decision.evicted, 1);
  assert.equal(decision.retention, 'failure');
  assert.equal(decision.rationale, 'failure evidence');
  assert.deepEqual(budget.screenshots().map((entry) => entry.reason), ['stall-targeted', 'final']);
  assert.equal(budget.dropped, 1);
  assert.equal(budget.screenshotCount, 2);
  assert.equal(budget.snapshot().evidenceBytes, 20);
  // The evicted transient is the one the ranking put first; the survivor is the
  // second transient, which carries no `removed` mark.
  assert.deepEqual(budget.screenshots().map((entry) => entry.at), [2, 4]);
  assert.deepEqual(budget.screenshots().map((entry) => entry.removed), [undefined, undefined]);
});

test('the byte ceiling evicts the oldest first, even when both entries are retained', () => {
  let tick = 0;
  const budget = createResourceBudget({ now: () => tick++, maxEvidenceBytes: 100, maxScreenshots: 10 });
  budget.registerScreenshot({ reason: 'a', runFailed: true, bytes: 60 });
  assert.equal(budget.screenshotCount, 1);

  const decision = budget.registerScreenshot({ reason: 'b', runFailed: true, bytes: 60 });
  assert.equal(decision.evicted, 1);
  assert.deepEqual(budget.screenshots().map((entry) => entry.reason), ['b']);
  assert.equal(budget.snapshot().evidenceBytes, 60);
  assert.equal(budget.dropped, 1);
});

test('the count eviction leaves the donor mark on the entry it tagged and dropped', () => {
  let tick = 0;
  const budget = createResourceBudget({ now: () => tick++, maxScreenshots: 1, maxEvidenceBytes: 1_000_000 });
  budget.registerScreenshot({ reason: 'a', runFailed: true, bytes: 1 });
  budget.registerScreenshot({ reason: 'b', runFailed: true, bytes: 1 });
  budget.registerScreenshot({ reason: 'c', runFailed: true, bytes: 1 });
  // Only 'a' ever came up as a count-ceiling candidate, so only the entries that
  // were dropped — not the survivor — carry the donor's `removed = true` mark.
  assert.deepEqual(budget.screenshots().map((entry) => entry.reason), ['c']);
  assert.equal(budget.screenshotCount, 1);
  assert.equal(budget.snapshot().droppedScreenshots, 2);

  // A registration that does have to evict leaves its mark on the live object the
  // drop removed from the list.
  const next = createResourceBudget({ now: () => 0, maxScreenshots: 1, maxEvidenceBytes: 1_000_000 });
  next.registerScreenshot({ reason: 'first', runFailed: true, bytes: 1 });
  const evictedEntry = next.screenshots()[0];
  next.registerScreenshot({ reason: 'second', runFailed: true, bytes: 1 });
  assert.equal(evictedEntry.removed, true);
});

test('the byte ceiling does not guard on the donor mark, but never re-drops the same entry', () => {
  let tick = 0;
  const budget = createResourceBudget({ now: () => tick++, maxScreenshots: 1, maxEvidenceBytes: 5 });
  assert.equal(budget.registerScreenshot({ reason: 'a', runFailed: true, bytes: 2 }).evicted, 0);
  assert.equal(budget.registerScreenshot({ reason: 'b', runFailed: true, bytes: 2 }).evicted, 1);
  const decision = budget.registerScreenshot({ reason: 'c', runFailed: true, bytes: 2 });
  // The byte pass re-reads the list, so the entry the count pass already removed
  // is not in it: one count eviction and one byte eviction.
  assert.equal(decision.evicted, 1);
  assert.equal(budget.dropped, 2);
  assert.equal(budget.screenshotCount, 1);
  assert.equal(budget.snapshot().evidenceBytes, 2);
});

test('pressure is kept as the last five eviction events', () => {
  let tick = 0;
  const budget = createResourceBudget({ now: () => tick++, maxScreenshots: 1 });
  for (let index = 0; index < 8; index += 1) {
    budget.registerScreenshot({ reason: `r${index}`, runFailed: true, bytes: 1 });
  }
  const snapshot = budget.snapshot();
  assert.equal(snapshot.pressure.length, 5);
  assert.deepEqual(snapshot.pressure.map((entry) => entry.evicted), [1, 1, 1, 1, 1]);
  assert.equal(snapshot.droppedScreenshots, 7);
});

test('atCeiling needs a drop and then real pressure, exactly as the donor defines it', () => {
  let tick = 0;
  const budget = createResourceBudget({ now: () => tick++, maxScreenshots: 2, maxEvidenceBytes: 100 });
  assert.equal(budget.snapshot().atCeiling, false);
  budget.registerScreenshot({ reason: 'a', runFailed: true, bytes: 10 });
  assert.equal(budget.snapshot().atCeiling, false);

  // Two retained at the count ceiling with an eviction behind it.
  budget.registerScreenshot({ reason: 'b', runFailed: true, bytes: 10 });
  budget.registerScreenshot({ reason: 'c', runFailed: true, bytes: 10 });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.droppedScreenshots, 1);
  assert.equal(snapshot.screenshots, 2);
  assert.equal(snapshot.atCeiling, true);

  // Dropped captures and 90% of the byte ceiling is the other arm.
  const bytes = createResourceBudget({ now: () => 0, maxScreenshots: 10, maxEvidenceBytes: 100 });
  bytes.registerScreenshot({ reason: 'a', bytes: 50 });
  bytes.registerScreenshot({ reason: 'b', bytes: 100 });
  const byteSnapshot = bytes.snapshot();
  assert.equal(byteSnapshot.droppedScreenshots, 1);
  assert.ok(byteSnapshot.evidenceBytes >= 90);
  assert.equal(byteSnapshot.atCeiling, true);
});

test('the ring buffer keeps the newest `capacity` items and reports its capacity', () => {
  const budget = createResourceBudget({ now: () => 0, ringSize: 3 });
  const ring = budget.ring();
  assert.equal(ring.capacity, 3);
  assert.equal(ring.size, 0);
  assert.equal(ring.push('a'), 1);
  assert.equal(ring.push('b'), 2);
  assert.equal(ring.push('c'), 3);
  assert.equal(ring.push('d'), 3);
  assert.deepEqual(ring.toArray(), ['b', 'c', 'd']);
  assert.deepEqual(ring.last(), ['d']);
  assert.deepEqual(ring.last(2), ['c', 'd']);
  // Donor defect, preserved: `last(0)` is `items.slice(-0)`, which is
  // `items.slice(0)` — the whole ring, not an empty list.
  assert.deepEqual(ring.last(0), ['b', 'c', 'd']);
  const copy = ring.toArray();
  copy.length = 0;
  assert.equal(ring.size, 3);
  ring.clear();
  assert.equal(ring.size, 0);
  assert.deepEqual(ring.toArray(), []);

  const sized = budget.ring(2);
  assert.equal(sized.capacity, 2);
  sized.push(1);
  sized.push(2);
  sized.push(3);
  assert.deepEqual(sized.toArray(), [2, 3]);
  // A nonsense size falls back to the budget's ring size.
  assert.equal(budget.ring(0).capacity, 3);
  assert.equal(budget.ring(-1).capacity, 3);
  assert.equal(budget.ring('x').capacity, 3);
});

test('the injected limits override every default, and the snapshot echoes them', () => {
  const budget = createResourceBudget({ now: () => 0, ringSize: 5, maxScreenshots: 3, transientTtlMs: 10, maxEvidenceBytes: 1000 });
  assert.deepEqual(budget.limits, { ringSize: 5, maxScreenshots: 3, transientTtlMs: 10, maxEvidenceBytes: 1000 });
  assert.deepEqual(budget.snapshot().limits, { ringSize: 5, maxScreenshots: 3, transientTtlMs: 10, maxEvidenceBytes: 1000 });
  assert.equal(budget.ring().capacity, 5);
  // A non-integer count falls back; a finite number for the byte ceiling is used.
  const fallback = createResourceBudget({ maxScreenshots: 1.5, maxEvidenceBytes: Infinity });
  assert.equal(fallback.limits.maxScreenshots, 32);
  assert.equal(fallback.limits.maxEvidenceBytes, 8388608);
});

test('the default clock is a deterministic step clock, so a TTL cannot expire by surprise', () => {
  const budget = createResourceBudget({ transientTtlMs: 60000 });
  budget.registerScreenshot({ reason: 'stall-targeted', bytes: 1 });
  assert.equal(budget.snapshot().screenshots, 1);
  assert.equal(budget.enforce(), 0);
  const second = createResourceBudget({ transientTtlMs: 60000 });
  second.registerScreenshot({ reason: 'stall-targeted', bytes: 1 });
  assert.deepEqual(budget.screenshots(), second.screenshots());
});

test('a capture with no bytes and no reason is still recorded with the donor defaults', () => {
  const budget = createResourceBudget({ now: () => 0, maxScreenshots: 1 });
  const decision = budget.registerScreenshot();
  assert.deepEqual(decision, { keep: false, retention: 'failure', rationale: 'transient capture - used and dropped', evicted: 0 });
  assert.deepEqual(budget.screenshots(), [{
    at: 0,
    step: null,
    reason: 'unspecified',
    level: null,
    bytes: 0,
    retention: 'failure',
    transient: true,
    keep: false,
    path: null,
  }]);
  // A non-finite byte count is recorded as zero rather than NaN.
  budget.registerScreenshot({ bytes: Number.NaN });
  assert.equal(budget.snapshot().evidenceBytes, 0);
});
