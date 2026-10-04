// The transport behind `relay-in-city`: a City accepts an OUTBOUND connection from a peer that cannot be dialled,
// and forwards join requests over it.
//
// THE PROBLEM THIS SOLVES, PRECISELY. Two PCs on different networks are both behind NAT: neither can accept an
// inbound connection, so neither can call the other's join route - there is no path. Every NAT, however, permits
// OUTBOUND connections. So the peer that cannot be dialled dials OUT to a City that IS reachable, and that City
// pushes the join request down the connection the peer opened. Nothing new is trusted: the connection carries the
// SAME join requests the HTTP route carries, the same one-time claim authorises them, and approval still happens on
// an already trusted surface. The relay is a pipe, not an authority.
//
// WHERE THE MESSAGE SHAPES COME FROM: they are not invented here. `encode`/`decode` are INJECTED, so this module
// can be driven with plain objects in a test, and the wire format stays one decision made in one place instead of
// being spread across the transport and the UI. The default JSON codec is deliberately trivial.
//
// WHAT IT REFUSES TO DO:
//   * no unauthenticated peer may register: `admit` is checked before a connection is accepted into the table;
//   * one connection per peer ref, so a second dial replaces the first rather than creating a second identity;
//   * a forwarded request that nobody answers FAILS with a typed timeout instead of hanging for ever;
//   * nothing is buffered without bound: `maxPending` caps in-flight requests, and the cap is a refusal, not a queue.
//
// WHAT MAY TRAVEL OVER THE PIPE (added with S1, the WebSocket接线): forwarding is restricted to a NAMED list of
// payloads - the join handshake and the tokenless reconnect - and nothing else. This is the difference between a
// pipe and an open proxy: a peer cannot ask the City to run an arbitrary route through it, and it cannot hand the
// pipe a URL for some third machine. The payloads themselves are the EXISTING HTTP payloads (same field names as
// `join.request` / `join.status` / `join.exchange` and the enrollment session request), so the relay introduces no
// second wire shape and no second credential: whoever answers a forwarded request answers it with the City's own
// route, on an already trusted surface.

export const DEFAULT_RELAY_LIMITS = Object.freeze({ maxPending: 32, requestTimeoutMs: 15000, maxPeers: 64 });

