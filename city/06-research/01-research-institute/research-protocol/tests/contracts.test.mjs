/**
 * UTOPIA · Research Institute — research protocol contracts suite.
 *
 * The vocabularies' members and order, the frozen arrays, and every validation
 * refusal with the donor's exact message, restated from the Codex-Boss donor
 * `src/shared/research-ir.ts`, `research-protocol.ts`, `research-contract.ts`,
 * `research-roles.ts` and `research-command.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ALLOWED_EXECUTABLES,
  AUTO_FIXABLE_FIELDS,
  AUTONOMY_MODES,
  BASELINE_PROVENANCE_KINDS,
  CITATION_POLICIES,
  DECLARABLE_BASELINE_SOURCES,
  FROZEN_FIELDS,
  PROVIDER_POLICIES,
  RESEARCH_ARTIFACT_KINDS,
  RESEARCH_CONTROL_STATES,
  RESEARCH_MAIN_STATES,
  RESEARCH_PURPOSES,
  RESEARCH_ROLE_NAMES,
  RESEARCH_STATES,
  protocolAmendment,
  researchBudget,
  researchCommandSpec,
  researchContract,
  researchIR,
  researchProtocol,
  researchScope,
} from '../index.mjs';

/** Run a refusal and return its message, so the donor's exact text is asserted. */
function refusal(run) {
  try {
    run();
  } catch (error) {
    return error.message;
  }
  return null;
}

const validBudget = () => ({ maxExperiments: 2, maxSteps: 10 });
const validScope = () => ({ workspace: '/work', allowedDomains: ['arxiv.org'], reviewers: ['reviewer-a'], autonomy: 'GUIDED', budget: validBudget() });
const validIR = () => ({
  schemaVersion: 1,
  id: 'run-1',
  goal: 'decide whether X beats Y',
  scope: validScope(),
  state: 'SCOPING',
  researchQuestions: ['q1'],
  hypotheses: ['h1'],
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
});
const validProtocol = () => ({
  schemaVersion: 1,
  hypothesis: 'X beats Y',
  primaryMetric: 'accuracy',
  baseline: '0.5',
  sampleDefinition: 'all items',
  evaluationCriterion: 'accuracy > 0.5',
  createdAt: '2026-09-29T00:00:00.000Z',
});
const validContract = () => ({
  researchQuestion: 'does X beat Y',
  hypotheses: ['h1'],
  claims: [{ id: 'claim-1', statement: 'X beats Y', evidenceRequirement: 'accuracy above 0.5' }],
  experimentPlan: { runsPerHypothesis: 2, metric: 'accuracy', baseline: '0.5' },
  evaluationCriterion: 'accuracy > 0.5',
  citationPolicy: 'strict-verbatim',
  sections: ['Methods', 'Results'],
  acceptanceGates: ['reviews done'],
  frozenAt: '2026-09-29T00:00:00.000Z',
});
const validSpec = () => ({ executable: 'python', args: ['run.py'], cwd: '/work', purpose: 'EXPERIMENT', timeoutMs: 60000 });

