/**
 * UTOPIA · City — Worker Gateway / Worker Runner: execution-seam suite.
 *
 * Every assertion here restates behaviour of the DS-Hns donor
 * `app/extensions/mega/scheduler/dsh-runner.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 *
 * No real dsh install is needed and no real process is ever spawned: the host
 * seam is injected with a recording fake `spawn`, a recording fake `fs` and a
 * plain ambient environment object. The ambient object is also how "does not
 * mutate the environment" is proved — it is snapshotted and compared.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { createRunner } from '../runner.mjs';
import * as publicSurface from '../index.mjs';

/* ------------------------------------------------------------------ *
 * The injected host seam
 * ------------------------------------------------------------------ */

const APP_ROOT = path.join('D:\\', 'DS-Hns', 'app');
const DSH_HOME = path.join('D:\\', 'DS-Hns', 'data');
const TEMP_DIR = path.join('D:\\', 'DS-Hns', 'runtime', 'cache', 'temp');
const CACHE_DIR = path.join('D:\\', 'DS-Hns', 'runtime', 'cache');
const LOGS_DIR = path.join('D:\\', 'DS-Hns', 'runtime', 'logs', 'harness');
const WORKSPACE_ROOT = path.join('D:\\', 'DS-Hns', 'runtime', 'workspace');

/** A recording fake `fs`: no directory is created and no file is opened. */
function makeFs() {
  const mkdirs = [];
  const opened = [];
  const streams = [];
  return {
    mkdirs,
    opened,
    streams,
    mkdirSync(dir, options) {
      mkdirs.push({ dir, options });
    },
    createWriteStream(file, options) {
      const stream = {
        file,
        options,
        ended: false,
        end() {
          this.ended = true;
        },
      };
      opened.push({ file, options });
      streams.push(stream);
      return stream;
    },
  };
}

/** A recording fake `spawn` that returns a fake child with piping stdout/stderr. */
function makeSpawn(options = {}) {
  const calls = [];
  const child = {
    pid: options.pid === undefined ? 4242 : options.pid,
    piped: [],
    stdout: {
      pipe(target) {
        child.piped.push(['stdout', target]);
        return target;
      },
    },
    stderr: {
      pipe(target) {
        child.piped.push(['stderr', target]);
        return target;
      },
    },
  };
  let attempts = 0;
  function spawn(command, args, spawnOptions) {
    attempts += 1;
    calls.push({ command, args, options: spawnOptions });
    if (options.throwOnCall) throw new Error('spawn refused');
    return child;
  }
  return { spawn, calls, child, attempts: () => attempts };
}

/**
 * One runner over a fresh seam. `env` is a plain object standing in for
 * `process.env`, so a test can prove the ambient environment is untouched.
 */
function makeRunner({ ambient = {}, fs = makeFs(), spawnApi = makeSpawn(), node } = {}) {
  const runner = createRunner({
    appRoot: APP_ROOT,
    dshHome: DSH_HOME,
    tempDir: TEMP_DIR,
    cacheDir: CACHE_DIR,
    logsDir: LOGS_DIR,
    workspaceRoot: WORKSPACE_ROOT,
    ...(node === undefined ? {} : { node }),
    spawn: spawnApi.spawn,
    fs,
    env: ambient,
  });
  return { runner, fs, spawnApi, ambient };
}

/** The donor's own literal argv prefix, restated independently of contracts.mjs. */
const DONOR_HEADLESS_ARGS = ['--profile', 'headless'];

/* ------------------------------------------------------------------ *
 * dshBin — the injected app root, donor path shape
 * ------------------------------------------------------------------ */

