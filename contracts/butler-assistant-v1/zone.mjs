// Butler Assistant Zone (BA-001) — assistant identity + personalization ownership.
//
// The Zone owns assistant identities and their replaceable profiles. It never
// touches Digital-Me: no API accepts Digital-Me state, and import rejects any
// bundle that claims a Digital-Me/user-canonical namespace. Assistant↔user
// relationship state lives on the assistant profile, not on the user model.
//
// Durable state mutations carry a monotonic `revision`; callers may pass
// `expectedRevision` to refuse stale writes (lost-update guard). Presence is
// explicitly *not* durable: it is a session cache and is never exported.
import {
 BUNDLE_KIND, BUNDLE_VERSION, DEFAULT_PORT_REGISTRY,
 PersonalizationError, applyProfilePatch, createDefaultProfile,
 findAuthorityPaths, findDigitalMePaths, normalizeProfile, validateProfile
} from './personalization.mjs';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => (value === undefined ? undefined : structuredClone(value));
const isText = value => typeof value === 'string' && value.trim().length > 0;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

// Timestamps are caller-supplied (this module owns no clock), so they are typed
// explicitly rather than trusted: a Date object must never leak into state.
function checkTimestamp(value, code) {
 if (value === null || value === undefined) return value ?? null;
 if (!isText(value)) throw new PersonalizationError(code, String(value));
 return value;
}

