// S2/S3: the DIAL side of `relay-in-city`.
//
// WHAT THIS IS FOR, AND WHY IT IS NOT "ANOTHER CONNECTION API". Two PCs on different networks are both behind NAT,
// so neither can accept an inbound connection - which is why the connection surface could report "relay-in-city"
// while no such path existed. The fix has two halves and this is the second one: the City end lives in
// `services/dev-gateway/server.mjs` (a peer dials `/api/v0/relay` and registers), and this module is what DIALS.
//
// THE LOAD-BEARING DECISION: THE PAYLOAD IS A JOIN-HANDSHAKE PAYLOAD THAT ALREADY EXISTS. A forwarded request is
// `{path, body}` where `path` is one of the City's own routes and `body` is EXACTLY what `joinApi('request', …)`
// would have posted. Nothing here invents a second wire shape, a second credential or a second approval step: the
// City that receives the forward runs its own route, so the same one-time claim authorises it and the same owner
// surface approves it. The relay is a pipe.
//
// WHAT IT REFUSES TO DO:
//   * it never opens a socket to more than the ONE host it was asked to dial;
//   * it never forwards a path that is not on the same whitelist the City enforces, so a compromised caller cannot
//     use this module to turn the City into an open proxy;
//   * it never hangs: the handshake AND every forwarded request have their own bounded timeout, and both failures
//     are TYPED (`RELAY_TIMEOUT` / `RELAY_UNREACHABLE`) so the surface can fall back to another path and say why;
//   * it never treats the relay-ready frame as trust: the frame only reports the peer ref the CITY decided.

/** Typed refusals. `fallback: true` means "another path may still work", which is what the surface needs to know. */
export class RelayDialError extends Error {
  constructor(code, detail, { status = null, fallback = true } = {}) {
    super(`${code}: ${detail}`);
    this.name = 'RelayDialError';
    this.code = code;
    this.detail = detail;
    this.status = status;
    this.fallback = fallback;
  }
}

export const RELAY_DIAL_PATH = '/api/v0/relay';
/** Mirrors the City's own list (`RELAY_PAYLOAD_PATHS`). Kept as a literal here because the browser must refuse
 *  BEFORE it dials: a client that dials first and is refused later has already opened a socket it did not need. */
export const RELAY_PAYLOAD_PATHS = Object.freeze([
  '/api/v0/join/info',
  '/api/v0/join/nearby',
  '/api/v0/join/request',
  '/api/v0/join/status',
  '/api/v0/join/exchange',
  '/api/v0/device/session',
]);

export const RELAY_DIAL_TIMEOUT_MS = 8000;
export const RELAY_FORWARD_TIMEOUT_MS = 20000;

