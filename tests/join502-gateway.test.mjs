// JOIN-502 — the City side of "a nearby PC asks to join, an existing trusted device decides".
//
// The workbook's completion gate is a set of NEGATIVE properties: approval must be a real gate, no
// discovery may auto-grant trust, a rejection must stay a rejection, a consumed request must not be
// replayable, and no secret may reach a surface that has not been approved. Each test below attacks one
// of those rather than demonstrating the happy path again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { createJoinRequests, MAX_PENDING, shortRef } from '../services/dev-gateway/join.mjs';

const CONTROL = 'join-control-token';
const NODE = 'join-node-token';
const VERSION = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json' };
const owner = { ...VERSION, Authorization: `Bearer ${CONTROL}` };
const claim = 'claim-secret-0123456789';

const call = (app, path, { body, headers = VERSION, method } = {}) => fetch(`${app.url}/api/v0/${path}`, {
  method: method ?? (body ? 'POST' : 'GET'),
  headers,
  body: body ? JSON.stringify(body) : undefined,
});

test('JOIN-502: a join request grants nothing until an already trusted device approves it', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
    // The capability statement is public BECAUSE a joining PC has no credential - that is what it is
    // asking for - so it must be reachable, and it must not carry a secret.
    const info = await call(app, 'join/info');
    assert.equal(info.status, 200);
    const statement = await info.json();
    assert.equal(statement.joinProtocolVersion, 1);
    assert.equal(typeof statement.cityId, 'string');
    assert.ok(!JSON.stringify(statement).includes(CONTROL));
    assert.ok(!JSON.stringify(statement).includes(claim));

    const created = await call(app, 'join/request', { body: { displayName: 'Mech Web', platform: 'Win32', installationHint: 'install-mech', origin: 'http://127.0.0.1:9', claim } });
    assert.equal(created.status, 200);
    const ask = await created.json();
    assert.equal(ask.state, 'PENDING');
    // The response is what the REQUESTER sees, and it must not contain the credential, the claim
    // preimage or even the claim digest.
    const serialized = JSON.stringify(ask);
    assert.ok(!serialized.includes(CONTROL), 'an unapproved request must never carry the City credential');
    assert.ok(!serialized.includes(claim), 'the claim preimage must never come back from the City');
    assert.ok(!serialized.includes('claimDigest'));
    assert.equal(ask.grantsTrust, false);
    assert.equal(ask.isIdentity, false);

    // Pending means pending: the collection route refuses, and it says why rather than minting anyway.
    const early = await call(app, 'join/exchange', { body: { requestId: ask.id, claim } });
    assert.equal(early.status, 409);

    // The owner's routes are AUTHENTICATED, so a machine on the same LAN cannot approve itself.
    assert.equal((await call(app, `join/requests/${ask.id}/approve`, { body: {} })).status, 401);
    assert.equal((await call(app, 'join/requests')).status, 401);
    assert.equal((await call(app, `join/requests/${ask.id}/approve`, { body: {}, headers: owner })).status, 200);

    // Approval is what releases the City's existing credential. It is the SAME credential the City
    // already issues - this module does not mint a second kind.
    const collected = await call(app, 'join/exchange', { body: { requestId: ask.id, claim } });
    assert.equal(collected.status, 200);
    assert.equal((await collected.json()).credential, CONTROL);
    // One request, one credential: a replay is refused rather than answered twice.
    assert.equal((await call(app, 'join/exchange', { body: { requestId: ask.id, claim } })).status, 410);
    // ...and a status poll on a spent ask answers with the FACT ("already used") instead of an error:
    // the poll is how a requester learns a terminal state, so it must not fail in order to say one.
    const afterSpend = await call(app, 'join/status', { body: { requestId: ask.id, claim } });
    assert.equal(afterSpend.status, 200);
    assert.equal((await afterSpend.json()).state, 'CONSUMED');

    // The ask never became a node, a task or a trust record.
    assert.equal(app.store.list('nodes').length, 0);
    const city = await (await fetch(`${app.url}/api/v0/city`, { headers: owner })).json();
    assert.equal(city.joinRequests.length, 0, 'a consumed request is no longer a live ask');
    assert.equal(city.nodes.length, 0);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-502: the browse is authenticated, and a nearby City never makes this City mint a pairing code', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE, nearbyTimeoutMs: 300 });
    // The browse is a READ of the City's own LAN view, so it carries the control credential like every
    // other read. An unauthenticated browse route would hand a stranger the City's list of owners.
    assert.equal((await call(app, 'join/nearby')).status, 401);
    const browsed = await call(app, 'join/nearby', { headers: owner });
    assert.equal(browsed.status, 200);
    const body = await browsed.json();
    assert.ok(Array.isArray(body.nearby), 'a machine with no multicast answer must still answer an empty list');
    assert.equal(body.bounded, true);

    // JOIN-501's Owner rule is a HARD boundary for this task (workbook section 6): discovery and asking
    // must never create temporary pairing material as a side effect. Measured through the City's own
    // public pairing state rather than by reading the UI.
    const pairingBefore = await (await call(app, 'pairing/info')).json();
    assert.equal(pairingBefore.activeSession, false);
    await call(app, 'join/request', { body: { displayName: 'Nearby PC', platform: 'Win32', installationHint: 'install-nearby', claim } });
    await call(app, `join/requests/${(await (await call(app, 'join/requests', { headers: owner })).json()).requests[0].id}/approve`, { body: {}, headers: owner });
    const pairingAfter = await (await call(app, 'pairing/info')).json();
    assert.equal(pairingAfter.activeSession, false, 'a join must not mint a short code or QR as a side effect');
    assert.equal(pairingAfter.descriptor.pairingSessionId, null);
    const events = app.store.events().map(event => event.type);
    assert.ok(!events.some(type => /PAIRING|SESSION/.test(type)), `no pairing event should be emitted by a join: ${events.filter(t => /PAIRING|SESSION/.test(t))}`);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-502: a duplicate or replayed request is bounded, not a second approval card', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
    const first = await (await call(app, 'join/request', { body: { displayName: 'Mech Web', platform: 'Win32', installationHint: 'install-mech', claim } })).json();

    // A second machine that heard the same advertisement and re-uses the hint must NOT adopt the ask.
    const impostor = await call(app, 'join/status', { body: { requestId: first.id, claim: 'another-claim-0123456789' } });
    assert.equal(impostor.status, 403);
    assert.equal((await call(app, 'join/exchange', { body: { requestId: first.id, claim: 'another-claim-0123456789' }, headers: VERSION })).status, 403);

    // Re-asking with the SAME hint is the same ask: one approval card, refreshed claim, same id.
    const again = await (await call(app, 'join/request', { body: { displayName: 'Mech Web', platform: 'Win32', installationHint: 'install-mech', claim } })).json();
    assert.equal(again.id, first.id, 'a retrying installation must not stack a second approval card');
    const listed = await (await call(app, 'join/requests', { headers: owner })).json();
    assert.equal(listed.requests.length, 1);
    assert.equal(listed.pending, 1);
    // The approver's row carries a short reference and no claim material of any kind.
    assert.equal(listed.requests[0].shortRef, shortRef(first.id));
    assert.ok(!JSON.stringify(listed).includes(claim));
    assert.ok(!JSON.stringify(listed).includes('claimDigest'));
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-502: a rejected request stays rejected, and re-asking after a rejection is refused', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
    const ask = await (await call(app, 'join/request', { body: { displayName: 'Bad PC', platform: 'Linux', installationHint: 'install-bad', claim } })).json();
    assert.equal((await call(app, `join/requests/${ask.id}/reject`, { body: {}, headers: owner })).status, 200);
    // Reject leaves the device untrusted: no credential, ever, from this row.
    const refused = await call(app, 'join/exchange', { body: { requestId: ask.id, claim } });
    assert.equal(refused.status, 403);
    assert.ok(!JSON.stringify(await refused.json()).includes(CONTROL));
    // "No" is an answer, not a prompt: the same installation cannot turn it back into a question.
    const reAsk = await call(app, 'join/request', { body: { displayName: 'Bad PC', platform: 'Linux', installationHint: 'install-bad', claim } });
    assert.equal(reAsk.status, 403);
    // A rejected row is not revived by an approval either.
    assert.equal((await call(app, `join/requests/${ask.id}/approve`, { body: {}, headers: owner })).status, 409);
    const city = await (await fetch(`${app.url}/api/v0/city`, { headers: owner })).json();
    assert.equal(city.joinRequests.filter(r => r.state !== 'REJECTED').length, 0);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-502: an expired request cannot be approved back into life, and expiry does not need a request to happen', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-'));
  let app;
  try {
    let clock = Date.parse('2026-10-03T10:00:00.000Z');
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE, pairingClock: () => clock });
    const ask = await (await call(app, 'join/request', { body: { displayName: 'Slow PC', platform: 'Win32', installationHint: 'install-slow', claim } })).json();
    clock += 11 * 60 * 1000;   // past the 10 minute request ttl
    const status = await (await call(app, 'join/status', { body: { requestId: ask.id, claim } })).json();
    assert.equal(status.state, 'EXPIRED');
    assert.equal((await call(app, 'join/exchange', { body: { requestId: ask.id, claim } })).status, 410);
    const late = await call(app, `join/requests/${ask.id}/approve`, { body: {}, headers: owner });
    assert.equal(late.status, 409, 'an expired ask must not be approvable');
    assert.equal((await call(app, 'join/exchange', { body: { requestId: ask.id, claim } })).status, 410);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-502: the request list is BOUNDED, and a decision survives a City restart', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
    let approved = null;
    for (let index = 0; index <= MAX_PENDING; index += 1) {
      const response = await call(app, 'join/request', { body: { displayName: `PC ${index}`, platform: 'Win32', installationHint: `install-${index}`, claim: `claim-secret-${String(index).padStart(4, '0')}` } });
      // The bound is enforced, not hoped for: the (MAX_PENDING+1)th ask is refused rather than queued.
      assert.equal(response.status, index < MAX_PENDING ? 200 : 429, `ask ${index} answered ${response.status}`);
      if (index === 0) approved = await response.json();
    }
    assert.equal((await (await call(app, 'join/requests', { headers: owner })).json()).requests.filter(r => r.state === 'PENDING').length, MAX_PENDING);
    assert.equal((await call(app, `join/requests/${approved.id}/approve`, { body: {}, headers: owner })).status, 200);

    // The claim preimage is never written to disk either: the City stores a digest, so a stolen state
    // file does not hand anyone the ability to collect somebody's approved request.
    const persisted = await readFile(resolve(dir, 'join-requests.json'), 'utf8');
    assert.ok(!persisted.includes('claim-secret-0000'), 'the claim preimage must not be persisted');
    assert.ok(persisted.includes('claimDigest'));

    await app.close();
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
    const survivor = await call(app, 'join/exchange', { body: { requestId: approved.id, claim: 'claim-secret-0000' } });
    assert.equal(survivor.status, 200, 'an approval recorded before a restart must still be collectable');
    assert.equal((await survivor.json()).credential, CONTROL);
    assert.equal((await call(app, 'join/exchange', { body: { requestId: approved.id, claim: 'claim-secret-0000' } })).status, 410);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-502: the state machine refuses what it cannot honour, instead of guessing', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-'));
  const store = createJoinRequests({ file: resolve(dir, 'join-requests.json'), credential: 'c', clock: () => Date.parse('2026-10-03T10:00:00.000Z') });
  try {
    assert.throws(() => store.request({ displayName: 'x', claim: 'tooshort' }), /claim secret/);
    assert.throws(() => store.request({ claim }), /display name/);
    assert.throws(() => store.status({ requestId: 'nope', claim }), /No such join request/);
    const ask = store.request({ displayName: 'PC', claim });
    assert.equal(ask.state, 'PENDING');
    // An unknown id and a wrong claim are DIFFERENT answers, so a surface can say which happened.
    assert.throws(() => store.status({ requestId: ask.id, claim: 'wrong-claim-0123456789' }), /another requester/);
    // A status read on a DECIDED row is the decision, not a refusal: both terminal states are readable
    // by the requester so its surface can say which one happened.
    store.approve({ requestId: ask.id });
    assert.equal(store.status({ requestId: ask.id, claim }).state, 'APPROVED');
    assert.throws(() => store.approve({ requestId: 'nope' }), /No such join request/);
    // Approving twice is not an error, but it must not create a second credential path either.
    store.approve({ requestId: ask.id });
    assert.equal(store.approve({ requestId: ask.id }).state, 'APPROVED');
    assert.equal(store.exchange({ requestId: ask.id, claim }).credential, 'c');
    assert.throws(() => store.exchange({ requestId: ask.id, claim }), /already been used/);
    assert.throws(() => store.reject({ requestId: ask.id }), /cannot be rejected/);
    assert.deepEqual(store.snapshot(), [], 'nothing live is left after collection');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-502: an approval reaches OTHER surfaces as a canonical event, not only the owner that made it', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-'));
  let app, socket;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
    const { WebSocket } = await import('ws');
    const frames = [];
    socket = new WebSocket(`${app.url.replace(/^http/, 'ws')}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=join502-listener&clientLabel=Listener`, ['city-v0', `city-token.${Buffer.from(CONTROL).toString('base64url')}`]);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('message', raw => { try { frames.push(JSON.parse(raw.toString())); } catch { /* non-JSON frames are not events */ } });

    const ask = await (await call(app, 'join/request', { body: { displayName: 'Mech Web', platform: 'Win32', installationHint: 'install-mech', claim } })).json();
    await call(app, `join/requests/${ask.id}/approve`, { body: {}, headers: owner });
    // The listener never issued the request; it learns about the decision over the City's event stream,
    // which is what "an existing trusted device receives an approval request" has to mean in practice.
    const observed = await (async () => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const found = frames.map(frame => frame.event).filter(event => event?.type?.startsWith('JOIN_REQUEST_'));
        if (found.some(event => event.type === 'JOIN_REQUEST_APPROVED')) return found;
        if (Date.now() > deadline) return found;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    const types = observed.map(event => event.type);
    assert.ok(types.includes('JOIN_REQUEST_CREATED'), `listener saw a creation event: ${types}`);
    assert.ok(types.includes('JOIN_REQUEST_APPROVED'), `listener saw the approval: ${types}`);
    // Canonical means ordered and attributed, not merely delivered.
    assert.ok(observed.every(event => Number.isInteger(event.seq)), 'every join event carries the City sequence');
    assert.ok(observed.every(event => event.payload.grantsTrust === false));
    assert.ok(!JSON.stringify(observed).includes(claim), 'the event stream must not carry the claim secret');
  } finally { try { socket?.close(); } catch {} await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-502: decisions are canonical events, and their payloads carry no secret', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
    const ask = await (await call(app, 'join/request', { body: { displayName: 'Mech Web', platform: 'Win32', installationHint: 'install-mech', claim } })).json();
    await call(app, `join/requests/${ask.id}/approve`, { body: {}, headers: owner });
    await call(app, 'join/exchange', { body: { requestId: ask.id, claim } });
    const events = app.store.events().filter(event => event.type.startsWith('JOIN_REQUEST_'));
    assert.deepEqual(events.map(event => event.type), ['JOIN_REQUEST_CREATED', 'JOIN_REQUEST_APPROVED', 'JOIN_REQUEST_CONSUMED']);
    // Every other surface converges on these events, so they must not become a secret channel.
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(CONTROL));
    assert.ok(!serialized.includes(claim));
    assert.ok(!serialized.includes('claimDigest'));
    assert.ok(events.every(event => event.payload.grantsTrust === false));
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});
