/**
 * UTOPIA · Research Institute — deterministic statistics suite.
 *
 * Every expectation here is a hand-computed or `node -e` pinned number, never a
 * second run of the same formula: the point is to hold the port to the Codex-Boss
 * donor `src/shared/research-statistics.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, not to itself. Each formula is
 * pinned for concrete inputs, and every threshold the donor declares is asserted
 * immediately below, at, and immediately above its boundary.
 *
 * All pinned literals were printed by `node -e`; the final test proves each one is
 * the full-precision rendering of the number the module returns, with its exact
 * length, so a rounded restatement of a result cannot pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_BOOTSTRAP_ALPHA,
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_CI_Z,
  DEFAULT_ONE_SAMPLE_PERMUTATION_SEED,
  DEFAULT_PERMUTATIONS,
  DEFAULT_PERMUTATION_SEED,
  bootstrapCi,
  confidenceInterval,
  describe,
  effectSize,
  mean,
  median,
  mulberry32,
  oneSampleEffectSize,
  oneSamplePermutationP,
  permutationP,
  proportion,
  standardDeviation,
} from '../statistics.mjs';

/** The donor's own doc example set, used wherever a worked example is needed. */
const V8 = [2, 4, 4, 4, 5, 5, 7, 9];

/** Assert a result renders exactly as the literal `node -e` printed for it. */
function pin(actual, literal) {
  assert.equal(String(actual), literal);
}

function interval(lower, upper) {
  return { lower, upper };
}

test('mean and median reproduce the donor arithmetic and its empty-sample NaN', () => {
  pin(mean([1, 2, 3, 4]), '2.5');
  pin(mean(V8), '5');
  pin(mean([-3, -1, 2]), '-0.6666666666666666');
  assert.ok(Number.isNaN(mean([])), 'an empty sample has no mean');

  pin(median([3, 1, 2]), '2');
  pin(median([4, 1, 3, 2]), '2.5');
  pin(median(V8), '4.5');
  assert.ok(Number.isNaN(median([])), 'an empty sample has no median');

  // the donor sorts a copy, so the caller's array keeps its order
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]);
});

test('standardDeviation switches between sample and population exactly at its declared boundaries', () => {
  // sample form (the donor default): needs 2 values
  assert.ok(Number.isNaN(standardDeviation([])), 'n = 0 is below the sample threshold');
  assert.ok(Number.isNaN(standardDeviation([1])), 'n = 1 is below the sample threshold');
  pin(standardDeviation([1, 3]), '1.4142135623730951');
  pin(standardDeviation([1, 2, 3, 4]), '1.2909944487358056');
  pin(standardDeviation(V8), '2.138089935299395');
  assert.equal(standardDeviation(V8), standardDeviation(V8, true), 'sample = true is the default');

  // population form: needs 1 value
  assert.ok(Number.isNaN(standardDeviation([], false)), 'n = 0 is below the population threshold');
  pin(standardDeviation([1], false), '0');
  pin(standardDeviation([1, 3], false), '1');
  pin(standardDeviation(V8, false), '2');
});

test('describe packages the donor four fields', () => {
  assert.deepEqual(describe([]), { n: 0, mean: NaN, median: NaN, sd: NaN });
  assert.deepEqual(describe(V8), { n: 8, mean: 5, median: 4.5, sd: 2.138089935299395 });
  assert.deepEqual(describe([1]), { n: 1, mean: 1, median: 1, sd: NaN });
});

test('confidenceInterval is the normal approximation with the donor default z', () => {
  assert.equal(DEFAULT_CI_Z, 1.96);
  assert.deepEqual(confidenceInterval(V8), interval(3.518379265803829, 6.481620734196171));
  assert.deepEqual(confidenceInterval(V8, 1.96), confidenceInterval(V8), 'z defaults to 1.96');
  assert.deepEqual(confidenceInterval([1, 2, 3]), interval(0.8683934723883333, 3.131606527611667));
  assert.deepEqual(confidenceInterval([1, 2, 3, 4]), interval(1.2348254402389105, 3.7651745597610895));

  // n < 2 is the declared boundary; it is checked before any margin is computed
  assert.deepEqual(confidenceInterval([]), interval(NaN, NaN));
  assert.deepEqual(confidenceInterval([1]), interval(NaN, NaN));
  // at n = 2 the margin is z * sd / sqrt(2); the donor does not round the 0.04
  assert.deepEqual(confidenceInterval([1, 3]), interval(0.040000000000000036, 3.96));

  // z is a parameter, not a repair: z = 0 collapses to the mean, z = 1 widens
  assert.deepEqual(confidenceInterval(V8, 0), interval(5, 5));
  assert.deepEqual(confidenceInterval(V8, 1), interval(4.244071053981545, 5.755928946018455));
});

