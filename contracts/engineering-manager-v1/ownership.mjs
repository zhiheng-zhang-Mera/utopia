// Engineering Manager ownership boundaries (EM-001).
//
// Engineering Manager owns Engineering execution state only. City/Shared Task
// Core stays canonical for task truth, Remote Fabric for trust/transport,
// Butler for assistant semantics and General AI Gateway for general-AI
// semantics. This module makes those boundaries executable: a canonical
// contract may not redefine a foreign concern, may not become a second task
// database, and may not require a provider product name.
import { isPlainObjectValue as isPlainObject, isText } from './canonical.mjs';

export const ENGINEERING_CONTRACT_VERSION = 1;
export const ENGINEERING_ROUTE = 'ENGINEERING';

// Canonical concern -> owner, mirrored from CROSS_PROGRAMME_EXECUTION_CONTRACT §6.
export const CANONICAL_OWNERSHIP = Object.freeze({
 task_action_attention_identity: 'Shared Task/Action Core',
 device_identity_trust_presence_transport: 'Remote Fabric',
 assistant_identity_memory_context_handoff: 'Butler Assistant',
 general_ai_provider_model_channel_conversation: 'General AI Gateway',
 engineering_job_connector_worker_result_artifact: 'Engineering Manager',
 secure_credential_handle_storage: 'neutral 00-Foundation SecureHandleStorePort',
 policy_decision_contract: 'Shared Core policy contract'
});

// Route names owned by other domains. Engineering Manager may reference their
// state through typed `*_ref` fields but must never declare or redefine them.
export const FOREIGN_ROUTES = Object.freeze([
 'ROOM', 'ROOMS', 'CAPABILITY', 'CAPABILITIES', 'CITY_TASK', 'CITY_TASKS',
 'GENERAL_AI', 'GENERAL_AI_GATEWAY', 'ASSISTANT', 'BUTLER', 'REMOTE_FABRIC'
]);

// The exact state Engineering Manager may own/durably store for a job.
export const ENGINEERING_OWNED_STATE_FIELDS = Object.freeze([
 'job_ref', 'city_task_ref', 'execution_mode', 'owner', 'executor',
 'connector_instance_ref', 'workspace', 'scope', 'acceptance', 'permission_context_ref',
 'risk_class', 'context_refs', 'checkpoints', 'evidence_refs', 'artifact_refs', 'lease_ref',
 'idempotency_key', 'job_version', 'state', 'blocking_state', 'created_at', 'updated_at'
]);

// Fields that would turn Engineering execution state into a competing City
// task/domain database. They are rejected wherever a canonical record is validated.
export const FOREIGN_CANONICAL_FIELDS = Object.freeze([
 'task_graph', 'city_task_state', 'canonical_task_state', 'task_owner_truth', 'city_attention_state',
 'room_state', 'capability_registry_truth', 'assistant_identity', 'assistant_profile',
 'device_trust_state', 'device_identity', 'transport_session', 'provider_account_registry',
 'provider_model_catalog', 'conversation_history', 'memory_namespace', 'user_self_model'
]);

// Provider product names must never be required by the core contract and must
// never become a task/route identity. Only an opaque `provider_ref` inside a
// connector descriptor may name a concrete provider.
export const PROVIDER_PRODUCT_PATTERN = /(?:ds[-_ ]?hns|hns|codex|claude|workbuddy|gemini|openai|chatgpt|anthropic|deepseek)/i;
// Historical tombstone: never a donor, dependency or connector target.
export const FORBIDDEN_DONOR_PATTERN = /codex[-_ ]?boss/i;

// Secret-shaped field names. Only handle/reference forms (`*_ref`, `*_handle`)
// are allowed in canonical contracts.
export const SECRET_KEY_PATTERN = /(?:^|[._-])(token|secret|password|passwd|cookie|api[-_]?key|private[-_]?key|bearer|credential|session[-_]?key|refresh[-_]?token|access[-_]?token|client[-_]?secret)(?:$|[._-])/i;
const REFERENCE_SUFFIX = /(?:_ref|_refs|_handle|_handles|_id)$/i;

export class EngineeringContractError extends Error {
 constructor(code, detail) {
  super(detail ? `${code}: ${detail}` : code);
  this.name = 'EngineeringContractError';
  this.code = code;
  this.detail = detail ?? null;
  this.status = 400;
 }
}

// ---- recursive boundary scans -------------------------------------------

