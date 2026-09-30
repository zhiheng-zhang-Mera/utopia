/**
 * UTOPIA · Automation District — the Action Contract.
 *
 * Ported from the DS-Hns donor `app/computer-use/action.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (read in full). Parameter rules,
 * normalization order, exact message strings, closed expected-effect vocabulary
 * and destructive-kind derivation are the donor's, unchanged.
 *
 * Every interaction with the machine — a click, a keystroke, a shell command, a
 * screenshot — is described by *one* schema before anything happens. The
 * executor refuses to run an action it cannot validate, which is what keeps the
 * upper layers from smuggling a raw pyautogui-style script past the runtime:
 * an upper layer must never generate a pyautogui script directly.
 *
 * The schema is intentionally declarative: a target (how to find the thing), a
 * precondition (what must already be true), a stabilization window (how long to
 * let the UI settle), an expected effect (how success will be *verified*) and a
 * bounded retry budget. Verification is part of the action, never an
 * afterthought.
 *
 * TARGET DEPENDENCY SEAM. The donor `action.cjs` (and `contract.cjs`) imported
 * `normalizeTarget` / `describeTarget` from `app/computer-use/target.cjs`, which
 * the City manifest assigns to the sibling module `target-guard`, not to this
 * one. That whole file (the resolution ladder, revalidation thresholds and
 * matching) stays in `target-guard`'s boundary and is NOT ported here; the two
 * pure helpers this module consumes are reproduced below, verbatim in behaviour,
 * so the Action Contract keeps the donor's observable normalization. Their
 * `TARGET_INVALID` messages and `TARGET_KINDS` order are the donor's.
 */

import {
  ACTION_TYPES,
  ACTION_TYPE_LIST,
  ACTION_CAPABILITY,
  TIMING,
  RETRY,
  DESTRUCTIVE_KINDS
} from './contracts.mjs';
import { CODES, ComputerUseError } from './errors.mjs';

export const VALID_ACTION_TYPES = new Set(ACTION_TYPE_LIST);

/** Per-type parameter requirements, checked without guessing. */
export const PARAM_RULES = Object.freeze({
  [ACTION_TYPES.MOVE]: { any: ['point', 'target'] },
  [ACTION_TYPES.CLICK]: { any: ['target', 'point'] },
  [ACTION_TYPES.DOUBLE_CLICK]: { any: ['target', 'point'] },
  [ACTION_TYPES.RIGHT_CLICK]: { any: ['target', 'point'] },
  [ACTION_TYPES.TYPE]: { requires: ['text'] },
  [ACTION_TYPES.KEY_PRESS]: { requires: ['key'] },
  [ACTION_TYPES.HOTKEY]: { requires: ['keys'] },
  [ACTION_TYPES.SCROLL]: { any: ['target', 'point', 'dy', 'dx'], requires: [] },
  [ACTION_TYPES.DRAG]: { requires: ['from', 'to'] },
  [ACTION_TYPES.FOCUS]: { any: ['target', 'window'] },
  [ACTION_TYPES.SELECT]: { requires: ['target'], any: ['value', 'text', 'index'] },
  [ACTION_TYPES.OPEN_APP]: { requires: ['application'] },
  [ACTION_TYPES.CLOSE_WINDOW]: { any: ['target', 'window'], requires: [] },
  [ACTION_TYPES.SWITCH_WINDOW]: { any: ['target', 'window'], requires: [] },
  [ACTION_TYPES.BROWSER_NAVIGATE]: { requires: ['url'] },
  [ACTION_TYPES.BROWSER_BACK]: {},
  [ACTION_TYPES.BROWSER_FORWARD]: {},
  [ACTION_TYPES.BROWSER_REFRESH]: {},
  [ACTION_TYPES.DOM_CLICK]: { requires: ['target'] },
  [ACTION_TYPES.DOM_TYPE]: { requires: ['target'], any: ['text', 'value'] },
  [ACTION_TYPES.DOM_SELECT]: { requires: ['target'], any: ['value', 'text', 'index'] },
  [ACTION_TYPES.ACCESSIBILITY_INVOKE]: { requires: ['target'] },
  [ACTION_TYPES.ACCESSIBILITY_SET_VALUE]: { requires: ['target'], any: ['value', 'text'] },
  [ACTION_TYPES.SHELL_EXEC]: { requires: ['command'] },
  [ACTION_TYPES.FILE_READ]: { requires: ['path'] },
  [ACTION_TYPES.FILE_WRITE]: { requires: ['path'], any: ['content', 'text'] },
  [ACTION_TYPES.FILE_COPY]: { requires: ['path'], any: ['to', 'destination'] },
  [ACTION_TYPES.FILE_MOVE]: { requires: ['path'], any: ['to', 'destination'] },
  [ACTION_TYPES.FILE_DELETE]: { requires: ['path'] },
  [ACTION_TYPES.FILE_MKDIR]: { requires: ['path'] },
  [ACTION_TYPES.FILE_EXISTS]: { requires: ['path'] },
  [ACTION_TYPES.WAIT_EVENT]: { any: ['waitFor', 'event'] },
  [ACTION_TYPES.WAIT_STATE]: { any: ['expect', 'target', 'waitFor'] },
  [ACTION_TYPES.SCREENSHOT_REGION]: { any: ['target', 'clip', 'region'] },
  [ACTION_TYPES.SCREENSHOT_WINDOW]: { any: ['window', 'target'], requires: [] },
  [ACTION_TYPES.SCREENSHOT_FULL]: { requires: [] }
});

