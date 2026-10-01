// Idempotency, replay and version rules for Engineering Manager submit/control/result (EM-001).
//
// Retry, reconnect and duplicate delivery must never create a duplicate job or a
// second side effect. Every externally visible operation carries an idempotency
// key plus the job version it was issued against:
//   - same key + same payload  -> replay the recorded outcome, do nothing else
//   - same key + other payload -> refuse (the key was reused for another operation)
//   - stale/future job version -> refuse instead of guessing which state is truth
import { digestOf, isPlainObjectValue as isPlainObject, isText } from './canonical.mjs';
import { EngineeringContractError } from './ownership.mjs';
import { TERMINAL_JOB_STATES, TIMESTAMP_PATTERN, validateJobEnvelope, validateResultEnvelope } from './envelopes.mjs';

export const IDEMPOTENCY_SCOPES = Object.freeze(['submit', 'control', 'result']);
export const CONTROL_COMMANDS = Object.freeze(['PAUSE', 'RESUME', 'CANCEL']);
export const CONTROL_TRANSITIONS = Object.freeze({
 PAUSE: Object.freeze({ to: 'PAUSED', from: Object.freeze(['QUEUED', 'RUNNING', 'WAITING_ATTENTION', 'RECOVERING']) }),
 RESUME: Object.freeze({ to: 'RUNNING', from: Object.freeze(['PAUSED']) }),
 CANCEL: Object.freeze({ to: 'CANCELLED', from: Object.freeze(['SUBMITTED', 'QUEUED', 'RUNNING', 'PAUSED', 'WAITING_ATTENTION', 'BLOCKED', 'RECOVERING']) })
});

export const CONTROL_COMMAND_SPEC = Object.freeze({
 contract_version: { required: true, type: 'int', constant: 1 },
 command_id: { required: true, type: 'text' },
 job_ref: { required: true, type: 'text' },
 kind: { required: true, enum: CONTROL_COMMANDS },
 job_version: { required: true, type: 'int', min: 1 },
 idempotency_key: { required: true, type: 'text' },
 issued_by_ref: { required: true, type: 'text' },
 issued_at: { required: true, type: 'timestamp' }
});

const enforce = (value, path, spec, errors) => {
 if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
 for (const key of Object.keys(value)) if (!(key in spec)) errors.push(`${path}.${key} is not part of the canonical contract`);
 for (const [key, rule] of Object.entries(spec)) {
  const present = Object.hasOwn(value, key);
  if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
  const field = value[key];
  if (rule.type === 'text' && !isText(field)) errors.push(`${path}.${key} must be nonempty text`);
  if (rule.type === 'timestamp' && !(isText(field) && TIMESTAMP_PATTERN.test(field))) errors.push(`${path}.${key} must be an ISO-8601 UTC timestamp`);
  if (rule.type === 'int' && !Number.isSafeInteger(field)) errors.push(`${path}.${key} must be an integer`);
  if (rule.constant !== undefined && field !== rule.constant) errors.push(`${path}.${key} must be ${JSON.stringify(rule.constant)}`);
  if (rule.enum && !rule.enum.includes(field)) errors.push(`${path}.${key} must be one of ${rule.enum.join(', ')}`);
 }
};

// ---- idempotency ledger --------------------------------------------------

export function createIdempotencyLedger({ maxEntries = 512 } = {}) {
 if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new EngineeringContractError('INVALID_LEDGER_CAPACITY', String(maxEntries));
 const entries = new Map();
 const keyOf = (scope, key) => `${scope}\u0000${key}`;
 const requireScope = scope => { if (!IDEMPOTENCY_SCOPES.includes(scope)) throw new EngineeringContractError('UNKNOWN_IDEMPOTENCY_SCOPE', String(scope)); };
 const requireKey = key => { if (!isText(key)) throw new EngineeringContractError('INVALID_IDEMPOTENCY_KEY', String(key)); };

 const readEntry = (scope, key, payload) => {
  const existing = entries.get(keyOf(scope, key));
  if (!existing) return null;
  const digest = digestOf(payload);
  if (existing.digest !== digest) throw new EngineeringContractError('IDEMPOTENCY_KEY_REUSE', `${scope}/${key} was already used for a different payload`);
  return { outcome: existing.outcome, digest, at: existing.at };
 };

 const ledger = {
  // Returns the recorded outcome when this exact operation was already applied,
  // otherwise null. A key reused with a different payload is refused.
  replay(scope, key, payload) {
   requireScope(scope);
   requireKey(key);
   return readEntry(scope, key, payload);
  },

  // Records the applied outcome. An identical operation is a no-op replay; the
  // stored outcome is never overwritten by a later duplicate.
  commit(scope, key, payload, { outcome = null, at = null } = {}) {
   const replayed = ledger.replay(scope, key, payload);
   if (replayed) return { replayed: true, outcome: replayed.outcome };
   entries.set(keyOf(scope, key), { scope, key, digest: digestOf(payload), outcome, at });
   while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
   return { replayed: false, outcome };
  },

  lookup(scope, key) {
   requireScope(scope);
   requireKey(key);
   const existing = entries.get(keyOf(scope, key));
   return existing ? { digest: existing.digest, outcome: existing.outcome, at: existing.at } : null;
  },
  size() { return entries.size; },
  snapshot() { return [...entries.values()].map(entry => ({ ...entry })).sort((a, b) => (a.scope + a.key).localeCompare(b.scope + b.key)); }
 };
 return ledger;
}

