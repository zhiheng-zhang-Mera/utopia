/**
 * UTOPIA · 10-automation / Computer Use Runtime — World State.
 *
 * Donor: DS-Hns `app/computer-use/world-state.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b. Ported behaviour is otherwise
 * unchanged; the one interface change is the mandatory purity adaptation
 * documented below, and it is the only one.
 *
 * Perception from every source is folded into one short-lived structure that
 * serves the *current* task: what app is in front, what page is loaded, which
 * control has focus, which targets are reachable, what the system just did.
 *
 * Two rules are enforced here rather than promised in prose:
 *
 *  - The world state is discarded when the task ends. `discardWorldState()`
 *    erases the contents, and nothing in this module writes to disk, so there
 *    is no path from "observed the UI" to "learned the application".
 *  - Progress is judged on *meaningful* change, not on any change.
 *    A spinner that mutates the DOM forever must not look like progress, while a
 *    toast, a navigation, a window switch or a control state flip must.
 *
 * PURITY ADAPTATION (the one interface change, recorded in `DONOR.json`):
 * the donor calls `crypto.createHash('sha1')` at :155 and reads `Date.now()`
 * directly at :57 with no injection point. This port exposes both — `hash` for
 * the digest and `now` for the captured time — so the digest and the captured
 * timestamp are deterministic in tests. When a hash is supplied the donor's exact
 * algorithm and output format are kept, and one is supplied by default: the
 * donor's own `sha1` hex, truncated to 16 characters. `now` defaults to
 * `DONOR_DEFAULT_CAPTURED_AT` instead of `Date.now()`, because this module may
 * not read the wall clock. See `DONOR.json` `adaptation` for the full statement.
 */

import { createHash } from 'node:crypto';

/**
 * The digest the donor computes: `sha1` of the stable stringification, hex, first
 * 16 characters. Injected wherever a digest is produced; deterministic by
 * construction.
 *
 * @param {string} text
 * @returns {string}
 */
