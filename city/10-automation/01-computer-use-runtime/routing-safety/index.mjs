/**
 * UTOPIA · Automation — computer-use routing & safety barrel.
 *
 * One entry point for the four donor modules ported into this building from
 * DS-Hns `app/computer-use/` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b:
 *
 *   routing.mjs   ← routing.cjs    channel plans, ordered fallbacks, route reasons
 *   safety.mjs    ← safety.cjs     destructive / window / focus / modal gates, redaction
 *   modal.mjs     ← modal.cjs      label classification, fail-safe control choice
 *   evidence.mjs  ← evidence.cjs   risk classification, evidence grades, the bar
 *
 * The exports mirror the donor `module.exports` blocks exactly, with no added
 * surface. `contracts.mjs` re-declares the donor vocabulary locally (see its
 * header) and its extras are re-exported here only where a consumer of the donor
 * would have reached them through `constants.cjs` / `errors.cjs`.
 */

export {
  CHANNEL_PLANS,
  CHANNEL_CAPABILITY,
  CHANNEL_CONTROLLER,
  routeAction,
  fallbackChannels,
  channelRank,
  isBrowserAction,
} from './routing.mjs';

export {
  createSafetyGuard,
  TYPING_ACTIONS,
  POINTING_ACTIONS,
  matchesWindow,
} from './safety.mjs';

export {
  MODAL_KINDS,
  MODAL_ACTION,
  DESTRUCTIVE_LABELS,
  SAFE_DISMISS_LABELS,
  NEUTRAL_LABELS,
  POSITIVE_LABELS,
  classifyControl,
  classifyModal,
  chooseControl,
  planModal,
  destructiveAllowed,
  isDestructiveKind,
} from './modal.mjs';

export {
  GRADES,
  GRADE_ORDER,
  RISK,
  RISK_ORDER,
  RISK_BAR,
  HIGH_RISK_ACTIONS,
  LOW_RISK_ACTIONS,
  classifyRisk,
  gradeEvidence,
  assess,
} from './evidence.mjs';

export {
  ACTION_TYPES,
  ROUTE_CHANNELS,
  VERIFICATION_KINDS,
  DESTRUCTIVE_KINDS,
  DESTRUCTIVE_MODES,
  CODES,
  ComputerUseError,
  redactDetails,
  describeAction,
  destructiveKinds,
  describeTarget,
  hasCapability,
} from './contracts.mjs';
