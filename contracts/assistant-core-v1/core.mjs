// Assistant Core — Shared Brain runtime (BA-002).
//
// One logical assistant, many embodiments, one authoritative durable state and
// many ContextProjections. This module is pure aside from an injectable clock:
// no filesystem, network or ambient state.
//
// Hard separation enforced here:
//   durable  = committed facts/decisions/checkpoints/commitments/memory refs/
//              plan artifacts/task references + the causal event log;
//   transient= live token context, scratch reasoning, plan drafts, uncommitted
//              inference and UI transient state, which stay embodiment-local and
//              can only become shared through an explicit typed promotion.
//
// Local state is a cache, not authority: a core restart bumps the epoch, and an
// embodiment handle from the previous epoch cannot promote anything until the
// device reconnects and re-fetches authoritative state.
import { createDeterministicProfilePort } from './profile-port.mjs';

export const ASSISTANT_CORE_VERSION = 1;
export const DURABLE_KINDS = Object.freeze(['FACT', 'DECISION', 'CHECKPOINT', 'COMMITMENT', 'MEMORY_REFERENCE', 'PLAN_ARTIFACT', 'TASK_REFERENCE']);
export const TRANSIENT_ONLY_KINDS = Object.freeze(['TOKEN_CONTEXT', 'SCRATCH_REASONING', 'PLAN_DRAFT', 'UNCOMMITTED_INFERENCE', 'UI_TRANSIENT']);
export const MEMORY_SCOPES = Object.freeze(['USER_GLOBAL', 'ASSISTANT_PRIVATE', 'PROJECT_TASK', 'AUDIENCE_CHANNEL', 'DEVICE_EPHEMERAL']);
export const DISCLOSURE_AUDIENCES = Object.freeze(['OWNER_PRIVATE', 'SHARED_DEVICE', 'PUBLIC_CHANNEL']);
// Knowledge is not disclosure authority: a projection may only emit records whose
// audience is visible to the requesting audience.
export const AUDIENCE_VISIBILITY = Object.freeze({
 OWNER_PRIVATE: Object.freeze(['OWNER_PRIVATE']),
 SHARED_DEVICE: Object.freeze(['OWNER_PRIVATE', 'SHARED_DEVICE']),
 PUBLIC_CHANNEL: Object.freeze(['PUBLIC_CHANNEL'])
});

// Authoritative assistant state is never canonical user identity, authority or a
// secret. (The Butler Zone contract owns profile-field validation; the Core only
// rejects state it must never hold.)
export const FORBIDDEN_CORE_STATE_FIELDS = Object.freeze([
 'digital_me', 'digitalMe', 'user_identity', 'userIdentity', 'user_self_model', 'canonical_user',
 'assistant_profile', 'profile', 'personality', 'voice', 'appearance',
 'permission', 'permissions', 'authority', 'grant', 'grants', 'lease', 'execution_lease',
 'capability_grants', 'action_key', 'policy'
]);
export const SECRET_FIELD_PATTERN = /(?:^|[._-])(token|secret|password|cookie|api[-_]?key|private[-_]?key|credential|access[-_]?token)(?:$|[._-])/i;
const REFERENCE_SUFFIX = /(?:_ref|_refs|_handle|_id)$/i;

