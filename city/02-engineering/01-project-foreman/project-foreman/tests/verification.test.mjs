/**
 * UTOPIA · City · Project Foreman — verification, acceptance, CI repair and
 * durable result.
 *
 * These tests exist to hold the migrated behaviour still. The questions they ask
 * are the ones the donor modules were written to answer:
 *
 *   verifier      which level runs which command, what is actually executed versus
 *                 merely recorded, what a summary may be read out of, and when
 *                 evidence stops being evidence
 *   result        every acceptance gate and the exact refusal it produces
 *   git           what the runtime may never run, and what it refuses by policy
 *   cross-volume  which scratch this episode may delete, and nothing else
 *   ci-repair     what a CI log really says, and the bounds the loop may not pass
 *   correction    what a human override may change, and that it never mutates
 *
 * Nothing here touches the repository tree: every filesystem fixture is a
 * `mkdtemp` under `node:os.tmpdir()`, and every cleanup is in a `finally`.
 *
 * Provenance: Hns `app/engineering/{verifier,result,git,cross-volume-cleanup}.cjs`
 * and Codex-Boss `src/shared/{ci-repair,correction}.ts` @ eeb57ca5 / 8df428ea.
 * Where a case reproduces an assertion from a donor suite, the donor suite and the
 * item id are named in the test title.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createVerifier,
  VERIFICATION_LEVELS,
  VERIFICATION_LADDER,
  LEVEL_COMMANDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  parseTestSummary,
  parseNodeTest,
  parseJestVitest,
  parsePytest,
  parseCargoTest,
  splitCommand,
  isVerificationLevel,
} from '../verifier.mjs';
import { createResultValidator, collectLeaks, workspaceStillValid, REFUSAL_REASONS } from '../result.mjs';
import { createGitController, FORBIDDEN_COMMANDS, DEFAULT_GIT_POLICY } from '../git.mjs';
import { createCrossVolumeTempRegistry, OWNER_MARKER, PURPOSE_CLASSES, CLEANUP_STATES } from '../cross-volume-cleanup.mjs';
import { parseCiFailure, classifyCiFailure, planCiRepair, ciVerdict, loopOutcome } from '../ci-repair.mjs';
import { applyCorrections, isCorrectableField } from '../correction.mjs';

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** Every temp root the suite makes, so a failure cannot leak one. */
const TEMP_ROOTS = [];
function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pf-${label}-`));
  TEMP_ROOTS.push(root);
  return root;
}
test.after(() => {
  for (const root of TEMP_ROOTS) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* disposable temp root */ }
  }
});

/** A controllable clock, so freshness is asserted instead of hoped for. */
function createClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms = 1) {
      value += ms;
      return value;
    },
  };
}

/** The checkpoint module's real truncation contract, as this module consumes it. */
function fakeTruncate(text, options = {}) {
  const source = String(text || '');
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : 256 * 1024;
  const originalBytes = Buffer.byteLength(source);
  if (originalBytes <= maxBytes) {
    return { text: source, bytes: originalBytes, originalBytes, truncated: false, head: source, tail: source, errorRegion: source };
  }
  const head = source.slice(0, Math.floor(maxBytes / 2));
  const tail = source.slice(-Math.floor(maxBytes / 2));
  return { text: `${head}\n[... omitted ...]\n${tail}`, bytes: head.length + tail.length, originalBytes, truncated: true, head, tail, errorRegion: tail };
}

/**
 * A scripted supervisor: it records what it was asked to start and answers with
 * the outcome the test queued. No process is ever spawned.
 */
function createFakeSupervisor(script = [], options = {}) {
  const started = [];
  const queue = script.slice();
  return {
    started,
    start(input) {
      const outcome = queue.shift() || {};
      started.push({ ...input, outcome });
      return { id: `p${started.length}`, ...outcome, startedAt: 0 };
    },
    async waitForExit(id) {
      const entry = started[Number(String(id).slice(1)) - 1] || {};
      const outcome = entry.outcome || {};
      return {
        ok: outcome.exitCode === 0 && !outcome.timedOut,
        status: outcome.timedOut ? 'timed_out' : 'exited',
        exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
        signal: outcome.signal || null,
        timedOut: outcome.timedOut === true,
        killed: outcome.killed === true,
        durationMs: Number.isFinite(outcome.durationMs) ? outcome.durationMs : 5,
        waitedMs: 5,
        output: outcome.output || '',
      };
    },
    options,
  };
}

const DISCOVERY = {
  commands: {
    install: { command: 'npm ci', acceptsFocus: false, evidence: 'fixture' },
    build: { command: 'npm run build', acceptsFocus: false, evidence: 'fixture' },
    test: { command: 'npm test --silent', acceptsFocus: false, evidence: 'fixture' },
    focusedTest: { command: 'node --test', acceptsFocus: true, evidence: 'fixture' },
  },
};

/** A passing outcome for every level the ladder can run. */
function passingRuns() {
  return [
    { exitCode: 0, output: '# tests 12\n# pass 12\n# fail 0\n' },
    { exitCode: 0, output: '# tests 40\n# pass 40\n# fail 0\n' },
    { exitCode: 0, output: '# tests 300\n# pass 300\n# fail 0\n' },
  ];
}

function makeVerifier(options = {}) {
  const clock = options.clock || createClock();
  const supervisor = options.supervisor || createFakeSupervisor(passingRuns());
  const verifier = createVerifier({
    supervisor,
    workspace: options.workspace || process.cwd(),
    discovery: options.discovery || DISCOVERY,
    now: clock.now,
    truncate: 'truncate' in options ? options.truncate : fakeTruncate,
    mutations: options.mutations,
    required: options.required,
  });
  return { verifier, supervisor, clock };
}

/** Run `git` in a fixture repository the tests own. */
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

/** A real repository under the temp root, configured so commits are reproducible. */
function gitFixture(label) {
  const root = tempRoot(label);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'foreman@example.invalid');
  git(root, 'config', 'user.name', 'Project Foreman');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  return root;
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
  return absolute;
}

/**
 * A volume root other than the one `target` lives on, when this host has one.
 *
 * Cross-volume cleanup only means anything when two volumes exist, so a host with
 * a single volume is reported as unavailable rather than faked.
 */
function otherVolumeRoot(target) {
  const own = path.parse(path.resolve(target)).root.toLowerCase();
  for (const candidate of ['C:\\', 'D:\\', 'E:\\', 'F:\\']) {
    const root = path.parse(candidate).root;
    if (root.toLowerCase() === own) continue;
    if (fs.existsSync(root)) return root;
  }
  return null;
}

/** The shape every run result — successful or not — must have. */
const RUN_KEYS = ['args', 'at', 'command', 'cwd', 'durationMs', 'exitCode', 'failure', 'killed', 'level', 'ok', 'operation', 'output', 'pid', 'reason', 'signal', 'testSummary', 'timedOut'];

/* ================================================================== *
 * verifier — the levels, and what actually runs
 * ================================================================== */

test('the ladder is frozen, ordered weakest first, and every level is recognised', () => {
  assert.equal(Object.isFrozen(VERIFICATION_LEVELS), true);
  assert.equal(Object.isFrozen(VERIFICATION_LADDER), true);
  assert.equal(Object.isFrozen(LEVEL_COMMANDS), true);
  assert.deepEqual({ ...VERIFICATION_LEVELS }, { FOCUSED: 'focused-test', AFFECTED: 'affected-test', FULL: 'full-verify' });
  assert.deepEqual([...VERIFICATION_LADDER], ['focused-test', 'affected-test', 'full-verify']);
  assert.deepEqual([...LEVEL_COMMANDS['focused-test']], ['focusedTest', 'test']);
  assert.deepEqual([...LEVEL_COMMANDS['affected-test']], ['test', 'focusedTest']);
  assert.deepEqual([...LEVEL_COMMANDS['full-verify']], ['test', 'focusedTest']);
  assert.equal(DEFAULT_TIMEOUT_MS, 30 * 60_000);
  assert.equal(DEFAULT_MAX_BYTES, 256 * 1024);
  for (const level of VERIFICATION_LADDER) assert.equal(isVerificationLevel(level), true);
  for (const other of ['focused', 'FULL', '', 'full-verify ', 'affected-test\n']) assert.equal(isVerificationLevel(other), false, `${JSON.stringify(other)} is not a rung`);
});

test('commandFor answers which command a level would run without running it', () => {
  const { verifier, supervisor } = makeVerifier({});
  assert.deepEqual(
    { ...verifier.commandFor('focused-test'), command: { ...verifier.commandFor('focused-test').command } },
    { level: 'focused-test', operation: 'focusedTest', command: { command: 'node --test', acceptsFocus: true, evidence: 'fixture' } },
  );
  assert.equal(verifier.commandFor('affected-test').operation, 'test');
  assert.equal(verifier.commandFor('full-verify').operation, 'test');
  assert.equal(verifier.commandFor('not-a-level').operation, null);
  assert.equal(supervisor.started.length, 0, 'resolving a command must not execute it');
  assert.equal(verifier.lastRun('focused-test'), null);
  assert.deepEqual(verifier.history(), []);
});

test('a level with no focused command falls back to the broader test command', async () => {
  const { verifier } = makeVerifier({
    discovery: { commands: { test: { command: 'npm test', acceptsFocus: false } } },
    supervisor: createFakeSupervisor([{ exitCode: 0 }]),
  });
  assert.equal(verifier.commandFor('focused-test').operation, 'test');
  const result = await verifier.run('focused-test');
  assert.equal(result.operation, 'test');
  assert.equal(result.ok, true, 'the fallback the ladder declares is a real run, not a refusal');
});

test('a run resolves the level command, appends the focus and goes through the supervisor', async () => {
  const { verifier, supervisor } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 0, output: '# tests 1\n# pass 1\n# fail 0\n' }]) });
  const result = await verifier.run(VERIFICATION_LEVELS.FOCUSED, { focus: 'tests/unit/foo.test.js' });
  assert.equal(supervisor.started.length, 1, 'the verifier must never spawn a process itself');
  assert.equal(supervisor.started[0].command, 'node');
  assert.deepEqual(supervisor.started[0].args, ['--test', 'tests/unit/foo.test.js']);
  assert.equal(supervisor.started[0].class, 'test');
  assert.equal(supervisor.started[0].ownership, 'episode');
  assert.equal(supervisor.started[0].step, null);
  assert.equal(result.level, 'focused-test');
  assert.equal(result.operation, 'focusedTest');
  assert.equal(result.cwd, process.cwd());
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.testSummary, { tests: 1, passed: 1, failed: 0, durationMs: null, framework: 'node-test' });
});

test('a focus is not appended to a command that does not accept one', async () => {
  const { verifier, supervisor } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 0 }]) });
  await verifier.run(VERIFICATION_LEVELS.FULL, { focus: 'tests/unit/foo.test.js' });
  assert.equal(supervisor.started[0].command, 'npm');
  assert.deepEqual(supervisor.started[0].args, ['test', '--silent']);
});

test('a focusedTest command accepts a focus even when it does not declare one', async () => {
  const { verifier, supervisor } = makeVerifier({
    discovery: { commands: { focusedTest: { command: 'node --test' } } },
    supervisor: createFakeSupervisor([{ exitCode: 0 }]),
  });
  await verifier.run('focused-test', { focus: 'tests/a.test.mjs' });
  assert.deepEqual(supervisor.started[0].args, ['--test', 'tests/a.test.mjs']);
  assert.equal(verifier.commandFor('focused-test').command.acceptsFocus, undefined, 'the descriptor is not rewritten, only the decision');
});

test('a declared command keeps its own arguments and its own cwd', async () => {
  const workdir = tempRoot('cwd');
  const { verifier, supervisor } = makeVerifier({
    discovery: { commands: { test: { command: 'node --test --reporter tap', args: ['--test-concurrency=1'], cwd: workdir, timeoutMs: 1234 } } },
    supervisor: createFakeSupervisor([{ exitCode: 0 }]),
  });
  await verifier.run('full-verify');
  assert.equal(supervisor.started[0].command, 'node');
  assert.deepEqual(supervisor.started[0].args, ['--test', '--reporter', 'tap', '--test-concurrency=1']);
  assert.equal(supervisor.started[0].cwd, workdir);
  assert.equal(supervisor.started[0].softTimeoutMs, 1234, 'the command\'s own bound wins over the default');
});

test('a level with no discovered command reports the refusal instead of guessing one', async () => {
  const { verifier, supervisor } = makeVerifier({ discovery: { commands: {} }, supervisor: createFakeSupervisor([]) });
  const result = await verifier.run(VERIFICATION_LEVELS.FOCUSED);
  assert.equal(result.ok, false);
  assert.equal(supervisor.started.length, 0);
  assert.ok(result.reason.includes('no command was discovered'));
  assert.equal(result.failure.class, 'unknown');
  assert.equal(result.failure.action, 'inspect');
  assert.equal(result.failure.signature, 'unknown|focused-test|nocmd|run-not-started');
  assert.deepEqual(result.args, []);
  assert.deepEqual(result.output, { text: '', bytes: 0, originalBytes: 0, truncated: false, head: '', tail: '', errorRegion: '' });
});

test('an unknown level and an empty command are refusals that are still recorded', async () => {
  const { verifier, supervisor } = makeVerifier({ supervisor: createFakeSupervisor([]) });
  const unknown = await verifier.run('lint-everything');
  assert.equal(unknown.ok, false);
  assert.ok(unknown.reason.includes('"lint-everything" is not a verification level'));
  assert.equal(supervisor.started.length, 0, 'a refusal may not start a process');

  const blank = makeVerifier({ discovery: { commands: { test: { command: '   ' } } }, supervisor: createFakeSupervisor([]) });
  const blanked = await blank.verifier.run('full-verify');
  assert.equal(blanked.ok, false);
  assert.equal(blanked.operation, 'test');
  assert.equal(blanked.reason, 'the full-verify command is empty');
  assert.equal(blank.supervisor.started.length, 0);

  assert.equal(verifier.history().length, 1, 'a refusal that never started is still durable evidence');
  assert.equal(verifier.lastRun('lint-everything'), null, 'a refusal is audit trail, not the level\'s state');
  assert.equal(verifier.freshAt('lint-everything').at, null);
  assert.equal(verifier.freshAt('lint-everything').reason, 'the lint-everything level has never run');
});

test('a non-zero exit is classified from the output and is not a success', async () => {
  const { verifier } = makeVerifier({
    supervisor: createFakeSupervisor([{ exitCode: 1, output: 'AssertionError: expected 1 to equal 2\n' }]),
  });
  const result = await verifier.run(VERIFICATION_LEVELS.FULL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(typeof result.failure.class, 'string');
  assert.ok(result.failure.reason.length > 0);
  assert.match(result.reason, /\w/);
});

test('a timeout is a failure with the timeout class', async () => {
  const { verifier } = makeVerifier({
    supervisor: createFakeSupervisor([{ exitCode: null, timedOut: true, killed: true, output: 'the run exceeded its 100ms budget' }]),
  });
  const result = await verifier.run(VERIFICATION_LEVELS.FULL);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.failure.class, 'timeout');
});

test('a killed process is not a success even when it exited zero', async () => {
  const { verifier } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 0, killed: true }]) });
  const result = await verifier.run(VERIFICATION_LEVELS.FULL);
  assert.equal(result.ok, false);
  assert.equal(result.killed, true);
});

test('a signalled exit is not a success', async () => {
  const { verifier } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: null, signal: 'SIGKILL' }]) });
  const result = await verifier.run(VERIFICATION_LEVELS.FULL);
  assert.equal(result.ok, false);
  assert.equal(result.signal, 'SIGKILL');
});

test('a successful run is never left without a reason slot: ok runs carry reason null and failure null', async () => {
  const { verifier } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 0 }]) });
  const result = await verifier.run('full-verify');
  assert.equal(result.ok, true);
  assert.equal(result.failure, null);
  assert.equal(result.reason, null);
});

test('every run carries a timeout and truncates the output it retains', async () => {
  const long = 'x'.repeat(4_000);
  const supervisor = createFakeSupervisor([{ exitCode: 0, output: long }]);
  const verifier = createVerifier({
    supervisor,
    workspace: process.cwd(),
    discovery: DISCOVERY,
    truncate: fakeTruncate,
    maxBytes: 512,
  });
  const result = await verifier.run(VERIFICATION_LEVELS.FULL);
  assert.equal(supervisor.started[0].softTimeoutMs, 30 * 60_000, 'the run defaults to the thirty-minute bound');
  assert.equal(supervisor.started[0].hardTimeoutMs, supervisor.started[0].softTimeoutMs);
  assert.equal(result.output.truncated, true);
  assert.ok(result.output.originalBytes > 512);
  assert.ok(Buffer.byteLength(result.output.text) < result.output.originalBytes);
});

test('a refused start is reported as a failure rather than thrown', async () => {
  const supervisor = {
    start() {
      throw new Error('the runtime already owns too many processes');
    },
    async waitForExit() {
      throw new Error('never reached');
    },
  };
  const { verifier } = makeVerifier({ supervisor });
  const result = await verifier.run(VERIFICATION_LEVELS.FULL);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('refused to start'));
});

test('a supervisor that starts nothing, or cannot be awaited, is a failure and not a crash', async () => {
  const nothing = makeVerifier({ supervisor: { start: () => ({}), waitForExit: async () => ({}) } });
  const empty = await nothing.verifier.run('full-verify');
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'the supervisor started nothing (no process id)');

  const throws = makeVerifier({
    supervisor: { start: () => ({ id: 'p1' }), waitForExit: async () => { throw new Error('the wait queue is gone') } },
  });
  const lost = await throws.verifier.run('full-verify');
  assert.equal(lost.ok, false);
  assert.equal(lost.pid, null, 'the donor\'s never-started record does not carry the pid it did start');
  assert.ok(lost.reason.includes('could not be awaited'));
});

test('the waiter wins over the start record for exit code, signal and duration', async () => {
  const supervisor = {
    start: () => ({ id: 'p1', exitCode: 0, signal: null, timedOut: false, killed: false }),
    waitForExit: async () => ({ exitCode: 2, signal: 'SIGTERM', timedOut: false, killed: false, durationMs: 77, output: 'boom' }),
  };
  const { verifier } = makeVerifier({ supervisor });
  const result = await verifier.run('full-verify');
  assert.equal(result.exitCode, 2);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.durationMs, 77);
  assert.equal(result.ok, false);
});

test('an entry record is used when the waiter is silent, including stdout+stderr concatenation', async () => {
  const supervisor = {
    start: () => ({ id: 'p1', exitCode: 1, stdout: '# tests 1\n', stderr: '# fail 1\n' }),
    waitForExit: async () => ({}),
  };
  const { verifier } = makeVerifier({ supervisor });
  const result = await verifier.run('full-verify');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.testSummary, { tests: 1, passed: null, failed: 1, durationMs: null, framework: 'node-test' });
});

test('runLevels stops at the first level that breaks and names it', async () => {
  const { verifier } = makeVerifier({
    supervisor: createFakeSupervisor([
      { exitCode: 0, output: '# tests 3\n# pass 3\n# fail 0\n' },
      { exitCode: 1, output: '1 failed, 11 passed in 2.3s' },
    ]),
  });
  const verdict = await verifier.runLevels([VERIFICATION_LEVELS.FOCUSED, VERIFICATION_LEVELS.AFFECTED, VERIFICATION_LEVELS.FULL]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.broken, 'affected-test');
  assert.deepEqual(verdict.ran, ['focused-test']);
  assert.equal(verdict.results.length, 2);
  assert.equal(verdict.reason, 'the affected-test level failed: unit-test: a failing unit test needs a code change');
});

test('runLevels with no argument climbs the levels this verifier requires', async () => {
  const { verifier } = makeVerifier({});
  const verdict = await verifier.runLevels();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.broken, null);
  assert.deepEqual(verdict.ran, ['focused-test', 'affected-test', 'full-verify']);
  assert.deepEqual(verifier.required, ['focused-test', 'affected-test', 'full-verify']);
});

test('satisfied() is false when the full level never ran', () => {
  const { verifier } = makeVerifier({});
  const gate = verifier.satisfied();
  assert.equal(gate.ok, false);
  assert.ok(gate.missing.includes('full-verify'));
  assert.ok(gate.reason.length > 0);
  assert.deepEqual(gate.missing, ['focused-test', 'affected-test', 'full-verify']);
});

test('satisfied() is true only with fresh passing evidence at every required level', async () => {
  const clock = createClock();
  const { verifier } = makeVerifier({
    clock,
    supervisor: createFakeSupervisor([
      { exitCode: 0, output: '# tests 12\n# pass 12\n# fail 0\n' },
      { exitCode: 0, output: '# tests 40\n# pass 40\n# fail 0\n' },
      { exitCode: 0, output: '# tests 300\n# pass 300\n# fail 0\n' },
    ]),
  });
  const verdict = await verifier.runLevels();
  assert.equal(verdict.ok, true);
  const gate = verifier.satisfied();
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.missing, []);
  assert.equal(gate.reason, 'every required level passed with fresh evidence: focused-test, affected-test, full-verify');
});

test('satisfied() refuses a level that ran and did not pass', async () => {
  const { verifier } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 1, output: 'AssertionError: nope' }]) });
  await verifier.run('focused-test');
  const gate = verifier.satisfied({ levels: ['focused-test'] });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.missing, ['focused-test']);
  assert.ok(gate.reason.includes('last ran and did not pass'));
});

test('satisfied() is false when the full level evidence predates a mutation', async () => {
  const clock = createClock();
  const mutations = { all: () => [{ at: clock.now() - 1, path: 'src/a.js' }] };
  const { verifier } = makeVerifier({ clock, mutations });
  await verifier.runLevels();
  assert.equal(verifier.satisfied().ok, true);
  // A mutation recorded after the green run invalidates it, because the tree the
  // evidence describes no longer exists.
  const mutationAt = clock.advance(10);
  mutations.all = () => [{ at: mutationAt, path: 'src/b.js' }];
  const after = verifier.satisfied();
  assert.equal(after.ok, false);
  assert.ok(after.missing.includes('full-verify'));
  assert.ok(after.reason.includes('full-verify'));
});

test('satisfied() honours sinceAt and sinceMs against the clock', async () => {
  const clock = createClock();
  const { verifier } = makeVerifier({ clock });
  await verifier.runLevels();
  const now = clock.now();
  assert.equal(verifier.satisfied({ sinceAt: now - 1 }).ok, true);
  assert.equal(verifier.satisfied({ sinceAt: now + 1 }).ok, false);
  assert.equal(verifier.satisfied({ sinceMs: 1_000 }).ok, true);
  clock.advance(60_000);
  const aged = verifier.satisfied({ sinceMs: 1_000 });
  assert.equal(aged.ok, false);
  assert.ok(aged.missing.includes('full-verify'));
});

test('satisfied() with an explicit level set answers only for those levels', async () => {
  const { verifier } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 0 }]) });
  await verifier.run('focused-test');
  assert.equal(verifier.satisfied({ levels: ['focused-test'] }).ok, true);
  assert.equal(verifier.satisfied({ levels: ['full-verify'] }).ok, false);
  assert.equal(verifier.satisfied({ levels: ['full-verify'] }).missing[0], 'full-verify');
});

test('invalidate marks the levels stale and makes the gate refuse', async () => {
  const clock = createClock();
  const { verifier } = makeVerifier({ clock });
  await verifier.runLevels();
  assert.equal(verifier.satisfied().ok, true);
  clock.advance(5);
  const dropped = verifier.invalidate('the patch changed src/a.js');
  assert.equal(dropped.ok, true);
  assert.deepEqual(dropped.stale, ['focused-test', 'affected-test', 'full-verify']);
  assert.equal(dropped.generations, 1);
  const state = verifier.stale();
  assert.equal(state.stale, true);
  assert.deepEqual(state.staleLevels, ['focused-test', 'affected-test', 'full-verify']);
  assert.equal(verifier.satisfied().ok, false);
  assert.equal(verifier.evidence().invalidation.reason, 'the patch changed src/a.js');
});

test('invalidate drops only the evidence at or before its own timestamp', async () => {
  const clock = createClock();
  const { verifier } = makeVerifier({ clock, supervisor: createFakeSupervisor([{ exitCode: 0 }, { exitCode: 0 }]) });
  await verifier.run('focused-test');
  clock.advance(5);
  const dropped = verifier.invalidate('halfway');
  assert.deepEqual(dropped.stale, ['focused-test', 'affected-test', 'full-verify']);
  clock.advance(1);
  await verifier.run('focused-test');
  assert.deepEqual(verifier.stale().staleLevels, ['affected-test', 'full-verify'], 'evidence produced after the invalidation is still evidence');
  assert.equal(verifier.stale().levels['focused-test'].stale, false);
  assert.equal(verifier.stale().levels['affected-test'].reason, 'the affected-test level has not run');
});

test('noteMutation bounds freshness for a verifier that has no mutation log', async () => {
  const clock = createClock();
  const { verifier } = makeVerifier({ clock });
  await verifier.runLevels();
  assert.equal(verifier.satisfied().ok, true);
  const changedAt = clock.advance(20);
  verifier.noteMutation(changedAt);
  assert.equal(verifier.satisfied().ok, false);
  assert.equal(verifier.stale().stale, true);
});

test('noteMutation keeps the newest time and counts every note', async () => {
  const clock = createClock();
  const { verifier } = makeVerifier({ clock });
  const first = verifier.noteMutation(clock.now());
  assert.deepEqual(first, { at: 1_000, count: 1 });
  clock.advance(10);
  const older = verifier.noteMutation({ at: 500 });
  assert.deepEqual(older, { at: 1_000, count: 2 }, 'an older note cannot move the boundary backwards');
  const newer = verifier.noteMutation();
  assert.deepEqual(newer, { at: 1_010, count: 3 });
  assert.equal(verifier.evidence().mutations, 3);
});

test('evidence() reports when each level last ran and whether it is fresh', async () => {
  const clock = createClock();
  const { verifier } = makeVerifier({ clock });
  const focusedAt = clock.now();
  await verifier.run(VERIFICATION_LEVELS.FOCUSED, { focus: 'tests/unit/foo.test.js' });
  await verifier.runLevels([VERIFICATION_LEVELS.AFFECTED, VERIFICATION_LEVELS.FULL]);
  const recorded = verifier.evidence();
  assert.equal(recorded.levels['focused-test'].at, focusedAt);
  assert.equal(recorded.levels['focused-test'].ok, true);
  assert.equal(recorded.fresh, true);
  assert.equal(recorded.commands.length, 3);
  assert.equal(recorded.commands[0].level, 'focused-test');
  assert.equal(recorded.commands[0].truncated, false);
});

test('freshAt() with no level answers when anything was last verified', async () => {
  const clock = createClock();
  const { verifier } = makeVerifier({ clock });
  const empty = verifier.freshAt();
  assert.equal(empty.at, null);
  assert.equal(empty.ok, false);
  assert.equal(empty.level, null);
  assert.equal(empty.reason, 'nothing has been verified yet');
  const startedAt = clock.advance(5);
  await verifier.run(VERIFICATION_LEVELS.FOCUSED, { focus: 'tests/unit/foo.test.js' });
  const summary = verifier.freshAt();
  assert.equal(summary.at, startedAt, 'the episode report reads when evidence was last produced');
  assert.equal(summary.level, 'focused-test');
  assert.equal(summary.ok, true);
  clock.advance(3);
  verifier.invalidate('the patch changed src/a.js');
  assert.equal(verifier.freshAt().ok, false, 'invalidated evidence is not fresh');
});

test('freshAt(level) refuses a level that never ran, failed, or aged out', async () => {
  const clock = createClock();
  const { verifier } = makeVerifier({ clock: clock, supervisor: createFakeSupervisor([{ exitCode: 1, output: 'AssertionError: x' }]) });
  assert.equal(verifier.freshAt('full-verify').reason, 'the full-verify level has never run');
  await verifier.run('full-verify');
  const failed = verifier.freshAt('full-verify');
  assert.equal(failed.ok, false);
  assert.ok(failed.reason.includes('did not pass'));
});

test('setDiscovery points the verifier at a new command table without rebuilding it', async () => {
  const { verifier, supervisor } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 0 }, { exitCode: 0 }]) });
  await verifier.run('full-verify');
  assert.equal(supervisor.started[0].command, 'npm');
  verifier.setDiscovery({ commands: { test: { command: 'pnpm test' } } });
  assert.equal(verifier.commandFor('full-verify').command.command, 'pnpm test');
  await verifier.run('full-verify');
  assert.equal(supervisor.started[1].command, 'pnpm');
});

test('the audit trail is bounded and every recorded run has the same shape', async () => {
  const script = Array.from({ length: 6 }, () => ({ exitCode: 0, output: '# tests 1\n# pass 1\n# fail 0\n' }));
  const supervisor = createFakeSupervisor(script);
  const verifier = createVerifier({
    supervisor,
    workspace: process.cwd(),
    discovery: DISCOVERY,
    truncate: fakeTruncate,
    now: (() => { let value = 0; return () => (value += 1); })(),
    historyLimit: 3,
  });
  for (let index = 0; index < 6; index += 1) await verifier.run('full-verify');
  assert.equal(verifier.history().length, 3, 'the audit trail is bounded, the state is not');
  assert.equal(verifier.satisfied({ levels: ['full-verify'] }).ok, true);
  for (const entry of verifier.history()) {
    for (const key of RUN_KEYS) assert.ok(key in entry, `a recorded run must carry ${key}`);
  }
  assert.equal(verifier.history()[0].output.originalBytes, 28);
});

test('createVerifier refuses to exist without a supervisor or a workspace', () => {
  assert.throws(() => createVerifier(null), /needs an options object/);
  assert.throws(() => createVerifier(), /needs a process supervisor with start\(\) and waitForExit\(\)/);
  assert.throws(() => createVerifier({}), /needs a process supervisor with start\(\) and waitForExit\(\)/);
  assert.throws(() => createVerifier({ supervisor: { start() {}, waitForExit() {} } }), /needs the verified workspace path/);
  assert.throws(() => createVerifier({ workspace: process.cwd() }), /needs a process supervisor/);
});

test('the workspace and required levels are exposed without letting a caller mutate them', () => {
  const { verifier } = makeVerifier({ workspace: process.cwd(), required: ['full-verify'] });
  assert.equal(verifier.workspace, process.cwd());
  const required = verifier.required;
  required.push('focused-test');
  assert.deepEqual(verifier.required, ['full-verify'], 'a caller must not be able to widen its own gate');
  assert.equal(verifier.invalidations, 0);
});

test('the default truncation seam resolves the sibling checkpoint module and bounds real output', async () => {
  // No `truncate` option: the module's own fallback must load `./checkpoint.mjs`
  // and use its `truncateOutput(text, { maxBytes })`.
  const long = `${'y'.repeat(3_000)}\n# tests 2\n# pass 2\n# fail 0\n`;
  const supervisor = createFakeSupervisor([{ exitCode: 0, output: long }]);
  const verifier = createVerifier({ supervisor, workspace: process.cwd(), discovery: DISCOVERY, maxBytes: 256 });
  const result = await verifier.run('full-verify');
  assert.equal(result.ok, true);
  assert.equal(result.output.truncated, true);
  assert.ok(result.output.originalBytes > 256);
  assert.ok(Buffer.byteLength(result.output.text) < result.output.originalBytes);
});

