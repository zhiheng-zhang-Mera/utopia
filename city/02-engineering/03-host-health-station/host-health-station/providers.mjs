/**
 * UTOPIA · City · Host Health Station — the provider layer.
 *
 * Ported from the donor `dsh-health-scheduler` src/providers/** @ 985e2b7;
 * see DONOR.json for the porting ledger. Behaviour is unchanged.
 *
 * Shared provider plumbing: stats-file ingestion and external command probes.
 *
 * The design forbids the scheduler from reaching into NVML, LibreHardwareMonitor,
 * HWiNFO, Windows APIs, worker internals or Electron internals. Those live
 * *outside* the process, so this module is the one sanctioned way to hear from
 * them: an integration writes canonical metrics to a JSON file, or an external
 * tool prints `name=value` lines, and a provider reports what it finds.
 *
 * @module host-health-station/providers
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodeProcess from 'node:process';
import { isCanonicalMetric } from './types.mjs';
/**
 * Reads the first readable stats file from a list.
 *
 * The file format is deliberately dull:
 *
 * ```json
 * { "timestamp": "2026-01-01T00:00:00.000Z", "metrics": { "render_latency_ms": 120 } }
 * ```
 *
 * A bare `{ "render_latency_ms": 120 }` object is accepted too, because writing
 * the wrapper is easy to forget. Non-canonical keys are reported rather than
 * folded in, so a typo shows up as an unknown key instead of silently doing
 * nothing.
 */
export class StatsFileSource {
  paths;
  staleAfterMs;
  cache = emptySnapshot();
  cachedAt = 0;
  cacheMs;
  constructor(paths, staleAfterMs, cacheMs = 2_000) {
    this.paths = paths;
    this.staleAfterMs = staleAfterMs;
    this.cacheMs = cacheMs;
  }
  /** Whether any path is configured. */
  get configured() {
    return this.paths.length > 0;
  }
  /**
   * Read the newest readable file, at most once per cache window.
   *
   * @param nowMs - evaluation instant.
   */
  read(nowMs) {
    if (!this.configured)
      return emptySnapshot();
    if (nowMs - this.cachedAt < this.cacheMs)
      return this.cache;
    this.cachedAt = nowMs;
    this.cache = this.readUncached(nowMs);
    return this.cache;
  }
  readUncached(nowMs) {
    let sawExisting = false;
    let lastReason = null;
    let lastDetail = null;
    for (const path of this.paths) {
      if (!existsSync(path))
        continue;
      sawExisting = true;
      try {
        const stat = statSync(path);
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw);
        const { metrics, unknownKeys } = extractMetrics(parsed);
        const stale = nowMs - stat.mtimeMs > this.staleAfterMs;
        return {
          metrics,
          unknownKeys,
          mtimeMs: stat.mtimeMs,
          readable: true,
          stale,
          reason: stale ? 'telemetry_unavailable' : null,
          detail: stale
            ? `stats file ${path} last written ${Math.round((nowMs - stat.mtimeMs) / 1000)}s ago`
            : null,
        };
      }
      catch (error) {
        lastReason = 'telemetry_unavailable';
        lastDetail = `${path}: ${error.message}`;
      }
    }
    if (!sawExisting) {
      return {
        ...emptySnapshot(),
        reason: 'telemetry_unavailable',
        detail: `no stats file exists yet (looked for ${this.paths.join(', ')})`,
      };
    }
    return { ...emptySnapshot(), reason: lastReason, detail: lastDetail };
  }
}
function emptySnapshot() {
  return {
    metrics: {},
    unknownKeys: [],
    mtimeMs: null,
    readable: false,
    stale: false,
    reason: null,
    detail: null,
  };
}
/**
 * Pull canonical metrics out of a parsed stats document.
 * @param {*} parsed - a parsed stats document, wrapped or bare.
 * @returns {{metrics: object, unknownKeys: string[]}} canonical metrics, and the sorted keys that are not canonical.
 */