export class RelayError extends Error {
  constructor(code, detail, status = 503) {
    super(`${code}: ${detail}`);
    this.name = 'RelayError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

const jsonCodec = Object.freeze({
  encode: value => JSON.stringify(value),
  decode: text => JSON.parse(String(text)),
});

/**
 * @param {object} options
 *   `admit`   - `(hello) => ({accepted: boolean, reason?: string, peerRef?: string})`. THE trust boundary: a City
 *               decides who may register as a relay peer, and this module never assumes the answer.
 *   `now`     - injected clock, so a timeout is testable without waiting.
 */
export function createRelayHub({ admit = () => ({ accepted: false, reason: 'no_admission_policy' }), clock = Date.now, limits = DEFAULT_RELAY_LIMITS, codec = jsonCodec } = {}) {
  const cap = { ...DEFAULT_RELAY_LIMITS, ...limits };
  /** peerRef -> { send, close, connectedAt, label } */
  const peers = new Map();
  /** requestId -> { resolve, reject, timer, peerRef } */
  const pending = new Map();
  let closed = false;

  const stats = () => Object.freeze({ peers: peers.size, pending: pending.size, closed });

  function register({ peerRef, label = null, send, close = () => {} }) {
    if (closed) throw new RelayError('RELAY_CLOSED', 'this City is no longer accepting relay peers');
    if (typeof peerRef !== 'string' || peerRef === '') throw new RelayError('MALFORMED_PEER', 'a relay peer needs a peer ref', 400);
    if (typeof send !== 'function') throw new RelayError('MALFORMED_PEER', 'a relay peer needs a way to be sent to', 400);
    if (!peers.has(peerRef) && peers.size >= cap.maxPeers) throw new RelayError('RELAY_FULL', `at most ${cap.maxPeers} relay peers are accepted`);
    // A re-dial REPLACES the previous connection for that ref: a peer that reconnected must not end up with two
    // live pipes, one of which nobody will ever read again.
    const previous = peers.get(peerRef);
    if (previous) { try { previous.close(); } catch { /* the old socket is already gone */ } }
    const entry = Object.freeze({ peerRef, label, send, close, connectedAt: new Date(clock()).toISOString() });
    peers.set(peerRef, entry);
    return entry;
  }

  function unregister(peerRef) {
    const had = peers.delete(peerRef);
    return had;
  }

  /**
   * Accept a peer that dialled in: the admission decision is the City's, and a refusal is a typed error rather than
   * a silent drop, so the dialling side can say WHY it was turned away.
   */
  function accept(hello, transport) {
    const verdict = admit(hello ?? {}) ?? {};
    if (verdict.accepted !== true) throw new RelayError('RELAY_REFUSED', verdict.reason ?? 'this City did not admit the peer', 403);
    return register({ peerRef: verdict.peerRef ?? hello?.peerRef, label: hello?.label ?? null, ...transport });
  }

  /**
   * What a client on the far side calls: forward one join request to a peer and wait for its answer.
   *
   * `requestId` is an OPTION and used to be ignored - the signature accepted `{timeoutMs}` and nothing else, so a
   * caller that passed its own id got an auto-generated one instead. That single missing field made the two-City
   * relay fail while looking healthy: the push carried a generated id, the answering peer echoed THAT id, and the
   * caller waiting on its own id was told NO_SUCH_REQUEST.
   */
  function forward(peerRef, request, { timeoutMs = cap.requestTimeoutMs, requestId = undefined } = {}) {
    const peer = peers.get(peerRef);
    if (!peer) throw new RelayError('RELAY_PEER_ABSENT', `peer ${peerRef} is not connected to this City`, 404);
    if (pending.size >= cap.maxPending) throw new RelayError('RELAY_BUSY', `at most ${cap.maxPending} forwarded requests may be in flight`);
    const id = typeof requestId === 'string' && requestId !== '' ? requestId : (request?.requestId ?? `relay-${clock()}-${Math.random().toString(36).slice(2, 10)}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RelayError('RELAY_TIMEOUT', `peer ${peerRef} did not answer within ${timeoutMs} ms`, 504));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, peerRef });
      // The frame KIND is direction-specific (`relay-push` down to the peer, `relay-request` up from it, `relay-answer`
      // back down). One shared name for both directions was the first attempt and it deadlocked every forward: the
      // City read its own pushed request returning as "another City wants to forward through me".
      try {
        peer.send(codec.encode({ kind: 'relay-push', requestId: id, ...request }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new RelayError('RELAY_SEND_FAILED', `the connection to ${peerRef} could not be written: ${error?.message ?? error}`));
      }
    });
  }

  /** The far side's answer. An answer nobody is waiting for is DROPPED, not buffered: it is either a duplicate or a
   *  reply to a request that already timed out, and neither is worth keeping. */
  function settle(peerRef, message) {
    const requestId = message?.requestId;
    const entry = typeof requestId === 'string' ? pending.get(requestId) : undefined;
    if (!entry || entry.peerRef !== peerRef) return { settled: false, reason: 'NO_SUCH_REQUEST' };
    clearTimeout(entry.timer);
    pending.delete(requestId);
    if (message?.error) entry.reject(new RelayError('RELAY_REMOTE_ERROR', String(message.error), 502));
    else entry.resolve(message?.response ?? null);
    return { settled: true };
  }

  /**
   * Deliver an answer to a request that is waiting on a SPECIFIC peer, without the caller having to reproduce the
   * (requestId, peerRef) pair `settle` matches on.
   *
   * WHY THIS EXISTS. The relay needs TWO live waits at once - the peer that asked, and this City waiting on the peer
   * it pushed to - and the first version tried to serve both with `settle` plus a reused id. `settle` refuses an
   * answer whose ref does not match the waiting request, so the answer destined for the ASKING peer was measured
   * against the OUTGOING push's entry, reported NO_SUCH_REQUEST, and the asking peer timed out while the relay's own
   * logs said the forward had succeeded. Naming the target explicitly removes that class of mistake.
   */
  function respond(peerRef, requestId, { response, error } = {}) {
    const entry = typeof requestId === 'string' ? pending.get(requestId) : undefined;
    if (!entry || entry.peerRef !== peerRef) return { delivered: false, reason: 'NO_SUCH_REQUEST' };
    clearTimeout(entry.timer);
    pending.delete(requestId);
    if (error) entry.reject(new RelayError('RELAY_REMOTE_ERROR', String(error), 502));
    else entry.resolve(response ?? null);
    return { delivered: true };
  }

  /**
   * Write a frame straight down a peer's pipe.
   *
   * WHY THIS IS SEPARATE FROM `respond`. `respond` settles a wait THIS City made with `forward`. The dialling peer's
   * wait lives in ITS OWN table (`relay-dial`'s `inFlight`), so nothing on this side can settle it - the only way to
   * answer such a peer is to WRITE TO IT. The first version tried `respond` for both, which is why a request that
   * had been forwarded perfectly (the target answered 200, the relay logged the forward) still timed out at the
   * caller: the answer had nowhere to go, because the caller's wait was never in this City's table.
   */
  function deliver(peerRef, frame) {
    const peer = peers.get(peerRef);
    if (!peer) return { delivered: false, reason: 'RELAY_PEER_ABSENT' };
    try { peer.send(codec.encode(frame)); return { delivered: true }; }
    catch (error) { return { delivered: false, reason: `RELAY_SEND_FAILED: ${error?.message ?? error}` }; }
  }

  function close() {
    closed = true;
    for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new RelayError('RELAY_CLOSED', 'this City is shutting down')); }
    pending.clear();
    for (const [, peer] of peers) { try { peer.close(); } catch { /* already gone */ } }
    peers.clear();
  }

  return Object.freeze({
    accept,
    register,
    unregister,
    forward,
    respond,
    deliver,
    settle,
    close,
    stats,
    listPeers: () => Object.freeze([...peers.values()].map(p => Object.freeze({ peerRef: p.peerRef, label: p.label, connectedAt: p.connectedAt }))),
    limits: Object.freeze(cap),
  });
}

// --- the payload policy ------------------------------------------------------------------------------------
//
// THE LIST IS THE POLICY, and it is short on purpose. Every entry is an EXISTING route whose caller already needs
// nothing but what the joining PC can honestly hold: the four join-handshake routes (JOIN-502) and the one
// tokenless-session route (JOIN-503). Absent from the list, and therefore refused with a typed error rather than
// silently dropped: everything under /api/v0/node/, /api/v0/tasks, /api/v0/capabilities, the City snapshot and the
// event stream. Those need an owner or installation credential the dialling peer has not got, so forwarding them
// would only move a 401 around - except for the event stream, which is a control surface and is not a payload.
export const RELAY_PAYLOAD_PATHS = Object.freeze([
  '/api/v0/join/info',
  '/api/v0/join/nearby',
  '/api/v0/join/request',
  '/api/v0/join/status',
  '/api/v0/join/exchange',
  '/api/v0/device/session',
]);

/** Bigger than any honest join payload, smaller than anything worth buffering. A refusal, not a truncation. */
export const DEFAULT_RELAY_MESSAGE_BYTES = 65536;

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Is this a payload the relay will carry? The check is deliberately a WHITELIST against a fixed list of literal
 * paths, and the path must be relative: an absolute URL here would turn the City into a proxy for a third machine,
 * which is the one thing this module exists NOT to be.
 */
export function isRoutableRelayPayload(payload = {}) {
  if (!isPlainObject(payload)) return false;
  if (typeof payload.path !== 'string' || !RELAY_PAYLOAD_PATHS.includes(payload.path)) return false;
  if (isPlainObject(payload.body) && Object.prototype.hasOwnProperty.call(payload.body, 'url')) return false;
  return true;
}

/**
 * Route one absolute-URL request through the relay.
 *
 * `request` is injected - the server passes `globalThis.fetch` - so this module keeps no opinion about how HTTP is
 * done and stays drivable in a test with a plain function. The answer goes back down the SAME pipe, wrapped in the
 * relay's answer shape, and the caller's own HTTP status travels with it: a forwarded 403 must reach the dialling
 * peer as a 403, or the join UI would report "unreachable" where the honest answer is "the owner refused".
 */
export async function forwardRequestOverRelay({ relay, peerRef, path, method = 'POST', body = null, request, timeoutMs = DEFAULT_RELAY_LIMITS.requestTimeoutMs, requestId = undefined }) {
  if (!relay || typeof relay.forward !== 'function') throw new RelayError('RELAY_MISCONFIGURED', 'forwarding needs a relay hub', 500);
  if (typeof request !== 'function') throw new RelayError('RELAY_MISCONFIGURED', 'forwarding needs a way to make the request', 500);
  const target = new URL(path.startsWith('/') ? path : '/' + path, 'http://city');
  if (!isRoutableRelayPayload({ path: target.pathname })) throw new RelayError('RELAY_PATH_REFUSED', `the relay does not carry ${target.pathname}`, 403);
  // The METHOD travels with the payload: `join/request` is a POST and `join/info` is a GET, and a pipe that forced
  // one of them on both would answer 404 for the other while looking perfectly healthy.
  const verb = String(method ?? 'POST').toUpperCase();
  if (!['GET', 'POST'].includes(verb)) throw new RelayError('RELAY_METHOD_REFUSED', `the relay does not carry ${verb}`, 403);
  const answer = await relay.forward(peerRef, { path: target.pathname, method: verb, body }, { timeoutMs, ...(requestId ? { requestId } : {}) });
  // The answer is VALIDATED, not assumed: a peer that answers with something else fails this request instead of
  // handing the caller `null` and letting it read as "the City said nothing".
  return readRelayAnswer(answer);
}

/**
 * The City side of a relay pipe: decode one frame from a dialled-in peer.
 *
 * TWO DIRECTIONS TRAVEL OVER ONE SOCKET, so the names are direction-specific and checked before anything else:
 *   * `relay-answer`  - an answer to a request THIS City pushed down (`relay.forward`), settled here;
 *   * `relay-request` - a request FROM the dialling peer. THE CITY RUNS IT ITSELF, on its own routes, and writes the
 *     answer back down the pipe.
 *
 * WHY THE CITY RUNS IT, and not "the peer it was forwarded to". The first version pushed the payload on to a peer
 * named in the frame. That produced a flow that LOOKED correct and could never join anybody: the dialling peer is,
 * by definition, the machine that cannot be dialled, so asking it to execute a join ask against another City means
 * asking the one machine with no route to that City to use one. The requester wants to reach THIS City - the
 * reachable one - and this City is therefore the only sensible place for the payload to run.
 *
 * `execute` is injected because the hub knows how to move frames and must not grow a second opinion about the
 * City's routes; a frame is dispatched only after `isRoutableRelayPayload` has approved its path.
 */
export function createRelayDispatcher({ relay, maxBytes = DEFAULT_RELAY_MESSAGE_BYTES, decode = jsonCodec.decode, execute = null } = {}) {
  if (!relay) throw new RelayError('RELAY_MISCONFIGURED', 'a dispatcher needs a relay hub', 500);
  return async function dispatch(peerRef, raw) {
    if (typeof raw === 'string' && raw.length > maxBytes) return { handled: false, reason: 'TOO_LARGE' };
    let message;
    try { message = typeof raw === 'string' ? decode(raw) : raw; } catch { return { handled: false, reason: 'NOT_JSON' }; }
    if (!isPlainObject(message)) return { handled: false, reason: 'NOT_AN_OBJECT' };
    if (typeof message.requestId !== 'string' || message.requestId === '') return { handled: false, reason: 'NO_REQUEST_ID' };

    // ANSWERS FIRST, and the ordering is load-bearing: the first version read `response`/`error` off a frame the
    // peer sent flat, so every forwarded request settled with `null` - the City saw a valid answer, the caller saw
    // `null`, and nothing failed loudly.
    if (message.kind === 'relay-answer') {
      if (!isPlainObject(message.response)) return { handled: false, reason: 'NO_RESPONSE' };
      return relay.settle(peerRef, { requestId: message.requestId, response: message.response, error: message.error });
    }
    if (message.kind !== 'relay-request') return { handled: false, reason: 'UNKNOWN_KIND' };

    const path = (() => { try { return new URL(String(message.path ?? '/'), 'http://city').pathname; } catch { return null; } })();
    const verb = String(message.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
    const refuse = (detail, status) => {
      const answer = relayAnswer({ requestId: message.requestId, ok: false, status, payload: null, error: detail });
      try { relay.deliver(peerRef, { kind: 'relay-answer', requestId: message.requestId, ok: false, status, response: answer.response, error: detail }); } catch { /* the pipe is gone */ }
      return { handled: true, direction: 'refused', reason: detail };
    };
    if (path === null || !isRoutableRelayPayload({ path })) return refuse(`the relay does not carry ${path ?? message.path}`, 403);
    if (typeof execute !== 'function') return refuse('this City has no way to run a relayed payload', 503);

    // THE ANSWER GOES BACK DOWN THE PIPE, never through `settle`: the asking peer's wait lives in ITS OWN table
    // (`relay-dial`'s `inFlight`), so nothing here can settle it - only writing to it can answer it.
    const settleLater = async () => {
      try {
        const result = await execute({ peerRef, path, method: verb, body: message.body ?? {} });
        const ok = result?.ok === true;
        const status = Number.isFinite(result?.status) ? result.status : (ok ? 200 : 502);
        return relay.deliver(peerRef, { kind: 'relay-answer', requestId: message.requestId, ok, status, response: { ok, status, payload: result?.payload ?? null } });
      } catch (error) {
        const status = Number.isFinite(error?.status) ? error.status : 500;
        return relay.deliver(peerRef, { kind: 'relay-answer', requestId: message.requestId, ok: false, status, response: { ok: false, status, payload: null }, error: String(error?.detail ?? error?.message ?? error) });
      }
    };
    return { handled: true, direction: 'executed', path, method: verb, settleLater };
  };
}

/**
 * The answer a dialling peer sends back, stated ONCE so both ends and the tests cannot drift apart.
 *
 * WHAT `ok` MEANS: the FORWARDING succeeded and the City answered. A City that answered 403 is `ok:true` with
 * `response.status === 403` - only a transport failure is `ok:false`. That separation is what lets the surface say
 * "the owner refused" instead of "unreachable".
 *
 * WHY THE CALLER RE-CHECKS `ok`: `relay.settle` resolves with this object whether it carries a 403 or a 200, so
 * the enforced version is `forwardRequestOverRelay`, which refuses a non-response rather than trusting one.
 */
export function relayAnswer({ requestId, ok, status, payload = null, error = null }) {
  if (typeof requestId !== 'string' || requestId === '') throw new RelayError('RELAY_MALFORMED_ANSWER', 'an answer must name the request it answers', 500);
  if (typeof ok !== 'boolean') throw new RelayError('RELAY_MALFORMED_ANSWER', 'an answer needs to say whether it succeeded', 500);
  return Object.freeze({ kind: 'relay-answer', requestId, ok, status: Number.isFinite(status) ? status : (ok ? 200 : 502), response: Object.freeze({ ok, status: Number.isFinite(status) ? status : (ok ? 200 : 502), payload }), ...(error ? { error: String(error) } : {}) });
}

/** Refuse an answer that is not one, with the reason. Used wherever a forwarded answer is consumed. */
export function readRelayAnswer(answer) {
  if (!isPlainObject(answer) || answer.kind !== 'relay-answer' || typeof answer.ok !== 'boolean') throw new RelayError('RELAY_MALFORMED_ANSWER', 'the peer answered with something that is not a response', 502);
  return answer;
}
