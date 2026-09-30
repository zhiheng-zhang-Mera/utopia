/**
 * UTOPIA · Engineering — restart lock contracts.
 *
 * The declared vocabulary of the exclusive restart lock, expressed as frozen data
 * plus copy-on-construct factories. Nothing here schedules or performs anything: a
 * reader can take these tables and know every state the lock can be in and every
 * edge it may take, without executing the module that drives it.
 *
 * Ported from the donor `src/plugin/restart-lock.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. The `TRANSITIONS` table, the
 * `REQUEST_STATE` table and the `TransitionRefusal` shape are the donor's own
 * declarations in that file and stay local here.
 *
 * The two vocabularies are not this module's to declare. The donor's
 * `restart-lock.ts` imports `RestartLockState` and `RestartRequestState` from the
 * shared contract layer (`import type { RestartLockState, RestartRequestState }
 * from '../shared/protocol.js'`). In this building that shared layer is the sibling
 * `restart-protocol` module, so the vocabularies are imported from it and
 * re-exported unchanged: the building keeps one declaration of each, exactly as the
 * donor does, and a drift between the lock and the protocol is impossible.
 *
 * Vocabulary:
 *   RESTART_LOCK_STATES     IDLE, REQUESTED, CHECKPOINTING, SHUTTING_DOWN,
 *                           RELAUNCHING, VERIFYING (shared contract layer)
 *   RESTART_REQUEST_STATES  the protocol's request lifecycle names (shared too)
 *   TRANSITIONS             the declared edges of the lock state machine
 *   REQUEST_STATE           the request state each lock state reports as
 *   TransitionRefusal       the shape returned when an edge is not declared
 *
 * Every factory validates its input and returns a frozen copy, so a caller can
 * never hand this state machine a half-built value and a caller can never mutate a
 * value this module handed back.
 */

// The donor's single shared contract layer, kept as a single source.
import { RESTART_LOCK_STATES, RESTART_REQUEST_STATES } from '../restart-protocol/contracts.mjs';

export { RESTART_LOCK_STATES, RESTART_REQUEST_STATES } from '../restart-protocol/contracts.mjs';

/**
 * The declared edges of the lock state machine, exactly as the donor declares them.
 *
 * A request may be abandoned from any working state, and every later state may also
 * finish, because an operator can always cancel a pending restart.
 */
export const TRANSITIONS = Object.freeze({
  IDLE: Object.freeze(['REQUESTED']),
  REQUESTED: Object.freeze(['CHECKPOINTING', 'SHUTTING_DOWN', 'IDLE']),
  CHECKPOINTING: Object.freeze(['SHUTTING_DOWN', 'IDLE']),
  SHUTTING_DOWN: Object.freeze(['RELAUNCHING', 'IDLE']),
  RELAUNCHING: Object.freeze(['VERIFYING', 'IDLE']),
  VERIFYING: Object.freeze(['IDLE']),
});

/** The request state that corresponds to each lock state. */
export const REQUEST_STATE = Object.freeze({
  IDLE: 'completed',
  REQUESTED: 'queued',
  CHECKPOINTING: 'checkpointing',
  SHUTTING_DOWN: 'shutting_down',
  RELAUNCHING: 'relaunching',
  VERIFYING: 'verifying',
});

/**
 * Validate one lock state name.
 *
 * This is the gate the whole module passes through: an unknown name cannot enter
 * the state machine, so a typo becomes a refusal (or a `TypeError` at the
 * boundary) instead of a state nothing can leave.
 *
 * @param {unknown} value
 * @returns {string} the state name
 */
export function restartLockState(value) {
  if (typeof value !== 'string' || !RESTART_LOCK_STATES.includes(value)) {
    throw new TypeError(`lock state must be one of ${RESTART_LOCK_STATES.join(', ')}`);
  }
  return value;
}

/**
 * Validate one request state name against the protocol vocabulary.
 *
 * @param {unknown} value
 * @returns {string} the request state name
 */
export function restartRequestState(value) {
  if (typeof value !== 'string' || !RESTART_REQUEST_STATES.includes(value)) {
    throw new TypeError(`request state must be one of ${RESTART_REQUEST_STATES.join(', ')}`);
  }
  return value;
}

/**
 * The declared successors of one lock state, as a fresh copy.
 *
 * @param {unknown} state
 * @returns {string[]} the state names that state may move to
 */
export function allowedTransitions(state) {
  return [...TRANSITIONS[restartLockState(state)]];
}

/** Whether an edge is declared. */
export function isLegalTransition(from, to) {
  return allowedTransitions(from).includes(restartLockState(to));
}

/**
 * Build a transition refusal.
 *
 * Copy-on-construct: the returned object is frozen and shares nothing with the
 * caller's arguments, so a refusal cannot be edited after the fact.
 *
 * @param {unknown} from
 * @param {unknown} to
 * @param {unknown} detail
 */
export function transitionRefusal(from, to, detail) {
  if (typeof detail !== 'string' || !detail) throw new TypeError('refusal.detail must be a non-empty string');
  return Object.freeze({ from: restartLockState(from), to: restartLockState(to), detail });
}

/**
 * The donor's refusal for an edge that is not declared.
 *
 * The detail string is the donor's, character for character, including `none` when
 * the current state has no declared successor at all.
 */
export function illegalTransition(from, to) {
  const state = restartLockState(from);
  const target = restartLockState(to);
  const allowed = TRANSITIONS[state];
  return transitionRefusal(state, target, `illegal restart lock transition ${state} -> ${target}; allowed: ${allowed.join(', ') || 'none'}`);
}

/** The donor's refusal for an attempt to claim the lock without naming a request. */
export function holderRequiredRefusal(from, to = 'REQUESTED') {
  return transitionRefusal(restartLockState(from), restartLockState(to), 'entering REQUESTED requires a request id');
}

/**
 * Build one transition history entry.
 *
 * Copy-on-construct, and the clock reading is supplied by the caller so this stays
 * a pure shape factory.
 *
 * @param {{from: unknown, to: unknown, atMs: unknown}} entry
 */
export function transitionRecord(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('entry must be an object');
  const atMs = entry.atMs;
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) throw new TypeError('entry.atMs must be a finite number');
  return Object.freeze({ from: restartLockState(entry.from), to: restartLockState(entry.to), atMs });
}

/** Build the record `release()` returns: where the lock was, and why it was freed. */
export function releaseRecord(from, reason) {
  if (typeof reason !== 'string' || !reason) throw new TypeError('release reason must be a non-empty string');
  return Object.freeze({ from: restartLockState(from), reason });
}

/**
 * Build the observable picture of a lock: its state, holder and history.
 *
 * Copy-on-construct: the history array is copied element by element, so the
 * caller's array can be mutated afterwards without reaching back into the lock.
 *
 * @param {{state: unknown, holder: unknown, enteredAtMs: unknown, history?: unknown[]}} snapshot
 */
export function lockSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('snapshot must be an object');
  const holder = snapshot.holder ?? null;
  if (holder !== null && (typeof holder !== 'string' || !holder)) throw new TypeError('snapshot.holder must be null or a non-empty string');
  const enteredAtMs = snapshot.enteredAtMs;
  if (typeof enteredAtMs !== 'number' || !Number.isFinite(enteredAtMs)) throw new TypeError('snapshot.enteredAtMs must be a finite number');
  const history = snapshot.history ?? [];
  if (!Array.isArray(history)) throw new TypeError('snapshot.history must be an array');
  return Object.freeze({
    state: restartLockState(snapshot.state),
    holder,
    enteredAtMs,
    history: Object.freeze(history.map((entry) => transitionRecord(entry))),
  });
}
