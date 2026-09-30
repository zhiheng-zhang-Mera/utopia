/**
 * UTOPIA · City · Project Foreman — the §33 failure-class / recovery-ladder model.
 *
 * These tests pin the behaviour ported from `Codex-Boss` `src/shared/recovery.ts`
 * at the frozen commit in `DONOR.json`. Every case names real input, because the
 * whole point of §33.1 is that a class comes from evidence and not from a guess:
 *
 *  * every failure class, and the exact input that selects it;
 *  * the precedence between overlapping CLASS_RULES, which is the donor's order;
 *  * the recovery plan for a failure of each class, budgets included;
 *  * the ladder being consumed, exhausted and terminated at the Hard Blocker;
 *  * determinism, and the refusal of a malformed or unknown-class record.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceRecovery,
  classifyFailure,
  FAILURE_CLASSES,
  HNS_ROLES,
  MAX_CONSECUTIVE_HNS_CALLS,
  planHnsFallback,
  planRecovery,
  RECOVERY_ORDER,
  RECOVERY_RULES,
  recordHnsUsage,
  THEME_RECOVERY_STEPS,
} from '../failure-recovery.mjs';

/** The donor's §33.1 class vocabulary, spelled out so a rename cannot pass. */
const DONOR_CLASSES = [
  'TRANSIENT', 'TERMINAL', 'DEPENDENCY', 'AUTH', 'RATE_LIMIT', 'PROVIDER_PAGE',
  'WORKSPACE', 'BUILD', 'TEST', 'ENVIRONMENT', 'THEME', 'UI', 'UNKNOWN',
];

/**
 * One exact input per class, taken from the donor's own CLASS_RULES patterns.
 * `signal` is the first pattern source the donor reports for that input.
 */
const CLASS_EVIDENCE = [
  {
    failure_class: 'TERMINAL',
    observation: { policy_refusal: 'GUARDIAN_DENIED', detail: 'timed out while submitting' },
    confidence: 1,
    severity: 'CRITICAL',
    signal: 'policy_refusal:GUARDIAN_DENIED',
  },
  {
    failure_class: 'AUTH',
    observation: { detail: '401 unauthorized: login expired' },
    confidence: 0.95,
    severity: 'HIGH',
    signal: 'output:\\b401\\b',
  },
  {
    failure_class: 'RATE_LIMIT',
    observation: { detail: '429 Too Many Requests' },
    confidence: 0.95,
    severity: 'MEDIUM',
    signal: 'output:\\b429\\b',
  },
  {
    failure_class: 'PROVIDER_PAGE',
    observation: { detail: 'selector not found for the send button' },
    confidence: 0.9,
    severity: 'MEDIUM',
    signal: 'output:selector not found',
  },
  {
    failure_class: 'DEPENDENCY',
    observation: { detail: "Error: Cannot find module 'left-pad'", workspace: { missing_modules: ['left-pad'] } },
    confidence: 0.9,
    severity: 'MEDIUM',
    signal: 'output:cannot find module',
  },
  {
    failure_class: 'ENVIRONMENT',
    observation: { detail: 'EPERM: operation not permitted' },
    confidence: 0.85,
    severity: 'HIGH',
    signal: 'output:EPERM',
  },
  {
    failure_class: 'WORKSPACE',
    observation: { detail: 'src/x.ts is outside the granted scope', workspace: { scope_refused: true } },
    confidence: 0.9,
    severity: 'HIGH',
    signal: 'output:outside the granted scope',
  },
  {
    failure_class: 'THEME',
    observation: { detail: 'theme validation failed: SCRIPT_INJECTION', theme_error_diagnostics: 2 },
    confidence: 0.9,
    severity: 'MEDIUM',
    signal: 'output:theme (validation|registry)',
  },
  {
    failure_class: 'UI',
    observation: { detail: 'NO_CATASTROPHIC_OVERFLOW failed', visual_failed: true, gate: 'VISUAL' },
    confidence: 0.85,
    severity: 'MEDIUM',
    signal: 'output:overflow',
  },
  {
    failure_class: 'BUILD',
    observation: { detail: "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'." },
    confidence: 0.85,
    severity: 'MEDIUM',
    signal: 'output:error TS\\d{4}',
  },
  {
    failure_class: 'TEST',
    observation: { detail: 'AssertionError: expected 1 to equal 2' },
    confidence: 0.85,
    severity: 'MEDIUM',
    signal: 'output:assertionerror',
  },
  {
    failure_class: 'TRANSIENT',
    observation: { detail: 'Timeout awaiting response: request timed out' },
    confidence: 0.7,
    severity: 'LOW',
    signal: 'output:TIMEOUT',
  },
];

