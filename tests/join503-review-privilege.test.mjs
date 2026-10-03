// JOIN-503 FORMAL REVIEW — Mech's regression test for the two privilege defects found in the reviewed head.
//
// FINDING D-1 (required repair): `POST /device/installations/:id/revoke` was reachable with a `sess:` credential,
// so an enrolled installation could revoke ANY OTHER installation - including the owner's own client - using only
// the short-lived session credential a browser holds. That contradicts the guard the author had already written on
// the two sibling routes (`SESSION_CANNOT_ENROLL`, `SESSION_CANNOT_REBIND`) and the intent stated in their own
// comment: "Nothing here is reachable by a session credential, so a joined device cannot enroll a second device
// for itself."
//
// FINDING D-2 (required repair): `GET /device/installations` answered a session credential with the City's ENTIRE
// enrollment roster - every installation and device record - while the same session was refused authority to
// enroll or rebind. The roster is owner information.
//
// The repair is the minimum that closes both without widening scope: a session may see and revoke ITSELF (a device
// leaving the City is legitimate and affects nobody else), and only the City's control token may see or act on
// another installation. The owner's Settings surface is unaffected because it holds the control token.
//
// These assertions FAIL on the reviewed head ede6fa2 and PASS with the repair, which is what makes them a guard
// rather than a description.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { enrollWithCity } from '../apps/client/device-enrollment.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const CONTROL = 'join503-review-token';

const post = async (url, path, body, credential) => {
  const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...V, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (url, path, credential) => {
  const r = await fetch(url + path, { headers: { ...V, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** One real join: the owner generates a pairing session, the installation exchanges it and declares itself. */
async function join(app, displayName) {
  const session = await post(app.url, '/api/v0/pairing/session', {}, CONTROL);
  assert.equal(session.status, 200, 'the owner generated a pairing session');
  const invite = { cityId: session.body.descriptor.cityId, sessionId: session.body.pairingSessionId, secret: new URLSearchParams(session.body.qrPayload.split('?')[1]).get('secret'), method: 'qr' };
  const { record, session: first } = await enrollWithCity({ endpoint: app.url, invite, displayName, platform: 'win32' });
  return { record, sessionCredential: first.credential };
}

test('REVIEW JOIN-503 D-1/D-2: a session may act on ITSELF and on nothing else', async () => {
  const dir = await mkdtemp(resolve('.scratch-review-join503-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: 'join503-review-node' });
    const first = await join(app, 'Review-PC-A');
    const second = await join(app, 'Review-PC-B');
    assert.ok(first.sessionCredential.startsWith('sess:') && second.sessionCredential.startsWith('sess:'));
    assert.notEqual(first.record.installationId, second.record.installationId);

    // The OWNER sees the whole roster, as the Settings surface needs.
    const ownerRoster = await get(app.url, '/api/v0/device/installations', CONTROL);
    assert.equal(ownerRoster.status, 200);
    assert.equal(ownerRoster.body.scope, 'CITY');
    assert.equal(ownerRoster.body.installations.length, 2);

    // D-2: a SESSION sees itself and only itself - not the City's roster.
    const sessionRoster = await get(app.url, '/api/v0/device/installations', first.sessionCredential);
    assert.equal(sessionRoster.status, 200);
    assert.equal(sessionRoster.body.scope, 'OWN_INSTALLATION', 'a session must be told its view is scoped to itself');
    assert.equal(sessionRoster.body.installations.length, 1, 'a session must not enumerate other installations');
    assert.equal(sessionRoster.body.installations[0].installationId, first.record.installationId);

    // D-1: a session may NOT revoke another installation.
    const crossRevoke = await post(app.url, `/api/v0/device/installations/${second.record.installationId}/revoke`, {}, first.sessionCredential);
    assert.equal(crossRevoke.status, 403, 'an enrolled session must not revoke another installation');
    assert.equal(crossRevoke.body.errorCode, 'SESSION_CANNOT_REVOKE_OTHER');
    // ...and the refusal really refused: B still works.
    const stillAlive = await get(app.url, '/api/v0/city', second.sessionCredential);
    assert.equal(stillAlive.status, 200, 'the victim installation was not affected by the refused revoke');

    // The owner CAN revoke B with the control token, and that revocation bites immediately.
    const ownerRevoke = await post(app.url, `/api/v0/device/installations/${second.record.installationId}/revoke`, {}, CONTROL);
    assert.equal(ownerRevoke.status, 200);
    assert.equal(ownerRevoke.body.scope, 'CITY');
    assert.equal((await get(app.url, '/api/v0/city', second.sessionCredential)).status, 401, 'a revoked installation is refused on the very next request');

    // A session revoking ITSELF is allowed (leaving the City affects nobody else), and it also stops working.
    const selfRevoke = await post(app.url, `/api/v0/device/installations/${first.record.installationId}/revoke`, {}, first.sessionCredential);
    assert.equal(selfRevoke.status, 200, 'a device may remove itself');
    assert.equal(selfRevoke.body.scope, 'OWN_INSTALLATION');
    assert.equal((await get(app.url, '/api/v0/city', first.sessionCredential)).status, 401);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});