test('the frozen vocabularies keep the donor members and order', () => {
  assert.deepEqual(RESEARCH_MAIN_STATES, [
    'SCOPING', 'PROJECT_INSPECTION', 'LITERATURE_REVIEW', 'QUESTION_FORMULATION',
    'PROTOCOL_DRAFT', 'PROTOCOL_FROZEN', 'EXPERIMENT_GENERATION', 'EXPERIMENT_EXECUTION',
    'ANALYSIS', 'REPLICATION', 'CLAIM_REVIEW', 'MANUSCRIPT', 'CITATION_AUDIT', 'REPRO_AUDIT', 'BUILD', 'READY',
  ]);
  assert.deepEqual(RESEARCH_CONTROL_STATES, ['RECOVERING', 'WAITING_FOR_PROVIDER', 'WAITING_FOR_USER', 'FAILED']);
  assert.deepEqual(RESEARCH_STATES, [...RESEARCH_MAIN_STATES, ...RESEARCH_CONTROL_STATES]);
  assert.deepEqual(AUTONOMY_MODES, ['AUTOPILOT', 'GUIDED']);
  assert.deepEqual(PROVIDER_POLICIES, ['AUTO', 'FIXED']);
  assert.deepEqual(AUTO_FIXABLE_FIELDS, ['syntax', 'path', 'environment', 'package', 'runtime-error']);
  assert.deepEqual(FROZEN_FIELDS, ['hypothesis', 'primary-metric', 'baseline', 'sample-definition', 'exclusion-rule', 'evaluation-criterion']);
  assert.deepEqual(BASELINE_PROVENANCE_KINDS, [
    'known-benchmark', 'control-implementation', 'random-chance',
    'previous-system', 'ablation', 'literature', 'implementation-declared', 'host-heuristic',
  ]);
  assert.deepEqual(DECLARABLE_BASELINE_SOURCES, [
    'known-benchmark', 'control-implementation', 'random-chance',
    'previous-system', 'ablation', 'literature', 'implementation-declared',
  ]);
  assert.deepEqual(CITATION_POLICIES, ['strict-verbatim', 'strict-summary', 'manual']);
  assert.deepEqual(RESEARCH_ROLE_NAMES, ['literature', 'planner', 'experiment', 'coder', 'analyst', 'reviewer', 'reporter']);
  assert.deepEqual(RESEARCH_ARTIFACT_KINDS, [
    'repo-scan', 'literature-notes', 'research-question', 'protocol', 'experiment-design',
    'experiment-run', 'statistic', 'analysis', 'claim', 'manuscript-section', 'citation-audit',
    'repro-audit', 'build-artifact',
  ]);
  assert.deepEqual(RESEARCH_PURPOSES, ['EXPERIMENT', 'ANALYSIS', 'TEST', 'BUILD', 'DATA_PROCESSING']);
  assert.deepEqual(ALLOWED_EXECUTABLES, ['python', 'python3', 'py', 'node', 'npm', 'pnpm', 'git', 'pytest', 'tsx', 'npx', 'electron']);
});

test('every vocabulary array is frozen', () => {
  const vocabularies = {
    RESEARCH_MAIN_STATES,
    RESEARCH_CONTROL_STATES,
    RESEARCH_STATES,
    AUTONOMY_MODES,
    PROVIDER_POLICIES,
    AUTO_FIXABLE_FIELDS,
    FROZEN_FIELDS,
    BASELINE_PROVENANCE_KINDS,
    DECLARABLE_BASELINE_SOURCES,
    CITATION_POLICIES,
    RESEARCH_ROLE_NAMES,
    RESEARCH_ARTIFACT_KINDS,
    RESEARCH_PURPOSES,
    ALLOWED_EXECUTABLES,
  };
  for (const [name, value] of Object.entries(vocabularies)) {
    assert.ok(Object.isFrozen(value), `${name} must be frozen`);
    assert.throws(() => {
      value.push('SMUGGLED');
    }, TypeError, `${name} must refuse a push`);
  }
});

