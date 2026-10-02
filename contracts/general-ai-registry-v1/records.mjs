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
/**
 * Typed absence. `UNKNOWN_*` means "never registered"; `RETIRED_*` means "the user removed it", which
 * is a different and more useful answer — a removed provider is not the same fact as a typo, and the
 * reason has to survive the removal or every surface can only say "not found".
 */
export const ABSENCE_CODES = Object.freeze(['UNKNOWN_PROVIDER', 'UNKNOWN_MODEL', 'UNKNOWN_ACCOUNT', 'MODEL_NOT_IN_PROVIDER', 'ACCOUNT_NOT_IN_PROVIDER', 'DUPLICATE_IDENTITY', 'IDENTITY_COLLISION', 'INVALID_REGISTRY_RECORD', 'RAW_SECRET_FORBIDDEN', 'HANDLE_STORE_REQUIRED', 'RETIRED_PROVIDER', 'RETIRED_MODEL', 'RETIRED_ACCOUNT', 'HAS_DEPENDENTS']);
export const SUBJECT_KINDS = Object.freeze(['PROVIDER', 'MODEL', 'ACCOUNT']);

/**
 * User enablement (RS-201). A record is either explicitly ENABLED or explicitly DISABLED by the
 * user, and the field is REQUIRED rather than defaulted, deliberately.
 *
 * The reason is the failure mode this contract exists to prevent: if an omitted field defaulted to
 * "enabled", then a record whose disablement was lost, mistyped, or written by an older writer would
 * silently read as available, and the scheduler would select a provider the user had turned off.
 * "A disabled provider was still selected" is named in the workbook as an attack on Review, so
 * absence must never be readable as consent. There is no third state and no implicit default.
 */
export const ENABLEMENT = Object.freeze(['ENABLED', 'DISABLED']);

/**
 * The single availability-reason vocabulary (RS-201). One code per category the workbook requires,
 * so no surface has to invent a synonym and no two surfaces can disagree about what "unavailable"
 * meant.
 *
 * This is a REASON vocabulary, not a second copy of the resilience states. `health-resilience-v1`
 * already owns AVAILABILITY_STATES / AUTH_STATES / FAULT_CLASSES / CIRCUIT_STATES and stays the
 * source of truth for those; AVAILABILITY_REASONS sits above them and says WHICH of them applies and
 * WHY, by mapping onto them in REASON_SOURCES. In particular REGION_UNSUPPORTED and USER_DISABLED
 * had no representation anywhere in either contract before this task, which is why they appear here
 * rather than being derived from the existing states.
 *
 * AVAILABLE is the only code that permits selection. Every other code is a refusal with a reason.
 */
export const AVAILABILITY_REASONS = Object.freeze([
  'AVAILABLE',
  'REGION_UNSUPPORTED',
  'CREDENTIALS_MISSING',
  'SESSION_EXPIRED',
  'SERVICE_FAULT',
  'USER_DISABLED',
  'UNKNOWN',
]);

/**
 * Where each reason is derived from, recorded so a later reader can see that this vocabulary is a
 * projection of existing state rather than a parallel truth. `null` means the reason has no source
 * in the existing contracts and is genuinely new in RS-201.
 */
export const REASON_SOURCES = Object.freeze({
  AVAILABLE: 'AVAILABILITY_STATES.AVAILABLE',
  REGION_UNSUPPORTED: null,
  CREDENTIALS_MISSING: 'AUTH_STATES.MISSING',
  SESSION_EXPIRED: 'AUTH_STATES.EXPIRED',
  SERVICE_FAULT: 'FAULT_CLASSES / CIRCUIT_STATES',
  USER_DISABLED: null,
  UNKNOWN: 'AVAILABILITY_STATES.UNKNOWN',
});

/** Only this reason may be selected. Stated as data so no caller has to re-derive the rule. */
export const SELECTABLE_REASON = 'AVAILABLE';

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

const SECRET_KEY_PATTERN = /(?:^|[._-])(token|secret|password|cookie|api[-_]?key|private[-_]?key|bearer|credential|access[-_]?token|refresh[-_]?token|session[-_]?key)(?:$|[._-])/i;
const HANDLE_SUFFIX = /(?:_ref|_refs|_handle|_handles|_id)$/i;

/**
 * Reserved prototype keys. A `__proto__` own key is worse than invalid: assigning it rewrites an
 * object's prototype instead of adding a key, so `Object.keys` — and therefore every check below —
 * cannot see the result. Refused at every depth of a canonical record.
 */
export const RESERVED_KEY_PATTERN = /^(?:__proto__|prototype|constructor)$/;

/**
 * Normalise a field name to one comparable form.
 *
 * The secret vocabulary is spelled with separator boundaries, so comparing raw keys missed every
 * compound and plural spelling of the same concept: `credentials`, `tokens`, `secrets`, `apiKeys`,
 * `authToken`, `bearerToken`, `clientSecret`, `accountCredential`, `tokenValue`, `passwordHash`.
 * Splitting camelCase into words, collapsing every non-alphanumeric run to one `_` and lowercasing
 * makes the scan about the name's meaning rather than its exact spelling.
 */
