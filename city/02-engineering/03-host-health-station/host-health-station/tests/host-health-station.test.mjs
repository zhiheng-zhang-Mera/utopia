/**
 * UTOPIA · City · Host Health Station — module tests.
 *
 * Ported behaviour is pinned here at the level a reader needs: the exact band
 * ramp, the exact anti-flapping durations, the exact refusal reasons. Where the
 * donor's own suite already pins a value, the assertion is restated rather than
 * imported, because this module must be provable without the donor checkout.
 * `tests/differential.test.mjs` is the other half of the evidence: it drives the
 * compiled donor and this port through the same seeded scenarios and compares
 * every observable output.
 *
 * Plain `node:test` + `node:assert/strict`, no test framework and no fixture
 * directory. Every scenario is synthetic: the providers are scripted, the clock
 * is injected, and no test reads `node:os`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION_LEVEL,
  CANONICAL_METRICS,
  DECISION_LADDER,
  DEFAULT_METRIC_CONFIG,
  DecisionLog,
  HealthScheduler,
  LEVEL_BOUNDS,
  LOG_SCHEMA_VERSION,
  METRICS,
  PRESETS,
  PRESET_DOCUMENTS,
  PRESSURE_DIMENSIONS,
  PRESSURE_LEVEL_RANK,
  PolicyEngine,
  PressureEngine,
  ProviderRegistry,
  RollingStore,
  SafePointRegistry,
  StatsFileSource,
  TrendAnalyzer,
  UnavailableRestartAdapter,
  UnavailableWorkerControlAdapter,
  UPTIME_RAMP_FULL_MS,
  UPTIME_RAMP_START_MS,
  applySettingsUpdate,
  bandKeyOf,
  buildBuiltInProviders,
  clamp,
  defaultEnvironment,
  dimensionOf,
  extractMetrics,
  foldReadiness,
  formatBytes,
  formatSlopePerHour,
  initialActionAttempts,
  initialPolicyState,
  isCanonicalMetric,
  levelOf,
  maintenanceAllowsRequest,
  mergeBags,
  metricDescriptor,
  metricsSnapshot,
  normalizeSample,
  parseNameValueLines,
  parseSampleTime,
  preset,
  rampEndpoints,
  renderHealthReport,
  renderMetricRow,
  resolveConfig,
  runCommandProbe,
  scoreMetric,
  scoreWithSustain,
  tryResolveConfig,
  ConfigError,
  cooldownKindOf,
  cooldownMsOf,
  clockWithin,
  computeMaintenancePicture as picture,
  formatClock,
  formatDuration,
  nextOccurrence,
  parseClock,
  previousOccurrence,
  startOfLocalDay,
} from '../index.mjs';

/* ------------------------------------------------------------------- rig */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** A local-wall-clock instant the default maintenance window is open on. */
const EPOCH = Date.parse('2026-03-01T00:00:00.000Z');

/** A provider whose readings a test scripts directly. */
class ScriptedProvider {
  constructor(id, group, provides) {
    this.id = id;
    this.group = group;
    this.provides = provides;
    this.enabled = true;
    this.current = {};
    this.failures = [];
    this.samples = 0;
  }

  set(values) {
    for (const [metric, value] of Object.entries(values)) this.current[metric] = value;
    return this;
  }

  unset(...metrics) {
    for (const metric of metrics) delete this.current[metric];
    return this;
  }

  failNext(times = 1) {
    for (let index = 0; index < times; index += 1) this.failures.push(true);
    return this;
  }

  sample() {
    this.samples += 1;
    if (this.failures.length > 0) {
      this.failures.shift();
      throw new Error(`scripted failure #${this.samples}`);
    }
    const metrics = {};
    for (const metric of this.provides) if (metric in this.current) metrics[metric] = this.current[metric];
    return { provider: this.id, timestamp: new Date(Date.now()).toISOString(), metrics };
  }
}

/** A restart adapter that records requests instead of performing anything. */
class RecordingRestartAdapter {
  constructor(options = {}) {
    this.id = 'recording-restart';
    this.capability = options.capability ?? 'available';
    this.requests = [];
    this.accept = options.accept ?? true;
    this.throwOnRequest = options.throwOnRequest ?? false;
  }

  async requestApplicationRestart(request) {
    this.requests.push({ ...request, mode: 'application' });
    if (this.throwOnRequest) throw new Error('restart plugin exploded');
    return this.accept
      ? { accepted: true, state: 'queued', requestId: `r-${this.requests.length}` }
      : { accepted: false, state: 'rejected', reason: 'restart_cooldown_active' };
  }

  async requestSystemRestart(request) {
    this.requests.push({ ...request, mode: 'system' });
    if (this.throwOnRequest) throw new Error('restart plugin exploded');
    return this.accept
      ? { accepted: true, state: 'queued', requestId: `r-${this.requests.length}` }
      : { accepted: false, state: 'rejected', reason: 'system_restart_disabled' };
  }

  async cancelPendingRestart() {
    return true;
  }
}

/** A worker-control adapter that records calls. */
class RecordingWorkerControl {
  constructor(options = {}) {
    this.id = 'recording-worker-control';
    this.capability = options.capability ?? 'available';
    this.calls = [];
    this.limit = null;
  }

  async setConcurrencyLimit(limit) {
    this.calls.push(['setConcurrencyLimit', limit]);
    this.limit = limit;
  }

  async pauseNewWorkers() {
    this.calls.push(['pauseNewWorkers']);
  }

  async resumeNormalConcurrency() {
    this.calls.push(['resumeNormalConcurrency']);
    this.limit = null;
  }

  currentConcurrencyLimit() {
    return this.limit;
  }
}

/** A scheduler with an injected clock and recording adapters, plus a tick loop. */
class Rig {
  constructor(options = {}) {
    this.now = options.epoch ?? EPOCH;
    this.config = resolveConfig(options.config ?? {});
    this.restart = options.restart ?? new RecordingRestartAdapter();
    this.workerControl = options.workerControl ?? new RecordingWorkerControl();
    this.scheduler = new HealthScheduler({
      config: this.config,
      restart: this.restart,
      workerControl: this.workerControl,
      stateDirectory: null,
      clock: () => this.now,
      ...(options.safePoints === undefined ? {} : { safePoints: options.safePoints }),
    });
    this.history = [];
    this.decisions = [];
    this.scheduler.on('decision', (record) => this.decisions.push(record));
  }

  provider(id, group, provides) {
    const provider = new ScriptedProvider(id, group, provides);
    this.scheduler.registerProvider(provider);
    return provider;
  }

