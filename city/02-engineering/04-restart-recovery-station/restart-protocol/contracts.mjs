/**
 * UTOPIA · Engineering — restart-recovery-station — restart protocol contracts.
 *
 * Donor: dsh-restart `src/shared/protocol.ts` and `src/shared/types.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. Read them side by side with this
 * file: every vocabulary, every value shape and every port below is a donor
 * declaration, carried as frozen data plus a strict constructor.
 *
 * What this module is: the shared wire protocol between a requester, the restart
 * plugin and the external supervisor, expressed so it can be read without the
 * implementation. Nothing here performs a restart, writes a file, talks to a
 * process or reads a clock.
 *
 * What the constructors are, and are not: each exported factory is a *copy
 * constructor*. It refuses input that does not satisfy the declared shape and
 * returns a frozen copy of exactly the declared fields. It never coerces,
 * defaults, trims or otherwise repairs invalid input into valid input — a caller
 * that wants the protocol's normalisation (trimming, the epoch `createdAt`
 * default, `priority: 'normal'`) must go through `validateShape` in
 * `request-validator.mjs`, which is the single admission gate. Stray caller
 * properties are not carried into the copy, so a checksum computed over canonical
 * JSON cannot be perturbed by a field the shape does not declare.
 *
 * Vocabulary:
 *   PROTOCOL_VERSION / TICKET_SCHEMA_VERSION  the two wire versions
 *   RESTART_MODES            application | system
 *   RESTART_PRIORITIES       low | normal | high | emergency
 *   RESTART_REASON_CODES     the stable codes a requester may raise
 *   RESTART_REQUEST_STATES   lifecycle of one request
 *   RESTART_LOCK_STATES      the exclusive restart lock
 *   SUPERVISOR_STATES        the supervisor state machine
 *   SELF_REASON_CODES        the codes the plugin itself may raise, with prose
 */

/** Current protocol version. Bump only for a breaking change. */
export const PROTOCOL_VERSION = 1;

/** On-disk schema version of a restart ticket. */
export const TICKET_SCHEMA_VERSION = 1;

/** Restart scope. */
export const RESTART_MODES = Object.freeze(['application', 'system']);

/**
 * How urgent the request is. Priority never bypasses validation — it is checked
 * against `RestartConfig.allowedPriorities` and nothing else.
 */
export const RESTART_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'emergency']);

/**
 * Stable reason codes.
 *
 * `dsh-restart` does not interpret these beyond logging them: deciding *why* a
 * restart is wanted belongs to the requester. The codes exist so an operator can
 * grep an incident afterwards. This is the known set, not a closed set: the donor
 * type is `RestartReasonCode | (string & {})`, and
 * `RestartConfig.knownReasonCodes` says unknown codes are logged, not refused.
 */
export const RESTART_REASON_CODES = Object.freeze([
  'RUNTIME_PRESSURE',
  'SYSTEM_PRESSURE',
  'MEMORY_LEAK',
  'THERMAL_STRESS',
  'UI_DEGRADATION',
  'COMPUTER_USE_STALL',
  'SCHEDULED_MAINTENANCE',
  'OPERATOR_REQUEST',
  'TEST',
]);

/** Lifecycle state of one restart request. */
export const RESTART_REQUEST_STATES = Object.freeze([
  'rejected',
  'queued',
  'checkpointing',
  'shutting_down',
  'relaunching',
  'verifying',
  'completed',
  'failed',
  'cancelled',
]);

/** The exclusive restart lock. At most one restart is ever in flight. */
export const RESTART_LOCK_STATES = Object.freeze([
  'IDLE',
  'REQUESTED',
  'CHECKPOINTING',
  'SHUTTING_DOWN',
  'RELAUNCHING',
  'VERIFYING',
]);

/** Supervisor state machine. */
export const SUPERVISOR_STATES = Object.freeze([
  'MONITORING',
  'WAITING_FOR_EXIT',
  'RELAUNCHING',
  'WAITING_FOR_HEARTBEAT',
  'VERIFIED',
  'CRASH_LOOP',
  'SAFE_MODE',
  'STOPPED',
]);

/** Reason codes the plugin itself may raise, each with its operator-facing prose. */
export const SELF_REASON_CODES = Object.freeze({
  DUPLICATE_REQUEST_ID: 'a request with this id has already been processed',
  UNKNOWN_SOURCE: 'the requesting source is not in the allow list',
  MODE_NOT_ALLOWED: 'this restart mode is disabled by configuration',
  SYSTEM_REBOOT_NOT_PERMITTED: 'system restart requires an explicit permission and acknowledgement',
  RESTART_IN_FLIGHT: 'another restart is already in progress',
  COOLDOWN_ACTIVE: 'the minimum interval for this restart mode has not elapsed',
  CHECKPOINT_REQUIRED: 'this request requires a checkpoint and none was produced',
  CHECKPOINT_FAILED: 'the harness refused to prepare a checkpoint',
  SHUTDOWN_TIMEOUT: 'the process did not exit inside the shutdown budget',
  SHUTDOWN_PORT_UNAVAILABLE: 'no shutdown capability is bound, so a graceful restart is impossible',
  SUPERVISOR_ABSENT: 'no supervisor heartbeat was seen, so a restart could not be observed',
  CRASH_LOOP: 'the crash-loop breaker has disabled automatic restart',
  INVALID_REQUEST: 'the request did not satisfy the protocol',
  DISABLED: 'restart execution is disabled by configuration',
});

