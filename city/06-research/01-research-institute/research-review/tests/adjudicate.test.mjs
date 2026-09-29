/**
 * UTOPIA · Research Institute — adjudication suite.
 *
 * The evidence-over-vote precedence, the exact reason strings and the vote
 * thresholds restate the Codex-Boss donor `src/shared/research-adjudicate.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REQUIRED_VOTES, adjudicateClaim, claimEvidence, reviewerVote } from '../index.mjs';

const vote = (reviewerId, claimId, stance) => ({ reviewerId, claimId, stance });
const decisive = (overrides = {}) => ({ claimId: 'c1', statisticSupported: true, independentReplication: true, verifiedCitations: 3, ...overrides });

test('the constructor factories carry the adjudication shapes, and the default is one vote', () => {
  assert.equal(DEFAULT_REQUIRED_VOTES, 1);
  assert.deepEqual(reviewerVote({ reviewerId: 'r1', claimId: 'c1', stance: 'supports' }), { reviewerId: 'r1', claimId: 'c1', stance: 'supports' });
  assert.deepEqual(claimEvidence({ claimId: 'c1', statisticSupported: true, independentReplication: true, verifiedCitations: 3 }), decisive());
  assert.deepEqual(adjudicateClaim({ votes: [vote('r1', 'c1', 'supports')], evidence: decisive() }), {
    claimId: 'c1',
    adopted: true,
    reason: 'evidence supports claim and 1/1 reviewers concur',
  });
});

test('only the votes bound to the evidence claim are counted', () => {
  const verdict = adjudicateClaim({
    votes: [vote('r1', 'c1', 'supports'), vote('r2', 'c1', 'opposes'), vote('r3', 'c2', 'supports'), vote('r4', 'c2', 'supports'), vote('r5', 'c2', 'supports')],
    evidence: decisive(),
  });
  assert.deepEqual(verdict, { claimId: 'c1', adopted: true, reason: 'evidence supports claim and 1/2 reviewers concur' });

  // no vote names the claim at all: the required boundary is not met, so the donor
  // asks for a human rather than adopting
  assert.deepEqual(adjudicateClaim({ votes: [vote('r3', 'c2', 'supports')], evidence: decisive() }), {
    claimId: 'c1',
    adopted: false,
    reason: 'evidence supports the claim but fewer than 1 reviewers concur; requires human review',
  });
});

test('adoption needs both evidence flags: evidence outranks any number of votes', () => {
  const tenSupports = Array.from({ length: 10 }, (_, index) => vote(`r${index}`, 'c1', 'supports'));

  // statistic false, replication false: the donor's order, statistic first
  assert.deepEqual(adjudicateClaim({ votes: tenSupports, evidence: decisive({ statisticSupported: false, independentReplication: false }) }), {
    claimId: 'c1',
    adopted: false,
    reason: 'statistic does not support the claim; no independent replication',
  });
  assert.deepEqual(adjudicateClaim({ votes: tenSupports, evidence: decisive({ statisticSupported: false }) }), {
    claimId: 'c1',
    adopted: false,
    reason: 'statistic does not support the claim',
  });
  assert.deepEqual(adjudicateClaim({ votes: tenSupports, evidence: decisive({ independentReplication: false }) }), {
    claimId: 'c1',
    adopted: false,
    reason: 'no independent replication',
  });

  // no votes and no evidence: the joined reasons, never the unreachable fallback
  assert.deepEqual(adjudicateClaim({ votes: [], evidence: decisive({ statisticSupported: false, independentReplication: false }) }), {
    claimId: 'c1',
    adopted: false,
    reason: 'statistic does not support the claim; no independent replication',
  });
});

test('with decisive evidence, the required-vote threshold decides, at and either side of it', () => {
  const three = [vote('r1', 'c1', 'supports'), vote('r2', 'c1', 'supports'), vote('r3', 'c1', 'opposes')];

  // required 2: exactly two supports adopt; one support (one below) does not
  assert.deepEqual(adjudicateClaim({ votes: three, evidence: decisive(), requiredVotes: 2 }), { claimId: 'c1', adopted: true, reason: 'evidence supports claim and 2/3 reviewers concur' });
  assert.deepEqual(adjudicateClaim({ votes: three, evidence: decisive(), requiredVotes: 3 }), {
    claimId: 'c1',
    adopted: false,
    reason: 'evidence supports the claim but fewer than 3 reviewers concur; requires human review',
  });

  // required 1: one support adopts, zero (one below) does not
  assert.deepEqual(adjudicateClaim({ votes: [vote('r1', 'c1', 'supports')], evidence: decisive(), requiredVotes: 1 }), { claimId: 'c1', adopted: true, reason: 'evidence supports claim and 1/1 reviewers concur' });
  assert.deepEqual(adjudicateClaim({ votes: [vote('r1', 'c1', 'opposes')], evidence: decisive(), requiredVotes: 1 }), {
    claimId: 'c1',
    adopted: false,
    reason: 'evidence supports the claim but fewer than 1 reviewers concur; requires human review',
  });

  // required 0 is accepted by the donor's `?? 1` and is always backed
  assert.deepEqual(adjudicateClaim({ votes: [vote('r1', 'c1', 'opposes')], evidence: decisive(), requiredVotes: 0 }), { claimId: 'c1', adopted: true, reason: 'evidence supports claim and 0/1 reviewers concur' });

  // the default applies only when requiredVotes is absent, not when it is 0
  assert.equal(DEFAULT_REQUIRED_VOTES, 1);
  assert.deepEqual(adjudicateClaim({ votes: three, evidence: decisive() }), { claimId: 'c1', adopted: true, reason: 'evidence supports claim and 2/3 reviewers concur' });
});

test('a non-supporting stance never counts as concurrence', () => {
  assert.deepEqual(adjudicateClaim({ votes: [vote('r1', 'c1', 'opposes'), vote('r2', 'c1', 'opposes')], evidence: decisive() }), {
    claimId: 'c1',
    adopted: false,
    reason: 'evidence supports the claim but fewer than 1 reviewers concur; requires human review',
  });
  // a vote whose claimId does not match is filtered before the stance is read
  assert.deepEqual(adjudicateClaim({ votes: [vote('r1', 'c9', 'supports')], evidence: decisive() }), {
    claimId: 'c1',
    adopted: false,
    reason: 'evidence supports the claim but fewer than 1 reviewers concur; requires human review',
  });
});

test('verifiedCitations is declared but never read, exactly as in the donor', () => {
  const none = adjudicateClaim({ votes: [vote('r1', 'c1', 'supports')], evidence: decisive({ verifiedCitations: 0 }) });
  const many = adjudicateClaim({ votes: [vote('r1', 'c1', 'supports')], evidence: decisive({ verifiedCitations: 99 }) });
  assert.deepEqual(none, many);

  const unsupported = adjudicateClaim({ votes: [], evidence: decisive({ statisticSupported: false, independentReplication: false, verifiedCitations: 99 }) });
  assert.equal(unsupported.reason, 'statistic does not support the claim; no independent replication');
});
