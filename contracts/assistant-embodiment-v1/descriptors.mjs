// Device embodiment descriptors (BA-003).
//
// A device is an *embodiment* of a logical assistant: it supplies capabilities, sensors, UI
// surfaces and actions, and it holds device-local context. It is never an assistant of its own,
// and Butler never mints physical-device identity — the canonical identity belongs to Remote
// Fabric. Pure module: no clock, filesystem, network or ambient state.
export const EMBODIMENT_CONTRACT_VERSION = 1;

export const EMBODIMENT_KINDS = Object.freeze(['DESKTOP', 'MOBILE', 'TABLET', 'KIOSK', 'HEADLESS']);
export const CAPABILITY_KINDS = Object.freeze(['MICROPHONE', 'CAMERA', 'DISPLAY', 'SPEAKER', 'TOUCH', 'KEYBOARD', 'NOTIFICATION', 'LOCATION', 'BIOMETRIC', 'NETWORK']);
export const SENSOR_KINDS = Object.freeze(['AMBIENT_LIGHT', 'MOTION', 'PRESENCE', 'AUDIO_LEVEL']);
export const UI_SURFACES = Object.freeze(['CHAT', 'VOICE', 'NOTIFICATION', 'AMBIENT', 'NONE']);
export const ACTION_KINDS = Object.freeze(['SPEAK', 'DISPLAY', 'VIBRATE', 'NOTIFY', 'CAPTURE']);
/** Where a device can run work. Recorded here because placement is decided elsewhere. */
export const LOCALITY = Object.freeze(['LOCAL', 'REMOTE_ELIGIBLE']);
export const DEVICE_ID_PATTERN = /^dev-[0-9a-f]{32}$/;
export const EMBODIMENT_REF_PATTERN = /^embodiment-[a-z0-9][a-z0-9._-]{0,63}$/;

/** The only identity authority Butler may reference for a physical device. */
export const DEVICE_IDENTITY_AUTHORITY = 'REMOTE_FABRIC';

export class EmbodimentError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EmbodimentError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/** Keys that would mean Butler is keeping its own physical-device identity namespace. */
export const COMPETING_IDENTITY_FIELDS = Object.freeze([
  'butler_device_id', 'butlerDeviceId', 'local_device_id', 'localDeviceId',
  'device_key', 'device_private_key', 'device_key_ref', 'device_identity_key',
  'device_trust_state', 'device_trust',
  'local_device_identity', 'butler_device_identity',
]);

/**
 * Reserved prototype keys. A `__proto__` own key is worse than invalid: assigning it rewrites an
 * object's prototype instead of adding a key, so `Object.keys` — and therefore this validator —
 * cannot see the result.
 */
export const RESERVED_KEY_PATTERN = /^(?:__proto__|prototype|constructor)$/;

/**
 * Normalise a field name to one comparable form.
 *
 * The competing-identity vocabulary is written in two spellings per concept (`butler_device_id`
 * and `butlerDeviceId`), which is exactly the kind of hand-maintained list that goes stale:
 * `deviceKey`, `deviceTrustState`, `DEVICE_KEY`, `localDeviceIdentity` and
 * `butler_device_identity` all named the same concepts and all passed. Comparing normalised
 * names makes the guard about the concept rather than about which spellings somebody remembered.
 */