export function findSecretFields(value, path = 'record', found = []) {
 if (Array.isArray(value)) { value.forEach((item, index) => findSecretFields(item, `${path}[${index}]`, found)); return found; }
 if (!isPlainObject(value)) return found;
 for (const [key, child] of Object.entries(value)) {
  const childPath = `${path}.${key}`;
  if (SECRET_KEY_PATTERN.test(key) && !REFERENCE_SUFFIX.test(key)) found.push(childPath);
  findSecretFields(child, childPath, found);
 }
 return found;
}

export function findForeignCanonicalFields(value, path = 'record', found = []) {
 if (Array.isArray(value)) { value.forEach((item, index) => findForeignCanonicalFields(item, `${path}[${index}]`, found)); return found; }
 if (!isPlainObject(value)) return found;
 for (const [key, child] of Object.entries(value)) {
  const childPath = `${path}.${key}`;
  if (FOREIGN_CANONICAL_FIELDS.includes(key)) found.push(childPath);
  findForeignCanonicalFields(child, childPath, found);
 }
 return found;
}

export function findForbiddenDonorReferences(value, path = 'record', found = []) {
 if (typeof value === 'string') { if (FORBIDDEN_DONOR_PATTERN.test(value)) found.push(path); return found; }
 if (Array.isArray(value)) { value.forEach((item, index) => findForbiddenDonorReferences(item, `${path}[${index}]`, found)); return found; }
 if (!isPlainObject(value)) return found;
 for (const [key, child] of Object.entries(value)) findForbiddenDonorReferences(child, `${path}.${key}`, found);
 return found;
}

// ---- route reservation ---------------------------------------------------

// The only semantic route Engineering Manager reserves. Anything else - a
// foreign route or a provider product name - is rejected, never guessed.
export function validateEngineeringRoute(route) {
 const errors = [];
 if (!isText(route)) errors.push('route must be nonempty text');
 else if (route !== ENGINEERING_ROUTE) {
  if (FOREIGN_ROUTES.includes(route.toUpperCase())) errors.push(`route ${route} is owned by another domain and must not be redefined as an Engineering route`);
  else if (PROVIDER_PRODUCT_PATTERN.test(route)) errors.push(`route ${route} is a provider product name; provider identity is not a task route`);
  else errors.push(`route ${route} is not the reserved ${ENGINEERING_ROUTE} route`);
 }
 return { ok: errors.length === 0, errors };
}

// ---- owned-state boundary ------------------------------------------------

export function validateEngineeringOwnedState(state, { path = 'engineering_state' } = {}) {
 const errors = [];
 if (!isPlainObject(state)) return { ok: false, errors: [`${path} must be an object`] };
 for (const key of Object.keys(state)) {
  if (FOREIGN_CANONICAL_FIELDS.includes(key)) { errors.push(`${path}.${key} is canonical ${CANONICAL_OWNERSHIP.task_action_attention_identity} state and must not be stored by Engineering Manager`); continue; }
  if (!ENGINEERING_OWNED_STATE_FIELDS.includes(key)) errors.push(`${path}.${key} is not Engineering-owned execution state`);
 }
 for (const found of findForeignCanonicalFields(state, path)) if (!errors.some(error => error.startsWith(found))) errors.push(`${found} is foreign canonical state`);
 for (const found of findSecretFields(state, path)) errors.push(`${found} looks like a raw secret; canonical contracts store handles/references only`);
 for (const found of findForbiddenDonorReferences(state, path)) errors.push(`${found} references Codex-Boss, which is forbidden for this programme`);
 return { ok: errors.length === 0, errors };
}

export function assertEngineeringOwnedState(state, options = {}) {
 const result = validateEngineeringOwnedState(state, options);
 if (!result.ok) throw new EngineeringContractError('INVALID_ENGINEERING_OWNED_STATE', result.errors.slice(0, 3).join('; '));
 return state;
}

// The port that must be used when canonical task truth is needed, so Engineering
// Manager never grows a second task database.
export const CANONICAL_TASK_TRUTH_PORT = Object.freeze({
 interface: 'CanonicalTaskTruthPort',
 methods: Object.freeze(['readTaskRef', 'reportExecutionState', 'reportResult', 'requestAttention']),
 owner: CANONICAL_OWNERSHIP.task_action_attention_identity,
 engineering_manager_may_own_task_truth: false
});
