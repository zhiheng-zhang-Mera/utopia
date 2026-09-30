/**
 * UTOPIA · City · Worker Gateway — provider adapter contracts.
 *
 * The value shapes and closed vocabularies a runtime adapter is described by,
 * expressed as data plus small factories and validators. Nothing here owns a
 * process, a network connection or a clock: an adapter *declares* what it is and
 * a caller decides whether to use it.
 *
 * Donor: Codex-Boss `electron/runtimes/runtime.ts` (types `RuntimeKind`,
 * `RuntimeAvailability`, `RuntimeCapability`, `RuntimeCapabilities`,
 * `RuntimeHealth`, `RuntimeRequest`, `RuntimeFailure`, `RuntimeMetrics`,
 * `ProviderUsage`, `RuntimeResult`, `RuntimeAdapter`) and
 * `electron/runtimes/web/provider-runtime-adapter.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The donor's TypeScript interfaces become plain value shapes here. The
 * `RuntimeAdapter` interface's behavioural half (healthCheck / execute / cancel)
 * lives in `runtime.mjs`; this module only fixes the vocabulary and the shapes
 * those values take.
 *
 * Two contract rules are deliberate:
 *   - every factory returns a **copy** built from validated input, so mutating
 *     the caller's object afterwards cannot reach inside a shape that was
 *     already accepted;
 *   - a factory never *repairs* malformed input. An unknown availability, role,
 *     kind or status is refused, so validation stays the single gate instead of
 *     being quietly softened by whichever factory happened to run first.
 */

/** The runtime kinds the donor knows. `web` is the only kind implemented here. */
export const RUNTIME_KINDS = Object.freeze(['web', 'codex', 'api', 'local']);

/**
 * The ten-value availability vocabulary, in the donor's declaration order.
 *
 * Exactly one of these means "usable now": AVAILABLE. Every other value is a
 * reason a runtime cannot serve a request, including UNKNOWN, which is not an
 * optimistic default but an admission that readiness was never established.
 */
export const RUNTIME_AVAILABILITY = Object.freeze([
  'AVAILABLE',
  'BUSY',
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'BUDGET_EXHAUSTED',
  'PAGE_CHANGED',
  'USER_ACTION_REQUIRED',
  'UNSUPPORTED',
  'DOWN',
  'UNKNOWN',
]);

/** The seven capability roles a runtime may fill. */
export const RUNTIME_CAPABILITIES = Object.freeze([
  'planning',
  'research',
  'review',
  'synthesis',
  'coding',
  'validation',
  'critique',
]);

/**
 * The four statuses a runtime result may carry, in the donor's declaration order.
 */
export const RUNTIME_RESULT_STATUSES = Object.freeze([
  'SUCCESS',
  'RETRYABLE_FAILURE',
  'PERMANENT_FAILURE',
  'CANCELLED',
]);

/** The four statuses that mean the work did not succeed. */
export const RUNTIME_FAILURE_STATUSES = Object.freeze([
  'RETRYABLE_FAILURE',
  'PERMANENT_FAILURE',
  'CANCELLED',
]);

/** The three provider lifecycle states, in the donor's declaration order. */
export const PROVIDER_STATES = Object.freeze(['ACTIVE', 'WAITING_PROVIDER', 'PAUSED_PROVIDER']);

/**
 * Failure codes a `RuntimeFailure` may carry: the ten availability values (the
 * donor's `RuntimeAvailability` union member) plus the two non-availability
 * codes the donor's union also allowed.
 */
export const RUNTIME_FAILURE_CODES = Object.freeze([...RUNTIME_AVAILABILITY, 'TIMEOUT', 'UNKNOWN']);

const AVAILABILITY_SET = new Set(RUNTIME_AVAILABILITY);
const CAPABILITY_SET = new Set(RUNTIME_CAPABILITIES);
const KIND_SET = new Set(RUNTIME_KINDS);
const RESULT_STATUS_SET = new Set(RUNTIME_RESULT_STATUSES);
const FAILURE_CODE_SET = new Set(RUNTIME_FAILURE_CODES);
const PROVIDER_STATE_SET = new Set(PROVIDER_STATES);

