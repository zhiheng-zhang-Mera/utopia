/**
 * UTOPIA · Engineering — the restart lock.
 *
 * Exactly one restart may be in flight. This module owns that invariant and the
 * declared state machine around it:
 *
 * ```
 * IDLE -> REQUESTED -> CHECKPOINTING -> SHUTTING_DOWN -> RELAUNCHING -> VERIFYING -> IDLE
 * ```
 *
 * The transitions are declared, not implied, so a bug elsewhere cannot walk the lock
 * into a state that has no way out. Anything that is not a declared edge is refused
 * and reported, which is how a stuck restart becomes visible instead of silently
 * blocking every future one.
 *
 * Ported from the donor `src/plugin/restart-lock.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. The donor class becomes a factory-built
 * object; the state, holder rule, bounded history and forced release are carried
 * over edge for edge. The declared tables and the refusal shape live in
 * `./contracts.mjs`, which is where every value is validated and copied; the two
 * state vocabularies come through it from the sibling shared contract layer
 * (`restart-protocol`), this building's port of the donor's `src/shared/protocol.ts`.
 * That is the donor's own dependency direction: `restart-lock.ts` imports them from
 * `../shared/protocol.js`.
 *
 * Clock:
 *   The donor reads `Date.now()` when no clock is injected. This port never calls
 *   `Date.now`. `now` defaults to a fixed clock pinned at epoch 0
 *   (`createFixedClock()`); passing a real clock is the caller's decision, and a
 *   test can therefore assert `heldForMs()` exactly.
 *
 * The rules that must never be softened:
 *   - only the declared edges in `TRANSITIONS` may be taken, and a refusal is
 *     returned rather than thrown, so the caller reports the stuck restart;
 *   - entering `REQUESTED` requires a non-empty holder, because a lock nobody holds
 *     cannot be reconciled after a crash;
 *   - the holder is set only on `IDLE -> REQUESTED` and cleared on `-> IDLE`;
 *   - the history is bounded by `maxHistory` and the oldest entry is dropped first;
 *   - `release(reason)` always ends in `IDLE` and always clears the holder.
 */

import {
  REQUEST_STATE,
  RESTART_LOCK_STATES,
  RESTART_REQUEST_STATES,
  TRANSITIONS,
  allowedTransitions,
  holderRequiredRefusal,
  illegalTransition,
  isLegalTransition,
  lockSnapshot,
  releaseRecord as releaseEntry,
  restartLockState,
  restartRequestState,
  transitionRecord as historyEntry,
  transitionRefusal,
} from './contracts.mjs';

export {
  REQUEST_STATE,
  RESTART_LOCK_STATES,
  RESTART_REQUEST_STATES,
  TRANSITIONS,
  allowedTransitions,
  holderRequiredRefusal,
  illegalTransition,
  isLegalTransition,
  lockSnapshot,
  releaseRecord,
  restartLockState,
  restartRequestState,
  transitionRecord,
  transitionRefusal,
} from './contracts.mjs';

/**
 * A clock pinned at a fixed instant.
 *
 * The default clock for this module: it refuses to guess at wall time, so a lock
 * built without an explicit `now` is fully deterministic until one is supplied.
 *
 * @param {number} [epochMs]
 */
export function createFixedClock(epochMs = 0) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) throw new TypeError('epochMs must be a finite number');
  return () => epochMs;
}

/**
 * Build a restart lock.
 *
 * @param {object} [options]
 * @param {number} [options.maxHistory] - how many transition records to keep, oldest
 *   dropped first (the donor's default is 50).
 * @param {() => number} [options.now] - injectable clock. Defaults to a fixed clock
 *   at epoch 0; `Date.now` is never called by this module.
 * @param {object} [options.initial] - a starting picture, for reconciliation with an
 *   observed lock. Validated through `lockSnapshot` like any other construction.
 */
export function restartLock(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');

  const maxHistory = options.maxHistory ?? 50;
  if (!Number.isInteger(maxHistory) || maxHistory < 0) throw new TypeError('maxHistory must be a non-negative integer');
  const now = options.now ?? createFixedClock();
  if (typeof now !== 'function') throw new TypeError('now must be a function returning a number');

  // Every clock read goes through the injected clock, and is checked.
  function readClock() {
    const atMs = now();
    if (typeof atMs !== 'number' || !Number.isFinite(atMs)) throw new TypeError('now must return a finite number');
    return atMs;
  }

  const initial = lockSnapshot(
    options.initial ?? { state: 'IDLE', holder: null, enteredAtMs: readClock(), history: [] },
  );
  let current = initial.state;
  let holder = initial.holder;
  let enteredAtMs = initial.enteredAtMs;
  const history = [...initial.history];

  /** Append one record, then drop the oldest until the bound holds. */
  function record(from, to) {
    history.push(historyEntry({ from, to, atMs: readClock() }));
    while (history.length > maxHistory) history.shift();
  }

  /**
   * Try to move the lock.
   *
   * @param {string} to - the desired state.
   * @param {string|null} [holder] - request id claiming the lock; only meaningful
   *   when leaving IDLE.
   * @returns {object|null} `null` on success, or the refusal.
   */
  function tryTransition(to, nextHolder = null) {
    const target = restartLockState(to);
    const from = current;

    if (!isLegalTransition(from, target)) return illegalTransition(from, target);
    if (target === 'REQUESTED' && (nextHolder === null || nextHolder === '')) return holderRequiredRefusal(from, target);

    if (from === 'IDLE' && target === 'REQUESTED') holder = nextHolder;
    if (target === 'IDLE') holder = null;

    record(from, target);
    current = target;
    enteredAtMs = readClock();
    return null;
  }

  /**
   * Force the lock back to IDLE.
   *
   * Used when a restart is abandoned (a refused checkpoint, a failed shutdown, an
   * explicit cancel, or a startup reconciliation that found a ticket no supervisor
   * ever consumed). Reported through the returned record so the reason is not lost.
   *
   * @param {string} reason
   * @returns {{from: string, reason: string}|null} the state the lock was in, or
   *   `null` when it was already idle.
   */
  function release(reason) {
    if (current === 'IDLE') return null;
    const from = current;
    const record = releaseEntry(from, reason);
    const atMs = readClock();
    history.push(historyEntry({ from, to: 'IDLE', atMs }));
    while (history.length > maxHistory) history.shift();
    current = 'IDLE';
    holder = null;
    enteredAtMs = atMs;
    return record;
  }

  /** Milliseconds the lock has been in its current state. */
  function heldForMs() {
    return Math.max(0, readClock() - enteredAtMs);
  }

  /** The observable picture, as a frozen copy. */
  function snapshot() {
    return lockSnapshot({ state: current, holder, enteredAtMs, history });
  }

  return Object.freeze({
    /** Current state. */
    get state() {
      return current;
    },
    /** Whether a new restart may be started. */
    get idle() {
      return current === 'IDLE';
    },
    /** The request id holding the lock, or `null`. */
    get currentHolder() {
      return holder;
    },
    /** Request state name for the current lock state. */
    get requestState() {
      return REQUEST_STATE[current];
    },
    /** The transitions taken so far, oldest first, as a copy. */
    get transitions() {
      return [...history];
    },
    /** The bound this lock enforces on its history. */
    get maxHistory() {
      return maxHistory;
    },
    transition: tryTransition,
    release,
    heldForMs,
    snapshot,
  });
}

/** The donor's exported name, kept so the port is recognizable. Same factory. */
export const RestartLock = restartLock;
