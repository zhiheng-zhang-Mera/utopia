/**
 * UTOPIA · City Core — durable audit vocabulary.
 *
 * Ported from three Codex-Boss donor files @ 8df428eaa437a409368401e95194e40266b83080:
 *   - `src/shared/decision-ledger.ts`   (the immutable decision record + its rules)
 *   - `src/shared/candidate-gate.ts` §36 (the Guardian checklist vocabulary)
 *   - `src/shared/recovery.ts` §33       (the failure/severity/step vocabularies)
 *
 * The doctrine carried over, unchanged:
 *
 *   - under OWNER_RESULT every internal decision is recorded for later audit —
 *     问题 / 候选 / 选择 / 证据 / 结果 / 是否回滚. The owner audits afterwards and
 *     never pre-approves routine technical decisions;
 *   - a check that could not be performed is NOT a pass. "We did not look" and
 *     "we looked and it is fine" are different facts, and a gate that cannot tell
 *     them apart is not a gate.
 *
 * The §33 vocabularies live here because they are the closed sets the recovery
 * behaviour is decided against — the same reason DECISION_OUTCOMES and
 * GUARDIAN_CHECKS live here. `recovery.mjs` holds the behaviour.
 *
 * Pure: no fs, no network, no clock, no process.
 */

/** §38: 结果 — what happened to the recorded decision. */
export const DECISION_OUTCOMES = ['APPLIED', 'ROLLED_BACK', 'DEFERRED'];

/** The donor's closed list of decision producers. */
export const DECISION_SOURCES = [
  'question-interceptor',
  'direction-stall',
  'planner',
  'reviewer',
  'executor',
  'recovery',
  'provider-replacement',
  'result-validator',
];

/** §36: the seven checks every candidate faces. */
export const GUARDIAN_CHECKS = [
  'GOAL_COMPLIANCE',
  'REQUIREMENT_COVERAGE',
  'SECRET_SCAN',
  'SCOPE_VALIDATION',
  'EVIDENCE_COMPLETENESS',
  'DESTRUCTIVE_CHANGE_CHECK',
  'OWNER_OVERRIDE_COMPLIANCE',
];

/** §36's additional four, required whenever the candidate touches a theme. */
export const THEME_GUARDIAN_CHECKS = [
  'THEME_ISOLATION',
  'FALLBACK_VALIDATION',
  'NO_EXECUTABLE_PAYLOAD',
  'BUILT_IN_THEME_INTEGRITY',
];

/** A check verdict. NOT_RUN is a blocker, never a pass. */
export const CHECK_VERDICTS = ['PASS', 'FAIL', 'NOT_RUN'];

/** The Guardian's own outcome vocabulary. */
export const GUARDIAN_VERDICTS = ['CANDIDATE', 'REPAIR', 'ACCEPTED'];

/** §36 requires full coverage, not "most of it". */
export const REQUIREMENT_COVERAGE_RATIO = 1;

/** Raised when a ledger entry or a guardian input is structurally unusable. */
export class AuditLedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditLedgerError';
    this.code = 'AUDIT_LEDGER_INVALID';
  }
}

/**
 * Copies a list argument, but never repairs a malformed one.
 *
 * Spreading a string would quietly turn `"sqlite"` into `["s","q","l",...]` and
 * make an invalid entry look valid, which would defeat the validator this module
 * exists to provide. A non-array value is therefore passed through untouched so
 * validation is the single gate that accepts or rejects it.
 */
function copyList(value) {
  return Array.isArray(value) ? [...value] : value;
}

/**
 * §38's record. `question` / `candidates` / `chosen` / `evidence` / `outcome` /
 * `rollback` are the donor's 问题 / 候选 / 选择 / 证据 / 结果 / 是否回滚, kept under
 * their English field names because the donor's own schema uses them.
 */
export function decisionLedgerEntry({
  id,
  taskId,
  createdAt,
  question,
  candidates = [],
  chosen,
  evidence = [],
  outcome,
  rollback,
  policy,
  source,
  stallOccurrence,
}) {
  return { id, taskId, createdAt, question, candidates: copyList(candidates), chosen, evidence: copyList(evidence), outcome, rollback, policy, source, stallOccurrence };
}

