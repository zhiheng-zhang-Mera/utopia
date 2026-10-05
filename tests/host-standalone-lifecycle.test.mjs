// Single-machine page lifecycle.
//
// The rule under test: when the launcher opens this City for one person on this machine, the City's life belongs to
// the page that opened it - but only then. A City that is hosting devices must survive a page closing, a member page
// must not be able to release someone else's City, and a stored membership must not divert an ordinary start.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {WebSocket} from 'ws';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {planStart, followsMembership, pageTied, describeStart} from '../scripts/launcher-plan.mjs';

const V = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const auth = token => ({...V, Authorization: 'Bearer ' + token});

async function city(options, fn) {
  const dir = await mkdtemp(resolve('.scratch-standalone-'));
  let app;
  const exits = [];
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true, onLifecycleExit: reason => exits.push(reason), ...options});
    const headers = auth('owner');
    const get = async (path, token = 'owner') => { const r = await fetch(app.url + '/api/v0/' + path, {headers: auth(token)}); return {status: r.status, body: await r.json()}; };
    const post = async (path, body, token = 'owner') => { const r = await fetch(app.url + '/api/v0/' + path, {method: 'POST', headers: auth(token), body: JSON.stringify(body ?? {})}); return {status: r.status, body: await r.json()}; };
    await fn({app, exits, get, post, headers, dir});
  } finally { await app?.close(); await rm(dir, {recursive: true, force: true}); }
}

const openSurface = (app, clientRef = 'page-1') => new Promise((yes, no) => {
  const url = `${app.url.replace(/^http/, 'ws')}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=${encodeURIComponent(clientRef)}&clientLabel=${encodeURIComponent('Review page')}`;
  const ws = new WebSocket(url, {headers: auth('owner')});
  ws.once('open', () => yes(ws));
  ws.once('error', no);
});
const closeSurface = ws => new Promise(yes => { ws.once('close', yes); ws.close(); });
const waitFor = async (predicate, ms = 3000) => { const until = Date.now() + ms; while (Date.now() < until) { if (predicate()) return true; await new Promise(r => setTimeout(r, 25)); } return predicate(); };

test('PROBE 1: the start plan defaults to a page-tied single-machine City and only --online follows a membership', () => {
  const plain = planStart({args: []});
  assert.equal(plain.mode, 'standalone-page', 'the default start is the single-machine one');
  assert.equal(plain.lifecycle, 'page', 'and it is tied to the page that opened it');
  assert.equal(followsMembership(plain), false, 'the default never follows a stored membership');
  assert.equal(pageTied(plain), true);

  const hosting = planStart({args: ['--host-only', '--json']});
  assert.equal(hosting.mode, 'standalone-service');
  assert.equal(pageTied(hosting), false, 'a host serving other devices must not follow a page');

  const online = planStart({args: ['--online']});
  assert.equal(online.mode, 'online-member');
  assert.equal(followsMembership(online), true, 'going online is the act that honours the stored role');
  assert.equal(pageTied(online), false);
});

test('PROBE 2: closing the last page in page mode closes the City, and says why', () => city({lifecycle: 'page', pageIdleMs: 250}, async ({app, exits}) => {
  const ws = await openSurface(app);
  assert.equal(exits.length, 0, 'the City must not close while the page is still attached');
  await closeSurface(ws);
  assert.equal(await waitFor(() => exits.length > 0), true, 'the City must close once the page is gone');
  assert.match(exits[0], /left without releasing/i);
  assert.equal(app.lifecycle, 'page');
}));

test('PROBE 3: a reload inside the grace window does NOT close the City', () => city({lifecycle: 'page', pageIdleMs: 400}, async ({app, exits}) => {
  const first = await openSurface(app, 'page-reload');
  await closeSurface(first);
  // A reload closes and reopens the stream well inside the grace window.
  const second = await openSurface(app, 'page-reload');
  await new Promise(r => setTimeout(r, 550));
  assert.equal(exits.length, 0, 'reconnecting within the grace window must cancel the exit');
  await closeSurface(second);
  assert.equal(await waitFor(() => exits.length > 0), true, 'and the City still closes when the page really goes away');
}));

