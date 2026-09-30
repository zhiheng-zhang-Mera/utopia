/**
 * UTOPIA · Host Health Station — differential parity harness.
 *
 * The strongest available parity evidence for this migration is not a hand-copied
 * expectation table: the donor is a zero-dependency TypeScript package whose own
 * build is already compiled to plain ESM, so it can be *run* alongside the port.
 * This harness drives both engines through the same seeded scenarios with the
 * same injected clock and asserts that every observable output agrees exactly —
 * the pressure score and its level, coverage, every dimension's score/level/
 * weight/effective weight, every metric's value, level, rule, sustain and trend
 * flag, the raw and gated band scores recomputed from each side's own primitives,
 * the band key, the driver list, the maintenance picture, the safe-point fold, the
 * decision records with their reasons, and every adapter call.
 *
 * ## Shape normalisation, and why it is small
 *
 * The mission dropped the donor's Cordis binding (`name`, `inject`, `apply`,
 * `applyHealthScheduler`) and its npm packaging. That removal touched only the
 * plugin entry point: the engine, providers, adapters, audit log and vocabulary
 * are carried over with their shapes intact. Both sides are therefore driven
 * through the *same* facade — `resolveConfig` + `new HealthScheduler({ config,
 * restart, workerControl, stateDirectory, clock, safePoints })` — which is the
 * donor's own public API and the port's `createScheduler` alias. The only
 * normalisations this harness performs are:
 *
 *   1. `unknownDimensions` and `warnings` are sorted, because the engine's own
 *      order is a stability guarantee rather than a semantic one, and sorting
 *      makes the comparison robust to an equal-set/different-order bug elsewhere.
 *   2. Per-metric `raw`, `gated` and `bandKey` are *recomputed* on each side from
 *      that side's own `scoreMetric`/`scoreWithSustain`/`bandKeyOf` and its own
 *      resolved metric config, because a snapshot publishes the result (`score`,
 *      `rule`, `sustainedMs`, `trendApplied`) but not those intermediates.
 *      Recomputing them per side compares the plumbing, not just the summary.
 *   3. `PRESET_DOCUMENTS` and the donor's plugin entry point are not compared:
 *      the first is a port-only convenience, the second is deliberately absent.
 *
 * Nothing else is reshaped: a differing key set, a differing string, or a
 * differing number is a failure.
 *
 * ## Running it
 *
 * The donor build lives in the git-ignored mission evidence area, so the test
 * skips with an explicit reason when it is missing rather than quietly passing.
 * To re-create it:
 *
 *   cd .runtime/evidence/mission-book/MB-005/donor-health
 *   git checkout 985e2b7389330db4b32ea2946e3657746c64b47b
 *   npm install --no-audit --no-fund typescript@5.7.2 @types/node@22
 *   npx tsc -p tsconfig.json
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------- the two sides */

const DONOR_LIB = fileURLToPath(new URL('../../../../../.runtime/evidence/mission-book/MB-005/donor-health/lib/index.js', import.meta.url));
const DONOR_PRESENT = existsSync(DONOR_LIB);

/* ------------------------------------------------------------------ the rig */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const EPOCH = Date.parse('2026-03-01T00:00:00.000Z');

/** A local-clock instant: the default 03:30–05:00 window is open and past target. */
const local = (day, hour, minute, month = 3) => new Date(2026, month - 1, day, hour, minute, 0, 0).getTime();

/**
 * The deterministic generator. A tiny mulberry32: 32-bit state, no dependency,
 * and the same sequence on every machine and every run.
 */
function seeded(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (values) => values[Math.floor(next() * values.length)],
  };
}

/** A provider whose readings the scenario scripts, with a deterministic timestamp. */
function scriptedProvider(id, group, provides, clock) {
  const current = {};
  return {
    id,
    group,
    provides,
    enabled: true,
    readings: current,
    sample() {
      const metrics = {};
      for (const metric of provides) if (metric in current) metrics[metric] = current[metric];
      return { provider: id, timestamp: new Date(clock()).toISOString(), metrics };
    },
  };
}

/** Records every restart request. The engine may only ever request. */
function recordingRestart(capability = 'available') {
  const adapter = {
    id: 'recording-restart',
    capability,
    requests: [],
    async requestApplicationRestart(request) {
      adapter.requests.push({ ...request, mode: 'application' });
      return { accepted: true, state: 'queued', requestId: `r-${adapter.requests.length}` };
    },
    async requestSystemRestart(request) {
      adapter.requests.push({ ...request, mode: 'system' });
      return { accepted: true, state: 'queued', requestId: `r-${adapter.requests.length}` };
    },
    async cancelPendingRestart() {
      return true;
    },
  };
  return adapter;
}

/** Records every worker-control call. */
function recordingWorker(capability = 'available') {
  const adapter = {
    id: 'recording-worker-control',
    capability,
    calls: [],
    limit: null,
    async setConcurrencyLimit(limit) {
      adapter.calls.push(['setConcurrencyLimit', limit]);
      adapter.limit = limit;
    },
    async pauseNewWorkers() {
      adapter.calls.push(['pauseNewWorkers']);
    },
    async resumeNormalConcurrency() {
      adapter.calls.push(['resumeNormalConcurrency']);
      adapter.limit = null;
    },
    currentConcurrencyLimit() {
      return adapter.limit;
    },
  };
  return adapter;
}