function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireOptionalText(value, field) {
  if (value === undefined) return undefined;
  return requireText(value, field);
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function requireFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
  return value;
}

function requireMember(value, allowed, field) {
  if (!allowed.has(value)) throw new TypeError(`${field} must be one of ${[...allowed].join(', ')}`);
  return value;
}

/** Validate a runtime kind. */
export function validateRuntimeKind(kind) {
  return requireMember(kind, KIND_SET, 'kind');
}

/** Validate one availability value. */
export function validateAvailability(availability) {
  return requireMember(availability, AVAILABILITY_SET, 'availability');
}

/** Validate one capability role. */
export function validateCapability(role) {
  return requireMember(role, CAPABILITY_SET, 'role');
}

/** Validate one runtime result status. */
export function validateResultStatus(status) {
  return requireMember(status, RESULT_STATUS_SET, 'status');
}

/** Validate one runtime failure code. */
export function validateFailureCode(code) {
  return requireMember(code, FAILURE_CODE_SET, 'failure.code');
}

/** Validate one provider lifecycle state. */
export function validateProviderState(state) {
  return requireMember(state, PROVIDER_STATE_SET, 'state');
}

/** Is this a role an adapter may declare? */
export function isRuntimeCapability(role) {
  return CAPABILITY_SET.has(role);
}

/**
 * Validate a runtime request.
 *
 * The donor's `RuntimeRequest` has three optional fields (`sessionId`,
 * `replaySafe`, `timeoutMs`) and five required ones. Optional fields are copied
 * only when the caller supplied them, so an absent `sessionId` stays absent
 * rather than becoming `undefined`-valued.
 */
export function runtimeRequest(request) {
  requireObject(request, 'request');
  const shape = {
    jobId: requireText(request.jobId, 'request.jobId'),
    taskId: requireText(request.taskId, 'request.taskId'),
    role: validateCapability(request.role),
    prompt: requireText(request.prompt, 'request.prompt'),
  };
  const sessionId = requireOptionalText(request.sessionId, 'request.sessionId');
  if (sessionId !== undefined) shape.sessionId = sessionId;
  if (request.replaySafe !== undefined) shape.replaySafe = requireBoolean(request.replaySafe, 'request.replaySafe');
  if (request.timeoutMs !== undefined) shape.timeoutMs = requireFiniteNumber(request.timeoutMs, 'request.timeoutMs');
  const context = requireOptionalText(request.context, 'request.context');
  if (context !== undefined) shape.context = context;
  return shape;
}

/**
 * Validate a runtime capabilities declaration.
 *
 * This is the donor's default-role merge (`roles: [...all seven roles],
 * supportsCancellation: false, supportsStreaming: false` followed by the
 * caller's partial override) as a shape, and it is what both adapters delegate
 * to, so the merge exists once.
 */
export function runtimeCapabilities(capabilities = {}) {
  requireObject(capabilities, 'capabilities');
  const roles = capabilities.roles === undefined
    ? [...RUNTIME_CAPABILITIES]
    : requireArray(capabilities.roles, 'capabilities.roles').map((role) => validateCapability(role));
  if (new Set(roles).size !== roles.length) throw new TypeError('capabilities.roles must be unique');
  const shape = {
    roles,
    supportsCancellation: capabilities.supportsCancellation === undefined
      ? false
      : requireBoolean(capabilities.supportsCancellation, 'capabilities.supportsCancellation'),
    supportsStreaming: capabilities.supportsStreaming === undefined
      ? false
      : requireBoolean(capabilities.supportsStreaming, 'capabilities.supportsStreaming'),
  };
  if (capabilities.consumesModel !== undefined) {
    shape.consumesModel = requireBoolean(capabilities.consumesModel, 'capabilities.consumesModel');
  }
  return shape;
}

