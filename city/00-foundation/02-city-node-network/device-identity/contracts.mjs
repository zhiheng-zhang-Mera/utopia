/**
 * UTOPIA · City Foundation — city-node-network — device identity contracts.
 *
 * RF-001 (Digital-City/mission-book/remote/RF-001-node-identity-installation-lifecycle.md)
 * is **new construction**, not a donor migration: there is no upstream file to port and
 * this module therefore records provenance in `./PROVENANCE.json` instead of `DONOR.json`.
 *
 * What this module is: the versioned data contract for a logical City device identity
 * (`device_id`) and for one concrete installation of it (`installation_id`), plus the
 * validation, canonical serialisation and safe-migration hooks those records need.
 *
 * The three rules this file exists to make unfalsifiable:
 *
 *   1. **Identity is cryptographic, never network-derived.** `deviceId` and the device
 *      key references are the only authority-bearing fields. IP address, hostname,
 *      display name, OS/model/arch and MAC address live under `metadata` and are
 *      explicitly marked non-authoritative, so a network change or a rename cannot
 *      move authority.
 *   2. **Logical device continuity is not installation continuity.** A reinstall mints a
 *      new `installationId`; the logical `deviceId` survives. Binding the new
 *      installation back to the device is an explicit, separately-audited act.
 *   3. **MAC is optional local pairing evidence only.** It is never a credential, never a
 *      remote identity and never an authorisation source. Randomisation, absence and
 *      multiple NICs are all normal, representable states.
 *
 * What this file is not: it holds no clock, no filesystem, no sockets, no randomness and
 * no policy decision. Ids, instants and key material are parameters (see `identity.mjs`),
 * which is what makes every acceptance claim in the workbook reproducible in a test.
 *
 * `canonicalJson` is deliberately local. The only other implementation in this checkout
 * lives in `city/02-engineering/.../restart-protocol`, whose docblock records that it is
 * shared *because a restart ticket checksum is recomputed by a different process*. No
 * digest produced here is ever recomputed by that process, so importing it would invert
 * the 00-foundation → 02-engineering ownership direction to buy nothing. The semantics
 * below are the same, and this module is the only consumer of its own digests.
 */

import { createHash } from 'node:crypto';

/** Schema version of both documents this module owns. Bump only for a breaking change. */
export const IDENTITY_SCHEMA_VERSION = 1;

/** Document discriminators, so a device record can never be read as an installation. */
export const DEVICE_IDENTITY_KIND = 'city.device-identity';
export const DEVICE_INSTALLATION_KIND = 'city.device-installation';

/** 128 bits of lowercase hex behind a type prefix: collision-safe and greppable. */
export const DEVICE_ID_PATTERN = /^dev-[0-9a-f]{32}$/;
export const INSTALLATION_ID_PATTERN = /^ins-[0-9a-f]{32}$/;
export const INSTANCE_ID_PATTERN = /^inst-[0-9a-f]{32}$/;
export const CREDENTIAL_ID_PATTERN = /^cred-[0-9a-f]{32}$/;

/** A key reference is a local handle, not key material: this module never sees a secret. */
export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const KEY_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Lifecycle of the logical device. Retirement is terminal and never deletes history. */
export const DEVICE_STATES = Object.freeze(['ACTIVE', 'RETIRED']);

/**
 * Lifecycle of one installation instance.
 *
 * `UNBOUND` is the state a freshly installed (or reinstalled) instance starts in: it has
 * an identity of its own but no logical device, so it can do nothing until an explicit
 * enrollment/rebind. `QUARANTINED` is entered by clone detection and is terminal without
 * owner action. `RETIRED` is left behind by a reinstall.
 */
export const INSTALLATION_STATES = Object.freeze(['UNBOUND', 'BOUND', 'QUARANTINED', 'RETIRED']);

/** Lifecycle of one device key reference. `ROTATED` is history, not authority. */
export const KEY_STATES = Object.freeze(['ACTIVE', 'ROTATED', 'REVOKED']);

/** Named public-key algorithms a key reference may declare. */
export const KEY_ALGORITHMS = Object.freeze(['ed25519']);

/**
 * The `metadata` block is a *cache of observations*, never an input to a trust decision.
 * These two constants are the machine-readable half of the MAC rule; the other half is
 * that no function in this module (or its siblings) reads a MAC to decide anything.
 */