test('the research budget and scope factories copy and refuse with the donor messages', () => {
  assert.deepEqual(researchBudget({ maxExperiments: 1, maxSteps: 1 }), { maxExperiments: 1, maxSteps: 1 });
  assert.deepEqual(
    researchBudget({ maxExperiments: 3, maxSteps: 20, maxProviderCalls: 5, maxRuntimeMinutes: 60 }),
    { maxExperiments: 3, maxSteps: 20, maxProviderCalls: 5, maxRuntimeMinutes: 60 },
  );

  assert.equal(refusal(() => researchBudget(undefined)), 'Invalid research budget');
  assert.equal(refusal(() => researchBudget({ maxExperiments: 0, maxSteps: 1 })), 'Invalid research budget');
  assert.equal(refusal(() => researchBudget({ maxExperiments: 1, maxSteps: 0 })), 'Invalid research budget');
  assert.equal(refusal(() => researchBudget({ maxExperiments: 1.5, maxSteps: 1 })), 'Invalid research budget');
  assert.equal(refusal(() => researchBudget({ maxExperiments: 1, maxSteps: '2' })), 'Invalid research budget');

  const scope = validScope();
  const copied = researchScope(scope);
  assert.deepEqual(copied, scope);
  assert.notEqual(copied, scope, 'the scope is copied, never shared');
  assert.notEqual(copied.allowedDomains, scope.allowedDomains);
  assert.notEqual(copied.reviewers, scope.reviewers);
  assert.deepEqual(researchScope({ ...scope, providerPolicy: 'FIXED' }).providerPolicy, 'FIXED');

  assert.equal(refusal(() => researchScope(undefined)), 'Research requires a workspace');
  assert.equal(refusal(() => researchScope({ ...scope, workspace: '   ' })), 'Research requires a workspace');
  assert.equal(refusal(() => researchScope({ ...scope, allowedDomains: null })), 'Invalid allowedDomains');
  assert.equal(refusal(() => researchScope({ ...scope, allowedDomains: Array.from({ length: 51 }, () => 'd') })), 'Invalid allowedDomains');
  assert.equal(refusal(() => researchScope({ ...scope, reviewers: [] })), 'Research requires 1–5 reviewers');
  assert.equal(refusal(() => researchScope({ ...scope, reviewers: ['a', 'b', 'c', 'd', 'e', 'f'] })), 'Research requires 1–5 reviewers');
  assert.equal(refusal(() => researchScope({ ...scope, autonomy: 'SOLO' })), 'Invalid autonomy mode');
  assert.equal(refusal(() => researchScope({ ...scope, budget: { maxExperiments: 0, maxSteps: 1 } })), 'Invalid research budget');
});

test('the research IR factory keeps the donor validation order and messages', () => {
  const ir = validIR();
  const copied = researchIR(ir);
  assert.equal(copied.schemaVersion, 1);
  assert.equal(copied.id, 'run-1');
  assert.deepEqual(copied.researchQuestions, ['q1']);
  assert.deepEqual(copied.hypotheses, ['h1']);
  assert.equal(copied.createdAt, '2026-09-29T00:00:00.000Z');
  assert.equal(copied.updatedAt, '2026-09-29T00:00:00.000Z');
  assert.notEqual(copied, ir);
  assert.notEqual(copied.scope, ir.scope);
  assert.deepEqual(copied.scope, ir.scope);
  assert.equal('pendingStage' in copied, false, 'an absent optional field stays absent');
  assert.equal('protocolHash' in copied, false);
  assert.deepEqual(researchIR({ ...ir, researchQuestions: undefined }).researchQuestions, [], 'a missing list becomes an empty list');
  assert.deepEqual(researchIR({ ...ir, hypotheses: 'nope' }).hypotheses, []);

  assert.equal(refusal(() => researchIR(undefined)), 'Invalid research IR id');
  assert.equal(refusal(() => researchIR({ ...ir, schemaVersion: 2 })), 'Invalid research IR id');
  assert.equal(refusal(() => researchIR({ ...ir, id: '  ' })), 'Invalid research IR id');
  assert.equal(refusal(() => researchIR({ ...ir, goal: '' })), 'Research goal must be 1–20000 characters');
  assert.equal(refusal(() => researchIR({ ...ir, goal: 'x'.repeat(20001) })), 'Research goal must be 1–20000 characters');
  assert.equal(refusal(() => researchIR({ ...ir, goal: 'x'.repeat(20000) })), null, 'exactly 20000 characters is accepted');
  assert.equal(refusal(() => researchIR({ ...ir, scope: { ...validScope(), workspace: '' } })), 'Research requires a workspace');
  assert.equal(refusal(() => researchIR({ ...ir, state: 'DONE' })), 'Invalid research state');
  assert.equal(refusal(() => researchIR({ ...ir, state: 'WAITING_FOR_USER' })), null, 'a control state is a valid state');
  assert.equal(refusal(() => researchIR({ ...ir, pendingStage: 'FAILED' })), 'Invalid pending research stage');
  assert.equal(refusal(() => researchIR({ ...ir, pendingStage: 'RECOVERING' })), 'Invalid pending research stage');
  assert.deepEqual(researchIR({ ...ir, pendingStage: 'ANALYSIS', protocolHash: 'abc' }).pendingStage, 'ANALYSIS');
  assert.equal(researchIR({ ...ir, protocolHash: 'abc' }).protocolHash, 'abc');
});