/* ------------------------------------------------------------ the scenarios */

/** The healthy baseline: every dimension reports, nothing is under pressure. */
const HEALTHY = {
  cpu_temp_c: 52, gpu_temp_c: 48, cpu_usage: 0.18, gpu_usage: 0.05,
  thermal_throttle: 0, power_limit_hit: 0,
  ram_used_ratio: 0.42, ram_available_bytes: 20 * 1024 ** 3, process_rss_bytes: 1_500_000_000,
  vram_used_ratio: 0.2,
  uptime_seconds: 4 * 3600, event_loop_latency_ms: 4, handle_count: 40, heartbeat_delay_ms: 0,
  active_workers: 2, queued_tasks: 0, task_latency_ms: 5_000, timeout_rate: 0, failure_rate: 0,
  retry_rate: 0, spawn_failure_rate: 0, abnormal_exit_rate: 0, queue_delay_ms: 0, task_failure_rate: 0,
  screenshot_latency_ms: 400, action_latency_ms: 120, verification_retry_rate: 0, missed_target_rate: 0,
  recovery_rate: 0.95, desktop_responsiveness_ms: 90,
  render_latency_ms: 20, main_window_heartbeat_ms: 1_000, blank_frame_rate: 0, frontend_error_rate: 0,
  git_operations_per_minute: 3,
};

const PROVIDER_OF = {
  hardware: ['cpu_temp_c', 'gpu_temp_c', 'cpu_usage', 'gpu_usage', 'thermal_throttle', 'power_limit_hit'],
  memory: ['ram_total_bytes', 'ram_available_bytes', 'ram_used_ratio', 'commit_used_ratio', 'process_rss_bytes', 'process_private_bytes', 'vram_used_ratio'],
  runtime: ['uptime_seconds', 'worker_process_count', 'handle_count', 'thread_count', 'event_loop_latency_ms', 'heartbeat_delay_ms', 'restart_count', 'ipc_timeout_rate'],
  workers: ['active_workers', 'queued_tasks', 'task_latency_ms', 'timeout_rate', 'retry_rate', 'failure_rate', 'spawn_failure_rate', 'abnormal_exit_rate', 'queue_delay_ms'],
  'computer-use': ['screenshot_latency_ms', 'action_latency_ms', 'verification_retry_rate', 'missed_target_rate', 'recovery_rate', 'desktop_responsiveness_ms'],
  ui: ['render_latency_ms', 'main_window_heartbeat_ms', 'blank_frame_rate', 'frontend_error_rate'],
  context: ['task_failure_rate', 'git_operations_per_minute'],
};

/** Every metric's band endpoints, plus one step outside each end. */
function bandEdgeValues(band) {
  const step = (band.critical - band.warn) / 4;
  return [band.warn - step, band.warn, band.warn + step, (band.warn + band.critical) / 2, band.critical - step, band.critical, band.critical + step];
}

/**
 * Build the scenario matrix.
 *
 * `steps` is a list of `{ advanceMs, readings }`: the readings are merged into the
 * named providers before the clock advances and the tick runs. Steps are a
 * deliberate mixture of "hold for a while" (which is how the sustain gate opens)
 * and "change every tick" (which is how a trend is fitted).
 */
