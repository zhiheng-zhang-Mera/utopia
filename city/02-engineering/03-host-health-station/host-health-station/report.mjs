/**
 * UTOPIA · City · Host Health Station — presentation helpers.
 *
 * Ported from the donor `dsh-health-scheduler` `src/dsh/report.ts` and the
 * presentation half of `src/dsh/plugin.ts` @ 985e2b7; see DONOR.json for the
 * porting ledger.
 *
 * Both renderers are derived from one `HealthSnapshot`, so a machine-readable
 * consumer and a human can never disagree about what the numbers were — and
 * every sentence is backed by a metric. That is the donor's rule against "the
 * model thought it should restart", carried over unchanged.
 *
 * What is *not* here: the donor's `tool()` wrapper, the harness tool contract
 * and the model-facing tool descriptions. Those are binding, not reporting; the
 * strings the tools returned are all in this file.
 *
 * @module host-health-station/report
 */

import { formatDuration } from './maintenance.mjs';
import { formatBytes } from './trend.mjs';

/**
 * Compact JSON payload for a machine consumer.
 *
 * @param {object} snapshot - a snapshot from `HealthScheduler.tick()`.
 * @returns {object} the same picture in snake_case, safe to serialise.
 */
export function metricsSnapshot(snapshot) {
  return {
    timestamp: snapshot.timestamp,
    state: snapshot.state,
    action: snapshot.action,
    restart_pressure: snapshot.pressure,
    coverage: snapshot.coverage,
    primary_cause: snapshot.primaryCause,
    unknown_dimensions: snapshot.unknownDimensions,
    capabilities: snapshot.capabilities,
    maintenance: {
      phase: snapshot.maintenance.phase,
      window_open: snapshot.maintenance.windowOpen,
      next_target_at: snapshot.maintenance.nextTargetAt,
      deferred_ms: snapshot.maintenance.deferredMs,
      defer_exhausted: snapshot.maintenance.deferExhausted,
      urgent_override: snapshot.maintenance.urgentOverride,
      summary: snapshot.maintenance.summary,
    },
    safe_point: {
      safe: snapshot.readiness.safe,
      reason: snapshot.readiness.reason,
      estimated_state: snapshot.readiness.estimated_state,
      summary: snapshot.readiness.summary,
    },
    dimensions: snapshot.dimensions.map((dimension) => ({
      dimension: dimension.dimension,
      score: dimension.score,
      level: dimension.level,
      weight: dimension.weight,
      effective_weight: Number(dimension.effectiveWeight.toFixed(4)),
      summary: dimension.summary,
      metrics: dimension.metrics.map((metric) => ({
        metric: metric.metric,
        value: metric.value,
        score: metric.score,
        level: metric.level,
        rule: metric.rule,
        sustained_ms: metric.sustainedMs,
        trend_applied: metric.trendApplied,
      })),
    })),
    drivers: snapshot.drivers.map((driver) => ({
      code: driver.code,
      dimension: driver.dimension,
      contribution: driver.contribution,
      detail: driver.detail,
    })),
    trends: snapshot.trends.map((trend) => ({
      metric: trend.metric,
      direction: trend.direction,
      slope_per_hour: trend.slopePerHour,
      r_squared: trend.rSquared,
      span_ms: trend.spanMs,
      summary: trend.summary,
    })),
    providers: snapshot.providers.map((provider) => ({
      id: provider.id,
      group: provider.group,
      available: provider.available,
      consecutive_failures: provider.consecutiveFailures,
      total_failures: provider.totalFailures,
      backoff_remaining_ms: provider.backoffRemainingMs,
      last_success_at: provider.lastSuccessAt,
      last_error: provider.lastError,
    })),
    metrics: snapshot.metrics,
    daily_summaries: snapshot.dailySummaries.map((day) => ({
      day_start: day.dayStart,
      metrics: day.metrics.map((metric) => ({
        metric: metric.metric,
        count: metric.count,
        mean: metric.mean,
        max: metric.max,
        min: metric.min,
      })),
    })),
    recent_decisions: snapshot.recentDecisions.map((record) => ({
      id: record.id,
      timestamp: record.timestamp,
      action: record.action,
      state: record.state,
      pressure: record.pressure,
      coverage: record.coverage,
      reasons: record.reasons,
      outcome: record.outcome,
    })),
    warnings: snapshot.warnings,
  };
}

/**
 * Plain-text report, sized for a terminal or a chat message.
 *
 * @param {object} snapshot - a snapshot from `HealthScheduler.tick()`.
 * @returns {string} the report, newline-joined.
 */
