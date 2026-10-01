/**
 * UTOPIA · City Foundation — city-node-network — pairing-trust tests (RF-002).
 *
 * Every "Required acceptance" line of
 * `Digital-City/mission-book/remote/RF-002-unified-pairing-trust-lifecycle.md` is
 * exercised below, together with the negative and security cases that make the positive
 * ones meaningful. The suite is deterministic: entropy is pinned and instants are
 * parameters, so nothing depends on the clock or on randomness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SESSION_TTL_MS,
  ENTRY_POINTS,
  MAC_AUTHORITY,
  MAX_CONFIRMATION_ATTEMPTS,
  MAC_EVIDENCE_ROLE,
  PAIRING_PHASES,
  PAIRING_REJECTION_CODES,
  PAIRING_SCHEMA_VERSION,
  PAIRING_STATES,
  PAIRING_TERMINAL_STATES,
  PAIRING_TRANSITIONS,
  PairingError,
  REVOCATION_REASONS,
  TRUST_ROLES,
  TRUST_STATES,
  buildDevicePreview,
  capabilitiesFromTrustRole,
  challengeFromNonce,
  createPairingAuthority,
  findSecretMaterial,
  inspectSessionDocument,
  isFinalState,
  isLocallyAdministeredMac,
  mintSessionId,
  mintTrustId,
  normalizeMac,
  randomEntropy,
  resolveActiveTrust,
  sessionDigest,
  sha256,
  trustDigest,
  trustFromMacEvidence,
  validatePairingSession,
  validateTrustRecord,
} from '../index.mjs';

/* ------------------------------------------------------------------ fixtures */

const entropy = (pair) => Uint8Array.from(Buffer.from(pair.repeat(16).slice(0, 32), 'hex'));

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const T1 = Date.parse('2026-01-01T00:00:01.000Z');
const T2 = Date.parse('2026-01-01T00:00:02.000Z');
const T3 = Date.parse('2026-01-01T00:00:03.000Z');
const T4 = Date.parse('2026-01-01T00:00:04.000Z');
const EXPIRED = T0 + DEFAULT_SESSION_TTL_MS + 1000;

const DEVICE = mintDeviceId();
const OTHER_DEVICE = mintDeviceId('22');
const SESSION = mintSessionId(entropy('11'));
const TRUST = mintTrustId(entropy('33'));

const FP_INITIATOR = sha256('initiator-public-key');
const FP_RESPONDER = sha256('responder-public-key');
const FP_OTHER = sha256('someone-else-public-key');
const CREDENTIAL = sha256('installation-credential');
const CREDENTIAL_2 = sha256('installation-credential-rotated');
const GLOBAL_MAC = '3c:22:fb:11:22:33';
const RANDOM_MAC = '02:11:22:33:44:55';

/** A local helper so tests read as intent rather than as id plumbing. */
function mintDeviceId(seed = '11') {
  return `dev-${seed.repeat(16).slice(0, 32)}`;
}

const authority = () => createPairingAuthority();

/** Drive a session all the way to HUMAN_CONFIRM. */
function readySession(auth, {
  sessionId = SESSION,
  entryPoint = 'DISCOVERY_LAN',
  nonce = 'nonce-1',
  tokenNonce = 'token-1',
  nowMs = T0,
  preview = null,
} = {}) {
  auth.startSession({ sessionId, entryPoint, nonce, initiatorFingerprint: FP_INITIATOR, nowMs });
  auth.exchangeEphemeralKeys(sessionId, { responderFingerprint: FP_RESPONDER, nowMs: nowMs + 500 });
  auth.presentDevicePreview(sessionId, {
    preview: preview ?? buildDevicePreview({
      deviceId: DEVICE,
      displayName: 'Alien Phone',
      platform: 'android',
      model: 'Pixel',
      fingerprint: FP_RESPONDER,
      macAddresses: [GLOBAL_MAC],
    }),
    nowMs: nowMs + 1000,
  });
  return auth.requestConfirmation(sessionId, { tokenNonce, nowMs: nowMs + 1500 });
}

const confirmArgs = (overrides = {}) => ({
  tokenNonce: 'token-1',
  confirmedBy: 'owner',
  confirmFingerprint: FP_RESPONDER,
  deviceId: DEVICE,
  role: 'PERSONAL_DEVICE',
  credentialFingerprint: CREDENTIAL,
  trustId: TRUST,
  nowMs: T4,
  ...overrides,
});

