// AssistantProfilePort — the stable seam between the Assistant Core (BA-002) and
// the Butler Zone personalization contract (BA-001).
//
// BA-002 branches from the same frozen baseline as BA-001 but must not consume or
// copy BA-001's implementation, so the Core depends only on this port: it asks
// for a profile *reference*, never for profile contents. BA-001 supplies the real
// implementation after integration; the deterministic double below keeps BA-002
// bounded and testable meanwhile.
//
// Integration seam: `AssistantZone` (contracts/butler-assistant-v1/zone.mjs,
// BA-001) must expose `resolveProfileReference(assistantId)` returning
// `{ profile_ref, profile_revision }` for its stored profile. No profile field may
// be copied into authoritative assistant state.
export const ASSISTANT_PROFILE_PORT_VERSION = 1;

export const ASSISTANT_PROFILE_PORT = Object.freeze({
 interface: 'AssistantProfilePort',
 version: ASSISTANT_PROFILE_PORT_VERSION,
 methods: Object.freeze(['resolveProfileReference']),
 owner: 'Butler Assistant — BA-001 Butler Zone contract',
 core_may_store_profile_fields: false,
 integration_status: 'WAITING_FOR_BA001_BUTLER_ZONE_BINDING'
});

const isText = value => typeof value === 'string' && value.trim().length > 0;

export function probeProfilePortConformance(subject) {
 const missing = ASSISTANT_PROFILE_PORT.methods.filter(method => typeof subject?.[method] !== 'function');
 return { ok: missing.length === 0, port: ASSISTANT_PROFILE_PORT.interface, version: ASSISTANT_PROFILE_PORT_VERSION, missing, errors: missing.length ? [`missing methods: ${missing.join(', ')}`] : [] };
}

// Deterministic double: fixed references only, no profile logic and no authority.
export function createDeterministicProfilePort({ profiles = {} } = {}) {
 const table = new Map(Object.entries(profiles).map(([assistantId, entry]) => [
  assistantId,
  typeof entry === 'string' ? { profile_ref: entry, profile_revision: 1 } : { profile_ref: entry.profile_ref, profile_revision: entry.profile_revision ?? 1 }
 ]));
 return Object.freeze({
  resolveProfileReference(assistantId) {
   if (!isText(assistantId)) return null;
   const entry = table.get(assistantId);
   return entry ? { profile_ref: entry.profile_ref, profile_revision: entry.profile_revision } : null;
  },
  describe() { return { interface: ASSISTANT_PROFILE_PORT.interface, version: ASSISTANT_PROFILE_PORT_VERSION, profiles: [...table.keys()].sort() }; }
 });
}
