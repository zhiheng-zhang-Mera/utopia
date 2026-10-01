// Digital-Me context gateway (BA-005).
//
// Assistants read the user through *authorized scoped projections*, never through direct database
// access, and knowing something never authorizes disclosing it to the current audience. Three rules
// shape this module:
//   1. the canonical user model is read-only here â€?no assistant persona/relationship data may ever be
//      written into it;
//   2. a projection contains the intersection of what the caller asked for, what policy authorizes and
//      what the audience may see, or nothing at all (a denial must not leak partially);
//   3. a fact learned in a private scope stays usable internally but is withheld from another audience
//      until disclosure is explicitly authorized for it.
// Pure module: no storage, clock, network or ambient state.
export const DIGITAL_ME_GATEWAY_VERSION = 1;

export const MEMORY_SCOPES = Object.freeze(['USER_GLOBAL_CANONICAL', 'ASSISTANT_PRIVATE', 'PROJECT_TASK', 'AUDIENCE_CHANNEL', 'DEVICE_EPHEMERAL']);
export const AUDIENCES = Object.freeze(['OWNER_PRIVATE', 'SHARED_DEVICE', 'PUBLIC_CHANNEL']);
/** Which audiences a record held at one audience may be disclosed to. */
export const AUDIENCE_VISIBILITY = Object.freeze({
  OWNER_PRIVATE: Object.freeze(['OWNER_PRIVATE']),
  SHARED_DEVICE: Object.freeze(['OWNER_PRIVATE', 'SHARED_DEVICE']),
  PUBLIC_CHANNEL: Object.freeze(['PUBLIC_CHANNEL']),
});
export const QUERY_PURPOSES = Object.freeze(['ANSWER_USER', 'PLAN_TASK', 'RESOLVE_PREFERENCE', 'SAFETY_CHECK']);
export const DIGITAL_ME_CODES = Object.freeze([
  'INVALID_QUERY', 'UNKNOWN_ASSISTANT', 'UNKNOWN_SCOPE', 'UNKNOWN_AUDIENCE', 'UNKNOWN_PURPOSE',
  'SCOPE_DENIED', 'PURPOSE_DENIED', 'AUDIENCE_DENIED', 'DIGITAL_ME_WRITE_FORBIDDEN',
  'PORT_REQUIRED', 'INVALID_RECORD', 'DISCLOSURE_NOT_AUTHORIZED', 'LEAST_DATA_VIOLATION',
]);

export class DigitalMeError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'DigitalMeError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 403;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * A canonical record must carry its fields as own properties on a bare object. Validating *own* keys
 * while accepting an inherited payload is not a check: a record refusing `persona` as its own field
 * accepted the same poison supplied through a prototype, and a class instance passed as a record.
 */
const isBareObject = value => isPlainObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isText = value => typeof value === 'string' && value.trim().length > 0;
/** The record is canonical state, so every level of it is immutable, not only the top. */
const deepFreeze = value => { if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const key of Object.keys(value)) deepFreeze(value[key]); return value; };
const clone = value => (value === undefined ? undefined : structuredClone(value));
const isIsoInstantShape = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
/** Shape is not enough: an impossible instant parses to NaN, and every NaN comparison is false. */
export const isIsoInstant = value => {
  if (!isIsoInstantShape(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
};

/** Tolerance for a peer clock running ahead of ours; only a bigger jump is treated as future-dated. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** A record cannot claim to stay current indefinitely. */
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_RECORD_DEPTH = 32;

/** Bounds the scans that walk *data* rather than the fixed schema, and cannot itself overflow. */
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

/** Fields that would make canonical user identity carry assistant persona or authority. */
export const FORBIDDEN_CANONICAL_FIELDS = Object.freeze([
  'assistant_ref', 'assistant_profile', 'persona', 'relationship_mode', 'companion_name',
  'grants', 'permissions', 'authority', 'lease', 'action_key', 'assistant_memory',
]);

/**
 * `Object.entries` walks enumerable own keys only, so a non-enumerable own `persona` put assistant
 * state into canonical user identity unseen; `Reflect.ownKeys` sees every own key. The walk covers
 * attacker-controlled data, so it is cycle-safe.
 */
export function findForbiddenCanonicalFields(value, path = 'record', found = [], seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return found;
    seen.add(value);
    value.forEach((item, index) => findForbiddenCanonicalFields(item, `${path}[${index}]`, found, seen));
    return found;
  }
  if (!isPlainObject(value)) return found;
  if (seen.has(value)) return found;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const childPath = `${path}.${String(key)}`;
    if (typeof key === 'string' && FORBIDDEN_CANONICAL_FIELDS.includes(key)) found.push(childPath);
    findForbiddenCanonicalFields(value[key], childPath, found, seen);
  }
  return found;
}

