// Local-first Sub-worker placement gate (EM-006).
//
// The programme invariant is one sentence long and easy to violate quietly: **attempt the local host
// first, and never move work to another device merely because that device is faster or less loaded.**
// So this module decides from *measurements*, reduces local concurrency before it proposes anything, and
// only ever proposes remote fallback for a measured LOCAL_BLOCKED / LOCAL_UNAVAILABLE — with explicit
// user approval as a hard field rather than a convention.
//
// Pure module: no clock, no OS probing, no network. Measurements are inputs.
export const PLACEMENT_CONTRACT_VERSION = 1;

export const PLACEMENT_DECISIONS = Object.freeze(['LOCAL_ALLOWED', 'LOCAL_THROTTLED', 'LOCAL_BLOCKED', 'LOCAL_UNAVAILABLE']);
export const REMOTE_PLACEMENT = 'REMOTE_APPROVED';
export const FALLBACK_REASONS = Object.freeze(['LOCAL_BLOCKED', 'LOCAL_UNAVAILABLE']);
export const MIN_LOCAL_WORKERS = 1;
export const PLACEMENT_CODES = Object.freeze([
  'INVALID_MEASUREMENT', 'INVALID_POLICY', 'MEASUREMENT_MISSING', 'PROTECTED_FOREGROUND_WORKLOAD',
  'RESOURCE_PRESSURE', 'LOCAL_FIRST_REQUIRED', 'REMOTE_FALLBACK_NOT_JUSTIFIED', 'USER_APPROVAL_REQUIRED',
  'SPEED_IS_NOT_A_REASON', 'LOCAL_ATTEMPT_REQUIRED', 'UNKNOWN_CANDIDATE', 'INVALID_PROPOSAL',
]);

export class PlacementError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PlacementError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/** Fields that would turn placement into load balancing. They are refused, not ignored. */
export const SPEED_FIELDS = Object.freeze(['speed', 'speed_rank', 'faster', 'benchmark_score', 'idle_percent', 'priority_rank']);
export function findSpeedFields(value, path = 'candidate', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findSpeedFields(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SPEED_FIELDS.includes(key)) found.push(childPath);
    findSpeedFields(child, childPath, found);
  }
  return found;
}

const num = (value, path, errors, { min = 0, max = null, nullable = false } = {}) => {
  if (value === null && nullable) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (max !== null && value > max)) {
    errors.push(`${path} must be a number between ${min} and ${max ?? 'Infinity'}${nullable ? ' or null' : ''}`);
  }
};

export const MEASUREMENT_SPEC = Object.freeze({
  cpu: { required: true, type: 'object' },
  memory: { required: true, type: 'object' },
  gpu: { required: true, type: 'object' },
  foreground: { required: true, type: 'object' },
  workers: { required: true, type: 'object' },
  observed_at: { required: true, type: 'instant' },
  source: { required: true, type: 'text' },
});

