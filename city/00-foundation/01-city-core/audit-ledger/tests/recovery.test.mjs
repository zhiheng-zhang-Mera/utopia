/**
 * UTOPIA · City Core — §33 recovery parity and behaviour tests.
 *
 * Ported from the Codex-Boss donor `src/shared/recovery.ts` §33 @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The tests that matter most are the doctrine ones: a refusal is decided before
 * any prose, a rule whose host-verified precondition is absent does not fire, an
 * unclassifiable failure is UNKNOWN rather than the most convenient class, a step
 * is never reachable before every cheaper step has spent its budget, and a
 * prohibited action is never planned for retry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditLedgerError,
  FAILURE_CLASSES,
  FAILURE_SEVERITIES,
  RECOVERY_ORDER,
  THEME_RECOVERY_STEPS,
  VERIFICATION_GATES,
  advanceRecovery,
  assertFailureClassification,
  assertFailureObservation,
  assertRecoveryAttempt,
  assertWorkspaceFacts,
  classifyFailure,
  failureClassification,
  failureObservation,
  planRecovery,
  recoveryAttempt,
  workspaceFacts,
} from '../index.mjs';

/** Every class the donor's ladder can produce, with the observation that produces it. */
const CLASS_VECTORS = [
  { name: 'TRANSIENT', observation: { detail: 'connection timed out' }, confidence: 0.7, severity: 'LOW', reason: 'a transient runtime fault: retrying is worth one bounded attempt', signals: ['output:timed out'] },
  { name: 'TERMINAL', observation: { runtime_code: 'GUARDIAN_DENIED', detail: 'guardian denied the change' }, confidence: 1, severity: 'CRITICAL', reason: 'a policy/Guardian refusal or a security finding: the action is prohibited, so retrying it is not recovery', signals: ['output:guardian (denied|refused)'] },
  { name: 'DEPENDENCY', observation: { detail: "Cannot find module 'left-pad'", workspace: { missing_modules: ['left-pad'] } }, confidence: 0.9, severity: 'MEDIUM', reason: 'a required module/package is missing: install or declare it, no provider can supply it', signals: ['output:cannot find module', 'workspace:missing_modules=left-pad'] },
  { name: 'AUTH', observation: { detail: 'unauthorized: the session expired' }, confidence: 0.95, severity: 'HIGH', reason: 'credentials are missing, expired or rejected: no local retry can substitute for signing in', signals: ['output:unauthori[sz]ed', 'output:session expired'] },
  { name: 'RATE_LIMIT', observation: { detail: 'HTTP 429 too many requests' }, confidence: 0.95, severity: 'MEDIUM', reason: 'the provider is rate limited: wait, then use a different provider', signals: ['output:\\b429\\b', 'output:too many requests'] },
  { name: 'PROVIDER_PAGE', observation: { detail: 'send button not found' }, confidence: 0.9, severity: 'MEDIUM', reason: 'the provider page changed under us: re-read the page and patch the adapter', signals: ['output:send button not found'] },
  { name: 'WORKSPACE', observation: { detail: 'the write escapes workspace', workspace: { escaped_path: true } }, confidence: 0.9, severity: 'HIGH', reason: 'the workspace refused the write: the scope or the path was not allowed', signals: ['output:escapes workspace'] },
  { name: 'BUILD', observation: { detail: "error TS1005: ';' expected." }, confidence: 0.85, severity: 'MEDIUM', reason: 'the code does not compile: repair the source, not the pipeline', signals: ['output:error TS\\d{4}', 'output:\\bTS\\d{4}\\b'] },
  { name: 'TEST', observation: { detail: 'AssertionError: expected 1 to equal 2' }, confidence: 0.85, severity: 'MEDIUM', reason: 'an executed test failed: repair the behaviour or the test, both inside the scope', signals: ['output:assertionerror', 'output:expected .* to (be|equal)'] },
  { name: 'ENVIRONMENT', observation: { detail: 'ENOSPC: no space left on device' }, confidence: 0.85, severity: 'HIGH', reason: 'the host environment refused the operation: permissions, disk or sandbox', signals: ['output:ENOSPC', 'output:no space left'] },
  { name: 'THEME', observation: { detail: 'theme validation failed', theme_error_diagnostics: 2 }, confidence: 0.9, severity: 'MEDIUM', reason: 'the theme package failed validation or the active theme is unusable: disable, fall back to built-in, record the diagnostic', signals: ['output:theme (validation|registry)', 'theme:error_diagnostics=2'] },
  { name: 'UI', observation: { runtime_code: 'MAJOR_SURFACE_VISIBLE', visual_failed: true }, confidence: 0.85, severity: 'MEDIUM', reason: 'the visual/runtime gate failed: this is interface engineering, not a retry', signals: ['output:MAJOR_SURFACE_VISIBLE'] },
];