test('the protocol factory validates the scientific core and copies', () => {
  const protocol = validProtocol();
  const copied = researchProtocol(protocol);
  assert.deepEqual(copied, protocol);
  assert.notEqual(copied, protocol);
  assert.equal(copied.schemaVersion, 1);
  assert.equal('exclusionRule' in copied, false, 'an absent optional field stays absent');
  assert.equal('syntax' in copied, false);

  const full = { ...protocol, exclusionRule: 'none', syntax: 'valid', environment: { PATH: '/bin' } };
  const copiedFull = researchProtocol(full);
  assert.equal(copiedFull.exclusionRule, 'none');
  assert.equal(copiedFull.syntax, 'valid');
  assert.deepEqual(copiedFull.environment, { PATH: '/bin' });
  assert.equal(copiedFull.evaluationCriterion, protocol.evaluationCriterion);

  assert.equal(refusal(() => researchProtocol(null)), 'Research protocol must be an object');
  assert.equal(refusal(() => researchProtocol([])), 'Research protocol must be an object');
  assert.equal(refusal(() => researchProtocol('protocol')), 'Research protocol must be an object');
  assert.equal(refusal(() => researchProtocol({ ...protocol, hypothesis: 1 })), 'Research protocol hypothesis must be a string');
  assert.equal(refusal(() => researchProtocol({ ...protocol, primaryMetric: undefined })), 'Research protocol primaryMetric must be a string');
  assert.equal(refusal(() => researchProtocol({ ...protocol, baseline: null })), 'Research protocol baseline must be a string');
  assert.equal(refusal(() => researchProtocol({ ...protocol, sampleDefinition: 5 })), 'Research protocol sampleDefinition must be a string');
  assert.equal(refusal(() => researchProtocol({ ...protocol, evaluationCriterion: false })), 'Research protocol evaluationCriterion must be a string');
  assert.equal(refusal(() => researchProtocol({ ...protocol, hypothesis: '' })), null, 'the donor does not require a non-empty hypothesis');
});

test('the amendment factory refuses non-frozen fields and missing reasons', () => {
  const amendment = {
    id: 'protocol-amendment-1',
    protocolHash: 'hash-1',
    changes: [{ field: 'baseline', before: '0.5', after: '0.6', reason: 'better control' }],
    approved: true,
    createdAt: '2026-09-29T00:00:00.000Z',
  };
  const copied = protocolAmendment(amendment);
  assert.deepEqual(copied, amendment);
  assert.notEqual(copied, amendment);
  assert.notEqual(copied.changes, amendment.changes);

  assert.equal(refusal(() => protocolAmendment(null)), 'Amendment requires an id');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, id: '' })), 'Amendment requires an id');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, protocolHash: '' })), 'Amendment requires the frozen protocol hash');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, protocolHash: undefined })), 'Amendment requires the frozen protocol hash');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, changes: [] })), 'Amendment requires changes');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, changes: 'baseline' })), 'Amendment requires changes');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, changes: [{ field: 'path', before: 'a', after: 'b', reason: 'r' }] })), 'Amendment touches non-frozen field: path');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, changes: [{ field: 'syntax', before: 'a', after: 'b', reason: 'r' }] })), 'Amendment touches non-frozen field: syntax');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, changes: [{ field: 'baseline', before: 'a', after: 'b', reason: '' }] })), 'Amendment change requires a reason');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, changes: [{ field: 'baseline', before: 'a', after: 'b', reason: '   ' }] })), 'Amendment change requires a reason');
  assert.equal(refusal(() => protocolAmendment({ ...amendment, changes: [{ field: 'baseline', before: 'a', after: 'b' }] })), 'Amendment change requires a reason');
  assert.equal(
    refusal(() => protocolAmendment({ ...amendment, approved: false, changes: [...amendment.changes, { field: 'exclusion-rule', before: '', after: 'x', reason: 'r' }] })),
    null,
    'every frozen field is amendable',
  );
});

