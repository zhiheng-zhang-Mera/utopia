/**
 * UTOPIA · City · Project Foreman — plan and failure parity tests.
 *
 * The strongest evidence for these two modules is the donor's own suite, which
 * lives beside this file in `tests/donor/engineering-plan.test.js` and passes
 * against the port with only its import specifiers rewritten. What this file adds
 * is the part the donor's suite does not reach: the *vocabulary* constants, the
 * differentially-checkable pure helpers, and the refusals a caller meets when it
 * asks for something the closed vocabularies do not contain.
 *
 * The donor is `DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b`; the exact
 * source paths are in `DONOR.json`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CLASS_POLICY,
  FAILURE_CLASSES,
  PATTERNS,
  classify,
  createRepairTracker,
  failureSignature,
  fromErrorCode,
  normalizeMessage,
} from '../failure.mjs';
import {
  COMMAND_KINDS,
  DEFAULT_MAX_STEPS,
  DEFAULT_SERVICE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  KIND_COMMANDS,
  KIND_EVIDENCE,
  KIND_EXPECTS,
  PLAN_KINDS,
  PLAN_KIND_LIST,
  TEMPLATES,
  advance,
  argsFromText,
  buildPlan,
  capToDeadline,
  classifyIntent,
  commandForKind,
  expectsMet,
  nextStep,
  normalizeStep,
  restorePlan,
  splitCommand,
  validateExpects,
} from '../plan.mjs';
import { CONFIDENCE, OPERATIONS } from '../discovery.mjs';

/** The donor's CommonJS engineering modules, for a differential check. */
const DONOR_ROOT = resolve('.runtime/evidence/mission-book/MB-004/donor-hns/app/engineering');
const DONOR_AVAILABLE = existsSync(resolve(DONOR_ROOT, 'failure.cjs'));
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The closed failure vocabulary
// ---------------------------------------------------------------------------

test('the failure vocabulary and its action policy are closed and complete', () => {
  assert.deepEqual(Object.values(FAILURE_CLASSES).sort(), [
    'compile', 'dependency', 'filesystem', 'integration-test', 'network', 'permission',
    'resource', 'runtime', 'syntax', 'timeout', 'transport', 'type', 'ui', 'unit-test',
    'unknown', 'workspace',
  ]);
  for (const failureClass of Object.values(FAILURE_CLASSES)) {
    const policy = CLASS_POLICY[failureClass];
    assert.ok(policy, `${failureClass} has a policy`);
    assert.ok(['repair', 'bound', 'retry-bounded', 'block', 'reconnect', 'degrade', 'inspect'].includes(policy.action), `${failureClass} action`);
    assert.equal(typeof policy.retryable, 'boolean');
    assert.ok(policy.reason.length > 0);
  }
  // The three classes a loop must never retry blind are exactly these.
  assert.equal(CLASS_POLICY[FAILURE_CLASSES.SYNTAX].retryable, false);
  assert.equal(CLASS_POLICY[FAILURE_CLASSES.UNIT_TEST].retryable, false);
  assert.equal(CLASS_POLICY[FAILURE_CLASSES.FILESYSTEM].retryable, false);
  assert.equal(CLASS_POLICY[FAILURE_CLASSES.UNKNOWN].action, 'inspect');
  assert.equal(CLASS_POLICY[FAILURE_CLASSES.RESOURCE].action, 'degrade');
});

test('classification follows the donor order: timeout flag, then typed code, then patterns, then unknown', () => {
  assert.equal(classify({ timedOut: true, output: 'SyntaxError: nope' }).class, FAILURE_CLASSES.TIMEOUT, 'the timeout flag outranks a pattern');
  assert.equal(classify({ code: 'WORKSPACE_UNAVAILABLE', output: 'SyntaxError: nope' }).class, FAILURE_CLASSES.WORKSPACE, 'a typed code outranks a pattern');
  assert.equal(classify({ output: 'TS2345: is not assignable' }).class, FAILURE_CLASSES.TYPE);
  assert.equal(classify({ output: 'npm ERR! ERESOLVE peer dep' }).class, FAILURE_CLASSES.DEPENDENCY);
  assert.equal(classify({ output: 'something entirely novel happened', exitCode: 1 }).class, FAILURE_CLASSES.UNKNOWN);
  assert.deepEqual(classify({ output: 'x', exitCode: 3 }).exitCode, 3);
  assert.equal(classify({ output: 'x', exitCode: 'nope' }).exitCode, null, 'a non-integer exit code is reported as absent');
  assert.equal(fromErrorCode('MUTATION_UNVERIFIED').class, FAILURE_CLASSES.FILESYSTEM);
  assert.equal(fromErrorCode('NOT_A_CODE'), null);
});

