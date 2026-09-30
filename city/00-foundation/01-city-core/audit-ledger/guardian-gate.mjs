/**
 * UTOPIA · City Core — the Guardian gate (§36).
 *
 * Ported from the Codex-Boss donor `src/shared/candidate-gate.ts` §36 @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The donor's doctrine is carried over exactly, and it is the reason this module
 * is worth migrating rather than re-inventing:
 *
 *   - a check whose observations are missing is NOT_RUN, and NOT_RUN is a blocker
 *     rather than a pass;
 *   - ACCEPTED is unreachable without a named verdict for every required check, so
 *     a task can never award itself a release;
 *   - a removal check that COULD NOT RUN is reported NOT_RUN, never PASS: "git could
 *     not tell us what was deleted" and "nothing was deleted" must not collapse
 *     into the same clean verdict;
 *   - an Owner override is checked lexically — some obligation must carry at least
 *     half of the override's own significant terms — because that is what
 *     "reflected in the work" can mean without a semantic reader. Nothing here
 *     consults a model's opinion of its own work.
 *
 * Pure: no fs, no git, no network, no clock, no process. Every observation is
 * supplied by the caller, and an omission is treated as "not inspected".
 */

import {
  CHECK_VERDICTS,
  GUARDIAN_CHECKS,
  REQUIREMENT_COVERAGE_RATIO,
  THEME_GUARDIAN_CHECKS,
  guardianCheckResult,
} from './contracts.mjs';

/**
 * Significant terms of a phrase, used by the lexical compliance checks. The
 * donor's exact rule: lower-case (locale-aware), keep runs of four or more
 * alphanumerics, deduplicate.
 */
export function termsOf(text) {
  return [...new Set(String(text).toLocaleLowerCase().match(/[a-z0-9]{4,}/g) ?? [])];
}

/** Which checks this candidate faces: the seven, plus four for a theme change. */
export function requiredGuardianChecks(context) {
  return context.themes?.length || context.theme_required
    ? [...GUARDIAN_CHECKS, ...THEME_GUARDIAN_CHECKS]
    : [...GUARDIAN_CHECKS];
}

/**
 * §36: the check a task cannot perform on itself.
 *
 * Returns the verdict plus the list of checks the context could not answer, so a
 * caller can see exactly what evidence it still owes instead of inferring it from
 * the blocked check ids.
 */
