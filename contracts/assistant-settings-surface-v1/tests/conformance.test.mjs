// Conformance tests for BA-007 — assistant settings + interaction surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_MODES, EDITABLE_FIELDS, EMBODIMENT_STATES, IDENTITY_KINDS, RESERVED_ADAPTERS, SettingsError,
  SURFACE_ACTIONS, createInteractionSurface, isIsoInstant,
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
// ---------------------------------------------------------------- Alien Correction regressions
// Every test below fails against the Development head and passes against the corrected head.

test('an editable field carries the kind of value its name promises', () => {
  const { surface } = surfaceAt();
  for (const changes of [{ display_name: 42 }, { verbosity: { evil: true } }, { locale: ['x'] }, { proactivity: true }, { display_name: '' }]) {
    assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes })).code, 'INVALID_FIELD', JSON.stringify(changes));
  }
  // An explicit undefined would silently clear the field rather than change it.
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { mode: undefined } })).code, 'INVALID_FIELD');
  const profile = surface.assistant(BUTLER).profile;
  assert.equal(profile.mode, 'BUTLER', 'the refused edits changed nothing');
  assert.equal(profile.display_name, 'Butler');
  assert.equal(profile.verbosity, null);
  assert.equal(surface.assistant(BUTLER).profile_version, 1, 'no version was consumed');
  // A genuine typed edit still lands, including clearing a nullable field.
  const update = surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { display_name: 'Alfred', verbosity: 'LOW', locale: null } });
  assert.equal(update.profile.display_name, 'Alfred');
  assert.equal(update.profile.verbosity, 'LOW');
  assert.deepEqual(update.changed_fields, ['display_name', 'verbosity', 'locale']);
});

test('a change the surface cannot read is refused rather than dropped', () => {
  const { surface } = surfaceAt();
  const symbol = { display_name: 'Alfred' };
  symbol[Symbol('user_name')] = 'Hijack';
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: symbol })).code, 'INVALID_FIELD', 'a symbol key would be dropped in silence');
  const hidden = { display_name: 'Alfred' };
  Object.defineProperty(hidden, 'user_name', { value: 'X', enumerable: false });
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: hidden })).code, 'DIGITAL_ME_IS_READ_ONLY', 'a hidden own field is still a declared change');
  class FakeChanges { constructor() { this.display_name = 'Alfred'; } }
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: new FakeChanges() })).code, 'INVALID_REQUEST');
  assert.equal(surface.assistant(BUTLER).profile.display_name, 'Butler', 'nothing was written');
  assert.equal(surface.committedUpdates().length, 0, 'and nothing was committed');
});

test('the version guard is not switchable off by policy', () => {
  for (const policy of [{ profile_version_required: false }, { unknown_key: 1 }, { allow_reserved_adapters: 'yes' }, { policy_ref: '' }]) {
    assert.equal(failure(() => createInteractionSurface({ clock: () => T0, policy })).code, 'INVALID_REQUEST', JSON.stringify(policy));
  }
  const { surface } = surfaceAt({ allow_reserved_adapters: true });
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 99, changes: { display_name: 'Lost update' } })).code, 'STALE_UPDATE', 'a stale write is still refused');
  assert.equal(surface.assistant(BUTLER).profile.display_name, 'Butler');
});

