/**
 * UTOPIA · Research Institute — capability registry suite.
 *
 * Every capability lookup, its trigger boundary and the refusal path restate the
 * Codex-Boss donor `src/shared/research-capability-registry.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEARCH_CAPABILITIES,
  RESEARCH_CAPABILITY_IDS,
  RESEARCH_CAPABILITY_STATUSES,
  isResearchCapabilityStatus,
  planResearchCapabilities,
} from '../index.mjs';
import { isResearchCapabilityStatus as isStatusFromRegistry } from '../capability-registry.mjs';

const NEEDED = 'NEEDED';
const NOT_NEEDED = 'NOT_NEEDED';
const ALWAYS_ON = ['literature-scout', 'section-planner', 'section-writer', 'skeptical-reviewer', 'latex-compiler'];

/** The ids the plan marks NEEDED, in registry order. */
const needed = (profile) => Object.entries(planResearchCapabilities(profile)).filter(([, status]) => status === NEEDED).map(([id]) => id);

test('the plan carries every registered capability, in registry order, and nothing else', () => {
  const plan = planResearchCapabilities({});
  assert.deepEqual(Object.keys(plan), [...RESEARCH_CAPABILITY_IDS]);
  assert.equal(Object.keys(plan).length, 16);
  assert.deepEqual(RESEARCH_CAPABILITIES.map((row) => row.id), [...RESEARCH_CAPABILITY_IDS]);
  for (const status of Object.values(plan)) {
    assert.ok(RESEARCH_CAPABILITY_STATUSES.includes(status), `${status} is a donor status`);
  }
  assert.equal(Object.values(plan).includes('AVAILABLE'), false, 'the donor marks every capability, so the initial AVAILABLE never survives');
  assert.equal(Object.values(plan).includes('FAILED'), false, 'the planner never invents an execution outcome');
});

test('an empty profile needs exactly the always-on five', () => {
  assert.deepEqual(planResearchCapabilities({}), {
    'literature-scout': NEEDED,
    'citation-verifier': NOT_NEEDED,
    'methodology-critic': NOT_NEEDED,
    'experiment-designer': NOT_NEEDED,
    'statistics-engine': NOT_NEEDED,
    'replication-runner': NOT_NEEDED,
    'figure-planner': NOT_NEEDED,
    'chart-renderer': NOT_NEEDED,
    'table-builder': NOT_NEEDED,
    'architecture-diagram-builder': NOT_NEEDED,
    'evidence-adjudicator': NOT_NEEDED,
    'section-planner': NEEDED,
    'section-writer': NEEDED,
    'skeptical-reviewer': NEEDED,
    'reproducibility-auditor': NOT_NEEDED,
    'latex-compiler': NEEDED,
  });
  assert.deepEqual(needed({}), ALWAYS_ON);
});

test('bindsCitations is a truthiness test, exactly as the donor has it', () => {
  assert.equal(planResearchCapabilities({ bindsCitations: true })['citation-verifier'], NEEDED);
  assert.equal(planResearchCapabilities({ bindsCitations: false })['citation-verifier'], NOT_NEEDED);
  assert.equal(planResearchCapabilities({ bindsCitations: 1 })['citation-verifier'], NEEDED, 'a truthy non-boolean is accepted, as in the donor');
  assert.equal(planResearchCapabilities({ bindsCitations: 'yes' })['citation-verifier'], NEEDED);
  assert.equal(planResearchCapabilities({ bindsCitations: 0 })['citation-verifier'], NOT_NEEDED);
  assert.equal(planResearchCapabilities({ bindsCitations: '' })['citation-verifier'], NOT_NEEDED);
  assert.deepEqual(needed({ bindsCitations: true }), [...ALWAYS_ON, 'citation-verifier'].sort((a, b) => RESEARCH_CAPABILITY_IDS.indexOf(a) - RESEARCH_CAPABILITY_IDS.indexOf(b)));
});

test('a formal protocol needs the methodology critic, and nothing else beyond the always-on five', () => {
  assert.deepEqual(needed({ hasFormalProtocol: true }), ['literature-scout', 'methodology-critic', 'section-planner', 'section-writer', 'skeptical-reviewer', 'latex-compiler']);
  assert.deepEqual(needed({ hasFormalProtocol: false }), ALWAYS_ON);
});