test('the pattern table keeps the donor order, so an ambiguous message resolves the donor way', () => {
  // A message that reads as both a type error and a unit-test failure is a type
  // error, because TYPE precedes UNIT_TEST in the table.
  const ambiguous = classify({ output: 'TypeError: boom\n1 failing' });
  assert.equal(ambiguous.class, FAILURE_CLASSES.TYPE);
  const index = (name) => PATTERNS.findIndex((entry) => entry.class === name);
  assert.ok(index(FAILURE_CLASSES.SYNTAX) < index(FAILURE_CLASSES.TYPE));
  assert.ok(index(FAILURE_CLASSES.TYPE) < index(FAILURE_CLASSES.COMPILE));
  assert.ok(index(FAILURE_CLASSES.UNIT_TEST) < index(FAILURE_CLASSES.RESOURCE));
});

test('the failure signature ignores what changes between two runs of the same failure', () => {
  // Each numeric component is replaced independently, so a clock time normalizes
  // to three placeholders. The donor does exactly this, which is why the
  // differential check below compares `normalizeMessage` against the donor rather
  // than trusting a hand-written expectation.
  assert.equal(normalizeMessage('failed at 12:00:03'), 'failed at <n>:<n>:<n>');
  assert.equal(normalizeMessage('took 250ms in C:\\build\\out'), 'took <time> in <path>');
  const a = failureSignature({ class: 'unit-test', operation: 'test', command: 'npm test', message: 'failed at 12:00:03' });
  const b = failureSignature({ class: 'unit-test', operation: 'test', command: 'npm test', message: 'failed at 12:00:04' });
  assert.equal(a, b, 'a different timestamp is the same failure');
  const c = failureSignature({ class: 'unit-test', operation: 'test', command: 'npm test', message: 'failed at 12:00:04 in a/other/file.js' });
  assert.notEqual(a, c, 'a different path is a different failure');
});

test('the repair tracker refuses a blind retry and a repeated hypothesis', () => {
  let clock = 0;
  const tracker = createRepairTracker({ now: () => (clock += 1), maxHypotheses: 2 });
  const failure = { class: FAILURE_CLASSES.UNIT_TEST, operation: 'test', command: 'npm test', message: 'AssertionError: nope' };

  assert.equal(tracker.wouldBeBlind(failure).blind, false, 'an unseen failure is not a blind retry');
  tracker.recordAttempt(failure);
  assert.equal(tracker.wouldBeBlind(failure).blind, true, 'the same failure with no state change is blind');
  assert.match(tracker.wouldBeBlind(failure).reason, /already produced 1 time\(s\) with no state change since/);
  assert.equal(tracker.wouldBeBlind({ ...failure, stateChanged: true }).blind, false, 'a state change makes it a new attempt');

  const first = tracker.proposeHypothesis({ ...failure, statement: 'the parser drops the last token' });
  assert.equal(first.ok, true);
  assert.equal(first.hypothesis.id, 'h1');
  const repeat = tracker.proposeHypothesis({ ...failure, statement: 'the parser drops the last token' });
  assert.equal(repeat.ok, false);
  assert.match(repeat.reason, /already been tried for this failure/);
  assert.equal(tracker.proposeHypothesis({ ...failure, statement: 'second idea' }).ok, true);
  const exhausted = tracker.proposeHypothesis({ ...failure, statement: 'third idea' });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.exhausted, true);
  assert.match(exhausted.reason, /already has 2 hypotheses; broaden the investigation instead/);
  assert.equal(tracker.proposeHypothesis({ ...failure, statement: '   ' }).ok, false);

  tracker.settleHypothesis('h1', 'refuted', ['reverted the parser edit']);
  assert.deepEqual(tracker.openFor(failureSignature(failure)).map((entry) => entry.id), ['h2']);
  assert.equal(tracker.repeated({ signature: failureSignature(failure) }).repeated, false);
  assert.equal(tracker.repeated({ signature: failureSignature(failure), threshold: 1 }).repeated, true);
  assert.deepEqual(tracker.attempts()[0].command, 'npm test');
  // A read returns copies: mutating one must not reach the tracker's memory.
  tracker.attempts()[0].command = 'mutated';
  assert.equal(tracker.attempts()[0].command, 'npm test');
});

