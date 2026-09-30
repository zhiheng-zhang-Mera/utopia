/**
 * UTOPIA · City Foundation — city-node-network — pairing and trust contracts.
 *
 * RF-002 (Digital-City/mission-book/remote/RF-002-unified-pairing-trust-lifecycle.md).
 * New construction, not a donor migration: provenance is in `./PROVENANCE.json`.
 *
 * What this module is: **one** versioned pairing/trust state machine that every join
 * mechanism converges on. Same-Wi-Fi discovery, LAN, Bluetooth, direct IP, a remote
 * invite/meeting code, a deep link and a QR/web link are *entry points*, not trust
 * systems. They all create the same session, walk the same phases and end in the same
 * `TRUSTED` record or the same typed refusal.
 *
 * The four rules this file exists to make unfalsifiable:
 *
 *   1. **Discovery is not trust.** Being able to see, reach or possess an invite for a
 *      device proves nothing. Only the human/Owner confirmation step can end in
 *      `TRUSTED`, and it is bound to the cryptographic fingerprint exchanged earlier.
 *   2. **Nothing network-derived is identity.** A MAC address is optional local evidence
 *      a human may compare once; a display name, platform and model are preview text.
 *      `buildDevicePreview` marks all of that non-authoritative and names the
 *      fingerprint as the identity.
 *   3. **A pairing attempt is single-use.** Sessions expire, confirmations are one-time,
 *      and a consumed challenge cannot be replayed even in a brand-new session.
 *   4. **A trust role is not a capability.** `TRUST_ROLES` classifies how a device is
 *      trusted; `capabilitiesFromTrustRole` always answers "none", because effective
 *      permission is an intersection computed elsewhere.
 *
 * What this file is not: it holds no clock, no filesystem, no sockets and no key
 * material. Instants are parameters, entropy is an explicit byte array, and only
 * fingerprints (never secrets) ever enter a document or the audit log.
 */

import { createHash } from 'node:crypto';

/** Schema version of every document this module owns. */
export const PAIRING_SCHEMA_VERSION = 1;

export const PAIRING_SESSION_KIND = 'city.pairing-session';
export const TRUST_RECORD_KIND = 'city.device-trust-record';

/** 128 bits of lowercase hex behind a type prefix. */
export const SESSION_ID_PATTERN = /^pair-[0-9a-f]{32}$/;
export const TRUST_ID_PATTERN = /^trust-[0-9a-f]{32}$/;
export const CHALLENGE_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const DEVICE_ID_PATTERN = /^dev-[0-9a-f]{32}$/;
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * How a join was started. Every value is an *entry point*: it decides how the two
 * sides reached each other, never whether they may trust each other.
 */
export const ENTRY_POINTS = Object.freeze([
  'DISCOVERY_LAN',
  'DISCOVERY_BLUETOOTH',
  'DIRECT_ADDRESS',
  'REMOTE_INVITE',
  'DEEP_LINK',
  'QR_WEB_LINK',
]);

/** The phases every session walks, in order, and the terminal states it can end in. */
export const PAIRING_PHASES = Object.freeze([
  'PAIRING_SESSION',
  'EPHEMERAL_KEY_EXCHANGE',
  'DEVICE_PREVIEW',
  'HUMAN_CONFIRM',
  'TRUSTED',
]);

export const PAIRING_TERMINAL_STATES = Object.freeze(['REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED']);

export const PAIRING_STATES = Object.freeze([...PAIRING_PHASES, ...PAIRING_TERMINAL_STATES]);

/**
 * The only legal transitions. A session never moves backwards, never skips the
 * preview (so a human always sees what they are about to trust) and never leaves a
 * terminal state.
 */
