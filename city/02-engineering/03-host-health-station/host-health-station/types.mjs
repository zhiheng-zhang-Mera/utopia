/**
 * UTOPIA · City · Host Health Station — the metric and decision vocabulary.
 *
 * Ported from the donor `dsh-health-scheduler` src/types/{metrics,provider,window,decision,config}.ts @ 985e2b7;
 * see DONOR.json for the porting ledger. Behaviour is unchanged.
 *
 * Canonical metric vocabulary of `dsh-health-scheduler`.
 *
 * Every provider speaks this vocabulary and nothing else. A metric name maps to
 * exactly one physical quantity with exactly one unit, so two providers can
 * never contribute the same idea under two different names. The registry below
 * is the single source of truth for units and for the direction that counts as
 * "more pressure".
 *
 * @module host-health-station/types
 */
/** The canonical metric registry as a const object, keyed by metric name. */
export const METRICS = {
  // ---------------------------------------------------------------- hardware
  cpu_temp_c: {
    name: 'cpu_temp_c',
    unit: 'celsius',
    polarity: 'higher-is-worse',
    group: 'hardware',
    hardMin: -20,
    hardMax: 130,
    description: 'CPU package temperature in degrees Celsius.',
  },
  gpu_temp_c: {
    name: 'gpu_temp_c',
    unit: 'celsius',
    polarity: 'higher-is-worse',
    group: 'hardware',
    hardMin: -20,
    hardMax: 130,
    description: 'GPU core temperature in degrees Celsius.',
  },
  cpu_usage: {
    name: 'cpu_usage',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'hardware',
    hardMin: 0,
    hardMax: 1,
    description: 'Aggregate CPU utilisation as a 0..1 ratio.',
  },
  gpu_usage: {
    name: 'gpu_usage',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'hardware',
    hardMin: 0,
    hardMax: 1,
    description: 'GPU utilisation as a 0..1 ratio.',
  },
  thermal_throttle: {
    name: 'thermal_throttle',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'hardware',
    hardMin: 0,
    hardMax: 1,
    description: 'Fraction of the sampling interval spent thermally throttled.',
  },
  power_limit_hit: {
    name: 'power_limit_hit',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'hardware',
    hardMin: 0,
    hardMax: 1,
    description: 'Fraction of the sampling interval spent at the power limit.',
  },
  // ------------------------------------------------------------------ memory
  ram_total_bytes: {
    name: 'ram_total_bytes',
    unit: 'bytes',
    polarity: 'higher-is-worse',
    group: 'memory',
    hardMin: 0,
    description: 'Installed physical memory.',
  },
  ram_available_bytes: {
    name: 'ram_available_bytes',
    unit: 'bytes',
    polarity: 'lower-is-worse',
    group: 'memory',
    hardMin: 0,
    description: 'Physical memory available to new allocations.',
  },
  ram_used_ratio: {
    name: 'ram_used_ratio',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'memory',
    hardMin: 0,
    hardMax: 1,
    description: 'Physical memory in use as a 0..1 ratio.',
  },
  commit_used_ratio: {
    name: 'commit_used_ratio',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'memory',
    hardMin: 0,
    hardMax: 1,
    description: 'Commit charge (private + mapped) as a 0..1 ratio.',
  },
  process_rss_bytes: {
    name: 'process_rss_bytes',
    unit: 'bytes',
    polarity: 'higher-is-worse',
    group: 'memory',
    hardMin: 0,
    description: 'Resident set size of the harness process tree.',
  },
  process_private_bytes: {
    name: 'process_private_bytes',
    unit: 'bytes',
    polarity: 'higher-is-worse',
    group: 'memory',
    hardMin: 0,
    description: 'Private committed bytes of the harness process tree.',
  },
  vram_used_ratio: {
    name: 'vram_used_ratio',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'memory',
    hardMin: 0,
    hardMax: 1,
    description: 'GPU memory in use as a 0..1 ratio.',
  },
  // ----------------------------------------------------------------- runtime
  uptime_seconds: {
    name: 'uptime_seconds',
    unit: 'seconds',
    polarity: 'higher-is-worse',
    group: 'runtime',
    hardMin: 0,
    description: 'Seconds since the harness process started.',
  },
  worker_process_count: {
    name: 'worker_process_count',
    unit: 'count',
    polarity: 'higher-is-worse',
    group: 'runtime',
    hardMin: 0,
    description: 'Live worker processes owned by the harness.',
  },
  handle_count: {
    name: 'handle_count',
    unit: 'count',
    polarity: 'higher-is-worse',
    group: 'runtime',
    hardMin: 0,
    description: 'Open OS handles held by the harness process tree.',
  },
  thread_count: {
    name: 'thread_count',
    unit: 'count',
    polarity: 'higher-is-worse',
    group: 'runtime',
    hardMin: 0,
    description: 'Live OS threads in the harness process tree.',
  },
  event_loop_latency_ms: {
    name: 'event_loop_latency_ms',
    unit: 'milliseconds',
    polarity: 'higher-is-worse',
    group: 'runtime',
    hardMin: 0,
    description: 'Event-loop delay, i.e. how late timers actually fire.',
  },
  heartbeat_delay_ms: {
    name: 'heartbeat_delay_ms',
    unit: 'milliseconds',
    polarity: 'higher-is-worse',
    group: 'runtime',
    hardMin: 0,
    description: 'Lateness of the most recent runtime heartbeat.',
  },
  restart_count: {
    name: 'restart_count',
    unit: 'count',
    polarity: 'higher-is-worse',
    group: 'runtime',
    hardMin: 0,
    description: 'Process restarts observed since the supervisor started.',
  },
  ipc_timeout_rate: {
    name: 'ipc_timeout_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'runtime',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of host/worker IPC calls that timed out.',
  },
  // ----------------------------------------------------------------- workers
  active_workers: {
    name: 'active_workers',
    unit: 'count',
    polarity: 'higher-is-worse',
    group: 'workers',
    hardMin: 0,
    description: 'Workers currently executing a task.',
  },
  queued_tasks: {
    name: 'queued_tasks',
    unit: 'count',
    polarity: 'higher-is-worse',
    group: 'workers',
    hardMin: 0,
    description: 'Tasks waiting for a worker slot.',
  },
  task_latency_ms: {
    name: 'task_latency_ms',
    unit: 'milliseconds',
    polarity: 'higher-is-worse',
    group: 'workers',
    hardMin: 0,
    description: 'Observed task latency.',
  },
  timeout_rate: {
    name: 'timeout_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'workers',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of tasks that hit their deadline.',
  },
  retry_rate: {
    name: 'retry_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'workers',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of tasks that had to be retried.',
  },
  failure_rate: {
    name: 'failure_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'workers',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of tasks that failed outright.',
  },
  spawn_failure_rate: {
    name: 'spawn_failure_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'workers',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of worker spawn attempts that failed.',
  },
  abnormal_exit_rate: {
    name: 'abnormal_exit_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'workers',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of worker exits that were not clean.',
  },
  queue_delay_ms: {
    name: 'queue_delay_ms',
    unit: 'milliseconds',
    polarity: 'higher-is-worse',
    group: 'workers',
    hardMin: 0,
    description: 'Time a task spent waiting before it started.',
  },
  // ----------------------------------------------------------- computer use
  screenshot_latency_ms: {
    name: 'screenshot_latency_ms',
    unit: 'milliseconds',
    polarity: 'higher-is-worse',
    group: 'computer-use',
    hardMin: 0,
    description: 'Latency of a desktop screenshot capture.',
  },
  action_latency_ms: {
    name: 'action_latency_ms',
    unit: 'milliseconds',
    polarity: 'higher-is-worse',
    group: 'computer-use',
    hardMin: 0,
    description: 'Latency of a synthetic input action.',
  },
  verification_retry_rate: {
    name: 'verification_retry_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'computer-use',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of actions that needed a verification retry.',
  },
  missed_target_rate: {
    name: 'missed_target_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'computer-use',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of actions that missed their intended target.',
  },
  recovery_rate: {
    name: 'recovery_rate',
    unit: 'ratio',
    polarity: 'lower-is-worse',
    group: 'computer-use',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of failed actions that recovered without help.',
  },
  desktop_responsiveness_ms: {
    name: 'desktop_responsiveness_ms',
    unit: 'milliseconds',
    polarity: 'higher-is-worse',
    group: 'computer-use',
    hardMin: 0,
    description: 'Round-trip latency of a desktop responsiveness probe.',
  },
  // ---------------------------------------------------------------------- ui
  render_latency_ms: {
    name: 'render_latency_ms',
    unit: 'milliseconds',
    polarity: 'higher-is-worse',
    group: 'ui',
    hardMin: 0,
    description: 'Time from commit to painted frame.',
  },
  main_window_heartbeat_ms: {
    name: 'main_window_heartbeat_ms',
    unit: 'milliseconds',
    polarity: 'higher-is-worse',
    group: 'ui',
    hardMin: 0,
    description: 'Interval between main-window heartbeats.',
  },
  blank_frame_rate: {
    name: 'blank_frame_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'ui',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of sampled frames that rendered blank.',
  },
  frontend_error_rate: {
    name: 'frontend_error_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'ui',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of frontend sessions reporting an uncaught error.',
  },
  // ----------------------------------------------------------------- context
  task_failure_rate: {
    name: 'task_failure_rate',
    unit: 'ratio',
    polarity: 'higher-is-worse',
    group: 'context',
    hardMin: 0,
    hardMax: 1,
    description: 'Share of agent turns that ended in failure.',
  },
  git_operations_per_minute: {
    name: 'git_operations_per_minute',
    unit: 'per-minute',
    polarity: 'higher-is-worse',
    group: 'context',
    hardMin: 0,
    description: 'Git operations per minute, used as a busy-signal for safe points.',
  },
};
/** Canonical metric names as a sorted array, for validation and presentation. */
export const CANONICAL_METRICS = Object.freeze(Object.keys(METRICS).sort());
/**
 * Look up a metric descriptor, or `undefined` when the name is not canonical.
 * @param {string} name - a candidate metric name.
 * @returns {object|undefined} the descriptor, or `undefined` when the name is not canonical.
 */
