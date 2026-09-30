/**
 * UTOPIA · Research Institute — deterministic research statistics.
 *
 * Formal statistics are produced by deterministic code; a language model only
 * interprets the numbers afterwards. Every function here is offline and, where
 * the donor said "random", seeded: the bootstrap and both permutation tests draw
 * from the donor's own `mulberry32` so the same input and seed always produce the
 * same number. Nothing reads a clock, the file system, the environment or the
 * network.
 *
 * Ported from the Codex-Boss donor `src/shared/research-statistics.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, which carries no import. Function
 * names, formulae, rounding, ordering, NaN guards and default parameters are the
 * donor's; the numeric defaults are named in `./contracts.mjs` with the donor's
 * exact values.
 *
 * The rules that must never be softened:
 *   - an empty or underpowered sample yields `NaN`, never 0 and never a guess;
 *   - `standardDeviation` is the sample standard deviation (n − 1) unless the
 *     caller explicitly asks for the population form;
 *   - `median` sorts a COPY, so the caller's array is never reordered;
 *   - the bootstrap and permutation tests consume their seeded generator in the
 *     donor's exact order, which is what makes their p-values reproducible;
 *   - nothing is rounded. Where a formula lands on 0.040000000000000036, that is
 *     the number returned.
 */

import {
  DEFAULT_BOOTSTRAP_ALPHA,
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_CI_Z,
  DEFAULT_ONE_SAMPLE_PERMUTATION_SEED,
  DEFAULT_PERMUTATIONS,
  DEFAULT_PERMUTATION_SEED,
} from './contracts.mjs';

/** The donor defaults this file consumes, re-exported so the surface is readable here. */
export {
  DEFAULT_BOOTSTRAP_ALPHA,
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_CI_Z,
  DEFAULT_ONE_SAMPLE_PERMUTATION_SEED,
  DEFAULT_PERMUTATIONS,
  DEFAULT_PERMUTATION_SEED,
} from './contracts.mjs';

/** Arithmetic mean; `NaN` for an empty sample. */
export function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