export const METADATA_AUTHORITY = 'NOT_AUTHORITY';
export const MAC_EVIDENCE_ROLE = 'OPTIONAL_HUMAN_CONFIRMATION';
export const MAC_AUTHORITY = 'NOT_AUTHORITY';

/** Where a MAC value came from. `reported` is the caller's word and carries no weight. */
export const MAC_SOURCES = Object.freeze(['os', 'reported', 'unknown']);

/** The only fields of a device identity that may carry authority. */
export const DEVICE_IDENTITY_AUTHORITY_FIELDS = Object.freeze(['deviceId', 'keys', 'activeKeyId']);

/** Exact field lists. A copy-constructor copies these and drops everything else. */
export const DEVICE_IDENTITY_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'deviceId',
  'createdAt',
  'displayName',
  'state',
  'retiredAt',
  'keys',
  'activeKeyId',
  'metadata',
]);

export const DEVICE_KEY_FIELDS = Object.freeze([
  'keyId',
  'algorithm',
  'fingerprint',
  'createdAt',
  'state',
  'retiredAt',
]);

export const DEVICE_METADATA_FIELDS = Object.freeze([
  'platform',
  'os',
  'arch',
  'model',
  'hostnames',
  'networkAddresses',
  'macAddresses',
]);

export const MAC_EVIDENCE_FIELDS = Object.freeze(['value', 'randomized', 'source']);

export const INSTALLATION_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'installationId',
  'instanceId',
  'createdAt',
  'deviceId',
  'state',
  'credential',
  'boundAt',
  'rebind',
  'retiredAt',
  'quarantine',
]);

export const INSTALLATION_CREDENTIAL_FIELDS = Object.freeze([
  'credentialId',
  'fingerprint',
  'createdAt',
]);

export const INSTALLATION_REBIND_FIELDS = Object.freeze(['required', 'reason']);

export const INSTALLATION_QUARANTINE_FIELDS = Object.freeze(['at', 'code', 'detail']);

/**
 * The fields of the *existing* `services/dev-gateway` node row that the migration hook
 * accepts. Recorded here so the seam to the live system is stated in one place rather
 * than re-derived in a test: `server.mjs` writes
 * `{id, devicePrincipalId, displayName, metadata:{platform}, agentVersion, ...telemetry,
 * capabilities, online, lastHeartbeatAt}`.
 */
export const LEGACY_GATEWAY_NODE_FIELDS = Object.freeze([
  'id',
  'devicePrincipalId',
  'displayName',
  'metadata',
  'agentVersion',
  'capabilities',
  'online',
  'lastHeartbeatAt',
]);

/**
 * Refusal codes. A caller switches on these; prose is for humans only.
 *
 * The first block is structural, the second is lifecycle, the third is trust. Nothing
 * here is a permission decision — this module decides *whether a record is well formed
 * and what it means*, never whether an actor may act.
 */
export const IDENTITY_REJECTION_CODES = Object.freeze([
  // structural
  'missing',
  'malformed',
  'schema_version',
  'kind',
  'device_id',
  'installation_id',
  'instance_id',
  'credential',
  'key',
  'key_list',
  'active_key',
  'metadata',
  'display_name',
  'instant',
  // lifecycle
  'device_retired',
  'installation_retired',
  'installation_unbound',
  'rebind_proof_required',
  'already_bound',
  'key_not_active',
  'already_retired',
  // trust
  'clone_detected',
  'quarantined',
  'credential_mismatch',
  'unknown_installation',
  'mac_not_authority',
]);

/** Thrown by the `assert*` helpers; carries the machine code alongside the prose. */
export class DeviceIdentityError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'DeviceIdentityError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Canonical JSON with sorted keys, so a digest is reproducible.
 *
 * Same semantics as the sibling restart-protocol port: non-objects go through
 * `JSON.stringify` with a `'null'` fallback, arrays recurse in place, objects drop
 * `undefined` values and sort with the plain code-unit comparator (deliberately not a
 * locale comparator and not numeric), and emissions use `:` and `,` with no whitespace.
 *
 * @param {unknown} value any JSON-representable value.
 * @returns {string} the canonical JSON text.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

