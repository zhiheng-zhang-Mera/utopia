/**
 * UTOPIA · City Foundation — city-node-network — unified pairing and trust lifecycle.
 *
 * Implements the RF-002 state machine every join mechanism converges on:
 *
 *   PAIRING_SESSION -> EPHEMERAL_KEY_EXCHANGE -> DEVICE_PREVIEW -> HUMAN_CONFIRM -> TRUSTED
 *
 * Design rules this file holds to, because they are what make the acceptance claims
 * testable rather than merely asserted:
 *
 *   - **No ambient state.** No `Date.now()`, no `Math.random()`, no `process.env`, no
 *     filesystem, no sockets. Instants are `nowMs` parameters and entropy is an explicit
 *     byte array, so a test can pin what production would randomise.
 *   - **Secrets are referenced, never stored.** The authority stores the digest of a
 *     confirmation token and of a credential, never the values, so the audit log can be
 *     published without redaction.
 *   - **Discovery is not trust.** `startSession` accepts any entry point and refuses
 *     nothing about reachability; the only path to `TRUSTED` runs through an explicit
 *     human confirmation bound to the exchanged fingerprint.
 *   - **A terminal state is terminal.** No transition leaves `TRUSTED`, `REJECTED`,
 *     `EXPIRED`, `CANCELLED` or `FAILED`, so a pairing attempt is single-use.
 */

import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SESSION_TTL_MS,
  DEVICE_ID_PATTERN,
  ENTRY_POINTS,
  FINGERPRINT_PATTERN,
  MAC_AUTHORITY,
  MAC_EVIDENCE_ROLE,
  MAX_CONFIRMATION_ATTEMPTS,
  PREVIEW_FIELDS,
  PAIRING_SCHEMA_VERSION,
  PAIRING_SESSION_KIND,
  PAIRING_TERMINAL_STATES,
  PAIRING_TRANSITIONS,
  PairingError,
  PairingValidationError,
  REVOCATION_REASONS,
  SESSION_ID_PATTERN,
  TRUST_RECORD_KIND,
  TRUST_ROLES,
  TRUST_ID_PATTERN,
  assertPairingSession,
  assertTrustRecord,
  buildDevicePreview,
  canonicalJson,
  findSecretMaterial,
  instantOf,
  isFinalState,
  resolveActiveTrust,
  sessionDocument,
  sha256,
  trustDocument,
} from './contracts.mjs';

/** Bounded audit history, so a long-lived authority cannot grow without limit. */
export const MAX_AUDIT_ENTRIES = 2048;

/** Real 16-byte entropy, isolated so the rest of this module stays pure. */
export function randomEntropy() {
  return new Uint8Array(randomBytes(16));
}

function hex16(entropy) {
  let bytes = null;
  if (entropy instanceof Uint8Array) bytes = Buffer.from(entropy);
  else if (typeof entropy === 'string' && /^[0-9a-fA-F]{32}$/.test(entropy)) bytes = Buffer.from(entropy, 'hex');
  if (bytes === null || bytes.length !== 16) {
    throw new PairingValidationError('malformed', 'entropy must be 16 bytes (Uint8Array or 32 hex characters)');
  }
  return bytes.toString('hex').toLowerCase();
}

/** Mint a pairing session identity: `pair-<32 hex>`. */
export function mintSessionId(entropy) {
  return `pair-${hex16(entropy)}`;
}

/** Mint a trust record identity: `trust-<32 hex>`. */
export function mintTrustId(entropy) {
  return `trust-${hex16(entropy)}`;
}

/**
 * The session challenge: a digest of the session nonce.
 *
 * The nonce itself never leaves the caller, which is why a challenge can be compared and
 * logged while a nonce cannot. Two sessions started from the same nonce produce the same
 * challenge, which is exactly how a replayed bootstrap attempt is detected.
 */
export function challengeFromNonce(nonce) {
  if (typeof nonce !== 'string' || nonce === '') {
    throw new PairingValidationError('challenge', 'a session nonce must be a non-empty string');
  }
  return sha256(nonce);
}

/**
 * Create the pairing/trust authority.
 *
 * It owns sessions, trust records, the consumed-confirmation set, the seen-challenge set
 * and the audit log. Everything is copy-on-read and documents are frozen, so a caller
 * cannot mutate authority state by holding a reference.
 */
