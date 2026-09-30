/**
 * UTOPIA · City Foundation — city-node-network — device identity lifecycle.
 *
 * Implements the RF-001 lifecycle: enrollment, rename, key rotation/revocation, network
 * metadata recording, installation bind/rebind/reinstall/retire and clone detection.
 *
 * Design rules this file holds to, because they are what make the acceptance claims
 * testable rather than merely asserted:
 *
 *   - **No ambient state.** There is no `Date.now()`, no `Math.random()`, no
 *     `process.env`, no filesystem and no sockets. Instants arrive as `nowMs` and are
 *     rendered through `instantOf`; identity entropy arrives as an explicit 16-byte
 *     `Uint8Array`. A caller that wants real entropy uses `randomEntropy()` explicitly,
 *     so a test can always pin what production would randomise.
 *   - **Copy-on-write.** Every function returns a new frozen document; nothing mutates
 *     its input, so a caller can keep an auditable previous version.
 *   - **Construction is self-checking.** Every builder runs its own document through the
 *     matching validator before returning, so a code path that forgot a rule cannot
 *     produce an impossible record.
 *   - **A secret is never stored.** An installation holds a credential *fingerprint*. The
 *     credential itself is an argument that is hashed on the way in and never copied into
 *     a document; `credentialLeakScan` lets a caller prove that after the fact.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  CREDENTIAL_ID_PATTERN,
  DEVICE_IDENTITY_FIELDS,
  DEVICE_IDENTITY_KIND,
  DEVICE_ID_PATTERN,
  DEVICE_INSTALLATION_KIND,
  DeviceIdentityError,
  IDENTITY_SCHEMA_VERSION,
  INSTALLATION_ID_PATTERN,
  MAC_AUTHORITY,
  MAC_EVIDENCE_ROLE,
  METADATA_AUTHORITY,
  assertDeviceIdentity,
  assertInstallation,
  canonicalJson,
  deviceIdentityDocument,
  deviceIdentityFromDocument,
  deviceKey,
  deviceMetadata,
  fingerprintKeyMaterial,
  installationDocument,
  installationFromDocument,
  macEvidence,
  normalizeMac,
  sha256,
} from './contracts.mjs';

/**
 * Presentation verdicts. `ACCEPTED` is the only value that may lead to an action; every
 * other value is a distinct, greppable refusal, so an operator can tell a stolen
 * credential (`CREDENTIAL_MISMATCH`) from a duplicated one (`CLONE_DETECTED`).
 */
export const PRESENTATION_VERDICTS = Object.freeze([
  'ACCEPTED',
  'MALFORMED_PRESENTATION',
  'UNKNOWN_INSTALLATION',
  'CREDENTIAL_MISMATCH',
  'CLONE_DETECTED',
  'QUARANTINED',
  'RETIRED',
  'UNBOUND',
]);

/**
 * Thrown when a lifecycle transition is refused.
 *
 * A distinct subclass so a caller can catch identity-lifecycle refusals specifically while
 * still catching every contract error with `DeviceIdentityError`.
 */
export class IdentityLifecycleError extends DeviceIdentityError {}

/** Real 16-byte entropy, isolated in one place so the rest of this module stays pure. */
export function randomEntropy() {
  return new Uint8Array(randomBytes(16));
}

/** Coerce 16 bytes of entropy into the lowercase hex this module's id prefixes carry. */
function hex16(entropy) {
  let bytes = null;
  if (entropy instanceof Uint8Array) bytes = Buffer.from(entropy);
  else if (typeof entropy === 'string' && /^[0-9a-fA-F]{32}$/.test(entropy)) bytes = Buffer.from(entropy, 'hex');
  if (bytes === null || bytes.length !== 16) {
    throw new IdentityLifecycleError('malformed', 'identity entropy must be 16 bytes (Uint8Array or 32 hex characters)');
  }
  return bytes.toString('hex').toLowerCase();
}

