/**
 * UTOPIA · Research Institute — Level-B selection suite.
 *
 * The falsifiability rule, its boundary behaviour, the rejection reasons, the
 * ranking and the refusal path restate the Codex-Boss donor
 * `src/shared/research-levelb.ts` @ 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TEXT_LENGTH, isFalsifiable, selectFalsifiableQuestion } from '../index.mjs';

const candidate = (overrides = {}) => ({ id: 'q1', question: 'Does X cause Y?', measurable: true, falsifiable: true, proposedBy: 'reviewer-1', ...overrides });
const errorFrom = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

test('isFalsifiable requires both flags and uses the donor truthiness test', () => {
  assert.equal(isFalsifiable({ measurable: true, falsifiable: true }), true);
  assert.equal(isFalsifiable({ measurable: true, falsifiable: false }), false);
  assert.equal(isFalsifiable({ measurable: false, falsifiable: true }), false);
  assert.equal(isFalsifiable({ measurable: false, falsifiable: false }), false);

  // the donor's `measurable && falsifiable` is a truthiness test, not `=== true`
  assert.equal(Boolean(isFalsifiable({ measurable: 1, falsifiable: 'yes' })), true);
  assert.equal(Boolean(isFalsifiable({ measurable: 0, falsifiable: 'yes' })), false);
  assert.equal(Boolean(isFalsifiable({ measurable: [], falsifiable: {} })), true);
  assert.equal(Boolean(isFalsifiable({ measurable: 'yes', falsifiable: '' })), false);
});

test('selectFalsifiableQuestion rejects with the donor reason and never drops a candidate', () => {
  const unmeasurable = candidate({ id: 'c1', measurable: false });
  const unfalsifiable = candidate({ id: 'c2', falsifiable: false });
  const neither = candidate({ id: 'c3', measurable: false, falsifiable: false });
  const ready = candidate({ id: 'c4', question: 'Does the tracker reduce latency?' });

  const selection = selectFalsifiableQuestion([unmeasurable, unfalsifiable, neither, ready]);
  assert.deepEqual(selection, {
    selectedId: 'c4',
    rejected: [
      { id: 'c1', reason: 'no measurable primary metric proposed' },
      { id: 'c2', reason: 'hypothesis is not falsifiable' },
      { id: 'c3', reason: 'no measurable primary metric proposed' },
    ],
    reason: 'falsifiable + measurable: Does the tracker reduce latency?',
  });
  assert.equal(selection.rejected.length, 3, 'a rejection is a record, not a silent drop');

  // measurable is checked before falsifiable, exactly as in the donor
  assert.equal(selectFalsifiableQuestion([neither]).rejected[0].reason, 'no measurable primary metric proposed');
});

test('a selection with nothing ready distinguishes "no candidates" from "no falsifiable candidate"', () => {
  assert.deepEqual(selectFalsifiableQuestion([]), { selectedId: null, rejected: [], reason: 'no candidates' });
  assert.deepEqual(selectFalsifiableQuestion([candidate({ id: 'c1', falsifiable: false })]), {
    selectedId: null,
    rejected: [{ id: 'c1', reason: 'hypothesis is not falsifiable' }],
    reason: 'no falsifiable candidate',
  });
});

test('ranking is novelty + feasibility with a ?? 0 default, and a tie keeps the earlier candidate', () => {
  const lower = candidate({ id: 'a', noveltyScore: 1, feasibilityScore: 1 });
  const firstOfTie = candidate({ id: 'b', noveltyScore: 3, feasibilityScore: 0 });
  const secondOfTie = candidate({ id: 'c', noveltyScore: 1.5, feasibilityScore: 1.5 });
  assert.equal(selectFalsifiableQuestion([lower, firstOfTie, secondOfTie]).selectedId, 'b', 'a stable sort keeps the earlier tie');
  assert.equal(selectFalsifiableQuestion([secondOfTie, firstOfTie, lower]).selectedId, 'c', 'and keeps the earlier of the reordered tie');

  // an absent score is 0, so a negative score loses to an absent one
  const absent = candidate({ id: 'd' });
  const negative = candidate({ id: 'e', noveltyScore: -1, feasibilityScore: -1 });
  assert.equal(selectFalsifiableQuestion([negative, absent]).selectedId, 'd');

  // a score of exactly 0 is kept (?? only replaces null/undefined)
  const zero = candidate({ id: 'f', noveltyScore: 0, feasibilityScore: 0 });
  const nullish = candidate({ id: 'g', noveltyScore: null, feasibilityScore: null });
  assert.equal(selectFalsifiableQuestion([zero, nullish]).selectedId, 'f');
  assert.equal(selectFalsifiableQuestion([nullish, zero]).selectedId, 'g', 'both score 0, so the earlier wins');

  // the reason quotes the question verbatim, untrimmed
  assert.equal(selectFalsifiableQuestion([candidate({ id: 'h', question: '  spaced question  ' })]).reason, 'falsifiable + measurable:   spaced question  ');
});

test('the donor candidate check runs before selection, with its exact messages', () => {
  const valid = candidate();

  assert.equal(errorFrom(() => selectFalsifiableQuestion([{ ...valid, id: '' }])).message, 'Candidate requires an id');
  assert.equal(errorFrom(() => selectFalsifiableQuestion([null])).message, 'Candidate requires an id');
  assert.equal(errorFrom(() => selectFalsifiableQuestion([{ ...valid, question: '   ' }])).message, 'Candidate question invalid');
  assert.equal(errorFrom(() => selectFalsifiableQuestion([{ ...valid, question: 7 }])).message, 'Candidate question invalid');
  assert.equal(errorFrom(() => selectFalsifiableQuestion([{ ...valid, proposedBy: ' ' }])).message, 'Candidate requires a proposer');

  // exactly the limit is selected, one over is refused
  const atLimit = candidate({ id: 'limit', question: 'q'.repeat(MAX_TEXT_LENGTH) });
  assert.equal(selectFalsifiableQuestion([atLimit]).selectedId, 'limit');
  assert.equal(errorFrom(() => selectFalsifiableQuestion([candidate({ question: 'q'.repeat(MAX_TEXT_LENGTH + 1) })])).message, 'Candidate question invalid');

  // an invalid candidate after a valid one still refuses the whole selection
  assert.equal(errorFrom(() => selectFalsifiableQuestion([valid, { ...valid, id: '' }])).message, 'Candidate requires an id');

  // and the check precedes the measurability rejection: an invalid unmeasurable
  // candidate throws rather than being recorded as rejected
  assert.equal(errorFrom(() => selectFalsifiableQuestion([{ id: 'x', question: '   ', measurable: false, falsifiable: false, proposedBy: 'p' }])).message, 'Candidate question invalid');
});