  async advance(ms, steps = 1) {
    const stepMs = Math.round(ms / steps);
    const snapshots = [];
    for (let index = 0; index < steps; index += 1) {
      this.now += stepMs;
      const snapshot = await this.scheduler.tick();
      this.history.push(snapshot);
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  get last() {
    return this.history[this.history.length - 1];
  }

  get actions() {
    return this.decisions.map((record) => record.action);
  }
}

const MODULE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Source of every shipped `.mjs` file, for the "no process control" proof. */
function moduleSources() {
  return readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => ({ name, text: readFileSync(join(MODULE_DIR, name), 'utf8') }));
}

/* -------------------------------------------------- vocabulary and bounds */

test('the canonical registry is sorted, unique, complete and prototype-safe', () => {
  assert.ok(CANONICAL_METRICS.length >= 40);
  assert.deepEqual(CANONICAL_METRICS, [...CANONICAL_METRICS].sort(), 'the exported list is sorted');
  assert.equal(new Set(CANONICAL_METRICS).size, CANONICAL_METRICS.length, 'no duplicates');
  for (const name of CANONICAL_METRICS) {
    const descriptor = metricDescriptor(name);
    assert.ok(descriptor, `${name} has a descriptor`);
    assert.equal(descriptor.name, name);
    assert.ok(descriptor.description.length > 0, `${name} has a description`);
    assert.ok(['celsius', 'ratio', 'bytes', 'count', 'milliseconds', 'seconds', 'per-minute'].includes(descriptor.unit));
    assert.ok(['higher-is-worse', 'lower-is-worse'].includes(descriptor.polarity));
  }
  assert.equal(isCanonicalMetric('gpu_temp_c'), true);
  assert.equal(isCanonicalMetric('gpu_temp'), false);
  assert.equal(isCanonicalMetric('__proto__'), false);
  assert.equal(isCanonicalMetric('toString'), false);
});

test('hard physical bounds are declared exactly where the donor declared them', () => {
  assert.equal(METRICS.cpu_temp_c.hardMax, 130);
  assert.equal(METRICS.cpu_temp_c.hardMin, -20);
  assert.equal(METRICS.ram_used_ratio.hardMax, 1);
  assert.equal(METRICS.process_rss_bytes.hardMax, undefined, 'an unbounded leak metric has no max');
  assert.equal(METRICS.recovery_rate.polarity, 'lower-is-worse');
  assert.equal(METRICS.ram_available_bytes.polarity, 'lower-is-worse');
});

test('the dimension dispatch table covers every canonical metric with two named exceptions', () => {
  for (const metric of CANONICAL_METRICS) {
    assert.ok(PRESSURE_DIMENSIONS.includes(dimensionOf(metric)), `${metric} maps to a dimension`);
  }
  assert.equal(dimensionOf('task_failure_rate'), 'worker', 'a context metric dispatched to worker');
  assert.equal(dimensionOf('git_operations_per_minute'), 'time', 'a context metric dispatched to time');
  assert.equal(dimensionOf('uptime_seconds'), 'time');
  assert.equal(dimensionOf('handle_count'), 'runtime');
  assert.equal(dimensionOf('not_a_metric'), 'runtime', 'the fallback is runtime');
});

test('the three shipped preset documents are the documents the code builds', () => {
  for (const name of ['conservative', 'balanced', 'aggressive']) {
    assert.deepEqual(PRESET_DOCUMENTS[name], preset(name), `${name} document matches the built preset`);
  }
  assert.deepEqual(PRESET_DOCUMENTS.balanced, PRESETS.balanced);
  assert.equal(PRESETS.balanced.weights.time + PRESETS.balanced.weights.thermal + PRESETS.balanced.weights.memory
    + PRESETS.balanced.weights.runtime + PRESETS.balanced.weights.worker + PRESETS.balanced.weights.computer_use_ui, 1);
  assert.deepEqual(DECISION_LADDER, ['NO_ACTION', 'THROTTLE', 'PAUSE_NEW_WORK', 'REQUEST_APP_RESTART', 'REQUEST_SYSTEM_REBOOT']);
  assert.equal(ACTION_LEVEL.REQUEST_SYSTEM_REBOOT, 4);
  assert.equal(PRESSURE_LEVEL_RANK.unknown, -1);
});

/* ------------------------------------------------------------ band ramp */

test('ramp endpoints come from polarity, never from the written order', () => {
  assert.deepEqual(rampEndpoints({ warn: 78, critical: 92 }, 'higher-is-worse'), [78, 92]);
  assert.deepEqual(rampEndpoints({ warn: 0.8, critical: 0.3 }, 'lower-is-worse'), [0.8, 0.3]);
  assert.deepEqual(rampEndpoints({ warn: 92, critical: 78 }, 'higher-is-worse'), [78, 92], 'a swapped band normalises');
  assert.deepEqual(rampEndpoints({ warn: 0.3, critical: 0.8 }, 'lower-is-worse'), [0.8, 0.3]);
});

test('the ramp is linear, rounded to an integer, and clamped at both ends', () => {
  const band = { warn: 78, critical: 92 };
  assert.equal(scoreMetric('gpu_temp_c', 70, band), 0, 'below warn scores zero');
  assert.equal(scoreMetric('gpu_temp_c', 78, band), 0, 'the warn endpoint is inclusive');
  assert.equal(scoreMetric('gpu_temp_c', 81, band), 21, '3/14 rounds to 21, not 21.43');
  assert.equal(scoreMetric('gpu_temp_c', 85, band), 50, 'the midpoint is exactly 50');
  assert.equal(scoreMetric('gpu_temp_c', 92, band), 100);
  assert.equal(scoreMetric('gpu_temp_c', 99, band), 100, 'the ramp saturates, it has no tail');
  assert.equal(scoreMetric('cpu_temp_c', 80, { warn: 80, critical: 95 }), 0);
  assert.equal(scoreMetric('cpu_temp_c', 88, { warn: 80, critical: 95 }), 53);
  assert.equal(scoreMetric('ram_available_bytes', 3 * 1024 ** 3, { warn: 4 * 1024 ** 3, critical: 512 * 1024 ** 2 }), 29);
});

test('a lower-is-worse band ramps the other way and tolerates either written order', () => {
  assert.equal(scoreMetric('recovery_rate', 0.9, { warn: 0.8, critical: 0.3 }), 0);
  assert.equal(scoreMetric('recovery_rate', 0.3, { warn: 0.8, critical: 0.3 }), 100);
  assert.equal(scoreMetric('recovery_rate', 0.55, { warn: 0.8, critical: 0.3 }), 50);
  assert.equal(scoreMetric('recovery_rate', 0.55, { warn: 0.3, critical: 0.8 }), 50, 'the same ramp, written either way');
  assert.equal(scoreMetric('ram_available_bytes', 512 * 1024 ** 2, { warn: 512 * 1024 ** 2, critical: 4 * 1024 ** 3 }), 100);
});

test('an unknown value scores null and levels as unknown, never as none', () => {
  assert.equal(scoreMetric('gpu_temp_c', null, { warn: 78, critical: 92 }), null);
  assert.equal(levelOf(null), 'unknown');
  assert.equal(levelOf(0), 'none', 'zero is a real measurement of zero');
  assert.notEqual(levelOf(null), levelOf(0));
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

test('the level boundaries are exactly 0 / 35 / 65 / 85', () => {
  assert.deepEqual(LEVEL_BOUNDS, { low: 0, moderate: 35, high: 65, critical: 85 });
  assert.equal(levelOf(0), 'none');
  assert.equal(levelOf(1), 'low');
  assert.equal(levelOf(34), 'low');
  assert.equal(levelOf(35), 'moderate');
  assert.equal(levelOf(64), 'moderate');
  assert.equal(levelOf(65), 'high');
  assert.equal(levelOf(84), 'high');
  assert.equal(levelOf(85), 'critical');
  assert.equal(levelOf(100), 'critical');
  assert.equal(levelOf(Number.NaN), 'unknown');
});

test('the sustain gate holds a spike at zero and opens exactly at the configured duration', () => {
  const band = { warn: 78, critical: 92 };
  const gated = scoreWithSustain('gpu_temp_c', 88, band, 60_000, 5_000);
  assert.deepEqual(gated, { score: 0, rawScore: 71, sustainedMs: 5_000, gated: true });
  const open = scoreWithSustain('gpu_temp_c', 88, band, 60_000, 60_000);
  assert.deepEqual(open, { score: 71, rawScore: 71, sustainedMs: 60_000, gated: false });
  assert.equal(scoreWithSustain('gpu_temp_c', 88, band, 0, 0).score, 71, 'a zero gate disables the gate');
  assert.deepEqual(
    scoreWithSustain('gpu_temp_c', null, band, 60_000, 600_000),
    { score: null, rawScore: null, sustainedMs: 0, gated: false },
    'unknown stays unknown however long it has been unknown',
  );
});

test('band identity is derived the same way the store times it', () => {
  assert.equal(bandKeyOf('gpu_temp_c', 93, { warn: 78, critical: 92 }), 'gpu_temp_c:critical');
  assert.equal(bandKeyOf('gpu_temp_c', 80, { warn: 78, critical: 92 }), 'gpu_temp_c:warn');
  assert.equal(bandKeyOf('gpu_temp_c', 70, { warn: 78, critical: 92 }), null);
  // DONOR BUG, reproduced deliberately: for a lower-is-worse metric the donor's
  // branch tests `value <= best` before `value <= worst`, and since best > worst
  // the second test is unreachable. So `:warn` is never returned for
  // `ram_available_bytes` or `recovery_rate`; everything at or below the warn
  // endpoint times as `:critical`. The port keeps this exactly, because the
  // sustain gate reads the key and a "fix" would change when a gate opens.
  const band = { warn: 4 * 1024 ** 3, critical: 512 * 1024 ** 2 };
  assert.equal(bandKeyOf('ram_available_bytes', 5 * 1024 ** 3, band), null);
  assert.equal(bandKeyOf('ram_available_bytes', 3 * 1024 ** 3, band), 'ram_available_bytes:critical');
  assert.equal(bandKeyOf('ram_available_bytes', 1 * 1024 ** 3, band), 'ram_available_bytes:critical');
  assert.equal(bandKeyOf('ram_available_bytes', 512 * 1024 ** 2, band), 'ram_available_bytes:critical');
  assert.equal(bandKeyOf('recovery_rate', 0.9, { warn: 0.8, critical: 0.3 }), null);
  assert.equal(bandKeyOf('recovery_rate', 0.5, { warn: 0.8, critical: 0.3 }), 'recovery_rate:critical');
});

/* ---------------------------------------------------------- normalization */

const sample = (metrics) => ({ provider: 'test', timestamp: '2026-01-01T00:00:00.000Z', metrics });

test('a ratio above 1 and at most 1.5 clamps to 1 with a violation, not a rejection', () => {
  const result = normalizeSample(sample({ cpu_usage: 1.2 }));
  assert.equal(result.metrics.cpu_usage, 1);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].reason, 'clamped');
  assert.equal(result.violations[0].metric, 'cpu_usage');
  assert.match(result.violations[0].detail, /percentage/);
  assert.equal(normalizeSample(sample({ cpu_usage: 1 })).metrics.cpu_usage, 1, 'exactly 1 is not clamped');
  assert.equal(normalizeSample(sample({ cpu_usage: 1.5 })).metrics.cpu_usage, 1, 'the clamp reaches 1.5');
});

test('a ratio above 1.5 is rejected as above_hard_max', () => {
  const result = normalizeSample(sample({ cpu_usage: 1.5000001 }));
  assert.deepEqual(result.metrics, {});
  assert.equal(result.violations[0].reason, 'above_hard_max');
  assert.equal(normalizeSample(sample({ cpu_usage: 42 })).violations[0].reason, 'above_hard_max');
});

test('impossible physical values are rejected below and above the hard bound', () => {
  assert.equal(normalizeSample(sample({ cpu_temp_c: 4000 })).violations[0].reason, 'above_hard_max');
  assert.equal(normalizeSample(sample({ cpu_temp_c: -300 })).violations[0].reason, 'below_hard_min');
  assert.equal(normalizeSample(sample({ cpu_usage: -1 })).violations[0].reason, 'below_hard_min');
  const both = normalizeSample(sample({ cpu_temp_c: 4000, cpu_usage: -1 }));
  assert.deepEqual(both.metrics, {});
  assert.deepEqual(both.violations.map((violation) => `${violation.metric}:${violation.reason}`).sort(), [
    'cpu_temp_c:above_hard_max',
    'cpu_usage:below_hard_min',
  ]);
});

test('a value just outside the hard bound is snapped rather than rejected (the 1e-9 tolerance)', () => {
  const justOver = normalizeSample(sample({ cpu_temp_c: 130 + 1e-12 }));
  assert.deepEqual(justOver.metrics, { cpu_temp_c: 130 }, 'inside the relative tolerance it snaps to the bound');
  assert.deepEqual(justOver.violations, []);
  const clearlyOver = normalizeSample(sample({ cpu_temp_c: 130 + 1e-6 }));
  assert.deepEqual(clearlyOver.metrics, {}, 'outside the tolerance it is rejected');
  assert.equal(clearlyOver.violations[0].reason, 'above_hard_max');
  const below = normalizeSample(sample({ cpu_usage: -1e-12 }));
  assert.deepEqual(below.metrics, { cpu_usage: 0 });
  assert.deepEqual(below.violations, []);
  const clearlyBelow = normalizeSample(sample({ cpu_usage: -1e-6 }));
  assert.deepEqual(clearlyBelow.metrics, {});
  assert.equal(clearlyBelow.violations[0].reason, 'below_hard_min');
  // A value strictly inside the bound is left alone rather than rounded up to it.
  assert.deepEqual(normalizeSample(sample({ cpu_temp_c: 130 - 1e-12 })).metrics, { cpu_temp_c: 130 - 1e-12 });
});

test('non-numbers, NaN and Infinity are violations and the survivors come back name-sorted', () => {
  const result = normalizeSample(sample({ cpu_temp_c: Number.NaN, gpu_temp_c: Number.POSITIVE_INFINITY, cpu_usage: '0.5' }));
  assert.deepEqual(result.metrics, {});
  assert.deepEqual(result.violations.map((violation) => `${violation.metric}:${violation.reason}`).sort(), [
    'cpu_temp_c:not_finite',
    'cpu_usage:not_a_number',
    'gpu_temp_c:not_finite',
  ]);
  const sorted = normalizeSample(sample({ gpu_temp_c: 60, cpu_temp_c: 50, cpu_usage: 0.1 }));
  assert.deepEqual(Object.keys(sorted.metrics), ['cpu_temp_c', 'cpu_usage', 'gpu_temp_c']);
  assert.deepEqual(sorted.violations, []);
});

test('a non-canonical metric name is a violation, and an absent metric is never invented', () => {
  const result = normalizeSample(sample({ gpu_temp: 60 }));
  assert.deepEqual(result.metrics, {});
  assert.equal(result.violations[0].reason, 'not_canonical');
  const empty = normalizeSample(sample({}));
  assert.deepEqual(empty.metrics, {});
  assert.equal('gpu_temp_c' in empty.metrics, false);
  assert.equal(parseSampleTime('2026-01-01T00:00:00.000Z'), Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(parseSampleTime('not-a-date'), null);
  assert.equal(parseSampleTime(''), null);
});

/* ----------------------------------------------------------- rolling window */

test('window statistics are exact, and a metric with no data has null statistics rather than zeros', () => {
  const store = new RollingStore(resolveConfig({}).windows);
  const base = 1_000_000;
  for (let index = 0; index < 100; index += 1) store.record('gpu_temp_c', 60 + index * 0.2, base + index * 1000);
  const stats = store.stats('gpu_temp_c', 5 * MINUTE, base + 100 * 1000);
  assert.equal(stats.count, 100);
  assert.equal(stats.min, 60);
  assert.equal(stats.max, 79.8);
  assert.ok(Math.abs(stats.mean - 69.9) < 0.01);
  assert.ok(stats.p95 >= 78);
  assert.equal(stats.latest, 79.8);
  assert.equal(stats.earliest, 60);
  assert.equal(stats.spanMs, 99 * 1000);

  const empty = store.stats('ram_used_ratio', 5 * MINUTE, base + 100 * 1000);
  assert.equal(empty.count, 0);
  assert.equal(empty.mean, null);
  assert.equal(empty.p95, null);
  assert.equal(empty.max, null);
  assert.equal(empty.latest, null);
  assert.equal(empty.slopePerHour, null);
  assert.equal(store.latest('ram_used_ratio'), null);
});

test('the raw retention floor is raised to the longest configured window', () => {
  const config = resolveConfig({ windows: { rawMs: 5 * MINUTE, windowsMs: [5 * MINUTE, 30 * MINUTE] } });
  assert.equal(config.windows.rawMs, 30 * MINUTE, 'rawMs is a minimum, never a cap');
  const store = new RollingStore(config.windows);
  const base = 10_000_000;
  for (let index = 0; index < 500; index += 1) store.record('cpu_usage', 0.5, base + index * MINUTE);
  const kept = store.rawPoints('cpu_usage', 24 * HOUR, base + 500 * MINUTE);
  assert.equal(kept.length, 31, 'only the rawMs horizon survives');
  assert.equal(kept[0].t - base, 469 * MINUTE);

  const explicit = resolveConfig({ windows: { rawMs: 12 * HOUR, windowsMs: [5 * MINUTE, 30 * MINUTE] } });
  assert.equal(explicit.windows.rawMs, 12 * HOUR);
});

test('band timing restarts on a band change and on leaving every band', () => {
  const store = new RollingStore(resolveConfig({}).windows);
  const base = 1_000_000;
  assert.equal(store.declareBand('gpu_temp_c', 'gpu_temp_c:warn', base), 0);
  assert.equal(store.declareBand('gpu_temp_c', 'gpu_temp_c:warn', base + 30_000), 30_000);
  assert.equal(store.declareBand('gpu_temp_c', 'gpu_temp_c:critical', base + 45_000), 0, 'a new band restarts the clock');
  assert.equal(store.declareBand('gpu_temp_c', null, base + 50_000), 0, 'leaving every band restarts the clock');
  assert.equal(store.declareBand('gpu_temp_c', 'gpu_temp_c:warn', base + 90_000), 0, 're-entering restarts it again');
  assert.equal(store.declareBand('gpu_temp_c', 'gpu_temp_c:warn', base + 120_000), 30_000);
});

test('recording a bag declares band identity, so the sustain gate times the data not the question', () => {
  const store = new RollingStore(resolveConfig({}).windows);
  store.recordBag({ gpu_temp_c: 88 }, EPOCH, (metric, value) => bandKeyOf(metric, value, { warn: 78, critical: 92 }));
  assert.equal(store.consecutiveMs('gpu_temp_c', EPOCH), 0);
  assert.equal(store.consecutiveMs('gpu_temp_c', EPOCH + 45_000), 45_000);
  store.recordBag({ gpu_temp_c: 88 }, EPOCH + 60_000, (metric, value) => bandKeyOf(metric, value, { warn: 78, critical: 92 }));
  assert.equal(store.consecutiveMs('gpu_temp_c', EPOCH + 60_000), 60_000, 'holding the same band keeps accumulating');
});

test('the store is bounded: raw points and buckets are pruned by construction', () => {
  const config = resolveConfig({ windows: { windowsMs: [5 * MINUTE, 30 * MINUTE] } });
  const store = new RollingStore(config.windows);
  const base = 1_000_000;
  for (let index = 0; index < 20_000; index += 1) store.record('cpu_usage', 0.3, base + index * 1000);
  assert.ok(store.size() <= 1850, `size ${store.size()} must stay near the 30 min horizon at 1 Hz`);
  assert.ok(store.size() >= 1750, `size ${store.size()} must still hold the whole horizon`);
  assert.ok(store.buckets('cpu_usage').length <= 24 * 12 + 1, 'buckets are pruned to the aggregate retention');
});

test('daily summaries are per local calendar day, weighted by sample count, metrics sorted', () => {
  const config = resolveConfig({ windows: { aggregateRetentionMs: 7 * 24 * HOUR } });
  const store = new RollingStore(config.windows);
  const day1 = new Date(2026, 2, 1, 10, 0, 0, 0).getTime();
  const day2 = day1 + 24 * HOUR;
  for (let i = 0; i < 60; i += 1) {
    for (let j = 0; j < 60; j += 1) store.record('cpu_usage', 0.5, day1 + i * MINUTE + j * 1000);
  }
  for (let j = 0; j < 60; j += 1) store.record('cpu_usage', 0.9, day2 + j * 1000);
  const days = store.dailySummaries(day2 + HOUR);
  assert.equal(days.length, 2);
  assert.equal(new Date(days[0].dayStart).getDate(), 1);
  assert.equal(days[0].metrics[0].count, 3600, 'the mean combines by sample count, not a mean of means');
  assert.ok(Math.abs(days[0].metrics[0].mean - 0.5) < 0.001);
  assert.equal(days[0].metrics[0].max, 0.5);
  assert.equal(days[1].metrics[0].count, 60);
  assert.ok(Math.abs(days[1].metrics[0].mean - 0.9) < 0.001);

  const sortStore = new RollingStore(resolveConfig({}).windows);
  const at = new Date(2026, 2, 1, 9, 0, 0, 0).getTime();
  sortStore.record('gpu_temp_c', 60, at);
  sortStore.record('cpu_temp_c', 55, at);
  sortStore.record('cpu_usage', 0.2, at);
  assert.deepEqual(sortStore.dailySummaries(at + MINUTE)[0].metrics.map((entry) => entry.metric), [
    'cpu_temp_c', 'cpu_usage', 'gpu_temp_c',
  ]);
});

/* -------------------------------------------------------------------- trend */

test('a sustained leak is a trusted worsening trend with an exact slope and R²', () => {
  const config = resolveConfig({});
  const store = new RollingStore(config.windows);
  const trends = new TrendAnalyzer(store, config.trend);
  const base = 1_000_000;
  for (let index = 0; index <= 240; index += 1) {
    store.record('process_rss_bytes', 2_000_000_000 + index * MINUTE * (200_000_000 / HOUR), base + index * MINUTE);
  }
  const trend = trends.evaluate('process_rss_bytes', base + 240 * MINUTE, 6 * HOUR);
  assert.equal(trend.direction, 'rising');
  assert.equal(trend.isWorsening, true);
  assert.ok(trend.rSquared > 0.99);
  assert.ok(Math.abs(trend.slopePerHour - 200_000_000) < 5_000_000);
  assert.match(trend.summary, /\/h/);
});

test('noise is not trusted, and polarity decides which direction is worsening', () => {
  const config = resolveConfig({});
  const store = new RollingStore(config.windows);
  const trends = new TrendAnalyzer(store, config.trend);
  const base = 1_000_000;
  const noisy = [70, 88, 71, 69, 90, 70, 72, 68, 89, 71, 70, 73, 69, 91, 70];
  noisy.forEach((value, index) => store.record('gpu_temp_c', value, base + index * MINUTE));
  const noise = trends.evaluate('gpu_temp_c', base + 15 * MINUTE, 6 * HOUR);
  assert.equal(noise.isWorsening, false);
  assert.ok(noise.rSquared < 0.5);

  const fallingStore = new RollingStore(config.windows);
  const falling = new TrendAnalyzer(fallingStore, config.trend);
  for (let index = 0; index < 60; index += 1) fallingStore.record('gpu_temp_c', 90 - index * 0.5, base + index * MINUTE);
  const cooling = falling.evaluate('gpu_temp_c', base + 60 * MINUTE, 6 * HOUR);
  assert.equal(cooling.direction, 'falling');
  assert.equal(cooling.isWorsening, false, 'a falling temperature is a strong trend and not a problem');

  const recoveryStore = new RollingStore(config.windows);
  const recovery = new TrendAnalyzer(recoveryStore, config.trend);
  for (let index = 0; index < 60; index += 1) recoveryStore.record('recovery_rate', 0.9 - index * 0.008, base + index * MINUTE);
  const degrading = recovery.evaluate('recovery_rate', base + 60 * MINUTE, 6 * HOUR);
  assert.equal(degrading.direction, 'falling');
  assert.equal(degrading.isWorsening, true, 'a falling recovery rate is worsening');
});

test('the trend gates produce unknown rather than a guess', () => {
  const config = resolveConfig({});
  const store = new RollingStore(config.windows);
  const trends = new TrendAnalyzer(store, config.trend);
  const base = 1_000_000;
  for (let index = 0; index < 5; index += 1) store.record('process_rss_bytes', 1e9 + index * 1e7, base + index * 1000);
  const trend = trends.evaluate('process_rss_bytes', base + 5000, 6 * HOUR);
  assert.equal(trend.direction, 'unknown');
  assert.equal(trend.slopePerHour, null);
  assert.equal(trend.isWorsening, false);
  assert.match(trend.summary, /insufficient observation/);
  assert.equal(trend.count, 5);
  assert.ok(trend.spanMs < config.trend.minSpanMs);
});

test('past the raw horizon the aggregate buckets take over, and the summary says so', () => {
  const config = resolveConfig({ windows: { windowsMs: [5 * MINUTE, 30 * MINUTE] } });
  const store = new RollingStore(config.windows);
  const trends = new TrendAnalyzer(store, config.trend);
  const base = 1_000_000;
  for (let index = 0; index <= 120; index += 1) {
    store.record('process_rss_bytes', 2_000_000_000 + index * MINUTE * (300_000_000 / HOUR), base + index * MINUTE);
  }
  const trend = trends.evaluate('process_rss_bytes', base + 120 * MINUTE, 2 * HOUR);
  assert.equal(trend.isWorsening, true);
  assert.ok(Math.abs(trend.slopePerHour - 300_000_000) < 10_000_000);
  assert.ok(trend.rSquared > 0.99);
  assert.match(trend.summary, /aggregate buckets/, 'the summary must say which series it fitted');
});

test('trend formatting keeps the donor precision asymmetry', () => {
  assert.equal(formatBytes(1_500_000_000), '1.40 GB');
  assert.equal(formatBytes(2_500_000), '2.4 MB');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatSlopePerHour('process_rss_bytes', 400_000_000), '381.5 MB/h');
  assert.equal(formatSlopePerHour('gpu_temp_c', 12), '12.00 °C/h');
});

/* ----------------------------------------------------------------- pressure */

/** A store with recorded values and declared bands, for direct engine driving. */
function seededEngine(readings, options = {}) {
  const config = resolveConfig(options.config ?? {});
  const store = new RollingStore(config.windows);
  const trends = new TrendAnalyzer(store, config.trend);
  const engine = new PressureEngine(store, trends, config);
  const step = options.stepMs ?? MINUTE;
  const span = options.spanMs ?? 20 * MINUTE;
  const start = options.startMs ?? EPOCH;
  for (let elapsed = 0; elapsed <= span; elapsed += step) {
    const at = start + elapsed;
    const bag = {};
    for (const [metric, value] of Object.entries(readings)) {
      if (value === null) continue;
      bag[metric] = value;
    }
    store.recordBag(bag, at, (metric, value) => {
      const band = config.metrics[metric]?.band;
      return band === undefined ? null : bandKeyOf(metric, value, band);
    });
  }
  return { engine, config, store, trends, nowMs: start + span, timestamp: new Date(start + span).toISOString() };
}

test('missing telemetry is not health: an unmeasured dimension is unknown with a null score', () => {
  const { engine, nowMs, timestamp } = seededEngine({ cpu_temp_c: 50 });
  const snapshot = engine.evaluate({ nowMs, timestamp, uptimeMs: null, restartCount: null });
  const thermal = snapshot.dimensions.find((entry) => entry.dimension === 'thermal');
  assert.equal(thermal.score, 0, 'a measured calm metric scores zero');
  assert.equal(thermal.level, 'none');
  assert.notEqual(thermal.level, 'unknown');
  const worker = snapshot.dimensions.find((entry) => entry.dimension === 'worker');
  assert.equal(worker.score, null, 'no telemetry is null, not zero');
  assert.equal(worker.level, 'unknown');
  assert.equal(worker.effectiveWeight, 0);
  assert.match(worker.summary, /no telemetry \(unknown\)/);
  assert.ok(snapshot.unknownDimensions.includes('worker'));
  assert.ok(snapshot.unknownDimensions.includes('memory'));
});

test('the weight of a missing dimension is redistributed, and the redistribution is published as coverage', () => {
  const { engine, nowMs, timestamp } = seededEngine({ cpu_temp_c: 50 });
  const snapshot = engine.evaluate({ nowMs, timestamp, uptimeMs: null, restartCount: null });
  const nominalTotal = PRESSURE_DIMENSIONS.reduce((sum, name) => sum + (resolveConfig({}).weights[name] ?? 0), 0);
  const thermal = snapshot.dimensions.find((entry) => entry.dimension === 'thermal');
  const expectedCoverage = Math.round((thermal.weight / nominalTotal) * 1000) / 1000;
  assert.equal(snapshot.coverage, expectedCoverage, 'coverage is the known share of nominal weight rounded to 3dp');
  assert.equal(thermal.effectiveWeight, 1, 'the one known dimension carries the whole answer');
  assert.equal(snapshot.restartPressure, 0, 'renormalisation is not an average over the missing dimensions');
});

test('with nothing measured at all the pressure is null and the coverage is zero', () => {
  const { engine, nowMs, timestamp } = seededEngine({});
  const snapshot = engine.evaluate({ nowMs, timestamp, uptimeMs: null, restartCount: null });
  assert.equal(snapshot.restartPressure, null, 'null, not 0');
  assert.equal(snapshot.coverage, 0);
  assert.deepEqual(snapshot.unknownDimensions, [...PRESSURE_DIMENSIONS]);
  assert.equal(snapshot.primaryCause, null);
  assert.equal(snapshot.drivers.length, 0);
  for (const dimension of snapshot.dimensions) {
    assert.equal(dimension.score, null);
    assert.equal(dimension.level, 'unknown');
    assert.equal(dimension.effectiveWeight, 0);
  }
});

test('the worst metric leads: a dimension score is half weighted mean, half worst member', () => {
  const readings = {
    cpu_temp_c: 84, cpu_usage: 0.9, gpu_temp_c: 88, gpu_usage: 0.95, thermal_throttle: 0.05, power_limit_hit: 0,
  };
  const { engine, nowMs, timestamp } = seededEngine(readings, { spanMs: 25 * MINUTE });
  const snapshot = engine.evaluate({ nowMs, timestamp, uptimeMs: null, restartCount: null });
  const thermal = snapshot.dimensions.find((entry) => entry.dimension === 'thermal');
  const byMetric = Object.fromEntries(thermal.metrics.map((entry) => [entry.metric, entry]));
  // the raw scores are the documented ramp values
  assert.equal(byMetric.cpu_temp_c.score, 27);
  assert.equal(byMetric.cpu_usage.score, 71);
  assert.equal(byMetric.gpu_temp_c.score, 71);
  assert.equal(byMetric.gpu_usage.score, 89);
  assert.equal(byMetric.thermal_throttle.score, 8);
  assert.equal(byMetric.power_limit_hit.score, 0);
  // weighted mean = 274 / 7.5 = 36.533; 0.5 * 36.533 + 0.5 * 89 = 63.267 -> 63
  assert.equal(thermal.score, 63);
  assert.equal(thermal.level, 'moderate');
  assert.match(thermal.summary, /led by gpu_usage=/);
});

test('a single critical metric is not averaged away by calm ones, and no known metric means null', () => {
  const combined = seededEngine({ gpu_usage: 0.95, cpu_usage: 0, cpu_temp_c: 0, gpu_temp_c: 0, thermal_throttle: 0, power_limit_hit: 0 });
  const thermal = combined.engine
    .evaluate({ nowMs: combined.nowMs, timestamp: combined.timestamp, uptimeMs: null, restartCount: null })
    .dimensions.find((entry) => entry.dimension === 'thermal');
  assert.ok(thermal.score >= 45, `one 100 among five zeros must dominate, got ${thermal.score}`);

  const allUnknown = seededEngine({});
  assert.equal(allUnknown.engine.evaluate({ nowMs: allUnknown.nowMs, timestamp: allUnknown.timestamp, uptimeMs: null, restartCount: null })
    .dimensions.find((entry) => entry.dimension === 'thermal').score, null);
});

test('the time dimension is the uptime ramp from 8 hours to 336 hours', () => {
  assert.equal(UPTIME_RAMP_START_MS, 8 * HOUR);
  assert.equal(UPTIME_RAMP_FULL_MS, 14 * 24 * HOUR);
  const { engine, nowMs, timestamp } = seededEngine({});
  for (const [hours, expected] of [[1, 0], [8, 0], [24, 5], [100, 28], [200, 59], [336, 100], [400, 100]]) {
    const snapshot = engine.evaluate({ nowMs, timestamp, uptimeMs: hours * HOUR, restartCount: null });
    const time = snapshot.dimensions.find((entry) => entry.dimension === 'time');
    assert.equal(time.score, expected, `${hours}h of uptime scores ${expected}`);
    assert.equal(time.metrics[0].metric, 'uptime_seconds');
    assert.equal(time.metrics[0].rule, 'uptime ramp over 8h..336h');
    assert.equal(time.metrics[0].sustainedMs, Math.round(hours * HOUR));
  }
  const noUptime = engine.evaluate({ nowMs, timestamp, uptimeMs: null, restartCount: null });
  const time = noUptime.dimensions.find((entry) => entry.dimension === 'time');
  assert.equal(time.score, null, 'no uptime telemetry leaves the time dimension unknown');
  assert.equal(time.metrics[0].rule, 'uptime telemetry unavailable');
});

test('a configured metric with no band and no trend is collected but never scored', () => {
  const { engine, config, nowMs, timestamp } = seededEngine({ active_workers: 8 });
  assert.equal(config.metrics.active_workers.band, undefined);
  const snapshot = engine.evaluate({ nowMs, timestamp, uptimeMs: null, restartCount: null });
  const worker = snapshot.dimensions.find((entry) => entry.dimension === 'worker');
  const entry = worker.metrics.find((metric) => metric.metric === 'active_workers');
  assert.ok(entry, 'it is evaluated');
  assert.equal(entry.score, null);
  assert.equal(entry.level, 'unknown');
  assert.equal(entry.rule, 'collected, not scored');
  assert.equal(worker.score, null);

  const ramTotal = seededEngine({ ram_total_bytes: 32 * 1024 ** 3 });
  const memory = ramTotal.engine
    .evaluate({ nowMs: ramTotal.nowMs, timestamp: ramTotal.timestamp, uptimeMs: null, restartCount: null })
    .dimensions.find((dimension) => dimension.dimension === 'memory');
  assert.deepEqual(memory.metrics, [], 'a metric absent from config.metrics is not evaluated at all');
});

test('the trend term is added on top of the band score and normalised by the band span', () => {
  const config = resolveConfig({});
  const store = new RollingStore(config.windows);
  const trends = new TrendAnalyzer(store, config.trend);
  const engine = new PressureEngine(store, trends, config);
  const base = EPOCH;
  // 241 samples over four hours, rising 350 ms/h: the band span for
  // event_loop_latency_ms is 400 - 50 = 350, so relative = 1 and trendPoints = 40,
  // capped at trendCap = 20.
  for (let index = 0; index <= 240; index += 1) {
    const value = 40 + index * MINUTE * (350 / HOUR);
    store.recordBag({ event_loop_latency_ms: value }, base + index * MINUTE, (metric, held) => {
      const band = config.metrics[metric].band;
      return bandKeyOf(metric, held, band);
    });
  }
  const nowMs = base + 240 * MINUTE;
  const snapshot = engine.evaluate({ nowMs, timestamp: new Date(nowMs).toISOString(), uptimeMs: null, restartCount: null });
  const entry = snapshot.dimensions
    .find((dimension) => dimension.dimension === 'runtime')
    .metrics.find((metric) => metric.metric === 'event_loop_latency_ms');
  assert.equal(entry.trendApplied, true);
  const bandScore = scoreMetric('event_loop_latency_ms', entry.value, config.metrics.event_loop_latency_ms.band);
  assert.equal(entry.score, Math.min(100, bandScore + 20), 'the trend adds 20 points on top of the band score');
  assert.match(entry.rule, /trend .* adds 20$/);
});

test('drivers are produced only at 35 or above, and their contribution is weighted down', () => {
  const readings = { gpu_usage: 0.95, cpu_usage: 0.9, cpu_temp_c: 84, gpu_temp_c: 88 };
  const { engine, nowMs, timestamp } = seededEngine(readings, { spanMs: 25 * MINUTE });
  const snapshot = engine.evaluate({ nowMs, timestamp, uptimeMs: null, restartCount: null });
  assert.ok(snapshot.drivers.length > 0);
  for (const driver of snapshot.drivers) {
    assert.ok(driver.contribution > 0, 'a zero-contribution driver is dropped');
    assert.ok(Number.isFinite(driver.contribution));
    assert.ok(['thermal', 'memory', 'runtime', 'worker', 'computer_use_ui', 'time'].includes(driver.dimension));
    assert.match(driver.detail, /scores \d+\/100/);
  }
  const codes = snapshot.drivers.map((driver) => driver.code);
  assert.ok(codes.includes('gpu_usage_critical'), `thermal driver codes are dimension-flavoured: ${codes.join(', ')}`);
  assert.equal(snapshot.primaryCause, snapshot.drivers[0].detail, 'the headline is always a measurement');
  const contributions = snapshot.drivers.map((driver) => driver.contribution);
  assert.deepEqual(contributions, [...contributions].sort((a, b) => b - a), 'drivers descend by contribution');
});

test('driver codes are dimension-flavoured, and a trend-led driver is a slope code', () => {
  const memory = seededEngine({ ram_used_ratio: 0.99 }, { spanMs: 25 * MINUTE });
  const memorySnapshot = memory.engine.evaluate({ nowMs: memory.nowMs, timestamp: memory.timestamp, uptimeMs: null, restartCount: null });
  assert.ok(memorySnapshot.drivers.some((driver) => driver.code === 'ram_used_ratio_pressure'));

  const worker = seededEngine({ failure_rate: 0.9 }, { spanMs: 25 * MINUTE });
  const workerSnapshot = worker.engine.evaluate({ nowMs: worker.nowMs, timestamp: worker.timestamp, uptimeMs: null, restartCount: null });
  assert.ok(workerSnapshot.drivers.some((driver) => driver.code === 'worker_failure_rate_elevated'));

  const runtime = seededEngine({ heartbeat_delay_ms: 60_000 }, { spanMs: 25 * MINUTE });
  const runtimeSnapshot = runtime.engine.evaluate({ nowMs: runtime.nowMs, timestamp: runtime.timestamp, uptimeMs: null, restartCount: null });
  assert.ok(runtimeSnapshot.drivers.some((driver) => driver.code === 'runtime_heartbeat_delay_ms_degraded'));

  const interactive = seededEngine({ render_latency_ms: 5_000 }, { spanMs: 25 * MINUTE });
  const interactiveSnapshot = interactive.engine.evaluate({ nowMs: interactive.nowMs, timestamp: interactive.timestamp, uptimeMs: null, restartCount: null });
  assert.ok(interactiveSnapshot.drivers.some((driver) => driver.code === 'interactive_render_latency_ms_degraded'));

  const time = seededEngine({}, {});
  const timeSnapshot = time.engine.evaluate({
    nowMs: time.nowMs, timestamp: time.timestamp, uptimeMs: 400 * HOUR, restartCount: null,
  });
  assert.equal(timeSnapshot.drivers.find((driver) => driver.dimension === 'time')?.code, 'uptime_pressure');
});

/* ----------------------------------------------------------- policy: ladder */

/** The donor's policy input shape, with only the fields the engine reads. */
function policyInput(overrides = {}) {
  const nowMs = overrides.nowMs ?? EPOCH;
  const total = overrides.total === undefined ? 0 : overrides.total;
  const drivers = overrides.drivers ?? [];
  return {
    pressure: {
      timestamp: new Date(nowMs).toISOString(),
      restartPressure: total,
      coverage: overrides.coverage ?? 1,
      unknownDimensions: [],
      dimensions: [],
      drivers,
      primaryCause: drivers[0]?.detail ?? null,
    },
    maintenance: {
      phase: 'outside_window',
      windowOpen: false,
      nextTargetAt: null,
      windowClosesInMs: 0,
      deferredMs: 0,
      deferExhausted: false,
      urgentOverride: false,
      summary: 'test',
      ...(overrides.maintenance ?? {}),
    },
    readiness: overrides.readiness === undefined ? null : overrides.readiness,
    restartCapability: overrides.restartCapability ?? 'available',
    workerControlCapability: overrides.workerControlCapability ?? 'available',
    nowMs,
    timestamp: new Date(nowMs).toISOString(),
    attempts: overrides.attempts ?? initialActionAttempts(),
  };
}

const OPEN_WINDOW = { phase: 'at_target', windowOpen: true, summary: 'target reached' };
const SAFE = { safe: true, reason: 'safe_point_reached', estimated_state: 'idle', sources: [], summary: 'idle' };
const NO_FLAP = { antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 } };
/** An open, enabled maintenance window with the safe point opted out of. */
const NO_FLAP_SAFE = { ...NO_FLAP, maintenance: { enabled: true, safePointRequired: false } };

