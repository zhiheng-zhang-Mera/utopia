/**
 * UTOPIA · 10-automation / Computer Use Runtime — bounded-run composition root.
 *
 * The seven ported modules of the `bounded-run` room, re-exported so a consumer
 * (the executor, or a test) can import one path instead of seven:
 *
 *   ./stall.mjs          createStallDetector, STALL_RECOVERY_LADDER
 *   ./state-machine.mjs  createStateMachine
 *   ./recovery.mjs       createRecoveryController, alternativeAction, mapType, …
 *   ./stabilization.mjs  createStabilizer, SIGNALS, normalizeSignals, …
 *   ./reconnect.mjs      createReconnectPolicy, createChannelRecovery, RECONNECT, …
 *   ./health.mjs         buildHealthSnapshot, capabilityVerdict, …
 *   ./resources.mjs      createResourceBudget, classifyRetention, DEFAULTS, …
 *
 * Ported from the DS-Hns donor `app/computer-use/` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b — `stall.cjs`, `state-machine.cjs`,
 * `recovery.cjs`, `stabilization.cjs`, `reconnect.cjs`, `health.cjs` and
 * `resources.cjs`. The donor has no `index.cjs` counterpart: its composition root
 * is `index.cjs` *of the whole runtime* (the executor loop, the controllers and the
 * isolation boundary), which is Deferred and recorded in `DONOR.json`. This file is
 * a barrel, not a runtime: it adds no behaviour, no default and no policy, and
 * every name below is the donor's own name with the donor's own value.
 *
 * The per-module namespaces (`stall`, `stateMachine`, …) are exported as well so a
 * caller can reach a module's whole surface — for example
 * `stabilization.detectSignals` or `resources.ring` — without a second import path.
 *
 * This barrel is also where the two sibling-owned bindings this room *uses* are
 * forwarded: `revalidate` (from the `target-guard` room's `./target.mjs`) and,
 * through `./recovery.mjs`, the routing tables (from the `routing-safety` room's
 * `./routing.mjs`). Only `revalidate` is part of this barrel's public surface,
 * because the donor's `recovery.cjs` never re-exported the routing tables — it only
 * read them.
 *
 * The one deliberate adaptation: every module whose donor default was `Date.now()`
 * or `setTimeout` declares the deterministic step clock as its default instead. It
 * is exported here as `createStepClock` (the `{now, sleep}` shape the donor's
 * `stabilization.cjs` clock has) and `createStepNow` (the bare `() => number` the
 * other modules take).
 */

export {
  CU_STATES,
  CU_TRANSITIONS,
  TERMINAL_STATES,
  CODES,
  ComputerUseError,
  defaultRetryable,
  redactDetails,
  fail,
  RETRY,
  STALL,
  TIMING,
  TARGET_MOVEMENT,
  SCREENSHOT_LEVELS,
  SCREENSHOT_RETENTION,
  DESTRUCTIVE_MODES,
  CAPABILITY_CONTROLLER,
  ACTION_TYPES,
  ACTION_CAPABILITY,
  createStepClock,
  createStepNow,
} from './contracts.mjs';

export { createStallDetector, STALL_RECOVERY_LADDER } from './stall.mjs';

export { createStateMachine } from './state-machine.mjs';

export {
  createRecoveryController,
  alternativeAction,
  alternativeController,
  mapType,
  RECOVERY_STEPS,
  RECOVERY_VERDICTS,
  VERDICT_BY_STEP,
  USER_ACTION_CODES,
  exhaustedError,
} from './recovery.mjs';

export {
  createStabilizer,
  SIGNALS,
  SIGNAL_LIST,
  SIGNAL_ALIASES,
  normalizeSignals,
} from './stabilization.mjs';

/**
 * `revalidate` is the donor's `target.cjs` function, owned by the sibling
 * `target-guard` room. It is re-exported here under the same name as before — so
 * this barrel's public surface is unchanged — but the binding is `target-guard`'s
 * own function, not a copy: `stabilization.mjs` imports it from
 * `../target-guard/target.mjs`, and this line forwards that same binding. The
 * identity is asserted by `tests/identity.test.mjs`.
 */
export { revalidate } from '../target-guard/target.mjs';

export {
  createReconnectPolicy,
  createChannelRecovery,
  RECONNECT,
  isTransportFailure,
  channelOfError,
  channelHintFor,
  TRANSPORT_CODES,
  DEFAULT_MAX_ATTEMPTS,
} from './reconnect.mjs';

export {
  HEALTH_STATUS,
  BLOCK_REASONS,
  CAPABILITY_CONTROLLERS,
  buildHealthSnapshot,
  capabilityVerdict,
  capabilityIsUsable,
  controllerIdsFor,
} from './health.mjs';

export {
  createResourceBudget,
  classifyRetention,
  DEFAULTS,
  TRANSIENT_TTL_MS,
} from './resources.mjs';

import * as stall from './stall.mjs';
import * as stateMachine from './state-machine.mjs';
import * as recovery from './recovery.mjs';
import * as stabilization from './stabilization.mjs';
import * as reconnect from './reconnect.mjs';
import * as health from './health.mjs';
import * as resources from './resources.mjs';
import * as contracts from './contracts.mjs';

/**
 * The module namespaces, in the order the donor's own dependency graph loads them:
 * the contracts first, then the machine that names the states, then the stall
 * detector and the ladder that consumes it, and finally the four independent
 * policy modules.
 */
export const MODULES = Object.freeze({
  contracts,
  stall,
  stateMachine,
  recovery,
  stabilization,
  reconnect,
  health,
  resources,
});
