// Butler Assistant personalization contract (BA-001).
//
// A personalization profile is *descriptive assistant-owned state*. It is a
// replaceable, versioned surface for how an assistant presents and behaves; it
// is never an authority source. This module is pure: no filesystem, network,
// clock or ambient state. Timestamps are always supplied by the caller.
//
// Authority boundary (hard invariant):
//   effective permission is computed from policy/capability/task grants, never
//   from a profile. `effectiveGrantsFromProfile()` therefore always returns an
//   empty grant set, and any profile that even *names* an authority field is
//   rejected at validation time.
export const PROFILE_SCHEMA_VERSION = 1;
export const BUNDLE_VERSION = 1;
export const BUNDLE_KIND = 'butler-assistant-profile-bundle';
export const MAX_EXTENSION_NAMESPACES = 64;
export const MAX_DUTY_LABELS = 8;

// Field names that would turn descriptive state into authority. Scanned
// recursively across every port and every extension namespace.
export const AUTHORITY_KEY_PATTERN =
 /^(?:authority|grant|grants|permission|permissions|capability|capabilities|lease|leases|execution_?lease|action_?key|action_?keys|allowed_?actions|allowed_?capabilities|policy|policies|scope|scopes|access_?token|token|credential|credentials|secret|secrets)$/i;
// `effect: allow|grant|permit` is the shape of a policy statement, not a preference.
export const AUTHORITY_EFFECT_PATTERN = /^(?:allow|grant|permit|authorize)$/i;
// A profile may address the user without becoming the user's canonical identity.
export const DIGITAL_ME_KEY_PATTERN =
 /^(?:digital[-_.]?me|digital[-_.]?self|user[-_.]?(?:identity|profile|self)|canonical[-_.]?(?:user|identity))$/i;
// Same rule for namespaced extension keys, where the namespace may be dotted.
export const DIGITAL_ME_NAMESPACE_PATTERN =
 /^(?:digital[-_.]?me|digital[-_.]?self|user[-_.]?(?:identity|profile|self)|canonical[-_.]?(?:user|identity))(?:[.-]|$)/i;
export const EXTENSION_NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
// Duty labels are human-readable role descriptions (`butler`, `night-shift`).
// The `:`-grant syntax (`act:device.control`) is explicitly not a label.
export const DUTY_LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const RELATIONSHIP_MODES = Object.freeze(['assistant', 'butler', 'secretary', 'companion']);
export const PERSONALITY_TONES = Object.freeze(['neutral', 'warm', 'formal', 'playful', 'reserved']);

export class PersonalizationError extends Error {
 constructor(code, detail) {
  super(detail ? `${code}: ${detail}` : code);
  this.name = 'PersonalizationError';
  this.code = code;
  this.detail = detail ?? null;
  this.status = 400;
 }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => (value === undefined ? undefined : structuredClone(value));
const isText = value => typeof value === 'string' && value.trim().length > 0;

function checkNullableText(value, path, errors) {
 if (value === null || value === undefined) return;
 if (!isText(value)) errors.push(`${path} must be nonempty text or null`);
}
function checkUnitInterval(value, path, errors) {
 if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) errors.push(`${path} must be a number between 0 and 1`);
}
function checkOptionalId(value, path, errors) {
 if (value === null || value === undefined) return;
 if (!isText(value) || value.length > 128) errors.push(`${path} must be a nonempty identifier of at most 128 characters or null`);
}

// ---- versioned personalization ports -------------------------------------
// Each port is independently replaceable. `sinceVersion` records when the port
// entered the profile schema, which is what makes forward-compatible migration
// possible without corrupting unknown data.

