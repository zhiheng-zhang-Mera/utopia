// RS-290 step 2 conformance: the unified presentation vocabulary.
//
// The property defended here is stronger than "no duplicate words". A UI consumer needs that no two
// DISTINCT MEANINGS share a presentation term - so the four UNKNOWN senses must stay four terms - while
// the SAME meaning reached through different components must MERGE to one term. Both halves are tested,
// and so is the thing a naive unification would break: RS-202's structural/resource partition.
//
// Mech's RS-290 review added three findings, and each is now a test in its own right rather than a
// property the module merely claimed:
//
//   F1  provenance, not spelling, decides meaning - a raw word colliding with a term name is mapped by
//       its vocabulary, and the projection refuses anything that does not declare where it came from;
//   F2  a terminal outcome outranks waitingUser, so a failed run is never masked and RETRY is offered;
//   F3  no collapse of two meanings onto one term goes undeclared, QUANTIFIED over the whole table
//       instead of spot-checked - which is how FRESHNESS.STALE was found hiding inside FRESHNESS_UNKNOWN.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as registry from '../../general-ai-registry-v1/records.mjs';
import * as availability from '../../general-ai-registry-v1/availability.mjs';
import * as pressure from '../../../city/00-foundation/01-city-core/fleet-routing/pressure.mjs';
import * as routing from '../../../city/00-foundation/01-city-core/fleet-routing/routing-sequence.mjs';
import * as bridge from '../../rs-cross-device-return-v1/return-bridge.mjs';

import {
  ALLOWED_ACTIONS, INTENDED_COLLAPSES, PRESENTATION_CONTRACT_VERSION, PRESENTATION_STATES, TERMS, TERM_CLASS, TERM_OF,
  presentState, presentTerm, projectStatus, termRef,
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
  const dto = projectStatus({ providerRefs: [termRef('RS-201.AVAILABILITY_REASONS', 'AVAILABLE')] });
  assert.equal(dto.state, 'RUNNING');
  assert.equal(dto.provider_choice_required, false);
  assert.equal(dto.providers[0].selectable, true);
  assert.deepEqual([...dto.actions], ['CANCEL']);
});

test('RS-290: a pool that is only BUSY does NOT demand a choice, because waiting can help', () => {
  // This is the distinction the RESOURCE class carries: saturation resolves on its own, so asking the
  // user to choose a provider would be asking them to solve something that fixes itself.
  const dto = projectStatus({
    providerRefs: [
      termRef('RS-202.ELIGIBILITY_REASONS', 'AT_CAPACITY'),
      termRef('RS-202.ELIGIBILITY_REASONS', 'PRESSURE_PAUSED'),
    ],
  });
  assert.equal(dto.provider_choice_required, false);
  assert.ok(dto.actions.includes('KEEP_WAITING'), 'waiting must be offered when it can help');
  assert.equal(dto.providers.every(entry => entry.resolves_by_waiting), true);
  assert.equal(dto.structural_refusal, false);
});

test('RS-290: a structurally refused pool DOES demand a choice, and does not offer waiting', () => {
  const dto = projectStatus({
    providerRefs: [
      termRef('RS-201.AVAILABILITY_REASONS', 'REGION_UNSUPPORTED'),
      termRef('RS-202.ELIGIBILITY_REASONS', 'USER_DISABLED'),
    ],
  });
  assert.equal(dto.provider_choice_required, true);
  assert.ok(dto.actions.includes('CHOOSE_PROVIDER'));
  assert.equal(dto.actions.includes('KEEP_WAITING'), false, 'waiting cannot fix a structural refusal');
  assert.equal(dto.structural_refusal, true);
  // And the projection never makes the choice on the user's behalf.
  assert.equal(dto.provider_choice_taken, false);
});

/* ------------------------------------------------------------------ Mech's RS-290 review, F1, F2, F3 */

