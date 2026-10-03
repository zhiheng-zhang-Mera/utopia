// UXI-301: the scheduler presentation FEED producer.
//
// The producer exists because the RS-290 contract shipped with a test suite and NO consumer anywhere in
// the repository - nothing called `projectStatus`, so no DTO existed for a UI to present. These tests
// cover the producer, including the two defects a probe found in its first version.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESENTATION_FEED_VERSION, buildPresentationFeed, candidateFromNode, eligibilityFor, loadFromTelemetry, routePlanFor,
  projectTaskStatus, termsInUse,
} from '../services/dev-gateway/presentation.mjs';
import {TERMS, TERM_CLASS} from '../contracts/rs-presentation-contract-v1/presentation.mjs';
import {ELIGIBILITY_REASONS} from '../city/00-foundation/01-city-core/fleet-routing/pressure.mjs';

const node = (id, telemetry, extra = {}) => ({id, online: true, telemetry, ...extra});
const healthy = (id = 'healthy') => node(id, {cpu: {usagePercent: 19.7}, memory: {usedBytes: 22.4e9, totalBytes: 31.8e9}});
const hot = (id = 'hot') => node(id, {cpu: {usagePercent: 99.2}, memory: {usedBytes: 31e9, totalBytes: 31.8e9}});
const offline = (id = 'offline') => ({id, online: false, telemetry: {cpu: {usagePercent: 5}, memory: {usedBytes: 1e9, totalBytes: 8e9}}});

/* ------------------------------------------------------------------ telemetry -> load */

test('UXI-301 feed: real telemetry becomes a load vector, and unmeasured dimensions stay missing', () => {
  assert.deepEqual(loadFromTelemetry({cpu: {usagePercent: 50}, memory: {usedBytes: 1, totalBytes: 4}}), {cpu: 0.5, memory: 0.25});
  // Nothing measurable is null, not a zeroed vector: zeros would render an unmeasured node as IDLE,
  // which is a fabricated reassurance.
  assert.equal(loadFromTelemetry(null), null);
  assert.equal(loadFromTelemetry({}), null);
  assert.equal(loadFromTelemetry({cpu: {usagePercent: null}}), null);
  // Out-of-range and malformed values are refused rather than clamped into a plausible-looking number.
  assert.equal(loadFromTelemetry({cpu: {usagePercent: 140}}), null);
  assert.equal(loadFromTelemetry({cpu: {usagePercent: -1}}), null);
  assert.equal(loadFromTelemetry({memory: {usedBytes: 5, totalBytes: 0}}), null);
  assert.equal(loadFromTelemetry({memory: {usedBytes: 9, totalBytes: 4}}), null);
  // Exactly one dimension is enough for RS-202 (its minimum observed is one).
  assert.deepEqual(loadFromTelemetry({cpu: {usagePercent: 10}}), {cpu: 0.1});
});

test('UXI-301 feed: disk CAPACITY is not reported as io LOAD', () => {
  // The telemetry carries disk used/free/total BYTES. Reporting capacity as `io` would be inventing a
  // measurement, so `io` must stay absent while cpu and memory are present.
  const load = loadFromTelemetry({cpu: {usagePercent: 10}, memory: {usedBytes: 1, totalBytes: 2}, disk: {usedBytes: 90, freeBytes: 10, totalBytes: 100}});
  assert.deepEqual(Object.keys(load).sort(), ['cpu', 'memory']);
  assert.equal('io' in load, false);
});

/* --------------------------------------------------------------- node -> candidate */

test('UXI-301 feed: the node mapping mirrors the gateway liveness truth', () => {
  // UXI-391 extends this exact shape with `enablement`, and the extension is the fix rather than a detail:
  // RS-202 refuses anything that is not an EXPLICIT ENABLED, so a mapping that omitted the field made every
  // device unplaceable on the route path while the presentation term still read SELECTABLE. The shape is
  // asserted in full on purpose - that is what makes an omission here a test failure instead of a silent
  // production bug.
  assert.deepEqual(candidateFromNode({id: 'n', online: true}), {deviceRef: 'n', device: {state: 'READY', presence: 'ONLINE'}, enablement: 'ENABLED', load: null});
  assert.deepEqual(candidateFromNode({id: 'n', online: false}).device, {state: 'OFFLINE', presence: 'OFFLINE'});
  // A node that is not explicitly online is OFFLINE, the same fail-closed rule the Core applies.
  assert.equal(candidateFromNode({id: 'n'}).device.state, 'OFFLINE');
  assert.equal(candidateFromNode({id: 'n', online: 'yes'}).device.state, 'OFFLINE');
});