function definePorts() {
 return {
  address: {
   id: 'address', version: 1, sinceVersion: 1, required: true,
   default: () => ({ assistantName: null, userFormOfAddress: null, pronouns: null }),
   validate(value, path, errors = []) {
    if (!isPlainObject(value)) return [`${path} must be an object`];
    for (const key of ['assistantName', 'userFormOfAddress', 'pronouns']) checkNullableText(value[key], `${path}.${key}`, errors);
    return errors;
   }
  },
  voice: {
   id: 'voice', version: 1, sinceVersion: 1, required: true,
   default: () => ({ voiceId: null, locale: null, speakingRate: 0.5, pitch: 0.5 }),
   validate(value, path, errors = []) {
    if (!isPlainObject(value)) return [`${path} must be an object`];
    checkOptionalId(value.voiceId, `${path}.voiceId`, errors);
    checkNullableText(value.locale, `${path}.locale`, errors);
    checkUnitInterval(value.speakingRate, `${path}.speakingRate`, errors);
    checkUnitInterval(value.pitch, `${path}.pitch`, errors);
    return errors;
   }
  },
  appearance: {
   id: 'appearance', version: 1, sinceVersion: 1, required: true,
   default: () => ({ avatarId: null, themeId: null }),
   validate(value, path, errors = []) {
    if (!isPlainObject(value)) return [`${path} must be an object`];
    checkOptionalId(value.avatarId, `${path}.avatarId`, errors);
    checkOptionalId(value.themeId, `${path}.themeId`, errors);
    return errors;
   }
  },
  personality: {
   id: 'personality', version: 1, sinceVersion: 1, required: true,
   default: () => ({ tone: 'neutral', traits: [] }),
   validate(value, path, errors = []) {
    if (!isPlainObject(value)) return [`${path} must be an object`];
    if (!PERSONALITY_TONES.includes(value.tone)) errors.push(`${path}.tone must be one of ${PERSONALITY_TONES.join(', ')}`);
    if (!Array.isArray(value.traits) || value.traits.length > 8) errors.push(`${path}.traits must be an array of at most 8 labels`);
    else value.traits.forEach((t, i) => { if (typeof t !== 'string' || !DUTY_LABEL_PATTERN.test(t)) errors.push(`${path}.traits[${i}] must be a lowercase descriptive label`); });
    return errors;
   }
  },
  duties: {
   id: 'duties', version: 1, sinceVersion: 1, required: true,
   // Descriptive labels only. Holding a duty label never confers the action.
   default: () => ({ labels: [] }),
   validate(value, path, errors = []) {
    if (!isPlainObject(value)) return [`${path} must be an object`];
    if (!Array.isArray(value.labels) || value.labels.length > MAX_DUTY_LABELS) { errors.push(`${path}.labels must be an array of at most ${MAX_DUTY_LABELS} labels`); return errors; }
    value.labels.forEach((label, i) => {
     if (typeof label !== 'string' || !DUTY_LABEL_PATTERN.test(label)) errors.push(`${path}.labels[${i}] must be a lowercase descriptive label without grant syntax`);
    });
    return errors;
   }
  },
  companion: {
   id: 'companion', version: 1, sinceVersion: 1, required: true,
   // Assistant↔user relationship state. Scoped to this assistant identity; it is
   // never written into Digital-Me as canonical user identity data.
   default: () => ({ relationshipMode: 'assistant', companionName: null, notes: null }),
   validate(value, path, errors = []) {
    if (!isPlainObject(value)) return [`${path} must be an object`];
    if (!RELATIONSHIP_MODES.includes(value.relationshipMode)) errors.push(`${path}.relationshipMode must be one of ${RELATIONSHIP_MODES.join(', ')}`);
    checkNullableText(value.companionName, `${path}.companionName`, errors);
    checkNullableText(value.notes, `${path}.notes`, errors);
    return errors;
   }
  }
 };
}

export const PERSONALIZATION_PORT_IDS = Object.freeze(Object.keys(definePorts()));

export function createPortRegistry({ additionalPorts = [] } = {}) {
 const ports = definePorts();
 for (const port of additionalPorts) {
  if (!isPlainObject(port) || !isText(port.id) || typeof port.validate !== 'function' || typeof port.default !== 'function') throw new PersonalizationError('INVALID_PORT_DEFINITION', String(port && port.id));
  if (ports[port.id]) throw new PersonalizationError('DUPLICATE_PORT_ID', port.id);
  if (!Number.isInteger(port.sinceVersion) || port.sinceVersion < 1) throw new PersonalizationError('INVALID_PORT_VERSION', port.id);
  ports[port.id] = { version: 1, required: false, ...port };
 }
 const schemaVersion = Object.values(ports).reduce((max, port) => Math.max(max, port.sinceVersion), PROFILE_SCHEMA_VERSION);
 return Object.freeze({ ports: Object.freeze(ports), schemaVersion });
}

export const DEFAULT_PORT_REGISTRY = createPortRegistry();

// ---- authority scan ------------------------------------------------------

export function findAuthorityPaths(value, path = 'profile', found = []) {
 if (Array.isArray(value)) { value.forEach((item, index) => findAuthorityPaths(item, `${path}[${index}]`, found)); return found; }
 if (!isPlainObject(value)) return found;
 for (const [key, child] of Object.entries(value)) {
  const childPath = `${path}.${key}`;
  if (AUTHORITY_KEY_PATTERN.test(key)) found.push(childPath);
  else if (key === 'effect' && typeof child === 'string' && AUTHORITY_EFFECT_PATTERN.test(child)) found.push(`${childPath}=${child}`);
  findAuthorityPaths(child, childPath, found);
 }
 return found;
}

