/**
 * UTOPIA · Research Institute — research role router + typed stage artifacts.
 *
 * Every research stage routes to a research role and is expected to produce a typed
 * artifact (never prose-only output). The mapping is deterministic — no model is
 * needed to answer "which role owns this stage".
 *
 * Ported from the Codex-Boss donor `src/shared/research-roles.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The donor's type-only import of
 * `ResearchState` from `research-ir.ts` becomes an import of the frozen state
 * vocabulary from `contracts.mjs`, so the router and the state machine cannot drift
 * apart.
 *
 * Rules that must not be softened:
 *   - STAGE_ROLE and STAGE_ARTIFACT cover every state, control states included;
 *   - an unknown stage is NOT rejected here: the donor's record lookup yields
 *     `undefined`, and inventing a refusal would change a verdict the donor accepts;
 *   - `now` is a parameter, not a clock read. The donor's `new Date(0).toISOString()`
 *     epoch default is deterministic and is kept verbatim; the artifact id is derived
 *     from `now` with `[:.]` replaced by `-`, and the summary is truncated to 500.
 */

import { RESEARCH_ARTIFACT_KINDS, RESEARCH_ROLE_NAMES, RESEARCH_STATES } from './contracts.mjs';

export { RESEARCH_ARTIFACT_KINDS, RESEARCH_ROLE_NAMES, RESEARCH_STATES };

/** Stage → owning role (deterministic; mirrors the supervisor's autopilot flow). */
const STAGE_ROLE = Object.freeze({
  SCOPING: 'planner',
  PROJECT_INSPECTION: 'coder',
  LITERATURE_REVIEW: 'literature',
  QUESTION_FORMULATION: 'planner',
  PROTOCOL_DRAFT: 'planner',
  PROTOCOL_FROZEN: 'reviewer',
  EXPERIMENT_GENERATION: 'experiment',
  EXPERIMENT_EXECUTION: 'coder',
  ANALYSIS: 'analyst',
  REPLICATION: 'analyst',
  CLAIM_REVIEW: 'reviewer',
  MANUSCRIPT: 'reporter',
  CITATION_AUDIT: 'reviewer',
  REPRO_AUDIT: 'reviewer',
  BUILD: 'reporter',
  READY: 'reporter',
  RECOVERING: 'planner',
  WAITING_FOR_PROVIDER: 'reviewer',
  WAITING_FOR_USER: 'reviewer',
  FAILED: 'reviewer',
});

/** Stage → expected typed artifact kind. */
const STAGE_ARTIFACT = Object.freeze({
  SCOPING: 'research-question',
  PROJECT_INSPECTION: 'repo-scan',
  LITERATURE_REVIEW: 'literature-notes',
  QUESTION_FORMULATION: 'research-question',
  PROTOCOL_DRAFT: 'protocol',
  PROTOCOL_FROZEN: 'protocol',
  EXPERIMENT_GENERATION: 'experiment-design',
  EXPERIMENT_EXECUTION: 'experiment-run',
  ANALYSIS: 'statistic',
  REPLICATION: 'analysis',
  CLAIM_REVIEW: 'claim',
  MANUSCRIPT: 'manuscript-section',
  CITATION_AUDIT: 'citation-audit',
  REPRO_AUDIT: 'repro-audit',
  BUILD: 'build-artifact',
  READY: 'build-artifact',
  RECOVERING: 'research-question',
  WAITING_FOR_PROVIDER: 'claim',
  WAITING_FOR_USER: 'claim',
  FAILED: 'claim',
});

export function roleForStage(stage) {
  return STAGE_ROLE[stage];
}

export function artifactKindForStage(stage) {
  return STAGE_ARTIFACT[stage];
}

/** Builds a typed artifact skeleton for a stage (caller fills typed payloads). */
export function stageArtifact(input, now = new Date(0).toISOString()) {
  const kind = artifactKindForStage(input.stage);
  const role = roleForStage(input.stage);
  return {
    kind,
    stage: input.stage,
    role,
    artifactId: `${input.stage.toLowerCase()}:${now.replace(/[:.]/g, '-')}`,
    summary: input.summary.slice(0, 500),
    evidenceRefs: input.evidenceRefs ?? [],
    createdAt: now,
  };
}
