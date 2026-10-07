// REX-807 acceptance: tests/rex807-surface.test.mjs
//
// The workbook names what must be verified: Home/Ask/Devices are not drowned by research controls; research does not
// require a console or raw API to use; high-impact fault controls cannot be triggered by accident; raw identifiers are
// folded by default; errors, exclusions and incomplete metrics stay visible; and the technical layer is available when
// needed. Each test below is a way that layering usually fails - a summary that leaks a UUID into the primary label, a
// diagnostic that disappears, a Danger Zone item that opens by default - written so it fails if the failure returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SURFACE_LEVELS, assertPrimarySurfacesClean, researchMarkup, researchView, summariseRun} from '../apps/web/research-surface.js';
import {renderResearch} from '../apps/web/research.js';

const UUIDS = ['campaign-4f1c2b7e-9a3d-4e5f-8b21-0c7d6e5f4a3b', 'campaign-8d2e4f61-1b2c-4d3e-9f40-aa11bb22cc33'];
const payload = {
  experiments: [
    {experimentId: UUIDS[0], question: 'Does strict routing preserve target identity?', status: 'REGISTERED', topology: 'TWO_HOST_MESH', repetitions: 3},
    {experimentId: UUIDS[1], question: 'Is a repetition a real canonical task?', status: 'REGISTERED', topology: 'SINGLE_CITY', repetitions: 1},
  ],
  live: {campaignId: UUIDS[0], scenarioId: 'WAIT', state: 'RUNNING', summary: {planned: 3, measured: 1, failed: 0}},
  metrics: {notMeasured: [{metric: 'intervention_count', reason: 'NOT_MEASURED: no owner intervention was recorded'}]},
};

test('REX807 S1: the primary labels are human summaries, and raw identifiers are folded into Diagnostics', () => {
  const view = researchView(payload, {locale: 'en'});
  const experiments = view.sections.find(section => section.id === 'experiments');
  for (const item of experiments.items) {
    assert.ok(!item.summary.includes('campaign-'), `a UUID leaked into the primary label: ${item.summary}`);
    assert.ok(item.summary.length > 10, 'the summary must say something');
    assert.ok(UUIDS.includes(item.id), 'the identifier is still carried, just not as the label');
  }
  const diagnostics = view.sections.find(section => section.id === 'diagnostics');
  assert.equal(diagnostics.collapsed, true, 'exact manifests belong in a collapsed technical layer');
  assert.ok(diagnostics.items.some(item => item.value.includes(UUIDS[0])), 'the raw record is available when opened');
  assert.ok(!view.defaultOpen.includes('diagnostics'), 'and it must not be open by default');
});

test('REX807 S2: fault injection is a Danger Zone control that requires confirmation and is not open by default', () => {
  const view = researchView({...payload, faults: [{faultId: 'fault-1', kind: 'NODE_OFFLINE'}]}, {locale: 'en'});
  const danger = view.sections.find(section => section.id === 'advanced-faults');
  assert.equal(danger.level, SURFACE_LEVELS.ADVANCED_CONTROL);
  assert.equal(danger.requiresConfirmation, true, 'a real fault injection must be confirmed');
  assert.equal(danger.collapsed, true);
  assert.match(danger.confirmation, /campaign id/i, 'the confirmation must be concrete, not a generic OK');
  assert.ok(view.confirmationRequired.includes('advanced-faults'));
  assert.ok(!view.defaultOpen.includes('advanced-faults'), 'the Danger Zone is never open by default');
});

test('REX807 S3: errors, exclusions and incomplete metrics stay visible with their reasons', () => {
  const view = researchView({
    ...payload,
    storeState: 'UNAVAILABLE',
    storeReason: 'SQLITE_BUSY',
    broken: [{experimentId: UUIDS[1], reason: 'CORRUPT_RECORD'}],
    exclusions: [{campaignId: UUIDS[0], reason: 'TOPOLOGY_NOT_READY'}],
  }, {locale: 'en'});
  const byId = Object.fromEntries(view.alerts.map(alert => [alert.id, alert]));
  assert.equal(byId['store-unavailable'].visible, true);
  assert.equal(byId['store-unavailable'].role, 'alert');
  assert.match(byId['store-unavailable'].detail, /SQLITE_BUSY/);
  assert.ok(Object.keys(byId).some(key => key.startsWith('broken-')), 'a broken record is reported, not dropped');
  assert.ok(Object.keys(byId).some(key => key.startsWith('exclusion-')), 'an exclusion is reported');
  assert.equal(byId['metrics-incomplete'].visible, true);
  assert.match(byId['metrics-incomplete'].detail, /intervention_count/);
  // The incomplete run is called out in words as well as numbers.
  assert.ok(Object.keys(byId).includes('run-incomplete'), 'an unfinished run must be stated');
  assert.match(byId['run-incomplete'].message, /2 planned repetition/);
});