test('re-registering a device never discards the binding the user chose', () => {
  const { surface } = surfaceAt();
  surface.switchForeground({ device_ref: DEVICE, to_assistant_ref: SECRETARY });
  surface.observeEmbodiment({ device_ref: DEVICE, state: 'STALE' });
  assert.equal(failure(() => surface.registerEmbodiment({ device_ref: DEVICE, assistant_ref: BUTLER, state: 'FRESH' })).code, 'INVALID_REQUEST');
  assert.equal(surface.listAssistants({ device_ref: DEVICE }).foreground_assistant_ref, SECRETARY, 'the foreground switch survived');
  assert.equal(surface.surfaceView({ device_ref: DEVICE }).foreground_binding.state, 'STALE', 'and the observed state survived');
  const refreshed = surface.registerEmbodiment({ device_ref: DEVICE, assistant_ref: SECRETARY, state: 'FRESH' });
  assert.equal(refreshed.foreground_assistant_ref, SECRETARY);
  assert.equal(surface.assertFresh({ device_ref: DEVICE }).fresh_confirmed, true);
  // Registration fields are typed like any other record.
  assert.equal(failure(() => surface.registerEmbodiment({ device_ref: 'device:new', assistant_ref: BUTLER, executor_for: [7, {}] })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => surface.registerEmbodiment({ device_ref: 'device:new', assistant_ref: BUTLER, last_seen_at: 'not-an-instant' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => surface.observeEmbodiment({ device_ref: DEVICE, state: 'FRESH', last_seen_at: 12345 })).code, 'INVALID_REQUEST');
  assert.deepEqual([...surface.registerEmbodiment({ device_ref: 'device:new', assistant_ref: BUTLER, executor_for: ['task:1', 'task:1'] }).executor_for], ['task:1']);
});

test('a task the surface cannot read is reported, not hidden', () => {
  const { surface } = surfaceAt();
  const mixed = surface.surfaceView({ device_ref: DEVICE, tasks: [{ task_ref: 'task:bg', foreground: false, owner_ref: BUTLER }, { owner_ref: BUTLER }, { task_ref: null, foreground: false }] });
  assert.deepEqual([...mixed.background_tasks].map(task => task.task_ref), ['task:bg']);
  assert.equal(mixed.unreadable_tasks.length, 2, 'unreadable tasks are surfaced');
  assert.equal(mixed.background_tasks_hidden, true, 'the view no longer claims nothing is hidden');
  assert.deepEqual([...mixed.unreadable_tasks].map(entry => entry.reason), ['MISSING_TASK_REF', 'MISSING_TASK_REF']);
  const clean = surface.surfaceView({ device_ref: DEVICE, tasks: [{ task_ref: 'task:bg', foreground: false }, { task_ref: 'task:fg', foreground: true }] });
  assert.equal(clean.background_tasks_hidden, false);
  assert.deepEqual([...clean.unreadable_tasks], []);
  assert.deepEqual([...clean.foreground_tasks].map(task => task.task_ref), ['task:fg']);
});

test('the committed-update cursor must be a version and the instants must be real', () => {
  const { surface } = surfaceAt();
  surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { display_name: 'Alfred' } });
  assert.equal(surface.committedUpdates({ since_profile_version: 1 }).length, 1);
  assert.deepEqual([...surface.committedUpdates({ since_profile_version: 2 })], []);
  for (const cursor of [NaN, 'x', -1, 1.5, Infinity]) {
    assert.equal(failure(() => surface.committedUpdates({ since_profile_version: cursor })).code, 'INVALID_REQUEST', String(cursor));
  }
  assert.equal(surface.committedUpdates().length, 1, 'the default cursor still works');

  assert.equal(isIsoInstant('2026-13-45T99:99:99Z'), false);
  assert.equal(isIsoInstant('2026-01-01T00:00:00.000Z'), true);
  const fresh = createInteractionSurface({ clock: () => T0 });
  assert.equal(failure(() => fresh.registerAssistant({ assistant_ref: BUTLER, display_name: 'Butler', at: '2026-13-45T99:99:99Z' })).code, 'INVALID_REQUEST');
  assert.equal(fresh.assistant(BUTLER), null, 'nothing was registered from an unusable instant');
  assert.equal(failure(() => createInteractionSurface({ clock: () => '2026-13-45T99:99:99Z' }).listAssistants()).code, 'INVALID_CLOCK');
});

test('freshness needs a recent observation, not only a declared state', () => {
  const { surface, clock } = surfaceAt();
  assert.equal(surface.surfaceView({ device_ref: DEVICE }).stale, false);
  clock.advance(400000);
  const aged = surface.surfaceView({ device_ref: DEVICE });
  assert.equal(aged.stale, true, 'an observation older than the freshness window is not current');
  assert.equal(aged.stale_indicator.stale_reason, 'OBSERVATION_OLDER_THAN_WINDOW');
  assert.equal(aged.stale_indicator.age_ms > aged.stale_indicator.stale_after_ms, true);
  const refused = failure(() => surface.assertFresh({ device_ref: DEVICE }));
  assert.equal(refused.code, 'STALE_CACHE_IS_NOT_AUTHORITY');
  assert.equal(refused.stale_reason, 'OBSERVATION_OLDER_THAN_WINDOW');
  assert.equal(refused.cached_view_is_authority, false);
  // A real observation makes the device current again.
  surface.observeEmbodiment({ device_ref: DEVICE, state: 'FRESH' });
  assert.equal(surface.surfaceView({ device_ref: DEVICE }).stale, false);
  assert.equal(surface.assertFresh({ device_ref: DEVICE }).fresh_confirmed, true);
  for (const policy of [{ stale_after_ms: 0 }, { stale_after_ms: NaN }, { stale_after_ms: 'soon' }]) {
    assert.equal(failure(() => createInteractionSurface({ clock: () => T0, policy })).code, 'INVALID_REQUEST', JSON.stringify(policy));
  }
});

test('every projection of a device gives the same freshness answer', () => {
  const { surface } = surfaceAt();
  const projection = surface.embodimentsOf({ assistant_ref: BUTLER, current_device_ref: DEVICE });
  const current = projection.embodiments.find(entry => entry.is_current_device === true);
  assert.equal(current.cached_view_is_authoritative, false, 'a projection never claims to be current authority');
  assert.equal(current.state_is_caller_declared, true);
  assert.equal(projection.embodiments.every(entry => entry.cached_view_is_authoritative === false), true);
  assert.equal(surface.surfaceView({ device_ref: DEVICE }).cache_is_authoritative, false);
});

