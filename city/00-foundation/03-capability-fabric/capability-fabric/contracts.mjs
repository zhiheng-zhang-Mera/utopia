/**
 * UTOPIA · City Service Network — capability fabric contracts.
 *
 * The value shapes the fabric is built from: a *provider* of a capability, a
 * *requirement* on one, and the stable outcome/state vocabulary an invocation
 * reports in. Nothing here is a runtime, and nothing here reaches the network,
 * the filesystem or a shell: a capability registration must be readable on its
 * own, years later, without the machinery that produced it.
 *
 * Donor provenance (pure migration, MODE=MIGRATION_ONLY):
 *
 *  - Codex-Boss `src/shared/provider-contracts.ts` @
 *    8df428eaa437a409368401e95194e40266b83080 — the provider identity fields
 *    (id/name/version), the `AdapterOutcome` runtime vocabulary and the
 *    `ProviderAccountMode` availability states. The Boss product fields that
 *    exist only to drive its own windows (url, accent, windowOpen, isCustom)
 *    are deliberately NOT carried: this module contacts nobody.
 *  - Codex-Boss `src/shared/provider-outcome.ts` @ the same SHA — the split
 *    between a *runtime* outcome (did the call work?) and a *semantic* outcome
 *    (did the output fulfil the goal?) and the rule that a runtime-layer fault is
 *    never evidence about the provider itself.
 *  - Codex-Boss `src/shared/provider-state.ts` @ the same SHA — the serialized
 *    provider lifecycle with the auto-resume flag and the retry deadline.
 *  - DS-Hns `app/core/contracts/capability.cjs` @
 *    eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973 — the shape of a capability
 *    vocabulary entry: a description, the expected providers and, above all, the
 *    documented fallback for when nobody provides it.
 *
 * Vocabulary:
 *   CapabilityDescriptor  what a provider declares it can be asked to do
 *   CapabilityRequirement what a consumer needs, and how hard it needs it
 *   RuntimeOutcome        whether the call worked
 *   ProviderAvailability  whether the provider may be called at all right now
 *   ProviderStateRecord   the serialized lifecycle of a provider
 *   InvocationRecord      one bounded call, its digest and its typed error
 *   LockEntry / LockVerdict  the strict composition lock and its drift verdict
 */

import { createHash } from 'node:crypto';

/** The fabric's own contract version. */
export const FABRIC_API_VERSION = 'utopia.capability-fabric/v1';

/** Default provider priority, matching the donor's `DEFAULT_PRIORITY`. */
export const DEFAULT_PRIORITY = 50;

/**
 * How many callback records each bounded ring retains.
 *
 * The donor bounded its capability lookup log at 200 (`capability-registry`),
 * its broker audit trails at 1000 (`capability-broker`) and its provider error
 * ring at 50 (`plugin-adapters/lifecycle`). One number is used here for the
 * lookup log and a separate, larger one for the invocation history so neither
 * promise is weakened.
 */
export const MAX_LOOKUPS = 200;
export const MAX_INVOCATIONS = 500;

// ---------------------------------------------------------------------------
// Refusal vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a capability lookup or registration was refused.
 *
 * Codes are values, never exceptions: a caller that has to catch is a caller
 * that cannot report. The two donor vocabularies are kept distinct here because
 * they are different support questions — a *registration* problem is a
 * composition error found before anything runs, a *resolution* problem is what
 * happened at call time.
 */
export const FABRIC_REASONS = Object.freeze({
  MISSING: 'capability is not provided by any loaded provider',
  CONFLICT: 'two providers offer the same capability at the same priority',
  REVOKED: 'the providing owner was unloaded',
  NAMELESS: 'a capability needs a name',
  OWNERLESS: 'a capability needs an owning provider',
  DUPLICATE: 'a provider with this identity is already registered',
  UNDESCRIBED: 'a provider must state what invoking its capability is able to do',
  UNKNOWN: 'nothing is known about this capability, so no fallback can be promised',
});

/**
 * Provider lifecycle states, matching the donor's four independent questions
 * (`installed` / `enabled` / `loaded` / `healthy`) collapsed into the single
 * label a report can print, in the donor's exact evaluation order.
 *
 *   not-registered  no provider record exists
 *   disabled        registered, but switched off
 *   enabled         switched on, not loaded yet
 *   loaded          loaded, health not asked
 *   healthy         loaded and the last health answer was healthy
 *   unhealthy       loaded and the last health answer was not healthy
 */
export const PROVIDER_STATES = Object.freeze([
  'not-registered',
  'disabled',
  'enabled',
  'loaded',
  'healthy',
  'unhealthy',
]);

/** Health answers a provider may give. `null` means "not asked", `null` is not a state. */
export const HEALTH_STATUS = Object.freeze(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);

