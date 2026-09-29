/**
 * UTOPIA · City Core — immutable decision ledger.
 *
 * Ported from the Codex-Boss donor `src/shared/decision-ledger.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The donor's own comment on this module is the whole point: it is the immutable
 * record model + append reducer; the durable JSON store lives elsewhere. So this
 * module validates an entry against the donor's exact bounds, appends without
 * mutating the input array, refuses a duplicate id rather than overwriting
 * history, and can summarise what the ledger holds.
 *
 * A ledger that can be silently rewritten is not an audit trail.
 */

import { AuditLedgerError, DECISION_OUTCOMES, DECISION_SOURCES, DECISION_OUTCOMES as OUTCOMES } from './contracts.mjs';

/**
 * The donor's `validateLedgerEntry`, with its bounds preserved one for one:
 * question ≤ 2000, at most 10 candidates of ≤ 200 each, chosen ≤ 2000, at most 50
 * pieces of evidence of ≤ 2000 each, rollback ≤ 2000, policy ≤ 200, and both the
 * outcome and the source drawn from their closed lists.
 */
export function validateLedgerEntry(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) throw new AuditLedgerError('Ledger entry requires an id');
  if (typeof entry.taskId !== 'string' || !entry.taskId.trim()) throw new AuditLedgerError('Ledger entry requires a taskId');
  if (typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) {
    throw new AuditLedgerError('Ledger entry requires a valid createdAt');
  }
  if (typeof entry.question !== 'string' || !entry.question.trim() || entry.question.length > 2000) {
    throw new AuditLedgerError('Ledger question invalid');
  }
  if (!Array.isArray(entry.candidates) || entry.candidates.length > 10 || entry.candidates.some((item) => typeof item !== 'string' || item.length > 200)) {
    throw new AuditLedgerError('Ledger candidates invalid');
  }
  if (typeof entry.chosen !== 'string' || !entry.chosen.trim() || entry.chosen.length > 2000) {
    throw new AuditLedgerError('Ledger chosen invalid');
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length > 50 || entry.evidence.some((item) => typeof item !== 'string' || item.length > 2000)) {
    throw new AuditLedgerError('Ledger evidence invalid');
  }
  if (!DECISION_OUTCOMES.includes(entry.outcome)) throw new AuditLedgerError('Ledger outcome invalid');
  if (entry.rollback !== undefined && (typeof entry.rollback !== 'string' || entry.rollback.length > 2000)) {
    throw new AuditLedgerError('Ledger rollback invalid');
  }
  if (entry.policy !== undefined && (typeof entry.policy !== 'string' || entry.policy.length > 200)) {
    throw new AuditLedgerError('Ledger policy invalid');
  }
  if (!DECISION_SOURCES.includes(entry.source)) throw new AuditLedgerError('Ledger source invalid');
}

/**
 * Immutable append: returns a NEW array with the entry appended. A repeated id is
 * refused, not merged — overwriting a decision would erase the audit trail the
 * ledger exists to provide.
 */
export function appendToLedger(entries, entry) {
  validateLedgerEntry(entry);
  if (entries.some((item) => item.id === entry.id)) {
    throw new AuditLedgerError(`Ledger entry already exists: ${entry.id}`);
  }
  return [...entries, entry];
}

/** Appends many entries in order, stopping at the first invalid or duplicate one. */
export function appendAllToLedger(entries, additions) {
  return additions.reduce((accumulated, entry) => appendToLedger(accumulated, entry), entries);
}

/** Counts by producer and by outcome, plus the rollback count the Owner audits. */
export function summarizeLedger(entries) {
  const bySource = Object.fromEntries(DECISION_SOURCES.map((source) => [source, 0]));
  const byOutcome = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const entry of entries) {
    bySource[entry.source] += 1;
    byOutcome[entry.outcome] += 1;
  }
  return { total: entries.length, bySource, byOutcome, rollbacks: byOutcome.ROLLED_BACK };
}

/** The entries for one task, in ledger order — the audit view the Owner reads. */
export function entriesForTask(entries, taskId) {
  return entries.filter((entry) => entry.taskId === taskId);
}
