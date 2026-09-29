/**
 * UTOPIA · City Core — decision ledger parity and behaviour tests.
 *
 * Ported from the Codex-Boss donor `src/shared/decision-ledger.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditLedgerError,
  DECISION_OUTCOMES,
  DECISION_SOURCES,
  appendAllToLedger,
  appendToLedger,
  decisionLedgerEntry,
  entriesForTask,
  summarizeLedger,
  validateLedgerEntry,
} from '../index.mjs';

const good = (overrides = {}) => decisionLedgerEntry({
  id: 'D-1',
  taskId: 'T-1',
  createdAt: '2026-09-29T00:00:00.000Z',
  question: 'which store should hold the record?',
  candidates: ['sqlite', 'json'],
  chosen: 'sqlite',
  evidence: ['run-1'],
  outcome: 'APPLIED',
  source: 'planner',
  ...overrides,
});

test('a well-formed entry validates and keeps every field', () => {
  const entry = good();
  assert.doesNotThrow(() => validateLedgerEntry(entry));
  assert.equal(entry.outcome, 'APPLIED');
  assert.equal(entry.source, 'planner');
  assert.deepEqual(entry.candidates, ['sqlite', 'json']);
  assert.deepEqual(DECISION_OUTCOMES, ['APPLIED', 'ROLLED_BACK', 'DEFERRED']);
  assert.equal(DECISION_SOURCES.length, 8);
});

test('the donor bounds are enforced one for one', () => {
  const cases = [
    ['id missing', { id: '   ' }],
    ['taskId missing', { taskId: '' }],
    ['createdAt not a date', { createdAt: 'not-a-date' }],
    ['question empty', { question: '  ' }],
    ['question too long', { question: 'x'.repeat(2001) }],
    ['candidates not an array', { candidates: 'sqlite' }],
    ['too many candidates', { candidates: Array.from({ length: 11 }, (_, index) => `c${index}`) }],
    ['candidate too long', { candidates: ['x'.repeat(201)] }],
    ['chosen empty', { chosen: '' }],
    ['too much evidence', { evidence: Array.from({ length: 51 }, (_, index) => `e${index}`) }],
    ['evidence entry too long', { evidence: ['x'.repeat(2001)] }],
    ['unknown outcome', { outcome: 'MAYBE' }],
    ['rollback too long', { rollback: 'x'.repeat(2001) }],
    ['policy too long', { policy: 'x'.repeat(201) }],
    ['unknown source', { source: 'vibes' }],
  ];
  for (const [name, override] of cases) {
    assert.throws(() => validateLedgerEntry(good(override)), AuditLedgerError, name);
  }
  // the exact boundary values are still accepted
  assert.doesNotThrow(() => validateLedgerEntry(good({ question: 'x'.repeat(2000) })));
  assert.doesNotThrow(() => validateLedgerEntry(good({ policy: 'x'.repeat(200) })));
  assert.doesNotThrow(() => validateLedgerEntry(good({ rollback: 'x'.repeat(2000) })));
  assert.doesNotThrow(() => validateLedgerEntry(good({ candidates: Array.from({ length: 10 }, (_, index) => `c${index}`) })));
});

test('append is immutable and refuses to overwrite an existing decision', () => {
  const first = good();
  const ledger = appendToLedger([], first);
  assert.deepEqual(ledger, [first]);
  assert.notEqual(ledger, [], 'a new array is returned rather than the input mutated');

  const original = [first];
  const appended = appendToLedger(original, good({ id: 'D-2' }));
  assert.equal(original.length, 1, 'the input array is never mutated');
  assert.equal(appended.length, 2);

  assert.throws(() => appendToLedger(appended, good()), AuditLedgerError, 'a duplicate id is refused');
  assert.throws(() => appendToLedger([], good({ outcome: 'NOPE' })), AuditLedgerError, 'invalid entries never reach the ledger');
});

test('appendAllToLedger appends in order and stops at the first bad entry', () => {
  const ledger = appendAllToLedger([], [good({ id: 'A' }), good({ id: 'B' })]);
  assert.deepEqual(ledger.map((entry) => entry.id), ['A', 'B']);
  assert.throws(() => appendAllToLedger(ledger, [good({ id: 'C' }), good({ id: 'A' })]), AuditLedgerError);
});

test('summarizeLedger counts by source and outcome and reports rollbacks', () => {
  const ledger = [
    good({ id: '1', source: 'planner', outcome: 'APPLIED' }),
    good({ id: '2', source: 'planner', outcome: 'ROLLED_BACK' }),
    good({ id: '3', source: 'recovery', outcome: 'DEFERRED' }),
  ];
  const stats = summarizeLedger(ledger);
  assert.equal(stats.total, 3);
  assert.equal(stats.bySource.planner, 2);
  assert.equal(stats.bySource.recovery, 1);
  assert.equal(stats.bySource.executor, 0, 'every known source is present even at zero');
  assert.equal(stats.byOutcome.ROLLED_BACK, 1);
  assert.equal(stats.rollbacks, 1);
  assert.deepEqual(Object.keys(stats.bySource).sort(), [...DECISION_SOURCES].sort());
});

test('entriesForTask returns that task history in ledger order', () => {
  const ledger = [good({ id: '1', taskId: 'T-1' }), good({ id: '2', taskId: 'T-2' }), good({ id: '3', taskId: 'T-1' })];
  assert.deepEqual(entriesForTask(ledger, 'T-1').map((entry) => entry.id), ['1', '3']);
  assert.deepEqual(entriesForTask(ledger, 'T-9'), []);
});
