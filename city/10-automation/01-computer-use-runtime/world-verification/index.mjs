/**
 * UTOPIA · 10-automation / Computer Use Runtime — world-verification barrel.
 *
 * The five ported modules of the World State / verification slice, re-exported
 * as one surface:
 *
 *   world-state.mjs   the short-lived perception structure and meaningful change
 *   verification.mjs  postcondition verification with success/failure/unknown
 *   miss.mjs          "the action was issued" ≠ "the action had an effect"
 *   observer.mjs      perception with a fault boundary per source
 *   progress.mjs      progress that counts only verified effects
 *
 * Donor: DS-Hns `app/computer-use/{world-state,verification,miss,observer,progress}.cjs`
 * @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 *
 * `VERDICTS` and `VERIFICATION_KINDS` are re-exported because verification.cjs
 * read them from the donor's `constants.cjs`; here they live in `contracts.mjs`.
 */

export * from './contracts.mjs';
export * from './world-state.mjs';
export * from './verification.mjs';
export * from './miss.mjs';
export * from './observer.mjs';
export * from './progress.mjs';