const subprotocolEncoder = value => String(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The subprotocols a dial carries. The credential travels here rather than in a URL, for the same reason the
 *  events stream does it: a browser WebSocket cannot set an Authorization header, and a token in a query string
 *  ends up in logs. */
export function relaySubprotocols({ credential = null } = {}) {
  const protocols = ['city-relay-v0'];
  if (typeof credential === 'string' && credential !== '') protocols.push('city-token.' + subprotocolEncoder(relayBasicEncode(credential)));
  return protocols;
}

// btoa exists in browsers and in Node >= 16; the fallback keeps this module importable in a bare test run.
function relayBasicEncode(value) {
  if (typeof btoa === 'function') return btoa(value);
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Executes a request the City pushed down the pipe, against the City it belongs to, and answers up the pipe.
 *
 * THE ADDRESS IS CHOSEN BY THE CITY, NOT BY THIS CLIENT, and that is a trust decision rather than a convenience:
 * the payload is answered by mailing it to a URL, so a client that invented the address could be pointed at any
 * host on the internet. The City sends `url` when the payload does not run on the City this pipe is dialled to
 * (the two-City case: the peer that joins is registered with the RELAY, and the City that must approve it lives
 * elsewhere), and this function refuses to send a body anywhere that is not on that exact origin.
 */
async function servePushedRequest({ frame, doRequest, timeoutMs, fallbackOrigin = null }) {
  const path = new URL(String(frame.path ?? '/'), 'http://relay');
  const relative = `${path.pathname}${path.search}`;
  let target = relative;
  if (typeof frame.url === 'string' && frame.url !== '') {
    try { target = new URL(frame.url).origin + relative; }
    // A pushed `url` that is not a URL is a refusal, not a crash: the answer travels back as a typed 400 so the
    // waiting City learns why instead of waiting for a reply that can never be sent.
    catch { return { ok: false, status: 400, payload: null, error: 'the pushed payload named a url that is not a URL' }; }
  } else if (typeof location === 'undefined') {
    // No page and no declared url: fall back to the address this pipe was DIALED to, which is the City that will
    // answer. That is the honest reading of a relative path here, and it keeps a headless peer usable.
    target = fallbackOrigin + relative;
  }
  const verb = String(frame.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  let ok = false;
  let status = 502;
  let payload = null;
  let error = null;
  try {
    const response = await doRequest(target, {
      method: verb,
      headers: { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
      ...(verb === 'GET' ? {} : { body: JSON.stringify(frame.body ?? {}) }),
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    status = response.status;
    payload = await response.json().catch(() => null);
    ok = response.ok === true;
    if (!ok) error = payload?.error ?? `the City answered ${status}`;
  } catch (failure) {
    status = 502;
    error = String(failure?.message ?? failure);
  }
  return { ok, status, payload, error };
}

function socketUrl({ host, port = null, secure = false, scheme = null }) {
  const protocol = secure || scheme === 'https' || scheme === 'wss' ? 'wss' : 'ws';
  const bare = String(host ?? '').replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
  if (bare === '') throw new RelayDialError('RELAY_NO_TARGET', 'no relay host was given to dial', { fallback: false });
  const withPort = /:\d+$/.test(bare) || port === null ? bare : `${bare}:${Number(port)}`;
  return `${protocol}://${withPort}${RELAY_DIAL_PATH}?apiVersion=0&schemaVersion=0`;
}

const answerKey = url => `${url.pathname}${url.search}`;

function readFrame(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return String(data ?? '');
}

/** Normalise the answer a forwarded request resolves with, so callers can rely on ONE shape.
 *
 *  TWO SHAPES ARRIVE HERE, and that is a fact about the transport rather than a caller's business. A City that
 *  pushes a payload on a peer's behalf answers with its own HTTP status (`{ok,status,payload}`); a City answering a
 *  payload it ran itself answers with a full relay answer (`{ok,status,response:{ok,status,payload}}`). Returning
 *  whichever arrived made `answer.response.status` undefined for exactly the first case, so the normaliser accepts
 *  both and states the one shape it returns.
 */
function readAnswer(frame) {
  const inner = frame?.response;
  const nested = inner && typeof inner === 'object' && !Array.isArray(inner) && 'ok' in inner && ('payload' in inner || 'status' in inner);
  const ok = nested ? inner.ok === true : frame?.ok === true;
  const status = nested ? (inner.status ?? (inner.ok ? 200 : 502)) : (Number.isFinite(frame?.status) ? frame.status : (ok ? 200 : 502));
  const payload = nested ? (inner.payload ?? null) : (frame?.payload ?? null);
  return Object.freeze({
    kind: 'relay-answer',
    requestId: frame?.requestId ?? null,
    ok,
    status,
    response: Object.freeze({ ok, status, payload }),
    ...(frame?.error ? { error: String(frame.error) } : {}),
  });
}

/**
 * Dial a City's relay endpoint and wait until IT says the peer is registered.
 *
 * The wait is on the City's own `RELAY_READY` frame rather than on `open`: a socket that opened and was then refused
 * by the admission policy must not look like a working path, and the refusal has to arrive as a typed error the
 * surface can report.
 *
 * A FORWARDED REQUEST GOES TO THE CITY THE PIPE BELONGS TO, and that is not always the page we are on. When this
 * page was served by the same City, the relative URL is already that City; when it was not (a client on City A
 * joining City B), sending the payload to `location.origin` would ask the WRONG owner to approve. So the target is
 * derived from the dialled host and passed explicitly, and the address is reported back so the surface can tell
 * "collect this credential here" from "this credential belongs to another City".
 *
 * @returns {Promise<{city: object, peerRef: string|null, verified: boolean, role: string, send: Function, close: Function, forward: Function}>}
 */
export function dialRelay({
  host = null,
  port = null,
  secure = false,
  scheme = null,
  cityOrigin = null,
  /** THIS peer's own origin, declared for the City's audit trail and for a City-to-City pipe. */
  clientUrl = null,
  installationId = null,
  label = null,
  credential = null,
  WebSocketImpl = null,
  fetchImpl = null,
  handshakeTimeoutMs = RELAY_DIAL_TIMEOUT_MS,
  forwardTimeoutMs = RELAY_FORWARD_TIMEOUT_MS,
} = {}) {
  const url = socketUrl({ host, port, secure, scheme });
  const target = new URL(url);
  const Socket = WebSocketImpl ?? (typeof WebSocket === 'function' ? WebSocket : null);
  if (!Socket) return Promise.reject(new RelayDialError('RELAY_UNSUPPORTED', 'this client has no WebSocket implementation', { fallback: false }));
  const doRequest = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!doRequest) return Promise.reject(new RelayDialError('RELAY_UNSUPPORTED', 'this client has no way to make the forwarded request', { fallback: false }));

  // Where the forwarded request is executed. `window.location.origin` first (a browser), then the page's own base
  // URI so this module also works under a non-browser test harness.
  const pageOrigin = cityOrigin    ?? (typeof location !== 'undefined' && location?.origin ? location.origin : null)
    ?? (typeof document !== 'undefined' && document?.baseURI ? new URL(document.baseURI).origin : null)
    ?? null;
  const targetPort = Number(target.port || (target.protocol === 'wss:' ? 443 : 80));
  const sameOrigin = pageOrigin !== null && (() => {
    try { const page = new URL(pageOrigin); return page.hostname === target.hostname && Number(page.port || (page.protocol === 'https:' ? 443 : 80)) === targetPort; } catch { return false; }
  })();
  // Same origin -> keep the relative URL, which is what a browser page behind that City can send. Otherwise say
  // explicitly which City this payload belongs to.
  const endpointBase = sameOrigin ? '' : `${target.protocol === 'wss:' ? 'https' : 'http'}://${target.host}`;
  const resolveTarget = path => (endpointBase === '' ? path : endpointBase + path);

  const params = [];
  if (installationId) params.push(`installationId=${encodeURIComponent(installationId)}`);
  if (label) params.push(`label=${encodeURIComponent(label)}`);
  // Declared for the City's own audit trail and for a City-to-City pipe: it is where THIS peer's City lives. It is
  // not an address the City will call - a relayed payload runs on the City that received it, never on the dialling
  // peer, which is the machine with no route to anything.
  const declaredClientUrl = typeof clientUrl === 'string' && clientUrl !== '' ? clientUrl : pageOrigin;
  if (declaredClientUrl) params.push(`clientUrl=${encodeURIComponent(declaredClientUrl)}`);
  const dialUrl = params.length ? `${url}&${params.join('&')}` : url;

  return new Promise((resolve, reject) => {
    let socket;
    try { socket = new Socket(dialUrl, relaySubprotocols({ credential })); } catch (error) { reject(new RelayDialError('RELAY_UNREACHABLE', String(error?.message ?? error))); return; }
    if ('binaryType' in socket) { try { socket.binaryType = 'arraybuffer'; } catch { /* a socket that refuses this still delivers text */ } }

    const inFlight = new Map();
    let settled = false;
    let closed = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already gone */ }
      reject(error);
    };
    const handshake = setTimeout(() => fail(new RelayDialError('RELAY_TIMEOUT', `no relay-ready frame within ${handshakeTimeoutMs} ms`)), handshakeTimeoutMs);
    handshake.unref?.();

    /** Send one forwarded request and settle with the answer the City produced for it. */
    const forward = (path, body = {}, { timeoutMs = forwardTimeoutMs, method = 'POST' } = {}) =>
      new Promise((resolveForward, rejectForward) => {
        const wanted = typeof path === 'string' && path.startsWith('/') ? path : '/' + String(path ?? '');
        const parsed = new URL(wanted, 'http://relay');
        if (!RELAY_PAYLOAD_PATHS.includes(parsed.pathname)) {
          rejectForward(new RelayDialError('RELAY_PATH_REFUSED', `the relay does not carry ${parsed.pathname}`, { status: 403, fallback: false }));
          return;
        }
        if (closed) { rejectForward(new RelayDialError('RELAY_DIAL_CLOSED', 'this relay connection is closed')); return; }
        const requestId = `dial-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const timer = setTimeout(() => {
          inFlight.delete(requestId);
          rejectForward(new RelayDialError('RELAY_TIMEOUT', `the relay did not answer ${parsed.pathname} within ${timeoutMs} ms`, { status: 504 }));
        }, timeoutMs);
        timer.unref?.();
        inFlight.set(requestId, { resolve: resolveForward, reject: rejectForward, timer, path: parsed.pathname });
        try { socket.send(JSON.stringify({ kind: 'relay-request', requestId, path: parsed.pathname, method: String(method).toUpperCase() === 'GET' ? 'GET' : 'POST', body: body ?? {} })); }
        catch (error) {
          clearTimeout(timer);
          inFlight.delete(requestId);
          rejectForward(new RelayDialError('RELAY_SEND_FAILED', String(error?.message ?? error)));
        }
      });

    /**
     * The City pushed a request down the pipe. It is executed against the City it belongs to - the SAME route the
     * peer would have called over HTTP if it could - and the answer (status included) goes back up the pipe. A
     * failure is answered as a failure rather than dropped, so the other end never waits for a reply that is not
     * coming.
     */
    const serve = async frame => {
      const { ok, status, payload } = await servePushedRequest({ frame, doRequest, timeoutMs: forwardTimeoutMs, fallbackOrigin: endpointBase !== '' ? endpointBase : (pageOrigin ?? null) });
      // The City's own status travels in `response`; `error` is deliberately NOT set here, because an answer that
      // carries both would be read as a transport failure by the waiting side and the City's real status (a 403,
      // a 410) would be flattened into "the relay failed" - the exact confusion this field split exists to avoid.
      try { socket.send(JSON.stringify({ kind: 'relay-answer', requestId: frame.requestId, ok, status, response: { ok, status, payload } })); }
      catch { /* the City's end is gone; its pending request will time out on its side */ }
    };

    const onFrame = raw => {
      let frame = null;
      try { frame = JSON.parse(raw); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'RELAY_READY') {
        if (settled) return;
        settled = true;
        clearTimeout(handshake);
        resolve(Object.freeze({
          city: { host: target.hostname, port: targetPort, origin: endpointBase === '' ? (pageOrigin ?? null) : endpointBase, sameOrigin, endpoint: `${target.protocol}//${target.host}` },
          peerRef: typeof frame.peerRef === 'string' ? frame.peerRef : null,
          verified: frame.verified === true,
          role: typeof frame.role === 'string' ? frame.role : 'unknown',
          forward,
          send: frameToSend => { socket.send(JSON.stringify(frameToSend)); },
          close: () => { closed = true; try { socket.close(); } catch { /* already gone */ } },
        }));
        return;
      }
      // A request the City is pushing DOWN this pipe, executed on the City this client dialled.
      if (frame.kind === 'relay-push' && typeof frame.requestId === 'string') { serve(frame); return; }
      // An answer to something this client forwarded up. The CALLER re-checks `ok`: a City that answered 403 is a
      // successful forward carrying a refusal, and flattening the two would make every refusal look like a fault.
      const waiting = inFlight.get(frame.requestId);
      if (!waiting) return;
      inFlight.delete(frame.requestId);
      clearTimeout(waiting.timer);
      // A frame WITH a `response` is the City's own HTTP answer, refusal included: that belongs to the caller as a
      // status, not as a transport failure. Only a frame with no response at all is a pipe-level error.
      if (!frame.response && frame.error) waiting.reject(new RelayDialError('RELAY_REMOTE_ERROR', String(frame.error), { status: Number.isFinite(frame.status) ? frame.status : 502 }));
      else waiting.resolve(readAnswer(frame));
    };

    // ONE message path, deliberately. The first draft wired `onmessage` AND `addEventListener` for two different
    // frame directions, which delivered every frame twice - a pushed request would have been executed twice and a
    // forwarded answer would have settled a request that had already settled.
    const onMessage = event => { if (event?.data !== undefined) onFrame(readFrame(event.data)); };
    socket.onmessage = onMessage;
    socket.onerror = () => fail(new RelayDialError('RELAY_UNREACHABLE', `could not reach the relay at ${target.host}`));
    socket.onclose = () => {
      closed = true;
      fail(new RelayDialError('RELAY_DIAL_CLOSED', 'the relay connection closed before it was ready'));
      for (const [, waiting] of inFlight) { clearTimeout(waiting.timer); waiting.reject(new RelayDialError('RELAY_DIAL_CLOSED', `the relay connection closed while ${waiting.path} was in flight`)); }
      inFlight.clear();
    };
  });
}
