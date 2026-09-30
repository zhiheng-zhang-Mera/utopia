/**
 * MB-004 verification pilot — a REAL engineering job through the ported Foreman.
 *
 * The Mission's Verification gate forbids substituting unit tests for a real run:
 *
 *   "通过 MB-003 Worker Gateway 跑一次真实 Engineering job，从 inspect/plan 到
 *    result/evidence，禁止仅用单元测试替代。"
 *   "至少一次受控中断/恢复或 donor 已存在的等价 recovery 场景验证 checkpoint/continuation。"
 *
 * The pilot drives the real `index.mjs` entry point against REAL scratch
 * repositories on disk: the real process supervisor spawns real `node --test`
 * child processes, and the real git fingerprint, workspace lock, mutation journal
 * with its ownership rule, checkpoint store, recovery store and result gate are
 * all exercised. Nothing here is scripted or stubbed, and no artefact of the
 * product tree is modified.
 *
 * Phases:
 *   1. real job              inspect -> discover -> plan -> patch -> verify -> COMPLETED
 *   2. graceful interruption a real episode stopped by the caller's cancel seam
 *   3. killed-process resume a live episode terminated by killing its process, then
 *                            resumed by a second episode from its own checkpoint
 *   4. ownership refusal     an episode may not overwrite the user's uncommitted work
 *
 * Run as a child (`--child`) it just runs one episode; the parent uses that to have
 * a real process it can kill. See `phaseKillAndResume`.
 *
 * Evidence: `.runtime/evidence/mission-book/MB-004/run-001/foreman-runtime-pilot.json`
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { run } from '../city/02-engineering/01-project-foreman/project-foreman/index.mjs';
import { createCheckpointStore } from '../city/02-engineering/01-project-foreman/project-foreman/checkpoint.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '.runtime', 'evidence', 'mission-book', 'MB-004', 'run-001');
const TEST_COMMAND = 'node --test tests/math.test.cjs';

/** The broken implementation: add subtracts. */
const BROKEN_LIB = `'use strict'

function add(a, b) {
  return a - b
}

module.exports = { add }
`;

/** The fix the contract carries. */
const FIXED_LIB = `'use strict'

function add(a, b) {
  return a + b
}

module.exports = { add }
`;

/** A real node:test suite that reads the library from disk. */
const testFile = (delayMs) => `'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { add } = require('../src/math.cjs')

test('add sums two numbers', async () => {
  await new Promise((resolve) => setTimeout(resolve, ${delayMs}))
  assert.equal(add(2, 3), 5)
})
`;