/** Mint a logical device identity: `dev-<32 hex>`. */
export function mintDeviceId(entropy) {
  return `dev-${hex16(entropy)}`;
}

/** Mint an installation identity: `ins-<32 hex>`. */
export function mintInstallationId(entropy) {
  return `ins-${hex16(entropy)}`;
}

/** Mint a physical-instance identity: `inst-<32 hex>`. */
export function mintInstanceId(entropy) {
  return `inst-${hex16(entropy)}`;
}

/** Mint an installation credential handle: `cred-<32 hex>`. */
export function mintCredentialId(entropy) {
  return `cred-${hex16(entropy)}`;
}

/** Render a caller-supplied instant. Instants are always parameters, never read here. */
export function instantOf(nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new IdentityLifecycleError('instant', `nowMs must be a finite millisecond instant, got ${String(nowMs)}`);
  }
  const rendered = new Date(nowMs).toISOString();
  if (Number.isNaN(Date.parse(rendered))) {
    throw new IdentityLifecycleError('instant', `nowMs ${nowMs} is outside the representable instant range`);
  }
  return rendered;
}

/** Fingerprint of an installation credential secret. The secret itself is never stored. */
export function credentialFingerprint(secret) {
  if (typeof secret !== 'string' || secret === '') {
    throw new IdentityLifecycleError('credential', 'a credential secret must be a non-empty string');
  }
  return sha256(secret);
}

/** Round-trip a device through the declared-field document and re-validate it. */
function freezeDevice(device) {
  return deviceIdentityFromDocument(deviceIdentityDocument(device));
}

/** Round-trip an installation through the declared-field document and re-validate it. */
function freezeInstallation(installation) {
  return installationFromDocument(installationDocument(installation));
}

/**
 * Enroll a logical device.
 *
 * The device id is supplied rather than minted here, because whether an id is new or
 * recovered is a caller decision, not a property of enrollment. The display name is
 * metadata from the very first instant, which is why `renameDevice` below can change it
 * with no trust consequence at all.
 */
export function enrollDevice({
  deviceId,
  displayName,
  nowMs,
  keyId = 'key-1',
  algorithm = 'ed25519',
  publicKeyMaterial,
  fingerprint,
  metadata = {},
}) {
  const createdAt = instantOf(nowMs);
  const key = deviceKey({ keyId, algorithm, fingerprint, publicKeyMaterial, createdAt });
  return freezeDevice({
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    kind: DEVICE_IDENTITY_KIND,
    deviceId,
    createdAt,
    displayName,
    state: 'ACTIVE',
    retiredAt: null,
    keys: [key],
    activeKeyId: key.keyId,
    metadata: deviceMetadata(metadata),
  });
}

/**
 * Rename a device.
 *
 * Only `displayName` changes. The device id, the key set, the active key and every
 * metadata observation are byte-identical afterwards — the machine-checkable form of "a
 * rename changes display metadata without changing authority". Two devices may hold the
 * same display name; nothing here or below resolves a device *by* name.
 */
export function renameDevice(device, displayName) {
  const current = assertDeviceIdentity(device);
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    throw new IdentityLifecycleError('display_name', 'displayName must be a non-empty string');
  }
  return freezeDevice({ ...deviceIdentityDocument(current), displayName });
}

/**
 * Record observed network metadata (hostnames, addresses, MAC observations).
 *
 * The patch replaces the corresponding metadata entries. Because metadata carries
 * `METADATA_AUTHORITY = 'NOT_AUTHORITY'` and no authority-bearing field is touched, an IP
 * change, a new hostname or a rewritten MAC cannot move identity — the acceptance claim
 * "IP/network changes do not change `device_id`", in code.
 */
export function recordNetworkMetadata(device, patch = {}) {
  const current = assertDeviceIdentity(device);
  const merged = { ...deviceIdentityDocument(current).metadata, ...patch };
  return freezeDevice({ ...deviceIdentityDocument(current), metadata: deviceMetadata(merged) });
}

