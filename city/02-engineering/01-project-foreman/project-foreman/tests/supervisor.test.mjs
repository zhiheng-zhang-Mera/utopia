'use strict';

/**
 * Project Foreman: the engineering supervisor's invariants.
 *
 * These tests drive the *real* supervisor — the real workspace verification, the
 * real baseline and mutation log, the real plan, the real freshness rule, the real
 * completion gate and the real workspace lock — and replace only two things:
 *
 *  * the **process supervisor**, with a scripted one whose `start`/`waitForExit`
 *    answer from a table (modelled byte-for-byte on the donor's own
 *    `tests/helpers/engineering-scripted.cjs`), so a timeout, a registry outage or
 *    a killed process can be produced on demand; and
 *  * the **clock**, with an injected `now` and `sleep`, so the deadline bands and
 *    the retry ladder are asserted rather than waited for.
 *
 * Nothing here touches the repository tree: every workspace is an `mkdtemp`
 * directory under `node:os.tmpdir()`, and every process outcome is scripted.
 *
 * The cases mirror the donor's covering suites
 * (`tests/unit/engineering-scenarios.test.js` and the process case in
 * `tests/unit/engineering-verifier.test.js`) and add the decision-table cases the
 * donor only covers indirectly.
 *
 * @module project-foreman/tests/supervisor
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createEngineeringSupervisor, runEpisode, STEP_OUTCOMES, EPISODE_DEFAULTS } from '../supervisor.mjs';
import { EPISODE_PHASES } from '../episode.mjs';
import { FAILURE_CLASSES } from '../failure.mjs';
import { REFUSAL_REASONS } from '../result.mjs';

/** The broken implementation: `add` subtracts. */
const BROKEN_LIB = `'use strict'

function add(a, b) {
  return a - b
}

module.exports = { add }
`;

/** The fix. */
const FIXED_LIB = `'use strict'

function add(a, b) {
  return a + b
}

module.exports = { add }
`;

/** A second, deliberately wrong fix: used to prove a failed hypothesis is not repeated. */
const STILL_WRONG_LIB = `'use strict'

function add(a, b) {
  return a * b
}

module.exports = { add }
`;

const TEST_FILE = `'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { add } = require('../src/math.cjs')

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5)
})
`;

