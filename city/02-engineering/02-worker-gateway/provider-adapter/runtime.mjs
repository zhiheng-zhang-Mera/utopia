/**
 * UTOPIA · City · Worker Gateway — runtime adapter behaviour.
 *
 * Three things live here, and nothing else:
 *
 *   1. `isRuntimeAvailable` — the readiness rule over the ten-value availability
 *      vocabulary. Only AVAILABLE is available; every other value, UNKNOWN
 *      included, is not.
 *   2. `unsupportedRuntime` — the refusal adapter for a runtime that is
 *      configured but not implemented. It never pretends to work: health reports
 *      UNSUPPORTED and execute refuses with a permanent, non-retryable failure.
 *   3. `providerRuntimeAdapter` — the wrapper over injected hooks, including the
 *      `web:` id rule and the default-role capability merge.
 *
 * Donor: Codex-Boss `electron/runtimes/runtime.ts` (`isRuntimeAvailable`),
 * `electron/runtimes/unsupported-runtime.ts` (`UnsupportedRuntime`) and
 * `electron/runtimes/web/provider-runtime-adapter.ts` (`ProviderRuntimeAdapter`)
 * @ 8df428eaa437a409368401e95194e40266b83080.
 *
 * Determinism: the donor's `UnsupportedRuntime.healthCheck` read the clock
 * directly (`new Date().toISOString()`). Here time is an injected parameter —
 * `now()` — so the module reads no clock of its own and the same call produces
 * the same bytes twice. `DONOR.json` records that single adaptation.
 */

import {
  RUNTIME_CAPABILITIES,
  runtimeCapabilities,
  runtimeFailure,
  runtimeHealth,
  runtimeRequest,
  runtimeResult,
  validateAvailability,
  validateRuntimeKind,
} from './contracts.mjs';

/** The donor's message for a runtime that is configured but not implemented. */
export const UNSUPPORTED_HEALTH_MESSAGE = 'Runtime is configured but not implemented in v0.5';

/** The donor's message for a refused execution. */
export const UNSUPPORTED_EXECUTE_MESSAGE = 'Runtime is not implemented';

/** The donor's exact refusal when a web runtime id does not carry the `web:` prefix. */
export const WEB_ID_PREFIX_ERROR = 'Web runtime id must start with web:';

/** The prefix every web runtime id must carry. */
export const WEB_ID_PREFIX = 'web:';

/** The `now` fallback: the Unix epoch, so a caller that omits the clock still gets a deterministic report. */
const EPOCH = () => new Date(0).toISOString();

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function requireNow(now) {
  if (now === undefined) return EPOCH;
  return requireFunction(now, 'now');
}

/**
 * Is this runtime availability usable right now?
 *
 * The donor's switch, value for value: only AVAILABLE returns true. BUSY,
 * AUTH_REQUIRED, RATE_LIMITED, BUDGET_EXHAUSTED, PAGE_CHANGED,
 * USER_ACTION_REQUIRED, UNSUPPORTED, DOWN and UNKNOWN all return false. UNKNOWN
 * is not a hopeful default — an unestablished readiness is a refusal.
 *
 * A value outside the ten-value vocabulary is refused rather than answered:
 * guessing "not available" for a typo would hide it, and this module does not
 * repair malformed input.
 *
 * @param {string} availability one of the ten `RUNTIME_AVAILABILITY` values
 * @returns {boolean} true only for AVAILABLE
 */
export function isRuntimeAvailable(availability) {
  validateAvailability(availability);
  switch (availability) {
    case 'AVAILABLE':
      return true;
    case 'BUSY':
    case 'AUTH_REQUIRED':
    case 'RATE_LIMITED':
    case 'BUDGET_EXHAUSTED':
    case 'PAGE_CHANGED':
    case 'USER_ACTION_REQUIRED':
    case 'UNSUPPORTED':
    case 'DOWN':
    case 'UNKNOWN':
      return false;
    /* c8 ignore next 2 -- unreachable in use: validateAvailability refused anything else above */
    default:
      throw new TypeError(`${String(availability)} is not one of the ten runtime availability values`);
  }
}