/**
 * Refuse unless the named key exists, is ACTIVE, carries real key material, and belongs to a
 * device that has not been retired.
 *
 * This is the module's trust primitive: the contract docblock of `trustFromMacEvidence` names
 * "a `deviceId` plus a key that passes `assertActiveKey`" as what a caller must present. Every
 * rung here therefore has to hold, or a record that the module itself calls unauthenticated
 * would pass its own trust check:
 *
 *   - a retired device is finished, whatever its key set still says (retirement is terminal);
 *   - a `PLACEHOLDER` key is a reference to key material the record does not have — it is
 *     identity, never authentication, and must be replaced by enrollment or rotation first.
 */
export function assertActiveKey(device, keyId) {
  const current = assertDeviceIdentity(device);
  if (current.state === 'RETIRED') {
    throw new IdentityLifecycleError('device_retired', `device ${current.deviceId} is retired and cannot present key authority`);
  }
  const key = current.keys.find((entry) => entry.keyId === keyId);
  if (!key) throw new IdentityLifecycleError('key', `keyId ${JSON.stringify(keyId)} is not declared by this device`);
  if (key.state !== 'ACTIVE') throw new IdentityLifecycleError('key_not_active', `keyId ${keyId} is ${key.state}`);
  if (key.material === 'PLACEHOLDER') {
    throw new IdentityLifecycleError('key_material_missing', `keyId ${keyId} is a placeholder reference with no key material; enroll or rotate before it can authenticate`);
  }
  return key;
}

/**
 * Rotate the device key.
 *
 * The previous active key becomes `ROTATED` with a `retiredAt` instant: kept as history,
 * never deleted, so a signature made before the rotation can still be attributed. It stops
 * being authority immediately — `activeKeyId` moves and the old key can no longer pass
 * `assertActiveKey`. A retired device cannot rotate.
 */
export function rotateDeviceKey(device, { keyId, algorithm = 'ed25519', publicKeyMaterial, fingerprint, nowMs }) {
  const current = assertDeviceIdentity(device);
  if (current.state === 'RETIRED') {
    throw new IdentityLifecycleError('device_retired', `device ${current.deviceId} is retired`);
  }
  if (current.keys.some((key) => key.keyId === keyId)) {
    throw new IdentityLifecycleError('key', `keyId ${keyId} is already declared by this device`);
  }
  const at = instantOf(nowMs);
  const next = deviceKey({ keyId, algorithm, fingerprint, publicKeyMaterial, createdAt: at });
  const keys = current.keys.map((key) => (
    key.keyId === current.activeKeyId ? { ...key, state: 'ROTATED', retiredAt: at } : key
  ));
  return freezeDevice({ ...deviceIdentityDocument(current), keys: [...keys, next], activeKeyId: next.keyId });
}

/**
 * Revoke a non-active key.
 *
 * Revoking the key that is currently authority is refused rather than silently promoted:
 * a device must always have exactly one active key, and losing that invariant as a side
 * effect of a revocation would leave the device unable to prove anything.
 */
export function revokeDeviceKey(device, keyId, nowMs) {
  const current = assertDeviceIdentity(device);
  if (keyId === current.activeKeyId) {
    throw new IdentityLifecycleError('active_key', `keyId ${keyId} is the active key; rotate before revoking it`);
  }
  if (!current.keys.some((entry) => entry.keyId === keyId)) {
    throw new IdentityLifecycleError('key', `keyId ${JSON.stringify(keyId)} is not declared by this device`);
  }
  const at = instantOf(nowMs);
  return freezeDevice({
    ...deviceIdentityDocument(current),
    keys: current.keys.map((entry) => (entry.keyId === keyId ? { ...entry, state: 'REVOKED', retiredAt: at } : entry)),
  });
}

/** Retire a logical device. Terminal; the record and its keys are preserved as history. */
export function retireDevice(device, nowMs) {
  const current = assertDeviceIdentity(device);
  if (current.state === 'RETIRED') {
    throw new IdentityLifecycleError('already_retired', `device ${current.deviceId} is already retired`);
  }
  return freezeDevice({ ...deviceIdentityDocument(current), state: 'RETIRED', retiredAt: instantOf(nowMs) });
}

