/**
 * UTOPIA · City · Project Foreman — the CI repair loop's decision half.
 *
 * The flow is: CI → PASS? yes → Final Gate; no → parse the failure → classify →
 * repair → verify locally → push → CI again, until PASS or a Hard Blocker.
 *
 * This module is the part that can be decided from real bytes: the parser reads a
 * CI log and extracts the failing step, the diagnostics, the tests and the exit
 * code; the classifier hands that to the §33 failure model; and the planner says
 * which local gates must be re-run and whether the loop may continue at all.
 *
 * Three rules keep a repair loop honest: a CI read that *failed* is never a pass,
 * the loop is bounded by §33.2's step budgets (a repeated identical failure cannot
 * be retried forever), and a terminal failure (a policy refusal, a leaked secret)
 * goes straight to the Hard Blocker instead of being repaired.
 *
 * Donor provenance: Codex-Boss `src/shared/ci-repair.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, ported from TypeScript to ESM. Every
 * regex, local-gate table, reason string, threshold and bound is the donor's. The
 * donor is pure — no fs, no network, no clock — and stays that way here. The
 * donor's TypeScript interfaces and type aliases (`CiRunDescriptor`,
 * `ParsedCiFailure`, `CiRepairPlan`, `CiLoopOutcome`) are erased at runtime and
 * documented in JSDoc instead of being re-created as runtime objects.
 *
 * **Cross-module boundary.** `ci-repair.ts` does not own the §33 failure model it
 * decides with; it imports `classifyFailure`, `planRecovery` and `advanceRecovery`
 * from `src/shared/recovery.ts`. That model is real Engineering failure policy —
 * thirteen failure classes and their recovery budgets — and it belongs to its own
 * module rather than being inlined here, because inlining it would make CI repair
 * the de-facto owner of Engineering failure policy and would collide with the
 * DS-Hns `failure.mjs` boundary. It is therefore resolved through a lazily-loaded
 * sibling seam, `./failure-recovery.mjs`, in exactly the shape `verifier.cjs` uses
 * for `checkpoint.cjs`: the module imports cleanly whether or not the sibling has
 * landed, and the functions that need it raise a named error until it has.
 *
 * **Two mechanical substitutions**, both byte-equivalent:
 *   * `contentHashOf(text)` (a vendored pure-TS SHA-256 in `src/shared/workbook.ts`)
 *     → `crypto.createHash('sha256').update(text, 'utf8').digest('hex')`. The donor
 *     hashes `sha256Bytes(utf8Bytes(text))`, i.e. exactly the UTF-8 bytes of the
 *     text, so the hex digest is identical.
 *   * `utf8Bytes(text).length` (from `src/shared/hash.ts`) → `Buffer.byteLength(text, 'utf8')`.
 *     The input is always well-formed (it is either the raw log, or a
 *     `JSON.stringify` result, which escapes lone surrogates), so the byte counts
 *     are identical.
 *
 * @module project-foreman/ci-repair
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The donor's record version string, carried verbatim. */
const CI_REPAIR_VERSION = 'ci-repair-1';

/** The §33 failure model, as an interface this module consumes. */
const RECOVERY_EXPORTS = Object.freeze(['classifyFailure', 'planRecovery', 'advanceRecovery']);

/**
 * Resolve the §33 failure model from its own module.
 *
 * The sibling is loaded lazily and synchronously, so `classifyCiFailure()` and
 * `planCiRepair()` keep the donor's synchronous, pure signatures while this file
 * still imports cleanly before `failure-recovery.mjs` exists.
 *
 * @returns {{classifyFailure:Function, planRecovery:Function, advanceRecovery:Function}}
 */
