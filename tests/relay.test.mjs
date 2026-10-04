// The relay transport, without sockets. Every property that matters here is about REFUSING things, because this
// pipe carries join requests for machines that cannot reach each other any other way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RELAY_LIMITS, RelayError, createRelayHub } from '../services/dev-gateway/relay.mjs';

const codec = { encode: v => v, decode: v => v };   // plain objects: the wire format is not what is under test

function hub(over = {}) {
  const sent = [];
  const h = createRelayHub({ admit: hello => (hello?.token === 'ok' ? { accepted: true, peerRef: 'peer-a' } : { accepted: false, reason: 'no_credential' }), codec, ...over });
  return { h, sent, transport: { send: m => sent.push(m), close: () => {} } };
}

test('an admitted peer registers and is listed; a refused one is refused WITH a reason', () => {
  const { h, transport } = hub();
  const entry = h.accept({ token: 'ok', label: 'PC-B' }, transport);
  assert.equal(entry.peerRef, 'peer-a');
  assert.deepEqual(h.listPeers().map(p => p.peerRef), ['peer-a']);
  assert.throws(() => h.accept({ token: 'wrong' }, transport), (e) => e instanceof RelayError && e.code === 'RELAY_REFUSED' && e.status === 403);
  assert.throws(() => h.accept({}, transport), /RELAY_REFUSED/, 'the DEFAULT is refusal, not acceptance');
});

test('a forwarded request reaches the peer and its answer comes back to the caller', async () => {
  const { h, sent, transport } = hub();
  h.accept({ token: 'ok' }, transport);
  const promise = h.forward('peer-a', { requestId: 'r1', path: '/api/v0/join/request', body: { displayName: 'X' } });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { kind: 'join-forward', requestId: 'r1', path: '/api/v0/join/request', body: { displayName: 'X' } });
  assert.deepEqual(h.settle('peer-a', { requestId: 'r1', response: { accepted: true } }), { settled: true });
  assert.deepEqual(await promise, { accepted: true });
  assert.equal(h.stats().pending, 0, 'the slot is released');
});

test('forwarding to a peer that is not connected is a typed 404, not a hang', () => {
  const { h } = hub();
  assert.throws(() => h.forward('nobody', { requestId: 'r' }), (e) => e.code === 'RELAY_PEER_ABSENT' && e.status === 404);
});

test('a peer that never answers produces a TIMEOUT rather than an unbounded wait', async () => {
  let t = 0;
  const { h, transport } = hub({ clock: () => t, limits: { requestTimeoutMs: 50 } });
  h.accept({ token: 'ok' }, transport);
  const promise = h.forward('peer-a', { requestId: 'r-timeout' });
  t += 100;
  await assert.rejects(promise, (e) => e.code === 'RELAY_TIMEOUT' && e.status === 504);
  assert.equal(h.stats().pending, 0, 'and the slot is released by the failure');
});

test('the in-flight cap is a REFUSAL, not a queue', () => {
  const { h, transport } = hub({ limits: { maxPending: 1 } });
  h.accept({ token: 'ok' }, transport);
  h.forward('peer-a', { requestId: 'r1' });
  assert.throws(() => h.forward('peer-a', { requestId: 'r2' }), (e) => e.code === 'RELAY_BUSY');
});

test('an answer nobody is waiting for is dropped, and an answer from the WRONG peer is not accepted', async () => {
  const { h, transport } = hub();
  h.accept({ token: 'ok' }, transport);
  const promise = h.forward('peer-a', { requestId: 'r1' });
  assert.deepEqual(h.settle('peer-b', { requestId: 'r1', response: 'stolen' }), { settled: false, reason: 'NO_SUCH_REQUEST' }, 'another peer cannot answer for mine');
  assert.deepEqual(h.settle('peer-a', { requestId: 'unknown', response: 'late' }), { settled: false, reason: 'NO_SUCH_REQUEST' });
  h.settle('peer-a', { requestId: 'r1', response: 'mine' });
  assert.equal(await promise, 'mine');
});

test('a peer answering with an error rejects the caller with that error, typed', async () => {
  const { h, transport } = hub();
  h.accept({ token: 'ok' }, transport);
  const promise = h.forward('peer-a', { requestId: 'r1' });
  h.settle('peer-a', { requestId: 'r1', error: 'that City refused the request' });
  await assert.rejects(promise, (e) => e.code === 'RELAY_REMOTE_ERROR' && /refused/.test(e.detail));
});

test('a re-dial REPLACES the old connection for that peer rather than leaving two live pipes', () => {
  const { h, transport } = hub();
  let closedOld = false;
  h.accept({ token: 'ok' }, { send: () => {}, close: () => { closedOld = true; } });
  const second = { send: () => {}, close: () => {} };
  h.register({ peerRef: 'peer-a', send: second.send, close: second.close });
  assert.equal(closedOld, true, 'the superseded socket is closed');
  assert.equal(h.listPeers().length, 1, 'and the peer is still ONE peer');
});

test('the peer cap and close() are both refusals rather than silent behaviour', async () => {
  const { h, transport } = hub({ limits: { maxPeers: 1 } });
  h.accept({ token: 'ok' }, transport);
  const other = createRelayHub({ admit: () => ({ accepted: true, peerRef: 'peer-b' }), codec });
  assert.equal(other.limits.maxPeers, DEFAULT_RELAY_LIMITS.maxPeers, 'limits are readable');
  assert.throws(() => h.register({ peerRef: 'peer-b', send: () => {} }), (e) => e.code === 'RELAY_FULL');
  const pendingPromise = h.forward('peer-a', { requestId: 'r1' });
  h.close();
  await assert.rejects(pendingPromise, (e) => e.code === 'RELAY_CLOSED');
  assert.equal(h.stats().peers, 0);
  assert.throws(() => h.register({ peerRef: 'peer-c', send: () => {} }), (e) => e.code === 'RELAY_CLOSED');
});

test('a write that throws fails THAT request instead of corrupting the hub', async () => {
  const { h } = hub();
  h.register({ peerRef: 'peer-a', send: () => { throw new Error('socket gone'); } });
  await assert.rejects(h.forward('peer-a', { requestId: 'r1' }), (e) => e.code === 'RELAY_SEND_FAILED');
  assert.equal(h.stats().pending, 0);
});