export function extractMetrics(parsed) {
  const metrics = {};
  const unknownKeys = [];
  if (typeof parsed !== 'object' || parsed === null)
    return { metrics, unknownKeys };
  const record = parsed;
  const container = typeof record.metrics === 'object' && record.metrics !== null
    ? record.metrics
    : record;
  for (const [key, value] of Object.entries(container)) {
    if (key === 'timestamp' || key === 'schemaVersion' || key === 'source')
      continue;
    if (!isCanonicalMetric(key)) {
      unknownKeys.push(key);
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      metrics[key] = value;
    }
  }
  return { metrics, unknownKeys: unknownKeys.sort() };
}
/**
 * Parse `name=value` / `name,value` lines from a command's stdout.
 * @param {string} stdout - the command's raw stdout.
 * @returns {{metrics: object, malformed: string[]}} parsed metrics, and the canonical names whose value was not finite.
 */
export function parseNameValueLines(stdout) {
  const metrics = {};
  const malformed = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#'))
      continue;
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*[=,]\s*(.+)$/.exec(trimmed);
    if (match === null)
      continue;
    const name = match[1];
    if (!isCanonicalMetric(name))
      continue;
    const value = Number(match[2].trim());
    if (!Number.isFinite(value)) {
      malformed.push(name);
      continue;
    }
    metrics[name] = value;
  }
  return { metrics, malformed };
}
/**
 * Run one configured command probe.
 *
 * `execFile` is used without a shell, so a configured command cannot be turned
 * into shell injection by a crafted metric value. Timeouts kill the child and
 * surface as an error the caller reports as a degraded sample.
 * @param {{argv: string[], timeoutMs: number, format?: string}} config - the command and its budget.
 * @returns {Promise<{metrics: object, malformed: string[], error: string|null}>} the probe result; metrics are discarded on any error.
 */
export function runCommandProbe(config) {
  const [file, ...args] = config.argv;
  if (file === undefined) {
    return Promise.resolve({ metrics: {}, malformed: [], error: 'command probe has an empty argv' });
  }
  return new Promise((resolve) => {
    execFile(file, args, { timeout: config.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        const message = error.killed === true
          ? `command probe timed out after ${config.timeoutMs} ms`
          : (error.message || String(error));
        resolve({ metrics: {}, malformed: [], error: message });
        return;
      }
      const parsed = parseNameValueLines(stdout);
      resolve({ metrics: parsed.metrics, malformed: parsed.malformed, error: null });
    });
  });
}
/**
 * Merge metric bags left to right; later bags win.
 * @param {...object} bags - metric bags, left to right.
 * @returns {object} a new bag where a later bag wins for the same metric.
 */
export function mergeBags(...bags) {
  const out = {};
  for (const bag of bags) {
    for (const [metric, value] of Object.entries(bag)) {
      out[metric] = value;
    }
  }
  return out;
}

// ------------------------------------------------------------------------ the provider runtime environment
/** Active libuv resource counts, when the runtime exposes them. */
function activeResources() {
  const getInfo = nodeProcess.getActiveResourcesInfo;
  if (typeof getInfo !== 'function')
    return { handles: null, requests: null };
  try {
    const info = getInfo();
    const requests = info.filter((entry) => !entry.endsWith('Wrap') && entry !== 'Timeout').length;
    const handles = info.filter((entry) => entry.endsWith('Wrap') || entry === 'Timeout').length;
    return { handles, requests };
  }
  catch {
    return { handles: null, requests: null };
  }
}
/**
 * Build the real environment from Node's own modules.
 * @param {{stateDirectory?: string|null}} [options] - the log directory to expose.
 * @returns {object} the real environment: `clock`, an `os` facade, a lazy `process` getter, `stateDirectory` and `runProbe`.
 */
export function defaultEnvironment(options = {}) {
  const fixed = {
    pid: nodeProcess.pid,
    treeRssBytes: null,
  };
  return {
    clock: () => Date.now(),
    os: {
      cpus: () => nodeOs.cpus(),
      totalmem: () => nodeOs.totalmem(),
      freemem: () => nodeOs.freemem(),
      loadavg: () => nodeOs.loadavg(),
      uptime: () => nodeOs.uptime(),
      platform: () => nodeOs.platform(),
      arch: () => nodeOs.arch(),
      hostname: () => nodeOs.hostname(),
      release: () => nodeOs.release(),
    },
    // Read through on every access. `uptime_seconds` in particular is the input to the
    // whole `time` dimension, and a value captured once at construction would freeze it.
    get process() {
      return readProcessFacade(fixed);
    },
    stateDirectory: options.stateDirectory ?? null,
    runProbe: (config) => runCommandProbe(config),
  };
}
/**
 * Read the volatile process numbers now.
 * @param {{pid?: number, treeRssBytes?: number|null}} [base] - fixed values to keep across reads.
 * @returns {object} the volatile process numbers, read now.
 */