function buildScenarios(metrics) {
  const scenarios = [];
  const push = (scenario) => scenarios.push(scenario);

  /** A scenario that sets one bag on one provider and holds it for `steps` ticks. */
  const hold = (name, providerId, bag, options = {}) => {
    const { advanceMs = MINUTE, steps = 25, extra = [], ...rest } = options;
    push({
      name,
      ...rest,
      providers: [{ id: providerId, group: providerId, metrics: Object.keys(bag) }, ...extra],
      steps: [{ advanceMs, readings: { [providerId]: bag } }].concat(
        Array.from({ length: steps - 1 }, () => ({ advanceMs, readings: {} })),
      ),
    });
  };

  // 1. normal load: everything reporting, nothing wrong.
  hold('normal load, every dimension reporting', 'hardware', HEALTHY, {
    steps: 12,
    extra: [
      { id: 'memory', group: 'memory', metrics: Object.keys(HEALTHY).filter((metric) => PROVIDER_OF.memory.includes(metric)) },
      { id: 'runtime', group: 'runtime', metrics: Object.keys(HEALTHY).filter((metric) => PROVIDER_OF.runtime.includes(metric)) },
    ],
  });
  push({
    name: 'normal load across every provider',
    providers: Object.keys(PROVIDER_OF).map((id) => ({ id, group: id, metrics: Object.keys(HEALTHY).filter((metric) => PROVIDER_OF[id].includes(metric)) })),
    steps: Array.from({ length: 10 }, (_, index) => ({
      advanceMs: MINUTE,
      readings: index === 0 ? Object.fromEntries(Object.keys(PROVIDER_OF).map((id) => [id, HEALTHY])) : {},
    })),
  });

  // 2. unknown and missing telemetry.
  push({ name: 'no telemetry at all', providers: [], steps: Array.from({ length: 6 }, () => ({ advanceMs: MINUTE, readings: {} })) });
  push({
    name: 'one dimension reporting, five unknown',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 88 } }],
    steps: Array.from({ length: 8 }, (_, index) => ({ advanceMs: MINUTE, readings: index === 0 ? { hardware: { gpu_temp_c: 88 } } : {} })),
  });
  push({
    name: 'a provider that goes silent mid-run',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 88, cpu_temp_c: 84 } }],
    steps: [
      { advanceMs: MINUTE, readings: { hardware: { gpu_temp_c: 88, cpu_temp_c: 84 } } },
      { advanceMs: MINUTE, readings: {} },
      { advanceMs: 6 * MINUTE, readings: { hardware: { gpu_temp_c: null, cpu_temp_c: null } } },
      { advanceMs: 6 * MINUTE, readings: {} },
    ],
  });

  // 3. sustained pressure.
  hold('sustained thermal pressure past the sustain gate', 'hardware', {
    gpu_temp_c: 90, cpu_temp_c: 92, cpu_usage: 0.95, gpu_usage: 0.97, thermal_throttle: 0.4, power_limit_hit: 0.5,
  }, { steps: 30, extra: [{ id: 'memory', group: 'memory', metrics: { ram_used_ratio: 0.9 } }] });
  hold('sustained memory pressure', 'memory', { ram_used_ratio: 0.95, ram_available_bytes: 700 * 1024 ** 2, vram_used_ratio: 0.9 }, { steps: 30 });

  // 4. transient spikes shorter than the sustain gate.
  push({
    name: 'a GPU spike of 30 s against a 60 s sustain gate',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 90 } }],
    steps: [
      { advanceMs: SECOND, readings: { hardware: { gpu_temp_c: 52 } } },
      { advanceMs: SECOND, readings: { hardware: { gpu_temp_c: 90 } } },
      { advanceMs: 2 * SECOND, readings: {} },
      { advanceMs: 14 * SECOND, readings: {} },
      { advanceMs: 2 * SECOND, readings: { hardware: { gpu_temp_c: 52 } } },
      { advanceMs: MINUTE, readings: {} },
    ],
  });
  push({
    name: 'a spike that reaches the sustain gate exactly',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 90 } }],
    steps: [
      { advanceMs: SECOND, readings: { hardware: { gpu_temp_c: 90 } } },
      { advanceMs: 30 * SECOND, readings: {} },
      { advanceMs: 30 * SECOND, readings: {} },
      { advanceMs: 30 * SECOND, readings: {} },
    ],
  });

  // 5. recovery.
  push({
    name: 'pressure then recovery back to healthy',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 90, thermal_throttle: 0.5 } }],
    steps: [
      { advanceMs: SECOND, readings: { hardware: { gpu_temp_c: 90, thermal_throttle: 0.5 } } },
      { advanceMs: 10 * MINUTE, readings: {} },
      { advanceMs: 5 * MINUTE, readings: { hardware: { gpu_temp_c: 45, thermal_throttle: 0 } } },
      { advanceMs: 5 * MINUTE, readings: {} },
      { advanceMs: 40 * MINUTE, readings: {} },
    ],
  });
  push({
    name: 'recovery inside an open maintenance window',
    providers: [{ id: 'memory', group: 'memory', metrics: { ram_used_ratio: 0.99 } }],
    config: { maintenance: { enabled: true, safePointRequired: false } },
    epoch: local(1, 4, 5),
    steps: [
      { advanceMs: MINUTE, readings: { memory: { ram_used_ratio: 0.99 } } },
      { advanceMs: 20 * MINUTE, readings: {} },
      { advanceMs: 10 * MINUTE, readings: { memory: { ram_used_ratio: 0.3 } } },
      { advanceMs: 30 * MINUTE, readings: {} },
    ],
  });

  // 6. boundary values at every band edge, for every banded metric.
  for (const metric of Object.keys(metrics).sort()) {
    const band = metrics[metric].band;
    if (band === undefined) continue;
    push({
      name: `band edges: ${metric}`,
      providers: [{ id: 'band', group: 'hardware', metrics: { [metric]: band.warn } }],
      steps: bandEdgeValues(band).map((value) => ({ advanceMs: 3 * MINUTE, readings: { band: { [metric]: value } } })),
    });
  }

  // 7. growth trends: bandless leak metrics and banded latency ramps.
  push({
    name: 'a four-hour RSS leak with no band at all',
    providers: [{ id: 'memory', group: 'memory', metrics: { process_rss_bytes: 2_000_000_000, ram_used_ratio: 0.62 } }],
    steps: Array.from({ length: 48 }, (_, index) => ({
      advanceMs: 5 * MINUTE,
      readings: { memory: { process_rss_bytes: 2_000_000_000 + (((index + 1) * 5 * MINUTE) / HOUR) * 1_200_000_000, ram_used_ratio: 0.62 } },
    })),
  });
  push({
    name: 'a rising event-loop latency ramp',
    providers: [{ id: 'runtime', group: 'runtime', metrics: { event_loop_latency_ms: 40, uptime_seconds: 100 * HOUR } }],
    steps: Array.from({ length: 30 }, (_, index) => ({
      advanceMs: 4 * MINUTE,
      readings: { runtime: { event_loop_latency_ms: 40 + (((index + 1) * 4 * MINUTE) / HOUR) * 350, uptime_seconds: 100 * HOUR } },
    })),
  });
  push({
    name: 'worker retry storm',
    providers: [{ id: 'workers', group: 'workers', metrics: { active_workers: 8, timeout_rate: 0.35, failure_rate: 0.28, retry_rate: 0.7, task_latency_ms: 220_000, abnormal_exit_rate: 0.25 } }],
    steps: [
      { advanceMs: SECOND, readings: { workers: { active_workers: 8 } } },
      { advanceMs: 2 * MINUTE, readings: {} },
      { advanceMs: 2 * MINUTE, readings: { workers: { timeout_rate: 0.35, failure_rate: 0.28, retry_rate: 0.7, task_latency_ms: 220_000, abnormal_exit_rate: 0.25 } } },
      { advanceMs: 6 * MINUTE, readings: {} },
    ],
  });
  push({
    name: 'a frozen UI',
    providers: [{ id: 'ui', group: 'ui', metrics: { render_latency_ms: 20, main_window_heartbeat_ms: 12_000, blank_frame_rate: 0.25, frontend_error_rate: 0.3 } }],
    steps: [
      { advanceMs: MINUTE, readings: { ui: { render_latency_ms: 20, blank_frame_rate: 0 } } },
      { advanceMs: 2 * MINUTE, readings: {} },
      { advanceMs: MINUTE, readings: { ui: { render_latency_ms: 2_600, main_window_heartbeat_ms: 12_000, blank_frame_rate: 0.25, frontend_error_rate: 0.3 } } },
      { advanceMs: 8 * MINUTE, readings: {} },
    ],
  });
  push({
    name: 'the uptime ramp from 8 h to 400 h',
    providers: [{ id: 'runtime', group: 'runtime', metrics: { uptime_seconds: 8 * 3600 } }],
    steps: [8, 24, 100, 200, 336, 400].map((hours) => ({ advanceMs: MINUTE, readings: { runtime: { uptime_seconds: hours * 3600 } } })),
  });

  // 8. the action ladder, its gates and its refusals.
  const ladderConfig = {
    antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 },
    throttle: { concurrencyLimit: 2 },
    thresholds: { throttle: { enter: 5, exit: 2 } },
  };
  push({
    name: 'the whole ladder from healthy to reboot',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 40, thermal_throttle: 0 } }],
    config: { ...ladderConfig, maintenance: { enabled: true, safePointRequired: false } },
    epoch: local(1, 4, 5),
    steps: [
      { advanceMs: MINUTE, readings: { hardware: { gpu_temp_c: 40, thermal_throttle: 0 } } },
      { advanceMs: 10 * MINUTE, readings: {} },
      { advanceMs: 10 * MINUTE, readings: { hardware: { gpu_temp_c: 60, thermal_throttle: 0 } } },
      { advanceMs: 10 * MINUTE, readings: { hardware: { gpu_temp_c: 80, thermal_throttle: 0.2 } } },
      { advanceMs: 10 * MINUTE, readings: { hardware: { gpu_temp_c: 90, thermal_throttle: 0.5 } } },
      { advanceMs: 10 * MINUTE, readings: { hardware: { gpu_temp_c: 99, thermal_throttle: 0.9 } } },
      { advanceMs: 10 * MINUTE, readings: {} },
      { advanceMs: 10 * MINUTE, readings: {} },
      { advanceMs: 20 * MINUTE, readings: { hardware: { gpu_temp_c: 40, thermal_throttle: 0 } } },
      { advanceMs: 30 * MINUTE, readings: {} },
    ],
  });
  push({
    name: 'debounced escalation over three evaluations',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 99 } }],
    config: { antiFlap: { debounceEvaluations: 3 }, maintenance: { enabled: true, safePointRequired: false } },
    epoch: local(1, 4, 5),
    steps: [
      { advanceMs: MINUTE, readings: { hardware: { gpu_temp_c: 99 } } },
      { advanceMs: 3 * MINUTE, readings: {} },
      { advanceMs: 3 * MINUTE, readings: {} },
      { advanceMs: 10 * MINUTE, readings: {} },
    ],
  });
  push({
    name: 'a restart gated by the maintenance window',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 92, thermal_throttle: 0.6 } }],
    config: { antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 }, maintenance: { enabled: true } },
    epoch: EPOCH,
    steps: Array.from({ length: 12 }, (_, index) => ({ advanceMs: 5 * MINUTE, readings: index === 0 ? { hardware: { gpu_temp_c: 92, thermal_throttle: 0.6 } } : {} })),
  });
  push({
    name: 'a restart gated by an unsafe safe point',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 92, thermal_throttle: 0.6 } }],
    config: { antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 }, maintenance: { enabled: true } },
    epoch: local(1, 4, 5),
    safePoint: { source: 'core', safe: false, reason: 'git_commit_in_progress', estimatedState: 'busy' },
    steps: Array.from({ length: 12 }, (_, index) => ({ advanceMs: 5 * MINUTE, readings: index === 0 ? { hardware: { gpu_temp_c: 92, thermal_throttle: 0.6 } } : {} })),
  });
  push({
    name: 'a restart gated by an unanswered safe point',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 92, thermal_throttle: 0.6 } }],
    config: { antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 }, maintenance: { enabled: true } },
    epoch: local(1, 4, 5),
    safePoint: { source: 'quiet', safe: null, reason: 'no_answer', estimatedState: 'unknown' },
    steps: Array.from({ length: 12 }, (_, index) => ({ advanceMs: 5 * MINUTE, readings: index === 0 ? { hardware: { gpu_temp_c: 92, thermal_throttle: 0.6 } } : {} })),
  });
  push({
    name: 'the urgent override with an available adapter',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 99, thermal_throttle: 0.9 } }],
    config: { antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 }, maintenance: { enabled: true } },
    epoch: local(1, 4, 5),
    safePoint: { source: 'core', safe: false, reason: 'busy', estimatedState: 'critical' },
    steps: Array.from({ length: 14 }, (_, index) => ({ advanceMs: 5 * MINUTE, readings: index === 0 ? { hardware: { gpu_temp_c: 99, thermal_throttle: 0.9 } } : {} })),
  });
  push({
    name: 'a missing restart capability refuses every restart',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 99, thermal_throttle: 0.9 } }],
    config: { antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 }, maintenance: { enabled: true, safePointRequired: false } },
    restartCapability: 'unavailable',
    workerControlCapability: 'unavailable',
    epoch: local(1, 4, 5),
    steps: Array.from({ length: 12 }, (_, index) => ({ advanceMs: 5 * MINUTE, readings: index === 0 ? { hardware: { gpu_temp_c: 99, thermal_throttle: 0.9 } } : {} })),
  });
  push({
    name: 'a long critical run is paced by its cooldown',
    providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 99, thermal_throttle: 0.9 } }],
    config: { throttle: { concurrencyLimit: 2 }, maintenance: { enabled: true, safePointRequired: false } },
    epoch: local(1, 4, 5),
    steps: Array.from({ length: 60 }, () => ({ advanceMs: 30 * SECOND, readings: {} })),
  });

  // 9. the maintenance window phases across local wall-clock instants.
  for (const [hour, minute] of [[2, 0], [3, 29], [3, 30], [3, 45], [4, 0], [4, 1], [4, 10], [4, 59], [5, 0], [14, 0]]) {
    push({
      name: `maintenance phase at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 85 } }],
      config: { maintenance: { enabled: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' } },
      epoch: local(1, hour, minute),
      steps: [{ advanceMs: MINUTE, readings: { hardware: { gpu_temp_c: 85 } } }, { advanceMs: MINUTE, readings: {} }],
    });
  }
  // a wrapping window and a day boundary
  for (const day of [1, 2, 28]) {
    push({
      name: `maintenance target on local day ${day}`,
      providers: [{ id: 'hardware', group: 'hardware', metrics: { gpu_temp_c: 85 } }],
      config: { maintenance: { enabled: true, targetTime: '04:00', windowStart: '23:00', windowEnd: '02:00' } },
      epoch: local(day, 23, 30),
      steps: [{ advanceMs: HOUR, readings: { hardware: { gpu_temp_c: 85 } } }, { advanceMs: 3 * HOUR, readings: {} }],
    });
  }

  // 10. the seeded random matrix: interesting values chosen per metric per tick.
  const prng = seeded(0x5eed1234);
  for (let scenarioIndex = 0; scenarioIndex < 40; scenarioIndex += 1) {
    const providerId = prng.pick(['hardware', 'memory', 'runtime', 'workers', 'computer-use', 'ui', 'context']);
    const corpus = PROVIDER_OF[providerId].filter((metric) => metric in HEALTHY);
    const chosen = corpus.filter(() => prng.float() < 0.55);
    const metricsForScenario = chosen.length > 0 ? chosen : [corpus[0]];
    const readings = {};
    const draw = (metric) => {
      const metricConfig = metrics[metric];
      if (metricConfig?.band !== undefined) return prng.pick(bandEdgeValues(metricConfig.band));
      return prng.pick([HEALTHY[metric], HEALTHY[metric], HEALTHY[metric] * 1.05, HEALTHY[metric] * 1.4, HEALTHY[metric] * 2.2]);
    };
    for (const metric of metricsForScenario) readings[metric] = draw(metric);
    const steps = [];
    const tickCount = prng.int(4, 12);
    for (let index = 0; index < tickCount; index += 1) {
      // Every third tick re-draws the readings, so the run contains both holds
      // (which open the sustain gate) and changes (which move the trend fit).
      if (index % 3 === 0) for (const metric of metricsForScenario) readings[metric] = draw(metric);
      steps.push({
        advanceMs: prng.pick([SECOND, 15 * SECOND, MINUTE, 5 * MINUTE]),
        readings: index === 0 ? { [providerId]: { ...readings } } : {},
      });
    }
    push({
      name: `seeded matrix #${scenarioIndex} on ${providerId} (${metricsForScenario.join(', ')})`,
      providers: [{ id: providerId, group: providerId, metrics: metricsForScenario }],
      config: scenarioIndex % 7 === 0
        ? { antiFlap: { debounceEvaluations: prng.int(1, 3), minStateDwellMs: prng.pick([0, 60_000]), minRepeatActionMs: prng.pick([0, 300_000]) } }
        : {},
      steps,
    });
  }

  return scenarios;
}