export const EXPECTED_EFFECT_KEYS = Object.freeze([
  'toast',
  'text_appears',
  'text_disappears',
  'control_state_changed',
  'target_disappears',
  'target_appears',
  'url_changed',
  'url_matches',
  'file_created',
  'file_modified',
  'file_exists',
  'file_missing',
  'process_exited',
  'exit_code',
  'stdout_matches',
  'stderr_matches',
  'focus_changed',
  'window_changed',
  'value_equals',
  'checked_equals',
  'dom_mutated',
  'navigation',
  'visual_change',
  'event'
]);

function invalid(message, details) {
  return new ComputerUseError(CODES.ACTION_INVALID, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes the many shapes an author may write into one action object.
 * Accepted inputs:
 *   - a bare action type string ('BROWSER_REFRESH')
 *   - `{ type, target, ... }`
 *   - `{ action: { type, target, ... } }` (the documented YAML shape)
 */
export function normalizeAction(input, options = {}) {
  if (typeof input === 'string') return buildAction({ type: input }, options);
  if (!isPlainObject(input)) throw invalid('an action must be an object or an action type string', { received: typeof input });
  const body = isPlainObject(input.action) ? { ...input.action, ...omit(input, ['action']) } : input;
  return buildAction(body, options);
}

function omit(object, keys) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (!keys.includes(key)) out[key] = value;
  return out;
}

function buildAction(body, options = {}) {
  const type = String(body.type || body.actionType || '').toUpperCase();
  if (!VALID_ACTION_TYPES.has(type)) {
    throw invalid(`unsupported action type: ${body.type || '(missing)'}`, { type: body.type || null, supported: ACTION_TYPE_LIST });
  }
  const target = body.target === undefined || body.target === null ? null : normalizeTarget(body.target);
  const params = {
    ...(isPlainObject(body.params) ? body.params : {}),
    ...collectParams(body, type)
  };
  const action = {
    type,
    capability: ACTION_CAPABILITY[type] || 'desktop',
    target,
    params,
    // precondition.target_exists / target_enabled are first-class.
    precondition: normalizePrecondition(body.precondition),
    stabilization: normalizeStabilization(body.stabilization, options),
    expectedEffect: normalizeExpectedEffect(body.expected_effect || body.expectedEffect),
    timeoutMs: positiveOr(body.timeout_ms ?? body.timeoutMs, TIMING.defaultActionTimeoutMs),
    retry: normalizeRetry(body.retry, options),
    destructive: normalizeDestructive(body.destructive || body.safety),
    id: body.id ? String(body.id) : null,
    description: body.description ? String(body.description) : null,
    // The log records what was asked for, not the secrets typed into it.
    sensitive: Boolean(body.sensitive || body.secret)
  };
  validateAction(action);
  return action;
}

function collectParams(body, type) {
  const params = {};
  const copy = [
    'point', 'clip', 'region', 'text', 'value', 'key', 'keys', 'url', 'command', 'args', 'cwd',
    'application', 'window', 'target', 'from', 'to', 'dx', 'dy', 'waitFor', 'event', 'expect',
    'timeout_ms', 'expectExitCode', 'shell', 'stdin', 'env', 'tabId', 'page', 'path', 'content',
    'destination', 'encoding', 'overwrite', 'recursive'
  ];
  for (const key of copy) {
    if (body[key] !== undefined) params[key] = body[key];
  }
  if (Array.isArray(body.keys)) params.keys = body.keys.map((key) => String(key));
  if (params.args !== undefined && !Array.isArray(params.args)) params.args = [String(params.args)];
  return params;
}

export function normalizePrecondition(input) {
  const raw = isPlainObject(input) ? input : {};
  return {
    targetExists: raw.target_exists === undefined ? true : Boolean(raw.target_exists),
    targetEnabled: raw.target_enabled === undefined ? true : Boolean(raw.target_enabled),
    targetVisible: raw.target_visible === undefined ? true : Boolean(raw.target_visible),
    windowForeground: raw.window_foreground === undefined ? null : Boolean(raw.window_foreground),
    focusMatches: raw.focus_matches === undefined ? null : Boolean(raw.focus_matches),
    custom: Array.isArray(raw.custom) ? raw.custom.slice() : []
  };
}

/**
 * The pre-action settling window. `minimum_ms` is what the author
 * asks for; it is clamped into the documented band so an action cannot order a
 * two-second sleep and call it stabilization.
 */
export function normalizeStabilization(input, options = {}) {
  const raw = isPlainObject(input) ? input : {};
  const min = numberOr(raw.minimum_ms ?? raw.minimumMs, null);
  const requested = min === null ? options.settleMinMs ?? TIMING.settleMinMs : min;
  const maximum = numberOr(raw.maximum_ms ?? raw.maximumMs, TIMING.settleMaxMs);
  return {
    minimumMs: clamp(requested, 0, TIMING.settleMaxMs),
    maximumMs: clamp(maximum, 0, TIMING.settleMaxMs),
    requireStable: raw.require_stable === undefined ? true : Boolean(raw.require_stable),
    waitForQuiet: raw.wait_for_quiet === undefined ? true : Boolean(raw.wait_for_quiet)
  };
}

export function normalizeExpectedEffect(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === 'string') return { any: [{ event: input }] };
  if (Array.isArray(input)) return { any: input.map(normalizeEffect) };
  if (!isPlainObject(input)) throw invalid('expected_effect must be an object, string or array', { received: typeof input });
  if (Array.isArray(input.any)) return { any: input.any.map(normalizeEffect), mode: 'any' };
  if (Array.isArray(input.all)) return { all: input.all.map(normalizeEffect), mode: 'all' };
  return { any: [normalizeEffect(input)], mode: 'any' };
}