test('the research contract factory is a strict gate and copies the lists', () => {
  const contract = validContract();
  const copied = researchContract(contract);
  assert.deepEqual(copied, contract);
  assert.notEqual(copied, contract);
  assert.notEqual(copied.hypotheses, contract.hypotheses);
  assert.notEqual(copied.sections, contract.sections);
  assert.notEqual(copied.acceptanceGates, contract.acceptanceGates);
  assert.notEqual(copied.experimentPlan, contract.experimentPlan);

  assert.equal(refusal(() => researchContract(null)), 'Research contract must be an object');
  assert.equal(refusal(() => researchContract([])), 'Research contract must be an object');
  assert.equal(refusal(() => researchContract({ ...contract, researchQuestion: 1 })), 'Research contract requires a research question');
  assert.equal(refusal(() => researchContract({ ...contract, hypotheses: 'h1' })), 'Research contract requires hypotheses');
  assert.equal(refusal(() => researchContract({ ...contract, claims: null })), 'Research contract requires claims');
  assert.equal(refusal(() => researchContract({ ...contract, experimentPlan: undefined })), 'Research contract requires an experiment plan');
  assert.equal(refusal(() => researchContract({ ...contract, evaluationCriterion: 1 })), 'Research contract requires an evaluation criterion');
  assert.equal(refusal(() => researchContract({ ...contract, citationPolicy: 'loose' })), 'Invalid citation policy');
  assert.equal(refusal(() => researchContract({ ...contract, sections: 'Methods' })), 'Research contract requires sections');
  assert.equal(refusal(() => researchContract({ ...contract, acceptanceGates: undefined })), 'Research contract requires acceptance gates');
  assert.equal(refusal(() => researchContract({ ...contract, citationPolicy: 'manual' })), null);
  assert.equal(refusal(() => researchContract({ ...contract, citationPolicy: 'strict-summary' })), null);
  assert.equal(refusal(() => researchContract({ ...contract, claims: [] })), null, 'a contract with no claims passes the shape gate');
});

test('the research command spec factory keeps the donor allow-list text and limits', () => {
  const spec = validSpec();
  const copied = researchCommandSpec(spec);
  assert.deepEqual(copied, spec);
  assert.notEqual(copied, spec);
  assert.notEqual(copied.args, spec.args);
  assert.equal('expectedOutputs' in copied, false);
  assert.deepEqual(
    researchCommandSpec({ ...spec, expectedOutputs: ['out.csv'], environment: { LC_ALL: 'C' } }),
    { ...spec, expectedOutputs: ['out.csv'], environment: { LC_ALL: 'C' } },
  );
  assert.equal(refusal(() => researchCommandSpec(undefined)), 'Research command requires an executable');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, executable: '  ' })), 'Research command requires an executable');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, executable: 'python -c' })), 'Research executable must be a bare path/name (no shell metacharacters)');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, executable: 'a\nb' })), 'Research executable must be a bare path/name (no shell metacharacters)');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, args: 'run.py' })), 'Invalid research args');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, args: Array.from({ length: 101 }, () => 'a') })), 'Invalid research args');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, args: ['a'.repeat(4001)] })), 'Invalid research args');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, args: [1] })), 'Invalid research args');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, args: ['a'.repeat(4000)] })), null, '4000 characters is accepted');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, cwd: '' })), 'Research command requires a cwd');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, purpose: 'DEPLOY' })), 'Invalid research purpose');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, timeoutMs: 999 })), 'Invalid research timeout');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, timeoutMs: 3600001 })), 'Invalid research timeout');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, timeoutMs: 1000 })), null, '1000 ms is accepted');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, timeoutMs: 3600000 })), null, 'one hour is accepted');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, timeoutMs: 60000.5 })), 'Invalid research timeout');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, expectedOutputs: [''] })), 'Invalid expected outputs');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, expectedOutputs: ['a'.repeat(501)] })), 'Invalid expected outputs');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, expectedOutputs: Array.from({ length: 21 }, () => 'o') })), 'Invalid expected outputs');
  assert.equal(refusal(() => researchCommandSpec({ ...spec, expectedOutputs: ['a'.repeat(500)] })), null, '500 characters is accepted');
});

