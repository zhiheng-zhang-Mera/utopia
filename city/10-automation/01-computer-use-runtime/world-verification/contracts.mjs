/**
 * UTOPIA · 10-automation / Computer Use Runtime — world-verification contracts.
 *
 * The vocabulary the ported world-state, verification, miss-detection, observer
 * and progress modules agree on, plus the plain value shapes they exchange.
 *
 * Donor: DS-Hns `app/computer-use/constants.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b. The sibling `constants.cjs` is being
 * ported concurrently, so this module declares the two closed vocabularies these
 * five files read — `VERDICTS` and `VERIFICATION_KINDS` — locally, byte-for-byte
 * the donor's values. Nothing else from `constants.cjs` is needed and nothing
 * else is declared.
 *
 * Donor files that consume this local vocabulary:
 *   `app/computer-use/world-state.cjs`   @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 *   `app/computer-use/verification.cjs`  @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 *   `app/computer-use/miss.cjs`          @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 *   `app/computer-use/observer.cjs`      @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 *   `app/computer-use/progress.cjs`      @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 *
 * Both vocabularies are closed. A value that is not in one of them cannot be
 * reported, so a caller can never invent a verification kind or a verdict the
 * runtime does not implement — that closure is the donor's, not an addition.
 */

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

/**
 * Every action returns exactly one of these. There is no fourth value and no
 * boolean shorthand: "unknown" is what keeps the runtime from silently assuming
 * success.
 */
export const VERDICTS = Object.freeze({ SUCCESS: 'success', FAILURE: 'failure', UNKNOWN: 'unknown' });

const VERIFICATION_KIND_LIST = Object.freeze(Object.values(VERIFICATION_KINDS));
const VERDICT_LIST = Object.freeze(Object.values(VERDICTS));

/** Is this one of the nine verification kinds the runtime implements? */
export function isVerificationKind(value) {
  return VERIFICATION_KIND_LIST.includes(value);
}

/** Is this one of the three verdicts the runtime may report? */
export function isVerdict(value) {
  return VERDICT_LIST.includes(value);
}

/**
 * @typedef {object} WorldState
 * @property {string|null} taskId
 * @property {number} capturedAt
 * @property {number|null} revision
 * @property {string|null} activeApp
 * @property {string|null} activeWindow
 * @property {string|null} activeWindowHandle
 * @property {number|null} foregroundProcessId
 * @property {string|null} url
 * @property {string|null} title
 * @property {string|null} readyState
 * @property {boolean} loading
 * @property {string|null} focusedRef
 * @property {object|null} focusedElement
 * @property {object[]} controls
 * @property {object[]} visibleTargets
 * @property {object[]} ax
 * @property {object[]} windows
 * @property {object|null} foreground
 * @property {object[]} dialogs
 * @property {object[]} systemEvents
 * @property {object|null} lastAction
 * @property {boolean|null} uiStable
 * @property {number} confidence
 * @property {{browser: SourceState, desktop: SourceState, system: SourceState}} sources
 * @property {string[]} notes
 * @property {string} dialogSignature
 * @property {string|null} controlSignature
 * @property {string|null} windowSignature
 * @property {string|null} axSignature
 * @property {string|null} signature
 */

/**
 * @typedef {object} SourceState
 * @property {boolean} available
 * @property {string|null} reason
 * @property {string|null} backend
 */

/**
 * @typedef {object} VerificationResult
 * @property {'success'|'failure'|'unknown'} verdict
 * @property {string} kind one of VERIFICATION_KINDS
 * @property {Array<{ok: boolean|null, verificationKind?: string, kind?: string, detail?: string}>} evidence
 * @property {number} checkedAt
 */

/**
 * @typedef {object} EffectEvaluation
 * @property {boolean|null} ok null when the fact the effect needs is unavailable
 * @property {string} verificationKind
 * @property {string} detail
 */

/**
 * @typedef {object} MissReport
 * @property {boolean} missed
 * @property {'low'|'medium'|'high'|'unknown'} confidence
 * @property {string[]} signals
 * @property {object} details
 */