/** Every class the donor's RECOVERY_RULES names, with the step budgets it gives. */
const EXPECTED_BUDGETS = {
  TRANSIENT: { NATIVE_RETRY: 2, LOCAL_RECOVERY: 1 },
  TERMINAL: {},
  DEPENDENCY: { LOCAL_RECOVERY: 2, ALTERNATE_INTERNAL_PATH: 1 },
  AUTH: { ALTERNATE_PROVIDER: 1 },
  RATE_LIMIT: { NATIVE_RETRY: 1, ALTERNATE_PROVIDER: 2, DEGRADED_MODE: 1 },
  PROVIDER_PAGE: { LOCAL_RECOVERY: 2, ALTERNATE_INTERNAL_PATH: 1, ALTERNATE_PROVIDER: 1 },
  WORKSPACE: { LOCAL_RECOVERY: 2 },
  BUILD: { LOCAL_RECOVERY: 3 },
  TEST: { LOCAL_RECOVERY: 3 },
  ENVIRONMENT: { LOCAL_RECOVERY: 2, DEGRADED_MODE: 1 },
  THEME: { LOCAL_RECOVERY: 2, DEGRADED_MODE: 1 },
  UI: { LOCAL_RECOVERY: 3 },
  UNKNOWN: { NATIVE_RETRY: 1, LOCAL_RECOVERY: 1, ALTERNATE_INTERNAL_PATH: 1 },
};

/** The class each exact input selects. */
const observationFor = (failureClass) => {
  if (failureClass === 'UNKNOWN') return {};
  return CLASS_EVIDENCE.find((entry) => entry.failure_class === failureClass).observation;
};

/* ------------------------------------------------------------------ *
 * §33.1 failure classification
 * ------------------------------------------------------------------ */

test('the §33.1 vocabulary is the donor\'s closed set of thirteen classes', () => {
  assert.deepEqual([...FAILURE_CLASSES], DONOR_CLASSES);
  assert.ok(FAILURE_CLASSES.length >= 12, '§33.1 wants at least twelve classes');
});

test('every failure class is selected by its own exact input', () => {
  for (const entry of CLASS_EVIDENCE) {
    const classified = classifyFailure(entry.observation);
    assert.equal(classified.failure_class, entry.failure_class, `${entry.failure_class} input was classified as ${classified.failure_class}`);
    assert.equal(classified.confidence, entry.confidence, `${entry.failure_class} confidence`);
    assert.equal(classified.severity, entry.severity, `${entry.failure_class} severity`);
    assert.ok(classified.reason.length > 0, `${entry.failure_class} carries a reason`);
    assert.ok(
      classified.signals.some((signal) => signal.startsWith('output:') || signal.startsWith('policy_refusal:')),
      `${entry.failure_class} reports the evidence signal that decided it`,
    );
    assert.equal(classified.signals[0], entry.signal, `${entry.failure_class} first signal`);
  }
});

test('an unknown-class input selects no pattern and the signals stay empty', () => {
  const classified = classifyFailure({ detail: 'something went sideways' });
  assert.equal(classified.failure_class, 'UNKNOWN');
  assert.equal(classified.confidence, 0.1);
  assert.equal(classified.severity, 'MEDIUM');
  assert.equal(classified.reason, 'no gate, runtime code or output signal was available to classify this failure');
  assert.deepEqual(classified.signals, []);
});

test('a non-zero exit with a runtime code but no prose is still classified', () => {
  const classified = classifyFailure({ exit_code: 429, runtime_code: 'RATE_LIMITED' });
  assert.equal(classified.failure_class, 'RATE_LIMIT');
  assert.deepEqual(classified.signals, ['output:RATE_LIMITED']);
});

/* §33.1 precedence: the CLASS_RULES order is the contract. */

test('a policy refusal is decided before any prose, even a retryable-looking one', () => {
  // "timed out" alone is TRANSIENT; the refusal is decided first and wins.
  assert.equal(classifyFailure({ detail: 'timed out while submitting' }).failure_class, 'TRANSIENT');
  const refused = classifyFailure({ detail: 'timed out while submitting', policy_refusal: 'GUARDIAN_DENIED' });
  assert.equal(refused.failure_class, 'TERMINAL');
  assert.equal(refused.severity, 'CRITICAL');
  assert.deepEqual(refused.signals, ['policy_refusal:GUARDIAN_DENIED']);
});

test('a policy refusal is also decided before a runtime code', () => {
  const refused = classifyFailure({ runtime_code: 'RATE_LIMITED', policy_refusal: 'POLICY' });
  assert.equal(refused.failure_class, 'TERMINAL');
  assert.deepEqual(refused.signals, ['policy_refusal:POLICY']);
});

test('AUTH is decided before RATE_LIMIT when the output carries both', () => {
  // AUTH (rule 2) precedes RATE_LIMIT (rule 3): a 429 wrapper around a 401 must
  // still be answered by signing in.
  const classified = classifyFailure({ detail: '429 Too Many Requests: 401 unauthorized' });
  assert.equal(classified.failure_class, 'AUTH');
});

test('PROVIDER_PAGE is decided before the generic BUILD wording in a provider log', () => {
  const classified = classifyFailure({ detail: 'PAGE_CHANGED: vite build error in the adapter' });
  assert.equal(classified.failure_class, 'PROVIDER_PAGE');
  assert.deepEqual(classified.signals, ['output:PAGE_CHANGED']);
});

