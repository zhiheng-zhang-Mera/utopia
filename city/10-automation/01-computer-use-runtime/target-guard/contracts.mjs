/**
 * UTOPIA · Automation District — computer-use target contracts.
 *
 * The value shapes a target resolution is written in: the ladder of addressing
 * modes, the movement tolerances `revalidate()` judges with, and the two typed
 * refusals a target can raise.
 *
 * Ported from the DS-Hns donor `app/computer-use/target.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b, whose header says it plainly: "A
 * target is *how to find the thing*, never 'x=821, y=440'."
 *
 * Local declaration, not import. The donor does
 *    const { TARGET_MOVEMENT } = require('./constants.cjs')
 *    const { CODES, ComputerUseError } = require('./errors.cjs')
 * and both sibling modules are being ported by another agent writing to another
 * directory in this same tree. To keep this module independently loadable (and to
 * keep it from depending on a file that may change under it), the three things
 * this module actually uses are declared here instead of imported. Nothing is
 * extended: `TARGET_MOVEMENT` is the donor's frozen `{ stablePx: 3, updatePx: 10 }`
 * from `constants.cjs` line 264, and `TARGET_INVALID` / `TARGET_NOT_FOUND` are the
 * donor's own string values from `errors.cjs` lines 25-26.
 */

/**
 * The "stable target" thresholds, in CSS pixels. Verbatim from the donor
 * `constants.cjs`: "`movement < stablePx` → the target is where it was;
 * `stablePx <= movement <= updatePx` → act on the refreshed coordinate;
 * `movement > updatePx` → the target is stale, re-observe instead of clicking."
 */
export const TARGET_MOVEMENT = Object.freeze({ stablePx: 3, updatePx: 10 });

/** Stable failure codes used by target resolution (donor `errors.cjs`). */
export const CODES = Object.freeze({
  TARGET_INVALID: 'TARGET_INVALID',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
});

/**
 * The donor's `ComputerUseError`, carrying exactly the fields the donor sets:
 * `name`, `code`, `details`, `retryable`, `controllerId`, `state`, and the JSON
 * view. `retryable` is the donor's `defaultRetryable()` answer for the two codes
 * reachable from here: TARGET_STALE / TARGET_NOT_ACTIONABLE and the other
 * retryable codes are not raised by target resolution, so both of ours are false.
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
      details: this.details,
    };
  }
}

/**
 * The donor's retry policy for the codes target resolution can raise. Both are
 * absent from the donor's retryable list, so both answer false: a malformed
 * target and a target that was not found are not worth another attempt.
 */
export function defaultRetryable(code) {
  switch (code) {
    case CODES.TARGET_INVALID:
    case CODES.TARGET_NOT_FOUND:
      return false;
    default:
      return false;
  }
}

/** A malformed target: TARGET_INVALID, the donor's `invalid()` helper. */
export function invalid(message, details) {
  return new ComputerUseError(CODES.TARGET_INVALID, message, details);
}