/** One Guardian check's result: what was inspected, and what was found. */
export function guardianCheckResult({ check, verdict, inspected = [], reasons = [] }) {
  return { check, verdict, inspected: copyList(inspected), reasons: copyList(reasons) };
}

/** The Guardian's verdict over a candidate. */
export function guardianVerdict({ verdict, checks = [], blocking = [], released, reason }) {
  return { verdict, checks: copyList(checks), blocking: copyList(blocking), released, reason };
}

/* ------------------------------------------------------------------ *
 * §33 recovery vocabulary (`src/shared/recovery.ts`)
 * ------------------------------------------------------------------ */

/** §33.1: the donor's closed list of failure classes, in donor order. */
export const FAILURE_CLASSES = [
  'TRANSIENT',
  'TERMINAL',
  'DEPENDENCY',
  'AUTH',
  'RATE_LIMIT',
  'PROVIDER_PAGE',
  'WORKSPACE',
  'BUILD',
  'TEST',
  'ENVIRONMENT',
  'THEME',
  'UI',
  'UNKNOWN',
];

/** §33.1: the donor's closed list of severities. */
export const FAILURE_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * §31 verification gates, from the donor's `VerificationGate` union. The donor
 * imported it as a type; the set is listed here so a caller can enumerate the
 * gates the classifier's own gate fallback answers.
 */
export const VERIFICATION_GATES = [
  'SYNTAX',
  'TYPECHECK',
  'BUILD',
  'UNIT',
  'MODULE',
  'INTEGRATION',
  'FULL',
  'VISUAL',
  'RUNTIME',
  'BLACKBOX',
];

/** §33.2: the recovery ladder, most-preferred first. Declared, never invented. */
export const RECOVERY_ORDER = [
  'NATIVE_RETRY',
  'LOCAL_RECOVERY',
  'ALTERNATE_INTERNAL_PATH',
  'ALTERNATE_PROVIDER',
  'DEGRADED_MODE',
  'HNS_FALLBACK',
  'HARD_BLOCKER',
];

/** §33.2's theme ladder, in order. */
export const THEME_RECOVERY_STEPS = ['DISABLE_THEME', 'FALLBACK_BUILT_IN_THEME', 'RECORD_DIAGNOSTIC'];

/** What an attempt at one recovery step can report. */
export const RECOVERY_ATTEMPT_OUTCOMES = ['PASS', 'FAIL', 'NOT_APPLICABLE'];

/**
 * The caller-checked workspace facts of `WorkspaceFacts` (§33.1). Optional
 * fields, but a list field that is present is still copied as a list so a
 * malformed non-array is passed through for the validator rather than spread.
 */
export function workspaceFacts({ is_git_repo, missing_modules, scope_refused, escaped_path, protected_path, disk_full } = {}) {
  return { is_git_repo, missing_modules: copyList(missing_modules), scope_refused, escaped_path, protected_path, disk_full };
}

/**
 * One observable failure (`FailureObservation`, §33.1). Every field is optional:
 * an observation with nothing in it is exactly what the donor's UNKNOWN fallback
 * describes, so this factory never fills a field the caller did not supply.
 */
export function failureObservation({
  gate,
  detail,
  runtime_code,
  semantic_outcome,
  exit_code,
  workspace,
  theme_error_diagnostics,
  visual_failed,
  policy_refusal,
} = {}) {
  return { gate, detail, runtime_code, semantic_outcome, exit_code, workspace, theme_error_diagnostics, visual_failed, policy_refusal };
}

/**
 * The classifier's answer (`FailureClassification`, §33.1). `signals` is the
 * evidence that decided the class, so it is copied and defaults to empty.
 */
export function failureClassification({ failure_class, confidence, reason, signals = [], severity }) {
  return { failure_class, confidence, reason, signals: copyList(signals), severity };
}

/** One attempt at one ladder step (`RecoveryAttempt`, §33.2). */
export function recoveryAttempt({ step, outcome, detail }) {
  return { step, outcome, detail };
}

/**
 * §33.1's `WorkspaceFacts`, checked. Missing fields are legal — "the host did not
 * check" is a fact — but a present field of the wrong type is refused rather than
 * quietly read as absent by `classifyFailure`'s own predicates.
 */