/**
 * Create an installation.
 *
 * With no `deviceId` the installation is `UNBOUND` and declares `rebind.required`, so a
 * freshly installed instance can be represented *before* anyone has proved it belongs to an
 * existing logical device — the state a reinstall starts in. That state is deliberately
 * inert: `resolveInstallationPresentation` refuses an unbound installation.
 */
export function createInstallation({
  installationId,
  instanceId,
  credentialId,
  credentialFingerprint: fingerprint,
  credentialSecret,
  nowMs,
  deviceId = null,
}) {
  const createdAt = instantOf(nowMs);
  const resolvedFingerprint = fingerprint ?? (credentialSecret === undefined ? null : credentialFingerprint(credentialSecret));
  const bound = deviceId !== null && deviceId !== undefined;
  return freezeInstallation({
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    kind: DEVICE_INSTALLATION_KIND,
    installationId,
    instanceId,
    createdAt,
    deviceId: bound ? deviceId : null,
    state: bound ? 'BOUND' : 'UNBOUND',
    credential: { credentialId, fingerprint: resolvedFingerprint, createdAt },
    boundAt: bound ? createdAt : null,
    rebind: { required: !bound, reason: bound ? null : 'fresh_installation' },
    retiredAt: null,
    quarantine: null,
  });
}

/** Explicit enrollment of a fresh installation onto a logical device. */
export function enrollInstallation(options) {
  if (options?.deviceId === null || options?.deviceId === undefined) {
    throw new IdentityLifecycleError('device_id', 'enrollInstallation requires the logical deviceId being enrolled');
  }
  return createInstallation(options);
}

/**
 * Bind an unbound installation to a logical device.
 *
 * `proof` is mandatory and is recorded only by its presence and kind: this function
 * refuses to invent evidence. It is the "explicit rebind/enrollment" half of the claim
 * that a reinstall must not silently inherit a device.
 *
 * Refusals are specific. An installation quarantined for credential cloning can never be
 * rebound, and one already bound to a *different* device must be retired rather than
 * re-pointed, because re-pointing is exactly the silent takeover this rule prevents.
 */
export function rebindInstallation(installation, { deviceId, proof, nowMs }) {
  const current = assertInstallation(installation);
  if (current.state === 'QUARANTINED') {
    throw new IdentityLifecycleError('quarantined', `installation ${current.installationId} is quarantined and cannot be rebound`);
  }
  if (current.state === 'RETIRED') {
    throw new IdentityLifecycleError('installation_retired', `installation ${current.installationId} is retired`);
  }
  if (proof === null || proof === undefined) {
    throw new IdentityLifecycleError('rebind_proof_required', 'rebinding requires explicit owner/enrollment proof');
  }
  if (typeof proof !== 'object' || typeof proof.kind !== 'string' || proof.kind === '') {
    throw new IdentityLifecycleError('rebind_proof_required', 'proof must be an object naming its kind');
  }
  if (current.state === 'BOUND' && current.deviceId !== deviceId) {
    throw new IdentityLifecycleError('already_bound', `installation ${current.installationId} is bound to ${current.deviceId}`);
  }
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new IdentityLifecycleError('device_id', `deviceId ${JSON.stringify(deviceId)} is not a dev-<32 hex> identity`);
  }
  return freezeInstallation({
    ...installationDocument(current),
    deviceId,
    state: 'BOUND',
    boundAt: instantOf(nowMs),
    rebind: { required: false, reason: null },
  });
}

/**
 * Reinstall.
 *
 * Returns both halves so a caller cannot keep only the convenient one: the previous
 * installation, retired at `nowMs`, and a fresh unbound installation carrying a new
 * `installationId`, a new `instanceId` and a new credential. The logical `deviceId` is
 * deliberately *not* carried over — that is the whole point — so the new installation must
 * be rebound explicitly before it can act.
 */