function normalizeEffect(effect) {
  if (typeof effect === 'string') return { event: effect };
  if (!isPlainObject(effect)) throw invalid('an expected effect must be an object', { received: typeof effect });
  const out = {};
  for (const [key, value] of Object.entries(effect)) {
    const normalizedKey = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    if (!EXPECTED_EFFECT_KEYS.includes(normalizedKey)) {
      throw invalid(`unknown expected_effect key: ${key}`, { key, supported: EXPECTED_EFFECT_KEYS });
    }
    out[normalizedKey] = value;
  }
  if (!Object.keys(out).length) throw invalid('an expected effect needs at least one signal');
  return out;
}

export function normalizeRetry(input, options = {}) {
  const raw = isPlainObject(input) ? input : {};
  const maxAttempts = clamp(
    numberOr(raw.max_attempts ?? raw.maxAttempts, options.maxRetriesPerAction ?? RETRY.maxAttempts),
    0,
    5
  );
  return {
    maxAttempts,
    // The second attempt must not be a blind repeat — it uses a
    // different interaction channel where one exists.
    allowAlternative: raw.allow_alternative === undefined ? true : Boolean(raw.allow_alternative),
    backoffMs: clamp(numberOr(raw.backoff_ms ?? raw.backoffMs, TIMING.cooldownBaseMs), 0, TIMING.cooldownSoftMaxMs)
  };
}

