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
  presentState, presentTerm,
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
