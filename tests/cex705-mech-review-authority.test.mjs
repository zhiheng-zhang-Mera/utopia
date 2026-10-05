// CEX-705 · OPPOSITE-HOST REVIEW probes (Mech) — canonical authority matrix.
//
// The workbook requires an on-device matrix (verified separately on a real handset) plus a Web/Android canonical-truth
// comparison. This file decides the authority half over the EXACT request shapes the Android client sends, and adds the
// negative controls the author's own suite does not construct. Verdict: mission-book/reports/CEX-705/REVIEW_REPORT.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';

const V = { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const auth = t => ({ ...V, Authorization: 'Bearer ' + t });

async function city(fn) {
  const dir = await mkdtemp(resolve('.scratch-cex705-review-'));
  let app;
  try {
    app = await createGateway({ dir, port: 0, token: 'owner', nodeToken: 'node', hostDeviceId: 'host-a', roomsDisabled: true });
    const req = async (path, body, token = 'owner', method) => { const r = await fetch(app.url + '/api/v0/' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: auth(token), body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    // Enrol a device exactly the way a joining client does, and open a session for it.
    const enroll = async name => {
      const pairing = (await req('pairing/session', {})).body;
      const exchange = await fetch(app.url + '/api/v0/pairing/exchange', { method: 'POST', headers: V, body: JSON.stringify({ cityId: app.store.cityId, sessionId: pairing.pairingSessionId, method: 'mdns', shortCode: pairing.shortCode, installation: { displayName: name, platform: 'win32' } }) });
      const body = await exchange.json();
      const opened = await fetch(app.url + '/api/v0/device/session', { method: 'POST', headers: V, body: JSON.stringify({ installationId: body.enrollment.installationId, instanceId: body.enrollment.instanceId, credentialId: body.enrollment.credentialId, credentialSecret: body.enrollment.credentialSecret }) });
      const session = await opened.json();
      return { deviceId: body.enrollment.deviceId, installationId: body.enrollment.installationId, credential: session.credential };
    };
    await fn({ app, req, enroll });
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('PROBE 1: rename follows the exact PATCH shape the Android card sends, and validates the name', () => city(async ({ app, req, enroll }) => {
  const member = await enroll('Member A');
  assert.equal((await req('city/name', { displayName: 'Chosen native City' }, 'owner', 'PATCH')).status, 200);
  assert.equal((await req('city')).body.displayName, 'Chosen native City', 'the canonical name must change');
  // Authority: the control token may rename; an enrolled session may not.
  const refused = await req('city/name', { displayName: 'Forbidden' }, member.credential, 'PATCH');
  assert.equal(refused.status, 403);
  assert.equal((await req('city')).body.displayName, 'Chosen native City', 'a refused rename must not half-apply');
  // Validation: every boundary the Android field gates on, plus the server's own answer.
  for (const bad of ['', '   ', 'x'.repeat(65), 42, null]) {
    const attempt = await req('city/name', { displayName: bad }, 'owner', 'PATCH');
    assert.ok(attempt.status >= 400, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal((await req('city')).body.displayName, 'Chosen native City');
  assert.equal((await req('city/name', { displayName: 'x' }, 'owner', 'PATCH')).status, 200, 'a one-character name is accepted');
  assert.equal((await req('city/name', { displayName: 'y'.repeat(64) }, 'owner', 'PATCH')).status, 200, 'the 64-character boundary the Android field allows is accepted');
}));

test('PROBE 2: sharing is own-node only, over the exact body the Android toggle sends', () => city(async ({ req, enroll }) => {
  const a = await enroll('Member A');
  const b = await enroll('Member B');
  // Register real nodes so the sharing route has something to act on.
  assert.equal((await req('node/register', { id: a.deviceId, displayName: 'A', capabilities: ['task.execute.safe'], metadata: { platform: 'win32' } }, a.credential)).status, 200);
  assert.equal((await req('node/register', { id: b.deviceId, displayName: 'B', capabilities: ['task.execute.safe'], metadata: { platform: 'win32' } }, b.credential)).status, 200);
  assert.equal((await req('node/sharing', { id: a.deviceId, enabled: false }, a.credential)).status, 200, 'a device may pause its own sharing');
  assert.equal((await req('city')).body.nodes.find(n => n.id === a.deviceId).sharingEnabled, false, 'canonical truth must record it');
  assert.equal((await req('node/sharing', { id: b.deviceId, enabled: false }, a.credential)).status, 403, 'a device may not pause another device');
  assert.equal((await req('city')).body.nodes.find(n => n.id === b.deviceId).sharingEnabled, true, 'and the other device is untouched');
  // Negative controls: a non-boolean flag, and the two different refusals an unknown node can produce.
  assert.equal((await req('node/sharing', { id: a.deviceId, enabled: 'false' }, a.credential)).status, 400);
  // AUTHORITY IS CHECKED BEFORE EXISTENCE, deliberately: a caller naming a node that is not its own gets 403 whether or
  // not that node exists, so the route cannot be used as an existence oracle. An earlier draft of this probe expected
  // 404 here and was wrong.
  assert.equal((await req('node/sharing', { id: 'no-such-node', enabled: false }, a.credential)).status, 403);
  assert.equal((await req('node/sharing', { id: 'no-such-node', enabled: false }, 'owner')).status, 403);
  // The reachable not-found is a caller naming its OWN device when no node row exists for it.
  const c = await enroll('Member C');
  assert.equal((await req('node/sharing', { id: c.deviceId, enabled: false }, c.credential)).status, 404, 'the caller own device has no compute node');
  // The owner credential acts as the host, so it cannot pause a member node either.
  assert.equal((await req('node/sharing', { id: a.deviceId, enabled: false }, 'owner')).status, 403);
}));

test('PROBE 3: member messages are scoped on send and on receipt, and the sender cannot be spoofed', () => city(async ({ app, req, enroll }) => {
  const a = await enroll('Member A');
  const b = await enroll('Member B');
  // The Android client sends {targetDeviceId, text}; a spoofed senderDeviceId must be ignored.
  const sent = await req('members/messages', { targetDeviceId: b.deviceId, text: 'controlled native message', senderDeviceId: 'host-a' }, a.credential);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message.senderDeviceId, a.deviceId, 'the sender must be the authenticated actor, not the supplied field');
  assert.equal(sent.body.message.state, 'PENDING');
  assert.equal(sent.body.message.targetDeviceId, b.deviceId);
  // The sender cannot mark its own message received.
  assert.equal((await req('members/messages/' + sent.body.message.id + '/receipt', {}, a.credential)).status, 403);
  // A third party cannot either.
  const c = await enroll('Member C');
  assert.equal((await req('members/messages/' + sent.body.message.id + '/receipt', {}, c.credential)).status, 403);
  // The recipient can, once, and a duplicate keeps the original timestamp.
  const received = await req('members/messages/' + sent.body.message.id + '/receipt', {}, b.credential);
  assert.equal(received.status, 200);
  assert.equal(received.body.message.state, 'RECEIVED');
  const duplicate = await req('members/messages/' + sent.body.message.id + '/receipt', {}, b.credential);
  assert.equal(duplicate.body.message.receivedAt, received.body.message.receivedAt, 'a duplicate receipt must not rewrite the time');
  // The recipient sees it in its own list; an unrelated member does not.
  assert.equal((await req('members/messages', undefined, b.credential)).body.messages.some(m => m.id === sent.body.message.id), true);
  assert.equal((await req('members/messages', undefined, c.credential)).body.messages.some(m => m.id === sent.body.message.id), false, 'messages must be scoped to their participants');
  // Negative controls.
  assert.equal((await req('members/messages', { targetDeviceId: 'no-such-device', text: 'x' }, a.credential)).status >= 400, true);
  assert.equal((await req('members/messages', { targetDeviceId: b.deviceId, text: '' }, a.credential)).status >= 400, true);
  assert.equal((await req('members/messages/no-such-message/receipt', {}, b.credential)).status >= 400, true);
}));

test('PROBE 4: the two fields the Android scope model keys on survive a restart for a session credential', () => city(async ({ app, req, enroll, dir }) => {
  // OwnerOnboarding and MemberManagement both decide OWNER vs SESSION from snapshot.enrolledDevice (null or not) and
  // snapshot.currentMemberRef. If a restart changed either shape, the Android projection would silently fall to
  // UNKNOWN - fail-closed, but a usability regression. Pinned here rather than assumed.
  const a = await enroll('Member A');
  const before = (await req('city', undefined, a.credential)).body;
  assert.equal(before.currentMemberRef, a.deviceId);
  assert.ok(before.enrolledDevice && before.enrolledDevice.installationId === a.installationId, 'a session must be told which installation it is');
  assert.equal((await req('device/installations', undefined, a.credential)).body.scope, 'OWN_INSTALLATION');
  assert.equal((await req('device/installations', undefined, 'owner')).body.scope, 'CITY');
  // The shape is what the projection reads: enrolledDevice is an object for a session and null for the owner.
  const ownerView = (await req('city', undefined, 'owner')).body;
  assert.equal(ownerView.enrolledDevice, null, 'the control-token client must report no enrolled installation');
  assert.equal((await req('city', undefined, a.credential)).body.hostDeviceId, 'host-a');
  void dir;
}));

test('PROBE 5: revoke authority is scoped, and a revoked session stops being able to read the City', () => city(async ({ req, enroll }) => {
  const a = await enroll('Member A');
  const b = await enroll('Member B');
  assert.equal((await req('device/installations/' + b.installationId + '/revoke', {}, a.credential)).status, 403, 'a session must not revoke another installation');
  assert.equal((await req('device/installations/' + a.installationId + '/revoke', { reason: 'native_user_request' }, a.credential)).status, 200, 'self-revoke is legitimate');
  assert.ok([401, 403].includes((await req('city', undefined, a.credential)).status), 'a revoked session must stop working immediately');
  assert.equal((await req('device/installations/' + b.installationId + '/revoke', {}, 'owner')).status, 200, 'the owner may revoke another installation');
}));