export class AssistantCoreError extends Error {
 constructor(code, detail) {
  super(detail ? `${code}: ${detail}` : code);
  this.name = 'AssistantCoreError';
  this.code = code;
  this.detail = detail ?? null;
  this.status = 409;
 }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => (value === undefined ? undefined : structuredClone(value));
const isText = value => typeof value === 'string' && value.trim().length > 0;
// Order-independent fingerprint, so a retried promotion with the same logical
// payload replays instead of failing on key ordering.
const stableStringify = value => Array.isArray(value)
 ? '[' + value.map(stableStringify).join(',') + ']'
 : (isPlainObject(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}' : JSON.stringify(value ?? null));

export function findForbiddenCoreStateFields(value, path = 'payload', found = []) {
 if (Array.isArray(value)) { value.forEach((item, index) => findForbiddenCoreStateFields(item, `${path}[${index}]`, found)); return found; }
 if (!isPlainObject(value)) return found;
 for (const [key, child] of Object.entries(value)) {
  const childPath = `${path}.${key}`;
  if (FORBIDDEN_CORE_STATE_FIELDS.includes(key)) found.push({ path: childPath, reason: 'authority-or-user-identity' });
  else if (SECRET_FIELD_PATTERN.test(key) && !REFERENCE_SUFFIX.test(key)) found.push({ path: childPath, reason: 'raw-secret' });
  findForbiddenCoreStateFields(child, childPath, found);
 }
 return found;
}

// A profile is referenced, never copied: only the reference and the revision the
// reference was resolved at may cross into authoritative assistant state.
export function assertProfileReference(profileRef, path = 'profileRef') {
 const errors = [];
 if (!isPlainObject(profileRef)) errors.push(`${path} must be an object`);
 else {
  for (const key of Object.keys(profileRef)) if (key !== 'profile_ref' && key !== 'profile_revision') errors.push(`${path}.${key} must not be copied into assistant state; only profile_ref/profile_revision are allowed`);
  if (!isText(profileRef.profile_ref)) errors.push(`${path}.profile_ref must be nonempty text`);
  if (!Number.isSafeInteger(profileRef.profile_revision) || profileRef.profile_revision < 1) errors.push(`${path}.profile_revision must be a positive integer`);
 }
 if (errors.length) throw new AssistantCoreError('INVALID_PROFILE_REFERENCE', errors.slice(0, 3).join('; '));
 return profileRef;
}

// User identity/authority and raw secrets are reported with distinct codes so a
// caller can tell "this is not assistant state" from "this is not storable at all".
function assertNoForbiddenState(value, path) {
 const found = findForbiddenCoreStateFields(value, path);
 if (!found.length) return;
 const authority = found.filter(entry => entry.reason === 'authority-or-user-identity');
 const detail = found.map(entry => `${entry.path} (${entry.reason})`).slice(0, 3).join('; ');
 if (authority.length) throw new AssistantCoreError('PROMOTION_AUTHORITY_FORBIDDEN', detail);
 throw new AssistantCoreError('PROMOTION_SECRET_FORBIDDEN', detail);
}

export function validateCoreSnapshot(snapshot) {
 const errors = [];
 if (!isPlainObject(snapshot)) errors.push('snapshot must be an object');
 else {
  if (snapshot.core_version !== ASSISTANT_CORE_VERSION) errors.push(`snapshot.core_version must be ${ASSISTANT_CORE_VERSION}`);
  if (!Number.isSafeInteger(snapshot.core_epoch) || snapshot.core_epoch < 1) errors.push('snapshot.core_epoch must be a positive integer');
  if (!Array.isArray(snapshot.assistants)) errors.push('snapshot.assistants must be an array');
  else for (const entry of snapshot.assistants) {
   if (!isPlainObject(entry) || !isText(entry.assistant_id) || !Array.isArray(entry.records) || !Array.isArray(entry.events) || !Number.isSafeInteger(entry.core_revision)) errors.push('snapshot.assistants[] entries must carry assistant_id, records, events and core_revision');
  }
 }
 return { ok: errors.length === 0, errors };
}

export function createAssistantCore({ clock = () => null, profilePort = createDeterministicProfilePort(), seed = null } = {}) {
 const assistants = new Map();
 const embodiments = new Map();
 let epoch = 1;
 let embodimentCounter = 0;

 // Recovery seeding: durable state only. Embodiment handles are session state,
 // never restored, and the epoch advances so previous-session sessions are invalid.
 const applySnapshot = (snapshot, { keepEmbodiments }) => {
  const check = validateCoreSnapshot(snapshot);
  if (!check.ok) throw new AssistantCoreError('INCOMPATIBLE_CORE_SNAPSHOT', check.errors.slice(0, 3).join('; '));
  assistants.clear();
  if (!keepEmbodiments) embodiments.clear();
  epoch = snapshot.core_epoch + 1;
  for (const entry of snapshot.assistants) {
   assistants.set(entry.assistant_id, {
    assistantId: entry.assistant_id,
    profileRef: assertProfileReference(clone(entry.profile_ref)),
    coreRevision: entry.core_revision,
    logSequence: entry.log_sequence,
    createdAt: entry.created_at ?? null,
    updatedAt: entry.updated_at ?? null,
    records: clone(entry.records),
    events: clone(entry.events)
   });
  }
 };
 if (seed !== null) applySnapshot(seed, { keepEmbodiments: false });

 const requireAssistant = assistantId => {
  const state = assistants.get(assistantId);
  if (!state) throw new AssistantCoreError('ASSISTANT_NOT_FOUND', String(assistantId));
  return state;
 };
 const requireEmbodiment = embodimentRef => {
  const handle = embodiments.get(embodimentRef);
  if (!handle) throw new AssistantCoreError('EMBODIMENT_NOT_CONNECTED', String(embodimentRef));
  return handle;
 };
 // Cache, not authority: a handle minted before a restart can never write to the
 // restarted core.
 const requireLiveEmbodiment = embodimentRef => {
  const handle = requireEmbodiment(embodimentRef);
  if (handle.coreEpoch !== epoch) throw new AssistantCoreError('EMBODIMENT_SESSION_EXPIRED', `${embodimentRef} belongs to epoch ${handle.coreEpoch}, core is at epoch ${epoch}`);
  return handle;
 };
 const appendEvent = (state, event) => {
  const sequence = state.logSequence + 1;
  const stored = { sequence, ...event };
  state.logSequence = sequence;
  state.events.push(stored);
  return stored;
 };

 const core = {
  get epoch() { return epoch; },

  // ---- assistant + embodiments ------------------------------------------
  createAssistant(assistantId, { profileRef = null, profileRefFor = null, createdAt = clock() } = {}) {
   if (!isText(assistantId)) throw new AssistantCoreError('INVALID_ASSISTANT_ID', String(assistantId));
   if (assistants.has(assistantId)) throw new AssistantCoreError('ASSISTANT_ALREADY_EXISTS', assistantId);
   let resolved = profileRef;
   if (resolved === null) {
    resolved = profileRefFor ?? (typeof profilePort?.resolveProfileReference === 'function' ? profilePort.resolveProfileReference(assistantId) : null);
    if (!resolved) throw new AssistantCoreError('ASSISTANT_PROFILE_REFERENCE_REQUIRED', assistantId);
   }
   assertProfileReference(resolved);
   const state = {
    assistantId,
    profileRef: clone(resolved),
    coreRevision: 1,
    logSequence: 0,
    createdAt: createdAt ?? null,
    updatedAt: createdAt ?? null,
    records: [],
    events: []
   };
   assistants.set(assistantId, state);
   appendEvent(state, { event_type: 'ASSISTANT_CREATED', assistant_id: assistantId, core_revision: state.coreRevision, at: createdAt ?? null, caused_by: null });
   return { assistantId, coreRevision: state.coreRevision, profileRef: clone(state.profileRef) };
  },

  // Several embodiments of the same assistant may be connected at once.
  connectEmbodiment(assistantId, { deviceId, sessionRef = null, connectedAt = clock() } = {}) {
   requireAssistant(assistantId);
   if (!isText(deviceId)) throw new AssistantCoreError('INVALID_DEVICE_ID', String(deviceId));
   embodimentCounter += 1;
   const embodimentRef = `emb-${embodimentCounter}`;
   const handle = { embodimentRef, assistantId, deviceId, sessionRef: sessionRef ?? null, coreEpoch: epoch, connectedAt: connectedAt ?? null };
   embodiments.set(embodimentRef, handle);
   return clone(handle);
  },

  disconnectEmbodiment(embodimentRef) {
   const handle = requireEmbodiment(embodimentRef);
   embodiments.delete(embodimentRef);
   const remaining = [...embodiments.values()].filter(entry => entry.assistantId === handle.assistantId).length;
   return { embodimentRef, assistantId: handle.assistantId, disconnected: true, remainingEmbodiments: remaining, assistantActive: remaining > 0 };
  },

  // Disconnecting one embodiment never terminates the assistant while another
  // embodiment of the same assistant remains connected.
  assistantStatus(assistantId) {
   const state = requireAssistant(assistantId);
   const connected = [...embodiments.values()].filter(entry => entry.assistantId === assistantId);
   return { assistantId, active: connected.length > 0, embodiments: connected.length, devices: [...new Set(connected.map(entry => entry.deviceId))].sort(), coreRevision: state.coreRevision, logSequence: state.logSequence, coreEpoch: epoch };
  },

  attestEmbodiment(embodimentRef) {
   const handle = embodiments.get(embodimentRef);
   if (!handle) return { valid: false, reason: 'UNKNOWN_EMBODIMENT' };
   if (handle.coreEpoch !== epoch) return { valid: false, reason: 'SESSION_EXPIRED', coreEpoch: epoch };
   return { valid: true, assistantId: handle.assistantId, deviceId: handle.deviceId, coreEpoch: epoch };
  },

  // ---- embodiment-local transient state (never authoritative) ------------
  setTransientState(embodimentRef, { kind, value, at = clock() } = {}) {
   const handle = requireLiveEmbodiment(embodimentRef);
   if (!TRANSIENT_ONLY_KINDS.includes(kind)) {
    if (DURABLE_KINDS.includes(kind)) throw new AssistantCoreError('DURABLE_KIND_REQUIRES_PROMOTION', `${kind} must be promoted through the durable-state contract`);
    throw new AssistantCoreError('UNKNOWN_TRANSIENT_KIND', String(kind));
   }
   handle.transient = { ...(handle.transient ?? {}), [kind]: { value: clone(value), at: at ?? null } };
   return { embodimentRef, kind, at: at ?? null, durable: false };
  },

  getTransientState(embodimentRef) {
   const handle = requireEmbodiment(embodimentRef);
   return clone(handle.transient ?? {});
  },

  // ---- typed durable promotion ------------------------------------------
  // The only path from embodiment-local material into shared authoritative state.
  promote(embodimentRef, { kind, payload, scope = 'ASSISTANT_PRIVATE', audience = 'OWNER_PRIVATE', expectedRevision, idempotencyKey, causedBy = null, at = clock() } = {}) {
   const handle = requireLiveEmbodiment(embodimentRef);
   const state = requireAssistant(handle.assistantId);
   if (TRANSIENT_ONLY_KINDS.includes(kind)) throw new AssistantCoreError('EPHEMERAL_STATE_CANNOT_BE_PROMOTED_AS_IS', `${kind} stays embodiment-local unless committed as a durable record`);
   if (!DURABLE_KINDS.includes(kind)) throw new AssistantCoreError('UNKNOWN_PROMOTION_KIND', String(kind));
   if (!MEMORY_SCOPES.includes(scope)) throw new AssistantCoreError('UNKNOWN_MEMORY_SCOPE', String(scope));
   if (!DISCLOSURE_AUDIENCES.includes(audience)) throw new AssistantCoreError('UNKNOWN_DISCLOSURE_AUDIENCE', String(audience));
   if (scope === 'DEVICE_EPHEMERAL') throw new AssistantCoreError('EPHEMERAL_SCOPE_CANNOT_BE_PROMOTED', kind);
   if (!isText(idempotencyKey)) throw new AssistantCoreError('INVALID_IDEMPOTENCY_KEY', String(idempotencyKey));
   if (!Number.isSafeInteger(expectedRevision)) throw new AssistantCoreError('REVISION_CHECK_REQUIRED', 'expectedRevision is required for durable promotion');
   if (!isPlainObject(payload)) throw new AssistantCoreError('INVALID_PROMOTION_PAYLOAD', 'payload must be an object');
   assertNoForbiddenState(payload, 'payload');
   assertNoForbiddenState({ [kind]: payload }, 'record');

   const fingerprint = stableStringify({ kind, scope, audience, payload });
   const prior = state.events.find(event => event.idempotency_key === idempotencyKey);
   if (prior) {
    if (prior.promotion_fingerprint !== fingerprint) throw new AssistantCoreError('IDEMPOTENCY_KEY_REUSE', `${idempotencyKey} was already used for a different promotion`);
    const record = state.records.find(entry => entry.record_id === prior.record_id) ?? null;
    return { record: clone(record), event: clone(prior), coreRevision: state.coreRevision, replayed: true };
   }

   // Concurrent promotion/update attempts are settled by version checks rather
   // than silent last-writer-wins.
   if (expectedRevision !== state.coreRevision) throw new AssistantCoreError('STALE_REVISION', `expected ${expectedRevision}, current ${state.coreRevision}`);

   // Ids are derived from the assistant and its own record sequence, so recovery
   // cannot mint an id that collides with an existing record.
   const recordId = `${state.assistantId}:record:${state.records.length + 1}`;   const record = {
    record_id: recordId,
    sequence: state.records.length + 1,
    assistant_id: state.assistantId,
    kind,
    scope,
    audience,
    payload: clone(payload),
    promoted_by: { embodiment_ref: embodimentRef, device_id: handle.deviceId },
    promoted_at: at ?? null,
    core_revision: state.coreRevision + 1
   };
   state.records.push(record);
   state.coreRevision += 1;
   state.updatedAt = at ?? null;
   const event = appendEvent(state, {
    event_type: 'DURABLE_RECORD_PROMOTED',
    assistant_id: state.assistantId,
    record_id: recordId,
    kind,
    scope,
    audience,
    core_revision: state.coreRevision,
    caused_by: causedBy,
    idempotency_key: idempotencyKey,
    promotion_fingerprint: fingerprint,
    at: at ?? null
   });
   return { record: clone(record), event: clone(event), coreRevision: state.coreRevision, replayed: false };
  },

  readDurable(assistantId, { kinds = null, scope = null, audience = null, sinceSequence = 0 } = {}) {
   const state = requireAssistant(assistantId);
   const since = Number.isSafeInteger(sinceSequence) ? sinceSequence : 0;
   return state.records
    .map((record, index) => ({ record, sequence: index + 1 }))
    .filter(entry => entry.sequence > since)
    .filter(entry => (kinds === null || kinds.includes(entry.record.kind)))
    .filter(entry => (scope === null || entry.record.scope === scope))
    .filter(entry => (audience === null || entry.record.audience === audience))
    .map(entry => clone(entry.record));
  },

  causalLog(assistantId, { sinceSequence = 0 } = {}) {
   const state = requireAssistant(assistantId);
   const since = Number.isSafeInteger(sinceSequence) ? sinceSequence : 0;
   return state.events.filter(event => event.sequence > since).map(clone);
  },

  // ---- ContextProjection -------------------------------------------------
  // Material selected for one embodiment/session from authoritative state plus
  // that embodiment's own local context. Another embodiment's transient state is
  // never included, and disclosure is limited by audience and requested scopes.
  projectContext(embodimentRef, { audience = 'OWNER_PRIVATE', scopes = ['ASSISTANT_PRIVATE'], generatedAt = clock() } = {}) {
   const handle = requireEmbodiment(embodimentRef);
   const state = requireAssistant(handle.assistantId);
   if (!DISCLOSURE_AUDIENCES.includes(audience)) throw new AssistantCoreError('UNKNOWN_DISCLOSURE_AUDIENCE', String(audience));
   if (!Array.isArray(scopes)) throw new AssistantCoreError('INVALID_PROJECTION_SCOPES', 'scopes must be an array');
   for (const scope of scopes) if (!MEMORY_SCOPES.includes(scope)) throw new AssistantCoreError('UNKNOWN_MEMORY_SCOPE', String(scope));
   // DEVICE_EPHEMERAL is never promoted, but a projection may still ask for it and
   // simply finds nothing in authoritative state.
   const visible = AUDIENCE_VISIBILITY[audience];
   const withheld = [];
   const records = state.records.filter(record => {
    if (!scopes.includes(record.scope)) { withheld.push({ record_id: record.record_id, reason: 'SCOPE_NOT_REQUESTED' }); return false; }
    if (!visible.includes(record.audience)) { withheld.push({ record_id: record.record_id, reason: 'AUDIENCE_NOT_PERMITTED' }); return false; }
    return true;
   });
   return {
    projection_version: ASSISTANT_CORE_VERSION,
    assistant_id: state.assistantId,
    profile_ref: clone(state.profileRef),
    embodiment_ref: embodimentRef,
    device_id: handle.deviceId,
    core_epoch: epoch,
    core_revision: state.coreRevision,
    log_sequence: state.logSequence,
    scope_stale: handle.coreEpoch !== epoch,
    audience,
    scopes: [...scopes],
    records: clone(records),
    withheld,
    // only this embodiment's own local context
    local_transient: clone(handle.transient ?? {}),
    generated_at: generatedAt ?? null
   };
  },

  // ---- lifecycle / recovery ---------------------------------------------
  // In-process recovery: durable state is replaced and the epoch advances, while
  // existing embodiment handles stay registered so their previous-session
  // staleness is detected (EMBODIMENT_SESSION_EXPIRED) instead of silently
  // resuming with local scratch state.
  reloadFromSnapshot(snapshot) {
   const check = validateCoreSnapshot(snapshot);
   if (!check.ok) throw new AssistantCoreError('INCOMPATIBLE_CORE_SNAPSHOT', check.errors.slice(0, 3).join('; '));
   applySnapshot(snapshot, { keepEmbodiments: true });
   return { coreEpoch: epoch, assistants: [...assistants.keys()].sort(), liveEmbodiments: embodiments.size };
  },

  // Durable state only: transient per-embodiment material is deliberately absent,
  // so it can never be restored as authority.
  snapshot() {
   return {
    core_version: ASSISTANT_CORE_VERSION,
    core_epoch: epoch,
    assistants: [...assistants.values()].map(state => ({
     assistant_id: state.assistantId,
     profile_ref: clone(state.profileRef),
     core_revision: state.coreRevision,
     log_sequence: state.logSequence,
     created_at: state.createdAt,
     updated_at: state.updatedAt,
     records: clone(state.records),
     events: clone(state.events)
    })).sort((a, b) => a.assistant_id.localeCompare(b.assistant_id))
   };
  }
 };

 return Object.freeze(core);
}

// Recovery: a restarted core keeps the logical assistant and every durable
// record, but starts a new epoch so no embodiment can resume side effects or
// promote scratch state from its previous session.
export function restoreAssistantCore(snapshot, { clock = () => null, profilePort = createDeterministicProfilePort() } = {}) {
 const check = validateCoreSnapshot(snapshot);
 if (!check.ok) throw new AssistantCoreError('INCOMPATIBLE_CORE_SNAPSHOT', check.errors.slice(0, 3).join('; '));
 return createAssistantCore({ clock, profilePort, seed: snapshot });
}
