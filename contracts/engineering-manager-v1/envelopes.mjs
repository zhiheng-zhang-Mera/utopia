// Canonical Engineering Manager envelopes (EM-001).
//
// Every canonical record is strict: an unknown version, state, route or field is
// rejected rather than guessed. No envelope may carry a raw secret, a foreign
// canonical state field or a Codex-Boss reference.
import { digestOf, isDigest, isPlainObjectValue as isPlainObject, isText } from './canonical.mjs';
import {
 ENGINEERING_CONTRACT_VERSION, ENGINEERING_ROUTE, EngineeringContractError,
 findForbiddenDonorReferences, findForeignCanonicalFields, findSecretFields, validateEngineeringRoute
} from './ownership.mjs';

export const EXECUTION_MODES = Object.freeze(['AUTONOMOUS_AGENT', 'SCRIPTED_EXECUTOR', 'INTERACTIVE_AGENT']);
export const JOB_STATES = Object.freeze(['SUBMITTED', 'QUEUED', 'RUNNING', 'PAUSED', 'WAITING_ATTENTION', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED', 'RECOVERING']);
export const TERMINAL_JOB_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']);
export const EVENT_TYPES = Object.freeze(['JOB_SUBMITTED', 'JOB_STATE_CHANGED', 'PROGRESS', 'LOG', 'ATTENTION_REQUIRED', 'ATTENTION_ACKNOWLEDGED', 'ARTIFACT_PRODUCED', 'RESULT_READY', 'CONTROL_ACCEPTED', 'CONTROL_REJECTED', 'HEALTH_CHANGED', 'RECOVERY_REQUESTED']);
export const ATTENTION_PROJECTIONS = Object.freeze(['ACTIONABLE', 'NOTIFY', 'RING']);
export const ATTENTION_STATUSES = Object.freeze(['PENDING', 'ACKNOWLEDGED', 'EXPIRED']);
export const AUTH_STATES = Object.freeze(['UNKNOWN', 'UNAUTHENTICATED', 'PENDING', 'AUTHENTICATED', 'EXPIRED', 'REVOKED']);
export const HEALTH_STATES = Object.freeze(['UNKNOWN', 'HEALTHY', 'DEGRADED', 'THROTTLED', 'UNHEALTHY', 'UNAVAILABLE']);
export const PLACEMENT_STATES = Object.freeze(['LOCAL_ALLOWED', 'LOCAL_THROTTLED', 'LOCAL_BLOCKED', 'LOCAL_UNAVAILABLE', 'REMOTE_APPROVED']);
export const BLOCKING_STATES = Object.freeze(['LOCAL_BLOCKED', 'LOCAL_UNAVAILABLE', 'AUTH_REQUIRED', 'USER_APPROVAL_REQUIRED', 'PHYSICAL_ACTION_REQUIRED']);
export const RISK_CLASSES = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const RESULT_OUTCOMES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']);
export const FALLBACK_REASONS = Object.freeze(['LOCAL_BLOCKED', 'LOCAL_UNAVAILABLE']);
export const FALLBACK_STATUSES = Object.freeze(['PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED']);
export const FILE_STATUSES = Object.freeze(['ADDED', 'MODIFIED', 'DELETED', 'RENAMED']);
export const TEST_STATUSES = Object.freeze(['PASS', 'FAIL', 'SKIPPED']);
export const CONNECTOR_INSTANCE_STATES = Object.freeze(['REGISTERED', 'PROBED', 'AVAILABLE', 'UNAVAILABLE', 'DISABLED']);
export const CAPABILITY_AVAILABILITY = Object.freeze(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']);
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// ---- declarative strict field checking ----------------------------------

function checkFields(value, path, spec, errors) {
 if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
 for (const key of Object.keys(value)) if (!(key in spec)) errors.push(`${path}.${key} is not part of the canonical contract`);
 for (const [key, rule] of Object.entries(spec)) {
  const present = Object.hasOwn(value, key);
  if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
  const field = value[key];
  const fieldPath = `${path}.${key}`;
  if (field === null || field === undefined) {
   if (rule.nullable) continue;
   errors.push(`${fieldPath} must not be null`);
   continue;
  }
  if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
  if (rule.type === 'timestamp' && !(isText(field) && TIMESTAMP_PATTERN.test(field))) errors.push(`${fieldPath} must be an ISO-8601 UTC timestamp`);
  if (rule.type === 'digest' && !isDigest(field)) errors.push(`${fieldPath} must be a sha256 digest`);
  if (rule.type === 'int' && (!Number.isSafeInteger(field) || field < (rule.min ?? 0))) errors.push(`${fieldPath} must be an integer >= ${rule.min ?? 0}`);
  if (rule.type === 'bool' && typeof field !== 'boolean') errors.push(`${fieldPath} must be a boolean`);
  if (rule.type === 'object' && !isPlainObject(field)) errors.push(`${fieldPath} must be an object`);
  if (rule.type === 'array' && !Array.isArray(field)) errors.push(`${fieldPath} must be an array`);
  if (rule.constant !== undefined && field !== rule.constant) errors.push(`${fieldPath} must be ${JSON.stringify(rule.constant)}`);
  if (rule.enum && !rule.enum.includes(field)) errors.push(`${fieldPath} must be one of ${rule.enum.join(', ')}`);
  if (rule.validate && !(rule.type === 'array' && !Array.isArray(field))) rule.validate(field, fieldPath, errors);
 }
}

const checkTextArray = (value, path, errors, { max = 64 } = {}) => {
 if (!Array.isArray(value)) return;
 if (value.length > max) errors.push(`${path} must hold at most ${max} entries`);
 value.forEach((item, index) => { if (!isText(item)) errors.push(`${path}[${index}] must be nonempty text`); });
};

function boundaryScans(value, path, errors) {
 for (const found of findSecretFields(value, path)) errors.push(`${found} looks like a raw secret; canonical contracts carry handles/references only`);
 for (const found of findForeignCanonicalFields(value, path)) errors.push(`${found} is canonical state owned by another domain`);
 for (const found of findForbiddenDonorReferences(value, path)) errors.push(`${found} references Codex-Boss, which is forbidden for this programme`);
}

const versionSpec = { required: true, type: 'int', constant: ENGINEERING_CONTRACT_VERSION };
const refSpec = { required: true, type: 'text' };
const timestampSpec = { required: true, type: 'timestamp' };

// ---- job envelope --------------------------------------------------------

export const OWNER_SPEC = { task_owner_ref: refSpec, coordinator_ref: refSpec };
export const EXECUTOR_SPEC = { host_kind: { required: true, enum: ['LOCAL', 'REMOTE'] }, host_ref: refSpec, placement: { required: true, enum: PLACEMENT_STATES } };
const WORKSPACE_SPEC = { repo_ref: refSpec, worktree_ref: { required: true, type: 'text', nullable: true }, branch_ref: { required: true, type: 'text', nullable: true } };
const SCOPE_SPEC = { include_refs: { required: true, type: 'array', validate: checkTextArray }, exclude_refs: { required: true, type: 'array', validate: checkTextArray } };
const ACCEPTANCE_SPEC = { criteria_refs: { required: true, type: 'array', validate: checkTextArray }, required_checks: { required: true, type: 'array', validate: checkTextArray } };

export const JOB_SPEC = {
 contract_version: versionSpec,
 route: refSpec,
 job_ref: refSpec,
 city_task_ref: refSpec,
 execution_mode: { required: true, enum: EXECUTION_MODES },
 owner: { required: true, type: 'object', validate: (value, path, errors) => checkFields(value, path, OWNER_SPEC, errors) },
 executor: { required: true, type: 'object', validate: (value, path, errors) => checkFields(value, path, EXECUTOR_SPEC, errors) },
 connector_instance_ref: refSpec,
 workspace: { required: true, type: 'object', validate: (value, path, errors) => checkFields(value, path, WORKSPACE_SPEC, errors) },
 scope: { required: true, type: 'object', validate: (value, path, errors) => checkFields(value, path, SCOPE_SPEC, errors) },
 acceptance: { required: true, type: 'object', validate: (value, path, errors) => checkFields(value, path, ACCEPTANCE_SPEC, errors) },
 permission_context_ref: refSpec,
 risk_class: { required: true, enum: RISK_CLASSES },
 context_refs: { required: true, type: 'array', validate: checkTextArray },
 checkpoints: { required: true, type: 'array', validate: checkTextArray },
 evidence_refs: { required: true, type: 'array', validate: checkTextArray },
 artifact_refs: { required: true, type: 'array', validate: checkTextArray },
 lease_ref: { required: true, type: 'text', nullable: true },
 idempotency_key: refSpec,
 job_version: { required: true, type: 'int', min: 1 },
 state: { required: true, enum: JOB_STATES },
 blocking_state: { required: true, enum: BLOCKING_STATES, nullable: true },
 operations: { required: false, type: 'array', validate: checkTextArray },
 created_at: timestampSpec,
 updated_at: timestampSpec
};

export function validateJobEnvelope(job) {
 const errors = [];
 checkFields(job, 'job', JOB_SPEC, errors);
 if (isPlainObject(job)) {
  const route = validateEngineeringRoute(job.route);
  for (const error of route.errors) errors.push(`job.${error}`);
  // A scripted Sub-worker needs explicit operations; autonomous/interactive
  // agents plan their own operations and must not be forced into that shape.
  if (job.execution_mode === 'SCRIPTED_EXECUTOR' && (!Array.isArray(job.operations) || job.operations.length === 0)) errors.push('job.operations are required for SCRIPTED_EXECUTOR');
  if (job.execution_mode && job.execution_mode !== 'SCRIPTED_EXECUTOR' && 'operations' in job) errors.push('job.operations must not be supplied for a non-scripted execution mode');
  boundaryScans(job, 'job', errors);
 }
 return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertJobEnvelope(job) {
 const result = validateJobEnvelope(job);
 if (!result.ok) throw new EngineeringContractError('INVALID_ENGINEERING_JOB', result.errors.slice(0, 3).join('; '));
 return job;
}

// Owner/coordinator and current executor are always distinct fields, even when
// the same physical host fills both roles.
export function resolveJobRoles(job) {
 assertJobEnvelope(job);
 return Object.freeze({
  taskOwnerRef: job.owner.task_owner_ref,
  coordinatorRef: job.owner.coordinator_ref,
  executorHostRef: job.executor.host_ref,
  executorKind: job.executor.host_kind,
  sameHost: job.owner.task_owner_ref === job.executor.host_ref,
  executionHostChangeCreatesNewOwner: false
 });
}

// ---- event / attention envelopes ----------------------------------------

export const EVENT_SPEC = {
 contract_version: versionSpec,
 event_id: refSpec,
 job_ref: refSpec,
 event_type: { required: true, enum: EVENT_TYPES },
 job_version: { required: true, type: 'int', min: 1 },
 sequence: { required: true, type: 'int', min: 0 },
 at: timestampSpec,
 payload: { required: true, type: 'object' }
};

export function validateEventEnvelope(event) {
 const errors = [];
 checkFields(event, 'event', EVENT_SPEC, errors);
 boundaryScans(event, 'event', errors);
 return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

const PROJECTION_SPEC = {
 device_ref: refSpec,
 projection: { required: true, enum: ATTENTION_PROJECTIONS },
 delivered_at: { required: true, type: 'timestamp', nullable: true },
 ringing: { required: true, type: 'bool' },
 actionable: { required: true, type: 'bool' }
};
const ACKNOWLEDGEMENT_SPEC = {
 status: { required: true, enum: ATTENTION_STATUSES },
 acknowledged_by: { required: true, type: 'text', nullable: true },
 at: { required: true, type: 'timestamp', nullable: true }
};

export const ATTENTION_SPEC = {
 contract_version: versionSpec,
 attention_id: refSpec,
 job_ref: refSpec,
 blocking: { required: true, type: 'bool' },
 question: refSpec,
 projections: { required: true, type: 'array', validate: (value, path, errors) => { if (Array.isArray(value)) value.forEach((item, index) => checkFields(item, `${path}[${index}]`, PROJECTION_SPEC, errors)); } },
 acknowledgement: { required: true, type: 'object', validate: (value, path, errors) => checkFields(value, path, ACKNOWLEDGEMENT_SPEC, errors) },
 created_at: timestampSpec
};

export function validateAttentionEnvelope(attention) {
 const errors = [];
 checkFields(attention, 'attention', ATTENTION_SPEC, errors);
 if (isPlainObject(attention)) {
  const projections = Array.isArray(attention.projections) ? attention.projections : [];
  const actionable = projections.filter(item => isPlainObject(item) && item.actionable === true);
  // Rule 1: the current interaction device holds the single actionable projection.
  if (attention.acknowledgement?.status === 'PENDING') {
   if (actionable.length !== 1) errors.push('attention.projections must contain exactly one actionable projection for the current interaction device');
  } else if (actionable.length > 0) errors.push('an acknowledged or expired attention must not keep an actionable projection');
  if (projections.length > 4) errors.push('attention.projections must not exceed the current device plus 3 recent devices');
  const ringing = projections.filter(item => isPlainObject(item) && item.ringing === true);
  if (attention.acknowledgement?.status !== 'PENDING' && ringing.length > 0) errors.push('an acknowledged or expired attention must not keep ringing');
  if (attention.blocking === false && ringing.length > 0) errors.push('a non-blocking informational event must not ring by default');
  const identities = new Set(projections.filter(isPlainObject).map(item => item.device_ref));
  if (identities.size !== projections.length) errors.push('attention projections must target distinct devices');
  boundaryScans(attention, 'attention', errors);
 }
 return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function acknowledgeAttention(attention, { device_ref, at }) {
 const result = validateAttentionEnvelope(attention);
 if (!result.ok) throw new EngineeringContractError('INVALID_ATTENTION_ENVELOPE', result.errors.slice(0, 3).join('; '));
 const targets = attention.projections.filter(projection => projection.device_ref === device_ref);
 // A device without a projection cannot acknowledge, and a duplicate/late
 // acknowledgement must never re-ring or reopen the epoch.
 if (targets.length === 0) throw new EngineeringContractError('ATTENTION_NOT_PROJECTED_TO_DEVICE', String(device_ref));
 if (attention.acknowledgement.status !== 'PENDING') return { attention, acknowledged: false, duplicate: true, rangAgain: false };
 const next = {
  ...structuredClone(attention),
  acknowledgement: { status: 'ACKNOWLEDGED', acknowledged_by: device_ref, at },
  projections: attention.projections.map(projection => ({ ...projection, ringing: false, actionable: false }))
 };
 return { attention: next, acknowledged: true, duplicate: false, rangAgain: false };
}

// Re-delivery after reconnect/refresh/duplicate delivery: already delivered or
// acknowledged epochs never ring again.
export function projectAttention(attention, { device_ref, projection }) {
 const result = validateAttentionEnvelope(attention);
 if (!result.ok) throw new EngineeringContractError('INVALID_ATTENTION_ENVELOPE', result.errors.slice(0, 3).join('; '));
 if (!ATTENTION_PROJECTIONS.includes(projection)) throw new EngineeringContractError('UNKNOWN_ATTENTION_PROJECTION', String(projection));
 const delivered = attention.projections.some(item => item.device_ref === device_ref);
 if (attention.acknowledgement.status !== 'PENDING' || delivered) return { delivered: false, ringing: false, actionable: false, suppressed: true };
 return { delivered: true, ringing: projection !== 'ACTIONABLE', actionable: projection === 'ACTIONABLE', suppressed: false };
}

// ---- result / artifact envelopes ---------------------------------------

const CHANGED_FILE_SPEC = { path: refSpec, status: { required: true, enum: FILE_STATUSES }, digest: { required: true, type: 'text', nullable: true } };
const TEST_RESULT_SPEC = { name: refSpec, status: { required: true, enum: TEST_STATUSES } };
const RESULT_ACCEPTANCE_SPEC = { status: { required: true, enum: ['PASS', 'FAIL', 'NOT_REQUIRED'] }, evidence_refs: { required: true, type: 'array', validate: checkTextArray } };

export const RESULT_SPEC = {
 contract_version: versionSpec,
 result_ref: refSpec,
 job_ref: refSpec,
 job_version: { required: true, type: 'int', min: 1 },
 outcome: { required: true, enum: RESULT_OUTCOMES },
 acceptance: { required: true, type: 'object', validate: (value, path, errors) => checkFields(value, path, RESULT_ACCEPTANCE_SPEC, errors) },
 changed_files: { required: true, type: 'array', validate: (value, path, errors) => { if (Array.isArray(value)) value.forEach((item, index) => checkFields(item, `${path}[${index}]`, CHANGED_FILE_SPEC, errors)); } },
 tests: { required: true, type: 'array', validate: (value, path, errors) => { if (Array.isArray(value)) value.forEach((item, index) => checkFields(item, `${path}[${index}]`, TEST_RESULT_SPEC, errors)); } },
 branch_ref: { required: true, type: 'text', nullable: true },
 commit_ref: { required: true, type: 'text', nullable: true },
 artifact_refs: { required: true, type: 'array', validate: checkTextArray },
 blocking_state: { required: true, enum: BLOCKING_STATES, nullable: true },
 produced_at: timestampSpec
};

export function validateResultEnvelope(result) {
 const errors = [];
 checkFields(result, 'result', RESULT_SPEC, errors);
 if (isPlainObject(result)) {
  // A typed blocker (including a hardware-bound physical action) is never success.
  if (result.blocking_state !== null && result.blocking_state !== undefined && result.outcome === 'SUCCEEDED') errors.push('result.outcome must not be SUCCEEDED while a typed blocking state is present');
  // Success requires accepted evidence, so a false success cannot be reported.
  if (result.outcome === 'SUCCEEDED' && result.acceptance?.status !== 'PASS') errors.push('result.outcome SUCCEEDED requires acceptance.status PASS');
  if (result.outcome === 'SUCCEEDED' && Array.isArray(result.tests) && result.tests.some(test => test?.status === 'FAIL')) errors.push('result.outcome SUCCEEDED must not contain failing tests');
  boundaryScans(result, 'result', errors);
 }
 return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export const ARTIFACT_SPEC = {
 contract_version: versionSpec,
 artifact_ref: refSpec,
 job_ref: refSpec,
 kind: refSpec,
 media_type: refSpec,
 digest: { required: true, type: 'digest' },
 size_bytes: { required: true, type: 'int', min: 0 },
 storage_ref: refSpec,
 produced_at: timestampSpec
};

export function validateArtifactEnvelope(artifact) {
 const errors = [];
 checkFields(artifact, 'artifact', ARTIFACT_SPEC, errors);
 boundaryScans(artifact, 'artifact', errors);
 return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

// ---- connector envelopes -----------------------------------------------

const CAPABILITY_ENTRY_SPEC = { capability_id: refSpec, capability_version: { required: true, type: 'int', min: 1 } };

export const CONNECTOR_DESCRIPTOR_SPEC = {
 contract_version: versionSpec,
 connector_kind: refSpec,
 descriptor_version: { required: true, type: 'int', min: 1 },
 display_name: refSpec,
 // The only place a concrete provider product may be named, and only as an
 // opaque reference. The core contract never requires it.
 provider_ref: { required: true, type: 'text', nullable: true },
 transports: { required: true, type: 'array', validate: checkTextArray },
 capabilities: { required: true, type: 'array', validate: (value, path, errors) => { if (Array.isArray(value)) value.forEach((item, index) => checkFields(item, `${path}[${index}]`, CAPABILITY_ENTRY_SPEC, errors)); } },
 auth_required: { required: true, type: 'bool' }
};

export const CONNECTOR_INSTANCE_SPEC = {
 contract_version: versionSpec,
 instance_ref: refSpec,
 connector_kind: refSpec,
 descriptor_version: { required: true, type: 'int', min: 1 },
 host_ref: refSpec,
 state: { required: true, enum: CONNECTOR_INSTANCE_STATES },
 auth_status: { required: true, enum: AUTH_STATES },
 health: { required: true, enum: HEALTH_STATES },
 capability_refs: { required: true, type: 'array', validate: checkTextArray },
 last_probe_at: { required: true, type: 'timestamp', nullable: true }
};

export const CAPABILITY_MANIFEST_SPEC = {
 contract_version: versionSpec,
 instance_ref: refSpec,
 capabilities: { required: true, type: 'array', validate: (value, path, errors) => { if (Array.isArray(value)) value.forEach((item, index) => checkFields(item, `${path}[${index}]`, { ...CAPABILITY_ENTRY_SPEC, availability: { required: true, enum: CAPABILITY_AVAILABILITY } }, errors)); } },
 probed_at: timestampSpec
};

export const AUTH_STATUS_SPEC = {
 contract_version: versionSpec,
 instance_ref: refSpec,
 status: { required: true, enum: AUTH_STATES },
 // A handle/reference only. A raw credential is rejected by the boundary scan.
 credential_ref: { required: true, type: 'text', nullable: true },
 expires_at: { required: true, type: 'timestamp', nullable: true },
 checked_at: timestampSpec
};

function validateWithSpec(name, value, spec) {
 const errors = [];
 checkFields(value, name, spec, errors);
 boundaryScans(value, name, errors);
 return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export const validateConnectorDescriptor = descriptor => validateWithSpec('descriptor', descriptor, CONNECTOR_DESCRIPTOR_SPEC);
export const validateConnectorInstance = instance => validateWithSpec('instance', instance, CONNECTOR_INSTANCE_SPEC);
export const validateCapabilityManifest = manifest => validateWithSpec('manifest', manifest, CAPABILITY_MANIFEST_SPEC);
export const validateAuthStatus = authStatus => validateWithSpec('authStatus', authStatus, AUTH_STATUS_SPEC);

// ---- remote fallback ----------------------------------------------------

const CANDIDATE_SPEC = {
 host_ref: refSpec,
 // Measured local blocking evidence, never a speed or load comparison.
 measured_reason: { required: true, enum: FALLBACK_REASONS },
 capability_refs: { required: true, type: 'array', validate: checkTextArray }
};

export const REMOTE_FALLBACK_SPEC = {
 contract_version: versionSpec,
 proposal_ref: refSpec,
 job_ref: refSpec,
 owner_ref: refSpec,
 reason: { required: true, enum: FALLBACK_REASONS },
 candidates: { required: true, type: 'array' },
 requires_user_approval: { required: true, type: 'bool' },
 scope: { required: true, constant: 'CURRENT_JOB' },
 status: { required: true, enum: FALLBACK_STATUSES },
 created_at: timestampSpec
};

export function validateRemoteFallbackProposal(proposal) {
 const errors = [];
 checkFields(proposal, 'proposal', REMOTE_FALLBACK_SPEC, errors);
 if (isPlainObject(proposal)) {
  const candidates = Array.isArray(proposal.candidates) ? proposal.candidates : [];
  if (candidates.length === 0 || candidates.length > 3) errors.push('proposal.candidates must hold between 1 and 3 eligible hosts');
  candidates.forEach((candidate, index) => checkFields(candidate, `proposal.candidates[${index}]`, CANDIDATE_SPEC, errors));
  // V1: no remote Sub-worker starts before explicit user approval.
  if (proposal.requires_user_approval !== true) errors.push('proposal.requires_user_approval must be true in V1');
  boundaryScans(proposal, 'proposal', errors);
 }
 return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

// Applying an approved proposal moves the executor only. The logical job owner
// is preserved: changing execution host never creates a new task owner.
export function applyApprovedFallback(job, proposal, { host_ref, at }) {
 assertJobEnvelope(job);
 const proposalResult = validateRemoteFallbackProposal(proposal);
 if (!proposalResult.ok) throw new EngineeringContractError('INVALID_REMOTE_FALLBACK_PROPOSAL', proposalResult.errors.slice(0, 3).join('; '));
 if (proposal.job_ref !== job.job_ref) throw new EngineeringContractError('PROPOSAL_JOB_MISMATCH', `${proposal.job_ref} != ${job.job_ref}`);
 if (proposal.owner_ref !== job.owner.task_owner_ref) throw new EngineeringContractError('PROPOSAL_OWNER_MISMATCH', `${proposal.owner_ref} != ${job.owner.task_owner_ref}`);
 if (proposal.status !== 'APPROVED') throw new EngineeringContractError('REMOTE_FALLBACK_NOT_APPROVED', proposal.status);
 if (!proposal.candidates.some(candidate => candidate.host_ref === host_ref)) throw new EngineeringContractError('REMOTE_HOST_NOT_PROPOSED', String(host_ref));
 const next = {
  ...structuredClone(job),
  executor: { host_kind: 'REMOTE', host_ref, placement: 'REMOTE_APPROVED' },
  state: 'QUEUED',
  job_version: job.job_version + 1,
  updated_at: at
 };
 assertJobEnvelope(next);
 return { job: next, ownerRef: next.owner.task_owner_ref, executorHostRef: next.executor.host_ref };
}

export const digestEnvelope = digestOf;
export const ENGINEERING_ROUTE_NAME = ENGINEERING_ROUTE;