/* ================================================================== *
 * verifier — summary parsing
 * ================================================================== */

test('parseTestSummary reads node --test TAP-ish output', () => {
  const summary = parseTestSummary('# tests 12\n# pass 11\n# fail 1\n# duration_ms 421.5\n');
  assert.deepEqual(summary, { tests: 12, passed: 11, failed: 1, durationMs: 422, framework: 'node-test' });
});

test('parseTestSummary reads Jest and Vitest output', () => {
  const summary = parseTestSummary('Test Suites: 1 failed, 3 passed, 4 total\nTests:       1 failed, 11 passed, 12 total\nTime:        2.35 s\n');
  assert.equal(summary.tests, 12);
  assert.equal(summary.passed, 11);
  assert.equal(summary.failed, 1);
  assert.equal(summary.durationMs, 2350);
  assert.equal(summary.framework, 'jest-vitest', 'a Jest summary must not be mistaken for a pytest one');
});

test('parseTestSummary reads pytest output', () => {
  const summary = parseTestSummary('==================== 1 failed, 11 passed in 2.3s ====================');
  assert.equal(summary.tests, 12);
  assert.equal(summary.passed, 11);
  assert.equal(summary.failed, 1);
  assert.equal(summary.durationMs, 2300);
  assert.equal(summary.framework, 'pytest');
  assert.equal(parseTestSummary('===== 11 passed in 0.41s =====').failed, 0);
});

