/**
 * UTOPIA · Worker Gateway — worker-runner execution seam.
 *
 * Port of the DS-Hns donor `app/extensions/mega/scheduler/dsh-runner.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 *
 * The donor was the real spawn seam of the Mega queue: one dsh headless job run
 * as an external Node child with a per-task working directory, the child's
 * stdout/stderr teed into one append log, a child environment pinned to the
 * engine's own home, and a `taskkill` process-tree kill. It reached outside
 * itself only twice, through `require('../utils/paths')` (`PATHS`, `ROOT`) and
 * `require('../utils/workspace')` (`getWorkspaceRoot()`), which hard-coded the
 * desktop app's absolute `D:\`-style layout. Those two imports are the only
 * thing whose shape changed: a City module must not own a drive letter, so the
 * host supplies the locations and the two side-effect seams.
 *
 * Donor export        -> here
 *   `DSH_BIN`         -> `runner.dshBin`, `path.join(appRoot, <DSH_BIN_SEGMENTS>)`
 *   `nodeExecutable`  -> `runner.nodeExecutable()`
 *   `childEnv`        -> `runner.childEnv(overrides)`
 *   `startJob`        -> `runner.startJob(task)`
 *   `killTree`        -> `runner.killTree(pid)`
 *
 * The host seam, and where each donor dependency went:
 *   PATHS.APP            -> appRoot
 *   PATHS.DSH_HOME       -> dshHome
 *   PATHS.TEMP           -> tempDir          (donor: TEMP and TMP)
 *   PATHS.CACHE          -> cacheDir         (donor: <cacheDir>\npm)
 *   ROOT\logs\harness    -> logsDir          (donor: the default log directory)
 *   getWorkspaceRoot()   -> workspaceRoot
 *   require('node:child_process').spawn -> spawn (defaults to the real one)
 *   require('node:fs')                  -> fs    (defaults to the real one)
 *   require('node:path')                -> path  (defaults to the real one)
 *   process.env                         -> env   (defaults to process.env)
 *   process.env.DSH_NODE                -> node  (an explicit binary wins; with
 *                                                  no `node` supplied the donor
 *                                                  rule `env.DSH_NODE || 'node'`
 *                                                  is reproduced exactly)
 *
 * Nothing else was added. There is no queue, no scheduler, no planner, no retry
 * policy, no timeout, no backoff and no logging framework here: the donor had
 * none of those, and `scheduler.js`, `gate.js` and `system.js` are deferred (see
 * DONOR.json). `startJob` still returns as soon as the child is spawned; the
 * caller owns the child lifecycle, exactly as the donor's queue did.
 *
 * `childEnv` sets exactly these seven keys on a fresh copy of the ambient
 * environment, in this order, then spreads `overrides` last:
 * DSH_HOME, DSH_TELEMETRY_MODE, DSH_PERMISSION_MODE, TEMP, TMP,
 * npm_config_cache, DEEPSEEK_HARNESS_WORKSPACE.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TELEMETRY_MODE,
  DSH_BIN_SEGMENTS,
  HEADLESS_ARGS,
  LOG_STREAM_FLAGS,
  NODE_ENV_VAR,
  RUNNER_STDIO,
  TASKKILL_EXE,
  TASKKILL_FORCE_FLAG,
  TASKKILL_PID_FLAG,
  TASKKILL_TREE_FLAG,
} from './contracts.mjs';

/**
 * Build one runner over an injected host seam.
 *
 * @param {{
 *   appRoot: string,
 *   dshHome: string,
 *   tempDir: string,
 *   cacheDir: string,
 *   logsDir: string,
 *   workspaceRoot: string,
 *   node?: string,
 *   spawn?: Function,
 *   fs?: object,
 *   path?: object,
 *   env?: Record<string, string|undefined>,
 * }} seams
 * @returns {{
 *   startJob: Function, killTree: Function, childEnv: Function,
 *   dshBin: string, nodeExecutable: Function,
 * }}
 */
export function createRunner(seams) {
  const {
    appRoot,
    dshHome,
    tempDir,
    cacheDir,
    logsDir,
    workspaceRoot,
    node,
    spawn = nodeSpawn,
    fs = nodeFs,
    path = nodePath,
    env = process.env,
  } = seams;

  // Donor: path.join(PATHS.APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  // computed once at module load. One dsh install for the whole host, resolved
  // against the injected app root instead of the desktop app's hard-coded one.
  const dshBin = path.join(appRoot, ...DSH_BIN_SEGMENTS);

  /**
   * Donor: `process.env.DSH_NODE || 'node'`. With no `node` seam supplied this
   * is that expression unchanged, against the injected environment.
   */
  function nodeExecutable() {
    return node || env[NODE_ENV_VAR] || 'node';
  }

  /**
   * Donor: a fresh object spreading the ambient environment, then the seven
   * pinned keys, then `overrides` last. Never mutates the ambient environment.
   */
  function childEnv(overrides = {}) {
    return {
      ...env,
      // Same engine home as the dsh Web UI, so every session — foreground or
      // queue — lands in one store the monitor watches for bells.
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: env.DSH_TELEMETRY_MODE || DEFAULT_TELEMETRY_MODE,
      DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE || DEFAULT_PERMISSION_MODE,
      TEMP: tempDir,
      TMP: tempDir,
      npm_config_cache: path.join(cacheDir, 'npm'),
      DEEPSEEK_HARNESS_WORKSPACE: workspaceRoot,
      ...overrides,
    };
  }

  /**
   * Donor: create the task directory, open the append log, spawn
   * `<node> <dshBin> --profile headless <prompt>` in the task directory, tee
   * both pipes into the log, and hand the caller the child and the log path.
   */
  function startJob({ id, prompt, taskDir, permissionMode, logFile }) {
    fs.mkdirSync(taskDir, { recursive: true });
    const log = logFile || path.join(logsDir, `${id}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const stream = fs.createWriteStream(log, { flags: LOG_STREAM_FLAGS });
    const args = [dshBin, ...HEADLESS_ARGS, prompt];
    const child = spawn(nodeExecutable(), args, {
      cwd: taskDir,
      env: childEnv(permissionMode ? { DSH_PERMISSION_MODE: permissionMode } : {}),
      stdio: [...RUNNER_STDIO],
      windowsHide: true,
    });
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    child.logStream = stream;
    return { child, pid: child.pid, logFile: log };
  }

  /**
   * Donor: kill the whole process tree of `pid`. The empty catch is the donor's,
   * and it covers a synchronous throw only — an asynchronous 'error' event on
   * the taskkill child is not observed, exactly as in the donor.
   */
  function killTree(pid) {
    if (!pid) return;
    try {
      spawn(
        TASKKILL_EXE,
        [TASKKILL_PID_FLAG, String(pid), TASKKILL_TREE_FLAG, TASKKILL_FORCE_FLAG],
        {
          windowsHide: true,
          stdio: 'ignore',
        },
      );
    } catch {
      /* process may already be gone */
    }
  }

  return { startJob, killTree, childEnv, dshBin, nodeExecutable };
}
