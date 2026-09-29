/**
 * UTOPIA · Research Institute — research statistics contracts.
 *
 * The frozen vocabularies, thresholds and value shapes the research statistics
 * module and the research experiment battery are built from, expressed as data
 * plus small copy-on-construct factories. Nothing here is a runtime: there is no
 * experiment conductor, no manuscript pipeline and no review council, because a
 * recorded statistic or verdict must be readable on its own, years later,
 * without the machinery that produced it.
 *
 * Ported from the Codex-Boss donor `src/shared/research-statistics.ts` and
 * `src/shared/research-battery.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Both donor files are pure and carry
 * no import at all; every name below — the five research domains, the five
 * terminal statuses, the `READY_GATES` list, the two review/replication
 * vocabularies and every numeric default — is taken verbatim from them.
 *
 * Vocabulary:
 *   researchEvidence()      one experiment's §34 evidence chain, validated and copied
 *   researchOutcomeInput()  one declared outcome: domain, declared status, hypothesis, evidence
 *
 * Validation is the single gate. A factory throws on anything the donor's own
 * TypeScript declared impossible; it never repairs, defaults or clamps a value.
 * `adjudicateResearchOutcome` in `./battery.mjs` deliberately does NOT sit behind
 * these factories: the donor gives it an explicit last branch for an undeclared
 * status, and gating it here would delete that branch.
 */

/** The five research domains of the §33 battery, in donor order. */
export const RESEARCH_DOMAINS = Object.freeze([
  'software-engineering',
  'multi-agent',
  'reliability',
  'writing-evaluation',
  'negative-null-result',
]);

/** The five terminal statuses an experiment may honestly declare, in donor order. */
export const RESEARCH_TERMINAL_STATUSES = Object.freeze([
  'READY',
  'REJECTED',
  'INCONCLUSIVE',
  'INSUFFICIENT_EVIDENCE',
  'REPLICATION_FAILED',
]);

/** The replication outcomes the donor's `ResearchEvidence` allows. */
export const REPLICATION_STATUSES = Object.freeze(['REPRODUCED', 'FAILED', 'NOT_ATTEMPTED']);

/** The review outcomes the donor's `ResearchEvidence` allows. */
export const REVIEW_STATUSES = Object.freeze(['APPROVED', 'VETOED', 'NOT_RUN']);

/**
 * The §34 gates a READY claim must carry, in donor order.
 *
 * The donor declares this list and never reads it; it is carried here unchanged
 * as the frozen name of the artifact chain rather than wired into a rule the
 * donor did not write. Note that neither `replication` nor `review` is a gate.
 */
export const READY_GATES = Object.freeze([
  'protocol',
  'executionEvidence',
  'statistics',
  'claimGraph',
  'citations',
  'manuscript',
  'finalAudit',
]);

/** Normal-approximation z for a 95% confidence interval (`confidenceInterval`). */
export const DEFAULT_CI_Z = 1.96;

/** Default bootstrap seed (`bootstrapCi`). */
export const DEFAULT_BOOTSTRAP_SEED = 42;

/** Default bootstrap resample count (`bootstrapCi`). */
export const DEFAULT_BOOTSTRAP_SAMPLES = 1000;

/** Default bootstrap alpha (`bootstrapCi`). */
export const DEFAULT_BOOTSTRAP_ALPHA = 0.05;

/** Default permutation count (`permutationP`, `oneSamplePermutationP`). */
export const DEFAULT_PERMUTATIONS = 5000;

/** Default seed for the one-sample sign-permutation test. */
export const DEFAULT_ONE_SAMPLE_PERMUTATION_SEED = 11;

/** Default seed for both branches of `permutationP`. */
export const DEFAULT_PERMUTATION_SEED = 7;

function requirePlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function requireVocabulary(value, vocabulary, field) {
  if (!vocabulary.includes(value)) throw new TypeError(`${field} must be one of ${vocabulary.join(', ')}`);
  return value;
}

/** Is this one of the donor's five research domains? */
export function isResearchDomain(value) {
  return RESEARCH_DOMAINS.includes(value);
}

/** Is this one of the donor's five terminal statuses? */
export function isResearchTerminalStatus(value) {
  return RESEARCH_TERMINAL_STATUSES.includes(value);
}

/**
 * Validate one `ResearchEvidence` chain and copy it.
 *
 * The donor declares all nine fields as required on its `ResearchEvidence`
 * interface, so all nine are required here too; `full()` in the donor's own
 * battery supplies every one of them. Field order follows the donor interface.
 *
 * @param {{protocol: boolean, executionEvidence: boolean, replication: string,
 *   statistics: boolean, claimGraph: boolean, citations: boolean, review: string,
 *   manuscript: boolean, finalAudit: boolean}} evidence
 */
export function researchEvidence(evidence) {
  requirePlainObject(evidence, 'evidence');
  return {
    protocol: requireBoolean(evidence.protocol, 'evidence.protocol'),
    executionEvidence: requireBoolean(evidence.executionEvidence, 'evidence.executionEvidence'),
    replication: requireVocabulary(evidence.replication, REPLICATION_STATUSES, 'evidence.replication'),
    statistics: requireBoolean(evidence.statistics, 'evidence.statistics'),
    claimGraph: requireBoolean(evidence.claimGraph, 'evidence.claimGraph'),
    citations: requireBoolean(evidence.citations, 'evidence.citations'),
    review: requireVocabulary(evidence.review, REVIEW_STATUSES, 'evidence.review'),
    manuscript: requireBoolean(evidence.manuscript, 'evidence.manuscript'),
    finalAudit: requireBoolean(evidence.finalAudit, 'evidence.finalAudit'),
  };
}

/**
 * Validate one `ResearchOutcomeInput` and copy it.
 *
 * `hypothesisSupported` is deliberately allowed to be `null`: the donor uses
 * three-valued logic where `null` means "not stated", which is neither supported
 * nor unsupported.
 *
 * @param {{domain: string, declaredStatus: string, hypothesisSupported: boolean|null,
 *   evidence: object}} input
 */
export function researchOutcomeInput(input) {
  requirePlainObject(input, 'input');
  if (input.hypothesisSupported !== null && typeof input.hypothesisSupported !== 'boolean') {
    throw new TypeError('input.hypothesisSupported must be a boolean or null');
  }
  return {
    domain: requireVocabulary(input.domain, RESEARCH_DOMAINS, 'input.domain'),
    declaredStatus: requireVocabulary(input.declaredStatus, RESEARCH_TERMINAL_STATUSES, 'input.declaredStatus'),
    hypothesisSupported: input.hypothesisSupported,
    evidence: researchEvidence(input.evidence),
  };
}
