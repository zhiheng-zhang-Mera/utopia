/**
 * UTOPIA · City · Project Foreman — process supervision.
 *
 * A 24-hour maintenance episode is mostly *waiting for processes*: builds, test
 * suites, dev servers, watchers. This module is the difference between waiting and
 * hanging. It adds the four things an engineering loop needs on top of a process
 * registry:
 *
 *   readiness   a background server is ready when it answers, not when a timer
 *               expires: a port, an HTTP response, a stdout pattern or a file.
 *   liveness    a process that is alive and still producing output is *working*,
 *               never a stall, however long it runs.
 *   bounds      every process carries a soft timeout (inspect whether it is still
 *               progressing) and a hard timeout (terminate it).
 *   evidence    the outcome — exit code, signal, duration, the bounded tail of its
 *               output — is recorded whether it succeeded, failed or was killed.
 *
 * Nothing here decides whether a *test* passed; it decides whether a *process*
 * finished, and it never kills anything the runtime did not start.
 *
 * Donor provenance: DS-Hns `app/engineering/process.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b, ported from CommonJS to ESM. Every
 * readiness kind, timeout default, status transition and readiness refusal string
 * is the donor's.
 *
 * Two boundaries are adaptations rather than behaviour, and both are narrow:
 *
 *  * **The process registry.** The donor reuses the Computer Use runtime's
 *    registry (`../computer-use/processes.cjs`) and its error type
 *    (`../computer-use/errors.cjs`). Both belong to the Computer Use domain and are
 *    out of scope for this migration, so they are not ported. The donor's
 *    supervisor already accepts an injected registry (`options.registry`), and the
 *    donor's own test harness (`tests/helpers/engineering-scripted.cjs`) injects
 *    one; the only calls this module makes on a registry are
 *    `register({ child, command, args, cwd, mode, expectedLifetimeMs, ownership, step })`,
 *    `settle(id, { status, exitCode, signal })` and `release(id)`. When no registry
 *    is injected, {@link createOwnedRegistry} satisfies exactly that surface — no
 *    more — so the module is self-contained without inventing any policy. The
 *    status vocabulary, the ownership ceiling and the bounded finished ring are the
 *    donor registry's, because the donor's `settle`/`snapshot` contract is what the
 *    status values are read back through.
 *  * **The error type.** `ComputerUseError` is mirrored locally with the donor's
 *    exact constructor shape and the two codes the donor raises here
 *    (`COMMAND_INVALID`, `WORKSPACE_UNAVAILABLE`); only `error.code` is ever read
 *    by this module or its callers.
 *
 * @module project-foreman/process
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** How a supervised process is used. */
export const PROCESS_CLASS = Object.freeze({
  FOREGROUND: 'foreground',
  BACKGROUND: 'background',
  WATCHER: 'watcher',
  BUILD: 'build',
  TEST: 'test',
  SERVER: 'server',
  HELPER: 'helper',
});

/** The readiness conditions a background process can be started with. */
export const READINESS = Object.freeze({
  PORT: 'port',
  HTTP: 'http',
  STDOUT: 'stdout',
  FILE: 'file',
  EXIT: 'exit',
  NONE: 'none',
});

/** Registry status for one owned process (the donor registry's vocabulary). */
export const PROCESS_STATUS = Object.freeze({
  RUNNING: 'running',
  EXITED: 'exited',
  TIMED_OUT: 'timed_out',
  KILLED: 'killed',
  FAILED: 'failed',
});

/** Process modes the donor registry distinguishes. */
export const PROCESS_MODE = Object.freeze({
  FOREGROUND: 'foreground',
  LONG_RUNNING: 'long_running',
});

/** Terminal statuses: nothing else will happen to this process. */
const TERMINAL_STATUS = Object.freeze([PROCESS_STATUS.EXITED, PROCESS_STATUS.TIMED_OUT, PROCESS_STATUS.KILLED, PROCESS_STATUS.FAILED]);