test('the §33 vocabularies are declared exactly as the donor declares them', () => {
  assert.deepEqual(FAILURE_CLASSES, [
    'TRANSIENT', 'TERMINAL', 'DEPENDENCY', 'AUTH', 'RATE_LIMIT', 'PROVIDER_PAGE',
    'WORKSPACE', 'BUILD', 'TEST', 'ENVIRONMENT', 'THEME', 'UI', 'UNKNOWN',
  ]);
  assert.deepEqual(FAILURE_SEVERITIES, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  assert.deepEqual(RECOVERY_ORDER, [
    'NATIVE_RETRY', 'LOCAL_RECOVERY', 'ALTERNATE_INTERNAL_PATH', 'ALTERNATE_PROVIDER',
    'DEGRADED_MODE', 'HNS_FALLBACK', 'HARD_BLOCKER',
  ]);
  assert.deepEqual(THEME_RECOVERY_STEPS, ['DISABLE_THEME', 'FALLBACK_BUILT_IN_THEME', 'RECORD_DIAGNOSTIC']);
  assert.equal(VERIFICATION_GATES.length, 10);
});

test('every class the donor can produce is classified with its own confidence, severity and reason', () => {
  for (const vector of CLASS_VECTORS) {
    const result = classifyFailure(vector.observation);
    assert.equal(result.failure_class, vector.name, `${vector.name} must classify as itself`);
    assert.equal(result.confidence, vector.confidence, `${vector.name} confidence`);
    assert.equal(result.severity, vector.severity, `${vector.name} severity`);
    assert.equal(result.reason, vector.reason, `${vector.name} reason`);
    assert.deepEqual(result.signals, vector.signals, `${vector.name} signals`);
  }
});

test('the ladder is decided most-authoritative-first, not by whichever pattern is easiest', () => {
  // A refusal outranks a stray transient word in the same output.
  const refused = classifyFailure({ detail: 'guardian denied the change after a timeout', runtime_code: 'GUARDIAN_DENIED' });
  assert.equal(refused.failure_class, 'TERMINAL');
  assert.equal(refused.confidence, 1);
  assert.equal(refused.severity, 'CRITICAL');

  // A policy refusal carried in its own field is decided before any prose at all.
  const policy = classifyFailure({ detail: 'HTTP 401 unauthorized, unreachable host', policy_refusal: 'the path is protected workspace metadata' });
  assert.equal(policy.failure_class, 'TERMINAL');
  assert.equal(policy.severity, 'CRITICAL');
  assert.deepEqual(policy.signals, ['policy_refusal:the path is protected workspace metadata']);

  // Credentials decide before a rate limit mentioned in the same output.
  assert.equal(classifyFailure({ detail: 'AUTH_REQUIRED then timeout' }).failure_class, 'AUTH');
  assert.equal(classifyFailure({ detail: '429 too many requests; the request timed out' }).failure_class, 'RATE_LIMIT');
  // A drifted provider page that is not reachable at all is still the page, not a transient fault.
  assert.equal(classifyFailure({ detail: 'PAGE_CHANGED and ECONNRESET' }).failure_class, 'PROVIDER_PAGE');
  // A missing module outranks the sandbox word in the same message.
  assert.equal(classifyFailure({ detail: "Cannot find module 'x' inside the sandbox", workspace: { missing_modules: ['x'] } }).failure_class, 'DEPENDENCY');
});

test('a rule whose host-verified precondition is absent does not fire', () => {
  // A missing-module message with a workspace that names no missing module: the host
  // checked and there is nothing missing, so this is not DEPENDENCY.
  assert.equal(classifyFailure({ detail: "Cannot find module 'x'", workspace: { missing_modules: [] } }).failure_class, 'UNKNOWN');

  // A scope-refusal message with no host-verified scope fact: refused as evidence-free.
  assert.equal(classifyFailure({ detail: 'the write escapes workspace', workspace: { is_git_repo: true } }).failure_class, 'UNKNOWN');

  // A theme diagnostic with no diagnostics counted does not become THEME: the donor
  // only accepts that class on a counted diagnostic or when no gate was named at
  // all, so this falls through to the gate fallback — UNIT is a verification gate,
  // and the gate itself is then the evidence.
  assert.equal(classifyFailure({ detail: 'theme validation failed', gate: 'UNIT' }).failure_class, 'TEST');
  assert.equal(classifyFailure({ detail: 'theme validation failed', gate: 'UNIT' }).confidence, 0.5);

  // A visual gate symptom with visual_failed false and no VISUAL gate: refused.
  assert.equal(classifyFailure({ detail: 'overflow on the panel', visual_failed: false }).failure_class, 'UNKNOWN');

  // The same observations WITH their precondition become their real class.
  assert.equal(classifyFailure({ detail: 'the write escapes workspace', workspace: { escaped_path: true } }).failure_class, 'WORKSPACE');
  assert.equal(classifyFailure({ detail: 'theme validation failed', gate: 'VISUAL' }).failure_class, 'UI', 'the UI rule precedes the THEME rule and the VISUAL gate satisfies it');
  assert.equal(classifyFailure({ detail: 'overflow on the panel', gate: 'VISUAL' }).failure_class, 'UI');

  // A counted theme diagnostic with no gate named is the real theme case.
  assert.equal(classifyFailure({ detail: 'theme validation failed', theme_error_diagnostics: 1 }).failure_class, 'THEME');
});

test('a gate that failed with no signature is classified from the gate itself', () => {
  const build = classifyFailure({ gate: 'TYPECHECK', detail: 'something unexpected went wrong' });
  assert.equal(build.failure_class, 'BUILD');
  assert.equal(build.confidence, 0.5);
  assert.equal(build.severity, 'MEDIUM');
  assert.deepEqual(build.signals, ['gate:TYPECHECK']);

  assert.equal(classifyFailure({ gate: 'FULL', detail: 'nothing recognisable' }).failure_class, 'TEST');
  assert.equal(classifyFailure({ gate: 'RUNTIME', detail: 'nothing recognisable' }).failure_class, 'UI');
  assert.equal(classifyFailure({ gate: 'MODULE', detail: 'nothing recognisable' }).failure_class, 'TEST');

  // §33.1 has no PERFORMANCE class, so a benchmark miss is UNKNOWN rather than guessed.
  const bench = classifyFailure({ gate: 'BENCHMARK', detail: 'p95 regression' });
  assert.equal(bench.failure_class, 'UNKNOWN');
  assert.equal(bench.confidence, 0.3);
  assert.equal(bench.reason, 'the BENCHMARK gate failed and §33.1 has no class for it; recorded as UNKNOWN rather than guessed');
  assert.deepEqual(bench.signals, ['gate:BENCHMARK']);
});

test('an observation with no signal at all is UNKNOWN, not the most convenient class', () => {
  const bare = classifyFailure({});
  assert.equal(bare.failure_class, 'UNKNOWN');
  assert.equal(bare.confidence, 0.1);
  assert.equal(bare.severity, 'MEDIUM');
  assert.deepEqual(bare.signals, []);
  assert.equal(bare.reason, 'no gate, runtime code or output signal was available to classify this failure');
  assert.equal(classifyFailure({ exit_code: 1 }).failure_class, 'UNKNOWN', 'an exit code alone is not a signal');
});

test('an unlisted TS error code is a dependency when no module was confirmed missing', () => {
  // The donor puts TS2307 on the DEPENDENCY rule and only `error TS<digits>` on
  // BUILD, so a 2307 is a dependency by design — and a compile error that is not
  // 2307 is still a build error.
  assert.equal(classifyFailure({ detail: 'error TS2307: cannot be compiled' }).failure_class, 'DEPENDENCY');
  assert.equal(classifyFailure({ detail: 'error TS1005: build failed' }).failure_class, 'BUILD');
});

test('the classifier reads the provider fields, not only the detail', () => {
  assert.equal(classifyFailure({ runtime_code: 'RATE_LIMITED' }).failure_class, 'RATE_LIMIT');
  assert.equal(classifyFailure({ semantic_outcome: 'selector not found' }).failure_class, 'PROVIDER_PAGE');
  assert.equal(classifyFailure({ runtime_code: 'EACCES' }).failure_class, 'ENVIRONMENT');
  // At most three matched patterns are reported as evidence, in donor order.
  const many = classifyFailure({ detail: 'TIMEOUT timed out ECONNRESET ECONNREFUSED 503 temporarily unavailable' });
  assert.equal(many.failure_class, 'TRANSIENT');
  assert.equal(many.signals.length, 3);
});

test('a plan exists for every class, walks the whole ladder, and always ends at the Hard Blocker', () => {
  const EXPECTED = {
    TRANSIENT: { applicable: { NATIVE_RETRY: 2, LOCAL_RECOVERY: 1, HNS_FALLBACK: 1 }, next: 'NATIVE_RETRY', hns_allowed: true },
    TERMINAL: { applicable: {}, next: undefined, hns_allowed: false, requires_owner: 'AUTHORIZATION' },
    DEPENDENCY: { applicable: { LOCAL_RECOVERY: 2, ALTERNATE_INTERNAL_PATH: 1, HNS_FALLBACK: 1 }, next: 'LOCAL_RECOVERY', hns_allowed: true },
    AUTH: { applicable: { ALTERNATE_PROVIDER: 1 }, next: 'ALTERNATE_PROVIDER', hns_allowed: false, requires_owner: 'SIGN_IN' },
    RATE_LIMIT: { applicable: { NATIVE_RETRY: 1, ALTERNATE_PROVIDER: 2, DEGRADED_MODE: 1, HNS_FALLBACK: 1 }, next: 'NATIVE_RETRY', hns_allowed: true },
    PROVIDER_PAGE: { applicable: { LOCAL_RECOVERY: 2, ALTERNATE_INTERNAL_PATH: 1, ALTERNATE_PROVIDER: 1, HNS_FALLBACK: 1 }, next: 'LOCAL_RECOVERY', hns_allowed: true },
    WORKSPACE: { applicable: { LOCAL_RECOVERY: 2 }, next: 'LOCAL_RECOVERY', hns_allowed: false, requires_owner: 'AUTHORIZATION' },
    BUILD: { applicable: { LOCAL_RECOVERY: 3, HNS_FALLBACK: 1 }, next: 'LOCAL_RECOVERY', hns_allowed: true },
    TEST: { applicable: { LOCAL_RECOVERY: 3, HNS_FALLBACK: 1 }, next: 'LOCAL_RECOVERY', hns_allowed: true },
    ENVIRONMENT: { applicable: { LOCAL_RECOVERY: 2, DEGRADED_MODE: 1, HNS_FALLBACK: 1 }, next: 'LOCAL_RECOVERY', hns_allowed: true },
    THEME: { applicable: { LOCAL_RECOVERY: 2, DEGRADED_MODE: 1, HNS_FALLBACK: 1 }, next: 'LOCAL_RECOVERY', hns_allowed: true, theme: true },
    UI: { applicable: { LOCAL_RECOVERY: 3, HNS_FALLBACK: 1 }, next: 'LOCAL_RECOVERY', hns_allowed: true },
    UNKNOWN: { applicable: { NATIVE_RETRY: 1, LOCAL_RECOVERY: 1, ALTERNATE_INTERNAL_PATH: 1, HNS_FALLBACK: 1 }, next: 'NATIVE_RETRY', hns_allowed: true },
  };
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...FAILURE_CLASSES].sort(), 'every §33.1 class has a plan vector');

  for (const failure_class of FAILURE_CLASSES) {
    const expected = EXPECTED[failure_class];
    const classification = classifyFailure(CLASS_VECTORS.find((vector) => vector.name === failure_class)?.observation ?? {});
    assert.equal(classification.failure_class, failure_class, `the ${failure_class} vector must classify as ${failure_class}`);
    const plan = planRecovery(classification);

    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.version, 'recovery-1');
    assert.equal(plan.failure_class, failure_class);
    assert.equal(plan.severity, classification.severity);
    assert.equal(plan.ends_at_hard_blocker, true);
    assert.equal(plan.hns_allowed, expected.hns_allowed);
    assert.equal(plan.next, expected.next);
    assert.deepEqual(plan.steps.map((step) => step.step), [...RECOVERY_ORDER], 'the ladder is never reordered or truncated');

    const applicable = Object.fromEntries(plan.steps.filter((step) => step.applicable && step.step !== 'HARD_BLOCKER').map((step) => [step.step, step.budget]));
    assert.deepEqual(applicable, expected.applicable, `${failure_class} applicable steps and budgets`);
    for (const step of plan.steps) {
      assert.equal(step.applicable, step.budget > 0, `${failure_class}/${step.step}: applicable and budget must agree`);
      assert.ok(step.reason.length > 0, `${failure_class}/${step.step} carries its reason`);
    }
    const blocker = plan.steps.at(-1);
    assert.deepEqual(blocker, { step: 'HARD_BLOCKER', applicable: true, reason: '§33.2 Hard Blocker (stop and hand the decision to the Owner)', budget: 1 });
    assert.equal(plan.requires_owner?.kind, expected.requires_owner, `${failure_class} requires_owner`);
    assert.equal(plan.theme_steps === undefined, expected.theme !== true, `${failure_class} theme_steps`);
    assert.equal(plan.diagnostics.includes('no recovery step applies; the plan goes straight to the Hard Blocker'), expected.next === undefined);
  }
});

