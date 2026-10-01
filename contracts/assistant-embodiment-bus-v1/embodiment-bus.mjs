// Embodiment event bus, execution leases and reconnect safety (BA-008).
//
// One authoritative Assistant event model for every embodiment. Devices are projections of one logical
// assistant, so their inputs are versioned against authoritative task state (never against a live local
// plan), replays are rejected or absorbed idempotently, and output is routed to the embodiments that may
// actually see it rather than broadcast everywhere.
//
// Split-brain execution is prevented structurally: at most ONE valid exclusive lease exists per action
// scope, and a side effect is only committed by the current lease holder with an unused action key. A
// disconnected device's leases are suspended, and nothing resumes until authoritative state has been
// re-fetched and the lease revalidated — a stale local lease is never enough.
//
// This is the Assistant domain-semantic bus. Remote Fabric may carry the bytes, but a transport envelope
// never becomes the canonical Assistant event, and this module owns no transport.
//
// Pure module: the clock is injected; no network, storage or ambient state.
export const EMBODIMENT_BUS_CONTRACT_VERSION = 1;

export const EVENT_KINDS = Object.freeze(['INPUT', 'OUTPUT', 'LEASE', 'RECONCILE', 'LIFECYCLE']);
export const EVENT_DIRECTIONS = Object.freeze(['INBOUND', 'OUTBOUND']);
export const AUDIENCES = Object.freeze(['USER', 'ASSISTANT', 'DEVICE', 'WORKSPACE', 'PUBLIC']);
export const PRIVACY_SCOPES = Object.freeze(['PRIVATE', 'SHARED']);
export const LEASE_STATES = Object.freeze(['ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'SUPERSEDED']);
export const ROUTING_REASONS = Object.freeze(['FOREGROUND', 'AUDIENCE_MATCH', 'WATCHER', 'TARGETED', 'DEVICE_UNAVAILABLE', 'PRIVACY_WITHHELD', 'NOT_IN_AUDIENCE']);
export const CANONICAL_STATE_SOURCE = 'ASSISTANT_EMBODIMENT_BUS';

export const EMBODIMENT_CODES = Object.freeze([
  'INVALID_EVENT', 'INVALID_LEASE', 'INVALID_CLOCK', 'INVALID_REQUEST', 'UNKNOWN_LEASE', 'UNKNOWN_DEVICE',
  'STALE_EVENT', 'DUPLICATE_ACTION_KEY', 'EXCLUSIVE_LEASE_HELD', 'LEASE_EXPIRED', 'LEASE_REVOKED',
  'LEASE_SUPERSEDED', 'LEASE_VERSION_CONFLICT', 'NOT_LEASE_HOLDER', 'REVALIDATION_REQUIRED',
  'ACTION_KEY_REQUIRED', 'AUDIENCE_NOT_PERMITTED', 'PRIVACY_WITHHELD',
]);

const CONFLICT_CODES = new Set(['EXCLUSIVE_LEASE_HELD', 'LEASE_VERSION_CONFLICT', 'DUPLICATE_ACTION_KEY', 'REVALIDATION_REQUIRED', 'STALE_EVENT', 'LEASE_EXPIRED', 'LEASE_REVOKED', 'LEASE_SUPERSEDED']);

export class EmbodimentError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EmbodimentError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_LEASE' || code === 'UNKNOWN_DEVICE' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  const seen = new WeakSet();
  const walk = node => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);
    for (const child of Object.values(node)) walk(child);
    return Object.freeze(node);
  };
  return walk(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

const INSTANT_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
/** Shape is not enough: the regex accepts a calendar-impossible date, so components must round trip. */
const isRealInstant = value => {
  if (!isIsoInstant(value)) return false;
  const parts = INSTANT_PARTS.exec(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return date.getUTCFullYear() === Number(parts[1])
    && date.getUTCMonth() + 1 === Number(parts[2])
    && date.getUTCDate() === Number(parts[3])
    && date.getUTCHours() === Number(parts[4])
    && date.getUTCMinutes() === Number(parts[5])
    && date.getUTCSeconds() === Number(parts[6]);
};

const callerInstant = (value, label = 'at') => {
  if (!isRealInstant(value)) throw new EmbodimentError('INVALID_REQUEST', `${label} must be a real ISO-8601 UTC instant such as 2026-01-01T00:00:00Z, got ${String(value)}`);
  return value;
};

export const EVENT_SPEC = Object.freeze({
  event_id: { required: true, type: 'text' },
  assistant_ref: { required: true, type: 'text' },
  kind: { required: true, type: 'enum', values: EVENT_KINDS },
  direction: { required: true, type: 'enum', values: EVENT_DIRECTIONS },
  source_device_ref: { required: true, type: 'text' },
  embodiment_kind: { required: false, type: 'text', nullable: true },
  audience: { required: true, type: 'enum', values: AUDIENCES },
  privacy: { required: true, type: 'enum', values: PRIVACY_SCOPES },
  task_ref: { required: false, type: 'text', nullable: true },
  task_version: { required: false, type: 'int', nullable: true },
  command_ref: { required: false, type: 'text', nullable: true },
  action_key: { required: false, type: 'text', nullable: true },
  lease_ref: { required: false, type: 'text', nullable: true },
  correlation_ref: { required: true, type: 'text' },
  caused_by: { required: false, type: 'text', nullable: true },
  payload_ref: { required: false, type: 'text', nullable: true },
  transport_ref: { required: false, type: 'text', nullable: true },
  at: { required: true, type: 'instant' },
});

/** Task truth lives in the task graph; the bus only serialises against the version it is told. */
export const AUTHORITATIVE_TASK_VERSION = Symbol('ba008.authoritativeTaskVersion');

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !Object.hasOwn(spec, key)) errors.push(`${path}.${String(key)} is not part of the canonical contract`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isRealInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int' && (!Number.isSafeInteger(field) || field < 0)) errors.push(`${fieldPath} must be a non-negative integer`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`${fieldPath} must be one of ${rule.values.join(', ')}`);
  }
}

