// Engineering job / event / result / artifact protocol (EM-003).
//
// One auditable protocol family that supports autonomous coding agents and scripted Sub-workers
// without forcing one execution model onto the other. Pure module: no clock, filesystem, network
// or process access; instants and ids are caller-supplied.
//
// Cross-device carriage may use Remote Fabric RPC/EVENT/STREAM, but an RF transport envelope never
// replaces canonical Engineering job/event/result state — these envelopes are domain-semantic.
export const ENGINEERING_JOB_CONTRACT_VERSION = 1;
export const ENGINEERING_ROUTE = 'ENGINEERING';

export const EXECUTION_MODES = Object.freeze(['AUTONOMOUS_AGENT', 'SCRIPTED_EXECUTOR', 'INTERACTIVE_AGENT']);
export const JOB_STATES = Object.freeze(['SUBMITTED', 'QUEUED', 'RUNNING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']);
export const TERMINAL_JOB_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']);
export const ACTIVE_JOB_STATES = Object.freeze(['SUBMITTED', 'QUEUED', 'RUNNING', 'BLOCKED']);
export const RESULT_STATUSES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']);
export const RISK_CLASSES = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const PLACEMENTS = Object.freeze(['LOCAL_ALLOWED', 'LOCAL_THROTTLED', 'LOCAL_BLOCKED', 'LOCAL_UNAVAILABLE', 'REMOTE_APPROVED']);
export const EVENT_STAGES = Object.freeze(['ADMISSION', 'SCHEDULING', 'EXECUTION', 'VERIFICATION', 'DELIVERY']);
export const ARTIFACT_KINDS = Object.freeze(['PATCH', 'DIFF', 'COMMIT_REF', 'BRANCH_REF', 'PR_REF', 'FILE', 'SCREENSHOT', 'TEST_REPORT', 'LOG']);
export const FILE_STATUSES = Object.freeze(['ADDED', 'MODIFIED', 'DELETED', 'RENAMED']);
export const TEST_STATUSES = Object.freeze(['PASS', 'FAIL', 'SKIPPED']);
export const JOB_REJECTION_CODES = Object.freeze([
  'INVALID_ENGINEERING_JOB', 'SCRIPTED_SPEC_REQUIRED', 'AUTONOMOUS_MUST_NOT_PRESENT_OPERATIONS',
  'UNKNOWN_EXECUTION_MODE', 'UNKNOWN_JOB_STATE', 'UNKNOWN_ROUTE', 'UNKNOWN_CONTRACT_VERSION',
  'INVALID_EVENT', 'PARTIAL_CANNOT_BE_TERMINAL', 'NON_MONOTONIC_SEQUENCE', 'TERMINAL_JOB_IS_FINAL',
  'INVALID_RESULT', 'RESULT_JOB_MISMATCH', 'RESULT_VERSION_MISMATCH', 'INVALID_ARTIFACT',
  'ARTIFACT_PROVENANCE_REQUIRED', 'DUPLICATE_EVENT_ID', 'RAW_SECRET_FORBIDDEN',
]);

export class EngineeringJobError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EngineeringJobError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 400;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

const SECRET_KEY_PATTERN = /(?:^|[._-])(token|secret|password|cookie|api[-_]?key|private[-_]?key|bearer|credential|access[-_]?token)(?:$|[._-])/i;
const HANDLE_SUFFIX = /(?:_ref|_refs|_handle|_handles|_id)$/i;

export function findRawSecretFields(value, path = 'envelope', found = []) {
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
  for (const key of Object.keys(value)) if (!(key in spec)) errors.push(`${path}.${key} is not part of the canonical contract`);
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
    if (rule.type === 'array' && !Array.isArray(field)) errors.push(`${fieldPath} must be an array`);
    if (rule.constant !== undefined && field !== rule.constant) errors.push(`${fieldPath} must be ${JSON.stringify(rule.constant)}`);
    if (rule.enum && !rule.enum.includes(field)) errors.push(`${fieldPath} must be one of ${rule.enum.join(', ')}`);
  }
}