/* --------------------------------------------------------- projection helpers */

/** The per-metric off-snapshot detail, recomputed from one side's own primitives. */
function metricProbe(side, config, metric, value, sustainedMs) {
  const metricConfig = config.metrics[metric];
  const band = metricConfig?.band;
  const bandKey = band === undefined ? null : side.bandKeyOf(metric, value, band);
  const raw = band === undefined ? null : side.scoreMetric(metric, value, band);
  const gated = band === undefined
    ? { score: null, rawScore: null, sustainedMs: 0, gated: false }
    : side.scoreWithSustain(metric, value, band, metricConfig.sustainMs ?? 0, sustainedMs);
  return { band: band ?? null, bandKey, raw, gated, rawLevel: side.levelOf(raw) };
}

/** Project one snapshot onto everything a consumer can observe. */
function projectSnapshot(side, config, snapshot) {
  const metricValues = {};
  for (const metric of Object.keys(snapshot.metrics).sort()) metricValues[metric] = snapshot.metrics[metric];
  return {
    timestamp: snapshot.timestamp,
    state: snapshot.state,
    action: snapshot.action,
    pressure: snapshot.pressure,
    pressureLevel: side.levelOf(snapshot.pressure),
    coverage: snapshot.coverage,
    primaryCause: snapshot.primaryCause,
    unknownDimensions: [...snapshot.unknownDimensions].sort(),
    dimensions: snapshot.dimensions.map((dimension) => ({
      dimension: dimension.dimension,
      score: dimension.score,
      level: dimension.level,
      weight: dimension.weight,
      effectiveWeight: dimension.effectiveWeight,
      summary: dimension.summary,
      metrics: dimension.metrics.map((metric) => ({
        metric: metric.metric,
        value: metric.value,
        score: metric.score,
        level: metric.level,
        rule: metric.rule,
        sustainedMs: metric.sustainedMs,
        trendApplied: metric.trendApplied,
        probe: metricProbe(side, config, metric.metric, metric.value, metric.sustainedMs),
      })),
    })),
    drivers: snapshot.drivers.map((driver) => ({ ...driver })),
    trends: snapshot.trends.map((trend) => ({ ...trend })),
    metrics: metricValues,
    maintenance: { ...snapshot.maintenance },
    readiness: { ...snapshot.readiness },
    capabilities: { ...snapshot.capabilities },
    providers: snapshot.providers.map((provider) => ({ ...provider })),
    recentDecisions: snapshot.recentDecisions.map((record) => projectDecision(record)),
    dailySummaries: snapshot.dailySummaries.map((day) => ({ ...day, metrics: day.metrics.map((metric) => ({ ...metric })) })),
    warnings: [...snapshot.warnings].sort(),
  };
}

