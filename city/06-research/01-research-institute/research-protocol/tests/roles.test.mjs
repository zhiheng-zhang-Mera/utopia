/**
 * UTOPIA · Research Institute — research role router suite.
 *
 * The stage → role and stage → artifact tables, the typed artifact skeleton and the
 * deterministic epoch default, restated from the Codex-Boss donor
 * `src/shared/research-roles.ts` @ 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEARCH_ARTIFACT_KINDS,
  RESEARCH_ROLE_NAMES,
  RESEARCH_STATES,
  artifactKindForStage,
  roleForStage,
  stageArtifact,
} from '../index.mjs';

/** The donor's STAGE_ROLE table, restated independently of the module. */
const STAGE_ROLE = {
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
};

/** The donor's STAGE_ARTIFACT table, restated independently of the module. */
const STAGE_ARTIFACT = {
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
};

test('every stage routes to the donor role, and only to a declared role', () => {
  assert.equal(Object.keys(STAGE_ROLE).length, RESEARCH_STATES.length);
  for (const stage of RESEARCH_STATES) {
    assert.equal(roleForStage(stage), STAGE_ROLE[stage], `roleForStage(${stage})`);
    assert.ok(RESEARCH_ROLE_NAMES.includes(roleForStage(stage)), `${stage} must route to a declared role`);
  }
  assert.equal(roleForStage('SCOPING'), 'planner');
  assert.equal(roleForStage('PROTOCOL_FROZEN'), 'reviewer');
  assert.equal(roleForStage('FAILED'), 'reviewer');
});

test('every stage expects the donor artifact kind, and only a declared kind', () => {
  assert.equal(Object.keys(STAGE_ARTIFACT).length, RESEARCH_STATES.length);
  for (const stage of RESEARCH_STATES) {
    assert.equal(artifactKindForStage(stage), STAGE_ARTIFACT[stage], `artifactKindForStage(${stage})`);
    assert.ok(RESEARCH_ARTIFACT_KINDS.includes(artifactKindForStage(stage)), `${stage} must expect a declared artifact kind`);
  }
  assert.equal(artifactKindForStage('PROJECT_INSPECTION'), 'repo-scan');
  assert.equal(artifactKindForStage('READY'), 'build-artifact');
});

test('an unknown stage is not rejected here: the donor lookup yields undefined', () => {
  assert.equal(roleForStage('NONSENSE'), undefined);
  assert.equal(artifactKindForStage('NONSENSE'), undefined);
  assert.equal(roleForStage(undefined), undefined);
  assert.equal(artifactKindForStage(null), undefined);
});

test('a stage artifact is a typed skeleton with a deterministic id', () => {
  const now = '2026-09-29T12:34:56.789Z';
  assert.deepEqual(stageArtifact({ stage: 'ANALYSIS', summary: 'paired t-test on accuracy' }, now), {
    kind: 'statistic',
    stage: 'ANALYSIS',
    role: 'analyst',
    artifactId: 'analysis:2026-09-29T12-34-56-789Z',
    summary: 'paired t-test on accuracy',
    evidenceRefs: [],
    createdAt: now,
  });
  assert.deepEqual(stageArtifact({ stage: 'CLAIM_REVIEW', summary: 'claim', evidenceRefs: ['evidence:claim-1'] }, now).evidenceRefs, ['evidence:claim-1']);
  assert.equal(stageArtifact({ stage: 'MANUSCRIPT', summary: 'x' }, now).kind, 'manuscript-section');
});

test('the clock is an injected parameter and its default is the deterministic epoch', () => {
  const artifact = stageArtifact({ stage: 'SCOPING', summary: 'scope the run' });
  assert.equal(artifact.createdAt, '1970-01-01T00:00:00.000Z');
  assert.equal(artifact.artifactId, 'scoping:1970-01-01T00-00-00-000Z');
  assert.deepEqual(stageArtifact({ stage: 'SCOPING', summary: 'scope the run' }), artifact, 'the default is deterministic');
});

test('the summary is truncated to 500 characters and the payload is copied', () => {
  const long = 's'.repeat(600);
  assert.equal(stageArtifact({ stage: 'BUILD', summary: long }, '2026-09-29T00:00:00.000Z').summary.length, 500);
  assert.equal(stageArtifact({ stage: 'BUILD', summary: 'x'.repeat(500) }, '2026-09-29T00:00:00.000Z').summary.length, 500);
  const refs = ['evidence:a'];
  const built = stageArtifact({ stage: 'BUILD', summary: 'built', evidenceRefs: refs }, '2026-09-29T00:00:00.000Z');
  assert.deepEqual(built.evidenceRefs, refs);
});
