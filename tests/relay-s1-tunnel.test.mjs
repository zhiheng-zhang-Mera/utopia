// S1 + S2 + S3: the relay PIPE, end to end.
//
// WHY THIS FILE EXISTS. `relay.mjs` was already a tested transport and `choosePath` already answered
// `relay-in-city`, but NOTHING DIALLED IT - the decision could name a mechanism that did not exist. This file
// covers the two halves that make it real: the City accepting a dialled-in peer and forwarding a payload to it
// (S1), and the client that dials and forwards an EXISTING join payload over the pipe (S2/S3).
//
// WHAT IS PINNED, AND IN WHICH DIRECTION:
//   * a peer that cannot be dialled registers over an OUTBOUND socket, and the City pushes a join payload to it;
//   * the payload the peer answers is the EXISTING route (`join/request`), and the owner's approval still happens
//     on the City's own authenticated surface - the pipe carries the ask, not the authority;
//   * the pipe is NOT an open proxy: a path outside the payload list is refused, and so is a target ref the City
//     does not actually hold;
//   * the ADMISSION policy refuses a credential that was presented and did not resolve, rather than quietly
//     demoting that peer to anonymous - otherwise revoking a device would not close its pipe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { RelayDialError, RELAY_PAYLOAD_PATHS, dialRelay } from '../apps/web/relay-dial.mjs';
import { RELAY_PAYLOAD_PATHS as SERVER_PAYLOAD_PATHS } from '../services/dev-gateway/relay.mjs';

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

/** Run one of the City's own routes, exactly as the pushed payload names it.
 *
 *  THE PUSHED `url` WINS over the City this socket is connected to, and the first version ignored it: the payload
 *  went to the RELAY that carried it instead of the City that owns the peer, so the two-City case recorded the ask
 *  on the wrong City while every status still looked healthy. That is exactly the failure the case exists to catch.
 */