export function reinstallInstallation(previous, {
  installationId,
  instanceId,
  credentialId,
  credentialFingerprint: fingerprint,
  credentialSecret,
  nowMs,
}) {
  const current = assertInstallation(previous);
  if (installationId === current.installationId) {
    throw new IdentityLifecycleError('installation_id', 'a reinstall must mint a new installationId');
  }
  if (instanceId === current.instanceId) {
    throw new IdentityLifecycleError('instance_id', 'a reinstall must mint a new instanceId');
  }
  // A reused credential is the "reused installation credential" the workbook names: the old
  // and the new installation would share one secret, so possession of it could not be
  // attributed to exactly one physical installation. Identity and instance must both be new,
  // and so must the credential.
  const resolvedFingerprint = fingerprint ?? (credentialSecret === undefined ? null : credentialFingerprint(credentialSecret));
  if (credentialId === current.credential.credentialId) {
    throw new IdentityLifecycleError('credential_reuse', 'a reinstall must mint a new credential handle, not reuse the previous one');
  }
  if (resolvedFingerprint !== null && resolvedFingerprint === current.credential.fingerprint) {
    throw new IdentityLifecycleError('credential_reuse', 'a reinstall must mint a new credential secret; reusing the previous secret would let two installations share one credential');
  }
  const retired = freezeInstallation({
    ...installationDocument(current),
    state: 'RETIRED',
    retiredAt: instantOf(nowMs),
    rebind: { required: false, reason: null },
  });
  const fresh = createInstallation({
    installationId,
    instanceId,
    credentialId,
    credentialFingerprint: fingerprint,
    credentialSecret,
    nowMs,
    deviceId: null,
  });
  return Object.freeze({
    retired,
    installation: freezeInstallation({ ...installationDocument(fresh), rebind: { required: true, reason: 'reinstall' } }),
  });
}

/** Retire an installation. Terminal, refusing on a second attempt, history preserved. */
export function retireInstallation(installation, nowMs) {
  const current = assertInstallation(installation);
  if (current.state === 'RETIRED') {
    throw new IdentityLifecycleError('already_retired', `installation ${current.installationId} is already retired`);
  }
  return freezeInstallation({
    ...installationDocument(current),
    state: 'RETIRED',
    retiredAt: instantOf(nowMs),
    rebind: { required: false, reason: null },
  });
}

/**
 * Quarantine an installation.
 *
 * Quarantine is the state; the reason is carried verbatim so a downstream ledger can state
 * what actually happened. A retired installation is not quarantined — retirement is already
 * terminal, and re-labelling it would rewrite history.
 */
export function quarantineInstallation(installation, { nowMs, code, detail }) {
  const current = assertInstallation(installation);
  if (current.state === 'RETIRED') {
    throw new IdentityLifecycleError('installation_retired', `installation ${current.installationId} is retired`);
  }
  if (typeof code !== 'string' || code === '') {
    throw new IdentityLifecycleError('malformed', 'quarantine requires a non-empty code');
  }
  return freezeInstallation({
    ...installationDocument(current),
    state: 'QUARANTINED',
    rebind: { required: false, reason: null },
    quarantine: { at: instantOf(nowMs), code, detail: typeof detail === 'string' ? detail : '' },
  });
}

/**
 * Decide what a presented installation credential means.
 *
 * The order of the ladder is the security argument, and each rung is a different fact:
 *
 *   1. an installation id the record does not own is simply unknown;
 *   2. a retired installation is finished, whatever is presented;
 *   3. a quarantined installation stays quarantined — a clone cannot clear its own flag;
 *   4. a credential that does not match the record is a *stolen or wrong* credential, and is
 *      reported separately from a duplicated one;
 *   5. the same installation identity presenting from a **different physical instance** is
 *      a clone: precisely "two physical installations silently sharing one active
 *      installation identity", converted from a silent condition into a named refusal;
 *   6. an unbound installation has no logical device yet, so it may do nothing;
 *   7. otherwise accepted.
 *
 * Rung 5 runs before rung 6 on purpose: a cloned credential must be detectable even while
 * the installation is unbound.
 *
 * @param {object} installation a valid installation document
 * @param {{installationId: string, instanceId: string, credentialId: string, credentialFingerprint: string}} presented
 * @returns {{accepted: boolean, verdict: string, code: string|null, detail: string, installation: object}}
 */