/** Project one audit record onto the fields that constitute a decision. */
function projectDecision(record) {
  return {
    id: record.id,
    timestamp: record.timestamp,
    action: record.action,
    state: record.state,
    pressure: record.pressure,
    coverage: record.coverage,
    drivers: record.drivers.map((driver) => ({ ...driver })),
    reasons: [...record.reasons],
    outcome: { ...record.outcome },
  };
}

/* ------------------------------------------------------------- both engines */

/**
 * Build the facade for one side. Both sides expose the same constructor, so a
 * single runner serves both — which is itself part of the parity claim.
 */
function runnerFor(side) {
  return (scenario) => {
    let now = scenario.epoch ?? EPOCH;
    const config = side.resolveConfig(scenario.config ?? {});
    const restart = recordingRestart(scenario.restartCapability ?? 'available');
    const workerControl = recordingWorker(scenario.workerControlCapability ?? 'available');
    const safePoints = scenario.safePoint === undefined ? [] : [{ id: 'scripted', readiness: () => ({ ...scenario.safePoint }) }];
    const scheduler = new side.HealthScheduler({ config, restart, workerControl, stateDirectory: null, clock: () => now, safePoints });
    const decisions = [];
    scheduler.on('decision', (record) => decisions.push(record));
    const providers = [];
    for (const spec of scenario.providers) {
      // A spec may name its metrics as a list, or give the bag it starts with;
      // either way the provider reports exactly the metrics it lists.
      const provides = Array.isArray(spec.metrics) ? spec.metrics : Object.keys(spec.metrics);
      const provider = scriptedProvider(spec.id, spec.group, provides, () => now);
      if (!Array.isArray(spec.metrics)) Object.assign(provider.readings, spec.metrics);
      scheduler.registerProvider(provider);
      providers.push(provider);
    }
    return {
      config,
      restart,
      workerControl,
      decisions,
      providers,
      tick: async (step) => {
        for (const [id, values] of Object.entries(step.readings ?? {})) {
          const provider = providers.find((entry) => entry.id === id);
          for (const [metric, value] of Object.entries(values)) {
            if (value === null) delete provider.readings[metric];
            else provider.readings[metric] = value;
          }
        }
        now += step.advanceMs;
        return scheduler.tick();
      },
    };
  };
}

