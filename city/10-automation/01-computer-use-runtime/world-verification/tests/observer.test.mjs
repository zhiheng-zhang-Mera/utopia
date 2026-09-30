/**
 * UTOPIA · 10-automation / Computer Use Runtime — observation layer suite.
 *
 * Restates DS-Hns `app/computer-use/observer.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the per-source fault boundary, the
 * degradation notes, the error ring, the bounded source timeout, the event
 * accumulation and the donor's `probe` defect. The clock and the digest are
 * injected, so every observation is deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DONOR_DEFAULT_CAPTURED_AT, PINNED_AT, PINNED_HASH } from './fixtures.mjs';
import { createObserver } from '../observer.mjs';

/** A controller that answers `probe()` and `snapshot()`. */
function controller(snapshot, probe = () => ({ available: true })) {
  return { probe, snapshot: typeof snapshot === 'function' ? snapshot : () => snapshot };
}

/** A clock that reads the same instant every time. */
function fixedClock(at = PINNED_AT) {
  return { now: () => at };
}

/** A clock that advances by `step` on every call. */
function steppingClock(start = PINNED_AT, step = 7) {
  let at = start;
  return { now: () => { at += step; return at; } };
}

/**
 * Observer options with working sources by default, so a test only has to name
 * the source it is actually exercising.
 */
function options(overrides = {}) {
  return {
    clock: fixedClock(),
    hash: PINNED_HASH,
    sourceTimeoutMs: 50,
    browser: controller({ url: 'https://example.test/form' }),
    desktop: controller({ windows: [{ handle: 1, title: 'Example', foreground: true }] }),
    file: null,
    ...overrides,
  };
}

test('PRESERVED DONOR DEFECT: a controller without a probe() is reported unavailable even when snapshot() works', async () => {
  const noProbe = { snapshot: () => ({ url: 'https://example.test/' }) };
  const observer = createObserver(options({ browser: noProbe }));
  const world = await observer.observe();

  assert.equal(world.url, null, 'the snapshot was never consulted');
  assert.equal(world.sources.browser.available, false);
  assert.deepEqual(world.notes, ['browser observation failed: browser controller is not available']);
  assert.deepEqual(observer.errors(), [], 'a skip does not enter the error ring');
  assert.deepEqual(world.sources.browser, { available: false, reason: 'browser controller is not available', backend: null });

  // A controller that does expose probe() is consulted.
  const withProbe = createObserver(options({ browser: controller({ url: 'https://example.test/' }) }));
  const observed = await withProbe.observe();
  assert.equal(observed.url, 'https://example.test/');
  assert.equal(observed.sources.browser.available, true);
  assert.deepEqual(observed.notes, []);
});

test('a probe that throws or answers available:false skips the source without an error record', async () => {
  const throwing = createObserver(options({ browser: controller({ url: 'x' }, () => { throw new Error('no channel'); }) }));
  const world = await throwing.observe();
  assert.equal(world.url, null);
  assert.deepEqual(world.notes, ['browser observation failed: browser controller is not available']);
  assert.deepEqual(throwing.errors(), [], 'a probe failure is a skip, not an observation error');

  const unavailable = createObserver(options({ desktop: controller({ windows: [{ handle: 9 }] }, () => ({ available: false })) }));
  const second = await unavailable.observe();
  assert.equal(second.windows.length, 0);
  assert.equal(second.sources.desktop.available, false);
  assert.deepEqual(second.notes, ['desktop observation failed: desktop controller is not available']);

  // A probe returning nothing (undefined) counts as available, exactly as the donor reads it.
  const silentProbe = createObserver(options({ browser: controller({ url: 'https://example.test/' }, () => undefined) }));
  assert.equal((await silentProbe.observe()).url, 'https://example.test/');
});

test('a snapshot that throws degrades the source, records a note and lands in the error ring', async () => {
  const failure = Object.assign(new Error('cdp detached'), { code: 'EPIPE' });
  const observer = createObserver(options({
    clock: steppingClock(),
    browser: controller(() => { throw failure; }),
    desktop: controller({ windows: [{ handle: 1, foreground: true, title: 'Only App' }] }),
  }));
  const world = await observer.observe();

  assert.deepEqual(world.notes, ['browser observation failed: cdp detached']);
  assert.deepEqual(world.sources.browser, { available: false, reason: 'cdp detached', backend: null });
  // The desktop side kept working: that is the point of the fault boundary.
  assert.equal(world.activeWindow, 'Only App');
  assert.equal(world.sources.desktop.available, true);
  assert.equal(observer.errors().length, 1);
  assert.equal(observer.errors()[0].source, 'browser');
  assert.equal(observer.errors()[0].error, 'cdp detached');
  assert.equal(observer.errors()[0].code, 'EPIPE');
  assert.equal(observer.errors()[0].at, PINNED_AT + 7, 'capturedAt is read first, then the error instant');
});

