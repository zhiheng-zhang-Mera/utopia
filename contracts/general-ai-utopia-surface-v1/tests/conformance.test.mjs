// Conformance tests for GAI-009 — Utopia Ask/Do + Action + Web/Android integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_KINDS, GAI_ACTION_STATES, GaiSurfaceError, PROVENANCE_FIELDS, ROUTES, SHARED_ATTENTION_SOURCE,
  SURFACE_SECTIONS, TERMINAL_STATES, createAskDoFacade, findSecretFields,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const LAPTOP = 'device:laptop';
const PHONE = 'device:phone-android';
const REMOTE = 'device:desktop';

/** The existing deterministic router, unchanged: it answers known commands and nothing else. */
const deterministicMatcher = text => (text.startsWith('/help') ? { handler_ref: 'handler:help', matched: '/help' } : null);

function ports({ route = 'GENERAL_AI', admission = 'ADMITTED' } = {}) {
  const calls = { route: 0, admit: 0, execute: 0, project: 0, acknowledge: 0 };
  return {
    calls,
    routePort: {
      route({ text }) {
        calls.route += 1;
        if (route === 'ENGINEERING') return { chosen: { route: 'ENGINEERING' }, recommendation: { intent: 'ENGINEERING' }, engineering: { code: 'ENGINEERING_ROUTE_DEFERRED' } };
        if (route === 'MANUAL_PICKER') return { chosen: { route: 'MANUAL_PICKER' }, recommendation: null };
        return { chosen: { route: 'GENERAL_AI' }, recommendation: { intent: 'QUESTION', preferred_channel: 'GENERAL_AI', confidence: 0.9 } };
      },
    },
    admissionPort: {
      checkBudget: () => ({ verdict: 'WITHIN_BUDGET', allowed: true, aggregate_usage_known: true }),
      admit({ consent }) {
        calls.admit += 1;
        if (admission === 'REFUSED_NO_CONSENT') return { admitted: false, verdict: 'REFUSED_NO_CONSENT', reason: 'NO_CONSENT_RECORD', budget: { verdict: 'WITHIN_BUDGET', allowed: true } };
        if (admission === 'REFUSED_BUDGET') return { admitted: false, verdict: 'REFUSED_BUDGET', reason: 'PER_ACTION_LIMIT_EXCEEDED', budget: { verdict: 'OVER_PER_ACTION_LIMIT', allowed: false } };
        return { admitted: true, verdict: 'ADMITTED', reason: 'CONSENT_AND_BUDGET_APPROVED', consent: consent ?? { consent_id: 'consent:1' }, budget: { verdict: 'WITHIN_BUDGET', allowed: true } };
      },
    },
    executionPort: { execute() { calls.execute += 1; return { ok: true, usage: { known: true } }; } },
    sharedAttention: {
      project({ attention_ref, question, delivered_to }) { calls.project += 1; return { attention_ref, question, state: 'PENDING', source: SHARED_ATTENTION_SOURCE, delivered_to, projection_of_shared_state: true }; },
      acknowledge({ attention_ref }) { calls.acknowledge += 1; return { attention_ref, state: 'ACKNOWLEDGED', reconciles_all_projections: true }; },
    },
  };
}