/**
 * Fault levels, from the donor's `FAULT_LEVELS`.
 *
 * `soft` continues, `degraded` is reported and may be retried, `fatal` stops.
 * The distinction is preserved because collapsing it would turn every plugin
 * typo into an outage.
 */
export const FAULT_LEVELS = Object.freeze(['soft', 'degraded', 'fatal']);

// ---------------------------------------------------------------------------
// Runtime outcome — "did the call work?"
// ---------------------------------------------------------------------------

/**
 * Runtime-layer outcomes, from the donor's `AdapterOutcome`.
 *
 * These are deliberately NOT statements about the provider's willingness or
 * quality. A timeout, an authentication prompt or a rate limit says something
 * about the moment and nothing about what the provider can do.
 */
export const RUNTIME_OUTCOMES = Object.freeze([
  'SUCCESS',
  'CANCELLED',
  'TIMEOUT',
  'RETRYABLE_FAILURE',
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'PAGE_CHANGED',
  'FORMAT_INVALID',
  'USER_ACTION_REQUIRED',
  'UNSUPPORTED',
  'UNAVAILABLE',
  'INVALID_INPUT',
  'UNKNOWN',
]);

/**
 * Runtime outcomes that are never evidence about a provider's capability.
 *
 * Migrated from the donor's `NON_SEMANTIC_RUNTIME_CODES`. `INVALID_INPUT` is
 * included for the same reason: our own bad request is our fault, not the
 * provider's.
 */
export const NON_SEMANTIC_RUNTIME_CODES = Object.freeze([
  'TIMEOUT',
  'AUTH_REQUIRED',
  'PAGE_CHANGED',
  'RATE_LIMITED',
  'USER_ACTION_REQUIRED',
  'UNSUPPORTED',
  'UNAVAILABLE',
  'INVALID_INPUT',
  'CANCELLED',
  'UNKNOWN',
]);

/** The typed error a refused or failed invocation carries. */
const INVOCATION_ERROR_CODES = Object.freeze([
  'CAPABILITY_NOT_FOUND',
  'OPERATION_BLOCKED',
  'BRIDGE_PENDING',
  'UNAVAILABLE',
  'BUSY',
  'INVALID_INPUT',
  'EXECUTION_TIMEOUT',
  'ADAPTER_UNAVAILABLE',
  'ENGINE_UNAVAILABLE',
  'RESULT_TOO_LARGE',
  'BUILD_STORAGE_UNAVAILABLE',
  'GATEWAY_RESTARTED',
]);

export function isRuntimeOutcome(value) {
  return RUNTIME_OUTCOMES.includes(value);
}

export function isInvocationErrorCode(value) {
  return typeof value === 'string' && INVOCATION_ERROR_CODES.includes(value);
}

/** Is this runtime code a host/runtime problem rather than provider behaviour? */
export function isNonSemanticRuntimeCode(code) {
  if (typeof code !== 'string' || !code) return false;
  return NON_SEMANTIC_RUNTIME_CODES.includes(code);
}