const VERSION = { required: true, type: 'int', constant: ENGINEERING_JOB_CONTRACT_VERSION };
const textArray = (max = 64) => (value, path, errors) => {
  if (!Array.isArray(value)) return;
  if (value.length > max) errors.push(`${path} must hold at most ${max} entries`);
  value.forEach((item, index) => { if (!isText(item)) errors.push(`${path}[${index}] must be nonempty text`); });
};

// ---- job envelope --------------------------------------------------------

export const JOB_SPEC = Object.freeze({
  contract_version: VERSION,
  route: { required: true, type: 'text', constant: ENGINEERING_ROUTE },
  job_ref: { required: true, type: 'text' },
  city_task_ref: { required: true, type: 'text' },
  objective: { required: true, type: 'text' },
  execution_mode: { required: true, enum: EXECUTION_MODES },
  target: { required: true, type: 'object' },
  context_refs: { required: true, type: 'array' },
  scope: { required: true, type: 'object' },
  acceptance: { required: true, type: 'object' },
  permissions: { required: true, type: 'object' },
  risk_class: { required: true, enum: RISK_CLASSES },
  device_policy: { required: true, type: 'object' },
  operations: { required: false, type: 'array' },
  state: { required: true, enum: JOB_STATES },
  job_version: { required: true, type: 'int', min: 1 },
  idempotency_key: { required: true, type: 'text' },
  created_at: { required: true, type: 'instant' },
  updated_at: { required: true, type: 'instant' },
});

const TARGET_SPEC = { repo_ref: { required: true, type: 'text' }, branch_ref: { required: true, type: 'text', nullable: true }, workspace_ref: { required: true, type: 'text', nullable: true } };
const SCOPE_SPEC = { include_refs: { required: true, type: 'array' }, exclude_refs: { required: true, type: 'array' } };
const ACCEPTANCE_SPEC = { criteria_refs: { required: true, type: 'array' }, required_checks: { required: true, type: 'array' } };
const PERMISSIONS_SPEC = { policy_context_ref: { required: true, type: 'text' }, required_needs: { required: true, type: 'array' } };
const DEVICE_POLICY_SPEC = { placement: { required: true, enum: PLACEMENTS }, execution_device_ref: { required: true, type: 'text', nullable: true } };

/**
 * Mode-specific shape, and the "honest blocker" for a scripted job that cannot execute.
 *
 * A scripted Sub-worker needs an explicit executable specification; an autonomous agent plans its
 * own operations from the objective and bounded constraints, so requiring `operations[]` of it
 * would be forcing one execution model onto the other. A scripted job without operations is not a
 * malformed document — it is a job that cannot run, and the caller is told which.
 */
export function admitJob(job) {
  const errors = [];
  checkShape(job, 'job', JOB_SPEC, errors);
  if (isPlainObject(job)) {
    if (isPlainObject(job.target)) checkShape(job.target, 'job.target', TARGET_SPEC, errors);
    if (isPlainObject(job.scope)) {
      checkShape(job.scope, 'job.scope', SCOPE_SPEC, errors);
      textArray()(job.scope.include_refs, 'job.scope.include_refs', errors);
      textArray()(job.scope.exclude_refs, 'job.scope.exclude_refs', errors);
    }
    if (isPlainObject(job.acceptance)) checkShape(job.acceptance, 'job.acceptance', ACCEPTANCE_SPEC, errors);
    if (isPlainObject(job.permissions)) { checkShape(job.permissions, 'job.permissions', PERMISSIONS_SPEC, errors); textArray(32)(job.permissions.required_needs, 'job.permissions.required_needs', errors); }
    if (isPlainObject(job.device_policy)) checkShape(job.device_policy, 'job.device_policy', DEVICE_POLICY_SPEC, errors);
    textArray()(job.context_refs, 'job.context_refs', errors);
    if (job.operations !== undefined) textArray(64)(job.operations, 'job.operations', errors);
    for (const found of findRawSecretFields(job, 'job')) errors.push(`${found} looks like raw secret bytes; jobs carry permission references, not secrets`);
  }
  if (errors.length) return { admitted: false, code: 'INVALID_ENGINEERING_JOB', detail: errors.slice(0, 3).join('; '), honest_blocker: false, errors };
  if (job.execution_mode === 'SCRIPTED_EXECUTOR') {
    if (!Array.isArray(job.operations) || job.operations.length === 0) {
      // Refused honestly: the job is well-formed but has no executable specification.
      return { admitted: false, code: 'SCRIPTED_SPEC_REQUIRED', detail: 'a SCRIPTED_EXECUTOR job must declare the operations it will execute', honest_blocker: true, errors: [] };
    }
    return { admitted: true, code: null, detail: 'scripted job has an explicit operation list', honest_blocker: false, errors: [] };
  }
  if (job.operations !== undefined) {
    return { admitted: false, code: 'AUTONOMOUS_MUST_NOT_PRESENT_OPERATIONS', detail: `${job.execution_mode} plans its own operations and must not be scripted`, honest_blocker: false, errors: [] };
  }
  return { admitted: true, code: null, detail: `${job.execution_mode} plans its own operations from the objective`, honest_blocker: false, errors: [] };
}