export function normalizeDestructive(input) {
  if (input === true) return { kinds: ['DELETE'], explicit: true };
  if (input === false || input === undefined || input === null) return null;
  if (typeof input === 'string') return { kinds: [input.toUpperCase()], explicit: true };
  if (isPlainObject(input)) {
    const kinds = [];
    if (Array.isArray(input.kinds)) for (const kind of input.kinds) kinds.push(String(kind).toUpperCase());
    if (input.kind) kinds.push(String(input.kind).toUpperCase());
    for (const key of DESTRUCTIVE_KINDS) if (input[key.toLowerCase()] === true) kinds.push(key);
    return { kinds: kinds.length ? kinds : ['DELETE'], explicit: input.explicit === undefined ? true : Boolean(input.explicit) };
  }
  throw invalid('destructive must be a boolean, a kind string or an object', { received: typeof input });
}

/**
 * An action that is missing the thing it must act on is rejected at
 * build time, not discovered halfway through an execution run.
 */
export function validateAction(action) {
  const rules = PARAM_RULES[action.type] || {};
  for (const key of rules.requires || []) {
    const value = action.params[key];
    if (value === undefined || value === null || value === '') {
      throw invalid(`${action.type} requires "${key}"`, { type: action.type, missing: key });
    }
  }
  if (rules.any && rules.any.length) {
    const present = rules.any.some((key) => {
      const value = action.params[key] !== undefined ? action.params[key] : action.target;
      return value !== undefined && value !== null && value !== '';
    });
    if (!present) throw invalid(`${action.type} requires one of: ${rules.any.join(', ')}`, { type: action.type, requiredAny: rules.any });
  }
  if (action.type === ACTION_TYPES.TYPE && typeof action.params.text !== 'string') {
    throw invalid('TYPE requires text to be a string', { received: typeof action.params.text });
  }
  if (action.type === ACTION_TYPES.HOTKEY && (!Array.isArray(action.params.keys) || action.params.keys.length === 0)) {
    throw invalid('HOTKEY requires a non-empty keys array');
  }
  if (action.type === ACTION_TYPES.SHELL_EXEC && typeof action.params.command !== 'string') {
    throw invalid('SHELL_EXEC requires command to be a string');
  }
  if (action.stabilization.minimumMs > action.stabilization.maximumMs) {
    throw invalid('stabilization.minimum_ms may not exceed stabilization.maximum_ms', {
      minimumMs: action.stabilization.minimumMs,
      maximumMs: action.stabilization.maximumMs
    });
  }
  return action;
}

/** True when the action needs a resolved target before it can be executed. */
export function requiresTarget(action) {
  if (action.target) {
    return true;
  }
  return [ACTION_TYPES.CLICK, ACTION_TYPES.DOUBLE_CLICK, ACTION_TYPES.RIGHT_CLICK, ACTION_TYPES.DOM_CLICK,
    ACTION_TYPES.DOM_TYPE, ACTION_TYPES.DOM_SELECT, ACTION_TYPES.ACCESSIBILITY_INVOKE,
    ACTION_TYPES.ACCESSIBILITY_SET_VALUE, ACTION_TYPES.FOCUS, ACTION_TYPES.SELECT].includes(action.type);
}

