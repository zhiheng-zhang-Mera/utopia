// Assistant settings + interaction surface (BA-007).
//
// The user-facing surface for choosing an assistant and changing assistant-owned personalization — with the
// five things users (and reviewers) most often conflate kept visibly apart:
//
//   ASSISTANT IDENTITY   which logical assistant (butler / secretary / companion / …)
//   USER IDENTITY        Digital-Me canonical records — read-only here, never edited from settings
//   FOREGROUND BINDING   which assistant answers on *this* device (BA-003), not ownership
//   LOGICAL OWNER        who coordinates a task
//   EXECUTOR             which embodiment is actually running it
//
// A profile change propagates through committed shared state as a typed update; it never synchronizes local
// UI/scratch context, never restarts or duplicates a task, and never transfers one. Switching the foreground
// assistant is a UI operation distinct from a TaskHandoff: a handoff is only *offered or requested* when
// responsibility genuinely needs to move, and the surface says so explicitly.
//
// Stale, offline and reconnecting embodiments are surfaced as such: a cached binding or task view is labelled
// a cache and never presented as current authority.
//
// Pure module: the clock is injected; no storage, network, UI framework or ambient state.
export const SETTINGS_SURFACE_CONTRACT_VERSION = 1;

export const ASSISTANT_MODES = Object.freeze(['BUTLER', 'SECRETARY', 'COMPANION', 'SPECIALIST']);
export const IDENTITY_KINDS = Object.freeze(['ASSISTANT_IDENTITY', 'USER_IDENTITY', 'FOREGROUND_BINDING', 'LOGICAL_OWNER', 'EXECUTOR']);
export const EMBODIMENT_STATES = Object.freeze(['CURRENT', 'FRESH', 'STALE', 'OFFLINE', 'RECONNECTING', 'UNKNOWN']);
export const EDITABLE_FIELDS = Object.freeze(['display_name', 'mode', 'voice_ref', 'avatar_ref', 'locale', 'verbosity', 'proactivity']);
export const RESERVED_ADAPTERS = Object.freeze(['VOICE_EDITOR', 'AVATAR_EDITOR']);
export const SURFACE_ACTIONS = Object.freeze(['SELECT_ASSISTANT', 'EDIT_PROFILE', 'SWITCH_FOREGROUND', 'REQUEST_HANDOFF', 'REFRESH']);

export const SETTINGS_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'UNKNOWN_ASSISTANT', 'DUPLICATE_ASSISTANT', 'INVALID_FIELD',
  'DIGITAL_ME_IS_READ_ONLY', 'STALE_UPDATE', 'TASK_HANDOFF_NOT_AUTOMATIC', 'STALE_CACHE_IS_NOT_AUTHORITY',
  'RESERVED_ADAPTER_UNAVAILABLE', 'NO_COMMITTED_UPDATE', 'FOREGROUND_SWITCHED_WITHOUT_HANDOFF',
]);

const CONFLICT_CODES = new Set(['STALE_UPDATE', 'TASK_HANDOFF_NOT_AUTOMATIC', 'DIGITAL_ME_IS_READ_ONLY', 'RESERVED_ADAPTER_UNAVAILABLE', 'STALE_CACHE_IS_NOT_AUTHORITY']);

export class SettingsError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SettingsError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_ASSISTANT' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

export const DEFAULT_SURFACE_POLICY = Object.freeze({
  policy_ref: 'policy:ba-settings-default',
  profile_version_required: true,
  allow_reserved_adapters: false,
});