/**
 * The canonical user model, read-only. `createDigitalMePortDouble` is the deterministic stand-in the
 * gateway reads through; the gateway itself never holds a copy.
 */
export const DIGITAL_ME_PORT = Object.freeze({
  interface: 'DigitalMeReadPort',
  version: DIGITAL_ME_GATEWAY_VERSION,
  methods: Object.freeze(['listRecords', 'resolveValue']),
  writable: false,
  assistant_direct_database_access: false,
});

export function createDigitalMePortDouble({ records = [], values = {} } = {}) {
  // A duplicate record_id used to collapse silently in the Map, so two canonical records became one
  // with no error and nothing marking the loss.
  const table = new Map();
  for (const record of records) {
    const id = record?.record_id;
    if (table.has(id)) throw new DigitalMeError('INVALID_RECORD', `duplicate record_id ${String(id)}`);
    table.set(id, structuredClone(record));
  }
  // Values live in the port, not on the canonical record: a projection carries references, and the port is
  // the only thing that can resolve them.
  const valueTable = new Map(Object.entries(values));
  const reads = [];
  return Object.freeze({
    listRecords({ scopes = null } = {}) {
      reads.push({ op: 'listRecords', scopes });
      return [...table.values()].filter(record => scopes === null || scopes.includes(record.scope)).map(record => structuredClone(record));
    },
    resolveValue(valueRef) {
      reads.push({ op: 'resolveValue', valueRef });
      if (!valueTable.has(valueRef)) throw new DigitalMeError('INVALID_RECORD', 'unknown value reference ' + String(valueRef));
      // Copied on the way out: handing the caller the port's own object let a projection rewrite
      // canonical user data, and every later projection carried the edit.
      return { value_ref: valueRef, value: structuredClone(valueTable.get(valueRef)) };
    },
    /** Only the harness may change canonical records, which is how the isolation test is possible. */
    __mutate(recordId, patch) { const record = table.get(recordId); if (record) Object.assign(record, patch); },
    __snapshot() { return [...table.values()].map(record => structuredClone(record)); },
    __reads: reads,
  });
}

export const RECORD_SPEC = Object.freeze({
  record_id: { required: true, type: 'text' },
  scope: { required: true, type: 'enum', values: MEMORY_SCOPES },
  audience: { required: true, type: 'enum', values: AUDIENCES },
  fact_ref: { required: true, type: 'text' },
  value_ref: { required: true, type: 'text' },
  sensitivity: { required: true, type: 'enum', values: ['NORMAL', 'SENSITIVE'] },
  observed_at: { required: true, type: 'instant' },
  ttl_ms: { required: true, type: 'int', min: 0, max: MAX_TTL_MS },
  disclosure_authorized: { required: true, type: 'bool' },
  /**
   * Who owns an assistant-private fact. Without it, `ASSISTANT_PRIVATE` isolation rested entirely on
   * which scopes an assistant happened to be granted, so two assistants granted the same scope saw
   * each other's private facts and values â€?the opposite of the published guarantee. Optional only
   * because the Development fixtures predate it; when present it is enforced.
   */
  owner_assistant_ref: { required: false, type: 'text', nullable: true },
});