test('REX807 S4: a payload field this view does not place is reported, never silently dropped', () => {
  const view = researchView({...payload, brandNewGatewayField: {anything: true}, anotherOne: 7}, {locale: 'en'});
  const diagnostics = view.sections.find(section => section.id === 'diagnostics');
  assert.deepEqual(diagnostics.unmappedFields, ['anotherOne', 'brandNewGatewayField']);
  assert.match(diagnostics.note, /brandNewGatewayField/);
});

test('REX807 S5: the research entry is secondary and the primary surfaces stay clean', () => {
  const view = researchView(payload, {locale: 'en', primarySurfaces: ['home', 'ask', 'devices']});
  assert.equal(view.entry.level, 'SECONDARY', 'research is reachable but not a primary surface');
  assert.equal(view.entry.section, 'advanced');
  const direct = view.sections.filter(section => section.level === SURFACE_LEVELS.DIRECT_CONTROL).map(section => section.id);
  assert.deepEqual(direct, ['experiments', 'replay-export'], 'direct controls are grouped, not scattered across the page');
  assertPrimarySurfacesClean(view);
  assert.throws(() => assertPrimarySurfacesClean(view, {primarySurfaces: ['home', 'research']}), /PRIMARY_SURFACE_POLLUTED/);
});

test('REX807 S6: nothing INTERNAL_ONLY is rendered as a user control', () => {
  const view = researchView(payload, {locale: 'en'});
  for (const section of view.sections) {
    if (section.level !== SURFACE_LEVELS.INTERNAL_ONLY) continue;
    for (const control of section.controls ?? []) assert.fail(`an internal section exposed a control: ${control.id}`);
  }
  const controls = view.sections.flatMap(section => section.controls ?? []);
  assert.ok(controls.length >= 5, 'the direct controls the workbook names must exist');
  for (const control of controls.filter(entry => entry.level === SURFACE_LEVELS.ADVANCED_CONTROL)) {
    assert.equal(control.requiresConfirmation, true);
  }
  // Start is offered only when nothing is running; Stop only while something is.
  const experiments = view.sections.find(section => section.id === 'experiments');
  const start = experiments.controls.find(control => control.id === 'start');
  const stop = experiments.controls.find(control => control.id === 'stop');
  assert.equal(start.enabled, false, 'a run is live, so Start is not offered');
  assert.equal(stop.enabled, true, 'a run is live, so Stop is offered');
});

test('REX807 S7: the same payload renders in zh-CN with real translation, not English fallback', () => {
  const view = researchView(payload, {locale: 'zh-CN'});
  const experiments = view.sections.find(section => section.id === 'experiments');
  assert.match(experiments.title, /[\u4e00-\u9fff]/, 'section titles must be localised');
  assert.match(view.entry.label, /[\u4e00-\u9fff]/);
  assert.match(view.sections.find(section => section.id === 'advanced-faults').confirmation, /[\u4e00-\u9fff]/);
  // A run summary keeps its numbers and translates its words.
  const run = summariseRun(payload.live, 'zh-CN');
  assert.equal(run.progress, '1/3');
  assert.match(run.note, /[\u4e00-\u9fff]/);
  assert.equal(summariseRun(payload.live, 'en').note.includes('planned repetition'), true);
});