test('an inapplicable step keeps its donor reason rather than being dropped', () => {
  const transient = planRecovery(classifyFailure({ detail: 'timed out' }));
  const byStep = Object.fromEntries(transient.steps.map((step) => [step.step, step]));
  assert.equal(byStep.ALTERNATE_PROVIDER.reason, 'not needed for this failure class');
  assert.equal(byStep.ALTERNATE_PROVIDER.applicable, false);
  assert.equal(byStep.HNS_FALLBACK.applicable, true, 'HNS is allowed for a transient fault, but only as the last fallback');
  assert.equal(byStep.HNS_FALLBACK.reason, '§33.3 HNS fallback (an external executor, and a CapabilityGap)');
  assert.equal(byStep.NATIVE_RETRY.reason, '§33.2 native retry (the same path, bounded)');

  const workspace = planRecovery(classifyFailure({ detail: 'escapes workspace', workspace: { escaped_path: true } }));
  const workspaceSteps = Object.fromEntries(workspace.steps.map((step) => [step.step, step]));
  assert.equal(workspaceSteps.NATIVE_RETRY.reason, 'the same path will be refused again');
  assert.equal(workspaceSteps.HNS_FALLBACK.reason, '§33.3: HNS is not a recovery route for this failure class');
  assert.deepEqual(workspace.requires_owner, { kind: 'AUTHORIZATION', reason: 'the granted scope must change; only the Owner can widen it' });

  const auth = planRecovery(classifyFailure({ detail: 'unauthorized' }));
  assert.deepEqual(auth.requires_owner, { kind: 'SIGN_IN', reason: 'credentials are expired or rejected; the Owner must sign in' });
  assert.equal(auth.steps.find((step) => step.step === 'LOCAL_RECOVERY').reason, "signing in is the Owner's action, not a local repair");
});