test('mulberry32 is the donor LCG: seed-normalised, reproducible and bounded', () => {
  const first = mulberry32(42);
  const sequence = [first(), first(), first(), first(), first()];
  assert.deepEqual(sequence.map(String), [
    '0.6011037519201636',
    '0.44829055899754167',
    '0.8524657934904099',
    '0.6697340414393693',
    '0.17481389874592423',
  ]);
  assert.ok(sequence.every((value) => value >= 0 && value < 1), 'the generator stays in [0, 1)');

  const eleven = mulberry32(11);
  assert.deepEqual([eleven(), eleven(), eleven()].map(String), [
    '0.5115870486479253',
    '0.5299464082345366',
    '0.6081185641232878',
  ]);
  const seven = mulberry32(7);
  assert.deepEqual([seven(), seven(), seven()].map(String), [
    '0.011704753153026104',
    '0.06195825757458806',
    '0.97690763277933',
  ]);

  // the same seed replays exactly; a different seed does not
  const again = mulberry32(42);
  assert.deepEqual([again(), again(), again(), again(), again()], sequence);
  assert.notDeepEqual([mulberry32(43)()], [sequence[0]]);
  // the donor normalises the seed with >>> 0, so -1 and 2**32 - 1 are the same seed
  assert.equal(mulberry32(-1)(), mulberry32(4294967295)());
});

test('bootstrapCi resamples deterministically at the donor defaults and alpha indices', () => {
  assert.equal(DEFAULT_BOOTSTRAP_SEED, 42);
  assert.equal(DEFAULT_BOOTSTRAP_SAMPLES, 1000);
  assert.equal(DEFAULT_BOOTSTRAP_ALPHA, 0.05);

  const byDefault = bootstrapCi(V8);
  assert.deepEqual(byDefault, interval(3.625, 6.5));
  assert.deepEqual(
    bootstrapCi(V8, { seed: DEFAULT_BOOTSTRAP_SEED, samples: DEFAULT_BOOTSTRAP_SAMPLES, alpha: DEFAULT_BOOTSTRAP_ALPHA }),
    byDefault,
    'the default parameters are the donor defaults',
  );
  assert.deepEqual(bootstrapCi(V8), byDefault, 'the same input replays to the same interval');

  assert.deepEqual(bootstrapCi(V8, { seed: 7 }), interval(3.75, 6.375));
  assert.deepEqual(bootstrapCi(V8, { seed: 0 }), interval(3.75, 6.5));
  assert.deepEqual(bootstrapCi(V8, { alpha: 0.1 }), interval(3.875, 6.25));
  assert.deepEqual(bootstrapCi(V8, { alpha: 0.01 }), interval(3.375, 7));

  // the sample count drives the floor/ceil quantile indices
  assert.deepEqual(bootstrapCi(V8, { samples: 10 }), interval(4, 5.75));
  assert.deepEqual(bootstrapCi(V8, { samples: 2 }), interval(4.875, 5.25));
  assert.deepEqual(bootstrapCi(V8, { samples: 1 }), interval(4.875, 4.875));

  // the declared boundary is n = 2
  assert.deepEqual(bootstrapCi([]), interval(NaN, NaN));
  assert.deepEqual(bootstrapCi([5]), interval(NaN, NaN));
  assert.deepEqual(bootstrapCi([1, 3]), interval(1, 3));

  // alpha = 1 makes the donor's lower index exceed its upper index; the interval is
  // returned exactly as computed rather than sorted into sense
  assert.deepEqual(bootstrapCi([1, 2, 3, 4], { samples: 4, alpha: 1 }), interval(2.75, 2.25));
});

test("effectSize is the donor's pooled Cohen's d", () => {
  pin(effectSize([5, 6, 7, 8], [1, 2, 3, 4]), '3.0983866769659336');
  pin(effectSize([10, 12, 14], [8, 8]), '2.449489742783178');
  pin(effectSize([1, 2], [3, 4]), '-2.82842712474619');

  // the declared boundary is two values per group
  assert.ok(Number.isNaN(effectSize([1], [2, 3])), 'left below the boundary');
  assert.ok(Number.isNaN(effectSize([1, 2], [3])), 'right below the boundary');
  // a zero pooled sd has no effect size, even with enough values
  assert.ok(Number.isNaN(effectSize([1, 1], [2, 2])));
});

