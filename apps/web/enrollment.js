// JOIN-503 — the web surface's half of device enrollment.
//
// WHAT THIS MODULE IS ALLOWED TO KNOW: a SESSION credential, and nothing else. The durable installation
// credential lives on the machine (`.runtime/device-enrollment.json`, read by the launcher) and is never put in a
// URL, never in sessionStorage and never in the DOM. That split is the point of the task: a browser is a
// disposable surface, so what it holds must be disposable too.
//
// WHY THE FRAGMENT. The launcher has to hand the page a credential without any typing. The URL fragment is the
// only browser-side channel that is never sent to a server, so a credential there does not reach the City's
// access log; the page strips it from the address bar as soon as it has been read (app.js does that).
//
// A SESSION CAN EXPIRE, AND THAT IS FINE. `refreshSession` re-mints from the session credential this page already
// holds; when even that fails the page says so and offers pairing rather than silently falling back to a token.

export const SESSION_STORAGE_KEY = 'city-session';
export const SESSION_ID_STORAGE_KEY = 'city-session-id';

const headers = (credential) => ({
  ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
  'Content-Type': 'application/json',
  'X-City-Api-Version': '0',
  'X-City-Schema-Version': '0',
});

/** Read the bootstrap credential out of `location.hash`. Returns null when the fragment carries none. */
export function readSessionFromHash(hash) {
  try {
    const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
    const value = params.get('session');
    if (!value) return null;
    // Only a SESSION credential is accepted here. A control token arriving as `session=` would quietly
    // reintroduce the permanent credential this task exists to keep out of the browser.
    if (!/^sess:[A-Za-z0-9_-]+$/.test(value)) return null;
    return value;
  } catch { return null; }
}

/** The session id half of a `sess:<id>` credential. */
export function sessionIdOf(credential) {
  return typeof credential === 'string' && credential.startsWith('sess:') ? credential.slice('sess:'.length) : null;
}

export function rememberSession(credential, storage = globalThis.sessionStorage) {
  try {
    storage.setItem(SESSION_STORAGE_KEY, credential);
    const id = sessionIdOf(credential);
    if (id) storage.setItem(SESSION_ID_STORAGE_KEY, id);
  } catch { /* a browser that refuses storage still works for this page view */ }
  return credential;
}

export function forgetSession(storage = globalThis.sessionStorage) {
  try { storage.removeItem(SESSION_STORAGE_KEY); storage.removeItem(SESSION_ID_STORAGE_KEY); } catch { /* see above */ }
}

export function storedSession(storage = globalThis.sessionStorage) {
  try { return storage.getItem(SESSION_STORAGE_KEY); } catch { return null; }
}

/**
 * Re-mint a session from the session credential this page holds. Nothing durable is involved: the server mints a
 * fresh short-lived session for the SAME installation and tells us when it expires.
 */
export async function refreshSession({ credential, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const id = sessionIdOf(credential);
  if (!id) return null;
  const response = await fetchImpl('/api/v0/device/session', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ sessionId: id }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(body?.detail ?? body?.error ?? `session refresh refused (${response.status})`), { code: body?.errorCode ?? 'SESSION_REFUSED' });
  return { credential: body.credential, expiresAt: body.session?.expiresAt ?? null, installation: body.installation ?? null };
}

/** The City's enrolled-installation list (for the Settings surface). */
export async function fetchEnrolled({ credential, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const response = await fetchImpl('/api/v0/device/installations', { headers: headers(credential), signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `could not read the enrolled devices (${response.status})`);
  return { installations: body.installations ?? [], cloneFindings: body.cloneFindings ?? [] };
}

/** Revoke one installation. Called by the Settings surface; a self-revoke is scoped by the server. */
export async function revokeEnrolled({ credential, installationId, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const response = await fetchImpl(`/api/v0/device/installations/${encodeURIComponent(installationId)}/revoke`, {
    method: 'POST',
    headers: headers(credential),
    body: JSON.stringify({ reason: 'revoked_by_owner' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `could not revoke (${response.status})`);
  return body.revoked;
}

/** A bounded display form of an installation id: enough to recognise, never the whole secret-shaped string. */
export function shortIdentity(value, head = 8, tail = 4) {
  const text = String(value ?? '');
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}
