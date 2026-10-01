// Versioned capability registry + addressing (RF-007).
//
// Upper layers ask for a *logical* capability at a version — `camera.capture@1`, `screen.stream@1`,
// `filesystem.read@1` — and never for a device class or an OS-specific method. Two heterogeneous devices
// may advertise the same logical capability with completely different implementations, and a caller that
// asks for a compatible version learns nothing about which one answered.
//
// Advertising is availability metadata and nothing else: a descriptor always reports
// `permission_granted: false`, resolving never grants anything, and invoking a capability returns a ticket
// only when the caller supplies an explicit permission decision from policy. Losing a capability (hardware,
// OS permission or app state) invalidates new invocations and stays *visible* as a recorded loss rather
// than disappearing from state.
//
// Version negotiation is deterministic and never coercive: a requested major version is honoured exactly or
// refused with the supported set listed, because hiding an incompatible version behind best-effort coercion
// is explicitly out of scope.
//
// Scope: transport-addressable node/device capabilities only. Provider/model and connector/worker
// capabilities remain their own domain registries that reference the canonical device identity.
//
// Pure module: the clock is injected; no network, storage or ambient state.
export const CAPABILITY_REGISTRY_CONTRACT_VERSION = 1;

export const AVAILABILITY_STATES = Object.freeze(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN']);
export const EXCLUSIVITY = Object.freeze(['EXCLUSIVE', 'SHARED', 'BACKGROUND_CAPABLE']);
export const LOSS_REASONS = Object.freeze(['HARDWARE_REMOVED', 'OS_PERMISSION_REVOKED', 'APP_STATE_CHANGED', 'NODE_OFFLINE', 'USER_WITHDREW', 'EXPIRED', 'UNKNOWN']);
export const CONSTRAINT_KEYS = Object.freeze(['max_width', 'max_height', 'max_bytes', 'max_duration_ms', 'min_interval_ms', 'requires_foreground']);
export const CAPABILITY_ID_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+@[1-9][0-9]*$/;

export const CAPABILITY_CODES = Object.freeze([
  'INVALID_CAPABILITY_ID', 'INVALID_VERSIONS', 'INVALID_REQUEST', 'INVALID_EXECUTION', 'INVALID_CONSTRAINTS',
  'INVALID_CLOCK', 'INVALID_WIRE', 'INCOMPATIBLE_CONTRACT', 'UNKNOWN_CAPABILITY', 'INCOMPATIBLE_VERSION',
  'CAPABILITY_UNAVAILABLE', 'NOT_TRUSTED', 'PERMISSION_NOT_GRANTED', 'PERMISSION_DECISION_REQUIRED',
  'CONSTRAINT_UNSATISFIED', 'ADVERTISEMENT_VERSION_CONFLICT',
]);

const CONFLICT_CODES = new Set(['INCOMPATIBLE_VERSION', 'CAPABILITY_UNAVAILABLE', 'PERMISSION_NOT_GRANTED', 'ADVERTISEMENT_VERSION_CONFLICT', 'CONSTRAINT_UNSATISFIED']);

export class CapabilityError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CapabilityError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_CAPABILITY' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/**
 * Shape is not enough: `2026-13-45T99:99:99Z` matches the ISO shape but Date.parse() is NaN, and
 * NaN reaching Date.toISOString() escapes as an untyped RangeError. Require a real instant.
 */
const isRealInstant = value => isIsoInstant(value) && Number.isFinite(Date.parse(value));

/**
 * A caller-supplied evaluation instant is validated exactly like the injected clock: a malformed
 * `at` must surface as a typed refusal rather than leaking a RangeError from Date.toISOString().
 */
const callerInstant = value => {
  if (!isRealInstant(value)) {
    throw new CapabilityError('INVALID_REQUEST', `at must be an ISO-8601 UTC instant such as 2026-01-01T00:00:00Z, got ${String(value)}`);
  }
  return value;
};

/** `namespace.name@major` — a logical capability, never a device or OS method. */
export function parseCapabilityId(value) {
  if (!isText(value) || !CAPABILITY_ID_SHAPE.test(value.trim())) {
    throw new CapabilityError('INVALID_CAPABILITY_ID', `${String(value)} is not a versioned logical capability id such as camera.capture@1`);
  }
  const trimmed = value.trim();
  const [path, majorText] = trimmed.split('@');
  if (!Number.isSafeInteger(Number(majorText))) {
    throw new CapabilityError('INVALID_CAPABILITY_ID', `${trimmed} names a major that is not a safe integer`);
  }
  const segments = path.split('.');
  return freeze({
    capability_id: trimmed,
    namespace: segments[0],
    name: segments.slice(1).join('.'),
    major: Number(majorText),
    device_specific: false,
    os_specific: false,
  });
}

export const DEFAULT_EXECUTION = Object.freeze({
  exclusivity: 'SHARED',
  queueable: false,
  requires_live_session: false,
  default_expiry_ms: null,
});

export const DEFAULT_CAPABILITY_POLICY = Object.freeze({
  policy_ref: 'policy:rf-capability-default',
  default_ttl_ms: 300000,
  max_ttl_ms: 3600000,
});

/**
 * Canonical execution metadata is read field by field, own-property by own-property: a descriptor
 * that declares `exclusivity` must never be stored as the default merely because the field happened
 * to be non-enumerable, and no non-canonical name may be smuggled in beside it.
 */
const CANONICAL_EXECUTION_KEYS = Object.freeze(['exclusivity', 'queueable', 'requires_live_session', 'default_expiry_ms']);
function normaliseExecution(execution = {}) {
  const normalised = { ...DEFAULT_EXECUTION };
  for (const key of CANONICAL_EXECUTION_KEYS) {
    if (Object.hasOwn(execution, key) && execution[key] !== undefined) normalised[key] = execution[key];
  }
  return freeze(normalised);
}

function validateExecution(execution, path, errors) {
  if (execution === undefined) return;
  if (!isPlainObject(execution)) { errors.push(`${path} must be an object`); return; }
  for (const key of Reflect.ownKeys(execution)) if (typeof key !== 'string' || !Object.hasOwn(DEFAULT_EXECUTION, key)) errors.push(`${path}.${String(key)} is not part of the canonical execution metadata`);
  if (execution.exclusivity !== undefined && !EXCLUSIVITY.includes(execution.exclusivity)) errors.push(`${path}.exclusivity must be one of ${EXCLUSIVITY.join(', ')}`);
  if (execution.queueable !== undefined && typeof execution.queueable !== 'boolean') errors.push(`${path}.queueable must be a boolean`);
  if (execution.requires_live_session !== undefined && typeof execution.requires_live_session !== 'boolean') errors.push(`${path}.requires_live_session must be a boolean`);
  if (execution.default_expiry_ms !== undefined && execution.default_expiry_ms !== null && (!Number.isSafeInteger(execution.default_expiry_ms) || execution.default_expiry_ms <= 0)) errors.push(`${path}.default_expiry_ms must be a positive integer or null`);
}

function validateConstraints(constraints, path, errors) {
  if (constraints === undefined) return;
  if (!isPlainObject(constraints)) { errors.push(`${path} must be an object`); return; }
  for (const key of Object.keys(constraints)) if (!CONSTRAINT_KEYS.includes(key)) errors.push(`${path}.${key} is not a canonical constraint`);
  for (const [key, value] of Object.entries(constraints)) {
    if (key === 'requires_foreground') {
      if (typeof value !== 'boolean') errors.push(`${path}.${key} must be a boolean`);
      continue;
    }
    if (!Number.isSafeInteger(value) || value <= 0) errors.push(`${path}.${key} must be a positive integer`);
  }
}

export function createCapabilityRegistry({ clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new CapabilityError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) {
    throw new CapabilityError('INVALID_REQUEST', 'policy must be an object');
  }
  const config = { ...DEFAULT_CAPABILITY_POLICY, ...(policy ?? {}) };
  for (const key of ['default_ttl_ms', 'max_ttl_ms']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new CapabilityError('INVALID_REQUEST', `policy.${key} must be a positive safe integer, got ${String(config[key])}`);
    }
  }
  if (config.default_ttl_ms > config.max_ttl_ms) {
    throw new CapabilityError('INVALID_REQUEST', 'policy.default_ttl_ms may not exceed policy.max_ttl_ms');
  }
  const advertisements = new Map();
  const losses = [];
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new CapabilityError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const keyFor = (node_ref, capability_id) => `${node_ref}\u0000${capability_id}`;

  const project = (advertisement, at) => freeze({
    contract_version: CAPABILITY_REGISTRY_CONTRACT_VERSION,
    advertisement_ref: advertisement.advertisement_ref,
    advertisement_version: advertisement.advertisement_version,
    node_ref: advertisement.node_ref,
    installation_ref: advertisement.installation_ref,
    capability_id: advertisement.capability_id,
    namespace: advertisement.namespace,
    supported_versions: clone(advertisement.supported_versions),
    chosen_version: advertisement.chosen_version,
    availability: advertisement.availability,
    available: advertisement.availability === 'AVAILABLE',
    loss_reason: advertisement.loss_reason ?? null,
    constraints: clone(advertisement.constraints),
    execution: clone(advertisement.execution),
    endpoint_ref: advertisement.endpoint_ref,
    adapter_ref: advertisement.adapter_ref,
    implementation_ref: advertisement.implementation_ref,
    observed_at: advertisement.observed_at,
    expires_at: advertisement.expires_at,
    expired: Date.parse(advertisement.expires_at) <= Date.parse(at),
    device_class: null,
    os_specific_method: null,
    permission_granted: false,
    advertisement_is_permission: false,
    canonical_device_identity: advertisement.node_ref,
  });

  const findAdvertisement = (node_ref, capability_id) => advertisements.get(keyFor(node_ref, capability_id)) ?? null;

  const candidatesFor = ({ capability_id, requested_major = null, trusted_nodes = null, at, constraints = null }) => {
    const candidates = [];
    for (const advertisement of advertisements.values()) {
      if (advertisement.capability_id !== capability_id) continue;
      const projected = project(advertisement, at);
      if (trusted_nodes !== null && !trusted_nodes.includes(advertisement.node_ref)) {
        candidates.push({ node_ref: advertisement.node_ref, excluded_reason: 'NOT_TRUSTED', trusted: false });
        continue;
      }
      if (projected.expired) { candidates.push({ node_ref: advertisement.node_ref, excluded_reason: 'ADVERTISEMENT_EXPIRED', trusted: true }); continue; }
      if (advertisement.availability !== 'AVAILABLE') {
        candidates.push({ node_ref: advertisement.node_ref, excluded_reason: `CAPABILITY_${advertisement.availability}`, trusted: true, availability: advertisement.availability, loss_reason: advertisement.loss_reason ?? null });
        continue;
      }
      if (requested_major !== null && !advertisement.supported_versions.includes(requested_major)) {
        candidates.push({ node_ref: advertisement.node_ref, excluded_reason: 'INCOMPATIBLE_VERSION', trusted: true, supported_versions: clone(advertisement.supported_versions) });
        continue;
      }
      if (constraints !== null) {
        const unmet = Object.entries(constraints).filter(([key, value]) => {
          if (key === 'requires_foreground') return value === true && advertisement.constraints?.requires_foreground !== true;
          const offered = advertisement.constraints?.[key];
          return offered === undefined || offered < value;
        });
        if (unmet.length > 0) {
          candidates.push({ node_ref: advertisement.node_ref, excluded_reason: 'CONSTRAINT_UNSATISFIED', trusted: true, unmet: unmet.map(([key]) => key) });
          continue;
        }
      }
      const negotiated = requested_major !== null ? requested_major : Math.max(...advertisement.supported_versions);
      candidates.push({
        node_ref: advertisement.node_ref,
        trusted: true,
        eligible: true,
        negotiated_major: negotiated,
        advertisement_ref: advertisement.advertisement_ref,
        advertisement_version: advertisement.advertisement_version,
        adapter_ref: advertisement.adapter_ref,
        endpoint_ref: advertisement.endpoint_ref,
        implementation_ref: advertisement.implementation_ref,
        execution: clone(advertisement.execution),
        availability: advertisement.availability,
      });
    }
    candidates.sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      if ((right.negotiated_major ?? 0) !== (left.negotiated_major ?? 0)) return (right.negotiated_major ?? 0) - (left.negotiated_major ?? 0);
      if (left.node_ref !== right.node_ref) return left.node_ref < right.node_ref ? -1 : 1;
      return (right.advertisement_version ?? 0) - (left.advertisement_version ?? 0);
    });
    return freeze(candidates);
  };

  const api = {
    policy: () => freeze(clone(config)),
    parseCapabilityId,

    /**
     * Advertise (or re-advertise) a capability for one node. Re-advertising bumps the advertisement
     * version, which is how a capability regaining availability stays visible as a versioned change.
     */
    advertise({
      node_ref, installation_ref = null, capability_id, supported_versions, constraints = {},
      execution = {}, endpoint_ref, adapter_ref, implementation_ref = null, availability = 'AVAILABLE', ttl_ms, at: when,
    } = {}) {
      const parsed = parseCapabilityId(capability_id);
      if (!isText(node_ref)) throw new CapabilityError('INVALID_REQUEST', 'node_ref is required');
      if (!isText(endpoint_ref) || !isText(adapter_ref)) throw new CapabilityError('INVALID_REQUEST', 'endpoint_ref and adapter_ref are required');
      if (!Array.isArray(supported_versions) || supported_versions.length === 0
        || supported_versions.some(version => !Number.isSafeInteger(version) || version <= 0)
        || new Set(supported_versions).size !== supported_versions.length) {
        throw new CapabilityError('INVALID_VERSIONS', 'supported_versions must be a non-empty list of distinct positive integers');
      }
      if (!supported_versions.includes(parsed.major)) {
        throw new CapabilityError('INVALID_VERSIONS', `the capability id names major ${parsed.major}, which is not in supported_versions`);
      }
      if (!AVAILABILITY_STATES.includes(availability)) throw new CapabilityError('INVALID_REQUEST', `availability must be one of ${AVAILABILITY_STATES.join(', ')}`);
      const errors = [];
      validateExecution(execution, 'execution', errors);
      validateConstraints(constraints, 'constraints', errors);
      if (errors.length) {
        const code = errors.some(error => error.startsWith('execution')) ? 'INVALID_EXECUTION' : 'INVALID_CONSTRAINTS';
        throw new CapabilityError(code, errors.join('; '));
      }
      const ttl = ttl_ms ?? config.default_ttl_ms;
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > config.max_ttl_ms) throw new CapabilityError('INVALID_REQUEST', `ttl_ms must be a positive integer up to ${config.max_ttl_ms}`);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const existing = findAdvertisement(node_ref, parsed.capability_id);
      counter += 1;
      const advertisement = {
        contract_version: CAPABILITY_REGISTRY_CONTRACT_VERSION,
        advertisement_ref: existing?.advertisement_ref ?? `advertisement:${counter}`,
        advertisement_version: (existing?.advertisement_version ?? 0) + 1,
        node_ref,
        installation_ref,
        capability_id: parsed.capability_id,
        namespace: parsed.namespace,
        supported_versions: [...supported_versions].sort((left, right) => left - right),
        chosen_version: parsed.major,
        availability,
        constraints: freeze({ ...constraints }),
        execution: normaliseExecution(execution),
        endpoint_ref,
        adapter_ref,
        implementation_ref,
        observed_at: at,
        expires_at: new Date(Date.parse(at) + ttl).toISOString(),
        loss_reason: null,
      };
      advertisements.set(keyFor(node_ref, parsed.capability_id), advertisement);
      note('CAPABILITY_ADVERTISED', at, { node_ref, capability_id: parsed.capability_id, advertisement_version: advertisement.advertisement_version });
      return project(advertisement, at);
    },

    /** Loss stays visible: the advertisement is marked unavailable rather than disappearing. */
    withdraw({ node_ref, capability_id, reason = 'UNKNOWN', at: when } = {}) {
      const parsed = parseCapabilityId(capability_id);
      if (!LOSS_REASONS.includes(reason)) throw new CapabilityError('INVALID_REQUEST', `loss reason must be one of ${LOSS_REASONS.join(', ')}`);
      const advertisement = findAdvertisement(node_ref, parsed.capability_id);
      if (!advertisement) throw new CapabilityError('UNKNOWN_CAPABILITY', `node ${node_ref} does not advertise ${parsed.capability_id}`);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const loss = freeze({
        loss_ref: `loss:${node_ref}:${parsed.capability_id}:${advertisement.advertisement_version}`,
        node_ref,
        capability_id: parsed.capability_id,
        reason,
        advertisement_version: advertisement.advertisement_version,
        previous_availability: advertisement.availability,
        at,
      });
      losses.push(loss);
      advertisement.availability = 'UNAVAILABLE';
      advertisement.loss_reason = reason;
      advertisement.observed_at = at;
      note('CAPABILITY_LOST', at, { node_ref, capability_id: parsed.capability_id, reason });
      return freeze({
        ...project(advertisement, at),
        loss,
        visible_through_state: true,
        new_invocations_invalidated: true,
        capability_removed_from_trust: false,
      });
    },

    lookup({ capability_id, at: when } = {}) {
      const parsed = parseCapabilityId(capability_id);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const matches = [...advertisements.values()].filter(advertisement => advertisement.capability_id === parsed.capability_id);
      if (matches.length === 0) throw new CapabilityError('UNKNOWN_CAPABILITY', `no node advertises ${parsed.capability_id}`);
      return freeze({
        capability_id: parsed.capability_id,
        advertisements: freeze(matches.map(advertisement => project(advertisement, at))),
        advertisement_count: matches.length,
        heterogeneous_implementations: new Set(matches.map(advertisement => advertisement.adapter_ref)).size > 1,
        permission_granted: false,
      });
    },

    /** What one node currently provides, including its recorded capability losses. */
    snapshot({ node_ref, at: when } = {}) {
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const owned = [...advertisements.values()].filter(advertisement => advertisement.node_ref === node_ref);
      const nodeLosses = losses.filter(loss => loss.node_ref === node_ref);
      return freeze({
        contract_version: CAPABILITY_REGISTRY_CONTRACT_VERSION,
        node_ref,
        capabilities: freeze(owned.map(advertisement => project(advertisement, at))),
        available_capabilities: freeze(owned.filter(advertisement => advertisement.availability === 'AVAILABLE' && !project(advertisement, at).expired).map(advertisement => advertisement.capability_id)),
        losses: freeze(clone(nodeLosses)),
        loss_count: nodeLosses.length,
        permission_granted: false,
        capability_is_availability_metadata: true,
      });
    },

    /** Deterministic negotiation: an exact requested major, or the highest version offered. */
    resolve({ capability_id, requested_major = null, trusted_nodes = null, constraints = null, at: when } = {}) {
      const parsed = parseCapabilityId(capability_id);
      if (requested_major !== null && (!Number.isSafeInteger(requested_major) || requested_major <= 0)) {
        throw new CapabilityError('INVALID_REQUEST', 'requested_major must be a positive integer when given');
      }
      if (trusted_nodes !== null && !Array.isArray(trusted_nodes)) throw new CapabilityError('INVALID_REQUEST', 'trusted_nodes must be an array when given');
      const errors = [];
      validateConstraints(constraints ?? undefined, 'constraints', errors);
      if (errors.length) throw new CapabilityError('INVALID_CONSTRAINTS', errors.join('; '));
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const examined = [...advertisements.values()].filter(advertisement => advertisement.capability_id === parsed.capability_id);
      if (examined.length === 0) throw new CapabilityError('UNKNOWN_CAPABILITY', `no node advertises ${parsed.capability_id}`);
      const candidates = candidatesFor({ capability_id: parsed.capability_id, requested_major, trusted_nodes, at, constraints });
      const eligible = candidates.filter(candidate => candidate.eligible === true);
      if (eligible.length === 0) {
        const versionFailures = candidates.filter(candidate => candidate.excluded_reason === 'INCOMPATIBLE_VERSION');
        if (versionFailures.length > 0) {
          throw new CapabilityError('INCOMPATIBLE_VERSION', `no trusted node offers ${parsed.capability_id} at major ${requested_major}`, {
            capability_id: parsed.capability_id,
            requested_major,
            supported_versions: freeze([...new Set(versionFailures.flatMap(candidate => candidate.supported_versions ?? []))].sort((left, right) => left - right)),
            coerced: false,
            best_effort_downgrade: false,
            candidates,
          });
        }
        const unavailable = candidates.filter(candidate => candidate.excluded_reason?.startsWith('CAPABILITY_'));
        if (unavailable.length > 0) {
          throw new CapabilityError('CAPABILITY_UNAVAILABLE', `${parsed.capability_id} is advertised but not available`, {
            capability_id: parsed.capability_id,
            availability: freeze(unavailable.map(candidate => ({ node_ref: candidate.node_ref, availability: candidate.availability, loss_reason: candidate.loss_reason }))),
            candidates,
          });
        }
        const untrustedOnly = candidates.every(candidate => candidate.trusted === false);
        if (untrustedOnly) throw new CapabilityError('NOT_TRUSTED', `${parsed.capability_id} is only advertised by untrusted nodes`, { capability_id: parsed.capability_id, candidates });
        const constraintFailures = candidates.filter(candidate => candidate.excluded_reason === 'CONSTRAINT_UNSATISFIED');
        if (constraintFailures.length > 0) {
          throw new CapabilityError('CONSTRAINT_UNSATISFIED', `no advertisement satisfies the requested constraints`, { capability_id: parsed.capability_id, unmet: freeze(constraintFailures.map(candidate => ({ node_ref: candidate.node_ref, unmet: candidate.unmet }))), candidates });
        }
        throw new CapabilityError('CAPABILITY_UNAVAILABLE', `no eligible advertisement for ${parsed.capability_id}`, { capability_id: parsed.capability_id, candidates });
      }
      const chosen = eligible[0];
      const advertisement = findAdvertisement(chosen.node_ref, parsed.capability_id);
      note('CAPABILITY_RESOLVED', at, { capability_id: parsed.capability_id, node_ref: chosen.node_ref, major: chosen.negotiated_major });
      return freeze({
        contract_version: CAPABILITY_REGISTRY_CONTRACT_VERSION,
        found: true,
        capability_id: parsed.capability_id,
        requested_major,
        negotiated_major: chosen.negotiated_major,
        node_ref: chosen.node_ref,
        adapter_ref: chosen.adapter_ref,
        endpoint_ref: chosen.endpoint_ref,
        implementation_ref: chosen.implementation_ref,
        execution: chosen.execution,
        availability: chosen.availability,
        capability_is_not_permission: true,
        permission_granted: false,
        permission_decision_required: true,
        device_class: null,
        negotiated_deterministically: true,
        candidate_count: eligible.length,
        candidates,
        advertisement_version: advertisement.advertisement_version,
      });
    },

    /** Lookup across trusted nodes: untrusted advertisements are never candidates. */
    resolveAcrossTrusted({ capability_id, requested_major = null, trusted_nodes = [], constraints = null, at: when } = {}) {
      if (!Array.isArray(trusted_nodes) || trusted_nodes.length === 0) throw new CapabilityError('INVALID_REQUEST', 'trusted_nodes must be a non-empty array');
      return api.resolve({ capability_id, requested_major, trusted_nodes, constraints, at: when });
    },

    /**
     * An invocation ticket, not an invocation. Availability is checked, the version must be compatible, and
     * the caller must supply the permission decision — this registry never grants permission.
     */
    invoke({ capability_id, node_ref = null, requested_major = null, permission_decision = null, invocation_ref, at: when } = {}) {
      if (!isText(invocation_ref)) throw new CapabilityError('INVALID_REQUEST', 'invocation_ref is required');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const resolved = node_ref === null
        ? api.resolve({ capability_id, requested_major, at })
        : api.resolve({ capability_id, requested_major, trusted_nodes: [node_ref], at });
      if (permission_decision === null || permission_decision === undefined) {
        throw new CapabilityError('PERMISSION_DECISION_REQUIRED', 'an advertised capability grants nothing; supply the permission decision from policy', { capability_id: resolved.capability_id, node_ref: resolved.node_ref });
      }
      if (permission_decision.granted !== true) {
        throw new CapabilityError('PERMISSION_NOT_GRANTED', 'the permission decision denied this invocation', { capability_id: resolved.capability_id, node_ref: resolved.node_ref, policy_ref: permission_decision.policy_ref ?? null });
      }
      const advertisement = findAdvertisement(resolved.node_ref, resolved.capability_id);
      const current = project(advertisement, at);
      // Expiry is evaluated both at the requested instant and at the registry's own clock: a caller
      // cannot make an already-expired advertisement invocable by naming an earlier instant.
      const currentAtRegistryClock = project(advertisement, now());
      if (!current.available || current.expired || currentAtRegistryClock.expired) {
        throw new CapabilityError('CAPABILITY_UNAVAILABLE', `${resolved.capability_id} is no longer available on ${resolved.node_ref}`, { capability_id: resolved.capability_id, node_ref: resolved.node_ref, availability: current.availability, loss_reason: advertisement.loss_reason, expired_at_requested_instant: current.expired, expired_at_registry_clock: currentAtRegistryClock.expired });
      }
      counter += 1;
      note('CAPABILITY_INVOCATION_ISSUED', at, { capability_id: resolved.capability_id, node_ref: resolved.node_ref });
      return freeze({
        contract_version: CAPABILITY_REGISTRY_CONTRACT_VERSION,
        ticket_ref: `invocation:${counter}`,
        invocation_ref,
        capability_id: resolved.capability_id,
        node_ref: resolved.node_ref,
        negotiated_major: resolved.negotiated_major,
        adapter_ref: resolved.adapter_ref,
        endpoint_ref: resolved.endpoint_ref,
        execution: resolved.execution,
        exclusive: resolved.execution.exclusivity === 'EXCLUSIVE',
        queueable: resolved.execution.queueable,
        requires_live_session: resolved.execution.requires_live_session,
        default_expiry_ms: resolved.execution.default_expiry_ms,
        permission_granted: true,
        permission_policy_ref: permission_decision.policy_ref ?? null,
        executed: false,
        external_side_effect: false,
        canonical_device_identity: resolved.node_ref,
        at,
      });
    },

    /** Serialization must preserve execution semantics and versioning exactly. */
    toWire({ node_ref, capability_id } = {}) {
      const parsed = parseCapabilityId(capability_id);
      const advertisement = findAdvertisement(node_ref, parsed.capability_id);
      if (!advertisement) throw new CapabilityError('UNKNOWN_CAPABILITY', `node ${node_ref} does not advertise ${parsed.capability_id}`);
      return freeze({
        wire_version: CAPABILITY_REGISTRY_CONTRACT_VERSION,
        capabilities: [freeze(clone({
          advertisement_ref: advertisement.advertisement_ref,
          advertisement_version: advertisement.advertisement_version,
          node_ref: advertisement.node_ref,
          installation_ref: advertisement.installation_ref,
          capability_id: advertisement.capability_id,
          supported_versions: advertisement.supported_versions,
          availability: advertisement.availability,
          constraints: advertisement.constraints,
          execution: advertisement.execution,
          endpoint_ref: advertisement.endpoint_ref,
          adapter_ref: advertisement.adapter_ref,
          implementation_ref: advertisement.implementation_ref,
          observed_at: advertisement.observed_at,
          expires_at: advertisement.expires_at,
          loss_reason: advertisement.loss_reason,
        }))],
      });
    },

    fromWire({ wire, at: when } = {}) {
      if (!isPlainObject(wire) || !Array.isArray(wire.capabilities)) throw new CapabilityError('INVALID_WIRE', 'a wire payload needs a capabilities array');
      if (wire.wire_version !== CAPABILITY_REGISTRY_CONTRACT_VERSION) {
        throw new CapabilityError('INCOMPATIBLE_CONTRACT', `wire version ${String(wire.wire_version)} is not ${CAPABILITY_REGISTRY_CONTRACT_VERSION}`, { wire_version: wire.wire_version ?? null, coerced: false });
      }
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const accepted = [];
      const pending = [];
      const seen = new Set();
      for (const entry of wire.capabilities) {
        const errors = [];
        if (!isPlainObject(entry)) throw new CapabilityError('INVALID_WIRE', 'each wire capability must be an object');
        const parsed = parseCapabilityId(entry.capability_id);
        if (!isText(entry.node_ref)) errors.push('node_ref is required');
        if (!isText(entry.endpoint_ref) || !isText(entry.adapter_ref)) errors.push('endpoint_ref and adapter_ref are required');
        if (!Array.isArray(entry.supported_versions) || entry.supported_versions.length === 0
          || entry.supported_versions.some(version => !Number.isSafeInteger(version) || version <= 0)
          || new Set(entry.supported_versions).size !== entry.supported_versions.length) {
          errors.push('supported_versions must be a non-empty list of distinct positive integers');
        } else if (!entry.supported_versions.includes(parsed.major)) {
          errors.push(`the capability id names major ${parsed.major}, which is not in supported_versions`);
        }
        if (!Number.isSafeInteger(entry.advertisement_version) || entry.advertisement_version <= 0) errors.push('advertisement_version must be a positive integer');
        if (!isRealInstant(entry.expires_at)) errors.push('expires_at must be an ISO-8601 UTC instant');
        if (entry.observed_at !== undefined && !isRealInstant(entry.observed_at)) errors.push('observed_at must be an ISO-8601 UTC instant');
        validateExecution(entry.execution, 'execution', errors);
        validateConstraints(entry.constraints, 'constraints', errors);
        if (!AVAILABILITY_STATES.includes(entry.availability)) errors.push('availability is not canonical');
        if (errors.length) throw new CapabilityError('INVALID_WIRE', errors.join('; '));
        const stored = findAdvertisement(entry.node_ref, parsed.capability_id);
        if (stored && (entry.advertisement_version < stored.advertisement_version
          || (stored.availability !== 'AVAILABLE' && entry.advertisement_version <= stored.advertisement_version))) {
          throw new CapabilityError('ADVERTISEMENT_VERSION_CONFLICT', `${parsed.capability_id} on ${entry.node_ref} already holds advertisement version ${stored.advertisement_version}; a wire payload may not replace newer state or silently clear a recorded loss`, { replaced_version: entry.advertisement_version, held_version: stored.advertisement_version, held_availability: stored.availability });
        }
        if (seen.has(keyFor(entry.node_ref, parsed.capability_id))) throw new CapabilityError('INVALID_WIRE', `duplicate advertisement for ${parsed.capability_id} on ${entry.node_ref}`);
        seen.add(keyFor(entry.node_ref, parsed.capability_id));
        pending.push({
          wire_ref: isText(entry.advertisement_ref) ? entry.advertisement_ref : null,
          advertisement_version: entry.advertisement_version,
          node_ref: entry.node_ref,
          installation_ref: entry.installation_ref ?? null,
          capability_id: parsed.capability_id,
          namespace: parsed.namespace,
          supported_versions: [...entry.supported_versions].sort((left, right) => left - right),
          chosen_version: parsed.major,
          availability: entry.availability,
          constraints: freeze({ ...(entry.constraints ?? {}) }),
          execution: normaliseExecution(entry.execution),
          endpoint_ref: entry.endpoint_ref,
          adapter_ref: entry.adapter_ref,
          implementation_ref: entry.implementation_ref ?? null,
          observed_at: entry.observed_at ?? at,
          expires_at: entry.expires_at,
          loss_reason: entry.loss_reason ?? null,
        });
      }
      // Nothing is installed until every entry has been validated: a refused payload must leave
      // the registry exactly as it was, with no partially applied snapshot.
      for (const staged of pending) {
        counter += 1;
        const advertisement = {
          contract_version: CAPABILITY_REGISTRY_CONTRACT_VERSION,
          advertisement_ref: staged.wire_ref ?? `advertisement:${counter}`,
          advertisement_version: staged.advertisement_version,
          node_ref: staged.node_ref,
          installation_ref: staged.installation_ref,
          capability_id: staged.capability_id,
          namespace: staged.namespace,
          supported_versions: staged.supported_versions,
          chosen_version: staged.chosen_version,
          availability: staged.availability,
          constraints: staged.constraints,
          execution: staged.execution,
          endpoint_ref: staged.endpoint_ref,
          adapter_ref: staged.adapter_ref,
          implementation_ref: staged.implementation_ref,
          observed_at: staged.observed_at,
          expires_at: staged.expires_at,
          loss_reason: staged.loss_reason,
        };
        advertisements.set(keyFor(advertisement.node_ref, advertisement.capability_id), advertisement);
        accepted.push(advertisement.capability_id);
      }
      note('WIRE_ACCEPTED', at, { accepted: accepted.length });
      return freeze({ accepted_capabilities: accepted, accepted_count: accepted.length, wire_version: wire.wire_version, execution_metadata_preserved: true, coerced: false });
    },

    advertisements: ({ at: when } = {}) => {
      const at = when === undefined || when === null ? now() : callerInstant(when);
      return freeze(clone([...advertisements.values()].map(advertisement => project(advertisement, at))));
    },
    losses: () => clone(losses),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