test('a TERMINAL failure has no applicable step but the Hard Blocker, and is never planned for retry', () => {
  const terminal = planRecovery(classifyFailure({ policy_refusal: 'destructive change refused' }));
  assert.equal(terminal.next, undefined);
  assert.deepEqual(terminal.steps.filter((step) => step.applicable).map((step) => step.step), ['HARD_BLOCKER']);
  assert.equal(terminal.hns_allowed, false);
  assert.deepEqual(terminal.diagnostics, ['no recovery step applies; the plan goes straight to the Hard Blocker']);
  assert.deepEqual(terminal.requires_owner, { kind: 'AUTHORIZATION', reason: 'the request was refused by policy; only the Owner can change the goal or authorize it' });
  assert.equal(terminal.steps.find((step) => step.step === 'HNS_FALLBACK').reason, '§33.3 forbids delegating a prohibited action to HNS');
  assert.equal(terminal.steps.find((step) => step.step === 'NATIVE_RETRY').reason, 'the action is prohibited; repeating it is not recovery');

  // Even when a caller has already tried everything it could think of, the terminal
  // plan still offers no retry: it blocks.
  const progress = advanceRecovery(terminal, [
    recoveryAttempt({ step: 'NATIVE_RETRY', outcome: 'FAIL' }),
    recoveryAttempt({ step: 'HNS_FALLBACK', outcome: 'FAIL' }),
  ]);
  assert.equal(progress.next, undefined, 'a prohibited action must never be offered for another attempt');
  assert.equal(progress.hard_blocker, true);
  assert.equal(progress.reason, '§33.2 Hard Blocker: no step applies (the action is prohibited; repeating it is not recovery)');
});