/**
 * Validate a runtime health report.
 *
 * `checkedAt` is carried as the donor carried it — an injected timestamp string.
 * This module never reads a clock, so the caller decides what that string means.
 */
export function runtimeHealth(health) {
  requireObject(health, 'health');
  return {
    runtimeId: requireText(health.runtimeId, 'health.runtimeId'),
    availability: validateAvailability(health.availability),
    message: requireText(health.message, 'health.message'),
    checkedAt: requireText(health.checkedAt, 'health.checkedAt'),
  };
}

/**
 * Validate a runtime failure.
 *
 * `retryAt` is present only when the caller defined it: the donor's optional
 * field, and the same conditional-presence rule `provider-state.mjs` keeps.
 */
export function runtimeFailure(failure) {
  requireObject(failure, 'failure');
  const shape = {
    code: validateFailureCode(failure.code),
    message: requireText(failure.message, 'failure.message'),
    retryable: requireBoolean(failure.retryable, 'failure.retryable'),
  };
  if (failure.retryAt !== undefined) shape.retryAt = requireFiniteNumber(failure.retryAt, 'failure.retryAt');
  return shape;
}

/** Validate a runtime metrics record. */
export function runtimeMetrics(metrics) {
  requireObject(metrics, 'metrics');
  return {
    startedAt: requireText(metrics.startedAt, 'metrics.startedAt'),
    completedAt: requireText(metrics.completedAt, 'metrics.completedAt'),
    durationMs: requireFiniteNumber(metrics.durationMs, 'metrics.durationMs'),
  };
}

/**
 * Validate provider-reported token usage.
 *
 * Every field is optional and means "the provider reported this number". An
 * absent field is not zero and is never estimated — the donor's own rule — so
 * this copies only the fields the caller actually supplied. There is no default
 * of 0 anywhere in this function.
 */
export function providerUsage(usage = {}) {
  requireObject(usage, 'usage');
  const shape = {};
  if (usage.inputTokens !== undefined) shape.inputTokens = requireFiniteNumber(usage.inputTokens, 'usage.inputTokens');
  if (usage.outputTokens !== undefined) shape.outputTokens = requireFiniteNumber(usage.outputTokens, 'usage.outputTokens');
  if (usage.totalTokens !== undefined) shape.totalTokens = requireFiniteNumber(usage.totalTokens, 'usage.totalTokens');
  return shape;
}

/**
 * Validate a runtime result.
 *
 * The donor's `artifact` and `content` stay optional and un-typed here: an
 * artifact is the caller's own record and `content` is free text, so this
 * factory copies them through rather than asserting a shape it does not own.
 * Nested `failure`, `metrics` and `usage` are validated, so a malformed result
 * is refused at construction instead of surfacing halfway through a supervisor.
 */
export function runtimeResult(result) {
  requireObject(result, 'result');
  const shape = {
    runtimeId: requireText(result.runtimeId, 'result.runtimeId'),
    jobId: requireText(result.jobId, 'result.jobId'),
    status: validateResultStatus(result.status),
  };
  if (result.artifact !== undefined) shape.artifact = result.artifact;
  if (result.content !== undefined) shape.content = requireText(result.content, 'result.content');
  if (result.failure !== undefined) shape.failure = runtimeFailure(result.failure);
  if (result.metrics !== undefined) shape.metrics = runtimeMetrics(result.metrics);
  if (result.usage !== undefined) shape.usage = providerUsage(result.usage);
  return shape;
}

/**
 * Validate a provider lifecycle state record.
 *
 * `retryAt` is the donor's conditional field: present only when defined.
 */
export function providerStateRecord(record) {
  requireObject(record, 'record');
  const shape = {
    state: validateProviderState(record.state),
    reason: requireText(record.reason, 'record.reason'),
    autoResume: requireBoolean(record.autoResume, 'record.autoResume'),
  };
  if (record.retryAt !== undefined) shape.retryAt = requireFiniteNumber(record.retryAt, 'record.retryAt');
  shape.updatedAt = requireText(record.updatedAt, 'record.updatedAt');
  return shape;
}
