// JOIN-503 — the DEVICE side of enrollment: durable identity on disk, sessions in hand, nothing typed.
//
// WHERE THE SECRET LIVES, AND WHY IT IS NOT IN THE BROWSER. JOIN-503 section 5 is precise about this: the durable
// device key belongs to the device/runtime layer, and the web surface keeps only a session-scoped credential.
// So this module is deliberately NOT browser code. It is used by
//
//   * the launcher (`scripts/utopia-client-launcher.mjs`), which runs on the machine and can hold a file; and
//   * the joining path, where an invite is exchanged once and the resulting installation credential is stored.
//
// The browser receives a `sess:` credential through the URL FRAGMENT (never sent to a server, stripped from the
// address bar immediately) and keeps it in sessionStorage exactly as it keeps the token today.
//
// WHAT IS STORED, AND WHAT IS NOT. `.runtime/device-enrollment.json` holds the City endpoint, the city id, the
// installation identity and the installation CREDENTIAL SECRET. That secret is the machine's durable credential,
// so the file is created with owner-only permissions where the platform supports it. No session credential is
// ever written to it - a session is disposable and is re-minted on every launch.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEVICE_FILE_VERSION = 1;

/** Requests carry the frozen V0 headers; a session credential is a bearer credential like any other. */
const headers = (credential) => ({
  ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
  'Content-Type': 'application/json',
  'X-City-Api-Version': '0',
  'X-City-Schema-Version': '0',
});

/**
 * Read the durable enrollment record.
 *
 * A structurally wrong record is answered with `null` rather than partially used: half a credential is not a
 * credential, and silently substituting the control token for a broken enrollment is exactly the fallback this
 * task exists to retire (it would make a revoked installation look enrolled again).
 */
export function readDeviceFile(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || parsed.version !== DEVICE_FILE_VERSION) return null;
    for (const field of ['endpoint', 'cityId', 'installationId', 'instanceId', 'credentialId', 'credentialSecret', 'deviceId']) {
      if (typeof parsed[field] !== 'string' || parsed[field] === '') return null;
    }
    return parsed;
  } catch { return null; }
}

/** Write the durable record with owner-only permissions where the platform honours them. */
export function writeDeviceFile(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({ version: DEVICE_FILE_VERSION, ...record }, null, 2);
  writeFileSync(path, body, { mode: 0o600 });
  // `mode` is honoured on POSIX and ignored on Windows; the chmod is repeated explicitly so a platform that
  // applies the umask to creation still ends up owner-only. A failure here is not fatal - the file is inside the
  // git-ignored .runtime tree either way - but it is attempted rather than assumed.
  try { chmodSync(path, 0o600); } catch { /* see above */ }
  return path;
}

export function forgetDeviceFile(path) {
  try { if (existsSync(path)) rmSync(path, { force: true }); return true; } catch { return false; }
}

/** The bounded, non-secret summary the UI shows. Never includes the credential secret. */
export function describeDeviceFile(record) {
  if (!record) return null;
  return {
    endpoint: record.endpoint,
    cityId: record.cityId,
    deviceId: record.deviceId,
    installationId: record.installationId,
    instanceId: record.instanceId,
    credentialId: record.credentialId,
    displayName: record.displayName ?? null,
    enrolledAt: record.enrolledAt ?? null,
  };
}

/**
 * Enroll this installation against a City using an invite (the one-time code/QR the owner generated).
 *
 * This is the ONLY normal path that produces a durable credential, and it is the same public
 * `pairing/exchange` call every client already makes - it simply also declares the installation, which the City
 * enrolls in the same breath because the exchange IS the owner's proof.
 */
export async function enrollWithCity({ endpoint, invite, displayName, platform = process.platform, instanceId = null, deviceId = null, fetchImpl = fetch, timeoutMs = 10000 }) {
  const base = String(endpoint ?? '').replace(/\/$/, '');
  if (!base) throw new Error('enrollWithCity needs the City endpoint');
  if (!invite || typeof invite !== 'object') throw new Error('enrollWithCity needs a parsed invite (cityId, sessionId, secret)');
  const response = await fetchImpl(`${base}/api/v0/pairing/exchange`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      cityId: invite.cityId,
      sessionId: invite.sessionId,
      method: invite.method ?? 'qr',
      ...(invite.method === 'qr' ? { secret: invite.secret } : { shortCode: invite.shortCode }),
      installation: { displayName, platform, instanceId, deviceId },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`the City refused the enrollment: ${body?.error ?? response.status}`);
  if (!body?.enrollment) throw new Error('the City accepted the invite but did not enroll this installation');
  if (body.cityId !== invite.cityId) throw Object.assign(new Error('Enrollment answered for a different City'), {code:'CITY_IDENTITY_MISMATCH'});
  const enrollment = body.enrollment;
  return {
    record: {
      endpoint: base,
      cityId: body.cityId ?? invite.cityId,
      deviceId: enrollment.deviceId,
      installationId: enrollment.installationId,
      instanceId: enrollment.instanceId,
      credentialId: enrollment.credentialId,
      credentialSecret: enrollment.credentialSecret,
      displayName: enrollment.displayName ?? displayName ?? null,
      enrolledAt: new Date().toISOString(),
    },
    session: enrollment.session ?? null,
  };
}