export function createInteractionSurface({ clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new SettingsError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const config = { ...DEFAULT_SURFACE_POLICY, ...(isPlainObject(policy) ? policy : {}) };
  const assistants = new Map();
  const embodiments = new Map();
  const committedUpdates = [];
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new SettingsError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const requireAssistant = assistant_ref => {
    const assistant = assistants.get(assistant_ref);
    if (!assistant) throw new SettingsError('UNKNOWN_ASSISTANT', `no assistant ${String(assistant_ref)}`);
    return assistant;
  };

  const api = {
    policy: () => freeze(clone(config)),
    identityKinds: () => freeze([...IDENTITY_KINDS]),

    registerAssistant({ assistant_ref, display_name, mode = 'BUTLER', voice_ref = null, avatar_ref = null, locale = null, verbosity = null, proactivity = null, at: when } = {}) {
      if (!isText(assistant_ref) || !isText(display_name)) throw new SettingsError('INVALID_REQUEST', 'assistant_ref and display_name are required');
      if (assistants.has(assistant_ref)) throw new SettingsError('DUPLICATE_ASSISTANT', `assistant ${assistant_ref} is already registered`);
      if (!ASSISTANT_MODES.includes(mode)) throw new SettingsError('INVALID_FIELD', `mode must be one of ${ASSISTANT_MODES.join(', ')}`);
      const at = when ?? now();
      const assistant = {
        assistant_ref,
        profile: freeze({ display_name, mode, voice_ref, avatar_ref, locale, verbosity, proactivity }),
        profile_version: 1,
        created_at: at,
        updated_at: at,
        source: 'ASSISTANT_OWNED_PROFILE',
      };
      assistants.set(assistant_ref, assistant);
      note('ASSISTANT_REGISTERED', at, { assistant_ref, mode });
      return freeze(clone(assistant));
    },

    /** Listing shows the five identities distinctly rather than as one "current assistant" blob. */
    listAssistants({ device_ref = null, at: when } = {}) {
      const at = when ?? now();
      const foreground = device_ref === null ? null : embodiments.get(device_ref)?.foreground_assistant_ref ?? null;
      return freeze({
        contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
        assistants: freeze([...assistants.values()].map(assistant => freeze({
          assistant_ref: assistant.assistant_ref,
          profile: clone(assistant.profile),
          profile_version: assistant.profile_version,
          mode: assistant.profile.mode,
          is_foreground_on_this_device: device_ref !== null && assistant.assistant_ref === foreground,
        }))),
        device_ref,
        foreground_assistant_ref: foreground,
        user_identity_source: 'DIGITAL_ME_CANONICAL',
        identity_roles_are_distinct: true,
        at,
      });
    },

    assistant: assistant_ref => {
      const assistant = assistants.get(assistant_ref);
      return assistant ? freeze(clone(assistant)) : null;
    },

    /**
     * A profile edit becomes a committed shared-state update with a version, so other embodiments see it
     * through shared state rather than by synchronizing local UI or scratch context.
     */
    editProfile({ assistant_ref, expected_profile_version, changes = {}, at: when } = {}) {
      const assistant = requireAssistant(assistant_ref);
      if (!isPlainObject(changes) || Object.keys(changes).length === 0) throw new SettingsError('INVALID_REQUEST', 'changes must contain at least one editable field');
      const rejected = Object.keys(changes).filter(field => !EDITABLE_FIELDS.includes(field));
      if (rejected.length > 0) {
        const digitalMe = rejected.filter(field => field.startsWith('user_') || field === 'digital_me' || field === 'canonical_user');
        if (digitalMe.length > 0) {
          throw new SettingsError('DIGITAL_ME_IS_READ_ONLY', 'assistant settings never edit Digital-Me canonical user records', { fields: freeze(digitalMe), canonical_source: 'DIGITAL_ME_CANONICAL', written: false });
        }
        throw new SettingsError('INVALID_FIELD', `${rejected.join(', ')} is not an editable assistant profile field`, { editable_fields: freeze([...EDITABLE_FIELDS]) });
      }
      if (changes.mode !== undefined && !ASSISTANT_MODES.includes(changes.mode)) throw new SettingsError('INVALID_FIELD', `mode must be one of ${ASSISTANT_MODES.join(', ')}`);
      for (const reserved of ['voice_ref', 'avatar_ref']) {
        if (changes[reserved] !== undefined && changes[reserved] !== null && config.allow_reserved_adapters !== true) {
          throw new SettingsError('RESERVED_ADAPTER_UNAVAILABLE', `${reserved} is reserved for a future editor adapter and is not enabled`, {
            field: reserved, reserved_adapters: freeze([...RESERVED_ADAPTERS]), enables_now: false,
          });
        }
      }
      if (config.profile_version_required === true && expected_profile_version !== assistant.profile_version) {
        throw new SettingsError('STALE_UPDATE', `profile is at version ${assistant.profile_version}, edit assumed ${expected_profile_version}`, {
          assistant_ref, current_profile_version: assistant.profile_version,
        });
      }
      const at = when ?? now();
      counter += 1;
      const update = freeze({
        contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
        update_ref: `profile-update:${counter}`,
        assistant_ref,
        from_profile_version: assistant.profile_version,
        to_profile_version: assistant.profile_version + 1,
        changed_fields: freeze(Object.keys(changes)),
        committed: true,
        propagates_via: 'COMMITTED_SHARED_STATE',
        local_scratch_synchronized: false,
        digital_me_edited: false,
        restarts_tasks: false,
        duplicates_tasks: false,
        transfers_tasks: false,
        at,
      });
      assistant.profile = freeze({ ...assistant.profile, ...clone(changes) });
      assistant.profile_version += 1;
      assistant.updated_at = at;
      committedUpdates.push(update);
      note('PROFILE_COMMITTED', at, { assistant_ref, to_profile_version: assistant.profile_version });
      return freeze({ ...clone(update), profile: clone(assistant.profile) });
    },

    /** The committed updates another embodiment would read from shared state. */
    committedUpdates: ({ since_profile_version = 0 } = {}) => freeze(committedUpdates.filter(update => update.to_profile_version > since_profile_version).map(update => freeze(clone(update)))),

    registerEmbodiment({ device_ref, assistant_ref, state = 'FRESH', last_seen_at = null, executor_for = [], at: when } = {}) {
      if (!isText(device_ref)) throw new SettingsError('INVALID_REQUEST', 'device_ref is required');
      requireAssistant(assistant_ref);
      if (!EMBODIMENT_STATES.includes(state)) throw new SettingsError('INVALID_REQUEST', `state must be one of ${EMBODIMENT_STATES.join(', ')}`);
      const at = when ?? now();
      embodiments.set(device_ref, {
        device_ref,
        foreground_assistant_ref: assistant_ref,
        state,
        last_seen_at: last_seen_at ?? at,
        executor_for: freeze([...executor_for]),
        updated_at: at,
      });
      note('EMBODIMENT_REGISTERED', at, { device_ref, assistant_ref, state });
      return freeze(clone(embodiments.get(device_ref)));
    },

    observeEmbodiment({ device_ref, state, last_seen_at = null, at: when } = {}) {
      const embodiment = embodiments.get(device_ref);
      if (!embodiment) throw new SettingsError('INVALID_REQUEST', `no embodiment ${String(device_ref)}`);
      if (!EMBODIMENT_STATES.includes(state)) throw new SettingsError('INVALID_REQUEST', `state must be one of ${EMBODIMENT_STATES.join(', ')}`);
      const at = when ?? now();
      embodiment.state = state;
      embodiment.last_seen_at = last_seen_at ?? at;
      embodiment.updated_at = at;
      note('EMBODIMENT_OBSERVED', at, { device_ref, state });
      return freeze(clone(embodiment));
    },

    /** Where else the same logical assistant is present — identity, not a second assistant. */
    embodimentsOf({ assistant_ref, current_device_ref = null, at: when } = {}) {
      requireAssistant(assistant_ref);
      const at = when ?? now();
      return freeze({
        contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
        assistant_ref,
        embodiments: freeze([...embodiments.values()].filter(embodiment => embodiment.foreground_assistant_ref === assistant_ref).map(embodiment => freeze({
          device_ref: embodiment.device_ref,
          state: embodiment.state,
          is_current_device: embodiment.device_ref === current_device_ref,
          cached_view_is_authoritative: embodiment.state === 'FRESH' || embodiment.state === 'CURRENT',
          last_seen_at: embodiment.last_seen_at,
        }))),
        one_logical_assistant: true,
        independent_minds: false,
        at,
      });
    },

    /**
     * Foreground switching is a UI operation bound to one device. It never transfers responsibility, and the
     * result says so; a handoff must be requested explicitly if responsibility truly needs to move.
     */
    switchForeground({ device_ref, to_assistant_ref, at: when } = {}) {
      const embodiment = embodiments.get(device_ref);
      if (!embodiment) throw new SettingsError('INVALID_REQUEST', `no embodiment ${String(device_ref)}`);
      requireAssistant(to_assistant_ref);
      const at = when ?? now();
      const previous = embodiment.foreground_assistant_ref;
      embodiment.foreground_assistant_ref = to_assistant_ref;
      embodiment.updated_at = at;
      note('FOREGROUND_SWITCHED', at, { device_ref, from: previous, to: to_assistant_ref });
      return freeze({
        contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
        device_ref,
        from_assistant_ref: previous,
        to_assistant_ref,
        switched: previous !== to_assistant_ref,
        produces_task_handoff: false,
        tasks_restarted: false,
        tasks_duplicated: false,
        tasks_transferred: false,
        background_tasks_continue: true,
        ownership_unchanged: true,
        executor_unchanged: true,
        handoff_must_be_requested_separately: true,
        at,
      });
    },

    /** Requesting a handoff is the *only* way responsibility moves, and it is explicit. */
    requestHandoff({ device_ref, task_ref, to_assistant_ref, reason = 'USER_REQUESTED', at: when } = {}) {
      const embodiment = embodiments.get(device_ref);
      if (!embodiment) throw new SettingsError('INVALID_REQUEST', `no embodiment ${String(device_ref)}`);
      if (!isText(task_ref)) throw new SettingsError('INVALID_REQUEST', 'task_ref is required');
      requireAssistant(to_assistant_ref);
      const at = when ?? now();
      note('HANDOFF_REQUESTED', at, { device_ref, task_ref, to_assistant_ref });
      return freeze({
        contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
        device_ref,
        task_ref,
        from_assistant_ref: embodiment.foreground_assistant_ref,
        to_assistant_ref,
        reason,
        explicit_request: true,
        foreground_switch_implies_handoff: false,
        requires_recipient_acceptance: true,
        transfers_no_authority: true,
        applied_by: 'BA_004_HANDOFF',
        at,
      });
    },

    /**
     * The surface view. Foreground binding, logical owner and executor are separate fields, and a stale
     * embodiment's cached task/binding state is labelled a cache rather than shown as authority.
     */
    surfaceView({ device_ref, tasks = [], at: when } = {}) {
      const embodiment = embodiments.get(device_ref);
      if (!embodiment) throw new SettingsError('INVALID_REQUEST', `no embodiment ${String(device_ref)}`);
      const at = when ?? now();
      const stale = ['STALE', 'OFFLINE', 'RECONNECTING', 'UNKNOWN'].includes(embodiment.state);
      const backgroundTasks = tasks.filter(task => isPlainObject(task) && task.task_ref !== undefined && task.foreground !== true);
      const foregroundTasks = tasks.filter(task => isPlainObject(task) && task.foreground === true);
      return freeze({
        contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
        device_ref,
        assistant_identity: freeze({ assistant_ref: embodiment.foreground_assistant_ref, role: 'ASSISTANT_IDENTITY' }),
        user_identity: freeze({ source: 'DIGITAL_ME_CANONICAL', role: 'USER_IDENTITY', editable_from_settings: false }),
        foreground_binding: freeze({ device_ref, assistant_ref: embodiment.foreground_assistant_ref, role: 'FOREGROUND_BINDING', state: embodiment.state }),
        background_tasks: freeze(backgroundTasks.map(task => freeze({
          task_ref: task.task_ref,
          foreground: false,
          logical_owner_ref: task.owner_ref ?? null,
          executor_ref: task.executor_ref ?? null,
          role: 'LOGICAL_OWNER_AND_EXECUTOR_SEPARATE',
        }))),
        foreground_tasks: freeze(foregroundTasks.map(task => freeze({ task_ref: task.task_ref, foreground: true }))),
        background_tasks_hidden: false,
        identity_roles_are_distinct: true,
        foreground_is_not_ownership: true,
        ownership_is_not_execution: true,
        stale,
        cache_is_authoritative: false,
        stale_indicator: stale ? freeze({
          contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
          state: embodiment.state,
          last_seen_at: embodiment.last_seen_at,
          message: `this device is ${embodiment.state}; the tasks and binding shown are a cache, not current authority`,
          cached_view_is_authority: false,
          user_must_refresh: true,
        }) : null,
        reserved_adapters: freeze(RESERVED_ADAPTERS.map(adapter => freeze({ adapter, enabled: config.allow_reserved_adapters === true, required_now: false }))),
        at,
      });
    },

    /** The UI must not present a cached view as authority; this is the guard a caller can assert. */
    assertFresh({ device_ref, at: when } = {}) {
      const embodiment = embodiments.get(device_ref);
      if (!embodiment) throw new SettingsError('INVALID_REQUEST', `no embodiment ${String(device_ref)}`);
      const at = when ?? now();
      if (['STALE', 'OFFLINE', 'RECONNECTING', 'UNKNOWN'].includes(embodiment.state)) {
        throw new SettingsError('STALE_CACHE_IS_NOT_AUTHORITY', `device ${device_ref} is ${embodiment.state}; cached task/binding state is not current authority`, {
          device_ref, state: embodiment.state, cached_view_is_authority: false, refresh_required: true,
        });
      }
      return freeze({ contract_version: SETTINGS_SURFACE_CONTRACT_VERSION, device_ref, state: embodiment.state, cache_is_authoritative: false, fresh_confirmed: true, at });
    },

    /** Reserved for future voice/avatar editors; nothing current requires them. */
    reservedAdapter({ adapter } = {}) {
      if (!RESERVED_ADAPTERS.includes(adapter)) throw new SettingsError('INVALID_REQUEST', `adapter must be one of ${RESERVED_ADAPTERS.join(', ')}`);
      if (config.allow_reserved_adapters !== true) {
        throw new SettingsError('RESERVED_ADAPTER_UNAVAILABLE', `${adapter} is reserved and not enabled`, { adapter, required_now: false, enables_current_acceptance: false });
      }
      return freeze({ contract_version: SETTINGS_SURFACE_CONTRACT_VERSION, adapter, enabled: true });
    },

    surfaceActions: () => freeze([...SURFACE_ACTIONS]),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