test('parseTestSummary reads cargo test output', () => {
  const summary = parseTestSummary('test result: FAILED. 11 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out');
  assert.equal(summary.tests, 12);
  assert.equal(summary.passed, 11);
  assert.equal(summary.failed, 1);
  assert.equal(summary.framework, 'cargo-test');
  assert.equal(summary.status, 'failed');
  const ok = parseTestSummary('test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured');
  assert.equal(ok.failed, 0);
  assert.equal(ok.status, 'ok');
});

test('parseTestSummary returns null for junk and never throws', () => {
  for (const junk of ['', '   ', 'all good, trust me', 'Compiling ds-harness v1.0.0', null, undefined, 42, {}, []]) {
    assert.equal(parseTestSummary(junk), null, `junk must not produce a summary: ${String(junk)}`);
  }
});

test('a summary field that is absent stays null and is never guessed at zero', () => {
  // Silence about failures is not "no failures": a report that invents failed: 0
  // is exactly the false evidence the verifier exists to prevent.
  assert.deepEqual(parseTestSummary('# tests 3\n# pass 3\n'), { tests: 3, passed: 3, failed: null, durationMs: null, framework: 'node-test' });
  assert.deepEqual(parseTestSummary('# pass 3\n# fail 0\n'), { tests: null, passed: 3, failed: 0, durationMs: null, framework: 'node-test' });
  const jest = parseTestSummary('Tests: 12 passed, 12 total\n');
  assert.equal(jest.failed, null, 'a passing Jest line names no failures, so the count is unknown and not zero');
  assert.equal(jest.passed, 12);
  assert.equal(jest.durationMs, null);
  const cargo = parseTestSummary('test result: ok. 7 passed; 0 ignored');
  assert.equal(cargo.failed, null);
  assert.equal(cargo.tests, null);
  assert.equal(cargo.durationMs, null);
});

test('pytest reports at least one failure when the run failed without naming a count', () => {
  const summary = parseTestSummary('===== 2 errors in 1.2s =====');
  assert.equal(summary.errors, 2);
  assert.equal(summary.failed, 2, 'an error count is a failure count');
  assert.equal(summary.passed, null, 'silence about passed is not a passing count');
  assert.equal(summary.tests, null);
  assert.equal(summary.durationMs, 1200);
});

test('cargo reports at least one failure when the summary says FAILED but the count is elsewhere', () => {
  const summary = parseTestSummary('test result: FAILED. 3 passed; 0 ignored; 0 measured');
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failed, 1, 'the parser still reports a failure rather than a reassuring zero');
  assert.equal(summary.tests, 4);
});

test('a Jest line that names no recognised clause is not a summary at all', () => {
  assert.equal(parseTestSummary('Tests: 1 flaky, 2 broken'), null);
  assert.equal(parseTestSummary('Tests:        \n'), null);
});

test('the summary parsers can be called on their own and each refuses foreign output', () => {
  assert.equal(parseNodeTest('# tests 1\n# pass 1\n# fail 0\n').framework, 'node-test');
  assert.equal(parseNodeTest('Tests: 1 failed, 1 passed, 2 total'), null);
  assert.equal(parseJestVitest('Tests: 1 failed, 1 passed, 2 total').skipped, null);
  assert.equal(parseJestVitest('Tests: 1 failed, 1 passed, 2 total, 3 skipped').skipped, 3);
  assert.equal(parsePytest('test result: ok. 1 passed; 0 failed'), null);
  assert.equal(parseCargoTest('===== 1 passed in 0.1s ====='), null);
});

test('splitCommand keeps a quoted argument together', () => {
  assert.deepEqual(splitCommand('node --test "tests/a b.test.mjs"'), { command: 'node', args: ['--test', 'tests/a b.test.mjs'] });
  assert.deepEqual(splitCommand("npm test -- --grep 'a b'"), { command: 'npm', args: ['test', '--', '--grep', 'a b'] });
  assert.deepEqual(splitCommand('   '), { command: '', args: [] });
  assert.deepEqual(splitCommand(undefined), { command: '', args: [] });
  assert.deepEqual(splitCommand('node'), { command: 'node', args: [] });
});

