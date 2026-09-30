// Engineering connector capability / probe / auth / instance registry (EM-004).
//
// What worker instances actually exist on each device, what they can do, and whether they are
// usable — without hard-coding provider choice into the Foreman. Pure module: no clock, filesystem,
// network or process access.
//
// Four facts are kept deliberately separate, because conflating them is how a "running" worker gets
// mistaken for a usable one:
//   process readiness  — is there a process, is it attached?
//   auth status        — may it act on the user's behalf?
//   health             — is it behaving?
//   capability support — can it do the thing at all?
export const ENGINEERING_REGISTRY_VERSION = 1;

export const CAPABILITY_FACTS = Object.freeze([
  'FILESYSTEM', 'SHELL', 'GIT', 'BROWSER', 'VISION', 'COMPUTER_USE',
  'CHECKPOINT_RESUME', 'INTERACTION', 'NETWORK', 'PACKAGE_INSTALL',
]);
export const SUPPORT_LEVELS = Object.freeze(['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN']);
export const AUTH_STATUSES = Object.freeze(['READY', 'MISSING', 'EXPIRED', 'NEEDS_USER', 'REFRESHING', 'UNAVAILABLE', 'UNKNOWN']);
export const HEALTH_STATES = Object.freeze(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);
export const PROCESS_STATES = Object.freeze(['NOT_INSTALLED', 'INSTALLED', 'STARTING', 'RUNNING', 'STOPPED', 'CRASHED', 'UNKNOWN']);
export const READINESS = Object.freeze(['READY', 'NOT_READY', 'UNKNOWN']);
export const FACT_SOURCES = Object.freeze(['PROBED', 'CONFIGURED', 'USER_REPORTED', 'RUNTIME']);
export const REGISTRY_CODES = Object.freeze([
  'INVALID_REGISTRY_RECORD', 'UNKNOWN_CONNECTOR_KIND', 'UNKNOWN_INSTANCE', 'DUPLICATE_INSTANCE',
  'DUPLICATE_CONNECTOR_KIND', 'CAPABILITY_MISMATCH', 'AUTH_NOT_READY', 'PROCESS_NOT_READY',
  // Symmetrical with AUTH_NOT_READY / PROCESS_NOT_READY: without it, an unhealthy-but-ready process
  // was reported as PROCESS_NOT_READY, which is the wrong diagnosis rather than a missing one.
  'HEALTH_NOT_READY',
  'PROBE_FAILED', 'PROBE_TIMEOUT', 'RAW_SECRET_FORBIDDEN', 'STALE_PROBE',
]);

export class RegistryError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RegistryError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const isIsoInstantShape = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
/**
 * Shape is not enough: `2026-13-45T99:99:99Z` matches the regex but parses to NaN, and
 * `2026-02-30T00:00:00.000Z` silently normalises to a different day. An instant must also round-trip
 * to the calendar date it claims — which matters here because `observed_at` gates freshness.
 */
