/**
 * UTOPIA · City · Host Health Station — configuration resolution.
 *
 * Ported from the donor `dsh-health-scheduler` src/core/config.js @ 985e2b7;
 * see DONOR.json for the porting ledger. Behaviour is unchanged.
 *
 * Configuration resolution: preset selection, deep override merging, and
 * validation with loud, actionable errors.
 *
 * The plugin never silently invents a value for a malformed document. A config
 * that cannot be acted on is rejected at load time, which is the only point
 * where a bad value is still cheap.
 *
 * @module host-health-station/config
 */
import { CANONICAL_METRICS, isCanonicalMetric } from './types.mjs';
import { preset } from './presets.mjs';
/** Thrown when a configuration document cannot be acted on. */
export class ConfigError extends Error {
  /** Dotted path of the offending value. */
  path;
  constructor(path, message) {
    super(`health-scheduler config: ${path} ${message}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Recursively merge `override` into `base`, returning a new document.
 *
 * Arrays replace rather than merge: a deployment that lists provider ids means
 * exactly that list. `null` is a value, not an instruction to delete, except for
 * the explicitly nullable leaves the schema declares.
 * @param {*} base - the base document.
 * @param {*} override - the overriding document; arrays replace, `null` is a value.
 * @returns {*} a new merged document, leaving both inputs untouched.
 */
export function deepMerge(base, override) {
  if (override === undefined)
    return base;
  if (override === null)
    return null;
  if (Array.isArray(override))
    return override;
  if (!isPlainObject(override))
    return override;
  if (!isPlainObject(base))
    return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined)
      continue;
    out[key] = deepMerge(base[key], value);
  }
  return out;
}
function requireFinite(path, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(path, `must be a finite number, received ${JSON.stringify(value)}`);
  }
  return value;
}
function requireNonNegative(path, value) {
  const n = requireFinite(path, value);
  if (n < 0)
    throw new ConfigError(path, `must be >= 0, received ${n}`);
  return n;
}
function requirePositive(path, value) {
  const n = requireFinite(path, value);
  if (n <= 0)
    throw new ConfigError(path, `must be > 0, received ${n}`);
  return n;
}
const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
function requireClock(path, value) {
  if (typeof value !== 'string' || !CLOCK_PATTERN.test(value)) {
    throw new ConfigError(path, `must be a 24-hour "HH:MM" wall-clock string, received ${JSON.stringify(value)}`);
  }
  return value;
}
function requireBand(path, value) {
  if (!isPlainObject(value))
    throw new ConfigError(path, 'must be an object with "enter" and "exit"');
  const enter = requireFinite(`${path}.enter`, value.enter);
  const exit = requireFinite(`${path}.exit`, value.exit);
  if (exit >= enter) {
    throw new ConfigError(path, `requires exit < enter for hysteresis, received exit=${exit} enter=${enter}`);
  }
  return { enter, exit };
}
function requireThresholds(value) {
  if (!isPlainObject(value))
    throw new ConfigError('thresholds', 'must be an object');
  const throttle = requireBand('thresholds.throttle', value.throttle);
  const pause = requireBand('thresholds.pause_new_work', value.pause_new_work);
  const appRestart = requireBand('thresholds.request_app_restart', value.request_app_restart);
  const sysReboot = requireBand('thresholds.request_system_reboot', value.request_system_reboot);
  const ladder = [
    ['throttle', throttle],
    ['pause_new_work', pause],
    ['request_app_restart', appRestart],
    ['request_system_reboot', sysReboot],
  ];
  for (let i = 1; i < ladder.length; i += 1) {
    const previous = ladder[i - 1];
    const current = ladder[i];
    if (current[1].enter <= previous[1].enter) {
      throw new ConfigError(`thresholds.${current[0]}.enter`, `must be strictly above thresholds.${previous[0]}.enter (${previous[1].enter})`);
    }
    if (current[1].exit < previous[1].exit) {
      throw new ConfigError(`thresholds.${current[0]}.exit`, `must not fall below thresholds.${previous[0]}.exit (${previous[1].exit})`);
    }
  }
  return {
    throttle,
    pause_new_work: pause,
    request_app_restart: appRestart,
    request_system_reboot: sysReboot,
  };
}
function requireWindows(value) {
  if (!isPlainObject(value))
    throw new ConfigError('windows', 'must be an object');
  const windowsMs = value.windowsMs;
  if (!Array.isArray(windowsMs) || windowsMs.length === 0) {
    throw new ConfigError('windows.windowsMs', 'must be a non-empty array of millisecond windows');
  }
  const normalized = windowsMs.map((entry, index) => requirePositive(`windows.windowsMs[${index}]`, entry));
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i] <= normalized[i - 1]) {
      throw new ConfigError('windows.windowsMs', 'must be strictly ascending');
    }
  }
  // `rawMs` is the *minimum* raw retention, not a cap: the longest statistics
  // window must always be fully backed by samples, so the effective retention is
  // the larger of the two. Keeping the configured floor separate means a
  // deployment can ask for 6-hour windows without restating the retention.
  const rawMs = Math.max(requirePositive('windows.rawMs', value.rawMs), normalized[normalized.length - 1]);
  return {
    rawMs,
    windowsMs: normalized,
    aggregateBucketMs: requirePositive('windows.aggregateBucketMs', value.aggregateBucketMs),
    aggregateRetentionMs: requirePositive('windows.aggregateRetentionMs', value.aggregateRetentionMs),
    dailyRetentionMs: requirePositive('windows.dailyRetentionMs', value.dailyRetentionMs),
  };
}
function requireWeights(value) {
  if (!isPlainObject(value))
    throw new ConfigError('weights', 'must be an object');
  const keys = ['time', 'thermal', 'memory', 'runtime', 'worker', 'computer_use_ui'];
  const out = {};
  const mutable = out;
  let total = 0;
  for (const key of keys) {
    const n = requireNonNegative(`weights.${key}`, value[key]);
    mutable[key] = n;
    total += n;
  }
  if (total <= 0)
    throw new ConfigError('weights', 'must have a positive total');
  return out;
}
function requireMetrics(value) {
  if (!isPlainObject(value))
    throw new ConfigError('metrics', 'must be an object keyed by metric name');
  const out = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isCanonicalMetric(name)) {
      throw new ConfigError(`metrics.${name}`, `is not a canonical metric; known names: ${CANONICAL_METRICS.join(', ')}`);
    }
    if (!isPlainObject(raw))
      throw new ConfigError(`metrics.${name}`, 'must be an object');
    const entry = {};
    if (raw.band !== undefined) {
      const band = raw.band;
      if (!isPlainObject(band))
        throw new ConfigError(`metrics.${name}.band`, 'must be an object');
      const warn = requireFinite(`metrics.${name}.band.warn`, band.warn);
      const critical = requireFinite(`metrics.${name}.band.critical`, band.critical);
      if (warn === critical) {
        throw new ConfigError(`metrics.${name}.band`, 'warn and critical must differ');
      }
      entry.band = { warn, critical };
    }
    if (raw.weight !== undefined) {
      entry.weight = requireNonNegative(`metrics.${name}.weight`, raw.weight);
    }
    if (raw.sustainMs !== undefined) {
      entry.sustainMs = requireNonNegative(`metrics.${name}.sustainMs`, raw.sustainMs);
    }
    if (raw.trendPointsPerHour !== undefined) {
      entry.trendPointsPerHour = requireNonNegative(`metrics.${name}.trendPointsPerHour`, raw.trendPointsPerHour);
    }
    if (raw.trendCap !== undefined) {
      entry.trendCap = requireNonNegative(`metrics.${name}.trendCap`, raw.trendCap);
    }
    out[name] = entry;
  }
  return out;
}
function requireProviders(value) {
  if (!Array.isArray(value))
    throw new ConfigError('disabledProviders', 'must be an array of provider ids');
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(`disabledProviders[${index}]`, 'must be a non-empty string');
    }
    return entry.trim();
  });
}
/**
 * Resolve a user document against a preset into a complete, validated config.
 *
 * @param overrides - partial document; `preset` selects the base.
 * @returns a frozen, fully-populated configuration.
 * @throws {ConfigError} when a value cannot be acted on.
 */
export function resolveConfig(overrides = {}) {
  const base = preset(overrides.preset);
  const merged = deepMerge(base, overrides);
  const resolved = {
    ...merged,
    enabled: merged.enabled !== false,
    preset: (overrides.preset ?? base.preset),
    windows: requireWindows(merged.windows),
    weights: requireWeights(merged.weights),
    thresholds: requireThresholds(merged.thresholds),
    metrics: requireMetrics(merged.metrics),
    disabledProviders: requireProviders(merged.disabledProviders ?? []),
    sampling: {
      intervalMs: requirePositive('sampling.intervalMs', merged.sampling.intervalMs),
      trendIntervalMs: requirePositive('sampling.trendIntervalMs', merged.sampling.trendIntervalMs),
      summaryIntervalMs: requirePositive('sampling.summaryIntervalMs', merged.sampling.summaryIntervalMs),
      providerBackoffMs: requireNonNegative('sampling.providerBackoffMs', merged.sampling.providerBackoffMs),
      providerBackoffMaxMs: requirePositive('sampling.providerBackoffMaxMs', merged.sampling.providerBackoffMaxMs),
    },
    trend: {
      minSamples: Math.max(2, Math.trunc(requirePositive('trend.minSamples', merged.trend.minSamples))),
      minSpanMs: requireNonNegative('trend.minSpanMs', merged.trend.minSpanMs),
      minRSquared: requireFinite('trend.minRSquared', merged.trend.minRSquared),
    },
    cooldowns: {
      throttleMs: requireNonNegative('cooldowns.throttleMs', merged.cooldowns.throttleMs),
      maintenanceMs: requireNonNegative('cooldowns.maintenanceMs', merged.cooldowns.maintenanceMs),
      escalationMs: requireNonNegative('cooldowns.escalationMs', merged.cooldowns.escalationMs),
    },
    throttle: {
      concurrencyLimit: merged.throttle?.concurrencyLimit === null || merged.throttle?.concurrencyLimit === undefined
        ? null
        : Math.max(1, Math.trunc(requirePositive('throttle.concurrencyLimit', merged.throttle.concurrencyLimit))),
      concurrencyFactor: Math.min(1, Math.max(0.05, requirePositive('throttle.concurrencyFactor', merged.throttle?.concurrencyFactor ?? 0.5))),
    },
    maintenance: {
      enabled: merged.maintenance.enabled === true,
      targetTime: requireClock('maintenance.targetTime', merged.maintenance.targetTime),
      windowStart: requireClock('maintenance.windowStart', merged.maintenance.windowStart),
      windowEnd: requireClock('maintenance.windowEnd', merged.maintenance.windowEnd),
      maxDeferMs: requireNonNegative('maintenance.maxDeferMs', merged.maintenance.maxDeferMs),
      urgentOverridePressure: merged.maintenance.urgentOverridePressure === null
        ? null
        : requireFinite('maintenance.urgentOverridePressure', merged.maintenance.urgentOverridePressure),
      allowAppRestart: merged.maintenance.allowAppRestart !== false,
      safePointRequired: merged.maintenance.safePointRequired !== false,
    },
    antiFlap: {
      minStateDwellMs: requireNonNegative('antiFlap.minStateDwellMs', merged.antiFlap.minStateDwellMs),
      minRepeatActionMs: requireNonNegative('antiFlap.minRepeatActionMs', merged.antiFlap.minRepeatActionMs),
      debounceEvaluations: Math.max(1, Math.trunc(requirePositive('antiFlap.debounceEvaluations', merged.antiFlap.debounceEvaluations))),
    },
    resilience: {
      providerFailureLimit: Math.max(1, Math.trunc(requirePositive('resilience.providerFailureLimit', merged.resilience.providerFailureLimit))),
      providerRetryAfterBackoff: merged.resilience.providerRetryAfterBackoff !== false,
      reportDegradedCapability: merged.resilience.reportDegradedCapability !== false,
    },
    storage: {
      enabled: merged.storage.enabled !== false,
      directory: merged.storage.directory === null ? null : String(merged.storage.directory),
      maxLogBytes: requirePositive('storage.maxLogBytes', merged.storage.maxLogBytes),
      maxRecentDecisions: Math.max(1, Math.trunc(requirePositive('storage.maxRecentDecisions', merged.storage.maxRecentDecisions))),
    },
    providerOptions: {
      hardware: {
        ignoreMetrics: (merged.providerOptions.hardware.ignoreMetrics ?? []).filter(isCanonicalMetric),
        helperCommand: merged.providerOptions.hardware.helperCommand === null
          ? null
          : merged.providerOptions.hardware.helperCommand.map(String),
        helperTimeoutMs: requirePositive('providerOptions.hardware.helperTimeoutMs', merged.providerOptions.hardware.helperTimeoutMs),
      },
      memory: {
        extraPids: (merged.providerOptions.memory.extraPids ?? []).map((pid) => Math.max(0, Math.trunc(requireFinite('providerOptions.memory.extraPids[]', pid)))),
      },
      runtime: {
        heartbeatFile: merged.providerOptions.runtime.heartbeatFile === null
          ? null
          : String(merged.providerOptions.runtime.heartbeatFile),
        heartbeatExpectedMs: requirePositive('providerOptions.runtime.heartbeatExpectedMs', merged.providerOptions.runtime.heartbeatExpectedMs),
      },
      statsFile: {
        paths: (merged.providerOptions.statsFile?.paths ?? []).map((entry, index) => {
          if (typeof entry !== 'string' || entry.trim() === '') {
            throw new ConfigError(`providerOptions.statsFile.paths[${index}]`, 'must be a non-empty path string');
          }
          return entry.trim();
        }),
        staleAfterMs: requirePositive('providerOptions.statsFile.staleAfterMs', merged.providerOptions.statsFile?.staleAfterMs ?? 120_000),
        commands: (merged.providerOptions.statsFile?.commands ?? []).map((entry, index) => {
          if (!Array.isArray(entry.argv) || entry.argv.length === 0) {
            throw new ConfigError(`providerOptions.statsFile.commands[${index}].argv`, 'must be a non-empty argv array');
          }
          return {
            argv: entry.argv.map(String),
            timeoutMs: requirePositive(`providerOptions.statsFile.commands[${index}].timeoutMs`, entry.timeoutMs ?? 5_000),
            format: 'name-value',
          };
        }),
      },
    },
  };
  return Object.freeze(resolved);
}
/**
 * Resolve a config from an untrusted source.
 *
 * Returns the resolved config plus, when resolution failed, the error. Callers
 * that must never throw (a plugin `apply`) use this shape; callers that want the
 * loud path use {@link resolveConfig}.
 * @param {object} [overrides] - partial document; `preset` selects the base.
 * @returns {{config: object, error: Error|null}} the resolved config and, when it failed, the error.
 */
export function tryResolveConfig(overrides = {}) {
  try {
    return { config: resolveConfig(overrides), error: null };
  }
  catch (error) {
    const wrapped = error instanceof ConfigError
      ? error
      : new ConfigError('<root>', `failed to resolve: ${error.message}`);
    return { config: resolveConfig({ preset: 'balanced' }), error: wrapped };
  }
}
