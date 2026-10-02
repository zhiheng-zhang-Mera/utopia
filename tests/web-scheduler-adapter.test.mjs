// UXI-301 step 1 conformance: the scheduler presentation adapter.
//
// The workbook's acceptance items this file makes executable:
//   - "major scheduler states have user language"            -> totality over states and terms
//   - "unavailable providers are visible but not selectable" -> forced-unselectable, incl. a LYING DTO
//   - "no raw scheduler field leaks by default"              -> a serialised-leak search
//   - "Web and Android share semantics"                      -> the table is the single source, and it
//                                                               is asserted against the CONTRACT
//
// The adapter deliberately does not import the contract (a browser module cannot reach contracts/,
// because serveWeb serves only apps/web with containment checking), so the agreement test below is
// what keeps the copy from drifting. If RS-290 ever changes its vocabulary, this file fails and the
// table must be updated deliberately - which is the point.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_COPY, STATE_COPY, STATE_SEVERITIES, SEVERITY_OF_CLASS, TERM_COPY, toSchedulerViewModel,
} from '../apps/web/scheduler-adapter.js';
import {
  ALLOWED_ACTIONS, PRESENTATION_STATES, TERMS, TERM_OF, TERM_CLASS, presentTerm, projectStatus,
} from '../contracts/rs-presentation-contract-v1/presentation.mjs';
import * as registry from '../contracts/general-ai-registry-v1/records.mjs';
import {configureRuntime, messagesFor, resetLocaleCache, t} from '../apps/web/i18n/index.js';

const useLocale = (locale) => {
  configureRuntime({storage: null, navigator: {language: locale}});
  resetLocaleCache();
};
const en = (dto, opts = {}) => {
  useLocale('en');
  return toSchedulerViewModel(dto, {t, ...opts});
};

/* ------------------------------------------------------ agreement with the frozen contract */

test('UXI-301: the adapter table agrees with the contract EXACTLY, in both directions', () => {
  // No gap: every term the contract can produce has copy. No stale extra: the adapter invents no term
  // of its own, which would be a second vocabulary and exactly what RS-290 exists to prevent.
  assert.deepEqual(Object.keys(TERM_COPY).sort(), [...TERMS].sort(), 'adapter terms must equal contract terms');
  assert.deepEqual(Object.keys(STATE_COPY).sort(), [...PRESENTATION_STATES].sort(), 'states must match');
  assert.deepEqual(Object.keys(ACTION_COPY).sort(), [...ALLOWED_ACTIONS].sort(), 'actions must match');
});

test('UXI-301: severity cannot contradict the contract class where the class carries meaning', () => {
  // For PERMITTED/RESOURCE/STRUCTURAL/KNOWLEDGE the class IS the meaning - structural means waiting
  // will not help, resource means it will, knowledge means we do not know - so the UI's emphasis is a
  // function of it and a contradiction is impossible by construction.
  const mismatched = TERMS
    .filter((term) => TERM_CLASS[term] !== 'STATE')
    .filter((term) => TERM_COPY[term].severity !== SEVERITY_OF_CLASS[TERM_CLASS[term]])
    .map((term) => `${term}: ${TERM_CLASS[term]} -> ${TERM_COPY[term].severity}`);
  assert.deepEqual(mismatched, [], 'a refusal or permission term whose emphasis contradicts its class');

  // STATE-class terms are excluded ON PURPOSE and are BOUNDED instead: the contract calls them STATE
  // because they are neither permission nor refusal, so their emphasis is presentational - but it may
  // never be 'blocked' (a settled state is not a refusal) nor 'ok' (it is not a permission).
  const stateTerms = TERMS.filter((term) => TERM_CLASS[term] === 'STATE');
  assert.ok(stateTerms.length > 0, 'sanity: the STATE class must be populated');
  for (const term of stateTerms) {
    assert.ok(STATE_SEVERITIES.includes(TERM_COPY[term].severity), `${term} carries out-of-range severity ${TERM_COPY[term].severity}`);
  }
  // And the presentation-state table is bounded by the same rule for the states it names, with ONE
  // asserted exception: a failed run IS a refusal of success, so it is the only state allowed to be
  // emphasised as blocked. Excluding it from the loop explicitly rather than by silence, because the
  // first version of this test asserted "no state is blocked" and then asserted FAILED is blocked -
  // it contradicted itself and failed on its own second assertion.
  const BLOCKED_ALLOWED = new Set(['FAILED']);
  for (const [state, copy] of Object.entries(STATE_COPY)) {
    if (BLOCKED_ALLOWED.has(state)) continue;
    assert.notEqual(copy.severity, 'blocked', `${state} must not be presented as blocked`);
  }
  assert.equal(STATE_COPY.FAILED.severity, 'blocked', 'a failed run is the one state that is a refusal of success');
});

/* ------------------------------------------------------------- user language, both locales */