/** The two Computer Use error codes this module raises. */
export const CODES = Object.freeze({
  COMMAND_INVALID: 'COMMAND_INVALID',
  WORKSPACE_UNAVAILABLE: 'WORKSPACE_UNAVAILABLE',
  PROCESS_INVALID: 'PROCESS_INVALID',
  RESOURCE_LIMIT: 'RESOURCE_LIMIT',
});

/**
 * The donor's `ComputerUseError` shape, mirrored: only `code`, `message` and
 * `details` are ever read.
 */
export class ComputerUseError extends Error {
  /**
   * @param {string} code one of {@link CODES}
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ComputerUseError';
    this.code = code;
    this.details = details;
  }
}

export const DEFAULT_SOFT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_HARD_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_READY_TIMEOUT_MS = 60_000;
export const DEFAULT_OUTPUT_BYTES = 256 * 1024;

/**
 * The checkpoint module owns bounded output, and it is a shared runtime file
 * rather than something this module may copy: a second truncation implementation
 * would be a second answer to "what did the process actually print?".
 *
 * The seam is lazy for the same reason `verifier.mjs` keeps its own lazy: the
 * sibling may not have landed yet, and a missing module must raise a named error
 * rather than a bare `MODULE_NOT_FOUND`.
 *
 * @returns {Function} `truncateOutput(text, { maxBytes })`
 */
function truncateDependency() {
  let checkpoint;
  try {
    checkpoint = require('./checkpoint.mjs');
  } catch (error) {
    throw new Error(`project-foreman/checkpoint.mjs has not landed yet, so bounded output cannot be resolved: ${error && error.message ? error.message : error}`);
  }
  if (typeof checkpoint.truncateOutput !== 'function') {
    throw new Error('project-foreman/checkpoint.mjs does not export truncateOutput(text, { maxBytes })');
  }
  return checkpoint.truncateOutput;
}

/**
 * The minimum registry the donor's own supervisor consumes, used when no Computer
 * Use registry is injected.
 *
 * The surface is exactly `register`, `settle`, `release` (write) and `snapshot`,
 * `ownedCount` (read) — the calls the donor's `process.cjs` makes. `kill`,
 * `dispose`, `isRunning`, `looksHung` and `atCapacity` are present because they are
 * part of the donor registry's own read/write contract and cost nothing to keep
 * honest; nothing in this module invents policy on top of them.
 *
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number} [options.maxOwned] the hard ceiling on simultaneously owned processes
 * @param {number} [options.ringSize] the bounded history of finished processes
 */
export function createOwnedRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ringSize = Number.isInteger(options.ringSize) && options.ringSize > 0 ? options.ringSize : 100;
  const maxOwned = Number.isInteger(options.maxOwned) && options.maxOwned > 0 ? options.maxOwned : 16;
  const owned = new Map();
  const finished = [];
  let sequence = 0;

  function remember(entry) {
    finished.push(entry);
    if (finished.length > ringSize) finished.splice(0, finished.length - ringSize);
    return entry;
  }

  function describe(entry) {
    return {
      id: entry.id,
      pid: entry.child && entry.child.pid ? entry.child.pid : null,
      command: entry.command,
      args: entry.args,
      cwd: entry.cwd,
      mode: entry.mode,
      ownership: entry.ownership,
      expectedLifetimeMs: entry.expectedLifetimeMs,
      startedAt: entry.startedAt,
      status: entry.status,
      exitCode: entry.exitCode === undefined ? null : entry.exitCode,
      signal: entry.signal || null,
      durationMs: entry.finishedAt ? entry.finishedAt - entry.startedAt : now() - entry.startedAt,
      step: entry.step === undefined ? null : entry.step,
    };
  }

  function atCapacity() {
    return owned.size >= maxOwned;
  }