/*
 * ---------------------------------------------------------------------------
 * Strict field checks. Each one throws; none of them substitutes a value.
 * ---------------------------------------------------------------------------
 */

function fail(message) {
  throw new TypeError(message);
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.trim() === '') fail(`${field} must be a non-empty string`);
  return value;
}

function requireNullableText(value, field) {
  if (value === null) return null;
  return requireText(value, field);
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`);
  return value;
}

function requireNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} must be a finite number`);
  return value;
}

function requireNonNegativeNumber(value, field) {
  requireNumber(value, field);
  if (value < 0) fail(`${field} must not be negative`);
  return value;
}

function requireNullableNumber(value, field) {
  if (value === null) return null;
  return requireNonNegativeNumber(value, field);
}

/**
 * A count, version, pid or sequence number.
 *
 * The donor declares these as `number`; a fractional or negative count is not a
 * count, and accepting one would let a shape pass validation while meaning
 * nothing. This is the one place the port is stricter than the donor's type.
 */
function requireCount(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer`);
  }
  return value;
}

function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) fail(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

function requireTextList(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return Object.freeze(value.map((entry, index) => requireText(entry, `${field}[${index}]`)));
}

function requireNullableTextList(value, field) {
  if (value === null) return null;
  return requireTextList(value, field);
}

function requireShapeList(value, field, validate) {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return Object.freeze(value.map((entry, index) => validate(entry, { name: `${field}[${index}]` })));
}

function requireCallable(value, field) {
  if (typeof value !== 'function') fail(`${field} must be a function`);
  return value;
}

/**
 * Build the frozen copy of one shape.
 *
 * Unknown properties are ignored; absent required properties are refused; absent
 * optional properties are omitted rather than written as `undefined`. In
 * `partial` mode (used only by `restartConfigOverrides`) an absent property is
 * simply not part of the copy.
 */
function construct(name, source, fields, options = {}) {
  const partial = options.partial === true;
  const shape = options.name ?? name;
  requireObject(source, shape);
  const out = {};
  for (const [key, field] of Object.entries(fields)) {
    if (!hasOwn(source, key) || source[key] === undefined) {
      if (partial || field.optional) continue;
      fail(`${shape}.${key} is required`);
    }
    out[key] = field.validate(source[key], `${shape}.${key}`);
  }
  return Object.freeze(out);
}

/*
 * ---------------------------------------------------------------------------
 * protocol.ts — RestartRequest, RestartResponse, RestartStatus and the
 * documents the supervisor trusts.
 * ---------------------------------------------------------------------------
 */

const RESTART_REQUEST_FIELDS = {
  requestId: { validate: (value, field) => requireText(value, field) },
  source: { validate: (value, field) => requireText(value, field) },
  mode: { validate: (value, field) => requireOneOf(value, RESTART_MODES, field) },
  reasonCode: { validate: (value, field) => requireText(value, field) },
  reasonSummary: { validate: (value, field) => requireText(value, field) },
  checkpointRequired: { validate: (value, field) => requireBoolean(value, field) },
  priority: { validate: (value, field) => requireOneOf(value, RESTART_PRIORITIES, field) },
  createdAt: { optional: true, validate: (value, field) => requireText(value, field) },
  acknowledgeSystemReboot: { optional: true, validate: (value, field) => requireBoolean(value, field) },
};

/**
 * Copy-construct a `RestartRequest` (donor `src/shared/protocol.ts`).
 *
 * `createdAt` and `acknowledgeSystemReboot` are the donor's two optional fields;
 * when absent they are absent from the copy. This constructor does not fill in
 * `priority` — the donor's `priority` is required here, and the `'normal'`
 * default belongs to the admission gate.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateRestartRequest(value, options = {}) {
  return construct('RestartRequest', value, RESTART_REQUEST_FIELDS, options);
}

/** Factory form of {@link validateRestartRequest}. Refuses what the validator refuses. */
export function restartRequest(value) {
  return validateRestartRequest(value);
}

const COOLDOWN_STATE_FIELDS = {
  nextAllowedAt: { validate: (value, field) => requireNullableText(value, field) },
  remainingMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  minimumIntervalMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
};

/**
 * Copy-construct a `CooldownState` (donor `src/shared/protocol.ts`): the earliest
 * instant another restart of one mode may start, the milliseconds remaining
 * (`0` when clear) and the enforced lower bound.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateCooldownState(value, options = {}) {
  return construct('CooldownState', value, COOLDOWN_STATE_FIELDS, options);
}

/** Factory form of {@link validateCooldownState}. */
export function cooldownState(value) {
  return validateCooldownState(value);
}

const CRASH_LOOP_STATE_FIELDS = {
  tripped: { validate: (value, field) => requireBoolean(value, field) },
  failuresInWindow: { validate: (value, field) => requireCount(value, field) },
  limit: { validate: (value, field) => requireCount(value, field) },
  windowMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  trippedAt: { validate: (value, field) => requireNullableText(value, field) },
  reason: { validate: (value, field) => requireNullableText(value, field) },
};

/**
 * Copy-construct a `CrashLoopState` (donor `src/shared/protocol.ts`): whether the
 * breaker has tripped, the unclean starts inside the window, the configured limit
 * and window, when it tripped and why.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateCrashLoopState(value, options = {}) {
  return construct('CrashLoopState', value, CRASH_LOOP_STATE_FIELDS, options);
}

/** Factory form of {@link validateCrashLoopState}. */
export function crashLoopState(value) {
  return validateCrashLoopState(value);
}

const SUPERVISOR_PRESENCE_FIELDS = {
  present: { validate: (value, field) => requireBoolean(value, field) },
  lastSeenAt: { validate: (value, field) => requireNullableText(value, field) },
  ageMs: { validate: (value, field) => requireNullableNumber(value, field) },
};

/**
 * Copy-construct a `SupervisorPresence` (donor `src/shared/protocol.ts`): whether
 * a supervisor heartbeat has been seen inside the timeout, when, and how old.
 *
 * `present: false` is the fact the admission ladder turns into
 * `SUPERVISOR_ABSENT` — without a supervisor, exiting the process is not a
 * restart, it is a shutdown.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateSupervisorPresence(value, options = {}) {
  return construct('SupervisorPresence', value, SUPERVISOR_PRESENCE_FIELDS, options);
}

/** Factory form of {@link validateSupervisorPresence}. */
export function supervisorPresence(value) {
  return validateSupervisorPresence(value);
}

const ATTEMPT_RECORD_FIELDS = {
  requestId: { validate: (value, field) => requireText(value, field) },
  ticketId: { validate: (value, field) => requireNullableText(value, field) },
  mode: { validate: (value, field) => requireOneOf(value, RESTART_MODES, field) },
  source: { validate: (value, field) => requireText(value, field) },
  reasonCode: { validate: (value, field) => requireText(value, field) },
  state: { validate: (value, field) => requireOneOf(value, RESTART_REQUEST_STATES, field) },
  startedAt: { validate: (value, field) => requireText(value, field) },
  finishedAt: { validate: (value, field) => requireText(value, field) },
  detail: { validate: (value, field) => requireText(value, field) },
  clean: { validate: (value, field) => requireBoolean(value, field) },
  outcomeCode: { validate: (value, field) => requireText(value, field) },
};

/**
 * Copy-construct a `RestartAttemptRecord` (donor `src/shared/protocol.ts`): one
 * completed or rejected attempt, kept for the audit trail.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateRestartAttemptRecord(value, options = {}) {
  return construct('RestartAttemptRecord', value, ATTEMPT_RECORD_FIELDS, options);
}

/** Factory form of {@link validateRestartAttemptRecord}. */
export function restartAttemptRecord(value) {
  return validateRestartAttemptRecord(value);
}

const ACTIVE_REQUEST_FIELDS = {
  requestId: { validate: (value, field) => requireText(value, field) },
  ticketId: { validate: (value, field) => requireText(value, field) },
  source: { validate: (value, field) => requireText(value, field) },
  mode: { validate: (value, field) => requireOneOf(value, RESTART_MODES, field) },
  reasonCode: { validate: (value, field) => requireText(value, field) },
  priority: { validate: (value, field) => requireOneOf(value, RESTART_PRIORITIES, field) },
  state: { validate: (value, field) => requireOneOf(value, RESTART_REQUEST_STATES, field) },
  createdAt: { validate: (value, field) => requireText(value, field) },
  updatedAt: { validate: (value, field) => requireText(value, field) },
  attempts: { validate: (value, field) => requireCount(value, field) },
};

/**
 * Copy-construct a `RestartActiveRequest` (donor `src/shared/protocol.ts`): the
 * in-flight request, as much of it as a caller may see.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateRestartActiveRequest(value, options = {}) {
  return construct('RestartActiveRequest', value, ACTIVE_REQUEST_FIELDS, options);
}

/** Factory form of {@link validateRestartActiveRequest}. */
export function restartActiveRequest(value) {
  return validateRestartActiveRequest(value);
}

const RESPONSE_FIELDS = {
  accepted: { validate: (value, field) => requireBoolean(value, field) },
  state: { validate: (value, field) => requireOneOf(value, RESTART_REQUEST_STATES, field) },
  reason: { optional: true, validate: (value, field) => requireText(value, field) },
  detail: { validate: (value, field) => requireText(value, field) },
  requestId: { validate: (value, field) => requireText(value, field) },
  ticketId: { optional: true, validate: (value, field) => requireText(value, field) },
};

/**
 * Copy-construct a `RestartResponse` (donor `src/shared/protocol.ts`): the answer
 * to a submitted request, with the request id echoed so a caller can correlate.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateRestartResponse(value, options = {}) {
  return construct('RestartResponse', value, RESPONSE_FIELDS, options);
}

/** Factory form of {@link validateRestartResponse}. */
export function restartResponse(value) {
  return validateRestartResponse(value);
}

/** Inline `RestartStatus.canRestart` — donor `src/shared/protocol.ts`. */
function validateCanRestart(value, field) {
  return construct(`${field}`, value, {
    allowed: { validate: (entry, name) => requireBoolean(entry, name) },
    reason: { validate: (entry, name) => requireText(entry, name) },
  });
}

/** Inline `RestartStatus.cooldowns` pair — donor `src/shared/protocol.ts`. */
function validateCooldownPair(value, field) {
  return construct(field, value, {
    application: { validate: (entry, name) => validateCooldownState(entry, { name }) },
    system: { validate: (entry, name) => validateCooldownState(entry, { name }) },
  });
}

/** Inline `RestartStatus.capabilities` — donor `src/shared/protocol.ts`. */
function validateCapabilities(value, field) {
  return construct(field, value, {
    applicationRestart: { validate: (entry, name) => requireBoolean(entry, name) },
    systemRestart: { validate: (entry, name) => requireBoolean(entry, name) },
    checkpointPort: { validate: (entry, name) => requireBoolean(entry, name) },
    shutdownPort: { validate: (entry, name) => requireBoolean(entry, name) },
    supervisorWatch: { validate: (entry, name) => requireBoolean(entry, name) },
  });
}

const STATUS_FIELDS = {
  timestamp: { validate: (value, field) => requireText(value, field) },
  enabled: { validate: (value, field) => requireBoolean(value, field) },
  lock: { validate: (value, field) => requireOneOf(value, RESTART_LOCK_STATES, field) },
  active: {
    validate: (value, field) => (value === null ? null : validateRestartActiveRequest(value, { name: field })),
  },
  canRestart: { validate: (value, field) => validateCanRestart(value, field) },
  cooldowns: { validate: (value, field) => validateCooldownPair(value, field) },
  recent: {
    validate: (value, field) => requireShapeList(value, field, validateRestartAttemptRecord),
  },
  crashLoop: { validate: (value, field) => validateCrashLoopState(value, { name: field }) },
  supervisor: { validate: (value, field) => validateSupervisorPresence(value, { name: field }) },
  capabilities: { validate: (value, field) => validateCapabilities(value, field) },
};

/**
 * Copy-construct a `RestartStatus` (donor `src/shared/protocol.ts`): everything an
 * operator or a requester can ask about the current situation, including the
 * configured capabilities, so a degraded install is visible rather than implied.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateRestartStatus(value, options = {}) {
  return construct('RestartStatus', value, STATUS_FIELDS, options);
}

/** Factory form of {@link validateRestartStatus}. */
export function restartStatus(value) {
  return validateRestartStatus(value);
}

const TICKET_FIELDS = {
  schemaVersion: { validate: (value, field) => requireCount(value, field) },
  ticketId: { validate: (value, field) => requireText(value, field) },
  requestId: { validate: (value, field) => requireText(value, field) },
  mode: { validate: (value, field) => requireOneOf(value, RESTART_MODES, field) },
  reasonCode: { validate: (value, field) => requireText(value, field) },
  reasonSummary: { validate: (value, field) => requireText(value, field) },
  pid: { validate: (value, field) => requireCount(value, field) },
  createdAt: { validate: (value, field) => requireText(value, field) },
  expiresAt: { validate: (value, field) => requireText(value, field) },
  cleanShutdown: { validate: (value, field) => requireBoolean(value, field) },
  checkpointId: { validate: (value, field) => requireNullableText(value, field) },
  checksum: { validate: (value, field) => requireText(value, field) },
};

/**
 * Copy-construct a `RestartTicket` (donor `src/shared/protocol.ts`): the on-disk
 * document the supervisor reads.
 *
 * The supervisor is a different process and must not trust the running plugin, so
 * the ticket is a self-describing, versioned, checksummed document. `checksum` is
 * `sha256:<hex>` over the ticket's canonical JSON without that field, exactly as
 * the donor computes it; this constructor carries it verbatim and never recomputes
 * or repairs it.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateRestartTicket(value, options = {}) {
  return construct('RestartTicket', value, TICKET_FIELDS, options);
}

/** Factory form of {@link validateRestartTicket}. */
export function restartTicket(value) {
  return validateRestartTicket(value);
}

const HEARTBEAT_FIELDS = {
  schemaVersion: { validate: (value, field) => requireCount(value, field) },
  supervisorPid: { validate: (value, field) => requireCount(value, field) },
  watchedPid: { validate: (value, field) => requireCount(value, field) },
  state: { validate: (value, field) => requireOneOf(value, SUPERVISOR_STATES, field) },
  timestamp: { validate: (value, field) => requireText(value, field) },
  sequence: { validate: (value, field) => requireCount(value, field) },
};

/**
 * Copy-construct a `SupervisorHeartbeat` (donor `src/shared/protocol.ts`): one
 * heartbeat, written where the plugin can read it. `sequence` is monotonic so a
 * reader can tell a fresh beat from a stale file.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateSupervisorHeartbeat(value, options = {}) {
  return construct('SupervisorHeartbeat', value, HEARTBEAT_FIELDS, options);
}

/** Factory form of {@link validateSupervisorHeartbeat}. */
export function supervisorHeartbeat(value) {
  return validateSupervisorHeartbeat(value);
}

/** Inline `SupervisorLedger.uncleanStarts[]` — donor `src/shared/protocol.ts`. */
function validateUncleanStart(value, field) {
  return construct(field, value, {
    at: { validate: (entry, name) => requireText(entry, name) },
    reason: { validate: (entry, name) => requireText(entry, name) },
  });
}

const LEDGER_FIELDS = {
  schemaVersion: { validate: (value, field) => requireCount(value, field) },
  uncleanStarts: { validate: (value, field) => requireShapeList(value, field, validateUncleanStart) },
  safeMode: { validate: (value, field) => requireBoolean(value, field) },
  safeModeReason: { validate: (value, field) => requireNullableText(value, field) },
  safeModeAt: { validate: (value, field) => requireNullableText(value, field) },
  relaunches: { validate: (value, field) => requireCount(value, field) },
};

/**
 * Copy-construct a `SupervisorLedger` (donor `src/shared/protocol.ts`): the
 * supervisor's own durable record of unclean starts, safe mode and relaunches.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateSupervisorLedger(value, options = {}) {
  return construct('SupervisorLedger', value, LEDGER_FIELDS, options);
}

/** Factory form of {@link validateSupervisorLedger}. */
export function supervisorLedger(value) {
  return validateSupervisorLedger(value);
}

/*
 * ---------------------------------------------------------------------------
 * types.ts — the configuration surface.
 *
 * Every value here is a bound the plugin enforces on itself, not a policy about
 * *when* to restart. The plugin has no opinion about timing: it is told to restart
 * and it either can, safely, or it refuses and says why.
 * ---------------------------------------------------------------------------
 */

const MODE_CONFIG_FIELDS = {
  enabled: { validate: (value, field) => requireBoolean(value, field) },
  minIntervalMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
};

/**
 * Copy-construct a `ModeConfig` (donor `src/shared/types.ts`): whether one restart
 * mode may be used at all, and the enforced lower bound between two restarts of
 * that mode in milliseconds.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateModeConfig(value, options = {}) {
  return construct('ModeConfig', value, MODE_CONFIG_FIELDS, options);
}

/** Factory form of {@link validateModeConfig}. */
export function modeConfig(value) {
  return validateModeConfig(value);
}

const SAFETY_CONFIG_FIELDS = {
  checkpointRequired: { validate: (value, field) => requireBoolean(value, field) },
  duplicateSuppression: { validate: (value, field) => requireBoolean(value, field) },
  crashLoopLimit: { validate: (value, field) => requireCount(value, field) },
  crashLoopWindowMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  safeModeOnLoop: { validate: (value, field) => requireBoolean(value, field) },
  shutdownTimeoutMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  allowForceTerminate: { validate: (value, field) => requireBoolean(value, field) },
  allowRestartWithoutSupervisor: { validate: (value, field) => requireBoolean(value, field) },
};

/**
 * Copy-construct a `SafetyConfig` (donor `src/shared/types.ts`): checkpoint and
 * duplicate-suppression rules, the crash-loop breaker, the shutdown budget and
 * whether a restart may be attempted without a supervisor.
 *
 * `allowRestartWithoutSupervisor` defaults to `false` in the donor's configuration
 * resolver, not here: without a supervisor, exiting the process is not a restart,
 * it is a shutdown, and an unhealthy app that never comes back is worse than an
 * unhealthy app that is still running.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateSafetyConfig(value, options = {}) {
  return construct('SafetyConfig', value, SAFETY_CONFIG_FIELDS, options);
}

/** Factory form of {@link validateSafetyConfig}. */
export function safetyConfig(value) {
  return validateSafetyConfig(value);
}

const SUPERVISOR_CONFIG_FIELDS = {
  heartbeatIntervalMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  heartbeatTimeoutMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  relaunchTimeoutMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  launchCommand: { validate: (value, field) => requireNullableTextList(value, field) },
  launchArgs: { validate: (value, field) => requireTextList(value, field) },
  launchCwd: { validate: (value, field) => requireNullableText(value, field) },
  pollIntervalMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  ticketTtlMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  detach: { validate: (value, field) => requireBoolean(value, field) },
  relaunchBackoffMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  relaunchBackoffMaxMs: { validate: (value, field) => requireNonNegativeNumber(value, field) },
};

/**
 * Copy-construct a `SupervisorConfig` (donor `src/shared/types.ts`): supervisor
 * timing and wiring.
 *
 * `launchCommand: null` means "reuse argv". A relaunch that fails is retried with
 * an exponential delay up to `relaunchBackoffMaxMs`, because a launch that fails
 * once usually fails again immediately — and a supervisor that retries in a tight
 * loop is indistinguishable from a fork bomb.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateSupervisorConfig(value, options = {}) {
  return construct('SupervisorConfig', value, SUPERVISOR_CONFIG_FIELDS, options);
}

/** Factory form of {@link validateSupervisorConfig}. */
export function supervisorConfig(value) {
  return validateSupervisorConfig(value);
}

const STORAGE_CONFIG_FIELDS = {
  directory: { validate: (value, field) => requireNullableText(value, field) },
  maxLogBytes: { validate: (value, field) => requireNonNegativeNumber(value, field) },
  maxRecentAttempts: { validate: (value, field) => requireCount(value, field) },
};

/**
 * Copy-construct a `StorageConfig` (donor `src/shared/types.ts`): where durable
 * state lives. `directory: null` means the donor's default location, and is
 * carried as `null` rather than resolved here — resolving it would need the
 * environment, and nothing in this module reads one.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateStorageConfig(value, options = {}) {
  return construct('StorageConfig', value, STORAGE_CONFIG_FIELDS, options);
}

/** Factory form of {@link validateStorageConfig}. */
export function storageConfig(value) {
  return validateStorageConfig(value);
}

const RESTART_CONFIG_FIELDS = {
  enabled: { validate: (value, field) => requireBoolean(value, field) },
  applicationRestart: { validate: (value, field) => validateModeConfig(value, { name: field }) },
  systemRestart: { validate: (value, field) => validateModeConfig(value, { name: field }) },
  allowedSources: { validate: (value, field) => requireTextList(value, field) },
  allowedPriorities: {
    validate: (value, field) => {
      if (!Array.isArray(value)) fail(`${field} must be an array`);
      return Object.freeze(value.map((entry, index) => requireOneOf(entry, RESTART_PRIORITIES, `${field}[${index}]`)));
    },
  },
  allowSystemReboot: { validate: (value, field) => requireBoolean(value, field) },
  safety: { validate: (value, field) => validateSafetyConfig(value, { name: field }) },
  supervisor: { validate: (value, field) => validateSupervisorConfig(value, { name: field }) },
  storage: { validate: (value, field) => validateStorageConfig(value, { name: field }) },
  knownReasonCodes: { validate: (value, field) => requireTextList(value, field) },
};

/**
 * Copy-construct the complete `RestartConfig` (donor `src/shared/types.ts`).
 *
 * `enabled` is the master switch: when false the donor's admission ladder refuses
 * every request with `DISABLED`. `allowedSources` is the authorization list —
 * "something on this machine asked me to reboot it" is not permission.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateRestartConfig(value, options = {}) {
  return construct('RestartConfig', value, RESTART_CONFIG_FIELDS, options);
}

/** Factory form of {@link validateRestartConfig}. */
export function restartConfig(value) {
  return validateRestartConfig(value);
}

const OVERRIDES_FIELDS = {
  enabled: { optional: true, validate: (value, field) => requireBoolean(value, field) },
  applicationRestart: {
    optional: true,
    validate: (value, field) => validateModeConfig(value, { partial: true, name: field }),
  },
  systemRestart: {
    optional: true,
    validate: (value, field) => validateModeConfig(value, { partial: true, name: field }),
  },
  allowedSources: { optional: true, validate: (value, field) => requireTextList(value, field) },
  allowedPriorities: {
    optional: true,
    validate: (value, field) => {
      if (!Array.isArray(value)) fail(`${field} must be an array`);
      return Object.freeze(value.map((entry, index) => requireOneOf(entry, RESTART_PRIORITIES, `${field}[${index}]`)));
    },
  },
  allowSystemReboot: { optional: true, validate: (value, field) => requireBoolean(value, field) },
  safety: { optional: true, validate: (value, field) => validateSafetyConfig(value, { partial: true, name: field }) },
  supervisor: {
    optional: true,
    validate: (value, field) => validateSupervisorConfig(value, { partial: true, name: field }),
  },
  storage: { optional: true, validate: (value, field) => validateStorageConfig(value, { partial: true, name: field }) },
  knownReasonCodes: { optional: true, validate: (value, field) => requireTextList(value, field) },
};

/**
 * Copy-construct a `RestartConfigOverrides` (donor `src/shared/types.ts`), the
 * deeply partial configuration document.
 *
 * Only the ten declared keys are carried, and each present sub-document is itself
 * partial: `{ safety: { checkpointRequired: true } }` is a complete overrides
 * document that says nothing about the rest of `SafetyConfig`. Merging overrides
 * onto a base configuration is *not* done here — the donor does it in its
 * configuration resolver, which is out of scope for this port.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateRestartConfigOverrides(value, options = {}) {
  return construct('RestartConfigOverrides', value, OVERRIDES_FIELDS, options);
}

/** Factory form of {@link validateRestartConfigOverrides}. */
export function restartConfigOverrides(value) {
  return validateRestartConfigOverrides(value);
}

/*
 * ---------------------------------------------------------------------------
 * types.ts — the results and value shapes the admission gate produces.
 * ---------------------------------------------------------------------------
 */

const NORMALIZED_REQUEST_FIELDS = {
  requestId: { validate: (value, field) => requireText(value, field) },
  source: { validate: (value, field) => requireText(value, field) },
  mode: { validate: (value, field) => requireOneOf(value, RESTART_MODES, field) },
  reasonCode: { validate: (value, field) => requireText(value, field) },
  reasonSummary: { validate: (value, field) => requireText(value, field) },
  checkpointRequired: { validate: (value, field) => requireBoolean(value, field) },
  priority: { validate: (value, field) => requireOneOf(value, RESTART_PRIORITIES, field) },
  createdAt: { validate: (value, field) => requireText(value, field) },
  acknowledgeSystemReboot: { validate: (value, field) => requireBoolean(value, field) },
};

/**
 * Copy-construct a `NormalizedRequest` (donor `src/shared/types.ts`): a validated,
 * immutable request, where every optional field of `RestartRequest` now has a
 * value.
 *
 * This is the *value shape*, so all nine fields are required and nothing is
 * defaulted: `createdAt` must already be an instant and `priority` must already be
 * one of the four. The donor's normalisation — trimming, `priority ?? 'normal'`
 * and `createdAt ?? new Date(0).toISOString()` — happens in `validateShape`, which
 * is the gate a request must pass before a value of this shape exists.
 *
 * `reasonCode` is deliberately a plain string, not a member of
 * `RESTART_REASON_CODES`: an unknown code is logged, not refused.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateNormalizedRequest(value, options = {}) {
  return construct('NormalizedRequest', value, NORMALIZED_REQUEST_FIELDS, options);
}

/** Factory form of {@link validateNormalizedRequest}. */
export function normalizedRequest(value) {
  return validateNormalizedRequest(value);
}

const VALIDATION_RESULT_FIELDS = {
  valid: { validate: (value, field) => requireBoolean(value, field) },
  code: { validate: (value, field) => requireNullableText(value, field) },
  detail: { validate: (value, field) => requireText(value, field) },
  request: {
    validate: (value, field) => (value === null ? null : validateNormalizedRequest(value, { name: field })),
  },
};

/**
 * Copy-construct a `ValidationResult` (donor `src/shared/types.ts`): whether the
 * request may proceed to execution, the machine-readable code when it may not, the
 * human-readable detail, and the normalized request when it may.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateValidationResult(value, options = {}) {
  return construct('ValidationResult', value, VALIDATION_RESULT_FIELDS, options);
}

/** Factory form of {@link validateValidationResult}. */
export function validationResult(value) {
  return validateValidationResult(value);
}

const CHECKPOINT_OUTCOME_FIELDS = {
  safe: { validate: (value, field) => requireBoolean(value, field) },
  reason: { validate: (value, field) => requireText(value, field) },
  checkpointId: { validate: (value, field) => requireNullableText(value, field) },
  resumeToken: { validate: (value, field) => requireNullableText(value, field) },
  completed: { validate: (value, field) => requireBoolean(value, field) },
  detail: { validate: (value, field) => requireText(value, field) },
};

/**
 * Copy-construct a `CheckpointOutcome` (donor `src/shared/types.ts`): what the
 * harness must answer before a restart may be authorized.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateCheckpointOutcome(value, options = {}) {
  return construct('CheckpointOutcome', value, CHECKPOINT_OUTCOME_FIELDS, options);
}

/** Factory form of {@link validateCheckpointOutcome}. */
export function checkpointOutcome(value) {
  return validateCheckpointOutcome(value);
}

const VALIDATOR_CONTEXT_FIELDS = {
  nowMs: { validate: (value, field) => requireNumber(value, field) },
  restartInFlight: { validate: (value, field) => requireBoolean(value, field) },
  cooldowns: {
    validate: (value, field) =>
      construct(field, value, {
        application: { validate: (entry, name) => requireNonNegativeNumber(entry, name) },
        system: { validate: (entry, name) => requireNonNegativeNumber(entry, name) },
      }),
  },
  isDuplicate: { validate: (value, field) => requireBoolean(value, field) },
  crashLoopTripped: { validate: (value, field) => requireBoolean(value, field) },
  supervisorPresent: { validate: (value, field) => requireBoolean(value, field) },
  checkpointPortAvailable: { validate: (value, field) => requireBoolean(value, field) },
};

/**
 * Copy-construct a `ValidatorContext` (donor `src/plugin/request-validator.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd): the facts the admission ladder needs
 * about the world right now.
 *
 * Every fact is injected — the evaluation instant, whether a restart is in flight,
 * the cooldown deadlines, duplicate and crash-loop state, supervisor presence and
 * checkpoint-port availability. That is what keeps `validateRequest` a pure
 * function of its arguments.
 *
 * @param {unknown} value - an untrusted candidate.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateValidatorContext(value, options = {}) {
  return construct('ValidatorContext', value, VALIDATOR_CONTEXT_FIELDS, options);
}