export function metricDescriptor(name) {
  return METRICS[name];
}
/**
 * True when `name` is a canonical metric.
 * @param {string} name - a candidate metric name.
 * @returns {boolean} `true` only for a canonical name, and never for a prototype key.
 */
export function isCanonicalMetric(name) {
  return Object.prototype.hasOwnProperty.call(METRICS, name);
}

// ------------------------------------------------------------------------ configuration vocabulary
/**
 * Every number in here is a default, never a law. The plugin ships three presets
 * (`conservative`, `balanced`, `aggressive`) that are complete documents of this
 * shape, and a user can override any leaf through the plugin's own settings
 * namespace or through a profile patch.
 */
/** The action a satisfied threshold produces. */
export const DECISION_LADDER = Object.freeze([
  'NO_ACTION',
  'THROTTLE',
  'PAUSE_NEW_WORK',
  'REQUEST_APP_RESTART',
  'REQUEST_SYSTEM_REBOOT',
]);
/** Dimensions in their canonical presentation order. */
export const PRESSURE_DIMENSIONS = Object.freeze([
  'time',
  'thermal',
  'memory',
  'runtime',
  'worker',
  'computer_use_ui',
]);

// ------------------------------------------------------------------------ decision vocabulary
/**
 * pressure, action levels, machine states, and the maintenance picture.
 *
 * Everything a consumer needs to explain a decision lives in these types. A
 * decision is never "the model thought so": it is a pressure number, a state, a
 * list of named drivers, and a list of reusable evidence strings.
 */
/** Ordinal rank of a level; `unknown` ranks above `none` but is scored separately. */
export const PRESSURE_LEVEL_RANK = Object.freeze({
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
  unknown: -1,
});
/** Numeric level of {@link DecisionAction}; escalation only ever increases it. */
export const ACTION_LEVEL = Object.freeze({
  NO_ACTION: 0,
  THROTTLE: 1,
  PAUSE_NEW_WORK: 2,
  REQUEST_APP_RESTART: 3,
  REQUEST_SYSTEM_REBOOT: 4,
});