  /**
   * @param {object} input
   * @param {object} input.child the spawned child process
   * @param {string} input.command
   * @param {string[]} [input.args]
   * @param {string} [input.cwd]
   * @param {string} [input.mode] PROCESS_MODE, defaults to foreground
   * @param {number} [input.expectedLifetimeMs]
   * @param {string} [input.ownership]
   * @param {number} [input.step]
   */
  function register({ child, command, args = [], cwd = null, mode = PROCESS_MODE.FOREGROUND, expectedLifetimeMs = null, ownership = 'runtime', step = null } = {}) {
    if (!child) throw new ComputerUseError(CODES.PROCESS_INVALID, 'a process cannot be registered without a child handle');
    if (atCapacity()) {
      throw new ComputerUseError(CODES.RESOURCE_LIMIT, `the runtime already owns ${owned.size} processes (ceiling ${maxOwned}); refusing to start another`, {
        owned: owned.size,
        ceiling: maxOwned,
      });
    }
    sequence += 1;
    const id = `p${sequence}`;
    const entry = {
      id,
      child,
      command: String(command || ''),
      args: Array.isArray(args) ? args.map(String) : [],
      cwd: cwd || null,
      mode: mode === PROCESS_MODE.LONG_RUNNING ? PROCESS_MODE.LONG_RUNNING : PROCESS_MODE.FOREGROUND,
      expectedLifetimeMs: Number.isFinite(expectedLifetimeMs) ? Number(expectedLifetimeMs) : null,
      ownership,
      step,
      startedAt: now(),
      finishedAt: null,
      status: PROCESS_STATUS.RUNNING,
      exitCode: null,
      signal: null,
    };
    owned.set(id, entry);
    return { id, entry };
  }

  /** Mark an owned process as finished; an unowned exit is not ours to record. */
  function settle(id, { status, exitCode = null, signal = null } = {}) {
    const entry = owned.get(id);
    if (!entry) return null;
    owned.delete(id);
    entry.status = TERMINAL_STATUS.includes(status) ? status : PROCESS_STATUS.EXITED;
    entry.exitCode = exitCode;
    entry.signal = signal;
    entry.finishedAt = now();
    return remember(describe(entry));
  }

  function isRunning(id) {
    return owned.has(id);
  }

  function looksHung(id) {
    const entry = owned.get(id);
    if (!entry) return false;
    if (entry.expectedLifetimeMs === null) return false;
    return now() - entry.startedAt > entry.expectedLifetimeMs;
  }

  /** Kill one owned process. Never touches a process that is not in the registry. */
  async function kill(id, reason = 'runtime shutdown') {
    const entry = owned.get(id);
    if (!entry) return { ok: false, reason: 'not_owned', id };
    try {
      entry.child.kill('SIGKILL');
    } catch (error) {
      const noted = settle(id, { status: PROCESS_STATUS.FAILED });
      return { ok: false, reason: 'kill_failed', id, error: String(error && error.message), entry: noted };
    }
    const noted = settle(id, { status: PROCESS_STATUS.KILLED });
    return { ok: true, id, reason, entry: noted };
  }

  async function dispose(reason = 'shutdown') {
    const ids = [...owned.keys()];
    const results = [];
    for (const id of ids) results.push(await kill(id, reason));
    return { disposed: results.filter((entry) => entry.ok).length, attempted: ids.length, results };
  }

  /** Detach a long-running process without killing it, and report it as detached. */
  function release(id) {
    const entry = owned.get(id);
    if (!entry) return null;
    owned.delete(id);
    entry.status = PROCESS_STATUS.RUNNING;
    entry.detachedAt = now();
    return remember({ ...describe(entry), detached: true });
  }

  function snapshot() {
    return {
      owned: [...owned.values()].map(describe),
      ownedCount: owned.size,
      ceiling: maxOwned,
      atCapacity: atCapacity(),
      finished: finished.slice(-20),
      hungSuspected: [...owned.keys()].filter((id) => looksHung(id)),
    };
  }