test('DEPENDENCY is decided before BUILD, but only when the host agrees the module is absent', () => {
  const absent = classifyFailure({ detail: "Cannot find module 'left-pad'" });
  assert.equal(absent.failure_class, 'DEPENDENCY');
  assert.deepEqual(absent.signals, ['output:cannot find module']);
  // A present module cannot be a dependency failure: the rule's requires() is false,
  // the rule is skipped, and the next matching evidence decides.
  const present = classifyFailure({ detail: "Cannot find module 'left-pad'", workspace: { missing_modules: [] } });
  assert.equal(present.failure_class, 'UNKNOWN');
  const presentWithGate = classifyFailure({ detail: "Cannot find module 'left-pad'", workspace: { missing_modules: [] }, gate: 'TYPECHECK' });
  assert.equal(presentWithGate.failure_class, 'BUILD');
  assert.equal(presentWithGate.confidence, 0.5);
  assert.ok(presentWithGate.reason.includes('the TYPECHECK gate failed'));
});

test('DEPENDENCY reports the verified missing modules in its signals', () => {
  const classified = classifyFailure({ detail: "Error: Cannot find module 'left-pad'", workspace: { missing_modules: ['left-pad'] } });
  assert.ok(classified.signals.includes('workspace:missing_modules=left-pad'));
});

test('ENVIRONMENT is decided before BUILD and before the generic test wording', () => {
  const classified = classifyFailure({ detail: 'ENOSPC: build failed, no space left on device' });
  assert.equal(classified.failure_class, 'ENVIRONMENT');
});

test('WORKSPACE is decided from the host fact, and requires() is what gates it', () => {
  // With no workspace facts at all, the donor's requires() is satisfied
  // (observation.workspace === undefined), so the wording alone decides.
  assert.equal(classifyFailure({ detail: 'src/x.ts is outside the granted scope' }).failure_class, 'WORKSPACE');
  // With facts present and none of the three flags set, requires() is false, the
  // rule is skipped, and the leftover evidence is the gate.
  const withoutFact = classifyFailure({ detail: 'src/x.ts is outside the granted scope', workspace: {} });
  assert.equal(withoutFact.failure_class, 'UNKNOWN');
  const withFact = classifyFailure({ detail: 'src/x.ts is outside the granted scope', workspace: { scope_refused: true } });
  assert.equal(withFact.failure_class, 'WORKSPACE');
  assert.ok(withFact.signals.includes('workspace:scope_refused'));
  assert.equal(classifyFailure({ detail: 'symlink escapes the workspace root', workspace: { escaped_path: true } }).failure_class, 'WORKSPACE');
  assert.equal(classifyFailure({ detail: 'protected workspace metadata', workspace: { protected_path: true } }).failure_class, 'WORKSPACE');
});

test('THEME needs a diagnostic or an unknown gate, not the wording alone', () => {
  const bare = classifyFailure({ detail: 'SCRIPT_INJECTION' });
  assert.equal(bare.failure_class, 'THEME');
  const withDiagnostics = classifyFailure({ detail: 'SCRIPT_INJECTION', theme_error_diagnostics: 2 });
  assert.equal(withDiagnostics.failure_class, 'THEME');
  assert.ok(withDiagnostics.signals.includes('theme:error_diagnostics=2'));
  // With a gate present and no diagnostics, THEME's requires() is false and the
  // gate is the remaining evidence.
  const gated = classifyFailure({ detail: 'SCRIPT_INJECTION', theme_error_diagnostics: 0, gate: 'VISUAL' });
  assert.equal(gated.failure_class, 'UI');
});

test('UI needs the visual fact or one of the three interface gates', () => {
  for (const gate of ['VISUAL', 'BLACKBOX', 'RUNTIME']) {
    assert.equal(classifyFailure({ detail: 'not visible', gate }).failure_class, 'UI', `gate ${gate}`);
  }
  const visual = classifyFailure({ detail: 'not visible', visual_failed: true });
  assert.equal(visual.failure_class, 'UI');
});

test('BUILD is decided before TEST when the output carries both', () => {
  const classified = classifyFailure({ detail: 'error TS2322 while running the failing test' });
  assert.equal(classified.failure_class, 'BUILD');
});

test('BUILD is decided before TRANSIENT when a failed build times out', () => {
  const classified = classifyFailure({ detail: 'Build failed: connection timed out after 30s' });
  assert.equal(classified.failure_class, 'BUILD');
});

test('TEST is decided before TRANSIENT when a failing test also times out', () => {
  const classified = classifyFailure({ detail: 'failing test: the request timed out' });
  assert.equal(classified.failure_class, 'TEST');
  // The donor's TEST pattern needs the fail-word *before* the test-word, so prose
  // that merely mentions a timeout next to a test is TRANSIENT.
  assert.equal(classifyFailure({ detail: 'the test run timed out' }).failure_class, 'TRANSIENT');
});