test('UXI-391: the candidate carries an EXPLICIT enablement, and an explicit disable is honoured', () => {
  // The default exists because this City keeps no per-node disable state - not because consent is assumed.
  assert.equal(candidateFromNode({id: 'n', online: true}).enablement, 'ENABLED');
  // If the City ever gains a disable flag, the mapping must READ it rather than keep the default, and RS-202
  // must then refuse the device. This is the assertion that fails the day the default starts swallowing it.
  assert.equal(candidateFromNode({id: 'n', online: true, enablement: 'DISABLED'}).enablement, 'DISABLED');
  const refused = eligibilityFor(candidateFromNode({id: 'n', online: true, enablement: 'DISABLED'}));
  assert.equal(refused.eligible, false, 'an explicitly disabled device must not be eligible');
  assert.equal(refused.reason, 'USER_DISABLED');
  // And the route path must reach the SAME verdict as the term path, because the defect was exactly that the
  // two disagreed about one candidate.
  const routed = routePlanFor({
    // switchDeclined is required for the planner to reach stage 3 at all: without the user's decline it
    // stops at SWITCH_OFFERED, which is the offer rather than the handoff. My first version of this test
    // asserted QUEUED without it and failed - correctly, and for the right reason.
    task: {id: 't', state: 'RUNNING', assignedNodeId: 'a', switchDeclined: true},
    candidates: [candidateFromNode({id: 'a', online: false}), candidateFromNode({id: 'b', online: true, enablement: 'DISABLED'})],
  });
  assert.equal(routed.stage, 'QUEUED', 'with the only alternate disabled, the planner must queue rather than hand off');
  assert.equal(routed.chosenDeviceRef, null);
});

/* --------------------------------------------------------------------- eligibility */

test('UXI-301 feed: eligibility terms come from RS-202 and are all declared in the contract', () => {
  const cases = [
    [healthy(), 'ELIGIBLE', 'SELECTABLE'],
    [hot(), 'PRESSURE_PAUSED', 'PRESSURE_PAUSED'],
    [offline(), 'REFUSING_WORK', 'DEVICE_REFUSING'],
    [node('n', null), 'LOAD_UNKNOWN', 'LOAD_UNMEASURED'],
  ];
  for (const [n, expectedReason, expectedTerm] of cases) {
    const got = eligibilityFor(candidateFromNode(n));
    assert.equal(got.reason, expectedReason, `${n.id} raw reason`);
    // The MAPPED term, not ref.word: ref.word is the raw RS-202 source word and this test learned the
    // distinction the hard way, by asserting ref.word and expecting the mapped term.
    assert.equal(got.term, expectedTerm, `${n.id} mapped term`);
  }
  // Every term this producer can emit is a declared contract term with a class.
  for (const n of [healthy(), hot(), offline(), node('n', null)]) {
    const {term, ref} = eligibilityFor(candidateFromNode(n));
    assert.ok(TERMS.includes(term), `${term} is not a declared term`);
    assert.ok(TERM_CLASS[term], `${term} has no class`);
    // `ref.word` is the RAW RS-202 source word - it must belong to that vocabulary, and it is NOT the
    // mapped term. Asserting identity here was my mistake: ELIGIBLE is a legitimate raw word whose
    // mapped term is SELECTABLE, which is precisely the distinction the two keys exist to keep apart.
    assert.ok(ELIGIBILITY_REASONS.includes(ref.word), `ref.word ${ref.word} is not an RS-202 reason`);
    assert.equal(ref.source, 'RS-202.ELIGIBILITY_REASONS');
  }
  const healthyRef = eligibilityFor(candidateFromNode(healthy()));
  assert.equal(healthyRef.ref.word, 'ELIGIBLE');
  assert.equal(healthyRef.term, 'SELECTABLE');
  assert.notEqual(healthyRef.ref.word, healthyRef.term, 'raw word and mapped term must be distinguishable here');
  // User disablement is a refusal whatever the device says.
  assert.equal(eligibilityFor(candidateFromNode(healthy()), {enablement: 'DISABLED'}).term, 'USER_DISABLED');
  assert.equal(eligibilityFor(candidateFromNode(healthy()), {enablement: null}).term, 'USER_DISABLED');
});

/* --------------------------- REGRESSION: the fabricated-alarm defect a probe found */