test('index.mjs is the one export site and exposes exactly the ported surface', async () => {
  const surface = await import('../index.mjs');
  assert.deepEqual(Object.keys(surface).sort(), [
    'ALLOWED_EXECUTABLES', 'AUTONOMY_MODES', 'AUTO_FIXABLE_FIELDS', 'BASELINE_PROVENANCE_KINDS', 'CITATION_POLICIES',
    'DECLARABLE_BASELINE_SOURCES', 'FROZEN_FIELDS', 'PROVIDER_POLICIES', 'RESEARCH_ARTIFACT_KINDS', 'RESEARCH_CONTROL_STATES',
    'RESEARCH_MAIN_STATES', 'RESEARCH_NEXT', 'RESEARCH_PURPOSES', 'RESEARCH_ROLE_NAMES', 'RESEARCH_STATES',
    'artifactKindForStage', 'canAdvance', 'canonicalStableProtocol', 'diffProtocol', 'executableAllowed',
    'expandSectionPromptsFromContract', 'hashProtocol', 'inferBaselineProvenance', 'nextResearchState', 'protocolAmendment',
    'researchBudget', 'researchCommandSpec', 'researchContract', 'researchIR', 'researchProtocol',
    'researchScope', 'roleForStage', 'scientificCore', 'stageArtifact', 'sufficiencyAudit',
    'validateAmendment', 'validateCommandSpec', 'validateResearchIR', 'violatesContract',
  ]);
  for (const [name, value] of Object.entries(surface)) {
    assert.notEqual(value, undefined, `${name} must be exported, not undefined`);
  }
  // every donor function and declared constant is reachable from the one site
  for (const donorName of [
    'RESEARCH_MAIN_STATES', 'RESEARCH_NEXT', 'canAdvance', 'validateResearchIR', 'nextResearchState',
    'AUTO_FIXABLE_FIELDS', 'FROZEN_FIELDS', 'canonicalStableProtocol', 'hashProtocol', 'scientificCore',
    'diffProtocol', 'validateAmendment', 'inferBaselineProvenance',
    'expandSectionPromptsFromContract', 'violatesContract', 'sufficiencyAudit',
    'roleForStage', 'artifactKindForStage', 'stageArtifact',
    'validateCommandSpec', 'executableAllowed',
  ]) {
    assert.ok(Object.hasOwn(surface, donorName), `${donorName} must be reachable from index.mjs`);
  }
});

test('the module is self-contained and pure: nothing outside its directory, no clock, no randomness', async () => {
  const moduleDir = join(import.meta.dirname, '..');
  const files = ['contracts.mjs', 'ir.mjs', 'protocol.mjs', 'contract.mjs', 'roles.mjs', 'command.mjs', 'index.mjs'];
  for (const file of files) {
    const code = (await readFile(join(moduleDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["require(", 'process.env', 'Math.random', 'Date.now', "node:fs", "node:crypto", 'evidence-engine']) {
      assert.ok(!code.includes(forbidden), `${file} must not carry ${forbidden}`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `${file} imports ${specifier}`);
    }
  }
});