test('a source that exceeds the window is reported unavailable with the donor message', async () => {
  const observer = createObserver(options({
    browser: controller(() => new Promise(() => {})),
    sourceTimeoutMs: 10,
  }));
  const world = await observer.observe();
  assert.deepEqual(world.notes, ['browser observation failed: browser observation timed out after 10ms']);
  assert.equal(observer.errors().length, 1);
  assert.equal(observer.errors()[0].source, 'browser');
  assert.equal(observer.errors()[0].error, 'browser observation timed out after 10ms');
  assert.equal(observer.errors()[0].code, null);

  // The per-observation override wins over the observer default.
  const perCall = createObserver(options({ browser: controller(() => new Promise(() => {})) }));
  const overridden = await perCall.observe({ sourceTimeoutMs: 5 });
  assert.deepEqual(overridden.notes, ['browser observation failed: browser observation timed out after 5ms']);
});

test('a snapshot returning null or undefined is an unavailable source, not a crash', async () => {
  const observer = createObserver(options({ browser: controller(() => null), desktop: controller(() => undefined) }));
  const world = await observer.observe();
  assert.deepEqual(world.notes, [
    'browser observation failed: browser controller is not available',
    'desktop observation failed: desktop controller is not available',
  ]);
  assert.equal(world.url, null);
  assert.equal(world.activeWindowHandle, null);
});

test('the accessibility walk is opt-out through context.ax', async () => {
  const seen = [];
  const desktop = { probe: () => ({ available: true }), snapshot: (arg) => { seen.push(arg); return { windows: [] }; } };
  const observer = createObserver(options({ desktop }));

  await observer.observe();
  await observer.observe({ ax: false });
  assert.deepEqual(seen, [{ ax: true }, { ax: false }]);
});

test('system events are computed from consecutive observations and accumulate until drained', async () => {
  let window = { handle: 1, title: 'One', foreground: true };
  let url = 'https://example.test/a';
  let focused = 'c-1';
  const browser = { probe: () => ({ available: true }), snapshot: () => ({ url, focusedRef: focused, controls: [] }) };
  const desktop = { probe: () => ({ available: true }), snapshot: () => ({ windows: [window], foreground: window }) };
  const observer = createObserver(options({ browser, desktop }));

  const first = await observer.observe();
  // The donor computes events only when there is a previous observation.
  assert.deepEqual(first.systemEvents, []);

  window = { handle: 2, title: 'Two', foreground: true };
  url = 'https://example.test/b';
  focused = 'c-2';
  const second = await observer.observe();
  assert.equal(second.systemEvents.length, 3);
  assert.deepEqual(second.systemEvents.map((event) => event.type), ['window_changed', 'focus_changed', 'url_changed']);
  assert.deepEqual(second.systemEvents.map((event) => [event.from, event.to]), [
    ['One', 'Two'],
    ['c-1', 'c-2'],
    ['https://example.test/a', 'https://example.test/b'],
  ]);
  assert.equal(second.systemEvents.every((event) => event.at === PINNED_AT), true, 'event instants come from the injected clock');

  // Events accumulate across observations.
  focused = 'c-3';
  const third = await observer.observe();
  assert.equal(third.systemEvents.length, 4);

  // `drainEvents` hands them over once, and `previous` keeps its identity.
  const drained = observer.drainEvents();
  assert.equal(drained.length, 4);
  assert.deepEqual(observer.drainEvents(), []);
  assert.equal(observer.previous, third);
  const fourth = await observer.observe();
  assert.deepEqual(fourth.systemEvents, []);

  // `reset` forgets both the previous observation and the pending events.
  observer.reset();
  assert.equal(observer.previous, null);
  assert.deepEqual(observer.drainEvents(), []);
  assert.deepEqual((await observer.observe()).systemEvents, []);
});

test('file events join the system events, and a broken file controller degrades the system source', async () => {
  const file = { facts: () => ({ events: () => Array.from({ length: 25 }, (_, index) => ({ type: `file_${index}` })) }) };
  const observer = createObserver(options({ file, browser: controller({ url: 'https://example.test/', events: [{ type: 'browser_event' }] }) }));
  const world = await observer.observe();

  // The last 20 file events, then the browser's own events.
  assert.equal(world.systemEvents.length, 21);
  assert.equal(world.systemEvents[0].type, 'file_5');
  assert.equal(world.systemEvents[20].type, 'browser_event');
  assert.equal(world.sources.system.available, true);

  const broken = createObserver(options({ file: { facts: () => { throw new Error('watch died'); } } }));
  const degraded = await broken.observe();
  // `collectSystemEvents` swallows the failure and reports the source as
  // unavailable, so the observation itself still succeeds and no note is added —
  // the reason lives in `sources.system.reason` and nowhere else.
  assert.equal(degraded.sources.system.available, false);
  assert.deepEqual(degraded.sources.system, { available: false, reason: 'watch died', backend: null });
  assert.deepEqual(degraded.notes, []);
  assert.deepEqual(degraded.systemEvents, []);
  assert.deepEqual(broken.errors(), []);

  // A file controller whose facts carry no `events` function contributes nothing.
  const noEvents = createObserver(options({ file: { facts: () => ({}) }, browser: controller({ events: [{ type: 'only_browser' }] }) }));
  const onlyBrowser = await noEvents.observe();
  assert.deepEqual(onlyBrowser.systemEvents.map((event) => event.type), ['only_browser']);

  // No file controller at all: the browser events are still collected.
  const noFile = createObserver(options({ file: null, browser: controller({ events: [{ type: 'still_here' }] }) }));
  assert.deepEqual((await noFile.observe()).systemEvents.map((event) => event.type), ['still_here']);
});