test('the failure module agrees with the donor module field by field', { skip: DONOR_AVAILABLE ? false : 'donor checkout absent; fetch DS-Hns @ eeb57ca5 into .runtime/evidence/mission-book/MB-004/donor-hns to run the differential check' }, () => {
  const donor = require(resolve(DONOR_ROOT, 'failure.cjs'));
  const cases = [
    { output: 'SyntaxError: Unexpected token' },
    { output: 'TS2345: is not assignable' },
    { output: 'npm ERR! ERESOLVE peer dep' },
    { output: 'ENOENT: no such file or directory' },
    { output: 'operation timed out after 30000ms' },
    { output: 'socket hang up' },
    { output: 'AssertionError: 1 != 2' },
    { timedOut: true },
    { code: 'CAPABILITY_UNAVAILABLE' },
    { output: 'nothing recognisable', exitCode: 2 },
  ];
  for (const input of cases) {
    const expected = donor.classify(input);
    const actual = classify(input);
    assert.equal(actual.class, expected.class, `class for ${JSON.stringify(input)}`);
    assert.equal(actual.action, expected.action);
    assert.equal(actual.retryable, expected.retryable);
    assert.equal(actual.reason, expected.reason);
    assert.equal(actual.signature, expected.signature);
    assert.equal(actual.exitCode, expected.exitCode);
    assert.deepEqual(actual.evidence, expected.evidence);
  }
  for (const text of ['failed at 12:00:03', 'took 250ms in C:\\build\\out', 'hash deadbeefcafe1234 changed', '']) {
    assert.equal(normalizeMessage(text), donor.normalizeMessage(text), text);
  }
});

// ---------------------------------------------------------------------------
// The closed plan vocabulary
// ---------------------------------------------------------------------------

test('the step vocabulary is closed and every kind is fully described', () => {
  assert.equal(PLAN_KIND_LIST.length, 14);
  for (const kind of PLAN_KIND_LIST) {
    assert.ok(KIND_COMMANDS[kind] === undefined || Array.isArray(KIND_COMMANDS[kind]), `${kind} command candidates`);
    assert.ok(Array.isArray(KIND_EVIDENCE[kind]), `${kind} evidence list`);
  }
  assert.deepEqual(COMMAND_KINDS, [
    'reproduce', 'focused-test', 'affected-test', 'full-verify', 'build', 'lint', 'typecheck', 'install', 'run-service',
  ]);
  // The one step whose success is a failure.
  assert.deepEqual(KIND_EXPECTS[PLAN_KINDS.REPRODUCE], { failurePresent: true, description: 'the command must fail, or there is no failure to fix' });
});

test('templates keep the donor order, and a repair always shows the failure first', () => {
  assert.deepEqual(TEMPLATES.fix.map((step) => step.kind), ['reproduce', 'inspect', 'patch', 'focused-test', 'affected-test', 'full-verify']);
  assert.equal(TEMPLATES.fix[0].kind, PLAN_KINDS.REPRODUCE, 'the reproduce step is first, which is the correctness property');
  assert.deepEqual(TEMPLATES.refactor.map((step) => step.kind), ['inspect', 'patch', 'affected-test', 'full-verify']);
  assert.deepEqual(TEMPLATES.dependency.map((step) => step.kind), ['install', 'build', 'affected-test', 'full-verify']);
  assert.deepEqual(TEMPLATES.generic.map((step) => step.kind), ['inspect', 'patch', 'affected-test', 'full-verify']);
  for (const template of Object.values(TEMPLATES)) {
    assert.equal(template[template.length - 1].kind, PLAN_KINDS.FULL_VERIFY, 'every template ends in full verification');
  }
  assert.equal(classifyIntent('fix the failing parser test'), 'fix');
  assert.equal(classifyIntent('upgrade the dependency'), 'dependency');
  assert.equal(classifyIntent('refactor the parser'), 'refactor');
  assert.equal(classifyIntent('build the bundle'), 'build');
  assert.equal(classifyIntent('do something else entirely'), 'generic');
});

