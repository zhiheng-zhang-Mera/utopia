/**
 * UTOPIA · Research Institute — research contract suite.
 *
 * Contract-bound section prompts, the goal-rewrite refusal, and the sufficiency gate,
 * restated from the Codex-Boss donor `src/shared/research-contract.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSectionPromptsFromContract, sufficiencyAudit, violatesContract } from '../index.mjs';

const contract = (overrides = {}) => ({
  researchQuestion: 'does X beat Y',
  hypotheses: ['h1'],
  claims: [
    { id: 'claim-1', statement: 'X beats Y on accuracy', evidenceRequirement: 'accuracy above 0.5 with the pinned harness' },
    { id: 'claim-2', statement: 'X is cheaper', evidenceRequirement: 'latency below the baseline' },
  ],
  experimentPlan: { runsPerHypothesis: 2, metric: 'accuracy', baseline: '0.5' },
  evaluationCriterion: 'accuracy > 0.5',
  citationPolicy: 'strict-verbatim',
  sections: ['Methods', 'Results', 'Discussion'],
  acceptanceGates: ['reviews done'],
  frozenAt: '2026-09-29T00:00:00.000Z',
  ...overrides,
});

test('a section prompt is bound to the frozen contract and lists only its claims', () => {
  const prompts = expandSectionPromptsFromContract(contract());
  assert.deepEqual(prompts.map((spec) => spec.section), ['Methods', 'Results', 'Discussion']);
  assert.deepEqual(prompts[0].requiredClaimIds, ['claim-1', 'claim-2'], 'a Methods section carries every claim');
  assert.deepEqual(prompts[1].requiredClaimIds, [], 'no Results claim statement mentions Results');
  assert.deepEqual(prompts[2].requiredClaimIds, []);

  assert.equal(
    prompts[0].prompt,
    'Write the "Methods" section for the frozen research contract below. '
    + 'Anchor every statement in the given hypotheses/claims/metrics; you may NOT change the research question, hypotheses, metric, baseline or evaluation criterion. '
    + 'Research question: does X beat Y. Hypotheses: h1. Primary metric: accuracy; baseline: 0.5; decision rule: accuracy > 0.5. Citation policy: strict-verbatim.',
  );

  // a claim whose statement echoes the section name is required by that section only
  const echoed = expandSectionPromptsFromContract(contract({ claims: [{ id: 'claim-9', statement: 'the Results section reports accuracy', evidenceRequirement: 'x' }] }));
  assert.deepEqual(echoed[1].requiredClaimIds, ['claim-9']);
  assert.deepEqual(echoed[0].requiredClaimIds, ['claim-9'], 'a Methods section still carries every claim');
  assert.match(echoed[1].prompt, /Hypotheses: h1\./, 'the whole hypothesis list is joined with "; "');
  assert.match(expandSectionPromptsFromContract(contract({ hypotheses: ['h1', 'h2'] }))[0].prompt, /Hypotheses: h1; h2\./);
});

test('a section that would rewrite the frozen goal is refused with the donor reason', () => {
  const spec = expandSectionPromptsFromContract(contract())[0];
  assert.equal(violatesContract(spec, 'We measure accuracy with the pinned harness.', contract()), undefined);
  assert.equal(violatesContract(spec, '', contract()), 'empty section');
  for (const text of [
    'The new research question is whether Z beats W.',
    'I propose studying a different corpus.',
    'Let us investigate whether the following new dataset helps.',
    'We change the hypothesis to Z.',
  ]) {
    assert.equal(violatesContract(spec, text, contract()), 'section must not rewrite the frozen research goal', text);
  }
  assert.equal(violatesContract(spec, 'we CHANGE THE HYPOTHESIS', contract()), 'section must not rewrite the frozen research goal', 'the pattern is case-insensitive');
  // the check is on the text only: no other input changes the verdict
  assert.equal(violatesContract(null, 'plain text', null), undefined);
});

test('the sufficiency gate needs evidence, runs, citations and a review', () => {
  const full = {
    evidenceRefs: ['evidence:claim-1', 'evidence:latency below the baseline'],
    executedExperiments: 2,
    reviewsCompleted: 1,
    citationsTraceable: 3,
    openCriticism: [],
  };
  assert.deepEqual(sufficiencyAudit(contract(), full), { sufficient: true, missing: [], notes: [] });

  const noClaimEvidence = sufficiencyAudit(contract(), { ...full, evidenceRefs: [] });
  assert.deepEqual(noClaimEvidence.missing, ['claim claim-1 has no supporting evidence', 'claim claim-2 has no supporting evidence']);
  assert.equal(noClaimEvidence.sufficient, false);

  const partial = sufficiencyAudit(contract(), { ...full, evidenceRefs: ['evidence:claim-1', 'evidence:latency below the baseline'] });
  assert.deepEqual(partial.missing, [], 'the requirement is matched by its first 24 characters (here "latency below the baseline")');
  assert.equal(partial.sufficient, true);

  const lengthOnly = sufficiencyAudit(contract(), { ...full, evidenceRefs: ['evidence:claim-1', 'evidence:accuracy above 0.5 with the pinned harness'] });
  assert.deepEqual(lengthOnly.missing, ['claim claim-2 has no supporting evidence'], 'the fallback matches the requirement text, not its length');

  const missingOne = sufficiencyAudit(contract(), { ...full, evidenceRefs: ['evidence:claim-1'] });
  assert.deepEqual(missingOne.missing, ['claim claim-2 has no supporting evidence']);

  const prefix = sufficiencyAudit(contract(), { ...full, evidenceRefs: ['evidence:accuracy above 0.5 with ', 'evidence:latency below the baseline'] });
  assert.deepEqual(prefix.missing, [], 'claim-1 is matched by the first 24 characters of its requirement ("accuracy above 0.5 with ")');

  const noRuns = sufficiencyAudit(contract(), { ...full, executedExperiments: 1 });
  assert.deepEqual(noRuns.missing, ['experiments executed (1) < required (2)']);

  const noCitations = sufficiencyAudit(contract(), { ...full, citationsTraceable: 0 });
  assert.deepEqual(noCitations.missing, ['no traceable citations']);

  const noReview = sufficiencyAudit(contract(), { ...full, reviewsCompleted: 0 });
  assert.deepEqual(noReview.missing, ['no review completed']);
});

test('the sufficiency gate keeps the donor accounting exactly', () => {
  const full = {
    evidenceRefs: ['evidence:claim-1'],
    executedExperiments: 2,
    reviewsCompleted: 1,
    citationsTraceable: 1,
    openCriticism: [],
  };

  // the requirement is runsPerHypothesis x max(1, hypotheses.length) ...
  const noHypotheses = sufficiencyAudit(contract({ hypotheses: [] }), { ...full, executedExperiments: 2 });
  assert.deepEqual(noHypotheses.missing, ['claim claim-2 has no supporting evidence'], 'one hypothesis worth of runs is the floor when none is declared');

  // ... but the printed requirement is the UNCLAMPED product, so two runs clear a
  // contract that declares no hypotheses while one run does not
  const oneRun = sufficiencyAudit(contract({ hypotheses: [] }), { ...full, executedExperiments: 1 });
  assert.deepEqual(oneRun.missing[1], 'experiments executed (1) < required (0)');

  // with one declared hypothesis the clamp and the product agree
  const twoRuns = sufficiencyAudit(contract({ hypotheses: ['h1'] }), { ...full, executedExperiments: 2 });
  assert.deepEqual(twoRuns.missing, ['claim claim-2 has no supporting evidence']);

  // manual citation policy is the one case where no traceable citation is not missing
  assert.deepEqual(sufficiencyAudit(contract({ citationPolicy: 'manual' }), { ...full, citationsTraceable: 0 }).missing, ['claim claim-2 has no supporting evidence']);
  assert.deepEqual(sufficiencyAudit(contract({ citationPolicy: 'strict-summary' }), { ...full, citationsTraceable: 0 }).missing, ['claim claim-2 has no supporting evidence', 'no traceable citations']);

  // unresolved criticism is retained explicitly in notes and never blocks
  const withCriticism = sufficiencyAudit(contract(), { ...full, openCriticism: ['variance unexplained', 'baseline contested'] });
  assert.deepEqual(withCriticism.notes, ['unresolved criticism retained explicitly: variance unexplained; baseline contested']);
  assert.deepEqual(withCriticism.missing, ['claim claim-2 has no supporting evidence']);
  assert.equal(withCriticism.sufficient, false);

  // a section prompt derives from a contract with no sections without inventing one
  assert.deepEqual(expandSectionPromptsFromContract(contract({ sections: [] })), []);
});