  return {
    PROCESS_MODE,
    PROCESS_STATUS,
    register,
    settle,
    kill,
    dispose,
    release,
    isRunning,
    looksHung,
    atCapacity,
    snapshot,
    get ownedCount() {
      return owned.size;
    },
    get ceiling() {
      return maxOwned;
    },
    finished() {
      return finished.slice();
    },
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.registry] a shared process registry
 * @param {Function} [options.now]
 * @param {Function} [options.sleep] injectable (virtual clocks in tests)
 * @param {number} [options.maxOwned] forwarded to a registry this module creates
 * @param {number} [options.outputBytes] the retained-output ceiling per process
 * @param {number} [options.historyLimit] how many settled records the history keeps
 */
export function createProcessSupervisor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const registry = options.registry || createOwnedRegistry({ now, maxOwned: options.maxOwned });
  const outputBytes = Number.isInteger(options.outputBytes) ? options.outputBytes : DEFAULT_OUTPUT_BYTES;
  const records = new Map();
  const history = [];
  const historyLimit = Number.isInteger(options.historyLimit) ? options.historyLimit : 200;

  function remember(record) {
    history.push({
      id: record.id,
      command: record.command,
      args: record.args.slice(),
      cwd: record.cwd,
      class: record.class,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      durationMs: record.durationMs,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      timedOut: record.timedOut,
      killed: record.killed,
      readiness: record.readiness ? record.readiness.kind : null,
    });
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
  }

  function record(id) {
    return records.get(id) || null;
  }

  /**
   * Start one process under supervision.
   *
   * @param {object} input
   * @param {string} input.command
   * @param {string[]} [input.args]
   * @param {string} input.cwd must be inside the verified workspace
   * @param {string} [input.class] PROCESS_CLASS
   * @param {number} [input.softTimeoutMs]
   * @param {number} [input.hardTimeoutMs]
   * @param {object} [input.readiness] `{ kind, port, url, pattern, file, timeoutMs }`
   * @param {string} [input.ownership] the episode that owns it
   * @param {boolean} [input.shell]
   * @param {object} [input.env]
   */
  function start(input = {}) {
    const command = String(input.command || '');
    if (!command) throw new ComputerUseError(CODES.COMMAND_INVALID, 'a supervised process needs a command');
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const cwd = input.cwd ? path.resolve(String(input.cwd)) : undefined;
    if (!cwd) throw new ComputerUseError(CODES.WORKSPACE_UNAVAILABLE, 'a supervised process needs an explicit working directory');
    const processClass = Object.values(PROCESS_CLASS).includes(input.class) ? input.class : PROCESS_CLASS.FOREGROUND;
    const softTimeoutMs = Number.isFinite(input.softTimeoutMs) ? Number(input.softTimeoutMs) : DEFAULT_SOFT_TIMEOUT_MS;
    const hardTimeoutMs = Number.isFinite(input.hardTimeoutMs) ? Number(input.hardTimeoutMs) : DEFAULT_HARD_TIMEOUT_MS;
    if (hardTimeoutMs < softTimeoutMs) {
      throw new ComputerUseError(CODES.COMMAND_INVALID, 'the hard timeout cannot be shorter than the soft timeout');
    }

    const child = spawn(command, args, {
      cwd,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      shell: input.shell === true,
      windowsHide: true,
    });
    const registration = registry.register({
      child,
      command,
      args,
      cwd,
      mode: processClass === PROCESS_CLASS.FOREGROUND ? 'foreground' : 'long_running',
      expectedLifetimeMs: processClass === PROCESS_CLASS.FOREGROUND ? hardTimeoutMs : null,
      ownership: input.ownership || 'episode',
      step: input.step === undefined ? null : input.step,
    });

    const entry = {
      id: registration.id,
      child,
      command,
      args,
      cwd,
      class: processClass,
      ownership: input.ownership || 'episode',
      startedAt: now(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      signal: null,
      timedOut: false,
      killed: false,
      softTimeoutMs,
      hardTimeoutMs,
      softTimedOut: false,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      /** The last moment this process produced output: liveness, not patience. */
      lastOutputAt: now(),
      outputEvents: 0,
      readiness: null,
      readinessCondition: input.readiness ? { ...input.readiness } : { kind: READINESS.NONE },
      exitPromise: null,
    };
    records.set(entry.id, entry);

    const collect = (chunk, stream) => {
      const text = chunk.toString('utf8');
      entry.lastOutputAt = now();
      entry.outputEvents += 1;
      if (stream === 'stdout') {
        entry.stdoutBytes += Buffer.byteLength(text);
        entry.stdout = appendBounded(entry.stdout, text, outputBytes);
      } else {
        entry.stderrBytes += Buffer.byteLength(text);
        entry.stderr = appendBounded(entry.stderr, text, outputBytes);
      }
    };
    child.stdout?.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => collect(chunk, 'stderr'));
    if (input.stdin !== undefined && child.stdin) {
      try {
        child.stdin.write(String(input.stdin));
        child.stdin.end();
      } catch {
        /* the child closed stdin early */
      }
    }

    entry.exitPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        if (entry.timer) clearTimeout(entry.timer);
        entry.finishedAt = now();
        entry.durationMs = entry.finishedAt - entry.startedAt;
        entry.exitCode = typeof exitCode === 'number' ? exitCode : null;
        entry.signal = signal || null;
        entry.status = entry.killed ? PROCESS_STATUS.KILLED : (entry.timedOut ? PROCESS_STATUS.TIMED_OUT : PROCESS_STATUS.EXITED);
        registry.settle(entry.id, { status: entry.status, exitCode: entry.exitCode, signal: entry.signal });
        remember(entry);
        resolve(entry);
      };
      child.on('error', (error) => {
        entry.stderr = appendBounded(entry.stderr, String(error && error.message ? error.message : error), outputBytes);
        entry.spawnError = String(error && error.message ? error.message : error);
        entry.status = PROCESS_STATUS.FAILED;
        finish(null, null);
      });
      child.on('close', (code, signal) => finish(code, signal));