export function resolveInstallationPresentation(installation, presented) {
  const current = assertInstallation(installation);
  const refuse = (verdict, code, detail) => ({ accepted: false, verdict, code, detail, installation: current });
  if (presented === null || typeof presented !== 'object' || Array.isArray(presented)) {
    return refuse('MALFORMED_PRESENTATION', 'malformed', 'a presentation must be an object');
  }
  if (presented.installationId !== current.installationId) {
    return refuse(
      'UNKNOWN_INSTALLATION',
      'unknown_installation',
      `presented installationId ${JSON.stringify(presented.installationId)} is not ${current.installationId}`,
    );
  }
  if (current.state === 'RETIRED') {
    return refuse('RETIRED', 'installation_retired', `installation ${current.installationId} is retired`);
  }
  if (current.state === 'QUARANTINED') {
    return refuse('QUARANTINED', 'quarantined', `installation ${current.installationId} is quarantined`);
  }
  const credentialMatches = presented.credentialId === current.credential.credentialId
    && presented.credentialFingerprint === current.credential.fingerprint;
  if (!credentialMatches) {
    return refuse('CREDENTIAL_MISMATCH', 'credential_mismatch', `presented credential does not match installation ${current.installationId}`);
  }
  if (presented.instanceId !== current.instanceId) {
    return refuse(
      'CLONE_DETECTED',
      'clone_detected',
      `installation ${current.installationId} presented from instance ${JSON.stringify(presented.instanceId)} but was enrolled from ${current.instanceId}`,
    );
  }
  if (current.state === 'UNBOUND') {
    return refuse('UNBOUND', 'installation_unbound', `installation ${current.installationId} is not bound to a logical device`);
  }
  return {
    accepted: true,
    verdict: 'ACCEPTED',
    code: null,
    detail: `installation ${current.installationId} matches its record`,
    installation: current,
  };
}

/**
 * Scan a population of installation records for a shared installation identity or a shared
 * installation credential.
 *
 * A per-record ladder cannot see two *records* that both claim one installation id, so this
 * is the population-level half of clone detection. Two distinct facts are reported separately,
 * because they need different repairs:
 *
 *   - `SHARED_INSTALLATION_IDENTITY`: one installation identity observed under more than one
 *     instance id, or with more than one credential fingerprint.
 *   - `REUSED_CREDENTIAL`: one credential fingerprint observed under more than one installation
 *     identity. This is the "reused installation credential" case — a fresh installation that
 *     merely mints a new id while keeping the old secret would otherwise be invisible here,
 *     even though it lets two physical installations present one credential.
 *
 * Retirement is not an exemption — a retired record that shares an identity or a credential
 * is still evidence that it was duplicated.
 *
 * @param {object[]} installations
 * @returns {{reason: string, installationId?: string, credentialFingerprint?: string,
 *            instances: string[], credentialFingerprints?: string[], installationIds?: string[],
 *            states: string[]}[]}
 */