test('a gate with no recognisable signature is still evidence, and BENCHMARK is honestly UNKNOWN', () => {
  const mapped = classifyFailure({ gate: 'TYPECHECK', detail: 'the tree is angry' });
  assert.equal(mapped.failure_class, 'BUILD');
  assert.equal(mapped.confidence, 0.5);
  assert.deepEqual(mapped.signals, ['gate:TYPECHECK']);
  for (const gate of ['SYNTAX', 'BUILD']) assert.equal(classifyFailure({ gate }).failure_class, 'BUILD');
  for (const gate of ['UNIT', 'MODULE', 'INTEGRATION', 'FULL']) assert.equal(classifyFailure({ gate }).failure_class, 'TEST', `gate ${gate}`);
  const benchmark = classifyFailure({ gate: 'BENCHMARK', detail: 'p95 240ms > 100ms budget' });
  assert.equal(benchmark.failure_class, 'UNKNOWN');
  assert.equal(benchmark.confidence, 0.3);
  assert.ok(benchmark.reason.includes('no class for it'));
});

/* ------------------------------------------------------------------ *
 * §33.2 the recovery plan
 * ------------------------------------------------------------------ */

test('the §33.2 recovery order is the donor\'s and ends at the Hard Blocker', () => {
  assert.deepEqual([...RECOVERY_ORDER], [
    'NATIVE_RETRY', 'LOCAL_RECOVERY', 'ALTERNATE_INTERNAL_PATH', 'ALTERNATE_PROVIDER',
    'DEGRADED_MODE', 'HNS_FALLBACK', 'HARD_BLOCKER',
  ]);
});

test('the theme ladder is the donor\'s three steps', () => {
  assert.deepEqual([...THEME_RECOVERY_STEPS], ['DISABLE_THEME', 'FALLBACK_BUILT_IN_THEME', 'RECORD_DIAGNOSTIC']);
});

test('a plan lists every step with a reason and always ends at the Hard Blocker', () => {
  const plan = planRecovery(classifyFailure({ detail: 'error TS2322' }));
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.version, 'recovery-1');
  assert.equal(plan.failure_class, 'BUILD');
  assert.equal(plan.severity, 'MEDIUM');
  assert.deepEqual(plan.steps.map((step) => step.step), [...RECOVERY_ORDER]);
  assert.ok(plan.steps.every((step) => typeof step.reason === 'string' && step.reason.length > 0));
  assert.equal(plan.steps.at(-1).step, 'HARD_BLOCKER');
  assert.equal(plan.steps.at(-1).applicable, true);
  assert.equal(plan.steps.at(-1).budget, 1);
  assert.equal(plan.ends_at_hard_blocker, true);
  assert.equal(plan.next, 'LOCAL_RECOVERY');
  assert.equal(plan.hns_allowed, true);
});

test('every class plans the donor\'s budgets, and only those steps are applicable', () => {
  for (const failureClass of DONOR_CLASSES) {
    const plan = planRecovery({ failure_class: failureClass, severity: 'MEDIUM', confidence: 1, reason: 'x', signals: [] });
    const expected = EXPECTED_BUDGETS[failureClass];
    for (const step of plan.steps) {
      if (step.step === 'HARD_BLOCKER') {
        assert.equal(step.budget, 1, `${failureClass} hard blocker budget`);
        assert.equal(step.applicable, true, `${failureClass} hard blocker is applicable`);
        continue;
      }
      // §33.3 fixes HNS at exactly one attempt whenever the class allows it at all,
      // independently of the attempts table.
      const budget = step.step === 'HNS_FALLBACK'
        ? (RECOVERY_RULES[failureClass].hns_allowed ? 1 : 0)
        : expected[step.step] ?? 0;
      assert.equal(step.budget, budget, `${failureClass}/${step.step} budget`);
      assert.equal(step.applicable, budget > 0, `${failureClass}/${step.step} applicability`);
    }
    // The rule table and the plan must agree about the §33.3 HNS route.
    assert.equal(plan.hns_allowed, RECOVERY_RULES[failureClass].hns_allowed, `${failureClass} hns_allowed`);
    const hns = plan.steps.find((step) => step.step === 'HNS_FALLBACK');
    if (plan.hns_allowed) {
      assert.equal(hns.applicable, true, `${failureClass} HNS is applicable when allowed`);
      assert.equal(hns.budget, 1, `${failureClass} HNS is tried once`);
      assert.equal(hns.reason, '§33.3 HNS fallback (an external executor, and a CapabilityGap)');
    } else if (RECOVERY_RULES[failureClass].inapplicable.HNS_FALLBACK) {
      assert.equal(hns.applicable, false);
      assert.equal(hns.reason, RECOVERY_RULES[failureClass].inapplicable.HNS_FALLBACK);
    } else {
      assert.equal(hns.applicable, false);
      assert.equal(hns.reason, '§33.3: HNS is not a recovery route for this failure class');
    }
  }
});

