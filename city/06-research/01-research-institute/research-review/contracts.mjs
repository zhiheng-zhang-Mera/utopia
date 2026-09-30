/**
 * UTOPIA · Research Institute — research review contracts.
 *
 * The frozen vocabularies, the thresholds and the value shapes the review,
 * adjudication, A/B-level and capability-registry rules are stated in, plus the
 * strict validators that gate them. Nothing here reads a clock, a file, the
 * network or the environment: a constructed value is a fresh copy, and a factory
 * never repairs the input it is given.
 *
 * Ported from the Codex-Boss donor files `src/shared/research-review.ts`,
 * `src/shared/research-adjudicate.ts`, `src/shared/research-levela.ts`,
 * `src/shared/research-levelb.ts` and
 * `src/shared/research-capability-registry.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * Value shapes:
 *   ReviewObjection        one structured objection (role, issue, severity, sections)
 *   ReviewResponse         one reply to an objection, optionally retaining it
 *   ReviewRound            a round: its objections and the responses to them
 *   PublicationState       the four gates PUBLICATION mode requires
 *   ReviewerVote           one reviewer's stance on one claim
 *   ClaimEvidence          the deterministic evidence bound to one claim
 *   CandidateQuestion      one proposed research question and its properties
 *   ProjectSignals         the bounded repo facts a Level-A review reads
 *   ExperimentSpec         the deterministic experiment a Level-A plan proposes
 *   ResearchStudyProfile   the coarse study shape the capability planner matches
 *
 * The donor's result shapes (`NoveltyReview`, `QuestionSelection`,
 * `AdjudicationVerdict`) are produced by the behaviour modules, not constructed
 * here.
 *
 * The factories enforce the *declared* shape: field types, the frozen
 * vocabularies, and — where the donor itself enforces them — emptiness and length
 * limits. They copy every array and object, so a caller cannot mutate a value it
 * handed over. The donor's decision functions do not route caller input through
 * these factories; the only two shape checks the donor runs are
 * `validateCandidateQuestion` and `validateLevelAPlan`, and those are reproduced
 * below with the donor's exact messages and check order.
 */

/** Review roles, in the order the donor declares them. */
export const REVIEW_ROLES = Object.freeze(['METHOD', 'EVIDENCE', 'CLAIM', 'WRITING', 'REPRODUCIBILITY', 'META']);

/** The two objection severities. */
export const REVIEW_SEVERITIES = Object.freeze(['major', 'minor']);

/** The two meta-review verdicts. */
export const REVIEW_VERDICTS = Object.freeze(['APPROVED', 'REVISE']);

/** The two reviewer stances the adjudicator counts. */
export const REVIEW_STANCES = Object.freeze(['supports', 'opposes']);

/** The primary metrics an experiment spec may compute. */
export const PRIMARY_METRICS = Object.freeze(['mean', 'proportion', 'effect-size', 'rate']);

/** The purposes an experiment spec may declare. */
export const EXPERIMENT_PURPOSES = Object.freeze(['EXPERIMENT', 'DATA_PROCESSING']);

/** Capability statuses, in the order the donor declares them. */
export const RESEARCH_CAPABILITY_STATUSES = Object.freeze(['AVAILABLE', 'NEEDED', 'NOT_NEEDED', 'FAILED']);

/** Capability ids, in the order the donor declares them (also the plan key order). */
export const RESEARCH_CAPABILITY_IDS = Object.freeze([
  'literature-scout',
  'citation-verifier',
  'methodology-critic',
  'experiment-designer',
  'statistics-engine',
  'replication-runner',
  'figure-planner',
  'chart-renderer',
  'table-builder',
  'architecture-diagram-builder',
  'evidence-adjudicator',
  'section-planner',
  'section-writer',
  'skeptical-reviewer',
  'reproducibility-auditor',
  'latex-compiler',
]);