test('the THEME class carries §33.2\'s own ladder', () => {
  const plan = planRecovery(classifyFailure({ detail: 'UNKNOWN_TOKEN in the theme', theme_error_diagnostics: 1 }));
  assert.equal(plan.failure_class, 'THEME');
  assert.deepEqual(plan.theme_steps, ['DISABLE_THEME', 'FALLBACK_BUILT_IN_THEME', 'RECORD_DIAGNOSTIC']);
  assert.deepEqual(plan.diagnostics, ['§33.2 theme ladder: disable → fall back to the built-in theme → record the diagnostic']);
  assert.equal(plan.hns_allowed, true);

  // Every other class leaves the theme ladder out entirely.
  const build = planRecovery(classifyFailure({ detail: 'error TS1005: build failed' }));
  assert.equal(build.theme_steps, undefined);
  assert.deepEqual(build.diagnostics, []);
});

test('progress offers the next step while its budget remains, and moves on at the exact boundary', () => {
  const plan = planRecovery(classifyFailure({ detail: 'timed out' }));

  const fresh = advanceRecovery(plan, []);
  assert.equal(fresh.next, 'NATIVE_RETRY');
  assert.equal(fresh.exhausted, false);
  assert.equal(fresh.hard_blocker, false);
  assert.equal(fresh.reason, '§33.2 native retry (the same path, bounded) — attempt 1 of 2');

  const one = advanceRecovery(plan, [recoveryAttempt({ step: 'NATIVE_RETRY', outcome: 'FAIL' })]);
  assert.equal(one.next, 'NATIVE_RETRY');
  assert.equal(one.reason, '§33.2 native retry (the same path, bounded) — attempt 2 of 2');

  // Exactly at the budget of NATIVE_RETRY the next cheaper step becomes due.
  const two = advanceRecovery(plan, [
    recoveryAttempt({ step: 'NATIVE_RETRY', outcome: 'FAIL' }),
    recoveryAttempt({ step: 'NATIVE_RETRY', outcome: 'FAIL' }),
  ]);
  assert.equal(two.next, 'LOCAL_RECOVERY');
  assert.equal(two.exhausted, false);
  assert.equal(two.reason, '§33.2 local recovery (repair what is inside our own authority) — attempt 1 of 1');

  // One past the total budget: HNS is reachable only now, and only once.
  const three = advanceRecovery(plan, [
    ...Array.from({ length: 2 }, () => recoveryAttempt({ step: 'NATIVE_RETRY', outcome: 'FAIL' })),
    recoveryAttempt({ step: 'LOCAL_RECOVERY', outcome: 'FAIL' }),
  ]);
  assert.equal(three.next, 'HNS_FALLBACK');
  assert.equal(three.reason, '§33.3 HNS fallback (an external executor, and a CapabilityGap) — attempt 1 of 1');

  const four = advanceRecovery(plan, [
    ...Array.from({ length: 2 }, () => recoveryAttempt({ step: 'NATIVE_RETRY', outcome: 'FAIL' })),
    recoveryAttempt({ step: 'LOCAL_RECOVERY', outcome: 'FAIL' }),
    recoveryAttempt({ step: 'HNS_FALLBACK', outcome: 'FAIL' }),
  ]);
  assert.equal(four.next, undefined);
  assert.equal(four.exhausted, true);
  assert.equal(four.hard_blocker, true);
  assert.equal(four.reason, '§33.2 Hard Blocker: every applicable recovery step is exhausted');
});

