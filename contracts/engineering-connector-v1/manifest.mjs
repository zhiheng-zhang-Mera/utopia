// Engineering connector manifests and permission mediation (EM-002).
//
// A connector is a *declaration*: what runtime it needs, which capabilities it offers, and which
// needs it proposes. It never grants itself anything — Utopia policy decides. Pure module: no
// clock, filesystem, network or process access.
export const CONNECTOR_CONTRACT_VERSION = 1;
export const RUNTIME_KINDS = Object.freeze(['NODE', 'PYTHON', 'EXE', 'CLI']);
export const CONNECTOR_FAILURE_CODES = Object.freeze([
  'ADAPTER_DETECT_FAILED',
  'ADAPTER_ADAPT_FAILED',
  'ADAPTER_INVALID_OUTPUT',
  'ADAPTER_STANDARDIZE_FAILED',
  'NO_ADAPTER_SELECTED',
  'DUPLICATE_CONNECTOR_KIND',
  'INVALID_CONNECTOR_MANIFEST',
  'UNDECLARED_NEED_GRANT',
  'CAPABILITY_NOT_DECLARED',
  'METHOD_NOT_DECLARED',
  'STARTUP_TIMEOUT',
  'HEARTBEAT_LOST',
  'RESTART_BUDGET_EXHAUSTED',
  'RUNTIME_IN_SAFE_MODE',
  'RUNTIME_NOT_STARTED',
  'PROCESS_SPAWN_FAILED',
  'INVALID_ADAPTER_REGISTRATION',
]);

export class ConnectorError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ConnectorError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 400;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));

/** Secret-shaped field names. Canonical manifests carry handles, never bytes. */
const SECRET_KEY_PATTERN = /(?:^|[._-])(token|secret|password|cookie|api[-_]?key|private[-_]?key|bearer|credential|access[-_]?token)(?:$|[._-])/i;
const HANDLE_SUFFIX = /(?:_ref|_refs|_handle|_handles|_id)$/i;

export function findRawSecretFields(value, path = 'manifest', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findRawSecretFields(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key) && !HANDLE_SUFFIX.test(key)) found.push(childPath);
    findRawSecretFields(child, childPath, found);
  }
  return found;
}

export const CAPABILITY_ENTRY_SPEC = Object.freeze({
  capability_id: { required: true, type: 'text' },
  capability_version: { required: true, type: 'int', min: 1 },
  methods: { required: true, type: 'array' },
});

export const NEED_ENTRY_SPEC = Object.freeze({
  need_id: { required: true, type: 'text' },
  reason: { required: true, type: 'text' },
});

export const LIMITS_SPEC = Object.freeze({
  startup_timeout_ms: { required: true, type: 'int', min: 1 },
  heartbeat_interval_ms: { required: true, type: 'int', min: 1 },
  max_restarts: { required: true, type: 'int', min: 0 },
  max_log_bytes: { required: true, type: 'int', min: 1 },
});

export const PROVENANCE_SPEC = Object.freeze({
  detection_evidence: { required: true, type: 'text' },
  selected_adapter_ref: { required: true, type: 'text' },
  runtime_kind: { required: true, enum: RUNTIME_KINDS },
});

export const CONNECTOR_MANIFEST_SPEC = Object.freeze({
  connector_version: { required: true, type: 'int', constant: CONNECTOR_CONTRACT_VERSION },
  connector_kind: { required: true, type: 'text' },
  display_name: { required: true, type: 'text' },
  runtime_kind: { required: true, enum: RUNTIME_KINDS },
  entry_ref: { required: true, type: 'text' },
  capabilities: { required: true, type: 'array' },
  needs: { required: true, type: 'array' },
  limits: { required: true, type: 'object' },
  provenance: { required: true, type: 'object' },
});

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  for (const key of Object.keys(value)) if (!(key in spec)) errors.push(`${path}.${key} is not part of the canonical contract`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'int' && (!Number.isSafeInteger(field) || field < (rule.min ?? 0))) errors.push(`${fieldPath} must be an integer >= ${rule.min ?? 0}`);
    if (rule.type === 'bool' && typeof field !== 'boolean') errors.push(`${fieldPath} must be a boolean`);
    if (rule.type === 'object' && !isPlainObject(field)) errors.push(`${fieldPath} must be an object`);
    if (rule.type === 'array' && !Array.isArray(field)) errors.push(`${fieldPath} must be an array`);
    if (rule.constant !== undefined && field !== rule.constant) errors.push(`${fieldPath} must be ${JSON.stringify(rule.constant)}`);
    if (rule.enum && !rule.enum.includes(field)) errors.push(`${fieldPath} must be one of ${rule.enum.join(', ')}`);
  }
}