/** The capability registry rows: id, bilingual-safe label, and its trigger. */
export const RESEARCH_CAPABILITIES = Object.freeze(
  [
    { id: 'literature-scout', label: '检索并获取相关文献', neededWhen: 'contextual literature is part of the study' },
    { id: 'citation-verifier', label: '核对引用来源与原文支持', neededWhen: 'citations are bound to the paper' },
    { id: 'methodology-critic', label: '审阅方法论设计缺陷', neededWhen: 'a formal protocol/methodology is drafted' },
    { id: 'experiment-designer', label: '设计真实实验方案', neededWhen: 'study requires controlled experiments' },
    { id: 'statistics-engine', label: '对记录数据做确定性统计', neededWhen: 'quantitative experiment runs exist' },
    { id: 'replication-runner', label: '以独立种子复跑验证', neededWhen: 'quantitative finding must be reproducible' },
    { id: 'figure-planner', label: '规划结果图', neededWhen: 'quantitative results need visual evidence' },
    { id: 'chart-renderer', label: '将记录指标渲染为图', neededWhen: 'quantitative results need a figure' },
    { id: 'table-builder', label: '构建结果表', neededWhen: 'multi-metric or grouped results need a table' },
    { id: 'architecture-diagram-builder', label: '构建架构/流程示意图', neededWhen: 'study presents a system/architecture to explain' },
    { id: 'evidence-adjudicator', label: '裁决证据>投票的 claim', neededWhen: 'multiple reviewers/claims need adjudication' },
    { id: 'section-planner', label: '规划论文章节结构', neededWhen: 'a manuscript is being assembled' },
    { id: 'section-writer', label: '撰写论文各章节', neededWhen: 'manuscript sections must be drafted' },
    { id: 'skeptical-reviewer', label: '对抗性审阅论文', neededWhen: 'manuscript draft is complete' },
    { id: 'reproducibility-auditor', label: '审计复现性', neededWhen: 'recorded runs should reproduce the finding' },
    { id: 'latex-compiler', label: '编译 TEX→PDF', neededWhen: 'a compiled PDF deliverable is required' },
  ].map((row) => Object.freeze(row)),
);

/** Level-A gate: novelty and feasibility must both reach this score. */
export const LEVEL_A_MIN_SCORE = 2;

/** Both Level-A scores are clamped into [SCORE_MIN, SCORE_MAX]. */
export const SCORE_MIN = 0;
export const SCORE_MAX = 5;

/** Novelty review weights, exactly as the donor's arithmetic states them. */
export const NOVELTY_OVERLAP_CREDIT = 3;
export const NOVELTY_SCORE_WEIGHT = 0.5;
export const NOVELTY_OVERLAP_PENALTY = 1;
export const FALSIFIABLE_FEASIBILITY_BONUS = 2;
export const NO_HARNESS_FEASIBILITY_PENALTY = 1;

/** Replication runs are clamped into [REPLICATION_RUNS_MIN, REPLICATION_RUNS_MAX]. */
export const REPLICATION_RUNS_MIN = 2;
export const REPLICATION_RUNS_MAX = 10;
export const DEFAULT_REPLICATION_RUNS = 3;

/** The seed a spec carries when none is given. */
export const DEFAULT_SEED = 42;

/** Reviewers who must concur before evidence-backed adoption. */
export const DEFAULT_REQUIRED_VOTES = 1;

/** Longest question / hypothesis the donor's validators accept (exclusive upper bound). */
export const MAX_TEXT_LENGTH = 2000;

/**
 * The deterministic timestamp a fresh experiment spec carries when no clock is
 * injected. The donor defaulted `createdAt` to the live clock
 * (`new Date().toISOString()`); this module is pure, so the clock is an injected
 * `now` option and this epoch sentinel is its default.
 */
export const EPOCH_TIMESTAMP = new Date(0).toISOString();

function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value;
}