test('a step outside the vocabulary is refused, and a command-bearing step with no command names what it needed', () => {
  const unknown = normalizeStep({ kind: 'deploy-to-production' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reasons[0], /is not a step kind this runtime can execute/);
  const noCommand = normalizeStep({ kind: PLAN_KINDS.BUILD, commands: {} });
  assert.equal(noCommand.ok, false);
  assert.match(noCommand.reasons[0], /the build step needs the build command, and discovery provided none/);
  const badOperation = normalizeStep({ kind: PLAN_KINDS.INSPECT, operation: 'teleport' });
  assert.equal(badOperation.ok, false);
  assert.match(badOperation.reasons[0], /is not an operation the supervisor can run/);
});

test('an unusable expects falls back to the exit code and says so', () => {
  const step = normalizeStep({ kind: PLAN_KINDS.BUILD, commands: { build: 'npm run build' }, expects: { exitCode: 'zero' } });
  assert.equal(step.ok, true);
  assert.deepEqual(step.step.expects, { exitCode: 0 });
  assert.ok(step.reasons.some((reason) => /falling back to the exit code/.test(reason)));
  assert.equal(validateExpects({ nope: 1 }).ok, false);
  assert.match(validateExpects({ nope: 1 }).reason, /names no usable condition/);
  assert.equal(validateExpects(null).ok, true);
  assert.equal(validateExpects({ testCount: { failed: 1.5 } }).ok, false);
});

test('expects evaluation treats a reproduce step as the one whose success is a failure', () => {
  assert.deepEqual(expectsMet({ failurePresent: true }, { exitCode: 1 }), { ok: true, reason: 'the step met its expectation' });
  assert.equal(expectsMet({ failurePresent: true }, { exitCode: 0 }).ok, false);
  assert.match(expectsMet({ failurePresent: true }, { exitCode: 0 }).reason, /expected the failure to reproduce, and the command exited 0/);
  assert.equal(expectsMet({ exitCode: 0 }, { exitCode: 1 }).ok, false);
  assert.match(expectsMet({ exitCode: 0 }, { exitCode: 1 }).reason, /expected exit code 0, observed 1/);
  assert.equal(expectsMet({ exitCode: 0 }, { exitCode: null }).reason.includes('observed none'), true);
  assert.equal(expectsMet({ testCount: { failed: 0 } }, { testCount: null }).ok, false);
  assert.equal(expectsMet({ testCount: { failed: 0 } }, { testCount: { failed: 2 } }).ok, false);
  assert.equal(expectsMet(null, {}).ok, true, 'a step with no expectation is met');
});

test('the cursor only moves forward, one step at a time', () => {
  const plan = buildPlan({ goal: 'fix the failing test', discovery: { commands: { focusedTest: 'npm test --', test: 'npm test', build: 'npm run build' } } });
  const first = nextStep(plan);
  assert.equal(first.kind, PLAN_KINDS.REPRODUCE);
  const second = plan.steps[1];
  const jumped = advance(plan, second.id, { ok: true });
  assert.equal(jumped.ok, false);
  assert.match(jumped.reason, /only the current step may be advanced/);
  assert.equal(advance(plan, first.id, { ok: true }).ok, true);
  assert.equal(advance(plan, first.id, { ok: true }).ok, false, 'a settled step cannot be settled twice');
  assert.match(advance(plan, first.id, { ok: true }).reason, /was already settled/);
  assert.equal(nextStep(plan).id, second.id);
  assert.equal(advance(plan, 'no-such-step', {}).reason, 'no step no-such-step');
});

test('the plan is bounded and every dropped step is explained', () => {
  const plan = buildPlan({ goal: 'fix the failing test', maxSteps: 2, discovery: { commands: { test: 'npm test' } } });
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.budget.maxSteps, 2);
  assert.ok(plan.reasons.some((reason) => /the plan is bounded at 2 steps; \d+ further step\(s\) were dropped/.test(reason)));
  assert.deepEqual(plan.progress().budget, { maxSteps: 2 });
  assert.equal(DEFAULT_MAX_STEPS, 40);
});

