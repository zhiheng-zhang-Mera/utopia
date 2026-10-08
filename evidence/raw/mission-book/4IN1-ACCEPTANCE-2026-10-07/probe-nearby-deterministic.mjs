// Deterministic repro: a LAN browse whose answer arrives AFTER the City's listener is gone.
// The gateway already accepts an injected `nearbyBrowser`, so the race is gated rather than timed.
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway} from 'file:///D:/utopia-4in1-verify/services/dev-gateway/server.mjs';

const dir = await mkdtemp(resolve('D:/utopia-chat/4in1-acceptance-2026-10-07/.scratch-nearby2-'));
let release;
const gate = new Promise(r => { release = r; });
const app = await createGateway({
  host: '127.0.0.1', port: 0, dir, token: 'owner', nodeToken: 'node', roomsDisabled: true, nearbyTimeoutMs: 5000,
  nearbyBrowser: async () => {
    await gate;
    // A neighbour that is NOT this City by identity, so the address/port half of the self-filter is the one that runs.
    return {candidates: [{cityId: null, cityRef: 'peer', displayName: 'Peer', address: '192.0.2.9', port: 4310, transport: 'LAN'}], bounded: true, discovered: 1, unavailable: false};
  },
});
const pending = fetch(app.url + '/api/v0/join/nearby', {headers: {'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'}})
  .then(r => r.status).catch(() => 'request-failed');
await new Promise(r => setTimeout(r, 150));
console.log('closing the City BEFORE the browse answers');
await app.close();
release();
console.log('request:', await pending);
await new Promise(r => setTimeout(r, 300));
console.log('REPRO-SURVIVED');
await rm(dir, {recursive: true, force: true});
