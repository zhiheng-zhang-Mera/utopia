// JOIN-503 — device enrollment and tokenless routine reconnect, as a registrar over the City's own identity.
//
// WHAT THIS IS NOT: a second device registry. `city/00-foundation/02-city-node-network/device-identity` already
// owns the RF-001 semantics (device_id = logical device, installation_id = one concrete installation,
// fingerprint = the cryptographic anchor, everything else = metadata), including enrollment, rebind, reinstall,
// clone detection and the presentation ladder. This module is the SEAM between that lifecycle and the running
// dev-gateway: it holds the records, mints installation credentials, and answers "may this installation act?".
// Writing a parallel registry would be the exact defect JOIN-503 section 2 forbids.
//
// THE PROBLEM IT SOLVES. Today the browser is handed the City's CONTROL TOKEN and keeps it in sessionStorage.
// That token is the City itself: whoever holds it is the owner, it never expires, and it cannot be revoked. A
// normal user is therefore asked, in effect, to manage a permanent credential. JOIN-503's rule is that a normal
// onboarded installation must not be. So:
//
//   * the DURABLE secret is an INSTALLATION CREDENTIAL (`cred-secret-…`), minted once at enrollment, stored by
//     the device/runtime layer (file, 0600-ish, git-ignored) and NEVER handed to the browser;
//   * the browser only ever receives a SESSION credential (`sess-…`), scoped to one installation and with a
//     short expiry, which it keeps in sessionStorage exactly as it keeps the token today;
//   * a session is re-minted INTERNALLY from the installation credential, so a restart reconnects with nothing
//     typed and no UI prompt;
//   * revocation is a server-side fact about the INSTALLATION, so a revoked installation cannot mint a new
//     session no matter what it still holds.
//
// WHY THIS MODULE IS PURE. It takes `nowMs` and entropy as parameters and touches no clock, no filesystem and no
// randomness of its own, so every acceptance clause in JOIN-503 section 8 is decidable in a test rather than
// asserted in a report. See tests/join503-enrollment.test.mjs.

import {
  assertInstallation,
  createInstallation,
  credentialFingerprint,
  detectCredentialClones,
  enrollDevice,
  enrollInstallation,
  instantOf,
  mintCredentialId,
  mintDeviceId,
  mintInstallationId,
  mintInstanceId,
  quarantineInstallation,
  rebindInstallation,
  resolveInstallationPresentation,
  retireInstallation,
  serializeInstallation,
} from '../../city/00-foundation/02-city-node-network/device-identity/index.mjs';

/** Session lifetimes. Short by design: a session is what the BROWSER holds, so it is the cheap thing to rotate. */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, so one working day never re-prompts
export const MIN_SESSION_TTL_MS = 60 * 1000;

/** The typed refusals this module can produce. A caller switches on the code, never on the prose. */
export const ENROLLMENT_REFUSALS = Object.freeze([
  'UNKNOWN_INSTALLATION',
  'CREDENTIAL_MISMATCH',
  'CLONE_DETECTED',
  'INSTALLATION_RETIRED',
  'INSTALLATION_QUARANTINED',
  'INSTALLATION_UNBOUND',
  'SESSION_EXPIRED',
  'SESSION_UNKNOWN',
  'MALFORMED_PRESENTATION',
  'ALREADY_ENROLLED',
]);