/** Factory form of {@link validateValidatorContext}. */
export function validatorContext(value) {
  return validateValidatorContext(value);
}

/*
 * ---------------------------------------------------------------------------
 * types.ts — the three seams.
 *
 * Ports are carried as documented data: a port is an object a caller binds, and
 * these constructors check that an object claiming to be one carries a stable id
 * and the callables the contract names. Nothing here calls a port.
 * ---------------------------------------------------------------------------
 */

const CHECKPOINT_PORT_FIELDS = {
  id: { validate: (value, field) => requireText(value, field) },
  prepareForRestart: { validate: (value, field) => requireCallable(value, field) },
  acknowledgeResume: { validate: (value, field) => requireCallable(value, field) },
};

/**
 * The checkpoint seam — donor `CheckpointPort` in `src/shared/types.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd.
 *
 * `dsh-restart` never saves task state. It asks the harness to, and it believes
 * only the answer. There is deliberately no default implementation that reports
 * success: an unbound port means "cannot verify", which means "do not restart" —
 * the admission ladder turns that into `CHECKPOINT_FAILED` whenever
 * `SafetyConfig.checkpointRequired` is true.
 *
 *   id                 stable port id, for diagnostics
 *   prepareForRestart(mode)          ask the harness to prepare for a restart
 *   acknowledgeResume(resumeToken)   report that the harness came back
 *
 * @param {unknown} value - the candidate port binding.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateCheckpointPort(value, options = {}) {
  return construct('CheckpointPort', value, CHECKPOINT_PORT_FIELDS, options);
}

/** Factory form of {@link validateCheckpointPort}. */
export function checkpointPort(value) {
  return validateCheckpointPort(value);
}