test('RS-290 F1: a raw word that COLLIDES with a term name is still mapped by its VOCABULARY', () => {
  // The anti-leak guard used to be a name check, so a raw word spelled like a term was accepted
  // unchanged. RS-202.REACHABLE_STATES.DEGRADED is exactly such a word, and accepting it produced the
  // WORSE answer: the term DEGRADED (class STATE) instead of the prescribed PRESSURE_PAUSED (RESOURCE),
  // which demanded CHOOSE_PROVIDER from the user and withheld KEEP_WAITING for a pool that only needed
  // to wait. The module's own reasoning says a saturated pool needs waiting, not a decision.
  assert.equal(presentTerm('RS-202.REACHABLE_STATES', 'DEGRADED'), 'PRESSURE_PAUSED');
  const byProvenance = projectStatus({ providerRefs: [termRef('RS-202.REACHABLE_STATES', 'DEGRADED')] });
  assert.equal(byProvenance.state, 'QUEUED');
  assert.deepEqual([...byProvenance.actions], ['CANCEL', 'KEEP_WAITING']);
  assert.equal(byProvenance.provider_choice_required, false, 'a pool under pressure must not demand a choice');

  // Quantified, so the fix is not just the one case Mech reported: EVERY source word that IS a declared
  // term while meaning something else is mapped by its vocabulary rather than by its name.
  //
  // Measured, not assumed, and the measurement is worth recording because my first version of this line
  // asserted nine from memory and the suite refused it: exactly ONE word in the whole table is in that
  // position, DEGRADED above. Near-collisions like ONLINE, UNKNOWN and DISABLED are NOT in the set,
  // because their terms are spelled DEVICE_ONLINE, AVAILABILITY_UNKNOWN and USER_DISABLED - a name check
  // cannot confuse a word with a term that is spelled differently. Only a word that IS a term name can
  // fool the guard, which is why this exact set is the one that matters, and why Mech's operative claim
  // ("for one of them the collision changes the answer") is what the executable measurement confirms.
  const colliding = [];
  for (const [source, table] of Object.entries(TERM_OF)) {
    for (const [word, term] of Object.entries(table)) {
      if (TERMS.includes(word) && word !== term) colliding.push([source, word, term]);
    }
  }
  assert.deepEqual(colliding, [['RS-202.REACHABLE_STATES', 'DEGRADED', 'PRESSURE_PAUSED']],
    'the set of words that both ARE a term name and mean something else has changed - re-audit the guard, because each one can defeat a name check');
  for (const [source, word, term] of colliding) {
    assert.equal(presentTerm(source, word), term, `${source}.${word} must map by vocabulary, not by name`);
  }
});

test('RS-290 F1: the guard needs PROVENANCE - bare words and bare terms are both refused', () => {
  // A name check cannot tell a raw word from a term of the same name, because the ambiguity IS the name.
  // The projection therefore takes {source, word} references and maps them itself, so anything that does
  // not declare where it came from is refused rather than guessed at.
  assert.throws(() => projectStatus({ providerRefs: ['AUTH_REQUIRED'] }), /bare string/);
  assert.throws(() => projectStatus({ termRefs: ['CACHED_WITHIN_TTL'] }), /bare string/);
  assert.throws(() => projectStatus({ providerRefs: ['DEGRADED'] }), /bare string/, 'a bare colliding spelling is refused, not accepted on its name');
  assert.throws(() => projectStatus({ providerRefs: [termRef('RS-201.ENABLEMENT', 'MAYBE')] }), /no mapping/);
  assert.throws(() => projectStatus({ providerRefs: [termRef('RS-202.NOPE', 'X')] }), /unknown source vocabulary/);
  // The removed parameter names are REFUSED rather than ignored: a rename that silently dropped its
  // input would reproduce F1's failure mode in a new form, as a plausible DTO computed from nothing.
  assert.throws(() => projectStatus({ providerTerms: ['SELECTABLE'] }), /was replaced by providerRefs/);
  assert.throws(() => projectStatus({ terms: [] }), /was replaced by termRefs/);
  assert.throws(() => projectStatus({ routeStage: 'QUEUED' }), /was replaced by routeStageRef/);
  // And a word that exists only on Object.prototype is not a mapping.
  assert.throws(() => presentTerm('RS-201.ENABLEMENT', 'constructor'), /no mapping/);
  assert.throws(() => presentTerm('RS-201.ENABLEMENT', 'toString'), /no mapping/);
});

