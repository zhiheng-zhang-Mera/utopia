/**
 * UTOPIA · City · Host Health Station — the scheduler.
 *
 * Ported from the donor `dsh-health-scheduler` src/core/scheduler.js @ 985e2b7;
 * see DONOR.json for the porting ledger. Behaviour is unchanged.
 *
 * The scheduler: the one object that owns a tick.
 *
 * ```
 * sample -> normalize -> roll up -> score -> decide -> request -> audit
 * ```
 *
 * Everything before "decide" is measurement, everything after it is a request to
 * somebody else. The scheduler holds no task state, performs no restart and
 * touches no worker internals; it owns exactly the loop, the history, and the
 * audit trail.
 *
 * Every stage is defensive on purpose. A provider that throws, an adapter that is
 * missing, a disk that is read-only — none of them may stop the loop, because a
 * health monitor that dies when the machine is unhealthy is worse than no monitor.
 *
 * @module host-health-station/scheduler
 */
import { ACTION_LEVEL } from './types.mjs';
import { DecisionLog } from './audit.mjs';
import { bandKeyOf } from './bands.mjs';
import { normalizeSample } from './normalize.mjs';
import { computeMaintenancePicture } from './maintenance.mjs';
import { PolicyEngine, cooldownKindOf, cooldownMsOf, initialActionAttempts, initialPolicyState, } from './policy.mjs';
import { PressureEngine } from './pressure.mjs';
import { RollingStore } from './rolling.mjs';
import { SafePointRegistry } from './safe-point.mjs';
import { TrendAnalyzer } from './trend.mjs';
import { ProviderRegistry } from './providers.mjs';
/** How many consecutive deferrals before the picture flips to `overdue`. */
export class HealthScheduler {
  /** Configuration in force; replaced by {@link HealthScheduler.reconfigure}. */
  config;
  /** Safe-point sources. */
  safePoints = new SafePointRegistry();
  /** Rolling history. */
  store;
  /** Decision audit log. */
  log;
  providers;
  pressure;
  policy;
  trends;
  restart;
  workerControl;
  clock;
  listeners = new Map();
  violations = [];
  timer = null;
  lastTickAt = 0;
  lastTrendAt = 0;
  /** Trends from the last full evaluation, reused between trend intervals. */
  lastTrends = [];
  /** Memoised daily rollup and the instant it was folded. */
  summaryCache = null;
  summaryCacheAt = 0;
  state;
  /**
   * What the adapters have actually been asked to do, and the cooldowns that
   * follow from those attempts. Kept here rather than in the policy engine
   * because only this class knows whether an adapter was really invoked.
   */
  attempts = initialActionAttempts();
  lastSnapshot = null;
  deferredSinceMs = null;
  workerLimitApplied = null;
  sequence = 0;
  /** Last failed action attempt, so a persistent failure is reported once, then every 15 min. */
  lastFailure = null;
  /** The action currently in force because an adapter accepted it. */
  appliedAction = 'NO_ACTION';
  constructor(options) {
    this.config = options.config;
    this.clock = options.clock ?? (() => Date.now());
    this.restart = options.restart;
    this.workerControl = options.workerControl;
    this.store = new RollingStore(options.config.windows);
    this.trends = new TrendAnalyzer(this.store, options.config.trend);
    this.pressure = new PressureEngine(this.store, this.trends, options.config);
    this.policy = new PolicyEngine(options.config);
    this.state = initialPolicyState(this.clock());
    this.providers = new ProviderRegistry({
      sampling: options.config.sampling,
      resilience: options.config.resilience,
      disabledProviders: options.config.disabledProviders,
    });
    this.log = new DecisionLog({
      maxRecords: options.config.storage.maxRecentDecisions,
      directory: options.config.storage.enabled ? options.stateDirectory : null,
      maxBytes: options.config.storage.maxLogBytes,
      now: this.clock,
    });
    this.providers.onFailure((failure) => this.emit('provider-failure', failure));
    for (const source of options.safePoints ?? []) {
      this.safePoints.register(source);
    }
  }
  /** Register a health provider. */
  registerProvider(provider) {
    return this.providers.register(provider);
  }
  /** Subscribe to an event. Returns a disposer. */
  on(event, listener) {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (set === undefined)
      return;
    for (const listener of set) {
      try {
        listener(payload);
      }
      catch {
        // A listener must never break the loop.
      }
    }
  }
  /** Whether the periodic loop is running. */
  get running() {
    return this.timer !== null;
  }
  /** Start the periodic loop. Idempotent. */
  start() {
    if (this.timer !== null || !this.config.enabled)
      return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.emit('error', error);
      });
    }, this.config.sampling.intervalMs);
    this.timer.unref?.();
  }
  /** Stop the periodic loop and release the timer. */
  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /** Replace the configuration. History and state are preserved. */
  reconfigure(config) {
    const wasRunning = this.running;
    this.stop();
    this.config = config;
    this.providers.resetBackoff();
    if (wasRunning)
      this.start();
  }
  /** Metrics currently tracked, sorted. */
  trackedMetrics() {
    return this.store.metrics();
  }
  /** Window statistics for one metric across every configured window. */
  windowsFor(metric) {
    return this.store.statsByWindow(metric, this.clock());
  }
  /** The most recent snapshot, or `null` before the first tick. */
  get snapshot() {
    return this.lastSnapshot;
  }
  /** Decisions kept in memory, newest last. */
  decisions(limit) {
    return this.log.recent(limit);
  }
  /**
   * Run one tick.
   *
   * @returns the snapshot produced by this tick.
   */
  async tick() {
    const nowMs = this.clock();
    const timestamp = new Date(nowMs).toISOString();
    this.lastTickAt = nowMs;
    const warnings = [];
    if (!this.config.enabled) {
      const snapshot = this.buildSnapshot(timestamp, null, warnings);
      this.lastSnapshot = snapshot;
      return snapshot;
    }
    // 1. Sample every available provider, containing failures.
    const round = await this.providers.sampleAll(nowMs, timestamp);
    for (const skipped of round.skipped) {
      warnings.push(`provider ${skipped} skipped (backoff or disabled)`);
    }
    // 2. Normalize and record.
    let recorded = 0;
    for (const sample of round.samples) {
      const normalized = normalizeSample(sample);
      for (const violation of normalized.violations) {
        this.violations.push(violation);
        this.emit('violation', violation);
      }
      if (normalized.violations.length > 0) {
        warnings.push(`${sample.provider}: ${normalized.violations.length} reading(s) rejected (${normalized.violations
          .map((violation) => `${violation.metric}:${violation.reason}`)
          .join(', ')})`);
      }
      if (sample.degraded === true && sample.note !== undefined) {
        warnings.push(`${sample.provider}: ${sample.note}`);
      }
      this.store.recordBag(normalized.metrics, nowMs, (metric, value) => this.bandKeyFor(metric, value));
      recorded += Object.keys(normalized.metrics).length;
    }
    if (recorded === 0) {
      warnings.push(round.samples.length === 0
        ? 'no provider produced a sample this tick: every subsystem is reported as unknown'
        : 'no canonical metrics were produced by any provider this tick');
    }
    // 3. Pressure.
    const uptimeMs = uptimeOf(this.store);
    const pressureSnapshot = this.pressure.evaluate({
      nowMs,
      timestamp,
      uptimeMs,
      restartCount: this.store.latest('restart_count'),
    });
    // 4. Maintenance picture, including the deferral ledger.
    const picture = computeMaintenancePicture(this.config.maintenance, nowMs, this.deferredSinceMs, pressureSnapshot.restartPressure);
    if (picture.windowOpen && this.deferredSinceMs === null) {
      this.deferredSinceMs = Math.max(picture.nextTargetAt === null ? nowMs : Date.parse(picture.nextTargetAt), nowMs);
    }
    if (!picture.windowOpen && picture.phase === 'outside_window' && (this.deferredSinceMs ?? 0) > 0) {
      // A closed window resets the deferral ledger for the next window.
      const closesIn = picture.windowClosesInMs;
      if (closesIn === 0)
        this.deferredSinceMs = null;
    }
    this.emit('maintenance', picture);
    // 5. Safe-point readiness, only when the configuration can use it.
    //
    // `null` means "this deployment does not consult a safe point", and the policy
    // engine skips the gate entirely. An object whose `safe` is `null` means the
    // opposite — a source was asked and did not answer — and the policy engine blocks
    // on it. Building the second from the first would make `safePointRequired: false`
    // block every restart, which is precisely the setting an operator uses to opt out.
    const readiness = this.config.maintenance.safePointRequired
      ? await this.safePoints.readiness()
      : null;
    // 6. Policy.
    const { decision, state } = this.policy.evaluate({
      pressure: pressureSnapshot,
      maintenance: picture,
      readiness,
      restartCapability: this.restart.capability,
      workerControlCapability: this.workerControl.capability,
      nowMs,
      timestamp,
      attempts: this.attempts,
    }, this.state);
    this.state = state;
    // 7. Apply the action through an adapter, and record the attempt. Only here,
    // where the adapter is actually invoked, is it known whether anything
    // happened — which is why the cooldown starts here and not in the policy.
    const outcome = await this.applyAction(decision, warnings);
    if (outcome !== null) {
      this.noteAttempt(decision.effectiveAction, nowMs);
      this.appliedAction = outcome.applied ? decision.effectiveAction : 'NO_ACTION';
    }
    else if (ACTION_LEVEL[decision.effectiveAction] < ACTION_LEVEL.THROTTLE) {
      this.appliedAction = 'NO_ACTION';
    }
    if (outcome !== null && !outcome.applied) {
      this.noteFailure(decision.effectiveAction, nowMs, outcome.detail);
      warnings.push(`action ${decision.effectiveAction} was requested but not applied (${outcome.detail})`);
      this.emit('error', new Error(`action ${decision.effectiveAction} not applied: ${outcome.detail}`));
    }
    else if (outcome !== null && outcome.applied) {
      this.lastFailure = null;
    }
    else if (decision.effectiveAction !== 'NO_ACTION' && this.lastFailure !== null) {
      // The action is still in force but was not re-attempted. Say so at a human
      // cadence instead of once per tick, because "we are still degraded and have
      // not been able to do anything about it" is worth repeating — just not
      // every fifteen seconds.
      const quietMs = nowMs - this.lastFailure.atMs;
      if (quietMs >= UNRESOLVED_WARNING_INTERVAL_MS) {
        this.lastFailure = { ...this.lastFailure, atMs: nowMs };
        warnings.push(`action ${decision.effectiveAction} remains unresolved after ${Math.round(quietMs / 60_000)} min (${this.lastFailure.detail})`);
      }
    }
    // 8. Audit.
    if (outcome !== null) {
      const record = {
        id: this.log.nextId(),
        timestamp,
        action: decision.effectiveAction,
        state: decision.toState,
        pressure: pressureSnapshot.restartPressure,
        coverage: pressureSnapshot.coverage,
        drivers: pressureSnapshot.drivers,
        reasons: decision.reasons,
        outcome,
      };
      this.log.append(record);
      this.emit('decision', record);
    }
    const trends = nowMs - this.lastTrendAt >= this.config.sampling.trendIntervalMs || this.lastTrends.length === 0
      ? this.trends.worsening({}, nowMs, this.config.windows.windowsMs[this.config.windows.windowsMs.length - 1] ?? 3_600_000)
      : this.lastTrends;
    if (nowMs - this.lastTrendAt >= this.config.sampling.trendIntervalMs) {
      this.lastTrendAt = nowMs;
      this.lastTrends = trends;
    }
    const snapshot = this.buildSnapshot(timestamp, pressureSnapshot, warnings, picture, readiness ?? undefined, trends);
    this.lastSnapshot = snapshot;
    this.emit('pressure', pressureSnapshot);
    return snapshot;
  }
  /**
   * Daily rolled-up history, oldest day first.
   *
   * Four numbers per metric per local day — mean, max, min, count — which is all
   * "is this machine getting worse over weeks?" needs. The raw samples behind
   * them are long gone; this reads the aggregate buckets.
   */
  dailySummaries() {
    return this.store.dailySummaries(this.clock());
  }
  /**
   * Daily summaries for a snapshot, memoised for `sampling.summaryIntervalMs`.
   *
   * The fold is cheap but not free, and a snapshot is built on every tick — fifteen
   * times a minute, for a payload that changes once a day. Keeping the interval an
   * explicit setting is also what makes it an honest knob rather than a number
   * nobody reads.
   */
  memoisedDailySummaries(nowMs) {
    if (this.summaryCache === null || nowMs - this.summaryCacheAt >= this.config.sampling.summaryIntervalMs) {
      this.summaryCache = this.store.dailySummaries(nowMs);
      this.summaryCacheAt = nowMs;
    }
    return this.summaryCache;
  }
  /** Remember a failed action attempt for the resolve-later warning. */
  noteFailure(action, atMs, detail) {
    const previous = this.lastFailure;
    if (previous !== null && previous.action === action) {
      this.lastFailure = { ...previous, detail };
      return;
    }
    this.lastFailure = { action, atMs, detail };
  }
  /**
   * Record that an action was attempted, and start its cooldown.
   *
   * Called for a failed attempt as well as a successful one: the cooldown exists
   * to pace the *capability*, so a refusal must start it too. This is the whole
   * reason the attempt log lives here and not in the policy engine.
   */
  noteAttempt(action, atMs) {
    if (action === 'NO_ACTION')
      return;
    const kind = cooldownKindOf(action);
    this.attempts = {
      lastAttemptAt: atMs,
      lastAttemptAction: action,
      cooldowns: { ...this.attempts.cooldowns, [kind]: atMs + cooldownMsOf(this.config, action) },
    };
  }
  /** Band identity of a recorded value, so the store can time the sustain gate. */
  bandKeyFor(metric, value) {
    const band = this.config.metrics[metric]?.band;
    if (band === undefined)
      return null;
    return bandKeyOf(metric, value, band);
  }
  /** Translate the decided action into one adapter call. */
  async applyAction(decision, warnings) {
    const action = decision.effectiveAction;
    // A mitigation that is no longer needed is released. This runs for any action
    // below THROTTLE, including the case where pressure recovered but the state
    // machine is still unwinding, so a throttle can never outlive its cause.
    if (ACTION_LEVEL[action] < ACTION_LEVEL.THROTTLE && this.workerLimitApplied !== null) {
      this.workerLimitApplied = null;
      if (this.workerControl.capability === 'available') {
        await this.workerControl.resumeNormalConcurrency().catch((error) => {
          warnings.push(`resumeNormalConcurrency failed: ${error.message}`);
        });
      }
    }
    if (action === 'NO_ACTION')
      return null;
    // An action that is already in force is already in force. Without this the
    // scheduler would re-issue its mitigation every time a cooldown lapsed, which
    // over a long incident is a decision storm with nothing to show for it.
    // A *failed* attempt is not "in force", so it is retried on the next cooldown.
    if (action === this.appliedAction)
      return null;
    // Otherwise pace the capability itself: a repeated attempt waits out the
    // bucket cooldown. Keying this off the attempt (not the successful
    // application) is what stops a refusing or failing adapter — a missing
    // restart plugin, a rejected request — from turning into a request storm.
    const cooldownKey = cooldownKindOf(action);
    const cooldownUntil = this.attempts.cooldowns[cooldownKey];
    if (action === this.attempts.lastAttemptAction && cooldownUntil > this.clock()) {
      return null;
    }
    switch (action) {
      case 'THROTTLE': {
        if (this.workerControl.capability !== 'available') {
          return {
            applied: false,
            capability: 'unavailable',
            adapter: this.workerControl.id,
            detail: 'worker-control capability is unavailable; monitoring continues without throttle control',
          };
        }
        const limit = throttleLimit(this.config, this.store.latest('active_workers'));
        if (limit === null) {
          return {
            applied: false,
            capability: 'available',
            adapter: this.workerControl.id,
            detail: 'no concurrency target configured or derivable; throttle is a no-op',
          };
        }
        try {
          await this.workerControl.setConcurrencyLimit(limit);
          this.workerLimitApplied = limit;
          return {
            applied: true,
            capability: 'available',
            adapter: this.workerControl.id,
            detail: `concurrency limited to ${limit}`,
          };
        }
        catch (error) {
          return {
            applied: false,
            capability: 'failed',
            adapter: this.workerControl.id,
            detail: `setConcurrencyLimit failed: ${error.message}`,
          };
        }
      }
      case 'PAUSE_NEW_WORK': {
        if (this.workerControl.capability !== 'available') {
          return {
            applied: false,
            capability: 'unavailable',
            adapter: this.workerControl.id,
            detail: 'worker-control capability is unavailable; new work is not paused',
          };
        }
        try {
          await this.workerControl.pauseNewWorkers();
          return {
            applied: true,
            capability: 'available',
            adapter: this.workerControl.id,
            detail: 'new worker admission paused',
          };
        }
        catch (error) {
          return {
            applied: false,
            capability: 'failed',
            adapter: this.workerControl.id,
            detail: `pauseNewWorkers failed: ${error.message}`,
          };
        }
      }
      case 'REQUEST_APP_RESTART':
      case 'REQUEST_SYSTEM_REBOOT': {
        if (this.restart.capability !== 'available') {
          return {
            applied: false,
            capability: 'unavailable',
            adapter: this.restart.id,
            detail: 'restart capability is unavailable; health monitoring continues',
          };
        }
        this.sequence += 1;
        const systemRestart = action === 'REQUEST_SYSTEM_REBOOT';
        const request = {
          requestId: `hs-${this.clock()}-${this.sequence}`,
          source: 'dsh-health-scheduler',
          mode: systemRestart ? 'system' : 'application',
          reasonCode: systemRestart ? 'SYSTEM_PRESSURE' : 'RUNTIME_PRESSURE',
          reasonSummary: decision.reasons.join(', '),
          checkpointRequired: this.config.maintenance.safePointRequired,
          priority: systemRestart ? 'high' : 'normal',
          // `dsh-restart` requires this for `mode: 'system'`, and requires it to be an
          // explicit statement rather than an inference from the mode. Without it the
          // top rung of the ladder is refused with SYSTEM_REBOOT_NOT_PERMITTED, which
          // means the escalation path exists in the policy and nowhere else.
          ...(systemRestart ? { acknowledgeSystemReboot: true } : {}),
        };
        try {
          const response = action === 'REQUEST_APP_RESTART'
            ? await this.restart.requestApplicationRestart(request)
            : await this.restart.requestSystemRestart(request);
          return {
            applied: response.accepted,
            capability: response.accepted ? 'available' : 'failed',
            adapter: this.restart.id,
            detail: response.accepted ? `restart accepted (${response.state})` : `restart rejected: ${response.reason ?? 'unknown'}`,
            ...(response.requestId === undefined ? {} : { reference: response.requestId }),
          };
        }
        catch (error) {
          return {
            applied: false,
            capability: 'failed',
            adapter: this.restart.id,
            detail: `restart request failed: ${error.message}`,
          };
        }
      }
      default:
        return null;
    }
  }
  buildSnapshot(timestamp, pressureSnapshot, warnings, picture, readiness, trends) {
    const maintenance = picture ??
      computeMaintenancePicture(this.config.maintenance, this.clock(), this.deferredSinceMs, null);
    const readinessValue = readiness ?? {
      safe: null,
      reason: 'not_evaluated',
      estimated_state: 'unknown',
      sources: [],
      summary: 'safe point not evaluated for this snapshot',
    };
    const metrics = {};
    for (const metric of this.store.metrics())
      metrics[metric] = this.store.latest(metric);
    return {
      timestamp,
      state: this.state.state,
      action: this.state.action,
      pressure: pressureSnapshot?.restartPressure ?? this.state.lastPressure,
      coverage: pressureSnapshot?.coverage ?? 0,
      primaryCause: pressureSnapshot?.primaryCause ?? null,
      dimensions: pressureSnapshot?.dimensions ?? [],
      drivers: pressureSnapshot?.drivers ?? [],
      unknownDimensions: pressureSnapshot?.unknownDimensions ?? [],
      maintenance,
      readiness: readinessValue,
      capabilities: {
        restart: this.restart.capability,
        workerControl: this.workerControl.capability,
      },
      providers: this.providers.status(this.clock()),
      trends: trends ?? [],
      metrics,
      recentDecisions: this.log.recent(10),
      dailySummaries: this.memoisedDailySummaries(this.clock()),
      warnings: [...warnings],
    };
  }
  /** Violations collected so far, oldest first. */
  normalizationViolations() {
    return [...this.violations];
  }
  /** Provider failures collected so far, newest last. */
  get lastTickMs() {
    return this.lastTickAt;
  }
  /** Force one provider status refresh, for tests. */
  providerStatus() {
    return this.providers.status(this.clock());
  }
  /** Feed a failure directly, so tests can exercise the audit path. */
  recordProviderFailure(failure) {
    this.emit('provider-failure', failure);
  }
  /** Record an externally produced sample, bypassing the provider registry. */
  ingest(sample) {
    const nowMs = this.clock();
    const normalized = normalizeSample(sample);
    for (const violation of normalized.violations) {
      this.violations.push(violation);
      this.emit('violation', violation);
    }
    this.store.recordBag(normalized.metrics, nowMs);
  }
}
/** Uptime in milliseconds from the rolling store, or `null` when absent. */
function uptimeOf(store) {
  const seconds = store.latest('uptime_seconds');
  return seconds === null ? null : seconds * 1000;
}
/** How often an unresolved action failure is re-reported in the warnings list. */
const UNRESOLVED_WARNING_INTERVAL_MS = 15 * 60_000;
/**
 * Concurrency limit a THROTTLE action asks for.
 * An explicit `throttle.concurrencyLimit` always wins. Otherwise the plugin
 * derives one from the observed worker count, and refuses to guess when there is
 * nothing to derive from — asking a harness to "reduce" an unknown quantity is
 * how a health plugin accidentally stops all work.
 */
function throttleLimit(config, activeWorkers) {
  if (config.throttle.concurrencyLimit !== null)
    return config.throttle.concurrencyLimit;
  if (activeWorkers === null || activeWorkers <= 0)
    return null;
  return Math.max(1, Math.floor(activeWorkers * config.throttle.concurrencyFactor));
}