export function validateConnectorManifest(manifest) {
  const errors = [];
  checkShape(manifest, 'manifest', CONNECTOR_MANIFEST_SPEC, errors);
  if (isPlainObject(manifest)) {
    if (Array.isArray(manifest.capabilities)) {
      if (manifest.capabilities.length === 0) errors.push('manifest.capabilities must declare at least one capability');
      const seen = new Set();
      manifest.capabilities.forEach((entry, index) => {
        checkShape(entry, `manifest.capabilities[${index}]`, CAPABILITY_ENTRY_SPEC, errors);
        if (isPlainObject(entry)) {
          if (seen.has(entry.capability_id)) errors.push(`manifest.capabilities[${index}].capability_id ${entry.capability_id} is declared twice`);
          seen.add(entry.capability_id);
          if (!Array.isArray(entry.methods) || entry.methods.length === 0) errors.push(`manifest.capabilities[${index}].methods must name at least one method`);
          else entry.methods.forEach((method, methodIndex) => { if (!isText(method)) errors.push(`manifest.capabilities[${index}].methods[${methodIndex}] must be nonempty text`); });
        }
      });
    }
    if (Array.isArray(manifest.needs)) {
      manifest.needs.forEach((entry, index) => checkShape(entry, `manifest.needs[${index}]`, NEED_ENTRY_SPEC, errors));
    }
    if (isPlainObject(manifest.limits)) checkShape(manifest.limits, 'manifest.limits', LIMITS_SPEC, errors);
    if (isPlainObject(manifest.provenance)) checkShape(manifest.provenance, 'manifest.provenance', PROVENANCE_SPEC, errors);
    for (const found of findRawSecretFields(manifest)) errors.push(`${found} looks like raw secret bytes; connectors declare needs, not secrets`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertConnectorManifest(manifest) {
  const verdict = validateConnectorManifest(manifest);
  if (!verdict.ok) throw new ConnectorError('INVALID_CONNECTOR_MANIFEST', verdict.errors.slice(0, 3).join('; '));
  return manifest;
}

export function declaredCapabilities(manifest) {
  assertConnectorManifest(manifest);
  return manifest.capabilities.map(entry => `${entry.capability_id}@${entry.capability_version}`).sort();
}

// ---- permission mediation ------------------------------------------------

/**
 * An adapter *proposes* needs; policy *decides* grants. The effective set is the intersection of
 * what the connector declared and what policy granted, so a policy answer can never widen a
 * manifest and a connector can never widen a policy answer.
 *
 * @param {object} manifest a valid connector manifest
 * @param {{granted?: string[], refused?: {need_id: string, code: string}[]}} policyDecision
 */
export function mediateConnectorPermissions(manifest, policyDecision = {}) {
  assertConnectorManifest(manifest);
  if (!isPlainObject(policyDecision)) throw new ConnectorError('INVALID_CONNECTOR_MANIFEST', 'a policy decision must be an object');
  const declared = new Set(manifest.needs.map(need => need.need_id));
  const grantedInput = Array.isArray(policyDecision.granted) ? policyDecision.granted : [];
  const refusedInput = Array.isArray(policyDecision.refused) ? policyDecision.refused : [];
  const undeclared = grantedInput.filter(needId => !declared.has(needId));
  if (undeclared.length) {
    // A grant for something the connector never asked for is not a grant: it would let policy
    // (or a mistaken caller) hand a connector authority outside its declaration.
    throw new ConnectorError('UNDECLARED_NEED_GRANT', `${undeclared.join(', ')} was granted but is not declared by ${manifest.connector_kind}`);
  }
  const granted = [...new Set(grantedInput)].filter(needId => declared.has(needId)).sort();
  const refused = [...refusedInput].map(entry => ({ need_id: entry.need_id, code: isText(entry.code) ? entry.code : 'NEED_REFUSED' })).sort((a, b) => a.need_id.localeCompare(b.need_id));
  const ungranted = manifest.needs.map(need => need.need_id).filter(needId => !granted.includes(needId) && !refused.some(entry => entry.need_id === needId));
  return Object.freeze({
    connector_kind: manifest.connector_kind,
    declared: Object.freeze([...declared].sort()),
    granted: Object.freeze(granted),
    refused: Object.freeze(refused),
    undecided: Object.freeze(ungranted),
    adapterGrantsAuthority: false,
    effectiveIsIntersection: true,
  });
}

/** Undeclared capability or method calls are refused before any process is involved. */
export function authorizeInvocation(manifest, permissionResult, { capabilityId, method }) {
  assertConnectorManifest(manifest);
  if (!isPlainObject(permissionResult)) throw new ConnectorError('INVALID_CONNECTOR_MANIFEST', 'a permission result is required');
  const entry = manifest.capabilities.find(capability => capability.capability_id === capabilityId);
  if (!entry) throw new ConnectorError('CAPABILITY_NOT_DECLARED', `${manifest.connector_kind} does not declare ${capabilityId}`);
  if (!entry.methods.includes(method)) throw new ConnectorError('METHOD_NOT_DECLARED', `${capabilityId} does not declare method ${method}`);
  const need = `${capabilityId}.invoke`;
  const requiresGrant = manifest.needs.some(candidate => candidate.need_id === need);
  if (requiresGrant && !permissionResult.granted.includes(need)) {
    throw new ConnectorError('UNDECLARED_NEED_GRANT', `${need} was not granted for ${manifest.connector_kind}`);
  }
  return { capability_id: capabilityId, capability_version: entry.capability_version, method, need: requiresGrant ? need : null };
}