function recoveryDependency() {
  let recovery;
  try {
    recovery = require('./failure-recovery.mjs');
  } catch (error) {
    throw new Error(`project-foreman/failure-recovery.mjs has not landed yet, so the §33 failure model cannot be resolved: ${error && error.message ? error.message : error}`);
  }
  for (const name of RECOVERY_EXPORTS) {
    if (typeof recovery[name] !== 'function') {
      throw new Error(`project-foreman/failure-recovery.mjs does not export ${name}(...)`);
    }
  }
  return recovery;
}

/**
 * The donor's `contentHashOf`, on node's own SHA-256.
 *
 * @param {string} content
 * @returns {string} lowercase hex digest of the UTF-8 bytes of `content`
 */
function contentHashOf(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Compiler/lint diagnostic in `file(line,col): error CODE: message` form. */
const DIAGNOSTIC = /^(?<file>[^\s(]+\.(?:ts|tsx|js|mjs|cjs|jsx))\((?<line>\d+),\d+\):\s*(?<severity>error|warning)\s+(?<code>TS\d+|[A-Z]+\d+):\s*(?<message>.+)$/;

/** The same diagnostic in `file:line:col: error CODE: message` form. */
const DIAGNOSTIC_ALT = /^(?<file>[^\s:]+\.(?:ts|tsx|js|mjs|cjs|jsx)):(?<line>\d+):\d+:\s*(?<severity>error|warning)\s+(?<code>[A-Z]+\d+)?:?\s*(?<message>.+)$/;

/** A failing test line. */
const TEST_FAIL = /^\s*(?:✗|✖|×|not ok|FAIL)\s+(?<name>.+?)(?:\s+\(\d+(?:\.\d+)?\s*ms\))?$/;

/** An assertion message. */
const ASSERTION = /^\s*(?:AssertionError|Error)\s*[:[]\s*(?<message>.+)$/;

/** The wrapper CI prints around a step's exit code. */
const EXIT_CODE = /Process completed with exit code (\d+)/i;

/** A workflow step heading. */
const STEP = /^##\[(?:error|group)\](?<name>.+)$/;

/** A command CI shows itself running. */
const COMMAND = /^\s*Run\s+(?<command>\S.*)$/;

/**
 * §41 "parse failure": reads a CI log as it is, without guessing what CI meant.
 *
 * Lines that look like diagnostics, test failures, assertions, workflow steps and
 * commands are kept with their text; anything else is ignored, so an unfamiliar
 * log produces an empty-but-honest parse rather than an invented cause.
 *
 * @param {{log:string, descriptor?:object}} input
 * @returns {{descriptor:object, step?:string, commands:string[], issues:object[], tests:object[], annotations:string[], exit_code?:number, log_bytes:number, signature:string, infrastructure:boolean}}
 */
export function parseCiFailure(input) {
  const log = input.log ?? '';
  const lines = log.split(/\r?\n/);
  const issues = [];
  const tests = [];
  const annotations = [];
  const commands = [];
  let step;
  let exitCode;
  let pendingTest;

  for (const raw of lines) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    const stepMatch = STEP.exec(line.trim());
    if (stepMatch?.groups?.name) step = stepMatch.groups.name.trim();
    const commandMatch = COMMAND.exec(line);
    if (commandMatch?.groups?.command) {
      const command = commandMatch.groups.command.trim();
      if (!commands.includes(command)) commands.push(command);
    }
    const diagnostic = DIAGNOSTIC.exec(line) ?? DIAGNOSTIC_ALT.exec(line);
    if (diagnostic?.groups) {
      const entry = { message: diagnostic.groups.message?.trim() ?? line.trim() };
      if (diagnostic.groups.file) entry.file = diagnostic.groups.file;
      if (diagnostic.groups.line) entry.line = Number(diagnostic.groups.line);
      if (diagnostic.groups.code) entry.code = diagnostic.groups.code;
      issues.push(entry);
      continue;
    }
    const testFail = TEST_FAIL.exec(line);
    if (testFail?.groups?.name) {
      pendingTest = testFail.groups.name.trim();
      tests.push({ name: pendingTest });
      continue;
    }
    // The exit code is read BEFORE the assertion pattern: CI wraps its own message
    // as "Error: Process completed with exit code 1", which is not an assertion.
    const exit = EXIT_CODE.exec(line);
    if (exit?.[1]) {
      exitCode = Number(exit[1]);
      if (annotations.length < 20) annotations.push(line.trim());
      continue;
    }
    const assertion = ASSERTION.exec(line);
    if (assertion?.groups?.message) {
      const message = assertion.groups.message.trim().replace(/\]$/, '');
      if (pendingTest && tests.length && !tests[tests.length - 1].message) tests[tests.length - 1].message = message;
      else annotations.push(message);
      pendingTest = undefined;
      continue;
    }
    if (/^Error:/i.test(line.trim()) && annotations.length < 20) annotations.push(line.trim());
  }

  const touchedFiles = [...new Set(issues.map((issue) => issue.file).filter((file) => Boolean(file)))];
  const signature = contentHashOf(JSON.stringify({
    step: step ?? '',
    codes: [...new Set(issues.map((issue) => issue.code ?? ''))].sort(),
    files: touchedFiles.sort(),
    tests: tests.map((test) => test.name).sort(),
    exit: exitCode ?? null,
  }));
  return {
    descriptor: input.descriptor ?? {},
    ...(step ? { step } : {}),
    commands,
    issues,
    tests,
    annotations,
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    log_bytes: Buffer.byteLength(log, 'utf8'),
    signature,
    infrastructure: issues.length === 0 && tests.length === 0 && /(could not resolve|failed to (?:start|set up)|no such file or directory: .*(?:node|pnpm|npm))/i.test(log),
  };
}

/**
 * §41 "classify": the parsed failure in §33's vocabulary.
 *
 * @param {object} parsed a `ParsedCiFailure`
 * @returns {object} a §33 `FailureObservation`
 */
function ciObservationFor(parsed) {
  const detail = [
    parsed.step ? `step: ${parsed.step}` : '',
    ...parsed.issues.slice(0, 6).map((issue) => `${issue.file ?? '?'}(${issue.line ?? 0}): ${issue.code ?? 'error'}: ${issue.message}`),
    ...parsed.tests.slice(0, 4).map((test) => `failing test: ${test.name}${test.message ? ` — ${test.message}` : ''}`),
    ...parsed.annotations.slice(0, 3),
  ].filter(Boolean).join('\n');
  const observation = { detail };
  if (parsed.exit_code !== undefined) observation.exit_code = parsed.exit_code;
  if (parsed.tests.length) observation.gate = 'UNIT';
  else if (parsed.issues.some((issue) => issue.code?.startsWith('TS'))) observation.gate = 'TYPECHECK';
  else if (/\bsecret\b|secret-scan|scan-tracked-secrets/i.test(detail)) observation.policy_refusal = 'CI reported a secret-scan failure';
  return observation;
}

/**
 * The §33 classification of one parsed CI failure.
 *
 * An infrastructure failure is decided here without the §33 model: CI could not
 * even start the job, so the runner's environment is the failure, not the change.
 *
 * @param {object} parsed a `ParsedCiFailure`
 * @returns {{failure_class:string, confidence:number, reason:string, signals:string[], severity:string}}
 */
export function classifyCiFailure(parsed) {
  if (parsed.infrastructure) {
    return {
      failure_class: 'ENVIRONMENT',
      confidence: 0.8,
      reason: 'CI could not even start the job, so the failure is the runner\'s environment rather than the change',
      signals: ['ci:infrastructure', `step:${parsed.step ?? 'unknown'}`],
      severity: 'HIGH',
    };
  }
  return recoveryDependency().classifyFailure(ciObservationFor(parsed));
}

/** Which local gates must pass again before the fix may be pushed (§41 "local verify"). */
const LOCAL_GATES = Object.freeze({
  BUILD: Object.freeze(['TYPECHECK']),
  TEST: Object.freeze(['UNIT']),
  DEPENDENCY: Object.freeze(['TYPECHECK']),
  WORKSPACE: Object.freeze(['SYNTAX', 'TYPECHECK']),
  THEME: Object.freeze(['TYPECHECK', 'UNIT']),
  UI: Object.freeze(['UNIT']),
  ENVIRONMENT: Object.freeze(['TYPECHECK']),
  TRANSIENT: Object.freeze([]),
  AUTH: Object.freeze([]),
  RATE_LIMIT: Object.freeze([]),
  PROVIDER_PAGE: Object.freeze([]),
  TERMINAL: Object.freeze([]),
  UNKNOWN: Object.freeze(['TYPECHECK', 'UNIT']),
});

/**
 * §41's decision for one CI failure.
 *
 * A terminal failure blocks instead of repairing, and the loop's remaining budget
 * comes from §33.2/§33.3 rather than from a counter invented here.
 *
 * @param {{parsed:object, attempts:object[]}} input
 * @returns {{schemaVersion:number, version:string, decision:string, failure_class:string, severity:string, local_gates:string[], targets:string[], progress:object, signature:string, reasons:string[]}}
 */
export function planCiRepair(input) {
  const classification = classifyCiFailure(input.parsed);
  const recovery = recoveryDependency();
  const plan = recovery.planRecovery(classification);
  const progress = recovery.advanceRecovery(plan, input.attempts);
  const gates = LOCAL_GATES[classification.failure_class] ?? [];
  const reasons = [classification.reason];
  const targets = [
    ...new Set([
      ...input.parsed.issues.map((issue) => issue.file).filter((file) => Boolean(file)),
      ...input.parsed.tests.map((test) => test.name),
    ]),
  ];
  const hardBlocked = classification.failure_class === 'TERMINAL' || progress.hard_blocker || progress.next === 'HARD_BLOCKER';
  if (classification.failure_class === 'TERMINAL') reasons.push('a prohibited or policy-refused failure is not repaired: the Hard Blocker hands it to the Owner');
  if (progress.hard_blocker) reasons.push(progress.reason);
  if (!gates.length && !hardBlocked) reasons.push('this failure class has no local gate to re-run, so the repair is a retry rather than a code change');
  return {
    schemaVersion: 1,
    version: CI_REPAIR_VERSION,
    decision: hardBlocked ? 'HARD_BLOCKER' : 'REPAIR',
    failure_class: classification.failure_class,
    severity: classification.severity,
    local_gates: [...gates],
    targets,
    progress,
    signature: input.parsed.signature,
    reasons,
  };
}

/**
 * §41 "CI: PASS?" — only a success counts, and a failed read is not a success.
 *
 * @param {{ok:boolean, conclusion?:string, reason?:string}} read
 * @returns {{passed:boolean, reason:string}}
 */
export function ciVerdict(read) {
  if (!read.ok) return { passed: false, reason: `§41: the CI result could not be read (${read.reason ?? 'unknown'}), which is not a pass` };
  if (read.conclusion !== 'success') return { passed: false, reason: `§41: CI concluded ${read.conclusion ?? 'unknown'}` };
  return { passed: true, reason: '§41: CI concluded success' };
}

/**
 * §41: the loop stops at PASS or at a Hard Blocker, never by quietly giving up.
 *
 * @param {{verdict:{passed:boolean}, plan?:object, attemptsUsed:number, maxAttempts:number}} input
 * @returns {'PASS'|'HARD_BLOCKER'|'IN_PROGRESS'}
 */
export function loopOutcome(input) {
  if (input.verdict.passed) return 'PASS';
  if (input.plan?.decision === 'HARD_BLOCKER') return 'HARD_BLOCKER';
  if (input.attemptsUsed >= input.maxAttempts) return 'HARD_BLOCKER';
  return 'IN_PROGRESS';
}