/* ================================================================== *
 * result — every acceptance gate
 * ================================================================== */

/** A verification record that satisfies every level the default contract needs. */
function passingVerification(extra = {}) {
  return {
    at: 500,
    levels: { 'full-verify': { at: 500, ok: true, command: 'npm test', fresh: true } },
    fresh: true,
    satisfied: true,
    missing: [],
    reason: 'every required level passed with fresh evidence: full-verify',
    stale: false,
    staleLevels: [],
    invalidation: null,
    invalidations: 0,
    mutations: 0,
    commands: [{ level: 'full-verify', command: 'npm test', at: 500 }],
    checkedAt: 500,
    ...extra,
  };
}

/** Every input a COMPLETED verdict needs. */
function passingInput(extra = {}) {
  return {
    contract: {},
    criteria: { satisfied: true, unknown: false, results: [{ id: 'c1', ok: true }] },
    verification: passingVerification(),
    ...extra,
  };
}

function validator(options = {}) {
  const clock = options.clock || createClock();
  return { validator: createResultValidator({ now: clock.now, ...options }), clock };
}

test('the refusal vocabulary is frozen and carries the donor\'s exact nine reasons', () => {
  assert.equal(Object.isFrozen(REFUSAL_REASONS), true);
  assert.deepEqual({ ...REFUSAL_REASONS }, {
    CRITERIA: 'success criteria are not satisfied',
    FRESHNESS: 'the required verification is not fresh',
    TESTS: 'the required tests did not pass',
    BUILD: 'the required build did not pass',
    LINT: 'the required lint did not pass',
    UNRESOLVED_FAILURE: 'an unresolved critical failure remains',
    WORKSPACE: 'the workspace is no longer valid',
    LEAK: 'the runtime left a resource behind',
    NOTHING_RAN: 'no verification was ever executed',
  });
});

test('an episode that meets every gate is COMPLETED with no reasons', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, 'COMPLETED');
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.at, 1_000);
  // criteria, tests and the two unconditional gates (unresolved failures,
  // something ran) — build, lint, workspace and leaks add nothing when absent.
  assert.deepEqual(verdict.evidence, { requiredLevels: ['full-verify'], lastMutationAt: null, ran: 1, checked: 4 });
});

test('gate 1 — unsatisfied criteria refuse with the criteria reason', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({ criteria: { satisfied: false, unknown: false, results: [{ id: 'c1', ok: false }] } }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.verdict, 'REFUSED');
  assert.deepEqual(verdict.reasons, [REFUSAL_REASONS.CRITERIA]);
  assert.equal(verdict.checks[0].ok, false);
  assert.deepEqual(verdict.checks[0].evidence.results, [{ id: 'c1', ok: false }]);
});

test('gate 1 — an unknown criterion is not a satisfied one, even when satisfied is true', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({ criteria: { satisfied: true, unknown: true, results: [] } }));
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, [REFUSAL_REASONS.CRITERIA]);
  assert.equal(verdict.checks[0].evidence.unknown, true);
});

test('gate 1 — a missing criteria evaluation is a refusal, not an assumption', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate({ contract: {}, verification: passingVerification() });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, [REFUSAL_REASONS.CRITERIA]);
});

test('gate 2 — a required level that never ran refuses with its name', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({ verification: passingVerification({ levels: {} }) }));
  const tests = verdict.checks[1];
  assert.equal(tests.ok, false);
  assert.deepEqual(tests.evidence, { missing: ['full-verify'], required: ['full-verify'] });
  assert.ok(verdict.reasons.includes(REFUSAL_REASONS.TESTS));
});

test('gate 2 — a required level that ran and failed refuses with its name', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({ verification: passingVerification({ levels: { 'full-verify': { at: 500, ok: false, reason: 'unit-test: 1 failed' } } }) }));
  const tests = verdict.checks[1];
  assert.equal(tests.ok, false);
  assert.deepEqual(tests.evidence, { failed: ['full-verify'], required: ['full-verify'] });
  assert.ok(verdict.reasons.includes(REFUSAL_REASONS.TESTS));
});

test('gate 2 — a contract that declares its own levels is believed over the default', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({
    contract: { tests: ['unit', 'integration'] },
    verification: passingVerification({ levels: { unit: { at: 10, ok: true }, integration: { at: 11, ok: true } } }),
  }));
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.evidence.requiredLevels, ['unit', 'integration']);
});

test('gate 2 — the donor\'s "no test level" escape hatch is unreachable, and that is preserved', () => {
  // `contract.tests || contract.requiredTests || null` turns every falsy value —
  // including `false` — into `null`, so `declared === false` never holds and
  // `requiredTestLevels` can never return an empty list. The branch that skips the
  // gate therefore cannot be entered from `validate()`, and a contract that tries
  // to declare "no test level" is judged against the default instead. Preserved
  // exactly; reported as a donor bug rather than silently repaired.
  for (const declared of [false, [], null, '', 0]) {
    const { validator: gate } = validator({});
    const verdict = gate.validate(passingInput({ contract: { tests: declared }, verification: passingVerification({ levels: {} }) }));
    assert.equal(verdict.evidence.requiredLevels[0], 'full-verify', `${JSON.stringify(declared)} does not remove the requirement`);
    assert.ok(verdict.reasons.includes(REFUSAL_REASONS.TESTS));
    assert.equal(verdict.checks[1].evidence.skipped, undefined, 'the skip branch is never reached');
  }
});

test('gate 2 — requiredTestLevels mirrors the contract declaration', () => {
  const { validator: gate } = validator({});
  assert.deepEqual(gate.requiredTestLevels({}), ['full-verify']);
  assert.deepEqual(gate.requiredTestLevels({ tests: ['unit'] }), ['unit']);
  assert.deepEqual(gate.requiredTestLevels({ requiredTests: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(gate.requiredTestLevels({ tests: [1, 2] }), ['1', '2']);
  assert.deepEqual(gate.requiredTestLevels({ tests: false }), ['full-verify'], 'a falsy declaration is swallowed by the `||` chain');
  assert.deepEqual(gate.requiredTestLevels({ tests: [] }), ['full-verify'], 'an empty list is not a declaration either');
});

test('gate 3 — evidence older than the last change is not fresh', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({ lastMutationAt: 900 }));
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, [REFUSAL_REASONS.FRESHNESS]);
  const freshness = verdict.checks[2];
  assert.deepEqual(freshness.evidence, { staleSince: 900, levels: ['full-verify'] });
});

test('gate 3 — evidence at or after the last change is fresh, and a level without a timestamp is not judged', () => {
  const { validator: gate } = validator({});
  assert.equal(gate.validate(passingInput({ lastMutationAt: 500 })).ok, true);
  assert.equal(gate.validate(passingInput({ lastMutationAt: 499 })).ok, true);
  const untimed = gate.validate(passingInput({ lastMutationAt: 900, verification: passingVerification({ levels: { 'full-verify': { ok: true } } }) }));
  assert.equal(untimed.ok, true, 'a level with no timestamp cannot be shown to be stale');
});

test('gate 3 — a freshness window expires evidence against the clock', () => {
  const clock = createClock(10_000);
  const { validator: gate } = validator({ clock, freshnessWindowMs: 1_000 });
  const fresh = gate.validate(passingInput({ lastMutationAt: 1, verification: passingVerification({ at: 9_500, levels: { 'full-verify': { at: 9_500, ok: true } } }) }));
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.checks[2].evidence, { windowMs: 1_000 });
  clock.advance(2_000);
  const expired = gate.validate(passingInput({ lastMutationAt: 1, verification: passingVerification({ at: 9_500, levels: { 'full-verify': { at: 9_500, ok: true } } }) }));
  assert.equal(expired.ok, false);
  assert.deepEqual(expired.reasons, [REFUSAL_REASONS.FRESHNESS]);
  assert.deepEqual(expired.checks[2].evidence, { expired: ['full-verify'], windowMs: 1_000 });
});

test('gate 3 — the window is not consulted at all when there is no last-change timestamp', () => {
  const { validator: gate } = validator({ freshnessWindowMs: 1, clock: createClock(1_000_000) });
  const verdict = gate.validate(passingInput({ verification: passingVerification({ at: 0, levels: { 'full-verify': { at: 0, ok: true } } }) }));
  assert.equal(verdict.ok, true, 'the donor only ages evidence against a change, never against the clock alone');
  assert.equal(verdict.checks.length, 4, 'no freshness check is added');
});

test('gate 4 — a required build that did not run or pass refuses, and both spellings of the flag work', () => {
  for (const flag of ['require_build', 'requireBuild']) {
    const { validator: gate } = validator({});
    const missing = gate.validate(passingInput({ contract: { [flag]: true } }));
    assert.ok(missing.reasons.includes(REFUSAL_REASONS.BUILD), `${flag} must be honoured`);
    const build = missing.checks.find((entry) => entry.reason === REFUSAL_REASONS.BUILD);
    assert.equal(build.ok, false);
    assert.equal(build.evidence, null);
  }
  const { validator: gate } = validator({});
  const failed = gate.validate(passingInput({ contract: { require_build: true }, verification: passingVerification({ levels: { 'full-verify': { at: 500, ok: true }, build: { ok: false } } }) }));
  assert.deepEqual(failed.checks.find((entry) => entry.reason === REFUSAL_REASONS.BUILD).evidence, { ok: false });
  const passed = gate.validate(passingInput({ contract: { require_build: true }, verification: passingVerification({ levels: { 'full-verify': { at: 500, ok: true }, build: { ok: true } } }) }));
  assert.equal(passed.ok, true);
  const explicit = gate.validate(passingInput({ contract: { require_build: true }, build: { ok: true } }));
  assert.equal(explicit.ok, true, 'an explicit build record wins over the verification levels');
});

test('gate 5 — a required lint that did not run or pass refuses, and both spellings of the flag work', () => {
  for (const flag of ['require_lint', 'requireLint']) {
    const { validator: gate } = validator({});
    const verdict = gate.validate(passingInput({ contract: { [flag]: true } }));
    assert.ok(verdict.reasons.includes(REFUSAL_REASONS.LINT), `${flag} must be honoured`);
  }
  const { validator: gate } = validator({});
  const passed = gate.validate(passingInput({ contract: { require_lint: true }, verification: passingVerification({ levels: { 'full-verify': { at: 500, ok: true }, lint: { ok: true } } }) }));
  assert.equal(passed.ok, true);
  const failed = gate.validate(passingInput({ contract: { require_lint: true }, lint: { ok: false } }));
  assert.equal(failed.ok, false);
  assert.ok(failed.reasons.includes(REFUSAL_REASONS.LINT));
});

test('gate 6 — an unresolved critical failure refuses and only the first ten are carried', () => {
  const { validator: gate } = validator({});
  const unresolved = Array.from({ length: 12 }, (_, index) => ({ class: 'runtime', id: index }));
  const verdict = gate.validate(passingInput({ failures: { unresolved } }));
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, [REFUSAL_REASONS.UNRESOLVED_FAILURE]);
  const entry = verdict.checks.find((candidate) => candidate.reason === REFUSAL_REASONS.UNRESOLVED_FAILURE);
  assert.equal(entry.evidence.unresolved.length, 10);
  assert.deepEqual(verdict.checks.find((candidate) => candidate.reason === REFUSAL_REASONS.UNRESOLVED_FAILURE).evidence.unresolved[0], { class: 'runtime', id: 0 });
});

test('gate 6 — the gate judges the list it is handed, and the caller does the filtering', () => {
  const { validator: gate } = validator({});
  assert.equal(gate.validate(passingInput({ failures: { unresolved: [] } })).ok, true);
  // `validate()` refuses on any non-empty `unresolved` list: deciding which classes
  // are critical is `unresolvedFailures()`'s job, and it is the caller that runs it.
  for (const entry of [{ class: 'runtime', resolved: true }, { class: 'network' }, { class: 'timeout' }]) {
    assert.equal(gate.validate(passingInput({ failures: { unresolved: [entry] } })).ok, false, `${entry.class} is still an unresolved entry until the caller filters it`);
  }
  assert.deepEqual(
    gate.unresolvedFailures([{ class: 'runtime' }, { class: 'network' }, { class: 'runtime', resolved: true }]),
    [{ class: 'runtime' }],
    'the helper is what removes non-critical and already-resolved failures',
  );
  assert.equal(gate.validate(passingInput({ failures: { unresolved: gate.unresolvedFailures([{ class: 'network' }]) } })).ok, true);
});

