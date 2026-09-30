/**
 * UTOPIA · Engineering — the checkpoint gate.
 *
 * This module never saves task state. It asks the harness to, waits a bounded time,
 * and believes only the answer.
 *
 * The default is refusal. A missing port, a timeout, a thrown error and an explicit
 * `safe: false` all produce the same outcome: no checkpoint, therefore no restart.
 * That is the design's "if checkpoint_required = true AND checkpoint failed -> ABORT
 * RESTART, 不得擅自继续".
 *
 * Ported from the donor `src/plugin/checkpoint-gate.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. The value shapes and the failure factory
 * live in `./contracts.mjs`; the `CheckpointOutcome` shape and its copy constructor
 * come through it from the sibling shared contract layer (`restart-protocol`), this
 * building's port of the donor's `src/shared/types.ts`. That is the donor's own
 * dependency direction: `checkpoint-gate.ts` imports `CheckpointOutcome` and
 * `CheckpointPort` from `../shared/types.js`.
 *
 * Clock and timers:
 *   `elapsedMs` is measured from the injected clock. `now` defaults to a fixed clock
 *   pinned at epoch 0, so this port never calls `Date.now`; passing a real clock is the
 *   caller's decision. The timeout race is the one ambient dependency kept from the
 *   donor: `setTimeout` / `clearTimeout` are Node globals, the timer is `unref`'d when
 *   the runtime supports it, and the path is exercised with a real short timeout
 *   rather than a fake timer.
 *
 * The rules that must never be softened:
 *   - an unbound port reports itself as such and every answer is "cannot verify";
 *   - a required checkpoint must be both `safe` and `completed` to authorize a
 *     restart;
 *   - a port that throws or does not answer inside the budget becomes the same
 *     failure shape as a refusal, and never authorizes anything;
 *   - `timeoutMs <= 0` means no timeout at all, and that is the only case where a
 *     hung port can hold the gate open.
 */

import {
  GATE_FAILURE_REASONS,
  NO_CHECKPOINT_PORT,
  UNBOUND_PORT_ID,
  UNBOUND_PORT_REASON,
  checkpointFailure,
  checkpointOutcome,
  gateResult,
} from './contracts.mjs';

export {
  GATE_FAILURE_REASONS,
  NO_CHECKPOINT_PORT,
  UNBOUND_PORT_ID,
  UNBOUND_PORT_REASON,
  checkpointFailure,
  checkpointOutcome,
  gateResult,
} from './contracts.mjs';

/** A clock pinned at a fixed instant. The default clock for this module. */
export function createFixedClock(epochMs = 0) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) throw new TypeError('epochMs must be a finite number');
  return () => epochMs;
}

/** The message the donor raises when the port does not answer inside the budget. */
export function timeoutMessage(portId, timeoutMs) {
  return `checkpoint port ${portId} did not answer within ${timeoutMs} ms`;
}

/** The detail the donor records when the port threw. */
export function throwDetail(error) {
  return `prepareForRestart threw: ${error instanceof Error ? error.message : String(error)}`;
}