test('UXI-301 feed: an ONLINE, healthy node must NOT present as unusable', () => {
  // The first version of the producer passed load:null on the grounds that the City has no
  // five-dimension vector. A probe showed the consequence: RS-202 classifies unmeasured load as
  // LOAD_UNKNOWN, LOAD_UNKNOWN is not eligible, so a healthy online node presented as unusable with
  // KEEP_WAITING and CHOOSE_PROVIDER - a fabricated ALARM, the mirror of a fabricated reassurance.
  // This test is the guard: with real telemetry the healthy node is SELECTABLE.
  const dto = projectTaskStatus({task: {id: 't', state: 'RUNNING'}, candidates: [candidateFromNode(healthy())]});
  const provider = dto.providers[0];
  assert.equal(provider.term, 'SELECTABLE', 'a healthy measured node must present as selectable');
  assert.equal(provider.selectable, true);
  assert.equal(dto.provider_choice_required, false, 'a usable provider must not demand a choice');
  assert.equal(dto.structural_refusal, false);
  // And the contrast: with NO telemetry the same node is honestly reported as still measuring.
  const blind = projectTaskStatus({task: {id: 't', state: 'RUNNING'}, candidates: [candidateFromNode(node('n', null))]});
  assert.equal(blind.providers[0].term, 'LOAD_UNMEASURED');
});

/* ------------------------------------------------------------------- task projection */

test('UXI-301 feed: COMPLETED is reachable ONLY from a terminal City state', () => {
  for (const state of ['QUEUED', 'RUNNING', 'WEIRD', '']) {
    const dto = projectTaskStatus({task: {id: 't', state}, candidates: [candidateFromNode(healthy())]});
    assert.notEqual(dto.state, 'COMPLETED', `${state} must not present as completed`);
  }
  assert.equal(projectTaskStatus({task: {id: 't', state: 'COMPLETED'}, candidates: []}).state, 'COMPLETED');
  assert.equal(projectTaskStatus({task: {id: 't', state: 'FAILED'}, candidates: []}).state, 'FAILED');
  assert.equal(projectTaskStatus({task: {id: 't', state: 'CANCELLED'}, candidates: []}).state, 'CANCELLED');
  assert.equal(projectTaskStatus({task: {id: 't', state: 'COMPLETED'}, candidates: []}).fabricated, false);
  assert.equal(projectTaskStatus({task: {id: 't', state: 'COMPLETED'}, candidates: []}).from_backend_truth, true);
});

test('UXI-301 feed: a healthy node plus a cold one offers waiting, never a forced choice', () => {
  const dto = projectTaskStatus({task: {id: 't', state: 'RUNNING'}, candidates: [candidateFromNode(healthy()), candidateFromNode(node('blind', null))]});
  assert.equal(dto.providers[0].selectable, true);
  assert.equal(dto.providers[1].selectable, false);
  assert.ok(dto.actions.includes('KEEP_WAITING'), 'an unmeasured candidate is a resource wait');
  assert.equal(dto.provider_choice_required, false, 'a usable provider means no decision is required');
});

test('UXI-301 feed: a structurally refused fleet DOES demand a choice and withholds waiting', () => {
  // A structural refusal cannot be fixed by waiting, which is the distinction RS-202's class carries.
  const dto = projectTaskStatus({task: {id: 't', state: 'RUNNING'}, candidates: [candidateFromNode(offline()), candidateFromNode(node('off', null, {online: false}))]});
  assert.equal(dto.providers.every((p) => !p.selectable), true);
  assert.equal(dto.structural_refusal, true);
  assert.equal(dto.provider_choice_required, true);
  assert.equal(dto.actions.includes('KEEP_WAITING'), false, 'waiting cannot fix a structural refusal');
  assert.ok(dto.actions.includes('CHOOSE_PROVIDER'));
});

test('UXI-301 feed: the producer rejects malformed input rather than guessing', () => {
  assert.throws(() => projectTaskStatus({}), /requires a task/);
  assert.throws(() => projectTaskStatus({task: null}), /requires a task/);
});

/* ------------------------------------------------------------------------- the feed */

test('UXI-301 feed: the feed is versioned, lists its candidates, and hides finished work by default', () => {
  const feed = buildPresentationFeed({
    tasks: [{id: 'run', state: 'RUNNING'}, {id: 'q', state: 'QUEUED'}, {id: 'done', state: 'COMPLETED'}],
    nodes: [healthy('a'), offline('b')],
    generatedAt: '2026-10-02T00:00:00.000Z',
  });
  assert.equal(feed.presentation_feed_version, PRESENTATION_FEED_VERSION);
  assert.deepEqual(feed.candidates, ['a', 'b']);
  assert.deepEqual(feed.tasks.map((t) => t.taskId), ['run', 'q'], 'a scheduler surface is about work in flight');
  assert.equal(feed.generatedAt, '2026-10-02T00:00:00.000Z');
  const all = buildPresentationFeed({tasks: [{id: 'done', state: 'COMPLETED'}], nodes: [], includeTerminal: true});
  assert.deepEqual(all.tasks.map((t) => t.taskId), ['done'], 'finished work is available when asked for');
  assert.ok(Object.isFrozen(feed) && Object.isFrozen(feed.tasks));
});