test('the ladder maps pressure onto actions at the exact default thresholds', () => {
  const engine = new PolicyEngine(resolveConfig(NO_FLAP));
  const decide = (total, extra) => engine.evaluate(policyInput({ total, ...extra }), initialPolicyState(EPOCH));
  assert.equal(decide(0).decision.effectiveAction, 'NO_ACTION');
  assert.equal(decide(40).decision.effectiveAction, 'NO_ACTION');
  assert.equal(decide(40).decision.toState, 'HEALTHY');
  assert.equal(decide(50).decision.effectiveAction, 'NO_ACTION');
  assert.equal(decide(50).decision.toState, 'DEGRADED', 'above the exit band but below enter is DEGRADED');
  assert.equal(decide(55).decision.effectiveAction, 'THROTTLE');
  assert.equal(decide(55).decision.toState, 'THROTTLED');
  assert.ok(decide(55).decision.reasons.includes('pressure_55_gte_throttle_55'));
  assert.equal(decide(70).decision.effectiveAction, 'PAUSE_NEW_WORK');
  assert.equal(decide(70).decision.toState, 'PAUSED');
  assert.ok(decide(80, { maintenance: OPEN_WINDOW, readiness: SAFE }).decision.reasons.includes('pressure_80_gte_app_restart_80'));
  assert.ok(decide(95, { maintenance: OPEN_WINDOW, readiness: SAFE }).decision.reasons.includes('pressure_95_gte_system_reboot_95'));
  assert.equal(resolveConfig({}).thresholds.throttle.enter, 55);
  assert.equal(resolveConfig({}).thresholds.throttle.exit, 45);
  assert.equal(resolveConfig({}).thresholds.pause_new_work.enter, 70);
  assert.equal(resolveConfig({}).thresholds.request_app_restart.enter, 80);
  assert.equal(resolveConfig({}).thresholds.request_system_reboot.enter, 95);
});

