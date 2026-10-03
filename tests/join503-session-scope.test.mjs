// JOIN-503 — regression guard for Mech's formal-review findings D-1 / D-2 (privilege escalation across
// installations), re-applied on the development branch by the author.
//
// THE DEFECT MECH FOUND, IN ONE SENTENCE: `auth()` accepts a `sess:` credential, so every route that relied on
// `auth()` alone was reachable by any ENROLLED INSTALLATION - and two of them handed that session authority that
// belongs to the owner. `POST /device/installations/:id/revoke` let a session revoke ANY OTHER installation,
// including the client the owner was using, with nothing but the short-lived credential a browser keeps in
// sessionStorage. `GET /device/installations` answered the same session with the City's whole enrollment roster.
//
// WHY THIS TEST EXISTS RATHER THAN A NOTE: the boundary was already stated in this branch - two sibling routes
// refuse a session with SESSION_CANNOT_ENROLL / SESSION_CANNOT_REBIND - and it was still missed on the third. An
// intent that is enforced route by route is not a boundary. So this file asserts the RULE over the whole route
// family, including the read route and the population-level clone scan, which is one step further than the
// review's minimum because `cloneFindings` also names other installations.
//
// IT IS A GUARD, NOT A DESCRIPTION: it FAILS on the unrepaired head `ede6fa2` (roster scope undefined, the clone
// scan disclosed, the cross-installation revoke returning 200) and PASSES with the repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { enrollWithCity } from '../apps/client/device-enrollment.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const CONTROL = 'join503-d1-token';

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
  assert.ok(first.credential.startsWith('sess:'), 'a join hands out a session credential');
  return { record, sessionCredential: first.credential };
}

/** Two installations in one City, which is the minimum topology for a cross-installation attack. */
async function cityWithTwoInstallations() {
  const dir = await mkdtemp(resolve('.scratch-join503-d1-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: 'join503-d1-node' });
  const a = await join(app, 'D1-PC-A');
  const b = await join(app, 'D1-PC-B');
  assert.notEqual(a.record.installationId, b.record.installationId);
  return { app, dir, a, b };
}

test('D-1: an enrolled session may NOT revoke another installation, and the refusal really refuses', async () => {
  const { app, dir, a, b } = await cityWithTwoInstallations();
  try {
    const cross = await post(app.url, `/api/v0/device/installations/${b.record.installationId}/revoke`, {}, a.sessionCredential);
    assert.equal(cross.status, 403, 'a session must not revoke another installation');
    assert.equal(cross.body.errorCode, 'SESSION_CANNOT_REVOKE_OTHER', 'and the refusal is typed, not a bare 403');
    // The refusal must be a REFUSAL and not merely a reported error: B is untouched.
    assert.equal((await get(app.url, '/api/v0/city', b.sessionCredential)).status, 200, 'the victim installation still works');
    const roster = await get(app.url, '/api/v0/device/installations', CONTROL);
    assert.equal(roster.body.installations.find(i => i.installationId === b.record.installationId).state, 'BOUND', 'B was not retired');
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('D-2: a session sees ONLY itself - not the roster, and not the City-wide clone scan', async () => {
  const { app, dir, a } = await cityWithTwoInstallations();
  try {
    const owner = await get(app.url, '/api/v0/device/installations', CONTROL);
    assert.equal(owner.status, 200);
    assert.equal(owner.body.scope, 'CITY');
    assert.equal(owner.body.installations.length, 2, 'the owner sees the whole City, as Settings needs');

    const session = await get(app.url, '/api/v0/device/installations', a.sessionCredential);
    assert.equal(session.status, 200, 'a session may read its OWN record');
    assert.equal(session.body.scope, 'OWN_INSTALLATION', 'and is told its view is scoped');
    assert.equal(session.body.installations.length, 1, 'a session must not enumerate other installations');
    assert.equal(session.body.installations[0].installationId, a.record.installationId);
    // The population-level scan names OTHER installations' ids and credential fingerprints, so it is owner
    // information too. An empty array is the honest answer to "which installations of the City are duplicated?"
    // when the caller is only allowed to know about itself.
    assert.deepEqual(session.body.cloneFindings, [], 'a session must not receive the City-wide clone scan');
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('D-1/D-2: the owner keeps FULL authority, so the repair did not break the surface it protects', async () => {
  const { app, dir, a, b } = await cityWithTwoInstallations();
  try {
    const ownerRevoke = await post(app.url, `/api/v0/device/installations/${b.record.installationId}/revoke`, {}, CONTROL);
    assert.equal(ownerRevoke.status, 200, 'the control token still revokes any installation');
    assert.equal(ownerRevoke.body.scope, 'CITY');
    assert.equal((await get(app.url, '/api/v0/city', b.sessionCredential)).status, 401, 'and the revocation bites on the very next request');

    // A device leaving the City is legitimate and affects nobody else, so a self-revoke still works.
    const selfRevoke = await post(app.url, `/api/v0/device/installations/${a.record.installationId}/revoke`, {}, a.sessionCredential);
    assert.equal(selfRevoke.status, 200, 'a session may remove ITSELF');
    assert.equal(selfRevoke.body.scope, 'OWN_INSTALLATION');
    assert.equal((await get(app.url, '/api/v0/city', a.sessionCredential)).status, 401, 'and then it is gone');
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('D-1/D-2: the two sibling guards the review compared against are still in place', async () => {
  const { app, dir, a } = await cityWithTwoInstallations();
  try {
    // If these ever regress too, the asymmetry Mech identified would come back from the other direction.
    const enroll = await post(app.url, '/api/v0/device/enroll', { displayName: 'sneaky' }, a.sessionCredential);
    assert.equal(enroll.status, 403);
    assert.equal(enroll.body.error, 'SESSION_CANNOT_ENROLL');
    const rebind = await post(app.url, `/api/v0/device/installations/${a.record.installationId}/rebind`, { deviceId: a.record.deviceId, proof: { kind: 'x' } }, a.sessionCredential);
    assert.equal(rebind.status, 403);
    assert.equal(rebind.body.error, 'SESSION_CANNOT_REBIND');
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});
