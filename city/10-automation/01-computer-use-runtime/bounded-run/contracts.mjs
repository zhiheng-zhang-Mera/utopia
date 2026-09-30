/**
 * UTOPIA · 10-automation / Computer Use Runtime — bounded-run contracts.
 *
 * The vocabulary the ported stall detector, state machine, recovery ladder,
 * stabilizer, reconnect policy, health snapshot and resource budget agree on,
 * plus the one typed failure they all raise.
 *
 * Donor: DS-Hns `app/computer-use/constants.cjs` and `app/computer-use/errors.cjs`
 * @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 *
 * Local declaration, not import. The donor does
 *    const { CU_STATES, CU_TRANSITIONS, TERMINAL_STATES } = require('./constants.cjs')
 *    const { CODES, ComputerUseError } = require('./errors.cjs')
 * and every sibling module is being ported concurrently by another agent writing
 * to another directory in this same tree. To stay loadable on its own, the seven
 * ported files declare the values they read here instead of importing a sibling.
 * Nothing is extended:
 *
 *   - `CU_STATES` / `CU_TRANSITIONS` / `TERMINAL_STATES` are the donor's closed
 *     machine, carried edge for edge (donor `constants.cjs` lines 142-185).
 *   - `TARGET_MOVEMENT`, `TIMING`, `STALL`, `RETRY`, `SCREENSHOT_LEVELS`,
 *     `SCREENSHOT_RETENTION`, `DESTRUCTIVE_MODES`, `CAPABILITY_CONTROLLER`,
 *     `ACTION_CAPABILITY` and the action-type strings are the donor's frozen
 *     values, verbatim.
 *   - `CODES` carries exactly the donor code strings these modules raise or
 *     compare against, including the deliberately duplicated values
 *     (`TRANSPORT_LOST === CONTROLLER_UNAVAILABLE`, `MODAL_REQUIRES_USER ===
 *     MODAL_BLOCKING`).
 *   - `ComputerUseError` is the donor class, field for field, including
 *     `defaultRetryable()` and the detail redaction its `toJSON()` applies.
 *
 * The donor `constants.cjs` also reads `config/app.json` and resolves runtime
 * options; none of that is here, because a bounded-run module takes its limits as
 * an injected `options` argument and owns no filesystem or clock of its own.
 */

/**
 * The action surface. Only the types the recovery ladder maps or inspects are
 * named here; the donation of the full surface belongs to `execution-contract`.
 */
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
 * Which capability owns an action.
 *
 * Declared so `channelHintFor()` can answer for an action that declares no
 * capability of its own: the donor's hint ladder is
 * `run.lastRoute.controller` → `CAPABILITY_CONTROLLER[action.capability]`, and
 * this table is the third rung the donor's `ACTION_CAPABILITY` feeds.
 */
export const ACTION_CAPABILITY = Object.freeze({
  MOVE: 'desktop',
  CLICK: 'desktop',
  DOUBLE_CLICK: 'desktop',
  RIGHT_CLICK: 'desktop',
  TYPE: 'desktop',
  KEY_PRESS: 'desktop',
  HOTKEY: 'desktop',
  SCROLL: 'desktop',
  DRAG: 'desktop',
  FOCUS: 'desktop',
  SELECT: 'desktop',
  OPEN_APP: 'desktop',
  CLOSE_WINDOW: 'desktop',
  SWITCH_WINDOW: 'desktop',
  BROWSER_NAVIGATE: 'browser',
  BROWSER_BACK: 'browser',
  BROWSER_FORWARD: 'browser',
  BROWSER_REFRESH: 'browser',
  DOM_CLICK: 'browser',
  DOM_TYPE: 'browser',
  DOM_SELECT: 'browser',
  ACCESSIBILITY_INVOKE: 'desktop',
  ACCESSIBILITY_SET_VALUE: 'desktop',
  SHELL_EXEC: 'shell',
  FILE_READ: 'filesystem',
  FILE_WRITE: 'filesystem',
  FILE_COPY: 'filesystem',
  FILE_MOVE: 'filesystem',
  FILE_DELETE: 'filesystem',
  FILE_MKDIR: 'filesystem',
  FILE_EXISTS: 'filesystem',
  WAIT_EVENT: 'desktop',
  WAIT_STATE: 'desktop',
  SCREENSHOT_REGION: 'vision',
  SCREENSHOT_WINDOW: 'vision',
  SCREENSHOT_FULL: 'vision',
});