export function renderHealthReport(snapshot) {
  const lines = [];
  const pressure = snapshot.pressure === null ? 'unknown' : `${snapshot.pressure} / 100`;
  lines.push(`Restart Pressure: ${pressure}`);
  lines.push(`State: ${snapshot.state}`);
  lines.push(`Primary Cause: ${snapshot.primaryCause ?? 'none'}`);
  lines.push(`Telemetry coverage: ${Math.round(snapshot.coverage * 100)}%`);
  if (snapshot.unknownDimensions.length > 0) {
    lines.push(`Unknown dimensions: ${snapshot.unknownDimensions.join(', ')} (not scored as healthy)`);
  }
  lines.push(`Maintenance: ${snapshot.maintenance.summary}`);
  lines.push(`Safe point: ${snapshot.readiness.summary}`);
  lines.push(`Capabilities: restart=${snapshot.capabilities.restart}, worker-control=${snapshot.capabilities.workerControl}`);
  lines.push('');
  lines.push('Dimensions:');
  for (const dimension of snapshot.dimensions) {
    const score = dimension.score === null ? 'unknown' : `${dimension.score}`;
    lines.push(`  ${dimension.dimension.padEnd(16)} ${score.padStart(7)}  ${dimension.level.padEnd(8)} weight=${dimension.weight}`);
  }
  if (snapshot.drivers.length > 0) {
    lines.push('');
    lines.push('Drivers:');
    for (const driver of snapshot.drivers.slice(0, 6)) {
      lines.push(`  [${driver.contribution.toFixed(1)} pts] ${driver.code}: ${driver.detail}`);
    }
  }
  if (snapshot.trends.length > 0) {
    lines.push('');
    lines.push('Worsening trends:');
    for (const trend of snapshot.trends.slice(0, 6)) {
      lines.push(`  ${trend.metric}: ${trend.summary}`);
    }
  }
  lines.push('');
  lines.push('Providers:');
  for (const provider of snapshot.providers) {
    const status = provider.available
      ? `ok (${provider.totalSuccesses} samples)`
      : `unavailable (${provider.consecutiveFailures} consecutive failures, backoff ${formatDuration(provider.backoffRemainingMs)})`;
    lines.push(`  ${provider.id.padEnd(16)} ${status}${provider.lastError === null ? '' : ` — ${provider.lastError}`}`);
  }
  lines.push('');
  lines.push('Memory:');
  lines.push(`  process RSS: ${formatBytes(snapshot.metrics.process_rss_bytes ?? 0)}`);
  lines.push(`  RAM used: ${snapshot.metrics.ram_used_ratio === undefined || snapshot.metrics.ram_used_ratio === null ? 'unknown' : `${Math.round(snapshot.metrics.ram_used_ratio * 100)}%`}`);
  if (snapshot.recentDecisions.length > 0) {
    lines.push('');
    lines.push('Recent decisions (newest last):');
    for (const record of snapshot.recentDecisions.slice(-5)) {
      lines.push(`  #${record.id} ${record.timestamp} ${record.action} -> ${record.state} (pressure ${record.pressure ?? 'unknown'}, ${record.outcome.applied ? 'applied' : 'not applied'})`);
      lines.push(`      reasons: ${record.reasons.slice(0, 5).join(', ')}`);
    }
  }
  if (snapshot.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of snapshot.warnings)
      lines.push(`  - ${warning}`);
  }
  return lines.join('\n');
}

/**
 * Render one metric table row. Exported for golden-output assertions.
 *
 * @param {string} name - metric name.
 * @param {number|null} value - normalized value, or `null` when unknown.
 * @returns {string} a padded `name value` row.
 */
export function renderMetricRow(name, value) {
  return `${name.padEnd(28)} ${value === null ? 'unknown' : value}`;
}

/**
 * The pressure half of the donor's `health_policy`-style reports.
 *
 * @param {object} snapshot - a snapshot from `HealthScheduler.tick()`.
 * @returns {string} restart pressure, state, coverage, cause and every driver.
 */
export function renderPressureSection(snapshot) {
  const lines = [
    `Restart Pressure: ${snapshot.pressure === null ? 'unknown' : `${snapshot.pressure} / 100`}`,
    `State: ${snapshot.state}`,
    `Coverage: ${Math.round(snapshot.coverage * 100)}%`,
    `Primary cause: ${snapshot.primaryCause ?? 'none'}`,
  ];
  for (const driver of snapshot.drivers) {
    lines.push(`  [${driver.contribution.toFixed(1)}] ${driver.code}: ${driver.detail}`);
  }
  return lines.join('\n');
}

/**
 * The maintenance half of the donor's report sections.
 *
 * @param {object} snapshot - a snapshot from `HealthScheduler.tick()`.
 * @returns {string} window phase, deferral and capability in six lines.
 */
export function renderMaintenanceSection(snapshot) {
  return [
    `Maintenance phase: ${snapshot.maintenance.phase}`,
    `Window open: ${snapshot.maintenance.windowOpen}`,
    `Next target: ${snapshot.maintenance.nextTargetAt ?? 'not scheduled'}`,
    `Deferred: ${Math.round(snapshot.maintenance.deferredMs / 1000)}s`,
    `Safe point: ${snapshot.readiness.summary}`,
    `Restart capability: ${snapshot.capabilities.restart}`,
  ].join('\n');
}

/**
 * The provider half of the donor's report sections.
 *
 * @param {object} snapshot - a snapshot from `HealthScheduler.tick()`.
 * @returns {string} one line per provider with its backoff and last error.
 */
export function renderProviderSection(snapshot) {
  return snapshot.providers
    .map((provider) => `${provider.id}: ${provider.available ? 'available' : 'unavailable'} ` +
      `(successes=${provider.totalSuccesses}, failures=${provider.totalFailures}, ` +
      `backoff=${Math.round(provider.backoffRemainingMs / 1000)}s)` +
      (provider.lastError === null ? '' : ` — ${provider.lastError}`))
    .join('\n');
}