test('dshBin keeps the donor path shape and follows the injected app root', () => {
  const { runner } = makeRunner();
  assert.equal(
    runner.dshBin,
    path.join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  );

  const other = createRunner({
    appRoot: path.join('E:\\', 'elsewhere'),
    dshHome: DSH_HOME,
    tempDir: TEMP_DIR,
    cacheDir: CACHE_DIR,
    logsDir: LOGS_DIR,
    workspaceRoot: WORKSPACE_ROOT,
  });
  assert.notEqual(other.dshBin, runner.dshBin);
  assert.equal(
    other.dshBin,
    path.join('E:\\', 'elsewhere', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  );
});

/* ------------------------------------------------------------------ *
 * nodeExecutable — the donor's single environment read
 * ------------------------------------------------------------------ */

test('nodeExecutable is the donor rule env.DSH_NODE || node', () => {
  assert.equal(makeRunner({ ambient: {} }).runner.nodeExecutable(), 'node');
  assert.equal(
    makeRunner({ ambient: { DSH_NODE: 'node-custom' } }).runner.nodeExecutable(),
    'node-custom',
  );
  // An explicit seam binary wins; without one the donor rule is exact.
  assert.equal(
    makeRunner({ ambient: { DSH_NODE: 'node-custom' }, node: 'E:\\node\\node.exe' })
      .runner.nodeExecutable(),
    'E:\\node\\node.exe',
  );
});

/* ------------------------------------------------------------------ *
 * childEnv
 * ------------------------------------------------------------------ */

test('childEnv sets exactly the donor keys, with the donor defaults and order', () => {
  const ambient = { PATH: 'C:\\Windows\\System32', KEEP: 'yes' };
  const { runner } = makeRunner({ ambient });

  const child = runner.childEnv();

  assert.deepEqual(Object.keys(child), [
    'PATH',
    'KEEP',
    'DSH_HOME',
    'DSH_TELEMETRY_MODE',
    'DSH_PERMISSION_MODE',
    'TEMP',
    'TMP',
    'npm_config_cache',
    'DEEPSEEK_HARNESS_WORKSPACE',
  ]);
  assert.deepEqual(child, {
    PATH: 'C:\\Windows\\System32',
    KEEP: 'yes',
    DSH_HOME,
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_PERMISSION_MODE: 'workspace-write',
    TEMP: TEMP_DIR,
    TMP: TEMP_DIR,
    npm_config_cache: path.join(CACHE_DIR, 'npm'),
    DEEPSEEK_HARNESS_WORKSPACE: WORKSPACE_ROOT,
  });
});

test('childEnv never mutates the ambient environment and returns a fresh object', () => {
  const ambient = { PATH: 'C:\\Windows\\System32', KEEP: 'yes' };
  const before = { ...ambient };
  const { runner } = makeRunner({ ambient });

  const first = runner.childEnv();
  const second = runner.childEnv();

  assert.deepEqual(ambient, before);
  assert.notEqual(first, second);
  assert.deepEqual(first, second);

  first.PATH = 'mutated';
  first.DSH_HOME = 'mutated';
  assert.deepEqual(ambient, before);
  assert.equal(second.PATH, 'C:\\Windows\\System32');
  assert.equal(second.DSH_HOME, DSH_HOME);
});

test('childEnv lets the ambient mode variables win over the defaults, and spreads overrides last', () => {
  const { runner } = makeRunner({
    ambient: { DSH_TELEMETRY_MODE: 'ON', DSH_PERMISSION_MODE: 'read-only' },
  });

  assert.equal(runner.childEnv().DSH_TELEMETRY_MODE, 'ON');
  assert.equal(runner.childEnv().DSH_PERMISSION_MODE, 'read-only');

  const overridden = runner.childEnv({
    DSH_HOME: 'C:\\other-home',
    TEMP: 'C:\\other-temp',
    DSH_PERMISSION_MODE: undefined,
    ADDED_BY_CALLER: '1',
  });
  assert.equal(overridden.DSH_HOME, 'C:\\other-home');
  assert.equal(overridden.TEMP, 'C:\\other-temp');
  assert.equal(overridden.TMP, TEMP_DIR);
  assert.equal(overridden.ADDED_BY_CALLER, '1');
  // The donor spread `overrides` last, so an explicit undefined lands as-is.
  assert.equal(overridden.DSH_PERMISSION_MODE, undefined);
});

/* ------------------------------------------------------------------ *
 * startJob
 * ------------------------------------------------------------------ */

test('startJob builds the donor argv, cwd, stdio and pipes, and returns {child, pid, logFile}', () => {
  const ambient = { PATH: 'C:\\Windows\\System32' };
  const { runner, fs, spawnApi } = makeRunner({ ambient });
  const taskDir = path.join(WORKSPACE_ROOT, 'active', 'task-7');
  const prompt = 'summarise the ledger';

  const result = runner.startJob({ id: 'task-7', prompt, taskDir });

  // The donor created the task directory, then the log directory, in that order.
  assert.deepEqual(fs.mkdirs, [
    { dir: taskDir, options: { recursive: true } },
    { dir: LOGS_DIR, options: { recursive: true } },
  ]);

  const logFile = path.join(LOGS_DIR, 'task-7.log');
  assert.deepEqual(fs.opened, [{ file: logFile, options: { flags: 'a' } }]);
  const stream = fs.streams[0];

  assert.equal(spawnApi.calls.length, 1);
  const call = spawnApi.calls[0];
  assert.equal(call.command, 'node');
  assert.deepEqual(call.args, [runner.dshBin, ...DONOR_HEADLESS_ARGS, prompt]);
  assert.equal(call.args.length, 4);
  assert.equal(call.options.cwd, taskDir);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(Object.keys(call.options), ['cwd', 'env', 'stdio', 'windowsHide']);
  assert.deepEqual(call.options.env, {
    PATH: 'C:\\Windows\\System32',
    DSH_HOME,
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_PERMISSION_MODE: 'workspace-write',
    TEMP: TEMP_DIR,
    TMP: TEMP_DIR,
    npm_config_cache: path.join(CACHE_DIR, 'npm'),
    DEEPSEEK_HARNESS_WORKSPACE: WORKSPACE_ROOT,
  });

  // stdout first, then stderr, both into the one append stream.
  assert.deepEqual(spawnApi.child.piped, [
    ['stdout', stream],
    ['stderr', stream],
  ]);
  assert.equal(spawnApi.child.logStream, stream);

  assert.deepEqual(Object.keys(result), ['child', 'pid', 'logFile']);
  assert.equal(result.child, spawnApi.child);
  assert.equal(result.pid, 4242);
  assert.equal(result.logFile, logFile);
});

test('startJob honours an explicit logFile', () => {
  const { runner, fs } = makeRunner();
  const taskDir = path.join(WORKSPACE_ROOT, 'active', 'task-9');
  const logFile = path.join('E:\\', 'chosen-logs', 'custom.log');

  const result = runner.startJob({ id: 'task-9', prompt: 'p', taskDir, logFile });

  assert.equal(result.logFile, logFile);
  assert.deepEqual(fs.mkdirs, [
    { dir: taskDir, options: { recursive: true } },
    { dir: path.dirname(logFile), options: { recursive: true } },
  ]);
  assert.deepEqual(fs.opened, [{ file: logFile, options: { flags: 'a' } }]);
});

test('startJob passes permissionMode through as DSH_PERMISSION_MODE, and omits it otherwise', () => {
  const { runner, spawnApi } = makeRunner();

  runner.startJob({
    id: 'a',
    prompt: 'p',
    taskDir: path.join(WORKSPACE_ROOT, 'active', 'a'),
    permissionMode: 'danger-full-access',
  });
  assert.equal(spawnApi.calls[0].options.env.DSH_PERMISSION_MODE, 'danger-full-access');

  runner.startJob({
    id: 'b',
    prompt: 'p',
    taskDir: path.join(WORKSPACE_ROOT, 'active', 'b'),
  });
  assert.equal(spawnApi.calls[1].options.env.DSH_PERMISSION_MODE, 'workspace-write');

  // The donor's `permissionMode ?` test means a falsy mode is "not supplied".
  runner.startJob({
    id: 'c',
    prompt: 'p',
    taskDir: path.join(WORKSPACE_ROOT, 'active', 'c'),
    permissionMode: '',
  });
  assert.equal(spawnApi.calls[2].options.env.DSH_PERMISSION_MODE, 'workspace-write');

  // The ambient environment still wins over the default when no mode is given.
  const ambientRunner = makeRunner({ ambient: { DSH_PERMISSION_MODE: 'read-only' } });
  ambientRunner.runner.startJob({
    id: 'd',
    prompt: 'p',
    taskDir: path.join(WORKSPACE_ROOT, 'active', 'd'),
  });
  assert.equal(ambientRunner.spawnApi.calls[0].options.env.DSH_PERMISSION_MODE, 'read-only');
});

test('startJob pipes into the log stream it opened, so the child records to that file', () => {
  const { runner, fs, spawnApi } = makeRunner();
  const taskDir = path.join(WORKSPACE_ROOT, 'active', 'task-11');

  runner.startJob({ id: 'task-11', prompt: 'p', taskDir });

  const stream = fs.streams[0];
  assert.equal(stream.file, path.join(LOGS_DIR, 'task-11.log'));
  assert.equal(stream.options.flags, 'a');
  assert.equal(spawnApi.child.piped[0][1], stream);
  assert.equal(spawnApi.child.piped[1][1], stream);
});

/* ------------------------------------------------------------------ *
 * killTree
 * ------------------------------------------------------------------ */

test('killTree spawns taskkill.exe with the donor argv for a numeric pid', () => {
  const { runner, spawnApi } = makeRunner();

  runner.killTree(4242);

  assert.equal(spawnApi.calls.length, 1);
  assert.equal(spawnApi.calls[0].command, 'taskkill.exe');
  assert.deepEqual(spawnApi.calls[0].args, ['/PID', '4242', '/T', '/F']);
  assert.deepEqual(spawnApi.calls[0].options, { windowsHide: true, stdio: 'ignore' });
});

test('killTree stringifies a non-numeric pid and spawns nothing for a falsy one', () => {
  const { runner, spawnApi } = makeRunner();

  runner.killTree('4242');
  assert.deepEqual(spawnApi.calls[0].args, ['/PID', '4242', '/T', '/F']);

  runner.killTree(0);
  runner.killTree(undefined);
  runner.killTree(null);
  runner.killTree('');
  assert.equal(spawnApi.calls.length, 1);
});

test('killTree swallows a synchronous spawn throw, as the donor empty catch did', () => {
  const { runner, spawnApi } = makeRunner({ spawnApi: makeSpawn({ throwOnCall: true }) });

  assert.doesNotThrow(() => runner.killTree(4242));

  // It really did attempt the kill; the error is what was swallowed.
  assert.equal(spawnApi.attempts(), 1);
});

/* ------------------------------------------------------------------ *
 * The export site and the frozen vocabularies
 * ------------------------------------------------------------------ */

test('index.mjs re-exports the runner factory and the closed vocabularies', () => {
  assert.equal(typeof publicSurface.createRunner, 'function');
  assert.equal(publicSurface.DEFAULT_TELEMETRY_MODE, 'DISABLED');
  assert.equal(publicSurface.DEFAULT_PERMISSION_MODE, 'workspace-write');
  assert.deepEqual([...publicSurface.HEADLESS_ARGS], ['--profile', 'headless']);
  assert.deepEqual([...publicSurface.RUNNER_STDIO], ['ignore', 'pipe', 'pipe']);
  assert.equal(publicSurface.LOG_STREAM_FLAGS, 'a');
  assert.equal(publicSurface.TASKKILL_EXE, 'taskkill.exe');
  assert.equal(publicSurface.NODE_ENV_VAR, 'DSH_NODE');
  assert.deepEqual([...publicSurface.DSH_BIN_SEGMENTS], [
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  ]);
});

test('the module is self-contained: built-ins only, no donor checkout dependency', async () => {
  const moduleDir = path.join(import.meta.dirname, '..');
  for (const file of ['contracts.mjs', 'runner.mjs', 'index.mjs']) {
    const source = await readFile(path.join(moduleDir, file), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ['require(', 'module.exports', 'DS-Hns', 'Codex-Boss']) {
      assert.ok(!code.includes(forbidden), `${file} must not depend on the donor checkout (${forbidden})`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
});

test('provenance stays honest: DONOR.json pins the donor and records the deferrals', async () => {
  const donor = JSON.parse(
    await readFile(path.join(import.meta.dirname, '..', 'DONOR.json'), 'utf8'),
  );

  assert.equal(donor.module, 'worker-runner');
  assert.equal(donor.cityPath, 'city/02-engineering/02-worker-gateway/worker-runner');
  assert.equal(donor.district, '02-engineering');
  assert.equal(donor.building, '02-worker-gateway');
  assert.deepEqual(donor.incubationRooms, ['mb-003-worker-runner-lab']);
  assert.equal(donor.mission.missionId, 'MB-003');
  assert.equal(donor.mission.role, 'MIGRATION');
  assert.equal(donor.mission.book, 'Digital-City/mission-book/MB-003-worker-gateway.md');
  assert.equal(donor.repository, 'zhiheng-zhang-Mera/DS-Hns');
  assert.equal(donor.commit, 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b');
  assert.deepEqual(donor.sourcePaths, ['app/extensions/mega/scheduler/dsh-runner.js']);
  assert.deepEqual(Object.values(donor.portedFiles).flat(), ['contracts.mjs', 'runner.mjs']);

  // The deferred donor files are named with their real reason, not silently dropped.
  const deferred = donor.classification.DEFERRED.join('\n');
  for (const file of ['scheduler.js', 'gate.js', 'system.js', 'lifecycle.js']) {
    assert.match(deferred, new RegExp(file.replace('.', '\\.')));
  }
  // The one structural adaptation is stated, not hidden.
  assert.match(donor.adaptation.join('\n'), /Injected host seam/);
  assert.match(donor.knownDifferences.join('\n'), /seam/);

  assert.ok(donor.adaptation.length >= 3);
  assert.ok(donor.knownDifferences.length >= 3);
  assert.ok(donor.parity.vectors.length >= 8);
  assert.equal(donor.parity.vectorSource.includes('dsh-runner.js'), true);
});
