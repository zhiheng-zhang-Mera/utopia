/**
 * UTOPIA · Research Institute — evidence-over-vote adjudication.
 *
 * Multi-AI decisions follow `evidence > vote`: a claim supported by verified
 * experiment evidence (with an independent replication) is adopted even if fewer
 * reviewers voted for it; majority opinion with no evidence is not adopted.
 *
 * Ported from the Codex-Boss donor `src/shared/research-adjudicate.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The donor's decision rule, kept exactly:
 *   - only the votes whose `claimId` matches the evidence are counted;
 *   - decisive evidence means `statisticSupported` AND `independentReplication`;
 *   - with decisive evidence, adoption needs `supports >= required` (default 1) and
 *     then reads `${supports}/${votes.length}` reviewers concurring;
 *   - without decisive evidence, no number of votes ever adopts, and the reasons are
 *     joined with `; ` in the donor's order: statistic first, replication second.
 *
 * `ClaimEvidence.verifiedCitations` is declared by the donor and never read here;
 * no citation ladder is applied.
 */

import { DEFAULT_REQUIRED_VOTES } from './contracts.mjs';

/**
 * Adopts a claim only when the evidence is decisive:
 *  - statistic supports AND independent replication exists;
 *  - otherwise even unanimous reviewer votes never adopt (evidence > vote).
 */
export function adjudicateClaim(input) {
  const votes = input.votes.filter((vote) => vote.claimId === input.evidence.claimId);
  const supports = votes.filter((vote) => vote.stance === 'supports').length;
  const required = input.requiredVotes ?? DEFAULT_REQUIRED_VOTES;
  const majorityBacks = supports >= required;
  const reasons = [];
  if (!input.evidence.statisticSupported) reasons.push('statistic does not support the claim');
  if (!input.evidence.independentReplication) reasons.push('no independent replication');
  if (reasons.length === 0 && majorityBacks) {
    return { claimId: input.evidence.claimId, adopted: true, reason: `evidence supports claim and ${supports}/${votes.length} reviewers concur` };
  }
  if (reasons.length === 0 && !majorityBacks) {
    return { claimId: input.evidence.claimId, adopted: false, reason: `evidence supports the claim but fewer than ${required} reviewers concur; requires human review` };
  }
  return { claimId: input.evidence.claimId, adopted: false, reason: reasons.join('; ') || 'no evidence' };
}
