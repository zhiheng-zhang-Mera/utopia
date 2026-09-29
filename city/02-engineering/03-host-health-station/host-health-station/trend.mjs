/**
 * UTOPIA · City · Host Health Station — trend analysis.
 *
 * Ported from the donor `dsh-health-scheduler` src/core/trend.js @ 985e2b7;
 * see DONOR.json for the porting ledger. Behaviour is unchanged.
 *
 * Trend analysis.
 *
 * A leak is not a value, it is a slope. This module decides whether a metric's
 * movement is real enough to act on: enough samples, a long enough span, a good
 * enough fit, and — crucially — the right *polarity*. A GPU temperature falling
 * 20 °C over an hour is a strong trend and not a problem; the same slope upward
 * is.
 *
 * @module host-health-station/trend
 */
import { metricDescriptor } from './types.mjs';
/**
 * Format a byte count as `MB`/`GB`/`KB`, for trend summaries.
 * @param {number} bytes - a byte count, possibly negative.
 * @returns {string} the count in `GB` (2dp), `MB` (1dp), `KB` (1dp) or `B`.
 */
export function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (abs >= 1024 ** 2)
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (abs >= 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes.toFixed(0)} B`;
}
/**
 * Format a metric delta with its canonical unit, for trend summaries.
 * @param {string} metric - canonical metric name, used for its unit.
 * @param {number} delta - the change in the metric's own unit.
 * @returns {string} the change with its canonical unit.
 */
export function formatDelta(metric, delta) {
  const descriptor = metricDescriptor(metric);
  switch (descriptor?.unit) {
    case 'bytes':
      return formatBytes(delta);
    case 'celsius':
      return `${delta.toFixed(2)} °C`;
    case 'ratio':
      return `${(delta * 100).toFixed(2)} pp`;
    case 'milliseconds':
      return `${delta.toFixed(0)} ms`;
    case 'seconds':
      return `${delta.toFixed(0)} s`;
    case 'count':
      return `${delta.toFixed(1)}`;
    case 'per-minute':
      return `${delta.toFixed(1)}/min`;
    default:
      return `${delta.toFixed(3)}`;
  }
}
/**
 * Format a slope in units per hour using the metric's canonical unit.
 * @param {string} metric - canonical metric name, used for its unit.
 * @param {number} slope - the slope in metric units per hour.
 * @returns {string} the slope with a `/h` suffix.
 */
export function formatSlopePerHour(metric, slope) {
  const descriptor = metricDescriptor(metric);
  if (descriptor?.unit === 'bytes')
    return `${formatBytes(slope)}/h`;
  return `${formatDelta(metric, slope)}/h`;
}
/**
 * Decide whether a metric's movement over a horizon is a worsening trend.
 */
export class TrendAnalyzer {
  config;
  store;
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }
  /**
   * Evaluate one metric over a horizon.
   *
   * Raw samples are preferred while they reach back far enough. Past that the
   * aggregate buckets take over, because a horizon the raw window cannot cover is
   * not "no trend" — it is a trend that has to be read from a coarser series.
   *
   * @param metric - canonical metric name.
   * @param nowMs - evaluation instant.
   * @param horizonMs - look-back horizon in milliseconds.
   */
  evaluate(metric, nowMs, horizonMs) {
    const points = this.store.rawPoints(metric, horizonMs, nowMs);
    const rawSpan = points.length >= 2 ? points[points.length - 1].t - points[0].t : 0;
    // A raw series that only reaches halfway across the requested horizon is worse
    // than the buckets, so the buckets win as soon as raw coverage falls short.
    if (rawSpan < horizonMs * 0.9) {
      const bucketFit = this.store.fitBuckets(metric, horizonMs, nowMs);
      if (bucketFit !== null && bucketFit.spanMs >= this.config.minSpanMs) {
        return this.verdict(metric, bucketFit, 'aggregate buckets');
      }
    }
    const count = points.length;
    const first = points[0];
    const last = points[points.length - 1];
    const spanMs = first !== undefined && last !== undefined ? last.t - first.t : 0;
    if (count < this.config.minSamples || spanMs < this.config.minSpanMs) {
      return {
        metric,
        direction: 'unknown',
        slopePerHour: null,
        rSquared: null,
        spanMs,
        count,
        isWorsening: false,
        summary: count === 0
          ? 'no samples in horizon'
          : `insufficient observation (${count} samples over ${Math.round(spanMs / 1000)} s)`,
      };
    }
    const fit = slope(points);
    if (fit === null) {
      return {
        metric,
        direction: 'unknown',
        slopePerHour: null,
        rSquared: null,
        spanMs,
        count,
        isWorsening: false,
        summary: 'no time variance in horizon',
      };
    }
    return this.verdict(metric, { slopePerHour: fit.slope, rSquared: fit.rSquared, count, spanMs }, 'raw samples');
  }
  /** Turn a fit into a trend verdict, applying the trust gates. */
  verdict(metric, fit, source) {
    const descriptor = metricDescriptor(metric);
    const rising = fit.slopePerHour > 0;
    const direction = fit.rSquared < this.config.minRSquared ? 'flat' : rising ? 'rising' : 'falling';
    const worsening = descriptor?.polarity === 'higher-is-worse' ? rising : !rising;
    const trusted = fit.rSquared >= this.config.minRSquared;
    const isWorsening = trusted && worsening && Math.abs(fit.slopePerHour) > 0;
    const summary = trusted
      ? `${formatSlopePerHour(metric, fit.slopePerHour)} (R²=${fit.rSquared.toFixed(2)}, ${Math.round(fit.spanMs / 60_000)} min, ${source})`
      : `movement within noise (R²=${fit.rSquared.toFixed(2)} < ${this.config.minRSquared})`;
    return {
      metric,
      direction,
      slopePerHour: fit.slopePerHour,
      rSquared: fit.rSquared,
      spanMs: fit.spanMs,
      count: fit.count,
      isWorsening,
      summary,
    };
  }
  /**
   * Evaluate a set of metrics and return only the worsening ones, worst first.
   */
  worsening(options, nowMs, defaultHorizonMs) {
    const horizonMs = options.horizonMs ?? defaultHorizonMs;
    const metrics = options.metrics ?? this.store.metrics();
    const trends = metrics
      .map((metric) => this.evaluate(metric, nowMs, horizonMs))
      .filter((trend) => trend.isWorsening);
    trends.sort((a, b) => (b.rSquared ?? 0) - (a.rSquared ?? 0));
    return trends;
  }
  /**
   * Project when a metric will reach a ceiling, given its current slope.
   *
   * @param metric - canonical metric name.
   * @param ceiling - the value of interest, in the metric's own unit.
   * @param nowMs - evaluation instant.
   * @param horizonMs - fitting horizon.
   */
  projectToCeiling(metric, ceiling, nowMs, horizonMs) {
    const trend = this.evaluate(metric, nowMs, horizonMs);
    const perHour = trend.slopePerHour;
    if (perHour === null || perHour <= 0) {
      return { metric, perHour, perDay: perHour === null ? null : perHour * 24, msToCeiling: null };
    }
    const latest = this.store.latest(metric);
    if (latest === null) {
      return { metric, perHour, perDay: perHour * 24, msToCeiling: null };
    }
    const remaining = ceiling - latest;
    if (remaining <= 0) {
      return { metric, perHour, perDay: perHour * 24, msToCeiling: 0 };
    }
    return {
      metric,
      perHour,
      perDay: perHour * 24,
      msToCeiling: (remaining / perHour) * 3_600_000,
    };
  }
}
/** Least-squares fit over raw points, in units per hour. */
function slope(points) {
  const n = points.length;
  if (n < 2)
    return null;
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.t;
    sumY += point.v;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const point of points) {
    const dx = point.t - meanX;
    const dy = point.v - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0)
    return null;
  const slopePerMs = sxy / sxx;
  const rSquared = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope: slopePerMs * 3_600_000, rSquared };
}