export function validateRecord(record) {
  const errors = [];
  if (!isBareObject(record)) return { ok: false, errors: ['a record must be a plain own-property object'] };
  // `key in RECORD_SPEC` walks the prototype chain and the spec is an object literal, so any own field
  // named after an Object.prototype member was accepted as part of the canonical record. Only own keys
  // of the spec count, and Reflect.ownKeys closes the non-enumerable case.
  for (const key of Reflect.ownKeys(record)) if (!Object.hasOwn(RECORD_SPEC, key)) errors.push(`record.${String(key)} is not part of the canonical record`);
  for (const [key, rule] of Object.entries(RECORD_SPEC)) {
    if (!Object.hasOwn(record, key)) { if (rule.required) errors.push(`record.${key} is required`); continue; }
    const field = record[key];
    if (rule.type === 'text' && !isText(field)) errors.push(`record.${key} must be nonempty text`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`record.${key} must be one of ${rule.values.join(', ')}`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`record.${key} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int') {
      if (!Number.isSafeInteger(field) || field < (rule.min ?? 0)) errors.push(`record.${key} must be a non-negative integer`);
      // A one-sided bound is not a bound: an enormous ttl kept a record current indefinitely.
      else if (rule.max !== undefined && field > rule.max) errors.push(`record.${key} must be an integer <= ${rule.max}`);
    }
    if (rule.type === 'bool' && typeof field !== 'boolean') errors.push(`record.${key} must be a boolean`);
  }
  if (recordDepthExceeded(record)) errors.push(`record must not be nested deeper than ${MAX_RECORD_DEPTH} levels`);
  for (const found of findForbiddenCanonicalFields(record)) errors.push(`${found} would put assistant or authority state into canonical user identity`);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/** Policy: which assistant may read which scopes, for which purposes, into which audiences. */
export const POLICY_SPEC_KEYS = Object.freeze(['scopes', 'purposes', 'audiences', 'allow_values']);

export function createDigitalMeGateway({ port, policy, clock = () => null } = {}) {
  if (!port || typeof port.listRecords !== 'function') throw new DigitalMeError('PORT_REQUIRED', 'the canonical Digital-Me read port is required');
  if (!isPlainObject(policy) || !isPlainObject(policy.assistants)) throw new DigitalMeError('UNKNOWN_ASSISTANT', 'policy.assistants is required');
  // The policy is snapshotted at construction. Holding the caller's live object meant a grant pushed
  // onto it later silently widened authorization for a gateway that had already been built.
  const policySnapshot = structuredClone({ policy_ref: policy.policy_ref ?? null, assistants: policy.assistants });
  const assistants = Object.assign(Object.create(null), policySnapshot.assistants);
  const now = () => {
    const value = clock();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (isIsoInstant(value)) return Date.parse(value);
    return null;
  };

  const refusal = (code, detail, provenance) => Object.freeze({ granted: false, code, detail, projection: null, provenance: Object.freeze(provenance) });

  const gateway = {
    /**
     * Read an authorized projection. A denial is total: no partial data crosses the boundary, and the
     * refusal names which axis denied it.
     */
    query({ assistantRef, purpose, audience, taskRef = null, deviceRef = null, scopes = [], includeValues = false } = {}) {
      const askedAt = clock();
      const provenance = { assistant_ref: assistantRef ?? null, purpose: purpose ?? null, audience: audience ?? null, scopes: [...(Array.isArray(scopes) ? scopes : [])], policy_ref: policySnapshot.policy_ref, decided_at: askedAt ?? null };
      if (!isText(assistantRef)) throw new DigitalMeError('INVALID_QUERY', 'assistantRef is required');
      // Own-key only. `policy.assistants[assistantRef]` consulted the prototype chain, so an assistant
      // named after an Object.prototype member crashed untyped â€?and a policy object whose prototype
      // carried a grant conferred that grant on an assistant that never had it.
      const grants = assistants[assistantRef];
      if (!isPlainObject(grants)) return refusal('UNKNOWN_ASSISTANT', `${assistantRef} is not a known assistant`, provenance);
      if (!Array.isArray(grants.scopes) || !Array.isArray(grants.purposes) || !Array.isArray(grants.audiences)) {
        return refusal('UNKNOWN_ASSISTANT', `${assistantRef} has a malformed policy grant`, provenance);
      }
      if (!AUDIENCES.includes(audience)) return refusal('UNKNOWN_AUDIENCE', String(audience), provenance);
      if (!QUERY_PURPOSES.includes(purpose)) return refusal('UNKNOWN_PURPOSE', String(purpose), provenance);
      if (!Array.isArray(scopes) || scopes.length === 0) throw new DigitalMeError('INVALID_QUERY', 'scopes must name at least one scope');
      for (const scope of scopes) if (!MEMORY_SCOPES.includes(scope)) return refusal('UNKNOWN_SCOPE', String(scope), provenance);
      if (!grants.purposes.includes(purpose)) return refusal('PURPOSE_DENIED', `${assistantRef} may not read for ${purpose}`, provenance);
      if (!grants.audiences.includes(audience)) return refusal('AUDIENCE_DENIED', `${assistantRef} may not project into ${audience}`, provenance);
      for (const scope of scopes) if (!grants.scopes.includes(scope)) return refusal('SCOPE_DENIED', `${assistantRef} may not read ${scope}`, provenance);

      const usableScopes = scopes.filter(scope => scope !== 'DEVICE_EPHEMERAL');
      const records = port.listRecords({ scopes });
      // Every fetched record is validated *before* anything is assembled or resolved, so a malformed
      // record is a typed refusal with no partial assembly and no values read out of the port.
      for (const candidate of records) {
        const validated = validateRecord(candidate);
        if (!validated.ok) throw new DigitalMeError('INVALID_RECORD', validated.errors.slice(0, 3).join('; '));
      }
      const visibleAudiences = AUDIENCE_VISIBILITY[audience];
      const nowMs = now();
      const included = [];
      const withheld = [];
      const stale = [];
      for (const record of records) {
        // Device-ephemeral context is rebuilt per device and is never part of a durable projection.
        if (record.scope === 'DEVICE_EPHEMERAL') { withheld.push({ fact_ref: record.fact_ref, reason: 'DEVICE_EPHEMERAL_NOT_DURABLE' }); continue; }
        if (!usableScopes.includes(record.scope)) { withheld.push({ fact_ref: record.fact_ref, reason: 'SCOPE_NOT_REQUESTED' }); continue; }
        // Assistant-private memory belongs to the assistant that owns it, not to every assistant that
        // happens to hold the ASSISTANT_PRIVATE scope.
        if (isText(record.owner_assistant_ref) && record.owner_assistant_ref !== assistantRef) { withheld.push({ fact_ref: record.fact_ref, reason: 'NOT_THE_OWNER' }); continue; }
        const age = nowMs === null ? 0 : nowMs - Date.parse(record.observed_at);
        // Two-sided: a replayed or clock-skewed record dated in the future used to satisfy `age > ttl`
        // never, so it was served as current â€?in the one module whose job is to decide disclosure.
        // The ttl is clamped as well as validated, so an unbounded claim cannot make a record eternal.
        const claimedTtl = Number.isFinite(record.ttl_ms) && record.ttl_ms > 0 ? record.ttl_ms : 0;
        const ttl = Math.min(claimedTtl, MAX_TTL_MS);
        if (nowMs !== null && (age < -MAX_CLOCK_SKEW_MS || age > ttl)) { stale.push(record.fact_ref); continue; }
        if (!visibleAudiences.includes(record.audience)) { withheld.push({ fact_ref: record.fact_ref, reason: 'AUDIENCE_NOT_PERMITTED' }); continue; }
        // Knowing a fact in private does not authorize disclosing it elsewhere.
        if (record.audience !== audience && record.disclosure_authorized !== true) { withheld.push({ fact_ref: record.fact_ref, reason: 'DISCLOSURE_NOT_AUTHORIZED' }); continue; }
        // A SENSITIVE record is not ordinary data: the field was validated and copied but gated nothing,
        // so a record marked SENSITIVE was released exactly like a NORMAL one. Releasing it needs the
        // same explicit authorization the module already requires for release into another audience.
        if (record.sensitivity === 'SENSITIVE' && record.disclosure_authorized !== true) { withheld.push({ fact_ref: record.fact_ref, reason: 'SENSITIVITY_NOT_PERMITTED' }); continue; }
        included.push({
          fact_ref: record.fact_ref,
          scope: record.scope,
          audience: record.audience,
          sensitivity: record.sensitivity,
          // Least data by default: references travel, values only when the purpose needs them.
          value_ref: record.value_ref,
          // Strict boolean: 'false', 1, {} and [] are all truthy, and they released values.
          value: includeValues === true && grants.allow_values === true ? port.resolveValue(record.value_ref).value : null,
        });
      }
      return Object.freeze({
        granted: true,
        code: null,
        detail: null,
        projection: Object.freeze({
          contract_version: DIGITAL_ME_GATEWAY_VERSION,
          assistant_ref: assistantRef,
          purpose,
          audience,
          task_ref: taskRef,
          device_ref: deviceRef,
          scopes: Object.freeze([...scopes]),
          facts: Object.freeze(included),
          withheld: Object.freeze(withheld),
          stale: Object.freeze([...stale].sort()),
          fact_count: included.length,
          rebuilds_daily: false,
          provenance: Object.freeze(provenance),
        }),
        provenance: Object.freeze(provenance),
      });
    },

    /** The gateway is read-only by construction; this is the explicit refusal for any write attempt. */
    write() {
      throw new DigitalMeError('DIGITAL_ME_WRITE_FORBIDDEN', 'an assistant may not write canonical user identity; persona and relationship state live on the assistant');
    },

    /** Assistant-private state is never canonical user data, so it is kept outside the port. */
    recordAssistantPrivateState({ assistantRef, relationshipMode = null, facts = [] } = {}) {
      if (!isText(assistantRef)) throw new DigitalMeError('INVALID_QUERY', 'assistantRef is required');
      return Object.freeze({
        assistant_ref: assistantRef,
        relationship_mode: relationshipMode,
        private_facts: Object.freeze([...facts]),
        stored_in_digital_me: false,
        write_forbidden_code: 'DIGITAL_ME_WRITE_FORBIDDEN',
      });
    },

    policyRef() { return policySnapshot.policy_ref; },
  };

  return Object.freeze(gateway);
}

/**
 * Rebuild device-ephemeral context for one device. It is derived per device/session and never merged into
 * durable assistant memory, so a rebuild cannot corrupt it.
 */
export function rebuildDeviceEphemeralContext({ deviceRef, sessionRef = null, entries = [], at = null } = {}) {
  if (!isText(deviceRef)) throw new DigitalMeError('INVALID_QUERY', 'deviceRef is required');
  return Object.freeze({
    device_ref: deviceRef,
    session_ref: sessionRef,
    scope: 'DEVICE_EPHEMERAL',
    entries: Object.freeze(entries.map(entry => { if (!isPlainObject(entry)) throw new DigitalMeError('INVALID_QUERY', 'an ephemeral entry must be an object'); if (entry.scope !== undefined && entry.scope !== 'DEVICE_EPHEMERAL') throw new DigitalMeError('INVALID_QUERY', 'a device-ephemeral entry may not claim a durable scope'); if (entry.sensitivity === 'SENSITIVE') throw new DigitalMeError('INVALID_QUERY', 'a device-ephemeral entry may not carry a SENSITIVE canonical fact'); return deepFreeze(structuredClone(entry)); })),
    durable: false,
    merged_into_durable_memory: false,
    rebuilt_at: at,
  });
}