test('oneSampleEffectSize is (mean − baseline) / sd and NaN when underpowered', () => {
  pin(oneSampleEffectSize([5, 6, 7, 8], 2.5), '3.0983866769659336');
  pin(oneSampleEffectSize(V8, 5), '0');
  pin(oneSampleEffectSize([1, 2, 3, 4], 10), '-5.809475019311125');

  assert.ok(Number.isNaN(oneSampleEffectSize([3], 1)), 'n = 1 is below the boundary');
  assert.ok(Number.isNaN(oneSampleEffectSize([3, 3], 1)), 'sd = 0 has no effect size');
});

test('oneSamplePermutationP is the seeded sign-permutation fraction', () => {
  assert.equal(DEFAULT_ONE_SAMPLE_PERMUTATION_SEED, 11);
  assert.equal(DEFAULT_PERMUTATIONS, 5000);

  pin(oneSamplePermutationP(V8, 3), '0.04039192161567687');
  pin(oneSamplePermutationP([1, 2, 3, 4], 0), '0.12917416516696661');
  pin(oneSamplePermutationP(V8, 3, { seed: 1 }), '0.03739252149570086');
  assert.equal(
    oneSamplePermutationP(V8, 3),
    oneSamplePermutationP(V8, 3, { seed: DEFAULT_ONE_SAMPLE_PERMUTATION_SEED, permutations: DEFAULT_PERMUTATIONS }),
    'the default seed is 11, not 7',
  );

  // a baseline at the sample mean gives an observed magnitude of 0, so every
  // permutation is at least as extreme and the p-value saturates at 1
  pin(oneSamplePermutationP(V8, 5), '1');

  // (extreme + 1) / (permutations + 1): the smallest attainable p-value is 1 / (n + 1)
  pin(oneSamplePermutationP(V8, 3, { permutations: 10 }), '0.09090909090909091');
  assert.ok(oneSamplePermutationP(V8, 3) >= 1 / (DEFAULT_PERMUTATIONS + 1), 'a p-value is never 0');

  // the declared boundary is n = 2
  assert.ok(Number.isNaN(oneSamplePermutationP([1], 0)));
  assert.ok(Number.isFinite(oneSamplePermutationP([1, 2], 0)));
});

test("permutationP keeps the donor's paired and unpaired paths, seeds and boundaries", () => {
  assert.equal(DEFAULT_PERMUTATION_SEED, 7);

  // unpaired: repartition the pooled groups with seed 7
  pin(permutationP([5, 6, 7, 8], [1, 2, 3, 4]), '0.026394721055788842');
  assert.equal(
    permutationP([5, 6, 7, 8], [1, 2, 3, 4]),
    permutationP([5, 6, 7, 8], [1, 2, 3, 4], { seed: DEFAULT_PERMUTATION_SEED, permutations: DEFAULT_PERMUTATIONS }),
    'the unpaired default seed is 7',
  );
  pin(permutationP([5, 6, 7, 8], [1, 2, 3, 4], { seed: 3 }), '0.02519496100779844');
  pin(permutationP([1, 2], [3, 4]), '0.32213557288542294');
  pin(permutationP([1, 2, 3], [4, 5]), '0.1949610077984403');
  pin(permutationP([5, 6, 7, 8], [1, 2, 3, 4], { permutations: 10 }), '0.18181818181818182');

  // paired: re-sign the within-pair differences, same seed 7
  pin(permutationP([5, 6, 7, 8], [1, 2, 3, 4], { paired: true }), '0.12117576484703059');
  assert.equal(
    permutationP([5, 6, 7, 8], [1, 2, 3, 4], { paired: true }),
    permutationP([5, 6, 7, 8], [1, 2, 3, 4], { paired: true, seed: DEFAULT_PERMUTATION_SEED, permutations: DEFAULT_PERMUTATIONS }),
    'the paired default seed is also 7',
  );
  pin(permutationP([5, 6, 7, 8], [1, 2, 3, 4], { paired: true, seed: 1 }), '0.1217756448710258');
  pin(permutationP([1, 2, 3], [4, 5, 6], { paired: true }), '0.2465506898620276');
  // all-zero differences: observed 0, so every sign flip is at least as extreme
  pin(permutationP([5, 5], [5, 5], { paired: true }), '1');

  // declared boundaries: two values per side, and equal lengths when paired
  assert.ok(Number.isNaN(permutationP([1], [2, 3])), 'left below the boundary');
  assert.ok(Number.isNaN(permutationP([1, 2], [3])), 'right below the boundary');
  assert.ok(Number.isNaN(permutationP([1, 2, 3], [1, 2], { paired: true })), 'paired lengths must match');
  assert.ok(Number.isFinite(permutationP([1, 2, 3], [4, 5, 6], { paired: true })), 'equal paired lengths are accepted');
});