export function findDigitalMePaths(value, path = 'profile', found = []) {
 if (Array.isArray(value)) { value.forEach((item, index) => findDigitalMePaths(item, `${path}[${index}]`, found)); return found; }
 if (!isPlainObject(value)) return found;
 for (const [key, child] of Object.entries(value)) {
  const childPath = `${path}.${key}`;
  if (DIGITAL_ME_KEY_PATTERN.test(key)) found.push(childPath);
  findDigitalMePaths(child, childPath, found);
 }
 return found;
}

// ---- profile validation --------------------------------------------------

function validateExtensions(extensions, errors, path = 'profile.extensions') {
 if (!isPlainObject(extensions)) { errors.push(`${path} must be an object`); return; }
 const namespaces = Object.keys(extensions);
 if (namespaces.length > MAX_EXTENSION_NAMESPACES) errors.push(`${path} must not exceed ${MAX_EXTENSION_NAMESPACES} namespaces`);
 for (const namespace of namespaces) {
  const entry = extensions[namespace];
  if (!EXTENSION_NAMESPACE_PATTERN.test(namespace)) errors.push(`${path}.${namespace} is not a valid namespaced extension key`);
  // Extension namespaces are descriptive too: neither Digital-Me nor authority
  // namespaces may be smuggled in through the extension surface.
  if (DIGITAL_ME_NAMESPACE_PATTERN.test(namespace)) errors.push(`${path}.${namespace} must not extend Digital-Me namespaces`);
  if (AUTHORITY_KEY_PATTERN.test(namespace.split(/[.-]/)[0])) errors.push(`${path}.${namespace} must not use an authority namespace`);
  if (!isPlainObject(entry)) { errors.push(`${path}.${namespace} must be an object with version and value`); continue; }
  if (!Number.isInteger(entry.version) || entry.version < 1) errors.push(`${path}.${namespace}.version must be a positive integer`);
  if (!('value' in entry)) errors.push(`${path}.${namespace}.value is required`);
  for (const key of Object.keys(entry)) if (key !== 'version' && key !== 'value') errors.push(`${path}.${namespace}.${key} is not part of a versioned extension entry`);
 }
}

export function validateProfile(profile, { registry = DEFAULT_PORT_REGISTRY, version = null } = {}) {
 const errors = [];
 if (!isPlainObject(profile)) return { ok: false, errors: ['profile must be an object'] };
 const declared = profile.schema_version;
 const target = version ?? declared ?? PROFILE_SCHEMA_VERSION;
 if (!Number.isInteger(target) || target < 1) errors.push('profile.schema_version must be a positive integer');
 if (Number.isInteger(declared) && declared > registry.schemaVersion) errors.push(`profile.schema_version ${declared} is newer than the supported ${registry.schemaVersion}`);
 const supported = Number.isInteger(target) && target >= 1 && target <= registry.schemaVersion;
 const knownPortIds = new Set(Object.values(registry.ports).filter(port => port.sinceVersion <= (supported ? target : 0)).map(port => port.id));
 const known = new Set(['schema_version', 'extensions', ...knownPortIds]);
 for (const key of Object.keys(profile)) {
  if (known.has(key)) continue;
  errors.push(`profile.${key} is not a recognized personalization port at schema version ${target}`);
 }
 for (const port of Object.values(registry.ports)) {
  if (port.sinceVersion > (supported ? target : 0)) continue;
  if (!(port.id in profile)) { if (port.required) errors.push(`profile.${port.id} is required at schema version ${target}`); continue; }
  const value = profile[port.id];
  port.validate(value, `profile.${port.id}`, errors);
  // Ports are strict as well: an undeclared field inside a port is a schema error.
  if (isPlainObject(value)) for (const key of Object.keys(value)) if (!(key in port.default())) errors.push(`profile.${port.id}.${key} is not a declared ${port.id} field`);
 }
 validateExtensions(profile.extensions, errors);
 for (const path of findAuthorityPaths(profile)) errors.push(`${path} is an authority field; personalization cannot grant authority`);
 return { ok: errors.length === 0, errors };
}

export function assertValidProfile(profile, options = {}) {
 const result = validateProfile(profile, options);
 if (!result.ok) throw new PersonalizationError('INVALID_ASSISTANT_PROFILE', result.errors.slice(0, 3).join('; '));
 return profile;
}