export function readProcessFacade(base = {}) {
  const memory = nodeProcess.memoryUsage();
  const { handles, requests } = activeResources();
  return {
    pid: base.pid ?? nodeProcess.pid,
    treeRssBytes: base.treeRssBytes ?? null,
    uptimeSeconds: nodeProcess.uptime(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    activeHandles: handles,
    activeRequests: requests,
  };
}
// ------------------------------------------------------------------------ the hardware provider
const HARDWARE_PROVIDES = [
  'cpu_temp_c',
  'cpu_usage',
  'gpu_temp_c',
  'gpu_usage',
  'power_limit_hit',
  'thermal_throttle',
];
/**
 * Reads what the OS exposes and merges in whatever an external helper adds.
 */
export class HardwareProvider {
  id = 'hardware';
  group = 'hardware';
  provides = HARDWARE_PROVIDES;
  enabled = true;
  environment;
  options;
  previous = null;
  constructor(environment, options) {
    this.environment = environment;
    this.options = options;
  }
  async sample() {
    const nowMs = this.environment.clock();
    const timestamp = new Date(nowMs).toISOString();
    const metrics = {};
    const cpuUsage = this.cpuUsage();
    if (cpuUsage !== null && !this.ignored('cpu_usage')) {
      metrics.cpu_usage = cpuUsage;
    }
    let degraded = false;
    let reason;
    const notes = [];
    if (this.options.helperCommand !== null) {
      const config = {
        argv: this.options.helperCommand,
        timeoutMs: this.options.helperTimeoutMs,
        format: 'name-value',
      };
      const result = await this.environment.runProbe(config);
      if (result.error !== null) {
        degraded = true;
        reason = 'telemetry_unavailable';
        notes.push(`helperCommand failed: ${result.error}`);
      }
      else {
        const filtered = this.filterIgnored(result.metrics);
        Object.assign(metrics, filtered);
        if (result.malformed.length > 0) {
          degraded = true;
          reason = 'telemetry_unavailable';
          notes.push(`unparsable values for ${result.malformed.join(', ')}`);
        }
        if (Object.keys(result.metrics).length === 0) {
          degraded = true;
          reason = 'telemetry_unavailable';
          notes.push('helperCommand printed no canonical metric lines');
        }
      }
    }
    else {
      degraded = true;
      reason = 'telemetry_unavailable';
      notes.push('no thermal telemetry source configured: set providerOptions.hardware.helperCommand or write a stats file');
    }
    return {
      provider: this.id,
      timestamp,
      metrics,
      ...(degraded ? { degraded: true } : {}),
      ...(reason === undefined ? {} : { degradedReason: reason }),
      ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
    };
  }
  /** Aggregate CPU utilisation from the delta of `os.cpus()` counters. */
  cpuUsage() {
    let idle = 0;
    let total = 0;
    for (const cpu of this.environment.os.cpus()) {
      const times = cpu.times;
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    const current = { idle, total };
    const previous = this.previous;
    this.previous = current;
    if (previous === null)
      return null;
    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    if (totalDelta <= 0 || idleDelta < 0)
      return null;
    const usage = 1 - idleDelta / totalDelta;
    return Math.min(1, Math.max(0, usage));
  }
  ignored(metric) {
    return this.options.ignoreMetrics.includes(metric);
  }
  filterIgnored(bag) {
    const out = {};
    for (const [metric, value] of Object.entries(bag)) {
      if (this.ignored(metric))
        continue;
      out[metric] = value;
    }
    return out;
  }
}
/**
 * Exposed for tests and for the acceptance harness.
 * @param {object} native - metrics the provider measured itself.
 * @param {object} external - metrics an external helper reported.
 * @returns {object} the merged bag; the external value wins.
 */
export function mergeHardwareMetrics(native, external) {
  return mergeBags(native, external);
}
// ------------------------------------------------------------------------ the memory provider
const MEMORY_PROVIDES = [
  'commit_used_ratio',
  'process_private_bytes',
  'process_rss_bytes',
  'ram_available_bytes',
  'ram_total_bytes',
  'ram_used_ratio',
  'vram_used_ratio',
];
/** Reads memory telemetry that Node exposes plus whatever a helper adds. */
export class MemoryProvider {
  id = 'memory';
  group = 'memory';
  provides = MEMORY_PROVIDES;
  enabled = true;
  environment;
  options;
  helper;
  tree;
  constructor(environment, options, helper, tree = null) {
    this.environment = environment;
    this.options = options;
    this.helper = helper;
    this.tree = tree;
  }
  async sample() {
    const nowMs = this.environment.clock();
    const timestamp = new Date(nowMs).toISOString();
    const metrics = {};
    const notes = [];
    const total = this.environment.os.totalmem();
    const available = this.environment.os.freemem();
    if (total > 0) {
      metrics.ram_total_bytes = total;
      metrics.ram_available_bytes = available;
      metrics.ram_used_ratio = Math.min(1, Math.max(0, 1 - available / total));
    }
    else {
      notes.push('os.totalmem() reported 0, RAM metrics omitted');
    }
    // The process-tree sum is what a leak looks like from outside: it covers the
    // launcher and any worker the host runs separately, not just this process.
    const selfRss = this.environment.process.rssBytes;
    const rss = this.tree === null ? (this.environment.process.treeRssBytes ?? selfRss) : this.tree.total(nowMs, selfRss);
    if (rss > 0)
      metrics.process_rss_bytes = rss;
    let degraded = total <= 0;
    let reason = total <= 0 ? 'telemetry_unavailable' : undefined;
    if (this.helper.command !== null) {
      const config = {
        argv: this.helper.command,
        timeoutMs: this.helper.timeoutMs,
        format: 'name-value',
      };
      const result = await this.environment.runProbe(config);
      if (result.error !== null) {
        degraded = true;
        reason = 'telemetry_unavailable';
        notes.push(`helperCommand failed: ${result.error}`);
      }
      else {
        for (const [metric, value] of Object.entries(result.metrics)) {
          metrics[metric] = value;
        }
        if (result.malformed.length > 0) {
          degraded = true;
          reason = 'telemetry_unavailable';
          notes.push(`unparsable values for ${result.malformed.join(', ')}`);
        }
      }
    }
    else {
      notes.push('commit charge, private bytes and VRAM are absent: set providerOptions.memory.helperCommand or write a stats file');
    }
    if (this.options.extraPids.length > 0) {
      if (this.tree !== null && this.tree.error !== null) {
        notes.push(`process tree query: ${this.tree.error}`);
      }
      notes.push(`process RSS includes ${this.options.extraPids.length} configured extra pid(s)`);
    }
    if (metrics.commit_used_ratio === undefined && metrics.vram_used_ratio === undefined) {
      degraded = true;
      reason ??= 'telemetry_unavailable';
    }
    return {
      provider: this.id,
      timestamp,
      metrics,
      ...(degraded ? { degraded: true } : {}),
      ...(reason === undefined ? {} : { degradedReason: reason }),
      ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
    };
  }
}
// ------------------------------------------------------------------------ the runtime provider
const RUNTIME_PROVIDES = [
  'event_loop_latency_ms',
  'handle_count',
  'heartbeat_delay_ms',
  'ipc_timeout_rate',
  'restart_count',
  'thread_count',
  'uptime_seconds',
  'worker_process_count',
];
/** A feed that answers `null` to everything: the honest default. */
export const EMPTY_RUNTIME_FEED = Object.freeze({
  eventLoopLatencyMs: () => null,
  workerProcessCount: () => null,
  threadCount: () => null,
  restartCount: () => null,
  ipcTimeoutRate: () => null,
});
/** Reads runtime health from the process itself plus an injected feed. */
export class RuntimeProvider {
  id = 'runtime';
  group = 'runtime';
  provides = RUNTIME_PROVIDES;
  enabled = true;
  environment;
  options;
  feed;
  lastHeartbeatSeenAt = null;
  constructor(environment, options, feed) {
    this.environment = environment;
    this.options = options;
    this.feed = feed;
  }
  sample() {
    const nowMs = this.environment.clock();
    const timestamp = new Date(nowMs).toISOString();
    const metrics = {};
    const notes = [];
    metrics.uptime_seconds = this.environment.process.uptimeSeconds;
    const handles = this.environment.process.activeHandles;
    if (handles !== null)
      metrics.handle_count = handles;
    else
      notes.push('active resource counts unavailable in this runtime');
    const eventLoop = this.feed.eventLoopLatencyMs();
    if (eventLoop !== null)
      metrics.event_loop_latency_ms = eventLoop;
    else
      notes.push('no event-loop latency sampler bound');
    const workers = this.feed.workerProcessCount();
    if (workers !== null)
      metrics.worker_process_count = workers;
    const threads = this.feed.threadCount();
    if (threads !== null)
      metrics.thread_count = threads;
    const restarts = this.feed.restartCount();
    if (restarts !== null)
      metrics.restart_count = restarts;
    const ipc = this.feed.ipcTimeoutRate();
    if (ipc !== null)
      metrics.ipc_timeout_rate = ipc;
    const heartbeat = this.heartbeatDelayMs(nowMs);
    if (heartbeat !== null)
      metrics.heartbeat_delay_ms = heartbeat;
    else if (this.options.heartbeatFile !== null) {
      notes.push(`heartbeat file ${this.options.heartbeatFile} not readable yet`);
    }
    const missing = RUNTIME_PROVIDES.filter((metric) => metrics[metric] === undefined);
    const degraded = missing.length > 0;
    return {
      provider: this.id,
      timestamp,
      metrics,
      ...(degraded ? { degraded: true } : {}),
      ...(degraded ? { degradedReason: 'telemetry_unavailable' } : {}),
      note: notes.length > 0
        ? notes.join('; ')
        : 'all runtime metrics measured',
    };
  }
  /**
   * Heartbeat lateness: how much older the heartbeat file is than the expected
   * cadence. A file that is exactly on time reports 0; a file that has stopped
   * being touched reports its full age, which is what makes a frozen UI visible.
   */
  heartbeatDelayMs(nowMs) {
    const file = this.options.heartbeatFile;
    if (file === null)
      return null;
    if (!existsSync(file))
      return null;
    try {
      const mtimeMs = statSync(file).mtimeMs;
      this.lastHeartbeatSeenAt = mtimeMs;
      return Math.max(0, nowMs - mtimeMs - this.options.heartbeatExpectedMs);
    }
    catch {
      return null;
    }
  }
  /** Last observed heartbeat instant, for the UI payload. */
  get heartbeatSeenAt() {
    return this.lastHeartbeatSeenAt;
  }
}
// ------------------------------------------------------------------------ the stats-backed providers
const WORKER_METRICS = [
  'abnormal_exit_rate',
  'active_workers',
  'failure_rate',
  'queue_delay_ms',
  'queued_tasks',
  'retry_rate',
  'spawn_failure_rate',
  'task_latency_ms',
  'timeout_rate',
];
const COMPUTER_USE_METRICS = [
  'action_latency_ms',
  'desktop_responsiveness_ms',
  'missed_target_rate',
  'recovery_rate',
  'screenshot_latency_ms',
  'verification_retry_rate',
];
const UI_METRICS = [
  'blank_frame_rate',
  'frontend_error_rate',
  'main_window_heartbeat_ms',
  'render_latency_ms',
];
const CONTEXT_METRICS = ['git_operations_per_minute', 'task_failure_rate'];
/**
 * One provider over a subset of the external stats.
 *
 * `required` lists the metrics whose absence is worth reporting as degraded even
 * when the file was read successfully; the design's acceptance criteria include
 * "no telemetry is marked unknown, not healthy", and this is where that becomes
 * observable.
 */
export class StatsBackedProvider {
  id;
  group;
  provides;
  enabled = true;
  /** Metrics whose absence marks the sample degraded. */
  required;
  source;
  environment;
  extraProbes;
  constructor(options) {
    this.id = options.id;
    this.group = options.group;
    this.provides = options.provides;
    this.required = options.required ?? options.provides;
    this.source = options.source;
    this.environment = options.environment;
    this.extraProbes = options.extraProbes ?? [];
  }
  async sample() {
    const nowMs = this.environment.clock();
    const timestamp = new Date(nowMs).toISOString();
    const snapshot = this.source.read(nowMs);
    const metrics = {};
    const notes = [];
    for (const metric of this.provides) {
      const value = snapshot.metrics[metric];
      if (value !== undefined)
        metrics[metric] = value;
    }
    for (const argv of this.extraProbes) {
      if (argv.length === 0)
        continue;
      const result = await this.environment.runProbe({ argv, timeoutMs: 5_000, format: 'name-value' });
      if (result.error !== null) {
        notes.push(`probe ${argv[0]} failed: ${result.error}`);
        continue;
      }
      for (const metric of this.provides) {
        const value = result.metrics[metric];
        if (value !== undefined)
          metrics[metric] = value;
      }
    }
    const missing = this.required.filter((metric) => metrics[metric] === undefined);
    const degraded = missing.length > 0 || snapshot.stale;
    if (snapshot.detail !== null)
      notes.push(snapshot.detail);
    if (missing.length > 0)
      notes.push(`no telemetry for ${missing.join(', ')}`);
    if (snapshot.unknownKeys.length > 0) {
      notes.push(`stats file contains non-canonical keys: ${snapshot.unknownKeys.join(', ')}`);
    }
    return {
      provider: this.id,
      timestamp,
      metrics,
      ...(degraded ? { degraded: true } : {}),
      ...(degraded ? { degradedReason: (snapshot.reason ?? 'telemetry_unavailable') } : {}),
      ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
    };
  }
}
/** Provider ids of the four stats-backed providers, in registration order. */
export const STATS_PROVIDER_IDS = Object.freeze([
  'workers',
  'computer-use',
  'ui',
  'context',
]);
/**
 * Build the four stats-backed providers over one shared source.
 * @param {object} source - the shared `StatsFileSource`.
 * @param {object} environment - the provider environment.
 * @param {{commands?: string[][]}} [options] - extra probe argv lists shared by all four.
 * @returns {object[]} the `workers`, `computer-use`, `ui` and `context` providers, in that order.
 */
export function buildStatsBackedProviders(source, environment, options = {}) {
  const commands = options.commands ?? [];
  return [
    new StatsBackedProvider({
      id: 'workers',
      group: 'workers',
      provides: WORKER_METRICS,
      source,
      environment,
      extraProbes: commands,
    }),
    new StatsBackedProvider({
      id: 'computer-use',
      group: 'computer-use',
      provides: COMPUTER_USE_METRICS,
      source,
      environment,
      extraProbes: commands,
    }),
    new StatsBackedProvider({
      id: 'ui',
      group: 'ui',
      provides: UI_METRICS,
      source,
      environment,
      extraProbes: commands,
    }),
    new StatsBackedProvider({
      id: 'context',
      group: 'context',
      provides: CONTEXT_METRICS,
      source,
      environment,
      extraProbes: commands,
    }),
  ];
}
/** Metric groups each stats-backed provider owns, for documentation and tests. */
export const STATS_PROVIDER_METRICS = Object.freeze({
  workers: WORKER_METRICS,
  'computer-use': COMPUTER_USE_METRICS,
  ui: UI_METRICS,
  context: CONTEXT_METRICS,
});
// ------------------------------------------------------------------------ process-tree memory reading
/** A reader for process-tree memory, with its own refresh cadence. */
export class ProcessTreeReader {
  extraPids;
  refreshMs;
  runner;
  selfPid;
  cache = [];
  cachedAt = Number.NEGATIVE_INFINITY;
  inFlight = false;
  lastError = null;
  constructor(options) {
    this.extraPids = options.extraPids;
    this.refreshMs = options.refreshMs ?? 30_000;
    this.selfPid = options.selfPid ?? process.pid;
    this.runner = options.runner ?? runCapture;
  }
  /** Every pid this reader considers part of the tree. */
  get pids() {
    return [this.selfPid, ...this.extraPids];
  }
  /** Last error from the platform query, or `null`. */
  get error() {
    return this.lastError;
  }
  /**
   * Total resident bytes for the tree.
   *
   * Returns the cached sum and, at most once per refresh window, starts a
   * background refresh. The refresh is deliberately fire-and-forget: a slow
   * `wmic` must not delay a health sample, and a stale-by-thirty-seconds sum is
   * still a perfectly good leak signal.
   *
   * @param nowMs - evaluation instant.
   * @param selfRssBytes - this process's RSS, always authoritative.
   */
  total(nowMs, selfRssBytes) {
    if (nowMs - this.cachedAt >= this.refreshMs && !this.inFlight && this.extraPids.length > 0) {
      this.inFlight = true;
      this.cachedAt = nowMs;
      void this.refresh();
    }
    const others = this.cache.reduce((sum, entry) => sum + entry.rssBytes, 0);
    return selfRssBytes + others;
  }
  async refresh() {
    try {
      const results = [];
      if (process.platform === 'win32') {
        // One query for the whole list is cheaper than one per pid, and the pid
        // filter is applied here rather than on the command line so a missing pid
        // cannot make the query itself fail.
        const result = await this.runner('tasklist.exe', ['/NH', '/FO', 'CSV']);
        if (result.code !== 0) {
          this.lastError = `tasklist exited with ${result.code}`;
        }
        else {
          const wanted = new Set(this.extraPids);
          for (const line of result.stdout.split(/\r?\n/)) {
            const parsed = parseTasklistMemoryLine(line);
            if (parsed !== null && wanted.has(parsed.pid))
              results.push(parsed);
          }
        }
      }
      else {
        const result = await this.runner('ps', ['-o', 'pid=,rss=', '-p', this.extraPids.join(',')]);
        if (result.code !== 0) {
          this.lastError = `ps exited with ${result.code}`;
        }
        else {
          for (const line of result.stdout.split('\n')) {
            const parsed = parsePsMemoryLine(line);
            if (parsed !== null)
              results.push(parsed);
          }
        }
      }
      this.cache = results;
      if (this.lastError === null && results.length !== this.extraPids.length) {
        this.lastError = `${this.extraPids.length - results.length} configured pid(s) are not running`;
      }
    }
    catch (error) {
      this.lastError = error.message;
    }
    finally {
      this.inFlight = false;
    }
  }
}
/**
 * Parse one `tasklist /NH /FO CSV` line into a pid and resident bytes.
 * @param {string} line - one `tasklist /NH /FO CSV` line.
 * @returns {{pid: number, rssBytes: number}|null} the parsed entry, or `null` when the line is not a process row.
 */
export function parseTasklistMemoryLine(line) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('INFO:'))
    return null;
  const fields = trimmed.split(',').map((field) => field.trim().replace(/^"|"$/g, ''));
  if (fields.length < 5)
    return null;
  const pid = Number(fields[1]);
  // Memory is rendered like `1,234,567 K`, so the thousands separators are inside
  // the quoted field and must be stripped before the unit suffix is read.
  const memory = (fields.slice(4).join(',') ?? '').replace(/[,\s]/g, '');
  const match = /^(\d+(?:\.\d+)?)([KMG]?)B?$/i.exec(memory);
  if (!Number.isFinite(pid) || match === null)
    return null;
  const value = Number(match[1]);
  const unit = match[2]?.toUpperCase();
  const scale = unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : 1024;
  return { pid, rssBytes: value * scale };
}
/**
 * Parse one `ps -o pid=,rss=` line, where RSS is in kibibytes.
 * @param {string} line - one `ps -o pid=,rss=` line, where RSS is in kibibytes.
 * @returns {{pid: number, rssBytes: number}|null} the parsed entry, or `null` when the line does not parse.
 */