test('every candidate carries its driver codes and a coverage tag', () => {
  const engine = new PolicyEngine(resolveConfig(NO_FLAP));
  const drivers = [
    { code: 'gpu_usage_critical', dimension: 'thermal', contribution: 0.3, detail: 'gpu_usage=95.00 pp scores 89/100' },
    { code: 'cpu_usage_critical', dimension: 'thermal', contribution: 0.2, detail: 'cpu_usage=90.00 pp scores 71/100' },
    { code: 'gpu_temp_c_critical', dimension: 'thermal', contribution: 0.2, detail: 'gpu_temp_c=88.00 °C scores 71/100' },
    { code: 'ignored_fourth', dimension: 'thermal', contribution: 0.1, detail: 'not in the top three' },
  ];
  const { decision } = engine.evaluate(policyInput({ total: 55, drivers, coverage: 0.6 }), initialPolicyState(EPOCH));
  assert.deepEqual(decision.reasons.slice(0, 4), [
    'pressure_55_gte_throttle_55', 'gpu_usage_critical', 'cpu_usage_critical', 'gpu_temp_c_critical',
  ]);
  assert.ok(decision.reasons.includes('coverage_60pct'), 'coverage is appended to every decision');
  assert.equal(decision.reasons.filter((reason) => reason === 'coverage_60pct').length, 1, 'reasons are de-duplicated');
  assert.equal(decision.drivers, drivers);
});

test('hysteresis holds the action in force until pressure falls through its own exit band', () => {
  const engine = new PolicyEngine(resolveConfig({}));
  const first = engine.evaluate(policyInput({ total: 60 }), initialPolicyState(EPOCH));
  assert.equal(first.decision.effectiveAction, 'THROTTLE');
  const held = engine.evaluate(policyInput({ total: 50, nowMs: EPOCH + MINUTE }), first.state);
  assert.equal(held.decision.effectiveAction, 'THROTTLE');
  assert.equal(held.decision.hysteresisHeld, true);
  assert.deepEqual(held.decision.reasons, ['hysteresis_holds_active_action', 'coverage_100pct']);
  const released = engine.evaluate(policyInput({ total: 45, nowMs: EPOCH + 2 * MINUTE }), held.state);
  assert.equal(released.decision.hysteresisHeld, false, 'at exactly the exit band the action is released');
  assert.equal(released.decision.effectiveAction, 'NO_ACTION');
  assert.equal(released.decision.toState, 'HEALTHY');
});

test('a series that oscillates around the enter threshold never oscillates the action', () => {
  const engine = new PolicyEngine(resolveConfig({}));
  let state = initialPolicyState(EPOCH);
  const actions = [];
  [56, 54, 56, 54, 56, 54, 56, 54].forEach((total, index) => {
    const result = engine.evaluate(policyInput({ total, nowMs: EPOCH + index * 15_000 }), state);
    state = result.state;
    actions.push(result.decision.effectiveAction);
  });
  assert.deepEqual(actions, Array(8).fill('THROTTLE'), '54 is above the 45 exit band, so nothing is released');
});

test('debounce delays a new high-risk level for exactly the configured evaluations', () => {
  const engine = new PolicyEngine(resolveConfig({ antiFlap: { debounceEvaluations: 3 } }));
  let state = initialPolicyState(EPOCH);
  const input = (nowMs) => policyInput({ total: 96, nowMs, maintenance: OPEN_WINDOW });
  const one = engine.evaluate(input(EPOCH), state);
  assert.equal(one.decision.effectiveAction, 'NO_ACTION', 'evaluation 1 of 3 must not act');
  assert.ok(one.decision.reasons.some((reason) => reason.startsWith('debounce_')));
  assert.ok(one.decision.reasons.includes('debounce_request_system_reboot_1_of_3'));
  state = one.state;
  const two = engine.evaluate(input(EPOCH + 15_000), state);
  assert.equal(two.decision.effectiveAction, 'NO_ACTION', 'evaluation 2 of 3 must not act');
  state = two.state;
  const three = engine.evaluate(input(EPOCH + 30_000), state);
  assert.equal(three.decision.effectiveAction, 'REQUEST_SYSTEM_REBOOT', 'evaluation 3 of 3 acts');
  assert.deepEqual(three.decision.reasons, [
    'pressure_96_gte_system_reboot_95', 'escalation_requested_at_maximum_pressure', 'coverage_100pct',
  ]);

  const noDebounce = new PolicyEngine(resolveConfig({ antiFlap: { debounceEvaluations: 1 } }));
  assert.equal(
    noDebounce.evaluate(policyInput({ total: 96, maintenance: OPEN_WINDOW, readiness: SAFE }), initialPolicyState(EPOCH)).decision.effectiveAction,
    'REQUEST_SYSTEM_REBOOT',
    'debounceEvaluations 1 disables debounce',
  );
});