/**
 * Mint a session from the durable credential. NOTHING is typed: the installation proves itself.
 *
 * A refusal is reported as a typed error carrying the City's code, because the three interesting refusals need
 * different user-facing behaviour: `INSTALLATION_RETIRED` and `INSTALLATION_QUARANTINED` mean this installation
 * must pair again (and must NOT be given any automatic workaround), while a network failure means retry.
 */
export async function openDeviceSession(record, { fetchImpl = fetch, timeoutMs = 8000, endpoint = null } = {}) {
  if (!record) throw Object.assign(new Error('this machine is not enrolled with any City'), { code: 'NOT_ENROLLED', retryable: false });
  // The reachable address wins over the remembered one, and this is not a shortcut: a City's port is not part of
  // its identity, so restarting it somewhere else must not look like a revoked installation. `record.endpoint` is
  // what a machine remembers about WHERE the City was; this machine already knows where it is.
  const base = String(endpoint ?? record.endpoint).replace(/\/$/, '');
  let response;
  try {
    response = await fetchImpl(`${base}/api/v0/device/session`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        installationId: record.installationId,
        instanceId: record.instanceId,
        credentialId: record.credentialId,
        credentialSecret: record.credentialSecret,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Unreachable is retryable and is NOT a credential problem: conflating the two would make a City that is
    // simply down look like a revoked installation.
    throw Object.assign(new Error(`the City at ${base} could not be reached: ${err?.message ?? err}`), { code: 'CITY_UNREACHABLE', retryable: true });
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(body?.detail ?? body?.error ?? `session refused (${response.status})`), {
      code: body?.errorCode ?? 'SESSION_REFUSED',
      retryable: false,
      status: response.status,
    });
  }
  if (body?.cityId !== record.cityId) throw Object.assign(new Error('The endpoint answered for a different City'), {code:'CITY_IDENTITY_MISMATCH', retryable:false});
  return { credential: body.credential, session: body.session, installation: body.installation, cityId: body.cityId };
}

/** Refresh an existing session credential (the web surface's routine restart case). */
export async function refreshDeviceSession({ endpoint, sessionId, fetchImpl = fetch, timeoutMs = 8000 }) {
  const response = await fetchImpl(`${String(endpoint).replace(/\/$/, '')}/api/v0/device/session`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(body?.detail ?? `session refresh refused (${response.status})`), { code: body?.errorCode ?? 'SESSION_REFUSED' });
  return { credential: body.credential, session: body.session, installation: body.installation };
}

/** The City's own list of enrolled installations, for the Settings surface. */
export async function listInstallations({ endpoint, credential, fetchImpl = fetch, timeoutMs = 8000 }) {
  const response = await fetchImpl(`${String(endpoint).replace(/\/$/, '')}/api/v0/device/installations`, { headers: headers(credential), signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `could not list installations (${response.status})`);
  return { installations: body.installations ?? [], cloneFindings: body.cloneFindings ?? [] };
}

/** Revoke one installation. This is the Settings "Remove device" action. */
export async function revokeInstallation({ endpoint, credential, installationId, reason = 'revoked_by_owner', fetchImpl = fetch, timeoutMs = 8000 }) {
  const response = await fetchImpl(`${String(endpoint).replace(/\/$/, '')}/api/v0/device/installations/${encodeURIComponent(installationId)}/revoke`, {
    method: 'POST',
    headers: headers(credential),
    body: JSON.stringify({ reason }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `could not revoke (${response.status})`);
  return body.revoked;
}

/**
 * Turn an invite of either shape into the `{cityId, sessionId, secret | shortCode, method}` the exchange wants.
 * Kept here so the launcher and any future joining surface cannot disagree about the shape.
 */
export function inviteForExchange(raw) {
  if (raw && typeof raw === 'object' && raw.cityId && raw.sessionId) {
    return raw.secret ? { ...raw, method: raw.method ?? 'qr' } : { ...raw, method: raw.method ?? 'mdns' };
  }
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const nested = url.searchParams.get('pair') ?? new URLSearchParams(url.hash.slice(1)).get('pair');
      if (!nested) return null;
      return inviteForExchange(nested.startsWith('utopia:') ? nested : `utopia://pair?${nested}`);
    }
    if (url.protocol !== 'utopia:' || url.hostname !== 'pair') return null;
    const q = url.searchParams;
    const cityId = q.get('city'), sessionId = q.get('session'), secret = q.get('secret');
    if (!cityId || !sessionId) return null;
    const host = q.get('host');
    if (host) {
      const endpoint = new URL(host);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
    }
    return secret ? { cityId, sessionId, secret, method: 'qr', ...(host ? {host} : {}) } : null;
  } catch { return null; }
}