export function assertJobEnvelope(job) {
  const verdict = admitJob(job);
  if (!verdict.admitted) throw new EngineeringJobError(verdict.code, verdict.detail);
  return job;
}

// ---- event envelope ------------------------------------------------------

export const EVENT_SPEC = Object.freeze({
  contract_version: VERSION,
  event_id: { required: true, type: 'text' },
  job_ref: { required: true, type: 'text' },
  job_version: { required: true, type: 'int', min: 1 },
  sequence: { required: true, type: 'int', min: 1 },
  stage: { required: true, enum: EVENT_STAGES },
  state: { required: true, enum: JOB_STATES },
  partial: { required: true, type: 'object' },
  source: { required: true, type: 'object' },
  caused_by_event_ref: { required: true, type: 'text', nullable: true },
  at: { required: true, type: 'instant' },
});
const SOURCE_SPEC = { connector_ref: { required: true, type: 'text' }, device_ref: { required: true, type: 'text' } };
const PARTIAL_SPEC = { progress_percent: { required: true, type: 'int', min: 0 }, summary: { required: true, type: 'text' } };

export function validateEventEnvelope(event) {
  const errors = [];
  checkShape(event, 'event', EVENT_SPEC, errors);
  if (isPlainObject(event)) {
    if (isPlainObject(event.source)) checkShape(event.source, 'event.source', SOURCE_SPEC, errors);
    if (isPlainObject(event.partial)) {
      checkShape(event.partial, 'event.partial', PARTIAL_SPEC, errors);
      if (Number.isSafeInteger(event.partial.progress_percent) && event.partial.progress_percent > 100) errors.push('event.partial.progress_percent must be at most 100');
    }
    // A progress/partial event is never a terminal fact about the job.
    if (event.partial?.progress_percent !== 100 && TERMINAL_JOB_STATES.includes(event.state)) {
      errors.push('event.state: a partial or progress event cannot mark a job terminal');
    }
    for (const found of findRawSecretFields(event, 'event')) errors.push(`${found} looks like raw secret bytes`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

// ---- result envelope -----------------------------------------------------

export const RESULT_SPEC = Object.freeze({
  contract_version: VERSION,
  result_ref: { required: true, type: 'text' },
  job_ref: { required: true, type: 'text' },
  job_version: { required: true, type: 'int', min: 1 },
  terminal_status: { required: true, enum: RESULT_STATUSES },
  status_code: { required: true, type: 'text' },
  summary: { required: true, type: 'text', nullable: true },
  changed_files: { required: true, type: 'array' },
  tests: { required: true, type: 'array' },
  git: { required: true, type: 'object' },
  acceptance: { required: true, type: 'object' },
  warnings: { required: true, type: 'array' },
  controller_decisions: { required: true, type: 'array' },
  produced_at: { required: true, type: 'instant' },
});
const CHANGED_FILE_SPEC = { path: { required: true, type: 'text' }, status: { required: true, enum: FILE_STATUSES }, digest: { required: true, type: 'text', nullable: true } };
const TEST_SPEC = { name: { required: true, type: 'text' }, status: { required: true, enum: TEST_STATUSES } };
const GIT_SPEC = { commit_ref: { required: true, type: 'text', nullable: true }, branch_ref: { required: true, type: 'text', nullable: true }, pr_ref: { required: true, type: 'text', nullable: true } };
const RESULT_ACCEPTANCE_SPEC = { status: { required: true, enum: ['PASS', 'FAIL', 'NOT_REQUIRED'] }, evidence_refs: { required: true, type: 'array' } };
const CONTROLLER_DECISION_SPEC = { decision: { required: true, type: 'text' }, reason: { required: true, type: 'text' } };

export function validateResultEnvelope(result) {
  const errors = [];
  checkShape(result, 'result', RESULT_SPEC, errors);
  if (isPlainObject(result)) {
    if (Array.isArray(result.changed_files)) result.changed_files.forEach((entry, index) => checkShape(entry, `result.changed_files[${index}]`, CHANGED_FILE_SPEC, errors));
    if (Array.isArray(result.tests)) result.tests.forEach((entry, index) => checkShape(entry, `result.tests[${index}]`, TEST_SPEC, errors));
    if (isPlainObject(result.git)) checkShape(result.git, 'result.git', GIT_SPEC, errors);
    if (isPlainObject(result.acceptance)) { checkShape(result.acceptance, 'result.acceptance', RESULT_ACCEPTANCE_SPEC, errors); textArray()(result.acceptance.evidence_refs, 'result.acceptance.evidence_refs', errors); }
    if (Array.isArray(result.controller_decisions)) result.controller_decisions.forEach((entry, index) => checkShape(entry, `result.controller_decisions[${index}]`, CONTROLLER_DECISION_SPEC, errors));
    textArray(32)(result.warnings, 'result.warnings', errors);
    // Success must be evidence-backed, and a terminal status must match the acceptance verdict.
    if (result.terminal_status === 'SUCCEEDED' && result.acceptance?.status !== 'PASS') errors.push('result.terminal_status SUCCEEDED requires acceptance.status PASS');
    if (result.terminal_status === 'SUCCEEDED' && Array.isArray(result.tests) && result.tests.some(test => test?.status === 'FAIL')) errors.push('result.terminal_status SUCCEEDED must not carry a failing test');
    for (const found of findRawSecretFields(result, 'result')) errors.push(`${found} looks like raw secret bytes`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

// ---- artifact envelope ---------------------------------------------------

export const ARTIFACT_SPEC = Object.freeze({
  contract_version: VERSION,
  artifact_ref: { required: true, type: 'text' },
  job_ref: { required: true, type: 'text' },
  kind: { required: true, enum: ARTIFACT_KINDS },
  digest: { required: true, type: 'text' },
  media_type: { required: true, type: 'text' },
  size_bytes: { required: true, type: 'int', min: 0 },
  storage_ref: { required: true, type: 'text' },
  provenance: { required: true, type: 'object' },
  produced_at: { required: true, type: 'instant' },
});
const PROVENANCE_SPEC = { device_ref: { required: true, type: 'text' }, connector_ref: { required: true, type: 'text' }, event_ref: { required: true, type: 'text', nullable: true } };

export function validateArtifactEnvelope(artifact) {
  const errors = [];
  checkShape(artifact, 'artifact', ARTIFACT_SPEC, errors);
  if (isPlainObject(artifact)) {
    if (isPlainObject(artifact.provenance)) checkShape(artifact.provenance, 'artifact.provenance', PROVENANCE_SPEC, errors);
    if (isText(artifact.digest) && !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) errors.push('artifact.digest must be a sha256:<64 hex> digest');
    for (const found of findRawSecretFields(artifact, 'artifact')) errors.push(`${found} looks like raw secret bytes`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/** Artifact provenance: the source job is implicit in the envelope, the device/connector are explicit. */
export function artifactProvenance(artifact) {
  const verdict = validateArtifactEnvelope(artifact);
  if (!verdict.ok) throw new EngineeringJobError('INVALID_ARTIFACT', verdict.errors.slice(0, 3).join('; '));
  return Object.freeze({
    artifact_ref: artifact.artifact_ref,
    job_ref: artifact.job_ref,
    device_ref: artifact.provenance.device_ref,
    connector_ref: artifact.provenance.connector_ref,
    event_ref: artifact.provenance.event_ref,
    digest: artifact.digest,
    kind: artifact.kind,
  });
}
