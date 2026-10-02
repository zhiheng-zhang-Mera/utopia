// RS-290 step 2 conformance: the unified presentation vocabulary.
//
// The property defended here is stronger than "no duplicate words". A UI consumer needs that no two
// DISTINCT MEANINGS share a presentation term - so the four UNKNOWN senses must stay four terms - while
// the SAME meaning reached through different components must MERGE to one term. Both halves are tested,
// and so is the thing a naive unification would break: RS-202's structural/resource partition.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as registry from '../../general-ai-registry-v1/records.mjs';
import * as availability from '../../general-ai-registry-v1/availability.mjs';
import * as pressure from '../../../city/00-foundation/01-city-core/fleet-routing/pressure.mjs';
import * as routing from '../../../city/00-foundation/01-city-core/fleet-routing/routing-sequence.mjs';
import * as bridge from '../../rs-cross-device-return-v1/return-bridge.mjs';

import {
  ALLOWED_ACTIONS, PRESENTATION_CONTRACT_VERSION, PRESENTATION_STATES, TERMS, TERM_CLASS, TERM_OF,
  presentState, presentTerm, projectStatus,
} from '../presentation.mjs';

/** The real vocabularies, so the mapping table is checked against the components rather than itself. */
const SOURCES = Object.freeze({
  'RS-201.AVAILABILITY_REASONS': registry.AVAILABILITY_REASONS,
  'RS-201.CHANNEL_READINESS': registry.CHANNEL_READINESS,
  'RS-201.FRESHNESS': registry.FRESHNESS,
  'RS-201.ENABLEMENT': registry.ENABLEMENT,
  'RS-201.PROBE_OUTCOMES': availability.PROBE_OUTCOMES,
  'RS-202.ELIGIBILITY_REASONS': pressure.ELIGIBILITY_REASONS,
  'RS-202.REACHABLE_STATES': pressure.REACHABLE_STATES,
  'RS-202.REFUSING_STATES': pressure.REFUSING_STATES,
  'RS-202.ROUTE_STAGES': routing.ROUTE_STAGES,
  'RS-203.REMOTE_STATES': bridge.REMOTE_STATES,
  'RS-203.UNAVAILABILITY_DOMAINS': bridge.UNAVAILABILITY_DOMAINS,
  'RS-201.ABSENCE_CODES': registry.ABSENCE_CODES,
});

const allTargets = () => Object.values(TERM_OF).flatMap(table => Object.values(table));

test('RS-290: the mapping COVERS every source vocabulary exactly - no gap and no stale extra', () => {
  // This is the check that makes the table trustworthy: it is validated against the real modules, so a
  // table that drifts when a component changes its vocabulary fails here rather than silently
  // presenting a wrong or missing term.
  assert.deepEqual(Object.keys(TERM_OF).sort(), Object.keys(SOURCES).sort());
  for (const [source, words] of Object.entries(SOURCES)) {
    const mapped = Object.keys(TERM_OF[source]).sort();
    assert.deepEqual(mapped, [...words].sort(), `${source} mapping does not match its real vocabulary`);
  }
});

test('RS-290: the presentation vocabulary is CLOSED - every target is a declared term with a class', () => {
  const declared = new Set(TERMS);
  for (const target of allTargets()) {
    assert.ok(declared.has(target), `${target} is mapped to but not declared in TERMS`);
    assert.ok(TERM_CLASS[target], `${target} has no TERM_CLASS`);
  }
  // Every declared term is actually reachable, so the vocabulary carries no dead entries.
  const reachable = new Set(allTargets());
  for (const term of TERMS) assert.ok(reachable.has(term), `${term} is declared but never produced`);
});

test('RS-290: the four UNKNOWN senses stay FOUR distinct terms - the polysemy fix', () => {
  // The measured overlap had UNKNOWN in four vocabularies. Merging them would render "we have not
  // measured availability" identically to "we cannot see the executor", which is the exact ambiguity
  // step 2 exists to remove.
  const unknowns = [
    presentTerm('RS-201.AVAILABILITY_REASONS', 'UNKNOWN'),
    presentTerm('RS-201.CHANNEL_READINESS', 'UNKNOWN'),
    presentTerm('RS-201.FRESHNESS', 'UNKNOWN'),
    presentTerm('RS-203.REMOTE_STATES', 'UNKNOWN'),
  ];
  assert.equal(new Set(unknowns).size, 4, `expected four distinct terms, got ${unknowns.join(', ')}`);
});

