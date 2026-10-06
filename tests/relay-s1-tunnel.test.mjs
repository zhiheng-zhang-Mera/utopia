// S1 + S2 + S3: the relay PIPE, end to end.
//
// WHY THIS FILE EXISTS. `relay.mjs` was already a tested transport and `choosePath` already answered
// `relay-in-city`, but NOTHING DIALLED IT - the decision could name a mechanism that did not exist. This file
// covers the two halves that make it real: the City accepting a dialled-in peer and RUNNING a join payload for it
// (S1), and the client that dials and forwards an EXISTING join payload over the pipe (S2/S3).
//
// THE EXECUTION MODEL, WHICH THIS FILE PINS: a relayed payload runs ON THE CITY THAT RECEIVED IT. The dialling peer
// is the machine that cannot be dialled, so asking it to execute a join ask against another City would be asking the
// one machine with no route to that City to use one - a flow that looks correct and joins nobody. An earlier
// revision did exactly that ("push it to the target peer"); it is recorded here so the regression cannot come back
// quietly.
//
// WHAT ELSE IS PINNED: the pipe is not an open proxy (a named payload list, checked at both ends); approval still
// happens on the City's own authenticated surface and the pipe records nothing on the peer's behalf; an
// unresolvable presented credential is refused rather than demoted to anonymous; and a request that never stops is
// rate-limited rather than allowed to fill the City's pending table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { RelayDialError, RELAY_PAYLOAD_PATHS, dialRelay } from '../apps/web/relay-dial.mjs';
import { RELAY_PAYLOAD_PATHS as SERVER_PAYLOAD_PATHS } from '../services/dev-gateway/relay.mjs';
import { joinCityOverRelay, reachForRow, relayTargetFor } from '../apps/web/relay-join.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const CONTROL = 'relay-s1-control';
const NODE = 'relay-s1-node';
const RELAY_PATHS = '/api/v0/relay?apiVersion=0&schemaVersion=0';

// `RELAY_PATHS` already opens the query string. Anything appended REPLACES a parameter of the same name rather than
// being appended after it: `?apiVersion=0&…&apiVersion=9` reads back as 0 (the first wins), so the malformed-version
// case silently became a VALID handshake and the assertion that it was refused failed for the wrong reason.
const wsUrl = (url, extra = '') => {
  const base = `${url.replace(/^http/, 'ws')}${RELAY_PATHS}`;
  if (!extra) return base;
  const merged = new URLSearchParams(base.split('?')[1] ?? '');
  for (const [key, value] of new URLSearchParams(extra.replace(/^\?/, ''))) merged.set(key, value);
  return `${base.split('?')[0]}?${merged.toString()}`;
};

const post = async (url, path, body, credential = null) => {
  const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...V, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** The enrollment route's own field names, read where the route defines them rather than guessed: the durable
 *  secret lives under `credential`, while `installation` carries the identity. A fixture that read the wrong one
 *  produced "credentialId must be a non-empty string" and proved nothing about admission. */
const enrollmentFixture = async (url, displayName) => {
  const enrolled = await post(url, '/api/v0/device/enroll', { displayName, platform: 'Win32' }, CONTROL);
  const block = enrolled.body?.credential ? { ...enrolled.body.installation, ...enrolled.body.credential } : null;
  if (!block?.credentialId) throw new Error(`the enroll fixture read nothing usable: ${JSON.stringify(enrolled.body).slice(0, 200)}`);
  return block;
};

const waitFor = async (predicate, { timeoutMs = 5000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, 25));
  }
};

const closeQuietly = socket => { try { socket?.close(); } catch { /* already gone */ } };

/** One shape for a forwarded answer, whichever side produced it. Mirrors `relay-dial`'s own normaliser so the two
 *  cannot drift: a City answering a payload it RAN says `{ok,status,payload}`, while one answering through the pipe
 *  says `{response:{…}}`. Assertions should not have to know which road the answer took. */
