// TWO INDEPENDENT CITY PROCESSES, LINKED OVER A DIALLED-OUT PIPE.
//
// WHAT THIS PROVES, EXACTLY: two separate City instances - separate stores, separate identities, separate join
// request tables - over a real WebSocket, where the MAIN City's side reaches the other City by DIALING OUT (the
// direction a NAT always permits). A join ask then travels end to end over that pipe, is decided on the City that
// received it, and the released credential works there.
//
// WHAT IT DOES NOT PROVE: that this works across two REAL networks on two REAL PCs. Both Cities run on this machine
// over loopback, so nothing here exercises NAT, a router, or a metered link. That limit is why the record marks the
// real two-network acceptance as DEFERRED rather than done - and it is repeated here so this file cannot be read as
// more than it is.
//
// WHY IT IS IN THE SUITE RATHER THAN A ONE-OFF SCRIPT: "the linked path works" is a claim that has to keep being
// true. A script run once proves it was true once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { dialRelay } from '../apps/web/relay-dial.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const owner = token => ({ ...V, Authorization: `Bearer ${token}` });

test('LINK: two independent Cities link over a pipe the main City dialled out, and a join completes across it', async () => {
  const dirA = await mkdtemp(resolve('.scratch-link-a-'));
  const dirB = await mkdtemp(resolve('.scratch-link-b-'));
  const cityA = await createGateway({ host: '127.0.0.1', port: 0, dir: dirA, token: 'link-a-control', nodeToken: 'link-a-node' });
  const cityB = await createGateway({ host: '127.0.0.1', port: 0, dir: dirB, token: 'link-b-control', nodeToken: 'link-b-node' });
  let peer = null;
  try {
    // 1. THE MAIN CITY DIALS OUT. City-B opens the connection, so City-A never has to reach in - which is the whole
    //    reason this mechanism exists for a PC behind NAT.
    peer = await dialRelay({ host: '127.0.0.1', port: Number(new URL(cityA.url).port), installationId: 'city-b-installation', label: 'City-B (main)', clientUrl: cityB.url });
    assert.equal(peer.verified, false, 'City-B holds no City-A credential: it is the machine asking to be reached');
    assert.equal(peer.city.sameOrigin, false, 'and the two Cities are different origins, so the payload must name the City it belongs to');

    // 2. THE ASK TRAVELS OVER THAT PIPE AND CITY-A RUNS IT ON ITS OWN ROUTES.
    const claim = 'local-link-claim-secret-0123456789';
    const asked = await peer.forward('/api/v0/join/request', {
      displayName: 'PC on another network', platform: 'Win32', installationHint: 'remote-pc-1', origin: cityB.url, claim,
    });
    const requestId = asked.response?.payload?.id;
    assert.equal(asked.response?.status, 200, `the ask reached City-A: ${JSON.stringify(asked).slice(0, 200)}`);
    assert.ok(typeof requestId === 'string' && requestId.length > 0);

    // 3. THE DECISION HAPPENS ON THE CITY THAT RECEIVED THE ASK, on its own authenticated surface.
    const pendingOnA = await (await fetch(cityA.url + '/api/v0/join/requests', { headers: owner('link-a-control') })).json();
    assert.ok(pendingOnA.requests.some(r => r.id === requestId), 'City-A is where the ask was recorded');
    const approved = await fetch(cityA.url + `/api/v0/join/requests/${requestId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...owner('link-a-control') }, body: '{}' });
    assert.equal(approved.status, 200, 'the owner approves on the City they own');

    // 4. THE CREDENTIAL COMES BACK OVER THE SAME PIPE, once, against the one-time claim.
    const collected = await peer.forward('/api/v0/join/exchange', { requestId, claim });
    const credential = collected.response?.payload?.credential;
    assert.ok(typeof credential === 'string' && credential.length > 0, 'the approved credential is released over the pipe');

    // 5. THE COLLECTED CREDENTIAL IS REAL: it works against City-A as a session.
    const asJoined = await fetch(cityA.url + '/api/v0/city', { headers: owner(credential) });
    assert.equal(asJoined.status, 200, 'the joined PC can act in the City it joined');

    // 6. AND THE CLAIM IS SPENT - with the City's own status, not a relay failure.
    const second = await peer.forward('/api/v0/join/exchange', { requestId, claim });
    assert.equal(second.response?.status, 410, 'a spent claim is answered "already used"');

    // 7. THE PIPE DID NOT BECOME A SECOND TRUST STORE: the City that carried the ask recorded nothing.
    const pendingOnB = await (await fetch(cityB.url + '/api/v0/join/requests', { headers: owner('link-b-control') })).json();
    assert.equal(pendingOnB.requests.length, 0, 'only the City that decides records the ask');
  } finally {
    try { peer?.close(); } catch { /* already gone */ }
    await cityA.close();
    await cityB.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});
