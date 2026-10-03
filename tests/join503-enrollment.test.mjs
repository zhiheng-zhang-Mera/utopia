// JOIN-503 — device enrollment and tokenless routine reconnect.
//
// These tests exercise the REAL gateway over HTTP, not the registrar in isolation, because the acceptance clauses
// are about behaviour a user can experience: a machine that joined once reconnects with nothing typed; a revoked
// machine cannot; an expired session re-authenticates internally with no prompt; and no durable secret ever
// reaches the browser, a log, a URL or the repo.
//
// The City's clock and entropy are injected, so "restart", "session expired" and "revoked" are decided by the
// test rather than by waiting. Nothing here is timed by luck.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { readDeviceFile, writeDeviceFile, describeDeviceFile, enrollWithCity, openDeviceSession, listInstallations, revokeInstallation, inviteForExchange, forgetDeviceFile, DEVICE_FILE_VERSION } from '../apps/client/device-enrollment.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const BASE_TIME = Date.parse('2026-10-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const clock = (start = BASE_TIME) => { let t = start; return { now: () => t, advance: ms => { t += ms; }, at: () => new Date(t).toISOString() }; };
const entropy = () => { let n = 0; return () => { n++; return Uint8Array.from({ length: 16 }, (_, i) => (n * 31 + i) % 256); }; };

// A City whose clock and entropy the test owns. `dir` is reused across restarts on purpose: persistence IS the
// thing under test.
async function city(dir, c, extra = {}) {
  return createGateway({ host: '127.0.0.1', port: 0, dir, token: 'join503-token', nodeToken: 'join503-node', pairingClock: c.now, deviceClock: c.now, ...extra });
}

