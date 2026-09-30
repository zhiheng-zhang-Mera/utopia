/**
 * UTOPIA · 10-automation / Computer Use Runtime — world-verification test fixtures.
 *
 * Donor: DS-Hns `app/computer-use/world-state.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b. Shared by the four `*.test.mjs`
 * suites so the observation fixtures and the pinned instant/digest are stated
 * once. This file contains no assertions.
 *
 * Every fixture value is supplied through the port's injection points — `now`
 * and `hash` — so the pinned digest, the captured time and every signature are
 * deterministic. `PINNED_HASH` is the digest the tests pin; the donor's own
 * `sha1` is still exercised separately (and independently re-computed inside the
 * suites) so the injected digest never hides what the donor actually computes.
 */

import { createHash } from 'node:crypto';

/** The one instant every fixture observation is captured at. */
export const PINNED_AT = 1_760_000_000_000;

/** The instant of the later observation in the change/verification fixtures. */
export const PINNED_LATER_AT = 1_760_000_000_500;

/**
 * The injected digest: the donor's exact output shape — a 16-character
 * hexadecimal digest — computed over an uppercase variant of the same stable
 * text. It is therefore independent of `world-state.mjs` (the expected value can
 * never come from a module under test), injectable, and still discriminating:
 * a different revision, event or value produces a different digest.
 */
export const PINNED_HASH = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16).toUpperCase();

/** The donor-computed signatures of the baseline observation. */
export const PINNED_CONTROL_SIGNATURE = 'c30f443ac39023e4';
export const PINNED_WINDOW_SIGNATURE = 'f55a369c53ac6040';
export const PINNED_AX_SIGNATURE = '57a684bd0ee85e08';
export const PINNED_WORLD_SIGNATURE = '555be3c59a2d4c71';
export const PINNED_EVIDENCE_DIGEST = '94c811a4c158e64d';

/**
 * The same baseline observation with `PINNED_HASH` injected into
 * `createWorldState`. `evidenceDigest` takes its own `hash` option, so the
 * evidence digest of this world (computed with no option, i.e. the donor's
 * `sha1` over an injected signature) is `PINNED_INJECTED_EVIDENCE_DIGEST`.
 */
export const PINNED_INJECTED_CONTROL_SIGNATURE = 'C30F443AC39023E4';
export const PINNED_INJECTED_WINDOW_SIGNATURE = 'F55A369C53AC6040';
export const PINNED_INJECTED_AX_SIGNATURE = '57A684BD0EE85E08';
export const PINNED_INJECTED_WORLD_SIGNATURE = '389E336F9D472720';
export const PINNED_INJECTED_EVIDENCE_DIGEST = 'b80bb402bcc731a5';

/** The captured time of an observation with no injected clock and no `capturedAt`. */
export const DONOR_DEFAULT_CAPTURED_AT = 0;

export function browserParts(overrides = {}) {
  return {
    url: 'https://example.test/form',
    title: 'Example Form',
    readyState: 'complete',
    loading: false,
    revision: 41,
    focusedRef: 'c-2',
    controls: [
      { ref: 'c-1', role: 'button', name: 'Save', text: 'Save', visible: true, disabled: false },
      { ref: 'c-2', role: 'textbox', name: 'Email', value: 'a@b.test', visible: true, disabled: false },
      { ref: 'c-3', role: 'button', name: 'Ghost', visible: false, disabled: false },
      { ref: 'c-4', role: 'button', name: 'Off', visible: true, disabled: true },
    ],
    ax: [
      { ref: 'ax-1', role: 'button', name: 'Save', enabled: true, focused: false, bounds: { x: 1, y: 2, w: 3, h: 4 } },
      { ref: 'ax-2', role: 'status', name: 'Saved', value: null, enabled: true, focused: false },
    ],
    dialogs: [{ type: 'alert', message: 'Careful' }],
    source: { available: true, reason: null, backend: 'cdp' },
    ...overrides,
  };
}

export function desktopParts(overrides = {}) {
  return {
    activeApp: 'Example App',
    focusedRef: 'd-1',
    windows: [
      { handle: 1001, title: 'Example Form', processName: 'example.exe', processId: 4242, foreground: true, minimized: false, bounds: { x: 0, y: 0, w: 800, h: 600 } },
      { handle: 1002, title: 'Background', processName: 'other.exe', processId: 4343, foreground: false, minimized: true, bounds: { x: 10, y: 10, w: 400, h: 300 } },
    ],
    dialogs: [{ type: 'confirm', message: 'Proceed?' }],
    source: { available: true, reason: null, backend: 'uia' },
    ...overrides,
  };
}

export function systemParts(overrides = {}) {
  return {
    events: [
      { type: 'window_changed', detail: '1002->1001' },
      { name: 'focus_changed', detail: 'd-0->d-1' },
    ],
    source: { available: true, reason: null, backend: 'events' },
    ...overrides,
  };
}

/**
 * The parts the pinned world is built from: two dialogs, four controls (two of
 * them not visible targets), a foreground window, two system events, one note.
 *
 * `lastAction` is present and `lastActionType` / `lastActionResult` are absent —
 * that is what the donor's own world shape does (see the preserved-defect test).
 */
export function pinnedParts(overrides = {}) {
  return {
    taskId: 'task-7',
    capturedAt: PINNED_AT,
    browser: browserParts(),
    desktop: desktopParts(),
    system: systemParts(),
    lastAction: { type: 'CLICK', result: 'ok' },
    uiStable: true,
    notes: ['desktop observation failed: timeout'],
    ...overrides,
  };
}

/** A world stamped with one instant. */
export function worldAt(state, at) {
  return state(at);
}

/**
 * The verification fixtures: worlds that need nothing but the fields the
 * evaluator reads. They carry no signature, so `evidenceDigest` is computed from
 * `signature: undefined` — which is exactly what the donor does for a partial
 * observation.
 */
export function vworld(overrides = {}) {
  return {
    url: null,
    title: null,
    revision: null,
    focusedRef: null,
    focusedElement: null,
    controls: [],
    ax: [],
    windows: [],
    foreground: null,
    systemEvents: [],
    capturedAt: PINNED_AT,
    activeWindow: null,
    activeWindowHandle: null,
    signature: undefined,
    ...overrides,
  };
}

/** The verification clock, so `checkedAt` is a pinned number rather than the wall clock. */
export function pinnedClock(at = PINNED_AT) {
  return { now: () => at };
}

/** A monotonic clock starting at `start`, so successive `now()` calls differ. */
export function steppingClock(start = PINNED_AT, step = 5) {
  let value = start;
  return {
    now() {
      value += step;
      return value;
    },
  };
}
