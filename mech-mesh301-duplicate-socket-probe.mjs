// MESH-301 FORMAL REVIEW - is `CLIENT_DISCONNECTED` a fact about a CLIENT or about a SOCKET?
//
// Why this exists: my own gate-1 analysis reconstructed each surface's presence from the City's CLIENT_CONNECTED /
// CLIENT_DISCONNECTED events and concluded that the Android surface was NOT connected across the declared gate-8
// window - while the Android receipt shows it observing continuously through that window and `controlSurfaces`
// lists it with an unbroken connectedAt. One of those three is wrong, and which one matters:
//   * if the events are right, the Android row of the gate-8 table is not what it claims to be;
//   * if the socket-level reading is right, my analysis method was wrong and gate 1 needs a different receipt.
//
// Reading the code first (`services/dev-gateway/server.mjs` at the review head) says the map is keyed by the
// SOCKET and the close handler deletes only its own socket but emits a REF-level disconnect:
//     controlSurfaces.set(ws, {...identity, connectedAt: now()});
//     emit('CLIENT_CONNECTED', null, {clientRef, clientLabel});
//     ws.on('close', () => { const gone = controlSurfaces.get(ws); controlSurfaces.delete(ws);
//                            if (!closed) emit('CLIENT_DISCONNECTED', null, {clientRef: gone?.clientRef, ...}); });
// A client with TWO live sockets therefore appears TWICE, and closing one of them announces that the client left.
// Reading the code is not evidence, so this reproduces it with two sockets of MY OWN, and observes all three
// views at once: the event stream, the controlSurfaces snapshot, and the sockets themselves.
import {WebSocket} from 'ws';

const CITY = (process.env.CITY_URL || 'http://172.31.3.110:4391').replace(/\/$/, '');
const TOKEN = process.env.CITY_TOKEN || '';
const WS_BASE = CITY.replace(/^http/, 'ws');
const H = {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const REF = `probe-mech-dup-${Math.random().toString(36).slice(2, 8)}`;
const LABEL = 'Mech-Dup-Probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(m);

const surfaces = async () => ((await (await fetch(`${CITY}/api/v0/city`, {headers: H})).json()).controlSurfaces ?? []);
const eventsSince = async (seq) => ((await (await fetch(`${CITY}/api/v0/events`, {headers: H})).json()).events ?? []).filter((e) => e.seq > seq && String(e.type).startsWith('CLIENT_'));
const maxSeq = async () => Math.max(0, ...((await (await fetch(`${CITY}/api/v0/events`, {headers: H})).json()).events ?? []).map((e) => e.seq ?? 0));
const mine = (list) => list.filter((s) => s.clientRef === REF);
const open = (tag) => new Promise((res, rej) => {
  const ws = new WebSocket(`${WS_BASE}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=${REF}&clientLabel=${LABEL}`, {headers: {Authorization: `Bearer ${TOKEN}`}});
  ws.on('open', () => res(ws)); ws.on('error', rej); setTimeout(() => rej(new Error(`${tag} open timeout`)), 8000);
});

const base = await maxSeq();
say(`probe clientRef=${REF} label=${LABEL}`);
say(`controlSurfaces entries for this probe BEFORE: ${mine(await surfaces()).length}`);

const a = await open('A');
await sleep(1200);
const afterA = await surfaces();
say(`AFTER socket A opens      : controlSurfaces entries for ${REF} = ${mine(afterA).length}  ${JSON.stringify(mine(afterA))}`);

const b = await open('B');
await sleep(1200);
const afterB = await surfaces();
say(`AFTER socket B opens      : controlSurfaces entries for ${REF} = ${mine(afterB).length}  ${JSON.stringify(mine(afterB))}`);
say(`  (the City keys control surfaces by SOCKET, so the same client is listed once per socket)`);

say('closing socket A while B stays open...');
a.close();
await sleep(2000);
const afterCloseA = await surfaces();
const ev = await eventsSince(base);
say(`AFTER socket A closes     : controlSurfaces entries for ${REF} = ${mine(afterCloseA).length}  ${JSON.stringify(mine(afterCloseA))}`);
say(`  CLIENT_* events for this probe: ${JSON.stringify(ev.map((e) => `${e.seq}:${e.type}:${e.payload?.clientRef}:${e.payload?.clientLabel}`))}`);

const closingEvent = ev.find((e) => e.type === 'CLIENT_DISCONNECTED' && e.payload?.clientRef === REF);
const stillListed = mine(afterCloseA).length > 0;
const bAlive = b.readyState === 1;

say('');
say('=== WHAT THIS SHOWS ===');
say(`socket B is still open                           : ${bAlive}`);
say(`the City still lists ${REF} as a control surface  : ${stillListed}`);
say(`the City emitted CLIENT_DISCONNECTED for ${REF}   : ${Boolean(closingEvent)}${closingEvent ? ` (seq ${closingEvent.seq})` : ''}`);
say(
  closingEvent && stillListed && bAlive
    ? '=> the DISCONNECT event is REF-level while the fact is SOCKET-level: an observer reconstructing presence from CLIENT_* events concludes this client left, while it is still connected and still listed. Reproduced.'
    : '=> the readings agree here; the hypothesis is NOT confirmed by this run and must not be reported as if it were.',
);

b.close();
await sleep(2000);
const afterCloseB = await surfaces();
say(`AFTER socket B closes     : controlSurfaces entries for ${REF} = ${mine(afterCloseB).length} (expected 0 - the entry is cleaned up when the LAST socket for it closes)`);