export const isIsoInstant = value => {
  if (!isIsoInstantShape(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
};

/** Bounds the scans that walk *data* rather than the fixed schema. */
export const MAX_RECORD_DEPTH = 32;

export function recordDepthExceeded(value, max = MAX_RECORD_DEPTH) {
  const stack = [{ node: value, depth: 1 }];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (depth > max) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}

const SECRET_KEY_PATTERN = /(?:^|[._-])(token|secret|password|cookie|api[-_]?key|private[-_]?key|bearer|credential|access[-_]?token|session[-_]?key)(?:$|[._-])/i;
const HANDLE_SUFFIX = /(?:_ref|_refs|_handle|_handles|_id)$/i;
/** Recognisable credential *shapes*, so raw material is caught by value as well as by key name. */
const SECRET_VALUE_PATTERNS = Object.freeze([
  /gh[pousr]_[A-Za-z0-9]{16,}/,                       // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[abpros]-[A-Za-z0-9-]{10,}/,                    // Slack tokens
  /AKIA[0-9A-Z]{16}/,                                 // AWS access key id
  /sk-[A-Za-z0-9]{20,}/,                              // provider-style API keys
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,               // PEM private key
]);

/**
 * Secret-shaped *fields*. `Object.entries` sees only enumerable own keys, so a non-enumerable own
 * `access_token` carried raw material past the scan; `Reflect.ownKeys` sees every own key. The walk
 * covers attacker-controlled data, so it is cycle-safe, and over-deep records are refused by the
 * validators rather than by a stack overflow.
 */
export function findRawSecretFields(value, path = 'record', found = [], seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return found;
    seen.add(value);
    value.forEach((item, index) => findRawSecretFields(item, `${path}[${index}]`, found, seen));
    return found;
  }
  if (!isPlainObject(value)) return found;
  if (seen.has(value)) return found;
  seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
    const childPath = `${path}.${String(key)}`;
    if (typeof key === 'string' && SECRET_KEY_PATTERN.test(key)) {
      // The `*_ref`/`*_handle`/`*_id` exemption is for *references*. Exempting by name alone meant a
      // raw token stored in `auth.handle_ref` was never examined, so an exempted field must still look
      // like a reference — no whitespace, a bounded length, and a reference-like character set.
      if (!HANDLE_SUFFIX.test(key)) found.push(childPath);
      else if (typeof value[key] === 'string' && !REFERENCE_PATTERN.test(value[key])) found.push(childPath);
    }
    findRawSecretFields(value[key], childPath, found, seen);
  }
  return found;
}

/**
 * Raw credential material is refused by *value* as well: the acceptance line is that no raw credential
 * material is stored in registry records, and a key-name scan alone cannot enforce that — a token in
 * `display_name` is still a stored token. Only well-known credential shapes are matched, so ordinary
 * text is not refused.
 */
export function findRawSecretValues(value, path = 'record', found = [], seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value))) found.push(path);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  if (seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => findRawSecretValues(item, `${path}[${index}]`, found, seen));
    return found;
  }
  for (const key of Reflect.ownKeys(value)) findRawSecretValues(value[key], `${path}.${String(key)}`, found, seen);
  return found;
}

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  // `key in spec` walks the prototype chain and every spec is an object literal, so a field named
  // `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__proto__` or any other Object.prototype
  // member was accepted as "part of the canonical record". Only own keys of the spec count, and the
  // scan uses Reflect.ownKeys so a non-enumerable own field cannot slip past it either.
  for (const key of Reflect.ownKeys(value)) if (!Object.hasOwn(spec, key)) errors.push(`${path}.${String(key)} is not part of the canonical record`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int') {
      if (!Number.isSafeInteger(field) || field < (rule.min ?? 0)) errors.push(`${fieldPath} must be an integer >= ${rule.min ?? 0}`);
      // A one-sided integer bound is not a bound: an enormous ttl made an observation current forever.
      else if (rule.max !== undefined && field > rule.max) errors.push(`${fieldPath} must be an integer <= ${rule.max}`);
    }
    if (rule.type === 'bool' && typeof field !== 'boolean') errors.push(`${fieldPath} must be a boolean`);
    if (rule.type === 'object' && !isPlainObject(field)) errors.push(`${fieldPath} must be an object`);
    if (rule.type === 'array' && !Array.isArray(field)) errors.push(`${fieldPath} must be an array`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`${fieldPath} must be one of ${rule.values.join(', ')}`);
    if (rule.constant !== undefined && field !== rule.constant) errors.push(`${fieldPath} must be ${JSON.stringify(rule.constant)}`);
  }
}

const VERSION = { required: true, type: 'int', constant: ENGINEERING_REGISTRY_VERSION };
/** Tolerance for a peer clock running ahead of ours; only a bigger jump is treated as future-dated. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/**
 * An observation cannot claim to stay current indefinitely. Without a ceiling, `ttl_ms: 2**53-1` made
 * a probe authoritative for a century while the identical record with a 1 s ttl was stale — the same
 * one-sided bound as the freshness comparison, one field over. One day is far longer than any worker
 * instance registry needs and short enough that "current" still means something.
 */