test('a repair that could not build its reproduce step records the missing regression evidence', () => {
  const plan = buildPlan({ goal: 'fix the failing test', discovery: { commands: { build: 'npm run build' } } });
  assert.ok(!plan.steps.some((step) => step.kind === PLAN_KINDS.REPRODUCE), 'no test command was discovered, so there is no reproduce step');
  assert.ok(plan.reasons.some((reason) => /a repair without a reproduce step has no regression evidence/.test(reason)));
});

test('an explicit contract plan always wins, and its missing reproduce step is recorded not corrected', () => {
  const plan = buildPlan({
    goal: 'fix the failing test',
    inputs: { steps: [{ kind: PLAN_KINDS.PATCH }, { kind: PLAN_KINDS.FULL_VERIFY }] },
    discovery: { commands: { test: 'npm test' } },
  });
  assert.deepEqual(plan.steps.map((step) => step.kind), ['patch', 'full-verify']);
  assert.equal(plan.intent, 'contract');
  assert.ok(plan.reasons.some((reason) => /the explicit plan is a repair but names no reproduce step/.test(reason)));
});

test('a step may not outlive the episode deadline it was clamped to', () => {
  assert.equal(capToDeadline(0, 1000), DEFAULT_TIMEOUT_MS);
  assert.equal(capToDeadline(Number.NaN, 1000), DEFAULT_TIMEOUT_MS);
  assert.equal(capToDeadline(5000, null), 5000);
  assert.equal(capToDeadline(5000, 1000), 1000);
  const plan = buildPlan({ goal: 'refactor the parser', contract: { deadlineMs: 1000 }, discovery: { commands: { test: 'npm test' } } });
  assert.equal(plan.deadlineMs, 1000);
  for (const step of plan.steps) assert.ok(step.timeoutMs <= 1000, `${step.kind} is clamped`);
  assert.equal(DEFAULT_SERVICE_TIMEOUT_MS, 2 * 60_000);
});

test('an optional step may be skipped, and a non-optional one may not', () => {
  const plan = buildPlan({
    goal: '',
    inputs: { steps: [{ kind: PLAN_KINDS.INSPECT, optional: true }, { kind: PLAN_KINDS.REPORT }] },
  });
  assert.equal(plan.optionalFailed('contract:report:2').ok, false);
  assert.match(plan.optionalFailed('contract:report:2').reason, /is not optional, so its failure cannot be skipped/);
  const skipped = plan.optionalFailed('contract:inspect:1', 'the files were unavailable');
  assert.equal(skipped.ok, true);
  assert.equal(plan.optionalFailed('contract:inspect:1').ok, false, 'the same optional skip is not recorded twice');
  assert.deepEqual(plan.skippedStepIds(), ['contract:inspect:1']);
  assert.equal(nextStep(plan).id, 'contract:report:2');
});

test('restorePlan refuses a cursor that skips a step without verified evidence', () => {
  const plan = buildPlan({ goal: 'refactor', discovery: { commands: { test: 'npm test' } } });
  advance(plan, plan.steps[0].id, { ok: true });
  const snapshot = plan.toJSON();
  const cursor = {
    nextStepIndex: 1,
    verifiedStepIds: [plan.steps[0].id],
    skippedStepIds: [],
    lastVerifiedStepId: plan.steps[0].id,
  };
  assert.equal(restorePlan({ plan: snapshot, cursor }).ok, true, 'the honest cursor restores');

  const skipping = restorePlan({ plan: snapshot, cursor: { ...cursor, nextStepIndex: 2 } });
  assert.equal(skipping.ok, false);
  assert.equal(skipping.code, 'CURSOR_UNVERIFIED');

  const unknownId = restorePlan({ plan: snapshot, cursor: { ...cursor, verifiedStepIds: ['ghost'] } });
  assert.equal(unknownId.ok, false);
  assert.equal(unknownId.code, 'CURSOR_INVALID');

  const both = restorePlan({ plan: snapshot, cursor: { ...cursor, skippedStepIds: [plan.steps[0].id] } });
  assert.equal(both.ok, false);
  assert.match(both.reason, /cannot be both verified and skipped/);

  const badPlan = restorePlan({ plan: { ...snapshot, version: 2 }, cursor });
  assert.equal(badPlan.ok, false);
  assert.equal(badPlan.code, 'PLAN_INVALID');

  const badStep = restorePlan({ plan: { ...snapshot, steps: [{ ...snapshot.steps[0], kind: 'deploy' }] }, cursor: { ...cursor, verifiedStepIds: [], lastVerifiedStepId: null, nextStepIndex: 0 } });
  assert.equal(badStep.ok, false);
  assert.equal(badStep.code, 'PLAN_STEP_INVALID');
});

