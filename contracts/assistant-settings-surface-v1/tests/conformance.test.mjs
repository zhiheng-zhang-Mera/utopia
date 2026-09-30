// Conformance tests for BA-007 — assistant settings + interaction surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_MODES, EDITABLE_FIELDS, EMBODIMENT_STATES, IDENTITY_KINDS, RESERVED_ADAPTERS, SettingsError,
  SURFACE_ACTIONS, createInteractionSurface,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const BUTLER = 'assistant:butler-a';
const SECRETARY = 'assistant:secretary-b';
const DEVICE = 'device:laptop';
const OTHER_DEVICE = 'device:phone';

function surfaceAt(policy = {}) {
  const state = { ms: 0 };
  const clock = () => new Date(Date.parse(T0) + state.ms).toISOString();
  clock.advance = ms => { state.ms += ms; return clock(); };
  const surface = createInteractionSurface({ clock, policy });
  surface.registerAssistant({ assistant_ref: BUTLER, display_name: 'Butler', mode: 'BUTLER' });
  surface.registerAssistant({ assistant_ref: SECRETARY, display_name: 'Secretary', mode: 'SECRETARY' });
  surface.registerEmbodiment({ device_ref: DEVICE, assistant_ref: BUTLER, state: 'CURRENT' });
  surface.registerEmbodiment({ device_ref: OTHER_DEVICE, assistant_ref: BUTLER, state: 'FRESH' });
  return { surface, clock };
}

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof SettingsError, `expected a SettingsError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('assistants are listed and selected, with the five identity roles kept distinct', () => {
  const { surface } = surfaceAt();
  assert.deepEqual([...IDENTITY_KINDS], ['ASSISTANT_IDENTITY', 'USER_IDENTITY', 'FOREGROUND_BINDING', 'LOGICAL_OWNER', 'EXECUTOR']);
  assert.deepEqual([...ASSISTANT_MODES], ['BUTLER', 'SECRETARY', 'COMPANION', 'SPECIALIST']);
  assert.deepEqual([...SURFACE_ACTIONS], ['SELECT_ASSISTANT', 'EDIT_PROFILE', 'SWITCH_FOREGROUND', 'REQUEST_HANDOFF', 'REFRESH']);

  const listed = surface.listAssistants({ device_ref: DEVICE });
  assert.equal(listed.assistants.length, 2);
  assert.equal(listed.foreground_assistant_ref, BUTLER);
  assert.equal(listed.assistants.find(entry => entry.assistant_ref === BUTLER).is_foreground_on_this_device, true);
  assert.equal(listed.assistants.find(entry => entry.assistant_ref === SECRETARY).is_foreground_on_this_device, false);
  assert.equal(listed.user_identity_source, 'DIGITAL_ME_CANONICAL');
  assert.equal(listed.identity_roles_are_distinct, true);
  assert.equal(surface.assistant(BUTLER).profile.mode, 'BUTLER');
  assert.equal(surface.assistant('assistant:nope'), null, 'an unknown assistant is a typed absence');

  // The other embodiment of the same logical assistant is reported as a projection, not a second mind.
  const embodiments = surface.embodimentsOf({ assistant_ref: BUTLER, current_device_ref: DEVICE });
  assert.equal(embodiments.embodiments.length, 2);
  assert.equal(embodiments.embodiments.find(entry => entry.device_ref === DEVICE).is_current_device, true);
  assert.equal(embodiments.one_logical_assistant, true);
  assert.equal(embodiments.independent_minds, false);
  assert.equal(failure(() => surface.embodimentsOf({ assistant_ref: 'assistant:nope' })).code, 'UNKNOWN_ASSISTANT');
  assert.equal(failure(() => surface.registerAssistant({ assistant_ref: BUTLER, display_name: 'Again' })).code, 'DUPLICATE_ASSISTANT');
  assert.equal(failure(() => surface.registerAssistant({ assistant_ref: 'assistant:x', display_name: 'X', mode: 'WIZARD' })).code, 'INVALID_FIELD');
});

test('profile changes propagate as committed shared state and never touch Digital-Me or tasks', () => {
  const { surface } = surfaceAt();
  const update = surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { display_name: 'Alfred', verbosity: 'LOW' } });
  assert.equal(update.committed, true);
  assert.equal(update.propagates_via, 'COMMITTED_SHARED_STATE');
  assert.equal(update.local_scratch_synchronized, false, 'local UI/scratch context is never the propagation path');
  assert.equal(update.digital_me_edited, false);
  assert.equal(update.restarts_tasks, false);
  assert.equal(update.duplicates_tasks, false);
  assert.equal(update.transfers_tasks, false);
  assert.equal(update.to_profile_version, 2);
  assert.deepEqual(update.changed_fields, ['display_name', 'verbosity']);
  assert.equal(update.profile.display_name, 'Alfred');
  assert.equal(surface.assistant(BUTLER).profile_version, 2);

  // Another embodiment reads the same committed update from shared state.
  const propagated = surface.committedUpdates({ since_profile_version: 1 });
  assert.equal(propagated.length, 1);
  assert.equal(propagated[0].update_ref, update.update_ref);
  assert.deepEqual(surface.committedUpdates({ since_profile_version: 2 }), []);

  // A mode/personality change is assistant policy, not a Digital-Me mutation, and restarts nothing.
  const modeChange = surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 2, changes: { mode: 'COMPANION' } });
  assert.equal(modeChange.restarts_tasks, false);
  assert.equal(modeChange.digital_me_edited, false);
  assert.equal(surface.assistant(BUTLER).profile.mode, 'COMPANION');

  assert.deepEqual([...EDITABLE_FIELDS].includes('display_name'), true);
  assert.deepEqual([...EDITABLE_FIELDS].includes('user_name'), false, 'canonical user fields are not editable here');
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 3, changes: { user_name: 'X' } })).code, 'DIGITAL_ME_IS_READ_ONLY');
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 3, changes: { digital_me: {} } })).code, 'DIGITAL_ME_IS_READ_ONLY');
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 3, changes: { nickname: 'x' } })).code, 'INVALID_FIELD');
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { display_name: 'Stale' } })).code, 'STALE_UPDATE');
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 3, changes: {} })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => surface.editProfile({ assistant_ref: 'assistant:nope', expected_profile_version: 1, changes: { display_name: 'x' } })).code, 'UNKNOWN_ASSISTANT');
});

test('foreground switching is a UI operation that transfers nothing', () => {
  const { surface } = surfaceAt();
  const tasks = [
    { task_ref: 'task:bg', foreground: false, owner_ref: BUTLER, executor_ref: OTHER_DEVICE },
    { task_ref: 'task:fg', foreground: true },
  ];
  const switched = surface.switchForeground({ device_ref: DEVICE, to_assistant_ref: SECRETARY });
  assert.equal(switched.switched, true);
  assert.equal(switched.from_assistant_ref, BUTLER);
  assert.equal(switched.produces_task_handoff, false, 'a foreground switch is never an automatic handoff');
  assert.equal(switched.tasks_restarted, false);
  assert.equal(switched.tasks_duplicated, false);
  assert.equal(switched.tasks_transferred, false);
  assert.equal(switched.ownership_unchanged, true);
  assert.equal(switched.executor_unchanged, true);
  assert.equal(switched.background_tasks_continue, true);
  assert.equal(switched.handoff_must_be_requested_separately, true);

  // A background task owned by the (now non-foreground) assistant stays visible and unchanged.
  const view = surface.surfaceView({ device_ref: DEVICE, tasks });
  assert.equal(view.foreground_binding.assistant_ref, SECRETARY);
  assert.equal(view.assistant_identity.assistant_ref, SECRETARY);
  assert.equal(view.background_tasks.length, 1);
  assert.equal(view.background_tasks[0].task_ref, 'task:bg');
  assert.equal(view.background_tasks[0].logical_owner_ref, BUTLER);
  assert.equal(view.background_tasks[0].executor_ref, OTHER_DEVICE);
  assert.equal(view.background_tasks_hidden, false, 'an active background task is never hidden because its owner lost foreground');
  assert.equal(view.foreground_tasks.length, 1);
  assert.equal(view.foreground_is_not_ownership, true);
  assert.equal(view.ownership_is_not_execution, true);
  assert.equal(view.identity_roles_are_distinct, true);

  // If responsibility really must move, it is an explicit request that goes through BA-004.
  const handoff = surface.requestHandoff({ device_ref: DEVICE, task_ref: 'task:bg', to_assistant_ref: BUTLER });
  assert.equal(handoff.explicit_request, true);
  assert.equal(handoff.foreground_switch_implies_handoff, false);
  assert.equal(handoff.requires_recipient_acceptance, true);
  assert.equal(handoff.transfers_no_authority, true);
  assert.equal(handoff.applied_by, 'BA_004_HANDOFF');
  assert.equal(failure(() => surface.requestHandoff({ device_ref: DEVICE, to_assistant_ref: BUTLER })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => surface.switchForeground({ device_ref: 'device:nope', to_assistant_ref: BUTLER })).code, 'INVALID_REQUEST');
});

test('stale, offline and reconnecting embodiments are surfaced and never shown as authority', () => {
  const { surface, clock } = surfaceAt();
  assert.deepEqual([...EMBODIMENT_STATES], ['CURRENT', 'FRESH', 'STALE', 'OFFLINE', 'RECONNECTING', 'UNKNOWN']);

  const fresh = surface.surfaceView({ device_ref: DEVICE, tasks: [{ task_ref: 'task:1', foreground: false, owner_ref: BUTLER }] });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.stale_indicator, null);
  assert.equal(fresh.cache_is_authoritative, false);
  assert.equal(surface.assertFresh({ device_ref: DEVICE }).fresh_confirmed, true);

  clock.advance(600000);
  const stale = surface.observeEmbodiment({ device_ref: DEVICE, state: 'STALE' });
  assert.equal(stale.state, 'STALE');
  const staleView = surface.surfaceView({ device_ref: DEVICE, tasks: [{ task_ref: 'task:1', foreground: false, owner_ref: BUTLER }] });
  assert.equal(staleView.stale, true);
  assert.equal(staleView.stale_indicator.state, 'STALE');
  assert.equal(staleView.stale_indicator.cached_view_is_authority, false);
  assert.equal(staleView.stale_indicator.user_must_refresh, true);
  assert.equal(staleView.stale_indicator.message.includes('cache'), true);
  assert.equal(staleView.cache_is_authoritative, false);

  const refused = failure(() => surface.assertFresh({ device_ref: DEVICE }));
  assert.equal(refused.code, 'STALE_CACHE_IS_NOT_AUTHORITY');
  assert.equal(refused.cached_view_is_authority, false);
  assert.equal(refused.refresh_required, true);

  surface.observeEmbodiment({ device_ref: DEVICE, state: 'RECONNECTING' });
  assert.equal(surface.surfaceView({ device_ref: DEVICE }).stale, true, 'reconnecting is not fresh');
  surface.observeEmbodiment({ device_ref: DEVICE, state: 'OFFLINE' });
  assert.equal(failure(() => surface.assertFresh({ device_ref: DEVICE })).state, 'OFFLINE');
  surface.observeEmbodiment({ device_ref: DEVICE, state: 'FRESH' });
  assert.equal(surface.assertFresh({ device_ref: DEVICE }).fresh_confirmed, true, 'a refreshed embodiment is usable again');
  assert.equal(failure(() => surface.observeEmbodiment({ device_ref: DEVICE, state: 'DREAMING' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => surface.observeEmbodiment({ device_ref: 'device:nope', state: 'FRESH' })).code, 'INVALID_REQUEST');
});

test('reserved voice/avatar adapters exist as adapters without being required now', () => {
  const { surface } = surfaceAt();
  assert.deepEqual([...RESERVED_ADAPTERS], ['VOICE_EDITOR', 'AVATAR_EDITOR']);
  const view = surface.surfaceView({ device_ref: DEVICE });
  assert.equal(view.reserved_adapters.length, 2);
  assert.equal(view.reserved_adapters.every(adapter => adapter.required_now === false), true);
  assert.equal(view.reserved_adapters.every(adapter => adapter.enabled === false), true);

  // Editing a reserved reference is refused while the adapter is disabled, and the profile is untouched.
  const refused = failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { voice_ref: 'voice:1' } }));
  assert.equal(refused.code, 'RESERVED_ADAPTER_UNAVAILABLE');
  assert.equal(refused.enables_now, false);
  assert.equal(surface.assistant(BUTLER).profile_version, 1);
  assert.equal(failure(() => surface.reservedAdapter({ adapter: 'VOICE_EDITOR' })).code, 'RESERVED_ADAPTER_UNAVAILABLE');
  assert.equal(failure(() => surface.reservedAdapter({ adapter: 'HOLOGRAM' })).code, 'INVALID_REQUEST');

  // With the adapter enabled by policy, the same edit is accepted and still restarts nothing.
  const enabled = surfaceAt({ allow_reserved_adapters: true }).surface;
  const update = enabled.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { voice_ref: 'voice:1', avatar_ref: 'avatar:1' } });
  assert.equal(update.restarts_tasks, false);
  assert.deepEqual(update.changed_fields, ['voice_ref', 'avatar_ref']);
  assert.equal(enabled.reservedAdapter({ adapter: 'VOICE_EDITOR' }).enabled, true);
});

test('the surface is strict, frozen and independent of ambient state', () => {
  const { surface } = surfaceAt();
  const view = surface.surfaceView({ device_ref: DEVICE, tasks: [] });
  assert.throws(() => { view.foreground_binding.assistant_ref = SECRETARY; }, TypeError, 'surface views are frozen');
  assert.throws(() => { surface.assistant(BUTLER).profile.display_name = 'Hijack'; }, TypeError);
  const update = surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { display_name: 'Alfred' } });
  assert.throws(() => { update.committed = false; }, TypeError);
  assert.equal(failure(() => createInteractionSurface({ clock: 'now' })).code, 'INVALID_CLOCK');
  assert.throws(() => { surface.listAssistants({ device_ref: DEVICE }).assistants.push({}); }, TypeError, 'the assistant list is a frozen snapshot');

  // Two surfaces share nothing.
  const other = surfaceAt().surface;
  assert.equal(other.listAssistants().assistants.length, 2);
  assert.equal(other.committedUpdates().length, 0);
  assert.equal(surface.committedUpdates().length, 1);
  assert.equal(surface.policy().policy_ref, 'policy:ba-settings-default');
  assert.equal(surface.identityKinds().length, 5);
  assert.equal(surface.journal().some(entry => entry.event === 'FOREGROUND_SWITCHED'), false, 'nothing happened that was not asked for');
  assert.equal(surface.journal().some(entry => entry.event === 'PROFILE_COMMITTED'), true);
  assert.equal(failure(() => surface.surfaceView({ device_ref: 'device:nope' })).code, 'INVALID_REQUEST');
});
