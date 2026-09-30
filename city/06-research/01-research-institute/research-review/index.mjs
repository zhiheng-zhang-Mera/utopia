/**
 * UTOPIA · Research Institute — research review, one export site.
 *
 * The complete public surface of the module: the frozen vocabularies, thresholds
 * and value-shape factories from `./contracts.mjs`, the cross-review loop
 * (`./review.mjs`), evidence-over-vote adjudication (`./adjudicate.mjs`), the A/B
 * research levels (`./levela.mjs` -> `./levelb.mjs`) and the research capability
 * registry (`./capability-registry.mjs`).
 *
 * Every file names its Codex-Boss donor and the frozen commit
 * 8df428eaa437a409368401e95194e40266b83080. The module is pure: no filesystem, no
 * network, no clock, no randomness, no environment. The only cross-file value edge
 * inside the behaviour modules is `levela.mjs` importing `isFalsifiable` from
 * `levelb.mjs`, exactly as the donor had it.
 *
 * Nothing here re-implements or wraps the evidence engine: claim statuses, artifact
 * hashing and PASS/HOLD decisions stay in the sibling `evidence-engine` module.
 */

export {
  // frozen vocabularies
  REVIEW_ROLES,
  REVIEW_SEVERITIES,
  REVIEW_VERDICTS,
  REVIEW_STANCES,
  PRIMARY_METRICS,
  EXPERIMENT_PURPOSES,
  RESEARCH_CAPABILITY_STATUSES,
  RESEARCH_CAPABILITY_IDS,
  RESEARCH_CAPABILITIES,
  // thresholds
  LEVEL_A_MIN_SCORE,
  SCORE_MIN,
  SCORE_MAX,
  NOVELTY_OVERLAP_CREDIT,
  NOVELTY_SCORE_WEIGHT,
  NOVELTY_OVERLAP_PENALTY,
  FALSIFIABLE_FEASIBILITY_BONUS,
  NO_HARNESS_FEASIBILITY_PENALTY,
  REPLICATION_RUNS_MIN,
  REPLICATION_RUNS_MAX,
  DEFAULT_REPLICATION_RUNS,
  DEFAULT_SEED,
  DEFAULT_REQUIRED_VOTES,
  MAX_TEXT_LENGTH,
  EPOCH_TIMESTAMP,
  // value-shape factories (copy-on-construct)
  reviewObjection,
  reviewResponse,
  reviewRound,
  publicationState,
  reviewerVote,
  claimEvidence,
  candidateQuestion,
  projectSignals,
  experimentSpec,
  researchStudyProfile,
  // strict validators
  validateCandidateQuestion,
  validateLevelAPlan,
  isResearchCapabilityStatus,
} from './contracts.mjs';

export { respondToObjections, reviewRoundSettled, metaReview, publicationReady } from './review.mjs';

export { adjudicateClaim } from './adjudicate.mjs';

export { noveltyReview, levelAGate, buildExperimentSpec } from './levela.mjs';

export { isFalsifiable, selectFalsifiableQuestion } from './levelb.mjs';

export { planResearchCapabilities } from './capability-registry.mjs';
