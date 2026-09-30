/**
 * UTOPIA · Automation District — computer-use target guard entry point.
 *
 * The donor's public surface, unchanged and in the donor's order. The DS-Hns donor
 * `app/computer-use/target.cjs` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b ends with:
 *
 *   module.exports = {
 *     TARGET_KINDS, normalizeTarget, targetKinds, describeTarget, resolveTarget,
 *     revalidate, distance, centerOf, containsPoint, matchesSemantic,
 *     matchesAccessibility, matchesWindow
 *   }
 *
 * every one of those twelve names is re-exported here with the same identity.
 *
 * `ComputerUseError` and `CODES` are additionally re-exported because the donor
 * module's callers switch on `error.code`, and `revalidate`'s default threshold
 * object is re-exported because it is the frozen `TARGET_MOVEMENT` value. All
 * three are declared locally in `./contracts.mjs` (the donor took them from the
 * concurrently ported `errors.cjs` / `constants.cjs`); they add no behaviour.
 * `TARGET_STALE`, `TARGET_AMBIGUOUS` and `TARGET_NOT_ACTIONABLE` are *not* raised
 * anywhere in the donor's target module, so they are deliberately not invented
 * here.
 *
 * This module is pure: no filesystem, no network, no clock, no randomness, no
 * environment. Resolvers and world state are supplied by the caller.
 */

export {
  TARGET_KINDS,
  normalizeTarget,
  targetKinds,
  describeTarget,
  resolveTarget,
  revalidate,
  distance,
  centerOf,
  containsPoint,
  matchesSemantic,
  matchesAccessibility,
  matchesWindow,
} from './target.mjs';

export { CODES, ComputerUseError, TARGET_MOVEMENT } from './contracts.mjs';