test('a representative failure of each class offers the donor\'s first step', () => {
  const next = (failureClass) =>
    planRecovery(classifyFailure(observationFor(failureClass))).next;
  assert.equal(next('TRANSIENT'), 'NATIVE_RETRY');
  assert.equal(next('DEPENDENCY'), 'LOCAL_RECOVERY');
  assert.equal(next('AUTH'), 'ALTERNATE_PROVIDER');
  assert.equal(next('RATE_LIMIT'), 'NATIVE_RETRY');
  assert.equal(next('PROVIDER_PAGE'), 'LOCAL_RECOVERY');
  assert.equal(next('WORKSPACE'), 'LOCAL_RECOVERY');
  assert.equal(next('BUILD'), 'LOCAL_RECOVERY');
  assert.equal(next('TEST'), 'LOCAL_RECOVERY');
  assert.equal(next('ENVIRONMENT'), 'LOCAL_RECOVERY');
  assert.equal(next('THEME'), 'LOCAL_RECOVERY');
  assert.equal(next('UI'), 'LOCAL_RECOVERY');
  assert.equal(next('UNKNOWN'), 'NATIVE_RETRY');
  // TERMINAL has no applicable step at all.
  assert.equal(next('TERMINAL'), undefined);
});

test('inapplicable steps are listed with the donor\'s own reason', () => {
  const build = planRecovery(classifyFailure({ detail: 'error TS2322' }));
  assert.deepEqual(
    build.steps.filter((step) => !step.applicable).map((step) => [step.step, step.reason]),
    [
      ['NATIVE_RETRY', 'the same source will not compile'],
      ['ALTERNATE_INTERNAL_PATH', 'not needed for this failure class'],
      ['ALTERNATE_PROVIDER', 'a provider cannot fix a compile error in our tree'],
      ['DEGRADED_MODE', 'not needed for this failure class'],
    ],
  );
});

test('a prohibited action goes straight to the Hard Blocker and forbids HNS', () => {
  const plan = planRecovery(classifyFailure({ policy_refusal: 'GUARDIAN_DENIED' }));
  assert.equal(plan.failure_class, 'TERMINAL');
  assert.equal(plan.next, undefined);
  assert.equal(plan.hns_allowed, false);
  assert.equal(plan.requires_owner.kind, 'AUTHORIZATION');
  assert.equal(plan.requires_owner.reason, 'the request was refused by policy; only the Owner can change the goal or authorize it');
  assert.equal(plan.steps.find((step) => step.step === 'HNS_FALLBACK').reason, '§33.3 forbids delegating a prohibited action to HNS');
  assert.ok(plan.steps.find((step) => step.step === 'HNS_FALLBACK').reason.includes('prohibited'));
  assert.deepEqual(plan.diagnostics, ['no recovery step applies; the plan goes straight to the Hard Blocker']);
});

test('an auth failure is handed to the Owner and cannot use HNS', () => {
  const plan = planRecovery(classifyFailure({ detail: '401 unauthorized' }));
  assert.equal(plan.failure_class, 'AUTH');
  assert.equal(plan.requires_owner.kind, 'SIGN_IN');
  assert.equal(plan.requires_owner.reason, 'credentials are expired or rejected; the Owner must sign in');
  assert.equal(plan.next, 'ALTERNATE_PROVIDER');
  assert.equal(plan.steps.find((step) => step.step === 'NATIVE_RETRY').applicable, false);
  assert.equal(plan.hns_allowed, false);
  assert.equal(plan.steps.find((step) => step.step === 'HNS_FALLBACK').reason, '§33.3: HNS is not a recovery route for this failure class');
});

test('a workspace failure escalates the granted scope to the Owner', () => {
  const plan = planRecovery(classifyFailure({ detail: 'src/x.ts is outside the granted scope', workspace: { scope_refused: true } }));
  assert.equal(plan.failure_class, 'WORKSPACE');
  assert.equal(plan.requires_owner.kind, 'AUTHORIZATION');
  assert.equal(plan.requires_owner.reason, 'the granted scope must change; only the Owner can widen it');
  assert.equal(plan.next, 'LOCAL_RECOVERY');
  assert.equal(plan.hns_allowed, false);
});

test('only THEME and WORKSPACE and AUTH and TERMINAL carry requires_owner', () => {
  const owners = Object.fromEntries(
    DONOR_CLASSES.map((failureClass) => [failureClass, RECOVERY_RULES[failureClass].requires_owner?.kind]),
  );
  assert.deepEqual(owners, {
    TRANSIENT: undefined,
    TERMINAL: 'AUTHORIZATION',
    DEPENDENCY: undefined,
    AUTH: 'SIGN_IN',
    RATE_LIMIT: undefined,
    PROVIDER_PAGE: undefined,
    WORKSPACE: 'AUTHORIZATION',
    BUILD: undefined,
    TEST: undefined,
    ENVIRONMENT: undefined,
    THEME: undefined,
    UI: undefined,
    UNKNOWN: undefined,
  });
});