test('quantitative experiments drive the quantitative capability set', () => {
  assert.deepEqual(needed({ hasQuantitativeExperiments: true }), [
    'literature-scout',
    'methodology-critic',
    'experiment-designer',
    'statistics-engine',
    'replication-runner',
    'figure-planner',
    'chart-renderer',
    'table-builder',
    'evidence-adjudicator',
    'section-planner',
    'section-writer',
    'skeptical-reviewer',
    'reproducibility-auditor',
    'latex-compiler',
  ]);

  // the quantitative flags do not leak into capabilities with their own trigger
  const plan = planResearchCapabilities({ hasQuantitativeExperiments: true });
  assert.equal(plan['citation-verifier'], NOT_NEEDED);
  assert.equal(plan['architecture-diagram-builder'], NOT_NEEDED);
  assert.deepEqual(needed({ hasQuantitativeExperiments: false }), ALWAYS_ON);
});

test('hasArchitecture is a Boolean() test and hasMultipleReviewers is a strict === true test', () => {
  assert.equal(planResearchCapabilities({ hasArchitecture: true })['architecture-diagram-builder'], NEEDED);
  assert.equal(planResearchCapabilities({ hasArchitecture: false })['architecture-diagram-builder'], NOT_NEEDED);
  assert.equal(planResearchCapabilities({})['architecture-diagram-builder'], NOT_NEEDED);
  assert.equal(planResearchCapabilities({ hasArchitecture: 1 })['architecture-diagram-builder'], NEEDED, 'Boolean(1) is true');
  assert.equal(planResearchCapabilities({ hasArchitecture: 'yes' })['architecture-diagram-builder'], NEEDED);

  assert.equal(planResearchCapabilities({ hasMultipleReviewers: true })['evidence-adjudicator'], NEEDED, 'exactly true needs the adjudicator');
  assert.equal(planResearchCapabilities({ hasMultipleReviewers: false })['evidence-adjudicator'], NOT_NEEDED);
  assert.equal(planResearchCapabilities({})['evidence-adjudicator'], NOT_NEEDED);
  // the donor's asymmetry: a truthy-but-not-true reviewer flag does not fire this one
  assert.equal(planResearchCapabilities({ hasMultipleReviewers: 1 })['evidence-adjudicator'], NOT_NEEDED);
  assert.equal(planResearchCapabilities({ hasMultipleReviewers: 'yes' })['evidence-adjudicator'], NOT_NEEDED);
  assert.equal(planResearchCapabilities({ hasMultipleReviewers: 1, hasQuantitativeExperiments: true })['evidence-adjudicator'], NEEDED, 'quantitative experiments fire it independently');
  assert.deepEqual(needed({ hasMultipleReviewers: true }), ['literature-scout', 'evidence-adjudicator', 'section-planner', 'section-writer', 'skeptical-reviewer', 'latex-compiler']);
});

test('every registry row is the donor row, and every planned status is a refused-or-accepted donor status', () => {
  assert.equal(isStatusFromRegistry, isResearchCapabilityStatus);
  assert.deepEqual(RESEARCH_CAPABILITIES[1], { id: 'citation-verifier', label: '核对引用来源与原文支持', neededWhen: 'citations are bound to the paper' });
  assert.deepEqual(RESEARCH_CAPABILITIES[15], { id: 'latex-compiler', label: '编译 TEX→PDF', neededWhen: 'a compiled PDF deliverable is required' });
  for (const row of RESEARCH_CAPABILITIES) {
    assert.deepEqual(Object.keys(row), ['id', 'label', 'neededWhen'], `${row.id} carries exactly the donor fields`);
    assert.equal(typeof row.label, 'string');
    assert.ok(row.label.length > 0 && row.neededWhen.length > 0);
  }

  const plan = planResearchCapabilities({ hasQuantitativeExperiments: true, bindsCitations: true, hasFormalProtocol: true, hasArchitecture: true, hasMultipleReviewers: true });
  for (const [id, status] of Object.entries(plan)) {
    assert.equal(isResearchCapabilityStatus(status), true, `${id} is planned with a recognised status`);
  }
});

test('the refusal path refuses anything that is not a donor capability status', () => {
  for (const status of RESEARCH_CAPABILITY_STATUSES) assert.equal(isResearchCapabilityStatus(status), true);
  for (const refused of ['AVAILABLE ', ' available', 'available', 'NEEDED ', 'NEEDED\n', 'PLANNED', 'DONE', 'FAILED_', '', 'n/a', undefined, null, 0, 1, -1, true, false, {}, { status: 'NEEDED' }, [], ['NEEDED'], () => 'NEEDED']) {
    assert.equal(isResearchCapabilityStatus(refused), false, `${JSON.stringify(refused)} is refused`);
  }
});