test('RS-290: the SAME meaning reached through different components MERGES to one term', () => {
  // The other half of the rule: user disablement is one fact however it arrives, so three components
  // and four spellings must collapse to exactly one presentation term.
  const disabled = [
    presentTerm('RS-201.AVAILABILITY_REASONS', 'USER_DISABLED'),
    presentTerm('RS-202.ELIGIBILITY_REASONS', 'USER_DISABLED'),
    presentTerm('RS-202.ELIGIBILITY_REASONS', 'USER_DISABLED'),
    presentTerm('RS-201.ENABLEMENT', 'DISABLED'),
  ];
  assert.deepEqual([...new Set(disabled)], ['USER_DISABLED']);
  // But the same SPELLING with a different meaning must NOT merge: an observed fleet DISABLED is not a
  // user choice, and ONLINE as device reachability is not ONLINE as remote execution state.
  assert.notEqual(presentTerm('RS-202.REFUSING_STATES', 'DISABLED'), presentTerm('RS-201.ENABLEMENT', 'DISABLED'));
  assert.notEqual(presentTerm('RS-202.REACHABLE_STATES', 'ONLINE'), presentTerm('RS-203.REMOTE_STATES', 'ONLINE'));
});

test('RS-290: the STRUCTURAL and RESOURCE partition is PRESERVED, which a naive merge would destroy', () => {
  // RS-202's gate depends on a structural refusal being distinguishable from a temporary shortage. A
  // unification written as "merge duplicate words" would flatten these, so the partition is asserted as
  // data here rather than left to survive by luck.
  const structural = TERMS.filter(term => TERM_CLASS[term] === 'STRUCTURAL');
  const resource = TERMS.filter(term => TERM_CLASS[term] === 'RESOURCE');
  assert.ok(structural.length > 0 && resource.length > 0, 'both classes must be populated');
  assert.deepEqual(structural.filter(term => resource.includes(term)), [], 'the classes must be disjoint');
  // The specific split RS-202 makes survives the unification.
  for (const reason of routing.STRUCTURAL_REASONS) {
    assert.equal(TERM_CLASS[presentTerm('RS-202.ELIGIBILITY_REASONS', reason)], 'STRUCTURAL', `${reason} must stay structural`);
  }
  for (const reason of routing.RESOURCE_REASONS) {
    assert.equal(TERM_CLASS[presentTerm('RS-202.ELIGIBILITY_REASONS', reason)], 'RESOURCE', `${reason} must stay resource`);
  }
});

test('RS-290: an unmapped or unknown source THROWS rather than yielding undefined', () => {
  // A silent undefined is how a UI renders a blank status for a real condition.
  assert.throws(() => presentTerm('RS-999.NOPE', 'X'), /unknown source vocabulary/);
  assert.throws(() => presentTerm('RS-201.ENABLEMENT', 'MAYBE'), /no mapping/);
});

test('RS-290: presentState always yields a declared presentation state', () => {
  const declared = new Set(PRESENTATION_STATES);
  const cases = [
    { terms: ['SELECTABLE'] },
    { terms: ['WAITING_USER'] },
    { terms: ['REMOTE_HANDOFF'] },
    { terms: ['AT_CAPACITY'] },
    { terms: ['REMOTE_STATE_UNKNOWN'] },
    { terms: [], terminal: true },
    { terms: [], terminal: true, failed: true },
    { terms: ['SELECTABLE'], cancelled: true },
    { terms: [] },
  ];
  for (const input of cases) {
    const state = presentState(input);
    assert.ok(declared.has(state), `${JSON.stringify(input)} produced undeclared state ${state}`);
  }
  // Terminal outcomes are decided by terminal flags, not by the terms present, so a late term cannot
  // make a finished run look active again.
  assert.equal(presentState({ terms: ['AT_CAPACITY'], terminal: true }), 'COMPLETED');
  assert.equal(presentState({ terms: ['SELECTABLE'], cancelled: true }), 'CANCELLED');
});

test('RS-290: the action and state vocabularies are closed sets of the shapes step 3 names', () => {
  assert.equal(PRESENTATION_CONTRACT_VERSION, 1);
  assert.deepEqual([...ALLOWED_ACTIONS], ['CANCEL', 'RETRY', 'KEEP_WAITING', 'CHOOSE_PROVIDER', 'CONFIRM']);
  // Step 3's list of states a UI renders, all present.
  for (const required of ['QUEUED', 'RUNNING', 'REMOTE_HANDOFF', 'WAITING_USER', 'DEGRADED', 'COMPLETED']) {
    assert.ok(PRESENTATION_STATES.includes(required), `${required} must be a presentation state`);
  }
});

/* ------------------------------------------- step 3: the presentation DTO, and step 4's truth rule */

