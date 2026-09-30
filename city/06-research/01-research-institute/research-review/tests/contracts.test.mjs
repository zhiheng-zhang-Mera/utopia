/**
 * UTOPIA · Research Institute — contract suite.
 *
 * The frozen vocabularies, thresholds, copy-on-construct factories and strict
 * validators of `contracts.mjs`, restating the Codex-Boss donor files
 * `src/shared/research-review.ts`, `src/shared/research-adjudicate.ts`,
 * `src/shared/research-levela.ts`, `src/shared/research-levelb.ts` and
 * `src/shared/research-capability-registry.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The registry digest below is computed from the copied vocabulary, not guessed:
 * changing a single label, trigger or order changes the digest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEFAULT_REPLICATION_RUNS,
  DEFAULT_REQUIRED_VOTES,
  DEFAULT_SEED,
  EPOCH_TIMESTAMP,
  FALSIFIABLE_FEASIBILITY_BONUS,
  LEVEL_A_MIN_SCORE,
  MAX_TEXT_LENGTH,
  NO_HARNESS_FEASIBILITY_PENALTY,
  NOVELTY_OVERLAP_CREDIT,
  NOVELTY_OVERLAP_PENALTY,
  NOVELTY_SCORE_WEIGHT,
  PRIMARY_METRICS,
  REPLICATION_RUNS_MAX,
  REPLICATION_RUNS_MIN,
  RESEARCH_CAPABILITIES,
  RESEARCH_CAPABILITY_IDS,
  RESEARCH_CAPABILITY_STATUSES,
  REVIEW_ROLES,
  REVIEW_SEVERITIES,
  REVIEW_STANCES,
  REVIEW_VERDICTS,
  SCORE_MAX,
  SCORE_MIN,
  candidateQuestion,
  claimEvidence,
  experimentSpec,
  isResearchCapabilityStatus,
  projectSignals,
  publicationState,
  researchStudyProfile,
  reviewObjection,
  reviewResponse,
  reviewRound,
  reviewerVote,
  validateCandidateQuestion,
  validateLevelAPlan,
} from '../index.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** The thrown error itself, so its exact name and message can be asserted. */
function errorFrom(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

test('the frozen vocabularies are the donor vocabularies in the donor order', () => {
  assert.deepEqual(REVIEW_ROLES, ['METHOD', 'EVIDENCE', 'CLAIM', 'WRITING', 'REPRODUCIBILITY', 'META']);
  assert.deepEqual(REVIEW_SEVERITIES, ['major', 'minor']);
  assert.deepEqual(REVIEW_VERDICTS, ['APPROVED', 'REVISE']);
  assert.deepEqual(REVIEW_STANCES, ['supports', 'opposes']);
  assert.deepEqual(PRIMARY_METRICS, ['mean', 'proportion', 'effect-size', 'rate']);
  assert.deepEqual(RESEARCH_CAPABILITY_STATUSES, ['AVAILABLE', 'NEEDED', 'NOT_NEEDED', 'FAILED']);

  for (const vocabulary of [REVIEW_ROLES, REVIEW_SEVERITIES, REVIEW_VERDICTS, REVIEW_STANCES, PRIMARY_METRICS, RESEARCH_CAPABILITY_IDS, RESEARCH_CAPABILITY_STATUSES, RESEARCH_CAPABILITIES]) {
    assert.ok(Object.isFrozen(vocabulary), 'vocabularies are frozen');
  }
  assert.throws(() => { REVIEW_ROLES[0] = 'OTHER'; }, TypeError, 'a frozen vocabulary cannot be edited');
  assert.throws(() => { RESEARCH_CAPABILITIES.push({ id: 'x', label: 'x', neededWhen: 'x' }); }, TypeError);
});

test('the capability registry is byte-identical to the donor and pinned by digest', () => {
  assert.equal(RESEARCH_CAPABILITIES.length, 16);
  assert.equal(RESEARCH_CAPABILITY_IDS.length, 16);
  assert.deepEqual(RESEARCH_CAPABILITIES.map((row) => row.id), [...RESEARCH_CAPABILITY_IDS]);

  // lengths, then the digests computed with `node -e` over the copied value
  const capabilitiesJson = JSON.stringify(RESEARCH_CAPABILITIES);
  assert.equal(capabilitiesJson.length, 1617);
  assert.equal(sha256(capabilitiesJson).length, 64);
  assert.equal(sha256(capabilitiesJson), '6d131ac46467622c7317183c016b6af17950ce27fc29346b15f6ef54d9b571ad');

  const idsJoined = RESEARCH_CAPABILITY_IDS.join(',');
  assert.equal(idsJoined.length, 293);
  assert.equal(sha256(idsJoined), '4805bb6419fa181dcbd0e13db7b75f0a4e316daa7561ce8d13346b7a71c701af');

  const rolesJoined = REVIEW_ROLES.join(',');
  assert.equal(rolesJoined.length, 50);
  assert.equal(sha256(rolesJoined), '6090fbbe57a818af0f1f74f407f950f42e51a0b0da7e768a40b11fe66553ae1a');

  assert.deepEqual(RESEARCH_CAPABILITIES[0], { id: 'literature-scout', label: '检索并获取相关文献', neededWhen: 'contextual literature is part of the study' });
  assert.deepEqual(RESEARCH_CAPABILITIES[10], { id: 'evidence-adjudicator', label: '裁决证据>投票的 claim', neededWhen: 'multiple reviewers/claims need adjudication' });
  assert.deepEqual(RESEARCH_CAPABILITIES[15], { id: 'latex-compiler', label: '编译 TEX→PDF', neededWhen: 'a compiled PDF deliverable is required' });
});

test('the thresholds are the donor thresholds, pinned exactly', () => {
  assert.equal(LEVEL_A_MIN_SCORE, 2);
  assert.equal(SCORE_MIN, 0);
  assert.equal(SCORE_MAX, 5);
  assert.equal(NOVELTY_OVERLAP_CREDIT, 3);
  assert.equal(NOVELTY_SCORE_WEIGHT, 0.5);
  assert.equal(NOVELTY_OVERLAP_PENALTY, 1);
  assert.equal(FALSIFIABLE_FEASIBILITY_BONUS, 2);
  assert.equal(NO_HARNESS_FEASIBILITY_PENALTY, 1);
  assert.equal(REPLICATION_RUNS_MIN, 2);
  assert.equal(REPLICATION_RUNS_MAX, 10);
  assert.equal(DEFAULT_REPLICATION_RUNS, 3);
  assert.equal(DEFAULT_SEED, 42);
  assert.equal(DEFAULT_REQUIRED_VOTES, 1);
  assert.equal(MAX_TEXT_LENGTH, 2000);

  // the deterministic clock default: the epoch sentinel, never the host clock
  assert.equal(EPOCH_TIMESTAMP, '1970-01-01T00:00:00.000Z');
  assert.equal(EPOCH_TIMESTAMP.length, 24);
  assert.equal(new Date(EPOCH_TIMESTAMP).getTime(), 0);
});

test('the factories copy on construct and enforce the declared shape', () => {
  const sections = ['intro'];
  const objection = reviewObjection({ id: 'o1', role: 'METHOD', issue: 'design is unfalsifiable', severity: 'major', revisedSections: sections });
  sections.push('mutated after construction');
  assert.deepEqual(objection, { id: 'o1', role: 'METHOD', issue: 'design is unfalsifiable', severity: 'major', revisedSections: ['intro'] }, 'the array is copied');

  const responses = [{ objectionId: 'o1', reply: 'fixed', revisedSections: ['intro'] }];
  const round = reviewRound({ roundId: 'r1', objections: [objection], responses });
  responses.push({ objectionId: 'o1', reply: 'sneaked in', revisedSections: [] });
  assert.equal(round.responses.length, 1, 'the responses array is copied');

  assert.deepEqual(reviewResponse({ objectionId: 'o1', reply: '', revisedSections: [] }), { objectionId: 'o1', reply: '', revisedSections: [] });
  assert.equal('retainedReason' in reviewResponse({ objectionId: 'o1', reply: 'x', revisedSections: [] }), false, 'an absent retention stays absent');
  assert.equal(reviewResponse({ objectionId: 'o1', reply: 'x', revisedSections: [], retainedReason: 'kept' }).retainedReason, 'kept');

  assert.deepEqual(publicationState({ contractPresent: true, sufficiencyPassed: false, reviewSettled: true, metaApproved: false }), { contractPresent: true, sufficiencyPassed: false, reviewSettled: true, metaApproved: false });
  assert.deepEqual(reviewerVote({ reviewerId: 'a', claimId: 'c1', stance: 'opposes' }), { reviewerId: 'a', claimId: 'c1', stance: 'opposes' });
  assert.deepEqual(claimEvidence({ claimId: 'c1', statisticSupported: true, independentReplication: false, verifiedCitations: 0 }), { claimId: 'c1', statisticSupported: true, independentReplication: false, verifiedCitations: 0 });
  assert.deepEqual(projectSignals({ files: 1, testFiles: 2, languages: ['ts'], topModules: ['a'] }), { files: 1, testFiles: 2, languages: ['ts'], topModules: ['a'] });
  assert.deepEqual(researchStudyProfile({ hasQuantitativeExperiments: true, bindsCitations: false, hasFormalProtocol: true }), { hasQuantitativeExperiments: true, bindsCitations: false, hasFormalProtocol: true });

  const spec = experimentSpec({ id: 'e1', primaryMetric: 'mean', replicationRuns: 3, purpose: 'EXPERIMENT', command: ['run'], seed: 42, createdAt: EPOCH_TIMESTAMP });
  assert.deepEqual(spec, { id: 'e1', primaryMetric: 'mean', replicationRuns: 3, purpose: 'EXPERIMENT', command: ['run'], seed: 42, createdAt: EPOCH_TIMESTAMP });

  // a factory never repairs invalid input: it refuses it
  assert.throws(() => reviewObjection({ id: 'o1', role: 'LEGAL', issue: 'x', severity: 'major', revisedSections: [] }), TypeError);
  assert.throws(() => reviewObjection({ id: 'o1', role: 'METHOD', issue: 'x', severity: 'blocker', revisedSections: [] }), TypeError);
  assert.throws(() => reviewObjection({ id: 'o1', role: 'METHOD', issue: 'x', severity: 'major' }), TypeError);
  assert.throws(() => reviewResponse({ objectionId: 'o1', reply: 7, revisedSections: [] }), TypeError);
  assert.throws(() => reviewResponse({ objectionId: 'o1', reply: 'x', revisedSections: [], retainedReason: 7 }), TypeError);
  assert.throws(() => reviewRound({ roundId: 'r1', objections: 'not a list', responses: [] }), TypeError);
  assert.throws(() => publicationState({ contractPresent: true, sufficiencyPassed: false, reviewSettled: true }), TypeError);
  assert.throws(() => reviewerVote({ reviewerId: 'a', claimId: 'c1', stance: 'abstains' }), TypeError);
  assert.throws(() => claimEvidence({ claimId: 'c1', statisticSupported: true, independentReplication: false }), TypeError);
  assert.throws(() => candidateQuestion({ id: 'q', question: 'q?', measurable: 'yes', falsifiable: true, proposedBy: 'p' }), TypeError);
  assert.throws(() => projectSignals({ files: 1, testFiles: 2, languages: 'ts', topModules: [] }), TypeError);
  assert.throws(() => researchStudyProfile({ hasQuantitativeExperiments: true, bindsCitations: false, hasFormalProtocol: true, hasArchitecture: 'yes' }), TypeError);
  assert.throws(() => experimentSpec({ id: 'e1', primaryMetric: 'median', replicationRuns: 3, purpose: 'EXPERIMENT', command: [], seed: 1, createdAt: EPOCH_TIMESTAMP }), TypeError);
  assert.throws(() => experimentSpec({ id: 'e1', primaryMetric: 'mean', replicationRuns: 3, purpose: 'REVIEW', command: [], seed: 1, createdAt: EPOCH_TIMESTAMP }), TypeError);
  assert.throws(() => reviewObjection(null), TypeError);
});

test('candidateQuestion enforces the donor limit and copies the optional fields', () => {
  const question = 'q'.repeat(MAX_TEXT_LENGTH);
  const candidate = candidateQuestion({ id: 'q1', question, measurable: true, falsifiable: false, proposedBy: 'p', hypothesis: 'h', noveltyScore: 0, feasibilityScore: 0 });
  assert.equal(candidate.question.length, MAX_TEXT_LENGTH, 'exactly the limit is accepted');
  assert.equal('hypothesis' in candidate, true);
  assert.equal(candidate.noveltyScore, 0, 'a zero score is kept, not defaulted away');
  assert.throws(() => candidateQuestion({ id: 'q1', question: `${question}q`, measurable: true, falsifiable: true, proposedBy: 'p' }), TypeError, 'one over the limit is refused');
  assert.throws(() => candidateQuestion({ id: '', question: 'q?', measurable: true, falsifiable: true, proposedBy: 'p' }), TypeError);
  assert.throws(() => candidateQuestion({ id: 'q1', question: '   ', measurable: true, falsifiable: true, proposedBy: 'p' }), TypeError);
  assert.throws(() => candidateQuestion({ id: 'q1', question: 'q?', measurable: true, falsifiable: true, proposedBy: ' ' }), TypeError);
});

test('validateCandidateQuestion is the donor check: exact messages and order', () => {
  const valid = { id: 'q1', question: 'Does X cause Y?', measurable: true, falsifiable: true, proposedBy: 'reviewer-1' };
  assert.equal(validateCandidateQuestion(valid), undefined);

  const idError = errorFrom(() => validateCandidateQuestion({ ...valid, id: '' }));
  assert.equal(idError.name, 'Error');
  assert.equal(idError.message, 'Candidate requires an id');
  assert.equal(errorFrom(() => validateCandidateQuestion(null)).message, 'Candidate requires an id');
  assert.equal(errorFrom(() => validateCandidateQuestion(undefined)).message, 'Candidate requires an id');

  // exactly at the limit passes, one over fails
  assert.equal(validateCandidateQuestion({ ...valid, question: 'q'.repeat(MAX_TEXT_LENGTH) }), undefined);
  assert.equal(errorFrom(() => validateCandidateQuestion({ ...valid, question: 'q'.repeat(MAX_TEXT_LENGTH + 1) })).message, 'Candidate question invalid');
  assert.equal(errorFrom(() => validateCandidateQuestion({ ...valid, question: '   ' })).message, 'Candidate question invalid');
  assert.equal(errorFrom(() => validateCandidateQuestion({ ...valid, question: 7 })).message, 'Candidate question invalid');
  assert.equal(errorFrom(() => validateCandidateQuestion({ ...valid, proposedBy: ' ' })).message, 'Candidate requires a proposer');

  // the id/question/proposer checks run before any research-property check
  assert.equal(errorFrom(() => validateCandidateQuestion({ id: 'q1', question: '   ', measurable: false, falsifiable: false, proposedBy: 'p' })).message, 'Candidate question invalid');
});

test('validateLevelAPlan is the donor check: exact messages, order and boundaries', () => {
  const plan = (overrides = {}) => ({
    selectedQuestion: { id: 'q1', question: 'Does X cause Y?', measurable: true, falsifiable: true, proposedBy: 'p' },
    hypothesis: 'X raises Y.',
    novelty: { claimId: 'q1', noveltyScore: 3, feasibilityScore: 3, reasons: [] },
    experiment: { id: 'e1', primaryMetric: 'mean', replicationRuns: 3, purpose: 'EXPERIMENT', command: [], seed: 42, createdAt: EPOCH_TIMESTAMP },
    ...overrides,
  });

  assert.equal(validateLevelAPlan(plan()), undefined);

  assert.equal(errorFrom(() => validateLevelAPlan(null)).message, 'Level-A plan requires a hypothesis');
  assert.equal(errorFrom(() => validateLevelAPlan(plan({ hypothesis: '   ' }))).message, 'Level-A plan requires a hypothesis');
  assert.equal(errorFrom(() => validateLevelAPlan(plan({ hypothesis: 'h'.repeat(MAX_TEXT_LENGTH + 1) }))).message, 'Level-A plan requires a hypothesis');
  assert.equal(errorFrom(() => validateLevelAPlan(plan({ hypothesis: 'h'.repeat(MAX_TEXT_LENGTH) }))), null, 'exactly the limit passes');

  assert.equal(errorFrom(() => validateLevelAPlan(plan({ experiment: null }))).message, 'Level-A plan requires an experiment');
  assert.equal(errorFrom(() => validateLevelAPlan(plan({ experiment: { id: '' } }))).message, 'Level-A plan requires an experiment');

  // the replication floor is `< 2`; the donor does not fire the guard on undefined
  assert.equal(errorFrom(() => validateLevelAPlan(plan({ experiment: { id: 'e1', primaryMetric: 'mean', replicationRuns: 1 } }))).message, 'Primary finding requires >= 2 replication runs');
  assert.equal(validateLevelAPlan(plan({ experiment: { id: 'e1', primaryMetric: 'mean', replicationRuns: REPLICATION_RUNS_MIN } })), undefined);
  assert.equal(validateLevelAPlan(plan({ experiment: { id: 'e1', primaryMetric: 'mean' } })), undefined, 'the donor guard does not fire on undefined');

  assert.equal(errorFrom(() => validateLevelAPlan(plan({ experiment: { id: 'e1', primaryMetric: 'median', replicationRuns: 3 } }))).message, 'Invalid primary metric');
  for (const primaryMetric of PRIMARY_METRICS) {
    assert.equal(validateLevelAPlan(plan({ experiment: { id: 'e1', primaryMetric, replicationRuns: 3 } })), undefined);
  }

  // the donor's plan gate does not look at the selected question or the review
  assert.equal(validateLevelAPlan({ hypothesis: 'X.', experiment: { id: 'e1', primaryMetric: 'rate', replicationRuns: 2 } }), undefined);
});

test('isResearchCapabilityStatus refuses anything that is not a donor status', () => {
  for (const status of RESEARCH_CAPABILITY_STATUSES) assert.equal(isResearchCapabilityStatus(status), true);
  for (const refused of ['AVAILABLE ', 'available', 'PLANNED', 'NEEDED ', '', undefined, null, 0, 1, true, {}, [], ['NEEDED']]) {
    assert.equal(isResearchCapabilityStatus(refused), false, `${JSON.stringify(refused)} must be refused`);
  }
});
