// Pairing session lifecycle — the OWNER's rule, as a testable state machine.
//
// NO CLICK = NO CODE.
//
//   IDLE    -- owner clicks Generate --> ACTIVE
//   ACTIVE  -- consumed --------------> CONSUMED
//   ACTIVE  -- expires ---------------> EXPIRED
//   CONSUMED / EXPIRED -- owner clicks Generate --> ACTIVE (a NEW session)
//
// The rule the previous implementation broke is not a rendering detail; it is this transition table. It lived
// inside app.js as scattered `clearPairing()` calls on navigation, on `pagehide`, on every non-ONLINE status
// and on refresh, which is why a valid code could vanish (or be silently replaced) without the user asking.
// A state machine cannot be "mostly" right, so it is kept here where a test can drive it without a browser:
// every create/clear/expire path goes through this module, and app.js only asks it questions.
//
// Two properties are load-bearing and are asserted in tests/pairing-lifecycle.test.mjs:
//   1. `snapshot()` is PURE — it never mutates state, so a render, a refresh, a reconnect or a countdown tick
//      cannot create, rotate or clear anything by itself.
//   2. `clearOnSessionChanged()` distinguishes CONSUMED from EXPIRED by the session's own expiry time, so the
//      page can say USED rather than guessing.

export const STORAGE_KEY = 'utopia.pairing-active-session';
export const STORAGE_VERSION = 1;

// Reasons a session stopped being ACTIVE. These are the only terminal labels the UI is allowed to show.
export const REASON_EXPIRED = 'pairing.expired';
export const REASON_USED = 'pairing.used';
export const REASON_REVOKED = 'pairing.revoked';

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = v => (typeof v === 'string' && v.length ? v : null);

// A restored session is only trusted if it is STRUCTURALLY what the generator produced. Anything else is
// dropped rather than half-rendered: a code with no expiry, or an invite with no payload, is not a session.
function validStored(v) {
  if (!isObject(v)) return false;
  if (v.version !== STORAGE_VERSION) return false;
  // `cityId` is deliberately NOT required: the City's session response does not carry one at the top level, and
  // the record is already scoped to this origin's sessionStorage. An absent cityId means "the City this page is
  // connected to", which is exactly what the storage key means.
  if (v.cityId !== null && v.cityId !== undefined && typeof v.cityId !== 'string') return false;
  if (!text(v.pairingSessionId) || !text(v.shortCode)) return false;
  if (!text(v.expiresAt) || !Number.isFinite(Date.parse(v.expiresAt))) return false;
  if (!text(v.qrPayload)) return false;
  return true;
}

// sessionStorage is the right scope: it survives a reload and an in-page navigation (so a valid code comes
// back as the SAME session), and it does NOT survive closing the tab or the browser. Temporary pairing
// material must never become a durable credential, so localStorage is deliberately not used here.
function memoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
  };
}

function pickStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) return sessionStorage;
  } catch { /* a browser may refuse storage access; the in-memory fallback keeps the page working */ }
  return memoryStorage();
}

