// D-R1 — `CLIENT_DISCONNECTED` must be a fact about the CLIENT, not about a socket.
//
// Mech's Formal Review reproduced this against the review head and required its repair:
//
//   "services/dev-gateway/server.mjs keys `controlSurfaces` by SOCKET and emits a ref-level disconnect
//    whenever ANY socket for that ref closes."
//
// The consequence was not cosmetic. In production:
//
//   seq 473  03:32:35Z  CLIENT_DISCONNECTED android-PERM00    (a superseded socket's late close)
//           ... and no CLIENT_CONNECTED for PERM00 afterwards, while PERM00's own receipt observes until
//           04:27:30Z and `controlSurfaces` still lists it.
//
// So anyone reconstructing "which surfaces are online" from canonical events concluded the Android surface
// left at 03:32:35 and never came back — a false negative emitted by the City itself, against the workbook's
// requirement that every device can see what the others are doing. Mech's own gate-1 analysis did exactly
// that and reported `android: false` for the whole gate-8 window.
//
// This test is Mech's reproduction, made permanent, so a later refactor cannot quietly reintroduce it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGateway } from '../services/dev-gateway/server.mjs';

const headers = { Authorization: 'Bearer surf-control', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };

async function openSurface(gateway, { clientRef, clientLabel }) {
  const url = `${gateway.url.replace(/^http/, 'ws')}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=${encodeURIComponent(clientRef)}&clientLabel=${encodeURIComponent(clientLabel)}`;
  const ws = new WebSocket(url, { headers });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return ws;
}
const closeSurface = ws => new Promise(res => { ws.once('close', res); ws.close(); });

test('D-R1: a surface with two sockets is ONE surface, and only the last socket closing announces its departure', async () => {
  const dir = await mkdtemp(resolve('.scratch-surface-'));
  let gateway, a, b;
  try {
    gateway = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'surf-control', nodeToken: 'surf-node' });
    const city = async () => (await fetch(`${gateway.url}/api/v0/city`, { headers })).json();
    const eventsOfType = async type => (await city()).events.filter(e => e.type === type);
    const rowsFor = async ref => (await city()).controlSurfaces.filter(s => s.clientRef === ref);
    const eventsFor = async (type, ref) => (await eventsOfType(type)).filter(e => e.payload.clientRef === ref);

    // --- one surface, two sockets: a reconnect overlap, or a second tab.
    a = await openSurface(gateway, { clientRef: 'test-surface', clientLabel: 'Test Surface' });
    await sleep(150);
    assert.equal((await rowsFor('test-surface')).length, 1, 'one socket must produce exactly one row');

    b = await openSurface(gateway, { clientRef: 'test-surface', clientLabel: 'Test Surface' });
    await sleep(150);
    // Mech's first symptom: "AFTER socket B opens, controlSurfaces entries for this ref = 2".
    assert.equal((await rowsFor('test-surface')).length, 1, 'a second socket for the same client must not add a second row');
    assert.equal((await eventsFor('CLIENT_CONNECTED', 'test-surface')).length, 1, 'CONNECTED is emitted when the client arrives, not once per socket');

    // --- close the first socket while the second is still open.
    await closeSurface(a); a = null;
    await sleep(200);
    // Mech's second symptom: "events: CONNECTED, CONNECTED, DISCONNECTED - announces the client LEFT".
    assert.equal((await eventsFor('CLIENT_DISCONNECTED', 'test-surface')).length, 0, 'closing ONE of two sockets must not announce that the client left');
    assert.equal((await rowsFor('test-surface')).length, 1, 'the client is still present, so it is still listed');

    // --- close the last one: now, and only now, the client has left.
    await closeSurface(b); b = null;
    await sleep(200);
    assert.equal((await eventsFor('CLIENT_DISCONNECTED', 'test-surface')).length, 1, 'the last socket closing announces the departure exactly once');
    assert.equal((await rowsFor('test-surface')).length, 0, 'and the client is gone from the live list');

    // --- and the rule is not over-applied: a DIFFERENT ref keeps its own row and its own events.
    const other = await openSurface(gateway, { clientRef: 'test-surface-2', clientLabel: 'Second Surface' });
    await sleep(150);
    assert.equal((await rowsFor('test-surface-2')).length, 1, 'a different client is a different row');
    assert.equal((await eventsFor('CLIENT_CONNECTED', 'test-surface-2')).length, 1);
    await closeSurface(other);
    await sleep(200);
    assert.equal((await eventsFor('CLIENT_DISCONNECTED', 'test-surface-2')).length, 1);
  } finally {
    for (const ws of [a, b]) { try { ws?.terminate(); } catch { /* already gone */ } }
    await gateway?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('D-R1: an ANONYMOUS surface is still recorded, and anonymous sockets do not silence each other', async () => {
  // The de-duplication must not become a way of losing a client. Anonymous surfaces share a key by
  // construction, so they are the case where a naive count-per-ref could either merge strangers or drop them.
  const dir = await mkdtemp(resolve('.scratch-surface-anon-'));
  let gateway, a, b;
  try {
    gateway = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'surf-control', nodeToken: 'surf-node' });
    const city = async () => (await fetch(gateway.url + '/api/v0/city', { headers })).json();
    a = await openSurface(gateway, { clientRef: '', clientLabel: '' });
    await sleep(150);
    b = await openSurface(gateway, { clientRef: '', clientLabel: '' });
    await sleep(150);
    const anonymous = (await city()).controlSurfaces.filter(s => s.clientRef === null);
    assert.equal(anonymous.length, 1, 'anonymous surfaces are one presence, honestly labelled null');
    await closeSurface(a); a = null;
    await sleep(200);
    assert.equal((await city()).controlSurfaces.filter(s => s.clientRef === null).length, 1, 'the second anonymous socket still holds the presence');
    await closeSurface(b); b = null;
    await sleep(200);
    assert.equal((await city()).controlSurfaces.filter(s => s.clientRef === null).length, 0);
  } finally {
    for (const ws of [a, b]) { try { ws?.terminate(); } catch { /* already gone */ } }
    await gateway?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