test('dwell slows a low-level transition for exactly the configured duration, and never the first crossing', () => {
  const engine = new PolicyEngine(resolveConfig({ antiFlap: { minStateDwellMs: 120_000 } }));
  const first = engine.evaluate(policyInput({ total: 60 }), initialPolicyState(EPOCH));
  assert.equal(first.decision.effectiveAction, 'THROTTLE');
  const early = engine.evaluate(policyInput({ total: 40, nowMs: EPOCH + 15_000 }), first.state);
  assert.equal(early.decision.effectiveAction, 'THROTTLE');
  assert.ok(early.decision.reasons.includes('dwell_suppressed_transition'));
  assert.ok(early.decision.reasons.includes('state_dwell_15s_of_120s'));
  const late = engine.evaluate(policyInput({ total: 40, nowMs: EPOCH + 130_000 }), early.state);
  assert.equal(late.decision.effectiveAction, 'NO_ACTION');

  const slowEngine = new PolicyEngine(resolveConfig({ antiFlap: { minStateDwellMs: 600_000 } }));
  const fresh = slowEngine.evaluate(policyInput({ total: 60 }), initialPolicyState(EPOCH));
  assert.equal(fresh.decision.effectiveAction, 'THROTTLE', 'a fresh throttle must not wait out a dwell timer');
});

test('the three cooldown buckets and their balanced durations map exactly as documented', () => {
  const config = resolveConfig({});
  assert.equal(cooldownKindOf('THROTTLE'), 'throttle');
  assert.equal(cooldownKindOf('PAUSE_NEW_WORK'), 'throttle');
  assert.equal(cooldownKindOf('REQUEST_APP_RESTART'), 'maintenance');
  assert.equal(cooldownKindOf('REQUEST_SYSTEM_REBOOT'), 'escalation');
  assert.equal(cooldownKindOf('NO_ACTION'), 'escalation', 'NO_ACTION falls through the default, inertly');
  assert.equal(cooldownMsOf(config, 'THROTTLE'), 5 * MINUTE);
  assert.equal(cooldownMsOf(config, 'PAUSE_NEW_WORK'), 5 * MINUTE);
  assert.equal(cooldownMsOf(config, 'REQUEST_APP_RESTART'), 30 * MINUTE);
  assert.equal(cooldownMsOf(config, 'REQUEST_SYSTEM_REBOOT'), 60 * MINUTE);
  assert.deepEqual(initialActionAttempts(), {
    lastAttemptAt: 0,
    lastAttemptAction: 'NO_ACTION',
    cooldowns: { throttle: 0, maintenance: 0, escalation: 0 },
  });
  assert.deepEqual(initialPolicyState(EPOCH), {
    action: 'NO_ACTION', state: 'HEALTHY', sinceMs: EPOCH, lastPressure: null, consecutiveCandidate: 0, candidate: 'NO_ACTION',
  });
});

test('a suppressed repeat is suppressed but a suppressed de-escalation is only delayed', () => {
  const config = resolveConfig({ antiFlap: { minRepeatActionMs: 600_000 } });
  const engine = new PolicyEngine(config);
  const attempts = {
    lastAttemptAt: EPOCH,
    lastAttemptAction: 'THROTTLE',
    cooldowns: { throttle: EPOCH + config.cooldowns.throttleMs, maintenance: 0, escalation: 0 },
  };
  const state = { ...initialPolicyState(EPOCH), action: 'THROTTLE', state: 'THROTTLED' };
  const repeat = engine.evaluate(policyInput({ total: 60, nowMs: EPOCH + MINUTE, attempts }), state);
  assert.equal(repeat.decision.cooldownActive, true);
  assert.equal(repeat.decision.cooldownKind, 'throttle');
  assert.equal(repeat.decision.cooldownRemainingMs, 4 * MINUTE);
  assert.equal(repeat.decision.effectiveAction, 'THROTTLE', 'the action stays in force');
  assert.ok(repeat.decision.reasons.some((reason) => reason.includes('cooldown')));

  const recovery = engine.evaluate(policyInput({ total: 20, nowMs: EPOCH + 2 * MINUTE, attempts }), state);
  assert.equal(recovery.decision.effectiveAction, 'NO_ACTION', 'recovery is never blocked by a cooldown');
  assert.equal(recovery.decision.toState, 'HEALTHY');

  const minRepeat = engine.evaluate(
    policyInput({ total: 60, nowMs: EPOCH + 5 * MINUTE, attempts: { ...attempts, cooldowns: { throttle: 0, maintenance: 0, escalation: 0 } } }),
    state,
  );
  assert.ok(minRepeat.decision.reasons.includes('min_repeat_action_interval'), 'the same action is paced independently of the bucket');
});

test('the state machine names a gated restart instead of forgetting it', () => {
  const engine = new PolicyEngine(resolveConfig(NO_FLAP));
  const gated = engine.evaluate(policyInput({ total: 85 }), initialPolicyState(EPOCH));
  assert.equal(gated.decision.action, 'REQUEST_APP_RESTART', 'the raw action is still the restart');
  assert.equal(gated.decision.effectiveAction, 'PAUSE_NEW_WORK', 'but the effective action is the fallback');
  assert.equal(gated.decision.toState, 'MAINTENANCE_PENDING');
  assert.ok(gated.decision.reasons.includes('maintenance_window_closed'));

  const rebootGated = engine.evaluate(policyInput({ total: 96 }), initialPolicyState(EPOCH));
  assert.equal(rebootGated.decision.effectiveAction, 'PAUSE_NEW_WORK');
  assert.equal(rebootGated.decision.toState, 'ESCALATION_PENDING');

  const unknownPressure = engine.evaluate(policyInput({ total: null }), initialPolicyState(EPOCH));
  assert.equal(unknownPressure.decision.pressure, null);
  assert.equal(unknownPressure.decision.toState, 'DEGRADED', 'unknown telemetry is not health');

  const safeMode = new PolicyEngine(resolveConfig(NO_FLAP)).evaluate(
    policyInput({ total: 40, nowMs: EPOCH + 600_000 }),
    { ...initialPolicyState(EPOCH), action: 'REQUEST_SYSTEM_REBOOT', state: 'REQUEST_SYSTEM_REBOOT', candidate: 'REQUEST_SYSTEM_REBOOT' },
  );
  assert.equal(safeMode.decision.toState, 'SAFE_MODE', 'SAFE_MODE is reachable only after a requested reboot');

  const walking = new PolicyEngine(resolveConfig(NO_FLAP));
  const atFifty = walking.evaluate(policyInput({ total: 50 }), initialPolicyState(EPOCH));
  assert.equal(atFifty.decision.toState, 'DEGRADED');
  const atSixty = walking.evaluate(policyInput({ total: 60, nowMs: EPOCH + MINUTE }), atFifty.state);
  assert.equal(atSixty.decision.toState, 'THROTTLED');
  const back = walking.evaluate(policyInput({ total: 10, nowMs: EPOCH + 2 * MINUTE }), atSixty.state);
  assert.equal(back.decision.toState, 'HEALTHY');
});

/* ------------------------------------------------------------- restart gate */

test('the restart gate downgrades to PAUSE_NEW_WORK and names every blocking reason', () => {
  const engine = new PolicyEngine(resolveConfig(NO_FLAP));
  const decide = (overrides) => engine.evaluate(policyInput({ total: 85, maintenance: OPEN_WINDOW, readiness: SAFE, ...overrides }), initialPolicyState(EPOCH));
  const noCapability = decide({ restartCapability: 'unavailable' });
  assert.equal(noCapability.decision.effectiveAction, 'PAUSE_NEW_WORK');
  assert.ok(noCapability.decision.reasons.includes('restart_capability_unavailable'));

  const unsafe = decide({ readiness: { safe: false, reason: 'git_commit_in_progress', estimated_state: 'busy', sources: [], summary: 'busy' } });
  assert.equal(unsafe.decision.effectiveAction, 'PAUSE_NEW_WORK');
  assert.ok(unsafe.decision.reasons.includes('safe_point_unsafe'));
  assert.ok(unsafe.decision.reasons.includes('safe_point_reason_git_commit_in_progress'), 'the source reason is embedded');
  assert.equal(unsafe.decision.toState, 'MAINTENANCE_PENDING');

  const unknown = decide({ readiness: { safe: null, reason: 'no_safe_point_source', estimated_state: 'unknown', sources: [], summary: 'unknown' } });
  assert.equal(unknown.decision.effectiveAction, 'PAUSE_NEW_WORK', 'an unanswered question is not a yes');
  assert.ok(unknown.decision.reasons.includes('safe_point_unknown'));

  const beforeTarget = decide({ maintenance: { phase: 'before_target', windowOpen: true } });
  assert.equal(beforeTarget.decision.effectiveAction, 'PAUSE_NEW_WORK');
  assert.ok(beforeTarget.decision.reasons.includes('maintenance_before_target_time'));

  const confirmed = decide({});
  assert.equal(confirmed.decision.effectiveAction, 'REQUEST_APP_RESTART');
  assert.equal(confirmed.decision.toState, 'REQUEST_APP_RESTART');
  assert.ok(confirmed.decision.reasons.includes('safe_point_confirmed'));
  assert.ok(confirmed.decision.reasons.includes('safe_point_idle'));
});

test('the configuration can forbid a restart, and the reason says so', () => {
  const engine = new PolicyEngine(resolveConfig({ ...NO_FLAP, maintenance: { enabled: true, allowAppRestart: false } }));
  const decision = engine.evaluate(policyInput({ total: 85, maintenance: OPEN_WINDOW, readiness: SAFE }), initialPolicyState(EPOCH));
  assert.equal(decision.decision.action, 'REQUEST_APP_RESTART');
  assert.equal(decision.decision.effectiveAction, 'PAUSE_NEW_WORK');
  assert.ok(decision.decision.reasons.includes('maintenance_app_restart_disabled'));
});

test('the urgent override skips the window, and level 4 alone may override the safe point', () => {
  const engine = new PolicyEngine(resolveConfig(NO_FLAP));
  const urgent = { phase: 'urgent_override', windowOpen: false, urgentOverride: true };
  const unsafe = { safe: false, reason: 'busy', estimated_state: 'critical', sources: [], summary: 'busy' };

  const appRestart = engine.evaluate(policyInput({ total: 85, maintenance: urgent, readiness: unsafe }), initialPolicyState(EPOCH));
  assert.equal(appRestart.decision.effectiveAction, 'PAUSE_NEW_WORK', 'the override does not skip the safe point for level 3');
  assert.ok(appRestart.decision.reasons.includes('urgent_override_active'));

  const reboot = engine.evaluate(policyInput({ total: 97, maintenance: urgent, readiness: unsafe }), initialPolicyState(EPOCH));
  assert.equal(reboot.decision.effectiveAction, 'REQUEST_SYSTEM_REBOOT');
  assert.ok(reboot.decision.reasons.includes('urgent_override_active'));
  assert.ok(reboot.decision.reasons.includes('escalation_overrides_safe_point'));
  assert.ok(reboot.decision.reasons.includes('safe_point_unsafe'), 'the audit trail still says the safe point was not confirmed');

  const rebootNoAdapter = engine.evaluate(
    policyInput({ total: 97, maintenance: urgent, readiness: unsafe, restartCapability: 'unavailable' }),
    initialPolicyState(EPOCH),
  );
  assert.equal(rebootNoAdapter.decision.effectiveAction, 'PAUSE_NEW_WORK', 'the override never bypasses a missing adapter');
});

/* --------------------------------------------------- maintenance and window */

const LOCAL = (year, month, day, hour, minute, second = 0) => new Date(year, month - 1, day, hour, minute, second, 0).getTime();

test('wall-clock parsing is strict and the occurrence boundaries are inclusive', () => {
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('04:00'), 4 * HOUR);
  assert.equal(parseClock('23:59'), 23 * HOUR + 59 * MINUTE);
  for (const bad of ['24:00', '4:00', '04:60', 'nope']) assert.throws(() => parseClock(bad));
  const noon = LOCAL(2026, 3, 1, 12, 0);
  assert.equal(previousOccurrence('04:00', noon), LOCAL(2026, 3, 1, 4, 0));
  assert.equal(nextOccurrence('04:00', noon), LOCAL(2026, 3, 2, 4, 0));
  const onTarget = LOCAL(2026, 3, 1, 4, 0);
  assert.equal(previousOccurrence('04:00', onTarget), onTarget);
  assert.equal(nextOccurrence('04:00', onTarget), onTarget);
  assert.equal(startOfLocalDay(noon), LOCAL(2026, 3, 1, 0, 0));
  assert.equal(formatClock(LOCAL(2026, 3, 1, 4, 5)), '04:05');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3 * HOUR + 5 * MINUTE), '3h 5m');
  assert.equal(formatDuration(0), '0s');
});

test('a wrapping window is handled, and clockWithin is start-inclusive end-exclusive', () => {
  assert.equal(clockWithin('23:30', '23:00', '02:00'), true);
  assert.equal(clockWithin('01:30', '23:00', '02:00'), true);
  assert.equal(clockWithin('12:00', '23:00', '02:00'), false);
  assert.equal(clockWithin('04:00', '03:30', '05:00'), true);
  assert.equal(clockWithin('03:00', '03:30', '05:00'), false);
  assert.equal(clockWithin('05:00', '03:30', '05:00'), false, 'the window end is exclusive');
});