/** Copy a preview so the authority owns its own frozen bytes, not the caller's object. */
function freezePreview(preview) {
  const deepFreeze = (value) => {
    if (value === null || typeof value !== 'object') return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  };
  return deepFreeze(structuredClone(preview));
}

export function createPairingAuthority({ defaultTtlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  if (!Number.isSafeInteger(defaultTtlMs) || defaultTtlMs <= 0) {
    throw new PairingValidationError('malformed', 'defaultTtlMs must be a positive integer');
  }
  const sessions = new Map();
  const trusts = new Map();
  const seenChallenges = new Map();
  const consumedConfirmations = new Map();
  const confirmationAttempts = new Map();
  let auditSequence = 0;
  const audit = [];

  const record = (entry) => {
    auditSequence += 1;
    audit.push(Object.freeze({ sequence: auditSequence, ...entry }));
    if (audit.length > MAX_AUDIT_ENTRIES) audit.splice(0, audit.length - MAX_AUDIT_ENTRIES);
    return auditSequence;
  };

  const requireSession = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) throw new PairingError('missing', `no pairing session ${String(sessionId)}`);
    return session;
  };
  const requireTrust = (trustId) => {
    const trust = trusts.get(trustId);
    if (!trust) throw new PairingError('unknown_trust', String(trustId));
    return trust;
  };

  /**
   * Expiry is evaluated lazily on every touch, so a session cannot be used after its
   * deadline even if no ticker ever ran. An expired session is *marked* expired here, so
   * the transition is auditable rather than implied by a timestamp.
   */
  const expireIfDue = (session, nowMs) => {
    // A final state is never rewritten: expiry must not turn a trusted (or already finished)
    // session into EXPIRED, which would misreport how trust was established.
    if (isFinalState(session.state)) return session;
    if (!Number.isFinite(nowMs) || nowMs < Date.parse(session.expires_at)) return session;
    session.state = 'EXPIRED';
    session.terminal_reason = 'session_ttl_elapsed';
    session.transitions.push({ state: 'EXPIRED', at: session.expires_at, reason: 'session_ttl_elapsed' });
    record({ event: 'SESSION_EXPIRED', session_id: session.session_id, at: session.expires_at });
    return session;
  };

  /**
   * Legality of one transition, checked *before* anything is written.
   *
   * Every operation below validates the edge first and its content second. Two reasons:
   * the actionable diagnosis for a caller that skipped a phase is "illegal transition",
   * not an incidental complaint about the payload; and a refusal must leave the session
   * byte-identical, which is impossible if a field is assigned before the edge is known
   * to be legal.
   */
  const assertTransition = (session, nextState) => {
    if (isFinalState(session.state)) {
      throw new PairingError('terminal_state', `session ${session.session_id} is ${session.state} and cannot move to ${nextState}`);
    }
    if (!PAIRING_TRANSITIONS[session.state].includes(nextState)) {
      throw new PairingError('illegal_transition', `${session.state} -> ${nextState} is not a pairing transition`);
    }
  };

  /** The one transition gate. Every phase change goes through it. */
  const transition = (session, nextState, { at, reason = null, actor = null } = {}) => {
    assertTransition(session, nextState);
    session.state = nextState;
    if (PAIRING_TERMINAL_STATES.includes(nextState)) session.terminal_reason = reason;
    session.transitions.push({ state: nextState, at, reason });
    record({ event: 'SESSION_STATE', session_id: session.session_id, state: nextState, at, reason, actor });
    return session;
  };

  const authority = {
    // ---- pairing session ---------------------------------------------------
    /**
     * Start a session from ANY join entry point. Nothing about the entry point is
     * trusted: it is recorded so an operator can audit how two sides met.
     */
    startSession({
      sessionId,
      entryPoint,
      nonce,
      initiatorFingerprint,
      nowMs,
      ttlMs = defaultTtlMs,
    }) {
      if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
        throw new PairingValidationError('session_id', `sessionId ${JSON.stringify(sessionId)} is not a pair-<32 hex> identity`);
      }
      if (sessions.has(sessionId)) throw new PairingError('malformed', `session ${sessionId} already exists`);
      if (!ENTRY_POINTS.includes(entryPoint)) {
        throw new PairingValidationError('entry_point', `entryPoint ${JSON.stringify(entryPoint)} is not a join entry point`);
      }
      if (typeof initiatorFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(initiatorFingerprint)) {
        throw new PairingValidationError('fingerprint', 'the initiator must present its sha256:<hex> fingerprint');
      }
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new PairingValidationError('malformed', 'ttlMs must be a positive integer');
      const createdAt = instantOf(nowMs);
      // Every refusal must be a no-op, so the deadline is computed (and can throw) *before* the
      // challenge is recorded as used. Burning a nonce for a call that then fails would let a
      // malformed request deny a legitimate retry.
      const expiresAt = instantOf(nowMs + ttlMs);
      const challenge = challengeFromNonce(nonce);

      // Replay protection at the bootstrap step: a nonce that has already been used to
      // open a session is refused, so an observed invite or handshake cannot be reused.
      const priorChallenge = seenChallenges.get(challenge);
      if (priorChallenge !== undefined) {
        record({ event: 'CHALLENGE_REPLAY_REFUSED', entry_point: entryPoint, at: createdAt, prior_session_id: priorChallenge });
        throw new PairingError('challenge_replayed', `challenge ${challenge} was already used by session ${priorChallenge}`);
      }
      seenChallenges.set(challenge, sessionId);

      const session = {
        schema_version: PAIRING_SCHEMA_VERSION,
        kind: PAIRING_SESSION_KIND,
        session_id: sessionId,
        entry_point: entryPoint,
        state: 'PAIRING_SESSION',
        created_at: createdAt,
        expires_at: expiresAt,
        challenge,
        confirmation_token_ref: null,
        initiator_fingerprint: initiatorFingerprint,
        responder_fingerprint: null,
        preview: null,
        trusted_device_id: null,
        trust_id: null,
        confirmed_by: null,
        confirmed_at: null,
        terminal_reason: null,
        transitions: [{ state: 'PAIRING_SESSION', at: createdAt, reason: null }],
      };
      sessions.set(sessionId, session);
      record({ event: 'SESSION_STARTED', session_id: sessionId, entry_point: entryPoint, at: createdAt });
      return sessionDocument(session);
    },

    /** Exchange ephemeral key material: both sides' fingerprints are now bound. */
    exchangeEphemeralKeys(sessionId, { responderFingerprint, nowMs }) {
      const session = expireIfDue(requireSession(sessionId), nowMs);
      if (session.state === 'EPHEMERAL_KEY_EXCHANGE' || session.state === 'DEVICE_PREVIEW' || session.state === 'HUMAN_CONFIRM' || session.state === 'TRUSTED') {
        if (session.responder_fingerprint === responderFingerprint) return sessionDocument(session);
        throw new PairingError('already_trusted', 'the responder fingerprint is already bound to this session');
      }
      assertTransition(session, 'EPHEMERAL_KEY_EXCHANGE');
      if (typeof responderFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(responderFingerprint)) {
        throw new PairingValidationError('fingerprint', 'the responder must present its sha256:<hex> fingerprint');
      }
      if (responderFingerprint === session.initiator_fingerprint) {
        throw new PairingError('fingerprint_mismatch', 'both sides reported the same fingerprint; a pairing needs two distinct peers');
      }
      session.responder_fingerprint = responderFingerprint;
      transition(session, 'EPHEMERAL_KEY_EXCHANGE', { at: instantOf(nowMs) });
      record({ event: 'EPHEMERAL_KEYS_EXCHANGED', session_id: sessionId, fingerprint: responderFingerprint, at: instantOf(nowMs) });
      return sessionDocument(session);
    },

    /** Present the human-readable preview. A human always sees what it is about to trust. */
    presentDevicePreview(sessionId, { preview, nowMs }) {
      const session = expireIfDue(requireSession(sessionId), nowMs);
      if (session.state === 'DEVICE_PREVIEW' || session.state === 'HUMAN_CONFIRM' || session.state === 'TRUSTED') {
        // Re-presenting is idempotent only for a real preview of the same peer; a decoy or
        // absent preview must not be reported as success.
        if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) {
          throw new PairingValidationError('preview', 'a preview must be built with buildDevicePreview');
        }
        if (preview.fingerprint !== session.responder_fingerprint) {
          throw new PairingError('fingerprint_mismatch', 'the preview must carry the fingerprint bound by the key exchange');
        }
        return sessionDocument(session);
      }
      // Legality before content: a caller that has not exchanged keys yet is told it
      // skipped a phase, rather than being told its preview fingerprint is wrong.
      assertTransition(session, 'DEVICE_PREVIEW');
      if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) {
        throw new PairingValidationError('preview', 'a preview must be built with buildDevicePreview');
      }
      if (preview.fingerprint !== session.responder_fingerprint) {
        throw new PairingError('fingerprint_mismatch', 'the preview must carry the fingerprint bound by the key exchange');
      }
      // The preview is the human's evidence, so it is checked against the declared field list and
      // the MAC rule rather than trusted for having two booleans set: a preview that claims MAC
      // authority must be refused, not stored. It is then copied and frozen, so the caller cannot
      // rewrite what the authority recorded by mutating the object it passed in.
      const previewErrors = [];
      for (const key of Object.keys(preview)) if (!PREVIEW_FIELDS.includes(key)) previewErrors.push(`preview.${key} is not a declared preview field`);
      if (preview.identity_is_cryptographic !== true || preview.metadata_is_not_authority !== true) {
        previewErrors.push('the preview must state that identity is cryptographic and metadata is not authority');
      }
      if (preview.device_id !== null && preview.device_id !== undefined
        && (typeof preview.device_id !== 'string' || !DEVICE_ID_PATTERN.test(preview.device_id))) {
        previewErrors.push('preview.device_id must be a dev-<32 hex> identity or null');
      }
      const mac = preview.mac_evidence;
      if (mac !== null && mac !== undefined) {
        const macOk = typeof mac === 'object' && !Array.isArray(mac)
          && mac.role === MAC_EVIDENCE_ROLE && mac.authority === MAC_AUTHORITY
          && mac.authoritative === false && mac.can_block_or_grant === false;
        if (!macOk) previewErrors.push('preview.mac_evidence must stay optional human evidence: role/authority are fixed and authoritative/can_block_or_grant must be false');
      }
      if (previewErrors.length) throw new PairingValidationError('preview', previewErrors.slice(0, 3).join('; '));
      session.preview = freezePreview(preview);
      transition(session, 'DEVICE_PREVIEW', { at: instantOf(nowMs) });
      record({
        event: 'DEVICE_PREVIEW_PRESENTED',
        session_id: sessionId,
        at: instantOf(nowMs),
        mac_mismatch_warning: Boolean(preview.mac_evidence?.mismatch_warning),
      });
      return sessionDocument(session);
    },

    /**
     * Ask a human to decide. Mints the one-time confirmation reference from a caller
     * nonce; only its digest is kept, so the log stays publishable. The raw token is
     * returned to the caller and never stored.
     */
    requestConfirmation(sessionId, { tokenNonce, nowMs }) {
      const session = expireIfDue(requireSession(sessionId), nowMs);
      if (session.state === 'HUMAN_CONFIRM' || session.state === 'TRUSTED') {
        // Idempotent only for the token this session already requested. Reporting success for a
        // different token would tell the caller a token is authoritative when it is not.
        if (session.state === 'HUMAN_CONFIRM' && tokenNonce !== undefined && sha256(String(tokenNonce)) !== session.confirmation_token_ref) {
          throw new PairingError('confirmation_not_available', 'a different confirmation token cannot replace the one this session already requested');
        }
        return sessionDocument(session);
      }
      assertTransition(session, 'HUMAN_CONFIRM');
      if (typeof tokenNonce !== 'string' || tokenNonce === '') {
        throw new PairingValidationError('malformed', 'a confirmation token nonce is required');
      }
      session.confirmation_token_ref = sha256(tokenNonce);
      transition(session, 'HUMAN_CONFIRM', { at: instantOf(nowMs) });
      record({ event: 'CONFIRMATION_REQUESTED', session_id: sessionId, at: instantOf(nowMs) });
      return sessionDocument(session);
    },

    /**
     * The only path to `TRUSTED`.
     *
     * The human/Owner decision is explicit (`confirmedBy`), bound to the fingerprint the
     * key exchange established, single-use (`confirmationReplayed`), and it establishes a
     * trust *classification* — never a capability.
     */
    confirmPairing(sessionId, {
      tokenNonce,
      confirmedBy,
      confirmFingerprint,
      deviceId,
      role,
      credentialFingerprint,
      macMismatchObserved = false,
      replaceExisting = false,
      trustId,
      nowMs,
    }) {
      const session = expireIfDue(requireSession(sessionId), nowMs);
      if (session.state === 'TRUSTED') throw new PairingError('terminal_state', `session ${sessionId} is already trusted`);
      if (PAIRING_TERMINAL_STATES.includes(session.state)) {
        throw new PairingError('terminal_state', `session ${sessionId} is ${session.state}`);
      }
      if (session.state !== 'HUMAN_CONFIRM') {
        throw new PairingError('confirmation_not_available', `session ${sessionId} is ${session.state}; a human preview and confirmation request must happen first`);
      }
      if (typeof tokenNonce !== 'string' || tokenNonce === '') {
        throw new PairingValidationError('malformed', 'the confirmation token is required');
      }
      const tokenRef = sha256(tokenNonce);
      const consumedBy = consumedConfirmations.get(tokenRef);
      if (consumedBy !== undefined) {
        record({ event: 'CONFIRMATION_REPLAY_REFUSED', session_id: sessionId, at: instantOf(nowMs), consumed_by: consumedBy });
        throw new PairingError('confirmation_replayed', `confirmation token was already consumed by session ${consumedBy}`);
      }
      if (tokenRef !== session.confirmation_token_ref) {
        // A wrong token is counted. Without a budget a short caller-chosen token is an oracle:
        // every guess is free and the session stays open until one lands.
        const attempts = (confirmationAttempts.get(sessionId) ?? 0) + 1;
        confirmationAttempts.set(sessionId, attempts);
        record({ event: 'CONFIRMATION_REFUSED', session_id: sessionId, at: instantOf(nowMs), attempts });
        if (attempts >= MAX_CONFIRMATION_ATTEMPTS) {
          transition(session, 'FAILED', { at: instantOf(nowMs), reason: 'confirmation_attempts_exhausted' });
          throw new PairingError('confirmation_attempts_exhausted', `session ${sessionId} failed after ${attempts} wrong confirmation tokens`);
        }
        throw new PairingError('confirmation_not_available', 'the confirmation token does not match the one this session requested');
      }
      if (typeof confirmedBy !== 'string' || confirmedBy.trim() === '') {
        throw new PairingError('confirmation_actor_missing', 'a human/Owner confirmation must name who confirmed');
      }
      if (confirmFingerprint !== session.responder_fingerprint) {
        throw new PairingError('fingerprint_mismatch', 'the confirmed fingerprint is not the one the key exchange bound');
      }
      if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
        throw new PairingValidationError('device_id', `deviceId ${JSON.stringify(deviceId)} is not a dev-<32 hex> identity`);
      }
      // The human confirmed a specific device; trusting a different one would make the preview
      // decorative.
      if (session.preview?.device_id !== null && session.preview?.device_id !== undefined && session.preview.device_id !== deviceId) {
        throw new PairingError('preview_mismatch', `the previewed device ${session.preview.device_id} is not the device being trusted (${deviceId})`);
      }
      if (!TRUST_ROLES.includes(role)) throw new PairingError('role_not_allowed', String(role));
      if (typeof credentialFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(credentialFingerprint)) {
        throw new PairingValidationError('fingerprint', 'credentialFingerprint must be a sha256:<hex> reference');
      }
      if (typeof macMismatchObserved !== 'boolean') throw new PairingValidationError('malformed', 'macMismatchObserved must be a boolean');
      if (typeof trustId !== 'string' || !TRUST_ID_PATTERN.test(trustId)) {
        throw new PairingValidationError('trust_id', `trustId ${JSON.stringify(trustId)} is not a trust-<32 hex> identity`);
      }
      if (trusts.has(trustId)) throw new PairingValidationError('trust_id', `trust ${trustId} already exists`);
      // A device that already holds a trust record needs an explicit replacement. This
      // includes a REVOKED record: revoking a lost device must not be undone by simply
      // pairing again, so re-pairing is a deliberate, named decision rather than a
      // side effect of a successful handshake.
      const priorRecords = [...trusts.values()].filter((record) => record.device_id === deviceId);
      const existing = priorRecords[0] ?? null;
      if (existing && !replaceExisting) {
        throw new PairingError('already_trusted', `device ${deviceId} already holds trust ${existing.trust_id} (${existing.state})`);
      }
      // The edge is checked before anything is written, so a refusal creates no trust.
      assertTransition(session, 'TRUSTED');

      const at = instantOf(nowMs);
      // A replacement must actually *supersede*: every prior record for this device that is
      // not already revoked is retired here. Leaving a still-TRUSTED predecessor would put
      // two live trusts on one device, and `checkReconnect` would then accept whichever it
      // found first — so revoking the replacement would not cut the device off.
      const superseded = [];
      for (const prior of priorRecords) {
        if (prior.state === 'REVOKED') continue;
        prior.state = 'REVOKED';
        prior.revoked_at = at;
        prior.revocation_reason = 'REPAIRED';
        prior.history.push({ state: 'REVOKED', at, reason: 'REPAIRED' });
        superseded.push(prior.trust_id);
        record({ event: 'TRUST_REVOKED', trust_id: prior.trust_id, device_id: deviceId, reason: 'REPAIRED', at, actor: confirmedBy });
      }
      const trust = {
        schema_version: PAIRING_SCHEMA_VERSION,
        kind: TRUST_RECORD_KIND,
        trust_id: trustId,
        device_id: deviceId,
        fingerprint: confirmFingerprint,
        role,
        state: 'TRUSTED',
        entry_point: session.entry_point,
        session_id: sessionId,
        established_at: at,
        confirmed_by: confirmedBy,
        credential_fingerprint: credentialFingerprint,
        revoked_at: null,
        revocation_reason: null,
        mac_mismatch_observed: macMismatchObserved,
        history: [{ state: 'TRUSTED', at, reason: null }],
      };
      assertTrustRecord(trust);
      trusts.set(trustId, trust);
      consumedConfirmations.set(tokenRef, sessionId);

      session.trusted_device_id = deviceId;
      session.trust_id = trustId;
      session.confirmed_by = confirmedBy;
      session.confirmed_at = at;
      transition(session, 'TRUSTED', { at, reason: null, actor: confirmedBy });
      record({ event: 'TRUST_ESTABLISHED', session_id: sessionId, trust_id: trustId, device_id: deviceId, role, at, confirmed_by: confirmedBy });
      return { session: sessionDocument(session), trust: trustDocument(trust), superseded: superseded.sort() };
    },

    /** Refuse a pairing. The reason is recorded, and the session is finished. */
    rejectPairing(sessionId, { reason, actor = null, nowMs }) {
      const session = expireIfDue(requireSession(sessionId), nowMs);
      transition(session, 'REJECTED', { at: instantOf(nowMs), reason: typeof reason === 'string' ? reason : 'REJECTED', actor });
      return sessionDocument(session);
    },

    /** Abandon a pairing. Nothing is trusted and no cleanup is owed. */
    cancelPairing(sessionId, { reason = 'CANCELLED', actor = null, nowMs }) {
      const session = expireIfDue(requireSession(sessionId), nowMs);
      // The caller's reason is recorded when given: "the user backed out" and "the
      // transport died" are different facts, and only the caller knows which happened.
      transition(session, 'CANCELLED', {
        at: instantOf(nowMs),
        reason: typeof reason === 'string' && reason !== '' ? reason : 'CANCELLED',
        actor,
      });
      return sessionDocument(session);
    },

    /** A protocol/transport failure. Distinct from a refusal: no human decided anything. */
    failPairing(sessionId, { reason, actor = null, nowMs }) {
      const session = expireIfDue(requireSession(sessionId), nowMs);
      transition(session, 'FAILED', { at: instantOf(nowMs), reason: typeof reason === 'string' ? reason : 'FAILED', actor });
      return sessionDocument(session);
    },

    /**
     * Mark a session expired. Refuses while the deadline has not passed, so "expired" is
     * a fact about the clock rather than something a caller can assert.
     */
    expireSession(sessionId, { nowMs }) {
      const session = requireSession(sessionId);
      if (isFinalState(session.state)) return sessionDocument(session);
      if (Date.parse(session.expires_at) > nowMs) {
        throw new PairingError('session_not_expired', `session ${sessionId} expires at ${session.expires_at}`);
      }
      return sessionDocument(expireIfDue(session, nowMs));
    },

    /** Failed-pair cleanup: retire every session whose deadline has passed. */
    cleanupExpired(nowMs) {
      const expired = [];
      for (const session of sessions.values()) {
        if (isFinalState(session.state)) continue;
        if (Date.parse(session.expires_at) <= nowMs) {
          expireIfDue(session, nowMs);
          expired.push(session.session_id);
        }
      }
      return { expired: expired.sort() };
    },

    getSession(sessionId) {
      return sessionDocument(requireSession(sessionId));
    },

    listSessions({ state = null } = {}) {
      return [...sessions.values()]
        .filter((session) => state === null || session.state === state)
        .map(sessionDocument)
        .sort((a, b) => (a.session_id < b.session_id ? -1 : 1));
    },

    // ---- trust lifecycle ---------------------------------------------------
    getTrust(trustId) {
      return trustDocument(requireTrust(trustId));
    },

    listTrusts({ deviceId = null, state = null } = {}) {
      return [...trusts.values()]
        .filter((trust) => deviceId === null || trust.device_id === deviceId)
        .filter((trust) => state === null || trust.state === state)
        .map(trustDocument)
        .sort((a, b) => (a.trust_id < b.trust_id ? -1 : 1));
    },

    /** Rotate the credential a device presents on reconnect. The old one stops working. */
    rotateCredential(trustId, { credentialFingerprint, actor = null, nowMs }) {
      const trust = requireTrust(trustId);
      if (trust.state === 'REVOKED') throw new PairingError('trust_revoked', `trust ${trustId} is revoked`);
      if (typeof credentialFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(credentialFingerprint)) {
        throw new PairingValidationError('fingerprint', 'credentialFingerprint must be a sha256:<hex> reference');
      }
      const at = instantOf(nowMs);
      trust.credential_fingerprint = credentialFingerprint;
      trust.history.push({ state: 'CREDENTIAL_ROTATED', at, reason: null });
      record({ event: 'CREDENTIAL_ROTATED', trust_id: trustId, device_id: trust.device_id, at, actor });
      return trustDocument(trust);
    },

    changeTrustRole(trustId, { role, actor = null, nowMs }) {
      const trust = requireTrust(trustId);
      if (trust.state === 'REVOKED') throw new PairingError('trust_revoked', `trust ${trustId} is revoked`);
      if (!TRUST_ROLES.includes(role)) throw new PairingError('role_not_allowed', String(role));
      if (trust.role === role) return trustDocument(trust);
      const at = instantOf(nowMs);
      const previous = trust.role;
      trust.role = role;
      trust.history.push({ state: `ROLE_${role}`, at, reason: `from:${previous}` });
      record({ event: 'TRUST_ROLE_CHANGED', trust_id: trustId, device_id: trust.device_id, from: previous, to: role, at, actor });
      return trustDocument(trust);
    },

    /** Withdraw trust. A revoked device cannot reconnect with its old credentials. */
    revokeTrust(trustId, { reason = 'OWNER_REVOKED', actor = null, nowMs }) {
      const trust = requireTrust(trustId);
      if (!REVOCATION_REASONS.includes(reason)) throw new PairingValidationError('malformed', `reason ${JSON.stringify(reason)} is not a revocation reason`);
      if (trust.state === 'REVOKED') throw new PairingError('already_revoked', `trust ${trustId} is already revoked`);
      const at = instantOf(nowMs);
      trust.state = 'REVOKED';
      trust.revoked_at = at;
      trust.revocation_reason = reason;
      trust.history.push({ state: 'REVOKED', at, reason });
      record({ event: 'TRUST_REVOKED', trust_id: trustId, device_id: trust.device_id, reason, at, actor });
      return trustDocument(trust);
    },

    /** Quarantine: still known, not currently usable, reversible by an explicit decision. */
    quarantineTrust(trustId, { reason, actor = null, nowMs }) {
      const trust = requireTrust(trustId);
      if (trust.state === 'REVOKED') throw new PairingError('trust_revoked', `trust ${trustId} is revoked`);
      if (trust.state === 'QUARANTINED') return trustDocument(trust);
      const at = instantOf(nowMs);
      trust.state = 'QUARANTINED';
      trust.history.push({ state: 'QUARANTINED', at, reason: typeof reason === 'string' ? reason : null });
      record({ event: 'TRUST_QUARANTINED', trust_id: trustId, device_id: trust.device_id, at, reason: typeof reason === 'string' ? reason : null, actor });
      return trustDocument(trust);
    },

    /** Lost-device revocation: revoke whatever trust the device holds, and refuse silently. */
    revokeLostDevice(deviceId, { actor = null, nowMs }) {
      const held = [...trusts.values()].filter((trust) => trust.device_id === deviceId && trust.state !== 'REVOKED');
      const revoked = [];
      for (const trust of held) {
        const at = instantOf(nowMs);
        trust.state = 'REVOKED';
        trust.revoked_at = at;
        trust.revocation_reason = 'DEVICE_LOST';
        trust.history.push({ state: 'REVOKED', at, reason: 'DEVICE_LOST' });
        record({ event: 'TRUST_REVOKED', trust_id: trust.trust_id, device_id: deviceId, reason: 'DEVICE_LOST', at, actor });
        revoked.push(trust.trust_id);
      }
      if (revoked.length === 0) throw new PairingError('unknown_device', `device ${String(deviceId)} holds no active trust`);
      return { deviceId, revoked: revoked.sort() };
    },

    /**
     * Can this device reconnect?
     *
     * A `true` answer means "the trust record still stands and the credential matches".
     * It is deliberately NOT a permission: capabilities come from
     * `capabilitiesFromTrustRole()`, which always answers none.
     */
    checkReconnect({ deviceId, fingerprint, credentialFingerprint }) {
      const held = [...trusts.values()].filter((trust) => trust.device_id === deviceId);
      if (held.length === 0) return { allowed: false, code: 'unknown_device', detail: `device ${String(deviceId)} holds no trust record` };
      const resolved = resolveActiveTrust(held);
      // Ambiguity is refused rather than resolved by insertion order. Two live records for one
      // device means a replacement did not supersede its predecessor, and answering with
      // whichever came first would hide a revocation bypass instead of reporting it.
      if (resolved.status === 'CONFLICT') {
        return {
          allowed: false,
          code: 'trust_conflict',
          detail: `device ${deviceId} holds ${resolved.conflicts.length} live trust records (${resolved.conflicts.join(', ')}); an operator must revoke the superseded one`,
        };
      }
      const active = resolved.active;
      if (!active) {
        const state = held[0].state;
        return {
          allowed: false,
          code: state === 'QUARANTINED' ? 'trust_quarantined' : 'trust_revoked',
          detail: `device ${deviceId} trust is ${state}`,
        };
      }
      if (fingerprint !== active.fingerprint) {
        return { allowed: false, code: 'fingerprint_mismatch', detail: 'the presented fingerprint is not the trusted one' };
      }
      if (credentialFingerprint !== active.credential_fingerprint) {
        const rotated = active.history.some((entry) => entry.state === 'CREDENTIAL_ROTATED');
        return {
          allowed: false,
          code: rotated ? 'credential_rotated' : 'credential_unknown',
          detail: rotated
            ? 'the presented credential was rotated away; re-pair or present the current credential'
            : 'the presented credential does not match the trusted credential',
        };
      }
      return { allowed: true, code: null, detail: `trust ${active.trust_id} stands`, trust_id: active.trust_id, role: active.role };
    },

    // ---- audit -------------------------------------------------------------
    /** The bounded transition log. It carries digests and states, never key material. */
    auditLog({ sinceSequence = 0 } = {}) {
      const since = Number.isSafeInteger(sinceSequence) ? sinceSequence : 0;
      return audit.filter((entry) => entry.sequence > since).map((entry) => ({ ...entry }));
    },

    /**
     * Prove the audit log leaks nothing.
     *
     * A negative answer is the contract: the authority stores only digests, so neither a
     * private key block nor any secret the caller names may appear. Kept as a runtime
     * helper because a future caller could otherwise add a field and leak silently.
     */
    auditLeakScan({ knownSecrets = [] } = {}) {
      const found = findSecretMaterial(audit, { knownSecrets, path: 'audit' });
      const serialized = canonicalJson(audit);
      return Object.freeze({
        leaks: Object.freeze(found),
        leaksNothing: found.length === 0,
        containsRawToken: knownSecrets.some((secret) => typeof secret === 'string' && secret !== '' && serialized.includes(secret)),
      });
    },
  };

  return Object.freeze(authority);
}

/**
 * Re-check a session document produced elsewhere.
 *
 * Exposed because a peer's session document arrives over a transport this module does not
 * own, and a caller must be able to refuse it without constructing an authority.
 */
export function inspectSessionDocument(raw) {
  const verdict = (() => {
    try { assertPairingSession(raw); return { ok: true, errors: [] }; }
    catch (error) { return { ok: false, errors: [error.detail ?? error.code], code: error.code }; }
  })();
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    errors: [],
    session_id: raw.session_id,
    state: raw.state,
    entry_point: raw.entry_point,
    // Final means "the transition table gives this state no outgoing edge", which includes
    // TRUSTED: a consumer must not believe a trusted session can still move.
    is_terminal: isFinalState(raw.state),
    is_trusted: raw.state === 'TRUSTED',
    transitions: raw.transitions.length,
  };
}

/** Re-exported so a consumer has one import site for the preview builder. */
export { buildDevicePreview };
