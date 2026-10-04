// N2: the last hop of the cross-network path - turning `relay-in-city` from a DECISION into an ACTION.
//
// WHAT THIS FILE IS FOR. `relay-dial.mjs` can dial a City and forward a payload. `choosePath` can name
// `relay-in-city` and carry the target. What was still missing was the JOIN FLOW over that pipe: the button on the
// connection screen still navigated the browser to the other PC's origin, which is exactly the thing that cannot
// happen when the other PC is on a different network behind NAT. This module is that flow, as a pure function of an
// injected `forward`, so it is testable without a browser and the surface only has to render what it returns.
//
// THE SHAPE OF THE FLOW, AND WHY IT IS NOT SHORTER:
//   1. the target's City capability is read first, so a wrong address or a City that refuses requests fails BEFORE a
//      join request is created (an ask nobody can approve is worse than no ask);
//   2. the ask is the EXISTING `join/request` payload - same fields as the browser's own `joinApi('request', …)`,
//      including the one-time claim the requester alone holds;
//   3. the decision is awaited by polling `join/status`, and every terminal state is REPORTED as itself: a rejection
//      is not "unreachable", and an expiry is not a rejection;
//   4. only an APPROVED request is exchanged, and the credential is returned to the caller - this module never
//      stores it, never writes it anywhere, and never decides what trust it carries.
//
// WHAT IT REFUSES TO DO: it will not retry a rejected ask (the City said no), it will not poll for ever (bounded by
// `deadlineMs`), and it will not turn a transport failure into a decision (a failed poll reports `FAILED` with the
// typed reason instead of pretending the owner decided something).

/** Terminal and non-terminal outcomes, named so the surface translates instead of inventing prose. */
export const RELAY_JOIN_STATES = Object.freeze(['DIALING', 'ASKING', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'FAILED']);

export class RelayJoinError extends Error {
  constructor(code, detail, { status = null, fallback = true } = {}) {
    super(`${code}: ${detail}`);
    this.name = 'RelayJoinError';
    this.code = code;
    this.detail = detail;
    this.status = status;
    this.fallback = fallback;
  }
}

const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' });

/** A claim secret with the same bounds the City enforces, generated here when the caller has none. */
export function newJoinClaim() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `relay-claim-${random}${Math.random().toString(36).slice(2)}`.slice(0, 120);
}

/**
 * Join a remote City over the relay pipe.
 *
 * @param {object} input
 *   `forward`   - `(path, body, options) => Promise<answer>`, normally `relay.forward` from `relay-dial`. Injected so
 *                 this flow can be tested against a stub and so it can never open a socket of its own.
 *   `claim`     - the requester's one-time secret. Required: a join the requester cannot later collect is useless.
 *   `hint`      - the installation hint, so a retry re-adopts the same row instead of creating a second card.
 *   `cityRef`   - the pinned City identity this ask is for, when the surface knows it. A target that answers with a
 *                 DIFFERENT city is refused, because delivering the ask to the wrong owner is worse than failing.
 *   `onStep`    - `(state, detail) => void`, called on every transition so the surface can show real progress.
 * @returns {Promise<{state:'APPROVED', requestId:string, credential:string, cityId:string|null}>}
 */
