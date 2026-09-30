/**
 * UTOPIA · Worker Gateway — worker-runner contracts.
 *
 * The closed vocabularies the runner itself uses, and nothing else. Every entry
 * below is a literal taken from the DS-Hns donor
 * `app/extensions/mega/scheduler/dsh-runner.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b), where
 * the same strings sat inline inside `startJob`, `childEnv`, `killTree` and the
 * module-level `DSH_BIN` const. Naming them changes no value: a caller can read
 * what the seam will run without reading `runner.mjs`.
 *
 * Donor line -> vocabulary
 *   `path.join(PATHS.APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')`
 *                                  -> DSH_BIN_SEGMENTS
 *   `[DSH_BIN, '--profile', 'headless', prompt]`
 *                                  -> PROFILE_FLAG, HEADLESS_PROFILE, HEADLESS_ARGS
 *   `'DISABLED'`                   -> DEFAULT_TELEMETRY_MODE
 *   `'workspace-write'`            -> DEFAULT_PERMISSION_MODE
 *   `stdio: ['ignore','pipe','pipe']`
 *                                  -> RUNNER_STDIO
 *   `fs.createWriteStream(log, { flags: 'a' })`
 *                                  -> LOG_STREAM_FLAGS
 *   `spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], …)`
 *                                  -> TASKKILL_EXE, TASKKILL_PID_FLAG,
 *                                     TASKKILL_TREE_FLAG, TASKKILL_FORCE_FLAG
 *   `process.env.DSH_NODE`         -> NODE_ENV_VAR
 *
 * There is deliberately NO queue, scheduling, retry, backoff, timeout or
 * logging vocabulary in this file. The donor `dsh-runner.js` has none, and the
 * donor files that do carry such policy (`scheduler.js`, `gate.js`, `system.js`)
 * are deferred in DONOR.json. The names of the seven environment variables
 * `childEnv` sets are deliberately NOT listed here either: they are the
 * behaviour of `childEnv`, so they are stated in `runner.mjs` and restated
 * independently by the tests rather than read back out of a constant.
 */

/** The flag the donor passes before the profile name. */
export const PROFILE_FLAG = '--profile';

/** The one profile the donor ever runs. */
export const HEADLESS_PROFILE = 'headless';

/**
 * The donor's fixed argv between the dsh bin and the prompt, in the donor's
 * order: `[DSH_BIN, '--profile', 'headless', prompt]`.
 */
export const HEADLESS_ARGS = Object.freeze([PROFILE_FLAG, HEADLESS_PROFILE]);

/** Default `DSH_TELEMETRY_MODE` when the ambient environment does not set one. */
export const DEFAULT_TELEMETRY_MODE = 'DISABLED';

/** Default `DSH_PERMISSION_MODE` when neither the caller nor the environment sets one. */
export const DEFAULT_PERMISSION_MODE = 'workspace-write';

/** The donor's child stdio triple: no stdin, piped stdout and stderr. */
export const RUNNER_STDIO = Object.freeze(['ignore', 'pipe', 'pipe']);

/** The donor's log-stream open mode: append, never truncate. */
export const LOG_STREAM_FLAGS = 'a';

/**
 * The path segments of the single dsh install, relative to the app root:
 * `<appRoot>\node_modules\@deepseek-ai\dsh\lib\bin.js`.
 */
export const DSH_BIN_SEGMENTS = Object.freeze([
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
]);

/** The environment variable the donor reads for an alternate Node binary. */
export const NODE_ENV_VAR = 'DSH_NODE';

/** The Windows process-tree killer the donor shells out to. */
export const TASKKILL_EXE = 'taskkill.exe';

/** `pid` selector of the donor's taskkill argv. */
export const TASKKILL_PID_FLAG = '/PID';

/** Kill the whole tree, not just the direct child. */
export const TASKKILL_TREE_FLAG = '/T';

/** Force the kill. */
export const TASKKILL_FORCE_FLAG = '/F';

/**
 * Every closed vocabulary this module publishes, for a caller that wants to
 * enumerate them without importing each name.
 */
export const CLOSED_VOCABULARIES = Object.freeze({
  profileFlag: PROFILE_FLAG,
  headlessProfile: HEADLESS_PROFILE,
  headlessArgs: HEADLESS_ARGS,
  defaultTelemetryMode: DEFAULT_TELEMETRY_MODE,
  defaultPermissionMode: DEFAULT_PERMISSION_MODE,
  runnerStdio: RUNNER_STDIO,
  logStreamFlags: LOG_STREAM_FLAGS,
  dshBinSegments: DSH_BIN_SEGMENTS,
  nodeEnvVar: NODE_ENV_VAR,
  taskkillExe: TASKKILL_EXE,
});
