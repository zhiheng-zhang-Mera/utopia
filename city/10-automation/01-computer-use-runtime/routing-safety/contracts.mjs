/**
 * UTOPIA · Automation — routing/safety contracts (local vocabulary).
 *
 * The routing, safety, modal and evidence modules of this building are ported
 * from the DS-Hns donor `app/computer-use/` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b. Their donor siblings
 * (`constants.cjs`, `errors.cjs`, `action.cjs`, `target.cjs`, `contract.cjs`)
 * are being ported concurrently and are NOT imported here. Everything this
 * module declares is a verbatim local redeclaration of the donor value the
 * ported files actually consumed, so the ported behaviour is byte-identical
 * without depending on a module that may land separately.
 *
 * Redeclared locally, all verbatim from the frozen donor:
 *   `constants.cjs`  → ACTION_TYPES, ROUTE_CHANNELS, VERIFICATION_KINDS,
 *                      DESTRUCTIVE_KINDS, DESTRUCTIVE_MODES
 *   `errors.cjs`     → CODES, ComputerUseError, redactDetails
 *   `action.cjs`     → describeAction, destructiveKinds
 *   `target.cjs`     → describeTarget
 *   `contract.cjs`   → hasCapability
 *
 * Nothing here is widened, narrowed or "fixed": the redundant `channel === 'api'`
 * test in `routing.cjs`, the unreachable `options.contract` safety toggles in
 * `safety.cjs` and the whole label precedence order in `modal.cjs` are donor
 * facts and are carried over as such.
 */

/** Action type → the channels that could possibly carry it, best first. */
export const ACTION_TYPES = Object.freeze({
  MOVE: 'MOVE',
  CLICK: 'CLICK',
  DOUBLE_CLICK: 'DOUBLE_CLICK',
  RIGHT_CLICK: 'RIGHT_CLICK',
  TYPE: 'TYPE',
  KEY_PRESS: 'KEY_PRESS',
  HOTKEY: 'HOTKEY',
  SCROLL: 'SCROLL',
  DRAG: 'DRAG',
  FOCUS: 'FOCUS',
  SELECT: 'SELECT',
  OPEN_APP: 'OPEN_APP',
  CLOSE_WINDOW: 'CLOSE_WINDOW',
  SWITCH_WINDOW: 'SWITCH_WINDOW',
  BROWSER_NAVIGATE: 'BROWSER_NAVIGATE',
  BROWSER_BACK: 'BROWSER_BACK',
  BROWSER_FORWARD: 'BROWSER_FORWARD',
  BROWSER_REFRESH: 'BROWSER_REFRESH',
  DOM_CLICK: 'DOM_CLICK',
  DOM_TYPE: 'DOM_TYPE',
  DOM_SELECT: 'DOM_SELECT',
  ACCESSIBILITY_INVOKE: 'ACCESSIBILITY_INVOKE',
  ACCESSIBILITY_SET_VALUE: 'ACCESSIBILITY_SET_VALUE',
  SHELL_EXEC: 'SHELL_EXEC',
  // File capability. The action list is a floor, not a ceiling: a filesystem
  // operation stays inside the Action Executor instead of becoming a side
  // channel the runtime cannot verify.
  FILE_READ: 'FILE_READ',
  FILE_WRITE: 'FILE_WRITE',
  FILE_COPY: 'FILE_COPY',
  FILE_MOVE: 'FILE_MOVE',
  FILE_DELETE: 'FILE_DELETE',
  FILE_MKDIR: 'FILE_MKDIR',
  FILE_EXISTS: 'FILE_EXISTS',
  WAIT_EVENT: 'WAIT_EVENT',
  WAIT_STATE: 'WAIT_STATE',
  SCREENSHOT_REGION: 'SCREENSHOT_REGION',
  SCREENSHOT_WINDOW: 'SCREENSHOT_WINDOW',
  SCREENSHOT_FULL: 'SCREENSHOT_FULL',
});

/**
 * The cost ladder. The router prefers the cheapest channel that can
 * actually carry the action: an API/shell path beats a DOM path, a DOM path
 * beats a GUI path, and "behave like a human" is the last resort.
 */
export const ROUTE_CHANNELS = Object.freeze(['api', 'file', 'shell', 'dom', 'accessibility', 'gui', 'vision']);

