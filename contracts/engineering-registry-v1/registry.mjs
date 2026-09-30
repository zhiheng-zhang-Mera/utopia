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
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

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
    if (rule.type === 'bool' && typeof field !== 'boolean') errors.push(`${fieldPath} must be a boolean`);
    if (rule.type === 'object' && !isPlainObject(field)) errors.push(`${fieldPath} must be an object`);
    if (rule.type === 'array' && !Array.isArray(field)) errors.push(`${fieldPath} must be an array`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`${fieldPath} must be one of ${rule.values.join(', ')}`);
    if (rule.constant !== undefined && field !== rule.constant) errors.push(`${fieldPath} must be ${JSON.stringify(rule.constant)}`);
  }
}

const VERSION = { required: true, type: 'int', constant: ENGINEERING_REGISTRY_VERSION };
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
  ttl_ms: { required: true, type: 'int', min: 0 },
  version: { required: true, type: 'text', nullable: true },
  installed: { required: true, type: 'bool' },
  attachable: { required: true, type: 'bool' },
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
  if (isPlainObject(descriptor)) validateCapabilityManifest(descriptor.capability_manifest, 'descriptor.capability_manifest', errors);
  for (const found of findRawSecretFields(descriptor, 'descriptor')) errors.push(`${found} looks like raw secret bytes; registry records carry handles only`);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateConnectorInstance(instance) {
  const errors = [];
  checkShape(instance, 'instance', INSTANCE_SPEC, errors);
  if (isPlainObject(instance)) {
    if (isPlainObject(instance.process)) checkShape(instance.process, 'instance.process', PROCESS_SPEC, errors);
    if (isPlainObject(instance.auth)) checkShape(instance.auth, 'instance.auth', AUTH_SPEC, errors);
    if (isPlainObject(instance.probe)) checkShape(instance.probe, 'instance.probe', PROBE_SPEC, errors);
    if (isPlainObject(instance.probe?.source)) checkShape(instance.probe.source, 'instance.probe.source', SOURCE_SPEC, errors);
    if (instance.device_ref !== null && instance.device_ref !== undefined && !/^dev-[0-9a-f]{32}$/.test(instance.device_ref)) {
      errors.push('instance.device_ref must be a Remote Fabric dev-<32 hex> identity or null');
    }
    validateCapabilityManifest(instance.capability_manifest, 'instance.capability_manifest', errors);
    for (const found of findRawSecretFields(instance, 'instance')) errors.push(`${found} looks like raw secret bytes; registry records carry handles only`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function assertValid(verdict, record) {
  if (!verdict.ok) throw new RegistryError('INVALID_REGISTRY_RECORD', verdict.errors.slice(0, 3).join('; '));
  return record;
}

export const assertConnectorDescriptor = descriptor => assertValid(validateConnectorDescriptor(descriptor), descriptor);
export const assertConnectorInstance = instance => assertValid(validateConnectorInstance(instance), instance);

// ---- probe freshness and effective usability -----------------------------

export function probeFreshness(instance, nowMs) {
  const observed = Date.parse(instance?.probe?.observed_at ?? '');
  if (!Number.isFinite(observed) || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return 'UNKNOWN';
  return nowMs - observed <= instance.probe.ttl_ms ? 'FRESH' : 'STALE';
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
  const blockers = [];
  if (freshness !== 'FRESH') blockers.push('STALE_PROBE');
  if (process.readiness !== 'READY') blockers.push(`PROCESS_${process.readiness}`);
  // A live process never implies auth: READY must be observed as its own fact.
  if (authStatus !== 'READY') blockers.push(`AUTH_${authStatus}`);
  if (health !== 'HEALTHY') blockers.push(`HEALTH_${health}`);
  return Object.freeze({
    usable: blockers.length === 0,
    freshness,
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
    const code = verdict.blockers.includes('STALE_PROBE') ? 'STALE_PROBE'
      : verdict.blockers.some(blocker => blocker.startsWith('AUTH_')) ? 'AUTH_NOT_READY' : 'PROCESS_NOT_READY';
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

    updateProbe(instanceRef, { probe, process = null, health = null, auth = null } = {}) {
      const current = instances.get(instanceRef);
      if (!current) throw new RegistryError('UNKNOWN_INSTANCE', String(instanceRef));
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
            outcomes.push({ instance_ref: instanceRef, ok: false, code: 'PROBE_TIMEOUT', detail: 'the probe did not answer' });
            continue;
          }
          registry.updateProbe(instanceRef, facts);
          outcomes.push({ instance_ref: instanceRef, ok: true, code: null, detail: null });
        } catch (error) {
          const code = error?.code === 'PROBE_TIMEOUT' ? 'PROBE_TIMEOUT' : 'PROBE_FAILED';
          probeFailures.push({ instance_ref: instanceRef, code });
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
        descriptors: registry.listDescriptors().map(entry => entry.connector_kind),
        instances: [...instances.values()].map(entry => ({
          instance_ref: entry.instance_ref,
          connector_kind: entry.connector_kind,
          device_ref: entry.device_ref,
          auth_status: entry.auth.status,
          capability_handle_present: entry.auth.handle_ref !== null,
          freshness: probeFreshness(entry, now),
          usable: usability(entry, now).usable,
        })).sort((a, b) => a.instance_ref.localeCompare(b.instance_ref)),
        probe_failures: [...probeFailures],
      });
    },
  };

  return Object.freeze(registry);
}
