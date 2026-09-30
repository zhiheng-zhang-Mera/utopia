// General AI Gateway — core contracts and user-level action vocabulary (GAI-001).
//
// Provider-neutral, transport-neutral contract layer for general-AI requests, results,
// partial output, attention, escalation and usage. Pure module: no filesystem, network,
// clock or ambient state.
//
// Two hard boundaries this file exists to make machine-checkable:
//   1. `GENERAL_AI` is a *user-level Action route*. `BOSS` is not a route, never was, and
//      nothing here may depend on that historical product.
//   2. No canonical envelope carries raw credential/cookie/token bytes — only bounded
//      handles the platform credential store owns.
export const GAI_CONTRACT_VERSION = 1;
export const GENERAL_AI_ROUTE = 'GENERAL_AI';
/** Routes that already existed before this task. Their semantics are unchanged. */
export const LEGACY_ACTION_ROUTES = Object.freeze(['ROOM', 'CAPABILITY', 'CITY_TASK']);
/** The complete user-level route vocabulary after GAI-001. */
export const ACTION_ROUTES_V1 = Object.freeze([...LEGACY_ACTION_ROUTES, GENERAL_AI_ROUTE]);
/** A historical product name must never become a route. */
export const FORBIDDEN_ROUTE_PATTERN = /boss/i;

export const CHANNELS = Object.freeze(['WEB', 'API']);
export const ACTION_STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNAVAILABLE']);
export const ACTION_TERMINAL_STATUSES = Object.freeze(['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED']);
export const ACTION_IN_FLIGHT_STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'WAITING_CONFIRMATION']);
/** Terminal for this attempt, but retryable by a *new* action with a new key. */
export const ACTION_RETRYABLE_STATUS = 'UNAVAILABLE';

export const PROVIDER_HEALTH = Object.freeze(['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN']);
export const AUTH_STATUSES = Object.freeze(['UNKNOWN', 'UNAUTHENTICATED', 'PENDING', 'AUTHENTICATED', 'EXPIRED', 'REVOKED']);
export const JEV_COMPLEXITY = Object.freeze(['TRIVIAL', 'NORMAL', 'HARD']);
export const JEV_RISK = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const ATTENTION_KINDS = Object.freeze(['USER_CONFIRMATION', 'CREDENTIAL_REQUIRED', 'PROVIDER_UNAVAILABLE', 'BUDGET_APPROVAL']);
export const BUDGET_DECISIONS = Object.freeze(['APPROVED', 'REJECTED', 'NOT_EVALUATED']);
export const GAI_ERROR_CODES = Object.freeze([
  'INVALID_ROUTE',
  'UNKNOWN_CONTRACT_VERSION',
  'UNKNOWN_CHANNEL',
  'UNKNOWN_STATUS',
  'MALFORMED_ENVELOPE',
  'UNKNOWN_PROVIDER',
  'PROVIDER_UNAVAILABLE',
  'CREDENTIAL_REQUIRED',
  'USER_CONSENT_REQUIRED',
  'BUDGET_REJECTED',
  'IDEMPOTENCY_KEY_REUSED',
  'PARTIAL_RESULT_CANNOT_COMPLETE',
  'TERMINAL_STATUS_IS_FINAL',
  'WEB_FAILURE_REQUIRES_USER_CONSENT',
  'FORBIDDEN_ROUTE',
  'RAW_SECRET_FORBIDDEN',
]);

export class GeneralAiGatewayError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GeneralAiGatewayError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 400;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

// ---- route vocabulary ----------------------------------------------------

