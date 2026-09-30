/**
 * UTOPIA · Research Institute — research proposal / research contract.
 *
 * The Research Proposal (RP) is a formal intermediate product; a Research Contract
 * derives from it and is the ONLY anchor for paper expansion — a section writer may
 * not regenerate the research goal freely. The sufficiency gate audits the run's
 * durable decisions/evidence against the contract before a final paper may be
 * declared: claims need evidence, experiments must be executed, citations must be
 * traceable, reviews must be done, criticism must be closed or explicitly retained.
 *
 * Ported from the Codex-Boss donor `src/shared/research-contract.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure: no clock, no fs, no model call —
 * this module decides whether the durable record is sufficient, it does not produce
 * the record.
 *
 * Rules that must not be softened:
 *   - a section prompt is derived strictly from the frozen contract and forbids
 *     changing the question, hypotheses, metric, baseline or decision rule;
 *   - `violatesContract` returns a reason (never mutates), and an empty section is
 *     already a refusal;
 *   - the experiment requirement is `runsPerHypothesis × max(1, hypotheses)`, and the
 *     message always reports the UNCLAMPED product, exactly as the donor prints it;
 *   - `manual` citation policy is the one case where zero traceable citations is not
 *     a missing item;
 *   - unresolved criticism never blocks: it is retained explicitly in `notes`.
 */

import { researchContract } from './contracts.mjs';

export { CITATION_POLICIES, researchContract } from './contracts.mjs';

export function expandSectionPromptsFromContract(contract) {
  return contract.sections.map((section) => {
    const relevantClaims = contract.claims.filter((claim) => claim.statement.toLowerCase().includes(section.toLowerCase()) || section.toLowerCase().includes('method'));
    return {
      section,
      prompt: `Write the "${section}" section for the frozen research contract below. Anchor every statement in the given hypotheses/claims/metrics; you may NOT change the research question, hypotheses, metric, baseline or evaluation criterion. Research question: ${contract.researchQuestion}. Hypotheses: ${contract.hypotheses.join('; ')}. Primary metric: ${contract.experimentPlan.metric}; baseline: ${contract.experimentPlan.baseline}; decision rule: ${contract.evaluationCriterion}. Citation policy: ${contract.citationPolicy}.`,
      requiredClaimIds: relevantClaims.map((claim) => claim.id),
    };
  });
}

/** A prompt that would rewrite the goal is rejected (section expansion is contract-bound). */
export function violatesContract(sectionSpec, proposedText, contract) {
  if (proposedText.length < 1) return 'empty section';
  const rewritesGoal = /new research question|i propose studying|let us investigate whether the following new|change the hypothesis/i.test(proposedText);
  if (rewritesGoal) return 'section must not rewrite the frozen research goal';
  return undefined;
}

export function sufficiencyAudit(contract, evidence) {
  const missing = [];
  const notes = [];
  for (const claim of contract.claims) {
    if (!evidence.evidenceRefs.some((ref) => ref.includes(claim.id) || ref.includes(claim.evidenceRequirement.slice(0, 24)))) {
      missing.push(`claim ${claim.id} has no supporting evidence`);
    }
  }
  if (evidence.executedExperiments < contract.experimentPlan.runsPerHypothesis * Math.max(1, contract.hypotheses.length)) {
    missing.push(`experiments executed (${evidence.executedExperiments}) < required (${contract.experimentPlan.runsPerHypothesis * contract.hypotheses.length})`);
  }
  if (evidence.citationsTraceable < 1 && contract.citationPolicy !== 'manual') missing.push('no traceable citations');
  if (evidence.reviewsCompleted < 1) missing.push('no review completed');
  if (evidence.openCriticism.length) notes.push(`unresolved criticism retained explicitly: ${evidence.openCriticism.join('; ')}`);
  return { sufficient: missing.length === 0, missing, notes };
}