/** Median of a sorted copy; `NaN` for an empty sample. */
export function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Standard deviation.
 *
 * `sample` (the donor's default) divides by n − 1 and needs at least two values;
 * `sample = false` is the population form, which needs at least one.
 */
export function standardDeviation(values, sample = true) {
  if (values.length < (sample ? 2 : 1)) return NaN;
  const average = mean(values);
  const squared = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  return Math.sqrt(squared / (sample ? values.length - 1 : values.length));
}

/** The donor's descriptive bundle: count, mean, median and sample sd. */
export function describe(values) {
  return { n: values.length, mean: mean(values), median: median(values), sd: standardDeviation(values) };
}

/** Normal-approximation CI (z = 1.96 for 95%); deterministic. */
export function confidenceInterval(values, z = DEFAULT_CI_Z) {
  const stats = describe(values);
  if (stats.n < 2 || Number.isNaN(stats.sd)) return { lower: NaN, upper: NaN };
  const margin = z * (stats.sd / Math.sqrt(stats.n));
  return { lower: stats.mean - margin, upper: stats.mean + margin };
}

/** Deterministic LCG seedable PRNG (mulberry32) for bootstrap reproducibility. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap CI on the mean with a fixed seed (reproducible). */
export function bootstrapCi(values, options = {}) {
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const samples = options.samples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  const alpha = options.alpha ?? DEFAULT_BOOTSTRAP_ALPHA;
  if (values.length < 2) return { lower: NaN, upper: NaN };
  const random = mulberry32(seed);
  const means = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const lowerIndex = Math.max(0, Math.floor((alpha / 2) * samples));
  const upperIndex = Math.min(samples - 1, Math.ceil((1 - alpha / 2) * samples) - 1);
  return { lower: means[lowerIndex], upper: means[upperIndex] };
}

/** Cohen's d effect size (equal-n pooled). */
export function effectSize(left, right) {
  if (left.length < 2 || right.length < 2) return NaN;
  const pooled = Math.sqrt(
    ((left.length - 1) * standardDeviation(left) ** 2 + (right.length - 1) * standardDeviation(right) ** 2) /
      (left.length + right.length - 2)
  );
  if (pooled === 0) return NaN;
  return (mean(left) - mean(right)) / pooled;
}

/**
 * One-sample effect size against a reference value (Overcomplete §9.12):
 * (mean − baseline) / sd — how far the recorded mean sits from the frozen
 * baseline in sample-standard-deviation units. NaN when underpowered.
 */
export function oneSampleEffectSize(values, baseline) {
  const stats = describe(values);
  if (stats.n < 2 || Number.isNaN(stats.sd) || stats.sd === 0) return NaN;
  return (stats.mean - baseline) / stats.sd;
}

/**
 * One-sample sign-permutation p-value against a reference value (§9.12):
 * each centered value (value − baseline) is kept or sign-flipped with equal
 * probability; the p-value is the seeded fraction of permutations whose mean
 * magnitude is at least the observed mean magnitude. Deterministic.
 */
export function oneSamplePermutationP(values, baseline, options = {}) {
  if (values.length < 2) return NaN;
  const permutations = options.permutations ?? DEFAULT_PERMUTATIONS;
  const centered = values.map((value) => value - baseline);
  const random = mulberry32(options.seed ?? DEFAULT_ONE_SAMPLE_PERMUTATION_SEED);
  const observed = Math.abs(mean(centered));
  let extreme = 0;
  for (let permutation = 0; permutation < permutations; permutation += 1) {
    let sum = 0;
    for (const value of centered) sum += random() < 0.5 ? value : -value;
    if (Math.abs(sum / centered.length) >= observed) extreme += 1;
  }
  return (extreme + 1) / (permutations + 1);
}

/** Paired (sign-flip) permutation p-value: equal-n pairs, differences re-signed. */
function permutationPairedP(differences, options) {
  const permutations = options.permutations ?? DEFAULT_PERMUTATIONS;
  const random = mulberry32(options.seed ?? DEFAULT_PERMUTATION_SEED);
  const observed = Math.abs(mean(differences));
  let extreme = 0;
  for (let permutation = 0; permutation < permutations; permutation += 1) {
    // Each difference is kept or flipped with equal probability (deterministic
    // via the seeded PRNG) — a paired permutation test.
    let sum = 0;
    for (const difference of differences) sum += random() < 0.5 ? difference : -difference;
    if (Math.abs(sum / differences.length) >= observed) extreme += 1;
  }
  return (extreme + 1) / (permutations + 1);
}

/**
 * Paired/unpaired comparison p-value via permutation test (seedable,
 * deterministic). Paired requires equal-length samples and flips the signs of
 * the within-pair differences; unpaired repartitions the pooled groups.
 */
export function permutationP(left, right, options = {}) {
  const permutations = options.permutations ?? DEFAULT_PERMUTATIONS;
  if (left.length < 2 || right.length < 2) return NaN;
  if (options.paired) {
    if (left.length !== right.length) return NaN;
    const differences = left.map((value, index) => value - right[index]);
    return permutationPairedP(differences, { seed: options.seed, permutations });
  }
  const random = mulberry32(options.seed ?? DEFAULT_PERMUTATION_SEED);
  const observed = Math.abs(mean(left) - mean(right));
  const combined = [...left, ...right];
  let extreme = 0;
  for (let permutation = 0; permutation < permutations; permutation += 1) {
    // Fisher–Yates shuffle over the combined pool.
    for (let index = combined.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [combined[index], combined[swap]] = [combined[swap], combined[index]];
    }
    const split = combined.slice(0, left.length);
    const rest = combined.slice(left.length);
    if (Math.abs(mean(split) - mean(rest)) >= observed) extreme += 1;
  }
  return (extreme + 1) / (permutations + 1);
}

/** A proportion; `NaN` unless the denominator is strictly positive. */
export function proportion(value, of) {
  return of > 0 ? value / of : NaN;
}