/** A non-empty, trimmed string — used only where the donor itself requires one. */
function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function requireOneOf(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new TypeError(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

function requireStringArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((entry) => requireString(entry, `${field}[]`));
}

function requireOptionalBoolean(value, field) {
  return value === undefined ? undefined : requireBoolean(value, field);
}

/** One structured objection. */
export function reviewObjection(row) {
  requireObject(row, 'objection');
  return {
    id: requireString(row.id, 'objection.id'),
    role: requireOneOf(row.role, REVIEW_ROLES, 'objection.role'),
    issue: requireString(row.issue, 'objection.issue'),
    severity: requireOneOf(row.severity, REVIEW_SEVERITIES, 'objection.severity'),
    revisedSections: requireStringArray(row.revisedSections, 'objection.revisedSections'),
  };
}

/** One response to an objection. `retainedReason` is absent unless the caller gave a string. */
export function reviewResponse(row) {
  requireObject(row, 'response');
  const response = {
    objectionId: requireString(row.objectionId, 'response.objectionId'),
    reply: requireString(row.reply, 'response.reply'),
    revisedSections: requireStringArray(row.revisedSections, 'response.revisedSections'),
  };
  if (row.retainedReason !== undefined) response.retainedReason = requireString(row.retainedReason, 'response.retainedReason');
  return response;
}

/** One review round: objections plus the responses recorded against them. */
export function reviewRound(row) {
  requireObject(row, 'round');
  if (!Array.isArray(row.objections)) throw new TypeError('round.objections must be an array');
  if (!Array.isArray(row.responses)) throw new TypeError('round.responses must be an array');
  return {
    roundId: requireString(row.roundId, 'round.roundId'),
    objections: row.objections.map((objection) => reviewObjection(objection)),
    responses: row.responses.map((response) => reviewResponse(response)),
  };
}

/** The four gates PUBLICATION mode requires. */
export function publicationState(row) {
  requireObject(row, 'state');
  return {
    contractPresent: requireBoolean(row.contractPresent, 'state.contractPresent'),
    sufficiencyPassed: requireBoolean(row.sufficiencyPassed, 'state.sufficiencyPassed'),
    reviewSettled: requireBoolean(row.reviewSettled, 'state.reviewSettled'),
    metaApproved: requireBoolean(row.metaApproved, 'state.metaApproved'),
  };
}

/** One reviewer's stance on one claim. */
export function reviewerVote(row) {
  requireObject(row, 'vote');
  return {
    reviewerId: requireString(row.reviewerId, 'vote.reviewerId'),
    claimId: requireString(row.claimId, 'vote.claimId'),
    stance: requireOneOf(row.stance, REVIEW_STANCES, 'vote.stance'),
  };
}

/**
 * The evidence bound to one claim. `verifiedCitations` is declared by the donor's
 * `ClaimEvidence` and is never read by the adjudicator; it is carried verbatim.
 */
export function claimEvidence(row) {
  requireObject(row, 'evidence');
  return {
    claimId: requireString(row.claimId, 'evidence.claimId'),
    statisticSupported: requireBoolean(row.statisticSupported, 'evidence.statisticSupported'),
    independentReplication: requireBoolean(row.independentReplication, 'evidence.independentReplication'),
    verifiedCitations: requireNumber(row.verifiedCitations, 'evidence.verifiedCitations'),
  };
}

/** One proposed research question, gated exactly as the donor gates it. */
export function candidateQuestion(row) {
  requireObject(row, 'candidate');
  const candidate = {
    id: requireText(row.id, 'candidate.id'),
    question: requireText(row.question, 'candidate.question'),
    measurable: requireBoolean(row.measurable, 'candidate.measurable'),
    falsifiable: requireBoolean(row.falsifiable, 'candidate.falsifiable'),
    proposedBy: requireText(row.proposedBy, 'candidate.proposedBy'),
  };
  if (candidate.question.length > MAX_TEXT_LENGTH) throw new TypeError(`candidate.question must be at most ${MAX_TEXT_LENGTH} characters`);
  if (row.hypothesis !== undefined) candidate.hypothesis = requireString(row.hypothesis, 'candidate.hypothesis');
  if (row.noveltyScore !== undefined) candidate.noveltyScore = requireNumber(row.noveltyScore, 'candidate.noveltyScore');
  if (row.feasibilityScore !== undefined) candidate.feasibilityScore = requireNumber(row.feasibilityScore, 'candidate.feasibilityScore');
  return candidate;
}

/** The bounded repo facts a Level-A review reads. */
export function projectSignals(row) {
  requireObject(row, 'signals');
  return {
    files: requireNumber(row.files, 'signals.files'),
    testFiles: requireNumber(row.testFiles, 'signals.testFiles'),
    languages: requireStringArray(row.languages, 'signals.languages'),
    topModules: requireStringArray(row.topModules, 'signals.topModules'),
  };
}

/** The deterministic experiment a Level-A plan proposes. */
export function experimentSpec(row) {
  requireObject(row, 'experiment');
  return {
    id: requireText(row.id, 'experiment.id'),
    primaryMetric: requireOneOf(row.primaryMetric, PRIMARY_METRICS, 'experiment.primaryMetric'),
    replicationRuns: requireNumber(row.replicationRuns, 'experiment.replicationRuns'),
    purpose: requireOneOf(row.purpose, EXPERIMENT_PURPOSES, 'experiment.purpose'),
    command: requireStringArray(row.command, 'experiment.command'),
    seed: requireNumber(row.seed, 'experiment.seed'),
    createdAt: requireString(row.createdAt, 'experiment.createdAt'),
  };
}

/** The coarse study shape the capability planner matches against. */
export function researchStudyProfile(row) {
  requireObject(row, 'profile');
  const profile = {
    hasQuantitativeExperiments: requireBoolean(row.hasQuantitativeExperiments, 'profile.hasQuantitativeExperiments'),
    bindsCitations: requireBoolean(row.bindsCitations, 'profile.bindsCitations'),
    hasFormalProtocol: requireBoolean(row.hasFormalProtocol, 'profile.hasFormalProtocol'),
  };
  const hasArchitecture = requireOptionalBoolean(row.hasArchitecture, 'profile.hasArchitecture');
  if (hasArchitecture !== undefined) profile.hasArchitecture = hasArchitecture;
  const hasMultipleReviewers = requireOptionalBoolean(row.hasMultipleReviewers, 'profile.hasMultipleReviewers');
  if (hasMultipleReviewers !== undefined) profile.hasMultipleReviewers = hasMultipleReviewers;
  return profile;
}

/**
 * The donor's candidate-question check, with its exact messages and order.
 * @throws {Error} `Candidate requires an id` | `Candidate question invalid` |
 *   `Candidate requires a proposer`
 */
export function validateCandidateQuestion(candidate) {
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id) throw new Error('Candidate requires an id');
  if (typeof candidate.question !== 'string' || !candidate.question.trim() || candidate.question.length > MAX_TEXT_LENGTH) throw new Error('Candidate question invalid');
  if (typeof candidate.proposedBy !== 'string' || !candidate.proposedBy.trim()) throw new Error('Candidate requires a proposer');
}