/** A real scratch git repository. Always under the OS temp dir. */
function createRepo(prefix, delayMs = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'math.cjs'), BROKEN_LIB);
  fs.writeFileSync(path.join(dir, 'tests', 'math.test.cjs'), testFile(delayMs));
  // No `scripts.test`: discovery must not resolve a project command, so the
  // commands that actually run are the ones this contract states.
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'mb004-pilot', version: '1.0.0', private: true })}\n`);
  for (const args of [['init', '-q'], ['config', 'user.email', 'foreman@utopia.invalid'], ['config', 'user.name', 'MB-004 Pilot'], ['add', '.'], ['commit', '-q', '-m', 'fixture: broken add']]) {
    const done = spawnSync('git', args, { cwd: dir, windowsHide: true });
    assert.equal(done.status, 0, `git ${args.join(' ')} failed`);
  }
  return dir;
}

function wipe(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** The contract every phase shares. */
const contract = (patch = true) => ({
  commands: { test: TEST_COMMAND, focusedTest: TEST_COMMAND, fullVerify: TEST_COMMAND },
  ...(patch ? { patches: [{ reason: 'add must sum, not subtract', files: [{ path: 'src/math.cjs', content: FIXED_LIB }] }] } : {}),
  require_build: false,
});

/** Only the report fields this pilot reasons about, kept small in the evidence. */
function summarize(report) {
  return {
    result: report.result,
    validationOk: report.validation ? report.validation.ok : null,
    validationVerdict: report.validation ? report.validation.verdict : null,
    refusalReasons: report.validation ? report.validation.reasons : null,
    remainingWarnings: report.remainingWarnings ?? null,
    failures: (report.failures ?? []).map((entry) => entry.class ?? entry.reason ?? String(entry)),
    repairRounds: report.repairRounds ?? null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ child mode */

/**
 * Child mode: run exactly one real episode and exit. The parent kills this
 * process mid-episode so that recovery runs against a genuinely abandoned run.
 */
async function childMode() {
  const repo = process.env.MB004_REPO;
  const checkpointRoot = process.env.MB004_CKPT;
  const recoveryRoot = process.env.MB004_REC;
  assert.ok(repo && checkpointRoot && recoveryRoot, 'child mode needs MB004_REPO, MB004_CKPT and MB004_REC');
  await run({
    workspace: repo,
    goal: 'fix the failing unit test in src/math.cjs',
    contract: contract(true),
    checkpointRoot,
    recoveryRoot,
    deadlineMs: 120_000,
    log: () => {},
  });
}

/* ----------------------------------------------------------------- the phases */

const evidence = {
  mission: 'MB-004',
  role: 'VERIFICATION',
  host: 'Alien',
  sourceSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  purpose: 'real end-to-end engineering job through the ported Project Foreman',
  phases: {},
  status: 'PASS',
};

let stepsInFullJob = null;

async function phaseRealJob() {
  const repo = createRepo('mb004-real-');
  const events = [];
  const checkpointRoot = path.join(repo, 'runtime', 'checkpoints');
  let steps = 0;
  try {
    const report = await run({
      workspace: repo,
      goal: 'fix the failing unit test in src/math.cjs',
      contract: contract(true),
      checkpointRoot,
      recoveryRoot: path.join(repo, 'runtime', 'recovery'),
      deadlineMs: 120_000,
      beforeAction: () => {
        steps += 1;
      },
      log: (event) => events.push({ type: event.type, from: event.from, to: event.to, kind: event.kind, step: event.step }),
    });

    const lib = fs.readFileSync(path.join(repo, 'src', 'math.cjs'), 'utf8');
    const after = spawnSync('node', ['--test', 'tests/math.test.cjs'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    const phases = events.filter((event) => event.type === 'phase').map((event) => `${event.from}->${event.to}`);
    stepsInFullJob = steps;

    evidence.phases.realJob = {
      ...summarize(report),
      stepsInFullJob: steps,
      patchAppliedOnDisk: lib.includes('a + b'),
      realTestExitAfterEpisode: after.status,
      phaseTrail: phases,
      progressEvents: events.filter((event) => event.type === 'progress').length,
      actionEvents: events.filter((event) => event.type === 'action').length,
      checkpointsOnDisk: fs.existsSync(checkpointRoot)
        ? fs.readdirSync(checkpointRoot, { recursive: true }).filter((name) => String(name).endsWith('.json')).length
        : 0,
    };

    assert.equal(report.result, 'COMPLETED', `the real job must complete (got ${report.result})`);
    assert.equal(report.validation.ok, true, 'the completion gate must pass on real fresh evidence');
    assert.ok(lib.includes('a + b'), 'the contract patch must have been applied to the real file');
    assert.equal(after.status, 0, 'the real suite must pass in the workspace after the episode');
    assert.ok(phases.length >= 4, 'the episode must publish a real phase trail');
  } finally {
    wipe(repo);
  }
}

async function phaseGracefulInterruption() {
  const repo = createRepo('mb004-cancel-');
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'mb004-cancel-ckpt-'));
  const checkpointRoot = path.join(holder, 'checkpoints');
  const lockFile = path.join(repo, 'runtime', 'engineering', 'workspace.lock');
  try {
    let steps = 0;
    let cancel = false;
    const first = await run({
      workspace: repo,
      goal: 'fix the failing unit test in src/math.cjs',
      contract: contract(true),
      checkpointRoot,
      recoveryRoot: path.join(holder, 'recovery'),
      deadlineMs: 120_000,
      log: () => {},
      beforeAction: () => {
        steps += 1;
        if (steps >= 2) cancel = true;
      },
      isCancelled: () => cancel,
    });

    const store = createCheckpointStore({ dir: checkpointRoot });
    const checkpoint = store.latest();
    const lockLeftBehind = fs.existsSync(lockFile);
    if (lockLeftBehind) fs.rmSync(lockFile, { force: true });

    // A cancelled episode is terminal, and the recovery store refuses to make a
    // terminal episode active again. That is donor behaviour and it means a
    // *graceful cancellation* is not resumable: only an abandoned run is.
    const resumeAttempt = await run({
      workspace: repo,
      goal: 'fix the failing unit test in src/math.cjs',
      contract: contract(true),
      checkpointRoot,
      recoveryRoot: path.join(holder, 'recovery'),
      recoveryCheckpoint: checkpoint,
      episodeId: checkpoint && checkpoint.recovery ? checkpoint.recovery.episodeId : undefined,
      deadlineMs: 120_000,
      log: () => {},
    });

    evidence.phases.gracefulInterruption = {
      ...summarize(first),
      stepsAttemptedBeforeCancel: steps,
      checkpointWritten: Boolean(checkpoint),
      checkpointCursor: checkpoint && checkpoint.recovery ? checkpoint.recovery.cursor : null,
      lockLeftBehindByCancellation: lockLeftBehind,
      resumeOfTerminalEpisode: summarize(resumeAttempt),
    };

    assert.equal(first.result, 'CANCELLED', `a cancelled episode reports CANCELLED (got ${first.result})`);
    assert.ok(checkpoint && checkpoint.recovery && checkpoint.recovery.cursor, 'the cancelled episode must leave a readable checkpoint');
    assert.equal(lockLeftBehind, true, "the donor's cancellation branch must leave the workspace lock behind (defect 2)");
    assert.notEqual(resumeAttempt.result, 'COMPLETED', 'a terminal episode must not be resumable into completion');
  } finally {
    wipe(repo);
    wipe(holder);
  }
}

async function phaseKillAndResume() {
  const repo = createRepo('mb004-kill-', 4000);
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'mb004-kill-ckpt-'));
  const checkpointRoot = path.join(holder, 'checkpoints');
  const recoveryRoot = path.join(holder, 'recovery');
  const lockFile = path.join(repo, 'runtime', 'engineering', 'workspace.lock');
  try {
    const child = spawn(process.execPath, [import.meta.filename, '--child'], {
      cwd: ROOT,
      env: { ...process.env, MB004_REPO: repo, MB004_CKPT: checkpointRoot, MB004_REC: recoveryRoot },
      stdio: 'ignore',
      windowsHide: true,
    });

    // Kill the live episode as soon as its own checkpoint proves it has done real,
    // verified work. This is the controlled interruption: an abandoned run, not a
    // requested stop.
    const store = createCheckpointStore({ dir: checkpointRoot });
    let killedAtCursor = null;
    let killedAtSeq = null;
    let childWasAliveAtKill = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const latest = store.latest();
      if (latest && latest.recovery && latest.recovery.cursor && latest.recovery.cursor.nextStepIndex >= 1) {
        killedAtCursor = latest.recovery.cursor;
        killedAtSeq = latest.recovery.sequence ?? null;
        childWasAliveAtKill = child.exitCode === null;
        child.kill('SIGTERM');
        break;
      }
      if (child.exitCode !== null) break;
      await sleep(50);
    }
    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(true);
      child.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 15_000);
    });
    if (!exited) child.kill('SIGKILL');

    const lockAboardAfterKill = fs.existsSync(lockFile);
    const checkpoint = store.latest();
    const patchAfterKill = fs.readFileSync(path.join(repo, 'src', 'math.cjs'), 'utf8').includes('a + b');

    evidence.phases.killedInterruption = {
      killed: killedAtCursor !== null,
      childWasAliveAtKill,
      killedAtCursor,
      killedAtRecoverySequence: killedAtSeq,
      childExited: exited,
      lockAboardAfterKill,
      patchAppliedBeforeKill: patchAfterKill,
    };
    assert.ok(killedAtCursor, 'the pilot must have killed a live episode that had already checkpointed verified work');
    assert.equal(childWasAliveAtKill, true, 'the kill must land on a running episode, not one that had already finished');

    // --- resume from the abandoned run's own checkpoint -------------------
    // The killed episode left its workspace lock behind. The donor refuses to
    // take a lock by default even when its owner is gone, so a resuming host has
    // to say so explicitly: `contract.stealStaleLock` is that decision, and it is
    // the recovery operator's to make, not the module's.
    let resumedSteps = 0;
    const events = [];
    const resumed = await run({
      workspace: repo,
      goal: 'fix the failing unit test in src/math.cjs',
      contract: { ...contract(true), stealStaleLock: true },
      checkpointRoot,
      recoveryRoot,
      recoveryCheckpoint: checkpoint,
      episodeId: checkpoint.recovery.episodeId,
      deadlineMs: 120_000,
      beforeAction: () => {
        resumedSteps += 1;
      },
      log: (event) => events.push({ type: event.type, from: event.from, to: event.to }),
    });

    const lib = fs.readFileSync(path.join(repo, 'src', 'math.cjs'), 'utf8');
    const after = spawnSync('node', ['--test', 'tests/math.test.cjs'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    const phaseTrail = events.filter((event) => event.type === 'phase').map((event) => `${event.from}->${event.to}`);

    evidence.phases.resume = {
      ...summarize(resumed),
      stepsAttemptedInResumedRun: resumedSteps,
      stepsInFullJob,
      didFewerStepsThanAFullRun: resumedSteps < stepsInFullJob,
      patchAppliedOnDisk: lib.includes('a + b'),
      realTestExitAfterResume: after.status,
      phaseTrail,
      recoveryEvents: events.filter((event) => String(event.type).includes('recovery') || String(event.type).includes('restore')),
    };

    assert.equal(resumed.result, 'COMPLETED', `the resumed episode must finish the job (got ${resumed.result})`);
    assert.ok(lib.includes('a + b'), 'the resumed episode must apply the outstanding patch');
    assert.equal(after.status, 0, 'the real suite must pass after the resumed episode');
    assert.ok(resumedSteps < stepsInFullJob, `continuation must do fewer steps than a full run (${resumedSteps} vs ${stepsInFullJob})`);
  } finally {
    wipe(repo);
    wipe(holder);
  }
}

async function phaseOwnershipRefusal() {
  const repo = createRepo('mb004-ownership-');
  try {
    // The user is mid-edit on the very file the contract wants to patch, and has
    // not committed it. The episode must not overwrite that work.
    const userContent = `${BROKEN_LIB}\n// the user was working on this and had not committed it\n`;
    fs.writeFileSync(path.join(repo, 'src', 'math.cjs'), userContent);

    const report = await run({
      workspace: repo,
      goal: 'fix the failing unit test in src/math.cjs',
      contract: contract(true),
      checkpointRoot: path.join(repo, 'runtime', 'checkpoints'),
      recoveryRoot: path.join(repo, 'runtime', 'recovery'),
      deadlineMs: 120_000,
      log: () => {},
    });

    const after = fs.readFileSync(path.join(repo, 'src', 'math.cjs'), 'utf8');
    evidence.phases.ownershipRefusal = {
      ...summarize(report),
      userWorkPreserved: after === userContent,
    };

    assert.equal(after, userContent, "the user's uncommitted work must survive the episode untouched");
    assert.notEqual(report.result, 'COMPLETED', 'an episode that cannot patch must not claim completion');
  } finally {
    wipe(repo);
  }
}

/* ------------------------------------------------------------------- the entry */

if (process.argv.includes('--child')) {
  await childMode();
} else {
  try {
    await phaseRealJob();
    await phaseGracefulInterruption();
    await phaseKillAndResume();
    await phaseOwnershipRefusal();
  } catch (error) {
    evidence.status = 'FAIL';
    evidence.error = error && error.message ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'foreman-runtime-pilot.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      status: evidence.status,
      error: evidence.error ?? null,
      realJob: evidence.phases.realJob?.result ?? null,
      gracefulInterruption: evidence.phases.gracefulInterruption?.result ?? null,
      killed: evidence.phases.killedInterruption?.killed ?? null,
      resumed: evidence.phases.resume?.result ?? null,
      resumeSteps: evidence.phases.resume?.stepsAttemptedInResumedRun ?? null,
      fullJobSteps: stepsInFullJob,
      ownershipRefusal: evidence.phases.ownershipRefusal?.result ?? null,
    }));
  }
}