test('proportion refuses a non-positive denominator instead of inventing a number', () => {
  assert.equal(proportion(0, 5), 0);
  assert.equal(proportion(3, 6), 0.5);
  assert.equal(proportion(5, 5), 1);
  pin(proportion(1, 0.5), '2');

  // the declared threshold is `of > 0`
  assert.ok(Number.isNaN(proportion(1, 0)), 'a zero denominator');
  assert.ok(Number.isNaN(proportion(1, -0.001)), 'just below the threshold');
  assert.ok(Number.isNaN(proportion(1, -2)), 'well below the threshold');
  assert.equal(proportion(1, 0.001), 1000, 'just above the threshold');
});

test('every pinned literal is verbatim node -e output at full precision', () => {
  const pinned = [
    ['-0.6666666666666666', 19],
    ['1.4142135623730951', 18],
    ['1.2909944487358056', 18],
    ['2.138089935299395', 17],
    ['3.518379265803829', 17],
    ['6.481620734196171', 17],
    ['0.8683934723883333', 18],
    ['3.131606527611667', 17],
    ['1.2348254402389105', 18],
    ['3.7651745597610895', 18],
    ['0.040000000000000036', 20],
    ['4.244071053981545', 17],
    ['5.755928946018455', 17],
    ['0.6011037519201636', 18],
    ['0.44829055899754167', 19],
    ['0.8524657934904099', 18],
    ['0.6697340414393693', 18],
    ['0.17481389874592423', 19],
    ['0.5115870486479253', 18],
    ['0.5299464082345366', 18],
    ['0.6081185641232878', 18],
    ['0.011704753153026104', 20],
    ['0.06195825757458806', 19],
    ['0.97690763277933', 16],
    ['3.0983866769659336', 18],
    ['2.449489742783178', 17],
    ['-2.82842712474619', 17],
    ['-5.809475019311125', 18],
    ['0.04039192161567687', 19],
    ['0.12917416516696661', 19],
    ['0.03739252149570086', 19],
    ['0.09090909090909091', 19],
    ['0.026394721055788842', 20],
    ['0.02519496100779844', 19],
    ['0.32213557288542294', 19],
    ['0.18181818181818182', 19],
    ['0.1949610077984403', 18],
    ['0.12117576484703059', 19],
    ['0.1217756448710258', 18],
    ['0.2465506898620276', 18],
  ];
  for (const [literal, length] of pinned) {
    assert.equal(literal.length, length, `${literal} has its recorded length`);
    assert.equal(String(Number(literal)), literal, `${literal} is the full-precision rendering`);
  }
  // a sample of the pins, re-derived from the module, must render identically
  assert.equal(String(standardDeviation(V8)), pinned.find(([literal]) => literal === '2.138089935299395')[0]);
  assert.equal(String(bootstrapCi([1, 2, 3, 4], { samples: 4, alpha: 1 }).lower), '2.75');
});

test('the module is pure: no clock, no randomness beyond the seed, no io', async () => {
  const moduleDir = join(import.meta.dirname, '..');
  for (const file of ['contracts.mjs', 'statistics.mjs', 'battery.mjs', 'index.mjs']) {
    const code = (await readFile(join(moduleDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of [
      'Math.random',
      'Date.now',
      'new Date',
      'process.env',
      'require(',
      'fetch(',
      'node:',
      'readFile',
      'writeFile',
      'import(',
    ]) {
      assert.ok(!code.includes(forbidden), `${file} must not use ${forbidden}`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('.'), `${file} imports only its siblings, not ${specifier}`);
      assert.ok(specifier.endsWith('.mjs'), `${file} uses an explicit .mjs specifier (${specifier})`);
    }
  }

  // the index is the single export site for the whole module
  const index = await import('../index.mjs');
  assert.equal(index.mean, mean);
  assert.equal(index.bootstrapCi, bootstrapCi);
  assert.equal(typeof index.adjudicateResearchOutcome, 'function');
  assert.equal(typeof index.researchEvidence, 'function');
  assert.deepEqual(index.RESEARCH_DOMAINS, [
    'software-engineering',
    'multi-agent',
    'reliability',
    'writing-evaluation',
    'negative-null-result',
  ]);
});