test('a theme failure carries the §33.2 theme ladder and its diagnostic', () => {
  const plan = planRecovery(classifyFailure({ detail: 'theme validation failed', theme_error_diagnostics: 1 }));
  assert.equal(plan.failure_class, 'THEME');
  assert.deepEqual(plan.theme_steps, [...THEME_RECOVERY_STEPS]);
  assert.ok(plan.diagnostics.some((line) => line.includes('theme ladder')));
  const nonTheme = planRecovery(classifyFailure({ detail: 'error TS2322' }));
  assert.equal(nonTheme.theme_steps, undefined);
});

/* ------------------------------------------------------------------ *
 * §33.2 the ladder advances, is consumed, and terminates
 * ------------------------------------------------------------------ */

test('a fresh plan offers its first step with the donor\'s attempt reason', () => {
  const plan = planRecovery(classifyFailure({ detail: 'error TS2322' }));
  const progress = advanceRecovery(plan, []);
  assert.equal(progress.next, 'LOCAL_RECOVERY');
  assert.equal(progress.exhausted, false);
  assert.equal(progress.hard_blocker, false);
  assert.equal(progress.reason, '§33.2 local recovery (repair what is inside our own authority) — attempt 1 of 3');
});

test('a step is re-offered until its budget is used, and not beyond', () => {
  const plan = planRecovery(classifyFailure({ detail: 'error TS2322' }));
  const fail = (step, times) => Array.from({ length: times }, () => ({ step, outcome: 'FAIL' }));
  assert.equal(advanceRecovery(plan, fail('LOCAL_RECOVERY', 1)).reason.endsWith('attempt 2 of 3'), true);
  assert.equal(advanceRecovery(plan, fail('LOCAL_RECOVERY', 1)).next, 'LOCAL_RECOVERY');
  assert.equal(advanceRecovery(plan, fail('LOCAL_RECOVERY', 2)).next, 'LOCAL_RECOVERY');
  assert.equal(advanceRecovery(plan, fail('LOCAL_RECOVERY', 3)).next, 'HNS_FALLBACK');
});

test('a NOT_APPLICABLE attempt does not consume the budget', () => {
  const plan = planRecovery(classifyFailure({ detail: 'error TS2322' }));
  const skipped = [{ step: 'LOCAL_RECOVERY', outcome: 'NOT_APPLICABLE' }, { step: 'LOCAL_RECOVERY', outcome: 'NOT_APPLICABLE' }];
  const progress = advanceRecovery(plan, skipped);
  assert.equal(progress.next, 'LOCAL_RECOVERY');
  assert.equal(progress.reason, '§33.2 local recovery (repair what is inside our own authority) — attempt 1 of 3');
});

test('HNS is never offered while a cheaper applicable step has budget left', () => {
  const plan = planRecovery(classifyFailure({ detail: 'error TS2322' }));
  const one = [{ step: 'LOCAL_RECOVERY', outcome: 'FAIL' }];
  assert.equal(advanceRecovery(plan, one).next, 'LOCAL_RECOVERY');
  const three = [1, 2, 3].map(() => ({ step: 'LOCAL_RECOVERY', outcome: 'FAIL' }));
  assert.equal(advanceRecovery(plan, three).next, 'HNS_FALLBACK');
});

test('the BUILD ladder is consumed and then terminates at the Hard Blocker', () => {
  const plan = planRecovery(classifyFailure({ detail: 'error TS2322' }));
  const three = [1, 2, 3].map(() => ({ step: 'LOCAL_RECOVERY', outcome: 'FAIL' }));
  assert.equal(advanceRecovery(plan, three).next, 'HNS_FALLBACK');
  // §33.3: HNS is tried exactly once.
  const withOne = [...three, { step: 'HNS_FALLBACK', outcome: 'FAIL' }];
  const blocked = advanceRecovery(plan, withOne);
  assert.equal(blocked.next, undefined);
  assert.equal(blocked.hard_blocker, true);
  assert.equal(blocked.exhausted, true);
  assert.equal(blocked.reason, '§33.2 Hard Blocker: every applicable recovery step is exhausted');
  // A second HNS attempt changes nothing: the ladder is already at the blocker.
  const withTwo = [...withOne, { step: 'HNS_FALLBACK', outcome: 'FAIL' }];
  assert.equal(advanceRecovery(plan, withTwo).reason, blocked.reason);
});

