/**
 * UTOPIA · Research Institute — cross-review loop suite.
 *
 * The review verdicts, their exact reason strings and the refusal paths restate the
 * Codex-Boss donor `src/shared/research-review.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_ROLES, REVIEW_VERDICTS, metaReview, publicationReady, respondToObjections, reviewRoundSettled } from '../index.mjs';
import { REVIEW_ROLES as REVIEW_ROLES_FROM_REVIEW } from '../review.mjs';

const round = (objections, responses) => ({ roundId: 'round-1', objections, responses });
const objection = (id, severity = 'minor') => ({ id, role: 'METHOD', issue: `issue ${id}`, severity, revisedSections: [] });
const response = (objectionId, overrides = {}) => ({ objectionId, reply: 'addressed', revisedSections: [], ...overrides });

test('the review module re-exports the donor role vocabulary unchanged', () => {
  assert.deepEqual(REVIEW_ROLES_FROM_REVIEW, REVIEW_ROLES);
  assert.deepEqual(REVIEW_ROLES, ['METHOD', 'EVIDENCE', 'CLAIM', 'WRITING', 'REPRODUCIBILITY', 'META']);
  assert.deepEqual(REVIEW_VERDICTS, ['APPROVED', 'REVISE']);
});

test('respondToObjections appends, replaces in place, and refuses an unknown objection', () => {
  const base = round([objection('o1'), objection('o2')], []);

  const appended = respondToObjections(base, [response('o1')]);
  assert.deepEqual(appended.responses.map((item) => item.objectionId), ['o1']);
  assert.equal(base.responses.length, 0, 'the input round is never mutated');
  assert.notEqual(appended, base, 'a new round object is returned');
  assert.equal(appended.roundId, 'round-1');
  assert.equal(appended.objections, base.objections);

  // a response to an existing objection is replaced at its index, not appended
  const replaced = respondToObjections(round([objection('o1'), objection('o2')], [response('o1', { reply: 'first' })]), [response('o1', { reply: 'second' }), response('o2')]);
  assert.deepEqual(replaced.responses.map((item) => item.reply), ['second', 'addressed']);

  // two responses for the same objection in one batch: the last one survives
  const deduped = respondToObjections(base, [response('o1', { reply: 'first' }), response('o1', { reply: 'second' })]);
  assert.equal(deduped.responses.length, 1);
  assert.equal(deduped.responses[0].reply, 'second');

  // an unknown objection is refused, and nothing from the batch is merged
  const error = (() => {
    try {
      respondToObjections(base, [response('o1'), response('o9')]);
    } catch (thrown) {
      return thrown;
    }
    return null;
  })();
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'Error');
  assert.equal(error.message, 'Unknown objection o9');
  assert.equal(base.responses.length, 0, 'validation happens before any merge');
  assert.equal(respondToObjections(base, []).responses.length, 0);
});

test('reviewRoundSettled reports open objections and violations, in objection order', () => {
  const objections = [objection('o1', 'major'), objection('o2', 'minor'), objection('o3', 'minor')];

  // no responses at all: every objection is open, and an open objection is not also
  // a violation
  assert.deepEqual(reviewRoundSettled(round(objections, [])), { settled: false, open: ['o1', 'o2', 'o3'], violations: [] });

  // a major objection may not be retained; a minor one may; o3 is still open
  const retained = reviewRoundSettled(round(objections, [
    response('o1', { retainedReason: 'too expensive' }),
    response('o2', { retainedReason: 'style only' }),
  ]));
  assert.deepEqual(retained, { settled: false, open: ['o3'], violations: ['major objection o1 cannot be merely retained'] });

  // a blank reply is no response
  assert.deepEqual(reviewRoundSettled(round([objection('o2')], [response('o2', { reply: '   ' })])), { settled: false, open: [], violations: ['objection o2 has no response'] });
  assert.deepEqual(reviewRoundSettled(round([objection('o2')], [{ objectionId: 'o2', revisedSections: [] }])), { settled: false, open: [], violations: ['objection o2 has no response'] });

  // fully settled: every objection has a non-blank reply
  assert.deepEqual(reviewRoundSettled(round(objections, [response('o1'), response('o2'), response('o3')])), { settled: true, open: [], violations: [] });

  // violations and open objections are reported together, violations first per objection
  const both = reviewRoundSettled(round(objections, [response('o1', { retainedReason: 'no' }), response('o2', { reply: '' })]));
  assert.deepEqual(both, { settled: false, open: ['o3'], violations: ['major objection o1 cannot be merely retained', 'objection o2 has no response'] });
});

test('metaReview approves only a settled round whose revisions landed', () => {
  const objections = [objection('o1', 'major'), objection('o2')];

  // unsettled with violations: the violations, then the donor's literal tail
  assert.deepEqual(metaReview(round(objections, [response('o1', { retainedReason: 'no' })])), {
    verdict: 'REVISE',
    reasons: ['major objection o1 cannot be merely retained', 'open objections remain'],
  });

  // unsettled with no open objection at all still appends the same literal tail
  assert.deepEqual(metaReview(round([objection('o1')], [response('o1', { reply: '' })])), {
    verdict: 'REVISE',
    reasons: ['objection o1 has no response', 'open objections remain'],
  });
  assert.deepEqual(metaReview(round([], [])), { verdict: 'REVISE', reasons: ['no sections revised'] }, 'a round with no objections is settled, but unrevised');

  // settled but nothing revised
  assert.deepEqual(metaReview(round(objections, [response('o1'), response('o2')])), { verdict: 'REVISE', reasons: ['no sections revised'] });

  // settled with one revised section: the exact approval shape, no reasons
  assert.deepEqual(metaReview(round(objections, [response('o1', { revisedSections: ['methods'] }), response('o2')])), { verdict: 'APPROVED', reasons: [] });

  // only the responses count: an objection's own section list does not approve it
  assert.deepEqual(metaReview(round([{ ...objection('o1'), revisedSections: ['methods'] }], [response('o1')])), { verdict: 'REVISE', reasons: ['no sections revised'] });

  // a retained minor objection can still settle the round, and the revision approves it
  assert.deepEqual(metaReview(round([objection('o1')], [response('o1', { retainedReason: 'style only', revisedSections: ['intro'] })])), { verdict: 'APPROVED', reasons: [] });
});

test('metaReview reads revisedSections directly, exactly as the donor does', () => {
  // the donor has no guard here: a response without the array is a TypeError, never a
  // silent "unrevised" verdict
  assert.throws(() => metaReview(round([objection('o1')], [{ objectionId: 'o1', reply: 'ok' }])), TypeError);
});

test('publicationReady reports the four publication gates in the donor order', () => {
  const all = { contractPresent: true, sufficiencyPassed: true, reviewSettled: true, metaApproved: true };
  assert.deepEqual(publicationReady(all), { ready: true, missing: [] });

  assert.deepEqual(publicationReady({ ...all, contractPresent: false }), { ready: false, missing: ['research contract missing'] });
  assert.deepEqual(publicationReady({ ...all, sufficiencyPassed: false }), { ready: false, missing: ['sufficiency gate failed'] });
  assert.deepEqual(publicationReady({ ...all, reviewSettled: false }), { ready: false, missing: ['review round unsettled'] });
  assert.deepEqual(publicationReady({ ...all, metaApproved: false }), { ready: false, missing: ['meta-review not approved'] });

  assert.deepEqual(publicationReady({ contractPresent: false, sufficiencyPassed: false, reviewSettled: false, metaApproved: false }), {
    ready: false,
    missing: ['research contract missing', 'sufficiency gate failed', 'review round unsettled', 'meta-review not approved'],
  });

  // the gates are truthiness tests, exactly as in the donor: no extra boolean rung
  assert.deepEqual(publicationReady({ contractPresent: 1, sufficiencyPassed: 'yes', reviewSettled: [], metaApproved: {} }), { ready: true, missing: [] });
  assert.deepEqual(publicationReady({ contractPresent: 0, sufficiencyPassed: true, reviewSettled: true, metaApproved: true }), { ready: false, missing: ['research contract missing'] });
  assert.deepEqual(publicationReady({ contractPresent: '', sufficiencyPassed: null, reviewSettled: 0, metaApproved: undefined }), {
    ready: false,
    missing: ['research contract missing', 'sufficiency gate failed', 'review round unsettled', 'meta-review not approved'],
  });
});