/** Drive one side through one scenario and collect everything observable. */
async function runScenario(runner, side, scenario) {
  const engine = runner(scenario);
  const ticks = [];
  for (const step of scenario.steps) ticks.push(projectSnapshot(side, engine.config, await engine.tick(step)));
  return {
    config: engine.config,
    ticks,
    decisions: engine.decisions.map(projectDecision),
    restartRequests: engine.restart.requests.map((request) => ({ ...request })),
    workerCalls: engine.workerControl.calls.map((call) => [...call]),
  };
}

/* ------------------------------------------------------------------ the test */

test(
  'the port matches the compiled donor on every scripted and seeded scenario',
  { skip: DONOR_PRESENT ? false : `donor build absent at ${DONOR_LIB}; build it per the header of this file to run the differential parity check` },
  async () => {
    const donor = await import(`file:///${DONOR_LIB.replace(/\\/g, '/')}`);
    // Three pure band helpers are only reachable from the donor's compiled
    // `core/bands.js`: the donor's own `index.ts` re-exports `LEVEL_BOUNDS`,
    // `levelOf`, `scoreMetric` and `scoreWithSustain` but not `bandKeyOf`,
    // `rampEndpoints` or `clamp`. The oracle is therefore `lib/index.js` plus that
    // one compiled submodule, which is the same file the port's `bands.mjs` came
    // from. The port publishes all three from its own index.
    const donorBands = await import(`file:///${DONOR_LIB.replace(/\\/g, '/').replace(/\/index\.js$/, '/core/bands.js')}`);
    const port = await import('../index.mjs');

    // A structural guard first: the port must publish every engine export the
    // donor's own build does. The four plugin-binding members are the only
    // deliberate omissions.
    const DROPPED = ['apply', 'applyHealthScheduler', 'name', 'inject'];
    const missing = Object.keys(donor).filter((key) => !DROPPED.includes(key) && !(key in port));
    assert.deepEqual(missing, [], 'the port publishes every non-binding donor export');

    const side = (module) => ({
      resolveConfig: module.resolveConfig,
      HealthScheduler: module.HealthScheduler,
      scoreMetric: module.scoreMetric,
      scoreWithSustain: module.scoreWithSustain,
      bandKeyOf: module.bandKeyOf,
      levelOf: module.levelOf,
      rampEndpoints: module.rampEndpoints,
      clamp: module.clamp,
    });
    const donorSide = side({ ...donor, ...donorBands });
    const portSide = side(port);

    // The band helpers themselves must agree, independently of any scenario.
    for (const [metric, config] of Object.entries(donorSide.resolveConfig({}).metrics)) {
      if (config.band === undefined) continue;
      assert.deepEqual(portSide.rampEndpoints(config.band), donorSide.rampEndpoints(config.band), `rampEndpoints(${metric})`);
      assert.deepEqual(portSide.rampEndpoints(config.band, 'lower-is-worse'), donorSide.rampEndpoints(config.band, 'lower-is-worse'), `rampEndpoints(${metric}, lower-is-worse)`);
      for (let score = 0; score <= 100; score += 1) {
        assert.equal(portSide.levelOf(score), donorSide.levelOf(score), `levelOf(${score})`);
      }
      for (let value = -10; value <= 110; value += 1) {
        assert.equal(portSide.scoreMetric(metric, value, config.band), donorSide.scoreMetric(metric, value, config.band), `scoreMetric(${metric}, ${value})`);
        assert.equal(portSide.bandKeyOf(metric, value, config.band), donorSide.bandKeyOf(metric, value, config.band), `bandKeyOf(${metric}, ${value})`);
      }
      for (const held of [0, 1, config.sustainMs ?? 0, (config.sustainMs ?? 0) + 1]) {
        assert.deepEqual(
          portSide.scoreWithSustain(metric, 1, config.band, config.sustainMs ?? 0, held),
          donorSide.scoreWithSustain(metric, 1, config.band, config.sustainMs ?? 0, held),
          `scoreWithSustain(${metric}, held=${held})`,
        );
      }
    }
    assert.deepEqual(portSide.clamp(-5, 0, 1), donorSide.clamp(-5, 0, 1));

    const scenarios = buildScenarios(donor.resolveConfig({}).metrics);
    const donorRunner = runnerFor(donorSide);
    const portRunner = runnerFor(portSide);

    let ticksCompared = 0;
    let decisionsCompared = 0;
    let metricsCompared = 0;
    const disagreements = [];
    const failed = new Set();
    /** Coverage census, so a green run is also a demonstrably wide run. */
    const seenActions = new Map();
    const seenReasons = new Set();
    let restartRequests = 0;
    let denialDecisions = 0;
    const DENIAL_REASONS = [
      'maintenance_window_closed', 'maintenance_before_target_time', 'maintenance_app_restart_disabled',
      'safe_point_unsafe', 'safe_point_unknown', 'restart_capability_unavailable',
      'system_reboot_requires_restart_adapter', 'urgent_override_active', 'escalation_overrides_safe_point',
      'hysteresis_holds_active_action', 'min_repeat_action_interval',
    ];

    for (const scenario of scenarios) {
      const expected = await runScenario(donorRunner, donorSide, scenario);
      const actual = await runScenario(portRunner, portSide, scenario);
      const record = (part, detail) => {
        failed.add(scenario.name);
        disagreements.push({ scenario: scenario.name, part, detail: String(detail).split('\n').slice(0, 40).join('\n') });
      };

      for (const entry of expected.decisions) {
        seenActions.set(entry.action, (seenActions.get(entry.action) ?? 0) + 1);
        let denied = false;
        for (const reason of entry.reasons) {
          seenReasons.add(reason);
          if (DENIAL_REASONS.includes(reason)) denied = true;
        }
        if (denied) denialDecisions += 1;
      }
      restartRequests += expected.restartRequests.length;

      try {
        assert.deepEqual(actual.config, expected.config);
      } catch (error) {
        record('resolved config', error.message);
        continue;
      }

      if (actual.ticks.length !== expected.ticks.length) {
        record('tick count', `${actual.ticks.length} vs ${expected.ticks.length}`);
        continue;
      }
      for (let index = 0; index < expected.ticks.length; index += 1) {
        ticksCompared += 1;
        metricsCompared += expected.ticks[index].dimensions.reduce((sum, dimension) => sum + dimension.metrics.length, 0);
        try {
          assert.deepEqual(actual.ticks[index], expected.ticks[index]);
        } catch (error) {
          record(`tick ${index}`, error.message);
        }
      }

      decisionsCompared += expected.decisions.length;
      try {
        assert.deepEqual(actual.decisions, expected.decisions);
      } catch (error) {
        record('decision stream', error.message);
      }
      try {
        assert.deepEqual(actual.restartRequests, expected.restartRequests);
      } catch (error) {
        record('restart requests', error.message);
      }
      try {
        assert.deepEqual(actual.workerCalls, expected.workerCalls);
      } catch (error) {
        record('worker-control calls', error.message);
      }
    }

    const agreed = scenarios.length - failed.size;
    const actionCensus = [...seenActions.entries()].sort().map(([action, count]) => `${action}=${count}`).join(' ');
    process.stdout.write(
      `differential: ${scenarios.length} scenarios compared, ${agreed} agreed, ${scenarios.length - agreed} disagreed; `
      + `${ticksCompared} ticks, ${metricsCompared} per-metric entries, ${decisionsCompared} decisions, `
      + `${restartRequests} restart requests, ${denialDecisions} decisions carrying a refusal reason\n`
      + `differential actions: ${actionCensus}\n`,
    );

    assert.deepEqual(
      disagreements,
      [],
      `${disagreements.length} disagreement(s) across ${scenarios.length} scenarios:\n`
        + disagreements.slice(0, 3).map((entry) => `  [${entry.scenario}] ${entry.part}:\n${entry.detail}`).join('\n'),
    );
    assert.ok(scenarios.length >= 70, `the matrix must be substantial, got ${scenarios.length}`);
    assert.ok(ticksCompared >= 200, `the matrix must exercise many ticks, got ${ticksCompared}`);
    assert.ok(metricsCompared >= 1000, `the matrix must exercise many metric evaluations, got ${metricsCompared}`);
    // A green run must also be a wide one: the ladder, the refusal reasons and the
    // request path all have to be genuinely exercised, or parity would be vacuous.
    assert.ok(decisionsCompared >= 15, `the matrix must produce decisions, got ${decisionsCompared}`);
    assert.ok(seenActions.has('THROTTLE'), 'the throttle rung must be exercised');
    assert.ok(seenActions.has('PAUSE_NEW_WORK'), 'the pause rung must be exercised');
    assert.ok(
      seenActions.has('REQUEST_APP_RESTART') || seenActions.has('REQUEST_SYSTEM_REBOOT'),
      'at least one restart must actually be requested',
    );
    assert.ok(restartRequests >= 1, 'an adapter must receive at least one request record');
    assert.ok(denialDecisions >= 3, `refusal reasons must be exercised, got ${denialDecisions}`);
    for (const required of ['maintenance_window_closed', 'safe_point_unsafe', 'safe_point_unknown', 'restart_capability_unavailable']) {
      assert.ok(seenReasons.has(required), `the matrix must exercise the refusal reason ${required}`);
    }
  },
);