/** `sha256:<64 lowercase hex>` of a UTF-8 string. The one digest spelling in this module. */
export function sha256(text) {
  return `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

/**
 * Fingerprint of device key material.
 *
 * Accepts the material in any of the shapes a caller realistically holds it: a UTF-8
 * string, a Buffer/TypedArray, or a JWK-ish object (which is canonicalised first, so key
 * order cannot change a fingerprint). This is a *reference*; the material itself is never
 * stored in an identity document.
 *
 * @param {string|Uint8Array|object} publicKeyMaterial
 * @returns {string} `sha256:<hex>`
 */
export function fingerprintKeyMaterial(publicKeyMaterial) {
  if (typeof publicKeyMaterial === 'string') return sha256(publicKeyMaterial);
  if (publicKeyMaterial instanceof Uint8Array) {
    return `sha256:${createHash('sha256').update(publicKeyMaterial).digest('hex')}`;
  }
  if (publicKeyMaterial !== null && typeof publicKeyMaterial === 'object') {
    return sha256(canonicalJson(publicKeyMaterial));
  }
  throw new DeviceIdentityError('key', `key material of type ${typeof publicKeyMaterial} cannot be fingerprinted`);
}

/** Stable digest of an identity document, used as evidence in reports and ledgers. */
export function deviceIdentityDigest(device) {
  return sha256(canonicalJson(deviceIdentityDocument(device)));
}

/** Stable digest of an installation document. */
export function installationDigest(installation) {
  return sha256(canonicalJson(installationDocument(installation)));
}

/** True for a canonical ISO-8601 instant string (`new Date(v).toISOString() === v`). */
export function isIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOrNull(value, code, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new DeviceIdentityError(code, `${field} must be a string or null`);
  return value;
}

function instantOrNull(value, code, field) {
  if (value === null || value === undefined) return null;
  if (!isIsoInstant(value)) throw new DeviceIdentityError('instant', `${field} must be a canonical ISO-8601 instant or null`);
  return value;
}

function stringList(value, code, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DeviceIdentityError(code, `${field} must be an array`);
  for (const entry of value) {
    if (typeof entry !== 'string') throw new DeviceIdentityError(code, `${field} entries must be strings`);
  }
  return [...value];
}

/**
 * Normalise one MAC observation, or answer `null` when the platform gave nothing usable.
 *
 * Tolerated and normalised: separators (`:` or `-`), case, surrounding whitespace, and
 * the sentinel values a platform returns when it refuses to expose a NIC
 * (`''`, `'unavailable'`, `'N/A'`, `'none'`, `'unknown'`, `00:00:00:00:00:00`). None of
 * those is an error — "the OS would not tell us the MAC" is an ordinary outcome on
 * modern mobile platforms, and a caller must not be forced to invent one.
 *
 * @param {unknown} value
 * @returns {string|null} lowercase colon-separated MAC, or null when unreadable.
 */
export function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (['', 'unavailable', 'n/a', 'na', 'none', 'unknown', 'null', 'undefined'].includes(trimmed)) return null;
  const hex = trimmed.replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  if (hex === '000000000000') return null;
  return hex.match(/.{2}/g).join(':');
}

/**
 * True when a MAC is locally administered (bit 0x02 of the first octet).
 *
 * This is the technical signature of OS MAC randomisation and of a hypervisor-assigned
 * address. It is reported so an operator can see *why* the value is not evidence; it is
 * never used to accept or refuse a pairing, because randomisation is a legitimate,
 * increasingly default platform behaviour (invariant 3 of the RF contract).
 */
export function isLocallyAdministeredMac(mac) {
  const normalized = normalizeMac(mac);
  if (normalized === null) return false;
  return (Number.parseInt(normalized.slice(0, 2), 16) & 0x02) === 0x02;
}

/** Build one MAC evidence entry. `source` defaults to `unknown`; `randomized` is derived. */
export function macEvidence(value, source = 'unknown') {
  const normalized = normalizeMac(value);
  const resolvedSource = MAC_SOURCES.includes(source) ? source : 'unknown';
  if (normalized === null) {
    return Object.freeze({ value: null, randomized: false, source: resolvedSource });
  }
  return Object.freeze({ value: normalized, randomized: isLocallyAdministeredMac(normalized), source: resolvedSource });
}

/** Build the (non-authoritative) metadata block from loose caller input. */
export function deviceMetadata({
  platform = null,
  os = null,
  arch = null,
  model = null,
  hostnames = [],
  networkAddresses = [],
  macAddresses = [],
} = {}) {
  const macEntries = (macAddresses ?? []).map((entry) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      return macEvidence(entry.value, entry.source ?? 'unknown');
    }
    return macEvidence(entry, 'reported');
  });
  return Object.freeze({
    platform: textOrNull(platform, 'metadata', 'metadata.platform'),
    os: textOrNull(os, 'metadata', 'metadata.os'),
    arch: textOrNull(arch, 'metadata', 'metadata.arch'),
    model: textOrNull(model, 'metadata', 'metadata.model'),
    hostnames: Object.freeze(stringList(hostnames, 'metadata', 'metadata.hostnames')),
    networkAddresses: Object.freeze(stringList(networkAddresses, 'metadata', 'metadata.networkAddresses')),
    macAddresses: Object.freeze(macEntries),
  });
}

/** Build one device key reference from a fingerprint or from raw public key material. */
export function deviceKey({ keyId, algorithm = 'ed25519', fingerprint, publicKeyMaterial, createdAt, state = 'ACTIVE', retiredAt = null }) {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw new DeviceIdentityError('key', `keyId ${JSON.stringify(keyId)} is not a key handle`);
  }
  if (!KEY_ALGORITHMS.includes(algorithm)) {
    throw new DeviceIdentityError('key', `algorithm ${JSON.stringify(algorithm)} is not a known key algorithm`);
  }
  const resolved = fingerprint ?? (publicKeyMaterial === undefined ? null : fingerprintKeyMaterial(publicKeyMaterial));
  if (typeof resolved !== 'string' || !KEY_FINGERPRINT_PATTERN.test(resolved)) {
    throw new DeviceIdentityError('key', 'a device key needs a sha256:<hex> fingerprint or public key material');
  }
  if (!KEY_STATES.includes(state)) {
    throw new DeviceIdentityError('key', `key state ${JSON.stringify(state)} is not a key state`);
  }
  if (!isIsoInstant(createdAt)) {
    throw new DeviceIdentityError('instant', 'deviceKey.createdAt must be a canonical ISO-8601 instant');
  }
  return Object.freeze({
    keyId,
    algorithm,
    fingerprint: resolved,
    createdAt,
    state,
    retiredAt: instantOrNull(retiredAt, 'instant', 'deviceKey.retiredAt'),
  });
}

/**
 * Validate a candidate device identity document.
 *
 * @returns {{valid: true, device: object, code: null, detail: string}
 *         | {valid: false, device: null, code: string, detail: string}}
 */
export function validateDeviceIdentity(raw) {
  const refuse = (code, detail) => ({ valid: false, device: null, code, detail });
  if (raw === null || raw === undefined) return refuse('missing', 'no device identity document');
  if (!isPlainObject(raw)) return refuse('malformed', 'a device identity document must be an object');
  if (raw.schemaVersion !== IDENTITY_SCHEMA_VERSION) {
    return refuse('schema_version', `device identity schemaVersion ${JSON.stringify(raw.schemaVersion)} is not ${IDENTITY_SCHEMA_VERSION}`);
  }
  if (raw.kind !== DEVICE_IDENTITY_KIND) {
    return refuse('kind', `device identity kind ${JSON.stringify(raw.kind)} is not ${DEVICE_IDENTITY_KIND}`);
  }
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(raw.deviceId)) {
    return refuse('device_id', `deviceId ${JSON.stringify(raw.deviceId)} is not a dev-<32 hex> identity`);
  }
  if (!isIsoInstant(raw.createdAt)) return refuse('instant', 'createdAt must be a canonical ISO-8601 instant');
  if (typeof raw.displayName !== 'string' || raw.displayName.trim() === '') {
    return refuse('display_name', 'displayName must be a non-empty string');
  }
  if (!DEVICE_STATES.includes(raw.state)) return refuse('malformed', `device state ${JSON.stringify(raw.state)} is not a device state`);
  const retiredAt = raw.retiredAt ?? null;
  if (retiredAt !== null && !isIsoInstant(retiredAt)) return refuse('instant', 'retiredAt must be a canonical ISO-8601 instant or null');
  if ((raw.state === 'RETIRED') !== (retiredAt !== null)) {
    return refuse('already_retired', 'state RETIRED and a retiredAt instant must be set together');
  }
  if (!Array.isArray(raw.keys) || raw.keys.length === 0) return refuse('key_list', 'keys must be a non-empty array');
  const seenKeyIds = new Set();
  for (const key of raw.keys) {
    if (!isPlainObject(key)) return refuse('key', 'every key reference must be an object');
    if (typeof key.keyId !== 'string' || !KEY_ID_PATTERN.test(key.keyId)) return refuse('key', `keyId ${JSON.stringify(key.keyId)} is not a key handle`);
    if (seenKeyIds.has(key.keyId)) return refuse('key', `keyId ${key.keyId} appears twice`);
    seenKeyIds.add(key.keyId);
    if (!KEY_ALGORITHMS.includes(key.algorithm)) return refuse('key', `algorithm ${JSON.stringify(key.algorithm)} is not a known key algorithm`);
    if (typeof key.fingerprint !== 'string' || !KEY_FINGERPRINT_PATTERN.test(key.fingerprint)) {
      return refuse('key', `fingerprint ${JSON.stringify(key.fingerprint)} is not a sha256:<64 hex> reference`);
    }
    if (!isIsoInstant(key.createdAt)) return refuse('instant', 'key createdAt must be a canonical ISO-8601 instant');
    if (!KEY_STATES.includes(key.state)) return refuse('key', `key state ${JSON.stringify(key.state)} is not a key state`);
    if (key.retiredAt !== null && key.retiredAt !== undefined && !isIsoInstant(key.retiredAt)) {
      return refuse('instant', 'key retiredAt must be a canonical ISO-8601 instant or null');
    }
  }
  if (typeof raw.activeKeyId !== 'string') return refuse('active_key', 'activeKeyId must name a key');
  const active = raw.keys.find((key) => key.keyId === raw.activeKeyId);
  if (!active) return refuse('active_key', `activeKeyId ${raw.activeKeyId} does not name a declared key`);
  if (active.state !== 'ACTIVE') return refuse('key_not_active', `activeKeyId ${raw.activeKeyId} names a ${active.state} key`);
  if (!isPlainObject(raw.metadata)) return refuse('metadata', 'metadata must be an object');
  for (const field of DEVICE_METADATA_FIELDS) {
    if (!Object.hasOwn(raw.metadata, field)) return refuse('metadata', `metadata.${field} is missing`);
  }
  for (const field of ['hostnames', 'networkAddresses', 'macAddresses']) {
    if (!Array.isArray(raw.metadata[field])) return refuse('metadata', `metadata.${field} must be an array`);
  }
  for (const entry of raw.metadata.macAddresses) {
    if (!isPlainObject(entry)) return refuse('metadata', 'every MAC evidence entry must be an object');
    if (entry.value !== null && typeof entry.value !== 'string') return refuse('metadata', 'MAC evidence value must be a string or null');
    if (entry.value !== null && normalizeMac(entry.value) !== entry.value) {
      return refuse('metadata', `MAC evidence value ${JSON.stringify(entry.value)} is not normalised`);
    }
    if (typeof entry.randomized !== 'boolean') return refuse('metadata', 'MAC evidence randomized must be a boolean');
    if (entry.value !== null && entry.randomized !== isLocallyAdministeredMac(entry.value)) {
      return refuse('metadata', 'MAC evidence randomized must follow from the value');
    }
    if (!MAC_SOURCES.includes(entry.source)) return refuse('metadata', `MAC evidence source ${JSON.stringify(entry.source)} is not a MAC source`);
  }
  return { valid: true, device: raw, code: null, detail: 'device identity verified' };
}

/** Validate, or throw `DeviceIdentityError`. */
export function assertDeviceIdentity(raw) {
  const verdict = validateDeviceIdentity(raw);
  if (!verdict.valid) throw new DeviceIdentityError(verdict.code, verdict.detail);
  return verdict.device;
}

/** Copy-construct a frozen device identity document from a parsed one. */
export function deviceIdentityFromDocument(raw) {
  const document = assertDeviceIdentity(raw);
  return Object.freeze({
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    kind: DEVICE_IDENTITY_KIND,
    deviceId: document.deviceId,
    createdAt: document.createdAt,
    displayName: document.displayName,
    state: document.state,
    retiredAt: document.retiredAt ?? null,
    keys: Object.freeze(document.keys.map((key) => Object.freeze({
      keyId: key.keyId,
      algorithm: key.algorithm,
      fingerprint: key.fingerprint,
      createdAt: key.createdAt,
      state: key.state,
      retiredAt: key.retiredAt ?? null,
    }))),
    activeKeyId: document.activeKeyId,
    metadata: deviceMetadata(document.metadata),
  });
}

/** The exact JSON document of a device identity (declared fields only, stables ordered). */
export function deviceIdentityDocument(device) {
  return {
    schemaVersion: device.schemaVersion,
    kind: device.kind,
    deviceId: device.deviceId,
    createdAt: device.createdAt,
    displayName: device.displayName,
    state: device.state,
    retiredAt: device.retiredAt ?? null,
    keys: (device.keys ?? []).map((key) => ({
      keyId: key.keyId,
      algorithm: key.algorithm,
      fingerprint: key.fingerprint,
      createdAt: key.createdAt,
      state: key.state,
      retiredAt: key.retiredAt ?? null,
    })),
    activeKeyId: device.activeKeyId,
    metadata: {
      platform: device.metadata?.platform ?? null,
      os: device.metadata?.os ?? null,
      arch: device.metadata?.arch ?? null,
      model: device.metadata?.model ?? null,
      hostnames: [...(device.metadata?.hostnames ?? [])],
      networkAddresses: [...(device.metadata?.networkAddresses ?? [])],
      macAddresses: (device.metadata?.macAddresses ?? []).map((entry) => ({
        value: entry.value ?? null,
        randomized: Boolean(entry.randomized),
        source: entry.source ?? 'unknown',
      })),
    },
  };
}

/**
 * Validate a candidate installation document.
 *
 * The `rebind` block is not decoration: it is how a reinstalled instance states, in the
 * record itself, that it owes an explicit rebind before it may act for the device.
 *
 * @returns {{valid: true, installation: object, code: null, detail: string}
 *         | {valid: false, installation: null, code: string, detail: string}}
 */
export function validateInstallation(raw) {
  const refuse = (code, detail) => ({ valid: false, installation: null, code, detail });
  if (raw === null || raw === undefined) return refuse('missing', 'no installation document');
  if (!isPlainObject(raw)) return refuse('malformed', 'an installation document must be an object');
  if (raw.schemaVersion !== IDENTITY_SCHEMA_VERSION) {
    return refuse('schema_version', `installation schemaVersion ${JSON.stringify(raw.schemaVersion)} is not ${IDENTITY_SCHEMA_VERSION}`);
  }
  if (raw.kind !== DEVICE_INSTALLATION_KIND) {
    return refuse('kind', `installation kind ${JSON.stringify(raw.kind)} is not ${DEVICE_INSTALLATION_KIND}`);
  }
  if (typeof raw.installationId !== 'string' || !INSTALLATION_ID_PATTERN.test(raw.installationId)) {
    return refuse('installation_id', `installationId ${JSON.stringify(raw.installationId)} is not an ins-<32 hex> identity`);
  }
  if (typeof raw.instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(raw.instanceId)) {
    return refuse('instance_id', `instanceId ${JSON.stringify(raw.instanceId)} is not an inst-<32 hex> identity`);
  }
  if (!isIsoInstant(raw.createdAt)) return refuse('instant', 'createdAt must be a canonical ISO-8601 instant');
  if (!INSTALLATION_STATES.includes(raw.state)) {
    return refuse('malformed', `installation state ${JSON.stringify(raw.state)} is not an installation state`);
  }
  const bound = raw.deviceId !== null && raw.deviceId !== undefined;
  if (bound && (typeof raw.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(raw.deviceId))) {
    return refuse('device_id', `deviceId ${JSON.stringify(raw.deviceId)} is not a dev-<32 hex> identity or null`);
  }
  if (raw.state === 'BOUND' && !bound) return refuse('installation_unbound', 'a BOUND installation must name its logical device');
  if (raw.state === 'UNBOUND' && bound) return refuse('already_bound', 'an UNBOUND installation must not name a logical device');
  if (!isPlainObject(raw.credential)) return refuse('credential', 'credential must be an object');
  if (typeof raw.credential.credentialId !== 'string' || !CREDENTIAL_ID_PATTERN.test(raw.credential.credentialId)) {
    return refuse('credential', `credentialId ${JSON.stringify(raw.credential.credentialId)} is not a cred-<32 hex> handle`);
  }
  if (typeof raw.credential.fingerprint !== 'string' || !KEY_FINGERPRINT_PATTERN.test(raw.credential.fingerprint)) {
    return refuse('credential', 'credential fingerprint must be a sha256:<64 hex> reference');
  }
  if (!isIsoInstant(raw.credential.createdAt)) return refuse('instant', 'credential createdAt must be a canonical ISO-8601 instant');
  if (!isPlainObject(raw.rebind)) return refuse('malformed', 'rebind must be an object');
  if (typeof raw.rebind.required !== 'boolean') return refuse('malformed', 'rebind.required must be a boolean');
  if (raw.rebind.reason !== null && raw.rebind.reason !== undefined && typeof raw.rebind.reason !== 'string') {
    return refuse('malformed', 'rebind.reason must be a string or null');
  }
  if (raw.state === 'UNBOUND' && raw.rebind.required !== true) {
    return refuse('rebind_proof_required', 'an UNBOUND installation must declare rebind.required');
  }
  const retiredAt = raw.retiredAt ?? null;
  if (retiredAt !== null && !isIsoInstant(retiredAt)) return refuse('instant', 'retiredAt must be a canonical ISO-8601 instant or null');
  if ((raw.state === 'RETIRED') !== (retiredAt !== null)) {
    return refuse('installation_retired', 'state RETIRED and a retiredAt instant must be set together');
  }
  const quarantine = raw.quarantine ?? null;
  if (quarantine !== null) {
    if (!isPlainObject(quarantine)) return refuse('malformed', 'quarantine must be an object or null');
    if (!isIsoInstant(quarantine.at)) return refuse('instant', 'quarantine.at must be a canonical ISO-8601 instant');
    if (typeof quarantine.code !== 'string' || quarantine.code === '') return refuse('malformed', 'quarantine.code must be a non-empty string');
    if (typeof quarantine.detail !== 'string') return refuse('malformed', 'quarantine.detail must be a string');
  }
  if ((raw.state === 'QUARANTINED') !== (quarantine !== null)) {
    return refuse('malformed', 'state QUARANTINED and a quarantine block must be set together');
  }
  const boundAt = raw.boundAt ?? null;
  if (boundAt !== null && !isIsoInstant(boundAt)) return refuse('instant', 'boundAt must be a canonical ISO-8601 instant or null');
  if (raw.state === 'BOUND' && boundAt === null) return refuse('malformed', 'a BOUND installation must record boundAt');
  return { valid: true, installation: raw, code: null, detail: 'installation verified' };
}

/** Validate, or throw `DeviceIdentityError`. */
export function assertInstallation(raw) {
  const verdict = validateInstallation(raw);
  if (!verdict.valid) throw new DeviceIdentityError(verdict.code, verdict.detail);
  return verdict.installation;
}

/** Copy-construct a frozen installation document from a parsed one. */
export function installationFromDocument(raw) {
  const document = assertInstallation(raw);
  return Object.freeze({
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    kind: DEVICE_INSTALLATION_KIND,
    installationId: document.installationId,
    instanceId: document.instanceId,
    createdAt: document.createdAt,
    deviceId: document.deviceId ?? null,
    state: document.state,
    credential: Object.freeze({
      credentialId: document.credential.credentialId,
      fingerprint: document.credential.fingerprint,
      createdAt: document.credential.createdAt,
    }),
    boundAt: document.boundAt ?? null,
    rebind: Object.freeze({
      required: document.rebind.required,
      reason: document.rebind.reason ?? null,
    }),
    retiredAt: document.retiredAt ?? null,
    quarantine: document.quarantine
      ? Object.freeze({ at: document.quarantine.at, code: document.quarantine.code, detail: document.quarantine.detail })
      : null,
  });
}

/** The exact JSON document of an installation. */
export function installationDocument(installation) {
  return {
    schemaVersion: installation.schemaVersion,
    kind: installation.kind,
    installationId: installation.installationId,
    instanceId: installation.instanceId,
    createdAt: installation.createdAt,
    deviceId: installation.deviceId ?? null,
    state: installation.state,
    credential: {
      credentialId: installation.credential?.credentialId,
      fingerprint: installation.credential?.fingerprint,
      createdAt: installation.credential?.createdAt,
    },
    boundAt: installation.boundAt ?? null,
    rebind: {
      required: Boolean(installation.rebind?.required),
      reason: installation.rebind?.reason ?? null,
    },
    retiredAt: installation.retiredAt ?? null,
    quarantine: installation.quarantine
      ? { at: installation.quarantine.at, code: installation.quarantine.code, detail: installation.quarantine.detail }
      : null,
  };
}