/** A short, log-safe description of the action. */
export function describeAction(action) {
  const parts = [action.type];
  if (action.target) parts.push(describeTarget(action.target));
  const params = { ...action.params };
  if (typeof params.text === 'string') params.text = action.sensitive ? '[redacted]' : truncate(params.text, 60);
  if (typeof params.value === 'string' && action.sensitive) params.value = '[redacted]';
  if (params.command) params.command = truncate(params.command, 80);
  const keys = Object.keys(params);
  if (keys.length) parts.push(keys.map((key) => `${key}=${JSON.stringify(params[key])}`).join(' '));
  return parts.join(' ');
}

function truncate(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** The executor asks this before running anything dangerous. */
export function destructiveKinds(action) {
  if (action.destructive && Array.isArray(action.destructive.kinds) && action.destructive.kinds.length) {
    return action.destructive.kinds.slice();
  }
  const kinds = [];
  // A file deletion is a deletion, whether it is expressed as a structured
  // action or as a shell command.
  if (action.type === ACTION_TYPES.FILE_DELETE) kinds.push('DELETE');
  const command = String(action.params.command || '');
  if (action.type === ACTION_TYPES.SHELL_EXEC) {
    if (/\b(rm|del|erase|rmdir|rd|Remove-Item)\b/i.test(command)) kinds.push('DELETE');
    if (/\b(format|diskpart)\b/i.test(command)) kinds.push('FORMAT');
    if (/\b(npm i|npm install|pip install|winget install|choco install|Install-)\b/i.test(command)) kinds.push('INSTALL');
    if (/\b(git push)\b/i.test(command)) kinds.push('PUBLISH');
  }
  return kinds;
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------------- *
 * Target seam — donor `app/computer-use/target.cjs` (owned by `target-guard`).
 * Only the two pure helpers `action.cjs` / `contract.cjs` import are reproduced
 * here; the resolution ladder (`resolveTarget`), revalidation thresholds and
 * matching stay in the `target-guard` module's boundary.
 * ------------------------------------------------------------------------- */

/** The ladder, cheapest and most stable first. */
export const TARGET_KINDS = Object.freeze([
  { kind: 'selector', rank: 1, label: 'DOM selector' },
  { kind: 'accessibility', rank: 2, label: 'accessibility node' },
  { kind: 'semantic', rank: 3, label: 'semantic element' },
  // A window is a structured identifier too (title / handle / process), and it
  // is what FOCUS / SWITCH_WINDOW / CLOSE_WINDOW address.
  { kind: 'window', rank: 4, label: 'window' },
  { kind: 'bbox', rank: 5, label: 'bounding box' },
  // A visual description (paint colour or template) is how a canvas, a WebGL
  // surface or a custom-drawn control is addressed.
  { kind: 'visual', rank: 6, label: 'visual target' },
  { kind: 'point', rank: 7, label: 'visual coordinate' }
]);

const KIND_BY_NAME = new Map(TARGET_KINDS.map((entry) => [entry.kind, entry]));

function invalidTarget(message, details) {
  return new ComputerUseError(CODES.TARGET_INVALID, message, details);
}

/**
 * Accepts the many shapes an author writes (`"#save"`, `{ selector: '#save' }`,
 * `{ accessibility: { role, name } }`, `{ point: { x, y } }`, `{ text: 'Save' }`)
 * and produces one normalized target.
 */
export function normalizeTarget(input) {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) throw invalidTarget('a target string may not be empty');
    if (looksLikeSelector(trimmed)) return build({ selector: trimmed });
    return build({ semantic: { text: trimmed } });
  }
  if (Array.isArray(input)) {
    // An ordered list of candidate targets *is* the ladder written out by hand.
    const candidates = input.map((entry) => normalizeTarget(entry));
    return build({ candidates });
  }
  if (!isPlainObject(input)) throw invalidTarget('a target must be a string, object or array of candidates', { received: typeof input });

  const raw = input;
  const target = {};
  if (raw.selector) target.selector = String(raw.selector);
  if (raw.dom_selector) target.selector = String(raw.dom_selector);

  const accessibility = raw.accessibility || raw.ax || (raw.role || raw.automation_id || raw.automationId || raw.control_type ? raw : null);
  if (accessibility) {
    target.accessibility = compact({
      role: accessibility.role ? String(accessibility.role) : undefined,
      name: accessibility.name ? String(accessibility.name) : undefined,
      controlType: accessibility.control_type || accessibility.controlType ? String(accessibility.control_type || accessibility.controlType) : undefined,
      automationId: accessibility.automation_id || accessibility.automationId ? String(accessibility.automation_id || accessibility.automationId) : undefined,
      className: accessibility.class_name || accessibility.className ? String(accessibility.class_name || accessibility.className) : undefined,
      index: Number.isInteger(accessibility.index) ? accessibility.index : undefined,
      exact: accessibility.exact === undefined ? undefined : Boolean(accessibility.exact)
    });
  }

  const semanticSource = raw.semantic || (raw.text || raw.label || raw.placeholder ? raw : null);
  if (semanticSource) {
    target.semantic = compact({
      text: semanticSource.text ? String(semanticSource.text) : undefined,
      label: semanticSource.label ? String(semanticSource.label) : undefined,
      placeholder: semanticSource.placeholder ? String(semanticSource.placeholder) : undefined,
      role: semanticSource.role ? String(semanticSource.role) : undefined,
      name: semanticSource.name ? String(semanticSource.name) : undefined,
      inside: semanticSource.inside ? String(semanticSource.inside) : undefined
    });
  }

  if (raw.bbox || raw.box || raw.rect) target.bbox = normalizeRect(raw.bbox || raw.box || raw.rect);
  if (raw.visual || raw.paint || raw.template) {
    const visual = raw.visual || { paint: raw.paint, template: raw.template, templatePath: raw.template_path };
    target.visual = compact({
      paint: visual.paint || visual.color
        ? compact({
            color: visual.paint ? (visual.paint.color || visual.paint) : visual.color,
            width: visual.paint && visual.paint.width ? Number(visual.paint.width) : undefined,
            height: visual.paint && visual.paint.height ? Number(visual.paint.height) : undefined,
            tolerance: visual.paint && visual.paint.tolerance !== undefined ? Number(visual.paint.tolerance) : undefined
          })
        : undefined,
      templatePath: visual.templatePath || visual.template_path ? String(visual.templatePath || visual.template_path) : undefined,
      template: visual.template && !visual.templatePath ? visual.template : undefined,
      threshold: visual.threshold !== undefined ? Number(visual.threshold) : undefined,
      search: visual.search || undefined,
      level: Number.isInteger(visual.level) ? visual.level : undefined
    });
  }
  if (raw.point || raw.coordinate || raw.coordinates) target.point = normalizePoint(raw.point || raw.coordinate || raw.coordinates);
  if (raw.x !== undefined && raw.y !== undefined) target.point = normalizePoint({ x: raw.x, y: raw.y });
  if (raw.window) target.window = normalizeWindowRef(raw.window);
  if (raw.page || raw.tab || raw.tabId) target.page = String(raw.page || raw.tab || raw.tabId);
  if (raw.ref) target.ref = String(raw.ref);
  if (Array.isArray(raw.candidates)) target.candidates = raw.candidates.map((entry) => normalizeTarget(entry));
  if (raw.description) target.description = String(raw.description);

  return build(target);
}