export function parsePsMemoryLine(line) {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
  if (match === null)
    return null;
  return { pid: Number(match[1]), rssBytes: Number(match[2]) * 1024 };
}
/** Run a command and capture stdout without a shell. */
function runCapture(file, args) {
  return new Promise((resolve) => {
    execFile(file, [...args], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) {
        resolve({ stdout: String(stdout ?? ''), code: 0 });
        return;
      }
      const code = typeof error.code === 'number'
        ? error.code
        : 1;
      resolve({ stdout: String(stdout ?? ''), code });
    });
  });
}
// ------------------------------------------------------------------------ the provider registry
/**
 * A registry of health providers with per-provider circuit breaking.
 */
export class ProviderRegistry {
  entries = new Map();
  sampling;
  resilience;
  disabled;
  listeners = new Set();
  constructor(options) {
    this.sampling = options.sampling;
    this.resilience = options.resilience;
    this.disabled = new Set(options.disabledProviders);
  }
  /** Register a provider. Returns a disposer that removes it again. */
  register(provider) {
    if (this.entries.has(provider.id)) {
      throw new Error(`health-scheduler: provider "${provider.id}" is already registered`);
    }
    this.entries.set(provider.id, {
      provider,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      disabledUntil: 0,
    });
    return () => {
      this.entries.delete(provider.id);
    };
  }
  /** Observe provider failures, e.g. to write them into the audit log. */
  onFailure(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Registered provider ids, sorted. */
  ids() {
    return [...this.entries.keys()].sort();
  }
  /** Whether a provider id is registered. */
  has(id) {
    return this.entries.has(id);
  }
  /** Current status of every provider, sorted by id. */
  status(nowMs) {
    return [...this.entries.values()]
      .map((entry) => ({
      id: entry.provider.id,
      group: entry.provider.group,
      consecutiveFailures: entry.consecutiveFailures,
      totalFailures: entry.totalFailures,
      totalSuccesses: entry.totalSuccesses,
      lastSuccessAt: entry.lastSuccessAt,
      lastFailureAt: entry.lastFailureAt,
      lastError: entry.lastError,
      backoffRemainingMs: Math.max(0, entry.disabledUntil - nowMs),
      available: this.isAvailable(entry, nowMs),
    }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  /**
   * Sample every available provider once, containing every failure.
   *
   * Providers run concurrently; one slow source delays the round but cannot
   * corrupt it. The caller is expected to hold a per-tick budget of its own if
   * needed — this method never rejects.
   */
  async sampleAll(nowMs, timestamp) {
    const samples = [];
    const failures = [];
    const skipped = [];
    const runnable = [];
    for (const entry of [...this.entries.values()].sort((a, b) => (a.provider.id < b.provider.id ? -1 : 1))) {
      if (!this.isAvailable(entry, nowMs)) {
        skipped.push(entry.provider.id);
        continue;
      }
      runnable.push(entry);
    }
    const results = await Promise.all(runnable.map(async (entry) => {
      try {
        const sample = await entry.provider.sample();
        return { entry, sample, error: null };
      }
      catch (error) {
        return { entry, sample: null, error: error };
      }
    }));
    for (const result of results) {
      const { entry } = result;
      if (result.error !== null) {
        entry.consecutiveFailures += 1;
        entry.totalFailures += 1;
        entry.lastFailureAt = timestamp;
        entry.lastError = truncate(result.error.message, 400);
        const backoffMs = this.backoffFor(entry);
        entry.disabledUntil = nowMs + backoffMs;
        const failure = {
          provider: entry.provider.id,
          message: entry.lastError,
          consecutiveFailures: entry.consecutiveFailures,
          backoffMs,
          timestamp,
        };
        failures.push(failure);
        for (const listener of this.listeners) {
          try {
            listener(failure);
          }
          catch {
            // A listener must never break sampling.
          }
        }
        continue;
      }
      const sample = result.sample;
      entry.consecutiveFailures = 0;
      entry.totalSuccesses += 1;
      entry.lastSuccessAt = timestamp;
      entry.lastError = null;
      entry.disabledUntil = 0;
      samples.push(sample);
    }
    return { samples, failures, skipped };
  }
  /** Reset all backoff windows, e.g. after a user-visible settings change. */
  resetBackoff() {
    for (const entry of this.entries.values()) {
      entry.disabledUntil = 0;
      entry.consecutiveFailures = 0;
    }
  }
  isAvailable(entry, nowMs) {
    if (this.disabled.has(entry.provider.id))
      return false;
    if (entry.provider.enabled === false)
      return false;
    if (!this.resilience.providerRetryAfterBackoff && entry.consecutiveFailures > 0)
      return false;
    return entry.disabledUntil <= nowMs;
  }
  backoffFor(entry) {
    if (entry.consecutiveFailures < this.resilience.providerFailureLimit)
      return 0;
    const steps = entry.consecutiveFailures - this.resilience.providerFailureLimit;
    const raw = this.sampling.providerBackoffMs * 2 ** Math.min(steps, 8);
    return Math.min(raw, this.sampling.providerBackoffMaxMs);
  }
}
function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