export function createPairingLifecycle({ storage, now = () => Date.now() } = {}) {
  const store = pickStorage(storage);
  let session = null;
  let notice = '';

  const read = () => {
    try { return store.getItem(STORAGE_KEY); } catch { return null; }
  };

  const persist = () => {
    try {
      if (session) store.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...session }));
      else store.removeItem(STORAGE_KEY);
    } catch { /* a full or blocked store must not break the pairing page */ }
  };

  // Drop the material. `reason` records WHY, and that distinction is the whole point: a consumed session and
  // an expired session end in the same visual state (material removed, Generate available again) but must not
  // tell the user the same story.
  const drop = (reason = '') => {
    session = null;
    notice = reason;
    persist();
  };

  return {
    // The stored material, restored only if it is still the SAME unexpired session. An expired or malformed
    // record is discarded here and NOT replaced by a new one — restoring is not generating.
    restore() {
      const raw = read();
      if (!raw) return null;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      if (!validStored(parsed)) { drop(); return null; }
      if (now() >= Date.parse(parsed.expiresAt)) {
        // The expiresAt check is done against the CURRENT clock, so a session that expired while the page was
        // away is restored as EXPIRED and never as ACTIVE.
        drop(REASON_EXPIRED);
        return null;
      }
      session = {
        cityId: parsed.cityId ?? null,
        pairingSessionId: parsed.pairingSessionId,
        shortCode: parsed.shortCode,
        createdAt: parsed.createdAt ?? null,
        expiresAt: parsed.expiresAt,
        qrPayload: parsed.qrPayload,
        qrSvg: parsed.qrSvg ?? '',
      };
      notice = '';
      return session;
    },

    // The result of the ONE operation allowed to create a session. The caller has already decided that this is
    // a user-initiated Generate; this method refuses to run over an ACTIVE session, which is what makes
    // "no silent rotation" a property of the state machine rather than a property of the button's label.
    create(result) {
      if (this.snapshot().state === 'ACTIVE') return { created: false, reason: 'SESSION_ALREADY_ACTIVE' };
      if (!isObject(result)) return { created: false, reason: 'NO_SESSION_RETURNED' };
      const next = {
        cityId: text(result.cityId) ?? text(result.descriptor?.cityId),
        pairingSessionId: text(result.pairingSessionId),
        shortCode: text(result.shortCode),
        createdAt: text(result.createdAt),
        expiresAt: text(result.expiresAt),
        qrPayload: text(result.qrPayload),
        qrSvg: typeof result.qrSvg === 'string' ? result.qrSvg : '',
      };
      if (!next.pairingSessionId || !next.shortCode || !next.expiresAt || !Number.isFinite(Date.parse(next.expiresAt))) {
        return { created: false, reason: 'MALFORMED_SESSION' };
      }
      session = next;
      notice = '';
      persist();
      return { created: true, session };
    },

    // PURE. Rendering, refresh, reconnect and the countdown all read through this and change nothing.
    // `generate` is the ONLY action the UI may offer while idle or after a terminal state.
    snapshot() {
      if (!session) {
        return {
          state: notice ? 'ENDED' : 'IDLE',
          notice,
          session: null,
          remainingMs: 0,
          generate: { available: true, label: 'pairing.generate', enabled: true },
        };
      }
      const remainingMs = Math.max(0, Date.parse(session.expiresAt) - now());
      if (remainingMs <= 0) {
        return {
          state: 'EXPIRED',
          notice: REASON_EXPIRED,
          session: null,
          remainingMs: 0,
          generate: { available: true, label: 'pairing.generate', enabled: true },
        };
      }
      return {
        state: 'ACTIVE',
        notice: '',
        session,
        // rounded UP, so the countdown only reaches 0 at the moment the session really expires
        remainingSeconds: Math.ceil(remainingMs / 1000),
        remainingMs,
        // While ACTIVE there is no Refresh: the button is replaced by a status, never by a rotation control.
        generate: { available: false, label: 'pairing.active', enabled: false },
      };
    },

    // The countdown's own tick. It may only ever move ACTIVE -> EXPIRED; it must not create anything.
    expireIfDue() {
      if (!session) return false;
      if (now() < Date.parse(session.expiresAt)) return false;
      drop(REASON_EXPIRED);
      return true;
    },

    // What the CITY says is currently the one active session id (null when there is none). Used to notice that
    // OUR session was consumed by another device. It never generates.
    ownerSessionId: () => session?.pairingSessionId ?? null,

    // A refresh observed a different canonical session. The distinction the UI needs:
    //   expiresAt has passed        -> EXPIRED
    //   expiresAt has not passed     -> the session was CONSUMED (used) or replaced
    // Both end with the material removed and Generate available again.
    clearOnSessionChanged(canonicalSessionId) {
      if (!session) return { changed: false };
      if (canonicalSessionId === session.pairingSessionId) return { changed: false };
      const consumed = now() < Date.parse(session.expiresAt);
      drop(consumed ? REASON_USED : REASON_EXPIRED);
      return { changed: true, reason: consumed ? REASON_USED : REASON_EXPIRED };
    },

    // An explicit, user-visible deselection (the page clearing its own display). Still not a generator.
    clear(reason = '') { drop(reason); },

    // The tab is going away. Persist and NOTHING else: this is where the old code deleted the user's code.
    persist,

    // exposed for tests and for the evidence receipt
    peek: () => session,
    storageKey: STORAGE_KEY,
  };
}