export const DEFAULT_BUS_POLICY = Object.freeze({
  policy_ref: 'policy:ba-embodiment-default',
  default_lease_ttl_ms: 60000,
  max_lease_ttl_ms: 900000,
  require_action_key_for_exclusive: true,
});

export function createEmbodimentBus({ clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new EmbodimentError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) throw new EmbodimentError('INVALID_REQUEST', 'policy must be an object');
  const config = { ...DEFAULT_BUS_POLICY, ...(policy ?? {}) };
  for (const key of ['default_lease_ttl_ms', 'max_lease_ttl_ms']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new EmbodimentError('INVALID_REQUEST', `policy.${key} must be a positive safe integer, got ${String(config[key])}`);
    }
  }
  if (config.default_lease_ttl_ms > config.max_lease_ttl_ms) {
    throw new EmbodimentError('INVALID_REQUEST', 'policy.default_lease_ttl_ms may not exceed policy.max_lease_ttl_ms');
  }
  // The action-key requirement for an exclusive lease is a safety bound, not an opt-in literal.
  if (config.require_action_key_for_exclusive !== true) {
    throw new EmbodimentError('INVALID_REQUEST', 'an exclusive lease must require an action key, so policy.require_action_key_for_exclusive must be true');
  }
  const events = [];
  const leases = new Map();
  const leasesByScope = new Map();
  const consumedActionKeys = new Map();
  const deviceState = new Map();
  const journal = [];
  let seq = 0;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new EmbodimentError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const deviceOf = device_ref => {
    if (!deviceState.has(device_ref)) deviceState.set(device_ref, { device_ref, connected: true, disconnected_at: null });
    return deviceState.get(device_ref);
  };

  const emit = ({ kind, direction, assistant_ref, device_ref, audience, privacy, at, task_ref = null, task_version = null, command_ref = null, action_key = null, lease_ref = null, correlation_ref, caused_by = null, payload_ref = null }) => {
    seq += 1;
    const event = freeze({
      contract_version: EMBODIMENT_BUS_CONTRACT_VERSION,
      bus_seq: seq,
      event_id: `event:${seq}`,
      canonical_state_source: CANONICAL_STATE_SOURCE,
      assistant_ref,
      kind,
      direction,
      source_device_ref: device_ref,
      audience,
      privacy,
      task_ref,
      task_version,
      command_ref,
      action_key,
      lease_ref,
      correlation_ref,
      caused_by,
      payload_ref,
      transport_envelope_is_canonical: false,
      assistant_event_is_transport_envelope: false,
      at,
    });
    events.push(event);
    return event;
  };

  const stateOf = (lease, at) => {
    if (lease.state === 'REVOKED' || lease.state === 'SUPERSEDED' || lease.state === 'SUSPENDED') return lease.state;
    if (Date.parse(lease.expires_at) <= Date.parse(at)) return 'EXPIRED';
    return lease.state;
  };

  const holdsExclusive = (action_scope, at, except_lease_ref = null) => [...leases.values()].find(lease =>
    lease.action_scope === action_scope
    && lease.exclusive === true
    && lease.lease_ref !== except_lease_ref
    && stateOf(lease, at) === 'ACTIVE');

  const requireLease = lease_ref => {
    const lease = leases.get(lease_ref);
    if (!lease) throw new EmbodimentError('UNKNOWN_LEASE', `no lease ${String(lease_ref)}`);
    return lease;
  };

  const assertUsable = (lease, at, holder_ref = null) => {
    const state = stateOf(lease, at);
    if (state === 'EXPIRED') throw new EmbodimentError('LEASE_EXPIRED', `lease ${lease.lease_ref} expired at ${lease.expires_at}`, { lease_ref: lease.lease_ref, lease_state: state });
    if (state === 'REVOKED') throw new EmbodimentError('LEASE_REVOKED', `lease ${lease.lease_ref} was revoked`, { lease_ref: lease.lease_ref, lease_state: state });
    if (state === 'SUPERSEDED') throw new EmbodimentError('LEASE_SUPERSEDED', `lease ${lease.lease_ref} was reassigned`, { lease_ref: lease.lease_ref, lease_state: state });
    if (state === 'SUSPENDED') throw new EmbodimentError('REVALIDATION_REQUIRED', `lease ${lease.lease_ref} is suspended; revalidate against authoritative state before resuming`, { lease_ref: lease.lease_ref, lease_state: state });
    if (holder_ref !== null && lease.holder_ref !== holder_ref) throw new EmbodimentError('NOT_LEASE_HOLDER', `${holder_ref} does not hold ${lease.lease_ref}`, { lease_ref: lease.lease_ref, holder_ref: lease.holder_ref });
    return state;
  };

  const leaseProjection = (lease, at) => freeze({
    contract_version: EMBODIMENT_BUS_CONTRACT_VERSION,
    lease_ref: lease.lease_ref,
    action_scope: lease.action_scope,
    assistant_ref: lease.assistant_ref,
    task_ref: lease.task_ref,
    task_version: lease.task_version,
    holder_ref: lease.holder_ref,
    device_ref: lease.device_ref,
    exclusive: lease.exclusive,
    lease_version: lease.lease_version,
    state: stateOf(lease, at),
    acquired_at: lease.acquired_at,
    expires_at: lease.expires_at,
    revoked_reason: lease.revoked_reason,
    superseded_by: lease.superseded_by,
    authority_is_local: false,
  });

  const api = {
    policy: () => freeze(clone(config)),

    /** Publish a canonical Assistant event. Replays are refused or absorbed; stale versions never apply. */
    publish(input) {
      const errors = [];
      checkShape(input, 'event', EVENT_SPEC, errors);
      if (errors.length) throw new EmbodimentError('INVALID_EVENT', errors.join('; '));
      const at = input.at;
      const device = deviceOf(input.source_device_ref);
      if (device.connected !== true) {
        throw new EmbodimentError('REVALIDATION_REQUIRED', `device ${input.source_device_ref} is disconnected; revalidate before publishing`, { device_ref: input.source_device_ref });
      }
      // Replay/idempotency: the same command with the same action key is absorbed, not applied twice.
      if (isText(input.command_ref)) {
        const key = `${input.source_device_ref}:${input.command_ref}`;
        const seen = consumedActionKeys.get(key) ?? null;
        if (seen !== null) {
          if (seen.action_key === (input.action_key ?? null)) {
            const event = emit({ ...input, direction: input.direction, correlation_ref: input.correlation_ref, device_ref: input.source_device_ref, at });
            note('EVENT_ABSORBED_DUPLICATE', at, { command_ref: input.command_ref, device_ref: input.source_device_ref });
            return freeze({ ...clone(event), duplicate: true, applied: false, idempotent: true, external_side_effect: false });
          }
          throw new EmbodimentError('DUPLICATE_ACTION_KEY', `command ${input.command_ref} was already applied with a different action key`, { command_ref: input.command_ref });
        }
        if (isText(input.task_ref) && Number.isSafeInteger(input.task_version)) {
          const authoritative = consumedActionKeys.get(`${input.task_ref}:version`) ?? null;
          if (authoritative !== null && input.task_version < authoritative) {
            note('EVENT_STALE_REJECTED', at, { task_ref: input.task_ref, task_version: input.task_version, authoritative });
            throw new EmbodimentError('STALE_EVENT', `event carries task version ${input.task_version} but authoritative state is ${authoritative}`, { task_ref: input.task_ref, task_version: input.task_version, authoritative_task_version: authoritative });
          }
        }
        consumedActionKeys.set(key, { action_key: input.action_key ?? null, at });
      }
      const event = emit({ ...input, device_ref: input.source_device_ref, at });
      note('EVENT_PUBLISHED', at, { kind: input.kind, bus_seq: event.bus_seq });
      return freeze({ ...clone(event), duplicate: false, applied: true, idempotent: false, external_side_effect: false });
    },

    /** Authoritative task versions are told to the bus by the task graph, never inferred locally. */
    noteAuthoritativeTaskVersion({ task_ref, task_version, at: when } = {}) {
      if (!isText(task_ref) || !Number.isSafeInteger(task_version)) throw new EmbodimentError('INVALID_REQUEST', 'task_ref and task_version are required');
      const current = consumedActionKeys.get(`${task_ref}:version`) ?? null;
      if (current !== null && task_version < current) {
        throw new EmbodimentError('STALE_EVENT', `authoritative version ${task_version} is older than the known ${current}`, { task_ref, authoritative_task_version: current });
      }
      consumedActionKeys.set(`${task_ref}:version`, task_version);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      return freeze({ task_ref, task_version, at });
    },

    /** At most one valid exclusive lease exists per action scope. */
    acquireLease({ assistant_ref, device_ref, holder_ref, action_scope, task_ref = null, task_version = null, exclusive = true, action_key = null, ttl_ms, at: when } = {}) {
      if (!isText(assistant_ref) || !isText(device_ref) || !isText(holder_ref) || !isText(action_scope)) {
        throw new EmbodimentError('INVALID_LEASE', 'assistant_ref, device_ref, holder_ref and action_scope are required');
      }
      const ttl = ttl_ms ?? config.default_lease_ttl_ms;
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > config.max_lease_ttl_ms) throw new EmbodimentError('INVALID_LEASE', `ttl_ms must be a positive integer up to ${config.max_lease_ttl_ms}`);
      if (exclusive === true && config.require_action_key_for_exclusive === true && !isText(action_key)) {
        throw new EmbodimentError('ACTION_KEY_REQUIRED', 'an exclusive lease needs an action key so a retry cannot duplicate the side effect');
      }
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const device = deviceOf(device_ref);
      if (device.connected !== true) throw new EmbodimentError('REVALIDATION_REQUIRED', `device ${device_ref} is disconnected; revalidate before taking exclusive authority`);
      if (isText(task_ref) && Number.isSafeInteger(task_version)) {
        const authoritative = consumedActionKeys.get(`${task_ref}:version`) ?? null;
        if (authoritative !== null && task_version < authoritative) {
          throw new EmbodimentError('STALE_EVENT', `lease would be taken against task version ${task_version}, authoritative is ${authoritative}`, { task_ref, authoritative_task_version: authoritative });
        }
      }
      const held = holdsExclusive(action_scope, at);
      if (held) {
        note('LEASE_CONFLICT_REFUSED', at, { action_scope, holder_ref: held.holder_ref });
        throw new EmbodimentError('EXCLUSIVE_LEASE_HELD', `action scope ${action_scope} is already held by ${held.holder_ref} on ${held.device_ref}`, {
          action_scope,
          held_by_holder_ref: held.holder_ref,
          held_by_device_ref: held.device_ref,
          current_lease_ref: held.lease_ref,
          valid_exclusive_leases: 1,
        });
      }
      const previous = leasesByScope.get(action_scope) ?? null;
      const lease_version = previous === null ? 1 : previous.lease_version + 1;
      const lease = {
        lease_ref: `lease:${action_scope}#${lease_version}`,
        action_scope,
        assistant_ref,
        device_ref,
        holder_ref,
        task_ref,
        task_version,
        exclusive: exclusive === true,
        action_key,
        lease_version,
        state: 'ACTIVE',
        acquired_at: at,
        expires_at: new Date(Date.parse(at) + ttl).toISOString(),
        revoked_reason: null,
        superseded_by: null,
      };
      leases.set(lease.lease_ref, lease);
      leasesByScope.set(action_scope, lease);
      emit({ kind: 'LEASE', direction: 'OUTBOUND', assistant_ref, device_ref, audience: 'ASSISTANT', privacy: 'SHARED', at, task_ref, task_version, action_key, lease_ref: lease.lease_ref, correlation_ref: lease.lease_ref });
      note('LEASE_ACQUIRED', at, { lease_ref: lease.lease_ref, action_scope });
      return freeze({ ...leaseProjection(lease, at), valid_exclusive_leases: 1, acquired: true });
    },

    renewLease({ lease_ref, holder_ref, ttl_ms, at: when } = {}) {
      const lease = requireLease(lease_ref);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      assertUsable(lease, at, holder_ref);
      if (Date.parse(at) < Date.parse(lease.acquired_at)) {
        // A renewal that starts before the lease was acquired would silently shorten authority.
        throw new EmbodimentError('INVALID_LEASE', `renewal instant ${at} precedes the lease acquisition ${lease.acquired_at}`, { lease_ref: lease.lease_ref });
      }
      const ttl = ttl_ms ?? config.default_lease_ttl_ms;
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > config.max_lease_ttl_ms) throw new EmbodimentError('INVALID_LEASE', `ttl_ms must be a positive integer up to ${config.max_lease_ttl_ms}`);
      lease.lease_version += 1;
      lease.expires_at = new Date(Date.parse(at) + ttl).toISOString();
      lease.lease_ref = `lease:${lease.action_scope}#${lease.lease_version}`;
      leases.set(lease.lease_ref, lease);
      leasesByScope.set(lease.action_scope, lease);
      note('LEASE_RENEWED', at, { lease_ref: lease.lease_ref, lease_version: lease.lease_version });
      return leaseProjection(lease, at);
    },

    revokeLease({ lease_ref, reason = 'REVOKED', by_ref, at: when } = {}) {
      const lease = requireLease(lease_ref);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const state = stateOf(lease, at);
      if (state === 'REVOKED') return freeze({ ...leaseProjection(lease, at), revoked: true, already_revoked: true });
      lease.state = 'REVOKED';
      lease.revoked_reason = reason;
      lease.revoked_at = at;
      lease.revoked_by_ref = by_ref ?? null;
      emit({ kind: 'LEASE', direction: 'OUTBOUND', assistant_ref: lease.assistant_ref, device_ref: lease.device_ref, audience: 'ASSISTANT', privacy: 'SHARED', at, task_ref: lease.task_ref, task_version: lease.task_version, lease_ref: lease.lease_ref, correlation_ref: lease.lease_ref, caused_by: lease.revoked_by_ref });
      note('LEASE_REVOKED', at, { lease_ref: lease.lease_ref, reason });
      return freeze({ ...leaseProjection(lease, at), revoked: true, already_revoked: false, observable: true });
    },

    /** Reassignment is supersession: the old lease stops being authority and the version advances. */
    reassignLease({ lease_ref, to_device_ref, to_holder_ref, expect_lease_version, reason = 'REASSIGNED', at: when } = {}) {
      const lease = requireLease(lease_ref);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      if (!isText(to_device_ref) || !isText(to_holder_ref)) throw new EmbodimentError('INVALID_LEASE', 'to_device_ref and to_holder_ref are required');
      if (expect_lease_version !== undefined && expect_lease_version !== lease.lease_version) {
        throw new EmbodimentError('LEASE_VERSION_CONFLICT', `lease is at version ${lease.lease_version}, reassignment assumed ${expect_lease_version}`, { lease_ref, current_lease_version: lease.lease_version });
      }
      const state = stateOf(lease, at);
      if (state === 'REVOKED' || state === 'EXPIRED') throw new EmbodimentError(state === 'REVOKED' ? 'LEASE_REVOKED' : 'LEASE_EXPIRED', `lease ${lease.lease_ref} is ${state}`, { lease_ref, lease_state: state });
      // Release the scope BEFORE acquiring the successor, otherwise the successor is refused as a
      // conflicting holder of the very lease being reassigned.
      const previousState = lease.state;
      lease.state = 'SUPERSEDED';
      let next;
      try {
        next = api.acquireLease({
          assistant_ref: lease.assistant_ref,
          device_ref: to_device_ref,
          holder_ref: to_holder_ref,
          action_scope: lease.action_scope,
          task_ref: lease.task_ref,
          task_version: lease.task_version,
          exclusive: lease.exclusive,
          action_key: lease.action_key,
          ttl_ms: Math.max(1, Date.parse(lease.expires_at) - Date.parse(at)),
          at,
        });
      } catch (error) {
        lease.state = previousState;
        throw error;
      }
      lease.superseded_by = next.lease_ref;
      note('LEASE_REASSIGNED', at, { from: lease.lease_ref, to: next.lease_ref, reason });
      return freeze({ ...next, superseded_lease_ref: lease.lease_ref, reassigned: true, reason });
    },

    leaseState({ lease_ref, at: when } = {}) {
      const lease = requireLease(lease_ref);
      return leaseProjection(lease, when === undefined || when === null ? now() : callerInstant(when));
    },

    /**
     * The guarded side-effect path. Only the current holder, with a live lease and an unused action key,
     * may produce an externally visible effect — and a retry never produces a second one.
     */
    commitSideEffect({ lease_ref, holder_ref, action_key, at: when } = {}) {
      const lease = requireLease(lease_ref);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const consumedKey = consumedActionKeys.get(`effect:${lease.lease_ref}:${action_key}`) ?? null;
      if (consumedKey !== null) {
        note('SIDE_EFFECT_DUPLICATE_SUPPRESSED', at, { lease_ref, action_key });
        return freeze({
          executed: false,
          duplicate: true,
          idempotent: true,
          action_key,
          lease_ref,
          external_side_effect: false,
          duplicate_external_side_effects: 0,
          at,
        });
      }
      if (!isText(action_key)) throw new EmbodimentError('ACTION_KEY_REQUIRED', 'a side effect needs an idempotency/action key');
      assertUsable(lease, at, holder_ref);
      consumedActionKeys.set(`effect:${lease.lease_ref}:${action_key}`, { at, holder_ref });
      note('SIDE_EFFECT_COMMITTED', at, { lease_ref, action_key, holder_ref });
      return freeze({
        executed: true,
        duplicate: false,
        idempotent: true,
        action_key,
        lease_ref,
        holder_ref,
        device_ref: lease.device_ref,
        task_ref: lease.task_ref,
        external_side_effect: true,
        duplicate_external_side_effects: 0,
        authority_is_local: false,
        at,
      });
    },

    /** Disconnect suspends authority; nothing may resume on a stale local lease. */
    onDisconnect({ device_ref, reason = 'DISCONNECTED', at: when } = {}) {
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const device = deviceOf(device_ref);
      device.connected = false;
      device.disconnected_at = at;
      const suspended = [];
      for (const lease of leases.values()) {
        if (lease.device_ref !== device_ref) continue;
        if (stateOf(lease, at) !== 'ACTIVE') continue;
        lease.state = 'SUSPENDED';
        lease.suspended_at = at;
        suspended.push(lease.lease_ref);
        emit({ kind: 'LIFECYCLE', direction: 'OUTBOUND', assistant_ref: lease.assistant_ref, device_ref, audience: 'ASSISTANT', privacy: 'SHARED', at, task_ref: lease.task_ref, task_version: lease.task_version, lease_ref: lease.lease_ref, correlation_ref: lease.lease_ref, caused_by: reason });
      }
      note('DEVICE_DISCONNECTED', at, { device_ref, suspended: suspended.length });
      return freeze({
        device_ref,
        connected: false,
        suspended_lease_refs: suspended,
        resumed_work: false,
        side_effects_resumed: false,
        reason,
        at,
      });
    },

    /**
     * Reconnect reconciliation: authoritative state first, then lease invalidation/revalidation, then local
     * intents. Work resumes only for intents whose lease and task version both still match authority.
     */
    reconcile({ device_ref, authoritative, local_intents = [], at: when } = {}) {
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const device = deviceOf(device_ref);
      if (!isPlainObject(authoritative)) throw new EmbodimentError('INVALID_REQUEST', 'authoritative state is required for reconciliation');
      const authoritativeVersions = isPlainObject(authoritative.task_versions) ? authoritative.task_versions : {};
      const authoritativeLeases = Array.isArray(authoritative.lease_refs) ? authoritative.lease_refs : null;
      const invalidated = [];
      const revalidated = [];
      for (const lease of leases.values()) {
        if (lease.device_ref !== device_ref) continue;
        const state = stateOf(lease, at);
        if (state === 'ACTIVE' || state === 'SUSPENDED') {
          const taskVersion = lease.task_ref === null ? null : authoritativeVersions[lease.task_ref] ?? null;
          const leaseStillAuthoritative = authoritativeLeases === null || authoritativeLeases.includes(lease.lease_ref);
          const versionMatches = taskVersion === null || lease.task_version === null || taskVersion === lease.task_version;
          if (!leaseStillAuthoritative || !versionMatches) {
            // Authority that authoritative state does not list — or lists at another version — is revoked,
            // whether it was ACTIVE or suspended by the disconnect. It must never be resumed.
            lease.state = 'REVOKED';
            lease.revoked_reason = !leaseStillAuthoritative ? 'REVOKE_ON_RECONCILE' : 'REVOKE_ON_VERSION_MISMATCH';
            invalidated.push(lease.lease_ref);
          } else if (state === 'SUSPENDED' && Date.parse(lease.expires_at) > Date.parse(at)) {
            lease.state = 'ACTIVE';
            revalidated.push(lease.lease_ref);
          }
        }
      }
      device.connected = true;
      device.disconnected_at = null;
      const resumedIntents = [];
      const droppedIntents = [];
      const blockedIntents = [];
      for (const intent of Array.isArray(local_intents) ? local_intents : []) {
        const intent_ref = isText(intent?.intent_ref) ? intent.intent_ref : null;
        if (intent_ref === null) { blockedIntents.push({ intent_ref: null, reason: 'MALFORMED_INTENT' }); continue; }
        const taskVersion = isText(intent.task_ref) ? authoritativeVersions[intent.task_ref] ?? null : null;
        const versionStale = isText(intent.task_ref) && Number.isSafeInteger(intent.task_version) && taskVersion !== null && intent.task_version < taskVersion;
        const lease = isText(intent.lease_ref) ? leases.get(intent.lease_ref) ?? null : null;
        const leaseUsable = lease !== null && revalidated.includes(lease.lease_ref) && lease.holder_ref === intent.holder_ref;
        if (versionStale) { droppedIntents.push({ intent_ref, reason: 'STALE_LOCAL_TASK_VERSION', local_task_version: intent.task_version, authoritative_task_version: taskVersion }); continue; }
        if (intent.requires_side_effect === true && !leaseUsable) { droppedIntents.push({ intent_ref, reason: 'LEASE_NOT_REVALIDATED' }); continue; }
        resumedIntents.push({ intent_ref, reason: leaseUsable ? 'LEASE_REVALIDATED' : 'READ_ONLY_INTENT' });
      }
      emit({ kind: 'RECONCILE', direction: 'OUTBOUND', assistant_ref: isText(authoritative.assistant_ref) ? authoritative.assistant_ref : 'assistant:unknown', device_ref, audience: 'ASSISTANT', privacy: 'SHARED', at, correlation_ref: `reconcile:${device_ref}`, caused_by: null });
      note('DEVICE_RECONCILED', at, { device_ref, revalidated: revalidated.length, dropped: droppedIntents.length });
      return freeze({
        device_ref,
        revalidated_lease_refs: revalidated,
        invalidated_lease_refs: invalidated,
        resumed_intents: freeze(resumedIntents),
        dropped_intents: freeze(droppedIntents),
        blocked_intents: freeze(blockedIntents),
        ready_to_resume: droppedIntents.length === 0,
        stale_local_work_resumed: false,
        authoritative_state_consulted: true,
        authoritative_task_versions: freeze(clone(authoritativeVersions)),
        at,
      });
    },

    /**
     * Route output to the embodiments that may see it. Private responses are never broadcast, and an
     * unavailable device is reported rather than silently skipped.
     */
    routeOutput({ assistant_ref, audience, privacy, candidates = [], foreground_device_ref = null, payload_ref = null, at: when } = {}) {
      if (!isText(assistant_ref) || !AUDIENCES.includes(audience) || !PRIVACY_SCOPES.includes(privacy)) {
        throw new EmbodimentError('INVALID_REQUEST', 'assistant_ref, a canonical audience and a canonical privacy scope are required');
      }
      if (!Array.isArray(candidates)) throw new EmbodimentError('INVALID_REQUEST', 'candidates must be an array of {device_ref, available, in_audience}');
      if (payload_ref !== null && payload_ref !== undefined && !isText(payload_ref)) throw new EmbodimentError('INVALID_REQUEST', 'payload_ref must be a reference when present');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const deliveries = [];
      const withheld = [];
      const seen = new Set();
      for (const candidate of candidates) {
        const device_ref = isText(candidate?.device_ref) ? candidate.device_ref : null;
        if (device_ref === null) { withheld.push({ device_ref: null, reason: 'UNKNOWN_DEVICE' }); continue; }
        if (seen.has(device_ref)) { withheld.push({ device_ref, reason: 'DUPLICATE_SUPPRESSED' }); continue; }
        seen.add(device_ref);
        const isForeground = foreground_device_ref === device_ref;
        const inAudience = candidate.in_audience === true;
        if (candidate.available !== true) { withheld.push({ device_ref, reason: 'DEVICE_UNAVAILABLE' }); continue; }
        if (privacy === 'PRIVATE') {
          const permitted = inAudience || (foreground_device_ref === null && audience === 'DEVICE' && inAudience);
          if (!permitted) {
            withheld.push({ device_ref, reason: isForeground ? 'PRIVACY_WITHHELD' : 'NOT_IN_AUDIENCE' });
            note('OUTPUT_WITHHELD_PRIVATE', at, { device_ref });
            continue;
          }
          deliveries.push({ device_ref, reason: isForeground && inAudience ? 'FOREGROUND' : 'AUDIENCE_MATCH', privacy: 'PRIVATE' });
          continue;
        }
        if (audience !== 'PUBLIC' && !inAudience) { withheld.push({ device_ref, reason: 'NOT_IN_AUDIENCE' }); continue; }
        deliveries.push({ device_ref, reason: isForeground ? 'FOREGROUND' : inAudience ? 'AUDIENCE_MATCH' : 'TARGETED', privacy: 'SHARED' });
      }
      const completed = freeze({
        assistant_ref,
        audience,
        privacy,
        deliveries: freeze(deliveries),
        withheld: freeze(withheld),
        delivery_count: deliveries.length,
        withheld_count: withheld.length,
        broadcast: false,
        private_response_broadcast: false,
        duplicate_side_effects: 0,
        canonical_state_source: CANONICAL_STATE_SOURCE,
        at,
      });
      note('OUTPUT_ROUTED', at, { deliveries: deliveries.length, withheld: withheld.length, privacy });
      // The invariant is enforced by construction above and published as data: a private response reached
      // only devices that are in its audience, and nothing was broadcast.
      return completed;
    },

    events: () => clone(events),
    leases: ({ at: when } = {}) => {
      const at = when === undefined || when === null ? now() : callerInstant(when);
      return clone([...leases.values()].map(lease => leaseProjection(lease, at)));
    },
    currentLeaseFor: ({ action_scope, at: when } = {}) => {
      const lease = leasesByScope.get(action_scope) ?? null;
      return lease === null ? null : leaseProjection(lease, when === undefined || when === null ? now() : callerInstant(when));
    },
    validExclusiveLeaseCount: ({ action_scope, at: when } = {}) => {
      const at = when === undefined || when === null ? now() : callerInstant(when);
      return [...leases.values()].filter(lease => lease.action_scope === action_scope && lease.exclusive === true && stateOf(lease, at) === 'ACTIVE').length;
    },
    deviceState: device_ref => clone(deviceState.get(device_ref) ?? null),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