test('a committed update carries the change, the previous values and the actor', () => {
  const { surface } = surfaceAt();
  const update = surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { display_name: 'Alfred', verbosity: 'LOW' } });
  assert.deepEqual(update.changed, { display_name: 'Alfred', verbosity: 'LOW' }, 'the record carries the change it commits');
  assert.deepEqual(update.previous_values, { display_name: 'Butler', verbosity: null });
  assert.equal(update.actor_ref, null);
  assert.equal(update.actor_known, false, 'an unnamed actor is recorded as unnamed, not invented');
  const propagated = surface.committedUpdates({ since_profile_version: 1 });
  assert.deepEqual(propagated[0].changed, { display_name: 'Alfred', verbosity: 'LOW' }, 'another embodiment can apply the propagation');
  const attributed = surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 2, changes: { display_name: 'Jeeves' }, actor_ref: 'user:owner' });
  assert.equal(attributed.actor_ref, 'user:owner');
  assert.equal(attributed.actor_known, true);
  const entry = surface.journal().find(item => item.event === 'PROFILE_COMMITTED');
  assert.deepEqual(entry.changed_fields, ['display_name', 'verbosity']);
  assert.equal(entry.from_profile_version, 1);
});

test('a handoff or a provisional switch is never taken from a cached view', () => {
  const { surface, clock } = surfaceAt();
  clock.advance(400000);
  assert.equal(failure(() => surface.requestHandoff({ device_ref: DEVICE, task_ref: 'task:bg', to_assistant_ref: BUTLER })).code, 'STALE_CACHE_IS_NOT_AUTHORITY');
  const provisional = surface.switchForeground({ device_ref: DEVICE, to_assistant_ref: SECRETARY });
  assert.equal(provisional.switched, true, 'the UI operation still works');
  assert.equal(provisional.binding_from_cached_view, true);
  assert.equal(provisional.requires_authoritative_revalidation, true);
  assert.equal(provisional.stale_reason, 'OBSERVATION_OLDER_THAN_WINDOW');
  const { surface: fresh } = surfaceAt();
  const current = fresh.switchForeground({ device_ref: DEVICE, to_assistant_ref: SECRETARY });
  assert.equal(current.binding_from_cached_view, false);
  assert.equal(current.requires_authoritative_revalidation, false);
  assert.equal(fresh.requestHandoff({ device_ref: DEVICE, task_ref: 'task:1', to_assistant_ref: BUTLER }).explicit_request, true);
});

test('a task foreground flag is a boolean and its role reflects the data', () => {
  const { surface } = surfaceAt();
  const view = surface.surfaceView({ device_ref: DEVICE, tasks: [
    { task_ref: 'task:bg', foreground: false, owner_ref: BUTLER, executor_ref: OTHER_DEVICE },
    { task_ref: 'task:same', foreground: false, owner_ref: BUTLER, executor_ref: BUTLER },
    { task_ref: 'task:unknown', foreground: false },
    { task_ref: 'task:weird', foreground: 'yes' },
  ] });
  assert.deepEqual([...view.background_tasks].map(task => task.task_ref), ['task:bg', 'task:same', 'task:unknown']);
  assert.equal(view.background_tasks[0].owner_is_executor_distinct, true);
  assert.equal(view.background_tasks[1].owner_is_executor_distinct, false);
  assert.equal(view.background_tasks[0].role, 'LOGICAL_OWNER_AND_EXECUTOR_SEPARATE');
  assert.equal(view.background_tasks[2].role, 'LOGICAL_OWNER_AND_EXECUTOR_UNKNOWN');
  assert.deepEqual([...view.unreadable_tasks].map(entry => entry.reason), ['NON_BOOLEAN_FOREGROUND'], 'a truthy stand-in is refused rather than inverted');
  assert.equal(view.background_tasks_hidden, true);
});

test('an untypeable value is refused before anything is recorded', () => {
  const surface = createInteractionSurface({ clock: () => T0 });
  assert.equal(failure(() => surface.registerAssistant({ assistant_ref: BUTLER, display_name: 'Butler', verbosity: () => 1 })).code, 'INVALID_FIELD');
  assert.equal(surface.assistant(BUTLER), null, 'a refused registration records nothing');
  assert.equal(surface.registerAssistant({ assistant_ref: BUTLER, display_name: 'Butler' }).assistant_ref, BUTLER, 'and the retry is not mistaken for a duplicate');
  assert.equal(surface.listAssistants().assistants.length, 1);

  const cyclic = { display_name: 'Alfred' };
  cyclic.self = cyclic;
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: cyclic })).code, 'INVALID_FIELD');
  assert.equal(failure(() => surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { display_name: () => 1 } })).code, 'INVALID_FIELD');
  assert.equal(surface.committedUpdates().length, 0, 'nothing was committed');
  const first = surface.editProfile({ assistant_ref: BUTLER, expected_profile_version: 1, changes: { display_name: 'Alfred' } });
  assert.equal(first.update_ref, 'profile-update:1', 'the refused edits did not consume an update reference');
});