export const PAIRING_TRANSITIONS = Object.freeze({
  PAIRING_SESSION: Object.freeze(['EPHEMERAL_KEY_EXCHANGE', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED']),
  EPHEMERAL_KEY_EXCHANGE: Object.freeze(['DEVICE_PREVIEW', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED']),
  DEVICE_PREVIEW: Object.freeze(['HUMAN_CONFIRM', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED']),
  HUMAN_CONFIRM: Object.freeze(['TRUSTED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED']),
  TRUSTED: Object.freeze([]),
  REJECTED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  FAILED: Object.freeze([]),
});

/** How a device is trusted. A classification, never a grant. */
export const TRUST_ROLES = Object.freeze([
  'FULL_NODE',
  'PERSONAL_DEVICE',
  'GUEST_DEVICE',
  'SENSOR_DEVICE',
  'WORKER_NODE',
]);

export const TRUST_STATES = Object.freeze(['TRUSTED', 'QUARANTINED', 'REVOKED']);

/** Why a trust was withdrawn. Recorded verbatim so an operator can audit the reason. */
export const REVOCATION_REASONS = Object.freeze(['OWNER_REVOKED', 'DEVICE_LOST', 'CREDENTIAL_ROTATED', 'REPAIRED']);

/** The one default a caller may not silently change without recording it. */
export const DEFAULT_SESSION_TTL_MS = 120_000;

/** MAC evidence is preview text. These two constants are the machine-readable half. */
export const MAC_EVIDENCE_ROLE = 'OPTIONAL_HUMAN_CONFIRMATION';
export const MAC_AUTHORITY = 'NOT_AUTHORITY';

export const PREVIEW_FIELDS = Object.freeze([
  'display_name',
  'platform',
  'model',
  'fingerprint',
  'device_id',
  'mac_evidence',
  'identity_is_cryptographic',
  'metadata_is_not_authority',
]);

export const SESSION_FIELDS = Object.freeze([
  'schema_version',
  'kind',
  'session_id',
  'entry_point',
  'state',
  'created_at',
  'expires_at',
  'challenge',
  'confirmation_token_ref',
  'initiator_fingerprint',
  'responder_fingerprint',
  'preview',
  'trusted_device_id',
  'trust_id',
  'confirmed_by',
  'confirmed_at',
  'terminal_reason',
  'transitions',
]);

export const TRUST_RECORD_FIELDS = Object.freeze([
  'schema_version',
  'kind',
  'trust_id',
  'device_id',
  'fingerprint',
  'role',
  'state',
  'entry_point',
  'session_id',
  'established_at',
  'confirmed_by',
  'credential_fingerprint',
  'revoked_at',
  'revocation_reason',
  'mac_mismatch_observed',
  'history',
]);

/**
 * Refusal codes. Structural first, lifecycle second, trust third. Nothing here is a
 * permission decision: this module decides whether a pairing is well formed and what
 * it means, never whether an actor may act.
 */
export const PAIRING_REJECTION_CODES = Object.freeze([
  // structural
  'missing',
  'malformed',
  'schema_version',
  'kind',
  'session_id',
  'trust_id',
  'device_id',
  'fingerprint',
  'entry_point',
  'challenge',
  'instant',
  'preview',
  // lifecycle
  'illegal_transition',
  'terminal_state',
  'session_expired',
  'session_not_expired',
  'confirmation_not_available',
  'confirmation_replayed',
  'challenge_replayed',
  'fingerprint_mismatch',
  'confirmation_actor_missing',
  // trust
  'unknown_trust',
  'unknown_device',
  'already_trusted',
  'already_revoked',
  'trust_revoked',
  'trust_quarantined',
  'credential_rotated',
  'credential_unknown',
  'role_not_allowed',
  'mac_not_authority',
]);

export class PairingError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PairingError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

/** A malformed document is a 400, a lifecycle conflict a 409. */
export class PairingValidationError extends PairingError {
  constructor(code, detail) {
    super(code, detail);
    this.name = 'PairingValidationError';
    this.status = 400;
  }
}

/** `sha256:<64 lowercase hex>` of a UTF-8 string. The one digest spelling here. */
export function sha256(text) {
  return `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

/** Canonical JSON with sorted keys, so a digest is reproducible. Deliberately local. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

/** True for a canonical ISO-8601 instant string. */
export function isIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

/** Render a caller-supplied instant. Instants are always parameters. */
export function instantOf(nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new PairingValidationError('instant', `nowMs must be a finite millisecond instant, got ${String(nowMs)}`);
  }
  const rendered = new Date(nowMs).toISOString();
  if (Number.isNaN(Date.parse(rendered))) throw new PairingValidationError('instant', `nowMs ${nowMs} is not representable`);
  return rendered;
}

/**
 * Normalise one MAC observation, or answer `null` when the platform gave nothing usable.
 *
 * Tolerated: separators, case, whitespace and the sentinel values a platform returns
 * when it refuses to expose a NIC. None of those is an error — "the OS would not tell
 * us the MAC" is ordinary on modern mobile platforms.
 */
export function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (['', 'unavailable', 'n/a', 'na', 'none', 'unknown', 'null', 'undefined'].includes(trimmed)) return null;
  const hex = trimmed.replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || hex === '000000000000') return null;
  return hex.match(/.{2}/g).join(':');
}

/** Locally-administered (bit 0x02 of the first octet): the OS-randomisation signature. */
export function isLocallyAdministeredMac(mac) {
  const normalized = normalizeMac(mac);
  if (normalized === null) return false;
  return (Number.parseInt(normalized.slice(0, 2), 16) & 0x02) === 0x02;
}

/**
 * Build the human-readable preview a confirmation screen shows.
 *
 * Everything except `fingerprint` is decoration. `identity_is_cryptographic` and
 * `metadata_is_not_authority` are part of the document so a consumer cannot render the
 * preview without the statement attached, and `mac_evidence.can_block_or_grant` is
 * always false.
 *
 * @param {{deviceId: string, displayName?: string, platform?: string|null, model?: string|null,
 *          fingerprint: string, macAddresses?: unknown[], expectedMac?: string|null}} input
 */
export function buildDevicePreview({
  deviceId,
  displayName = null,
  platform = null,
  model = null,
  fingerprint,
  macAddresses = [],
  expectedMac = null,
}) {
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new PairingValidationError('fingerprint', 'a preview needs the sha256:<hex> fingerprint exchanged with the peer');
  }
  const entries = (macAddresses ?? []).map((value) => {
    const normalized = normalizeMac(value);
    return Object.freeze({ value: normalized, randomized: normalized === null ? false : isLocallyAdministeredMac(normalized) });
  });
  const expected = normalizeMac(expectedMac);
  // A mismatch is a warning for the human, never a decision. Pairing continues.
  const mismatch = expected !== null && entries.length > 0 && !entries.some((entry) => entry.value === expected);
  return Object.freeze({
    display_name: typeof displayName === 'string' && displayName.trim() !== '' ? displayName : (deviceId ?? null),
    platform: typeof platform === 'string' ? platform : null,
    model: typeof model === 'string' ? model : null,
    fingerprint,
    device_id: deviceId ?? null,
    mac_evidence: Object.freeze({
      role: MAC_EVIDENCE_ROLE,
      authority: MAC_AUTHORITY,
      authoritative: false,
      can_block_or_grant: false,
      mismatch_warning: mismatch,
      entries: Object.freeze(entries),
    }),
    identity_is_cryptographic: true,
    metadata_is_not_authority: true,
  });
}

/**
 * The only defined way to ask "what does this trust role authorize?".
 *
 * The answer is always: nothing. A role classifies how a device is trusted; effective
 * permission is `User/OwnerPolicy ∩ AssistantPolicy ∩ DeviceCapability ∩ TaskActionGrant`,
 * computed elsewhere from current policy, never from a pairing.
 */
export function capabilitiesFromTrustRole() {
  return Object.freeze({
    authority: 'TRUST_ROLE_GRANTS_NO_CAPABILITY',
    capabilities: Object.freeze([]),
    descriptiveOnly: TRUST_ROLES,
  });
}

/** Refuse every attempt to derive trust from MAC evidence. */
export function trustFromMacEvidence() {
  return Object.freeze({
    granted: false,
    code: 'mac_not_authority',
    detail: 'a MAC address may be compared once by a human during local onboarding; it can never grant trust or replace the cryptographic fingerprint',
  });
}

/** Validate a pairing session document. */
export function validatePairingSession(raw) {
  const refuse = (code, detail) => ({ ok: false, errors: [`${code}: ${detail}`], code });
  if (raw === null || raw === undefined) return refuse('missing', 'no pairing session');
  if (!isPlainObject(raw)) return refuse('malformed', 'a pairing session must be an object');
  if (raw.schema_version !== PAIRING_SCHEMA_VERSION) return refuse('schema_version', `session schema_version ${JSON.stringify(raw.schema_version)} is not ${PAIRING_SCHEMA_VERSION}`);
  if (raw.kind !== PAIRING_SESSION_KIND) return refuse('kind', `session kind ${JSON.stringify(raw.kind)} is not ${PAIRING_SESSION_KIND}`);
  if (typeof raw.session_id !== 'string' || !SESSION_ID_PATTERN.test(raw.session_id)) return refuse('session_id', `session_id ${JSON.stringify(raw.session_id)} is not a pair-<32 hex> identity`);
  if (!ENTRY_POINTS.includes(raw.entry_point)) return refuse('entry_point', `entry_point ${JSON.stringify(raw.entry_point)} is not a join entry point`);
  if (!PAIRING_STATES.includes(raw.state)) return refuse('malformed', `state ${JSON.stringify(raw.state)} is not a pairing state`);
  if (!isIsoInstant(raw.created_at)) return refuse('instant', 'created_at must be a canonical ISO-8601 instant');
  if (!isIsoInstant(raw.expires_at)) return refuse('instant', 'expires_at must be a canonical ISO-8601 instant');
  if (typeof raw.challenge !== 'string' || !CHALLENGE_PATTERN.test(raw.challenge)) return refuse('challenge', 'challenge must be a sha256:<hex> digest of the session nonce');
  if (raw.responder_fingerprint !== null && (typeof raw.responder_fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(raw.responder_fingerprint))) return refuse('fingerprint', 'responder_fingerprint must be a sha256:<hex> reference or null');
  if (raw.state === 'TRUSTED' && raw.responder_fingerprint === null) return refuse('fingerprint', 'a TRUSTED session must name the fingerprint it was bound to');
  if (raw.trusted_device_id !== null && (typeof raw.trusted_device_id !== 'string' || !DEVICE_ID_PATTERN.test(raw.trusted_device_id))) return refuse('device_id', 'trusted_device_id must be a dev-<32 hex> identity or null');
  if (raw.trust_id !== null && (typeof raw.trust_id !== 'string' || !TRUST_ID_PATTERN.test(raw.trust_id))) return refuse('trust_id', 'trust_id must be a trust-<32 hex> identity or null');
  if (!Array.isArray(raw.transitions)) return refuse('malformed', 'transitions must be an array');
  return { ok: true, errors: [], code: null };
}

/** Validate a trust record document. */
export function validateTrustRecord(raw) {
  const refuse = (code, detail) => ({ ok: false, errors: [`${code}: ${detail}`], code });
  if (raw === null || raw === undefined) return refuse('missing', 'no trust record');
  if (!isPlainObject(raw)) return refuse('malformed', 'a trust record must be an object');
  if (raw.schema_version !== PAIRING_SCHEMA_VERSION) return refuse('schema_version', `trust schema_version ${JSON.stringify(raw.schema_version)} is not ${PAIRING_SCHEMA_VERSION}`);
  if (raw.kind !== TRUST_RECORD_KIND) return refuse('kind', `trust kind ${JSON.stringify(raw.kind)} is not ${TRUST_RECORD_KIND}`);
  if (typeof raw.trust_id !== 'string' || !TRUST_ID_PATTERN.test(raw.trust_id)) return refuse('trust_id', 'trust_id must be a trust-<32 hex> identity');
  if (typeof raw.device_id !== 'string' || !DEVICE_ID_PATTERN.test(raw.device_id)) return refuse('device_id', 'device_id must be a dev-<32 hex> identity');
  if (typeof raw.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(raw.fingerprint)) return refuse('fingerprint', 'fingerprint must be a sha256:<hex> reference');
  if (!TRUST_ROLES.includes(raw.role)) return refuse('role_not_allowed', `role ${JSON.stringify(raw.role)} is not a trust role`);
  if (!TRUST_STATES.includes(raw.state)) return refuse('malformed', `trust state ${JSON.stringify(raw.state)} is not a trust state`);
  if (!ENTRY_POINTS.includes(raw.entry_point)) return refuse('entry_point', `entry_point ${JSON.stringify(raw.entry_point)} is not a join entry point`);
  if (!isIsoInstant(raw.established_at)) return refuse('instant', 'established_at must be a canonical ISO-8601 instant');
  if ((raw.state === 'REVOKED') !== (raw.revoked_at !== null && raw.revoked_at !== undefined)) return refuse('already_revoked', 'state REVOKED and a revoked_at instant must be set together');
  if (raw.state === 'REVOKED' && !REVOCATION_REASONS.includes(raw.revocation_reason)) return refuse('malformed', `revocation_reason ${JSON.stringify(raw.revocation_reason)} is not a revocation reason`);
  if (!Array.isArray(raw.history)) return refuse('malformed', 'history must be an array');
  return { ok: true, errors: [], code: null };
}

/** Refuse any document, or return it. */
export function assertPairingSession(raw) {
  const verdict = validatePairingSession(raw);
  if (!verdict.ok) throw new PairingValidationError(verdict.code, verdict.errors.join('; '));
  return raw;
}

export function assertTrustRecord(raw) {
  const verdict = validateTrustRecord(raw);
  if (!verdict.ok) throw new PairingValidationError(verdict.code, verdict.errors.join('; '));
  return raw;
}

/** The exact JSON document of a pairing session (declared fields only). */
export function sessionDocument(session) {
  return {
    schema_version: session.schema_version,
    kind: session.kind,
    session_id: session.session_id,
    entry_point: session.entry_point,
    state: session.state,
    created_at: session.created_at,
    expires_at: session.expires_at,
    challenge: session.challenge,
    confirmation_token_ref: session.confirmation_token_ref ?? null,
    initiator_fingerprint: session.initiator_fingerprint ?? null,
    responder_fingerprint: session.responder_fingerprint ?? null,
    preview: session.preview ?? null,
    trusted_device_id: session.trusted_device_id ?? null,
    trust_id: session.trust_id ?? null,
    confirmed_by: session.confirmed_by ?? null,
    confirmed_at: session.confirmed_at ?? null,
    terminal_reason: session.terminal_reason ?? null,
    transitions: (session.transitions ?? []).map((entry) => ({ state: entry.state, at: entry.at, reason: entry.reason ?? null })),
  };
}

/** The exact JSON document of a trust record. */
export function trustDocument(trust) {
  return {
    schema_version: trust.schema_version,
    kind: trust.kind,
    trust_id: trust.trust_id,
    device_id: trust.device_id,
    fingerprint: trust.fingerprint,
    role: trust.role,
    state: trust.state,
    entry_point: trust.entry_point,
    session_id: trust.session_id,
    established_at: trust.established_at,
    confirmed_by: trust.confirmed_by,
    credential_fingerprint: trust.credential_fingerprint,
    revoked_at: trust.revoked_at ?? null,
    revocation_reason: trust.revocation_reason ?? null,
    mac_mismatch_observed: Boolean(trust.mac_mismatch_observed),
    history: (trust.history ?? []).map((entry) => ({ state: entry.state, at: entry.at, reason: entry.reason ?? null })),
  };
}

/** Stable digest of a session document, used as evidence. */
export function sessionDigest(session) {
  return sha256(canonicalJson(sessionDocument(session)));
}

/** Stable digest of a trust document. */
export function trustDigest(trust) {
  return sha256(canonicalJson(trustDocument(trust)));
}

/**
 * Scan a value for material that must never be logged or stored.
 *
 * The audit log is meant to prove what happened without carrying key material, so this
 * is a runtime helper and not only a test assertion: a future caller that adds a field
 * to a transition can check it. It looks for PEM blocks, obvious secret-shaped field
 * names and the raw values a caller asks it to check for.
 */
export function findSecretMaterial(value, { knownSecrets = [], path = 'log', found = [] } = {}) {
  if (typeof value === 'string') {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) found.push(path);
    for (const secret of knownSecrets) if (typeof secret === 'string' && secret !== '' && value.includes(secret)) found.push(path);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretMaterial(item, { knownSecrets, path: `${path}[${index}]`, found }));
    return found;
  }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/(?:^|[._-])(?:private|secret|seed|mnemonic|passphrase)(?:$|[._-])/i.test(key)) found.push(childPath);
    findSecretMaterial(child, { knownSecrets, path: childPath, found });
  }
  return found;
}
