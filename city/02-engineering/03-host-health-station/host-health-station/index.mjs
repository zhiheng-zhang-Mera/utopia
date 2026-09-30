/**
 * UTOPIA · City · Host Health Station — public surface.
 *
 * Ported from the donor `dsh-health-scheduler` `src/index.ts` @ 985e2b7; see
 * DONOR.json for the porting ledger.
 *
 * The host/runtime health capability, without its DeepSeek/Cordis binding. What
 * was the donor's plugin entry point — `name`, `inject`, `apply` and
 * `applyHealthScheduler`, which read `ctx.tools`, `ctx.settings` and
 * `ctx.effect` — is deliberately absent: this module registers nothing with a
 * harness, owns no loader contract and holds no preset of its own.
 *
 * What remains is the whole engine plus the seams that were never binding:
 *
 *   measure   `normalizeSample`, `RollingStore`, `TrendAnalyzer`, the providers
 *   judge     `PressureEngine`, `PolicyEngine`, `computeMaintenancePicture`
 *   request   `HealthScheduler.applyAction` through an injected action adapter
 *   record    `DecisionLog`
 *
 * Two properties the port inherits unchanged and that the module's tests prove:
 * missing telemetry is `unknown`, never a zero (the `coverage` field says how
 * much of the model was actually measured), and **nothing here ever executes a
 * restart**. The ladder stops at a bounded action request; the two shipped
 * adapters refuse rather than act, and the module holds no process-control
 * primitive of any kind.
 *
 * @module host-health-station
 */

import { ConfigError, deepMerge, resolveConfig, tryResolveConfig } from './config.mjs';
import { HealthScheduler } from './scheduler.mjs';

/* ------------------------------------------------------------------ engine */

export { HealthScheduler };
export { ConfigError, deepMerge, resolveConfig, tryResolveConfig };

/**
 * Construct a scheduler without starting it.
 *
 * @param {{config: object, restart: object, workerControl: object, stateDirectory: string|null, clock?: Function, safePoints?: object[]}} options
 * @returns {HealthScheduler} a scheduler that has not sampled anything yet.
 */
export function createScheduler(options) {
  return new HealthScheduler(options);
}

/* -------------------------------------------------------- configuration */

export { PRESETS, PRESET_SCALES, PRESET_DOCUMENTS, DEFAULT_METRIC_CONFIG, preset } from './presets.mjs';
export { DEFAULT_SCORED_METRICS, DEFAULT_UNSCORED_METRICS, BALANCED_PRESET } from './presets.mjs';
export { DECISION_LADDER, PRESSURE_DIMENSIONS } from './types.mjs';
export {
  SETTINGS_NAMESPACE,
  CONFIG_SCHEMA,
  applySettingsUpdate,
  reconfigureFromSettings,
} from './settings.mjs';

/* ------------------------------------------------------------- vocabulary */

export { CANONICAL_METRICS, METRICS, isCanonicalMetric, metricDescriptor } from './types.mjs';
export { ACTION_LEVEL, PRESSURE_LEVEL_RANK } from './types.mjs';

/* ---------------------------------------------------- measure and window */

export { normalizeSample, parseSampleTime } from './normalize.mjs';
export { RollingStore } from './rolling.mjs';
export { TrendAnalyzer, formatBytes, formatDelta, formatSlopePerHour } from './trend.mjs';

/* --------------------------------------------------------------- scoring */

export {
  LEVEL_BOUNDS,
  bandKeyOf,
  byScoreDescending,
  clamp,
  describeRule,
  levelOf,
  rampEndpoints,
  scoreMetric,
  scoreWithSustain,
} from './bands.mjs';
export { PressureEngine, dimensionOf, UPTIME_RAMP_FULL_MS, UPTIME_RAMP_START_MS } from './pressure.mjs';

/* ---------------------------------------------------------------- policy */

export {
  PolicyEngine,
  cooldownKindOf,
  cooldownMsOf,
  initialActionAttempts,
  initialPolicyState,
} from './policy.mjs';
export {
  clockWithin,
  computeMaintenancePicture,
  formatClock,
  formatDuration,
  maintenanceAllowsRequest,
  nextOccurrence,
  parseClock,
  previousOccurrence,
  startOfLocalDay,
} from './maintenance.mjs';
export { SafePointRegistry, foldReadiness } from './safe-point.mjs';

/* ----------------------------------------------------------------- audit */

export { DecisionLog, LOG_SCHEMA_VERSION } from './audit.mjs';

/* -------------------------------------------------------------- providers */

export { ProviderRegistry } from './providers.mjs';
export { StatsFileSource, extractMetrics, parseNameValueLines, runCommandProbe, mergeBags } from './providers.mjs';
export { defaultEnvironment, readProcessFacade } from './providers.mjs';
export { HardwareProvider, MemoryProvider, RuntimeProvider, EMPTY_RUNTIME_FEED } from './providers.mjs';
export {
  StatsBackedProvider,
  buildStatsBackedProviders,
  STATS_PROVIDER_IDS,
  STATS_PROVIDER_METRICS,
} from './providers.mjs';
export { ProcessTreeReader, parsePsMemoryLine, parseTasklistMemoryLine } from './providers.mjs';
export { mergeHardwareMetrics } from './providers.mjs';

/* ---------------------------------------------------------------- wiring */

export { buildBuiltInProviders, registerBuiltInProviders } from './wiring.mjs';

/* --------------------------------------------------------------- actions */

export { UnavailableRestartAdapter, UnavailableWorkerControlAdapter, outcomeForAction } from './adapters.mjs';

/* ------------------------------------------------------------ presentation */

export {
  metricsSnapshot,
  renderHealthReport,
  renderMetricRow,
  renderMaintenanceSection,
  renderPressureSection,
  renderProviderSection,
} from './report.mjs';