test('RS-290 F2: a terminal outcome OUTRANKS waitingUser, so a failure is never masked', () => {
  // waitingUser used to short-circuit the state before presentState was consulted, so a run that was
  // terminal AND failed reported WAITING_USER: a finished failure rendered as something awaiting the
  // user, with RETRY withheld - because RETRY is gated on FAILED. The fix is the removal of that
  // override, so presentState's single precedence decides, exactly as it already did for `cancelled`.
  const failed = projectStatus({ terminal: true, failed: true, waitingUser: true });
  assert.equal(failed.state, 'FAILED', 'a finished failure must not be masked by a pending confirmation');
  assert.ok(failed.actions.includes('RETRY'), 'the recovery action must reach the only user who needs it');
  assert.equal(failed.actions.includes('CONFIRM'), false, 'nothing is waiting on the user in a terminal run');

  assert.equal(projectStatus({ terminal: true, waitingUser: true }).state, 'COMPLETED');
  assert.deepEqual([...projectStatus({ terminal: true, waitingUser: true }).actions], []);
  assert.equal(projectStatus({ terminal: true, cancelled: true, waitingUser: true }).state, 'CANCELLED');

  // Non-terminal: a pending confirmation still drives the state and offers CONFIRM.
  const waiting = projectStatus({ waitingUser: true });
  assert.equal(waiting.state, 'WAITING_USER');
  assert.deepEqual([...waiting.actions], ['CANCEL', 'CONFIRM']);
});

test('RS-290 F3: FRESHNESS.STALE and FRESHNESS.UNKNOWN stay DISTINCT terms', () => {
  // "we measured, and the measurement is out of date" is not "we have never measured". Collapsing those
  // two is the same ambiguity the four UNKNOWN terms were split apart to remove, and the collapsed term
  // was even named FRESHNESS_UNKNOWN while being the target for a value that is not unknown-freshness.
  const stale = presentTerm('RS-201.FRESHNESS', 'STALE');
  const unknown = presentTerm('RS-201.FRESHNESS', 'UNKNOWN');
  assert.notEqual(stale, unknown, 'stale must not render as never-measured');
  assert.equal(stale, 'FRESHNESS_STALE');
  assert.equal(unknown, 'FRESHNESS_UNKNOWN');
  // Both are knowledge states, so neither is silently treated as current truth.
  assert.equal(TERM_CLASS[stale], 'KNOWLEDGE');
  assert.equal(TERM_CLASS[unknown], 'KNOWLEDGE');
  assert.notEqual(presentTerm('RS-201.FRESHNESS', 'FRESH'), stale);
  assert.equal(projectStatus({ termRefs: [termRef('RS-201.FRESHNESS', 'STALE')] }).degraded, true);
});

test('RS-290 F3: NO collapse of two meanings onto one term goes UNDECLARED - quantified over the table', () => {
  // The module claimed this property in its header and asserted it NOWHERE. The two tests that looked
  // like they covered it were spot checks - one hard-coded the four UNKNOWN senses, the other two named
  // same-spelling pairs - so a collapse anywhere else passed the whole suite 21/21, and one did.
  //
  // So the property is quantified over the entire table and stated honestly: a collapse is permitted
  // only when it is DECLARED with its reason, because coarsening a category is sometimes right (five
  // "unknown X" codes are one meaning to a UI) and that judgement should be visible rather than
  // implied. An undeclared collapse fails; a declaration with no collapse behind it fails too, so this
  // table cannot rot into a list of things that used to be true.
  const actual = new Map();
  for (const [source, table] of Object.entries(TERM_OF)) {
    const byTerm = new Map();
    for (const [word, term] of Object.entries(table)) {
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term).push(word);
    }
    for (const [term, words] of byTerm) {
      if (words.length > 1) actual.set(`${source} -> ${term}`, [...words].sort());
    }
  }

  const declared = new Set();
  for (const [source, collapses] of Object.entries(INTENDED_COLLAPSES)) {
    assert.ok(TERM_OF[source], `INTENDED_COLLAPSES names an unknown vocabulary ${source}`);
    for (const [term, reason] of Object.entries(collapses)) {
      const key = `${source} -> ${term}`;
      declared.add(key);
      assert.ok(typeof reason === 'string' && reason.length > 40, `${key} must carry a real reason, not a placeholder`);
      const words = actual.get(key);
      assert.ok(words, `${key} is declared as a collapse, but no two words in ${source} map to it`);
      assert.ok(words.length > 1, `${key} is declared as a collapse but only one word maps to it`);
    }
  }
  for (const [key, words] of actual) {
    assert.ok(declared.has(key), `${key} silently collapses ${words.join(', ')}; declare it in INTENDED_COLLAPSES with the reason it is one meaning at UI granularity`);
  }
  // The property is only meaningful if collapses actually exist to be judged - otherwise this test
  // would pass vacuously on an empty table.
  assert.ok(actual.size > 0, 'the table must exercise this property, not dodge it');
});