/**
 * Which controller carries which capability's channel.
 *
 * Used as the reconnect channel hint: a transport failure is attributed to the
 * controller that was carrying the action, and the reconnect budget is spent per
 * channel. A capability nobody carries is `null` rather than a guess.
 */
export const CAPABILITY_CONTROLLER = Object.freeze({
  browser: 'browser',
  dom: 'browser',
  desktop: 'desktop',
  accessibility: 'desktop',
  vision: 'vision',
  screenshot: 'vision',
  shell: 'shell',
  process: 'shell',
  filesystem: 'file',
  file: 'file',
});

/** The complete state machine. */
export const CU_STATES = Object.freeze({
  IDLE: 'IDLE',
  RECEIVING_TASK: 'RECEIVING_TASK',
  OBSERVING: 'OBSERVING',
  PLANNING_ACTION: 'PLANNING_ACTION',
  STABILIZING: 'STABILIZING',
  REVALIDATING: 'REVALIDATING',
  ACTING: 'ACTING',
  POST_ACTION_GRACE: 'POST_ACTION_GRACE',
  VERIFYING: 'VERIFYING',
  RETRYING: 'RETRYING',
  RECOVERING: 'RECOVERING',
  REPLANNING: 'REPLANNING',
  STALLED: 'STALLED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

/**
 * The legal transitions. `COMPLETED` and `FAILED` are terminal: a task that ended
 * cannot silently re-enter the loop, it has to be re-issued as a new task.
 *
 * Edge for edge with the donor, including the two empty terminal lists and the
 * exact order of each list — the order is what an "allowed" error message shows.
 */
export const CU_TRANSITIONS = Object.freeze({
  IDLE: ['RECEIVING_TASK'],
  RECEIVING_TASK: ['OBSERVING', 'FAILED'],
  OBSERVING: ['PLANNING_ACTION', 'COMPLETED', 'FAILED'],
  PLANNING_ACTION: ['STABILIZING', 'COMPLETED', 'REPLANNING', 'FAILED'],
  STABILIZING: ['REVALIDATING', 'OBSERVING', 'RETRYING', 'RECOVERING', 'FAILED'],
  REVALIDATING: ['ACTING', 'OBSERVING', 'RETRYING', 'RECOVERING', 'FAILED'],
  ACTING: ['POST_ACTION_GRACE', 'RETRYING', 'RECOVERING', 'FAILED'],
  POST_ACTION_GRACE: ['VERIFYING', 'RETRYING', 'FAILED'],
  VERIFYING: ['OBSERVING', 'RETRYING', 'RECOVERING', 'REPLANNING', 'STALLED', 'COMPLETED', 'FAILED'],
  RETRYING: ['STABILIZING', 'RECOVERING', 'REPLANNING', 'OBSERVING', 'PLANNING_ACTION', 'FAILED'],
  RECOVERING: ['OBSERVING', 'STABILIZING', 'RETRYING', 'REPLANNING', 'PLANNING_ACTION', 'STALLED', 'FAILED'],
  REPLANNING: ['OBSERVING', 'PLANNING_ACTION', 'FAILED'],
  STALLED: ['OBSERVING', 'STABILIZING', 'PLANNING_ACTION', 'RECOVERING', 'REPLANNING', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
});

export const TERMINAL_STATES = Object.freeze([CU_STATES.COMPLETED, CU_STATES.FAILED]);

/** Screenshot levels, cheapest first. */
export const SCREENSHOT_LEVELS = Object.freeze({ NONE: 0, REGION: 1, WINDOW: 2, FULL: 3 });

/**
 * How the contract treats a destructive action.
 *
 * Declared locally even though nothing in this module reads it yet: the recovery
 * ladder's `USER_ACTION_CODES` comment is written in terms of it and
 * `execution-contract` is the module that owns the gate.
 */
export const DESTRUCTIVE_MODES = Object.freeze({
  ALLOWED: 'allowed',
  CONFIRM: 'confirm',
  FORBIDDEN: 'forbidden',
});

/** When a screenshot may be written to disk. */
export const SCREENSHOT_RETENTION = Object.freeze({
  DEBUG: 'debug',
  AUDIT: 'audit',
  FAILURE: 'failure',
  REQUESTED: 'requested',
  NEVER: 'never',
});

/**
 * The "stable target" thresholds, in CSS pixels.
 * `movement < stablePx` → the target is where it was;
 * `stablePx <= movement <= updatePx` → act on the refreshed coordinate;
 * `movement > updatePx` → the target is stale, re-observe instead of clicking.
 */
export const TARGET_MOVEMENT = Object.freeze({ stablePx: 3, updatePx: 10 });

/**
 * Timing policy. These are *ceilings*, not sleeps: the stabilizer always prefers
 * an event wait and only ever spends a bounded forced delay. `cooldownHardMaxMs`
 * is what stops the "add another 80 ms" ladder from turning into a sleep loop.
 */
export const TIMING = Object.freeze({
  settleMinMs: 50,
  settlePreferredMs: 100,
  settleComplexMs: 200,
  settleMaxMs: 300,
  graceMinMs: 80,
  gracePreferredMs: 150,
  graceMaxMs: 250,
  cooldownBaseMs: 80,
  cooldownStepMs: 80,
  cooldownSoftMaxMs: 400,
  cooldownHardMaxMs: 500,
  navigationCooldownMs: 800,
  navigationCooldownMaxMs: 1000,
  eventPollMs: 40,
  defaultActionTimeoutMs: 3000,
  defaultWaitTimeoutMs: 5000,
  appStartTimeoutMs: 20000,
});

/**
 * A stall is N consecutive actions with no meaningful state change. The recovery
 * ladder is bounded, so an unresponsive page ends in FAIL_WITH_CONTEXT instead of
 * an infinite retry loop.
 */
export const STALL = Object.freeze({ consecutiveActions: 3, maxRecoveries: 2 });

/** Retry policy per action. */
export const RETRY = Object.freeze({ maxAttempts: 2, alternateAtAttempt: 2 });

/**
 * Every failure carries a stable `code` so the execution log, the recovery ladder
 * and the acceptance harness can reason about *what* failed without parsing
 * English.
 *
 * Only the codes the seven ported files raise or compare against are declared.
 * The two aliases the donor spells out as duplicates are kept as duplicates.
 */
export const CODES = Object.freeze({
  // Contract and task intake
  CONTRACT_INVALID: 'CONTRACT_INVALID',
  // Plan selection
  PLAN_EXHAUSTED: 'PLAN_EXHAUSTED',
  // State machine
  STATE_INVALID: 'STATE_INVALID',
  STATE_TRANSITION_INVALID: 'STATE_TRANSITION_INVALID',
  // Target resolution
  TARGET_STALE: 'TARGET_STALE',
  TARGET_NOT_ACTIONABLE: 'TARGET_NOT_ACTIONABLE',
  // Controller availability and fault isolation
  CONTROLLER_UNAVAILABLE: 'CONTROLLER_UNAVAILABLE',
  TRANSPORT_LOST: 'CONTROLLER_UNAVAILABLE',
  CONTROLLER_FAILED: 'CONTROLLER_FAILED',
  CONTROLLER_TIMEOUT: 'CONTROLLER_TIMEOUT',
  CAPABILITY_NOT_ALLOWED: 'CAPABILITY_NOT_ALLOWED',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  // Action execution
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  // Verification and miss detection
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  VERIFICATION_UNKNOWN: 'VERIFICATION_UNKNOWN',
  ACTION_MISSED: 'ACTION_MISSED',
  // Stabilization
  UI_UNSTABLE: 'UI_UNSTABLE',
  WINDOW_MISMATCH: 'WINDOW_MISMATCH',
  // Safety
  SAFETY_REFUSED: 'SAFETY_REFUSED',
  DESTRUCTIVE_FORBIDDEN: 'DESTRUCTIVE_FORBIDDEN',
  DESTRUCTIVE_NEEDS_CONFIRMATION: 'DESTRUCTIVE_NEEDS_CONFIRMATION',
  MODAL_BLOCKING: 'MODAL_BLOCKING',
  MODAL_REQUIRES_USER: 'MODAL_BLOCKING',
  // Stalls and bounds
  STALL_DETECTED: 'STALL_DETECTED',
  // Long-running execution
  WORKSPACE_UNAVAILABLE: 'WORKSPACE_UNAVAILABLE',
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',
  PROCESS_LOST: 'PROCESS_LOST',
  EVIDENCE_INSUFFICIENT: 'EVIDENCE_INSUFFICIENT',
  RECONNECT_EXHAUSTED: 'RECONNECT_EXHAUSTED',
  STATE_INTEGRITY_UNCERTAIN: 'STATE_INTEGRITY_UNCERTAIN',
});

/**
 * The donor's typed failure. Field for field: `name`, `code`, `details`,
 * `retryable` (from `defaultRetryable()` unless the details say otherwise),
 * `controllerId`, `state`, and the redacted JSON view.
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
 * Which failures may be retried without a human. A stale target, a missed click,
 * an unstable UI and a timeout are worth one more attempt; a refused capability
 * or a forbidden destructive action is not. A *transient* condition (a degraded
 * capability, a lost process, a reconnect that was not exhausted) is worth
 * another attempt, while an unverifiable mutation or a drifted workspace is not.
 */
export function defaultRetryable(code) {
  switch (code) {
    case CODES.TARGET_STALE:
    case CODES.TARGET_NOT_ACTIONABLE:
    case CODES.ACTION_MISSED:
    case CODES.TRANSPORT_LOST:
    case CODES.VERIFICATION_FAILED:
    case CODES.VERIFICATION_UNKNOWN:
    case CODES.ACTION_TIMEOUT:
    case CODES.CONTROLLER_TIMEOUT:
    case CODES.UI_UNSTABLE:
    case CODES.STALL_DETECTED:
    case CODES.MODAL_BLOCKING:
    case CODES.CAPABILITY_UNAVAILABLE:
    case CODES.PROCESS_LOST:
    case CODES.EVIDENCE_INSUFFICIENT:
      return true;
    default:
      return false;
  }
}

const SENSITIVE_KEY = /pass(word|phrase)|token|secret|api[-_]?key|credential|authorization|cookie/i;

/**
 * Passwords and tokens are never written to the execution log. The redaction is
 * applied to error details as well, because a typed password can easily end up
 * quoted inside a failure message.
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

/** The donor's `fail()` helper. */
export function fail(code, message, details) {
  return new ComputerUseError(code, message, details);
}

/**
 * The one deterministic clock every timer-injecting module in this directory
 * defaults to: 0, then 1, 2, … one millisecond per read, with a `sleep(ms)` that
 * resolves without waiting.
 *
 * The donor reads `Date.now()` and `setTimeout` in five of these seven files. This
 * module is pure, so the *shape* of every injection seam is kept
 * (`options.now` / `options.clock` / `options.sleep`) and the default behind it is
 * this step clock. A caller that needs real time injects a real clock; a caller
 * that needs a reproducible run gets one for free.
 *
 * @returns {{now: Function, sleep: Function}}
 */
export function createStepClock() {
  let tick = -1;
  return {
    now: () => {
      tick += 1;
      return tick;
    },
    sleep: () => Promise.resolve(),
  };
}

/**
 * The bare `now` function of `createStepClock()`, for the modules whose donor
 * injection seam is a function rather than a clock object.
 *
 * @returns {Function} () => number
 */
export function createStepNow() {
  return createStepClock().now;
}
