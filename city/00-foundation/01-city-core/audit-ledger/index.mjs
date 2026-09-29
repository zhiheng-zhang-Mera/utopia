/**
 * UTOPIA · City Core — audit-ledger module entry point.
 *
 * Cluster D of MB-001: continuation / recovery and durable audit primitives.
 * Donor provenance, the exact ported behaviour and every deliberate difference are
 * recorded in `./DONOR.json`.
 */

export {
  AuditLedgerError,
  CHECK_VERDICTS,
  DECISION_OUTCOMES,
  DECISION_SOURCES,
  FAILURE_CLASSES,
  FAILURE_SEVERITIES,
  GUARDIAN_CHECKS,
  GUARDIAN_VERDICTS,
  RECOVERY_ATTEMPT_OUTCOMES,
  RECOVERY_ORDER,
  REQUIREMENT_COVERAGE_RATIO,
  THEME_GUARDIAN_CHECKS,
  THEME_RECOVERY_STEPS,
  VERIFICATION_GATES,
  assertFailureClassification,
  assertFailureObservation,
  assertRecoveryAttempt,
  assertWorkspaceFacts,
  decisionLedgerEntry,
  failureClassification,
  failureObservation,
  guardianCheckResult,
  guardianVerdict,
  recoveryAttempt,
  workspaceFacts,
} from './contracts.mjs';

export { appendAllToLedger, appendToLedger, entriesForTask, summarizeLedger, validateLedgerEntry } from './decision-ledger.mjs';

export { evaluateGuardian, requiredGuardianChecks, termsOf } from './guardian-gate.mjs';

export { advanceRecovery, classifyFailure, planRecovery } from './recovery.mjs';
