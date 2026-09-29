/**
 * UTOPIA · Research Institute — Level-A planning suite.
 *
 * The novelty/feasibility arithmetic, the gate boundaries, the replication clamp and
 * the plan refusal path restate the Codex-Boss donor `src/shared/research-levela.ts`
 * @ 8df428eaa437a409368401e95194e40266b83080. Every expected score below was
 * re-derived from a line-by-line transcription of the donor before being pinned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EPOCH_TIMESTAMP,
  FALSIFIABLE_FEASIBILITY_BONUS,
  LEVEL_A_MIN_SCORE,
  MAX_TEXT_LENGTH,
  NO_HARNESS_FEASIBILITY_PENALTY,
  REPLICATION_RUNS_MAX,
  REPLICATION_RUNS_MIN,
  SCORE_MAX,
  buildExperimentSpec,
  levelAGate,
  noveltyReview,
} from '../index.mjs';
import { validateLevelAPlan as validateFromLevelA } from '../levela.mjs';
import { validateLevelAPlan as validateFromIndex } from '../index.mjs';

const signals = (overrides = {}) => ({ files: 1, testFiles: 1, languages: ['ts'], topModules: [], ...overrides });
const candidate = (overrides = {}) => ({ id: 'q1', question: 'Does X cause Y?', measurable: true, falsifiable: true, proposedBy: 'p', ...overrides });

test('the novelty review scores exactly the donor arithmetic', () => {
  const cases = [
    {
      label: 'overlap costs novelty, no harness costs feasibility',
      signals: signals({ files: 12, testFiles: 0, topModules: ['alpha'] }),
      candidate: candidate({ id: 'q1', question: 'Does ALPHA change the beta rate?', noveltyScore: 0, feasibilityScore: 0 }),
      expected: { claimId: 'q1', noveltyScore: 2, feasibilityScore: 1, reasons: ['measurable + falsifiable', 'no existing test harness in repo'] },
    },
    {
      label: 'both scores clamp at the maximum',
      signals: signals({ files: 5, testFiles: 3, languages: ['ts', 'py'], topModules: ['none'] }),
      candidate: candidate({ id: 'q2', question: 'Does X cause Y?', falsifiable: false, noveltyScore: 10, feasibilityScore: 10 }),
      expected: { claimId: 'q2', noveltyScore: SCORE_MAX, feasibilityScore: SCORE_MAX, reasons: ['cross-language surface increases feasibility breadth'] },
    },
    {
      label: 'an overlap of two discounts twice, and the tested-module penalty lands on novelty',
      signals: signals({ files: 5, testFiles: 3, topModules: ['alpha', 'beta'] }),
      candidate: candidate({ id: 'q3', question: 'alpha and beta together?', noveltyScore: 0, feasibilityScore: 0 }),
      expected: { claimId: 'q3', noveltyScore: 0, feasibilityScore: 2, reasons: ['question overlaps existing tested modules', 'measurable + falsifiable'] },
    },
    {
      label: 'four overlaps cannot drive novelty below zero',
      signals: signals({ files: 9, testFiles: 4, topModules: ['aa', 'bb', 'cc', 'dd'] }),
      candidate: candidate({ id: 'q8', question: 'aa bb cc dd', noveltyScore: 1, feasibilityScore: 3 }),
      expected: { claimId: 'q8', noveltyScore: 0, feasibilityScore: 5, reasons: ['question overlaps existing tested modules', 'measurable + falsifiable'] },
    },
    {
      label: 'both scores exactly at the gate',
      signals: signals({ files: 3, testFiles: 2, topModules: ['alpha'] }),
      candidate: candidate({ id: 'q4', question: 'Does gamma matter?', noveltyScore: -2, feasibilityScore: 0 }),
      expected: { claimId: 'q4', noveltyScore: LEVEL_A_MIN_SCORE, feasibilityScore: LEVEL_A_MIN_SCORE, reasons: ['measurable + falsifiable'] },
    },
    {
      label: 'both scores clamp at the minimum',
      signals: signals({ files: 3, testFiles: 2, topModules: ['alpha'] }),
      candidate: candidate({ id: 'q5', question: 'Does gamma matter?', measurable: false, falsifiable: false, noveltyScore: -10, feasibilityScore: -10 }),
      expected: { claimId: 'q5', noveltyScore: 0, feasibilityScore: 0, reasons: [] },
    },
    {
      label: 'the biases are added verbatim and are not clamped away',
      signals: signals({ files: 1, testFiles: 1, topModules: [] }),
      candidate: candidate({ id: 'q6', question: 'Any?', noveltyScore: undefined, feasibilityScore: undefined }),
      overrides: { noveltyBias: 1.5, feasibilityBias: 1.25 },
      expected: { claimId: 'q6', noveltyScore: 4.5, feasibilityScore: 3.25, reasons: ['measurable + falsifiable'] },
    },
    {
      label: 'a non-falsifiable question gains no feasibility bonus',
      signals: signals({ files: 1, testFiles: 1, topModules: [] }),
      candidate: candidate({ id: 'q7', question: 'Any?', falsifiable: false }),
      expected: { claimId: 'q7', noveltyScore: 3, feasibilityScore: 0, reasons: [] },
    },
    {
      label: 'just below the maximum: 4.9 stays, 5 is the cap',
      signals: signals({ files: 1, testFiles: 1, topModules: [] }),
      candidate: candidate({ id: 'q9', question: 'Any?', noveltyScore: 3.8, feasibilityScore: 2.9 }),
      expected: { claimId: 'q9', noveltyScore: 4.9, feasibilityScore: 4.9, reasons: ['measurable + falsifiable'] },
    },
  ];

  for (const { label, signals: signalInput, candidate: candidateInput, overrides, expected } of cases) {
    assert.deepEqual(noveltyReview(candidateInput, signalInput, overrides), expected, label);
  }
});

test('the A/B value edge is real: falsifiability is worth exactly +2 feasibility', () => {
  const signalsInput = signals({ files: 1, testFiles: 1, topModules: [] });
  const falsifiable = noveltyReview(candidate({ falsifiable: true }), signalsInput);
  const notFalsifiable = noveltyReview(candidate({ falsifiable: false }), signalsInput);
  const notMeasurable = noveltyReview(candidate({ measurable: false }), signalsInput);

  assert.equal(falsifiable.feasibilityScore - notFalsifiable.feasibilityScore, FALSIFIABLE_FEASIBILITY_BONUS);
  assert.equal(falsifiable.feasibilityScore - notMeasurable.feasibilityScore, FALSIFIABLE_FEASIBILITY_BONUS);
  assert.deepEqual(falsifiable.reasons, ['measurable + falsifiable']);
  assert.deepEqual(notFalsifiable.reasons, []);

  // a zero-test harness subtracts one, in the donor's order after the bonus
  const noHarness = noveltyReview(candidate({ falsifiable: true }), signals({ testFiles: 0 }));
  assert.equal(falsifiable.feasibilityScore - noHarness.feasibilityScore, NO_HARNESS_FEASIBILITY_PENALTY);
  assert.deepEqual(noHarness.reasons, ['measurable + falsifiable', 'no existing test harness in repo']);
});

test('noveltyReview adds no validation rung of its own', () => {
  // the donor's review reads the candidate structurally; it never gates it
  const review = noveltyReview({ question: 'no id, no proposer', measurable: true, falsifiable: true }, signals());
  assert.deepEqual(review, { claimId: undefined, noveltyScore: 3, feasibilityScore: 2, reasons: ['measurable + falsifiable'] });

  // and it scores an undeclared score as 0 rather than refusing it
  const absent = noveltyReview({ id: 'q', question: 'Does X cause Y?', measurable: true, falsifiable: true }, signals());
  assert.equal(absent.noveltyScore, 3);
});

test('levelAGate decides at 2.0 on each score, novelty first', () => {
  assert.equal(LEVEL_A_MIN_SCORE, 2);
  assert.deepEqual(levelAGate({ noveltyScore: 2, feasibilityScore: 2 }), { ok: true });
  assert.deepEqual(levelAGate({ noveltyScore: 2.04, feasibilityScore: 5 }), { ok: true }, 'just above is accepted');

  // just below is refused, and the reason formats the score to one decimal — so 1.99
  // prints as `2.0` in the very message that refuses it
  assert.deepEqual(levelAGate({ noveltyScore: 1.99, feasibilityScore: 5 }), { ok: false, reason: 'novelty too low (2.0)' });
  assert.deepEqual(levelAGate({ noveltyScore: 1.95, feasibilityScore: 5 }), { ok: false, reason: 'novelty too low (1.9)' });
  assert.deepEqual(levelAGate({ noveltyScore: 1.94, feasibilityScore: 5 }), { ok: false, reason: 'novelty too low (1.9)' });
  assert.deepEqual(levelAGate({ noveltyScore: 0, feasibilityScore: 5 }), { ok: false, reason: 'novelty too low (0.0)' });
  assert.deepEqual(levelAGate({ noveltyScore: -1, feasibilityScore: 5 }), { ok: false, reason: 'novelty too low (-1.0)' });

  assert.deepEqual(levelAGate({ noveltyScore: 5, feasibilityScore: 1.99 }), { ok: false, reason: 'feasibility too low (2.0)' });
  assert.deepEqual(levelAGate({ noveltyScore: 5, feasibilityScore: 1.94 }), { ok: false, reason: 'feasibility too low (1.9)' });
  assert.deepEqual(levelAGate({ noveltyScore: 5, feasibilityScore: 0 }), { ok: false, reason: 'feasibility too low (0.0)' });
  assert.equal(levelAGate({ noveltyScore: 5, feasibilityScore: LEVEL_A_MIN_SCORE }).ok, true);

  // when both are low, the novelty reason is the one reported
  assert.deepEqual(levelAGate({ noveltyScore: 1, feasibilityScore: 0 }), { ok: false, reason: 'novelty too low (1.0)' });
});

test('buildExperimentSpec clamps, defaults and stamps, with the clock injected', () => {
  const spec = buildExperimentSpec({ id: 'e1', primaryMetric: 'mean' });
  assert.deepEqual(spec, { id: 'e1', primaryMetric: 'mean', replicationRuns: 3, purpose: 'EXPERIMENT', command: [], seed: 42, createdAt: EPOCH_TIMESTAMP });
  assert.equal(spec.createdAt.length, 24);
  assert.deepEqual(buildExperimentSpec({ id: 'e1', primaryMetric: 'mean' }), spec, 'the default is deterministic, not clock-dependent');

  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', replicationRuns: 1 }).replicationRuns, REPLICATION_RUNS_MIN, 'one below the floor clamps up');
  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', replicationRuns: 0 }).replicationRuns, REPLICATION_RUNS_MIN);
  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', replicationRuns: 2 }).replicationRuns, 2, 'exactly the floor stays');
  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', replicationRuns: 9 }).replicationRuns, 9);
  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', replicationRuns: 10 }).replicationRuns, REPLICATION_RUNS_MAX, 'exactly the ceiling stays');
  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', replicationRuns: 11 }).replicationRuns, REPLICATION_RUNS_MAX, 'one above the ceiling clamps down');
  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', replicationRuns: null }).replicationRuns, 3, 'null falls back to the default, then clamps');
  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', replicationRuns: 3 }).replicationRuns, 3);

  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', seed: 0 }).seed, 0, 'seed 0 is kept');
  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean', seed: 7 }).seed, 7);
  assert.equal(buildExperimentSpec({ id: 'e', primaryMetric: 'mean' }).seed, 42);
  for (const primaryMetric of ['mean', 'proportion', 'effect-size', 'rate']) {
    assert.equal(buildExperimentSpec({ id: 'e', primaryMetric }).primaryMetric, primaryMetric);
  }

  const injected = buildExperimentSpec({ id: 'e4', primaryMetric: 'mean' }, { now: () => '2026-09-29T12:00:00.000Z' });
  assert.equal(injected.createdAt, '2026-09-29T12:00:00.000Z');
  const explicit = buildExperimentSpec({ id: 'e5', primaryMetric: 'mean', createdAt: '2020-01-01T00:00:00.000Z' }, { now: () => '2026-09-29T12:00:00.000Z' });
  assert.equal(explicit.createdAt, '2020-01-01T00:00:00.000Z', 'an explicit stamp beats the injected clock');
});

test('validateLevelAPlan is reachable from the levela module and the export site alike', () => {
  assert.equal(validateFromLevelA, validateFromIndex);
});

test('the Level-A plan gate reports the donor messages at every boundary', () => {
  const plan = (overrides = {}) => ({ hypothesis: 'X raises Y.', experiment: { id: 'e1', primaryMetric: 'mean', replicationRuns: 3 }, ...overrides });
  const errorFrom = (fn) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return null;
  };

  assert.equal(validateFromIndex(plan()), undefined);
  assert.equal(validateFromIndex(plan({ hypothesis: 'h'.repeat(MAX_TEXT_LENGTH) })), undefined, 'exactly the limit passes');
  assert.equal(errorFrom(() => validateFromIndex(plan({ hypothesis: 'h'.repeat(MAX_TEXT_LENGTH + 1) }))).message, 'Level-A plan requires a hypothesis', 'one over fails');
  assert.equal(errorFrom(() => validateFromIndex(plan({ hypothesis: '   ' }))).message, 'Level-A plan requires a hypothesis');
  assert.equal(errorFrom(() => validateFromIndex(null)).message, 'Level-A plan requires a hypothesis');

  assert.equal(errorFrom(() => validateFromIndex(plan({ experiment: null }))).message, 'Level-A plan requires an experiment');
  assert.equal(errorFrom(() => validateFromIndex(plan({ experiment: { id: '' } }))).message, 'Level-A plan requires an experiment');
  assert.equal(errorFrom(() => validateFromIndex(plan({ experiment: { id: 7 } }))).message, 'Level-A plan requires an experiment');

  assert.equal(errorFrom(() => validateFromIndex(plan({ experiment: { id: 'e1', primaryMetric: 'mean', replicationRuns: 1 } }))).message, 'Primary finding requires >= 2 replication runs', 'one below the floor fails');
  assert.equal(validateFromIndex(plan({ experiment: { id: 'e1', primaryMetric: 'mean', replicationRuns: 2 } })), undefined, 'exactly the floor passes');
  assert.equal(validateFromIndex(plan({ experiment: { id: 'e1', primaryMetric: 'mean', replicationRuns: 3 } })), undefined, 'above the floor passes');
  assert.equal(validateFromIndex(plan({ experiment: { id: 'e1', primaryMetric: 'mean' } })), undefined, 'the donor guard does not fire on an absent run count');

  assert.equal(errorFrom(() => validateFromIndex(plan({ experiment: { id: 'e1', primaryMetric: 'median', replicationRuns: 3 } }))).message, 'Invalid primary metric');
  assert.equal(errorFrom(() => validateFromIndex(plan({ experiment: { id: 'e1', replicationRuns: 3 } }))).message, 'Invalid primary metric');
  assert.equal(validateFromIndex({ hypothesis: 'X.', experiment: { id: 'e1', primaryMetric: 'rate', replicationRuns: 2 } }), undefined, 'the donor gate never inspects the selected question or the review');
});
