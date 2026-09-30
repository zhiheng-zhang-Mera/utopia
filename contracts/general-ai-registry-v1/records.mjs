// General AI registry records: providers, models, accounts, capability facts and channel readiness
// (GAI-002).
//
// Provider-neutral discovery state. Two rules shape every record here:
//   - an unverified capability fact is UNKNOWN, never assumed true, and a stale fact reads as
//     UNKNOWN so staleness is visible rather than silently trusted;
//   - only *handles* (browser-profile references and credential references) may be stored; raw
//     secret bytes are refused from canonical records.
export const GAI_REGISTRY_VERSION = 1;

export const CHANNELS = Object.freeze(['WEB', 'API']);
export const CHANNEL_READINESS = Object.freeze(['READY', 'AUTH_REQUIRED', 'UNAVAILABLE', 'UNKNOWN']);
export const CAPABILITY_FACTS = Object.freeze(['TEXT', 'IMAGE', 'FILE', 'VISION', 'CODE', 'LONG_CONTEXT', 'STREAMING', 'TOOLS', 'STRUCTURED_OUTPUT']);
/** `UNKNOWN` is the default for every fact nobody verified. */
export const SUPPORT_LEVELS = Object.freeze(['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN']);
export const ACCOUNT_STATUSES = Object.freeze(['UNKNOWN', 'UNAUTHENTICATED', 'PENDING', 'AUTHENTICATED', 'EXPIRED', 'REVOKED']);
export const FACT_SOURCES = Object.freeze(['CONFIGURED', 'PROBED', 'USER_REPORTED']);
export const FRESHNESS = Object.freeze(['FRESH', 'STALE', 'UNKNOWN']);
export const ABSENCE_CODES = Object.freeze(['UNKNOWN_PROVIDER', 'UNKNOWN_MODEL', 'UNKNOWN_ACCOUNT', 'MODEL_NOT_IN_PROVIDER', 'ACCOUNT_NOT_IN_PROVIDER', 'DUPLICATE_IDENTITY', 'IDENTITY_COLLISION', 'INVALID_REGISTRY_RECORD', 'RAW_SECRET_FORBIDDEN', 'HANDLE_STORE_REQUIRED']);
export const SUBJECT_KINDS = Object.freeze(['PROVIDER', 'MODEL', 'ACCOUNT']);

export class RegistryError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RegistryError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 400;
  }
}

export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;

const SECRET_KEY_PATTERN = /(?:^|[._-])(token|secret|password|cookie|api[-_]?key|private[-_]?key|bearer|credential|access[-_]?token|session[-_]?key)(?:$|[._-])/i;
const HANDLE_SUFFIX = /(?:_ref|_refs|_handle|_handles|_id)$/i;

export function findRawSecretFields(value, path = 'record', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findRawSecretFields(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key) && !HANDLE_SUFFIX.test(key)) found.push(childPath);
    findRawSecretFields(child, childPath, found);
  }
  return found;
}

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  for (const key of Object.keys(value)) if (!(key in spec)) errors.push(`${path}.${key} is not part of the canonical record`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int' && (!Number.isSafeInteger(field) || field < (rule.min ?? 0))) errors.push(`${fieldPath} must be an integer >= ${rule.min ?? 0}`);
    if (rule.type === 'object' && !isPlainObject(field)) errors.push(`${fieldPath} must be an object`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`${fieldPath} must be one of ${rule.values.join(', ')}`);
    if (rule.constant !== undefined && field !== rule.constant) errors.push(`${fieldPath} must be ${JSON.stringify(rule.constant)}`);
  }
}

const VERSION = { required: true, type: 'int', constant: GAI_REGISTRY_VERSION };
const SOURCE_SPEC = { kind: { required: true, type: 'enum', values: FACT_SOURCES }, ref: { required: true, type: 'text' } };
const capabilitySpec = { required: true, type: 'object' };

/** Validate a capability map: unknown facts are allowed and mean UNKNOWN; bad values are not. */
export function validateCapabilityMap(map, path, errors) {
  if (!isPlainObject(map)) { errors.push(`${path} must be an object`); return; }
  for (const [fact, level] of Object.entries(map)) {
    if (!CAPABILITY_FACTS.includes(fact)) errors.push(`${path}.${fact} is not a capability fact`);
    else if (!SUPPORT_LEVELS.includes(level)) errors.push(`${path}.${fact} must be one of ${SUPPORT_LEVELS.join(', ')}`);
  }
}

export const PROVIDER_SPEC = Object.freeze({
  registry_version: VERSION,
  provider_ref: { required: true, type: 'text' },
  display_name: { required: true, type: 'text' },
  channels: { required: true, type: 'array' },
  capabilities: capabilitySpec,
  observed_at: { required: true, type: 'instant' },
  source: { required: true, type: 'object' },
  ttl_ms: { required: true, type: 'int', min: 0 },
});

export const MODEL_SPEC = Object.freeze({
  registry_version: VERSION,
  model_ref: { required: true, type: 'text' },
  provider_ref: { required: true, type: 'text' },
  display_name: { required: true, type: 'text' },
  channels: { required: true, type: 'array' },
  capabilities: capabilitySpec,
  context_window: { required: true, type: 'int', min: 1, nullable: true },
  observed_at: { required: true, type: 'instant' },
  source: { required: true, type: 'object' },
  ttl_ms: { required: true, type: 'int', min: 0 },
});

const HANDLE_SLOT_SPEC = { handle_ref: { required: true, type: 'text' }, kind: { required: true, type: 'text' } };