test('RS-290: no path FABRICATES success - COMPLETED needs an explicit terminal flag', () => {
  // Step 4 as an executable property: absence of bad news is not good news.
  assert.notEqual(projectStatus({ providerRefs: [termRef('RS-201.AVAILABILITY_REASONS', 'AVAILABLE')] }).state, 'COMPLETED');
  assert.notEqual(projectStatus({ termRefs: [] }).state, 'COMPLETED');
  assert.notEqual(projectStatus({ termRefs: [termRef('RS-201.AVAILABILITY_REASONS', 'AVAILABLE')], terminal: false }).state, 'COMPLETED');
  assert.equal(projectStatus({ terminal: true }).state, 'COMPLETED');
  assert.equal(projectStatus({ terminal: true, failed: true }).state, 'FAILED');
  assert.equal(projectStatus({ terminal: true, cancelled: true }).state, 'CANCELLED');
  const dto = projectStatus({ terminal: true });
  assert.equal(dto.from_backend_truth, true);
  assert.equal(dto.fabricated, false);
});

test('RS-290: the route stage drives the state through its own vocabulary, and only where it should', () => {
  assert.equal(projectStatus({ routeStageRef: termRef('RS-202.ROUTE_STAGES', 'QUEUED') }).state, 'QUEUED');
  assert.equal(projectStatus({ routeStageRef: termRef('RS-202.ROUTE_STAGES', 'ALTERNATE_DEVICE') }).state, 'REMOTE_HANDOFF');
  // Only the two stages that settle a state are folded. DIRECT is routing detail and must NOT override a
  // state the terms already determine - behaviour deliberately preserved from before the F1 repair, and
  // asserted because folding every stage would silently turn a refused run into a running one.
  const direct = projectStatus({
    routeStageRef: termRef('RS-202.ROUTE_STAGES', 'DIRECT'),
    termRefs: [termRef('RS-202.ELIGIBILITY_REASONS', 'USER_DISABLED')],
  });
  assert.equal(direct.state, 'DEGRADED', 'a DIRECT stage must not make a refused run look live');
});

test('RS-290: every DTO output is inside the declared vocabularies', () => {
  const states = new Set(PRESENTATION_STATES);
  const actions = new Set(ALLOWED_ACTIONS);
  const inputs = [
    { providerRefs: [termRef('RS-201.AVAILABILITY_REASONS', 'AVAILABLE')] },
    { providerRefs: [termRef('RS-202.ELIGIBILITY_REASONS', 'AT_CAPACITY')] },
    { providerRefs: [termRef('RS-201.AVAILABILITY_REASONS', 'USER_DISABLED')] },
    { termRefs: [termRef('RS-201.FRESHNESS', 'UNKNOWN')] },
    { termRefs: [termRef('RS-201.FRESHNESS', 'STALE')] },
    { routeStageRef: termRef('RS-202.ROUTE_STAGES', 'QUEUED') },
    { routeStageRef: termRef('RS-202.ROUTE_STAGES', 'ALTERNATE_DEVICE') },
    { waitingUser: true }, { terminal: true }, { terminal: true, failed: true },
    { terminal: true, cancelled: true }, { terminal: true, failed: true, waitingUser: true },
  ];
  for (const input of inputs) {
    const dto = projectStatus(input);
    assert.ok(states.has(dto.state), `${JSON.stringify(input)} gave undeclared state ${dto.state}`);
    for (const action of dto.actions) assert.ok(actions.has(action), `undeclared action ${action}`);
    assert.equal(dto.provider_choice_taken, false, 'the DTO must never record a choice it did not make');
  }
});