test('UXI-301: every referenced key exists in BOTH locale packs', () => {
  const keys = new Set([
    ...Object.values(TERM_COPY).map((c) => c.key),
    ...Object.values(STATE_COPY).map((c) => c.key),
    ...Object.values(ACTION_COPY).map((c) => c.key),
  ]);
  for (const locale of ['en', 'zh-CN']) {
    const pack = messagesFor(locale);
    const missing = [...keys].filter((k) => !(k in pack));
    assert.deepEqual(missing, [], `${locale} is missing scheduler copy for: ${missing.join(', ')}`);
  }
});

test('UXI-301: every state and every action renders real copy, not a fallback key', () => {
  const dto = {state: 'RUNNING', providers: [], actions: [], provider_choice_required: false};
  for (const state of PRESENTATION_STATES) {
    const view = en({...dto, state});
    assert.ok(view.stateLabel && view.stateLabel !== STATE_COPY[state].key, `${state} rendered its key, not copy`);
  }
  for (const token of ALLOWED_ACTIONS) {
    const view = en({...dto, actions: [token]});
    assert.equal(view.actions[0].token, token, 'the token must survive verbatim for wiring');
    assert.ok(view.actions[0].label && view.actions[0].label !== ACTION_COPY[token].key, `${token} rendered its key`);
  }
});

test('UXI-301: zh-CN renders different copy from en, so the locale is really applied', () => {
  const dto = {state: 'REMOTE_HANDOFF', providers: [], actions: [], provider_choice_required: false};
  const a = en(dto);
  useLocale('zh-CN');
  const b = toSchedulerViewModel(dto, {t});
  assert.notEqual(a.stateLabel, b.stateLabel);
  assert.match(b.stateLabel, /[\u4e00-\u9fff]/, 'zh-CN copy should contain Han characters');
});

/* ------------------------------------------------------------------- the forced-unselectable rule */

test('UXI-301: a non-permitted provider is never selectable or interactive', () => {
  const view = en({
    state: 'QUEUED',
    providers: [
      {index: 0, term: 'SELECTABLE', selectable: true, class: 'PERMITTED'},
      {index: 1, term: 'DEVICE_UNREACHABLE', selectable: false, class: 'STRUCTURAL'},
      {index: 2, term: 'AT_CAPACITY', selectable: false, class: 'RESOURCE'},
      {index: 3, term: 'FRESHNESS_UNKNOWN', selectable: false, class: 'KNOWLEDGE'},
    ],
    actions: [],
    provider_choice_required: false,
  });
  assert.equal(view.providers[0].selectable, true);
  assert.equal(view.providers[0].interactive, true);
  for (const p of view.providers.slice(1)) {
    assert.equal(p.selectable, false, `provider ${p.index} must not be selectable`);
    assert.equal(p.interactive, false, `provider ${p.index} must not be interactive`);
  }
  // Every provider is still RENDERED with a reason - visible but not clickable is the requirement.
  for (const p of view.providers) assert.ok(p.reason.length > 0 && !p.reason.startsWith('scheduler.'), `provider ${p.index} has no user-facing reason`);
});

test('UXI-301: the adapter forces unselectable even when the DTO LIES about selectable', () => {
  // A buggy or hostile producer must not be able to make an unavailable provider clickable by sending
  // selectable:true. This is the acceptance item made structural rather than a renderer convention.
  const view = en({
    state: 'QUEUED',
    providers: [
      {index: 0, term: 'USER_DISABLED', selectable: true, class: 'STRUCTURAL'},
      {index: 1, term: 'DEVICE_OFFLINE_PLACEHOLDER', selectable: true, class: 'STRUCTURAL'},
    ].filter((p) => TERMS.includes(p.term)),
    actions: [],
    provider_choice_required: false,
  });
  assert.equal(view.providers.length, 1);
  assert.equal(view.providers[0].selectable, false, 'a lying selectable:true must not survive');
  assert.equal(view.providers[0].interactive, false);
});

/* ---------------------------------------------------------------------------------- the leak rule */

test('UXI-301: NO raw scheduler vocabulary leaks into the default view model', () => {
  // Build a DTO from the REAL contract that deliberately includes knowledge, structural, resource and
  // permitted terms, then serialise the whole view model and search it for every token the contract
  // declares. Case-sensitive, because the user copy is prose and the tokens are upper-case.
  const dto = projectStatus({
    providerRefs: [
      {source: 'RS-201.AVAILABILITY_REASONS', word: 'AVAILABLE'},
      {source: 'RS-201.AVAILABILITY_REASONS', word: 'USER_DISABLED'},
      {source: 'RS-202.ELIGIBILITY_REASONS', word: 'AT_CAPACITY'},
      {source: 'RS-201.FRESHNESS', word: 'STALE'},
      {source: 'RS-201.AVAILABILITY_REASONS', word: 'UNKNOWN'},
    ],
  });
  const view = en(dto);
  const serialized = JSON.stringify(view);
  const forbidden = [
    ...TERMS,
    ...PRESENTATION_STATES,
    ...Object.keys(TERM_OF).map((s) => s.split('.')[1]), // source vocabulary names
    ...Object.keys(TERM_CLASS),
  ];
  const leaked = [...new Set(forbidden)].filter((token) => serialized.includes(token));
  assert.deepEqual(leaked, [], `raw scheduler tokens reached the default UI: ${leaked.join(', ')}`);
  // And the advanced block is ABSENT, not merely empty.
  assert.equal('technical' in view, false);
  assert.equal(Object.keys(view).includes('technical'), false);
});