export const MAX_PROBE_TTL_MS = 24 * 60 * 60 * 1000;
/** An exempted reference field must still look like a reference, not like raw credential material. */
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const SOURCE_SPEC = { kind: { required: true, type: 'enum', values: FACT_SOURCES }, ref: { required: true, type: 'text' } };

export const DESCRIPTOR_SPEC = Object.freeze({
  registry_version: VERSION,
  connector_kind: { required: true, type: 'text' },
  display_name: { required: true, type: 'text' },
  runtime_kind: { required: true, type: 'text' },
  capability_manifest: { required: true, type: 'object' },
  declared_at: { required: true, type: 'instant' },
});

export const PROBE_SPEC = Object.freeze({
  observed_at: { required: true, type: 'instant' },
  source: { required: true, type: 'object' },
  ttl_ms: { required: true, type: 'int', min: 0, max: MAX_PROBE_TTL_MS },
  version: { required: true, type: 'text', nullable: true },
  installed: { required: true, type: 'bool' },
  attachable: { required: true, type: 'bool' },
});

/**
 * A recorded probe failure. A failed or timed-out probe is evidence about *now*, so it is stamped on
 * the instance rather than only counted globally: otherwise a connector that just stopped answering
 * stayed FRESH and usable on its previous observation, and `assertUsable` authorised dispatch to it.
 */
export const PROBE_FAILURE_SPEC = Object.freeze({
  code: { required: true, type: 'enum', values: ['PROBE_FAILED', 'PROBE_TIMEOUT'] },
  at: { required: true, type: 'instant' },
  detail: { required: true, type: 'text', nullable: true },
});

export const PROCESS_SPEC = Object.freeze({
  state: { required: true, type: 'enum', values: PROCESS_STATES },
  pid_ref: { required: true, type: 'text', nullable: true },
});

export const AUTH_SPEC = Object.freeze({
  status: { required: true, type: 'enum', values: AUTH_STATUSES },
  handle_ref: { required: true, type: 'text', nullable: true },
});

export const INSTANCE_SPEC = Object.freeze({
  registry_version: VERSION,
  instance_ref: { required: true, type: 'text' },
  connector_kind: { required: true, type: 'text' },
  device_ref: { required: true, type: 'text', nullable: true },
  account_ref: { required: true, type: 'text', nullable: true },
  installation_ref: { required: true, type: 'text', nullable: true },
  process: { required: true, type: 'object' },
  auth: { required: true, type: 'object' },
  health: { required: true, type: 'enum', values: HEALTH_STATES },
  capability_manifest: { required: true, type: 'object' },
  probe: { required: true, type: 'object' },
  probe_failure: { required: false, type: 'object' },
});

/** A capability manifest describes engineering-worker abilities only — never node transport capability. */
export function validateCapabilityManifest(manifest, path = 'capability_manifest', errors = []) {
  checkShape(manifest, path, { registry_version: VERSION, capabilities: { required: true, type: 'object' } }, errors);
  if (isPlainObject(manifest?.capabilities)) {
    for (const [fact, level] of Object.entries(manifest.capabilities)) {
      if (!CAPABILITY_FACTS.includes(fact)) errors.push(`${path}.capabilities.${fact} is not an engineering capability fact`);
      else if (!SUPPORT_LEVELS.includes(level)) errors.push(`${path}.capabilities.${fact} must be one of ${SUPPORT_LEVELS.join(', ')}`);
    }
  }
  return errors;
}