test('the ladder is not advisory: a later step is never offered while a cheaper one has budget', () => {
  const plan = planRecovery(classifyFailure({ detail: 'socket hang up, temporarily unavailable' }));
  assert.equal(plan.next, 'NATIVE_RETRY');
  // Only the later step was attempted: the cheapest step is still due, so HNS is not reached.
  const later = advanceRecovery(plan, [recoveryAttempt({ step: 'HNS_FALLBACK', outcome: 'FAIL' })]);
  assert.equal(later.next, 'NATIVE_RETRY');
  assert.equal(later.hard_blocker, false);
  // And a NOT_APPLICABLE attempt spends no budget, so the same step stays due.
  const skipped = advanceRecovery(plan, [recoveryAttempt({ step: 'NATIVE_RETRY', outcome: 'NOT_APPLICABLE' })]);
  assert.equal(skipped.next, 'NATIVE_RETRY');
  assert.equal(skipped.reason, '§33.2 native retry (the same path, bounded) — attempt 1 of 2');
});

test('a PASS still spends the budget, because the run advances on attempts made', () => {
  const plan = planRecovery(classifyFailure({ detail: 'ESLint reported a build failed run' }));
  assert.equal(plan.failure_class, 'BUILD');
  const one = advanceRecovery(plan, [recoveryAttempt({ step: 'LOCAL_RECOVERY', outcome: 'PASS' })]);
  assert.equal(one.next, 'LOCAL_RECOVERY');
  assert.equal(one.reason, '§33.2 local recovery (repair what is inside our own authority) — attempt 2 of 3');
  const two = advanceRecovery(plan, Array.from({ length: 3 }, () => recoveryAttempt({ step: 'LOCAL_RECOVERY', outcome: 'PASS' })));
  assert.equal(two.next, 'HNS_FALLBACK', 'the budget is spent by attempts, whatever they reported');
});