export function normalizeFieldName(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

/** True when a field name denotes a raw secret, allowing a plural spelling. */
export function isSecretFieldName(key) {
  const normalised = normalizeFieldName(key);
  // A reference form is explicitly allowed, so it is exempt before the plural tolerance is applied:
  // `credential_ref` and `token_id` stay references, `credentials` does not.
  if (HANDLE_SUFFIX.test(`_${normalised}`)) return false;
  if (SECRET_KEY_PATTERN.test(normalised)) return true;
  const singular = normalised.replace(/s$/, '');
  return singular !== normalised && SECRET_KEY_PATTERN.test(singular);
}

/**
 * Value shapes that are recognisably raw credential bytes rather than a handle.
 *
 * A name scan alone cannot hold this module's rule — "only handles may be stored; raw secret bytes
 * are refused" — because a provider record has declared free-text fields (`display_name`, and the
 * `HANDLE_STORE_REQUIRED` path's neighbours) whose names are innocent. This is the other half.
 */
export const RAW_SECRET_VALUE_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$|^(?:sk|rk|pk|ghp|gho|ghs|ghu|github_pat_|AKIA|ASIA|xox[baprs])[-_][A-Za-z0-9_-]{12,}$)/;

/** Every value that looks like raw credential bytes rather than a handle. */
export function findRawSecretValues(value, path = 'record', found = []) {
  if (typeof value === 'string') {
    if (RAW_SECRET_VALUE_PATTERN.test(value.trim())) found.push(path);
    return found;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => findRawSecretValues(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) findRawSecretValues(child, `${path}.${key}`, found);
  return found;
}

/** Every reserved prototype key, at every depth. `JSON.parse` can produce an own `__proto__`. */
export function findReservedKeyPaths(value, path = 'record', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findReservedKeyPaths(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (RESERVED_KEY_PATTERN.test(key)) found.push(childPath);
    findReservedKeyPaths(child, childPath, found);
  }
  return found;
}

export function findRawSecretFields(value, path = 'record', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findRawSecretFields(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    // Value-aware in one direction only: a secret-shaped name holding a *number* is a quantity, not
    // credential bytes.
    if (isSecretFieldName(key) && typeof child !== 'number') found.push(childPath);
    findRawSecretFields(child, childPath, found);
  }
  return found;
}

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  // Own-key lookup: `key in spec` walks the prototype chain, so `toString`, `valueOf`,
  // `hasOwnProperty`, `constructor`, `isPrototypeOf`, `propertyIsEnumerable` and `toLocaleString`
  // were all accepted as canonical record fields, and a JSON-parsed `__proto__` own key too.
  for (const key of Object.keys(value)) {
    if (RESERVED_KEY_PATTERN.test(key)) { errors.push(`${path}.${key} is a reserved prototype key and is never part of the canonical record`); continue; }
    if (!Object.hasOwn(spec, key)) errors.push(`${path}.${key} is not part of the canonical record`);
  }
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
  // Required, not defaulted: absence must never read as "enabled" (see ENABLEMENT).
  enablement: { required: true, type: 'enum', values: ENABLEMENT },
  /**
   * The region this provider is declared to serve, or null when the provider is region-neutral.
   * Declared, never inferred: a provider that requires a region and has none is UNKNOWN, and the
   * contract must not guess a region from the host's own location or fabricate support.
   */
  region: { required: true, type: 'text', nullable: true },
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
  // A model can be switched off independently of its provider.
  enablement: { required: true, type: 'enum', values: ENABLEMENT },
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
  // Distinct from `status`: status is what the account IS (probed/observed), enablement is what the
  // USER chose. A user may disable a perfectly AUTHENTICATED account, and that must be honoured.
  enablement: { required: true, type: 'enum', values: ENABLEMENT },
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
  for (const found of findRawSecretValues(record, path)) errors.push(`${found} contains raw credential bytes; canonical records carry handles only`);
  for (const found of findReservedKeyPaths(record, path)) errors.push(`${found} is a reserved prototype key and is never part of the canonical record`);
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
  // Two-sided: a record claiming an observation in the future is not evidence of anything. The bound
  // used to be one-sided, so `observed_at = 2099, ttl_ms = 1` read FRESH in 2026 and still FRESH in
  // 2089 — an impossible observation trusted as current, which is what this module forbids.
  if (nowMs < observed) return false;
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

/**
 * Readiness values that do **not** mean the channel is usable. AUTH_REQUIRED is deliberately absent:
 * the channel is supported, it merely needs a credential.
 */
export const UNSUPPORTED_READINESS = Object.freeze(['UNAVAILABLE', 'UNKNOWN']);

/**
 * Channel readiness. WEB and API are answered independently, so they can differ.
 *
 * `supported` used to be `channel === 'WEB' || channel === 'API'` in the stale branch — a tautology,
 * because `channel` was already validated into CHANNELS above and the missing-entry case had already
 * returned. It could not be false, so a *stale* channel declaration was advertised as supported
 * through the very listing API this report names as the GAI-003/004/005 routing query surface, while
 * the capability path for the same record correctly collapsed to UNKNOWN. `supported` is now computed
 * from freshness and readiness, and the stored readiness is re-validated rather than echoed.
 */
export function channelReadiness(record, channel, nowMs) {
  if (!CHANNELS.includes(channel)) throw new RegistryError('INVALID_REGISTRY_RECORD', `${channel} is not a channel`);
  const entry = Array.isArray(record?.channels) ? record.channels.find(candidate => candidate.channel === channel) : null;
  if (!entry) return { channel, readiness: 'UNKNOWN', supported: false, freshness: freshnessOf(record, nowMs) };
  const freshness = freshnessOf(record, nowMs);
  if (freshness !== 'FRESH') return { channel, readiness: 'UNKNOWN', supported: false, freshness };
  const readiness = CHANNEL_READINESS.includes(entry.readiness) ? entry.readiness : 'UNKNOWN';
  return { channel, readiness, supported: !UNSUPPORTED_READINESS.includes(readiness), freshness: 'FRESH' };
}