/** Raised when a checkpoint port does not answer inside the gate's budget. */
export class CheckpointTimeoutError extends Error {
  constructor(portId, timeoutMs) {
    super(timeoutMessage(portId, timeoutMs));
    this.name = 'CheckpointTimeoutError';
    this.code = 'checkpoint_timeout';
    this.portId = portId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A checkpoint port that is not bound: every answer is "cannot verify".
 *
 * The donor decided `available` with `instanceof UnboundCheckpointPort`; this port is
 * factory-built, so it carries a non-exported brand instead and `isUnboundPort`
 * checks that brand or the donor class. That is the one check that must stay exactly
 * as narrow as the donor's: nothing else may report itself as unbound.
 */
export const UNBOUND_PORT_BRAND = Symbol('utopia.checkpoint-gate.unbound');

export function unboundCheckpointPort(reason = UNBOUND_PORT_REASON) {
  if (typeof reason !== 'string' || !reason) throw new TypeError('reason must be a non-empty string');
  const portReason = reason;
  return Object.freeze({
    /** Stable port id, for diagnostics. */
    id: UNBOUND_PORT_ID,
    /** Why nothing is bound, surfaced in the audit record. */
    reason: portReason,
    /** The unbound brand, so `available` can tell this port from a real one. */
    [UNBOUND_PORT_BRAND]: true,
    /** Nothing is bound, so nothing can be prepared. */
    prepareForRestart() {
      return {
        safe: false,
        reason: NO_CHECKPOINT_PORT,
        checkpointId: null,
        resumeToken: null,
        completed: false,
        detail: portReason,
      };
    },
    /** Nothing was checkpointed, so there is nothing to acknowledge. */
    acknowledgeResume() {
      return false;
    },
  });
}

/** The donor's exported name, kept so the port is recognizable. Same factory. */
export const UnboundCheckpointPort = unboundCheckpointPort;

/** Whether a port is an unbound one, branded or the donor's own class shape. */
export function isUnboundPort(port) {
  return Boolean(port) && (port[UNBOUND_PORT_BRAND] === true || port.id === UNBOUND_PORT_ID);
}

/**
 * Run one checkpoint request under a hard budget.
 *
 * A hung checkpoint must not hang the restart path: the caller is asked to prepare
 * for a restart, and an unbounded wait would leave the lock in CHECKPOINTING forever,
 * blocking every future request.
 *
 * @param {object} options
 * @param {{id: string, prepareForRestart: Function, acknowledgeResume: Function}} options.port
 * @param {number} options.timeoutMs - budget in milliseconds; `<= 0` means no timeout.
 * @param {() => number} [options.now] - injectable clock for `elapsedMs`. Defaults to a
 *   fixed clock at epoch 0; `Date.now` is never called here.
 */
export function checkpointGate(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  const port = options.port;
  if (port === null || typeof port !== 'object') throw new TypeError('a checkpoint port is required');
  if (typeof port.id !== 'string' || !port.id) throw new TypeError('port.id must be a non-empty string');
  if (typeof port.prepareForRestart !== 'function') throw new TypeError('port.prepareForRestart must be a function');
  if (typeof port.acknowledgeResume !== 'function') throw new TypeError('port.acknowledgeResume must be a function');
  const timeoutMs = options.timeoutMs ?? 0;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) throw new TypeError('timeoutMs must be a finite number');
  const now = options.now ?? createFixedClock();
  if (typeof now !== 'function') throw new TypeError('now must be a function returning a number');

  /** Every clock read goes through the injected clock, and is checked. */
  function readClock() {
    const atMs = now();
    if (typeof atMs !== 'number' || !Number.isFinite(atMs)) throw new TypeError('now must return a finite number');
    return atMs;
  }

  /**
   * Race one answer against the budget.
   *
   * With no budget the promise is passed straight through, so a port that never
   * answers is waited on forever — exactly the donor's behaviour, and the caller's
   * choice.
   */
  function withTimeout(value) {
    if (timeoutMs <= 0) return value;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CheckpointTimeoutError(port.id, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      value.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * Ask the harness to prepare for a restart.
   *
   * @param {string} mode - the restart scope being requested.
   * @param {boolean} required - whether a checkpoint must succeed for the request to proceed.
   */
  async function prepare(mode, required) {
    const startedAt = readClock();
    let outcome;
    try {
      outcome = checkpointOutcome(await withTimeout(Promise.resolve(port.prepareForRestart(mode))));
    } catch (error) {
      outcome = checkpointFailure('checkpoint_threw', throwDetail(error));
    }
    const elapsedMs = readClock() - startedAt;

    const authorized = required ? outcome.safe && outcome.completed : true;
    return gateResult({
      outcome:
        required || outcome.safe
          ? outcome
          : { ...outcome, detail: `${outcome.detail} (checkpoint not required for this request)` },
      elapsedMs,
      authorized,
    });
  }

  /** Tell the harness the checkpoint was consumed after a successful restart. */
  async function acknowledgeResume(resumeToken) {
    try {
      return await withTimeout(Promise.resolve(port.acknowledgeResume(resumeToken)));
    } catch {
      return false;
    }
  }

  return Object.freeze({
    /** Port id, for diagnostics. */
    get portId() {
      return port.id;
    },
    /** Whether a real port is bound (the unbound one reports itself as such). */
    get available() {
      return !isUnboundPort(port);
    },
    /** The budget this gate enforces. */
    get timeoutMs() {
      return timeoutMs;
    },
    prepare,
    acknowledgeResume,
  });
}

/** The donor's exported name, kept so the port is recognizable. Same factory. */
export const CheckpointGate = checkpointGate;