test('the maintenance picture reports every phase, and an exhausted deferral still says go', () => {
  const config = resolveConfig({ maintenance: { enabled: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' } }).maintenance;
  const disabled = resolveConfig({ maintenance: { enabled: false } }).maintenance;
  const disabledPicture = picture(disabled, LOCAL(2026, 3, 1, 4, 0), null, 50);
  assert.equal(disabledPicture.phase, 'outside_window');
  assert.equal(disabledPicture.nextTargetAt, null);
  assert.match(disabledPicture.summary, /disabled/);

  const at02 = picture(config, LOCAL(2026, 3, 1, 2, 0), null, 10);
  assert.equal(at02.phase, 'outside_window');
  assert.equal(at02.windowOpen, false);
  const at0345 = picture(config, LOCAL(2026, 3, 1, 3, 45), null, 10);
  assert.equal(at0345.phase, 'before_target');
  assert.equal(at0345.windowOpen, true);
  assert.equal(at0345.windowClosesInMs, 75 * MINUTE);
  assert.equal(maintenanceAllowsRequest(at0345, config), false);
  const at0400 = picture(config, LOCAL(2026, 3, 1, 4, 0), null, 10);
  assert.equal(at0400.phase, 'at_target');
  assert.equal(maintenanceAllowsRequest(at0400, config), true);

  const deferredConfig = resolveConfig({ maintenance: { enabled: true, targetTime: '04:00', maxDeferMs: 30 * MINUTE } }).maintenance;
  const deferred = picture(deferredConfig, LOCAL(2026, 3, 1, 4, 10), LOCAL(2026, 3, 1, 4, 0), 10);
  assert.equal(deferred.phase, 'deferred');
  assert.equal(deferred.deferredMs, 10 * MINUTE);
  assert.equal(deferred.deferExhausted, false);
  assert.equal(maintenanceAllowsRequest(deferred, deferredConfig), true);
  const overdue = picture(deferredConfig, LOCAL(2026, 3, 1, 4, 40), LOCAL(2026, 3, 1, 4, 0), 10);
  assert.equal(overdue.phase, 'overdue');
  assert.equal(overdue.deferExhausted, true);
  assert.match(overdue.summary, /max defer exhausted/);
  assert.equal(maintenanceAllowsRequest(overdue, deferredConfig), true, 'an exhausted deferral means go now, not give up');

  const urgentConfig = resolveConfig({ maintenance: { enabled: true, urgentOverridePressure: 92 } }).maintenance;
  const urgent = picture(urgentConfig, LOCAL(2026, 3, 1, 14, 0), null, 93);
  assert.equal(urgent.phase, 'urgent_override');
  assert.equal(urgent.urgentOverride, true);
  assert.equal(urgent.windowOpen, false);
  assert.equal(maintenanceAllowsRequest(urgent, urgentConfig), true, 'the threshold comparison is >=');
  const notUrgent = picture(urgentConfig, LOCAL(2026, 3, 1, 14, 0), null, 91);
  assert.equal(notUrgent.phase, 'outside_window');
  assert.equal(maintenanceAllowsRequest(notUrgent, urgentConfig), false);

  const noRestart = resolveConfig({ maintenance: { enabled: true, allowAppRestart: false } }).maintenance;
  assert.equal(maintenanceAllowsRequest(picture(noRestart, LOCAL(2026, 3, 1, 4, 30), null, 99), noRestart), false);
});

test('window arithmetic is local-calendar based, so it survives a day boundary', () => {
  const config = resolveConfig({ maintenance: { enabled: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' } }).maintenance;
  for (const day of [1, 2, 3, 28]) {
    const instance = picture(config, LOCAL(2026, 3, day, 4, 0), null, 0);
    assert.equal(instance.phase, 'at_target', `day ${day} should be at target`);
    const target = new Date(instance.nextTargetAt);
    assert.equal(target.getHours(), 4);
    assert.equal(target.getMinutes(), 0);
  }
});

test('safe points fold worst-first, and an unanswered question is not a yes', async () => {
  const registry = new SafePointRegistry();
  assert.equal(registry.isEmpty, true);
  const empty = await registry.readiness();
  assert.equal(empty.safe, null);
  assert.equal(empty.reason, 'no_safe_point_source');
  assert.equal(empty.estimated_state, 'unknown');

  const one = foldReadiness([{ source: 'core', safe: true, reason: 'idle', estimatedState: 'idle' }]);
  assert.equal(one.safe, true);
  assert.equal(one.estimated_state, 'idle');
  const unsafe = foldReadiness([
    { source: 'core', safe: true, reason: 'idle', estimatedState: 'idle' },
    { source: 'git', safe: false, reason: 'git_commit_in_progress', estimatedState: 'busy' },
  ]);
  assert.equal(unsafe.safe, false);
  assert.equal(unsafe.reason, 'git_commit_in_progress');
  assert.equal(unsafe.estimated_state, 'busy');
  const silent = foldReadiness([
    { source: 'core', safe: true, reason: 'idle', estimatedState: 'idle' },
    { source: 'mystery', safe: null, reason: 'no_answer', estimatedState: 'unknown' },
  ]);
  assert.equal(silent.safe, null, 'a silent source must not be read as safe');
  assert.equal(silent.estimated_state, 'unknown', 'an unknown reading forces the state to unknown');

  const bounded = new SafePointRegistry();
  bounded.register({ id: 'thrower', readiness: () => { throw new Error('core is down'); } });
  bounded.register({ id: 'hanger', readiness: () => new Promise(() => {}) });
  const result = await bounded.readiness(50);
  assert.equal(result.safe, null);
  assert.equal(result.sources.length, 2, 'a failure and a timeout are both reported, not dropped');
  assert.equal(result.sources.find((entry) => entry.source === 'thrower').reason, 'safe_point_source_failed');
  assert.equal(result.sources.find((entry) => entry.source === 'hanger').reason, 'safe_point_timeout');

  const disposable = new SafePointRegistry();
  const dispose = disposable.register({ id: 'a', readiness: () => ({ source: 'a', safe: true, reason: 'idle', estimatedState: 'idle' }) });
  assert.deepEqual(disposable.sources(), ['a']);
  dispose();
  assert.deepEqual(disposable.sources(), []);
  assert.equal((await disposable.readiness()).safe, null);
});

test('safePointRequired: false skips the question instead of answering it badly', async () => {
  const rig = new Rig({
    config: {
      ...NO_FLAP,
      thresholds: { throttle: { enter: 5, exit: 2 } },
      maintenance: { enabled: true, safePointRequired: false },
    },
  });
  rig.provider('hardware', 'hardware', ['gpu_temp_c']).set({ gpu_temp_c: 96 });
  await rig.advance(2 * MINUTE, 10);
  assert.equal(rig.last.pressure, 100, 'the saturated lone metric renormalises to 100');
  assert.equal(rig.last.readiness.reason, 'not_evaluated');
  assert.ok(rig.restart.requests.length > 0, 'the request is raised');
  assert.equal(rig.last.maintenance.phase, 'urgent_override', 'the pressure is past the urgent override');
  for (const record of rig.decisions) {
    assert.equal(
      record.reasons.some((reason) => reason === 'safe_point_unknown' || reason.startsWith('safe_point_unsafe')),
      false,
      'an unrequired safe point never becomes the reason a request is blocked',
    );
  }
});

test('a registered safe point gates the request through the real scheduler', async () => {
  let calls = 0;
  const safePoint = { id: 'core', readiness: () => { calls += 1; return { source: 'core', safe: false, reason: 'git_commit_in_progress', estimatedState: 'busy' }; } };
  const rig = new Rig({
    config: { maintenance: { enabled: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' } },
    safePoints: [safePoint],
  });
  rig.now = LOCAL(2026, 3, 1, 3, 45);
  const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle']);
  hardware.set({ gpu_temp_c: 90, thermal_throttle: 0.4 });
  for (let index = 0; index < 120; index += 1) {
    hardware.set({ gpu_temp_c: 90, thermal_throttle: 0.4 });
    await rig.advance(30_000, 1);
  }
  assert.equal(rig.last.readiness.safe, false);
  assert.equal(rig.last.readiness.reason, 'git_commit_in_progress');
  assert.equal(rig.last.maintenance.windowOpen, true);
  assert.equal(rig.restart.requests.length, 0, 'no restart while the safe point refuses');
  assert.ok(['MAINTENANCE_PENDING', 'PAUSED'].includes(rig.last.state));
  assert.ok(calls > 0, 'the registry was actually asked');
});

/* ------------------------------------------------ scheduler: action requests */

test('the level-to-action mapping reaches the right adapter and always as a request', async () => {
  const rig = new Rig({ config: { ...NO_FLAP, throttle: { concurrencyLimit: 2 }, thresholds: { throttle: { enter: 10, exit: 5 } } } });
  rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle']).set({ gpu_temp_c: 85, thermal_throttle: 0.2 });
  await rig.advance(10 * MINUTE, 40);
  assert.equal(rig.decisions[0].action, 'THROTTLE');
  assert.deepEqual(rig.workerControl.calls, [['setConcurrencyLimit', 2]], 'the configured limit is applied once');
  assert.equal(rig.restart.requests.length, 0, 'a throttle is not a restart');

  // Level 3 needs an open window, and a pressure that is high but not urgent:
  // gpu_temp_c 90 scores 86 and thermal_throttle 0.4 scores 80, which blends to 84.
  const rig2 = new Rig({ config: NO_FLAP_SAFE, epoch: LOCAL(2026, 3, 1, 4, 5) });
  rig2.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle']).set({ gpu_temp_c: 90, thermal_throttle: 0.4 });
  await rig2.advance(2 * MINUTE, 4);
  assert.equal(rig2.last.pressure, 84, 'the app-restart rung, not the reboot rung');
  const application = rig2.restart.requests.find((request) => request.mode === 'application');
  assert.ok(application, 'level 3 is a request handed to the adapter');
  assert.equal(application.acknowledgeSystemReboot, undefined, 'an application request never carries the reboot acknowledgement');
  assert.equal(application.source, 'dsh-health-scheduler');
  assert.equal(application.reasonCode, 'RUNTIME_PRESSURE');
  assert.equal(application.priority, 'normal');
  assert.equal(application.checkpointRequired, false, 'checkpointRequired follows safePointRequired');
  assert.match(application.requestId, /^hs-\d+-\d+$/);
  assert.match(application.reasonSummary, /pressure_84_gte_app_restart_80/);
  const restartDecision = rig2.decisions.find((record) => record.action === 'REQUEST_APP_RESTART');
  assert.ok(restartDecision, 'the restart rung produced one decision record');
  assert.equal(restartDecision.outcome.applied, true);
  assert.equal(restartDecision.outcome.capability, 'available');
  assert.equal(restartDecision.outcome.reference, 'r-1');
  assert.equal(restartDecision.outcome.adapter, 'recording-restart');
  assert.equal(restartDecision.state, 'REQUEST_APP_RESTART');
  // The rung below it was a mitigation the engine requested first, and the restart
  // was not blocked by that mitigation's cooldown, because they are different buckets.
  assert.equal(rig2.decisions[0].action, 'THROTTLE');
  assert.equal(rig2.decisions[0].outcome.applied, false, 'no concurrency target is derivable, so the throttle is a no-op');
  assert.match(rig2.decisions[0].outcome.detail, /no concurrency target/);
});

test('a system request always acknowledges the reboot, and only that rung does', async () => {
  const rig = new Rig({
    config: {
      ...NO_FLAP,
      thresholds: { throttle: { enter: 5, exit: 2 }, pause_new_work: { enter: 25, exit: 20 }, request_app_restart: { enter: 40, exit: 35 }, request_system_reboot: { enter: 90, exit: 85 } },
      maintenance: { enabled: true, safePointRequired: false },
    },
  });
  const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c']);
  hardware.set({ gpu_temp_c: 60 });
  await rig.advance(MINUTE, 2);
  hardware.set({ gpu_temp_c: 96 });
  await rig.advance(2 * MINUTE, 10);
  assert.equal(rig.last.pressure, 100);
  assert.ok(['REQUEST_SYSTEM_REBOOT', 'ESCALATION_PENDING'].includes(rig.last.state), `state was ${rig.last.state}`);
  assert.ok(rig.restart.requests.some((request) => request.mode === 'system'));
  for (const request of rig.restart.requests) {
    if (request.mode === 'system') assert.equal(request.acknowledgeSystemReboot, true);
    else assert.equal(request.acknowledgeSystemReboot, undefined);
  }
});

test('the engine only ever calls the documented adapter methods, so an action cannot become an effect', async () => {
  const invoked = [];
  const allowedForRestart = ['requestApplicationRestart', 'requestSystemRestart'];
  const allowedForWorker = ['setConcurrencyLimit', 'pauseNewWorkers', 'resumeNormalConcurrency', 'currentConcurrencyLimit'];
  const restart = {
    id: 'recording-restart',
    capability: 'available',
    requests: [],
    async requestApplicationRestart(request) {
      invoked.push('requestApplicationRestart');
      this.requests.push({ ...request, mode: 'application' });
      return { accepted: true, state: 'queued', requestId: `r-${this.requests.length}` };
    },
    async requestSystemRestart(request) {
      invoked.push('requestSystemRestart');
      this.requests.push({ ...request, mode: 'system' });
      return { accepted: true, state: 'queued', requestId: `r-${this.requests.length}` };
    },
    async cancelPendingRestart() {
      invoked.push('cancelPendingRestart');
      return true;
    },
  };
  const workerControl = {
    id: 'recording-worker-control',
    capability: 'available',
    calls: [],
    async setConcurrencyLimit(limit) {
      invoked.push('setConcurrencyLimit');
      this.calls.push(['setConcurrencyLimit', limit]);
    },
    async pauseNewWorkers() {
      invoked.push('pauseNewWorkers');
      this.calls.push(['pauseNewWorkers']);
    },
    async resumeNormalConcurrency() {
      invoked.push('resumeNormalConcurrency');
      this.calls.push(['resumeNormalConcurrency']);
    },
    currentConcurrencyLimit() {
      invoked.push('currentConcurrencyLimit');
      return null;
    },
  };
  const rig = new Rig({
    config: { ...NO_FLAP_SAFE, throttle: { concurrencyLimit: 2 }, thresholds: { throttle: { enter: 5, exit: 2 } } },
    restart,
    workerControl,
  });
  rig.provider('hardware', 'hardware', ['gpu_temp_c']).set({ gpu_temp_c: 96 });
  await rig.advance(2 * MINUTE, 10);
  assert.ok(restart.requests.length > 0, 'the adapter was actually exercised');
  assert.ok(invoked.length > 0);
  for (const name of invoked) {
    assert.ok(
      [...allowedForRestart, ...allowedForWorker].includes(name),
      `an adapter method outside the request contract was called: ${name}`,
    );
    assert.equal(allowedForRestart.includes(name) || allowedForWorker.includes(name), true);
  }
  // cancelPendingRestart and currentConcurrencyLimit are never called by the engine.
  assert.equal(invoked.includes('cancelPendingRestart'), false);
  assert.equal(invoked.includes('currentConcurrencyLimit'), false);
  assert.equal(invoked.includes('requestSystemRestart'), true, 'the top rung was reached');
});

test('the cooldown starts on the attempt, so a long critical run is bounded to a few requests', async () => {
  const rig = new Rig({
    config: { ...NO_FLOP_SAFE, throttle: { concurrencyLimit: 2 } },
  });
  const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle']);
  hardware.set({ gpu_temp_c: 96, thermal_throttle: 0.7 });
  await rig.advance(6 * HOUR, 1440);
  assert.equal(rig.history.length, 1440);
  assert.ok(rig.decisions.length >= 1, 'the machine was never silent about being critical');
  assert.ok(rig.decisions.length <= 5, `a level already in force is not re-issued: ${rig.decisions.length} decisions`);
  const mitigationCalls = rig.workerControl.calls.filter(([name]) => name !== 'resumeNormalConcurrency');
  assert.ok(mitigationCalls.length <= 3, `at most three mitigation calls, got ${mitigationCalls.length}`);
});

const NO_FLOP_SAFE = { ...NO_FLAP, maintenance: { enabled: true, safePointRequired: false } };

test('a throwing restart adapter never stops the loop and never becomes a request storm', async () => {
  const rig = new Rig({ config: { ...NO_FLOP_SAFE, maintenance: { enabled: true, safePointRequired: false } } });
  rig.restart.throwOnRequest = true;
  const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle']);
  for (let index = 0; index < 120; index += 1) {
    hardware.set({ gpu_temp_c: 100, thermal_throttle: 0.8 });
    await rig.advance(15_000, 1);
  }
  assert.equal(rig.history.length, 120, 'the loop must survive a throwing adapter');
  assert.equal(rig.last.capabilities.restart, 'available');
  const warnings = rig.history.flatMap((snapshot) => snapshot.warnings);
  assert.ok(warnings.some((warning) => warning.includes('not applied')));
  assert.ok(rig.restart.requests.length >= 1);
  assert.ok(rig.restart.requests.length <= 3, `bounded attempts, got ${rig.restart.requests.length}`);
});

test('an unavailable capability reports a refusal rather than throwing or acting', async () => {
  const rig = new Rig({
    config: NO_FLAP_SAFE,
    restart: new RecordingRestartAdapter({ capability: 'unavailable' }),
    workerControl: new RecordingWorkerControl({ capability: 'unavailable' }),
  });
  rig.provider('hardware', 'hardware', ['gpu_temp_c']).set({ gpu_temp_c: 96 });
  await rig.advance(2 * MINUTE, 10);
  assert.equal(rig.last.capabilities.restart, 'unavailable');
  assert.equal(rig.last.capabilities.workerControl, 'unavailable');
  assert.equal(rig.restart.requests.length, 0, 'an unavailable capability is never called');
  assert.equal(rig.workerControl.calls.length, 0);
  const applied = rig.decisions.filter((record) => record.action !== 'NO_ACTION');
  assert.ok(applied.length > 0, 'the engine still decided and recorded something');
  for (const record of applied) {
    assert.equal(record.outcome.applied, false);
    assert.equal(record.outcome.capability, 'unavailable');
    assert.match(record.outcome.detail, /unavailable/);
  }
  assert.ok(['ESCALATION_PENDING', 'MAINTENANCE_PENDING', 'PAUSED'].includes(rig.last.state), `state was ${rig.last.state}`);

  const adapter = new UnavailableRestartAdapter();
  assert.equal(adapter.capability, 'unavailable');
  const response = await adapter.requestApplicationRestart({});
  assert.deepEqual(response, { accepted: false, state: 'rejected', reason: 'dsh-restart is not installed in this profile' });
  assert.deepEqual(await adapter.requestSystemRestart({}), { accepted: false, state: 'rejected', reason: 'dsh-restart is not installed in this profile' });
  assert.equal(await adapter.cancelPendingRestart('x'), false);
  const workers = new UnavailableWorkerControlAdapter();
  assert.equal(workers.capability, 'unavailable');
  await workers.setConcurrencyLimit(2);
  await workers.pauseNewWorkers();
  await workers.resumeNormalConcurrency();
  assert.equal(workers.currentConcurrencyLimit(), null);
});

test('disabled configuration samples nothing at all', async () => {
  const rig = new Rig({ config: { enabled: false } });
  const hardware = rig.provider('hardware', 'hardware', ['cpu_temp_c']).set({ cpu_temp_c: 99 });
  await rig.advance(MINUTE, 4);
  assert.equal(hardware.samples, 0);
  assert.equal(rig.last.pressure, null);
  assert.deepEqual(rig.decisions, []);
});

test('the ingest seam records violations and never tracks a rejected metric', () => {
  const rig = new Rig({});
  rig.scheduler.ingest({ provider: 'manual', timestamp: new Date(EPOCH).toISOString(), metrics: { cpu_temp_c: 9000 } });
  assert.equal(rig.scheduler.normalizationViolations().length, 1);
  assert.equal(rig.scheduler.normalizationViolations()[0].reason, 'above_hard_max');
  assert.equal(rig.scheduler.trackedMetrics().includes('cpu_temp_c'), false);
  rig.scheduler.ingest({ provider: 'manual', timestamp: new Date(EPOCH).toISOString(), metrics: { cpu_temp_c: 55 } });
  assert.deepEqual(rig.scheduler.trackedMetrics(), ['cpu_temp_c']);
});

test('per-window history is exposed for one metric and coverage stays honest', async () => {
  const rig = new Rig({});
  rig.provider('hardware', 'hardware', ['cpu_temp_c', 'gpu_temp_c']).set({ cpu_temp_c: 55, gpu_temp_c: 45 });
  await rig.advance(MINUTE, 4);
  const windows = rig.scheduler.windowsFor('cpu_temp_c');
  assert.equal(windows.length, rig.config.windows.windowsMs.length);
  for (const entry of windows) assert.equal(entry.mean, 55);
  assert.ok(rig.last.coverage > 0 && rig.last.coverage < 1);
  assert.ok(rig.last.unknownDimensions.includes('worker'));
  assert.equal(rig.last.metrics.cpu_temp_c, 55);
  assert.equal(rig.last.metrics.ram_used_ratio, undefined);
});

test('provider failures are isolated, backed off exponentially, and reported', async () => {
  const registry = new ProviderRegistry({
    sampling: { providerBackoffMs: 1000, providerBackoffMaxMs: 8000 },
    resilience: { providerFailureLimit: 2, providerRetryAfterBackoff: true, reportDegradedCapability: true },
    disabledProviders: [],
  });
  const good = new ScriptedProvider('good', 'hardware', ['cpu_temp_c']).set({ cpu_temp_c: 50 });
  const bad = new ScriptedProvider('bad', 'hardware', ['gpu_temp_c']);
  bad.failNext(3);
  registry.register(good);
  registry.register(bad);
  assert.throws(
    () => registry.register(new ScriptedProvider('good', 'hardware', [])),
    /already registered/,
  );
  const first = await registry.sampleAll(EPOCH, new Date(EPOCH).toISOString());
  assert.deepEqual(first.samples.map((entry) => entry.provider), ['good']);
  assert.equal(first.failures.length, 1);
  assert.equal(first.failures[0].provider, 'bad');
  assert.match(first.failures[0].message, /scripted failure/);
  assert.equal(first.failures[0].backoffMs, 0, 'below the failure limit there is no backoff yet');
  assert.equal(registry.status(EPOCH + 1)[0].available, true);

  const second = await registry.sampleAll(EPOCH + 1, new Date(EPOCH + 1).toISOString());
  assert.equal(second.failures[0].backoffMs, 1000, 'at the limit the backoff starts at the base');
  assert.equal(registry.status(EPOCH + 2).find((entry) => entry.id === 'bad').available, false);
  assert.ok(registry.status(EPOCH + 2).find((entry) => entry.id === 'bad').backoffRemainingMs > 0);

  const third = await registry.sampleAll(EPOCH + 100, new Date(EPOCH + 100).toISOString());
  assert.deepEqual(third.skipped, ['bad'], 'a backed-off provider is skipped, not sampled');
  assert.equal(third.failures.length, 0);
  const later = await registry.sampleAll(EPOCH + 60_000, new Date(EPOCH + 60_000).toISOString());
  assert.equal(later.failures.length, 1, 'it is retried after the backoff window');
});

test('a disabled provider and a per-provider flag are both skipped in sorted order', async () => {
  const registry = new ProviderRegistry({
    sampling: { providerBackoffMs: 1000, providerBackoffMaxMs: 8000 },
    resilience: { providerFailureLimit: 2, providerRetryAfterBackoff: true, reportDegradedCapability: true },
    disabledProviders: ['off'],
  });
  registry.register(new ScriptedProvider('off', 'hardware', ['cpu_temp_c']).set({ cpu_temp_c: 1 }));
  const flagged = new ScriptedProvider('flagged', 'hardware', ['cpu_temp_c']);
  flagged.enabled = false;
  registry.register(flagged);
  const round = await registry.sampleAll(EPOCH, new Date(EPOCH).toISOString());
  assert.deepEqual(round.skipped, ['flagged', 'off']);
  assert.equal(round.samples.length, 0);
});

/* ---------------------------------------------------------- decision log */

const logRecord = (id, action = 'THROTTLE') => ({
  id,
  timestamp: new Date(EPOCH + id * 1000).toISOString(),
  action,
  state: 'THROTTLED',
  pressure: 60,
  coverage: 0.5,
  drivers: [],
  reasons: ['pressure_60_gte_throttle_55'],
  outcome: { applied: true, capability: 'available', adapter: 'test', detail: 'ok' },
});

test('the decision log keeps a bounded, append-only ring, newest last', () => {
  const log = new DecisionLog({ maxRecords: 3, directory: null, maxBytes: 1024 });
  assert.equal(log.path, null, 'a null directory keeps the log in memory only');
  for (let id = 1; id <= 5; id += 1) log.append(logRecord(id));
  assert.equal(log.size, 3);
  assert.deepEqual(log.recent().map((entry) => entry.id), [3, 4, 5]);
  assert.deepEqual(log.recent(2).map((entry) => entry.id), [4, 5]);
  assert.deepEqual(log.recent(10).map((entry) => entry.id), [3, 4, 5]);
  assert.equal(log.nextId(), 1, 'ids are monotonic per instance and allocated by the log');
  assert.equal(log.nextId(), 2);
  log.clear();
  assert.equal(log.size, 0);
  assert.deepEqual(log.readPersisted(), []);
});

test('the on-disk log is a JSONL envelope, read back, tolerant of a torn line, and rotates', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'host-health-log-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const log = new DecisionLog({ maxRecords: 10, directory, maxBytes: 1024 * 1024, now: () => EPOCH });
  log.append(logRecord(1));
  log.append(logRecord(2));
  assert.ok(existsSync(log.path));
  const lines = readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const envelope = JSON.parse(lines[0]);
  assert.equal(envelope.schemaVersion, LOG_SCHEMA_VERSION);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.kind, 'decision');
  assert.equal(envelope.record.id, 1);
  const reopened = new DecisionLog({ maxRecords: 10, directory, maxBytes: 1024 * 1024 });
  assert.deepEqual(reopened.readPersisted().map((entry) => entry.id), [1, 2]);

  appendFileSync(log.path, '{"schemaVersion":1,"kind":"decision","recor', 'utf8');
  assert.deepEqual(reopened.readPersisted().map((entry) => entry.id), [1, 2], 'a half-written trailing line is skipped');

  const rotating = new DecisionLog({ maxRecords: 100, directory, maxBytes: 200, now: () => EPOCH });
  for (let id = 1; id <= 6; id += 1) rotating.append(logRecord(id));
  assert.ok(readdirSync(directory).some((name) => name.endsWith('.bak')), 'the log rotates once it exceeds its budget');
});

test('an unwritable log directory is reported instead of thrown', () => {
  const log = new DecisionLog({ maxRecords: 5, directory: '\0invalid\0', maxBytes: 1024 });
  log.append(logRecord(1));
  assert.equal(log.writeFailures, 1);
  assert.notEqual(log.lastError, null);
  assert.equal(log.size, 1, 'the in-memory ring still records it');
});

/* --------------------------------------------------------------- providers */

test('the stats file is read first-match-wins, with unknown keys reported and staleness named', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'host-health-stats-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const good = join(directory, 'good.json');
  const second = join(directory, 'second.json');
  writeFileSync(good, JSON.stringify({ timestamp: 'x', metrics: { render_latency_ms: 180, typo_metric: 1 } }), 'utf8');
  writeFileSync(second, JSON.stringify({ render_latency_ms: 999 }), 'utf8');

  const source = new StatsFileSource([join(directory, 'missing.json'), good, second], 120_000, 0);
  const snapshot = source.read(Date.now());
  assert.equal(snapshot.readable, true);
  assert.equal(snapshot.metrics.render_latency_ms, 180, 'the first readable path wins');
  assert.deepEqual(snapshot.unknownKeys, ['typo_metric']);
  assert.equal(snapshot.stale, false);

  const stale = new StatsFileSource([good], 0, 0);
  const staleSnapshot = stale.read(Date.now() + 1000);
  assert.equal(staleSnapshot.stale, true);
  assert.equal(staleSnapshot.reason, 'telemetry_unavailable');
  assert.match(staleSnapshot.detail, /last written \d+s ago/);

  const absent = new StatsFileSource([join(directory, 'nope.json')], 1000, 0);
  const absentSnapshot = absent.read(Date.now());
  assert.equal(absentSnapshot.readable, false);
  assert.match(absentSnapshot.detail, /no stats file exists yet/);
  assert.equal(absent.configured, true);
  assert.equal(new StatsFileSource([], 1000).configured, false);
  assert.deepEqual(extractMetrics({ render_latency_ms: 12, schemaVersion: 1, bad: 1 }), { metrics: { render_latency_ms: 12 }, unknownKeys: ['bad'] });
  assert.deepEqual(extractMetrics(null), { metrics: {}, unknownKeys: [] });
  assert.deepEqual(extractMetrics({ metrics: { render_latency_ms: 5 } }).metrics, { render_latency_ms: 5 });
});

test('the command-probe grammar ignores what it cannot trust and reports what it cannot parse', () => {
  const parsed = parseNameValueLines([
    '# comment',
    'gpu_temp_c=71.5',
    'cpu_temp_c,62',
    'not_a_metric=5',
    'gpu_usage=not-a-number',
    '',
    'broken',
  ].join('\n'));
  assert.deepEqual(parsed.metrics, { gpu_temp_c: 71.5, cpu_temp_c: 62 });
  assert.deepEqual(parsed.malformed, ['gpu_usage']);
  assert.deepEqual(mergeBags({ a: 1, b: 2 }, { b: 3 }), { a: 1, b: 3 }, 'later bags win');
  assert.deepEqual(mergeBags({}, {}), {});
});

test('a command probe with an empty argv refuses instead of executing anything', async () => {
  const result = await runCommandProbe({ argv: [], timeoutMs: 1000, format: 'name-value' });
  assert.deepEqual(result, { metrics: {}, malformed: [], error: 'command probe has an empty argv' });
});

test('the built-in provider graph follows the configuration without reading the OS', () => {
  const config = resolveConfig({});
  const environment = {
    clock: () => EPOCH,
    os: {},
    process: { pid: 1, treeRssBytes: null, uptimeSeconds: 10, rssBytes: 1, heapUsedBytes: 1, externalBytes: 1, activeHandles: 1, activeRequests: 1 },
    stateDirectory: null,
    runProbe: async () => ({ metrics: {}, malformed: [], error: null }),
  };
  const built = buildBuiltInProviders(config, environment);
  assert.deepEqual(built.ids, ['hardware', 'memory', 'runtime', 'workers', 'computer-use', 'ui', 'context']);
  assert.deepEqual(built.providers.map((provider) => provider.id), built.ids);
  const disabled = buildBuiltInProviders(resolveConfig({ disabledProviders: ['hardware', 'ui'] }), environment);
  assert.deepEqual(disabled.ids, ['memory', 'runtime', 'workers', 'computer-use', 'context'], 'disabled providers are not registered at all');
  // the memory provider reuses the hardware helper command, which the donor documents
  const withHelper = buildBuiltInProviders(resolveConfig({ providerOptions: { hardware: { helperCommand: ['echo', 'gpu_temp_c=52'] } } }), environment);
  const memory = withHelper.providers.find((provider) => provider.id === 'memory');
  assert.deepEqual(memory.helper.command, ['echo', 'gpu_temp_c=52']);
  assert.equal(memory.tree, null, 'no process-tree reader without extra pids');
  const withPids = buildBuiltInProviders(resolveConfig({ providerOptions: { memory: { extraPids: [42] } } }), environment);
  assert.ok(withPids.providers.find((provider) => provider.id === 'memory').tree, 'extra pids bring a tree reader');
});

/* ------------------------------------------------------------- presentation */

test('the text report never claims that an unknown is healthy and renders goldens exactly', async () => {
  const rig = new Rig({});
  await rig.advance(SECOND, 1);
  const report = renderHealthReport(rig.last);
  assert.match(report, /Restart Pressure: unknown/);
  assert.match(report, /Unknown dimensions: .*\(not scored as healthy\)/);
  assert.match(report, /Telemetry coverage: 0%/);
  assert.match(report, /Capabilities: restart=available, worker-control=available/);
  assert.equal(renderMetricRow('gpu_temp_c', 88), 'gpu_temp_c                   88');
  assert.equal(renderMetricRow('gpu_temp_c', null), 'gpu_temp_c                   unknown');
  const populated = new Rig({});
  populated.provider('hardware', 'hardware', ['cpu_temp_c']).set({ cpu_temp_c: 95 });
  await populated.advance(10 * MINUTE, 40);
  const text = renderHealthReport(populated.last);
  assert.match(text, /Restart Pressure: \d+ \/ 100/);
  assert.match(text, /Dimensions:/);
  assert.match(text, /Providers:/);
  assert.match(text, /Memory:/);
});

test('the machine payload serialises without an undefined, and keeps the donor key names', async () => {
  const rig = new Rig({});
  rig.provider('hardware', 'hardware', ['cpu_temp_c']).set({ cpu_temp_c: 50 });
  await rig.advance(MINUTE, 4);
  const payload = metricsSnapshot(rig.last);
  assert.equal(JSON.stringify(payload).includes('undefined'), false);
  assert.equal(typeof payload.restart_pressure, 'number');
  assert.equal(typeof payload.coverage, 'number');
  assert.ok(Array.isArray(payload.unknown_dimensions));
  assert.ok(Array.isArray(payload.dimensions));
  assert.ok(Array.isArray(payload.providers));
  assert.equal(typeof payload.maintenance.phase, 'string');
  assert.equal(payload.safe_point.safe, null, 'an unasked safe point is null, never a boolean yes');
  assert.equal(payload.dimensions[0].effective_weight, Number(payload.dimensions[0].effective_weight));
  assert.equal('total_successes' in payload.providers[0], false, 'the donor omits total_successes from the JSON');
});

/* ------------------------------------------------------------------ settings */

test('a rejected settings document is refused loudly and leaves the configuration in force', () => {
  const rig = new Rig({});
  const before = rig.scheduler.config;
  const rejected = applySettingsUpdate(rig.scheduler, { metrics: { gpu_temp: {} } });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.error instanceof ConfigError);
  assert.match(rejected.error.message, /is not a canonical metric/);
  assert.equal(rig.scheduler.config, before, 'nothing was applied');
  assert.deepEqual(rejected.error.path, 'metrics.gpu_temp');

  const accepted = applySettingsUpdate(rig.scheduler, { preset: 'conservative' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.error, null);
  assert.equal(rig.scheduler.config.preset, 'conservative');
  assert.equal(accepted.config.preset, 'conservative');
});

test('a bad configuration is rejected loudly but the caller can keep running on balanced', () => {
  assert.throws(() => resolveConfig({ metrics: { gpu_temp_c: { band: { warn: 80, critical: 80 } } } }), /warn and critical must differ/);
  assert.throws(() => resolveConfig({ thresholds: { throttle: { enter: 55, exit: 55 } } }), /requires exit < enter/);
  assert.throws(() => resolveConfig({ thresholds: { pause_new_work: { enter: 50, exit: 40 } } }), /must be strictly above/);
  assert.throws(() => resolveConfig({ windows: { windowsMs: [] } }), /non-empty array/);
  assert.throws(() => resolveConfig({ windows: { windowsMs: [300_000, 300_000] } }), /strictly ascending/);
  assert.throws(() => resolveConfig({ weights: { time: 0, thermal: 0, memory: 0, runtime: 0, worker: 0, computer_use_ui: 0 } }), /positive total/);
  assert.throws(() => resolveConfig({ maintenance: { targetTime: '4:00' } }), /24-hour/);
  const fallback = tryResolveConfig({ metrics: { nope: {} } });
  assert.equal(fallback.error instanceof ConfigError, true);
  assert.equal(fallback.config.preset, 'balanced', 'the fallback is the balanced preset');
  assert.equal(resolveConfig({ preset: 'custom' }).preset, 'custom', 'custom is accepted as a label only');
  assert.deepEqual(resolveConfig({ preset: 'custom' }).thresholds, resolveConfig({ preset: 'balanced' }).thresholds, 'and resolves to balanced');
  assert.deepEqual(DEFAULT_METRIC_CONFIG, PRESETS.balanced.metrics, 'the default metric table is the balanced table');
});

/* ------------------------------------------- the module cannot restart anything */

test('the module ships no process-control primitive of any kind', () => {
  const forbidden = [
    'taskkill', 'shutdown', 'Stop-Computer', 'Restart-Computer', 'process.kill', 'process.abort', 'process.exit',
    'execSync', 'spawnSync', 'spawn(', 'child_process.spawn', 'SIGKILL', 'SIGTERM', 'SIGINT', 'killall', 'pkill',
    'systemctl', 'schtasks', 'Start-Process',
  ];
  for (const { name, text } of moduleSources()) {
    for (const token of forbidden) {
      assert.equal(text.includes(token), false, `${name} must not contain ${token}`);
    }
  }
  // `execFile` exists exactly twice, both read-only probes with a fixed argv.
  const providers = moduleSources().find((entry) => entry.name === 'providers.mjs').text;
  assert.equal(providers.split('execFile(').length - 1, 2, 'only the two documented probes call execFile');
  assert.ok(providers.includes("'tasklist.exe', ['/NH', '/FO', 'CSV']"), 'the Windows probe is a process list');
  assert.ok(providers.includes("'ps', ['-o', 'pid=,rss=', '-p'"), 'the POSIX probe is a process list');
  assert.equal(/execFile\([^)]*'(\/c|-Command)'/.test(providers), false, 'no probe is routed through a shell');
});

test('the only outbound capability is a bounded action request, and no exported function can stop a process', async () => {
  const index = await import('../index.mjs');
  for (const [name, value] of Object.entries(index)) {
    if (typeof value !== 'function') continue;
    assert.equal(
      /^(kill|stop|restart|reboot|shutdown|terminate|signal|spawn|exec|abort|exit)/i.test(name),
      false,
      `exported function ${name} must not look like a process-control entry point`,
    );
  }
  const calls = [];
  const realKill = process.kill;
  process.kill = (...args) => { calls.push(args); return realKill.apply(process, args); };
  try {
    const rig = new Rig({ config: { ...NO_FLOP_SAFE } });
    rig.provider('hardware', 'hardware', ['gpu_temp_c']).set({ gpu_temp_c: 100 });
    await rig.advance(4 * MINUTE, 20);
    assert.ok(rig.restart.requests.length > 0, 'the highest rung was genuinely reached');
    assert.deepEqual(calls, [], 'no signal was ever sent to any process');
    for (const request of rig.restart.requests) {
      assert.equal(typeof request, 'object');
      assert.equal(typeof request.requestId, 'string', 'the output is a request record, not an effect');
      assert.equal(typeof request.mode, 'string');
      assert.ok(['application', 'system'].includes(request.mode));
      assert.equal(typeof request.checkpointRequired, 'boolean');
    }
    const record = rig.decisions.find((entry) => entry.action.startsWith('REQUEST_'));
    assert.ok(record, 'the decision was recorded');
    assert.equal(typeof record.outcome.applied, 'boolean', 'the outcome is data about the request, not the restart');
  } finally {
    process.kill = realKill;
  }
});

test('the real OS-backed providers are optional: nothing in the module builds one on its own', () => {
  // The only construction site for the real environment is `defaultEnvironment`
  // itself. Nothing else in the module calls it, so no provider can reach
  // `node:os` unless a caller deliberately passes the real environment in. Every
  // test in this file passes a stub instead, which is what makes the suite
  // synthetic and machine-independent.
  const sources = moduleSources();
  const sites = sources
    .map(({ name, text }) => ({ name, count: text.split('defaultEnvironment(').length - 1 }))
    .filter(({ count }) => count > 0);
  assert.deepEqual(sites, [{ name: 'providers.mjs', count: 1 }], 'the real environment is defined once and never called');
  assert.equal(typeof defaultEnvironment, 'function', 'and it stays an explicit opt-in for a real deployment');

  // The environment reads the process lazily, so building it costs no OS read at
  // all; only a provider actually calling `environment.process` would.
  const environment = defaultEnvironment({ stateDirectory: '/tmp/state' });
  assert.equal(environment.stateDirectory, '/tmp/state', 'an injected state directory is honoured');
  assert.equal(typeof Object.getOwnPropertyDescriptor(environment, 'process').get, 'function', 'process is read through a getter');
  assert.equal(typeof environment.clock(), 'number');
});
