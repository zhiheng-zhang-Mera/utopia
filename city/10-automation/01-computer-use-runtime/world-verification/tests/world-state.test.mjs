/**
 * UTOPIA · 10-automation / Computer Use Runtime — world state suite.
 *
 * Restates DS-Hns `app/computer-use/world-state.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b. The pinned digests are asserted
 * twice over: once against the port's injected digest, and once against the
 * donor's `sha1`, re-computed inside this file so the expected value cannot come
 * from the code under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DONOR_DEFAULT_CAPTURED_AT,
  PINNED_AT,
  PINNED_AX_SIGNATURE,
  PINNED_CONTROL_SIGNATURE,
  PINNED_EVIDENCE_DIGEST,
  PINNED_HASH,
  PINNED_INJECTED_AX_SIGNATURE,
  PINNED_INJECTED_CONTROL_SIGNATURE,
  PINNED_INJECTED_EVIDENCE_DIGEST,
  PINNED_INJECTED_WINDOW_SIGNATURE,
  PINNED_INJECTED_WORLD_SIGNATURE,
  PINNED_WINDOW_SIGNATURE,
  PINNED_WORLD_SIGNATURE,
  browserParts,
  pinnedParts,
  systemParts,
} from './fixtures.mjs';
import {
  MEANINGFUL_FIELDS,
  computeConfidence,
  createWorldState,
  discardWorldState,
  evidenceDigest,
  meaningfulChange,
  signatureOf,
  stableStringify,
  summarizeWorldState,
} from '../world-state.mjs';

/** The pinned world: explicitly pinned instant, explicitly pinned digest. */
function pinnedWorld(overrides = {}) {
  return createWorldState(pinnedParts(overrides), { hash: PINNED_HASH });
}