test('the DEPENDENCY ladder walks LOCAL_RECOVERY, ALTERNATE_INTERNAL_PATH, HNS, then blocks', () => {
  const plan = planRecovery(classifyFailure({ detail: "Cannot find module 'left-pad'", workspace: { missing_modules: ['left-pad'] } }));
  assert.equal(plan.failure_class, 'DEPENDENCY');
  const steps = [];
  const attempts = [];
  for (;;) {
    const progress = advanceRecovery(plan, attempts);
    if (progress.hard_blocker) {
      assert.equal(progress.reason, '§33.2 Hard Blocker: every applicable recovery step is exhausted');
      break;
    }
    steps.push(progress.next);
    attempts.push({ step: progress.next, outcome: 'FAIL' });
    assert.ok(attempts.length <= 10, 'the ladder must terminate');
  }
  assert.deepEqual(steps, ['LOCAL_RECOVERY', 'LOCAL_RECOVERY', 'ALTERNATE_INTERNAL_PATH', 'HNS_FALLBACK']);
});

test('the RATE_LIMIT ladder is the donor\'s order with the donor\'s budgets', () => {
  const plan = planRecovery(classifyFailure({ detail: '429 Too Many Requests' }));
  const steps = [];
  const attempts = [];
  for (;;) {
    const progress = advanceRecovery(plan, attempts);
    if (progress.hard_blocker) break;
    steps.push(progress.next);
    attempts.push({ step: progress.next, outcome: 'FAIL' });
  }
  assert.deepEqual(steps, ['NATIVE_RETRY', 'ALTERNATE_PROVIDER', 'ALTERNATE_PROVIDER', 'DEGRADED_MODE', 'HNS_FALLBACK']);
});

test('a prohibited failure is immediately hard-blocked with the "no step applies" reason', () => {
  const plan = planRecovery(classifyFailure({ policy_refusal: 'POLICY' }));
  const progress = advanceRecovery(plan, []);
  assert.equal(progress.hard_blocker, true);
  assert.equal(progress.exhausted, true);
  assert.equal(progress.next, undefined);
  assert.equal(
    progress.reason,
    '§33.2 Hard Blocker: no step applies (the action is prohibited; repeating it is not recovery)',
  );
});

test('a TRANSIENT ladder exhausts at the native retry and its local repair', () => {
  const plan = planRecovery(classifyFailure({ detail: 'request timed out' }));
  const attempts = [
    { step: 'NATIVE_RETRY', outcome: 'FAIL' },
    { step: 'NATIVE_RETRY', outcome: 'FAIL' },
  ];
  assert.equal(advanceRecovery(plan, attempts).next, 'LOCAL_RECOVERY');
  assert.equal(advanceRecovery(plan, attempts).reason, '§33.2 local recovery (repair what is inside our own authority) — attempt 1 of 1');
  const done = [...attempts, { step: 'LOCAL_RECOVERY', outcome: 'FAIL' }];
  assert.equal(advanceRecovery(plan, done).next, 'HNS_FALLBACK');
  const blocked = advanceRecovery(plan, [...done, { step: 'HNS_FALLBACK', outcome: 'FAIL' }]);
  assert.equal(blocked.hard_blocker, true);
  assert.equal(blocked.reason, '§33.2 Hard Blocker: every applicable recovery step is exhausted');
});

/* ------------------------------------------------------------------ *
 * determinism, and the refusal of a malformed record
 * ------------------------------------------------------------------ */

test('the same observation yields an identical classification and plan', () => {
  const observation = {
    detail: "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    workspace: { missing_modules: [] },
    gate: 'TYPECHECK',
  };
  const first = classifyFailure(observation);
  const second = classifyFailure(observation);
  assert.deepEqual(first, second);
  assert.deepEqual(planRecovery(first), planRecovery(second));
  assert.equal(JSON.stringify(planRecovery(first)), JSON.stringify(planRecovery(second)));
});

test('classifying does not mutate the observation it was given', () => {
  const observation = { detail: 'error TS2322', workspace: { missing_modules: ['a', 'b'] } };
  const snapshot = JSON.stringify(observation);
  classifyFailure(observation);
  planRecovery(classifyFailure(observation));
  assert.equal(JSON.stringify(observation), snapshot);
});

test('planRecovery refuses a malformed or unknown failure class', () => {
  assert.throws(() => planRecovery({ failure_class: 'NOT_A_CLASS', severity: 'LOW' }), /is not a recovery failure class/);
  assert.throws(() => planRecovery({}), /"undefined" is not a recovery failure class/);
  assert.throws(() => planRecovery(undefined), /is not a recovery failure class/);
  // The refusal names the whole accepted vocabulary, so a typo is diagnosable.
  assert.throws(() => planRecovery({ failure_class: 'build' }), new RegExp(DONOR_CLASSES.join(', ')));
});

test('planRecovery does not mutate or upgrade the classification it was given', () => {
  const classification = classifyFailure({ detail: 'error TS2322' });
  const snapshot = JSON.stringify(classification);
  const plan = planRecovery(classification);
  assert.equal(JSON.stringify(classification), snapshot);
  assert.equal(plan.failure_class, classification.failure_class);
  assert.equal(plan.severity, classification.severity);
  assert.equal('recovered' in plan, false, 'a plan never claims a recovery');
});

/* ------------------------------------------------------------------ *
 * §33.3 HNS positioning and the mandatory gap
 * ------------------------------------------------------------------ */