      // The hard timeout terminates an owned process. The soft timeout only
      // *reports*: a long build that is still producing output is working.
      entry.timer = setTimeout(() => {
        entry.timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, hardTimeoutMs);
      entry.timer.unref?.();
    });

    return entry;
  }

  /** Keep at most `limit` bytes of a stream, dropping from the front. */
  function appendBounded(existing, chunk, limit) {
    const combined = existing + chunk;
    if (Buffer.byteLength(combined) <= limit) return combined;
    const buffer = Buffer.from(combined);
    return buffer.subarray(buffer.length - limit).toString('utf8');
  }

  /**
   * Wait for a process's readiness condition.
   *
   * The condition is checked, not slept through: a server that answers in 200 ms
   * is ready in 200 ms and a server that never answers is reported as not ready at
   * the bound, never waited on forever.
   *
   * @returns {Promise<{ok:boolean, kind:string, waitedMs:number, attempts:number, reason:string|null}>}
   */
  async function waitForReady(id, override = {}) {
    const entry = record(id);
    if (!entry) return { ok: false, kind: READINESS.NONE, waitedMs: 0, attempts: 0, reason: `no process ${id}` };
    const condition = { ...entry.readinessCondition, ...override };
    const kind = condition.kind || READINESS.NONE;
    const timeoutMs = Number.isFinite(condition.timeoutMs) ? Number(condition.timeoutMs) : DEFAULT_READY_TIMEOUT_MS;
    const pollMs = Number.isFinite(condition.pollMs) ? Number(condition.pollMs) : 120;
    const startedAt = now();
    let attempts = 0;

    if (kind === READINESS.NONE) {
      entry.readiness = { kind, ok: true, waitedMs: 0, at: now(), reason: null };
      return { ok: true, kind, waitedMs: 0, attempts: 0, reason: null };
    }

    for (;;) {
      attempts += 1;
      if (entry.exitCode !== null && kind !== READINESS.EXIT) {
        const outcome = { ok: false, kind, waitedMs: now() - startedAt, attempts, reason: `the process exited (${entry.exitCode}) before it became ready` };
        entry.readiness = { ...outcome, at: now() };
        return outcome;
      }
      let ready = false;
      let reason = null;
      try {
        ready = await checkReady(kind, condition, entry);
      } catch (error) {
        reason = String(error && error.message ? error.message : error);
      }
      if (ready) {
        const outcome = { ok: true, kind, waitedMs: now() - startedAt, attempts, reason: null };
        entry.readiness = { ...outcome, at: now() };
        return outcome;
      }
      if (now() - startedAt >= timeoutMs) {
        const outcome = { ok: false, kind, waitedMs: now() - startedAt, attempts, reason: reason || `the readiness condition (${kind}) was not met within ${timeoutMs}ms` };
        entry.readiness = { ...outcome, at: now() };
        return outcome;
      }
      await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (now() - startedAt))));
    }
  }

  async function checkReady(kind, condition, entry) {
    switch (kind) {
      case READINESS.PORT:
        return portOpen(condition.port, condition.host || '127.0.0.1', Number.isFinite(condition.connectTimeoutMs) ? condition.connectTimeoutMs : 500);
      case READINESS.HTTP:
        return httpOk(condition.url, Number.isFinite(condition.httpTimeoutMs) ? condition.httpTimeoutMs : 1500);
      case READINESS.STDOUT:
        return condition.pattern ? new RegExp(condition.pattern, 'i').test(`${entry.stdout}\n${entry.stderr}`) : false;
      case READINESS.FILE:
        return Boolean(condition.file) && fs.existsSync(path.resolve(String(condition.file)));
      case READINESS.EXIT:
        return entry.exitCode !== null;
      default:
        return true;
    }
  }

  /** Is anything listening on this port? */
  function portOpen(port, host, timeoutMs) {
    return new Promise((resolve) => {
      if (!Number.isInteger(port) || port <= 0) {
        resolve(false);
        return;
      }
      const socket = net.connect({ port, host });
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.on('connect', () => done(true));
      socket.on('timeout', () => done(false));
      socket.on('error', () => done(false));
    });
  }

  /** Does this URL answer? */
  function httpOk(url, timeoutMs) {
    return new Promise((resolve) => {
      if (!url) {
        resolve(false);
        return;
      }
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const request = http.get(url, (response) => {
          response.resume();
          done(response.statusCode >= 200 && response.statusCode < 500);
        });
        request.setTimeout(timeoutMs, () => {
          request.destroy();
          done(false);
        });
        request.on('error', () => done(false));
      } catch {
        done(false);
      }
    });
  }

  /**
   * Wait for a foreground process to finish, bounded by its own timeouts.
   *
   * A process that is alive and has produced output recently is reported as
   * *progressing* rather than stalled, which is what keeps a 45-minute test run
   * from being mistaken for a hang.
   */
  async function waitForExit(id, waitOptions = {}) {
    const entry = record(id);
    if (!entry) return { ok: false, status: 'missing', reason: `no process ${id}` };
    const softTimeoutMs = Number.isFinite(waitOptions.softTimeoutMs) ? Number(waitOptions.softTimeoutMs) : entry.softTimeoutMs;
    const onSoftTimeout = typeof waitOptions.onSoftTimeout === 'function' ? waitOptions.onSoftTimeout : null;
    let softFired = false;
    const startedAt = now();

    for (;;) {
      if (entry.exitCode !== null || entry.status !== 'running') {
        return {
          ok: entry.exitCode === 0 && !entry.timedOut && !entry.killed,
          status: entry.status,
          exitCode: entry.exitCode,
          signal: entry.signal,
          timedOut: entry.timedOut,
          killed: entry.killed,
          durationMs: entry.durationMs === undefined ? now() - entry.startedAt : entry.durationMs,
          waitedMs: now() - startedAt,
          output: outputOf(entry),
        };
      }
      const elapsed = now() - startedAt;
      if (!softFired && elapsed >= softTimeoutMs) {
        softFired = true;
        entry.softTimedOut = true;
        const progressing = progressingNow(entry, waitOptions.stallAfterMs);
        if (!progressing) {
          // A soft timeout on a process that has stopped producing output is the
          // moment to terminate it: waiting longer cannot produce new information.
          kill(id, 'the process stopped making progress within its soft timeout');
          continue;
        }
        if (onSoftTimeout) onSoftTimeout({ id, elapsedMs: elapsed, progressing: true });
      }
      await sleep(Number.isFinite(waitOptions.pollMs) ? Number(waitOptions.pollMs) : 100);
    }
  }

  /** Is this process alive and still producing output? */
  function progressingNow(entry, stallAfterMs) {
    if (!entry || entry.status !== 'running') return false;
    const window = Number.isFinite(stallAfterMs) ? Number(stallAfterMs) : 60_000;
    return now() - entry.lastOutputAt <= window;
  }

  /** The bounded evidence one process leaves behind. */
  function outputOf(entry) {
    const combined = `${entry.stdout}${entry.stderr}`;
    const truncated = truncateDependency()(combined, { maxBytes: outputBytes });
    return {
      text: truncated.text,
      bytes: truncated.bytes,
      originalBytes: truncated.originalBytes,
      truncated: truncated.truncated,
      errorRegion: truncated.errorRegion,
      stdoutBytes: entry.stdoutBytes,
      stderrBytes: entry.stderrBytes,
      outputEvents: entry.outputEvents,
      lastOutputAt: entry.lastOutputAt,
    };
  }

  /** Stop one owned process. Refuses anything the runtime does not own. */
  function kill(id, reason = 'supervisor request') {
    const entry = record(id);
    if (!entry) return { ok: false, reason: 'not_owned', id };
    entry.killed = true;
    entry.killReason = String(reason);
    try {
      entry.child.kill('SIGKILL');
    } catch (error) {
      entry.status = PROCESS_STATUS.FAILED;
      return { ok: false, reason: 'kill_failed', id, error: String(error && error.message ? error.message : error) };
    }
    return { ok: true, id, reason };
  }

  /** Stop every process this supervisor owns. */
  function dispose(reason = 'episode teardown') {
    const ids = [...records.keys()].filter((id) => record(id) && record(id).status === 'running');
    const results = ids.map((id) => kill(id, reason));
    return { attempted: ids.length, stopped: results.filter((entry) => entry.ok).length, results };
  }

  /** Release a background process the contract asked to keep alive. */
  function release(id, reason = 'kept alive by contract') {
    const entry = record(id);
    if (!entry) return null;
    entry.released = true;
    entry.releaseReason = String(reason);
    return registry.release(id);
  }

  return {
    PROCESS_CLASS,
    READINESS,
    registry,
    start,
    waitForReady,
    waitForExit,
    progressingNow,
    kill,
    dispose,
    release,
    record,
    /** Every process this supervisor currently owns (bounded). */
    running() {
      return [...records.values()].filter((entry) => entry.status === 'running').map((entry) => ({
        id: entry.id,
        command: entry.command,
        args: entry.args.slice(),
        cwd: entry.cwd,
        class: entry.class,
        startedAt: entry.startedAt,
        lastOutputAt: entry.lastOutputAt,
        outputEvents: entry.outputEvents,
        progressing: progressingNow(entry),
      }));
    },
    /** The settled history, bounded. */
    finished() {
      return history.slice();
    },
    ownedCount() {
      return [...records.values()].filter((entry) => entry.status === 'running').length;
    },
    /** The heartbeat line the plan asks for during a long wait. */
    heartbeat() {
      const running = [...records.values()].filter((entry) => entry.status === 'running');
      return {
        at: now(),
        processes: running.length,
        currentCommand: running.length ? running[running.length - 1].command : null,
        lastOutputAgoMs: running.length ? now() - running[running.length - 1].lastOutputAt : null,
        progressing: running.every((entry) => progressingNow(entry)),
      };
    },
  };
}