export const ACCOUNT_SPEC = Object.freeze({
  registry_version: VERSION,
  account_ref: { required: true, type: 'text' },
  provider_ref: { required: true, type: 'text' },
  display_name: { required: true, type: 'text' },
  status: { required: true, type: 'enum', values: ACCOUNT_STATUSES },
  channel_handles: { required: true, type: 'object' },
  capabilities: capabilitySpec,
  observed_at: { required: true, type: 'instant' },
  source: { required: true, type: 'object' },
  ttl_ms: { required: true, type: 'int', min: 0 },
});

function validateChannelEntries(entries, path, errors) {
  if (!Array.isArray(entries)) { errors.push(`${path} must be an array`); return; }
  if (entries.length === 0) errors.push(`${path} must declare at least one channel`);
  const seen = new Set();
  entries.forEach((entry, index) => {
    checkShape(entry, `${path}[${index}]`, { channel: { required: true, type: 'enum', values: CHANNELS }, readiness: { required: true, type: 'enum', values: CHANNEL_READINESS } }, errors);
    if (isPlainObject(entry)) {
      if (seen.has(entry.channel)) errors.push(`${path}[${index}].channel ${entry.channel} is declared twice`);
      seen.add(entry.channel);
    }
  });
}

function validateHandles(handles, path, errors) {
  if (!isPlainObject(handles)) { errors.push(`${path} must be an object`); return; }
  for (const [channel, slot] of Object.entries(handles)) {
    if (!CHANNELS.includes(channel)) { errors.push(`${path}.${channel} is not a channel`); continue; }
    if (slot === null) continue;
    checkShape(slot, `${path}.${channel}`, HANDLE_SLOT_SPEC, errors);
  }
}

function validateCommon(record, path, spec, errors) {
  checkShape(record, path, spec, errors);
  if (isPlainObject(record)) {
    if (Array.isArray(record.channels)) validateChannelEntries(record.channels, `${path}.channels`, errors);
    if (isPlainObject(record.capabilities)) validateCapabilityMap(record.capabilities, `${path}.capabilities`, errors);
    if (isPlainObject(record.source)) checkShape(record.source, `${path}.source`, SOURCE_SPEC, errors);
    for (const found of findRawSecretFields(record, path)) errors.push(`${found} looks like raw secret bytes; canonical records carry handles only`);
  }
}

export function validateProviderDescriptor(record) {
  const errors = [];
  validateCommon(record, 'provider', PROVIDER_SPEC, errors);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateModelDescriptor(record) {
  const errors = [];
  validateCommon(record, 'model', MODEL_SPEC, errors);
  if (isPlainObject(record) && isPlainObject(record.channels)) errors.push('model.channels must be an array');
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateProviderAccount(record) {
  const errors = [];
  validateCommon(record, 'account', ACCOUNT_SPEC, errors);
  if (isPlainObject(record) && isPlainObject(record.channel_handles)) validateHandles(record.channel_handles, 'account.channel_handles', errors);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export const assertProviderDescriptor = record => assertValid(validateProviderDescriptor(record), record);
export const assertModelDescriptor = record => assertValid(validateModelDescriptor(record), record);
export const assertProviderAccount = record => assertValid(validateProviderAccount(record), record);

function assertValid(verdict, record) {
  if (!verdict.ok) throw new RegistryError('INVALID_REGISTRY_RECORD', verdict.errors.slice(0, 3).join('; '));
  return record;
}

// ---- capability facts, freshness and channel readiness --------------------

const isFresh = (record, nowMs) => {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false;
  const observed = Date.parse(record.observed_at);
  if (!Number.isFinite(observed)) return false;
  return nowMs - observed <= record.ttl_ms;
};

/** Freshness as a visible fact: FRESH, STALE (observed but past its ttl) or UNKNOWN (no instant). */
export function freshnessOf(record, nowMs) {
  if (!isPlainObject(record) || !isIsoInstant(record.observed_at)) return 'UNKNOWN';
  return isFresh(record, nowMs) ? 'FRESH' : 'STALE';
}

/**
 * The capability answer for a fact. An unverified fact is UNKNOWN, and a *stale* fact is UNKNOWN
 * too: reporting a remembered value as current is exactly the silent staleness this task forbids.
 */
export function capabilityOf(record, fact, nowMs) {
  if (!CAPABILITY_FACTS.includes(fact)) throw new RegistryError('INVALID_REGISTRY_RECORD', `${fact} is not a capability fact`);
  if (freshnessOf(record, nowMs) !== 'FRESH') return { fact, level: 'UNKNOWN', freshness: freshnessOf(record, nowMs) };
  const level = record.capabilities?.[fact];
  return { fact, level: SUPPORT_LEVELS.includes(level) ? level : 'UNKNOWN', freshness: 'FRESH' };
}

/** Channel readiness. WEB and API are answered independently, so they can differ. */
export function channelReadiness(record, channel, nowMs) {
  if (!CHANNELS.includes(channel)) throw new RegistryError('INVALID_REGISTRY_RECORD', `${channel} is not a channel`);
  const entry = Array.isArray(record?.channels) ? record.channels.find(candidate => candidate.channel === channel) : null;
  if (!entry) return { channel, readiness: 'UNKNOWN', supported: false, freshness: freshnessOf(record, nowMs) };
  if (freshnessOf(record, nowMs) !== 'FRESH') return { channel, readiness: 'UNKNOWN', supported: channel === 'WEB' || channel === 'API', freshness: freshnessOf(record, nowMs) };
  return { channel, readiness: entry.readiness, supported: true, freshness: 'FRESH' };
}