test('unresolvedFailures keeps exactly the donor\'s critical classes', () => {
  const { validator: gate } = validator({});
  const critical = ['syntax', 'compile', 'type', 'unit-test', 'integration-test', 'runtime', 'filesystem', 'permission', 'workspace', 'unknown'];
  const other = ['timeout', 'network', 'dependency', 'resource', 'ui', 'transport'];
  const kept = gate.unresolvedFailures([...critical.map((cls) => ({ class: cls })), ...other.map((cls) => ({ class: cls }))]);
  assert.deepEqual(kept.map((entry) => entry.class), critical);
  assert.equal(gate.unresolvedFailures([{ class: 'runtime', resolved: true }]).length, 0);
  assert.deepEqual(gate.unresolvedFailures(null), []);
  assert.deepEqual(gate.unresolvedFailures([null, undefined, { class: 'runtime' }]).length, 1);
});

test('gate 7 — a workspace that is no longer valid refuses with its own reason', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({ workspace: { ok: false, cwd: 'D:\\gone', reason: 'ENOENT' } }));
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, [REFUSAL_REASONS.WORKSPACE]);
  const entry = verdict.checks.find((candidate) => candidate.reason === REFUSAL_REASONS.WORKSPACE);
  assert.deepEqual(entry.evidence, { cwd: 'D:\\gone', reason: 'ENOENT' });
});

test('gate 7 — a workspace check is only made when one is supplied, and ok:true passes', () => {
  const { validator: gate } = validator({});
  assert.equal(gate.validate(passingInput({ workspace: { ok: true, cwd: 'D:\\works' } })).ok, true);
  assert.equal(gate.validate(passingInput()).checks.some((entry) => entry.reason === REFUSAL_REASONS.WORKSPACE), false);
});

test('gate 8 — a leak count above zero refuses and names the offenders', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({ leaks: { processes: 1, watchers: 0, listeners: 2 } }));
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, [REFUSAL_REASONS.LEAK]);
  const entry = verdict.checks.find((candidate) => candidate.reason === REFUSAL_REASONS.LEAK);
  assert.deepEqual(entry.evidence.offenders, [{ name: 'processes', count: 1 }, { name: 'listeners', count: 2 }]);
  assert.equal(gate.validate(passingInput({ leaks: { processes: 0, watchers: 0 } })).ok, true);
});

test('gate 9 — an episode that verified nothing is not a completed episode', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({ verification: { levels: {} } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.includes(REFUSAL_REASONS.NOTHING_RAN));
  const entry = verdict.checks.find((candidate) => candidate.reason === REFUSAL_REASONS.NOTHING_RAN);
  assert.deepEqual(entry.evidence, { levels: [] });
});

test('gate 9 — a command history alone is enough to have run something', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate(passingInput({ verification: { levels: {}, commands: [{ level: 'full-verify' }] } }));
  assert.equal(verdict.reasons.includes(REFUSAL_REASONS.NOTHING_RAN), false);
});