function build(target) {
  const kinds = targetKinds(target);
  if (!kinds.length) {
    throw invalidTarget('a target must carry at least one of: selector, accessibility, semantic, window, bbox, point, ref', { received: target });
  }
  return {
    ...target,
    kinds,
    // The declared rank is the best (lowest) rank present, which is what the
    // execution log records as "how this target was addressed".
    rank: Math.min(...kinds.map((kind) => KIND_BY_NAME.get(kind).rank)),
    primaryKind: kinds[0]
  };
}

/** Every addressing mode present on the target, best first. */
function targetKinds(target) {
  const kinds = [];
  if (target.ref) kinds.push('accessibility');
  if (target.selector) kinds.push('selector');
  if (target.accessibility) kinds.push('accessibility');
  if (target.semantic) kinds.push('semantic');
  // A window is a *locator context* when another rung is present ("this point
  // inside that window", "this painted control in that window"); it is only a
  // standalone target when it is all the target says.
  const specific = target.selector || target.accessibility || target.semantic || target.visual || target.bbox || target.point || target.ref;
  if (target.window && !specific) kinds.push('window');
  if (target.bbox) kinds.push('bbox');
  if (target.visual) kinds.push('visual');
  if (target.point) kinds.push('point');
  if (target.candidates && target.candidates.length) for (const candidate of target.candidates) for (const kind of candidate.kinds) if (!kinds.includes(kind)) kinds.push(kind);
  return [...new Set(kinds)].sort((a, b) => KIND_BY_NAME.get(a).rank - KIND_BY_NAME.get(b).rank);
}