export function detectCredentialClones(installations) {
  const byInstallation = new Map();
  const byCredential = new Map();
  for (const candidate of installations) {
    const current = assertInstallation(candidate);
    const entry = byInstallation.get(current.installationId)
      ?? { instances: new Set(), credentialFingerprints: new Set(), states: new Set() };
    entry.instances.add(current.instanceId);
    entry.credentialFingerprints.add(current.credential.fingerprint);
    entry.states.add(current.state);
    byInstallation.set(current.installationId, entry);

    const credentialEntry = byCredential.get(current.credential.fingerprint)
      ?? { installationIds: new Set(), instances: new Set(), states: new Set() };
    credentialEntry.installationIds.add(current.installationId);
    credentialEntry.instances.add(current.instanceId);
    credentialEntry.states.add(current.state);
    byCredential.set(current.credential.fingerprint, credentialEntry);
  }
  const findings = [];
  for (const [installationId, entry] of byInstallation) {
    if (entry.instances.size > 1 || entry.credentialFingerprints.size > 1) {
      findings.push({
        reason: 'SHARED_INSTALLATION_IDENTITY',
        installationId,
        instances: [...entry.instances].sort(),
        credentialFingerprints: [...entry.credentialFingerprints].sort(),
        states: [...entry.states].sort(),
      });
    }
  }
  for (const [credentialFingerprint, entry] of byCredential) {
    if (entry.installationIds.size > 1) {
      findings.push({
        reason: 'REUSED_CREDENTIAL',
        credentialFingerprint,
        installationIds: [...entry.installationIds].sort(),
        instances: [...entry.instances].sort(),
        states: [...entry.states].sort(),
      });
    }
  }
  return findings.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    const left = a.installationId ?? a.credentialFingerprint ?? '';
    const right = b.installationId ?? b.credentialFingerprint ?? '';
    return left < right ? -1 : 1;
  });
}

/**
 * The optional MAC evidence a pairing screen may show, and what it must never become.
 *
 * `authoritative` and `canBlockPairing` are always false, including when the platform
 * reported nothing at all or reported a randomised address. The entries exist for a human
 * to compare against a sticker or a settings screen; they are not an input to any decision.
 */
export function macPairingEvidence(values = []) {
  // A caller may hold one address, several, or nothing. Accepting all three is deliberate:
  // this is the one path that must never fail a pairing, so an unhelpful shape is answered
  // with a typed refusal rather than an incidental `TypeError` from `.map`.
  const list = values === null || values === undefined
    ? []
    : (Array.isArray(values) ? values : (typeof values === 'string' ? [values] : null));
  if (list === null) {
    throw new IdentityLifecycleError('malformed', 'MAC evidence must be a single address, an array of addresses, or absent');
  }
  const entries = list.map((value) => macEvidence(value, 'reported'));
  return Object.freeze({
    role: MAC_EVIDENCE_ROLE,
    authority: MAC_AUTHORITY,
    authoritative: false,
    canBlockPairing: false,
    unavailable: entries.filter((entry) => entry.value === null).length,
    randomized: entries.filter((entry) => entry.randomized).length,
    entries: Object.freeze(entries),
  });
}

/**
 * Refuse every attempt to derive trust from MAC evidence.
 *
 * Not a configurable policy: it refuses for every input, including a byte-identical match
 * against a previously trusted device. A caller that wants to trust a node must present
 * cryptographic identity — a `deviceId` plus a key that passes `assertActiveKey`.
 */
export function trustFromMacEvidence() {
  return Object.freeze({
    granted: false,
    code: 'mac_not_authority',
    detail: 'a MAC address is optional local pairing evidence and can never grant trust or identify a node',
  });
}

/**
 * Upgrade a legacy record to a `DeviceIdentity`.
 *
 * Exactly two inputs are accepted:
 *
 *   - a v1 device identity document, validated and returned unchanged;
 *   - a row in the shape the live `services/dev-gateway` node table already holds —
 *     `{id, devicePrincipalId, displayName, metadata:{platform}, agentVersion, ...}` —
 *     which becomes a v1 document with `deviceId = id`, a `legacy-gateway` key reference and
 *     the observed platform/hostname moved into `metadata`.
 *
 * A legacy row carries **no key material**. The upgraded device therefore gets a key
 * reference whose fingerprint is derived from the record itself, and `PROVENANCE.json`
 * records that this is a placeholder for the key the record does not yet have — the
 * migration is deliberately not allowed to invent a cryptographic fact. A future schema
 * version is refused rather than guessed at.
 *
 * @returns {{migrated: boolean, device: object, from: string}}
 */