async function runCityRoute(baseUrl, frame) {
  const verb = String(frame.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const base = typeof frame.url === 'string' && frame.url !== '' ? new URL(frame.url).origin : baseUrl;
  const r = await fetch(new URL(frame.path, base).toString(), {
    method: verb,
    headers: { 'Content-Type': 'application/json', ...V },
    ...(verb === 'GET' ? {} : { body: JSON.stringify(frame.body ?? {}) }),
  });
  const payload = await r.json().catch(() => null);
  // A route that refused is NOT an exception to hide: the pushed payload's own status has to travel back, so a
  // refusal is recorded here where the test can see it.
  if (!r.ok) console.warn('relay test: the City refused a pushed payload', JSON.stringify({ path: frame.path, status: r.status, error: payload?.error }).slice(0, 200));
  return { ok: r.ok, status: r.status, payload, error: r.ok ? null : (payload?.error ?? `the City answered ${r.status}`) };
}

/**
 * A hand-rolled relay peer: enough to speak the wire contract directly and assert what the City does with it.
 *
 * `answers: true` makes it behave like `relay-dial` does - execute the pushed payload against the City that sent
 * it and answer up the same socket. `answers: false` leaves the pushed requests unanswered on purpose.
 */
async function manualPeer(url, { credential = null, installationId = 'install-peer-b', label = 'Peer B', query = {}, answers = true, clientUrl = null } = {}) {
  const { WebSocket } = await import('ws');
  // An EMPTY installationId means "declare no ref at all", which is the refusal case - so the parameter is omitted
  // rather than sent empty, because an empty string and a missing ref are not the same fact to the admission policy.
  const params = new URLSearchParams({ ...query, label, ...(installationId ? { installationId } : {}) });
  // A peer states where ITS City lives, exactly as `relay-dial` does: without it the relay has no address to name
  // for a pushed payload, and the refusal it answers with is correct-but-useless ("no endpoint to name").
  if (clientUrl ?? url) params.set('clientUrl', clientUrl ?? url);
  const protocols = ['city-relay-v0', ...(credential ? [`city-token.${Buffer.from(credential).toString('base64url')}`] : [])];
  const socket = new WebSocket(wsUrl(url, `?${params.toString()}`), protocols);
  const frames = [];
  socket.on('message', async raw => {
    let frame = null;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    frames.push(frame);
    if (!answers || frame?.kind !== 'relay-push') return;
    const { ok, status, payload } = await runCityRoute(url, frame);
    // `error` is NOT echoed, and that omission is deliberate: an answer carrying both a response and an error is
    // read as a TRANSPORT failure by the waiting side, so the City's real status (a 403, a 410) would arrive as
    // "the relay failed". The City's own status is the answer; `relay-dial` omits it for the same reason.
    try { socket.send(JSON.stringify({ kind: 'relay-answer', requestId: frame.requestId, ok, status, response: { ok, status, payload } })); } catch { /* gone */ }
  });
  const outcome = await new Promise(resolveOutcome => {
    socket.once('open', () => resolveOutcome({ opened: true }));
    socket.once('error', error => resolveOutcome({ opened: false, message: error?.message ?? String(error) }));
    // A refused upgrade is answered with a non-101 status; `ws` reports it as 'unexpected-response', so the raw
    // status is captured too rather than being flattened into "socket closed".
    socket.once('unexpected-response', (_request, response) => resolveOutcome({ opened: false, status: response.statusCode }));
  });
  return {
    socket,
    frames,
    ...outcome,
    ready: () => frames.find(f => f?.type === 'RELAY_READY') ?? null,
    pushed: () => frames.filter(f => f?.kind === 'relay-push'),
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
    const gone = await waitFor(() => app.relay.stats().peers === 0);
    assert.equal(gone, true, 'a closed pipe is unregistered rather than leaked');
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

test('S3: a real join travels over the pipe - ask, owner approve, collect - and the relay only forwards', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s3-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let peer, relay;
  try {
    // PC-A: already registered with this City, and reachable only by the pipe it opened itself.
    peer = await manualPeer(app.url, { installationId: 'install-peer-a' });
    assert.ok(await waitFor(() => peer.ready()), 'the far side is registered');

    // PC-B: cannot be dialled, dials out, and asks the City to push the join ask to PC-A.
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-b', label: 'Peer B', targetPeerRef: 'install-peer-a' });
    assert.equal(relay.verified, false, 'the dialling peer holds no City credential yet: that is the whole premise');
    assert.equal(relay.city.sameOrigin, false, 'this page was NOT served by the City being dialled, so the forwarded payload must name that City explicitly');

    const claim = 'relay-claim-secret-0123456789';
    // The payload is the EXISTING join payload, field for field. Nothing about it is relay-specific.
    const asked = await relay.forward('/api/v0/join/request', { displayName: 'Peer B', platform: 'Win32', installationHint: 'install-peer-b', origin: 'relay', claim });
    assert.equal(asked.ok, true, 'the forward itself succeeded');
    assert.equal(asked.response.status, 200);
    assert.equal(asked.response.payload.state, 'PENDING', 'the request was recorded on the City by the peer the relay pushed it to');
    assert.equal(peer.pushed().length, 1, 'and it really travelled as a pushed payload rather than being answered by the relay itself');

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

    // ONE-TIME means one time, through the pipe as much as over HTTP. A refusal from the City travels as its OWN
    // status inside a successful forward - that is what lets the surface say "already used" instead of "unreachable".
    const spent = await relay.forward('/api/v0/join/exchange', { requestId: asked.response.payload.id, claim });
    assert.equal(spent.response.status, 410, `a spent claim is answered with its own status: ${JSON.stringify(spent).slice(0, 200)}`);
  } finally { relay?.close(); closeQuietly(peer?.socket); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S3: without approval the pipe grants nothing - the City is not joined just because a path exists', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s3-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let peer, relay;
  try {
    peer = await manualPeer(app.url, { installationId: 'install-peer-a' });
    await waitFor(() => peer.ready());
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-c', targetPeerRef: 'install-peer-a' });
    const claim = 'relay-claim-secret-abcdefghij';
    const asked = await relay.forward('/api/v0/join/request', { displayName: 'Peer C', platform: 'Win32', installationHint: 'install-peer-c', claim });
    const status = await relay.forward('/api/v0/join/status', { requestId: asked.response.payload.id, claim });
    assert.equal(status.response.payload.state, 'PENDING');
    assert.equal(status.response.payload.approved, false);
    const refused = await relay.forward('/api/v0/join/exchange', { requestId: asked.response.payload.id, claim });
    assert.equal(refused.response.status, 409, 'an unapproved request releases no credential, whatever transport carried the ask');
    assert.equal(refused.response.payload?.credential, undefined, 'and it releases no credential field at all');
  } finally { relay?.close(); closeQuietly(peer?.socket); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S2/S3: the relay refuses to be an open proxy - no path outside the list, and no target the City does not hold', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s2-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay, peer;
  try {
    peer = await manualPeer(app.url, { installationId: 'install-peer-a' });
    await waitFor(() => peer.ready());
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-d', targetPeerRef: 'install-peer-a' });

    // The client refuses a non-payload path WITHOUT asking anyone: dialling first and being refused later would
    // already have opened a socket the user did not need.
    for (const path of ['/api/v0/tasks', '/api/v0/node/claim', '/api/v0/city', 'https://example.invalid/api/v0/join/request']) {
      await assert.rejects(() => relay.forward(path, {}), error => error instanceof RelayDialError && error.code === 'RELAY_PATH_REFUSED', `the client refuses ${path}`);
    }
    // And the City's own list is the authority the client mirrors: if the two ever drift, a payload the client
    // refuses to dial would become reachable, so drift is a test failure rather than a comment.
    assert.deepEqual([...RELAY_PAYLOAD_PATHS].sort(), [...SERVER_PAYLOAD_PATHS].sort(), 'the client and the City must carry exactly the same payload list');

    // A target ref the City does not hold is refused WITH a reason, rather than forwarded into the void.
    const foreign = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-e', targetPeerRef: 'install-peer-nowhere' });
    const nowhere = await foreign.forward('/api/v0/join/info', {}, { method: 'GET' });
    assert.equal(nowhere.response.status, 404, 'a peer cannot ask this City to reach a machine of its choosing');
    assert.match(String(nowhere.response.payload?.error ?? nowhere.error ?? ''), /not connected/, 'and the refusal names the reason');
    foreign.close();
  } finally { relay?.close(); closeQuietly(peer?.socket); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S2/S3 - THE TWO-CITY CASE: a join ask crosses a relay City and is decided on the City that owns the peer', async () => {
  // THIS IS THE SHAPE THE OWNER ASKED FOR: the PC that joins cannot be dialled and is registered with a REACHABLE
  // relay City, while the City that must approve it lives somewhere else. The relay pushes the payload to the peer;
  // the peer executes it against the MAIN City, which is where the owner sees the ask and where the approval happens.
  const relayDir = await mkdtemp(resolve('.scratch-relay-two-a-'));
  const mainDir = await mkdtemp(resolve('.scratch-relay-two-b-'));
  const relayCity = await createGateway({ host: '127.0.0.1', port: 0, dir: relayDir, token: 'relay-city-control', nodeToken: 'relay-city-node' });
  const mainCity = await createGateway({ host: '127.0.0.1', port: 0, dir: mainDir, token: 'main-city-control', nodeToken: 'main-city-node' });
  let peer;
  try {
    // THE JOINING PC dials the RELAY City (it is the reachable one) and is admitted under its own installation ref.
    // THE JOINING PC DECLARES WHICH CITY IT BELONGS TO. It is registered with the relay (that is the only reachable
    // door), but the City that must decide its ask is the MAIN one - so that is the origin it declares, and that is
    // where the pushed payload is executed. This is the whole point of the two-City case: the relay carries the ask,
    // and the answer is produced by the City that owns the peer.
    peer = await manualPeer(relayCity.url, { installationId: 'install-joining-pc', clientUrl: mainCity.url });
    assert.ok(await waitFor(() => peer.ready()), 'the joining PC is registered with the relay');

    // The relay pushes a join payload at it. The peer executes the payload against the MAIN City - not the relay -
    // and the ask appears where the owner can approve it.
    const pushed = await relayCity.relay.forward('install-joining-pc', { requestId: 'two-city-1', path: '/api/v0/join/request', method: 'POST', url: mainCity.url, body: { displayName: 'Joining PC', platform: 'Win32', installationHint: 'install-joining-pc', origin: 'relay', claim: 'two-city-claim-secret-0123456789' } });
    const pushedAnswer = readAnswer(pushed);
    assert.equal(pushedAnswer.status, 200, `the relay carried the ask: ${JSON.stringify(pushed).slice(0, 240)}`);
    const requestId = pushedAnswer.payload?.id;
    assert.ok(typeof requestId === 'string', `the main City created the join request: ${JSON.stringify(pushed).slice(0, 240)}`);

    const mainPending = await (await fetch(mainCity.url + '/api/v0/join/requests', { headers: { ...V, Authorization: 'Bearer main-city-control' } })).json();
    assert.ok(mainPending.requests.some(r => r.id === requestId), 'the ask is visible on the City that must decide it, not on the relay');
    const relayPending = await (await fetch(relayCity.url + '/api/v0/join/requests', { headers: { ...V, Authorization: 'Bearer relay-city-control' } })).json();
    assert.equal(relayPending.requests.some(r => r.id === requestId), false, 'and the RELAY City did NOT record it: it is a pipe, not a second trust store');

    // The owner approves on the main City, and the credential is collected there.
    assert.equal((await post(mainCity.url, `/api/v0/join/requests/${requestId}/approve`, {}, 'main-city-control')).status, 200);
    const collected = readAnswer(await relayCity.relay.forward('install-joining-pc', { requestId: 'two-city-2', path: '/api/v0/join/exchange', method: 'POST', url: mainCity.url, body: { requestId, claim: 'two-city-claim-secret-0123456789' } }));
    assert.equal(collected.status, 200, 'the approved credential is released');
    assert.equal(collected.payload.accepted, true);
    assert.ok(typeof collected.payload.credential === 'string' && collected.payload.credential.length > 0);
  } finally { closeQuietly(peer?.socket); await relayCity.close(); await mainCity.close(); await rm(relayDir, { recursive: true, force: true }); await rm(mainDir, { recursive: true, force: true }); }
});

test('S3: a City refusal travels back as its OWN status, so the surface can say why instead of "unreachable"', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s3-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let peer, relay;
  try {
    peer = await manualPeer(app.url, { installationId: 'install-peer-a' });
    await waitFor(() => peer.ready());
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-f', targetPeerRef: 'install-peer-a' });
    // A join request with no claim is a 400 from the City's own validation. The point is that the FORWARDED status
    // reaches the dialling peer: a flattened "relay failed" would make every refusal look like a network fault.
    const answered = await relay.forward('/api/v0/join/request', { displayName: 'Peer F' });
    assert.equal(answered.response.status, 400, `the City’s own status is what the caller sees: ${JSON.stringify(answered).slice(0, 200)}`);
    assert.match(String(answered.response.payload?.error ?? ''), /claim secret/i);
  } finally { relay?.close(); closeQuietly(peer?.socket); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S2: the dialling peer also SERVES the City - a pushed request runs on the City it belongs to', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s2-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let relay;
  try {
    relay = await dialRelay({ host: '127.0.0.1', port: Number(new URL(app.url).port), installationId: 'install-peer-g' });
    // The City pushes a payload down the pipe; the dialling side runs it against the City it dialled (the same
    // existing route) and answers up the same socket. This is the half that makes the channel usable in the
    // direction the City needs, and a pure "client calls server" design would not have it.
    const answer = readAnswer(await app.relay.forward(relay.peerRef, { requestId: 'pushed-1', path: '/api/v0/join/info', method: 'GET', body: {} }));
    assert.equal(answer.ok, true, `the peer answered the pushed request: ${JSON.stringify(answer)}`);
    assert.equal(answer.status, 200);
    assert.equal(typeof answer.payload?.cityId, 'string', 'and the answer is the City’s own /join/info payload');
    // `/join/info` deliberately carries no `grantsTrust` field - it is the City's CAPABILITY, not a candidate row -
    // so the assertion is that nothing in it claims trust, not that a field this route never had is false.
    assert.equal(answer.payload?.grantsTrust ?? false, false, 'still nothing here reads as trust');
  } finally { relay?.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('S1: the pipe is refused when the City never admitted the peer, and a malformed hello is a typed refusal', async () => {
  const dir = await mkdtemp(resolve('.scratch-relay-s1-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
  let anonymous, badVersion;
  try {
    // No installationId AND no credential: there is no ref to register under, so this is refused rather than
    // admitted under an invented one.
    anonymous = await manualPeer(app.url, { installationId: '' });
    assert.equal(anonymous.opened, false, `a peer with no ref and no credential must not open a pipe (status=${anonymous.status} peers=${JSON.stringify(app.relay.listPeers())})`);
    assert.equal(String(anonymous.status), '403');

    // The version check applies to the relay handshake too: a peer that has not agreed the protocol cannot use it.
    badVersion = await manualPeer(app.url, { installationId: 'install-peer-h', query: { apiVersion: '9', schemaVersion: '9' } });
    assert.equal(badVersion.opened, false);
    assert.equal(String(badVersion.status), '409');
  } finally { closeQuietly(anonymous?.socket); closeQuietly(badVersion?.socket); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
