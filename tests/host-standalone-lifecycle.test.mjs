// Single-machine page lifecycle.
//
// The rule under test: when the launcher opens this City for one person on this machine, the City's life belongs to
// the page that opened it - but only then. A City that is hosting devices must survive a page closing, a member page
// must not be able to release someone else's City, and a stored membership must not divert an ordinary start.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {WebSocket} from 'ws';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {resolveLifecycle, selectMemberFile} from '../services/dev-gateway/host-lifecycle.mjs';
import {planStart, followsMembership, pageTied, describeStart, hostsOwnCity, mayFollowStoredMembership} from '../scripts/launcher-plan.mjs';

const V = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const auth = token => ({...V, Authorization: 'Bearer ' + token});
const ROOT = resolve(import.meta.dirname, '..');

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

test('PROBE 1: the start plan defaults to a page-tied single-machine City, and only --online forces a membership', () => {
  const plain = planStart({args: []});
  assert.equal(plain.mode, 'standalone-page', 'the default start is the single-machine one');
  assert.equal(plain.lifecycle, 'page', 'and it is tied to the page that opened it');
  assert.equal(followsMembership(plain), false, 'the default does not ASK to follow a stored membership');
  assert.equal(pageTied(plain), true);
  assert.equal(hostsOwnCity(plain), false, 'but it is also not an explicit hosting start');

  const hosting = planStart({args: ['--host-only', '--json']});
  assert.equal(hosting.mode, 'standalone-service');
  assert.equal(pageTied(hosting), false, 'a host serving other devices must not follow a page');
  assert.equal(hostsOwnCity(hosting), true, 'hosting says so explicitly');

  const online = planStart({args: ['--online']});
  assert.equal(online.mode, 'online-member');
  assert.equal(followsMembership(online), true, 'going online is the act that honours the stored role');
  assert.equal(pageTied(online), false);
});

test('PROBE 9: an explicit hosting start never consults a stored membership, and no other start turns a member host into a second City', () => {
  // This rule was caught by hosted CI, not by this host: gating the membership path on --online alone made a plain
  // start (the `--port` reconnect case JOIN-503 accepts) ignore its enrollment and launch a SECOND City in the member's
  // state directory. The test that covers it is tests/host-city-launcher.test.mjs:95, which fails here for an unrelated
  // environmental reason (a City is already reserved on this host), so the rule is pinned in the plan as well.
  const plain = planStart({args: ['--port', '4998']});
  assert.equal(mayFollowStoredMembership(plain), true, 'a plain start may reconnect to the membership still on disk');
  assert.equal(followsMembership(plain), false, 'a reconnect is not a role ADJUSTMENT');

  const hosting = planStart({args: ['--host-only']});
  assert.equal(mayFollowStoredMembership(hosting), false, 'hosting this host\'s own City ignores whatever membership is on disk');

  const online = planStart({args: ['--online']});
  assert.equal(mayFollowStoredMembership(online), true);

  // The three modes are exhaustive: a plan cannot be both hosting and membership-forced.
  for (const args of [[], ['--port', '4998'], ['--host-only'], ['--online'], ['--enroll-code', '123456']]) {
    const plan = planStart({args});
    assert.equal(hostsOwnCity(plan) && followsMembership(plan), false, `${args.join(' ')} cannot both host and force a membership`);
  }
});

test('PROBE 10: a member agent is an online start whatever was declared, so it can never become a host City of its own', () => {
  // This is the second half of the CI-caught regression: the launcher spawns the member agent with CITY_MEMBER_FILE and
  // no lifecycle, and a predicate that only read CITY_LIFECYCLE made that process start as a PRIMARY City - a host City
  // where the caller had deliberately asked for none.
  const member = resolveLifecycle({CITY_MEMBER_FILE: 'enrollment.json'});
  assert.equal(member.online, true, 'a member agent is online by construction');
  assert.equal(member.lifecycle, 'online');
  assert.equal(member.roleIgnored, false, 'its stored role is the whole point of the start');
  assert.equal(member.gatewayLifecycle, 'service', 'a member agent has no page, so it must never be page-tied');

  const plain = resolveLifecycle({});
  assert.equal(plain.lifecycle, 'page', 'the default life is unchanged');
  assert.equal(plain.roleIgnored, true);
  assert.equal(plain.gatewayLifecycle, 'page');

  assert.equal(resolveLifecycle({CITY_LIFECYCLE: 'service'}).gatewayLifecycle, 'service');
  assert.equal(resolveLifecycle({CITY_LIFECYCLE: 'service'}).roleIgnored, true, 'hosting ignores the role');
  assert.equal(resolveLifecycle({CITY_LIFECYCLE: 'online'}).online, true);
  assert.equal(resolveLifecycle({CITY_LIFECYCLE: 'nonsense'}).lifecycle, 'page', 'an unknown value falls back to the documented default rather than to a mode nobody asked for');
  // The declared value can never *remove* the member agent's online-ness.
  assert.equal(resolveLifecycle({CITY_LIFECYCLE: 'page', CITY_MEMBER_FILE: 'x.json'}).online, true);
});

test('PROBE 12: which membership a start may use - the four cases hosted CI forced into the open', () => {
  const enrollment = {cityId: '11111111-2222-3333-4444-555555555555'};
  const memberSelection = {role: 'MEMBER', cityId: enrollment.cityId, memberEnrollmentFile: 'member.json'};

  // 1. A member agent is followed no matter what else is on disk.
  assert.deepEqual(selectMemberFile({env: {CITY_MEMBER_FILE: 'agent.json'}, selection: memberSelection, hasRoleSelection: true, deviceFile: 'device.json', deviceEnrollment: enrollment, online: false}), {file: 'agent.json', source: 'MEMBER_AGENT', refuse: null});

  // 2. A STORED MEMBER SELECTION is resumed - including on a plain start, because that is this host continuing to be a
  //    member of a City it already belongs to (tests/host-city-launcher.test.mjs asserts the reachable half).
  assert.deepEqual(selectMemberFile({selection: memberSelection, hasRoleSelection: true, deviceFile: 'device.json', deviceEnrollment: enrollment, online: false}), {file: 'member.json', source: 'STORED_MEMBER_SELECTION', refuse: null});

  // 3. ...but a selection whose credential is gone REFUSES. It must never quietly become a PRIMARY City in its place.
  const refused = selectMemberFile({selection: memberSelection, hasRoleSelection: true, deviceFile: 'device.json', deviceEnrollment: null, online: false});
  assert.equal(refused.file, null);
  assert.match(refused.refuse, /credential unavailable/);
  assert.doesNotMatch(String(refused.file), /device\.json/, 'the leftover device file must not be used to paper over a lost member credential');

  // 4. A LEFTOVER enrollment with NO stored selection must NOT divert an ordinary start. This is the reported defect.
  assert.deepEqual(selectMemberFile({selection: {role: 'PRIMARY'}, hasRoleSelection: false, deviceFile: 'device.json', deviceEnrollment: enrollment, online: false}), {file: null, source: 'NONE', refuse: null});
  // ...and going online is exactly when that leftover enrollment may be used.
  assert.deepEqual(selectMemberFile({selection: {role: 'PRIMARY'}, hasRoleSelection: false, deviceFile: 'device.json', deviceEnrollment: enrollment, online: true}), {file: 'device.json', source: 'LEFTOVER_ENROLLMENT', refuse: null});
  // Nothing at all is still a host start.
  assert.deepEqual(selectMemberFile({}), {file: null, source: 'NONE', refuse: null});
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
