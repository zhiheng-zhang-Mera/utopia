// Digital-Me context gateway (BA-005).
//
// Assistants read the user through *authorized scoped projections*, never through direct database
// access, and knowing something never authorizes disclosing it to the current audience. Three rules
// shape this module:
//   1. the canonical user model is read-only here — no assistant persona/relationship data may ever be
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
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/** Fields that would make canonical user identity carry assistant persona or authority. */
export const FORBIDDEN_CANONICAL_FIELDS = Object.freeze([
  'assistant_ref', 'assistant_profile', 'persona', 'relationship_mode', 'companion_name',
  'grants', 'permissions', 'authority', 'lease', 'action_key', 'assistant_memory',
]);

export function findForbiddenCanonicalFields(value, path = 'record', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findForbiddenCanonicalFields(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_CANONICAL_FIELDS.includes(key)) found.push(childPath);
    findForbiddenCanonicalFields(child, childPath, found);
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
  const table = new Map(records.map(record => [record.record_id, { ...record }]));
  // Values live in the port, not on the canonical record: a projection carries references, and the port is
  // the only thing that can resolve them.
  const valueTable = new Map(Object.entries(values));
  const reads = [];
  return Object.freeze({
    listRecords({ scopes = null } = {}) {
      reads.push({ op: 'listRecords', scopes });
      return [...table.values()].filter(record => scopes === null || scopes.includes(record.scope)).map(record => ({ ...record }));
    },
    resolveValue(valueRef) {
      reads.push({ op: 'resolveValue', valueRef });
      if (!valueTable.has(valueRef)) throw new DigitalMeError('INVALID_RECORD', 'unknown value reference ' + String(valueRef));
      return { value_ref: valueRef, value: valueTable.get(valueRef) };
    },
    /** Only the harness may change canonical records, which is how the isolation test is possible. */
    __mutate(recordId, patch) { const record = table.get(recordId); if (record) Object.assign(record, patch); },
    __snapshot() { return [...table.values()].map(record => ({ ...record })); },
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
  ttl_ms: { required: true, type: 'int', min: 0 },
  disclosure_authorized: { required: true, type: 'bool' },
});

export function validateRecord(record) {
  const errors = [];
  if (!isPlainObject(record)) return { ok: false, errors: ['a record must be an object'] };
  for (const key of Object.keys(record)) if (!(key in RECORD_SPEC)) errors.push(`record.${key} is not part of the canonical record`);
  for (const [key, rule] of Object.entries(RECORD_SPEC)) {
    if (!Object.hasOwn(record, key)) { if (rule.required) errors.push(`record.${key} is required`); continue; }
    const field = record[key];
    if (rule.type === 'text' && !isText(field)) errors.push(`record.${key} must be nonempty text`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`record.${key} must be one of ${rule.values.join(', ')}`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`record.${key} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int' && (!Number.isSafeInteger(field) || field < 0)) errors.push(`record.${key} must be a non-negative integer`);
    if (rule.type === 'bool' && typeof field !== 'boolean') errors.push(`record.${key} must be a boolean`);
  }
  for (const found of findForbiddenCanonicalFields(record)) errors.push(`${found} would put assistant or authority state into canonical user identity`);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/** Policy: which assistant may read which scopes, for which purposes, into which audiences. */
export const POLICY_SPEC_KEYS = Object.freeze(['scopes', 'purposes', 'audiences', 'allow_values']);

export function createDigitalMeGateway({ port, policy, clock = () => null } = {}) {
  if (!port || typeof port.listRecords !== 'function') throw new DigitalMeError('PORT_REQUIRED', 'the canonical Digital-Me read port is required');
  if (!isPlainObject(policy) || !isPlainObject(policy.assistants)) throw new DigitalMeError('UNKNOWN_ASSISTANT', 'policy.assistants is required');
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
      const provenance = { assistant_ref: assistantRef ?? null, purpose: purpose ?? null, audience: audience ?? null, scopes: [...(Array.isArray(scopes) ? scopes : [])], policy_ref: policy.policy_ref ?? null, decided_at: askedAt ?? null };
      if (!isText(assistantRef)) throw new DigitalMeError('INVALID_QUERY', 'assistantRef is required');
      const grants = policy.assistants[assistantRef];
      if (!grants) return refusal('UNKNOWN_ASSISTANT', `${assistantRef} is not a known assistant`, provenance);
      if (!AUDIENCES.includes(audience)) return refusal('UNKNOWN_AUDIENCE', String(audience), provenance);
      if (!QUERY_PURPOSES.includes(purpose)) return refusal('UNKNOWN_PURPOSE', String(purpose), provenance);
      if (!Array.isArray(scopes) || scopes.length === 0) throw new DigitalMeError('INVALID_QUERY', 'scopes must name at least one scope');
      for (const scope of scopes) if (!MEMORY_SCOPES.includes(scope)) return refusal('UNKNOWN_SCOPE', String(scope), provenance);
      if (!grants.purposes.includes(purpose)) return refusal('PURPOSE_DENIED', `${assistantRef} may not read for ${purpose}`, provenance);
      if (!grants.audiences.includes(audience)) return refusal('AUDIENCE_DENIED', `${assistantRef} may not project into ${audience}`, provenance);
      for (const scope of scopes) if (!grants.scopes.includes(scope)) return refusal('SCOPE_DENIED', `${assistantRef} may not read ${scope}`, provenance);

      const usableScopes = scopes.filter(scope => scope !== 'DEVICE_EPHEMERAL');
      const records = port.listRecords({ scopes });
      const visibleAudiences = AUDIENCE_VISIBILITY[audience];
      const nowMs = now();
      const included = [];
      const withheld = [];
      const stale = [];
      for (const record of records) {
        const validated = validateRecord(record);
        if (!validated.ok) throw new DigitalMeError('INVALID_RECORD', validated.errors.slice(0, 3).join('; '));
        // Device-ephemeral context is rebuilt per device and is never part of a durable projection.
        if (record.scope === 'DEVICE_EPHEMERAL') { withheld.push({ fact_ref: record.fact_ref, reason: 'DEVICE_EPHEMERAL_NOT_DURABLE' }); continue; }
        if (!usableScopes.includes(record.scope)) { withheld.push({ fact_ref: record.fact_ref, reason: 'SCOPE_NOT_REQUESTED' }); continue; }
        const age = nowMs === null ? 0 : nowMs - Date.parse(record.observed_at);
        if (nowMs !== null && age > record.ttl_ms) { stale.push(record.fact_ref); continue; }
        if (!visibleAudiences.includes(record.audience)) { withheld.push({ fact_ref: record.fact_ref, reason: 'AUDIENCE_NOT_PERMITTED' }); continue; }
        // Knowing a fact in private does not authorize disclosing it elsewhere.
        if (record.audience !== audience && record.disclosure_authorized !== true) { withheld.push({ fact_ref: record.fact_ref, reason: 'DISCLOSURE_NOT_AUTHORIZED' }); continue; }
        included.push({
          fact_ref: record.fact_ref,
          scope: record.scope,
          audience: record.audience,
          sensitivity: record.sensitivity,
          // Least data by default: references travel, values only when the purpose needs them.
          value_ref: record.value_ref,
          value: includeValues && grants.allow_values === true ? port.resolveValue(record.value_ref).value : null,
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

    policyRef() { return policy.policy_ref ?? null; },
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
    entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))),
    durable: false,
    merged_into_durable_memory: false,
    rebuilt_at: at,
  });
}