/** A scratch repository for a supervisor test. Always under the OS temp dir. */
function createRepo(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || 'pf-supervisor-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'math.cjs'), options.broken === false ? FIXED_LIB : BROKEN_LIB);
  fs.writeFileSync(path.join(dir, 'tests', 'math.test.cjs'), TEST_FILE);
  // Deliberately **no** `scripts.test`: discovery must not find a project command,
  // because every command this suite runs comes from the contract and is answered by
  // the scripted supervisor. A discovered `npm test` would be a real process.
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'pf-fixture', version: '1.0.0', private: true })}\n`);
  if (options.git !== false) {
    spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    spawnSync('git', ['config', 'user.email', 'foreman@test.invalid'], { cwd: dir, windowsHide: true });
    spawnSync('git', ['config', 'user.name', 'Project Foreman Fixture'], { cwd: dir, windowsHide: true });
    spawnSync('git', ['add', '.'], { cwd: dir, windowsHide: true });
    spawnSync('git', ['commit', '-q', '-m', 'fixture: initial'], { cwd: dir, windowsHide: true });
  }
  if (options.dirty === true) {
    // An uncommitted change that belongs to the user, made *after* the commit.
    fs.writeFileSync(path.join(dir, 'NOTES-user.txt'), 'the user was working on this\n');
  }
  return dir;
}

/** Remove a scratch directory. Never throws: a failed cleanup must not fail a test. */
function wipe(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * A scripted process supervisor: no real process is ever spawned.
 *
 * The surface is the donor helper's, which is the surface the supervisor consumes:
 * `start`, `waitForExit`, `kill`, `dispose`, `release`, `record`, `running`,
 * `finished`, `ownedCount`, `heartbeat` and a `registry` whose `snapshot()` reports
 * an `ownedCount`.
 *
 * @param {object} [options]
 * @param {Function} [options.script] `(invocation) => { exitCode, stdout, stderr, timedOut, killed, signal, alive, durationMs }`
 * @param {Function} [options.now]
 */
function createScriptedSupervisor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const script = typeof options.script === 'function' ? options.script : () => ({ exitCode: 0 });
  const invocations = [];
  const records = new Map();
  let sequence = 0;

  function start(input = {}) {
    sequence += 1;
    const invocation = {
      index: sequence,
      command: String(input.command || ''),
      args: Array.isArray(input.args) ? input.args.map(String) : [],
      cwd: input.cwd || null,
      class: input.class || null,
      step: input.step === undefined ? null : input.step,
      line: `${String(input.command || '')} ${(input.args || []).join(' ')}`.trim(),
    };
    const outcome = script(invocation) || { exitCode: 0 };
    invocations.push(invocation);
    const id = `scripted-${sequence}`;
    records.set(id, {
      id,
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      class: invocation.class,
      ownership: input.ownership || 'episode',
      startedAt: now(),
      status: outcome.alive ? 'running' : (outcome.killed ? 'killed' : (outcome.timedOut ? 'timed_out' : 'exited')),
      exitCode: outcome.alive ? null : (Number.isInteger(outcome.exitCode) ? outcome.exitCode : 0),
      signal: outcome.signal || null,
      timedOut: outcome.timedOut === true,
      killed: outcome.killed === true,
      durationMs: Number.isFinite(outcome.durationMs) ? outcome.durationMs : 5,
      output: {
        text: `${outcome.stdout || ''}${outcome.stderr || ''}`,
        bytes: Buffer.byteLength(`${outcome.stdout || ''}${outcome.stderr || ''}`),
        originalBytes: Buffer.byteLength(`${outcome.stdout || ''}${outcome.stderr || ''}`),
        truncated: false,
        errorRegion: outcome.stderr || null,
        stdoutBytes: Buffer.byteLength(outcome.stdout || ''),
        stderrBytes: Buffer.byteLength(outcome.stderr || ''),
        outputEvents: 1,
        lastOutputAt: now(),
      },
    });
    return records.get(id);
  }

  async function waitForExit(id) {
    const entry = records.get(id);
    if (!entry) return { ok: false, status: 'missing', exitCode: null, timedOut: false, killed: false, durationMs: 0, signal: null, output: { text: '', bytes: 0, originalBytes: 0, truncated: false } };
    // The donor helper's rule, unchanged: a non-zero exit, a timeout or a kill is
    // never a success, whatever the exit code says.
    const ok = entry.exitCode === 0 && !entry.timedOut && !entry.killed;
    return {
      ok,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
      timedOut: entry.timedOut,
      killed: entry.killed,
      durationMs: entry.durationMs,
      waitedMs: entry.durationMs,
      output: entry.output,
    };
  }

  return {
    registry: {
      snapshot: () => ({ ownedCount: records.size, owned: [...records.values()].map((entry) => ({ id: entry.id })), ceiling: 8, atCapacity: false, finished: [], hungSuspected: [] }),
      release: () => null,
    },
    start,
    waitForExit,
    progressingNow: () => true,
    kill: (id) => {
      const entry = records.get(id);
      if (!entry) return { ok: false, reason: 'not_owned', id };
      entry.killed = true;
      entry.status = 'killed';
      return { ok: true, id };
    },
    dispose: () => ({ attempted: 0, stopped: 0, results: [] }),
    release: () => null,
    record: (id) => records.get(id) || null,
    running: () => [...records.values()].filter((entry) => entry.status === 'running').map((entry) => ({ id: entry.id, command: entry.command })),
    finished: () => [...records.values()].map((entry) => ({ id: entry.id, command: entry.command, exitCode: entry.exitCode, durationMs: entry.durationMs, timedOut: entry.timedOut })),
    ownedCount: () => [...records.values()].filter((entry) => entry.status === 'running').length,
    heartbeat: () => ({ at: now(), processes: 0, currentCommand: null, lastOutputAgoMs: null, progressing: true }),
    invocations,
  };
}

/** An injected, virtual clock. The engine is never waited on in real time. */
function createClock(start = 1_700_000_000_000) {
  let value = start;
  let sleeps = 0;
  return {
    now: () => value,
    advance(ms = 1) {
      value += ms;
      return value;
    },
    sleep: async (ms = 0) => {
      sleeps += ms;
      // A virtual clock: the sleep is recorded, then time moves by exactly as much
      // as the caller asked for, so a 10-minute backoff costs nothing.
      value += Math.max(0, ms);
    },
    sleeps() {
      return sleeps;
    },
  };
}

/**
 * Build an episode against a scratch repository with everything injected.
 *
 * @param {object} input `{ repo, goal, contract, clock, script, ...overrides }`
 */
function buildEpisode(input = {}) {
  const clock = input.clock || createClock();
  const scripted = input.scripted || createScriptedSupervisor({ script: input.script, now: clock.now });
  const holder = input.holder || fs.mkdtempSync(path.join(os.tmpdir(), 'pf-checkpoints-'));
  const events = [];
  const supervisor = createEngineeringSupervisor({
    workspace: input.repo,
    goal: input.goal || 'fix the failing unit test',
    contract: input.contract || { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' } },
    checkpointRoot: path.join(holder, 'runtime', 'engineering', 'checkpoints'),
    deadlineMs: input.deadlineMs === undefined ? 60_000 : input.deadlineMs,
    now: clock.now,
    sleep: clock.sleep,
    log: (event) => events.push(event),
    runtime: input.runtime,
    runOptions: input.runOptions,
    isCancelled: input.isCancelled,
    lock: input.lock,
    episodeId: input.episodeId,
    recoveryCheckpoint: input.recoveryCheckpoint,
    beforeAction: input.beforeAction,
  });
  const realSupervisor = supervisor.supervisor;
  realSupervisor.start = scripted.start;
  realSupervisor.waitForExit = scripted.waitForExit;
  realSupervisor.registry = scripted.registry;
  return { supervisor, scripted, clock, holder, events };
}

/** The summary line one node --test run prints. */
function nodeTestOutput(failed) {
  return failed
    ? { exitCode: 1, stderr: 'AssertionError: expected 1 to be 5\n# tests 1\n# pass 0\n# fail 1\n' }
    : { exitCode: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n' };
}

/** Answer the suite from the file on disk, so "the fix works" is real. */
function suiteFollowsFixture(repo) {
  return () => {
    const file = path.join(repo, 'src', 'math.cjs');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return nodeTestOutput(!content.includes('a + b'));
  };
}

// ---------------------------------------------------------------------------
// The episode lifecycle and its terminal states.
// ---------------------------------------------------------------------------

test('the episode lifecycle: verify, discover, plan, patch, verify, COMPLETED', async () => {
  const repo = createRepo();
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test in src/math.cjs',
    contract: {
      commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' },
      patches: [{ reason: 'add must sum, not subtract', files: [{ path: 'src/math.cjs', content: FIXED_LIB }] }],
      require_build: false,
    },
    script: suiteFollowsFixture(repo),
  });
  try {
    const report = await episode.supervisor.run();

    // The evidence trail, in order.
    const phases = report.phases;
    assert.ok(phases.includes(EPISODE_PHASES.DISCOVERING), `the episode must discover the repository (${phases.join(' -> ')})`);
    assert.ok(phases.includes(EPISODE_PHASES.PLANNING));
    assert.ok(phases.includes(EPISODE_PHASES.EDITING) || phases.includes(EPISODE_PHASES.REPAIRING), 'the episode must change the code');
    assert.ok(phases.includes(EPISODE_PHASES.VERIFYING));
    assert.equal(phases[phases.length - 1], EPISODE_PHASES.COMPLETED, 'the terminal phase is COMPLETED');

    // The fix really landed on disk.
    assert.match(fs.readFileSync(path.join(repo, 'src', 'math.cjs'), 'utf8'), /a \+ b/);
    assert.deepEqual(report.filesChanged, ['src/math.cjs']);
    assert.equal(report.validation.ok, true, JSON.stringify(report.validation.reasons));
    assert.equal(report.validation.verdict, 'COMPLETED');
    assert.equal(report.result, 'COMPLETED');
    assert.equal(episode.supervisor.status, 'completed');
    assert.equal(episode.supervisor.phase, EPISODE_PHASES.COMPLETED);
    assert.equal(report.failures.length, 0, 'a clean episode records no failure');

    // The report's `lock` field is a snapshot taken before the tail of `run()`
    // releases, so the on-disk lock is what proves the workspace was freed.
    assert.equal(fs.existsSync(path.join(repo, 'runtime', 'engineering', 'workspace.lock')), false, 'no lock may be left behind');
    assert.equal(episode.scripted.invocations.length > 0, true, 'the episode must have actually run commands');
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

test('a repair that does not work is not retried blind, and the episode fails with evidence', async () => {
  const repo = createRepo();
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test',
    contract: {
      commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' },
      // Both patches are wrong: the loop must stop, not keep guessing.
      patches: [
        { reason: 'first guess', files: [{ path: 'src/math.cjs', content: STILL_WRONG_LIB }] },
        { reason: 'second guess', files: [{ path: 'src/math.cjs', content: STILL_WRONG_LIB }] },
      ],
      maxRepairRounds: 2,
    },
    script: () => ({
      exitCode: 1,
      stderr: `AssertionError: still wrong\n# tests 1\n# pass 0\n# fail 1\n`,
    }),
  });
  try {
    const report = await episode.supervisor.run();
    assert.notEqual(report.result, 'COMPLETED', 'an unfixed failure must not be reported as completed');
    assert.ok(report.repairRounds <= 2, `the repair budget must bound the loop (${report.repairRounds})`);
    assert.ok(report.failures.length >= 1, 'the episode must record the failure it could not repair');
    assert.ok(report.failures.some((entry) => entry.class === FAILURE_CLASSES.UNIT_TEST), JSON.stringify(report.failures.map((entry) => entry.class)));
    assert.ok(report.validation.reasons.length >= 1, 'a failure must be reported with its reasons');
    assert.equal(report.result, 'REFUSED', 'the validator refuses the completion claim, and its refusal is the verdict');
    assert.equal(report.validation.verdict, 'REFUSED');
    assert.equal(episode.supervisor.status, 'failed');
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

test('a caller may cancel the episode at a step boundary, and it reports CANCELLED', async () => {
  const repo = createRepo();
  let seen = 0;
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test',
    contract: { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' } },
    script: () => nodeTestOutput(true),
    // Cancel after the first step boundary the walk reaches.
    isCancelled: () => {
      seen += 1;
      return seen > 1;
    },
  });
  try {
    const report = await episode.supervisor.run();
    assert.equal(report.result, 'CANCELLED');
    assert.equal(report.validation.ok, false);
    assert.deepEqual(report.remainingWarnings, ['the caller cancelled the episode']);
    assert.equal(episode.supervisor.phase, EPISODE_PHASES.CANCELLED);
    // The donor's cancellation branch returns before the tail of `run()` reaches
    // its `lock.release()` (donor `supervisor.cjs:1159`), so a cancelled episode
    // leaves its workspace lock on disk. That is the donor's behaviour, ported
    // unchanged — see the migration report's defect section. Asserting it here keeps
    // the port honest about what it does, and will fail loudly if someone later
    // "fixes" the port without deciding what the city module should do.
    assert.equal(fs.existsSync(path.join(repo, 'runtime', 'engineering', 'workspace.lock')), true,
      'the donor leaves the lock behind on cancellation; a later reader must not assume otherwise');
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

// ---------------------------------------------------------------------------
// The failure decision table.
// ---------------------------------------------------------------------------

test('a transient failure is not retried blind: the attempt is recorded first, so the loop blocks', async () => {
  const repo = createRepo();
  const clock = createClock();
  const episode = buildEpisode({
    repo,
    clock,
    goal: 'fix the failing unit test',
    contract: { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' } },
    // A registry outage: transient, retry-bounded, and never any new state.
    script: () => ({ exitCode: 1, stderr: 'npm ERR! code ECONNREFUSED\nnpm ERR! network is unreachable\n' }),
  });
  try {
    const report = await episode.supervisor.run();
    // The decision table, exactly as the donor implements it: `decideAfterFailure`
    // calls `repairs.recordAttempt(...)` *before* asking `wouldBeBlind`, and
    // `wouldBeBlind` matches on the first attempt with the same signature — which is
    // the one just recorded. So `blind.blind` is true on the very first failure and
    // the `retry-bounded` arm blocks. The three-attempt `retry` path is therefore
    // never reached; this test pins the behaviour that is actually implemented
    // (donor `supervisor.cjs` lines 594-621), not the behaviour the comment implies.
    // See the migration report: this is a donor defect, not a port defect.
    const retries = episode.events.filter((event) => event.type === 'retry-parked');
    assert.equal(retries.length, 0, 'the donor never parks a retry: the first attempt already reads as blind');
    assert.equal(report.result, 'BLOCKED');
    assert.equal(report.repairRounds, 0);
    assert.equal(report.failures.length, 1, 'the failure is recorded once, then blocked');
    assert.ok(report.failures.some((entry) => entry.class === FAILURE_CLASSES.NETWORK));
    // The block names the network class, which is the classification the decision
    // was made on; the retry-bound message never reaches the report because the
    // supervisor's own block reason is what is carried into `failures`.
    assert.match(report.remainingWarnings.join('; '), /network/);
    assert.equal(clock.sleeps(), 0, 'nothing was parked, so nothing was slept');
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

test('a filesystem failure blocks rather than looping', async () => {
  const repo = createRepo();
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test',
    contract: { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' } },
    script: () => ({ exitCode: 1, stderr: 'ENOSPC: no space left on device, write\n' }),
  });
  try {
    const report = await episode.supervisor.run();
    assert.equal(report.result, 'BLOCKED');
    assert.equal(episode.events.filter((event) => event.type === 'retry-parked').length, 0, 'a block is not a retry');
    assert.equal(report.repairRounds, 0, 'a block is not a repair');
    assert.ok(report.failures.some((entry) => entry.class === FAILURE_CLASSES.FILESYSTEM));
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

test('a resource ceiling (degrade) blocks rather than looping, as a reconnect does', async () => {
  for (const scenario of [
    { stderr: 'FATAL ERROR: heap out of memory\n', expected: FAILURE_CLASSES.RESOURCE },
    { stderr: 'Target closed: the transport failed\n', expected: FAILURE_CLASSES.TRANSPORT },
  ]) {
    const repo = createRepo();
    const episode = buildEpisode({
      repo,
      goal: 'fix the failing unit test',
      contract: { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' } },
      script: () => ({ exitCode: 1, stderr: scenario.stderr }),
    });
    try {
      const report = await episode.supervisor.run();
      assert.equal(report.result, 'BLOCKED', `${scenario.expected} must block (${report.result})`);
      assert.equal(episode.events.filter((event) => event.type === 'retry-parked').length, 0, `${scenario.expected} must not be retried`);
      assert.ok(report.failures.some((entry) => entry.class === scenario.expected), `${scenario.expected} was classified as ${JSON.stringify(report.failures.map((entry) => entry.class))}`);
    } finally {
      wipe(repo);
      wipe(episode.holder);
    }
  }
});

test('the documented repair tracker is what makes the retry arm unreachable (donor defect)', async () => {
  // This is the mechanism behind the case above, isolated so it cannot be mistaken
  // for a porting mistake: the supervisor's own call order is
  // `recordAttempt(...)` then `wouldBeBlind({ stateChanged: false })`, and the
  // second call finds the first one's entry. The donor's intent — "a transient
  // failure may be retried, but not forever and not blindly" — is not what the
  // implementation does. Nothing here is weakened: the assertion pins the donor's
  // actual output.
  const { createRepairTracker, classify } = await import('../failure.mjs');
  const tracker = createRepairTracker({ now: () => 1 });
  const failure = classify({ operation: 'focusedTest', command: 'node --test tests', output: 'ECONNREFUSED\n', exitCode: 1 });
  assert.equal(failure.action, 'retry-bounded');
  const attempt = tracker.recordAttempt({ signature: failure.signature, class: failure.class, operation: 'focusedTest', command: 'node --test tests', mutations: 0 });
  assert.equal(attempt.count, 1, 'the first failure is attempt one');
  const blind = tracker.wouldBeBlind({ signature: failure.signature, stateChanged: false });
  assert.equal(blind.blind, true, 'the attempt just recorded is read back as a previous attempt');
  assert.match(blind.reason, /already produced 1 time\(s\)/);
  // The donor's own guard therefore refuses the retry on attempt one:
  assert.equal(!blind.blind && attempt.count <= 3, false, 'the retry arm can never be entered');
});

test('a repair already ruled blind stalls instead of repeating the same patch', async () => {
  const repo = createRepo();
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test',
    contract: {
      commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' },
      maxRepairRounds: 6,
    },
    // The patch is skipped (none is supplied), so the loop produces no mutation at
    // all: the identical failure with no state change is the blind retry.
    script: () => nodeTestOutput(true),
  });
  try {
    const report = await episode.supervisor.run();
    assert.equal(report.repairRounds, 0, 'no patch was applied, so no repair round was spent');
    assert.equal(report.result, 'REFUSED');
    assert.ok(report.stallLevel >= 3, `a stall is recorded (${report.stallLevel})`);
    // The escalation is recorded once, and it broadens to full verification rather
    // than starting another repair round.
    const escalations = report.context.decisions.filter((entry) => entry.kind === 'stall');
    assert.equal(escalations.length, 1, 'the broaden-to-verify escalation happens exactly once');
    assert.equal(escalations[0].result, 'escalate to full verification');
    assert.ok(report.phases.includes(EPISODE_PHASES.STALLED));
    assert.ok(report.phases.indexOf(EPISODE_PHASES.STALLED) < report.phases.indexOf(EPISODE_PHASES.VERIFYING));
    assert.equal(report.failures.some((entry) => entry.class === FAILURE_CLASSES.UNIT_TEST), true);
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

test('the repair budget is spent -> a stall, not another round', async () => {
  const repo = createRepo();
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test',
    contract: {
      commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' },
      // One patch that never fixes it, and a budget of exactly one round.
      patches: [{ reason: 'only guess', files: [{ path: 'src/math.cjs', content: STILL_WRONG_LIB }] }],
      maxRepairRounds: 1,
    },
    script: () => nodeTestOutput(true),
  });
  try {
    const report = await episode.supervisor.run();
    assert.ok(report.repairRounds <= 1, `the repair budget is a ceiling (${report.repairRounds})`);
    assert.equal(report.result, 'REFUSED');
    assert.equal(report.stallLevel >= 3, true, `the loop stalled rather than looping (${report.stallLevel})`);
    // The stall is the repair budget's own refusal, not an exhaustion of hypotheses:
    // one patch round happened, then the budget was spent.
    assert.equal(report.stallLevel >= 3, true);
    assert.ok(report.context.decisions.some((entry) => entry.kind === 'stall'));
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

// ---------------------------------------------------------------------------
// The deadline bands.
// ---------------------------------------------------------------------------

test('the deadline bands gate new work: a nearly expired episode verifies and reports', async () => {
  const repo = createRepo();
  const clock = createClock(1_000_000);
  const episode = buildEpisode({
    repo,
    clock,
    goal: 'fix the failing test',
    contract: { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' } },
    script: () => nodeTestOutput(false),
    // Ten minutes of budget, and the clock jumps past the wrap-up band before the
    // first step: the runtime may only verify what exists and report.
    deadlineMs: 600_000,
    beforeAction: () => {
      clock.advance(550_000);
    },
  });
  try {
    const report = await episode.supervisor.run();
    assert.ok(report.phases.includes(EPISODE_PHASES.VERIFYING), 'an expiring episode must go to verification');
    assert.ok(report.durationMs >= 0);
    assert.ok(report.validation, 'the report must carry the validation verdict');
    assert.equal(report.mutations.applied, 0, 'no new work may start in the final band');
    assert.equal(report.result, 'REFUSED', 'a deadline-limited episode does not claim completion it cannot prove');
    assert.equal(report.validation.ok, false);
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

test('the episode budget defaults match the donor exactly', () => {
  assert.deepEqual(EPISODE_DEFAULTS, {
    deadlineMs: 24 * 60 * 60 * 1000,
    maxSteps: 40,
    maxRepairRounds: 6,
    maxHypotheses: 4,
    stallThreshold: 3,
    stepTimeoutMs: 30 * 60_000,
    outputBytes: 256 * 1024,
    maxParkedMs: 10 * 60_000,
  });
  assert.deepEqual(STEP_OUTCOMES, { SUCCESS: 'success', FAILED: 'failed', SKIPPED: 'skipped', WAITING: 'waiting' });
});

test('the module surface the rest of the runtime imports is exactly the donor\'s', async () => {
  // The donor's `module.exports` for the four scoped modules, verbatim. A port that
  // dropped a name would break its importers silently; a port that added one is
  // reported separately in the migration report as an adaptation.
  const supervisor = await import('../supervisor.mjs');
  for (const name of ['createEngineeringSupervisor', 'runEpisode', 'splitCommand', 'STEP_OUTCOMES', 'EPISODE_DEFAULTS', 'FAILURE_CLASSES', 'MUTATION_KINDS']) {
    assert.ok(name in supervisor, `supervisor.mjs must export ${name}`);
  }
  const process = await import('../process.mjs');
  for (const name of ['createProcessSupervisor', 'PROCESS_CLASS', 'READINESS']) {
    assert.ok(name in process, `process.mjs must export ${name}`);
  }
  const context = await import('../context.mjs');
  for (const name of ['createEpisodeContext', 'LIVE_KEYS', 'DEFAULT_EVIDENCE_RING', 'DEFAULT_VERIFICATION_RING', 'DEFAULT_DECISION_RING', 'DEFAULT_PROCESS_RING', 'DEFAULT_STEP_RING', 'DEFAULT_FILE_RING', 'DEFAULT_BLOCKER_RING', 'DEFAULT_TAIL', 'DEFAULT_SUMMARY_BUDGET_BYTES']) {
    assert.ok(name in context, `context.mjs must export ${name}`);
  }
  const scheduler = await import('../scheduler.mjs');
  for (const name of ['WAKE_REASONS', 'DEFAULT_DEADLINE_MS', 'DEFAULT_BACKOFF_MS', 'deadlineState', 'createScheduler']) {
    assert.ok(name in scheduler, `scheduler.mjs must export ${name}`);
  }
  // Every frozen constant stays frozen.
  for (const value of [supervisor.STEP_OUTCOMES, supervisor.EPISODE_DEFAULTS, process.PROCESS_CLASS, process.READINESS, context.LIVE_KEYS, scheduler.WAKE_REASONS, scheduler.DEFAULT_BACKOFF_MS]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test('the donor constants the port must not drift from', async () => {
  const { DEFAULT_SOFT_TIMEOUT_MS, DEFAULT_HARD_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS, DEFAULT_OUTPUT_BYTES, PROCESS_CLASS, READINESS } = await import('../process.mjs');
  assert.equal(DEFAULT_SOFT_TIMEOUT_MS, 600_000);
  assert.equal(DEFAULT_HARD_TIMEOUT_MS, 3_600_000);
  assert.equal(DEFAULT_READY_TIMEOUT_MS, 60_000);
  assert.equal(DEFAULT_OUTPUT_BYTES, 262_144);
  assert.deepEqual(PROCESS_CLASS, { FOREGROUND: 'foreground', BACKGROUND: 'background', WATCHER: 'watcher', BUILD: 'build', TEST: 'test', SERVER: 'server', HELPER: 'helper' });
  assert.deepEqual(READINESS, { PORT: 'port', HTTP: 'http', STDOUT: 'stdout', FILE: 'file', EXIT: 'exit', NONE: 'none' });

  const { DEFAULT_DEADLINE_MS, DEFAULT_BACKOFF_MS, deadlineState } = await import('../scheduler.mjs');
  assert.equal(DEFAULT_DEADLINE_MS, 86_400_000);
  assert.deepEqual(DEFAULT_BACKOFF_MS, [30_000, 60_000, 120_000, 300_000, 600_000]);
  // The bands, at the donor's boundaries.
  const band = (now) => deadlineState({ now, startedAt: 0, deadline: 100_000 });
  assert.equal(band(50_000).band, 'full');
  assert.equal(band(50_000).allowNewWork, true);
  assert.equal(band(80_000).band, 'wrap-up');
  assert.equal(band(80_000).allowNewWork, false);
  assert.equal(band(80_000).finalOnly, false);
  assert.equal(band(90_000).band, 'final');
  assert.equal(band(90_000).finalOnly, true);
  assert.equal(band(100_001).band, 'expired');
  assert.equal(band(100_001).expired, true);
  // The donor's absolute floor is `totalMs > 15000 && remainingMs <= 15000`. On a
  // 100-second budget, 16 seconds left (ratio 0.16) is still wrap-up, and 13 seconds
  // left (ratio 0.13) is final because the floor applies — the floor is what decides
  // the last 15 seconds of an episode that is long enough to have them.
  assert.equal(deadlineState({ now: 84_000, startedAt: 0, deadline: 100_000 }).band, 'wrap-up');
  assert.equal(deadlineState({ now: 84_000, startedAt: 0, deadline: 100_000 }).finalOnly, false);
  assert.equal(deadlineState({ now: 87_000, startedAt: 0, deadline: 100_000 }).band, 'final');
  assert.equal(deadlineState({ now: 87_000, startedAt: 0, deadline: 100_000 }).finalOnly, true);
  // A fixed "15 minutes left" rule would put an episode in its final band three
  // minutes before the end of a long unit of work, before it could finish it. The
  // donor's banding is relative unless the *absolute* 15-second floor applies: on a
  // 25-minute budget, the last five minutes are still wrap-up, not final.
  const minutes = 60_000;
  const wrap = deadlineState({ now: 20 * minutes, startedAt: 0, deadline: 25 * minutes });
  assert.equal(wrap.remainingMs, 5 * minutes);
  assert.equal(wrap.ratio, 0.2);
  assert.equal(wrap.band, 'wrap-up');
  assert.equal(wrap.finalOnly, false);
  assert.equal(wrap.allowCurrentWork, true);
  // On a long episode the 15-second absolute floor does decide the last stretch: the
  // ratio is 0.011, which would already be final, and the floor agrees.
  const day = 24 * 60 * 60 * 1000;
  const floorBand = deadlineState({ now: day - 10_000, startedAt: 0, deadline: day });
  assert.equal(floorBand.remainingMs, 10_000);
  assert.equal(floorBand.band, 'final', 'the 15s absolute floor decides the last stretch of a long episode');
  assert.equal(floorBand.finalOnly, true);

  const { DEFAULT_SUMMARY_BUDGET_BYTES, LIVE_KEYS } = await import('../context.mjs');
  assert.equal(DEFAULT_SUMMARY_BUDGET_BYTES, 4096);
  assert.deepEqual(LIVE_KEYS, ['phase', 'goal', 'planStep', 'currentFile', 'currentAction', 'currentError']);
});

// ---------------------------------------------------------------------------
// Repair ordering: the failure must be proven before anything is patched.
// ---------------------------------------------------------------------------

test('a repair is proven before it is patched: reproduce precedes patch end to end', async () => {
  const repo = createRepo();
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test in src/math.cjs',
    contract: {
      commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' },
      patches: [{ reason: 'add must sum', files: [{ path: 'src/math.cjs', content: FIXED_LIB }] }],
    },
    script: suiteFollowsFixture(repo),
    beforeAction: (action) => {
      // While the reproduce step is the action, the file must still be broken: a
      // patch that ran first would have been a guess, not a repair.
      if (action.kind === 'reproduce') {
        assert.match(fs.readFileSync(path.join(repo, 'src', 'math.cjs'), 'utf8'), /a - b/);
      }
    },
  });
  try {
    const report = await episode.supervisor.run();
    assert.equal(report.result, 'COMPLETED');
    const phases = report.phases;
    assert.ok(phases.includes(EPISODE_PHASES.TESTING), 'the failure is reproduced by running the suite');
    assert.ok(phases.includes(EPISODE_PHASES.EDITING), 'only then is the code changed');
    assert.ok(phases.indexOf(EPISODE_PHASES.TESTING) < phases.indexOf(EPISODE_PHASES.EDITING), `reproduce must precede the patch (${phases.join(' -> ')})`);
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

// ---------------------------------------------------------------------------
// A killed process is never a success.
// ---------------------------------------------------------------------------

test('a killed process is never a success, even when it exited zero', async () => {
  const repo = createRepo();
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test',
    contract: { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' } },
    // Exit code 0, and killed: the two facts together are a refusal.
    script: () => ({ exitCode: 0, killed: true, stdout: '# tests 1\n# pass 1\n# fail 0\n' }),
  });
  try {
    const report = await episode.supervisor.run();
    assert.notEqual(report.result, 'COMPLETED', 'a killed process must not complete the episode');
    assert.ok(report.failures.length >= 1, 'the kill must leave a recorded failure');
    assert.equal(episode.supervisor.phase === EPISODE_PHASES.COMPLETED, false);
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

test('a timed-out process is a failure with the timeout class, never a success', async () => {
  const repo = createRepo();
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test',
    contract: { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' } },
    script: () => ({ exitCode: null, timedOut: true, killed: true, stderr: 'the command exceeded its 1800000ms budget\n' }),
  });
  try {
    const report = await episode.supervisor.run();
    assert.notEqual(report.result, 'COMPLETED');
    assert.ok(report.failures.some((entry) => entry.class === FAILURE_CLASSES.TIMEOUT), JSON.stringify(report.failures.map((entry) => entry.class)));
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

test('the completion gate refuses: the required tests, the unresolved failure, the build, the lint', async () => {
  // 1. TESTS: the contract requires the suite but the project declares no command
  //    for it, so every verification level reports the refusal instead of a run.
  {
    const repo = createRepo();
    const episode = buildEpisode({
      repo,
      goal: 'fix the failing unit test',
      contract: { commands: { build: 'node --version' }, tests: ['full-verify'] },
      script: () => ({ exitCode: 0 }),
    });
    try {
      const report = await episode.supervisor.run();
      assert.equal(report.result, 'REFUSED');
      assert.ok(report.validation.reasons.includes(REFUSAL_REASONS.TESTS), `expected the tests refusal (${report.validation.reasons.join('; ')})`);
      assert.equal(report.validation.ok, false);
      assert.equal(report.validation.verdict, 'REFUSED');
      // The required level produced no passing run: either nothing was ever run for
      // it, or the verifier refused because no command was discovered. Both are the
      // donor's own refusal wording, and both are "not a run".
      assert.equal(report.verification.levels['full-verify'].ok, false);
      assert.match(String(report.verification.levels['full-verify'].reason), /has not run|no command was discovered/);
    } finally {
      wipe(repo);
      wipe(episode.holder);
    }
  }

  // 2. UNRESOLVED_FAILURE: the failure class the loop could not repair.
  {
    const repo = createRepo();
    const episode = buildEpisode({
      repo,
      goal: 'fix the failing unit test',
      contract: { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' } },
      script: () => ({ exitCode: 1, stderr: 'SyntaxError: Unexpected token\n' }),
    });
    try {
      const report = await episode.supervisor.run();
      assert.equal(report.result, 'REFUSED');
      assert.ok(report.validation.reasons.includes(REFUSAL_REASONS.UNRESOLVED_FAILURE), `expected the unresolved-failure refusal (${report.validation.reasons.join('; ')})`);
      assert.ok(report.failures.some((entry) => entry.class === FAILURE_CLASSES.SYNTAX));
    } finally {
      wipe(repo);
      wipe(episode.holder);
    }
  }

  // 3. BUILD: `require_build` with a command that was never run as a required level.
  {
    const repo = createRepo();
    const episode = buildEpisode({
      repo,
      goal: 'fix the failing unit test',
      contract: {
        commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' },
        require_build: true,
        tests: [],
      },
      script: () => ({ exitCode: 0 }),
    });
    try {
      const report = await episode.supervisor.run();
      assert.equal(report.result, 'REFUSED');
      assert.ok(report.validation.reasons.includes(REFUSAL_REASONS.BUILD), `expected the build refusal (${report.validation.reasons.join('; ')})`);
    } finally {
      wipe(repo);
      wipe(episode.holder);
    }
  }

  // 4. LINT: the same, for lint.
  {
    const repo = createRepo();
    const episode = buildEpisode({
      repo,
      goal: 'fix the failing unit test',
      contract: {
        commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' },
        require_lint: true,
        tests: [],
      },
      script: () => ({ exitCode: 0 }),
    });
    try {
      const report = await episode.supervisor.run();
      assert.equal(report.result, 'REFUSED');
      assert.ok(report.validation.reasons.includes(REFUSAL_REASONS.LINT), `expected the lint refusal (${report.validation.reasons.join('; ')})`);
    } finally {
      wipe(repo);
      wipe(episode.holder);
    }
  }
});

test('the completion gate refuses a workspace that is no longer the one it was given', async () => {
  // The workspace check is the validator's own (`workspaceStillValid`), so it is
  // asserted through the same door the supervisor uses: a validation input whose
  // workspace is gone must be refused, with the named reason.
  const { createResultValidator, workspaceStillValid, REFUSAL_REASONS: reasons } = await import('../result.mjs');
  const repo = createRepo();
  try {
    const validator = createResultValidator({ now: () => 1 });
    const verification = { commands: [{ command: 'node --test tests' }], levels: { 'full-verify': { ok: true, at: 1 } } };
    const verdict = validator.validate({
      contract: { tests: ['full-verify'] },
      criteria: { satisfied: true, unknown: false, results: [] },
      verification,
      lastMutationAt: null,
      failures: { unresolved: [] },
      workspace: workspaceStillValid(path.join(repo, 'gone')),
      leaks: { processes: 0, watchers: 0, screenshots: 0 },
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.includes(reasons.WORKSPACE), `expected the workspace refusal (${verdict.reasons.join('; ')})`);

    // And a live workspace with the same evidence is accepted, so the refusal above
    // is the workspace and nothing else.
    const accepted = validator.validate({
      contract: { tests: ['full-verify'] },
      criteria: { satisfied: true, unknown: false, results: [] },
      verification,
      lastMutationAt: null,
      failures: { unresolved: [] },
      workspace: workspaceStillValid(repo),
      leaks: { processes: 0, watchers: 0, screenshots: 0 },
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.reasons));
  } finally {
    wipe(repo);
  }
});

// ---------------------------------------------------------------------------
// Safety rules that must never be weakened.
// ---------------------------------------------------------------------------

test('the lock is not stolen from a live owner', async () => {
  const repo = createRepo();
  const { createWorkspaceLock } = await import('../locking.mjs');
  const holder = createWorkspaceLock({ root: repo });
  const first = holder.acquire({ episode: 'episode-owner' });
  assert.equal(first.ok, true);
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test',
    contract: { commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' }, requireGit: true },
    script: suiteFollowsFixture(repo),
    // The lock is created fresh inside the supervisor unless one is injected, so
    // this episode competes for the real on-disk lock the holder above owns.
  });
  try {
    const report = await episode.supervisor.run();
    assert.equal(report.result, 'BLOCKED');
    assert.match(report.remainingWarnings.join('; '), /another episode holds this workspace/);
    assert.equal(episode.supervisor.status, 'blocked');
    assert.equal(episode.scripted.invocations.length, 0, 'a blocked episode must start nothing');
    assert.equal(holder.held, true, 'the live owner still holds its lock');
    assert.equal(fs.existsSync(holder.file), true);
  } finally {
    holder.release();
    wipe(repo);
    wipe(episode.holder);
  }
});

test('the user\'s uncommitted work is never overwritten', async () => {
  const repo = createRepo({ dirty: true });
  const userFile = path.join(repo, 'NOTES-user.txt');
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test in src/math.cjs',
    contract: {
      commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' },
      // The patch tries to overwrite the file the user had already modified.
      patches: [{ reason: 'rewrite the user notes', files: [{ path: 'NOTES-user.txt', content: 'the runtime overwrote this\n' }] }],
    },
    script: suiteFollowsFixture(repo),
  });
  try {
    const report = await episode.supervisor.run();
    assert.equal(fs.readFileSync(userFile, 'utf8'), 'the user was working on this\n', 'the user\'s uncommitted file must be untouched');
    assert.deepEqual(report.filesChanged, [], 'nothing the episode did not own is reported as changed');
    assert.equal(report.repository.dirtyAtStart >= 1, true);
    // The refusal is recorded, and it is the mutation log's own reason.
    const refusals = report.context ? report.context.decisions.filter((entry) => entry.kind === 'mutation-refused') : [];
    assert.ok(refusals.length >= 1, 'the refusal must be recorded as a decision');
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

test('a workspace that does not exist is BLOCKED, and is not conjured into being by the lock', async () => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-missing-'));
  const missing = path.join(holder, 'there-is-no-repo-here');
  const clock = createClock();
  const scripted = createScriptedSupervisor({ script: () => ({ exitCode: 0 }), now: clock.now });
  const supervisor = createEngineeringSupervisor({
    workspace: missing,
    goal: 'fix the failing unit test',
    checkpointRoot: path.join(holder, 'runtime', 'engineering', 'checkpoints'),
    now: clock.now,
    sleep: clock.sleep,
  });
  supervisor.supervisor.start = scripted.start;
  supervisor.supervisor.waitForExit = scripted.waitForExit;
  supervisor.supervisor.registry = scripted.registry;
  try {
    const report = await supervisor.run();
    assert.equal(report.result, 'BLOCKED');
    assert.equal(fs.existsSync(missing), false, 'a missing workspace must not be created by taking a lock');
    assert.equal(supervisor.status, 'blocked');
  } finally {
    wipe(holder);
  }
});

// ---------------------------------------------------------------------------
// Durability: the episode checkpoints its cursor.
// ---------------------------------------------------------------------------

test('the episode checkpoints its plan, its cursor and its phase as it walks', async () => {
  const repo = createRepo();
  const episode = buildEpisode({
    repo,
    goal: 'fix the failing unit test in src/math.cjs',
    contract: {
      commands: { test: 'node --test tests', focusedTest: 'node --test tests', fullVerify: 'node --test tests' },
      patches: [{ reason: 'add must sum', files: [{ path: 'src/math.cjs', content: FIXED_LIB }] }],
    },
    script: suiteFollowsFixture(repo),
  });
  try {
    const report = await episode.supervisor.run();
    assert.equal(report.result, 'COMPLETED');
    assert.ok(report.checkpoints >= 1, 'the episode must have written at least one checkpoint');
    const saved = episode.supervisor.checkpoints.latest(episode.supervisor.id);
    assert.ok(saved, 'the latest checkpoint is readable');
    assert.equal(saved.recovery.lifecycleState, 'COMPLETED');
    assert.equal(saved.recovery.request.goal, 'fix the failing unit test in src/math.cjs');
    assert.ok(Array.isArray(saved.recovery.plan.steps));
    assert.ok(saved.recovery.cursor.nextStepIndex >= 1, 'the verified prefix is recorded in the cursor');
  } finally {
    wipe(repo);
    wipe(episode.holder);
  }
});

// ---------------------------------------------------------------------------
// The convenience entry point is the same loop.
// ---------------------------------------------------------------------------

test('the public entry point is the same loop, and builds the same supervisor', async () => {
  // `runEpisode` is deliberately not driven with real commands here: it builds its
  // own supervisor, and a test that runs it would spawn real processes. What is
  // asserted instead is that it is the documented entry point over the same
  // constructor — the loop itself is covered by every case above.
  assert.equal(typeof runEpisode, 'function');
  const repo = createRepo({ broken: false });
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-entry-'));
  const clock = createClock();
  try {
    const built = createEngineeringSupervisor({
      workspace: repo,
      goal: 'verify the suite stays green',
      contract: { commands: { test: 'node --test tests', fullVerify: 'node --test tests' }, tests: ['focused-test'] },
      checkpointRoot: path.join(holder, 'runtime', 'engineering', 'checkpoints'),
      deadlineMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.ok(built.id.startsWith('episode-'));
    assert.equal(built.phase, EPISODE_PHASES.INITIALIZING);
    assert.equal(built.status, 'idle');
    assert.equal(typeof built.run, 'function');
    assert.equal(typeof built.summarize, 'function');
    assert.deepEqual(Object.keys(built.budget).sort(), Object.keys(EPISODE_DEFAULTS).sort());
    // The entry point takes one optional input object, so its declared arity is 0.
    // (The re-exported arity in the package entry point is another agent's concern;
    // this asserts the source module's own signature.)
    assert.equal(runEpisode.length, 0);
  } finally {
    wipe(repo);
    wipe(holder);
  }
});