export class EnrollmentError extends Error {
  constructor(code, detail, status = 403) {
    super(`${code}: ${detail}`);
    this.name = 'EnrollmentError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

const text = (v, what) => {
  if (typeof v !== 'string' || v.trim() === '') throw new EnrollmentError('MALFORMED_PRESENTATION', `${what} must be a non-empty string`, 400);
  return v;
};

/** Cryptographically random secret material. Kept explicit so tests can pin it (see the module docblock). */
export function mintSecret(randomBytes) {
  const bytes = randomBytes(32);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * The registrar.
 *
 * @param {object} options
 * @param {(table: string, record: object) => object} options.put   persist one record (id-keyed)
 * @param {(table: string) => object[]} options.list                read a table
 * @param {() => number} options.now                                the only clock
 * @param {(n: number) => Uint8Array} options.randomBytes           the only entropy
 * @param {(type: string, payload?: object) => object} [options.emit] canonical event sink
 */
export function createEnrollmentRegistrar({ put, list, get, now, randomBytes, emit = () => ({}) }) {
  const DEVICES = 'devices';
  const INSTALLATIONS = 'installations';
  const SESSIONS = 'device_sessions';

  const sessionTtl = DEFAULT_SESSION_TTL_MS;

  const readDevice = id => get(DEVICES, `dev:${id}`) || get(DEVICES, id);
  const readInstallation = id => get(INSTALLATIONS, `ins:${id}`);

  // Records are stored under an id-prefixed key so the three tables can never be confused with each other or
  // with the City's existing `nodes` table.
  const writeDevice = device => put(DEVICES, { id: `dev:${device.deviceId}`, ...device });
  const writeInstallation = installation => put(INSTALLATIONS, { id: `ins:${installation.installationId}`, ...installation });
  const writeSession = session => put(SESSIONS, { id: `sess:${session.sessionId}`, ...session });

  const allInstallations = () => list(INSTALLATIONS).map(row => strip(row));
  const allDevices = () => list(DEVICES).map(row => strip(row));
  const allSessions = () => list(SESSIONS).map(row => strip(row));

  // The store keeps a row `id` next to the document; the lifecycle functions must see the document alone.
  function strip(row) {
    const { id, ...rest } = row;
    return rest;
  }

  function ensureDevice({ deviceId, displayName, platform = null }) {
    const existing = readDevice(deviceId);
    if (existing) return strip(existing);
    const device = enrollDevice({
      deviceId,
      displayName,
      nowMs: now(),
      publicKeyMaterial: `installation-key:${deviceId}`,
      metadata: { platform, hostnames: [], networkAddresses: [], macAddresses: [] },
    });
    writeDevice(device);
    return device;
  }

  /**
   * The FIRST join (or an explicit re-enrollment). Called by the gateway after a pairing exchange succeeded,
   * because that exchange is the owner's proof that this installation may join.
   *
   * `deviceId` may be supplied by the caller when the installation already knows which logical device it is
   * re-enrolling as; otherwise the caller supplies a display name and the registrar mints both identities.
   */
  function enroll({ deviceId = null, displayName, platform = null, instanceId = null, credentialId = null, unbound = false }) {
    const name = text(displayName, 'displayName');
    const at = now();
    // `unbound` is the REINSTALL shape: the installation exists and is known, but it has no logical device until
    // an explicit rebind, so it can do nothing in the meantime (JOIN-503 section 4).
    const device = unbound ? null : (deviceId
      ? ensureDevice({ deviceId, displayName: name, platform })
      : ensureDevice({ deviceId: mintDeviceId(randomBytes(16)), displayName: name, platform }));

    const secret = mintSecret(randomBytes);
    // `createInstallation`, not `enrollInstallation`: the latter insists on a logical device, and the unbound
    // (reinstall) shape is precisely "an installation that does not have one yet". Same module, same record.
    const installation = createInstallation({
      installationId: mintInstallationId(randomBytes(16)),
      instanceId: instanceId ?? mintInstanceId(randomBytes(16)),
      credentialId: credentialId ?? mintCredentialId(randomBytes(16)),
      credentialSecret: secret,
      nowMs: at,
      deviceId: device ? device.deviceId : null,
    });
    writeInstallation(installation);
    emit('DEVICE_ENROLLED', { deviceId: installation.deviceId, installationId: installation.installationId, displayName: device ? device.displayName : name, unbound: installation.state === 'UNBOUND' });
    // The secret is returned ONCE, here, to the enrolling installation. It is never readable again and never
    // stored: only its fingerprint is in the record, which `credentialLeakScan` can prove.
    return { device, installation, credential: { installationId: installation.installationId, credentialId: installation.credential.credentialId, credentialSecret: secret } };
  }

  /**
   * Decide whether a presented installation credential may act, and mint a session if so.
   *
   * The refusal ladder is the identity module's own (`resolveInstallationPresentation`), not a re-implementation:
   * unknown / retired / quarantined / credential mismatch / clone / unbound are all distinguished there, so an
   * operator can tell a stolen credential from a duplicated one. This function only adds the SESSION half.
   */
  function openSession({ installationId, instanceId, credentialId, credentialSecret }) {
    const installation = readInstallation(text(installationId, 'installationId'));
    if (!installation) throw new EnrollmentError('UNKNOWN_INSTALLATION', `installation ${installationId} is not enrolled in this City`, 403);
    const presented = {
      installationId,
      instanceId: text(instanceId, 'instanceId'),
      credentialId: text(credentialId, 'credentialId'),
      credentialFingerprint: credentialFingerprint(text(credentialSecret, 'credentialSecret')),
    };
    const verdict = resolveInstallationPresentation(strip(installation), presented);
    if (!verdict.accepted) {
      // The identity module's verdict is translated into this module's typed refusal without losing which fact
      // it was: RETIRED and QUARANTINED are not "no", they are different kinds of no.
      const code = {
        RETIRED: 'INSTALLATION_RETIRED',
        QUARANTINED: 'INSTALLATION_QUARANTINED',
        UNBOUND: 'INSTALLATION_UNBOUND',
        CREDENTIAL_MISMATCH: 'CREDENTIAL_MISMATCH',
        CLONE_DETECTED: 'CLONE_DETECTED',
        UNKNOWN_INSTALLATION: 'UNKNOWN_INSTALLATION',
        MALFORMED_PRESENTATION: 'MALFORMED_PRESENTATION',
      }[verdict.verdict] ?? 'CREDENTIAL_MISMATCH';
      if (code === 'CLONE_DETECTED') emit('DEVICE_CLONE_DETECTED', { installationId, detail: verdict.detail });
      throw new EnrollmentError(code, verdict.detail, code === 'UNKNOWN_INSTALLATION' ? 404 : 403);
    }
    return issueSession(verdict.installation);
  }

  function issueSession(installation) {
    const at = now();
    const session = {
      sessionId: Buffer.from(randomBytes(16)).toString('hex'),
      installationId: installation.installationId,
      deviceId: installation.deviceId,
      issuedAt: instantOf(at),
      expiresAt: instantOf(at + sessionTtl),
      revokedAt: null,
    };
    writeSession(session);
    emit('DEVICE_SESSION_ISSUED', { installationId: installation.installationId, deviceId: installation.deviceId, expiresAt: session.expiresAt });
    return { session, installation };
  }

  /** Resolve a session credential presented by a client (the browser holds only this). */
  function checkSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new EnrollmentError('SESSION_UNKNOWN', 'no session credential presented', 401);
    const row = get(SESSIONS, `sess:${sessionId}`);
    if (!row) throw new EnrollmentError('SESSION_UNKNOWN', 'that session credential was not issued by this City', 401);
    const session = strip(row);
    if (session.revokedAt) throw new EnrollmentError('SESSION_UNKNOWN', 'that session credential was revoked', 401);
    if (now() >= Date.parse(session.expiresAt)) throw new EnrollmentError('SESSION_EXPIRED', 'that session credential has expired', 401);
    const installation = readInstallation(session.installationId);
    // A session outliving its installation is the "revoked identity keeps reconnecting" case, so the
    // installation is consulted on EVERY check rather than trusted because the session was valid at issue time.
    if (!installation) throw new EnrollmentError('UNKNOWN_INSTALLATION', 'the installation behind this session no longer exists', 401);
    const current = strip(installation);
    if (current.state !== 'BOUND') throw new EnrollmentError(current.state === 'RETIRED' ? 'INSTALLATION_RETIRED' : 'INSTALLATION_QUARANTINED', `installation is ${current.state}`, 403);
    return { session, installation: current, device: readDevice(session.deviceId) ? strip(readDevice(session.deviceId)) : null };
  }

  /**
   * Revoke every authority of one installation: the record is retired (terminal, history preserved) and every
   * live session it holds is revoked. This is the Settings "Remove device" action.
   */
  function revoke({ installationId, reason = 'revoked_by_owner' }) {
    const installation = readInstallation(text(installationId, 'installationId'));
    if (!installation) throw new EnrollmentError('UNKNOWN_INSTALLATION', `installation ${installationId} is not enrolled in this City`, 404);
    const current = strip(installation);
    if (current.state !== 'RETIRED') writeInstallation(retireInstallation(current, now()));
    let revoked = 0;
    for (const row of list(SESSIONS)) {
      const session = strip(row);
      if (session.installationId !== installationId || session.revokedAt) continue;
      writeSession({ ...session, revokedAt: instantOf(now()) });
      revoked++;
    }
    emit('DEVICE_REVOKED', { installationId, deviceId: current.deviceId, reason, sessionsRevoked: revoked });
    return { installationId, deviceId: current.deviceId, sessionsRevoked: revoked };
  }

  /**
   * Rebind a reinstalled instance onto its logical device. The identity module requires explicit proof, so this
   * refuses without one — a reinstall must not silently inherit a device (JOIN-503 section 4).
   */
  function rebind({ installationId, deviceId, proof }) {
    const installation = readInstallation(text(installationId, 'installationId'));
    if (!installation) throw new EnrollmentError('UNKNOWN_INSTALLATION', `installation ${installationId} is not enrolled`, 404);
    const rebound = rebindInstallation(strip(installation), { deviceId, proof, nowMs: now() });
    writeInstallation(rebound);
    emit('DEVICE_REBOUND', { installationId, deviceId });
    return rebound;
  }

  function quarantine({ installationId, code, detail = '' }) {
    const installation = readInstallation(text(installationId, 'installationId'));
    if (!installation) throw new EnrollmentError('UNKNOWN_INSTALLATION', `installation ${installationId} is not enrolled`, 404);
    const result = quarantineInstallation(strip(installation), { nowMs: now(), code, detail });
    writeInstallation(result);
    return result;
  }

  /** A bounded, non-secret summary for the UI: what the City believes about this installation, and no secret. */
  function describe(installationId) {
    const installation = readInstallation(installationId);
    if (!installation) return null;
    const current = strip(installation);
    const device = current.deviceId ? readDevice(current.deviceId) : null;
    return {
      installationId: current.installationId,
      deviceId: current.deviceId,
      displayName: device ? strip(device).displayName : null,
      state: current.state,
      rebindRequired: current.rebind.required,
      enrolledAt: current.createdAt,
      credentialFingerprint: current.credential.fingerprint,
      // The handle is safe; the secret behind it is not stored anywhere and so cannot be reported.
      credentialId: current.credential.credentialId,
    };
  }

  const listEnrolled = () => allInstallations()
    .map(installation => describe(installation.installationId))
    .filter(Boolean);

  /**
   * Population-level clone detection, surfaced as a City fact rather than a log line: two records sharing one
   * installation identity, or two installations sharing one credential secret, are both named.
   */
  const cloneFindings = () => detectCredentialClones(allInstallations());

  return Object.freeze({
    enroll,
    openSession,
    checkSession,
    refreshSession:sessionId=>issueSession(checkSession(sessionId).installation),
    revoke,
    rebind,
    quarantine,
    describe,
    list: listEnrolled,
    cloneFindings,
    installations: allInstallations,
    devices: allDevices,
    sessions: allSessions,
    serializeInstallation,
    assertInstallation,
    sessionTtlMs: sessionTtl,
    // exposed so a caller (and a test) can prove the durable secret is not reachable from the records
    installationRecord: id => {
      const installation = readInstallation(id);
      return installation ? serializeInstallation(strip(installation)) : null;
    },
    createInstallationFor: options => createInstallation({ ...options, nowMs: options.nowMs ?? now() }),
  });
}