test('the HNS role vocabulary is the donor\'s four roles', () => {
  assert.deepEqual([...HNS_ROLES], ['fallback', 'diagnostic', 'recovery', 'external_executor']);
  assert.equal(MAX_CONSECUTIVE_HNS_CALLS, 2);
});

test('a first fallback is allowed and always produces a CapabilityGap', () => {
  const classification = classifyFailure({ detail: 'error TS2322: type mismatch' });
  const decision = planHnsFallback({
    classification,
    plan: { hns_allowed: true },
    task: 'repair the gateway',
    missing_capability: 'multi-file refactor planning',
    workaround: 'HNS rewrites the two files and Boss verifies them',
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.capability_gap.missing_capability, 'multi-file refactor planning');
  assert.equal(decision.capability_gap.severity, 'LOW');
  assert.equal(decision.capability_gap.failure_class, 'BUILD');
  assert.equal(decision.capability_gap.failure, 'BUILD: the code does not compile: repair the source, not the pipeline');
  assert.equal(decision.capability_gap.first_seen_at, '2026-01-01T00:00:00.000Z');
  assert.equal(decision.backlog.stage, 'IMPROVEMENT_TASK');
  assert.equal(decision.backlog.from_failure_class, 'BUILD');
  assert.ok(decision.reason.includes('gap is recorded'));
});

test('a fallback with no named missing capability is refused and still records the gap', () => {
  const decision = planHnsFallback({
    classification: classifyFailure({ detail: 'error TS2322' }),
    plan: { hns_allowed: true },
    task: 't',
    missing_capability: '   ',
    workaround: 'w',
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes('must name the capability'));
  assert.equal(decision.capability_gap.missing_capability, '');
  assert.equal(decision.backlog.missing_capability, '');
});

test('a prohibited action may not be delegated to HNS', () => {
  const terminal = classifyFailure({ policy_refusal: 'GUARDIAN_DENIED' });
  const decision = planHnsFallback({ classification: terminal, plan: { hns_allowed: false }, task: 't', missing_capability: 'c', workaround: 'w' });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes('not a recovery route'));
  assert.equal(decision.capability_gap.failure_class, 'TERMINAL');
});

test('HNS stops being a crutch at the consecutive ceiling and the gap goes HIGH', () => {
  const classification = classifyFailure({ detail: 'error TS2322: type mismatch' });
  const allowed = planHnsFallback({
    classification, plan: { hns_allowed: true }, task: 't', missing_capability: 'c', workaround: 'w',
    history: { hns_calls: 1, consecutive_hns_calls: 1 },
  });
  assert.equal(allowed.allowed, true);
  const refused = planHnsFallback({
    classification, plan: { hns_allowed: true }, task: 't', missing_capability: 'c', workaround: 'w',
    history: { hns_calls: 2, consecutive_hns_calls: 2 },
  });
  assert.equal(refused.allowed, false);
  assert.ok(refused.reason.includes('permanent crutch'));
  assert.equal(refused.capability_gap.severity, 'HIGH');
});

test('the gap severity rises with its frequency, and TERMINAL is always CRITICAL', () => {
  const classification = classifyFailure({ detail: 'error TS2322' });
  const at = (frequency) =>
    planHnsFallback({
      classification, plan: { hns_allowed: true }, task: 't', missing_capability: 'c', workaround: 'w',
      history: { hns_calls: frequency, consecutive_hns_calls: 0, gap_frequency: frequency },
    }).capability_gap;
  assert.equal(at(1).severity, 'LOW');
  assert.equal(at(2).severity, 'MEDIUM');
  assert.equal(at(4).severity, 'MEDIUM');
  assert.equal(at(5).severity, 'HIGH');
  assert.equal(at(6).frequency, 6);
  const terminal = planHnsFallback({
    classification: classifyFailure({ policy_refusal: 'P' }), plan: { hns_allowed: true }, task: 't', missing_capability: 'c', workaround: 'w',
  });
  assert.equal(terminal.capability_gap.severity, 'CRITICAL');
});

test('every usage is recorded with its gap, and a gapless or unknown role is refused', () => {
  const decision = planHnsFallback({
    classification: classifyFailure({ detail: 'error TS2322' }),
    plan: { hns_allowed: true },
    task: 't',
    missing_capability: 'c',
    workaround: 'w',
    now: '2026-01-01T00:00:00.000Z',
  });
  const record = recordHnsUsage(decision, 'external_executor', '2026-01-01T00:00:01.000Z');
  assert.equal(record.role, 'external_executor');
  assert.equal(record.capability_gap.missing_capability, 'c');
  assert.equal(record.recorded_at, '2026-01-01T00:00:01.000Z');
  assert.throws(() => recordHnsUsage(decision, 'magic'), /not an HNS role/);
  const gapless = { ...decision, capability_gap: { ...decision.capability_gap, missing_capability: '' } };
  assert.throws(() => recordHnsUsage(gapless, 'fallback'), /without a named missing capability/);
});