// ---- stable identities across restart/reconnect --------------------------

// The semantic submit intent: retry/reconnect may change volatile state,
// checkpoints or timestamps without turning a retry into a new operation.
export function submitIntentOf(job) {
 return {
  route: job.route,
  job_ref: job.job_ref,
  city_task_ref: job.city_task_ref,
  execution_mode: job.execution_mode,
  owner: job.owner,
  connector_instance_ref: job.connector_instance_ref,
  workspace: job.workspace,
  scope: job.scope,
  acceptance: job.acceptance,
  risk_class: job.risk_class,
  operations: job.operations ?? null,
  idempotency_key: job.idempotency_key
 };
}

export function submitJob(job, { ledger, at = job?.updated_at ?? null } = {}) {
 const result = validateJobEnvelope(job);
 if (!result.ok) throw new EngineeringContractError('INVALID_ENGINEERING_JOB', result.errors.slice(0, 3).join('; '));
 const intent = submitIntentOf(job);
 const replay = ledger.replay('submit', job.idempotency_key, intent);
 // A retried submit is answered from the ledger: no second job, no second side effect.
 if (replay) return { jobRef: replay.outcome?.job_ref ?? job.job_ref, created: false, replayed: true, outcome: replay.outcome };
 const outcome = { job_ref: job.job_ref, city_task_ref: job.city_task_ref, state: job.state, job_version: job.job_version };
 ledger.commit('submit', job.idempotency_key, intent, { outcome, at });
 return { jobRef: job.job_ref, created: true, replayed: false, outcome };
}

// Reconnect/restart proof: the canonical identity of a job is reconstructible
// from its serialized envelope and does not depend on live session state.
export function jobIdentityDigest(job) {
 if (!isPlainObject(job) || !isText(job.job_ref) || !isText(job.city_task_ref)) throw new EngineeringContractError('INVALID_JOB_IDENTITY', 'job_ref and city_task_ref are required');
 return digestOf({ job_ref: job.job_ref, city_task_ref: job.city_task_ref, route: job.route });
}

export function parseJobEnvelope(text) {
 let parsed;
 try { parsed = JSON.parse(text); } catch (error) { throw new EngineeringContractError('INVALID_ENGINEERING_JOB', 'envelope is not valid JSON'); }
 const result = validateJobEnvelope(parsed);
 if (!result.ok) throw new EngineeringContractError('INCOMPATIBLE_JOB_ENVELOPE', result.errors.slice(0, 3).join('; '));
 return parsed;
}

// ---- control -------------------------------------------------------------