/**
 * Build the refusal adapter for a runtime that is configured but not implemented.
 *
 * Donor: `UnsupportedRuntime` — constructed with an id, a kind, and an optional
 * role list defaulting to none. Its capabilities are always
 * `{ roles, supportsCancellation: false, supportsStreaming: false }`: a runtime
 * that does nothing cannot cancel or stream anything.
 *
 * `healthCheck` and `execute` are async in the donor and stay async here.
 * `healthCheck` reports UNSUPPORTED with the donor's message and a `checkedAt`
 * taken from the injected `now()`.
 */
export function unsupportedRuntime({ id, kind, roles = [], now } = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('id must be a non-empty string');
  const runtimeId = id;
  const runtimeKind = validateRuntimeKind(kind);
  const capabilities = runtimeCapabilities({ roles, supportsCancellation: false, supportsStreaming: false });
  const clock = requireNow(now);
  return {
    id: runtimeId,
    kind: runtimeKind,
    capabilities,
    /** The donor reads the clock here; the clock is now a parameter. */
    async healthCheck() {
      return runtimeHealth({
        runtimeId,
        availability: 'UNSUPPORTED',
        message: UNSUPPORTED_HEALTH_MESSAGE,
        checkedAt: clock(),
      });
    },
    async execute(request) {
      const shape = runtimeRequest(request);
      return runtimeResult({
        runtimeId,
        jobId: shape.jobId,
        status: 'PERMANENT_FAILURE',
        failure: runtimeFailure({
          code: 'UNSUPPORTED',
          message: UNSUPPORTED_EXECUTE_MESSAGE,
          retryable: false,
        }),
      });
    },
  };
}

/**
 * Build a provider runtime adapter over injected hooks.
 *
 * Donor: `ProviderRuntimeAdapter`. Departures are the ones the donor itself
 * declared:
 *   - the id must start with `web:` or the constructor throws the donor's exact
 *     message, `Web runtime id must start with web:`;
 *   - the capabilities are the all-seven-role default
 *     `{ roles: [...], supportsCancellation: false, supportsStreaming: false }`
 *     merged with the caller's partial override;
 *   - `healthCheck` and `execute` delegate to the hooks, and `cancel` delegates
 *     when a hook exists and resolves otherwise (`this.hooks.cancel?.(jobId) ??
 *     Promise.resolve()`).
 *
 * The donor also carried a `compatibility` window literal (`{ id: 'web', kind:
 * 'web-session', windows: { adapter_api: { min: '1', max: '1' } } }`). The
 * compatibility contract is not part of this port, so the field is not invented
 * here; see `knownDifferences` in DONOR.json.
 *
 * A hook result is validated before it leaves the adapter, so a hook cannot
 * smuggle a malformed health report or result into the caller.
 *
 * The donor validated nothing at construction beyond the id prefix, and neither
 * does this: `healthCheck` and `execute` read their hook when they are called, so
 * an adapter with a missing hook is still constructible and fails only if that
 * method is actually used.
 */
export function providerRuntimeAdapter({ id, hooks, capabilities } = {}) {
  if (typeof id !== 'string' || !id.startsWith(WEB_ID_PREFIX)) throw new Error(WEB_ID_PREFIX_ERROR);
  if (hooks === null || typeof hooks !== 'object') throw new TypeError('hooks must be an object');
  if (hooks.cancel !== undefined) requireFunction(hooks.cancel, 'hooks.cancel');
  const declared = runtimeCapabilities(capabilities);
  return {
    id,
    kind: 'web',
    capabilities: declared,
    healthCheck() {
      // The hook is read inside the promise chain so a synchronous throw from a
      // hook lands as a rejection, matching the donor's `async` method.
      return Promise.resolve()
        .then(() => hooks.healthCheck())
        .then((reported) => runtimeHealth(reported));
    },
    execute(request, signal) {
      const shape = runtimeRequest(request);
      return Promise.resolve()
        .then(() => hooks.execute(shape, signal))
        .then((result) => runtimeResult(result));
    },
    cancel(jobId) {
      return hooks.cancel?.(jobId) ?? Promise.resolve();
    },
  };
}