const post = async (url, path, body, credential) => {
  const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...V, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (url, path, credential) => {
  const r = await fetch(url + path, { headers: { ...V, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The one join a real machine performs: the owner generated a pairing code, the joining installation exchanges it
// and declares itself in the same call.
async function joinOnce(app, c, displayName) {
  const session = await post(app.url, '/api/v0/pairing/session', {}, 'join503-token');
  assert.equal(session.status, 200, 'the owner generated a pairing session');
  const invite = { cityId: session.body.descriptor.cityId, sessionId: session.body.pairingSessionId, secret: new URLSearchParams(session.body.qrPayload.split('?')[1]).get('secret'), method: 'qr' };
  const { record, session: firstSession } = await enrollWithCity({ endpoint: app.url, invite, displayName, platform: 'win32' });
  return { record, firstSession, invite };
}

test('JOIN-503 (1)(2): one join enrolls an installation, and a RESTART reconnects with nothing typed', async () => {
  const dir = await mkdtemp(resolve('.scratch-join503-'));
  const c = clock();
  let app;
  try {
    app = await city(dir, c);
    const { record, firstSession } = await joinOnce(app, c, 'Alien-Win');
    assert.match(record.installationId, /^ins-[0-9a-f]{32}$/);
    assert.match(record.deviceId, /^dev-[0-9a-f]{32}$/);
    assert.match(record.credentialId, /^cred-[0-9a-f]{32}$/);
    assert.equal(record.cityId, app.store.cityId);
    assert.ok(firstSession?.credential?.startsWith('sess:'), 'the join hands out a session, not the durable credential');
    assert.ok(firstSession.expiresAt, 'the session states when it expires');

    // The City knows the installation, and reports its state without any secret.
    const listed = await listInstallations({ endpoint: app.url, credential: 'join503-token' });
    assert.equal(listed.installations.length, 1);
    assert.equal(listed.installations[0].installationId, record.installationId);
    assert.equal(listed.installations[0].state, 'BOUND');
    assert.equal(JSON.stringify(listed).includes(record.credentialSecret), false, 'the durable secret is not readable from the City');
    assert.deepEqual(listed.cloneFindings, []);

    // RESTART: a new gateway process on the same data directory. The installation credential is all the client
    // has, and it never sees a token.
    await app.close();
    app = await city(dir, c);
    const stored = describeDeviceFile(record);
    assert.equal(stored.installationId, record.installationId, 'the stored record is the one that joined');
    // The recorded endpoint is where the City WAS. A restarted City on a new port is not a different City, so the
    // caller supplies the address it can actually reach - which is what the launcher does. Passing only the
    // remembered endpoint here would be testing that ports never change, not that reconnect works.
    const opened = await openDeviceSession(record, { endpoint: app.url });
    assert.ok(opened.credential.startsWith('sess:'), 'the restart minted a fresh session');
    assert.equal(opened.installation.installationId, record.installationId);
    assert.equal(JSON.stringify(opened).includes(record.credentialSecret), false, 'the session response carries no durable secret');

    // ...and that session really is authority: the City accepts it on a normal control route.
    const snapshot = await get(app.url, '/api/v0/city', opened.credential);
    assert.equal(snapshot.status, 200, 'the minted session is accepted by the City');
    assert.equal(snapshot.body.enrolledDevice.installationId, record.installationId, 'the City tells the surface which installation it is');
    assert.equal(JSON.stringify(snapshot.body).includes(record.credentialSecret), false);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-503 (3): an EXPIRED session is replaced by an internal re-auth, with no user-visible token prompt', async () => {
  const dir = await mkdtemp(resolve('.scratch-join503-'));
  const c = clock();
  let app;
  try {
    app = await city(dir, c);
    const { record, firstSession } = await joinOnce(app, c, 'Alien-Win');

    // The session credential the browser would hold ages out...
    c.advance(13 * HOUR);
    const stale = await post(app.url, '/api/v0/device/session', { sessionId: firstSession.credential.replace('sess:', '') });
    assert.equal(stale.status, 401, 'an expired session is refused');
    assert.equal(stale.body.errorCode, 'SESSION_EXPIRED', 'and it says WHY, so the client can tell expiry from revocation');
    const refusedCity = await get(app.url, '/api/v0/city', firstSession.credential);
    assert.equal(refusedCity.status, 401, 'the expired credential is not authority either');

    // ...and the installation re-authenticates from its durable credential. Nothing is typed by a user and no
    // City control token is involved.
    const fresh = await openDeviceSession(record);
    assert.ok(fresh.credential.startsWith('sess:'));
    assert.notEqual(fresh.credential, firstSession.credential, 'a genuinely new session was minted');
    assert.equal((await get(app.url, '/api/v0/city', fresh.credential)).status, 200, 'the fresh session works');

    // The old session stays dead: re-auth does not resurrect it.
    assert.equal((await get(app.url, '/api/v0/city', firstSession.credential)).status, 401);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-503 (4)(5): REVOKE denies reconnect, and a revoked installation cannot mint new membership', async () => {
  const dir = await mkdtemp(resolve('.scratch-join503-'));
  const c = clock();
  let app;
  try {
    app = await city(dir, c);
    const { record, firstSession } = await joinOnce(app, c, 'Alien-Win');
    const live = await openDeviceSession(record);
    assert.equal((await get(app.url, '/api/v0/city', live.credential)).status, 200);

    const revoked = await revokeInstallation({ endpoint: app.url, credential: 'join503-token', installationId: record.installationId });
    assert.equal(revoked.installationId, record.installationId);
    assert.equal(revoked.sessionsRevoked >= 1, true, 'live sessions are revoked with the installation');

    // (4) the next reconnect fails, and it fails TYPED rather than looking like a network problem.
    const refused = await openDeviceSession(record).then(() => null, e => e);
    assert.ok(refused, 'a revoked installation cannot open a session');
    assert.equal(refused.code, 'INSTALLATION_RETIRED');
    assert.equal(refused.retryable, false, 'and the client is told not to keep retrying');

    // (5) neither can the sessions that were live a moment ago.
    assert.equal((await get(app.url, '/api/v0/city', live.credential)).status, 401, 'the revoked session is dead');
    assert.equal((await get(app.url, '/api/v0/city', firstSession.credential)).status, 401);

    // "Cannot silently mint new membership": a retired installation is not a way back in.
    const afterRevoke = await listInstallations({ endpoint: app.url, credential: 'join503-token' });
    assert.equal(afterRevoke.installations[0].state, 'RETIRED');
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-503 (6): a REINSTALL mints new identities and is unbound until an explicit rebind', async () => {
  const dir = await mkdtemp(resolve('.scratch-join503-'));
  const c = clock();
  let app;
  try {
    app = await city(dir, c);
    const { record } = await joinOnce(app, c, 'Alien-Win');

    // `POST /device/enroll` with no deviceId mints a NEW logical device and a NEW installation: what a fresh
    // install of the same software on a machine the City has never seen does.
    const second = await post(app.url, '/api/v0/device/enroll', { displayName: 'Alien-Win-2', platform: 'win32' }, 'join503-token');
    assert.equal(second.status, 200);
    assert.notEqual(second.body.installation.installationId, record.installationId);
    assert.notEqual(second.body.installation.deviceId, record.deviceId);
    assert.notEqual(second.body.credential.credentialSecret, record.credentialSecret, 'a new installation gets a new secret');
    assert.equal(JSON.stringify(second.body).includes(record.credentialSecret), false);

    // That installation holds a credential immediately, and can open a session with it - enrollment is complete
    // on its own, and a fresh install never inherits another machine's identity.
    const secondSession = await post(app.url, '/api/v0/device/session', {
      installationId: second.body.installation.installationId,
      instanceId: second.body.installation.instanceId,
      credentialId: second.body.credential.credentialId,
      credentialSecret: second.body.credential.credentialSecret,
    });
    assert.equal(secondSession.status, 200);
    assert.ok(secondSession.body.credential.startsWith('sess:'));
    assert.notEqual(secondSession.body.credential, null);

    // Enrollment through the control token is authority, and a session may NOT do it: a joined device cannot
    // enroll further devices for itself.
    const viaSession = await post(app.url, '/api/v0/device/enroll', { displayName: 'sneaky' }, secondSession.body.credential);
    assert.equal(viaSession.status, 403);
    assert.equal(viaSession.body.error, 'SESSION_CANNOT_ENROLL');

    // REINSTALL: a new installation arrives UNBOUND. Its credential opens a session record (the City knows it),
    // but it has no logical device, so it is refused every BOUND-only authority...
    const fresh = await post(app.url, '/api/v0/device/enroll', { displayName: 'Alien-Win-reinstalled', unbound: true }, 'join503-token');
    assert.equal(fresh.body.installation.state, 'UNBOUND', 'a reinstall starts unbound');
    assert.equal(fresh.body.installation.deviceId, null, 'and it inherits no logical device');
    const unboundId = fresh.body.installation.installationId;
    const unboundCredential = fresh.body.credential;
    const refused = await post(app.url, '/api/v0/device/session', {
      installationId: unboundId,
      instanceId: fresh.body.installation.instanceId,
      credentialId: unboundCredential.credentialId,
      credentialSecret: unboundCredential.credentialSecret,
    });
    assert.equal(refused.status, 403, 'an unbound installation cannot act');
    assert.equal(refused.body.error, 'INSTALLATION_UNBOUND');

    // ...until an EXPLICIT rebind with proof binds it to a logical device, which is the only way back.
    const noProof = await post(app.url, `/api/v0/device/installations/${unboundId}/rebind`, { deviceId: record.deviceId }, 'join503-token');
    assert.equal(noProof.status, 403, 'rebinding without explicit proof is refused');
    assert.match(noProof.body.error, /rebind_proof_required/);
    const rebound = await post(app.url, `/api/v0/device/installations/${unboundId}/rebind`, { deviceId: record.deviceId, proof: { kind: 'owner_approved_reinstall' } }, 'join503-token');
    assert.equal(rebound.status, 200);
    assert.equal(rebound.body.installation.deviceId, record.deviceId, 'the reinstall joined the SAME logical device');
    assert.equal(rebound.body.installation.installationId, unboundId, 'and it is still its own installation, not the retired one');
    const afterRebind = await post(app.url, '/api/v0/device/session', {
      installationId: unboundId,
      instanceId: fresh.body.installation.instanceId,
      credentialId: unboundCredential.credentialId,
      credentialSecret: unboundCredential.credentialSecret,
    });
    assert.equal(afterRebind.status, 200, 'and now it can act');
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-503 (7): the secret-exposure sweep - no durable secret in the snapshot, events, records or a URL', async () => {
  const dir = await mkdtemp(resolve('.scratch-join503-'));
  const c = clock();
  let app;
  try {
    app = await city(dir, c);
    const { record, firstSession } = await joinOnce(app, c, 'Alien-Win');
    const secret = record.credentialSecret;

    // The web surface's own snapshot, which is what the DOM is rendered from.
    const snapshot = await get(app.url, '/api/v0/city', firstSession.credential);
    assert.equal(JSON.stringify(snapshot.body).includes(secret), false, 'the snapshot carries no durable secret');

    // Canonical events, which is what every surface converges on.
    const events = app.store.events();
    assert.equal(JSON.stringify(events).includes(secret), false, 'no canonical event carries the secret');
    // The enrollment is still visible as a fact - the sweep must not be passing because nothing was recorded.
    assert.ok(events.some(e => e.type === 'DEVICE_ENROLLED'), 'the enrollment was recorded as an event');
    assert.ok(events.some(e => e.type === 'DEVICE_SESSION_ISSUED'), 'the session issuance was recorded as an event');

    // The persisted records in the City's own database.
    const installationRow = app.store.get('installations', `ins:${record.installationId}`);
    assert.ok(installationRow, 'the installation is persisted');
    assert.equal(JSON.stringify(installationRow).includes(secret), false, 'the stored record holds a fingerprint, not the secret');
    assert.match(installationRow.credential.fingerprint, /^sha256:[0-9a-f]{64}$/);

    // No URL the City produced contains the secret. The invite contains a one-time pairing secret, which is a
    // different thing and is expected to expire with the session.
    const session = await post(app.url, '/api/v0/pairing/session', {}, 'join503-token');
    assert.equal(session.body.qrPayload.includes(secret), false, 'a pairing QR never carries a durable credential');
    assert.equal(JSON.stringify(snapshot.body).includes(firstSession.credential), false, 'the session credential is not echoed back either');

    // The client's own file holds the secret (it must - it is the machine's credential) and is owner-only.
    const file = resolve(dir, 'device-enrollment.json');
    writeDeviceFile(file, record);
    const raw = await readFile(file, 'utf8');
    assert.ok(raw.includes(secret), 'the device file is where the durable credential lives');
    assert.equal(readDeviceFile(file).installationId, record.installationId);
    if (process.platform !== 'win32') {
      const mode = (await stat(file)).mode & 0o777;
      assert.equal(mode, 0o600, 'and it is owner-only');
    }
    forgetDeviceFile(file);
    assert.equal(existsSync(file), false);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-503: a broken or foreign device file is refused rather than half-used', async () => {
  const dir = await mkdtemp(resolve('.scratch-join503-'));
  const file = resolve(dir, 'device-enrollment.json');
  try {
    const good = { version: DEVICE_FILE_VERSION, endpoint: 'http://127.0.0.1:1', cityId: 'c', deviceId: 'd', installationId: 'i', instanceId: 'n', credentialId: 'k', credentialSecret: 's' };
    writeDeviceFile(file, good);
    assert.ok(readDeviceFile(file));
    for (const broken of [
      { ...good, version: 99 },
      { ...good, installationId: '' },
      { ...good, credentialSecret: undefined },
      'not json',
      '{}',
    ]) {
      await writeFile(file, typeof broken === 'string' ? broken : JSON.stringify(broken));
      assert.equal(readDeviceFile(file), null, `${JSON.stringify(broken).slice(0, 40)} must not be used`);
    }
    // A structurally sound record pointing at nothing is a RETRYABLE network problem, not a credential problem:
    // conflating the two would make a City that is simply down look like a revoked installation.
    await writeFile(file, JSON.stringify({ ...good, endpoint: 'http://127.0.0.1:9' }));
    const err = await openDeviceSession(readDeviceFile(file)).then(() => null, e => e);
    assert.equal(err.code, 'CITY_UNREACHABLE');
    assert.equal(err.retryable, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-503 (8): the engineering manual fallback still exists and is not the default path', async () => {
  const dir = await mkdtemp(resolve('.scratch-join503-'));
  const c = clock();
  let app;
  try {
    app = await city(dir, c);
    // The control token still works everywhere it used to. This task removes the token from the NORMAL path; it
    // does not delete the fallback, and proving that matters because "token" and "no token" must not both be
    // claimed.
    const withToken = await get(app.url, '/api/v0/city', 'join503-token');
    assert.equal(withToken.status, 200);
    assert.equal(withToken.body.enrolledDevice, null, 'a control-token client is the owner, not an enrolled installation');
    assert.equal((await get(app.url, '/api/v0/city')).status, 401, 'and an unauthenticated call is still refused');

    // An invite still carries a session id and a one-time secret, and nothing durable.
    const { invite } = await joinOnce(app, c, 'Alien-Win');
    assert.ok(invite.sessionId && invite.secret);
    assert.equal(JSON.stringify(invite).includes('cred-'), false);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('JOIN-503: an invite of either shape is understood, and junk is refused instead of guessed at', () => {
  const structured = inviteForExchange({ cityId: 'c', sessionId: 's', secret: 'x' });
  assert.deepEqual(structured, { cityId: 'c', sessionId: 's', secret: 'x', method: 'qr' });
  const url = `utopia://pair?v=1&host=${encodeURIComponent('http://127.0.0.1:4391')}&city=c&session=s&secret=x`;
  assert.equal(inviteForExchange(url).method, 'qr');
  assert.equal(inviteForExchange('not-an-invite'), null);
  assert.equal(inviteForExchange('utopia://pair?city=c'), null, 'a session without a secret is not exchangeable');
  assert.equal(inviteForExchange(null), null);
});

test('JOIN-503: enrollment events are emitted on a CLONE, which is the population-level half of detection', async () => {
  const dir = await mkdtemp(resolve('.scratch-join503-'));
  const c = clock();
  let app;
  try {
    app = await city(dir, c);
    const { record } = await joinOnce(app, c, 'Alien-Win');
    // Present the right credential from the WRONG physical instance: exactly "two installations silently sharing
    // one installation identity", which must be a named refusal rather than a working login.
    const clone = await post(app.url, '/api/v0/device/session', {
      installationId: record.installationId,
      instanceId: `inst-${'0'.repeat(32)}`,
      credentialId: record.credentialId,
      credentialSecret: record.credentialSecret,
    });
    assert.equal(clone.status, 403);
    assert.equal(clone.body.error, 'CLONE_DETECTED');
    assert.ok(app.store.events().some(e => e.type === 'DEVICE_CLONE_DETECTED'), 'the clone is a canonical fact');
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});