test('a class with no applicable step reports the reason for its first skipped step', () => {
  const plan = planRecovery(classifyFailure({ detail: 'unauthorized', policy_refusal: 'policy refusal' }));
  assert.equal(plan.failure_class, 'TERMINAL');
  const progress = advanceRecovery(plan, []);
  assert.equal(progress.hard_blocker, true);
  assert.equal(progress.exhausted, true);
  assert.equal(progress.reason, '§33.2 Hard Blocker: no step applies (the action is prohibited; repeating it is not recovery)');
});

test('the shape helpers construct the donor shapes and copy their lists', () => {
  assert.deepEqual(workspaceFacts({}), { is_git_repo: undefined, missing_modules: undefined, scope_refused: undefined, escaped_path: undefined, protected_path: undefined, disk_full: undefined });
  const facts = workspaceFacts({ missing_modules: ['a', 'b'], escaped_path: true });
  assert.deepEqual(facts.missing_modules, ['a', 'b']);
  facts.missing_modules.push('c');
  assert.deepEqual(workspaceFacts({ missing_modules: ['a', 'b'] }).missing_modules, ['a', 'b'], 'each factory call builds its own list');

  assert.deepEqual(failureObservation({ detail: 'x' }), { gate: undefined, detail: 'x', runtime_code: undefined, semantic_outcome: undefined, exit_code: undefined, workspace: undefined, theme_error_diagnostics: undefined, visual_failed: undefined, policy_refusal: undefined });
  assert.deepEqual(failureClassification({ failure_class: 'UNKNOWN', confidence: 0.1, reason: 'r', severity: 'MEDIUM' }), { failure_class: 'UNKNOWN', confidence: 0.1, reason: 'r', signals: [], severity: 'MEDIUM' });
  const signals = ['a'];
  assert.deepEqual(failureClassification({ failure_class: 'TEST', confidence: 0.5, reason: 'r', signals, severity: 'MEDIUM' }).signals, ['a']);
  assert.notEqual(failureClassification({ failure_class: 'TEST', confidence: 0.5, reason: 'r', signals, severity: 'MEDIUM' }).signals, signals);
  assert.deepEqual(recoveryAttempt({ step: 'NATIVE_RETRY', outcome: 'FAIL' }), { step: 'NATIVE_RETRY', outcome: 'FAIL', detail: undefined });
});