export function validateBundle(bundle, { registry = DEFAULT_PORT_REGISTRY } = {}) {
 const errors = [];
 if (!isPlainObject(bundle)) return { ok: false, errors: ['bundle must be an object'] };
 if (bundle.kind !== BUNDLE_KIND) errors.push(`bundle.kind must be ${BUNDLE_KIND}`);
 if (bundle.bundle_version !== BUNDLE_VERSION) errors.push(`bundle.bundle_version must be ${BUNDLE_VERSION}`);
 for (const key of Object.keys(bundle)) if (!['kind', 'bundle_version', 'exported_at', 'assistant'].includes(key)) errors.push(`bundle.${key} is not part of the portable assistant bundle`);
 const assistant = bundle.assistant;
 if (!isPlainObject(assistant)) errors.push('bundle.assistant must be an object');
 else {
  for (const key of Object.keys(assistant)) if (!['assistant_id', 'id_source', 'created_at', 'profile'].includes(key)) errors.push(`bundle.assistant.${key} is not part of the portable assistant bundle`);
  if (!isText(assistant.assistant_id) || !ID_PATTERN.test(assistant.assistant_id)) errors.push('bundle.assistant.assistant_id must be a valid assistant identifier');
  if (assistant.id_source !== 'provided' && assistant.id_source !== 'minted') errors.push('bundle.assistant.id_source must be provided or minted');
  if (assistant.created_at !== null && !isText(assistant.created_at)) errors.push('bundle.assistant.created_at must be text or null');
  const profileResult = validateProfile(assistant.profile, { registry });
  for (const error of profileResult.errors) errors.push(`bundle.assistant.${error}`);
 }
 // A bundle is portable assistant state: it may not carry Digital-Me identity
 // data, and it may not smuggle authority into a profile.
 for (const path of findDigitalMePaths(bundle, 'bundle')) errors.push(`${path} must not be exported into or imported from the assistant bundle`);
 for (const path of findAuthorityPaths(bundle, 'bundle')) errors.push(`${path} is an authority field; personalization cannot grant authority`);
 return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function createAssistantZone({ registry = DEFAULT_PORT_REGISTRY, clock = () => null } = {}) {
 const identities = new Map();
 const presence = new Map();
 let mintCounter = 0;

 const requireIdentity = assistantId => {
  const record = identities.get(assistantId);
  if (!record) throw new PersonalizationError('ASSISTANT_NOT_FOUND', String(assistantId));
  return record;
 };
 const checkRevision = (record, expectedRevision) => {
  if (expectedRevision === undefined || expectedRevision === null) return;
  if (!Number.isInteger(expectedRevision)) throw new PersonalizationError('INVALID_EXPECTED_REVISION', String(expectedRevision));
  if (expectedRevision !== record.revision) throw new PersonalizationError('PROFILE_REVISION_CONFLICT', `expected ${expectedRevision}, current ${record.revision}`);
 };
 const mintAssistantId = () => {
  let candidate;
  do { mintCounter += 1; candidate = `assistant-${mintCounter}`; } while (identities.has(candidate));
  return candidate;
 };
 const presenceKey = (assistantId, deviceId) => `${assistantId}\u0000${deviceId}`;

 const zone = {
  // ---- identity lifecycle ------------------------------------------------
  createIdentity({ assistantId = null, profile = null, createdAt = clock() } = {}) {
   if (assistantId !== null && (!isText(assistantId) || !ID_PATTERN.test(assistantId))) throw new PersonalizationError('INVALID_ASSISTANT_ID', String(assistantId));
   const resolvedId = assistantId ?? mintAssistantId();
   if (identities.has(resolvedId)) throw new PersonalizationError('ASSISTANT_ID_CONFLICT', resolvedId);
   checkTimestamp(createdAt, 'INVALID_TIMESTAMP');
   const resolvedProfile = profile === null
    ? createDefaultProfile({ registry })
    : normalizeProfile(profile, { registry, version: profile.schema_version ?? registry.schemaVersion });
   const record = {
    assistantId: resolvedId,
    // Recorded honestly: an id the caller supplied is not a minted identity.
    idSource: assistantId === null ? 'minted' : 'provided',
    createdAt: createdAt ?? null,
    updatedAt: createdAt ?? null,
    revision: 1,
    profile: resolvedProfile
   };
   identities.set(resolvedId, record);
   return clone(record);
  },

  getIdentity(assistantId) { return clone(requireIdentity(assistantId)); },
  hasIdentity(assistantId) { return identities.has(assistantId); },
  listIdentities() { return [...identities.values()].map(clone).sort((a, b) => a.assistantId.localeCompare(b.assistantId)); },

  removeIdentity(assistantId) {
   requireIdentity(assistantId);
   identities.delete(assistantId);
   for (const [key, entry] of [...presence]) if (entry.assistantId === assistantId) presence.delete(key);
   return { assistantId, removed: true };
  },

  // ---- profile (replaceable personalization state) -----------------------
  getProfile(assistantId) { return clone(requireIdentity(assistantId).profile); },

  setProfile(assistantId, profile, { expectedRevision = null, at = clock() } = {}) {
   const record = requireIdentity(assistantId);
   checkRevision(record, expectedRevision);
   checkTimestamp(at, 'INVALID_TIMESTAMP');
   // Validate the next state completely before mutating, so a rejected write is a no-op.
   const next = normalizeProfile(profile, { registry, version: profile?.schema_version ?? record.profile.schema_version });
   record.profile = next;
   record.revision += 1;
   record.updatedAt = at ?? null;
   return clone(record);
  },

  patchProfile(assistantId, patch, { expectedRevision = null, at = clock() } = {}) {
   const record = requireIdentity(assistantId);
   checkRevision(record, expectedRevision);
   checkTimestamp(at, 'INVALID_TIMESTAMP');
   const next = applyProfilePatch(record.profile, patch, { registry });
   record.profile = next;
   record.revision += 1;
   record.updatedAt = at ?? null;
   return clone(record);
  },

  resetProfile(assistantId, { expectedRevision = null, at = clock(), keepExtensions = false } = {}) {
   const record = requireIdentity(assistantId);
   checkRevision(record, expectedRevision);
   checkTimestamp(at, 'INVALID_TIMESTAMP');
   const extensions = keepExtensions ? clone(record.profile.extensions) : {};
   record.profile = createDefaultProfile({ overrides: { extensions }, registry });
   record.revision += 1;
   record.updatedAt = at ?? null;
   return clone(record);
  },

  resetAllProfiles({ at = clock() } = {}) {
   checkTimestamp(at, 'INVALID_TIMESTAMP');
   const reset = [];
   for (const record of identities.values()) {
    record.profile = createDefaultProfile({ registry });
    record.revision += 1;
    record.updatedAt = at ?? null;
    reset.push(record.assistantId);
   }
   return { reset: reset.sort() };
  },

  // ---- presence (session cache, never durable, never exported) -----------
  // Several assistant identities may be online at once. Foreground binding is
  // deliberately out of scope here (BA-003 owns it), so presence does not elect
  // a foreground assistant and never touches tasks.
  setPresence(assistantId, { deviceId, sessionId = null, since = clock() } = {}) {
   requireIdentity(assistantId);
   if (!isText(deviceId)) throw new PersonalizationError('INVALID_DEVICE_ID', String(deviceId));
   checkTimestamp(since, 'INVALID_TIMESTAMP');
   checkTimestamp(sessionId, 'INVALID_TIMESTAMP');
   const key = presenceKey(assistantId, deviceId);
   const existing = presence.get(key);
   if (existing) return { ...clone(existing), idempotent: true };
   const entry = { assistantId, deviceId, sessionId: sessionId ?? null, since: since ?? null };
   presence.set(key, entry);
   return { ...clone(entry), idempotent: false };
  },

  clearPresence(assistantId, { deviceId } = {}) {
   const key = presenceKey(assistantId, deviceId);
   const existed = presence.delete(key);
   return { assistantId, deviceId, cleared: existed };
  },

  listPresence() { return [...presence.values()].map(clone).sort((a, b) => (a.assistantId + a.deviceId).localeCompare(b.assistantId + b.deviceId)); },
  listOnlineAssistantIds() { return [...new Set([...presence.values()].map(entry => entry.assistantId))].sort(); },

  // ---- portable export / import ------------------------------------------
  exportBundle(assistantId, { exportedAt = clock() } = {}) {
   const record = requireIdentity(assistantId);
   checkTimestamp(exportedAt, 'INVALID_TIMESTAMP');
   return {
    kind: BUNDLE_KIND,
    bundle_version: BUNDLE_VERSION,
    exported_at: exportedAt ?? null,
    assistant: {
     assistant_id: record.assistantId,
     id_source: record.idSource,
     created_at: record.createdAt,
     profile: clone(record.profile)
    }
   };
  },

  // Atomic: the whole bundle is validated before any state changes, so a failed
  // import leaves the zone exactly as it was.
  importBundle(bundle, { mode = 'create', importedAt = clock() } = {}) {
   if (mode !== 'create' && mode !== 'replace') throw new PersonalizationError('INVALID_IMPORT_MODE', String(mode));
   const result = validateBundle(bundle, { registry });
   if (!result.ok) throw new PersonalizationError('INVALID_ASSISTANT_BUNDLE', result.errors.slice(0, 3).join('; '));
   checkTimestamp(importedAt, 'INVALID_TIMESTAMP');
   const source = bundle.assistant;
   const existing = identities.get(source.assistant_id);
   if (mode === 'create' && existing) throw new PersonalizationError('ASSISTANT_ID_CONFLICT', source.assistant_id);
   if (mode === 'replace' && !existing) throw new PersonalizationError('ASSISTANT_NOT_FOUND', source.assistant_id);
   const profile = clone(source.profile);
   const createdAt = mode === 'replace' ? existing.createdAt : (source.created_at ?? importedAt ?? null);
   identities.set(source.assistant_id, {
    assistantId: source.assistant_id,
    idSource: mode === 'replace' ? existing.idSource : source.id_source,
    createdAt,
    updatedAt: importedAt ?? null,
    revision: mode === 'replace' ? existing.revision + 1 : 1,
    profile
   });
   return { assistantId: source.assistant_id, mode, revision: identities.get(source.assistant_id).revision };
  },

  // ---- inspection --------------------------------------------------------
  // Durable state only; presence is session-scoped and intentionally excluded.
  snapshot() {
   return {
    identities: [...identities.values()].map(record => ({
     assistantId: record.assistantId, idSource: record.idSource, createdAt: record.createdAt,
     updatedAt: record.updatedAt, revision: record.revision, profile: clone(record.profile)
    })).sort((a, b) => a.assistantId.localeCompare(b.assistantId))
   };
  }
 };

 return Object.freeze(zone);
}

// Structural isolation statement, used by tests and by later BA tasks: the Zone
// exposes no Digital-Me write surface, so personalization can never become the
// canonical user self-model.
export const DIGITAL_ME_WRITE_SURFACE = Object.freeze({
 mutatesDigitalMe: false,
 acceptsDigitalMeInput: false,
 assistantRelationshipStoredOnAssistant: true
});