test('watchFile pushes watched events into the stream and calls the callback', async () => {
  let emit = null;
  const file = { watch: (target, listener) => { emit = listener; return { target, close() {} }; } };
  const observer = createObserver(options({ file }));

  const seen = [];
  const handle = observer.watchFile('/tmp/watched.txt', (event) => seen.push(event));
  assert.equal(handle.target, '/tmp/watched.txt');
  assert.equal(typeof handle.close, 'function');

  emit({ type: 'file_changed', path: '/tmp/watched.txt' });
  assert.deepEqual(seen, [{ type: 'file_changed', path: '/tmp/watched.txt' }]);
  assert.deepEqual(observer.drainEvents(), [{ type: 'file_changed', path: '/tmp/watched.txt' }]);

  // No file controller, or one without `watch`: nothing is installed.
  assert.equal(createObserver(options({ file: null })).watchFile('/tmp/x', () => {}), null);
  assert.equal(createObserver(options({ file: {} })).watchFile('/tmp/x', () => {}), null);

  // An event with no callback is still collected.
  const silent = createObserver(options({ file }));
  silent.watchFile('/tmp/y');
  emit({ type: 'file_changed', path: '/tmp/y' });
  assert.deepEqual(silent.drainEvents(), [{ type: 'file_changed', path: '/tmp/y' }]);
});

test('the observer passes the world its sources produced, including their notes and sources map', async () => {
  const browser = controller({
    url: 'https://example.test/form',
    title: 'Example Form',
    readyState: 'complete',
    revision: 3,
    controls: [{ ref: 'c-1', name: 'Save', visible: true, disabled: false }, null],
    ax: [{ ref: 'ax-1', role: 'button', name: 'Save' }],
    dialogs: [{ type: 'alert', message: 'Careful' }],
    source: { available: true, reason: null, backend: 'cdp' },
  });
  const desktop = controller({
    activeApp: 'Example App',
    windows: [{ handle: 1001, title: 'Example Form', processName: 'example.exe', processId: 4242, foreground: true }],
    source: { available: true, reason: null, backend: 'uia' },
  });
  const observer = createObserver(options({ clock: steppingClock(), browser, desktop }));
  const world = await observer.observe({ taskId: 'task-9', lastAction: { type: 'CLICK' }, uiStable: false });

  assert.equal(world.taskId, 'task-9');
  assert.equal(world.capturedAt, PINNED_AT + 7);
  assert.equal(world.url, 'https://example.test/form');
  assert.deepEqual(world.controls.map((control) => control.ref), ['c-1']);
  assert.deepEqual(world.visibleTargets.map((control) => control.ref), ['c-1']);
  assert.equal(world.activeWindowHandle, '1001');
  assert.deepEqual(world.lastAction, { type: 'CLICK' });
  assert.equal(world.uiStable, false);
  assert.equal(world.dialogSignature, 'alert:Careful');
  assert.deepEqual(world.notes, []);
  assert.equal(world.sources.browser.backend, 'cdp');
  assert.equal(world.sources.desktop.backend, 'uia');
  assert.equal(observer.errors().length, 0);
});

test('with no clock injected the world is stamped with the port default, not the wall clock', async () => {
  const observer = createObserver({ browser: controller({ url: 'https://example.test/' }), hash: PINNED_HASH });
  const world = await observer.observe();
  assert.equal(world.capturedAt, DONOR_DEFAULT_CAPTURED_AT);

  // A snapshot that throws then records `at: null` rather than reading the clock.
  const broken = createObserver({ browser: controller(() => { throw new Error('down'); }), hash: PINNED_HASH });
  await broken.observe();
  assert.equal(broken.errors()[0].at, null);
});

test('the observation is deterministic across two identical calls with the same injected clock', async () => {
  const build = () => createObserver(options({
    browser: controller({ url: 'https://example.test/form', controls: [{ ref: 'c-1', name: 'Save', visible: true }] }),
    desktop: controller({ windows: [{ handle: 1, title: 'W', foreground: true }] }),
  }));
  const first = build();
  const second = build();
  assert.deepEqual(await first.observe({ taskId: 't' }), await second.observe({ taskId: 't' }));
  assert.deepEqual(await first.observe({ taskId: 't' }), await second.observe({ taskId: 't' }));
  // And the same call repeated on one observer only differs by its own events.
  const repeated = build();
  const one = await repeated.observe({ taskId: 't' });
  const two = await repeated.observe({ taskId: 't' });
  assert.deepEqual(two.systemEvents, []);
  assert.equal(one.signature, two.signature);
});
