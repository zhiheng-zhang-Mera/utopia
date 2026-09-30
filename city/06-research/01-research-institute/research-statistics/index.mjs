/**
 * UTOPIA · Research Institute — research statistics, one export site.
 *
 * Import from here: the deterministic statistics, the §33 experiment battery and
 * the frozen contracts they share. There is no runtime beneath them — no task
 * scheduler, no experiment conductor, no manuscript pipeline, no review council
 * — because a recorded number or verdict has to stay readable without the
 * machinery that produced it.
 *
 * Ported from the Codex-Boss donor `src/shared/research-statistics.ts` and
 * `src/shared/research-battery.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The donor's two file boundaries are
 * kept as `./statistics.mjs` and `./battery.mjs`; the frozen vocabularies,
 * thresholds and validated value shapes live in `./contracts.mjs`.
 */

export {
  DEFAULT_BOOTSTRAP_ALPHA,
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_CI_Z,
  DEFAULT_ONE_SAMPLE_PERMUTATION_SEED,
  DEFAULT_PERMUTATIONS,
  DEFAULT_PERMUTATION_SEED,
  READY_GATES,
  REPLICATION_STATUSES,
  RESEARCH_DOMAINS,
  RESEARCH_TERMINAL_STATUSES,
  REVIEW_STATUSES,
  isResearchDomain,
  isResearchTerminalStatus,
  researchEvidence,
  researchOutcomeInput,
} from './contracts.mjs';

export {
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
} from './statistics.mjs';

export { adjudicateResearchOutcome, buildResearchBattery, runResearchBattery } from './battery.mjs';