export function validateConnectorDescriptor(descriptor) {
  const errors = [];
  checkShape(descriptor, 'descriptor', DESCRIPTOR_SPEC, errors);
  if (isPlainObject(descriptor)) {
    validateCapabilityManifest(descriptor.capability_manifest, 'descriptor.capability_manifest', errors);
    if (recordDepthExceeded(descriptor)) errors.push(`descriptor must not be nested deeper than ${MAX_RECORD_DEPTH} levels`);
    for (const found of findRawSecretFields(descriptor, 'descriptor')) errors.push(`${found} looks like raw secret bytes; registry records carry handles only`);
    for (const found of findRawSecretValues(descriptor, 'descriptor')) errors.push(`${found} carries raw credential material; registry records carry handles only`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateConnectorInstance(instance) {
  const errors = [];
  checkShape(instance, 'instance', INSTANCE_SPEC, errors);
  if (isPlainObject(instance)) {
    if (isPlainObject(instance.process)) checkShape(instance.process, 'instance.process', PROCESS_SPEC, errors);
    if (isPlainObject(instance.auth)) checkShape(instance.auth, 'instance.auth', AUTH_SPEC, errors);
    if (isPlainObject(instance.probe)) checkShape(instance.probe, 'instance.probe', PROBE_SPEC, errors);
    if (isPlainObject(instance.probe_failure)) checkShape(instance.probe_failure, 'instance.probe_failure', PROBE_FAILURE_SPEC, errors);
    if (isPlainObject(instance.probe?.source)) checkShape(instance.probe.source, 'instance.probe.source', SOURCE_SPEC, errors);
    if (instance.device_ref !== null && instance.device_ref !== undefined && !/^dev-[0-9a-f]{32}$/.test(instance.device_ref)) {
      errors.push('instance.device_ref must be a Remote Fabric dev-<32 hex> identity or null');
    }
    validateCapabilityManifest(instance.capability_manifest, 'instance.capability_manifest', errors);
    if (recordDepthExceeded(instance)) errors.push(`instance must not be nested deeper than ${MAX_RECORD_DEPTH} levels`);
    for (const found of findRawSecretFields(instance, 'instance')) errors.push(`${found} looks like raw secret bytes; registry records carry handles only`);
    for (const found of findRawSecretValues(instance, 'instance')) errors.push(`${found} carries raw credential material; registry records carry handles only`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function assertValid(verdict, record) {
  if (!verdict.ok) {
    // `RAW_SECRET_FORBIDDEN` was declared but never raised; a record refused for carrying credentials
    // now says so, instead of every refusal arriving as the generic record error.
    const carriesSecret = verdict.errors.some(error => error.includes('secret'));
    throw new RegistryError(carriesSecret ? 'RAW_SECRET_FORBIDDEN' : 'INVALID_REGISTRY_RECORD', verdict.errors.slice(0, 3).join('; '));
  }
  return record;
}

export const assertConnectorDescriptor = descriptor => assertValid(validateConnectorDescriptor(descriptor), descriptor);
export const assertConnectorInstance = instance => assertValid(validateConnectorInstance(instance), instance);

// ---- probe freshness and effective usability -----------------------------

/**
 * Freshness is a *two-sided* bound, and that is the only correct form.
 *
 * `nowMs - observed <= ttl_ms` accepts a probe dated in the future for as long as that date is in the
 * future, so a replayed or clock-skewed probe reported FRESH forever — and here freshness is not
 * bookkeeping: it gates `capabilityOf`, `processReadiness`, `usability`, `assertUsable` and
 * `matchRequirements`, so a future-dated probe was silently healthy and authorised execution. Only a
 * peer clock ahead by more than `MAX_CLOCK_SKEW_MS` is rejected, so ordinary skew is tolerated.
 */
export function probeFreshness(instance, nowMs) {
  const observed = Date.parse(instance?.probe?.observed_at ?? '');
  if (!Number.isFinite(observed) || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return 'UNKNOWN';
  const age = nowMs - observed;
  if (age < -MAX_CLOCK_SKEW_MS) return 'STALE';
  // Clamped as well as validated, so a record that reached this function without validation still
  // cannot claim an unbounded ttl.
  const claimed = Number.isFinite(instance?.probe?.ttl_ms) && instance.probe.ttl_ms > 0 ? instance.probe.ttl_ms : 0;
  const ttl = Math.min(claimed, MAX_PROBE_TTL_MS);
  return age <= ttl ? 'FRESH' : 'STALE';
}

/** The source kind behind the probe evidence, so a caller can tell observed facts from configured ones. */
export function probeEvidenceSource(instance) {
  const kind = instance?.probe?.source?.kind;
  return FACT_SOURCES.includes(kind) ? kind : 'UNKNOWN';
}

/**
 * The capability answer for a fact. A stale *or* missing fact is UNKNOWN — a remembered capability
 * is never reported as current.
 */
export function capabilityOf(instance, fact, nowMs) {
  if (!CAPABILITY_FACTS.includes(fact)) throw new RegistryError('INVALID_REGISTRY_RECORD', `${fact} is not an engineering capability fact`);
  const freshness = probeFreshness(instance, nowMs);
  if (freshness !== 'FRESH') return { fact, level: 'UNKNOWN', freshness };
  const level = instance.capability_manifest?.capabilities?.[fact];
  return { fact, level: SUPPORT_LEVELS.includes(level) ? level : 'UNKNOWN', freshness: 'FRESH' };
}

/**
 * Process readiness. A stale probe reports UNKNOWN rather than the last known state, and a process
 * that is running is still only *attachable*, not usable.
 */
export function processReadiness(instance, nowMs) {
  const freshness = probeFreshness(instance, nowMs);
  if (freshness !== 'FRESH') return { readiness: 'UNKNOWN', freshness, reason: 'STALE_PROBE' };
  // Two observed facts must not contradict each other: a connector whose probe says it is not
  // installed cannot be a running, usable worker, whatever the process block claims. The probe was
  // validated for this field but no decision ever read it, so `installed: false` was fully usable.
  if (instance.probe?.installed === false) return { readiness: 'NOT_READY', freshness, reason: 'NOT_INSTALLED' };
  const state = instance.process?.state;
  if (state === 'RUNNING') return { readiness: instance.probe.attachable === true ? 'READY' : 'NOT_READY', freshness, reason: instance.probe.attachable === true ? null : 'NOT_ATTACHABLE' };
  if (state === 'INSTALLED' || state === 'STARTING') return { readiness: 'NOT_READY', freshness, reason: 'NOT_RUNNING' };
  if (state === 'UNKNOWN') return { readiness: 'UNKNOWN', freshness, reason: 'UNKNOWN_PROCESS_STATE' };
  return { readiness: 'NOT_READY', freshness, reason: state };
}

/**
 * Usability. This is the function that keeps "a process is running" from being mistaken for
 * "this worker may act": auth and health are independent facts and every one of them must hold.
 */
export function usability(instance, nowMs) {
  const freshness = probeFreshness(instance, nowMs);
  const process = processReadiness(instance, nowMs);
  const authStatus = AUTH_STATUSES.includes(instance?.auth?.status) ? instance.auth.status : 'UNKNOWN';
  const health = HEALTH_STATES.includes(instance?.health) ? instance.health : 'UNKNOWN';
  const evidence = probeEvidenceSource(instance);
  const blockers = [];
  if (freshness !== 'FRESH') blockers.push('STALE_PROBE');
  // A recorded failure is the most recent thing the registry knows: the connector did not answer.
  const failure = isPlainObject(instance?.probe_failure) ? instance.probe_failure.code : null;
  if (failure === 'PROBE_TIMEOUT' || failure === 'PROBE_FAILED') blockers.push(failure);
  else if (failure !== null) blockers.push('PROBE_FAILED');
  if (process.readiness !== 'READY') blockers.push(`PROCESS_${process.readiness}`);
  // A live process never implies auth: READY must be observed as its own fact.
  if (authStatus !== 'READY') blockers.push(`AUTH_${authStatus}`);
  if (health !== 'HEALTHY') blockers.push(`HEALTH_${health}`);
  return Object.freeze({
    usable: blockers.length === 0,
    freshness,
    evidence_source: evidence,
    process_readiness: process.readiness,
    auth_status: authStatus,
    health,
    blockers: Object.freeze(blockers),
    reason: blockers[0] ?? null,
  });
}

/** Typed refusal before execution: an unusable instance is refused, never silently attempted. */
export function assertUsable(instance, nowMs) {
  const verdict = usability(instance, nowMs);
  if (!verdict.usable) {
    // The code names the blocker that actually applies. Deriving it from the blocker *category* told a
    // caller "PROCESS_NOT_READY" for an unhealthy-but-ready process, so the typed refusal carried the
    // wrong diagnosis while its own detail said HEALTH_UNHEALTHY.
    const blocker = verdict.blockers[0];
    const code = blocker === 'STALE_PROBE' || blocker === 'PROBE_TIMEOUT' || blocker === 'PROBE_FAILED' ? blocker
      : blocker.startsWith('AUTH_') ? 'AUTH_NOT_READY'
        : blocker.startsWith('PROCESS_') ? 'PROCESS_NOT_READY'
          : blocker.startsWith('HEALTH_') ? 'HEALTH_NOT_READY'
            : 'INVALID_REGISTRY_RECORD';
    throw new RegistryError(code, `instance ${instance?.instance_ref} is not usable: ${verdict.blockers.join(', ')}`);
  }
  return verdict;
}

/**
 * Requirement matching for dispatch and remote fallback. It reports *fit*, and deliberately does not
 * choose a host: a SUPPORTED fact is required, and an UNKNOWN fact is a mismatch (never assumed true).
 */
export function matchRequirements(instance, requirements = [], nowMs) {
  if (!Array.isArray(requirements)) throw new RegistryError('INVALID_REGISTRY_RECORD', 'requirements must be an array');
  const missing = [];
  const unknown = [];
  for (const fact of requirements) {
    if (!CAPABILITY_FACTS.includes(fact)) { unknown.push(fact); continue; }
    const answer = capabilityOf(instance, fact, nowMs);
    if (answer.level === 'UNSUPPORTED') missing.push(fact);
    else if (answer.level === 'UNKNOWN') unknown.push(fact);
  }
  const matched = missing.length === 0 && unknown.length === 0;
  return Object.freeze({
    instance_ref: instance.instance_ref,
    matched,
    required: Object.freeze([...requirements]),
    missing: Object.freeze(missing.sort()),
    unknown: Object.freeze(unknown.sort()),
    code: matched ? null : 'CAPABILITY_MISMATCH',
    detail: matched ? null : `missing ${missing.join(', ') || 'none'}; unverified ${unknown.join(', ') || 'none'}`,
  });
}

export function assertRequirements(instance, requirements, nowMs) {
  const verdict = matchRequirements(instance, requirements, nowMs);
  if (!verdict.matched) throw new RegistryError('CAPABILITY_MISMATCH', verdict.detail);
  return verdict;
}

// ---- registry ------------------------------------------------------------

export function createConnectorRegistry({ clock = () => null } = {}) {
  const descriptors = new Map();
  const instances = new Map();
  const probeFailures = [];

  /** Stamp or clear the per-instance probe-failure fact; validation still gates the write. */
  const writeProbeFailure = (instanceRef, probeFailure) => {
    const current = instances.get(instanceRef);
    if (!current) return;
    const next = structuredClone(current);
    if (probeFailure === null) delete next.probe_failure;
    else next.probe_failure = probeFailure;
    const verdict = validateConnectorInstance(next);
    if (verdict.ok) instances.set(instanceRef, next);
  };
  const stampProbeFailure = (instanceRef, code, detail) => {
    // The clock is a millisecond timestamp elsewhere in this module; the recorded fact needs an instant.
    const now = clock();
    const at = typeof now === 'number' && Number.isFinite(now) ? new Date(now).toISOString() : null;
    return writeProbeFailure(instanceRef, { code, at, detail: detail ?? null });
  };
  const clearProbeFailure = instanceRef => writeProbeFailure(instanceRef, null);

  const registry = {
    registerDescriptor(descriptor) {
      assertConnectorDescriptor(descriptor);
      const existing = descriptors.get(descriptor.connector_kind);
      if (existing && existing.runtime_kind !== descriptor.runtime_kind) {
        throw new RegistryError('DUPLICATE_CONNECTOR_KIND', `${descriptor.connector_kind} is already declared as ${existing.runtime_kind}`);
      }
      descriptors.set(descriptor.connector_kind, structuredClone(descriptor));
      return { connector_kind: descriptor.connector_kind, updated: Boolean(existing) };
    },

    /** One connector kind may have many instances; the instance identity is its own. */
    registerInstance(instance) {
      assertConnectorInstance(instance);
      if (!descriptors.has(instance.connector_kind)) {
        throw new RegistryError('UNKNOWN_CONNECTOR_KIND', `instance ${instance.instance_ref} names undeclared connector kind ${instance.connector_kind}`);
      }
      if (instances.has(instance.instance_ref)) throw new RegistryError('DUPLICATE_INSTANCE', String(instance.instance_ref));
      instances.set(instance.instance_ref, structuredClone(instance));
      return { instance_ref: instance.instance_ref, connector_kind: instance.connector_kind };
    },

    /**
     * Apply a partial probe/process/health/auth update. `process`, `health` and `auth` defaulted to
     * null ("no change") but `probe` did not, so a caller that observed only health had its whole
     * probe block replaced with `undefined` and the update refused with a message about a field it
     * never mentioned. A patch that carries none of the four facts is refused rather than reported as
     * a successful no-op — otherwise a probe that answered nothing looks like a probe that worked.
     */
    updateProbe(instanceRef, { probe = null, process = null, health = null, auth = null } = {}) {
      const current = instances.get(instanceRef);
      if (!current) throw new RegistryError('UNKNOWN_INSTANCE', String(instanceRef));
      if (probe === null && process === null && health === null && auth === null) {
        throw new RegistryError('INVALID_REGISTRY_RECORD', 'a probe update must carry at least one of probe, process, health or auth');
      }
      const next = structuredClone(current);
      if (probe !== null) next.probe = structuredClone(probe);
      if (process !== null) next.process = structuredClone(process);
      if (health !== null) next.health = health;
      if (auth !== null) next.auth = structuredClone(auth);
      assertConnectorInstance(next);
      instances.set(instanceRef, next);
      return structuredClone(next);
    },

    getDescriptor(connectorKind) {
      const found = descriptors.get(connectorKind);
      return found ? { found: true, code: null, descriptor: structuredClone(found) } : { found: false, code: 'UNKNOWN_CONNECTOR_KIND', detail: `connector kind ${String(connectorKind)} is not declared`, descriptor: null };
    },
    getInstance(instanceRef) {
      const found = instances.get(instanceRef);
      return found ? { found: true, code: null, instance: structuredClone(found) } : { found: false, code: 'UNKNOWN_INSTANCE', detail: `instance ${String(instanceRef)} is not registered`, instance: null };
    },
    listDescriptors() { return [...descriptors.values()].map(entry => structuredClone(entry)).sort((a, b) => a.connector_kind.localeCompare(b.connector_kind)); },
    listInstances({ connectorKind = null, deviceRef = null, authStatus = null, usableOnly = false } = {}) {
      const now = clock();
      return [...instances.values()]
        .filter(entry => connectorKind === null || entry.connector_kind === connectorKind)
        .filter(entry => deviceRef === null || entry.device_ref === deviceRef)
        .filter(entry => authStatus === null || entry.auth.status === authStatus)
        .filter(entry => !usableOnly || usability(entry, now).usable)
        .map(entry => structuredClone(entry)).sort((a, b) => a.instance_ref.localeCompare(b.instance_ref));
    },

    /**
     * Probe isolation: one connector's probe throwing or timing out is recorded as data and cannot
     * stop the others, and cannot leave the instance looking healthy.
     */
    probeAll(probes = []) {
      if (!Array.isArray(probes)) throw new RegistryError('INVALID_REGISTRY_RECORD', 'probes must be an array');
      const outcomes = [];
      for (const entry of probes) {
        const instanceRef = entry?.instanceRef;
        const run = entry?.probe;
        if (typeof run !== 'function') { outcomes.push({ instance_ref: instanceRef ?? null, ok: false, code: 'PROBE_FAILED', detail: 'a probe must be a function' }); continue; }
        if (!instances.has(instanceRef)) { outcomes.push({ instance_ref: instanceRef ?? null, ok: false, code: 'UNKNOWN_INSTANCE', detail: 'instance is not registered' }); continue; }
        try {
          const facts = run();
          if (facts === null || facts === undefined) {
            probeFailures.push({ instance_ref: instanceRef, code: 'PROBE_TIMEOUT' });
            stampProbeFailure(instanceRef, 'PROBE_TIMEOUT', 'the probe did not answer');
            outcomes.push({ instance_ref: instanceRef, ok: false, code: 'PROBE_TIMEOUT', detail: 'the probe did not answer' });
            continue;
          }
          registry.updateProbe(instanceRef, facts);
          clearProbeFailure(instanceRef);
          outcomes.push({ instance_ref: instanceRef, ok: true, code: null, detail: null });
        } catch (error) {
          const code = error?.code === 'PROBE_TIMEOUT' ? 'PROBE_TIMEOUT' : 'PROBE_FAILED';
          probeFailures.push({ instance_ref: instanceRef, code });
          stampProbeFailure(instanceRef, code, String(error?.message ?? error).slice(0, 160));
          outcomes.push({ instance_ref: instanceRef, ok: false, code, detail: String(error?.message ?? error).slice(0, 160) });
        }
      }
      return Object.freeze({ outcomes: Object.freeze(outcomes.map(Object.freeze)), failures: Object.freeze([...probeFailures]) });
    },

    /** Fit for a requirement set. Reports candidates and per-instance verdicts; chooses nothing. */
    eligibleInstances({ requirements = [], connectorKind = null, usableOnly = true } = {}) {
      const now = clock();
      const candidates = registry.listInstances({ connectorKind, usableOnly });
      return candidates.map(instance => {
        const match = matchRequirements(instance, requirements, now);
        return Object.freeze({ instance_ref: instance.instance_ref, connector_kind: instance.connector_kind, device_ref: instance.device_ref, match, usability: usability(instance, now) });
      });
    },

    /** Auditable snapshot. Handle references appear; handle values never do. */
    snapshot() {
      const now = clock();
      return Object.freeze({
        registry_version: ENGINEERING_REGISTRY_VERSION,
        descriptors: Object.freeze(registry.listDescriptors().map(entry => entry.connector_kind)),
        instances: Object.freeze([...instances.values()].map(entry => Object.freeze({
          instance_ref: entry.instance_ref,
          connector_kind: entry.connector_kind,
          device_ref: entry.device_ref,
          auth_status: entry.auth.status,
          capability_handle_present: entry.auth.handle_ref !== null,
          freshness: probeFreshness(entry, now),
          usable: usability(entry, now).usable,
        })).sort((a, b) => a.instance_ref.localeCompare(b.instance_ref))),
        // Copied and frozen: the snapshot is evidence, and `[...probeFailures]` copied only the array,
        // so a reader could rewrite the registry's own failure record through the snapshot.
        probe_failures: Object.freeze(probeFailures.map(entry => Object.freeze(structuredClone(entry)))),
      });
    },
  };

  return Object.freeze(registry);
}