export function validateMeasurements(measurements) {
  const errors = [];
  if (!isPlainObject(measurements)) return { ok: false, errors: ['measurements must be an object'] };
  for (const key of Object.keys(measurements)) if (!(key in MEASUREMENT_SPEC)) errors.push(`measurements.${key} is not part of the placement contract`);
  for (const [key, rule] of Object.entries(MEASUREMENT_SPEC)) {
    const present = Object.hasOwn(measurements, key);
    if (!present) { if (rule.required) errors.push(`measurements.${key} is required`); continue; }
    const field = measurements[key];
    if (rule.type === 'object' && !isPlainObject(field)) errors.push(`measurements.${key} must be an object`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`measurements.${key} must be an ISO-8601 UTC instant`);
    if (rule.type === 'text' && !isText(field)) errors.push(`measurements.${key} must be nonempty text`);
  }
  if (isPlainObject(measurements.cpu)) {
    num(measurements.cpu.load_percent, 'measurements.cpu.load_percent', errors, { max: 100 });
    num(measurements.cpu.cores, 'measurements.cpu.cores', errors, { min: 1 });
  }
  if (isPlainObject(measurements.memory)) {
    num(measurements.memory.used_percent, 'measurements.memory.used_percent', errors, { max: 100 });
    num(measurements.memory.free_bytes, 'measurements.memory.free_bytes', errors);
  }
  if (isPlainObject(measurements.gpu)) {
    num(measurements.gpu.used_percent, 'measurements.gpu.used_percent', errors, { max: 100, nullable: true });
    num(measurements.gpu.vram_free_bytes, 'measurements.gpu.vram_free_bytes', errors, { nullable: true });
    if (typeof measurements.gpu.protected !== 'boolean') errors.push('measurements.gpu.protected must be a boolean');
  }
  if (isPlainObject(measurements.foreground)) {
    if (typeof measurements.foreground.protected_workload !== 'boolean') errors.push('measurements.foreground.protected_workload must be a boolean');
    if (typeof measurements.foreground.full_screen_app !== 'boolean') errors.push('measurements.foreground.full_screen_app must be a boolean');
    if (typeof measurements.foreground.user_present !== 'boolean') errors.push('measurements.foreground.user_present must be a boolean');
  }
  if (isPlainObject(measurements.workers)) {
    num(measurements.workers.running, 'measurements.workers.running', errors);
    num(measurements.workers.max, 'measurements.workers.max', errors, { min: 1 });
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertMeasurements(measurements) {
  const verdict = validateMeasurements(measurements);
  if (!verdict.ok) throw new PlacementError('INVALID_MEASUREMENT', verdict.errors.slice(0, 3).join('; '));
  return measurements;
}

const DEFAULT_POLICY = Object.freeze({
  cpu_block_percent: 92,
  cpu_throttle_percent: 75,
  memory_block_percent: 90,
  memory_throttle_percent: 70,
  vram_min_free_bytes: 512 * 1024 * 1024,
  reduce_concurrency_to: 1,
});

/**
 * Decide where a Sub-worker may run *locally*.
 *
 * Order matters and mirrors the invariant: a protected foreground workload blocks immediately (the
 * user's own work outranks ours); then concurrency is reduced before any remote thought; only when even a
 * single worker cannot run safely is the local host blocked or unavailable.
 */
export function evaluateLocalPlacement(measurements, { policy = {} } = {}) {
  assertMeasurements(measurements);
  const settings = { ...DEFAULT_POLICY, ...policy };
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new PlacementError('INVALID_POLICY', `${key} must be a non-negative number`);
  }
  const evidence = {
    cpu_load_percent: measurements.cpu.load_percent,
    memory_used_percent: measurements.memory.used_percent,
    vram_free_bytes: measurements.gpu.vram_free_bytes,
    gpu_protected: measurements.gpu.protected,
    protected_workload: measurements.foreground.protected_workload,
    full_screen_app: measurements.foreground.full_screen_app,
    user_present: measurements.foreground.user_present,
    running_workers: measurements.workers.running,
    max_workers: measurements.workers.max,
    observed_at: measurements.observed_at,
    source: measurements.source,
  };

  // The user's own foreground work is never displaced by a Sub-worker.
  if (measurements.foreground.protected_workload === true) {
    return Object.freeze({ decision: 'LOCAL_BLOCKED', reason: 'PROTECTED_FOREGROUND_WORKLOAD', concurrency: 0, evidence: Object.freeze({ ...evidence }), remote_fallback_eligible: true });
  }
  if (measurements.gpu.protected === true && measurements.workers.running > 0) {
    return Object.freeze({ decision: 'LOCAL_BLOCKED', reason: 'PROTECTED_FOREGROUND_WORKLOAD', concurrency: 0, evidence: Object.freeze({ ...evidence }), remote_fallback_eligible: true });
  }
  // Unmeasured or nonsensical capacity means "cannot run here", never "assume free".
  if (measurements.workers.max < MIN_LOCAL_WORKERS || measurements.memory.free_bytes <= 0) {
    return Object.freeze({ decision: 'LOCAL_UNAVAILABLE', reason: 'MEASUREMENT_MISSING', concurrency: 0, evidence: Object.freeze({ ...evidence }), remote_fallback_eligible: true });
  }

  const blockedByCpu = measurements.cpu.load_percent >= settings.cpu_block_percent;
  const blockedByMemory = measurements.memory.used_percent >= settings.memory_block_percent;
  const blockedByVram = measurements.gpu.vram_free_bytes !== null && measurements.gpu.vram_free_bytes < settings.vram_min_free_bytes;
  if (blockedByCpu || blockedByMemory || blockedByVram || measurements.workers.running >= measurements.workers.max) {
    // Reducing local work to a single worker is attempted before any remote fallback is proposed.
    const canRunOne = measurements.workers.max >= MIN_LOCAL_WORKERS && measurements.memory.free_bytes > 0 && measurements.cpu.load_percent < 100;
    if (canRunOne) {
      return Object.freeze({
        decision: 'LOCAL_THROTTLED',
        reason: 'RESOURCE_PRESSURE',
        concurrency: Math.max(MIN_LOCAL_WORKERS, Math.min(settings.reduce_concurrency_to, measurements.workers.max)),
        evidence: Object.freeze({ ...evidence }),
        remote_fallback_eligible: false,
      });
    }
    return Object.freeze({ decision: 'LOCAL_BLOCKED', reason: 'RESOURCE_PRESSURE', concurrency: 0, evidence: Object.freeze({ ...evidence }), remote_fallback_eligible: true });
  }

  const pressured = measurements.cpu.load_percent >= settings.cpu_throttle_percent || measurements.memory.used_percent >= settings.memory_throttle_percent;
  const headroom = Math.max(MIN_LOCAL_WORKERS, measurements.workers.max - measurements.workers.running);
  if (pressured || measurements.workers.running >= measurements.workers.max - 1) {
    return Object.freeze({
      decision: 'LOCAL_THROTTLED',
      reason: 'RESOURCE_PRESSURE',
      concurrency: Math.max(MIN_LOCAL_WORKERS, Math.min(settings.reduce_concurrency_to, headroom)),
      evidence: Object.freeze({ ...evidence }),
      remote_fallback_eligible: false,
    });
  }
  return Object.freeze({ decision: 'LOCAL_ALLOWED', reason: null, concurrency: headroom, evidence: Object.freeze({ ...evidence }), remote_fallback_eligible: false });
}

/**
 * Propose remote fallback. This is the gate the invariant is really about: it is only reachable from a
 * measured blocking decision, and a candidate may not carry a speed ranking.
 */
export function proposeRemoteFallback({ localDecision, jobRef, candidates = [], requestedBy = null } = {}) {
  if (!isPlainObject(localDecision) || !PLACEMENT_DECISIONS.includes(localDecision.decision)) {
    throw new PlacementError('INVALID_PROPOSAL', 'a local placement decision is required');
  }
  if (!FALLBACK_REASONS.includes(localDecision.decision)) {
    throw new PlacementError('REMOTE_FALLBACK_NOT_JUSTIFIED', `local placement is ${localDecision.decision}; remote fallback requires a measured LOCAL_BLOCKED or LOCAL_UNAVAILABLE`);
  }
  if (localDecision.remote_fallback_eligible !== true) {
    throw new PlacementError('REMOTE_FALLBACK_NOT_JUSTIFIED', 'the local decision did not record itself as remote-eligible');
  }
  if (!isText(jobRef)) throw new PlacementError('INVALID_PROPOSAL', 'jobRef is required');
  if (!Array.isArray(candidates) || candidates.length === 0) throw new PlacementError('INVALID_PROPOSAL', 'at least one candidate device is required');
  for (const candidate of candidates) {
    if (!isPlainObject(candidate) || !isText(candidate.host_ref)) throw new PlacementError('UNKNOWN_CANDIDATE', 'every candidate needs a host_ref');
    const speedFields = findSpeedFields(candidate);
    // "Faster" is not a placement reason; a ranking field would make it one.
    if (speedFields.length) throw new PlacementError('SPEED_IS_NOT_A_REASON', `${speedFields.join(', ')} would rank a host by speed; remote fallback is only for measured local blocking`);
    if (!FALLBACK_REASONS.includes(candidate.measured_reason)) throw new PlacementError('REMOTE_FALLBACK_NOT_JUSTIFIED', `${candidate.host_ref} must carry the measured local reason that justifies it`);
  }
  return Object.freeze({
    proposal_version: PLACEMENT_CONTRACT_VERSION,
    job_ref: jobRef,
    reason: localDecision.decision,
    measured_evidence: Object.freeze({ ...localDecision.evidence }),
    candidates: Object.freeze(candidates.map(candidate => Object.freeze({ ...candidate }))),
    // V1 hard rule, stated as data rather than as documentation.
    requires_user_approval: true,
    scope: 'CURRENT_JOB',
    local_attempted_first: true,
    proposed_by: requestedBy,
    rank_by: 'CAPABILITY_FIT_THEN_HOST_REF',
    ranked_by_speed: false,
  });
}

/** Approve a proposal. Only an explicit user/owner reference counts as approval. */
export function approveRemoteFallback(proposal, { approvedBy, at } = {}) {
  if (!isPlainObject(proposal) || proposal.requires_user_approval !== true) throw new PlacementError('INVALID_PROPOSAL', 'a user-approved proposal is required');
  if (!isText(approvedBy)) throw new PlacementError('USER_APPROVAL_REQUIRED', 'remote execution requires explicit user approval in V1');
  if (!isIsoInstant(at)) throw new PlacementError('INVALID_PROPOSAL', 'at must be an ISO-8601 UTC instant');
  return Object.freeze({
    job_ref: proposal.job_ref,
    placement: REMOTE_PLACEMENT,
    approved_by: approvedBy,
    approved_at: at,
    reason: proposal.reason,
    scope: 'CURRENT_JOB',
    local_attempted_first: true,
    // The logical owner does not move with execution.
    owner_preserved: true,
  });
}

/** Rank candidates for a *justified* fallback: capability fit first, then host reference. Never speed. */
export function rankCandidateHosts(proposal, { requiredCapabilities = [] } = {}) {
  if (!isPlainObject(proposal)) throw new PlacementError('INVALID_PROPOSAL', 'a proposal is required');
  return Object.freeze([...proposal.candidates].map(candidate => {
    const capabilities = Array.isArray(candidate.capability_refs) ? candidate.capability_refs : [];
    const missing = requiredCapabilities.filter(capability => !capabilities.includes(capability));
    return { host_ref: candidate.host_ref, fit: missing.length === 0, missing: Object.freeze(missing.sort()) };
  }).sort((left, right) => (Number(right.fit) - Number(left.fit)) || left.host_ref.localeCompare(right.host_ref)));
}

/** A remote dispatch without a recorded local attempt violates the invariant. */
export function assertLocalFirstAttempted({ jobRef, attempts = [] } = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw new PlacementError('LOCAL_ATTEMPT_REQUIRED', `job ${String(jobRef)} cannot dispatch remotely without a recorded local attempt`);
  }
  const local = attempts.filter(attempt => attempt?.scope === 'LOCAL');
  if (local.length === 0) throw new PlacementError('LOCAL_ATTEMPT_REQUIRED', `job ${String(jobRef)} has attempts but none on the local host`);
  return { job_ref: jobRef, local_attempted_first: true, local_attempts: local.length, reduced_concurrency_first: local.some(attempt => attempt.throttled === true) };
}

export { DEFAULT_POLICY as LOCAL_FIRST_POLICY };