export function evaluateGuardian(context) {
  const checks = [];
  const notInspected = [];

  // GOAL_COMPLIANCE
  if (!context.goal) {
    checks.push(guardianCheckResult({ check: 'GOAL_COMPLIANCE', verdict: 'NOT_RUN', reasons: ['the compiled goal was not supplied to the Guardian'] }));
    notInspected.push('GOAL_COMPLIANCE');
  } else {
    const served = context.goal.served_by_requirements;
    const problems = [];
    if (!context.goal.text.trim()) problems.push('the goal is empty');
    if (!served.length) problems.push('no requirement serves the goal, so nothing the candidate did is traceable to it');
    for (const deliverable of context.goal.deliverables) {
      if (!served.some((requirement) => requirement.length > 0)) {
        problems.push(`deliverable "${deliverable.slice(0, 60)}" has no serving requirement`);
      }
    }
    checks.push(guardianCheckResult({
      check: 'GOAL_COMPLIANCE',
      verdict: problems.length ? 'FAIL' : 'PASS',
      inspected: [`goal:${context.goal.text.slice(0, 60)}`, ...served.slice(0, 6)],
      reasons: problems.length ? problems : ['every deliverable is traceable to a requirement'],
    }));
  }

  // REQUIREMENT_COVERAGE
  if (!context.coverage) {
    checks.push(guardianCheckResult({ check: 'REQUIREMENT_COVERAGE', verdict: 'NOT_RUN', reasons: ['requirement bindings were not supplied'] }));
    notInspected.push('REQUIREMENT_COVERAGE');
  } else {
    const required = context.coverage.required;
    const covered = new Set(context.coverage.covered);
    const missing = required.filter((requirement) => !covered.has(requirement));
    const unimplemented = context.coverage.unimplemented;
    const problems = [
      ...missing.map((requirement) => `${requirement} has no binding`),
      ...unimplemented.map((requirement) => `${requirement} is not implemented`),
    ];
    const ratio = required.length ? (required.length - missing.length) / required.length : 1;
    if (ratio < REQUIREMENT_COVERAGE_RATIO) problems.push(`coverage ${(ratio * 100).toFixed(0)}% is below 100%`);
    checks.push(guardianCheckResult({
      check: 'REQUIREMENT_COVERAGE',
      verdict: problems.length ? 'FAIL' : 'PASS',
      inspected: [`required:${required.length}`, `covered:${covered.size}`],
      reasons: problems.length ? problems : ['every requirement is bound and implemented'],
    }));
  }

  // SECRET_SCAN
  if (!context.secrets) {
    checks.push(guardianCheckResult({ check: 'SECRET_SCAN', verdict: 'NOT_RUN', reasons: ['no file was scanned for credentials'] }));
    notInspected.push('SECRET_SCAN');
  } else {
    const problems = context.secrets.hits.map((hit) => `${hit.path} contains ${hit.shapes.join(', ')}`);
    checks.push(guardianCheckResult({
      check: 'SECRET_SCAN',
      verdict: problems.length ? 'FAIL' : 'PASS',
      inspected: context.secrets.scanned_files.map((file) => `scanned:${file}`),
      reasons: problems.length ? problems : [`${context.secrets.scanned_files.length} file(s) scanned, no credential shapes`],
    }));
  }

  // SCOPE_VALIDATION
  if (!context.scope) {
    checks.push(guardianCheckResult({ check: 'SCOPE_VALIDATION', verdict: 'NOT_RUN', reasons: ['the granted scope was not supplied'] }));
    notInspected.push('SCOPE_VALIDATION');
  } else {
    const allowed = context.scope.allowed_files;
    const outside = context.scope.written_files.filter((file) => !allowed.includes(file));
    const problems = [
      ...outside.map((file) => `${file} was written outside the granted scope`),
      ...context.scope.refused.map((problem) => `a change unit was refused: ${problem}`),
    ];
    checks.push(guardianCheckResult({
      check: 'SCOPE_VALIDATION',
      verdict: problems.length ? 'FAIL' : 'PASS',
      inspected: [`allowed:${allowed.length}`, `written:${context.scope.written_files.length}`],
      reasons: problems.length ? problems : ['every written file was inside the grant'],
    }));
  }

  // EVIDENCE_COMPLETENESS
  if (!context.evidence) {
    checks.push(guardianCheckResult({ check: 'EVIDENCE_COMPLETENESS', verdict: 'NOT_RUN', reasons: ['the evidence ledger was not supplied'] }));
    notInspected.push('EVIDENCE_COMPLETENESS');
  } else {
    const problems = [
      ...context.evidence.outstanding_requirements.map((requirement) => `${requirement} is still owed evidence`),
      ...context.evidence.failed_requirements.map((requirement) => `${requirement} failed verification`),
      ...(context.evidence.ledger_rows === 0 ? ['the ledger holds no rows at all'] : []),
      ...(context.evidence.review_covered ? [] : ['the review did not cover every required dimension']),
    ];
    checks.push(guardianCheckResult({
      check: 'EVIDENCE_COMPLETENESS',
      verdict: problems.length ? 'FAIL' : 'PASS',
      inspected: [`ledger_rows:${context.evidence.ledger_rows}`, `review_covered:${context.evidence.review_covered}`],
      reasons: problems.length ? problems : ['every requirement has passing evidence and the review covered its dimensions'],
    }));
  }

  // DESTRUCTIVE_CHANGE_CHECK
  if (!context.destructive) {
    checks.push(guardianCheckResult({ check: 'DESTRUCTIVE_CHANGE_CHECK', verdict: 'NOT_RUN', reasons: ['the change set was not inspected for removals'] }));
    notInspected.push('DESTRUCTIVE_CHANGE_CHECK');
  } else if ((context.destructive.unchecked ?? []).length) {
    // The host had lists to offer but could not fill them: the check did not run,
    // and saying PASS here would be the gate claiming a removal check it never did.
    checks.push(guardianCheckResult({ check: 'DESTRUCTIVE_CHANGE_CHECK', verdict: 'NOT_RUN', reasons: context.destructive.unchecked }));
    notInspected.push('DESTRUCTIVE_CHANGE_CHECK');
  } else {
    const approved = new Set(context.destructive.approved_by_owner);
    const removals = [
      ...context.destructive.deleted_files.map((file) => ({ file, kind: 'file' })),
      ...context.destructive.deleted_tests.map((file) => ({ file, kind: 'test' })),
      ...context.destructive.removed_scripts.map((script) => ({ file: script, kind: 'script' })),
    ];
    const unapproved = removals.filter((removal) => !approved.has(removal.file));
    const problems = unapproved.map((removal) => `${removal.kind} ${removal.file} was removed without an Owner approval`);
    checks.push(guardianCheckResult({
      check: 'DESTRUCTIVE_CHANGE_CHECK',
      verdict: problems.length ? 'FAIL' : 'PASS',
      inspected: removals.length ? removals.map((removal) => `removed:${removal.file}`) : ['no removals in the change set'],
      reasons: problems.length ? problems : ['removals, if any, are Owner-approved'],
    }));
  }

  // OWNER_OVERRIDE_COMPLIANCE
  if (!context.overrides) {
    checks.push(guardianCheckResult({ check: 'OWNER_OVERRIDE_COMPLIANCE', verdict: 'NOT_RUN', reasons: ["the contract's overrides were not supplied"] }));
    notInspected.push('OWNER_OVERRIDE_COMPLIANCE');
  } else {
    const obligations = (context.obligations ?? []).map((obligation) => ({ text: obligation, terms: termsOf(obligation) }));
    const problems = [];
    for (const override of context.overrides) {
      for (const expected of override.expected_in_requirements) {
        const wanted = termsOf(expected);
        if (!wanted.length) continue;
        const reflected = obligations.some((obligation) => {
          const shared = wanted.filter((term) => obligation.terms.includes(term)).length;
          return shared >= Math.max(1, Math.ceil(wanted.length / 2));
        });
        if (!reflected) {
          problems.push(`the Owner's override (${override.text.slice(0, 50)}) is not reflected: nothing serves "${expected.slice(0, 50)}"`);
        }
      }
    }
    checks.push(guardianCheckResult({
      check: 'OWNER_OVERRIDE_COMPLIANCE',
      verdict: problems.length ? 'FAIL' : 'PASS',
      inspected: context.overrides.length
        ? context.overrides.map((override) => `override:${override.text.slice(0, 40)}`)
        : ['no override was recorded'],
      reasons: problems.length ? problems : ['every recorded override is reflected in the work'],
    }));
  }

  // §36's theme checks (required whenever a theme lane was touched, readable or not)
  if (context.themes?.length || context.theme_required) {
    const themes = context.themes ?? [];
    if (!themes.length) {
      for (const check of THEME_GUARDIAN_CHECKS) {
        checks.push(guardianCheckResult({ check, verdict: 'NOT_RUN', reasons: ['the candidate touched a theme but no theme package was read for this check'] }));
        notInspected.push(check);
      }
    } else {
      checks.push(themeCheck('THEME_ISOLATION', themes, (theme) => (theme.references_other_theme ? [`theme ${theme.id} references another theme package`] : []), (theme) => [`theme:${theme.id}`], 'every theme package is self-contained'));
      checks.push(themeCheck('FALLBACK_VALIDATION', themes, (theme) => (theme.fallback_plan_valid ? [] : [`theme ${theme.id} has no valid fallback plan`]), (theme) => [`fallback_plan_valid:${theme.id}:${theme.fallback_plan_valid}`], 'each theme has a valid fallback plan'));
      checks.push(themeCheck('NO_EXECUTABLE_PAYLOAD', themes, (theme) => (theme.executable_payload_diagnostics > 0 ? [`theme ${theme.id} carries ${theme.executable_payload_diagnostics} executable-content diagnostic(s)`] : []), (theme) => [`executable_payload:${theme.id}:${theme.executable_payload_diagnostics}`], 'no theme carries executable content'));
      checks.push(themeCheck('BUILT_IN_THEME_INTEGRITY', themes, (theme) => (theme.built_in && (!theme.built_in_intact || theme.error_diagnostics > 0) ? [`built-in theme ${theme.id} is not intact`] : []), (theme) => [`built_in:${theme.id}:${theme.built_in_intact}`], 'built-in themes are locked and valid'));
    }
  }

  const required = requiredGuardianChecks(context);
  const forRequired = required.map((check) => checks.find((entry) => entry.check === check) ?? guardianCheckResult({ check, verdict: 'NOT_RUN', reasons: [`${check} was never evaluated`] }));
  const blocking = forRequired.filter((check) => check.verdict !== 'PASS').map((check) => check.check);
  const released = blocking.length === 0;
  const failed = forRequired.filter((check) => check.verdict === 'FAIL').length;
  const unrun = forRequired.filter((check) => check.verdict === 'NOT_RUN').length;

  return {
    verdict: {
      verdict: released ? 'ACCEPTED' : 'REPAIR',
      checks: forRequired,
      blocking,
      released,
      reason: released
        ? `§36 every required check passed (${forRequired.length})`
        : `§36 Candidate → Repair: ${failed} check(s) failed, ${unrun} could not be run${blocking.length ? ` (${blocking.join(', ')})` : ''}`,
    },
    not_inspected: notInspected,
  };
}

function themeCheck(check, themes, problemsOf, inspectedOf, passReason) {
  const problems = themes.flatMap(problemsOf);
  return guardianCheckResult({
    check,
    verdict: problems.length ? 'FAIL' : 'PASS',
    inspected: themes.flatMap(inspectedOf),
    reasons: problems.length ? problems : [passReason],
  });
}

/** Exported so a caller can assert the vocabulary it is expected to answer. */
export { CHECK_VERDICTS, GUARDIAN_CHECKS, THEME_GUARDIAN_CHECKS };
