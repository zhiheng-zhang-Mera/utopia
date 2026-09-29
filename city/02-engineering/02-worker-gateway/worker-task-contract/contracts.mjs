/**
 * UTOPIA · City — Worker Gateway / Worker Task Contract: vocabularies.
 *
 * Ported from the DS-Hns donor `app/extensions/mega/scheduler/lifecycle.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b), which is
 * the donor's canonical task-lifecycle vocabulary and terminal-event contract.
 *
 * The donor keeps two spellings of the same idea and this file keeps both, unchanged:
 *
 *   persisted `task.status`  PENDING | SUSPENDED | DISPATCHING | RUNNING |
 *                            COMPLETED | FAILED | CANCELED | INTERRUPTED
 *                            (backward compatible with the existing queue files)
 *
 *   canonical terminal       COMPLETED | FAILED_FINAL | CANCELLED
 *                            (what TASK_TERMINATED events, notifications and the
 *                             acceptance matrix classify a transition into)
 *
 * The donor declared `ACTIVE_STATUSES` and `QUEUED_STATUSES` but did not export them;
 * both are exported here because they are part of this contract's vocabulary.
 *
 * Factories copy on construct: a caller may mutate whatever it receives without
 * touching the vocabulary this module owns. Validators refuse instead of coercing —
 * an invalid value is never turned into a valid one, so `requireCanonicalTerminal`
 * cannot be used to launder `'completed'` into `'COMPLETED'`.
 *
 * Nothing here reads the clock, the filesystem, the environment or randomness.
 */

/** The one terminal event type the scheduler, the notifier and the UI share.
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`TERMINAL_EVENT`).
 */
export const TERMINAL_EVENT = 'TASK_TERMINATED';

/** The canonical terminal vocabulary, in the donor's order.
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`CANONICAL_TERMINAL`).
 */
export const CANONICAL_TERMINAL = Object.freeze({
  COMPLETED: 'COMPLETED',
  FAILED_FINAL: 'FAILED_FINAL',
  CANCELLED: 'CANCELLED',
});

/** Persisted statuses that mean "this task will never run again".
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`TERMINAL_STATUSES`).
 */
export const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'FAILED_FINAL', 'CANCELED', 'CANCELLED', 'INTERRUPTED']);

/** Persisted statuses that mean "a worker is holding this task right now".
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`ACTIVE_STATUSES`, unexported there).
 */
export const ACTIVE_STATUSES = Object.freeze(['DISPATCHING', 'RUNNING']);

/** Persisted statuses that mean "this task is waiting for its turn".
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`QUEUED_STATUSES`, unexported there).
 */
export const QUEUED_STATUSES = Object.freeze(['PENDING', 'SUSPENDED']);

/** Why a task left the queue, in the donor's order.
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`REASONS`).
 */
export const REASONS = Object.freeze({
  USER_CANCEL: 'user-cancel',
  QUEUE_CLEARED: 'queue-cleared',
  REMOVED: 'removed',
  APP_QUIT: 'app-quit',
  APP_RESTART: 'app-restart',
  PEAK_PAUSE: 'peak-pause',
  STALL_RETRY: 'stall-retry',
});

/**
 * Every status spelling this contract knows: queued, active and terminal, persisted
 * and canonical. Module-private on purpose — it is a union of the vocabularies above,
 * not a fifth vocabulary.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (derived from its three lists).
 */
const KNOWN_STATUSES = Object.freeze([...QUEUED_STATUSES, ...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);

/** Fresh copy of the canonical terminal vocabulary.
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`CANONICAL_TERMINAL`).
 */
export function canonicalTerminal() {
  return { ...CANONICAL_TERMINAL };
}

/** Fresh copy of the terminal status list, in donor order.
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`TERMINAL_STATUSES`).
 */
export function terminalStatuses() {
  return TERMINAL_STATUSES.slice();
}

/** Fresh copy of the active status list, in donor order.
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`ACTIVE_STATUSES`).
 */
export function activeStatuses() {
  return ACTIVE_STATUSES.slice();
}

/** Fresh copy of the queued status list, in donor order.
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`QUEUED_STATUSES`).
 */
export function queuedStatuses() {
  return QUEUED_STATUSES.slice();
}

/** Fresh copy of the reason vocabulary.
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`REASONS`).
 */
export function reasons() {
  return { ...REASONS };
}

/**
 * Is this exactly one of the three canonical terminal states?
 *
 * Exact match only: `'completed'` is not `'COMPLETED'`. Callers that need the donor's
 * tolerant comparison use `terminalState()` / `normalizeStatus()` in `lifecycle.mjs`.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`CANONICAL_TERMINAL` members).
 */
export function isCanonicalTerminal(value) {
  return typeof value === 'string' && Object.values(CANONICAL_TERMINAL).includes(value);
}

/**
 * Return `value` when it is a canonical terminal state, otherwise throw. It never
 * normalizes, so an invalid state cannot be turned into a valid one.
 *
 * @throws {TypeError} when `value` is not exactly COMPLETED, FAILED_FINAL or CANCELLED.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`CANONICAL_TERMINAL` members).
 */
export function requireCanonicalTerminal(value) {
  if (!isCanonicalTerminal(value)) {
    throw new TypeError(`state must be one of ${Object.values(CANONICAL_TERMINAL).join(', ')}`);
  }
  return value;
}

/** Is this exactly one of the status spellings this contract knows? (exact match, no coercion)
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (its three status lists).
 */
export function isKnownStatus(value) {
  return typeof value === 'string' && KNOWN_STATUSES.includes(value);
}

/**
 * Return `value` when it is a known status spelling, otherwise throw.
 *
 * @throws {TypeError} when `value` is not one of the queued, active or terminal statuses.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (its three status lists).
 */
export function requireKnownStatus(value) {
  if (!isKnownStatus(value)) {
    throw new TypeError(`status must be one of ${KNOWN_STATUSES.join(', ')}`);
  }
  return value;
}

/** Is this exactly one of the declared reasons? (exact match, no coercion)
 *  Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`REASONS` values).
 */
export function isKnownReason(value) {
  return typeof value === 'string' && Object.values(REASONS).includes(value);
}

/**
 * Return `value` when it is a declared reason, otherwise throw. The terminal event
 * itself carries a caller's reason verbatim (see `buildTerminalEvent`); this validator
 * exists for callers that must stay inside the declared vocabulary.
 *
 * @throws {TypeError} when `value` is not one of the REASONS values.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`REASONS` values).
 */
export function requireKnownReason(value) {
  if (!isKnownReason(value)) {
    throw new TypeError(`reason must be one of ${Object.values(REASONS).join(', ')}`);
  }
  return value;
}