/**
 * The donor's Level-A plan check, with its exact messages and order. It checks the
 * hypothesis, the experiment id, the replication floor and the primary metric, and
 * nothing else — as in the donor, the selected question and the novelty review are
 * not re-checked, and a missing `replicationRuns` is not a failure
 * (`undefined < 2` is false).
 * @throws {Error} `Level-A plan requires a hypothesis` |
 *   `Level-A plan requires an experiment` |
 *   `Primary finding requires >= 2 replication runs` | `Invalid primary metric`
 */
export function validateLevelAPlan(plan) {
  if (!plan || typeof plan.hypothesis !== 'string' || !plan.hypothesis.trim() || plan.hypothesis.length > MAX_TEXT_LENGTH) throw new Error('Level-A plan requires a hypothesis');
  if (!plan.experiment || typeof plan.experiment.id !== 'string' || !plan.experiment.id) throw new Error('Level-A plan requires an experiment');
  if (plan.experiment.replicationRuns < REPLICATION_RUNS_MIN) throw new Error('Primary finding requires >= 2 replication runs');
  if (!PRIMARY_METRICS.includes(plan.experiment.primaryMetric)) throw new Error('Invalid primary metric');
}

/** Is this a capability status? Anything else is refused, never coerced. */
export function isResearchCapabilityStatus(value) {
  return typeof value === 'string' && RESEARCH_CAPABILITY_STATUSES.includes(value);
}
