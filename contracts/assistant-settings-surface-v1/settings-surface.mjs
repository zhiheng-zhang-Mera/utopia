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

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isText = value => typeof value === 'string' && value.trim().length > 0;
const nullableText = value => value === null || isText(value);
const clone = value => (value === undefined ? undefined : structuredClone(value));
/** Cycle-safe: a caller-supplied structure must not be able to blow the stack. */
const freeze = value => {
  const seen = new WeakSet();
  const walk = node => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);
    for (const child of Object.values(node)) walk(child);
    return Object.freeze(node);
  };
  return walk(value);
};
export const isIsoInstant = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && !Number.isNaN(Date.parse(value));

const INSTANT_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const isRealInstant = value => {
  if (!isIsoInstant(value)) return false;
  const parts = INSTANT_PARTS.exec(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return date.getUTCFullYear() === Number(parts[1])
    && date.getUTCMonth() + 1 === Number(parts[2])
    && date.getUTCDate() === Number(parts[3])
    && date.getUTCHours() === Number(parts[4])
    && date.getUTCMinutes() === Number(parts[5])
    && date.getUTCSeconds() === Number(parts[6]);
};

/** A settings field carries the kind of value its name promises; nothing else reaches the profile. */
const EDITABLE_FIELD_RULES = Object.freeze({
  display_name: { kind: 'text' },
  mode: { kind: 'enum', values: ASSISTANT_MODES },
  voice_ref: { kind: 'ref' },
  avatar_ref: { kind: 'ref' },
  locale: { kind: 'ref' },
  verbosity: { kind: 'token' },
  proactivity: { kind: 'token' },
});

/** Returns a list of 'field: reason' strings; an empty list means every declared value is usable. */
function checkEditableValue(field, value) {
  const rule = EDITABLE_FIELD_RULES[field];
  if (rule === undefined) return null;
  if (value === undefined) return 'an explicit undefined would silently clear the field instead of changing it';
  if (value === null) return rule.kind === 'text' || rule.kind === 'enum' ? 'this field may not be cleared' : null;
  if (rule.kind === 'text') return isText(value) ? null : 'must be nonempty text';
  if (rule.kind === 'enum') return rule.values.includes(value) ? null : `must be one of ${rule.values.join(', ')}`;
  if (rule.kind === 'ref') return isText(value) ? null : 'must be a nonempty reference or null';
  if (rule.kind === 'token') return isText(value) ? null : 'must be a nonempty token or null';
  return null;
}

export const DEFAULT_SURFACE_POLICY = Object.freeze({
  policy_ref: 'policy:ba-settings-default',
  profile_version_required: true,
  allow_reserved_adapters: false,
  // How long an embodiment's last observation stays usable as current authority before the view must be
  // treated as a cache. A declared state string alone cannot make an old observation fresh.
  stale_after_ms: 300000,
});

export function createInteractionSurface({ clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new SettingsError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) throw new SettingsError('INVALID_REQUEST', 'policy must be a plain object');
  const config = { ...DEFAULT_SURFACE_POLICY, ...(isPlainObject(policy) ? policy : {}) };
  for (const key of Reflect.ownKeys(config)) {
    if (typeof key !== 'string' || !Object.hasOwn(DEFAULT_SURFACE_POLICY, key)) throw new SettingsError('INVALID_REQUEST', `policy.${String(key)} is not part of the settings policy`);
  }
  if (typeof config.allow_reserved_adapters !== 'boolean') throw new SettingsError('INVALID_REQUEST', 'policy.allow_reserved_adapters must be a boolean');
  if (!Number.isSafeInteger(config.stale_after_ms) || config.stale_after_ms <= 0) throw new SettingsError('INVALID_REQUEST', `policy.stale_after_ms must be a positive integer, got ${String(config.stale_after_ms)}`);
  // Version-checked writes are how a committed profile update stays safe across embodiments; a caller may
  // not switch that guard off for the same profile it is editing.
  if (config.profile_version_required !== true) throw new SettingsError('INVALID_REQUEST', 'an assistant profile edit must be version-checked, so policy.profile_version_required must be true');
  if (!isText(config.policy_ref)) throw new SettingsError('INVALID_REQUEST', 'policy.policy_ref must be nonempty text');
  const assistants = new Map();
  const embodiments = new Map();
  const committedUpdates = [];
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new SettingsError('INVALID_CLOCK', 'clock() must return a real ISO-8601 UTC instant');
    return produced;
  };

  /** A caller-supplied instant is validated: a recorded timestamp is evidence, including its reality. */
  const atFrom = when => {
    if (when === undefined || when === null) return now();
    if (!isRealInstant(when)) throw new SettingsError('INVALID_REQUEST', `at must be a real ISO-8601 UTC instant, got ${String(when)}`);
    return when;
  };

  /** A device's observation instant is rendered in the UI, so it is validated like any other evidence. */
  const seenAtFrom = (value, fallback) => {
    if (value === undefined || value === null) return fallback;
    if (!isRealInstant(value)) throw new SettingsError('INVALID_REQUEST', `last_seen_at must be a real ISO-8601 UTC instant, got ${String(value)}`);
    return value;
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

  /** Freshness is the declared state AND a recent enough observation; either one alone is not authority. */
  const freshnessOf = (embodiment, at) => {
    const declared_stale = ['STALE', 'OFFLINE', 'RECONNECTING', 'UNKNOWN'].includes(embodiment.state);
    const seen = isRealInstant(embodiment.last_seen_at) ? Date.parse(embodiment.last_seen_at) : null;
    const nowMs = Date.parse(at);
    const age_ms = seen === null ? null : nowMs - seen;
    const window_expired = age_ms === null || age_ms > config.stale_after_ms;
    return {
      stale: declared_stale || window_expired,
      declared_state: embodiment.state,
      last_seen_at: embodiment.last_seen_at,
      age_ms,
      stale_after_ms: config.stale_after_ms,
      stale_reason: declared_stale ? 'DECLARED_STATE_NOT_CURRENT' : window_expired ? 'OBSERVATION_OLDER_THAN_WINDOW' : null,
      state_is_caller_declared: true,
    };
  };

  const api = {
    policy: () => freeze(clone(config)),
    identityKinds: () => freeze([...IDENTITY_KINDS]),

    registerAssistant({ assistant_ref, display_name, mode = 'BUTLER', voice_ref = null, avatar_ref = null, locale = null, verbosity = null, proactivity = null, at: when } = {}) {
      if (!isText(assistant_ref) || !isText(display_name)) throw new SettingsError('INVALID_REQUEST', 'assistant_ref and display_name are required');
      if (assistants.has(assistant_ref)) throw new SettingsError('DUPLICATE_ASSISTANT', `assistant ${assistant_ref} is already registered`);
      if (!ASSISTANT_MODES.includes(mode)) throw new SettingsError('INVALID_FIELD', `mode must be one of ${ASSISTANT_MODES.join(', ')}`);
      const at = atFrom(when);
      for (const [field, value] of [['display_name', display_name], ['mode', mode], ['voice_ref', voice_ref], ['avatar_ref', avatar_ref], ['locale', locale], ['verbosity', verbosity], ['proactivity', proactivity]]) {
        const problem = checkEditableValue(field, value);
        if (problem !== null) throw new SettingsError('INVALID_FIELD', `${field} ${problem}`, { field, editable_fields: freeze([...EDITABLE_FIELDS]) });
      }
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
      const at = atFrom(when);
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
    editProfile({ assistant_ref, expected_profile_version, changes = {}, actor_ref = null, at: when } = {}) {
      const assistant = requireAssistant(assistant_ref);
      // The declared fields are the only thing this surface may change, and the shape is decided on the
      // object itself: a symbol key or a non-enumerable own key would otherwise be dropped in silence and
      // the caller would believe it had been written.
      if (!isPlainObject(changes)) throw new SettingsError('INVALID_REQUEST', 'changes must be a plain object of editable fields');
      for (const key of Reflect.ownKeys(changes)) {
        if (typeof key === 'string' && EDITABLE_FIELDS.includes(key)) continue;
        const field = String(key);
        if (typeof key === 'string' && (field.startsWith('user_') || field === 'digital_me' || field === 'canonical_user')) {
          throw new SettingsError('DIGITAL_ME_IS_READ_ONLY', 'assistant settings never edit Digital-Me canonical user records', { fields: freeze([field]), canonical_source: 'DIGITAL_ME_CANONICAL', written: false });
        }
        throw new SettingsError('INVALID_FIELD', `${field} is not an editable assistant profile field`, { field, editable_fields: freeze([...EDITABLE_FIELDS]) });
      }
      if (Object.keys(changes).length === 0) throw new SettingsError('INVALID_REQUEST', 'changes must contain at least one editable field');
      if (changes.mode !== undefined && !ASSISTANT_MODES.includes(changes.mode)) throw new SettingsError('INVALID_FIELD', `mode must be one of ${ASSISTANT_MODES.join(', ')}`);
      for (const field of Object.keys(changes)) {
        const problem = checkEditableValue(field, changes[field]);
        if (problem !== null) throw new SettingsError('INVALID_FIELD', `${field} ${problem}`, { field, editable_fields: freeze([...EDITABLE_FIELDS]) });
      }
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
      const at = atFrom(when);
      counter += 1;
      const update = freeze({
        contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
        update_ref: `profile-update:${counter}`,
        assistant_ref,
        from_profile_version: assistant.profile_version,
        to_profile_version: assistant.profile_version + 1,
        changed_fields: freeze(Object.keys(changes)),
        // The record must carry the change it commits, not only the field names: another embodiment applies
        // the propagation from this record, and an audit needs the before/after values.
        changed: freeze(clone(changes)),
        previous_values: freeze(clone(Object.fromEntries(Object.keys(changes).map(field => [field, assistant.profile[field]])))),
        actor_ref: isText(actor_ref) ? actor_ref : null,
        actor_known: isText(actor_ref),
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
      note('PROFILE_COMMITTED', at, {
        assistant_ref,
        from_profile_version: update.from_profile_version,
        to_profile_version: assistant.profile_version,
        changed_fields: update.changed_fields,
        actor_ref: update.actor_ref,
        actor_known: update.actor_known,
      });
      return freeze({ ...clone(update), profile: clone(assistant.profile) });
    },

    /** The committed updates another embodiment would read from shared state. */
    committedUpdates: ({ since_profile_version = 0 } = {}) => {
      // An unreadable cursor must not read as "there is nothing to synchronise".
      if (!Number.isSafeInteger(since_profile_version) || since_profile_version < 0) {
        throw new SettingsError('INVALID_REQUEST', `since_profile_version must be a non-negative integer, got ${String(since_profile_version)}`);
      }
      return freeze(committedUpdates.filter(update => update.to_profile_version > since_profile_version).map(update => freeze(clone(update))));
    },

    registerEmbodiment({ device_ref, assistant_ref, state = 'FRESH', last_seen_at = null, executor_for = [], at: when } = {}) {
      if (!isText(device_ref)) throw new SettingsError('INVALID_REQUEST', 'device_ref is required');
      requireAssistant(assistant_ref);
      if (!EMBODIMENT_STATES.includes(state)) throw new SettingsError('INVALID_REQUEST', `state must be one of ${EMBODIMENT_STATES.join(', ')}`);
      if (!Array.isArray(executor_for) || executor_for.some(entry => !isText(entry))) {
        throw new SettingsError('INVALID_REQUEST', 'executor_for must be a list of task references', { device_ref });
      }
      const at = atFrom(when);
      const seen = seenAtFrom(last_seen_at, at);
      const existing = embodiments.get(device_ref) ?? null;
      // Re-registering a device under a different assistant would silently discard the foreground binding
      // the user chose on that device, so it is a refusal rather than a quiet overwrite.
      if (existing !== null && existing.foreground_assistant_ref !== assistant_ref) {
        throw new SettingsError('INVALID_REQUEST', `device ${device_ref} is bound to ${String(existing.foreground_assistant_ref)}; use switchForeground to change the binding`, {
          device_ref, current_foreground_assistant_ref: existing.foreground_assistant_ref, requested_assistant_ref: assistant_ref,
        });
      }
      embodiments.set(device_ref, {
        device_ref,
        foreground_assistant_ref: existing === null ? assistant_ref : existing.foreground_assistant_ref,
        state,
        last_seen_at: seen,
        executor_for: freeze([...new Set(executor_for)]),
        updated_at: at,
      });
      note('EMBODIMENT_REGISTERED', at, { device_ref, assistant_ref, state });
      return freeze(clone(embodiments.get(device_ref)));
    },

    observeEmbodiment({ device_ref, state, last_seen_at = null, at: when } = {}) {
      const embodiment = embodiments.get(device_ref);
      if (!embodiment) throw new SettingsError('INVALID_REQUEST', `no embodiment ${String(device_ref)}`);
      if (!EMBODIMENT_STATES.includes(state)) throw new SettingsError('INVALID_REQUEST', `state must be one of ${EMBODIMENT_STATES.join(', ')}`);
      const at = atFrom(when);
      embodiment.state = state;
      embodiment.last_seen_at = seenAtFrom(last_seen_at, at);
      embodiment.updated_at = at;
      note('EMBODIMENT_OBSERVED', at, { device_ref, state });
      return freeze(clone(embodiment));
    },

    /** Where else the same logical assistant is present — identity, not a second assistant. */
    embodimentsOf({ assistant_ref, current_device_ref = null, at: when } = {}) {
      requireAssistant(assistant_ref);
      const at = atFrom(when);
      return freeze({
        contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
        assistant_ref,
        embodiments: freeze([...embodiments.values()].filter(embodiment => embodiment.foreground_assistant_ref === assistant_ref).map(embodiment => freeze({
          device_ref: embodiment.device_ref,
          state: embodiment.state,
          is_current_device: embodiment.device_ref === current_device_ref,
          // A projection never claims to be current authority: it carries the declared state and the window.
          cached_view_is_authoritative: false,
          state_is_caller_declared: true,
          freshness_window_ms: config.stale_after_ms,
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
      const at = atFrom(when);
      const freshness = freshnessOf(embodiment, at);
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
        // A switch taken while the view is a cache is recorded as provisional, not as a current binding.
        binding_from_cached_view: freshness.stale,
        requires_authoritative_revalidation: freshness.stale,
        stale_reason: freshness.stale_reason,
        at,
      });
    },

    /** Requesting a handoff is the *only* way responsibility moves, and it is explicit. */
    requestHandoff({ device_ref, task_ref, to_assistant_ref, reason = 'USER_REQUESTED', at: when } = {}) {
      const embodiment = embodiments.get(device_ref);
      if (!embodiment) throw new SettingsError('INVALID_REQUEST', `no embodiment ${String(device_ref)}`);
      if (!isText(task_ref)) throw new SettingsError('INVALID_REQUEST', 'task_ref is required');
      requireAssistant(to_assistant_ref);
      const at = atFrom(when);
      // Responsibility must not be moved on the strength of a cached view: a handoff from a device whose
      // task/binding state is not current would transfer what the cache claims, not what is true.
      const freshness = freshnessOf(embodiment, at);
      if (freshness.stale) {
        throw new SettingsError('STALE_CACHE_IS_NOT_AUTHORITY', `device ${device_ref} is ${embodiment.state}; a handoff cannot be requested from a cached view`, {
          device_ref, task_ref, state: embodiment.state, stale_reason: freshness.stale_reason, requested: false,
        });
      }
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
      const at = atFrom(when);
      const freshness = freshnessOf(embodiment, at);
      const stale = freshness.stale;
      // A task the surface cannot read must be reported, not dropped: hiding an active background task is
      // exactly what the workbook forbids, and "nothing is hidden" must not be an unchecked claim.
      const unreadable = [];
      const backgroundTasks = [];
      const foregroundTasks = [];
      for (const task of tasks) {
        // The foreground flag is a boolean assertion; a truthy stand-in would be silently reported as background.
        if (isPlainObject(task) && task.foreground !== undefined && typeof task.foreground !== 'boolean') {
          unreadable.push({ reason: 'NON_BOOLEAN_FOREGROUND', foreground: null });
          continue;
        }
        const task_ref = isPlainObject(task) && isText(task.task_ref) ? task.task_ref : null;
        if (task_ref === null) { unreadable.push({ reason: 'MISSING_TASK_REF', foreground: isPlainObject(task) && task.foreground === true }); continue; }
        if (isPlainObject(task) && task.foreground === true) foregroundTasks.push({ ...task, task_ref });
        else if (isPlainObject(task)) backgroundTasks.push({ ...task, task_ref });
        else unreadable.push({ reason: 'NOT_A_TASK_RECORD', foreground: false });
      }
      return freeze({
        contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
        device_ref,
        assistant_identity: freeze({ assistant_ref: embodiment.foreground_assistant_ref, role: 'ASSISTANT_IDENTITY' }),
        user_identity: freeze({ source: 'DIGITAL_ME_CANONICAL', role: 'USER_IDENTITY', editable_from_settings: false }),
        foreground_binding: freeze({ device_ref, assistant_ref: embodiment.foreground_assistant_ref, role: 'FOREGROUND_BINDING', state: embodiment.state }),
        background_tasks: freeze(backgroundTasks.map(task => freeze({
          task_ref: task.task_ref,
          foreground: false,
          logical_owner_ref: isText(task.owner_ref) ? task.owner_ref : null,
          executor_ref: isText(task.executor_ref) ? task.executor_ref : null,
          owner_is_executor_distinct: isText(task.owner_ref) && isText(task.executor_ref) && task.owner_ref !== task.executor_ref,
          role: isText(task.owner_ref) || isText(task.executor_ref) ? 'LOGICAL_OWNER_AND_EXECUTOR_SEPARATE' : 'LOGICAL_OWNER_AND_EXECUTOR_UNKNOWN',
        }))),
        foreground_tasks: freeze(foregroundTasks.map(task => freeze({ task_ref: task.task_ref, foreground: true }))),
        unreadable_tasks: freeze(unreadable.map(entry => freeze(clone(entry)))),
        background_tasks_hidden: unreadable.length > 0,
        identity_roles_are_distinct: true,
        foreground_is_not_ownership: true,
        ownership_is_not_execution: true,
        stale,
        cache_is_authoritative: false,
        stale_indicator: stale ? freeze({
          contract_version: SETTINGS_SURFACE_CONTRACT_VERSION,
          state: embodiment.state,
          last_seen_at: embodiment.last_seen_at,
          age_ms: freshness.age_ms,
          stale_after_ms: freshness.stale_after_ms,
          stale_reason: freshness.stale_reason,
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
      const at = atFrom(when);
      const freshness = freshnessOf(embodiment, at);
      if (freshness.stale) {
        throw new SettingsError('STALE_CACHE_IS_NOT_AUTHORITY', `device ${device_ref} is ${embodiment.state}; cached task/binding state is not current authority`, {
          device_ref, state: embodiment.state, stale_reason: freshness.stale_reason, age_ms: freshness.age_ms, stale_after_ms: freshness.stale_after_ms, cached_view_is_authority: false, refresh_required: true,
        });
      }
      return freeze({ contract_version: SETTINGS_SURFACE_CONTRACT_VERSION, device_ref, state: embodiment.state, last_seen_at: embodiment.last_seen_at, cache_is_authoritative: false, fresh_confirmed: true, at });
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