export function applyControlCommand(job, command, { ledger, at = null } = {}) {
 const jobResult = validateJobEnvelope(job);
 if (!jobResult.ok) throw new EngineeringContractError('INVALID_ENGINEERING_JOB', jobResult.errors.slice(0, 3).join('; '));
 const commandErrors = [];
 enforce(command, 'command', CONTROL_COMMAND_SPEC, commandErrors);
 if (commandErrors.length) throw new EngineeringContractError('INVALID_CONTROL_COMMAND', [...new Set(commandErrors)].slice(0, 3).join('; '));
 if (command.job_ref !== job.job_ref) throw new EngineeringContractError('CONTROL_JOB_MISMATCH', `${command.job_ref} != ${job.job_ref}`);

 const payload = { job_ref: command.job_ref, kind: command.kind, job_version: command.job_version, issued_by_ref: command.issued_by_ref };
 const replay = ledger.replay('control', command.idempotency_key, payload);
 // A duplicate command (retry/reconnect) is answered from the ledger and never
 // applied twice.
 if (replay) return { job, replayed: true, applied: false, outcome: replay.outcome };

 if (TERMINAL_JOB_STATES.includes(job.state)) throw new EngineeringContractError('JOB_ALREADY_TERMINAL', `${job.job_ref} is ${job.state}`);
 if (command.job_version < job.job_version) throw new EngineeringContractError('STALE_JOB_VERSION', `command ${command.job_version} < current ${job.job_version}`);
 if (command.job_version > job.job_version) throw new EngineeringContractError('FUTURE_JOB_VERSION', `command ${command.job_version} > current ${job.job_version}`);
 const transition = CONTROL_TRANSITIONS[command.kind];
 if (!transition.from.includes(job.state)) throw new EngineeringContractError('ILLEGAL_STATE_TRANSITION', `${command.kind} from ${job.state}`);

 const next = {
  ...structuredClone(job),
  state: transition.to,
  blocking_state: command.kind === 'CANCEL' ? null : job.blocking_state,
  job_version: job.job_version + 1,
  updated_at: at ?? job.updated_at
 };
 const nextResult = validateJobEnvelope(next);
 if (!nextResult.ok) throw new EngineeringContractError('INVALID_ENGINEERING_JOB', nextResult.errors.slice(0, 3).join('; '));
 const outcome = { job_ref: next.job_ref, kind: command.kind, state: next.state, job_version: next.job_version, command_id: command.command_id };
 ledger.commit('control', command.idempotency_key, payload, { outcome, at });
 return { job: next, replayed: false, applied: true, outcome };
}

// ---- result --------------------------------------------------------------

export function applyResult(job, result, { ledger, at = null } = {}) {
 const jobResult = validateJobEnvelope(job);
 if (!jobResult.ok) throw new EngineeringContractError('INVALID_ENGINEERING_JOB', jobResult.errors.slice(0, 3).join('; '));
 const resultCheck = validateResultEnvelope(result);
 if (!resultCheck.ok) throw new EngineeringContractError('INVALID_ENGINEERING_RESULT', resultCheck.errors.slice(0, 3).join('; '));
 if (result.job_ref !== job.job_ref) throw new EngineeringContractError('RESULT_JOB_MISMATCH', `${result.job_ref} != ${job.job_ref}`);

 const payload = { job_ref: result.job_ref, result_ref: result.result_ref, outcome: result.outcome, acceptance: result.acceptance };
 const replay = ledger.replay('result', result.result_ref, payload);
 if (replay) return { job, replayed: true, applied: false, outcome: replay.outcome };

 // A terminal job cannot be resurrected or overwritten by another result.
 if (TERMINAL_JOB_STATES.includes(job.state)) throw new EngineeringContractError('DUPLICATE_RESULT_CONFLICT', `${job.job_ref} already finished as ${job.state}`);
 if (result.job_version < job.job_version) throw new EngineeringContractError('STALE_JOB_VERSION', `result ${result.job_version} < current ${job.job_version}`);
 if (result.job_version > job.job_version) throw new EngineeringContractError('FUTURE_JOB_VERSION', `result ${result.job_version} > current ${job.job_version}`);

 const next = {
  ...structuredClone(job),
  state: result.outcome,
  blocking_state: result.blocking_state,
  artifact_refs: [...new Set([...job.artifact_refs, ...result.artifact_refs])],
  evidence_refs: [...new Set([...job.evidence_refs, ...(result.acceptance?.evidence_refs ?? [])])],
  job_version: job.job_version + 1,
  updated_at: at ?? job.updated_at
 };
 const nextResult = validateJobEnvelope(next);
 if (!nextResult.ok) throw new EngineeringContractError('INVALID_ENGINEERING_JOB', nextResult.errors.slice(0, 3).join('; '));
 const outcome = { job_ref: next.job_ref, result_ref: result.result_ref, state: next.state, job_version: next.job_version };
 ledger.commit('result', result.result_ref, payload, { outcome, at });
 return { job: next, replayed: false, applied: true, outcome };
}

export { validateJobEnvelope, validateResultEnvelope };