const readAnswer = frame => {
  const inner = frame?.response;
  const nested = inner && typeof inner === 'object' && !Array.isArray(inner) && 'ok' in inner && ('payload' in inner || 'status' in inner);
  const ok = nested ? inner.ok === true : frame?.ok === true;
  const status = nested ? (inner.status ?? (inner.ok ? 200 : 502)) : (Number.isFinite(frame?.status) ? frame.status : (ok ? 200 : 502));
  return { ok, status, payload: nested ? (inner.payload ?? null) : (frame?.payload ?? null) };
};

/**
 * A hand-rolled relay peer: enough to speak the wire contract directly and assert what the City does with it.
 *
 * `answers: true` makes it behave like `relay-dial` does - execute a payload the City PUSHES down the pipe against
 * the City that sent it, and answer up the same socket. A relayed REQUEST it sends up needs no answer from it: the
 * City runs that itself.
 */
async function manualPeer(url, { credential = null, installationId = 'install-peer-b', label = 'Peer B', query = {}, answers = true, clientUrl = null } = {}) {
  const { WebSocket } = await import('ws');
  // An EMPTY installationId means "declare no ref at all", which is the refusal case - so the parameter is omitted
  // rather than sent empty, because an empty string and a missing ref are not the same fact to the admission policy.
  const params = new URLSearchParams({ ...query, label, ...(installationId ? { installationId } : {}) });
  if (clientUrl) params.set('clientUrl', clientUrl);
  const protocols = ['city-relay-v0', ...(credential ? [`city-token.${Buffer.from(credential).toString('base64url')}`] : [])];
  const socket = new WebSocket(wsUrl(url, `?${params.toString()}`), protocols);
  const frames = [];
  socket.on('message', async raw => {
    let frame = null;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    frames.push(frame);
    if (!answers || frame?.kind !== 'relay-push') return;
    const verb = String(frame.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
    const base = typeof frame.url === 'string' && frame.url !== '' ? new URL(frame.url).origin : url;
    const r = await fetch(new URL(frame.path, base).toString(), {
      method: verb,
      headers: { 'Content-Type': 'application/json', ...V },
      ...(verb === 'GET' ? {} : { body: JSON.stringify(frame.body ?? {}) }),
    });
    const payload = await r.json().catch(() => null);
    // `error` is NOT echoed, and that omission is deliberate: an answer carrying both a response and an error is
    // read as a TRANSPORT failure by the waiting side, so the City's real status (a 403, a 410) would arrive as
    // "the relay failed". The City's own status is the answer; `relay-dial` omits it for the same reason.
    try { socket.send(JSON.stringify({ kind: 'relay-answer', requestId: frame.requestId, ok: r.ok, status: r.status, response: { ok: r.ok, status: r.status, payload } })); } catch { /* gone */ }
  });
  const outcome = await new Promise(resolveOutcome => {
    socket.once('open', () => resolveOutcome({ opened: true }));
    socket.once('error', error => resolveOutcome({ opened: false, message: error?.message ?? String(error) }));
    // A refused upgrade is answered with a non-101 status; `ws` reports it as 'unexpected-response', so the raw
    // status is captured too rather than being flattened into "socket closed".
    socket.once('unexpected-response', (_request, response) => resolveOutcome({ opened: false, status: response.statusCode }));
  });
  const ready = () => frames.find(f => f?.type === 'RELAY_READY') ?? null;
  return {
    socket,
    frames,
    ...outcome,
    ready,
    pushed: () => frames.filter(f => f?.kind === 'relay-push'),
    /** Send one request up the pipe, exactly as `relay-dial` does, and return the answer frame it gets back. */
    request: async (path, body = {}, { method = 'POST', timeoutMs = 4000 } = {}) => {
      const requestId = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      socket.send(JSON.stringify({ kind: 'relay-request', requestId, path, method, body }));
      const frame = await waitFor(() => frames.find(f => f?.kind === 'relay-answer' && f.requestId === requestId), { timeoutMs });
      if (!frame) throw new Error(`the City never answered ${path}`);
      return { ok: frame.ok === true, status: frame.status, payload: frame.response?.payload ?? null, error: frame.error ?? null };
    },
  };
}

test('S1: a peer that cannot be dialled registers over an OUTBOUND socket, and the City names its ref', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s1-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let peer;
  try {
    peer = await manualPeer(app.url);
    assert.equal(peer.opened, true, `a peer holding no credential is still admitted (status=${peer.status} message=${peer.message})`);
    const ready = await waitFor(() => peer.ready());
    assert.ok(ready, 'the City confirms registration rather than leaving the peer to assume it');
    assert.equal(ready.peerRef, 'install-peer-b', 'the ref is the installation identity the peer declared');
    assert.equal(ready.verified, false, 'and it is NOT marked verified, because nothing proved it');
    assert.equal(ready.role, 'joining-peer');
    assert.ok(Array.isArray(ready.payloads) && ready.payloads.includes('/api/v0/join/request'), 'the City also states WHAT the pipe will carry, so the peer does not have to guess');
    assert.equal(app.relay.stats().peers, 1);

    peer.socket.close();
    assert.equal(await waitFor(() => app.relay.stats().peers === 0), true, 'a closed pipe is unregistered rather than leaked');
  } finally { closeQuietly(peer?.socket); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S1: admission reuses the City’s OWN credentials - a session ref comes from the registry, and a bad one is refused', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s1-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let enrolled, refused, control;
  try {
    const installation = await enrollmentFixture(app.url, 'Peer A');
    const session = await post(app.url, '/api/v0/device/session', {
      installationId: installation.installationId,
      instanceId: installation.instanceId,
      credentialId: installation.credentialId,
      credentialSecret: installation.credentialSecret,
    });
    assert.equal(session.status, 200, `the enrollment fixture itself must work, or this test proves nothing: ${JSON.stringify(session.body).slice(0, 200)}`);

    enrolled = await manualPeer(app.url, { credential: session.body.credential, installationId: 'a-lie', label: 'Enrolled' });
    const ready = await waitFor(() => enrolled.ready());
    assert.ok(ready, 'an enrolled session is admitted');
    assert.equal(ready.peerRef, installation.installationId, 'the ref comes from the SESSION, not from what the peer claimed');
    assert.equal(ready.verified, true, 'and the City says the ref was proven');

    control = await manualPeer(app.url, { credential: CONTROL, installationId: 'owner-pc' });
    const controlReady = await waitFor(() => control.ready());
    assert.ok(controlReady, 'the control token is an existing credential and is accepted');
    assert.equal(controlReady.peerRef, 'control:owner-pc');

    // A credential that was PRESENTED and did not resolve is refused, rather than demoted to anonymous: otherwise
    // revoking a device would leave its pipe open.
    refused = await manualPeer(app.url, { credential: 'sess:not-a-real-session' });
    assert.equal(refused.opened, false, 'an unresolvable session credential must not open a pipe');
    assert.equal(String(refused.status), '403');
  } finally {
    for (const socket of [enrolled?.socket, control?.socket, refused?.socket]) closeQuietly(socket);
    await app.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('S3: a real join completes over the pipe - the CITY runs the payload, the owner approves, the claim is spent once', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s3-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay;
  try {
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-b', label: 'Peer B' });
    assert.equal(relay.verified, false, 'the dialling peer holds no City credential yet: that is the whole premise');

    const claim = 'relay-claim-secret-0123456789';
    const asked = await relay.forward('/api/v0/join/request', { displayName: 'Peer B', platform: 'Win32', installationHint: 'install-peer-b', origin: 'relay', claim });
    assert.equal(asked.response.status, 200, `the City ran the payload itself: ${JSON.stringify(asked).slice(0, 200)}`);
    assert.equal(asked.response.payload.state, 'PENDING');

    // The decision still happens on an AUTHENTICATED surface: the pipe carries the ask, not the authority.
    const pending = await (await fetch(app.url + '/api/v0/join/requests', { headers: { ...V, Authorization: `Bearer ${CONTROL}` } })).json();
    const row = pending.requests.find(r => r.id === asked.response.payload.id);
    assert.ok(row, 'the owner can see the ask that arrived over the relay');
    assert.equal(row.grantsTrust, false, 'and it still grants nothing by existing');
    assert.equal((await post(app.url, `/api/v0/join/requests/${asked.response.payload.id}/approve`, {}, CONTROL)).status, 200);

    const status = await relay.forward('/api/v0/join/status', { requestId: asked.response.payload.id, claim });
    assert.equal(status.response.payload.state, 'APPROVED');
    const collected = await relay.forward('/api/v0/join/exchange', { requestId: asked.response.payload.id, claim });
    assert.equal(collected.response.payload.accepted, true, 'and the credential is released only through the approved, one-time claim');
    assert.ok(typeof collected.response.payload.credential === 'string' && collected.response.payload.credential.length > 0);

    const spent = await relay.forward('/api/v0/join/exchange', { requestId: asked.response.payload.id, claim });
    assert.equal(spent.response.status, 410, `a spent claim is answered with its own status: ${JSON.stringify(spent).slice(0, 200)}`);
  } finally { relay?.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S3: without approval the pipe grants nothing - the City is not joined just because a path exists', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s3-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay;
  try {
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-c' });
    const claim = 'relay-claim-secret-abcdefghij';
    const asked = await relay.forward('/api/v0/join/request', { displayName: 'Peer C', platform: 'Win32', installationHint: 'install-peer-c', claim });
    const status = await relay.forward('/api/v0/join/status', { requestId: asked.response.payload.id, claim });
    assert.equal(status.response.payload.state, 'PENDING');
    assert.equal(status.response.payload.approved, false);
    const refused = await relay.forward('/api/v0/join/exchange', { requestId: asked.response.payload.id, claim });
    assert.equal(refused.response.status, 409, 'an unapproved request releases no credential, whatever transport carried the ask');
    assert.equal(refused.response.payload?.credential, undefined, 'and it releases no credential field at all');
  } finally { relay?.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S2/S3: the relay refuses to be an open proxy - no path outside the list, and no widening by method', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s2-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay, peer;
  try {
    peer = await manualPeer(app.url, { installationId: 'install-peer-a' });
    await waitFor(() => peer.ready());
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-d' });

    // The client refuses a non-payload path WITHOUT asking anyone: dialling first and being refused later would
    // already have opened a socket the user did not need.
    for (const path of ['/api/v0/tasks', '/api/v0/node/claim', '/api/v0/city', 'https://example.invalid/api/v0/join/request']) {
      await assert.rejects(() => relay.forward(path, {}), error => error instanceof RelayDialError && error.code === 'RELAY_PATH_REFUSED', `the client refuses ${path}`);
    }
    // And the City's own list is the authority the client mirrors: if the two ever drift, a payload the client
    // refuses to dial would become reachable, so drift is a test failure rather than a comment.
    assert.deepEqual([...RELAY_PAYLOAD_PATHS].sort(), [...SERVER_PAYLOAD_PATHS].sort(), 'the client and the City must carry exactly the same payload list');

    // A hand-rolled peer asking the City DIRECTLY for an owner operation is refused WITH a reason.
    const offList = await peer.request('/api/v0/tasks', {});
    assert.equal(offList.ok, false, 'the City does not run a route outside the payload list');
    assert.equal(offList.status, 403);
    assert.match(String(offList.error ?? ''), /does not carry/);
  } finally { relay?.close(); closeQuietly(peer?.socket); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S3: a City refusal travels back as its OWN status, so the surface can say why instead of "unreachable"', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s3-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay;
  try {
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-f' });
    // A join request with no claim is a 400 from the City's own validation. The point is that the FORWARDED status
    // reaches the dialling peer: a flattened "relay failed" would make every refusal look like a network fault.
    const answered = await relay.forward('/api/v0/join/request', { displayName: 'Peer F' });
    assert.equal(answered.response.status, 400, `the City’s own status is what the caller sees: ${JSON.stringify(answered).slice(0, 200)}`);
    assert.match(String(answered.response.payload?.error ?? ''), /claim secret/i);
  } finally { relay?.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S2: the dialling peer also SERVES the City - a payload the City PUSHES runs on the City it was dialled to', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s2-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay;
  try {
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-g' });
    // The City pushes a payload down the pipe and the dialling side executes it against the City it dialled, then
    // answers up the same socket. This is the direction a City needs when it has to reach a peer that cannot be
    // dialled - a pure "client calls server" design would not have it.
    // NOTE ON THE SHAPE: a DIRECT `relay.forward` resolves with the answering side's own response object
    // (`{ok, status, payload}`), not with the nested frame `relay-dial` normalises for its callers. Both are the same
    // fact; this helper states the one shape so the assertion does not depend on which road the answer took.
    const answer = readAnswer(await app.relay.forward(relay.peerRef, { requestId: 'pushed-1', path: '/api/v0/join/info', method: 'GET', body: {} }));
    assert.equal(answer.ok, true, `the peer answered the pushed request: ${JSON.stringify(answer)}`);
    assert.equal(answer.status, 200);
    assert.equal(typeof answer.payload?.cityId, 'string', 'and the answer is the City’s own /join/info payload');
    assert.equal(answer.payload?.grantsTrust ?? false, false, 'still nothing here reads as trust');
  } finally { relay?.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('N2: the whole cross-network join runs over the pipe - capability, ask, decision, credential', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-join-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay;
  try {
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-remote-pc', label: 'Remote PC' });
    const steps = [];
    const claim = 'flow-claim-secret-0123456789';
    const flow = joinCityOverRelay({
      forward: (path, body, options) => relay.forward(path, body, options),
      claim,
      displayName: 'Remote PC',
      platform: 'Win32',
      hint: 'install-remote-pc',
      origin: 'relay',
      pollIntervalMs: 50,
      onStep: state => steps.push(state),
    });
    // The owner approves on the City's authenticated surface while the flow is polling.
    const approver = (async () => {
      const seen = await waitFor(async () => {
        const list = await (await fetch(app.url + '/api/v0/join/requests', { headers: { ...V, Authorization: `Bearer ${CONTROL}` } })).json();
        return list.requests.find(r => r.state === 'PENDING') ?? null;
      });
      assert.ok(seen, 'the ask reached the owner over the relay');
      await post(app.url, `/api/v0/join/requests/${seen.id}/approve`, {}, CONTROL);
      return seen.id;
    })();
    const result = await flow;
    const approvedId = await approver;

    assert.equal(result.state, 'APPROVED');
    assert.equal(result.requestId, approvedId, 'the flow collected the credential for the request the owner approved');
    assert.match(result.credential,/^sess:/,'relay admission returns a scoped member session');
    assert.equal(JSON.stringify(result).includes('credentialSecret'),false);
    assert.deepEqual(steps, ['DIALING', 'ASKING', 'PENDING', 'APPROVED'], 'every transition is reported in order, so the surface can show real progress');
  } finally { relay?.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('N2: a rejection is reported AS a rejection and never retried; the flow stops there', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-join-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay;
  try {
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-remote-rejected' });
    const claim = 'flow-claim-secret-rejected-01';
    const flow = joinCityOverRelay({
      forward: (path, body, options) => relay.forward(path, body, options),
      claim, displayName: 'Remote', platform: 'Win32', hint: 'install-remote-rejected', pollIntervalMs: 50,
    });
    const rejecter = (async () => {
      const seen = await waitFor(async () => {
        const list = await (await fetch(app.url + '/api/v0/join/requests', { headers: { ...V, Authorization: `Bearer ${CONTROL}` } })).json();
        return list.requests.find(r => r.state === 'PENDING') ?? null;
      });
      // A REJECTED row cannot be rejected twice, so this also proves the flow did not re-ask after the decision.
      await post(app.url, `/api/v0/join/requests/${seen.id}/reject`, {}, CONTROL);
      return seen.id;
    })();
    await assert.rejects(() => flow, error => error.code === 'RELAY_JOIN_REJECTED' && error.status === 403 && error.fallback === false, 'a city owner saying no is a terminal answer, not a transport failure');
    await rejecter;

    // AND THE ASK IS NOT RE-CREATED: one row, decided, and the city did not get a second one from the flow.
    const list = await (await fetch(app.url + '/api/v0/join/requests', { headers: { ...V, Authorization: `Bearer ${CONTROL}` } })).json();
    assert.equal(list.requests.filter(r => r.installationHint === 'install-remote-rejected').length, 1, 'a rejected installation must not be re-asked by this flow');
  } finally { relay?.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('N2: a pipe that answers for ANOTHER City is refused before an ask is created', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-join-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay;
  try {
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-remote-wrongcity' });
    await assert.rejects(
      () => joinCityOverRelay({ forward: (p, b, o) => relay.forward(p, b, o), claim: 'flow-claim-secret-wrongcity-1', cityRef: 'a-city-that-is-not-this-one', displayName: 'X', platform: 'Win32' }),
      error => error.code === 'RELAY_JOIN_WRONG_CITY',
      'delivering the ask to the wrong owner is worse than failing',
    );
    const list = await (await fetch(app.url + '/api/v0/join/requests', { headers: { ...V, Authorization: `Bearer ${CONTROL}` } })).json();
    assert.equal(list.requests.length, 0, 'and nothing was recorded on the City either');
  } finally { relay?.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('N2: the reach decision sends the same link to navigation and the far network to the pipe', () => {
  assert.equal(reachForRow({ scope: 'local' }), 'self');
  assert.equal(reachForRow({ scope: 'lan' }), 'navigate');
  assert.equal(reachForRow({ scope: 'bluetooth' }), 'navigate');
  assert.equal(reachForRow({ scope: 'remote' }), 'relay');
  assert.equal(reachForRow({ scope: 'unknown' }), 'relay');
  // A row with no address cannot produce a relay target, and the surface must not offer a mechanism it cannot act on.
  assert.equal(relayTargetFor({ cityRef: 'c' }, 'http://here'), null);
  assert.deepEqual(relayTargetFor({ address: '10.0.0.9', port: 4310, cityRef: 'c' }, 'http://here'), { host: '10.0.0.9', port: 4310, cityRef: 'c', relayOrigin: 'http://here' });
});

test('S1: a pipe that never stops is rate-limited, and the version check still applies to the handshake', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s1-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let anonymous, badVersion, peer;
  try {
    // No installationId AND no credential: there is no ref to register under, so this is refused rather than
    // admitted under an invented one.
    anonymous = await manualPeer(app.url, { installationId: '' });
    assert.equal(anonymous.opened, false, `a peer with no ref and no credential must not open a pipe (status=${anonymous.status})`);
    assert.equal(String(anonymous.status), '403');

    // The version check applies to the relay handshake too: a peer that has not agreed the protocol cannot use it.
    badVersion = await manualPeer(app.url, { installationId: 'install-peer-h', query: { apiVersion: '9', schemaVersion: '9' } });
    assert.equal(badVersion.opened, false);
    assert.equal(String(badVersion.status), '409');

    // A peer that sprays requests at the City's routes is slowed down rather than allowed to fill its tables.
    peer = await manualPeer(app.url, { installationId: 'install-peer-hammer' });
    await waitFor(() => peer.ready());
    // The burst is sent AS a burst: every request is written to the pipe before any answer is awaited, so all of them
    // reach the City's 1000 ms window together.
    //
    // The previous version awaited each round-trip before sending the next, which made this a host-speed assertion in
    // disguise: the limiter refuses the 21st request inside a 1000 ms window (services/dev-gateway/server.mjs:93,225),
    // so a sequential loop only trips it while the first 21 round-trips average under roughly 48 ms. On a loaded host -
    // a full-suite run, a busy CI box - the window refills between requests and the probe failed while the limiter was
    // working perfectly. That is a false red about the product, produced by the instrument, and it was observed doing
    // exactly that during the REX integration preflight. Measuring the send span makes the premise visible instead of
    // assumed: if the requests themselves took a second to write, the test says so rather than blaming the limiter.
    const sendStartedAt = Date.now();
    const pendingAnswers = Array.from({ length: 30 }, () => peer.request('/api/v0/join/info', {}, { method: 'GET' }));
    const sendSpanMs = Date.now() - sendStartedAt;
    const results = await Promise.all(pendingAnswers);
    assert.ok(results.some(r => r.status === 429),
      `a burst of 30 concurrent relay requests is refused with 429 rather than served (the 30 requests were written in ${sendSpanMs} ms)`);
  } finally { closeQuietly(anonymous?.socket); closeQuietly(badVersion?.socket); closeQuietly(peer?.socket); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