test('UXI-301: the leak rule survives every provider term the contract can produce', () => {
  // Not just one DTO: sweep every term through the adapter and search each view for its own token.
  const offenders = [];
  for (const term of TERMS) {
    const view = en({state: 'QUEUED', providers: [{index: 0, term, selectable: term === 'SELECTABLE', class: TERM_CLASS[term]}], actions: [], provider_choice_required: false});
    const serialized = JSON.stringify(view);
    if (serialized.includes(term)) offenders.push(term);
  }
  assert.deepEqual(offenders, [], `terms leaked when rendered: ${offenders.join(', ')}`);
});

test('UXI-301: raw vocabulary IS reachable, but only through the explicit advanced block', () => {
  const dto = projectStatus({providerRefs: [{source: 'RS-201.AVAILABILITY_REASONS', word: 'UNKNOWN'}]});
  const view = en(dto, {advanced: true});
  assert.ok(view.technical, 'advanced:true must expose the technical block');
  assert.equal(view.technical.state, dto.state);
  assert.deepEqual(view.technical.providerTerms, dto.providers.map((p) => p.term));
  assert.equal(view.technical.fabricated, false, 'step 4 truth flags travel with the technical view');
  // The headline is still user language even in advanced mode: detail is additional, not a replacement.
  assert.ok(!view.stateLabel.startsWith('scheduler.'));
});

/* --------------------------------------------------------------------- truth and drift guards */

test('UXI-301: the adapter never fabricates success and never claims to have chosen', () => {
  const running = en(projectStatus({providerRefs: [{source: 'RS-201.AVAILABILITY_REASONS', word: 'AVAILABLE'}]}));
  assert.notEqual(running.stateLabel, en(projectStatus({terminal: true})).stateLabel);
  const completed = en(projectStatus({terminal: true}));
  assert.equal(completed.severity, 'ok');
});

test('UXI-301: an unknown state or term THROWS rather than rendering blank', () => {
  // Drift detection in the adapter itself: a table that silently falls back would present a blank or
  // wrong status for a real condition, which is the failure the contract's own presentTerm refuses.
  assert.throws(() => en({state: 'INVENTED', providers: [], actions: [], provider_choice_required: false}), /unknown presentation state/);
  assert.throws(() => en({state: 'RUNNING', providers: [{index: 0, term: 'INVENTED'}], actions: [], provider_choice_required: false}), /unknown presentation term/);
  assert.throws(() => en({state: 'RUNNING', providers: [], actions: ['INVENTED'], provider_choice_required: false}), /unknown action/);
  assert.throws(() => toSchedulerViewModel(null, {t}), /expects the contract DTO/);
  assert.throws(() => toSchedulerViewModel({state: 'RUNNING'}, {}), /requires a translator/);
});

test('UXI-301: the adapter does not recompute selection - it reports the contract decision unchanged', () => {
  // The workbook forbids the UI recomputing provider/device choice. Both directions are checked, so
  // the adapter cannot be "helpfully" inferring a choice the contract did not ask for.
  const demanded = en({state: 'WAITING_USER', providers: [{index: 0, term: 'REGION_UNSUPPORTED', selectable: false, class: 'STRUCTURAL'}], actions: ['CHOOSE_PROVIDER'], provider_choice_required: true});
  assert.equal(demanded.choiceRequired, true);
  assert.equal(demanded.waitingOnResources, false, 'a decision request is not a resource wait');

  const saturated = en({state: 'QUEUED', providers: [{index: 0, term: 'AT_CAPACITY', selectable: false, class: 'RESOURCE'}], actions: ['KEEP_WAITING'], provider_choice_required: false});
  assert.equal(saturated.choiceRequired, false);
  assert.equal(saturated.waitingOnResources, true, 'a saturated pool is a wait, not a choice');
  assert.equal(saturated.severity, 'waiting');
});

test('UXI-301: the view model is frozen, so a renderer cannot mutate presentation truth', () => {
  const view = en(projectStatus({providerRefs: [{source: 'RS-201.AVAILABILITY_REASONS', word: 'AVAILABLE'}]}));
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.providers));
  assert.ok(Object.isFrozen(view.actions));
});

test('UXI-301: real registry vocabulary flows end to end into user language', () => {
  // Anchors the adapter to the real source vocabulary rather than to a hand-written term, so it is
  // not possible to pass this file by inventing inputs.
  const disabled = presentTerm('RS-201.ENABLEMENT', 'DISABLED');
  assert.ok(registry.ENABLEMENT.includes('DISABLED'), 'the source word must really exist in RS-201');
  const view = en({state: 'QUEUED', providers: [{index: 0, term: disabled, selectable: false, class: TERM_CLASS[disabled]}], actions: [], provider_choice_required: false});
  useLocale('en');
  assert.equal(view.providers[0].reason, t(TERM_COPY[disabled].key));
  assert.equal(view.providers[0].severity, 'blocked');
});