export async function joinCityOverRelay({
  forward,
  claim,
  displayName = 'Utopia client',
  platform = 'browser',
  hint = null,
  origin = null,
  cityRef = null,
  pollIntervalMs = 2000,
  deadlineMs = 10 * 60 * 1000,
  timeoutMs = 20000,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  onStep = () => {},
} = {}) {
  if (typeof forward !== 'function') throw new RelayJoinError('RELAY_JOIN_NO_PIPE', 'joining over the relay needs the pipe it was given', { fallback: false });
  if (typeof claim !== 'string' || claim.length < 16) throw new RelayJoinError('RELAY_JOIN_NO_CLAIM', 'a join needs a claim secret the requester keeps', { fallback: false });

  const readAnswer = answer => {
    if (!answer || typeof answer !== 'object') throw new RelayJoinError('RELAY_JOIN_BAD_ANSWER', 'the relay returned no answer');
    const inner = answer.response && typeof answer.response === 'object' && ('payload' in answer.response || 'status' in answer.response) ? answer.response : answer;
    return { status: Number.isFinite(inner.status) ? inner.status : 502, payload: inner.payload ?? null, error: inner.error ?? answer.error ?? null };
  };
  // STEPPED ONCE PER TRANSITION, not once per call. The poll loop and the exchange both report APPROVED, and the
  // first version called `onStep` from both - so a surface counting steps saw the same state twice and a test that
  // pins the sequence caught it. A state change is the fact worth reporting; a repeat is noise.
  let lastReported = null;
  const step = (state, detail) => { if (state === lastReported) return; lastReported = state; onStep(state, detail); };

  step('DIALING', null);
  // 1. WHAT CITY IS ON THE OTHER END. `join/info` is a public route, so this needs no credential - and it fails
  //    BEFORE a request exists, which is the point: an ask nobody can approve is worse than no ask.
  const info = readAnswer(await forward('/api/v0/join/info', {}, { timeoutMs, method: 'GET' }));
  if (info.status !== 200 || !info.payload) throw new RelayJoinError('RELAY_JOIN_UNREACHABLE', info.error ?? `the target City did not answer /join/info (${info.status})`);
  const answeredCity = info.payload.cityId ?? null;
  if (cityRef && answeredCity && cityRef !== answeredCity) {
    throw new RelayJoinError('RELAY_JOIN_WRONG_CITY', `that pipe answers for ${answeredCity}, not for the City this row pinned (${cityRef})`, { fallback: true });
  }

  // 2. THE ASK. Field for field the payload the browser posts on the target's own origin.
  step('ASKING', null);
  const asked = readAnswer(await forward('/api/v0/join/request', {
    displayName,
    platform,
    installationHint: hint ?? undefined,
    origin: origin ?? undefined,
    claim,
  }, { timeoutMs }));
  if (asked.status !== 200 || !asked.payload?.id) {
    throw new RelayJoinError('RELAY_JOIN_ASK_REFUSED', asked.error ?? `the City refused the ask (${asked.status})`, { status: asked.status });
  }
  const requestId = asked.payload.id;
  let state = asked.payload.state ?? 'PENDING';
  step(state === 'APPROVED' ? 'APPROVED' : 'PENDING', asked.payload);

  // 3. THE DECISION. Every terminal state is reported as itself - a rejection must never arrive as "unreachable",
  //    and an expiry must never arrive as a rejection.
  const deadline = now() + deadlineMs;
  while (state !== 'APPROVED') {
    if (state === 'REJECTED') throw new RelayJoinError('RELAY_JOIN_REJECTED', 'the City owner rejected this join request', { status: 403, fallback: false });
    if (state === 'EXPIRED' || state === 'CONSUMED') throw new RelayJoinError('RELAY_JOIN_EXPIRED', 'this join request is no longer valid', { status: 410, fallback: false });
    if (now() > deadline) throw new RelayJoinError('RELAY_JOIN_TIMEOUT', 'the owner did not decide before the deadline', { status: 504 });
    await wait(pollIntervalMs);
    const polled = readAnswer(await forward('/api/v0/join/status', { requestId, claim }, { timeoutMs }));
    if (polled.status !== 200 || !polled.payload) {
      // A poll that FAILS cannot report a terminal state, so it is a failure of this flow - not a decision.
      throw new RelayJoinError('RELAY_JOIN_POLL_FAILED', polled.error ?? `the City did not answer the status poll (${polled.status})`, { status: polled.status });
    }
    state = polled.payload.state;
    step(state === 'APPROVED' ? 'APPROVED' : state, polled.payload);
  }

  // 4. THE ONLY ROUTE TO A CREDENTIAL, through the same one-time claim.
  const collected = readAnswer(await forward('/api/v0/join/exchange', { requestId, claim, installation:{browserOnly:true} }, { timeoutMs }));
  if (collected.status !== 200 || !collected.payload?.credential) {
    throw new RelayJoinError('RELAY_JOIN_EXCHANGE_REFUSED', collected.error ?? `the City did not release a credential (${collected.status})`, { status: collected.status });
  }
  step('APPROVED', collected.payload);
  return Object.freeze({
    state: 'APPROVED',
    requestId,
    credential: collected.payload.credential,
    cityId: answeredCity,
    displayName: info.payload.displayName ?? null,
  });
}

/**
 * A relay target derived from a row the connection list already holds, or null when the row cannot support one.
 *
 * The RELAY is the City that serves the page (`selfOrigin`) - the reachable one, whose pipe the target's City will
 * be asked to push to. The TARGET is the far PC. Both are needed: a mechanism the user cannot act on must not be
 * offered, which is the same rule `choosePath` follows for `relay-in-city` itself.
 */
export function relayTargetFor(row = {}, selfOrigin = null) {
  const host = typeof row.address === 'string' && row.address.length > 0 ? row.address : null;
  if (!host) return null;
  const port = Number.isFinite(row.port) ? row.port : null;
  return Object.freeze({ host, port, cityRef: row.cityRef ?? null, relayOrigin: selfOrigin ?? null });
}

/** How a row should be reached. `relay` means the ask cannot be carried by navigating there. */
export function reachForRow(row = {}) {
  if (row.scope === 'local') return 'self';
  if (row.scope === 'lan' || row.scope === 'bluetooth') return 'navigate';
  // `remote` is the whole point of this module; `unknown` has no address to navigate to.
  return 'relay';
}
