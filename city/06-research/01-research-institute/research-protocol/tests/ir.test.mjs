/**
 * UTOPIA · Research Institute — research IR state machine suite.
 *
 * The deterministic transition graph, the control-state rule and the IR validation
 * gate, restated from the Codex-Boss donor `src/shared/research-ir.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEARCH_MAIN_STATES,
  RESEARCH_NEXT,
  RESEARCH_STATES,
  canAdvance,
  nextResearchState,
  validateResearchIR,
  researchIR,
} from '../index.mjs';

const validIR = () => ({
  schemaVersion: 1,
  id: 'run-1',
  goal: 'decide whether X beats Y',
  scope: {
    workspace: '/work',
    allowedDomains: ['arxiv.org'],
    reviewers: ['reviewer-a'],
    autonomy: 'GUIDED',
    budget: { maxExperiments: 2, maxSteps: 10 },
  },
  state: 'SCOPING',
  researchQuestions: [],
  hypotheses: [],
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
});

test('the transition graph is the donor table and covers every state', () => {
  assert.deepEqual(RESEARCH_NEXT, {
    SCOPING: 'PROJECT_INSPECTION',
    PROJECT_INSPECTION: 'LITERATURE_REVIEW',
    LITERATURE_REVIEW: 'QUESTION_FORMULATION',
    QUESTION_FORMULATION: 'PROTOCOL_DRAFT',
    PROTOCOL_DRAFT: 'PROTOCOL_FROZEN',
    PROTOCOL_FROZEN: 'EXPERIMENT_GENERATION',
    EXPERIMENT_GENERATION: 'EXPERIMENT_EXECUTION',
    EXPERIMENT_EXECUTION: 'ANALYSIS',
    ANALYSIS: 'REPLICATION',
    REPLICATION: 'CLAIM_REVIEW',
    CLAIM_REVIEW: 'MANUSCRIPT',
    MANUSCRIPT: 'CITATION_AUDIT',
    CITATION_AUDIT: 'REPRO_AUDIT',
    REPRO_AUDIT: 'BUILD',
    BUILD: 'READY',
    READY: 'READY',
    RECOVERING: 'SCOPING',
    WAITING_FOR_PROVIDER: 'SCOPING',
    WAITING_FOR_USER: 'SCOPING',
    FAILED: 'FAILED',
  });
  assert.deepEqual(Object.keys(RESEARCH_NEXT), [...RESEARCH_STATES], 'the table is keyed in vocabulary order');
  assert.ok(Object.isFrozen(RESEARCH_NEXT));
});

test('the main flow advances in the plan order and stops at READY', () => {
  let state = RESEARCH_MAIN_STATES[0];
  const visited = [state];
  while (state !== 'READY') {
    state = nextResearchState(state);
    visited.push(state);
  }
  assert.deepEqual(visited, [...RESEARCH_MAIN_STATES]);
  assert.equal(nextResearchState('READY'), null, 'READY has no successor');
  assert.equal(nextResearchState('FAILED'), null, 'FAILED has no successor');
});

test('a control state has no successor unless control transitions are allowed', () => {
  for (const control of ['RECOVERING', 'WAITING_FOR_PROVIDER', 'WAITING_FOR_USER']) {
    assert.equal(nextResearchState(control), null);
    assert.equal(nextResearchState(control, true), 'SCOPING');
  }
  assert.equal(nextResearchState('FAILED', true), null, 'allowing control transitions never revives FAILED');
  assert.equal(nextResearchState('READY', true), null);
  assert.equal(nextResearchState('SCOPING', true), 'PROJECT_INSPECTION');
});

test('canAdvance refuses FAILED, READY and the two waiting states', () => {
  for (const state of RESEARCH_STATES) {
    const expected = !['FAILED', 'READY', 'WAITING_FOR_PROVIDER', 'WAITING_FOR_USER'].includes(state);
    assert.equal(canAdvance(state), expected, `canAdvance(${state})`);
  }
  assert.equal(canAdvance('RECOVERING'), true, 'RECOVERING is not a waiting state');
});

test('the IR gate accepts a complete IR and refuses with the donor messages', () => {
  const ir = validIR();
  assert.equal(validateResearchIR(ir), undefined, 'the gate returns nothing on success');
  assert.doesNotThrow(() => validateResearchIR({ ...ir, state: 'WAITING_FOR_USER' }), 'a control state is a valid state');
  assert.doesNotThrow(() => validateResearchIR({ ...ir, state: 'READY' }), 'READY is a valid resting state');
  assert.doesNotThrow(() => validateResearchIR({ ...ir, pendingStage: 'REPRO_AUDIT' }), 'a main stage may be pending');
  assert.doesNotThrow(() => validateResearchIR({ ...ir, protocolHash: 'abc' }));

  for (const [patch, message] of [
    [{ schemaVersion: 2 }, 'Invalid research IR id'],
    [{ id: '' }, 'Invalid research IR id'],
    [{ goal: '   ' }, 'Research goal must be 1–20000 characters'],
    [{ scope: { ...ir.scope, workspace: '' } }, 'Research requires a workspace'],
    [{ scope: { ...ir.scope, reviewers: [] } }, 'Research requires 1–5 reviewers'],
    [{ scope: { ...ir.scope, autonomy: 'SOLO' } }, 'Invalid autonomy mode'],
    [{ state: 'FINISHED' }, 'Invalid research state'],
    [{ pendingStage: 'FAILED' }, 'Invalid pending research stage'],
  ]) {
    assert.throws(() => validateResearchIR({ ...ir, ...patch }), (error) => {
      assert.equal(error.message, message);
      return true;
    });
  }

  // the gate is the factory: the same accepted value either way
  assert.deepEqual(researchIR(ir), researchIR(validIR()));
});