// The rendered page, not just the view model: the layer has to survive into the markup the browser receives, and the
// page's own render path has to run. The harness therefore memoises nodes in one shared registry, so the page's
// identity check passes and the properties it sets can be read back afterwards. (This harness took three corrections
// of its own: a stub without querySelector, a non-memoised stub that made show() return early, and a missing
// querySelectorAll - each one recorded rather than quietly fixed.)
const makeHarness = () => {
  const registry = new Map();
  const stubNode = () => ({
    style: {}, dataset: {}, innerHTML: '', textContent: '', disabled: false, isConnected: true, _show: null,
    querySelector(selector) { if (!registry.has(selector)) registry.set(selector, stubNode()); return registry.get(selector); },
    querySelectorAll() { return []; }, append() {}, remove() {},
    parentElement: {firstChild: {textContent: ''}, append() {}},
    set onclick(value) {}, set oninput(value) {}, set onchange(value) {},
    get onclick() { return null; }, get oninput() { return null; }, get onchange() { return null; },
  });
  const root = stubNode();
  let html = '';
  return {
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value); },
    querySelector(selector) { return selector === '#research-shell' ? root : (registry.get(selector) ?? null); },
    contains() { return true; },
    node: selector => registry.get(selector),
  };
};
const fakeContainer = makeHarness;

test('REX807 S8: the rendered page folds identifiers, keeps the technical layer collapsed, and surfaces alerts', async () => {
  const container = fakeContainer();
  const api = async path => {
    if (path === 'research/experiments') return {experiments: [{experimentId: UUIDS[0], question: 'Does strict routing preserve target identity?', status: 'REGISTERED', topology: 'TWO_HOST_MESH', repetitions: 3}], storeState: 'UNAVAILABLE', storeReason: 'SQLITE_BUSY', research: {capabilityVocabulary: ['research.evidence.review']}};
    if (path === 'research/campaigns') return {live: {campaignId: UUIDS[0], scenarioId: 'WAIT', state: 'RUNNING', summary: {planned: 3, measured: 1, failed: 0}}};
    return {};
  };
  renderResearch(container, true, api, 'test-context');
  await new Promise(resolve => setTimeout(resolve, 20));
  const shell = container.innerHTML;
  // The render path really executed (the memoised stubs make the page's own identity check pass) and left the page
  // usable: a page error inside show() used to leave every control disabled, which is what this asserts against.
  assert.equal(container.node('#research-register')?.disabled, false, 'the register control must be enabled after the data arrives');
  assert.equal(container.node('#research-manifest')?.disabled, false, 'the manifest editor must be enabled');
  assert.match(container.node('#research-alerts')?.innerHTML ?? '', /role="alert"/, 'the storage outage is rendered as an alert');
  assert.match(container.node('#research-vocabulary')?.textContent ?? '', /capabilityVocabulary/, 'the vocabulary disclosure stays part of the page');
  // The page is layered, and the technical layer is present but NOT open.
  for (const id of ['research-direct', 'research-runs', 'research-metrics', 'research-technical']) assert.match(shell, new RegExp(`id="${id}"`), `${id} must exist`);
  assert.ok(!/<details id="research-technical" open>/.test(shell), 'the technical layer must not be open by default');
  assert.match(shell, /id="research-direct" open/, 'the direct controls are the open one');
  // The fragments the page renders, asserted directly: the identifier is a title attribute, never the label.
  const view = researchView({experiments: [{experimentId: UUIDS[0], question: 'Does strict routing preserve target identity?', status: 'REGISTERED', repetitions: 3}], live: {campaignId: UUIDS[0], scenarioId: 'WAIT', state: 'RUNNING', summary: {planned: 3, measured: 1}}}, {locale: 'en'});
  const markup = researchMarkup(view, {locale: 'en'});
  assert.match(markup.list, /Does strict routing preserve target identity\?/, 'the label is the question');
  // The identifier travels as an ATTRIBUTE (the click handler needs it) but never as visible text. Stripping every
  // attribute value is the honest test: `indexOf` alone would flag the attribute's own position, not the label.
  const visibleText = markup.list.replace(/="[^"]*"/g, '=""');
  assert.ok(!visibleText.includes(UUIDS[0]), `the identifier must not be visible text: ${visibleText}`);
  assert.match(markup.list, new RegExp(`data-experiment="${UUIDS[0]}"`), 'the identifier is still carried for the handler');
  assert.ok(markup.technical.includes(UUIDS[0]), 'the exact record is available in the technical fragment');
  assert.match(markup.run, /1\/3/);
  assert.match(markup.run, /2 planned repetition/, 'an unfinished run is stated in words');
});