test('PROBE 4: a second surface keeps the City alive', () => city({lifecycle: 'page', pageIdleMs: 250}, async ({app, exits}) => {
  const one = await openSurface(app, 'page-a');
  const two = await openSurface(app, 'page-b');
  await closeSurface(one);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(exits.length, 0, 'one page leaving must not take the City from the other');
  await closeSurface(two);
  assert.equal(await waitFor(() => exits.length > 0), true);
}));

test('PROBE 5: a City that never had a page does not close itself', () => city({lifecycle: 'page', pageIdleMs: 200}, async ({exits}) => {
  await new Promise(r => setTimeout(r, 500));
  assert.equal(exits.length, 0, 'a headless City has no page to lose, so nothing may close it');
}));

test('PROBE 6: the owner page can release the City explicitly, and only the owner', () => city({lifecycle: 'page', pageIdleMs: 60000}, async ({app, exits, post, get}) => {
  // A member page must not be able to release the City it is a guest in.
  const admission = await post('device/enroll', {displayName: 'Member page'});
  const session = (await post('device/session', {installationId: admission.body.installation.installationId, instanceId: admission.body.installation.instanceId, ...admission.body.credential})).body.credential;
  const refused = await post('host/release', {}, session);
  assert.equal(refused.status, 403, 'releasing the City is the owner act');
  assert.equal(exits.length, 0);
  // The snapshot tells the page whether it is allowed to matter at all.
  assert.equal((await get('city')).body.lifecycle, 'page');
  const released = await post('host/release', {});
  assert.equal(released.status, 200);
  assert.equal(released.body.released, true);
  assert.equal(await waitFor(() => exits.length > 0), true, 'the explicit release closes the City');
}));

test('PROBE 7: a hosting City ignores the release and never follows a page', () => city({lifecycle: 'service', pageIdleMs: 150}, async ({app, exits, post, get}) => {
  assert.equal((await get('city')).body.lifecycle, 'service', 'the page is told this City is not its to close');
  const ws = await openSurface(app, 'page-on-service');
  await closeSurface(ws);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(exits.length, 0, 'a City hosting devices must survive a page closing');
  const released = await post('host/release', {});
  assert.equal(released.status, 200);
  assert.equal(released.body.released, false, 'and it must answer honestly that nothing was released');
  assert.equal(released.body.reason, 'this City is not tied to a page');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(exits.length, 0);
}));

test('PROBE 8: the person starting a City is told which life it got, and told why their stored role was ignored', () => {
  // §14A: a start that changes long-running background behaviour must disclose itself rather than let the person infer
  // it from the City vanishing later. These are the exact words the launcher prints in human mode.
  const page = describeStart({lifecycle: 'page', roleIgnored: true});
  assert.equal(page.length, 2);
  assert.match(page[0], /follows this page: closing it closes the City/);
  assert.match(page[1], /does not use the stored role; going online is what changes the role/);

  const service = describeStart({lifecycle: 'service', roleIgnored: true});
  assert.match(service[0], /keeps running on its own/);
  assert.equal(describeStart({lifecycle: 'online', roleIgnored: false}).length, 1);
  assert.match(describeStart({lifecycle: 'online'})[0], /online/);

  // An enrolment report carries no lifecycle and no ignored role: it must not invent a disclosure it cannot support.
  assert.deepEqual(describeStart({role: 'MEMBER'}), []);
  assert.deepEqual(describeStart(), []);
  // And a mode that keeps its own life must never claim to close with the page.
  assert.equal(describeStart({lifecycle: 'service'}).some(line => /closing it closes/.test(line)), false);
});