test('the shape validators refuse a field that lies about its type, without inventing new rules', () => {
  assert.doesNotThrow(() => assertWorkspaceFacts({}));
  assert.doesNotThrow(() => assertWorkspaceFacts({ missing_modules: ['a'], escaped_path: true }));
  assert.throws(() => assertWorkspaceFacts({ missing_modules: 'a' }), AuditLedgerError);
  assert.throws(() => assertWorkspaceFacts({ missing_modules: [1] }), AuditLedgerError);
  assert.throws(() => assertWorkspaceFacts({ scope_refused: 'yes' }), AuditLedgerError);
  assert.throws(() => assertWorkspaceFacts([]), AuditLedgerError);

  assert.doesNotThrow(() => assertFailureObservation({}));
  assert.doesNotThrow(() => assertFailureObservation(failureObservation({ gate: 'VISUAL', detail: 'x', exit_code: 1, workspace: workspaceFacts({ disk_full: true }) })));
  assert.throws(() => assertFailureObservation({ gate: 'PERFORMANCE' }), AuditLedgerError, 'a gate outside the donor union is refused');
  assert.throws(() => assertFailureObservation({ detail: 42 }), AuditLedgerError);
  assert.throws(() => assertFailureObservation({ exit_code: 1.5 }), AuditLedgerError);
  assert.throws(() => assertFailureObservation({ visual_failed: 'true' }), AuditLedgerError);
  assert.throws(() => assertFailureObservation({ theme_error_diagnostics: '2' }), AuditLedgerError);

  assert.doesNotThrow(() => assertFailureClassification(classifyFailure({ detail: 'timed out' })));
  assert.throws(() => assertFailureClassification({ failure_class: 'MAYBE', confidence: 0.5, reason: 'r', signals: [], severity: 'LOW' }), AuditLedgerError);
  assert.throws(() => assertFailureClassification({ failure_class: 'TEST', confidence: 2, reason: 'r', signals: [], severity: 'LOW' }), AuditLedgerError);
  assert.throws(() => assertFailureClassification({ failure_class: 'TEST', confidence: Number.NaN, reason: 'r', signals: [], severity: 'LOW' }), AuditLedgerError);
  assert.throws(() => assertFailureClassification({ failure_class: 'TEST', confidence: 0.5, reason: 'r', signals: [], severity: 'URGENT' }), AuditLedgerError);

  assert.doesNotThrow(() => assertRecoveryAttempt(recoveryAttempt({ step: 'HNS_FALLBACK', outcome: 'FAIL' })));
  assert.throws(() => assertRecoveryAttempt(recoveryAttempt({ step: 'ASK_A_FRIEND', outcome: 'FAIL' })), AuditLedgerError);
  assert.throws(() => assertRecoveryAttempt(recoveryAttempt({ step: 'NATIVE_RETRY', outcome: 'MAYBE' })), AuditLedgerError);
});

test('the ported functions refuse a classification that is not one of §33.1\'s classes', () => {
  assert.throws(() => planRecovery(failureClassification({ failure_class: 'PERFORMANCE', confidence: 0.5, reason: 'r', severity: 'LOW' })), AuditLedgerError);
  assert.throws(() => planRecovery(null), AuditLedgerError);
});