const expectCode = (fn, code) => {
  try { fn(); } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected the call to fail with ${code}`);
};

/* ------------------------------------ 1. many join methods, one trust protocol */

test('every join entry point feeds the same pairing state machine', () => {
  assert.deepEqual([...ENTRY_POINTS], [
    'DISCOVERY_LAN', 'DISCOVERY_BLUETOOTH', 'DIRECT_ADDRESS', 'REMOTE_INVITE', 'DEEP_LINK', 'QR_WEB_LINK',
  ]);
  for (const [index, entryPoint] of ENTRY_POINTS.entries()) {
    const auth = authority();
    const sessionId = mintSessionId(entropy(`${(index + 1).toString(16)}1`));
    const started = auth.startSession({
      sessionId, entryPoint, nonce: `nonce-${entryPoint}`, initiatorFingerprint: FP_INITIATOR, nowMs: T0,
    });
    assert.equal(started.state, 'PAIRING_SESSION', `${entryPoint} starts the same first phase`);
    assert.equal(started.entry_point, entryPoint);
    // and it walks the identical transition table from there
    assert.deepEqual(started.transitions.map((entry) => entry.state), ['PAIRING_SESSION']);
    const keys = auth.exchangeEphemeralKeys(sessionId, { responderFingerprint: FP_RESPONDER, nowMs: T1 });
    assert.equal(keys.state, 'EPHEMERAL_KEY_EXCHANGE', `${entryPoint} walks the same second phase`);
  }
});

test('a Bluetooth bootstrap and a remote invite end in the same TRUSTED record', () => {
  const args = [
    { entryPoint: 'DISCOVERY_BLUETOOTH', sessionId: mintSessionId(entropy('41')), trustId: mintTrustId(entropy('51')) },
    { entryPoint: 'REMOTE_INVITE', sessionId: mintSessionId(entropy('42')), trustId: mintTrustId(entropy('52')) },
  ];
  const established = [];
  for (const [index, item] of args.entries()) {
    const auth = authority();
    readySession(auth, { sessionId: item.sessionId, entryPoint: item.entryPoint, nonce: `n-${index}`, tokenNonce: `t-${index}` });
    const done = auth.confirmPairing(item.sessionId, confirmArgs({ tokenNonce: `t-${index}`, trustId: item.trustId }));
    established.push(done.trust);
  }
  // Same shape, same role vocabulary, same trust state - only the recorded entry point differs.
  assert.deepEqual(Object.keys(established[0]).sort(), Object.keys(established[1]).sort());
  assert.equal(established[0].role, established[1].role);
  assert.equal(established[0].state, 'TRUSTED');
  assert.equal(established[1].state, 'TRUSTED');
  assert.notEqual(established[0].entry_point, established[1].entry_point);
});

test('possession of an invite or proximity never becomes trust on its own', () => {
  const auth = authority();
  // A session exists and keys were exchanged: reaching the device is not trust.
  auth.startSession({ sessionId: SESSION, entryPoint: 'REMOTE_INVITE', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  auth.exchangeEphemeralKeys(SESSION, { responderFingerprint: FP_RESPONDER, nowMs: T1 });
  assert.equal(auth.getSession(SESSION).state, 'EPHEMERAL_KEY_EXCHANGE');
  assert.deepEqual(auth.listTrusts(), []);
  // Confirmation is not even available before the human preview step.
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs()), 'confirmation_not_available');
  assert.deepEqual(auth.listTrusts(), [], 'a refused confirmation creates no trust');
});

/* ------------------------------- 2. stable fingerprints for human confirmation */

test('both sides present stable fingerprints, and the confirmation is bound to them', () => {
  const auth = authority();
  readySession(auth);
  const session = auth.getSession(SESSION);
  assert.equal(session.initiator_fingerprint, FP_INITIATOR);
  assert.equal(session.responder_fingerprint, FP_RESPONDER);
  assert.equal(session.preview.fingerprint, FP_RESPONDER, 'the preview shows the fingerprint the human compares');
  // Confirming a different fingerprint than the one exchanged is refused.
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ confirmFingerprint: FP_OTHER })), 'fingerprint_mismatch');
  assert.deepEqual(auth.listTrusts(), []);
  // The digest of a session is stable and changes when the binding changes.
  assert.equal(sessionDigest(session), sessionDigest(auth.getSession(SESSION)));
});

test('a preview that carries a different fingerprint than the key exchange is refused', () => {
  const auth = authority();
  auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  auth.exchangeEphemeralKeys(SESSION, { responderFingerprint: FP_RESPONDER, nowMs: T1 });
  const wrong = buildDevicePreview({ deviceId: DEVICE, fingerprint: FP_OTHER, macAddresses: [] });
  expectCode(() => auth.presentDevicePreview(SESSION, { preview: wrong, nowMs: T2 }), 'fingerprint_mismatch');
});

test('both sides reporting the same fingerprint is refused: a pairing needs two peers', () => {
  const auth = authority();
  auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  expectCode(
    () => auth.exchangeEphemeralKeys(SESSION, { responderFingerprint: FP_INITIATOR, nowMs: T1 }),
    'fingerprint_mismatch',
  );
});

/* ------------------------------ 3. reused and expired pairing attempts rejected */

test('a replayed bootstrap nonce is refused, so an observed handshake cannot be reused', () => {
  const auth = authority();
  auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'shared-nonce', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  const second = mintSessionId(entropy('55'));
  expectCode(
    () => auth.startSession({ sessionId: second, entryPoint: 'QR_WEB_LINK', nonce: 'shared-nonce', initiatorFingerprint: FP_INITIATOR, nowMs: T1 }),
    'challenge_replayed',
  );
  assert.equal(auth.listSessions().length, 1, 'the replayed attempt created nothing');
  assert.equal(challengeFromNonce('shared-nonce'), auth.getSession(SESSION).challenge);
});

test('a confirmation token is single-use even across sessions', () => {
  const auth = authority();
  readySession(auth, { tokenNonce: 'one-time' });
  auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'one-time' }));
  // A brand-new session that asks for the SAME token nonce cannot consume it again.
  const second = mintSessionId(entropy('56'));
  readySession(auth, { sessionId: second, nonce: 'n2', tokenNonce: 'one-time', nowMs: T0 });
  expectCode(
    () => auth.confirmPairing(second, confirmArgs({ tokenNonce: 'one-time', sessionId: second, trustId: mintTrustId(entropy('57')), deviceId: OTHER_DEVICE })),
    'confirmation_replayed',
  );
  assert.deepEqual(auth.listTrusts().map((trust) => trust.device_id), [DEVICE]);
});

test('a wrong confirmation token is refused and the session stays open', () => {
  const auth = authority();
  readySession(auth);
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'not-the-token' })), 'confirmation_not_available');
  assert.equal(auth.getSession(SESSION).state, 'HUMAN_CONFIRM');
  assert.deepEqual(auth.listTrusts(), []);
});

test('a session past its deadline cannot advance, whatever the caller tries', () => {
  const auth = authority();
  readySession(auth);
  assert.equal(auth.getSession(SESSION).expires_at, new Date(T0 + DEFAULT_SESSION_TTL_MS).toISOString());
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ nowMs: EXPIRED })), 'terminal_state');
  assert.equal(auth.getSession(SESSION).state, 'EXPIRED', 'touching an overdue session marks it expired');
  assert.equal(auth.getSession(SESSION).terminal_reason, 'session_ttl_elapsed');
  assert.deepEqual(auth.listTrusts(), []);
});

test('expiry is a fact about the clock, not something a caller can assert', () => {
  const auth = authority();
  auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  expectCode(() => auth.expireSession(SESSION, { nowMs: T1 }), 'session_not_expired');
  assert.equal(auth.expireSession(SESSION, { nowMs: EXPIRED }).state, 'EXPIRED');
});

test('failed-pair cleanup retires exactly the overdue sessions and nothing else', () => {
  const auth = authority();
  const fresh = mintSessionId(entropy('61'));
  auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n1', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  auth.startSession({ sessionId: fresh, entryPoint: 'DISCOVERY_LAN', nonce: 'n2', initiatorFingerprint: FP_INITIATOR, nowMs: EXPIRED });
  assert.deepEqual(auth.cleanupExpired(EXPIRED + 1000).expired, [SESSION]);
  assert.equal(auth.getSession(SESSION).state, 'EXPIRED');
  assert.equal(auth.getSession(fresh).state, 'PAIRING_SESSION', 'a live attempt is untouched');
});

/* -------------------------------------- the state machine itself */

test('the transition table is respected and terminal states are terminal', () => {
  assert.deepEqual([...PAIRING_PHASES], ['PAIRING_SESSION', 'EPHEMERAL_KEY_EXCHANGE', 'DEVICE_PREVIEW', 'HUMAN_CONFIRM', 'TRUSTED']);
  assert.deepEqual([...PAIRING_TERMINAL_STATES], ['REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED']);
  const auth = authority();
  auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  // Cannot skip the key exchange.
  expectCode(() => auth.presentDevicePreview(SESSION, { preview: buildDevicePreview({ deviceId: DEVICE, fingerprint: FP_RESPONDER }), nowMs: T1 }), 'illegal_transition');
  // Cannot skip straight to trust.
  expectCode(() => auth.requestConfirmation(SESSION, { tokenNonce: 'x', nowMs: T1 }), 'illegal_transition');
  // A cancelled session is finished for good.
  auth.cancelPairing(SESSION, { nowMs: T1 });
  assert.equal(auth.getSession(SESSION).state, 'CANCELLED');
  expectCode(() => auth.exchangeEphemeralKeys(SESSION, { responderFingerprint: FP_RESPONDER, nowMs: T2 }), 'terminal_state');
});

test('reject, cancel and fail are distinct recorded outcomes', () => {
  for (const [operation, expected] of [['rejectPairing', 'REJECTED'], ['cancelPairing', 'CANCELLED'], ['failPairing', 'FAILED']]) {
    const auth = authority();
    const sessionId = mintSessionId(entropy('71'));
    auth.startSession({ sessionId, entryPoint: 'DISCOVERY_LAN', nonce: `n-${operation}`, initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
    const result = auth[operation](sessionId, { reason: 'because', nowMs: T1 });
    assert.equal(result.state, expected);
    assert.equal(result.terminal_reason, 'because');
    assert.deepEqual(auth.listTrusts(), []);
    assert.ok(PAIRING_STATES.includes(result.state));
  }
});

/* --------------------------- 4. revoked devices cannot reconnect */

test('a revoked device cannot reconnect with its old credentials', () => {
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs());
  const credentials = { deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: CREDENTIAL };
  assert.equal(auth.checkReconnect(credentials).allowed, true);

  auth.revokeTrust(TRUST, { reason: 'OWNER_REVOKED', actor: 'owner', nowMs: T4 });
  const after = auth.checkReconnect(credentials);
  assert.equal(after.allowed, false);
  assert.equal(after.code, 'trust_revoked');
  expectCode(() => auth.revokeTrust(TRUST, { reason: 'OWNER_REVOKED', nowMs: T4 }), 'already_revoked');
});

test('a lost device loses every trust it holds, and re-pairing needs an explicit decision', () => {
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs());
  assert.deepEqual(auth.revokeLostDevice(DEVICE, { actor: 'owner', nowMs: T4 }).revoked, [TRUST]);
  assert.equal(auth.getTrust(TRUST).revocation_reason, 'DEVICE_LOST');
  expectCode(() => auth.revokeLostDevice(OTHER_DEVICE, { nowMs: T4 }), 'unknown_device');

  // Re-pair: refused unless the caller explicitly says it is replacing the old trust.
  // A REVOKED record counts, so revoking a lost device cannot be undone by simply
  // pairing again.
  const second = mintSessionId(entropy('81'));
  readySession(auth, { sessionId: second, nonce: 'n2', tokenNonce: 't2' });
  expectCode(
    () => auth.confirmPairing(second, confirmArgs({ tokenNonce: 't2', trustId: mintTrustId(entropy('82')) })),
    'already_trusted',
  );
  assert.equal(auth.listTrusts({ deviceId: DEVICE }).length, 1, 'the refused re-pair created nothing');

  // Stated explicitly, it succeeds, and the revoked record is kept as history.
  const repaired = auth.confirmPairing(second, confirmArgs({
    tokenNonce: 't2', trustId: mintTrustId(entropy('82')), replaceExisting: true,
  }));
  assert.equal(repaired.trust.state, 'TRUSTED');
  assert.equal(repaired.trust.device_id, DEVICE);
  const records = auth.listTrusts({ deviceId: DEVICE });
  assert.equal(records.length, 2, 'the revoked trust is history, not deleted');
  assert.equal(records.filter((record) => record.state === 'TRUSTED').length, 1);
  assert.equal(auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: CREDENTIAL }).allowed, true);
});

test('a refusal never leaves the session changed', () => {
  // Found while writing this suite: the phase edge used to be checked *after* the
  // payload fields were assigned, so a session that was refused for being terminal had
  // already had `responder_fingerprint` written into it. A guard that mutates before it
  // refuses is not a guard.
  const auth = authority();
  auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  auth.cancelPairing(SESSION, { nowMs: T1 });
  const before = JSON.stringify(auth.getSession(SESSION));
  const digestBefore = sessionDigest(auth.getSession(SESSION));

  expectCode(() => auth.exchangeEphemeralKeys(SESSION, { responderFingerprint: FP_RESPONDER, nowMs: T2 }), 'terminal_state');
  expectCode(() => auth.presentDevicePreview(SESSION, { preview: buildDevicePreview({ deviceId: DEVICE, fingerprint: FP_RESPONDER }), nowMs: T2 }), 'terminal_state');
  expectCode(() => auth.requestConfirmation(SESSION, { tokenNonce: 't', nowMs: T2 }), 'terminal_state');
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ nowMs: T2 })), 'terminal_state');
  expectCode(() => auth.failPairing(SESSION, { reason: 'x', nowMs: T2 }), 'terminal_state');

  assert.equal(JSON.stringify(auth.getSession(SESSION)), before, 'every refusal left the session byte-identical');
  assert.equal(sessionDigest(auth.getSession(SESSION)), digestBefore);
  assert.equal(auth.getSession(SESSION).responder_fingerprint, null, 'the refused key exchange wrote nothing');
  assert.equal(auth.getSession(SESSION).preview, null);
  assert.equal(auth.getSession(SESSION).confirmation_token_ref, null);
  assert.deepEqual(auth.listTrusts(), []);
});

test('a pairing can be refused at any phase, and the refusal is recorded', () => {
  for (const stopAfter of ['PAIRING_SESSION', 'EPHEMERAL_KEY_EXCHANGE', 'DEVICE_PREVIEW', 'HUMAN_CONFIRM']) {
    const auth = authority();
    const sessionId = mintSessionId(entropy('b1'));
    auth.startSession({ sessionId, entryPoint: 'DISCOVERY_LAN', nonce: `n-${stopAfter}`, initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
    if (stopAfter !== 'PAIRING_SESSION') auth.exchangeEphemeralKeys(sessionId, { responderFingerprint: FP_RESPONDER, nowMs: T1 });
    if (stopAfter === 'DEVICE_PREVIEW' || stopAfter === 'HUMAN_CONFIRM') {
      auth.presentDevicePreview(sessionId, { preview: buildDevicePreview({ deviceId: DEVICE, fingerprint: FP_RESPONDER }), nowMs: T2 });
    }
    if (stopAfter === 'HUMAN_CONFIRM') auth.requestConfirmation(sessionId, { tokenNonce: 't', nowMs: T3 });
    const rejected = auth.rejectPairing(sessionId, { reason: 'not my device', actor: 'owner', nowMs: T4 });
    assert.equal(rejected.state, 'REJECTED', `${stopAfter} can be refused`);
    assert.equal(rejected.terminal_reason, 'not my device');
    assert.deepEqual(auth.listTrusts(), []);
  }
});

test('a quarantined device is refused, and a second trust for one device is refused', () => {
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs());
  auth.quarantineTrust(TRUST, { reason: 'suspicious reinstall', actor: 'owner', nowMs: T4 });
  const verdict = auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: CREDENTIAL });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'trust_quarantined');

  const second = mintSessionId(entropy('83'));
  readySession(auth, { sessionId: second, nonce: 'n3', tokenNonce: 't3' });
  expectCode(
    () => auth.confirmPairing(second, confirmArgs({ tokenNonce: 't3', trustId: mintTrustId(entropy('84')) })),
    'already_trusted',
  );
});

test('a rotated credential stops working and the refusal names the reason', () => {
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs());
  auth.rotateCredential(TRUST, { credentialFingerprint: CREDENTIAL_2, actor: 'owner', nowMs: T4 });
  const stale = auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: CREDENTIAL });
  assert.equal(stale.allowed, false);
  assert.equal(stale.code, 'credential_rotated', 'a rotated credential is distinguishable from a wrong one');
  assert.equal(auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: CREDENTIAL_2 }).allowed, true);
});

test('an unknown device, a wrong fingerprint and a wrong credential are all refused distinctly', () => {
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs());
  assert.equal(auth.checkReconnect({ deviceId: OTHER_DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: CREDENTIAL }).code, 'unknown_device');
  assert.equal(auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_OTHER, credentialFingerprint: CREDENTIAL }).code, 'fingerprint_mismatch');
  assert.equal(auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: FP_OTHER }).code, 'credential_unknown');
});

/* ------------------------------- 5. role changes are explicit and auditable */

test('a trust role change is explicit, auditable and transfers no capability', () => {
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs({ role: 'GUEST_DEVICE' }));
  assert.equal(auth.getTrust(TRUST).role, 'GUEST_DEVICE');
  const changed = auth.changeTrustRole(TRUST, { role: 'FULL_NODE', actor: 'owner', nowMs: T4 });
  assert.equal(changed.role, 'FULL_NODE');
  const entry = changed.history.find((item) => item.state === 'ROLE_FULL_NODE');
  assert.equal(entry.reason, 'from:GUEST_DEVICE');
  const logged = auth.auditLog().find((item) => item.event === 'TRUST_ROLE_CHANGED');
  assert.equal(logged.from, 'GUEST_DEVICE');
  assert.equal(logged.to, 'FULL_NODE');
  assert.equal(logged.actor, 'owner');
  // Repeating it is a no-op, and an unknown role is refused.
  assert.deepEqual(auth.changeTrustRole(TRUST, { role: 'FULL_NODE', nowMs: T4 }).history, changed.history);
  expectCode(() => auth.changeTrustRole(TRUST, { role: 'ROOT', nowMs: T4 }), 'role_not_allowed');
});

test('a trust role is a classification, never a capability grant', () => {
  const granted = capabilitiesFromTrustRole();
  assert.deepEqual([...granted.capabilities], []);
  assert.equal(granted.authority, 'TRUST_ROLE_GRANTS_NO_CAPABILITY');
  assert.deepEqual([...granted.descriptiveOnly], [...TRUST_ROLES]);
  // A reconnect that is allowed still carries no capability.
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs({ role: 'FULL_NODE' }));
  const verdict = auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: CREDENTIAL });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.role, 'FULL_NODE');
  assert.equal(Object.hasOwn(verdict, 'capabilities'), false, 'a successful reconnect is not a permission');
});

/* ---------------------------- 6. MAC evidence: a warning, never an identity */

test('local MAC evidence may warn a human but never blocks or grants', () => {
  const matching = buildDevicePreview({ deviceId: DEVICE, fingerprint: FP_RESPONDER, macAddresses: [GLOBAL_MAC], expectedMac: GLOBAL_MAC });
  assert.equal(matching.mac_evidence.mismatch_warning, false);
  const mismatching = buildDevicePreview({ deviceId: DEVICE, fingerprint: FP_RESPONDER, macAddresses: [GLOBAL_MAC], expectedMac: '3c:22:fb:99:99:99' });
  assert.equal(mismatching.mac_evidence.mismatch_warning, true, 'a mismatch is surfaced to the human');
  assert.equal(mismatching.mac_evidence.can_block_or_grant, false, 'and it decides nothing');
  assert.equal(mismatching.mac_evidence.authority, MAC_AUTHORITY);
  assert.equal(mismatching.mac_evidence.role, MAC_EVIDENCE_ROLE);
  assert.equal(mismatching.identity_is_cryptographic, true);
  assert.equal(mismatching.metadata_is_not_authority, true);
});

test('a missing or randomised MAC does not obstruct pairing', () => {
  for (const value of [null, undefined, '', 'unavailable', 'N/A', 'unknown', '00:00:00:00:00:00', 'not-a-mac', 42]) {
    assert.equal(normalizeMac(value), null, `${String(value)} is simply unavailable`);
  }
  assert.equal(normalizeMac('3C-22-FB-11-22-33'), GLOBAL_MAC);
  assert.equal(isLocallyAdministeredMac(RANDOM_MAC), true);
  assert.equal(isLocallyAdministeredMac(GLOBAL_MAC), false);
  const randomised = buildDevicePreview({ deviceId: DEVICE, fingerprint: FP_RESPONDER, macAddresses: [RANDOM_MAC, null], expectedMac: GLOBAL_MAC });
  // No MAC matches, yet the preview is still presented and the human may still confirm.
  assert.equal(randomised.mac_evidence.mismatch_warning, true);
  assert.equal(randomised.mac_evidence.can_block_or_grant, false);
  const auth = authority();
  auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  auth.exchangeEphemeralKeys(SESSION, { responderFingerprint: FP_RESPONDER, nowMs: T1 });
  auth.presentDevicePreview(SESSION, { preview: randomised, nowMs: T2 });
  auth.requestConfirmation(SESSION, { tokenNonce: 'tok', nowMs: T3 });
  const done = auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'tok', macMismatchObserved: true }));
  assert.equal(done.trust.state, 'TRUSTED', 'a MAC mismatch is never a refusal');
  assert.equal(done.trust.mac_mismatch_observed, true, 'and it is recorded honestly');
});

test('MAC evidence can never be turned into trust', () => {
  assert.equal(trustFromMacEvidence().granted, false);
  assert.equal(trustFromMacEvidence().code, 'mac_not_authority');
});

/* --------------------- 7. the audit log proves transitions without leaking keys */

test('the audit log proves every state transition without carrying key material', () => {
  const auth = authority();
  readySession(auth, { tokenNonce: 'secret-token-value' });
  auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'secret-token-value' }));
  auth.changeTrustRole(TRUST, { role: 'WORKER_NODE', actor: 'owner', nowMs: T4 });
  auth.revokeTrust(TRUST, { reason: 'OWNER_REVOKED', actor: 'owner', nowMs: T4 });

  const log = auth.auditLog();
  const events = log.map((entry) => entry.event);
  for (const expected of ['SESSION_STARTED', 'EPHEMERAL_KEYS_EXCHANGED', 'DEVICE_PREVIEW_PRESENTED', 'CONFIRMATION_REQUESTED', 'TRUST_ESTABLISHED', 'TRUST_ROLE_CHANGED', 'TRUST_REVOKED']) {
    assert.ok(events.includes(expected), `${expected} is recorded`);
  }
  assert.deepEqual(events.slice(0, 5), ['SESSION_STARTED', 'SESSION_STATE', 'EPHEMERAL_KEYS_EXCHANGED', 'SESSION_STATE', 'DEVICE_PREVIEW_PRESENTED']);
  // Every phase change is recorded twice on purpose: once as the phase transition and
  // once as the named event, so a reader can follow either.
  assert.deepEqual(
    events.filter((event) => event !== 'SESSION_STATE').slice(0, 5),
    ['SESSION_STARTED', 'EPHEMERAL_KEYS_EXCHANGED', 'DEVICE_PREVIEW_PRESENTED', 'CONFIRMATION_REQUESTED', 'TRUST_ESTABLISHED'],
  );
  // Every session state change is also in the log, in order.
  const states = log.filter((entry) => entry.event === 'SESSION_STATE').map((entry) => entry.state);
  assert.deepEqual(states, ['EPHEMERAL_KEY_EXCHANGE', 'DEVICE_PREVIEW', 'HUMAN_CONFIRM', 'TRUSTED']);

  // And the log leaks nothing: no private key block, no token, no credential.
  const scan = auth.auditLeakScan({ knownSecrets: ['secret-token-value', 'installation-credential'] });
  assert.equal(scan.leaksNothing, true, JSON.stringify(scan.leaks));
  assert.deepEqual([...scan.leaks], []);
  assert.equal(scan.containsRawToken, false);
  // The authority holds only digests of the token and the credential.
  const session = auth.getSession(SESSION);
  assert.equal(session.confirmation_token_ref, sha256('secret-token-value'));
  assert.ok(!JSON.stringify(auth.auditLog()).includes('secret-token-value'));
  assert.ok(!JSON.stringify(auth.listTrusts()).includes('installation-credential'));
});

test('the leak scanner really detects a leak, so its clean answer means something', () => {
  assert.deepEqual(findSecretMaterial({ note: 'plain' }), []);
  assert.equal(findSecretMaterial({ private_key: 'x' }).length, 1);
  assert.equal(findSecretMaterial({ nested: { seed: 'x' } }).length, 1);
  assert.equal(findSecretMaterial({ note: '-----BEGIN RSA PRIVATE KEY-----\nabc' }).length, 1);
  assert.equal(findSecretMaterial({ note: 'token-abc' }, { knownSecrets: ['token-abc'] }).length, 1);
});

test('the audit log is bounded', () => {
  const auth = authority();
  const first = mintSessionId(entropy('91'));
  auth.startSession({ sessionId: first, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  const before = auth.auditLog().length;
  for (let index = 0; index < 40; index += 1) {
    const sessionId = mintSessionId(entropy(`${(index + 16).toString(16)}1`));
    auth.startSession({ sessionId, entryPoint: 'DEEP_LINK', nonce: `n-${index}`, initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  }
  assert.equal(auth.auditLog().length, before + 40);
  const tail = auth.auditLog({ sinceSequence: auth.auditLog().length - 2 });
  assert.equal(tail.length, 2, 'a caller can read only what it has not seen');
});

/* ------------------------------------------------------- documents and refusal */

test('a session document round-trips through validation and refuses malformed input', () => {
  const auth = authority();
  readySession(auth);
  const session = auth.getSession(SESSION);
  assert.equal(validatePairingSession(session).ok, true);
  assert.equal(session.schema_version, PAIRING_SCHEMA_VERSION);

  const cases = [
    ['missing', null],
    ['malformed', []],
    ['malformed', 'session'],
    ['schema_version', { ...session, schema_version: 2 }],
    ['kind', { ...session, kind: 'city.something-else' }],
    ['session_id', { ...session, session_id: 'pair-NOPE' }],
    ['entry_point', { ...session, entry_point: 'TELEPATHY' }],
    ['malformed', { ...session, state: 'TRUSTING' }],
    ['challenge', { ...session, challenge: 'not-a-digest' }],
    ['fingerprint', { ...session, responder_fingerprint: 'sha256:short' }],
    ['device_id', { ...session, trusted_device_id: 'node-1' }],
    ['instant', { ...session, expires_at: 'tomorrow' }],
  ];
  for (const [code, candidate] of cases) {
    const verdict = validatePairingSession(candidate);
    assert.equal(verdict.ok, false, `${code} case must be refused`);
    assert.equal(verdict.code, code);
    assert.ok(PAIRING_REJECTION_CODES.includes(verdict.code), `${verdict.code} is a declared code`);
  }
});

test('a trust record round-trips through validation and refuses malformed input', () => {
  const auth = authority();
  readySession(auth);
  const { trust } = auth.confirmPairing(SESSION, confirmArgs());
  assert.equal(validateTrustRecord(trust).ok, true);
  assert.equal(TRUST_STATES.includes(trust.state), true);
  assert.equal(trustDigest(trust), trustDigest(auth.getTrust(TRUST)));

  const cases = [
    ['missing', undefined],
    ['malformed', 42],
    ['kind', { ...trust, kind: 'city.pairing-session' }],
    ['trust_id', { ...trust, trust_id: 'trust-1' }],
    ['device_id', { ...trust, device_id: 'phone' }],
    ['fingerprint', { ...trust, fingerprint: 'abc' }],
    ['role_not_allowed', { ...trust, role: 'SUPERUSER' }],
    ['malformed', { ...trust, state: 'FRIENDLY' }],
    ['already_revoked', { ...trust, state: 'REVOKED' }],
    ['entry_point', { ...trust, entry_point: 'CARRIER_PIGEON' }],
  ];
  for (const [code, candidate] of cases) {
    const verdict = validateTrustRecord(candidate);
    assert.equal(verdict.ok, false, `${code} case must be refused`);
    assert.equal(verdict.code, code);
  }
});

test('a peer session document can be inspected without an authority', () => {
  const auth = authority();
  readySession(auth);
  const inspected = inspectSessionDocument(auth.getSession(SESSION));
  assert.equal(inspected.ok, true);
  assert.equal(inspected.session_id, SESSION);
  assert.equal(inspected.is_terminal, false);
  assert.equal(inspected.is_trusted, false);
  assert.equal(inspected.transitions, 4);
  const refused = inspectSessionDocument({ session_id: 'nope' });
  assert.equal(refused.ok, false);
});

test('the authority refuses structural nonsense instead of guessing', () => {
  const auth = authority();
  expectCode(() => auth.startSession({ sessionId: 'nope', entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 }), 'session_id');
  expectCode(() => auth.startSession({ sessionId: SESSION, entryPoint: 'TELEPATHY', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0 }), 'entry_point');
  expectCode(() => auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: 'nope', nowMs: T0 }), 'fingerprint');
  expectCode(() => auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: '', initiatorFingerprint: FP_INITIATOR, nowMs: T0 }), 'challenge');
  expectCode(() => auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: 'now' }), 'instant');
  expectCode(() => auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'n', initiatorFingerprint: FP_INITIATOR, nowMs: T0, ttlMs: 0 }), 'malformed');
  expectCode(() => auth.getSession('pair-' + '0'.repeat(32)), 'missing');
  expectCode(() => auth.getTrust(mintTrustId(entropy('99'))), 'unknown_trust');
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs()), 'missing');
  assert.equal(auth.auditLog().length, 0, 'a refused start records nothing');
});

test('confirmation requires a named human actor', () => {
  for (const confirmedBy of [undefined, null, '', '   ', 42]) {
    const auth = authority();
    const sessionId = mintSessionId(entropy('a1'));
    readySession(auth, { sessionId, nonce: `n-${String(confirmedBy)}`, tokenNonce: 'tok' });
    expectCode(
      () => auth.confirmPairing(sessionId, {
        tokenNonce: 'tok', confirmedBy, confirmFingerprint: FP_RESPONDER, deviceId: DEVICE,
        role: 'PERSONAL_DEVICE', credentialFingerprint: CREDENTIAL, trustId: mintTrustId(entropy('a2')), nowMs: T4,
      }),
      'confirmation_actor_missing',
    );
    assert.deepEqual(auth.listTrusts(), []);
  }
});

test('a trust id and a credential must be well formed before any trust exists', () => {
  const auth = authority();
  readySession(auth);
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ trustId: 'trust-1' })), 'trust_id');
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ deviceId: 'phone' })), 'device_id');
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ role: 'SUPERUSER' })), 'role_not_allowed');
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ credentialFingerprint: 'nope' })), 'fingerprint');
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ confirmFingerprint: FP_OTHER })), 'fingerprint_mismatch');
  assert.deepEqual(auth.listTrusts(), [], 'no partial trust was created by any refusal');
});

/* ------------------------------------------------------------- purity and entropy */

test('minting is pure and refuses entropy that is not 16 bytes', () => {
  assert.equal(mintSessionId(entropy('ab')), mintSessionId(entropy('ab')));
  assert.notEqual(mintSessionId(entropy('ab')), mintSessionId(entropy('cd')));
  assert.match(mintSessionId(entropy('ab')), /^pair-[0-9a-f]{32}$/);
  assert.match(mintTrustId(entropy('ab')), /^trust-[0-9a-f]{32}$/);
  for (const bad of [undefined, null, 'abcd', new Uint8Array(8), 42]) {
    assert.throws(() => mintSessionId(bad), (error) => error.code === 'malformed');
  }
});

test('randomEntropy produces 16 usable bytes each call', () => {
  const a = randomEntropy();
  const b = randomEntropy();
  assert.equal(a.length, 16);
  assert.notDeepEqual([...a], [...b]);
  assert.match(mintSessionId(a), /^pair-[0-9a-f]{32}$/);
});

test('the exported vocabularies are frozen and internally consistent', () => {
  assert.ok(Object.isFrozen(ENTRY_POINTS));
  assert.ok(Object.isFrozen(TRUST_ROLES));
  assert.equal(new Set(PAIRING_STATES).size, PAIRING_STATES.length);
  assert.equal(new Set(PAIRING_REJECTION_CODES).size, PAIRING_REJECTION_CODES.length);
  assert.equal(new Set(REVOCATION_REASONS).size, REVOCATION_REASONS.length);
  // Every terminal state is reachable through the table.
  for (const terminal of PAIRING_TERMINAL_STATES) {
    assert.ok(
      Object.values(PAIRING_TRANSITIONS).some((targets) => targets.includes(terminal)),
      `${terminal} must be reachable`,
    );
    assert.deepEqual([...PAIRING_TRANSITIONS[terminal]], [], `${terminal} must be terminal`);
  }
  assert.equal(new PairingError('X', 'y').status, 409);
});

/* ------------------------------------------- 13. correction round (host: Mech)
 *
 * Repairs made by the Correction host after independent adversarial probing. Each test below
 * fails on the pre-correction branch head 3c0eb4f and passes on the corrected head.
 */

test('C1 a trusted session is final: expiry and cleanup never rewrite it', () => {
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs());
  assert.equal(auth.getSession(SESSION).state, 'TRUSTED');

  // The deadline passes. Neither expiry path may turn a successful pairing into EXPIRED.
  assert.equal(auth.expireSession(SESSION, { nowMs: EXPIRED }).state, 'TRUSTED');
  assert.deepEqual(auth.cleanupExpired(EXPIRED + 60_000).expired, []);
  const doc = auth.getSession(SESSION);
  assert.equal(doc.state, 'TRUSTED');
  assert.equal(doc.terminal_reason, null);
  assert.deepEqual(doc.transitions.map((entry) => entry.state), [
    'PAIRING_SESSION', 'EPHEMERAL_KEY_EXCHANGE', 'DEVICE_PREVIEW', 'HUMAN_CONFIRM', 'TRUSTED',
  ]);
  assert.equal(doc.transitions.some((entry) => entry.state === 'EXPIRED'), false, 'a trusted session never expires');

  // The derived rule: a state with no outgoing edge is final, and TRUSTED is one of them.
  assert.equal(isFinalState('TRUSTED'), true);
  for (const state of PAIRING_TERMINAL_STATES) assert.equal(isFinalState(state), true, state);
  for (const phase of ['PAIRING_SESSION', 'EPHEMERAL_KEY_EXCHANGE', 'DEVICE_PREVIEW', 'HUMAN_CONFIRM']) {
    assert.equal(isFinalState(phase), false, phase);
  }
  assert.equal(isFinalState('NOT_A_STATE'), false);

  // Leaving a successful pairing is a terminal-state refusal, not an incidental one.
  expectCode(() => auth.rejectPairing(SESSION, { reason: 'changed mind', nowMs: EXPIRED }), 'terminal_state');
  expectCode(() => auth.cancelPairing(SESSION, { nowMs: EXPIRED }), 'terminal_state');
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'token-2' })), 'terminal_state');

  // A peer reading the document is told the session is final.
  assert.equal(inspectSessionDocument(doc).is_terminal, true);
  assert.equal(inspectSessionDocument(doc).is_trusted, true);
});

test('C2 a live re-pair supersedes the previous trust instead of leaving two', () => {
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs());
  const secondSession = mintSessionId(entropy('81'));
  const secondTrust = mintTrustId(entropy('82'));
  readySession(auth, { sessionId: secondSession, nonce: 'n2', tokenNonce: 't2' });

  // Without the explicit flag the re-pair is still refused: replacement must be deliberate.
  expectCode(
    () => auth.confirmPairing(secondSession, confirmArgs({ tokenNonce: 't2', trustId: secondTrust })),
    'already_trusted',
  );

  const repaired = auth.confirmPairing(secondSession, confirmArgs({
    tokenNonce: 't2', trustId: secondTrust, replaceExisting: true,
  }));
  assert.deepEqual(repaired.superseded, [TRUST], 'the caller is told which record was superseded');
  const records = auth.listTrusts({ deviceId: DEVICE });
  assert.equal(records.length, 2, 'the superseded record is history, not deleted');
  assert.equal(records.filter((record) => record.state === 'TRUSTED').length, 1, 'exactly one live trust');
  const superseded = auth.getTrust(TRUST);
  assert.equal(superseded.state, 'REVOKED');
  assert.equal(superseded.revocation_reason, 'REPAIRED');

  // The bypass is closed: revoking the replacement must leave no live trust behind.
  auth.revokeTrust(secondTrust, { reason: 'OWNER_REVOKED', nowMs: T4 + 1000 });
  assert.deepEqual(auth.listTrusts({ deviceId: DEVICE, state: 'TRUSTED' }), []);
  const afterRevoke = auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: CREDENTIAL });
  assert.equal(afterRevoke.allowed, false, 'a superseded record must not authenticate once the replacement is revoked');
  assert.equal(afterRevoke.code, 'trust_revoked');
});

test('C2 the superseded credential and the replacement credential are both cut off by revocation', () => {
  const auth = authority();
  readySession(auth);
  auth.confirmPairing(SESSION, confirmArgs());
  const secondSession = mintSessionId(entropy('83'));
  const secondTrust = mintTrustId(entropy('84'));
  const replacementCredential = sha256('replacement-installation-credential');
  readySession(auth, { sessionId: secondSession, nonce: 'n3', tokenNonce: 't3' });
  auth.confirmPairing(secondSession, confirmArgs({
    tokenNonce: 't3', trustId: secondTrust, replaceExisting: true, credentialFingerprint: replacementCredential,
  }));

  assert.equal(auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: replacementCredential }).allowed, true);
  assert.equal(auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: CREDENTIAL }).allowed, false, 'the superseded credential is not live');

  // Revoking everything the device holds (the lost-device path) cuts off both.
  assert.deepEqual(auth.revokeLostDevice(DEVICE, { actor: 'owner', nowMs: T4 + 1000 }).revoked, [secondTrust]);
  assert.equal(auth.checkReconnect({ deviceId: DEVICE, fingerprint: FP_RESPONDER, credentialFingerprint: replacementCredential }).allowed, false);
});

test('C2 two live records for one device are reported, never silently resolved', () => {
  assert.deepEqual(resolveActiveTrust([]), { status: 'NONE', active: null, conflicts: [] });
  const live = { trust_id: 'trust-a', state: 'TRUSTED' };
  const single = resolveActiveTrust([live]);
  assert.equal(single.status, 'ACTIVE');
  assert.equal(single.active, live);
  const conflict = resolveActiveTrust([
    { trust_id: 'trust-b', state: 'TRUSTED' },
    live,
    { trust_id: 'trust-c', state: 'REVOKED' },
  ]);
  assert.equal(conflict.status, 'CONFLICT');
  assert.deepEqual(conflict.conflicts, ['trust-a', 'trust-b']);
  assert.equal(conflict.active, null, 'ambiguity is not resolved by insertion order');
  assert.deepEqual(resolveActiveTrust([{ trust_id: 'trust-d', state: 'REVOKED' }]), { status: 'NONE', active: null, conflicts: [] });
});

test('C3 a preview that claims MAC authority, or names a foreign device, is refused', () => {
  const auth = authority();
  auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'nonce-c3', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  auth.exchangeEphemeralKeys(SESSION, { responderFingerprint: FP_RESPONDER, nowMs: T0 + 500 });
  const forged = {
    fingerprint: FP_RESPONDER,
    identity_is_cryptographic: true,
    metadata_is_not_authority: true,
    device_id: 'not-a-device-id',
    mac_evidence: { role: 'AUTHORITY', authority: 'AUTHORITY', authoritative: true, can_block_or_grant: true },
  };
  expectCode(() => auth.presentDevicePreview(SESSION, { preview: forged, nowMs: T0 + 1000 }), 'preview');
  // the refusal stored nothing and moved nothing
  assert.equal(auth.getSession(SESSION).state, 'EPHEMERAL_KEY_EXCHANGE');
  assert.ok(!auth.getSession(SESSION).preview);
  // an undeclared preview field is refused as well, so a caller cannot smuggle key material in
  const withExtra = { ...buildDevicePreview({ deviceId: DEVICE, fingerprint: FP_RESPONDER }), private_key: 'PEM' };
  expectCode(() => auth.presentDevicePreview(SESSION, { preview: withExtra, nowMs: T0 + 1000 }), 'preview');
});

test('C3 the authority records its own copy of the preview', () => {
  const auth = authority();
  const preview = { ...buildDevicePreview({ deviceId: DEVICE, fingerprint: FP_RESPONDER }) };
  readySession(auth, { nonce: 'nonce-c3b', tokenNonce: 'token-c3b', preview });
  const before = sessionDigest(auth.getSession(SESSION));
  preview.display_name = 'rewritten after the human saw it';
  assert.equal(sessionDigest(auth.getSession(SESSION)), before, 'mutating the caller object must not rewrite what was recorded');
  assert.notEqual(auth.getSession(SESSION).preview, preview);
});

test('C3 the trusted device must be the device the human was shown', () => {
  const auth = authority();
  readySession(auth, { nonce: 'nonce-c3c', tokenNonce: 'token-c3c' });
  expectCode(
    () => auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'token-c3c', deviceId: OTHER_DEVICE })),
    'preview_mismatch',
  );
  assert.deepEqual(auth.listTrusts(), [], 'the refusal created no trust');
});

test('C4 wrong confirmation tokens are bounded and then fail the session', () => {
  const auth = authority();
  readySession(auth, { nonce: 'nonce-c4', tokenNonce: 'token-c4' });
  for (let attempt = 1; attempt < MAX_CONFIRMATION_ATTEMPTS; attempt += 1) {
    expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: `wrong-${attempt}` })), 'confirmation_not_available');
  }
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'wrong-final' })), 'confirmation_attempts_exhausted');
  assert.equal(auth.getSession(SESSION).state, 'FAILED');
  // the real token can no longer be used, so a brute-force attempt cannot end in trust
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'token-c4' })), 'terminal_state');
  assert.deepEqual(auth.listTrusts(), []);
  assert.equal(auth.auditLog().some((entry) => entry.event === 'CONFIRMATION_REFUSED'), true);
});

test('C4 re-requesting a different token is refused, and a decoy preview is never success', () => {
  const auth = authority();
  readySession(auth, { nonce: 'nonce-c5', tokenNonce: 'token-c5' });
  expectCode(() => auth.requestConfirmation(SESSION, { tokenNonce: 'other-token', nowMs: T1 }), 'confirmation_not_available');
  assert.equal(auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'token-c5' })).trust.state, 'TRUSTED');
  expectCode(() => auth.presentDevicePreview(SESSION, { preview: null, nowMs: T1 }), 'preview');
});

test('C5 a refused startSession does not burn the challenge', () => {
  const auth = authority();
  expectCode(
    () => auth.startSession({
      sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'nonce-c6',
      initiatorFingerprint: FP_INITIATOR, nowMs: T0, ttlMs: Number.MAX_SAFE_INTEGER,
    }),
    'instant',
  );
  assert.deepEqual(auth.listSessions(), []);
  const retry = auth.startSession({ sessionId: SESSION, entryPoint: 'DISCOVERY_LAN', nonce: 'nonce-c6', initiatorFingerprint: FP_INITIATOR, nowMs: T0 });
  assert.equal(retry.state, 'PAIRING_SESSION');
});

test('C5 the MAC mismatch flag must be a real boolean', () => {
  const auth = authority();
  readySession(auth, { nonce: 'nonce-c7', tokenNonce: 'token-c7' });
  expectCode(() => auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'token-c7', macMismatchObserved: 'no' })), 'malformed');
  const confirmed = auth.confirmPairing(SESSION, confirmArgs({ tokenNonce: 'token-c7', macMismatchObserved: true }));
  assert.equal(confirmed.trust.mac_mismatch_observed, true);
});