const facadeWith = (options = {}) => {
  const built = ports(options);
  const facade = createAskDoFacade({ deterministicMatcher, clock: () => T0, policy: options.policy ?? {}, ...built });
  return { facade, ...built };
};

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof GaiSurfaceError, `expected a GaiSurfaceError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

const askGeneralAi = facade => facade.ask({ text: 'explain the pairing handshake', interaction_device_ref: LAPTOP, request_ref: 'req:1' });

test('deterministic local commands route exactly as before', () => {
  const { facade, calls } = facadeWith();
  const deterministic = facade.ask({ text: '/help me', interaction_device_ref: LAPTOP });
  assert.equal(deterministic.route, 'DETERMINISTIC_LOCAL');
  assert.equal(deterministic.action_kind, 'DETERMINISTIC_LOCAL');
  assert.equal(deterministic.deterministic_unchanged, true, 'the local path is untouched by this facade');
  assert.equal(deterministic.routed_through_gai, false);
  assert.equal(deterministic.general_ai_action_created, false);
  assert.equal(deterministic.action_ref, null, 'no Action is created for a local command');
  assert.deepEqual(deterministic.deterministic_result, { handler_ref: 'handler:help', matched: '/help' });
  assert.equal(deterministic.provider_choice_requested_from_user, false);
  assert.equal(calls.route, 0, 'the GAI router was never consulted');
  assert.equal(facade.actions().length, 0);

  // An unmatched request does enter GAI routing.
  const ai = askGeneralAi(facade);
  assert.equal(calls.route, 1);
  assert.equal(ai.route, 'GENERAL_AI');
  assert.equal(facade.surfaceContract().deterministic_first, true);
  assert.deepEqual([...ACTION_KINDS], ['DETERMINISTIC_LOCAL', 'GENERAL_AI', 'ENGINEERING']);
  assert.deepEqual([...ROUTES], ['DETERMINISTIC_LOCAL', 'GENERAL_AI', 'ENGINEERING', 'MANUAL_PICKER', 'CONFIRMATION_REQUIRED']);
});

test('an ordinary AI request produces a GENERAL_AI Action with provenance as advanced state', () => {
  const { facade } = facadeWith();
  const asked = askGeneralAi(facade);
  assert.equal(asked.action_kind, 'GENERAL_AI');
  assert.match(asked.action_ref, /^action:gai:\d+$/);
  assert.equal(asked.canonical_history_ref.startsWith('history:gai:'), true);
  assert.equal(asked.web_first_default_path, true, 'the current-device Web flow is the default visible path');
  assert.equal(asked.interaction_device_ref, LAPTOP);
  assert.equal(asked.execution_device_ref, LAPTOP);
  assert.equal(asked.provider_choice_requested_from_user, false, 'the user is not asked to pick a backend class');
  assert.equal(asked.provenance_available_in_advanced_view, true);

  const advanced = facade.advanced({ action_ref: asked.action_ref });
  assert.equal(advanced.advanced_view, true);
  assert.equal(advanced.provider_and_channel_visible, true);
  assert.equal(advanced.real_identifiers_preserved, true);
  assert.equal(advanced.provenance.channel_ref, 'WEB');
  assert.equal(advanced.provenance.device_ref, LAPTOP);
  assert.equal(advanced.contains_secret_material, false);

  // Real identifiers can be recorded, and secrets cannot.
  const updated = facade.advanced({ action_ref: asked.action_ref, provenance: { provider_ref: 'provider:deepseek', model_ref: 'model:chat', backend_run_ref: 'backend:run:7', protocol_ref: 'OPENAI_COMPATIBLE' } });
  assert.equal(updated.provenance.backend_run_ref, 'backend:run:7');
  assert.equal(failure(() => facade.advanced({ action_ref: asked.action_ref, provenance: { provider_ref: 'p', access_token: 'sk-live-abcdef' } })).code, 'SECRET_MATERIAL_REFUSED');
  assert.equal(failure(() => facade.advanced({ action_ref: asked.action_ref, provenance: { nickname: 'x' } })).code, 'INVALID_REQUEST');
  assert.deepEqual(findSecretFields({ provider_ref: 'provider:1' }), [], 'a reference is not a secret');

  const view = facade.render({ action_ref: asked.action_ref });
  assert.equal(view.surface_section, 'ACTION_VIEW');
  assert.deepEqual([...SURFACE_SECTIONS], ['ASK_DO', 'ACTION_VIEW', 'PROGRESS', 'ATTENTION', 'CONTROL', 'RESULT', 'ADVANCED']);
  assert.equal(view.provenance.channel_ref, 'WEB');
  assert.equal(failure(() => facade.render({ action_ref: 'action:nope' })).code, 'UNKNOWN_ACTION');
  assert.equal(facade.action('action:nope'), null, 'an unknown action is a typed absence');
});

test('device-switch and API proposals never navigate the user away, and remote results return to the action', () => {
  const { facade } = facadeWith();
  const asked = askGeneralAi(facade);
  const proposal = facade.proposeDeviceSwitch({ action_ref: asked.action_ref, remote_device_ref: REMOTE });
  assert.equal(proposal.requires_explicit_confirmation, true);
  assert.equal(proposal.confirmed, false);
  assert.equal(proposal.auto_selected, false);
  assert.equal(proposal.user_navigated_away, false);
  assert.equal(facade.render({ action_ref: asked.action_ref }).state, 'WAITING_CONFIRMATION');
  assert.equal(facade.render({ action_ref: asked.action_ref }).execution_device_ref, LAPTOP, 'the executor only changes on confirmation');

  const confirmed = facade.confirmDeviceSwitch({ action_ref: asked.action_ref, confirmed: true });
  assert.equal(confirmed.applied, true);
  assert.equal(confirmed.execution_device_ref, REMOTE);
  assert.equal(confirmed.interaction_device_ref, LAPTOP);
  assert.equal(confirmed.user_navigated_away, false, 'the user keeps their own device as the UI endpoint');
  assert.equal(confirmed.remote_result_returns_to_originating_action, true);

  // The remote result lands on the originating shared action.
  const result = facade.applyResult({ action_ref: asked.action_ref, state: 'SUCCEEDED', result_ref: 'result:remote-1' });
  assert.equal(result.user_visible_success, true);
  assert.equal(result.result.returned_to_interaction_device, LAPTOP);
  assert.equal(result.interaction_device_ref, LAPTOP);
  assert.equal(result.execution_device_ref, REMOTE);
  assert.equal(result.success_source, 'TERMINAL_ACCEPTED_RESULT');
  assert.equal(facade.surfaceContract().user_navigated_away_on_remote, false);
});

test('an API proposal requires explicit confirmation and shows the budget outcome before execution', () => {
  const refusedNoConsent = facadeWith({ admission: 'REFUSED_NO_CONSENT' });
  const asked = askGeneralAi(refusedNoConsent.facade);
  const proposal = refusedNoConsent.facade.proposeApiSwitch({ action_ref: asked.action_ref, reason: 'WEB_UNAVAILABLE' });
  assert.equal(proposal.requires_explicit_confirmation, true);
  assert.equal(proposal.confirmed, false);
  assert.equal(proposal.api_triggered_automatically, false);
  assert.equal(proposal.budget_shown_before_execution, true);
  assert.equal(proposal.budget_verdict.verdict, 'WITHIN_BUDGET', 'the budget is shown before anything runs');

  // Without consent nothing executes, and the budget verdict is still returned.
  const denied = refusedNoConsent.facade.executeApi({ action_ref: asked.action_ref });
  assert.equal(denied.executed, false);
  assert.equal(denied.admission_verdict, 'REFUSED_NO_CONSENT');
  assert.equal(denied.budget_shown_before_execution, true);
  assert.equal(refusedNoConsent.calls.execute, 0, 'the channel was never executed');

  // Over budget is refused before execution too.
  const overBudget = facadeWith({ admission: 'REFUSED_BUDGET' });
  const second = askGeneralAi(overBudget.facade);
  overBudget.facade.proposeApiSwitch({ action_ref: second.action_ref });
  const budgetRefused = overBudget.facade.executeApi({ action_ref: second.action_ref });
  assert.equal(budgetRefused.executed, false);
  assert.equal(budgetRefused.budget_verdict.verdict, 'OVER_PER_ACTION_LIMIT');
  assert.equal(overBudget.calls.execute, 0);

  // With consent and budget the run proceeds, on the interaction device.
  const admitted = facadeWith();
  const third = askGeneralAi(admitted.facade);
  admitted.facade.proposeApiSwitch({ action_ref: third.action_ref });
  const executed = admitted.facade.executeApi({ action_ref: third.action_ref });
  assert.equal(executed.executed, true);
  assert.equal(executed.admission_verdict, 'ADMITTED');
  assert.equal(executed.channel_ref, 'API');
  assert.equal(executed.interaction_device_ref, LAPTOP);
  assert.equal(executed.user_navigated_away, false);
  assert.equal(admitted.calls.execute, 1);
  // An action with no API proposal cannot be executed at all.
  const noProposal = askGeneralAi(admitted.facade);
  assert.equal(failure(() => admitted.facade.executeApi({ action_ref: noProposal.action_ref })).code, 'CONFIRMATION_REQUIRED');
});

test('attention is projected into canonical shared state, never a GAI-only store', () => {
  const { facade, calls } = facadeWith();
  const asked = askGeneralAi(facade);
  const refused = failure(() => facade.registerGaiAttentionStore());
  assert.equal(refused.code, 'ATTENTION_FROM_SHARED_STATE_ONLY');
  assert.equal(refused.created, false, 'no GAI-only notification database exists');

  const projected = facade.projectAttention({ action_ref: asked.action_ref, attention_ref: 'attention:1', question: 'Which provider should I use?' });
  assert.equal(projected.from_shared_state, true);
  assert.equal(projected.gai_only_store, false);
  assert.equal(projected.delivered_to, LAPTOP);
  assert.equal(calls.project, 1);
  assert.equal(facade.render({ action_ref: asked.action_ref }).attention_required, true);
  assert.equal(facade.render({ action_ref: asked.action_ref }).state, 'WAITING_CONFIRMATION');
  assert.equal(facade.surfaceContract().attention_from_shared_state, true);
  assert.equal(facade.surfaceContract().gai_only_attention_store, false);

  // Without the shared port, projection is refused rather than stored locally.
  const orphanPorts = ports();
  const orphan = createAskDoFacade({ deterministicMatcher, routePort: orphanPorts.routePort, admissionPort: orphanPorts.admissionPort, clock: () => T0 });
  const orphanAction = askGeneralAi(orphan);
  assert.equal(failure(() => orphan.projectAttention({ action_ref: orphanAction.action_ref, attention_ref: 'a', question: 'q' })).code, 'ATTENTION_FROM_SHARED_STATE_ONLY');
});

test('cancel and control work from Web and Android for the same Action, with one shared history', () => {
  const { facade } = facadeWith();
  const asked = askGeneralAi(facade);
  assert.equal(facade.history({ action_ref: asked.action_ref }).entries.length, 1);

  // The Android device becomes an authorized controller after a confirmed device switch.
  facade.proposeDeviceSwitch({ action_ref: asked.action_ref, remote_device_ref: PHONE });
  facade.confirmDeviceSwitch({ action_ref: asked.action_ref, confirmed: true });

  const fromAndroid = facade.control({ action_ref: asked.action_ref, operation: 'PAUSE', by_device_ref: PHONE });
  assert.equal(fromAndroid.applied, true);
  assert.equal(fromAndroid.controlled_from_other_android_device, true);
  assert.equal(facade.render({ action_ref: asked.action_ref }).state, 'WAITING_CONFIRMATION');
  const fromWeb = facade.control({ action_ref: asked.action_ref, operation: 'RESUME', by_device_ref: LAPTOP });
  assert.equal(fromWeb.applied, true);
  assert.equal(fromWeb.controlled_from_interaction_device, true);

  // An unauthorized device cannot control the action.
  const unauthorized = failure(() => facade.control({ action_ref: asked.action_ref, operation: 'CANCEL', by_device_ref: 'device:intruder' }));
  assert.equal(unauthorized.code, 'NOT_AUTHORIZED_TO_CONTROL');
  assert.deepEqual(unauthorized.authorized_devices, [LAPTOP, PHONE]);
  assert.equal(failure(() => facade.control({ action_ref: asked.action_ref, operation: 'EXPLODE', by_device_ref: LAPTOP })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => facade.control({ action_ref: 'action:nope', operation: 'CANCEL', by_device_ref: LAPTOP })).code, 'UNKNOWN_ACTION');

  // The history is one canonical truth for both devices.
  const history = facade.history({ action_ref: asked.action_ref });
  assert.equal(history.entries.length >= 3, true, 'the ask and both control operations are recorded');
  assert.equal(history.entries.some(entry => entry.event === 'CONTROL_PAUSE'), true);
  assert.equal(history.entries.some(entry => entry.event === 'CONTROL_RESUME'), true);
  assert.equal(history.canonical_action_truth_shared, true);
  assert.equal(history.per_device_history_copy, false);
  assert.equal(history.second_history_store, false);
  assert.equal(history.entries.every(entry => entry.history_ref === asked.canonical_history_ref), true, 'every event belongs to one canonical history');
  assert.equal(facade.history().entries.length, history.entries.length);
});

test('no path claims success while the backend is unavailable, and legacy routes are refused', () => {
  const { facade } = facadeWith();
  const asked = askGeneralAi(facade);
  assert.deepEqual([...TERMINAL_STATES], ['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED']);
  assert.deepEqual([...GAI_ACTION_STATES], ['ACCEPTED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNAVAILABLE', 'UNKNOWN']);

  // Partial output is never success.
  const partial = facade.addPartial({ action_ref: asked.action_ref, partial_ref: 'partial:1', text: 'half' });
  assert.equal(partial.partial_is_not_success, true);
  assert.equal(partial.terminal, false);
  assert.equal(facade.render({ action_ref: asked.action_ref }).shows_success, false);

  // A success cannot be claimed from a non-terminal state or without a result reference.
  assert.equal(failure(() => facade.applyResult({ action_ref: asked.action_ref, state: 'RUNNING' })).code, 'FALSE_SUCCESS_REFUSED');
  assert.equal(failure(() => facade.applyResult({ action_ref: asked.action_ref, state: 'SUCCEEDED' })).code, 'FALSE_SUCCESS_REFUSED');

  // While attention is required the backend is not available, so success is refused.
  facade.projectAttention({ action_ref: asked.action_ref, attention_ref: 'attention:9', question: 'confirm?' });
  const whileWaiting = failure(() => facade.applyResult({ action_ref: asked.action_ref, state: 'SUCCEEDED', result_ref: 'result:1' }));
  assert.equal(whileWaiting.code, 'FALSE_SUCCESS_REFUSED');
  assert.equal(whileWaiting.backend_unavailable, true);
  assert.equal(facade.render({ action_ref: asked.action_ref }).backend_unavailable, true);
  assert.equal(facade.render({ action_ref: asked.action_ref }).success_claimed_while_not_succeeded, false);

  // A failure result is honest, and a success afterwards behaves normally on a fresh action.
  const failed = facade.applyResult({ action_ref: asked.action_ref, state: 'FAILED', error: { code: 'PROVIDER_FAULT' } });
  assert.equal(failed.user_visible_success, false);
  assert.equal(failed.success_source, null);
  assert.equal(failed.result.error.code, 'PROVIDER_FAULT');
  assert.equal(failure(() => facade.addPartial({ action_ref: asked.action_ref, partial_ref: 'p2' })).code, 'FALSE_SUCCESS_REFUSED', 'a terminal action takes no more partials');

  const fresh = askGeneralAi(facadeWith().facade);
  assert.equal(fresh.general_ai_action_created, true);
  const ok = facadeWith();
  const second = askGeneralAi(ok.facade);
  assert.equal(ok.facade.applyResult({ action_ref: second.action_ref, state: 'SUCCEEDED', result_ref: 'result:ok' }).success_source, 'TERMINAL_ACCEPTED_RESULT');

  // Boss/Hns routes are not exposed.
  for (const route of ['BOSS', 'HNS', 'CODEX_BOSS']) {
    const refused = failure(() => facade.exposeLegacyRoute({ route }));
    assert.equal(refused.code, 'LEGACY_ROUTE_NOT_EXPOSED');
    assert.equal(refused.exposed, false);
  }
  assert.equal(facade.surfaceContract().legacy_routes_exposed, false);
  assert.equal(facade.surfaceContract().tasks_services_rooms_truths_separate, true);
  assert.equal(failure(() => facade.ask({ text: '', interaction_device_ref: LAPTOP })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => facade.ask({ text: 'x' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => createAskDoFacade({ deterministicMatcher, clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(failure(() => createAskDoFacade({ deterministicMatcher: 'x', clock: () => T0 })).code, 'INVALID_REQUEST');
  assert.throws(() => { facade.render({ action_ref: second.action_ref }).state = 'FAILED'; }, TypeError);
  assert.equal(PROVENANCE_FIELDS.includes('provider_ref'), true);
});