/** The verification kinds. */
export const VERIFICATION_KINDS = Object.freeze({
  DIRECT: 'direct',
  STATE: 'state',
  NAVIGATION: 'navigation',
  FILE: 'file',
  PROCESS: 'process',
  VISUAL: 'visual',
  FOCUS: 'focus',
  EVENT: 'event',
  NONE: 'none',
});

/** Destructive action families and the gate that guards them. */
export const DESTRUCTIVE_KINDS = Object.freeze([
  'DELETE',
  'PURCHASE',
  'SEND',
  'PUBLISH',
  'INSTALL',
  'UNINSTALL',
  'FORMAT',
  'ACCOUNT_CHANGE',
]);

/** How the contract treats a destructive action. */
export const DESTRUCTIVE_MODES = Object.freeze({
  ALLOWED: 'allowed',
  CONFIRM: 'confirm',
  FORBIDDEN: 'forbidden',
});

/**
 * The failure codes the ported modules can raise, copied verbatim from the donor
 * `errors.cjs`. Only the codes reachable from routing, safety, modal and evidence
 * are declared; the donor's full table is not reproduced because nothing here
 * reports the rest and an unreferenced constant would be a new surface.
 */
export const CODES = Object.freeze({
  // Controller availability and fault isolation
  CONTROLLER_UNAVAILABLE: 'CONTROLLER_UNAVAILABLE',
  // Action execution
  ACTION_UNSUPPORTED: 'ACTION_UNSUPPORTED',
  // Stabilization
  WINDOW_MISMATCH: 'WINDOW_MISMATCH',
  FOCUS_MISMATCH: 'FOCUS_MISMATCH',
  // Safety
  SAFETY_REFUSED: 'SAFETY_REFUSED',
  DESTRUCTIVE_FORBIDDEN: 'DESTRUCTIVE_FORBIDDEN',
  DESTRUCTIVE_NEEDS_CONFIRMATION: 'DESTRUCTIVE_NEEDS_CONFIRMATION',
  MODAL_BLOCKING: 'MODAL_BLOCKING',
});

/**
 * The donor's typed failure: a stable `code`, structured `details`, and a
 * `retryable` flag derived from the code.
 *
 * `defaultRetryable` is the subset of the donor table that the ported modules can
 * actually produce; the donor's rules for its other codes are out of scope here.
 */
export class ComputerUseError extends Error {
  /**
   * @param {string} code stable failure code, one of CODES
   * @param {string} message human readable detail (never carries secrets)
   * @param {object} [details] structured context for the log
   */
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'ComputerUseError';
    this.code = code;
    this.details = details;
    this.retryable = details.retryable === undefined ? defaultRetryable(code) : Boolean(details.retryable);
    this.controllerId = details.controllerId || null;
    this.state = details.state || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ComputerUseError);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      controllerId: this.controllerId,
      state: this.state,
      details: redactDetails(this.details),
    };
  }
}

/**
 * Which failures may be retried without a human, restricted to the codes the
 * ported modules raise. A blocking modal is worth another attempt; a refused
 * safety gate is not.
 */
function defaultRetryable(code) {
  switch (code) {
    case CODES.MODAL_BLOCKING:
      return true;
    default:
      return false;
  }
}

const SENSITIVE_KEY = /pass(word|phrase)|token|secret|api[-_]?key|credential|authorization|cookie/i;

/**
 * Passwords and tokens are never written to the execution log. The
 * redaction is applied to error details as well, because a typed password can
 * easily end up quoted inside a failure message.
 */
export function redactDetails(details) {
  if (details === null || details === undefined) return details;
  if (Array.isArray(details)) return details.map((item) => redactDetails(item));
  if (typeof details !== 'object') return details;
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEY.test(key)) out[key] = '[redacted]';
    else out[key] = redactDetails(value);
  }
  return out;
}

/** A short, log-safe description of the action (donor `action.cjs`). */
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

/** The executor asks this before running anything dangerous (donor `action.cjs`). */
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

/** A short label for the execution log. Never contains a coordinate unless the coordinate *is* the target (donor `target.cjs`). */
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

/** The contract check the router consumes (donor `contract.cjs`). */
export function hasCapability(contract, capability) {
  return contract.allowedCapabilities.includes(capability);
}