function normalizeRect(rect) {
  if (!isPlainObject(rect)) throw invalidTarget('bbox must be an object with x, y, width, height', { received: typeof rect });
  const x = Number(rect.x ?? rect.left);
  const y = Number(rect.y ?? rect.top);
  const width = Number(rect.width ?? rect.w);
  const height = Number(rect.height ?? rect.h);
  if (![x, y, width, height].every(Number.isFinite)) throw invalidTarget('bbox needs finite x, y, width and height', { received: rect });
  if (width <= 0 || height <= 0) throw invalidTarget('bbox must have a positive width and height', { received: rect });
  return { x, y, width, height };
}

function normalizePoint(point) {
  if (!isPlainObject(point)) throw invalidTarget('point must be an object with x and y', { received: typeof point });
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw invalidTarget('point needs finite x and y', { received: point });
  return { x, y };
}

function normalizeWindowRef(window) {
  if (typeof window === 'string') return { title: window };
  if (!isPlainObject(window)) throw invalidTarget('window must be a string or an object', { received: typeof window });
  return compact({
    title: window.title ? String(window.title) : undefined,
    handle: window.handle !== undefined ? String(window.handle) : undefined,
    processId: Number.isInteger(window.processId) ? window.processId : Number.isInteger(window.pid) ? window.pid : undefined,
    className: window.className ? String(window.className) : undefined,
    process: window.process ? String(window.process) : undefined
  });
}

function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}

function looksLikeSelector(text) {
  return /^[#.[][^\s]*$/.test(text) || /^[a-z][a-z0-9-]*(\[[^\]]*\])?$/.test(text) || text.includes('>') || text.includes('#') && !text.includes(' ');
}

/** A short label for the execution log. Never contains a coordinate unless the coordinate *is* the target. */
export function describeTarget(target) {
  if (!target) return '(no target)';
  if (target.selector) return `selector:${target.selector}`;
  if (target.accessibility) {
    const ax = target.accessibility;
    return `ax:${[ax.role, ax.name, ax.automationId].filter(Boolean).join('/') || '(any)'}`;
  }
  if (target.semantic) return `semantic:${target.semantic.text || target.semantic.label || target.semantic.name || target.semantic.placeholder}`;
  if (target.window) return `window:${target.window.title || target.window.handle || target.window.process || '(any)'}`;
  if (target.visual) return `visual:${target.visual.paint ? JSON.stringify(target.visual.paint.color) : 'template'}`;
  if (target.bbox) return `bbox:${target.bbox.x},${target.bbox.y},${target.bbox.width}x${target.bbox.height}`;
  if (target.point) return `point:${target.point.x},${target.point.y}`;
  return '(unresolved)';
}