test('command splitting respects quoting and argument inheritance', () => {
  assert.deepEqual(splitCommand('npm test -- --grep "two words"'), { command: 'npm', args: ['test', '--', '--grep', 'two words'] });
  assert.deepEqual(splitCommand(''), { command: '', args: [] });
  assert.deepEqual(argsFromText('--test one.test.js'), ['--test', 'one.test.js']);
  assert.deepEqual(argsFromText(''), []);
  assert.deepEqual(commandForKind(PLAN_KINDS.FOCUSED_TEST, { test: 'npm test' }), { operation: 'test', command: 'npm test' });
  assert.deepEqual(commandForKind(PLAN_KINDS.FOCUSED_TEST, { focusedTest: 'a', test: 'b' }).operation, 'focusedTest', 'the preferred operation wins');
  assert.equal(commandForKind(PLAN_KINDS.BUILD, {}), null);
});

test('a focus is appended to the operation it belongs to, and only to the steps that take one', () => {
  const plan = buildPlan({
    goal: 'fix the failing test',
    inputs: { focus: 'one.test.js' },
    discovery: { commands: { focusedTest: 'npm test', test: 'npm test' } },
  });
  const reproduce = plan.steps.find((step) => step.kind === PLAN_KINDS.REPRODUCE);
  assert.deepEqual(reproduce.args, ['one.test.js']);
  const affected = plan.steps.find((step) => step.kind === PLAN_KINDS.AFFECTED_TEST);
  assert.ok(!affected.args.includes('one.test.js') || affected.args.length === 0, 'a step that was not given the focus does not silently gain it');
});

// ---------------------------------------------------------------------------
// Discovery vocabulary
// ---------------------------------------------------------------------------

test('the discovery module agrees with the donor module field by field', { skip: DONOR_AVAILABLE ? false : 'donor checkout absent; fetch DS-Hns @ eeb57ca5 into .runtime/evidence/mission-book/MB-004/donor-hns to run the differential check' }, () => {
  const donor = require(resolve(DONOR_ROOT, 'discovery.cjs'));
  assert.deepEqual([...OPERATIONS], [...donor.OPERATIONS]);
  assert.deepEqual({ ...CONFIDENCE }, { ...donor.CONFIDENCE });
  const cases = [
    ['npm test', 'test', 'contract'],
    ['npm test', 'focusedTest', 'project'],
    [{ command: 'npx jest', cwd: 'pkg', acceptsFocus: true, longRunning: false, confidence: 'convention', evidence: 'from package.json' }, 'test', 'project'],
  ];
  for (const [input, operation, origin] of cases) {
    assert.deepEqual(normalizeCommandForTest(input, operation, origin), donor.normalizeCommand(input, operation, origin), `${JSON.stringify(input)} ${origin}`);
  }
  assert.deepEqual(normalizeCommandForTest('', 'test', 'contract'), donor.normalizeCommand('', 'test', 'contract'));
});

/** `normalizeCommand` reached through discovery, kept out of the public import list. */
function normalizeCommandForTest(input, operation, origin) {
  // Imported lazily so this file's public import list stays what it documents.
  return discoveryModule.normalizeCommand(input, operation, origin);
}

const discoveryModule = await import('../discovery.mjs');
