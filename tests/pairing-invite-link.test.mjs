// N3: the SHAREABLE INVITE - the thing a person hands to the other Windows PC.
//
// WHY THIS HAS ITS OWN FILE. The report from the machine was specific: the web pairing screen had no entry for a
// code, and what it did offer was a `utopia://` deep link, which cannot be pasted into a browser's address bar. Both
// are properties of the SURFACE, so they are pinned here: the link must be a real http(s) URL a second machine can
// open, and the entry point must exist in BOTH the states a person can be in - disconnected (first screen) and
// connected (the Pairing page), because a connected client is the state everyone is actually in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { Pairing } from '../services/dev-gateway/pairing.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const WEB = file => readFileSync(new URL(`../apps/web/${file}`, import.meta.url), 'utf8');

test('N3: a pairing session offers a WEB link a second PC can open, without replacing the QR payload', async () => {
  const pairing = new Pairing({ cityId: 'city-1', endpoint: 'http://192.168.1.20:4310', credential: 'control' });
  const created = await pairing.create();
  assert.ok(typeof created.inviteUrl === 'string' && created.inviteUrl.startsWith('http://192.168.1.20:4310/'), `the link must be a real http URL, got ${created.inviteUrl}`);
  assert.ok(created.inviteUrl.includes('?pair='), 'the link carries the invite in a query a browser will send');
  // The QR / Android deep link is NOT replaced: a camera cannot read an http URL out of a native app handshake.
  assert.ok(created.qrPayload.startsWith('utopia://pair?'), 'the deep link stays for the QR and the Android app');
  // The link's own payload must parse back into the same session, or one of the two forms would be a dead end.
  // NOTE: what comes back out of `URLSearchParams.get` is the DECODED payload, so it is the inner query - the
  // `utopia://pair?` prefix the deep link needs is not part of it. The page accepts the inner query directly
  // (`beginPairingFromInvite` takes either shape), which is why the link works without a second decoder.
  const link = new URL(created.inviteUrl);
  const payload = new URLSearchParams(link.search).get('pair');
  const parsed = new URLSearchParams(payload);
  assert.equal(parsed.get('session'), created.pairingSessionId);
  assert.equal(parsed.get('city'), 'city-1');
  assert.ok(parsed.get('host'), 'the link names the City to switch to');
  assert.ok(parsed.get('secret'), 'and the one-time secret travels in it (single use, short TTL, attempt-locked)');
});

test('N3: the session route hands the web link to the surface, so the page has something to show', async () => {
  const dir = await mkdtemp(resolve('.scratch-invite-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'invite-control', nodeToken: 'invite-node' });
  try {
    const r = await fetch(app.url + '/api/v0/pairing/session', { method: 'POST', headers: { 'Content-Type': 'application/json', ...V, Authorization: 'Bearer invite-control' }, body: '{}' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(typeof body.inviteUrl === 'string' && body.inviteUrl.startsWith(app.url), 'the link points at THIS City');
    assert.ok(body.inviteUrl.includes('pair='), 'and carries the invite');
    assert.ok(typeof body.qrPayload === 'string' && body.qrPayload.startsWith('utopia://pair?'), 'the deep link is still returned for the QR');
    // The exchange itself must accept what the LINK carries, or the receiving page would be handed a dead link.
    const payload = new URLSearchParams(new URL(body.inviteUrl).search).get('pair');
    const parsed = new URLSearchParams(payload.slice(payload.indexOf('?') + 1));
    const exchanged = await fetch(app.url + '/api/v0/pairing/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', ...V }, body: JSON.stringify({ cityId: parsed.get('city'), method: 'qr', sessionId: parsed.get('session'), secret: parsed.get('secret') }) });
    assert.equal(exchanged.status, 200, 'the link a user pastes is a link that WORKS');
    const credential = (await exchanged.json()).credential;
    assert.ok(typeof credential === 'string' && credential.length > 0);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('N3: the pairing entry exists in BOTH states the page can be in', () => {
  const app = WEB('app.js');
  const html = WEB('index.html');
  // The first screen (disconnected): the card exists in the shell and the code fills it, because `render` bails out
  // without a snapshot - so a card filled only from `render` would be an empty section on the screen that needs it.
  assert.match(html, /id="pair-code-card"/, 'the disconnected screen has the entry host');
  assert.match(app, /function renderPairCodeCard\(/, 'the entry is defined once');
  assert.match(app, /syncPairEntry\(\);/, 'and it is filled outside `render` as well, or the first screen stays empty');
  // The Pairing page (connected): a second copy, with a DIFFERENT id prefix - two live copies sharing ids would make
  // querySelector return the hidden one and the visible card would read the other card's input. The prefix is `swap`
  // rather than `pairing` on purpose: `#pairing-code` is ALREADY the 6-digit short-code display on that page, and a
  // second element with that id broke JOIN-501's own acceptance test (it resolved to two elements).
  assert.match(app, /renderPairCodeCard\('swap'\)/, 'the Pairing page renders its own copy');
  assert.match(app, /id="\$\{prefix\}-code"/, 'and each copy names its own controls');
  // Both copies have to be wired, or one of them is decoration.
  assert.match(app, /e\.target\.id==='pair-code-connect'\|\|e\.target\.id==='swap-code-connect'/);
  assert.match(app, /e\.target\.id==='pair-invite-accept'\|\|e\.target\.id==='swap-invite-accept'/);
});

test('N3: the page can take a link from the address bar, and it asks before it connects', () => {
  const app = WEB('app.js');
  // The query is read (a pasted link) and the fragment still is (the hand-off from another page), and BOTH are
  // stripped from the address bar because they carry a one-time secret.
  assert.match(app, /bootQuery\.get\('pair'\)\?\?bootQuery\.get\('accept'\)/, 'the query string is a way in');
  assert.match(app, /beginPairingFromInvite\(bootInviteLink\)/, 'and it is handled at boot');
  assert.match(app, /history\.replaceState\(null,'',location\.pathname\+location\.hash\)/, 'the secret does not stay in the address bar');
  // A link that arrived by accident must not silently move this browser onto somebody else's City: the person who
  // opened it confirms once.
  assert.match(app, /async function acceptPendingInvite\(/, 'there is a confirm step');
  assert.match(app, /pairing\.linkReady/, 'and the surface says an invite is waiting');
});