/** The runtime outcome a typed error code reports as. */
export function runtimeOutcomeForError(errorCode) {
  switch (errorCode) {
    case 'EXECUTION_TIMEOUT':
      return 'TIMEOUT';
    case 'BUSY':
      return 'RETRYABLE_FAILURE';
    case 'ADAPTER_UNAVAILABLE':
    case 'ENGINE_UNAVAILABLE':
    case 'GATEWAY_RESTARTED':
      return 'UNAVAILABLE';
    case 'INVALID_INPUT':
    case 'RESULT_TOO_LARGE':
      return 'INVALID_INPUT';
    default:
      return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Provider availability — "may the provider be called at all?"
// ---------------------------------------------------------------------------

/**
 * The provider-side availability model, from the donor's `ProviderState`.
 *
 * `WAITING_PROVIDER` resumes on its own once the deadline passes (a rate-limit
 * reset, a retry); `PAUSED_PROVIDER` must NOT auto-resume because it is waiting
 * on a person (an approval, a login, a side effect to reconcile).
 */
export const PROVIDER_STATES_LIFECYCLE = Object.freeze([
  'ACTIVE',
  'WAITING_PROVIDER',
  'PAUSED_PROVIDER',
]);

/** Recovery actions that resume automatically. */
const AUTO_RECOVERY_ACTIONS = Object.freeze(['WAIT', 'RETRY', 'RECONSTRUCT', 'DEFER']);
/** Recovery actions that need a person. */
const HUMAN_RECOVERY_ACTIONS = Object.freeze(['HUMAN_REQUIRED', 'VERIFY_SIDE_EFFECT']);

/**
 * The recovery action for one runtime outcome.
 *
 * Migrated from the donor's recovery-action vocabulary; `SUCCESS` and our own
 * bad input produce no recovery at all.
 */
export function recoveryActionFor(runtimeOutcome) {
  switch (runtimeOutcome) {
    case 'SUCCESS':
      return 'NONE';
    case 'TIMEOUT':
    case 'RATE_LIMITED':
    case 'UNAVAILABLE':
    case 'RETRYABLE_FAILURE':
      return 'RETRY';
    case 'AUTH_REQUIRED':
    case 'USER_ACTION_REQUIRED':
    case 'PAGE_CHANGED':
      return 'HUMAN_REQUIRED';
    case 'INVALID_INPUT':
    case 'FORMAT_INVALID':
    case 'UNSUPPORTED':
      return 'NONE';
    case 'CANCELLED':
      return 'NONE';
    default:
      return 'DEFER';
  }
}

/**
 * Build the serialized provider lifecycle record for a recovery action.
 *
 * Faithful to the donor: `autoResume` is derived from the action, never passed
 * in, so a caller cannot claim a human-blocked provider resumes by itself.
 */
export function providerStateFor(recoveryAction, reason, retryAt, now = Date.now()) {
  const at = new Date(now).toISOString();
  if (AUTO_RECOVERY_ACTIONS.includes(recoveryAction)) {
    return {
      state: 'WAITING_PROVIDER',
      reason: reason || 'waiting for the provider to recover',
      autoResume: true,
      ...(retryAt === undefined ? {} : { retryAt }),
      updatedAt: at,
    };
  }
  if (HUMAN_RECOVERY_ACTIONS.includes(recoveryAction)) {
    return {
      state: 'PAUSED_PROVIDER',
      reason: reason || 'waiting for a person to act on the provider',
      autoResume: false,
      ...(retryAt === undefined ? {} : { retryAt }),
      updatedAt: at,
    };
  }
  return {
    state: 'ACTIVE',
    reason: reason || 'running',
    autoResume: true,
    ...(retryAt === undefined ? {} : { retryAt }),
    updatedAt: at,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export class FabricError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'FabricError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new FabricError('INVALID_INPUT', `${field} must be a non-empty string`);
  return value;
}

/** A provider identifier the fabric will accept. */
export function requireProviderId(value, field = 'providerId') {
  const id = text(value, field);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new FabricError('INVALID_INPUT', `${field} must match ^[a-z0-9][a-z0-9._-]*$`);
  return id;
}

/**
 * Validate a capability descriptor.
 *
 * A descriptor that does not say what invoking its capability is able to do is
 * refused, exactly as the donor's broker refused an undescribed adapter
 * provider: an undescribed grant cannot be reviewed.
 */
export function capabilityDescriptor(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new FabricError('INVALID_INPUT', 'capability must be an object');
  }
  const capabilityId = text(input.capabilityId, 'capabilityId');
  const name = text(input.name ?? capabilityId, 'name');
  const describes = text(input.describes, 'describes');
  const operations = Array.isArray(input.operations) ? input.operations.map((operation) => text(operation, 'operations[]')) : [];
  if (new Set(operations).size !== operations.length) {
    throw new FabricError('INVALID_INPUT', 'operations must be unique');
  }
  const priority = input.priority === undefined ? DEFAULT_PRIORITY : input.priority;
  if (!Number.isFinite(priority)) throw new FabricError('INVALID_INPUT', 'priority must be a finite number');
  return Object.freeze({
    capabilityId,
    name,
    describes,
    owner: text(input.owner, 'owner'),
    priority,
    version: input.version === undefined || input.version === null ? null : text(input.version, 'version'),
    operations: Object.freeze(operations),
    inputKind: input.inputKind === undefined ? 'unavailable' : text(input.inputKind, 'inputKind'),
    fallback: input.fallback === undefined ? null : text(input.fallback, 'fallback'),
  });
}

/** Validate a requirement on a capability. */
export function capabilityRequirement(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new FabricError('INVALID_INPUT', 'requirement must be an object');
  }
  if (typeof input.optional !== 'undefined' && typeof input.optional !== 'boolean') {
    throw new FabricError('INVALID_INPUT', 'requirement.optional must be a boolean');
  }
  return Object.freeze({
    capabilityId: text(input.capabilityId, 'capabilityId'),
    by: input.by === undefined ? null : text(input.by, 'by'),
    optional: input.optional === true,
  });
}

// ---------------------------------------------------------------------------
// Stable digests
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted, so two otherwise identical values always
 * produce the same bytes. Non-finite numbers are refused rather than silently
 * becoming `null`, which is what `JSON.stringify` would do.
 */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new FabricError('INVALID_INPUT', 'a non-finite number cannot be canonicalized');
  }
  return value;
}

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