function sha1Signature(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/**
 * The captured time used when the caller injects none.
 *
 * The donor read `Date.now()` here; a pure port may not read the wall clock, so
 * an observation with no injected time is stamped with this fixed value rather
 * than with the current instant. Every caller that cares about the time (the
 * observer) injects `now`.
 */
export const DONOR_DEFAULT_CAPTURED_AT = 0;

export const MEANINGFUL_FIELDS = Object.freeze([
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

/**
 * Reads the injected time function, or `null` when none was supplied.
 *
 * @param {object} [options]
 * @returns {Function|null}
 */
function injectedNow(options) {
  return options && typeof options.now === 'function' ? options.now : null;
}

/**
 * Reads the injected digest function, or the donor's own `sha1` when none was
 * supplied.
 *
 * @param {object} [options]
 * @returns {(text: string) => string}
 */
function injectedHash(options) {
  return options && typeof options.hash === 'function' ? options.hash : sha1Signature;
}

/**
 * Builds a world state from whatever the observation sources managed to
 * collect. Missing sources are recorded as unavailable, with their reason —
 * they must never be silently replaced by a guess.
 *
 * @param {object} [parts] what the observation sources collected
 * @param {object} [options]
 * @param {Function} [options.now] injected clock, used when `parts.capturedAt` is absent
 * @param {Function} [options.hash] injected digest, used for every signature
 * @returns {import('./contracts.mjs').WorldState}
 */
export function createWorldState(parts = {}, options = {}) {
  const hash = injectedHash(options);
  const now = injectedNow(options);
  const browser = parts.browser || {};
  const desktop = parts.desktop || {};
  const system = parts.system || {};
  const controls = Array.isArray(browser.controls) ? browser.controls.filter(Boolean) : [];
  const ax = Array.isArray(browser.ax) ? browser.ax.filter(Boolean) : Array.isArray(desktop.ax) ? desktop.ax.filter(Boolean) : [];
  const windows = Array.isArray(desktop.windows) ? desktop.windows.filter(Boolean) : [];
  const foreground = desktop.foreground || windows.find((window) => window.foreground) || null;
  const dialogs = [
    ...(Array.isArray(browser.dialogs) ? browser.dialogs : []),
    ...(Array.isArray(desktop.dialogs) ? desktop.dialogs : []),
  ];
  const world = {
    taskId: parts.taskId || null,
    capturedAt: Number.isFinite(parts.capturedAt) ? parts.capturedAt : now ? now() : DONOR_DEFAULT_CAPTURED_AT,
    revision: Number.isFinite(browser.revision) ? browser.revision : null,

    activeApp: parts.activeApp || desktop.activeApp || (foreground ? foreground.processName || foreground.className || null : null),
    activeWindow: foreground ? foreground.title || null : null,
    activeWindowHandle: foreground ? String(foreground.handle) : null,
    foregroundProcessId: foreground ? foreground.processId ?? null : null,
    url: typeof browser.url === 'string' ? browser.url : null,
    title: typeof browser.title === 'string' ? browser.title : null,
    readyState: browser.readyState || null,
    loading: Boolean(browser.loading),
    focusedRef: browser.focusedRef || desktop.focusedRef || null,
    focusedElement: parts.focusedElement || describeFocused(controls, browser.focusedRef) || (desktop.focusedElement || null),

    controls,
    visibleTargets: Array.isArray(parts.visibleTargets) ? parts.visibleTargets.filter(Boolean) : defaultVisibleTargets(controls),
    ax,
    windows,
    foreground,
    dialogs,

    systemEvents: Array.isArray(system.events) ? system.events : [],
    lastAction: parts.lastAction || null,
    uiStable: parts.uiStable === undefined ? null : Boolean(parts.uiStable),
    confidence: 0,
    sources: {
      browser: normalizeSource(browser.source, { available: browser.available !== false, reason: browser.reason || null }),
      desktop: normalizeSource(desktop.source, { available: desktop.available !== false, reason: desktop.reason || null }),
      system: normalizeSource(system.source, { available: system.available !== false, reason: system.reason || null }),
    },
    notes: Array.isArray(parts.notes) ? parts.notes.slice(0, 20) : [],
  };
  world.confidence = computeConfidence(world);
  world.dialogSignature = dialogs.map((dialog) => `${dialog.type || 'dialog'}:${dialog.message || ''}`).join('|');
  world.controlSignature = signatureOf(controls, hash);
  world.windowSignature = signatureOf(
    windows.map((window) => ({
      handle: String(window.handle),
      title: window.title,
      bounds: window.bounds,
      foreground: Boolean(window.foreground),
      minimized: Boolean(window.minimized),
    })),
    hash,
  );
  world.axSignature = signatureOf(
    ax.slice(0, 200).map((node) => ({
      ref: node.ref,
      role: node.role,
      name: node.name,
      value: node.value,
      enabled: node.enabled,
      focused: node.focused,
      bounds: node.bounds,
    })),
    hash,
  );
  world.signature = signatureOf(pickMeaningful(world), hash);
  return world;
}

function describeFocused(controls, focusedRef) {
  if (!focusedRef) return null;
  const match = controls.find((control) => control.ref === focusedRef);
  if (!match) return { ref: focusedRef };
  return { ref: match.ref, role: match.role, name: match.name, value: match.value === undefined ? null : match.value };
}

function normalizeSource(source, fallback) {
  if (source && typeof source === 'object') {
    return { available: Boolean(source.available), reason: source.reason || null, backend: source.backend || null };
  }
  return { available: Boolean(fallback.available), reason: fallback.reason || null, backend: null };
}

function defaultVisibleTargets(controls) {
  return controls.filter((control) => control.visible !== false && control.disabled !== true);
}

/**
 * Confidence: how much of the picture is actually structured and
 * current. A screenshot-only world state is possible but is reported as low
 * confidence instead of being mistaken for structured knowledge.
 */
export function computeConfidence(world) {
  let score = 0;
  let weight = 0;
  const add = (value, amount) => {
    weight += amount;
    if (value === true) score += amount;
  };
  add(world.sources.browser.available, 0.3);
  add(Boolean(world.url), 0.1);
  add(world.sources.desktop.available, 0.25);
  add(Boolean(world.foreground), 0.1);
  add(world.sources.system.available, 0.1);
  add(world.controls.length > 0 || world.ax.length > 0 || world.windows.length > 0, 0.1);
  add(world.dialogs.length === 0, 0.05);
  const raw = weight ? score / weight : 0;
  return Math.round(raw * 100) / 100;
}

/**
 * @param {*} value
 * @param {(text: string) => string} [hash] injected digest; defaults to the donor's sha1
 * @returns {string|null} the donor's 16-character signature, or null when it cannot be computed
 */
export function signatureOf(value, hash = sha1Signature) {
  try {
    return hash(stableStringify(value));
  } catch {
    return null;
  }
}

export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function pickMeaningful(world) {
  const picked = {};
  for (const field of MEANINGFUL_FIELDS) {
    if (world[field] !== undefined) picked[field] = world[field];
  }
  return picked;
}

/**
 * Did anything *meaningful* change between two observations?
 *
 * Two things are deliberately excluded. DOM revision churn, because an
 * animation loop must not be able to hide a stalled task. And the runtime's own
 * bookkeeping (`lastAction`), because the action we just issued is not a change
 * in the environment — counting it would make every step look like progress and
 * stall detection could never fire.
 */
export function meaningfulChange(previous, next) {
  if (!previous) return { changed: true, fields: ['<first observation>'], meaningful: true };
  if (!next) return { changed: true, fields: ['<observation lost>'], meaningful: true };
  const fields = [];
  const compare = (name, a, b) => {
    if (a === b) return;
    if (a === undefined && b === undefined) return;
    fields.push(name);
  };
  for (const field of MEANINGFUL_FIELDS) {
    compare(field, previous[field], next[field]);
  }
  return { changed: fields.length > 0, fields, meaningful: fields.length > 0 };
}

/**
 * The broad evidence digest, used by verification rather than by
 * stall detection: it includes DOM revision and the event stream, because a
 * mutation *is* evidence that something happened.
 *
 * @param {import('./contracts.mjs').WorldState|null} world
 * @param {object} [options]
 * @param {Function} [options.hash] injected digest; defaults to the donor's sha1
 */
export function evidenceDigest(world, options = {}) {
  if (!world) return null;
  return signatureOf(
    {
      signature: world.signature,
      revision: world.revision,
      events: (world.systemEvents || []).map((event) => `${event.type || event.name}:${event.detail || ''}`),
      value: world.focusedElement ? world.focusedElement.value : null,
    },
    injectedHash(options),
  );
}

/** Compact, log-safe summary (a step log carries a summary, not the tree). */
export function summarizeWorldState(world) {
  if (!world) return null;
  return {
    activeApp: world.activeApp,
    activeWindow: world.activeWindow,
    url: world.url,
    title: world.title,
    readyState: world.readyState,
    loading: world.loading,
    focused: world.focusedElement ? `${world.focusedElement.role || '?'}:${world.focusedElement.name || world.focusedElement.ref || ''}` : null,
    controls: world.controls.length,
    axNodes: world.ax.length,
    windows: world.windows.length,
    dialogs: world.dialogs.length,
    uiStable: world.uiStable,
    confidence: world.confidence,
    revision: world.revision,
    signature: world.signature,
    // A degraded source is part of the step's pre-state: a summary that hides
    // "the desktop controller timed out" would hide the reason a step failed.
    notes: world.notes && world.notes.length ? world.notes.slice(0, 5) : undefined,
  };
}

/**
 * A task's world state is dropped when the task ends. The object is
 * emptied (not just dereferenced) so a stale reference cannot keep observing.
 */
export function discardWorldState(world) {
  if (!world) return null;
  const summary = summarizeWorldState(world);
  world.discarded = true;
  world.controls = [];
  world.visibleTargets = [];
  world.ax = [];
  world.windows = [];
  world.systemEvents = [];
  world.dialogs = [];
  world.focusedElement = null;
  world.url = null;
  world.title = null;
  world.foreground = null;
  world.signature = null;
  return summary;
}