test('RS-290: a selectable provider renders RUNNING with CANCEL and no choice demanded', () => {
  const dto = projectStatus({ providerTerms: ['SELECTABLE'] });
  assert.equal(dto.state, 'RUNNING');
  assert.equal(dto.provider_choice_required, false);
  assert.equal(dto.providers[0].selectable, true);
  assert.deepEqual([...dto.actions], ['CANCEL']);
});

test('RS-290: a pool that is only BUSY does NOT demand a choice, because waiting can help', () => {
  // This is the distinction the RESOURCE class carries: saturation resolves on its own, so asking the
  // user to choose a provider would be asking them to solve something that fixes itself.
  const dto = projectStatus({ providerTerms: ['AT_CAPACITY', 'PRESSURE_PAUSED'] });
  assert.equal(dto.provider_choice_required, false);
  assert.ok(dto.actions.includes('KEEP_WAITING'), 'waiting must be offered when it can help');
  assert.equal(dto.providers.every(entry => entry.resolves_by_waiting), true);
  assert.equal(dto.structural_refusal, false);
});

test('RS-290: a structurally refused pool DOES demand a choice, and does not offer waiting', () => {
  const dto = projectStatus({ providerTerms: ['REGION_UNSUPPORTED', 'USER_DISABLED'] });
  assert.equal(dto.provider_choice_required, true);
  assert.ok(dto.actions.includes('CHOOSE_PROVIDER'));
  assert.equal(dto.actions.includes('KEEP_WAITING'), false, 'waiting cannot fix a structural refusal');
  assert.equal(dto.structural_refusal, true);
  // And the projection never makes the choice on the user's behalf.
  assert.equal(dto.provider_choice_taken, false);
});

test('RS-290: RAW component words are REFUSED - only mapped terms may enter the DTO', () => {
  // The anti-leak guard: without it a component's private vocabulary could reach the UI through the
  // projection and the three-vocabulary problem would return by the back door.
  assert.throws(() => projectStatus({ providerTerms: ['AUTH_REQUIRED'] }), /not a presentation term/);
  assert.throws(() => projectStatus({ terms: ['CACHED_WITHIN_TTL'] }), /not a presentation term/);
});

test('RS-290: no path FABRICATES success - COMPLETED needs an explicit terminal flag', () => {
  // Step 4 as an executable property: absence of bad news is not good news.
  assert.notEqual(projectStatus({ providerTerms: ['SELECTABLE'] }).state, 'COMPLETED');
  assert.notEqual(projectStatus({ terms: [] }).state, 'COMPLETED');
  assert.notEqual(projectStatus({ terms: ['SELECTABLE'], terminal: false }).state, 'COMPLETED');
  assert.equal(projectStatus({ terminal: true }).state, 'COMPLETED');
  assert.equal(projectStatus({ terminal: true, failed: true }).state, 'FAILED');
  assert.equal(projectStatus({ terminal: true, cancelled: true }).state, 'CANCELLED');
  const dto = projectStatus({ terminal: true });
  assert.equal(dto.from_backend_truth, true);
  assert.equal(dto.fabricated, false);
});

test('RS-290: waiting-user, failure and route stage each drive the state and the offered action', () => {
  assert.equal(projectStatus({ waitingUser: true }).state, 'WAITING_USER');
  assert.ok(projectStatus({ waitingUser: true }).actions.includes('CONFIRM'));
  assert.ok(projectStatus({ terminal: true, failed: true }).actions.includes('RETRY'));
  assert.equal(projectStatus({ routeStage: 'QUEUED' }).state, 'QUEUED');
  assert.equal(projectStatus({ routeStage: 'ALTERNATE_DEVICE' }).state, 'REMOTE_HANDOFF');
});

test('RS-290: every DTO output is inside the declared vocabularies', () => {
  const states = new Set(PRESENTATION_STATES);
  const actions = new Set(ALLOWED_ACTIONS);
  const inputs = [
    { providerTerms: ['SELECTABLE'] }, { providerTerms: ['AT_CAPACITY'] }, { providerTerms: ['USER_DISABLED'] },
    { terms: ['FRESHNESS_UNKNOWN'] }, { routeStage: 'QUEUED' }, { routeStage: 'ALTERNATE_DEVICE' },
    { waitingUser: true }, { terminal: true }, { terminal: true, failed: true }, { terminal: true, cancelled: true },
  ];
  for (const input of inputs) {
    const dto = projectStatus(input);
    assert.ok(states.has(dto.state), `${JSON.stringify(input)} gave undeclared state ${dto.state}`);
    for (const action of dto.actions) assert.ok(actions.has(action), `undeclared action ${action}`);
    assert.equal(dto.provider_choice_taken, false, 'the DTO must never record a choice it did not make');
  }
});