/** An independent implementation of the donor's digest, used as the expected value. */
function donorSha1(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

test('the pinned world carries the donor shape: foreground, targets, sources, notes', () => {
  const w = pinnedWorld();
  assert.equal(w.taskId, 'task-7');
  assert.equal(w.capturedAt, PINNED_AT);
  assert.equal(w.revision, 41);
  assert.equal(w.activeApp, 'Example App');
  assert.equal(w.activeWindow, 'Example Form');
  assert.equal(w.activeWindowHandle, '1001');
  assert.equal(w.foregroundProcessId, 4242);
  assert.equal(w.url, 'https://example.test/form');
  assert.equal(w.title, 'Example Form');
  assert.equal(w.readyState, 'complete');
  assert.equal(w.loading, false);
  assert.equal(w.focusedRef, 'c-2');
  assert.deepEqual(w.focusedElement, { ref: 'c-2', role: 'textbox', name: 'Email', value: 'a@b.test' });
  assert.equal(w.controls.length, 4);
  assert.deepEqual(w.visibleTargets.map((control) => control.ref), ['c-1', 'c-2']);
  assert.equal(w.ax.length, 2);
  assert.equal(w.windows.length, 2);
  assert.equal(w.foreground.handle, 1001);
  assert.deepEqual(w.dialogs, [{ type: 'alert', message: 'Careful' }, { type: 'confirm', message: 'Proceed?' }]);
  assert.deepEqual(w.systemEvents, [
    { type: 'window_changed', detail: '1002->1001' },
    { name: 'focus_changed', detail: 'd-0->d-1' },
  ]);
  assert.deepEqual(w.lastAction, { type: 'CLICK', result: 'ok' });
  assert.equal(w.uiStable, true);
  assert.deepEqual(w.notes, ['desktop observation failed: timeout']);
  assert.deepEqual(w.sources, {
    browser: { available: true, reason: null, backend: 'cdp' },
    desktop: { available: true, reason: null, backend: 'uia' },
    system: { available: true, reason: null, backend: 'events' },
  });
  assert.equal(w.confidence, 0.95);
});

test('the pinned world digest is the donor sha1 of the pinned stable string, 16 characters', () => {
  const w = pinnedWorld();
  assert.equal(w.controlSignature, PINNED_INJECTED_CONTROL_SIGNATURE);
  assert.equal(w.windowSignature, PINNED_INJECTED_WINDOW_SIGNATURE);
  assert.equal(w.axSignature, PINNED_INJECTED_AX_SIGNATURE);
  assert.equal(w.signature, PINNED_INJECTED_WORLD_SIGNATURE);
  assert.equal(w.dialogSignature, 'alert:Careful|confirm:Proceed?');

  // `evidenceDigest` takes its own hash option; with none, this world's injected
  // signature is digested by the donor's sha1 — the value pinned here.
  const digest = evidenceDigest(w);
  assert.equal(digest, PINNED_INJECTED_EVIDENCE_DIGEST);
  assert.equal(digest.length, 16);
  assert.match(digest, /^[0-9a-f]{16}$/);

  // The same digest, recomputed here from the donor's own algorithm.
  assert.equal(
    digest,
    donorSha1(stableStringify({
      signature: PINNED_INJECTED_WORLD_SIGNATURE,
      revision: 41,
      events: ['window_changed:1002->1001', 'focus_changed:d-0->d-1'],
      value: 'a@b.test',
    })),
  );
});

test('the donor-hash world pins the donor signature and the donor evidence digest', () => {
  const w = createWorldState(pinnedParts(), { hash: donorSha1 });
  assert.equal(w.controlSignature, PINNED_CONTROL_SIGNATURE);
  assert.equal(w.windowSignature, PINNED_WINDOW_SIGNATURE);
  assert.equal(w.axSignature, PINNED_AX_SIGNATURE);
  assert.equal(w.signature, PINNED_WORLD_SIGNATURE);
  assert.equal(evidenceDigest(w), PINNED_EVIDENCE_DIGEST);
  assert.equal(evidenceDigest(w).length, 16);
  assert.equal(
    evidenceDigest(w),
    donorSha1(stableStringify({
      signature: PINNED_WORLD_SIGNATURE,
      revision: 41,
      events: ['window_changed:1002->1001', 'focus_changed:d-0->d-1'],
      value: 'a@b.test',
    })),
  );
});

test('with no injected digest the port computes the donor sha1, and an injected digest replaces it', () => {
  // No hash at all: the module's own default is the donor's sha1.
  const defaulted = createWorldState(pinnedParts());
  const donorHashed = createWorldState(pinnedParts(), { hash: donorSha1 });
  assert.equal(defaulted.signature, donorHashed.signature);
  assert.equal(defaulted.signature, PINNED_WORLD_SIGNATURE);
  assert.equal(evidenceDigest(defaulted), PINNED_EVIDENCE_DIGEST);

  // An injected digest reaches the signatures, and travels separately to
  // evidenceDigest.
  const injected = createWorldState(pinnedParts(), { hash: PINNED_HASH });
  assert.equal(injected.signature, PINNED_INJECTED_WORLD_SIGNATURE);
  assert.notEqual(injected.signature, defaulted.signature);
  assert.equal(evidenceDigest(injected, { hash: PINNED_HASH }), 'B80BB402BCC731A5');
  assert.equal(
    evidenceDigest(injected, { hash: PINNED_HASH }),
    PINNED_HASH(stableStringify({
      signature: PINNED_INJECTED_WORLD_SIGNATURE,
      revision: 41,
      events: ['window_changed:1002->1001', 'focus_changed:d-0->d-1'],
      value: 'a@b.test',
    })),
  );
});

test('stableStringify sorts object keys, keeps array order and renders null and undefined alike', () => {
  assert.equal(
    stableStringify({ b: 1, a: [2, { d: 4, c: 3 }], n: null, u: undefined }),
    '{"a":[2,{"c":3,"d":4}],"b":1,"n":null,"u":null}',
  );
  assert.equal(stableStringify({ z: { y: 1, x: 2 }, a: 0 }), '{"a":0,"z":{"x":2,"y":1}}');
  assert.equal(stableStringify([3, 'b', null, undefined]), '[3,"b",null,null]');
  assert.equal(stableStringify('text'), '"text"');
  assert.equal(stableStringify(7), '7');
  assert.equal(stableStringify(true), 'true');
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(undefined), 'null');
  // Two objects that differ only in key order stringify identically, which is
  // what makes the digest order-independent.
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test('signatureOf is the donor sha1 truncated to 16 characters and survives a failing digest', () => {
  const value = { b: 1, a: [2, { d: 4, c: 3 }] };
  assert.equal(stableStringify(value), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.equal(signatureOf(value), donorSha1('{"a":[2,{"c":3,"d":4}],"b":1}'));
  assert.equal(signatureOf(value).length, 16);
  assert.equal(signatureOf(value), signatureOf({ a: [2, { c: 3, d: 4 }], b: 1 }));
  assert.equal(signatureOf(value, PINNED_HASH), 'B63A7A7C53638F33');
  assert.equal(signatureOf(value, PINNED_HASH), PINNED_HASH('{"a":[2,{"c":3,"d":4}],"b":1}'));
  assert.equal(signatureOf({ value: 1 }, () => { throw new Error('digest unavailable'); }), null);
});

test('a missing captured time takes the port default instead of the wall clock', () => {
  assert.equal(createWorldState(pinnedParts({ capturedAt: undefined })).capturedAt, DONOR_DEFAULT_CAPTURED_AT);
  assert.equal(createWorldState(pinnedParts({ capturedAt: null })).capturedAt, DONOR_DEFAULT_CAPTURED_AT);
  assert.equal(createWorldState(pinnedParts({ capturedAt: Number.NaN })).capturedAt, DONOR_DEFAULT_CAPTURED_AT);
  assert.equal(createWorldState(pinnedParts({ capturedAt: Number.POSITIVE_INFINITY })).capturedAt, DONOR_DEFAULT_CAPTURED_AT);
  assert.equal(createWorldState({}).capturedAt, DONOR_DEFAULT_CAPTURED_AT);

  // The injected clock is the donor's replacement for `Date.now()`.
  assert.equal(createWorldState(pinnedParts({ capturedAt: undefined }), { now: () => PINNED_AT }).capturedAt, PINNED_AT);
  assert.equal(createWorldState(pinnedParts({ capturedAt: 12 }), { now: () => PINNED_AT }).capturedAt, 12);
});

test('a missing source is recorded as unavailable with its reason, never replaced by a guess', () => {
  const w = createWorldState({
    browser: { source: { available: false, reason: 'cdp died', backend: 'cdp' } },
    desktop: { available: false, reason: 'uia timed out' },
    system: {},
  }, { hash: PINNED_HASH });

  assert.deepEqual(w.sources.browser, { available: false, reason: 'cdp died', backend: 'cdp' });
  // No `source` object: the fallback reads `available`/`reason` off the part.
  assert.deepEqual(w.sources.desktop, { available: false, reason: 'uia timed out', backend: null });
  // No browser part at all: `available !== false` is the donor's default.
  assert.deepEqual(w.sources.system, { available: true, reason: null, backend: null });

  assert.equal(w.activeApp, null);
  assert.equal(w.activeWindow, null);
  assert.equal(w.activeWindowHandle, null);
  assert.equal(w.foregroundProcessId, null);
  assert.equal(w.url, null);
  assert.equal(w.focusedElement, null);
  assert.equal(w.confidence, 0.15);
});

test('ax falls back from browser to desktop, controls are filtered, dialogs are concatenated', () => {
  const fromDesktop = createWorldState({
    browser: {},
    desktop: { ax: [{ ref: 'ax-desktop' }, null] },
  }, { hash: PINNED_HASH });
  assert.deepEqual(fromDesktop.ax, [{ ref: 'ax-desktop' }]);

  const fromBrowser = createWorldState({
    browser: { ax: [{ ref: 'ax-browser' }] },
    desktop: { ax: [{ ref: 'ax-desktop' }] },
  }, { hash: PINNED_HASH });
  assert.deepEqual(fromBrowser.ax, [{ ref: 'ax-browser' }]);

  const w = createWorldState({
    browser: { controls: [{ ref: 'c-1' }, null, false, { ref: 'c-2' }], dialogs: [{ type: 'alert', message: 'A' }] },
    desktop: { windows: [{ handle: 1 }, null], dialogs: [{ message: 'B' }] },
  }, { hash: PINNED_HASH });
  assert.deepEqual(w.controls, [{ ref: 'c-1' }, { ref: 'c-2' }]);
  assert.deepEqual(w.windows, [{ handle: 1 }]);
  // A dialog with no type is named "dialog"; one with no message contributes "".
  assert.equal(w.dialogSignature, 'alert:A|dialog:B');
});

test('the foreground window is taken from desktop.foreground or from the first foreground window', () => {
  const explicit = createWorldState({
    desktop: { foreground: { handle: 7, title: 'Explicit', processName: 'a.exe', processId: 9 } },
  }, { hash: PINNED_HASH });
  assert.equal(explicit.activeWindowHandle, '7');
  assert.equal(explicit.activeApp, 'a.exe');
  assert.equal(explicit.activeWindow, 'Explicit');
  assert.equal(explicit.foregroundProcessId, 9);

  // A window with no processName falls back to className; one with no processId
  // yields null rather than a guess.
  const byClass = createWorldState({
    desktop: { windows: [{ handle: 8, className: 'WinClass', foreground: true, processId: undefined }] },
  }, { hash: PINNED_HASH });
  assert.equal(byClass.activeApp, 'WinClass');
  assert.equal(byClass.foregroundProcessId, null);

  // No foreground window at all.
  const none = createWorldState({ desktop: { windows: [{ handle: 1, foreground: false }] } }, { hash: PINNED_HASH });
  assert.equal(none.foreground, null);
  assert.equal(none.activeWindowHandle, null);
  assert.equal(none.activeApp, null);
});

test('a focused ref with no matching control is described by ref alone', () => {
  const absent = createWorldState({ browser: { focusedRef: 'c-99', controls: [{ ref: 'c-1' }] } }, { hash: PINNED_HASH });
  assert.deepEqual(absent.focusedElement, { ref: 'c-99' });

  const noRef = createWorldState({ browser: { controls: [{ ref: 'c-1', role: 'button' }] } }, { hash: PINNED_HASH });
  assert.equal(noRef.focusedElement, null);

  const explicit = createWorldState({
    browser: { focusedRef: 'c-1', controls: [{ ref: 'c-1', role: 'button', name: 'Go' }] },
    focusedElement: { ref: 'given' },
  }, { hash: PINNED_HASH });
  assert.deepEqual(explicit.focusedElement, { ref: 'given' });
});

test('computeConfidence follows the donor weights and rounds to two places', () => {
  const all = computeConfidence(createWorldState(pinnedParts(), { hash: PINNED_HASH }));
  assert.equal(all, 0.95);

  // browser down, no url, desktop up, foreground, system down, controls present, no dialogs
  const degraded = computeConfidence({
    sources: {
      browser: { available: false, reason: 'x', backend: null },
      desktop: { available: true, reason: null, backend: null },
      system: { available: false, reason: 'y', backend: null },
    },
    url: null,
    controls: [{ ref: 'c-1' }],
    ax: [],
    windows: [],
    dialogs: [],
    foreground: { handle: 1 },
  });
  // score 0.25 + 0.1 + 0.1 + 0.05 = 0.5 of weight 1.0
  assert.equal(degraded, 0.5);

  const empty = computeConfidence({
    sources: {
      browser: { available: false, reason: null, backend: null },
      desktop: { available: false, reason: null, backend: null },
      system: { available: false, reason: null, backend: null },
    },
    url: null,
    controls: [],
    ax: [],
    windows: [],
    dialogs: [{ type: 'alert' }],
    foreground: null,
  });
  // score 0 of weight 1.0
  assert.equal(empty, 0);

  // A dialog costs its 0.05 even when everything else is structured.
  const withDialog = computeConfidence(createWorldState(pinnedParts({ browser: browserParts({ dialogs: [] }) }), { hash: PINNED_HASH }));
  assert.equal(withDialog, 0.95);

  // Every weighted input, one at a time, against the donor's weight table:
  // browser 0.3, url 0.1, desktop 0.25, foreground 0.1, system 0.1,
  // structured content 0.1, no dialogs 0.05 — total weight 1.0.
  const base = {
    sources: {
      browser: { available: false, reason: null, backend: null },
      desktop: { available: false, reason: null, backend: null },
      system: { available: false, reason: null, backend: null },
    },
    url: null,
    controls: [],
    ax: [],
    windows: [],
    dialogs: [{ type: 'alert' }],
    foreground: null,
  };
  assert.equal(computeConfidence(base), 0);
  assert.equal(computeConfidence({ ...base, sources: { ...base.sources, browser: { available: true } } }), 0.3);
  assert.equal(computeConfidence({ ...base, url: 'https://example.test/' }), 0.1);
  assert.equal(computeConfidence({ ...base, sources: { ...base.sources, desktop: { available: true } } }), 0.25);
  assert.equal(computeConfidence({ ...base, foreground: { handle: 1 } }), 0.1);
  assert.equal(computeConfidence({ ...base, sources: { ...base.sources, system: { available: true } } }), 0.1);
  assert.equal(computeConfidence({ ...base, controls: [{ ref: 'c-1' }] }), 0.1);
  assert.equal(computeConfidence({ ...base, dialogs: [] }), 0.05);
  // Only an exact `true` scores: a truthy source object is not "available".
  assert.equal(computeConfidence({ ...base, sources: { ...base.sources, browser: { available: 'yes' } } }), 0);
});

test('meaningfulChange reports a first observation and a lost observation', () => {
  assert.deepEqual(meaningfulChange(null, pinnedWorld()), { changed: true, fields: ['<first observation>'], meaningful: true });
  assert.deepEqual(meaningfulChange(undefined, pinnedWorld()), { changed: true, fields: ['<first observation>'], meaningful: true });
  assert.deepEqual(meaningfulChange(pinnedWorld(), null), { changed: true, fields: ['<observation lost>'], meaningful: true });
  assert.deepEqual(meaningfulChange(pinnedWorld(), undefined), { changed: true, fields: ['<observation lost>'], meaningful: true });
});

test('meaningfulChange reports no change for two identical observations', () => {
  const before = pinnedWorld();
  const after = pinnedWorld();
  assert.deepEqual(meaningfulChange(before, after), { changed: false, fields: [], meaningful: false });
});

test('every MEANINGFUL_FIELDS member is a boundary: changing it alone is the only reported change', () => {
  assert.equal(MEANINGFUL_FIELDS.length, 13);
  for (const field of MEANINGFUL_FIELDS) {
    const before = pinnedWorld();
    const after = pinnedWorld();
    after[field] = `changed-${field}`;
    const change = meaningfulChange(before, after);
    assert.equal(change.changed, true, `${field} must be a meaningful change`);
    assert.deepEqual(change.fields, [field], `${field} must be the only reported field`);
    assert.equal(change.meaningful, true, `${field} must be meaningful`);

    // The same field left alone is not a change.
    assert.deepEqual(meaningfulChange(pinnedWorld(), pinnedWorld()), { changed: false, fields: [], meaningful: false });
  }
});

test('MEANINGFUL_FIELDS is the donor list, in the donor order, frozen', () => {
  assert.deepEqual([...MEANINGFUL_FIELDS], [
    'url',
    'title',
    'readyState',
    'activeApp',
    'activeWindowHandle',
    'foregroundProcessId',
    'focusedRef',
    'dialogSignature',
    'controlSignature',
    'windowSignature',
    'axSignature',
    'lastActionType',
    'lastActionResult',
  ]);
  assert.equal(Object.isFrozen(MEANINGFUL_FIELDS), true);
  assert.throws(() => { MEANINGFUL_FIELDS.push('nope'); }, TypeError);
});

test('PRESERVED DONOR DEFECT: the world never populates lastActionType/lastActionResult, so lastAction is invisible to meaningfulChange', () => {
  const before = pinnedWorld({ lastAction: { type: 'CLICK', result: 'ok' } });
  const after = pinnedWorld({ lastAction: { type: 'TYPE', result: 'failed' } });
  // The donor stores `lastAction` and never derives the two meaningful fields
  // from it, so the action we just issued is correctly *not* a meaningful change.
  assert.equal(before.lastActionType, undefined);
  assert.equal(before.lastActionResult, undefined);
  assert.deepEqual(meaningfulChange(before, after), { changed: false, fields: [], meaningful: false });
  // ... and it is also invisible when the two meaningful fields *are* set, since
  // `lastAction` itself is not compared.
  before.lastActionType = 'CLICK';
  before.lastActionResult = 'ok';
  after.lastActionType = 'CLICK';
  after.lastActionResult = 'ok';
  assert.deepEqual(meaningfulChange(before, after), { changed: false, fields: [], meaningful: false });
});

test('meaningfulChange compares fields individually, and undefined against a value is a change', () => {
  const before = pinnedWorld();
  const after = pinnedWorld();
  after.url = null;
  assert.deepEqual(meaningfulChange(before, after).fields, ['url']);
  after.title = '';
  assert.deepEqual(meaningfulChange(before, after).fields, ['url', 'title']);
  // Strict comparison: a number never equals its string form.
  after.foregroundProcessId = '4242';
  assert.deepEqual(meaningfulChange(before, after).fields, ['url', 'title', 'foregroundProcessId']);
  // undefined on both sides is not a change.
  delete after.url;
  delete before.url;
  assert.deepEqual(meaningfulChange(before, after).fields, ['title', 'foregroundProcessId']);
});

test('meaningfulChange ignores DOM revision churn, which evidenceDigest does not', () => {
  const before = pinnedWorld();
  const churned = createWorldState(pinnedParts({ browser: browserParts({ revision: 42 }) }), { hash: PINNED_HASH });
  assert.deepEqual(meaningfulChange(before, churned), { changed: false, fields: [], meaningful: false });
  assert.notEqual(evidenceDigest(before), evidenceDigest(churned));
});

test('evidenceDigest follows the event stream and the focused value, and is null without a world', () => {
  const before = pinnedWorld();
  assert.equal(evidenceDigest(null), null);
  assert.equal(evidenceDigest(undefined), null);

  const events = pinnedWorld({ system: systemParts({ events: [{ type: 'dialog_opened', detail: 'x' }] }) });
  assert.notEqual(evidenceDigest(before), evidenceDigest(events));

  const value = pinnedWorld({ browser: browserParts({ controls: [{ ref: 'c-2', role: 'textbox', name: 'Email', value: 'z@b.test', visible: true, disabled: false }] }) });
  assert.notEqual(evidenceDigest(before), evidenceDigest(value));

  // The `hash` option reaches evidenceDigest directly, and the projection it
  // digests is exactly the donor's four fields.
  const projection = stableStringify({
    signature: PINNED_INJECTED_WORLD_SIGNATURE,
    revision: 41,
    events: ['window_changed:1002->1001', 'focus_changed:d-0->d-1'],
    value: 'a@b.test',
  });
  assert.equal(projection.length, 129);
  assert.equal(evidenceDigest(before, { hash: PINNED_HASH }), PINNED_HASH(projection));
  assert.equal(evidenceDigest(before, { hash: PINNED_HASH }), 'B80BB402BCC731A5');
  assert.equal(evidenceDigest(before), PINNED_INJECTED_EVIDENCE_DIGEST);
  assert.notEqual(evidenceDigest(before), evidenceDigest(before, { hash: PINNED_HASH }));

  // Determinism: the same world digests the same way every call.
  assert.equal(evidenceDigest(before), evidenceDigest(before));
  assert.equal(evidenceDigest(events, { hash: PINNED_HASH }), evidenceDigest(events, { hash: PINNED_HASH }));
});

test('two identical calls build the same world and the same digest', () => {
  const first = pinnedWorld();
  const second = pinnedWorld();
  assert.deepEqual(first, second);
  assert.equal(evidenceDigest(first), evidenceDigest(second));
  assert.equal(evidenceDigest(first, { hash: PINNED_HASH }), evidenceDigest(first, { hash: PINNED_HASH }));
  assert.deepEqual(summarizeWorldState(first), summarizeWorldState(second));
  assert.deepEqual(meaningfulChange(first, second), meaningfulChange(pinnedWorld(), pinnedWorld()));
});

test('parts.notes is copied and capped at 20, summarizeWorldState caps its notes at 5', () => {
  const notes = Array.from({ length: 25 }, (_, index) => `note-${index}`);
  const w = createWorldState(pinnedParts({ notes }), { hash: PINNED_HASH });
  assert.equal(w.notes.length, 20);
  assert.equal(w.notes[19], 'note-19');
  notes[0] = 'mutated-after-build';
  assert.equal(w.notes[0], 'note-0');
  assert.equal(summarizeWorldState(w).notes.length, 5);
  assert.deepEqual(summarizeWorldState(w).notes, ['note-0', 'note-1', 'note-2', 'note-3', 'note-4']);

  const none = createWorldState({ notes: 'not-an-array' }, { hash: PINNED_HASH });
  assert.deepEqual(none.notes, []);
  assert.equal(summarizeWorldState(none).notes, undefined);
});

test('summarizeWorldState is the compact donor summary, and null for no world', () => {
  assert.equal(summarizeWorldState(null), null);
  assert.equal(summarizeWorldState(undefined), null);
  assert.deepEqual(summarizeWorldState(pinnedWorld()), {
    activeApp: 'Example App',
    activeWindow: 'Example Form',
    url: 'https://example.test/form',
    title: 'Example Form',
    readyState: 'complete',
    loading: false,
    focused: 'textbox:Email',
    controls: 4,
    axNodes: 2,
    windows: 2,
    dialogs: 2,
    uiStable: true,
    confidence: 0.95,
    revision: 41,
    signature: PINNED_INJECTED_WORLD_SIGNATURE,
    notes: ['desktop observation failed: timeout'],
  });

  // The focused label falls back through role, name, ref.
  const noName = pinnedWorld({ browser: browserParts({ controls: [{ ref: 'c-2', role: 'textbox', value: 'x', visible: true }] }) });
  assert.equal(summarizeWorldState(noName).focused, 'textbox:c-2');
  const noRole = pinnedWorld({ browser: browserParts({ controls: [{ ref: 'c-2', name: 'Email', value: 'x', visible: true }] }) });
  assert.equal(summarizeWorldState(noRole).focused, '?:Email');
  assert.equal(summarizeWorldState(createWorldState({}, { hash: PINNED_HASH })).focused, null);
  assert.equal(summarizeWorldState(createWorldState({}, { hash: PINNED_HASH })).uiStable, null);
});

test('discardWorldState returns the summary and empties the world in place', () => {
  const w = pinnedWorld();
  const reference = w;
  const summary = discardWorldState(w);

  assert.equal(summary.signature, PINNED_INJECTED_WORLD_SIGNATURE);
  assert.equal(summary.url, 'https://example.test/form');
  assert.equal(w.discarded, true);
  assert.deepEqual(reference.controls, []);
  assert.deepEqual(reference.visibleTargets, []);
  assert.deepEqual(reference.ax, []);
  assert.deepEqual(reference.windows, []);
  assert.deepEqual(reference.systemEvents, []);
  assert.deepEqual(reference.dialogs, []);
  assert.equal(reference.focusedElement, null);
  assert.equal(reference.url, null);
  assert.equal(reference.title, null);
  assert.equal(reference.foreground, null);
  assert.equal(reference.signature, null);

  // A stale reference can no longer observe anything, and the digest of the
  // emptied world is a different evidence digest.
  assert.equal(evidenceDigest(reference, { hash: PINNED_HASH }), PINNED_HASH(stableStringify({
    signature: null,
    revision: 41,
    events: [],
    value: null,
  })));
  assert.equal(evidenceDigest(reference, { hash: PINNED_HASH }), '3E36514B6DFFC0CE');
  assert.notEqual(evidenceDigest(reference, { hash: PINNED_HASH }), PINNED_INJECTED_EVIDENCE_DIGEST);
  assert.equal(discardWorldState(null), null);
});

test('a world with every source degraded still records what it can, and its confidence says so', () => {
  const w = createWorldState({
    taskId: 'degraded',
    browser: { available: false, reason: 'browser controller is not available' },
    desktop: { available: false, reason: 'desktop controller is not available' },
    system: { available: false, reason: 'system observation is unavailable' },
  }, { hash: PINNED_HASH });

  assert.equal(w.confidence, 0.05);
  assert.equal(w.signature, signatureOf({
    activeApp: null,
    url: null,
    title: null,
    readyState: null,
    activeWindowHandle: null,
    foregroundProcessId: null,
    focusedRef: null,
    dialogSignature: '',
    controlSignature: PINNED_HASH(stableStringify([])),
    windowSignature: PINNED_HASH(stableStringify([])),
    axSignature: PINNED_HASH(stableStringify([])),
  }, PINNED_HASH));
});
