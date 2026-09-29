/**
 * UTOPIA · City · Host Health Station — metric normalization.
 *
 * Ported from the donor `dsh-health-scheduler` src/core/normalize.js @ 985e2b7;
 * see DONOR.json for the porting ledger. Behaviour is unchanged.
 *
 * Metric normalization.
 *
 * Providers report what the hardware says. Normalization turns that into the
 * canonical vocabulary: it rejects impossible values, converts units, and — most
 * importantly — *omits* anything it cannot stand behind. A rejected reading is
 * reported as a violation so a broken provider is visible instead of silently
 * feeding zeros into the pressure model.
 *
 * @module host-health-station/normalize
 */
import { metricDescriptor } from './types.mjs';
/**
 * Coerce one raw reading to a canonical value.
 *
 * Returns a number, `null` for "omit", or throws nothing: every failure mode is
 * a violation entry rather than an exception, because one bad sensor must not
 * take down a tick.
 */
function normalizeValue(provider, metric, raw, violations) {
  const descriptor = metricDescriptor(metric);
  if (descriptor === undefined) {
    violations.push({
      provider,
      metric,
      reason: 'not_canonical',
      value: raw,
      detail: 'metric is not in the canonical registry',
    });
    return null;
  }
  if (typeof raw !== 'number') {
    violations.push({
      provider,
      metric,
      reason: 'not_a_number',
      value: raw,
      detail: `expected a number, received ${typeof raw}`,
    });
    return null;
  }
  if (!Number.isFinite(raw)) {
    violations.push({
      provider,
      metric,
      reason: 'not_finite',
      value: raw,
      detail: 'NaN and Infinity are not measurements',
    });
    return null;
  }
  let value = raw;
  // A ratio sent as a percentage is the single most common provider mistake, so
  // it is repaired with a violation rather than rejected as out of range.
  if (descriptor.unit === 'ratio' && value > 1 && value <= 1.5) {
    violations.push({
      provider,
      metric,
      reason: 'clamped',
      value,
      detail: 'ratio above 1.0 clamped to 1.0 (did the provider report a percentage?)',
    });
    value = 1;
  }
  if (descriptor.hardMin !== undefined && value < descriptor.hardMin) {
    if (value < descriptor.hardMin - 1e-9 * Math.max(1, Math.abs(descriptor.hardMin))) {
      violations.push({
        provider,
        metric,
        reason: 'below_hard_min',
        value,
        detail: `${value} is below the physical minimum ${descriptor.hardMin}`,
      });
      return null;
    }
    value = descriptor.hardMin;
  }
  if (descriptor.hardMax !== undefined && value > descriptor.hardMax) {
    if (value > descriptor.hardMax + 1e-9 * Math.max(1, Math.abs(descriptor.hardMax))) {
      violations.push({
        provider,
        metric,
        reason: 'above_hard_max',
        value,
        detail: `${value} is above the physical maximum ${descriptor.hardMax}`,
      });
      return null;
    }
    value = descriptor.hardMax;
  }
  return value;
}
/**
 * Normalize one provider sample.
 *
 * @param sample - the raw sample.
 * @returns canonical metrics and the violations that produced them.
 */
export function normalizeSample(sample) {
  const violations = [];
  const entries = [];
  for (const [key, raw] of Object.entries(sample.metrics ?? {})) {
    const value = normalizeValue(sample.provider, key, raw, violations);
    if (value !== null)
      entries.push([key, value]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const metrics = {};
  for (const [metric, value] of entries) {
    metrics[metric] = value;
  }
  return { metrics, violations };
}
/**
 * Parse an ISO-8601 timestamp into epoch milliseconds, or `null`.
 * @param {string} timestamp - an ISO-8601 timestamp.
 * @returns {number|null} epoch milliseconds, or `null` when it does not parse.
 */
export function parseSampleTime(timestamp) {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}