test('every refusal is reported at once, in the donor\'s gate order', () => {
  const { validator: gate } = validator({});
  const verdict = gate.validate({
    contract: { require_build: true, require_lint: true },
    criteria: { satisfied: false, unknown: false, results: [] },
    verification: { levels: {}, commands: [] },
    lastMutationAt: 1,
    failures: { unresolved: [{ class: 'type' }] },
    workspace: { ok: false, reason: 'gone' },
    leaks: { processes: 1 },
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, [
    REFUSAL_REASONS.CRITERIA,
    REFUSAL_REASONS.TESTS,
    REFUSAL_REASONS.BUILD,
    REFUSAL_REASONS.LINT,
    REFUSAL_REASONS.UNRESOLVED_FAILURE,
    REFUSAL_REASONS.WORKSPACE,
    REFUSAL_REASONS.LEAK,
    REFUSAL_REASONS.NOTHING_RAN,
  ]);
  assert.equal(verdict.evidence.checked, verdict.checks.length);
  assert.equal(verdict.reasons.length, verdict.checks.filter((entry) => !entry.ok).length);
});

test('the durable verdict is deterministic for the same input and clock', () => {
  const clock = createClock(7_777);
  const { validator: gate } = validator({ clock });
  const input = passingInput({ lastMutationAt: 10, leaks: { processes: 0 }, workspace: { ok: true, cwd: 'x' }, failures: { unresolved: [] } });
  const first = gate.validate(input);
  const second = gate.validate(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const refused = gate.validate(passingInput({ criteria: { satisfied: false, unknown: false, results: [] } }));
  assert.equal(JSON.stringify(refused), JSON.stringify(gate.validate(passingInput({ criteria: { satisfied: false, unknown: false, results: [] } }))));
});

test('the durable verdict has a stable shape whether it completes or refuses', () => {
  const { validator: gate } = validator({});
  for (const verdict of [gate.validate(passingInput()), gate.validate({})]) {
    assert.deepEqual(Object.keys(verdict), ['at', 'ok', 'verdict', 'reasons', 'checks', 'evidence']);
    assert.equal(typeof verdict.at, 'number');
    assert.equal(typeof verdict.verdict, 'string');
    assert.ok(Array.isArray(verdict.reasons));
    assert.ok(Array.isArray(verdict.checks));
    assert.deepEqual(Object.keys(verdict.evidence), ['requiredLevels', 'lastMutationAt', 'ran', 'checked']);
    for (const entry of verdict.checks) {
      assert.deepEqual(Object.keys(entry), ['ok', 'reason', 'evidence']);
      if (entry.ok) assert.equal(entry.reason, null, 'a passing check carries no reason');
      if (!entry.ok) assert.equal(typeof entry.reason, 'string');
    }
  }
});

test('collectLeaks asks each component and reports counts, not verdicts', () => {
  assert.deepEqual(collectLeaks({}), {});
  assert.deepEqual(collectLeaks({ processes: { snapshot: () => ({ ownedCount: 2 }) }, watchers: { watchCount: () => 1 }, resources: { snapshot: () => ({ screenshots: 3 }) } }), { processes: 2, watchers: 1, screenshots: 3 });
  assert.deepEqual(collectLeaks({ processes: { ownedCount: 4 }, watchers: { count: () => 5 } }), { processes: 4, watchers: 5 });
  assert.deepEqual(collectLeaks({ processes: { snapshot: () => ({}) }, resources: {} }), { processes: 0 });
  assert.deepEqual(collectLeaks({ processes: { snapshot: () => { throw new Error('gone') } }, watchers: { watchCount: () => { throw new Error('gone') } }, resources: { snapshot: () => { throw new Error('gone') } } }), { processes: 0, watchers: 0, screenshots: 0 });
});

test('workspaceStillValid asks the filesystem, and a missing root is a refusal with the real error', () => {
  const root = tempRoot('workspace');
  assert.deepEqual(workspaceStillValid(root), { ok: true, cwd: root, reason: null });
  const missing = path.join(root, 'gone');
  const absent = workspaceStillValid(missing);
  assert.equal(absent.ok, false);
  assert.equal(absent.cwd, missing);
  assert.ok(absent.reason.length > 0);
  const file = write(root, 'a-file.txt', 'not a directory');
  assert.equal(workspaceStillValid(file).ok, false, 'a file is not a workspace');
});

/* ================================================================== *
 * git — what may never run, and what is refused by policy
 * ================================================================== */

test('the forbidden list and the default policy are frozen with the donor\'s contents', () => {
  assert.equal(Object.isFrozen(FORBIDDEN_COMMANDS), true);
  assert.equal(FORBIDDEN_COMMANDS.length, 10);
  assert.deepEqual({ ...DEFAULT_GIT_POLICY }, { allowCommit: false, allowPush: false, allowMerge: false, commitMessagePrefix: 'chore(engineering):' });
  assert.equal(Object.isFrozen(DEFAULT_GIT_POLICY), true);
});

test('every destructive command is refused before it reaches the shell', () => {
  const root = gitFixture('git-forbidden');
  const controller = createGitController({ root, now: (() => { let value = 0; return () => (value += 1); })() });
  const cases = [
    [['reset', '--hard', 'HEAD'], 'a hard reset destroys uncommitted work'],
    [['clean', '-fd'], 'a forced clean deletes untracked files'],
    [['clean', '-xdf'], 'a forced clean deletes untracked files'],
    [['push', 'origin', 'main', '--force'], 'a force push rewrites shared history'],
    [['push', 'origin', 'main', '-f'], 'a force push rewrites shared history'],
    [['filter-branch', '--all'], 'history rewriting is out of scope'],
    [['rebase', '--root'], 'history rewriting is out of scope'],
    [['branch', '-D', 'main'], 'deleting branches is not a maintenance action'],
    [['update-ref', '-d', 'refs/heads/x'], 'deleting refs is not a maintenance action'],
    [['checkout', '--', '.'], 'discarding the working tree destroys uncommitted work'],
    [['restore', '.'], 'discarding the working tree destroys uncommitted work'],
  ];
  for (const [args, reason] of cases) {
    const result = controller.run(args);
    assert.equal(result.ok, false, `${args.join(' ')} must be refused`);
    assert.equal(result.refused, true);
    assert.equal(result.reason, `refused: ${reason}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  assert.equal(controller.refusals().length, cases.length);
  assert.equal(controller.commands().every((entry) => entry.refused === true), true);
  assert.equal(fs.existsSync(path.join(root, '.git', 'index.lock')), false);
});

test('an allowed verb is executed and answers with the real exit code', () => {
  const root = gitFixture('git-allowed');
  write(root, 'a.txt', 'base\n');
  const controller = createGitController({ root });
  const bad = controller.run(['rev-parse', '--verify', 'does-not-exist']);
  assert.equal(bad.ok, false);
  assert.equal(bad.refused, false);
  assert.equal(typeof bad.code, 'number');
  assert.ok(bad.reason.length > 0);
  const good = controller.run(['rev-parse', '--is-inside-work-tree']);
  assert.equal(good.ok, true);
  assert.equal(good.reason, null);
  assert.equal(good.stdout.trim(), 'true');
});

test('status separates untracked, staged, modified and conflicted files', () => {
  const root = gitFixture('git-status');
  const controller = createGitController({ root });
  write(root, 'tracked.txt', 'one\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '--quiet', '-m', 'base');
  git(root, 'branch', '-M', 'main');

  write(root, 'untracked.txt', 'new\n');
  write(root, 'tracked.txt', 'two\n');
  const dirty = controller.status();
  assert.equal(dirty.ok, true);
  assert.deepEqual(dirty.untracked, ['untracked.txt']);
  assert.deepEqual(dirty.modified, ['tracked.txt']);
  assert.deepEqual(dirty.staged, []);
  assert.deepEqual(dirty.conflicted, []);

  git(root, 'add', 'tracked.txt');
  const staged = controller.status();
  assert.deepEqual(staged.staged, ['tracked.txt']);
  assert.deepEqual(staged.modified, []);
  git(root, 'commit', '--quiet', '-m', 'second');

  git(root, 'checkout', '--quiet', '-b', 'other');
  write(root, 'tracked.txt', 'other\n');
  git(root, 'commit', '--quiet', '-am', 'other');
  git(root, 'checkout', '--quiet', 'main');
  write(root, 'tracked.txt', 'main\n');
  git(root, 'commit', '--quiet', '-am', 'main');
  spawnSync('git', ['merge', 'other'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const conflicted = controller.status();
  assert.deepEqual(conflicted.conflicted, ['tracked.txt']);
});

test('status reports the failure instead of pretending the tree is clean', () => {
  const empty = tempRoot('git-not-a-repo');
  const controller = createGitController({ root: empty });
  const status = controller.status();
  assert.equal(status.ok, false);
  assert.deepEqual(status.modified, []);
  assert.deepEqual(status.untracked, []);
  assert.ok(status.reason.length > 0);
});

test('head reports the branch, the sha and whether HEAD is detached', () => {
  const root = gitFixture('git-head');
  write(root, 'a.txt', 'base\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '--quiet', '-m', 'base');
  git(root, 'branch', '-M', 'main');
  const controller = createGitController({ root });
  const head = controller.head();
  assert.equal(head.ok, true);
  assert.equal(head.branch, 'main');
  assert.equal(head.detached, false);
  assert.equal(head.sha, git(root, 'rev-parse', 'HEAD'));
  git(root, 'checkout', '--quiet', '--detach');
  const detached = controller.head();
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, 'HEAD');
});

test('diff is bounded and the staged diff is the cached one', () => {
  const root = gitFixture('git-diff');
  write(root, 'a.txt', `${'line\n'.repeat(200)}`);
  git(root, 'add', 'a.txt');
  git(root, 'commit', '--quiet', '-m', 'base');
  write(root, 'a.txt', `${'changed\n'.repeat(200)}`);
  const controller = createGitController({ root });
  const full = controller.diff();
  assert.equal(full.ok, true);
  assert.equal(full.truncated, false);
  assert.equal(full.bytes, Buffer.byteLength(full.text));
  assert.ok(full.text.includes('-line'));
  const bounded = controller.diff({ maxBytes: 64 });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.bytes, full.bytes);
  assert.ok(Buffer.byteLength(bounded.text) <= 64);
  assert.equal(controller.stagedDiff().text, '', 'nothing is staged yet');
  git(root, 'add', 'a.txt');
  assert.ok(controller.stagedDiff({ paths: ['a.txt'] }).text.includes('+changed'));
});

test('stage takes explicit paths only, and refuses an empty list', () => {
  const root = gitFixture('git-stage');
  write(root, 'a.txt', 'a\n');
  write(root, 'b.txt', 'b\n');
  const controller = createGitController({ root });
  assert.deepEqual(controller.stage([]), { ok: false, reason: 'no paths to stage' });
  assert.deepEqual(controller.stage(null), { ok: false, reason: 'no paths to stage' });
  const staged = controller.stage(['a.txt']);
  assert.equal(staged.ok, true);
  assert.deepEqual(staged.paths, ['a.txt']);
  const status = controller.status();
  assert.deepEqual(status.staged, ['a.txt']);
  assert.deepEqual(status.untracked, ['b.txt'], 'a path the episode did not name is never staged');
});

test('commit refuses by default, refuses without a message, and works only when the contract allows it', () => {
  const root = gitFixture('git-commit');
  write(root, 'a.txt', 'a\n');
  const refused = createGitController({ root });
  assert.deepEqual(refused.commit('chore: x', { paths: ['a.txt'] }), { ok: false, reason: 'the contract does not allow commits', committed: false });

  const allowed = createGitController({ root, policy: { allowCommit: true } });
  assert.deepEqual(allowed.commit(''), { ok: false, reason: 'a commit needs a message', committed: false });
  const before = allowed.head().sha;
  const committed = allowed.commit('chore(engineering): stage a.txt', { paths: ['a.txt'] });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.committed, true);
  assert.equal(committed.previousSha, before);
  assert.equal(committed.branch, allowed.head().branch);
  assert.equal(committed.sha, committed.branch ? allowed.head().sha : null);
  assert.equal(committed.reason, null);
});

test('a commit with nothing staged fails on git\'s own refusal, not on a rewritten one', () => {
  const root = gitFixture('git-commit-noop');
  write(root, 'a.txt', 'a\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '--quiet', '-m', 'base');
  const controller = createGitController({ root, policy: { allowCommit: true } });
  const result = controller.commit('chore(engineering): nothing to do');
  assert.equal(result.ok, false, 'git refuses a commit with nothing staged, and the donor does not paper over it');
  assert.equal(result.committed, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'the reason is git\'s own first stderr line');
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
});

test('push and merge are refused unless the contract says otherwise', () => {
  const root = gitFixture('git-push-merge');
  const controller = createGitController({ root });
  assert.deepEqual(controller.push(), { ok: false, reason: 'the contract does not allow pushes', pushed: false });
  assert.deepEqual(controller.merge('main'), { ok: false, reason: 'the contract does not allow merges', merged: false });
  assert.equal(controller.policy.allowCommit, false);
  assert.equal(controller.root, root);
});

test('drift names exactly what moved since the baseline', () => {
  const root = gitFixture('git-drift');
  write(root, 'a.txt', 'one\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '--quiet', '-m', 'base');
  git(root, 'branch', '-M', 'main');
  const controller = createGitController({ root });
  const baseline = controller.head();
  assert.deepEqual(controller.drift(null), { drifted: false, reasons: [] });
  assert.deepEqual(controller.drift(baseline).reasons, []);
  write(root, 'a.txt', 'two\n');
  git(root, 'commit', '--quiet', '-am', 'second');
  const moved = controller.drift(baseline);
  assert.equal(moved.drifted, true);
  assert.match(moved.reasons[0], /^HEAD moved: [0-9a-f]{8} -> [0-9a-f]{8}$/);
  git(root, 'checkout', '--quiet', '-b', 'side');
  const branchMoved = controller.drift(controller.head());
  assert.deepEqual(branchMoved.reasons, [], 'a fresh baseline of the current state has not drifted');
  git(root, 'checkout', '--quiet', '--detach');
  assert.ok(controller.drift({ sha: controller.head().sha, branch: 'side', detached: false }).reasons.includes('HEAD became detached'));
});

test('the command history is bounded to the last two hundred entries', () => {
  const root = gitFixture('git-history');
  const controller = createGitController({ root });
  for (let index = 0; index < 205; index += 1) controller.run(['rev-parse', '--is-inside-work-tree']);
  assert.equal(controller.commands().length, 200);
  assert.equal(controller.commands().every((entry) => entry.refused === false), true);
  assert.deepEqual(controller.refusals(), []);
});

/* ================================================================== *
 * cross-volume cleanup — ownership, refusal codes and the taxonomy
 * ================================================================== */

test('the exported vocabularies are the donor\'s', () => {
  assert.equal(OWNER_MARKER, '.dshns-episode-owner.json');
  assert.deepEqual([...PURPOSE_CLASSES].sort(), ['build', 'cache', 'clone', 'copy', 'download', 'log', 'other', 'test', 'tool-scratch', 'unpack'].sort());
  assert.deepEqual([...CLEANUP_STATES].sort(), ['ACTIVE', 'CLEANUP_BLOCKED', 'DELETED', 'DELETE_PENDING'].sort());
});

test('an incomplete registry identity is refused at construction', () => {
  const root = tempRoot('xv-init');
  assert.equal(createCrossVolumeTempRegistry({ workRoot: root }).initializationError.code, 'CROSS_VOLUME_REGISTRY_INVALID');
  // A relative work root is resolved against the process cwd before the absolute
  // check, so it is not "not absolute" — it simply does not exist, and the donor
  // reports the raw filesystem code rather than its own.
  assert.equal(createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: 'relative/root' }).initializationError.code, 'ENOENT');
  assert.equal(createCrossVolumeTempRegistry({ episodeId: 'e'.repeat(513), workRoot: root }).initializationError.code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: path.join(root, 'does-not-exist') }).initializationError.code, 'ENOENT');
  const good = createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: root });
  assert.equal(good.initializationError, null);
  assert.equal(good.episodeId, 'e');
  assert.equal(good.workRoot, root);
  assert.match(good.workRootIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(good.list(), []);
  // A reparse/non-canonical work root is the donor's own refusal, so it does carry
  // the donor's own code.
  const file = write(root, 'not-a-directory.txt', 'x');
  const notADirectory = createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: file });
  assert.equal(notADirectory.initializationError.code, 'WORK_ROOT_INVALID');
});

test('a registry that failed to initialize refuses every operation with the same error', () => {
  const store = createCrossVolumeTempRegistry({ workRoot: tempRoot('xv-broken') });
  assert.equal(store.createTaskDirectory({ path: 'relative', purposeClass: 'build' }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(store.createRegisteredFile({ path: 'relative', purposeClass: 'log' }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(store.cleanupTerminal({ terminal: true }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
});

test('a scratch path on the work volume is not cross-volume material, and the path is judged before the purpose', () => {
  const root = tempRoot('xv-same-volume');
  const store = createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: root });
  const onVolume = path.join(root, 'scratch');
  const wrongPurpose = store.createTaskDirectory({ path: onVolume, purposeClass: 'not-a-purpose' });
  assert.equal(wrongPurpose.ok, false);
  assert.equal(wrongPurpose.code, 'TEMP_PATH_NOT_OFF_VOLUME', 'the target is validated before the taxonomy');
  const relative = store.createTaskDirectory({ path: 'scratch', purposeClass: 'build' });
  assert.equal(relative.code, 'TEMP_PATH_INVALID');
  const badPurpose = store.createRegisteredFile({ path: onVolume, purposeClass: 'nope' });
  assert.equal(badPurpose.code, 'TEMP_PATH_NOT_OFF_VOLUME');
  assert.deepEqual(store.list(), [], 'a refused creation registers nothing');
});

test('cleanup is a no-op until the episode is terminal', () => {
  const root = tempRoot('xv-not-terminal');
  const store = createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: root });
  const interrupted = store.cleanupTerminal({ terminal: false, reason: 'unclean_exit' });
  assert.deepEqual(interrupted, { ok: true, skipped: true, reason: 'episode is not terminal', deleted: [], residuals: [] });
  assert.deepEqual(store.cleanupTerminal().deleted, [], 'the default is not terminal');
});

test('a cleaned registry with nothing registered proves an empty cleanup', () => {
  const store = createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: tempRoot('xv-empty') });
  const cleaned = store.cleanupTerminal({ terminal: true, reason: 'completed' });
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.skipped, false);
  assert.deepEqual(cleaned.deleted, []);
  assert.deepEqual(cleaned.residuals, []);
  assert.equal(cleaned.reason, 'completed');
  assert.deepEqual(cleaned.entries, []);
});

test('retrying cleanup debt is the terminal cleanup under its own reason', () => {
  const store = createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: tempRoot('xv-retry') });
  const retried = store.retryCleanupDebt();
  assert.equal(retried.ok, true);
  assert.equal(retried.reason, 'cleanup_debt_retry');
});

test('a restored registration is validated against the episode, the work root and its own type', (t) => {
  const root = tempRoot('xv-restore');
  const volume = otherVolumeRoot(root);
  if (!volume) return t.skip('a restored off-volume registration needs a second volume');
  const offVolume = path.join(volume, 'pf-xv-restore', 'scratch');
  const store = createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: root });
  const identity = store.workRootIdentity;
  const base = {
    episodeId: 'e', workRoot: root, workRootIdentity: identity, path: offVolume, canonicalPath: offVolume,
    type: 'file', purposeClass: 'log', createdByEpisode: true, registeredAt: 1, cleanupState: 'ACTIVE', contentDigest: `sha256:${'a'.repeat(64)}`,
  };
  const restore = (entry) => createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: root, entries: [entry] }).initializationError;
  assert.equal(restore(base), null);
  assert.deepEqual(store.list(), [], 'constructing a store does not touch its own ledger');
  const restored = createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: root, entries: [base] });
  assert.deepEqual(restored.list(), [base]);
  assert.equal(restore({ ...base, episodeId: 'other' }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore({ ...base, createdByEpisode: false }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore({ ...base, purposeClass: 'nope' }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore({ ...base, cleanupState: 'NOPE' }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore({ ...base, contentDigest: 'sha256:short' }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore({ ...base, canonicalPath: path.join(volume, 'pf-xv-restore', 'elsewhere') }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore({ ...base, type: 'directory' }).code, 'CROSS_VOLUME_REGISTRY_INVALID', 'a directory needs its exact marker path');
  assert.equal(restore({ ...base, workRoot: path.join(root, 'elsewhere') }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore({ ...base, workRootIdentity: `sha256:${'b'.repeat(64)}` }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore('not an entry').code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore({ ...base, path: 'relative' }).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(restore({ ...base, path: path.join(root, 'scratch'), canonicalPath: path.join(root, 'scratch') }).code, 'TEMP_PATH_NOT_OFF_VOLUME', 'a registration on the work volume is not cross-volume material');
});

test('the registry deep-copies what it hands out, so a caller cannot edit its own ledger', () => {
  const store = createCrossVolumeTempRegistry({ episodeId: 'e', workRoot: tempRoot('xv-copy') });
  const first = store.list();
  first.push({ forged: true });
  assert.deepEqual(store.list(), []);
});

/* ================================================================== *
 * ci-repair — what a CI log really says (Boss §41)
 * ================================================================== */

/** A real `tsc --noEmit` diagnostic block, in the exact format tsc prints. */
const TSC_LOG = [
  '##[group]Run pnpm run typecheck',
  'Run pnpm run typecheck',
  '$ tsc --noEmit',
  "src/gateway.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  'Error: Process completed with exit code 1.',
].join('\n');

/** A real `node --test` failing block, in the exact format the runner prints. */
const TEST_LOG = [
  '##[group]Run pnpm test',
  'Run pnpm test',
  'not ok 1 - the receipt totals',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  'Error: Process completed with exit code 1.',
].join('\n');

/** A CI run whose security scan found a credential shape. */
const SECRET_LOG = [
  '##[group]Run pnpm run security:scan',
  'Run pnpm run security:scan',
  'Error: scan-tracked-secrets found a credential shape in src/creds.ts: aws-access-key',
  'Error: Process completed with exit code 1.',
].join('\n');

test('§41 CR-01 a compiler failure parses into a step, a diagnostic and an exit code', () => {
  const parsed = parseCiFailure({ log: TSC_LOG, descriptor: { branch: 'boss/t-15/fix' } });
  assert.equal(parsed.step, 'Run pnpm run typecheck');
  assert.deepEqual(parsed.commands, ['pnpm run typecheck']);
  assert.equal(parsed.issues.some((issue) => issue.file === 'src/gateway.ts'), true);
  assert.equal(parsed.issues.some((issue) => issue.code === 'TS2322'), true);
  assert.equal(parsed.issues.some((issue) => issue.line === 1), true);
  assert.equal(parsed.issues[0].message, "Type 'string' is not assignable to type 'number'.");
  assert.equal(parsed.exit_code, 1);
  assert.ok(parsed.log_bytes > 0);
  assert.match(parsed.signature, /^[0-9a-f]{64}$/);
  assert.equal(parsed.infrastructure, false);
  assert.deepEqual(parsed.descriptor, { branch: 'boss/t-15/fix' });
  assert.deepEqual(parsed.tests, []);
});

test('§41 CR-02 a test failure parses into the failing test name and keeps the assertion', () => {
  const parsed = parseCiFailure({ log: TEST_LOG });
  assert.equal(parsed.tests.some((entry) => entry.name.includes('the receipt totals')), true);
  assert.match(parsed.tests[0].message, /Expected values to be strictly equal/);
  assert.equal(parsed.step, 'Run pnpm test');
  assert.equal(parsed.exit_code, 1);
  assert.equal(parsed.issues.length, 0);
  assert.deepEqual(parsed.descriptor, {}, 'an absent descriptor is an empty record, not undefined');
});

test('the exit-code wrapper is never mistaken for an assertion', () => {
  const parsed = parseCiFailure({ log: TEST_LOG });
  assert.equal(parsed.tests[0].message.includes('Process completed with exit code'), false);
  assert.equal(parsed.annotations.includes('Error: Process completed with exit code 1.'), true);
});

test('a second assertion for the same test becomes an annotation, not an overwrite', () => {
  const parsed = parseCiFailure({
    log: ['not ok 1 - a', 'AssertionError: first', 'AssertionError: second'].join('\n'),
  });
  assert.equal(parsed.tests[0].message, 'first');
  assert.deepEqual(parsed.annotations, ['second']);
});

test('an assertion with no pending test is an annotation', () => {
  const parsed = parseCiFailure({ log: 'AssertionError: nothing queued' });
  assert.deepEqual(parsed.tests, []);
  assert.deepEqual(parsed.annotations, ['nothing queued']);
});

test('the alternate diagnostic form is read too', () => {
  const parsed = parseCiFailure({ log: 'src/a.mjs:12:5: error TS2554: Expected 2 arguments, but got 1.' });
  assert.deepEqual(parsed.issues, [{ message: 'Expected 2 arguments, but got 1.', file: 'src/a.mjs', line: 12, code: 'TS2554' }]);
});

test('commands are de-duplicated and ANSI colour is stripped', () => {
  const parsed = parseCiFailure({ log: ['\u001b[36mRun pnpm test\u001b[0m', 'Run pnpm test', 'Run pnpm run build'].join('\r\n') });
  assert.deepEqual(parsed.commands, ['pnpm test', 'pnpm run build']);
});

test('the annotation list is capped at twenty exit-code lines', () => {
  const log = Array.from({ length: 30 }, () => 'Error: Process completed with exit code 1.').join('\n');
  const parsed = parseCiFailure({ log });
  assert.equal(parsed.annotations.length, 20);
  assert.equal(parsed.annotations[0], 'Error: Process completed with exit code 1.');
  assert.equal(parsed.exit_code, 1);
});

test('the twenty-line cap does not apply to assertion lines, and the donor does not pretend it does', () => {
  // The assertion branch appends without checking the cap, so a suite that prints
  // thirty assertions produces thirty annotations. Preserved as-is; reported.
  const log = Array.from({ length: 30 }, (_, index) => `Error: failure number ${index}`).join('\n');
  const parsed = parseCiFailure({ log });
  assert.equal(parsed.annotations.length, 30);
  assert.equal(parsed.annotations[0], 'failure number 0');
  assert.deepEqual(parsed.issues, []);
  assert.equal('exit_code' in parsed, false);
});

test('a log with nothing recognisable parses honestly empty and invents no cause', () => {
  for (const log of ['', '   \n  ', 'Compiling ds-harness v1.0.0\nFinished in 4.2s']) {
    const parsed = parseCiFailure({ log });
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.tests, []);
    assert.deepEqual(parsed.commands, []);
    assert.deepEqual(parsed.annotations, []);
    assert.equal('step' in parsed, false, 'no step is invented');
    assert.equal('exit_code' in parsed, false, 'no exit code is invented');
    assert.equal(parsed.infrastructure, false);
    assert.match(parsed.signature, /^[0-9a-f]{64}$/);
  }
  assert.equal(parseCiFailure({ log: '' }).log_bytes, 0);
});

test('log_bytes counts UTF-8 bytes, not characters', () => {
  const log = 'Error: 失败 — ✗';
  assert.equal(parseCiFailure({ log }).log_bytes, Buffer.byteLength(log, 'utf8'));
  assert.notEqual(parseCiFailure({ log }).log_bytes, log.length);
});

test('the signature identifies the failure and moves when the failure moves', () => {
  const base = parseCiFailure({ log: TSC_LOG });
  assert.equal(base.signature, parseCiFailure({ log: TSC_LOG }).signature, 'the same log is the same failure');
  assert.equal(base.signature, parseCiFailure({ log: `${TSC_LOG}\n` }).signature, 'trailing whitespace does not change the identity');
  assert.notEqual(base.signature, parseCiFailure({ log: TSC_LOG.replace('TS2322', 'TS2323') }).signature);
  assert.notEqual(base.signature, parseCiFailure({ log: TSC_LOG.replace('exit code 1', 'exit code 2') }).signature);
  assert.notEqual(base.signature, parseCiFailure({ log: TSC_LOG.replace('src/gateway.ts', 'src/other.ts') }).signature);
  assert.notEqual(base.signature, parseCiFailure({ log: TSC_LOG.replace('Run pnpm run typecheck', 'Run pnpm run build') }).signature);
});

test('the signature is a sha256 of the donor\'s exact identity payload', () => {
  const parsed = parseCiFailure({ log: TSC_LOG });
  const expected = crypto.createHash('sha256').update(JSON.stringify({
    step: parsed.step ?? '',
    codes: [...new Set(parsed.issues.map((issue) => issue.code ?? ''))].sort(),
    files: [...new Set(parsed.issues.map((issue) => issue.file).filter(Boolean))].sort(),
    tests: parsed.tests.map((entry) => entry.name).sort(),
    exit: parsed.exit_code ?? null,
  }), 'utf8').digest('hex');
  assert.equal(parsed.signature, expected, 'the digest is node\'s sha256 of the same payload');
});

test('CI could not start is reported as infrastructure, not as a code failure', () => {
  const parsed = parseCiFailure({ log: 'Error: no such file or directory: pnpm\nError: Process completed with exit code 1.' });
  assert.equal(parsed.infrastructure, true);
  const classification = classifyCiFailure(parsed);
  assert.equal(classification.failure_class, 'ENVIRONMENT');
  assert.equal(classification.confidence, 0.8);
  assert.equal(classification.severity, 'HIGH');
  assert.deepEqual(classification.signals, ['ci:infrastructure', `step:${parsed.step ?? 'unknown'}`]);
  assert.match(classification.reason, /runner's environment rather than the change/);
});

test('a recognisable failure is never called infrastructure', () => {
  assert.equal(parseCiFailure({ log: TSC_LOG }).infrastructure, false);
  assert.equal(parseCiFailure({ log: TEST_LOG }).infrastructure, false);
  assert.equal(parseCiFailure({ log: 'Error: could not resolve host\nsrc/a.ts(1,1): error TS1005: \';\' expected.' }).infrastructure, false);
});

test('§41 CR-03 a compiler failure is BUILD and its local gate is the typecheck', () => {
  const parsed = parseCiFailure({ log: TSC_LOG });
  const classification = classifyCiFailure(parsed);
  assert.equal(classification.failure_class, 'BUILD');
  assert.equal(classification.severity, 'MEDIUM');
  const plan = planCiRepair({ parsed, attempts: [] });
  assert.equal(plan.decision, 'REPAIR');
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.version, 'ci-repair-1');
  assert.deepEqual(plan.local_gates, ['TYPECHECK']);
  assert.deepEqual(plan.targets, ['src/gateway.ts']);
  assert.equal(plan.failure_class, 'BUILD');
  assert.equal(plan.signature, parsed.signature);
  assert.equal(plan.reasons[0], classification.reason);
  assert.equal(plan.progress.hard_blocker, false);
  assert.equal(plan.progress.next, 'LOCAL_RECOVERY');
});

test('§41 CR-03 a test failure is TEST with the unit gate', () => {
  const parsed = parseCiFailure({ log: TEST_LOG });
  const plan = planCiRepair({ parsed, attempts: [] });
  assert.equal(plan.failure_class, 'TEST');
  assert.deepEqual(plan.local_gates, ['UNIT']);
  assert.deepEqual(plan.targets, ['1 - the receipt totals'], 'the parser keeps the TAP number in the test name');
  assert.equal(plan.decision, 'REPAIR');
});

test('the local gate table is the donor\'s, and an unmappable class has no gate at all', () => {
  // ENVIRONMENT is decided by the infrastructure branch, so its gate is observable
  // without the §33 model having to classify anything.
  const infrastructure = parseCiFailure({ log: 'Error: failed to start the job runner\nError: Process completed with exit code 1.' });
  assert.equal(infrastructure.infrastructure, true);
  const plan = planCiRepair({ parsed: infrastructure, attempts: [] });
  assert.equal(plan.failure_class, 'ENVIRONMENT');
  assert.deepEqual(plan.local_gates, ['TYPECHECK']);
  assert.equal(plan.decision, 'REPAIR', 'an environment failure has a local gate, so it is repaired rather than retried blindly');
});

test('§41 CR-05 a prohibited CI failure goes straight to the Hard Blocker', () => {
  const parsed = parseCiFailure({ log: SECRET_LOG });
  assert.equal(parsed.infrastructure, false);
  const classification = classifyCiFailure(parsed);
  assert.equal(classification.failure_class, 'TERMINAL');
  assert.equal(classification.severity, 'CRITICAL');
  assert.deepEqual(classification.signals, ['policy_refusal:CI reported a secret-scan failure']);
  const plan = planCiRepair({ parsed, attempts: [] });
  assert.equal(plan.decision, 'HARD_BLOCKER');
  assert.equal(plan.local_gates.length, 0);
  assert.ok(plan.reasons.some((reason) => reason.includes('Hard Blocker') && reason.includes('Owner')));
  assert.equal(plan.severity, 'CRITICAL');
});

test('the loop is bounded by §33.2\'s budgets, not by a counter invented here', () => {
  const parsed = parseCiFailure({ log: TSC_LOG });
  const fresh = planCiRepair({ parsed, attempts: [] });
  assert.equal(fresh.decision, 'REPAIR');
  assert.equal(fresh.progress.next, 'LOCAL_RECOVERY');
  assert.match(fresh.progress.reason, /attempt 1 of \d+/);

  const oneAttempt = planCiRepair({ parsed, attempts: [{ step: 'LOCAL_RECOVERY', outcome: 'FAIL' }] });
  assert.equal(oneAttempt.decision, 'REPAIR', 'a BUILD failure gets more than one local repair');
  assert.equal(oneAttempt.progress.hard_blocker, false);

  // BUILD's local-recovery budget is three. Once it is spent the ladder moves on
  // rather than repeating: the §33.2 HNS fallback is offered once, and only then is
  // the Hard Blocker due. The bound is the model's, not this module's.
  const spent = planCiRepair({
    parsed,
    attempts: [
      { step: 'LOCAL_RECOVERY', outcome: 'FAIL' },
      { step: 'LOCAL_RECOVERY', outcome: 'FAIL' },
      { step: 'LOCAL_RECOVERY', outcome: 'FAIL' },
    ],
  });
  assert.equal(spent.progress.hard_blocker, false);
  assert.equal(spent.progress.next, 'HNS_FALLBACK');
  assert.equal(spent.decision, 'REPAIR');

  const exhausted = planCiRepair({
    parsed,
    attempts: [
      { step: 'LOCAL_RECOVERY', outcome: 'FAIL' },
      { step: 'LOCAL_RECOVERY', outcome: 'FAIL' },
      { step: 'LOCAL_RECOVERY', outcome: 'FAIL' },
      { step: 'HNS_FALLBACK', outcome: 'FAIL' },
    ],
  });
  assert.equal(exhausted.progress.hard_blocker, true);
  assert.equal(exhausted.progress.exhausted, true);
  assert.equal(exhausted.decision, 'HARD_BLOCKER');
  assert.ok(exhausted.reasons.includes(exhausted.progress.reason));
  assert.match(exhausted.progress.reason, /Hard Blocker/);
});

test('a NOT_APPLICABLE attempt does not spend a recovery budget', () => {
  const parsed = parseCiFailure({ log: TSC_LOG });
  const spent = planCiRepair({
    parsed,
    attempts: [
      { step: 'LOCAL_RECOVERY', outcome: 'NOT_APPLICABLE' },
      { step: 'LOCAL_RECOVERY', outcome: 'NOT_APPLICABLE' },
      { step: 'LOCAL_RECOVERY', outcome: 'NOT_APPLICABLE' },
    ],
  });
  assert.equal(spent.progress.next, 'LOCAL_RECOVERY', 'only a real attempt spends the budget');
  assert.equal(spent.decision, 'REPAIR');
});

test('a class with no local gate is a retry, and the plan says so', () => {
  const parsed = parseCiFailure({ log: TSC_LOG });
  // TRANSIENT has an empty gate list in the donor's table. Reach it through the
  // model rather than by guessing: a timeout-shaped log classifies as TRANSIENT.
  const transient = parseCiFailure({ log: 'Error: the build timed out after 600000ms\nError: Process completed with exit code 1.' });
  const classification = classifyCiFailure(transient);
  assert.equal(classification.failure_class, 'TRANSIENT');
  const plan = planCiRepair({ parsed: transient, attempts: [] });
  assert.deepEqual(plan.local_gates, []);
  assert.equal(plan.decision, 'REPAIR', 'a gate-less class is still repairable');
  assert.ok(plan.reasons.some((reason) => reason.includes('no local gate to re-run')));
  assert.equal(parsed.signature.length, 64, 'the fixture above is only here to keep the log shapes honest');
});

test('§41 CR-04 only a green CI read counts, and a failed read is not a pass', () => {
  assert.deepEqual(ciVerdict({ ok: true, conclusion: 'success' }), { passed: true, reason: '§41: CI concluded success' });
  assert.equal(ciVerdict({ ok: true, conclusion: 'failure' }).passed, false);
  assert.equal(ciVerdict({ ok: true, conclusion: 'cancelled' }).passed, false);
  assert.equal(ciVerdict({ ok: true }).passed, false);
  assert.equal(ciVerdict({ ok: true }).reason, '§41: CI concluded unknown');
  const unreadable = ciVerdict({ ok: false, reason: 'ETIMEDOUT' });
  assert.equal(unreadable.passed, false);
  assert.match(unreadable.reason, /not a pass/);
  assert.match(ciVerdict({ ok: false }).reason, /unknown/);
});

test('§41 the loop ends at PASS, at a Hard Blocker, or not yet', () => {
  assert.equal(loopOutcome({ verdict: { passed: true }, attemptsUsed: 5, maxAttempts: 3 }), 'PASS', 'a pass wins even past the bound');
  assert.equal(loopOutcome({ verdict: { passed: false }, plan: { decision: 'HARD_BLOCKER' }, attemptsUsed: 0, maxAttempts: 3 }), 'HARD_BLOCKER');
  assert.equal(loopOutcome({ verdict: { passed: false }, attemptsUsed: 3, maxAttempts: 3 }), 'HARD_BLOCKER');
  assert.equal(loopOutcome({ verdict: { passed: false }, attemptsUsed: 4, maxAttempts: 3 }), 'HARD_BLOCKER');
  assert.equal(loopOutcome({ verdict: { passed: false }, plan: { decision: 'REPAIR' }, attemptsUsed: 1, maxAttempts: 3 }), 'IN_PROGRESS');
  assert.equal(loopOutcome({ verdict: { passed: false }, attemptsUsed: 0, maxAttempts: 1 }), 'IN_PROGRESS');
});

test('the CI-repair plan is deterministic for the same log and attempts', () => {
  const first = planCiRepair({ parsed: parseCiFailure({ log: TSC_LOG }), attempts: [] });
  const second = planCiRepair({ parsed: parseCiFailure({ log: TSC_LOG }), attempts: [] });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('ci-repair needs no clock, no filesystem and no network to decide', () => {
  // The donor is pure. If this module ever reached for a real clock or a real
  // repository, the same call twice would stop being equal — asserted above — and
  // the module would need an fs seam it does not have.
  const parsed = parseCiFailure({ log: TSC_LOG });
  assert.deepEqual(Object.keys(parsed).sort(), ['annotations', 'commands', 'descriptor', 'exit_code', 'infrastructure', 'issues', 'log_bytes', 'signature', 'step', 'tests']);
});

/* ================================================================== *
 * correction — human overrides (Boss plan §26)
 * ================================================================== */

function draft(extra = {}) {
  return {
    problem: 'generated problem',
    evidence: { runtimeId: 'r1', reason: 'timeout', count: 3 },
    hypothesis: 'generated hypothesis',
    candidateFix: 'generated fix',
    expectedBenefit: 'generated benefit',
    risk: 'generated risk',
    benchmark: 'generated benchmark',
    rollback: 'generated rollback',
    compatibilityImpact: 'generated impact',
    ...extra,
  };
}

function correction(extra = {}) {
  return { id: 'c1', clusterKey: 'r1|timeout', field: 'problem', correctedValue: 'human problem', correctedAt: '2026-01-01T00:00:00.000Z', ...extra };
}

test('the correctable field list is the donor\'s eight text fields, and excludes the structured evidence', () => {
  const correctable = ['problem', 'hypothesis', 'candidateFix', 'expectedBenefit', 'risk', 'benchmark', 'rollback', 'compatibilityImpact'];
  for (const field of correctable) assert.equal(isCorrectableField(field), true);
  for (const other of ['evidence', 'id', 'clusterKey', 'correctedValue', 'correctedAt', '', 'Problem', 'PROBLEM', 'problem ', null, undefined, 1, {}, []]) {
    assert.equal(isCorrectableField(other), false, `${String(other)} is not correctable`);
  }
  // The list is private in the donor and stays private here, so it is asserted
  // through the one predicate that reads it rather than through a widened export.
  assert.equal(applyCorrections(draft(), correctable.map((field, index) => correction({ id: `c${index}`, field, correctedValue: `human ${field}` }))).rollback, 'human rollback');
});

test('a correction replaces only its own field and leaves the rest of the draft alone', () => {
  const original = draft();
  const snapshot = structuredClone(original);
  const corrected = applyCorrections(original, [correction()]);
  assert.equal(corrected.problem, 'human problem');
  assert.equal(corrected.hypothesis, original.hypothesis);
  assert.deepEqual(corrected.evidence, original.evidence, 'structured evidence is not a correctable text field');
  assert.deepEqual(original, snapshot, 'the original draft is never mutated');
  assert.notEqual(corrected, original);
});

test('the latest correction per field wins, whatever order the list arrives in', () => {
  const corrected = applyCorrections(draft(), [
    correction({ id: 'later', correctedValue: 'second', correctedAt: '2026-02-01T00:00:00.000Z' }),
    correction({ id: 'earlier', correctedValue: 'first', correctedAt: '2026-01-01T00:00:00.000Z' }),
    correction({ id: 'newest', correctedValue: 'third', correctedAt: '2026-03-01T00:00:00.000Z' }),
  ]);
  assert.equal(corrected.problem, 'third');
});

test('two corrections with the same timestamp resolve to the later one in the list', () => {
  const corrected = applyCorrections(draft(), [
    correction({ id: 'a', correctedValue: 'first', correctedAt: '2026-01-01T00:00:00.000Z' }),
    correction({ id: 'b', correctedValue: 'second', correctedAt: '2026-01-01T00:00:00.000Z' }),
  ]);
  assert.equal(corrected.problem, 'second', 'the donor compares with >=, so the later entry wins a tie');
});

test('several fields can be corrected at once, each from its own latest entry', () => {
  const corrected = applyCorrections(draft(), [
    correction({ id: 'p', field: 'problem', correctedValue: 'p1', correctedAt: '2026-01-01T00:00:00.000Z' }),
    correction({ id: 'r', field: 'risk', correctedValue: 'r1', correctedAt: '2026-01-02T00:00:00.000Z' }),
    correction({ id: 'r2', field: 'risk', correctedValue: 'r2', correctedAt: '2026-01-03T00:00:00.000Z' }),
    correction({ id: 'b', field: 'benchmark', correctedValue: 'b1', correctedAt: '2026-01-04T00:00:00.000Z' }),
  ]);
  assert.equal(corrected.problem, 'p1');
  assert.equal(corrected.risk, 'r2');
  assert.equal(corrected.benchmark, 'b1');
  assert.equal(corrected.rollback, 'generated rollback');
});

test('a blank correction is ignored, and a draft nobody corrected is returned unchanged by identity', () => {
  const original = draft();
  for (const blank of ['', '   ', '\n\t ']) {
    const corrected = applyCorrections(original, [correction({ correctedValue: blank })]);
    assert.equal(corrected, original, 'a blank override is not an override');
    assert.equal(corrected.problem, 'generated problem');
  }
  assert.equal(applyCorrections(original, []), original);
  assert.equal(applyCorrections(original, [correction({ field: 'evidence', correctedValue: 'nope' })]), original);
  assert.equal(applyCorrections(original, [correction({ field: 'not-a-field', correctedValue: 'nope' })]), original);
});

test('a blank correction for one field does not suppress a real correction for another', () => {
  const corrected = applyCorrections(draft(), [
    correction({ id: 'blank', field: 'problem', correctedValue: '  ' }),
    correction({ id: 'real', field: 'risk', correctedValue: 'human risk' }),
  ]);
  assert.equal(corrected.problem, 'generated problem');
  assert.equal(corrected.risk, 'human risk');
});

test('the donor does not filter corrections by cluster key', () => {
  // `RfcCorrection.clusterKey` is documented as the key the correction amends, but
  // the merge is per field across every correction it is handed. Preserved as-is.
  const corrected = applyCorrections(draft(), [correction({ clusterKey: 'some-other-cluster|reason', correctedValue: 'applied anyway' })]);
  assert.equal(corrected.problem, 'applied anyway');
});

test('fields the draft does not have are carried through untouched', () => {
  const corrected = applyCorrections(draft({ extraField: 'kept' }), [correction()]);
  assert.equal(corrected.extraField, 'kept');
  assert.equal(corrected.problem, 'human problem');
});

test('applying the same corrections twice is deterministic', () => {
  const corrections = [correction(), correction({ id: 'x', field: 'rollback', correctedValue: 'rb', correctedAt: '2026-05-05T00:00:00.000Z' })];
  const first = applyCorrections(draft(), corrections);
  const second = applyCorrections(draft(), corrections);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(Object.keys(first), Object.keys(draft()));
});