test('UXI-301 feed: termsInUse reports only declared terms, so a UI can preload copy', () => {
  const feed = buildPresentationFeed({tasks: [{id: 'a', state: 'RUNNING'}, {id: 'b', state: 'QUEUED'}], nodes: [healthy(), hot(), offline()]});
  const terms = termsInUse(feed);
  assert.ok(terms.length > 0);
  const undeclared = terms.filter((t) => !TERMS.includes(t));
  assert.deepEqual(undeclared, [], 'the feed produced a term the contract does not declare');
});

test('UXI-301 feed: an empty City produces an empty feed rather than a fabricated status', () => {
  const feed = buildPresentationFeed({tasks: [], nodes: []});
  assert.deepEqual([...feed.tasks], []);
  assert.deepEqual([...feed.candidates], []);
  assert.deepEqual(termsInUse(feed), []);
});

/* ------------------------------------------------- real capacity pressure (the device-busy case) */

test('UXI-301 feed: a node already running OTHER work reports real capacity pressure', () => {
  // RS-202's session ceiling is 1, and the producer used to pass sessionConcurrency 0 always, so the
  // ceiling could never be reached and a saturated node was never reported as busy - the workbook's named
  // "device busy" condition was unreachable through the real feed. The count now comes from the City's own
  // task store, so this is real state rather than an invented number.
  const feed = buildPresentationFeed({
    tasks: [
      {id: 'running', state: 'RUNNING', assignedNodeId: 'n1'},
      {id: 'waiting', state: 'QUEUED', assignedNodeId: null},
    ],
    nodes: [healthy('n1')],
  });
  const running = feed.tasks.find((e) => e.taskId === 'running');
  const waiting = feed.tasks.find((e) => e.taskId === 'waiting');
  // A task's OWN node must not look unavailable to the run occupying it: counting itself made running
  // work render as QUEUED, which is a false report about a running task.
  assert.equal(running.dto.providers[0].term, 'SELECTABLE', 'a run must not be blocked by its own occupancy');
  assert.notEqual(running.dto.state, 'QUEUED', 'a running task must not be reported as queued');
  // A DIFFERENT task sees the node as genuinely at capacity.
  assert.equal(waiting.dto.providers[0].term, 'AT_CAPACITY', 'a node already running work is busy to everyone else');
  assert.equal(waiting.dto.providers[0].selectable, false);
  assert.equal(waiting.dto.state, 'QUEUED');
});

test('UXI-301 feed: capacity pressure clears once the other work finishes', () => {
  const busy = buildPresentationFeed({
    tasks: [{id: 'a', state: 'RUNNING', assignedNodeId: 'n1'}, {id: 'b', state: 'QUEUED'}],
    nodes: [healthy('n1')],
  });
  const idle = buildPresentationFeed({
    tasks: [{id: 'a', state: 'COMPLETED', assignedNodeId: 'n1'}, {id: 'b', state: 'QUEUED'}],
    nodes: [healthy('n1')],
  });
  assert.equal(busy.tasks.find((e) => e.taskId === 'b').dto.providers[0].term, 'AT_CAPACITY');
  assert.equal(idle.tasks.find((e) => e.taskId === 'b').dto.providers[0].term, 'SELECTABLE',
    'a finished task must not keep its node loaded');
});

test('UXI-301 feed: two busy nodes and one free node is reported truthfully per node', () => {
  const feed = buildPresentationFeed({
    tasks: [
      {id: 'a', state: 'RUNNING', assignedNodeId: 'n1'},
      {id: 'b', state: 'RUNNING', assignedNodeId: 'n2'},
      {id: 'c', state: 'QUEUED'},
    ],
    nodes: [healthy('n1'), healthy('n2'), healthy('n3')],
  });
  const c = feed.tasks.find((e) => e.taskId === 'c');
  const byIndex = c.dto.providers.map((p) => p.term);
  assert.deepEqual(byIndex, ['AT_CAPACITY', 'AT_CAPACITY', 'SELECTABLE'], 'the free node must remain usable');
});
