/**
 * UTOPIA · City Core — Guardian gate (§36) behaviour tests.
 *
 * Ported from the Codex-Boss donor `src/shared/candidate-gate.ts` §36 @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The tests that matter most here are the fail-closed ones: a missing observation
 * must produce NOT_RUN and block release, and a removal check that could not run
 * must never be reported as a pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GUARDIAN_CHECKS,
  THEME_GUARDIAN_CHECKS,
  evaluateGuardian,
  guardianCheckResult,
  guardianVerdict,
  requiredGuardianChecks,
  termsOf,
} from '../index.mjs';

const passingContext = (overrides = {}) => ({
  goal: { text: 'ship the city core', served_by_requirements: ['R1'], deliverables: ['core'] },
  coverage: { required: ['R1'], covered: ['R1'], unimplemented: [] },
  secrets: { scanned_files: ['a.mjs'], hits: [] },
  scope: { allowed_files: ['a.mjs'], written_files: ['a.mjs'], refused: [] },
  evidence: { outstanding_requirements: [], failed_requirements: [], ledger_rows: 3, review_covered: true },
  destructive: { deleted_files: [], deleted_tests: [], removed_scripts: [], approved_by_owner: [] },
  overrides: [],
  ...overrides,
});

const checkOf = (verdict, id) => verdict.checks.find((entry) => entry.check === id);

test('the donor vocabulary is seven checks plus four theme checks', () => {
  assert.deepEqual(GUARDIAN_CHECKS, [
    'GOAL_COMPLIANCE',
    'REQUIREMENT_COVERAGE',
    'SECRET_SCAN',
    'SCOPE_VALIDATION',
    'EVIDENCE_COMPLETENESS',
    'DESTRUCTIVE_CHANGE_CHECK',
    'OWNER_OVERRIDE_COMPLIANCE',
  ]);
  assert.deepEqual(THEME_GUARDIAN_CHECKS, [
    'THEME_ISOLATION',
    'FALLBACK_VALIDATION',
    'NO_EXECUTABLE_PAYLOAD',
    'BUILT_IN_THEME_INTEGRITY',
  ]);
  assert.deepEqual(requiredGuardianChecks({}), [...GUARDIAN_CHECKS]);
  assert.deepEqual(requiredGuardianChecks({ theme_required: true }), [...GUARDIAN_CHECKS, ...THEME_GUARDIAN_CHECKS]);
  assert.deepEqual(requiredGuardianChecks({ themes: [{ id: 't' }] }), [...GUARDIAN_CHECKS, ...THEME_GUARDIAN_CHECKS]);
});

test('no observations means NOT_RUN, not a pass, and release is blocked', () => {
  const { verdict, not_inspected } = evaluateGuardian({});
  assert.equal(verdict.verdict, 'REPAIR');
  assert.equal(verdict.released, false);
  assert.deepEqual(verdict.blocking, [...GUARDIAN_CHECKS]);
  assert.deepEqual(not_inspected, [...GUARDIAN_CHECKS]);
  for (const check of verdict.checks) assert.equal(check.verdict, 'NOT_RUN', `${check.check} must be NOT_RUN`);
  assert.match(verdict.reason, /§36 Candidate → Repair: 0 check\(s\) failed, 7 could not be run/);
});

test('a fully evidenced candidate is released with every check named', () => {
  const { verdict, not_inspected } = evaluateGuardian(passingContext());
  assert.equal(verdict.verdict, 'ACCEPTED');
  assert.equal(verdict.released, true);
  assert.deepEqual(verdict.blocking, []);
  assert.deepEqual(not_inspected, []);
  assert.deepEqual(verdict.checks.map((entry) => entry.check), [...GUARDIAN_CHECKS]);
  assert.ok(verdict.checks.every((entry) => entry.verdict === 'PASS'));
  assert.equal(verdict.reason, '§36 every required check passed (7)');
  assert.deepEqual(checkOf(verdict, 'SECRET_SCAN').reasons, ['1 file(s) scanned, no credential shapes']);
  assert.deepEqual(checkOf(verdict, 'DESTRUCTIVE_CHANGE_CHECK').inspected, ['no removals in the change set']);
});

test('a partial context reports exactly what is still owed', () => {
  const { not_inspected } = evaluateGuardian({ goal: passingContext().goal });
  assert.equal(not_inspected.length, 6);
  assert.ok(!not_inspected.includes('GOAL_COMPLIANCE'));
  assert.ok(not_inspected.includes('EVIDENCE_COMPLETENESS'));
});

test('a removal check that could not run is NOT_RUN, never PASS', () => {
  const { verdict, not_inspected } = evaluateGuardian(passingContext({
    destructive: { deleted_files: [], deleted_tests: [], removed_scripts: [], approved_by_owner: [], unchecked: ['git could not enumerate the change set'] },
  }));
  const check = checkOf(verdict, 'DESTRUCTIVE_CHANGE_CHECK');
  assert.equal(check.verdict, 'NOT_RUN');
  assert.deepEqual(check.reasons, ['git could not enumerate the change set']);
  assert.ok(not_inspected.includes('DESTRUCTIVE_CHANGE_CHECK'));
  assert.equal(verdict.released, false);
  assert.match(verdict.reason, /1 could not be run/);
});

test('unapproved removals fail the destructive-change check and name the kind', () => {
  const { verdict } = evaluateGuardian(passingContext({
    destructive: { deleted_files: ['a.mjs'], deleted_tests: [], removed_scripts: ['b.cjs'], approved_by_owner: ['a.mjs'] },
  }));
  const check = checkOf(verdict, 'DESTRUCTIVE_CHANGE_CHECK');
  assert.equal(check.verdict, 'FAIL');
  assert.deepEqual(check.reasons, ['script b.cjs was removed without an Owner approval']);
  assert.deepEqual(check.inspected, ['removed:a.mjs', 'removed:b.cjs']);
});

test('coverage below 100% fails and reports the ratio', () => {
  const { verdict } = evaluateGuardian(passingContext({
    coverage: { required: ['R1', 'R2'], covered: ['R1'], unimplemented: [] },
  }));
  const check = checkOf(verdict, 'REQUIREMENT_COVERAGE');
  assert.equal(check.verdict, 'FAIL');
  assert.deepEqual(check.reasons, ['R2 has no binding', 'coverage 50% is below 100%']);
});

test('an empty goal fails even when requirements are listed', () => {
  const { verdict } = evaluateGuardian(passingContext({
    goal: { text: '   ', served_by_requirements: ['R1'], deliverables: [] },
  }));
  const check = checkOf(verdict, 'GOAL_COMPLIANCE');
  assert.equal(check.verdict, 'FAIL');
  assert.deepEqual(check.reasons, ['the goal is empty']);
});

test('a deliverable with no serving requirement fails the goal check', () => {
  const { verdict } = evaluateGuardian(passingContext({
    goal: { text: 'ship it', served_by_requirements: [], deliverables: ['the core'] },
  }));
  const check = checkOf(verdict, 'GOAL_COMPLIANCE');
  assert.equal(check.verdict, 'FAIL');
  assert.deepEqual(check.reasons, [
    'no requirement serves the goal, so nothing the candidate did is traceable to it',
    'deliverable "the core" has no serving requirement',
  ]);
});

test('scope violations and refusals fail the scope check', () => {
  const { verdict } = evaluateGuardian(passingContext({
    scope: { allowed_files: ['a.mjs'], written_files: ['a.mjs', 'b.mjs'], refused: ['delete of c.mjs'] },
  }));
  const check = checkOf(verdict, 'SCOPE_VALIDATION');
  assert.equal(check.verdict, 'FAIL');
  assert.deepEqual(check.reasons, ['b.mjs was written outside the granted scope', 'a change unit was refused: delete of c.mjs']);
});

test('an empty evidence ledger fails completeness even with nothing outstanding', () => {
  const { verdict } = evaluateGuardian(passingContext({
    evidence: { outstanding_requirements: [], failed_requirements: [], ledger_rows: 0, review_covered: true },
  }));
  const check = checkOf(verdict, 'EVIDENCE_COMPLETENESS');
  assert.equal(check.verdict, 'FAIL');
  assert.deepEqual(check.reasons, ['the ledger holds no rows at all']);
});

test("an Owner override must be lexically reflected in the work", () => {
  const reflected = evaluateGuardian(passingContext({
    overrides: [{ text: 'use postgres', supersedes: [], expected_in_requirements: ['postgres database'] }],
    obligations: ['we will use a postgres database'],
  }));
  assert.equal(checkOf(reflected.verdict, 'OWNER_OVERRIDE_COMPLIANCE').verdict, 'PASS');

  const ignored = evaluateGuardian(passingContext({
    overrides: [{ text: 'use postgres', supersedes: [], expected_in_requirements: ['postgres database'] }],
    obligations: ['we will use mysql'],
  }));
  const check = checkOf(ignored.verdict, 'OWNER_OVERRIDE_COMPLIANCE');
  assert.equal(check.verdict, 'FAIL');
  assert.equal(check.reasons.length, 1);
  assert.match(check.reasons[0], /is not reflected/);

  const none = evaluateGuardian(passingContext({ overrides: [] }));
  assert.deepEqual(checkOf(none.verdict, 'OWNER_OVERRIDE_COMPLIANCE').inspected, ['no override was recorded']);
});

test('a touched theme lane requires the four theme checks even when nothing was read', () => {
  const { verdict, not_inspected } = evaluateGuardian(passingContext({ theme_required: true }));
  assert.deepEqual(verdict.checks.map((entry) => entry.check), [...GUARDIAN_CHECKS, ...THEME_GUARDIAN_CHECKS]);
  assert.equal(verdict.released, false);
  for (const check of THEME_GUARDIAN_CHECKS) {
    assert.equal(checkOf(verdict, check).verdict, 'NOT_RUN');
    assert.ok(not_inspected.includes(check));
  }
  assert.match(verdict.reason, /4 could not be run/);
});

test('readable theme packages produce real theme verdicts', () => {
  const clean = evaluateGuardian(passingContext({
    themes: [{ id: 't1', references_other_theme: false, error_diagnostics: 0, executable_payload_diagnostics: 0, fallback_plan_valid: true, built_in: true, built_in_intact: true }],
  }));
  assert.equal(clean.verdict.released, true);
  assert.equal(clean.verdict.reason, '§36 every required check passed (11)');

  const dirty = evaluateGuardian(passingContext({
    themes: [{ id: 't1', references_other_theme: true, error_diagnostics: 2, executable_payload_diagnostics: 1, fallback_plan_valid: false, built_in: true, built_in_intact: false }],
  }));
  assert.equal(checkOf(dirty.verdict, 'THEME_ISOLATION').verdict, 'FAIL');
  assert.equal(checkOf(dirty.verdict, 'FALLBACK_VALIDATION').verdict, 'FAIL');
  assert.equal(checkOf(dirty.verdict, 'NO_EXECUTABLE_PAYLOAD').verdict, 'FAIL');
  assert.equal(checkOf(dirty.verdict, 'BUILT_IN_THEME_INTEGRITY').verdict, 'FAIL');
  assert.deepEqual(checkOf(dirty.verdict, 'BUILT_IN_THEME_INTEGRITY').reasons, ['built-in theme t1 is not intact']);
  assert.equal(dirty.verdict.released, false);
});

test('a non-built-in theme with diagnostics is not judged on built-in integrity', () => {
  const { verdict } = evaluateGuardian(passingContext({
    themes: [{ id: 't1', references_other_theme: false, error_diagnostics: 5, executable_payload_diagnostics: 0, fallback_plan_valid: true, built_in: false, built_in_intact: false }],
  }));
  assert.equal(checkOf(verdict, 'BUILT_IN_THEME_INTEGRITY').verdict, 'PASS');
});

test('termsOf keeps runs of four or more alphanumerics and deduplicates', () => {
  assert.deepEqual(termsOf('Ship the CORE core 42 times'), ['ship', 'core', 'times']);
  assert.deepEqual(termsOf('abc ab12'), ['ab12']);
  assert.deepEqual(termsOf(''), []);
});

test('the result factories shape their inputs', () => {
  assert.deepEqual(guardianCheckResult({ check: 'SECRET_SCAN', verdict: 'PASS' }), { check: 'SECRET_SCAN', verdict: 'PASS', inspected: [], reasons: [] });
  assert.deepEqual(guardianVerdict({ verdict: 'REPAIR', released: false, reason: 'x' }), { verdict: 'REPAIR', checks: [], blocking: [], released: false, reason: 'x' });
});
