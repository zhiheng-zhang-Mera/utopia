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

  /** What a client on the far side calls: forward one join request to a peer and wait for its answer. */
  function forward(peerRef, request, { timeoutMs = cap.requestTimeoutMs } = {}) {
    const peer = peers.get(peerRef);
    if (!peer) throw new RelayError('RELAY_PEER_ABSENT', `peer ${peerRef} is not connected to this City`, 404);
    if (pending.size >= cap.maxPending) throw new RelayError('RELAY_BUSY', `at most ${cap.maxPending} forwarded requests may be in flight`);
    const requestId = request?.requestId ?? `relay-${clock()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new RelayError('RELAY_TIMEOUT', `peer ${peerRef} did not answer within ${timeoutMs} ms`, 504));
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { resolve, reject, timer, peerRef });
      try {
        peer.send(codec.encode({ kind: 'join-forward', requestId, ...request }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
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
    settle,
    close,
    stats,
    listPeers: () => Object.freeze([...peers.values()].map(p => Object.freeze({ peerRef: p.peerRef, label: p.label, connectedAt: p.connectedAt }))),
    limits: Object.freeze(cap),
  });
}