export function normalizeFieldName(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

const COMPETING_IDENTITY_NORMALISED = new Set(COMPETING_IDENTITY_FIELDS.map(normalizeFieldName));

/**
 * The systematic rule behind the explicit list: a Butler/locality qualifier plus a device, and
 * one of the nouns that only an identity authority may own. An enumeration alone is what failed —
 * `butlerDeviceKey` was missed because nobody had written that spelling down — so the guard is a
 * pattern over the *concept*.
 *
 * `device_identity_ref` deliberately does not match: `identity_ref` is not in the noun set, and
 * that is the one legitimate field, because Butler may reference Remote Fabric's identity.
 */
const COMPETING_IDENTITY_PATTERN = /^(?:(?:butler|local)_device_(?:id|identity|key|private_key|public_key|trust|trust_state)|device_(?:key|private_key|public_key|identity_key|trust|trust_state))$/;

export function findCompetingIdentityFields(value, path = 'descriptor', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findCompetingIdentityFields(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const normalised = normalizeFieldName(key);
    if (COMPETING_IDENTITY_NORMALISED.has(normalised) || COMPETING_IDENTITY_PATTERN.test(normalised)) found.push(childPath);
    findCompetingIdentityFields(child, childPath, found);
  }
  return found;
}

/** Every reserved prototype key, at every depth. `JSON.parse` can produce an own `__proto__`. */
export function findReservedKeyPaths(value, path = 'descriptor', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findReservedKeyPaths(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (RESERVED_KEY_PATTERN.test(key)) found.push(childPath);
    findReservedKeyPaths(child, childPath, found);
  }
  return found;
}

/**
 * A reference to the canonical Remote Fabric identity. When cross-device identity is not
 * available yet the reference is `null` and the descriptor must say so explicitly, rather than
 * inventing a local identity that would later collide with the real one.
 */
export function deviceIdentityReference({ device_id, installation_ref = null }) {
  if (!isText(device_id) || !DEVICE_ID_PATTERN.test(device_id)) {
    throw new EmbodimentError('INVALID_DEVICE_IDENTITY', `device_id ${JSON.stringify(device_id)} is not a dev-<32 hex> Remote Fabric identity`);
  }
  if (installation_ref !== null && !isText(installation_ref)) throw new EmbodimentError('INVALID_DEVICE_IDENTITY', 'installation_ref must be text or null');
  return Object.freeze({ authority: DEVICE_IDENTITY_AUTHORITY, device_id, installation_ref });
}

export const EMBODIMENT_DESCRIPTOR_SPEC = Object.freeze({
  embodiment_version: { required: true, type: 'int', constant: EMBODIMENT_CONTRACT_VERSION },
  embodiment_ref: { required: true, type: 'text' },
  device_identity_ref: { required: true, type: 'object', nullable: true },
  identity_source: { required: true, enum: ['REMOTE_FABRIC', 'UNAVAILABLE'] },
  kind: { required: true, enum: EMBODIMENT_KINDS },
  display_name: { required: true, type: 'text' },
  capabilities: { required: true, type: 'array' },
  sensors: { required: true, type: 'array' },
  ui_surfaces: { required: true, type: 'array' },
  actions: { required: true, type: 'array' },
  locality: { required: true, enum: LOCALITY },
  registered_at: { required: true, type: 'text' },
});

const isSubset = (value, allowed) => Array.isArray(value) && value.every(entry => allowed.includes(entry));

export function validateEmbodimentDescriptor(descriptor) {
  const errors = [];
  if (!isPlainObject(descriptor)) return { ok: false, errors: ['descriptor must be an object'] };
  for (const key of Object.keys(descriptor)) {
    if (RESERVED_KEY_PATTERN.test(key)) { errors.push(`descriptor.${key} is a reserved prototype key and is never part of the embodiment contract`); continue; }
    // Own-key lookup: `key in SPEC` walks the prototype chain, so `toString`, `valueOf`,
    // `hasOwnProperty`, `constructor`, `isPrototypeOf`, `propertyIsEnumerable` and
    // `toLocaleString` were all accepted as declared descriptor fields.
    if (!Object.hasOwn(EMBODIMENT_DESCRIPTOR_SPEC, key)) errors.push(`descriptor.${key} is not part of the embodiment contract`);
  }
  for (const [key, rule] of Object.entries(EMBODIMENT_DESCRIPTOR_SPEC)) {
    const present = Object.hasOwn(descriptor, key);
    if (!present) { if (rule.required) errors.push(`descriptor.${key} is required`); continue; }
    const field = descriptor[key];
    if (field === null) { if (rule.nullable) continue; errors.push(`descriptor.${key} must not be null`); continue; }
    if (rule.type === 'int' && field !== rule.constant) errors.push(`descriptor.${key} must be ${rule.constant}`);
    if (rule.type === 'text' && !isText(field)) errors.push(`descriptor.${key} must be nonempty text`);
    if (rule.enum && !rule.enum.includes(field)) errors.push(`descriptor.${key} must be one of ${rule.enum.join(', ')}`);
    if (rule.type === 'object' && !isPlainObject(field)) errors.push(`descriptor.${key} must be an object or null`);
  }
  if (isText(descriptor.embodiment_ref) && !EMBODIMENT_REF_PATTERN.test(descriptor.embodiment_ref)) errors.push('descriptor.embodiment_ref must be an embodiment handle');
  if (!isIsoInstant(descriptor.registered_at)) errors.push('descriptor.registered_at must be an ISO-8601 UTC instant');
  if (!isSubset(descriptor.capabilities, CAPABILITY_KINDS)) errors.push(`descriptor.capabilities must be drawn from ${CAPABILITY_KINDS.join(', ')}`);
  if (!isSubset(descriptor.sensors, SENSOR_KINDS)) errors.push(`descriptor.sensors must be drawn from ${SENSOR_KINDS.join(', ')}`);
  if (!isSubset(descriptor.ui_surfaces, UI_SURFACES)) errors.push(`descriptor.ui_surfaces must be drawn from ${UI_SURFACES.join(', ')}`);
  if (!isSubset(descriptor.actions, ACTION_KINDS)) errors.push(`descriptor.actions must be drawn from ${ACTION_KINDS.join(', ')}`);
  if (descriptor.ui_surfaces !== undefined && Array.isArray(descriptor.ui_surfaces) && descriptor.ui_surfaces.includes('NONE') && descriptor.ui_surfaces.length > 1) {
    errors.push('descriptor.ui_surfaces NONE is exclusive: a device with no UI cannot also declare a surface');
  }
  if (descriptor.identity_source === 'REMOTE_FABRIC' && !isPlainObject(descriptor.device_identity_ref)) {
    errors.push('descriptor.device_identity_ref is required when identity_source is REMOTE_FABRIC');
  }
  if (descriptor.identity_source === 'UNAVAILABLE' && descriptor.device_identity_ref !== null) {
    errors.push('descriptor.device_identity_ref must be null when identity_source is UNAVAILABLE');
  }
  if (isPlainObject(descriptor.device_identity_ref)) {
    if (descriptor.device_identity_ref.authority !== DEVICE_IDENTITY_AUTHORITY) errors.push('descriptor.device_identity_ref.authority must be REMOTE_FABRIC');
    if (!isText(descriptor.device_identity_ref.device_id) || !DEVICE_ID_PATTERN.test(descriptor.device_identity_ref.device_id)) errors.push('descriptor.device_identity_ref.device_id must be a Remote Fabric device id');
    for (const key of Object.keys(descriptor.device_identity_ref)) {
      if (!['authority', 'device_id', 'installation_ref'].includes(key)) errors.push(`descriptor.device_identity_ref.${key} is not part of the identity reference`);
    }
  }
  for (const found of findCompetingIdentityFields(descriptor)) errors.push(`${found} would make Butler mint a competing physical-device identity`);
  for (const found of findReservedKeyPaths(descriptor)) errors.push(`${found} is a reserved prototype key and is never part of the embodiment contract`);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertEmbodimentDescriptor(descriptor) {
  const verdict = validateEmbodimentDescriptor(descriptor);
  if (!verdict.ok) throw new EmbodimentError('INVALID_EMBODIMENT_DESCRIPTOR', verdict.errors.slice(0, 3).join('; '));
  return descriptor;
}

export function descriptorFor({
  embodimentRef, kind, displayName, capabilities = [], sensors = [], uiSurfaces = [],
  actions = [], locality = 'LOCAL', deviceIdentityRef = null, registeredAt,
}) {
  const identitySource = deviceIdentityRef === null ? 'UNAVAILABLE' : 'REMOTE_FABRIC';
  return assertEmbodimentDescriptor({
    embodiment_version: EMBODIMENT_CONTRACT_VERSION,
    embodiment_ref: embodimentRef,
    device_identity_ref: deviceIdentityRef,
    identity_source: identitySource,
    kind,
    display_name: displayName,
    capabilities: [...capabilities],
    sensors: [...sensors],
    ui_surfaces: [...uiSurfaces],
    actions: [...actions],
    locality,
    registered_at: registeredAt,
  });
}