const SHUTDOWN_PORT_FIELDS = {
  id: { validate: (value, field) => requireText(value, field) },
  requestShutdown: { validate: (value, field) => requireCallable(value, field) },
};

/**
 * The shutdown seam — donor `ShutdownPort` in `src/shared/types.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd.
 *
 * The only thing this plugin may ask the *host* to do. It never calls
 * `process.exit`, never signals a pid, and never shells out: the harness owns its
 * own lifecycle, and the supervisor owns the relaunch. `requestShutdown(reason)`
 * takes the ticket id, so the harness can log why it is exiting, and answers
 * `true` only when the request was accepted and the exit is expected.
 *
 *   id                          stable port id, for diagnostics
 *   requestShutdown(reason)     request a graceful shutdown of the harness
 *
 * @param {unknown} value - the candidate port binding.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateShutdownPort(value, options = {}) {
  return construct('ShutdownPort', value, SHUTDOWN_PORT_FIELDS, options);
}

/** Factory form of {@link validateShutdownPort}. */
export function shutdownPort(value) {
  return validateShutdownPort(value);
}

const SYSTEM_SHUTDOWN_PORT_FIELDS = {
  id: { validate: (value, field) => requireText(value, field) },
  requestSystemRestart: { validate: (value, field) => requireCallable(value, field) },
};

/**
 * The system-reboot seam — donor `SystemShutdownPort` in `src/shared/types.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd.
 *
 * Implemented by a Windows-only helper script in the donor repository. It is
 * deliberately a separate port from `ShutdownPort` so that "reboot the machine"
 * can be absent while "restart the app" works: an application restart must never
 * depend on a system port being bound.
 *
 *   id                                     stable port id, for diagnostics
 *   requestSystemRestart(reason, delaySeconds)   request an operating-system restart
 *
 * @param {unknown} value - the candidate port binding.
 * @param {{partial?: boolean, name?: string}} [options] - internal use.
 * @returns {Readonly<object>}
 */
export function validateSystemShutdownPort(value, options = {}) {
  return construct('SystemShutdownPort', value, SYSTEM_SHUTDOWN_PORT_FIELDS, options);
}

/** Factory form of {@link validateSystemShutdownPort}. */
export function systemShutdownPort(value) {
  return validateSystemShutdownPort(value);
}
