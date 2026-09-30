/**
 * UTOPIA · Automation District — Computer Use Execution Contract.
 *
 * The public surface of this module: the donor's execution-contract vocabulary
 * (`constants.cjs` → `./contracts.mjs`), typed failures (`errors.cjs` →
 * `./errors.mjs`), the action schema (`action.cjs` → `./action.mjs`), success
 * criteria (`criteria.cjs` → `./criteria.mjs`) and the contract builder
 * (`contract.cjs` → `./contract.mjs`), all from DS-Hns @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 *
 * This file is a barrel over those five donor file boundaries; it adds no
 * behaviour of its own. The donor's own `app/computer-use/index.cjs` is NOT
 * ported here: it wires the controllers, drivers, executor, state machine and
 * evidence log, which belong to this building's other modules
 * (`target-guard`, `routing-safety`, `world-verification`, `bounded-run`,
 * `backend-surface`) and to the executor that consumes them.
 *
 * Deliberate non-ports carried in `DONOR.json`:
 *  - `constants.cjs`'s `ROOT` and `readComputerUseConfig` (load-impure: they
 *    were the file read this port replaces with an explicit `configBlock`);
 *  - `target.cjs`'s `resolveTarget` / `revalidate` / matching (owned by
 *    `target-guard`); only `normalizeTarget` / `describeTarget`, re-exported
 *    here from `./action.mjs`, are carried because `action.cjs` / `contract.cjs`
 *    call them.
 */

export {
  ACTION_TYPES,
  ACTION_TYPE_LIST,
  ACTION_CAPABILITY,
  CAPABILITY_CONTROLLER,
  ROUTE_CHANNELS,
  CU_STATES,
  CU_TRANSITIONS,
  TERMINAL_STATES,
  VERIFICATION_KINDS,
  VERDICTS,
  SCREENSHOT_LEVELS,
  CAPABILITIES,
  DESTRUCTIVE_KINDS,
  DESTRUCTIVE_MODES,
  SCREENSHOT_RETENTION,
  STEP_RESULTS,
  RUN_STATUS,
  TARGET_MOVEMENT,
  TIMING,
  STALL,
  RETRY,
  CONTRACT_DEFAULTS,
  resolveComputerUseOptions
} from './contracts.mjs';

export { CODES, ComputerUseError, fail, redactDetails, defaultRetryable } from './errors.mjs';

export {
  VALID_ACTION_TYPES,
  EXPECTED_EFFECT_KEYS,
  PARAM_RULES,
  normalizeAction,
  validateAction,
  normalizeExpectedEffect,
  normalizeStabilization,
  normalizePrecondition,
  normalizeRetry,
  normalizeDestructive,
  requiresTarget,
  describeAction,
  destructiveKinds,
  TARGET_KINDS,
  normalizeTarget,
  describeTarget
} from './action.mjs';

export {
  CRITERION_KINDS,
  normalizeCriterion,
  normalizeCriteria,
  evaluateCriterion,
  evaluateCriteria,
  describe
} from './criteria.mjs';

export {
  createContract,
  normalizePlan,
  hasCapability,
  assertCapability,
  declaredDestructiveKinds,
  describeContract
} from './contract.mjs';