// Fills declared ports with safe defaults. Unknown or malformed data still fails.
export function normalizeProfile(profile, { registry = DEFAULT_PORT_REGISTRY, version = PROFILE_SCHEMA_VERSION } = {}) {
 if (!isPlainObject(profile)) throw new PersonalizationError('INVALID_ASSISTANT_PROFILE', 'profile must be an object');
 const supportedVersion = profile.schema_version ?? version;
 const normalized = { ...clone(profile), schema_version: supportedVersion, extensions: isPlainObject(profile.extensions) ? clone(profile.extensions) : {} };
 for (const port of Object.values(registry.ports)) {
  if (port.sinceVersion > supportedVersion) continue;
  const current = normalized[port.id];
  const defaults = port.default();
  // Missing ports get safe defaults; partially specified ports keep their values
  // and receive the remaining defaults, so callers never hand-write a full port.
  if (current === undefined) normalized[port.id] = defaults;
  else if (isPlainObject(current) && isPlainObject(defaults)) normalized[port.id] = { ...defaults, ...current };
 }
 assertValidProfile(normalized, { registry });
 return normalized;
}

export function createDefaultProfile({ overrides = {}, registry = DEFAULT_PORT_REGISTRY, version = PROFILE_SCHEMA_VERSION } = {}) {
 if (!isPlainObject(overrides)) throw new PersonalizationError('INVALID_ASSISTANT_PROFILE', 'overrides must be an object');
 return normalizeProfile({ schema_version: version, extensions: {}, ...clone(overrides) }, { registry, version });
}

// Shallow-per-port patch. Port objects merge one level deep so a caller can
// change `voice.speakingRate` without restating the whole port.
export function applyProfilePatch(profile, patch, { registry = DEFAULT_PORT_REGISTRY } = {}) {
 assertValidProfile(profile, { registry });
 if (!isPlainObject(patch)) throw new PersonalizationError('INVALID_PROFILE_PATCH', 'patch must be an object');
 const next = clone(profile);
 for (const [key, value] of Object.entries(clone(patch))) {
  if (key === 'schema_version') {
   if (value !== profile.schema_version) throw new PersonalizationError('PROFILE_SCHEMA_VERSION_IMMUTABLE', 'use migrateProfile to change schema_version');
   continue;
  }
  if (key === 'extensions') {
   if (!isPlainObject(value)) throw new PersonalizationError('INVALID_PROFILE_PATCH', 'extensions patch must be an object');
   next.extensions = { ...next.extensions, ...value };
   continue;
  }
  const port = registry.ports[key];
  if (!port) throw new PersonalizationError('UNKNOWN_PERSONALIZATION_PORT', key);
  if (isPlainObject(value) && isPlainObject(next[key])) next[key] = { ...next[key], ...value };
  else next[key] = value;
 }
 assertValidProfile(next, { registry });
 return next;
}

// Versioned forward migration: later ports receive their declared defaults,
// every existing value and every unknown-but-well-formed extension namespace is
// preserved byte for byte.
export function migrateProfile(profile, { toVersion, registry = DEFAULT_PORT_REGISTRY } = {}) {
 const from = assertValidProfile(normalizeProfile(profile, { registry, version: profile?.schema_version ?? PROFILE_SCHEMA_VERSION }), { registry }).schema_version;
 if (!Number.isInteger(toVersion) || toVersion < from || toVersion > registry.schemaVersion) {
  throw new PersonalizationError('UNSUPPORTED_PROFILE_MIGRATION', `${from} -> ${toVersion}`);
 }
 const next = clone(profile);
 const addedPorts = [];
 for (const port of Object.values(registry.ports)) {
  if (port.sinceVersion > toVersion || port.sinceVersion <= from) continue;
  if (!(port.id in next)) { next[port.id] = port.default(); addedPorts.push(port.id); }
 }
 next.schema_version = toVersion;
 next.extensions = clone(profile.extensions) ?? {};
 assertValidProfile(next, { registry });
 return { profile: next, fromVersion: from, toVersion, addedPorts, preservedExtensions: Object.keys(next.extensions) };
}

// ---- authority boundary --------------------------------------------------

// The only defined way to ask "what does this profile authorize?".
// The answer is always: nothing. Personality, duty labels and relationship mode
// are descriptive; effective permission comes from
// User/OwnerPolicy ∩ AssistantPolicy ∩ DeviceCapability ∩ TaskActionGrant.
export function effectiveGrantsFromProfile(profile, { registry = DEFAULT_PORT_REGISTRY } = {}) {
 assertValidProfile(profile, { registry });
 return Object.freeze({
  authority: 'ASSISTANT_PROFILE_GRANTS_NO_AUTHORITY',
  grants: Object.freeze([]),
  descriptiveOnly: Object.freeze(['address', 'voice', 'appearance', 'personality', 'duties', 'companion'])
 });
}

export const PROFILE_AUTHORITY_BOUNDARY = Object.freeze({
  profileGrantsAuthority: false,
  profileMayContainAuthorityFields: false,
  dutyLabelsAreDescriptiveOnly: true,
  relationshipModeGrantsAuthority: false,
  effectivePermissionSources: Object.freeze(['User/OwnerPolicy', 'AssistantPolicy', 'DeviceCapability', 'TaskActionGrant'])
});