export function assertWorkspaceFacts(facts) {
  if (facts === undefined) return facts;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new AuditLedgerError('Workspace facts must be an object');
  const listFields = ['missing_modules'];
  for (const field of listFields) {
    const value = facts[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new AuditLedgerError(`Workspace facts ${field} must be a list of strings`);
    }
  }
  const booleanFields = ['is_git_repo', 'scope_refused', 'escaped_path', 'protected_path', 'disk_full'];
  for (const field of booleanFields) {
    if (facts[field] !== undefined && typeof facts[field] !== 'boolean') {
      throw new AuditLedgerError(`Workspace facts ${field} must be a boolean`);
    }
  }
  return facts;
}

/**
 * §33.1's `FailureObservation`, checked. Nothing is required, because "no gate,
 * no runtime code and no output signal" is a real and classifiable observation;
 * what is refused is a field that claims a type it does not have.
 */
export function assertFailureObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) throw new AuditLedgerError('Failure observation must be an object');
  const stringFields = ['detail', 'runtime_code', 'semantic_outcome', 'policy_refusal'];
  for (const field of stringFields) {
    if (observation[field] !== undefined && typeof observation[field] !== 'string') {
      throw new AuditLedgerError(`Failure observation ${field} must be a string`);
    }
  }
  if (observation.gate !== undefined && !VERIFICATION_GATES.includes(observation.gate)) throw new AuditLedgerError('Failure observation gate is not a known verification gate');
  if (observation.exit_code !== undefined && !Number.isInteger(observation.exit_code)) throw new AuditLedgerError('Failure observation exit_code must be an integer');
  if (observation.theme_error_diagnostics !== undefined && typeof observation.theme_error_diagnostics !== 'number') {
    throw new AuditLedgerError('Failure observation theme_error_diagnostics must be a number');
  }
  if (observation.visual_failed !== undefined && typeof observation.visual_failed !== 'boolean') {
    throw new AuditLedgerError('Failure observation visual_failed must be a boolean');
  }
  assertWorkspaceFacts(observation.workspace);
  return observation;
}

/**
 * §33.1's `FailureClassification`, checked. `confidence` must be a real
 * probability: NaN and Infinity are not confidences.
 */
export function assertFailureClassification(classification) {
  if (!classification || typeof classification !== 'object' || Array.isArray(classification)) throw new AuditLedgerError('Failure classification must be an object');
  if (!FAILURE_CLASSES.includes(classification.failure_class)) throw new AuditLedgerError(`Failure classification class is not one of §33.1's classes: ${classification.failure_class}`);
  if (!FAILURE_SEVERITIES.includes(classification.severity)) throw new AuditLedgerError(`Failure classification severity is not one of §33.1's severities: ${classification.severity}`);
  if (!Number.isFinite(classification.confidence) || classification.confidence < 0 || classification.confidence > 1) {
    throw new AuditLedgerError('Failure classification confidence must be a number between 0 and 1');
  }
  if (typeof classification.reason !== 'string') throw new AuditLedgerError('Failure classification reason must be a string');
  if (!Array.isArray(classification.signals) || classification.signals.some((signal) => typeof signal !== 'string')) {
    throw new AuditLedgerError('Failure classification signals must be a list of strings');
  }
  return classification;
}

/** §33.2's `RecoveryAttempt`, checked against the declared step and outcome sets. */
export function assertRecoveryAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) throw new AuditLedgerError('Recovery attempt must be an object');
  if (!RECOVERY_ORDER.includes(attempt.step)) throw new AuditLedgerError(`Recovery attempt step is not on the §33.2 ladder: ${attempt.step}`);
  if (!RECOVERY_ATTEMPT_OUTCOMES.includes(attempt.outcome)) throw new AuditLedgerError(`Recovery attempt outcome is not one of ${RECOVERY_ATTEMPT_OUTCOMES.join(', ')}: ${attempt.outcome}`);
  if (attempt.detail !== undefined && typeof attempt.detail !== 'string') throw new AuditLedgerError('Recovery attempt detail must be a string');
  return attempt;
}