/** Refuse anything that is not a declared user-level route, and never guess. */
export function validateActionRoute(route) {
  const errors = [];
  if (!isText(route)) errors.push('route must be nonempty text');
  else if (FORBIDDEN_ROUTE_PATTERN.test(route)) errors.push(`route ${route} is a historical product name and is not a user-level route`);
  else if (!ACTION_ROUTES_V1.includes(route)) errors.push(`route ${route} is not one of ${ACTION_ROUTES_V1.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

export function assertActionRoute(route) {
  const verdict = validateActionRoute(route);
  if (!verdict.ok) throw new GeneralAiGatewayError(verdict.errors[0].includes('historical') ? 'FORBIDDEN_ROUTE' : 'INVALID_ROUTE', verdict.errors[0]);
  return route;
}

export function assertContractVersion(value, expected = GAI_CONTRACT_VERSION) {
  if (value !== expected) throw new GeneralAiGatewayError('UNKNOWN_CONTRACT_VERSION', `contract_version ${JSON.stringify(value)} is not ${expected}`);
  return value;
}

// ---- secret-shaped field scan -------------------------------------------

const SECRET_KEY_PATTERN = /(?:^|[._-])(token|secret|password|cookie|api[-_]?key|private[-_]?key|bearer|credential|session[-_]?key|access[-_]?token|refresh[-_]?token)(?:$|[._-])/i;
const HANDLE_SUFFIX = /(?:_ref|_refs|_handle|_handles|_id)$/i;

/**
 * Every occurrence of a secret-shaped field name that is not a bounded handle.
 * `credential_ref` is a handle; `credential` is bytes and is refused.
 */
export function findRawSecretFields(value, path = 'envelope', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findRawSecretFields(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key) && !HANDLE_SUFFIX.test(key)) found.push(childPath);
    findRawSecretFields(child, childPath, found);
  }
  return found;
}

// ---- declarative strict checking ----------------------------------------

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  for (const key of Object.keys(value)) if (!(key in spec)) errors.push(`${path}.${key} is not part of the canonical contract`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) {
      if (rule.nullable) continue;
      errors.push(`${fieldPath} must not be null`);
      continue;
    }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int' && !Number.isSafeInteger(field)) errors.push(`${fieldPath} must be an integer`);
    if (rule.type === 'bool' && typeof field !== 'boolean') errors.push(`${fieldPath} must be a boolean`);
    if (rule.type === 'object' && !isPlainObject(field)) errors.push(`${fieldPath} must be an object`);
    if (rule.type === 'array' && !Array.isArray(field)) errors.push(`${fieldPath} must be an array`);
    if (rule.constant !== undefined && field !== rule.constant) errors.push(`${fieldPath} must be ${JSON.stringify(rule.constant)}`);
    if (rule.enum && !rule.enum.includes(field)) errors.push(`${fieldPath} must be one of ${rule.enum.join(', ')}`);
    if (rule.validate && !(rule.type === 'array' && !Array.isArray(field))) rule.validate(field, fieldPath, errors);
  }
}

const textArray = (max = 64) => (value, path, errors) => {
  if (!Array.isArray(value)) return;
  if (value.length > max) errors.push(`${path} must hold at most ${max} entries`);
  value.forEach((item, index) => { if (!isText(item)) errors.push(`${path}[${index}] must be nonempty text`); });
};

const versionSpec = { required: true, type: 'int', constant: GAI_CONTRACT_VERSION };
const handleSpec = { required: true, type: 'text', nullable: true };

function seal(name, value, spec) {
  const errors = [];
  checkShape(value, name, spec, errors);
  for (const found of findRawSecretFields(value, name)) errors.push(`${found} looks like raw secret bytes; canonical contracts carry handles only`);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

// ---- canonical envelopes -------------------------------------------------

export const INPUT_BUNDLE_SPEC = Object.freeze({
  text: { required: true, type: 'text', nullable: true },
  files: { required: true, type: 'array', validate: textArray() },
  images: { required: true, type: 'array', validate: textArray() },
  references: { required: true, type: 'array', validate: textArray() },
  contextRefs: { required: true, type: 'array', validate: textArray() },
});

export function validateInputBundle(bundle) {
  return seal('inputBundle', bundle, INPUT_BUNDLE_SPEC);
}

export const GENERAL_AI_REQUEST_SPEC = Object.freeze({
  contract_version: versionSpec,
  route: { required: true, type: 'text', constant: GENERAL_AI_ROUTE },
  request_id: { required: true, type: 'text' },
  action_id: { required: true, type: 'text', nullable: true },
  channel: { required: true, enum: CHANNELS },
  provider_ref: handleSpec,
  model_ref: handleSpec,
  account_ref: handleSpec,
  conversation_id: handleSpec,
  input_bundle: { required: true, type: 'object', validate: (value, path, errors) => { for (const error of validateInputBundle(value).errors) errors.push(error.replace(/^inputBundle/, path)); } },
  interaction_device_ref: { required: true, type: 'text' },
  execution_device_ref: { required: true, type: 'text', nullable: true },
  idempotency_key: { required: true, type: 'text' },
  requested_at: { required: true, type: 'instant' },
});

export function validateGeneralAiRequest(request) {
  const errors = [];
  checkShape(request, 'request', GENERAL_AI_REQUEST_SPEC, errors);
  if (isPlainObject(request) && request.route !== undefined) {
    for (const error of validateActionRoute(request.route).errors) errors.push(`request.${error}`);
  }
  for (const found of findRawSecretFields(request, 'request')) errors.push(`${found} looks like raw secret bytes; canonical contracts carry handles only`);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export const PROVIDER_DESCRIPTOR_SPEC = Object.freeze({
  contract_version: versionSpec,
  provider_ref: { required: true, type: 'text' },
  display_name: { required: true, type: 'text' },
  channels: { required: true, type: 'array', validate: (value, path, errors) => { if (!Array.isArray(value)) return; if (!value.length) errors.push(`${path} must declare at least one channel`); value.forEach((entry, index) => { if (!CHANNELS.includes(entry)) errors.push(`${path}[${index}] must be one of ${CHANNELS.join(', ')}`); }); } },
  auth_status: { required: true, enum: AUTH_STATUSES },
  health: { required: true, enum: PROVIDER_HEALTH },
  credential_ref: { required: true, type: 'text', nullable: true },
});

export const MODEL_DESCRIPTOR_SPEC = Object.freeze({
  contract_version: versionSpec,
  model_ref: { required: true, type: 'text' },
  provider_ref: { required: true, type: 'text' },
  display_name: { required: true, type: 'text' },
  capabilities: { required: true, type: 'array', validate: textArray(32) },
  context_window: { required: true, type: 'int', nullable: true },
});

export const PROVIDER_ACCOUNT_SPEC = Object.freeze({
  contract_version: versionSpec,
  account_ref: { required: true, type: 'text' },
  provider_ref: { required: true, type: 'text' },
  credential_ref: { required: true, type: 'text', nullable: true },
  status: { required: true, enum: AUTH_STATUSES },
  created_at: { required: true, type: 'instant' },
});

export const CONVERSATION_SPEC = Object.freeze({
  contract_version: versionSpec,
  conversation_id: { required: true, type: 'text' },
  provider_ref: handleSpec,
  model_ref: handleSpec,
  backend_thread_ref: handleSpec,
  created_at: { required: true, type: 'instant' },
  updated_at: { required: true, type: 'instant' },
});

export const PARTIAL_RESULT_SPEC = Object.freeze({
  contract_version: versionSpec,
  action_id: { required: true, type: 'text' },
  sequence: { required: true, type: 'int' },
  delta: { required: true, type: 'text' },
  status: { required: true, enum: ACTION_IN_FLIGHT_STATUSES },
  at: { required: true, type: 'instant' },
});

export const RESULT_ENVELOPE_SPEC = Object.freeze({
  contract_version: versionSpec,
  action_id: { required: true, type: 'text' },
  status: { required: true, enum: ACTION_TERMINAL_STATUSES },
  output: { required: true, type: 'text', nullable: true },
  usage_ref: handleSpec,
  provenance: { required: true, type: 'object', validate: (value, path, errors) => checkShape(value, path, { source: { required: true, type: 'text' }, provider_ref: handleSpec, model_ref: handleSpec, channel: { required: true, enum: CHANNELS } }, errors) },
  completed_at: { required: true, type: 'instant' },
});

export const ATTENTION_REQUEST_SPEC = Object.freeze({
  contract_version: versionSpec,
  attention_id: { required: true, type: 'text' },
  action_id: { required: true, type: 'text' },
  kind: { required: true, enum: ATTENTION_KINDS },
  question: { required: true, type: 'text' },
  blocking: { required: true, type: 'bool' },
  created_at: { required: true, type: 'instant' },
});

export const DEVICE_SWITCH_PROPOSAL_SPEC = Object.freeze({
  contract_version: versionSpec,
  proposal_ref: { required: true, type: 'text' },
  action_id: { required: true, type: 'text' },
  from_device_ref: { required: true, type: 'text' },
  to_device_ref: { required: true, type: 'text' },
  reason: { required: true, type: 'text' },
  requires_user_confirmation: { required: true, type: 'bool', constant: true },
  created_at: { required: true, type: 'instant' },
});

export const API_SWITCH_PROPOSAL_SPEC = Object.freeze({
  contract_version: versionSpec,
  proposal_ref: { required: true, type: 'text' },
  action_id: { required: true, type: 'text' },
  from_channel: { required: true, type: 'text', constant: 'WEB' },
  to_channel: { required: true, type: 'text', constant: 'API' },
  reason: { required: true, type: 'text' },
  requires_user_confirmation: { required: true, type: 'bool', constant: true },
  budget_ref: handleSpec,
  created_at: { required: true, type: 'instant' },
});

export const ESCALATION_RECEIPT_SPEC = Object.freeze({
  contract_version: versionSpec,
  receipt_ref: { required: true, type: 'text' },
  action_id: { required: true, type: 'text' },
  from_channel: { required: true, type: 'text', constant: 'WEB' },
  to_channel: { required: true, type: 'text', constant: 'API' },
  confirmed_by_ref: { required: true, type: 'text' },
  confirmed_at: { required: true, type: 'instant' },
  budget_decision: { required: true, enum: BUDGET_DECISIONS },
});

export const USAGE_RECORD_SPEC = Object.freeze({
  contract_version: versionSpec,
  usage_ref: { required: true, type: 'text' },
  action_id: { required: true, type: 'text' },
  channel: { required: true, enum: CHANNELS },
  provider_ref: handleSpec,
  input_tokens: { required: true, type: 'int', nullable: true },
  output_tokens: { required: true, type: 'int', nullable: true },
  cost_micros: { required: true, type: 'int', nullable: true },
  recorded_at: { required: true, type: 'instant' },
});

export const validateProviderDescriptor = value => seal('provider', value, PROVIDER_DESCRIPTOR_SPEC);
export const validateModelDescriptor = value => seal('model', value, MODEL_DESCRIPTOR_SPEC);
export const validateProviderAccount = value => seal('account', value, PROVIDER_ACCOUNT_SPEC);
export const validateConversation = value => seal('conversation', value, CONVERSATION_SPEC);
export const validatePartialResult = value => seal('partial', value, PARTIAL_RESULT_SPEC);
export const validateResultEnvelope = value => seal('result', value, RESULT_ENVELOPE_SPEC);
export const validateAttentionRequest = value => seal('attention', value, ATTENTION_REQUEST_SPEC);
export const validateDeviceSwitchProposal = value => seal('deviceSwitch', value, DEVICE_SWITCH_PROPOSAL_SPEC);
export const validateApiSwitchProposal = value => seal('apiSwitch', value, API_SWITCH_PROPOSAL_SPEC);
export const validateEscalationReceipt = value => seal('escalation', value, ESCALATION_RECEIPT_SPEC);
export const validateUsageRecord = value => seal('usage', value, USAGE_RECORD_SPEC);

// ---- status / idempotency rules -----------------------------------------

/**
 * A partial result can never move an Action to a terminal status, and a terminal status is
 * final. This is the single place both rules are decided, so no channel implementation can
 * invent its own answer.
 */
export function nextActionStatus(currentStatus, incoming) {
  if (!ACTION_STATUSES.includes(currentStatus)) throw new GeneralAiGatewayError('UNKNOWN_STATUS', String(currentStatus));
  if (!isPlainObject(incoming) || !ACTION_STATUSES.includes(incoming.status)) throw new GeneralAiGatewayError('UNKNOWN_STATUS', String(incoming?.status));
  if (ACTION_TERMINAL_STATUSES.includes(currentStatus)) throw new GeneralAiGatewayError('TERMINAL_STATUS_IS_FINAL', `${currentStatus} cannot become ${incoming.status}`);
  if (incoming.source === 'PARTIAL' && ACTION_TERMINAL_STATUSES.includes(incoming.status)) {
    throw new GeneralAiGatewayError('PARTIAL_RESULT_CANNOT_COMPLETE', `partial output must not mark the action ${incoming.status}`);
  }
  return incoming.status;
}

/** Order-independent fingerprint of the *request*, used to detect idempotency-key reuse. */
export function fingerprintGeneralAiRequest(request) {
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
  };
  return JSON.stringify(stable({
    route: request?.route ?? null,
    channel: request?.channel ?? null,
    provider_ref: request?.provider_ref ?? null,
    model_ref: request?.model_ref ?? null,
    account_ref: request?.account_ref ?? null,
    conversation_id: request?.conversation_id ?? null,
    input_bundle: request?.input_bundle ?? null,
  }));
}

/**
 * A key identifies exactly one request. Replaying the same request is safe; binding a key to
 * a different request is refused, because the caller would otherwise believe a different thing
 * happened than really did.
 */
export function checkIdempotentReuse(existing, incoming) {
  if (!existing) return { replayed: false };
  const existingFingerprint = existing.request_fingerprint ?? fingerprintGeneralAiRequest(existing.request ?? {});
  const incomingFingerprint = fingerprintGeneralAiRequest(incoming);
  if (existingFingerprint !== incomingFingerprint) {
    throw new GeneralAiGatewayError('IDEMPOTENCY_KEY_REUSED', `idempotencyKey ${incoming.idempotency_key} is already bound to a different request`);
  }
  return { replayed: true, actionId: existing.action_id ?? null, status: existing.status ?? null };
}

export const cloneEnvelope = clone;