export function migrateDeviceIdentity(raw, { nowMs } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IdentityLifecycleError('malformed', 'a migratable record must be an object');
  }
  if (raw.schemaVersion === IDENTITY_SCHEMA_VERSION) {
    return Object.freeze({ migrated: false, device: assertDeviceIdentity(raw), from: 'device-identity-v1' });
  }
  if (raw.schemaVersion !== undefined) {
    throw new IdentityLifecycleError(
      'schema_version',
      `device identity schemaVersion ${JSON.stringify(raw.schemaVersion)} cannot be migrated by this module`,
    );
  }
  if (typeof raw.id !== 'string' || !DEVICE_ID_PATTERN.test(raw.id)) {
    throw new IdentityLifecycleError('device_id', `legacy record id ${JSON.stringify(raw.id)} is not a dev-<32 hex> identity`);
  }
  const at = instantOf(nowMs);
  const platform = typeof raw.metadata?.platform === 'string' ? raw.metadata.platform : null;
  const device = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    kind: DEVICE_IDENTITY_KIND,
    deviceId: raw.id,
    createdAt: at,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() !== '' ? raw.displayName : raw.id,
    state: 'ACTIVE',
    retiredAt: null,
    keys: [deviceKey({
      keyId: 'legacy-gateway',
      algorithm: 'ed25519',
      fingerprint: fingerprintKeyMaterial(canonicalJson({ id: raw.id, agentVersion: raw.agentVersion ?? null })),
      // A placeholder, not a key: the legacy row was never issued one. Marked so that
      // `assertActiveKey` refuses it — the migrated record is identity without authentication
      // until a real enrollment or rotation replaces this reference.
      material: 'PLACEHOLDER',
      createdAt: at,
    })],
    activeKeyId: 'legacy-gateway',
    metadata: deviceMetadata({
      platform,
      hostnames: typeof raw.metadata?.hostname === 'string' ? [raw.metadata.hostname] : [],
    }),
  };
  return Object.freeze({ migrated: true, device: freezeDevice(device), from: 'legacy-gateway-node-row' });
}

/**
 * Serialise a device identity canonically.
 *
 * Two documents with the same meaning produce the same bytes regardless of the key order the
 * caller's object happened to use, which is what makes the digest usable as evidence in a
 * report or a ledger.
 */
export function serializeDeviceIdentity(device) {
  return canonicalJson(deviceIdentityDocument(assertDeviceIdentity(device)));
}

/** Serialise an installation canonically. */
export function serializeInstallation(installation) {
  return canonicalJson(installationDocument(assertInstallation(installation)));
}

/**
 * Scan a serialised document for a credential secret.
 *
 * `secretPresent: false` is the contract: the secret is hashed on the way in, so no
 * serialised identity or installation may contain it. Kept as a runtime helper rather than
 * only a test assertion, because a future caller could otherwise add a field and leak the
 * value silently.
 */
export function credentialLeakScan(serialized, secret) {
  if (typeof serialized !== 'string') throw new IdentityLifecycleError('malformed', 'serialized document must be a string');
  if (typeof secret !== 'string' || secret === '') {
    throw new IdentityLifecycleError('credential', 'a credential secret must be a non-empty string');
  }
  const hash = createHash('sha256').update(secret, 'utf8').digest('hex');
  return Object.freeze({
    secretPresent: serialized.includes(secret),
    fingerprintPresent: serialized.includes(`sha256:${hash}`),
  });
}

/** The declared field list of a device identity, re-exported for consumers and tests. */
export const IDENTITY_FIELD_LIST = DEVICE_IDENTITY_FIELDS;

/** The metadata authority marker, re-exported so a consumer need not import two modules. */
export const METADATA_IS_NOT_AUTHORITY = METADATA_AUTHORITY;

/** `normalizeMac`, re-exported so a caller has one import site for MAC handling. */
export { normalizeMac };
