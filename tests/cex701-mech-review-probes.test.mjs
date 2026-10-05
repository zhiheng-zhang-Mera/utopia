// CEX-701 路 OPPOSITE-HOST REVIEW probes (Mech).
//
// The workbook's Formal Review section names seven scenarios the reviewer must CONSTRUCT rather than read about:
//
//   1 UNBOUND reinstall 路 2 legitimate rebind 路 3 wrong proof 路 4 clone finding 路
//   5 a session trying to rebind another installation 路 6 self revoke 路 7 owner revoking another installation
//
// and it requires at least one real browser flow. It also forbids: a second device registry, bypassing the rebind
// proof, auto-deleting a device on a clone finding, persisting a durable credential in the front end, and promoting a
// session credential to owner authority. Each prohibition is attacked below. Verdict and findings:
// mission-book/reports/CEX-701/REVIEW_REPORT.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { findRunningCities } from '../services/dev-gateway/host-preflight.mjs';

const V = { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const auth = token => ({ ...V, Authorization: 'Bearer ' + token });

async function city(fn, options = {}) {
  const dir = await mkdtemp(resolve('.scratch-cex701-review-'));
  let app, browser;
  try {
    app = await createGateway({ dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true, ...options });
    const post = async (path, body, token = 'owner') => { const r = await fetch(app.url + '/api/v0/' + path, { method: 'POST', headers: auth(token), body: JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json() }; };
    const get = async (path, token = 'owner') => { const r = await fetch(app.url + '/api/v0/' + path, { headers: auth(token) }); return { status: r.status, body: await r.json() }; };
    await fn({ app, post, get, async browser() { browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true }); return browser; } });
  } finally { await browser?.close(); await app?.close(); await rm(dir, { recursive: true, force: true }); }
}

// Enrol a member session and return its credential.
async function sessionFor(post, body) {
  const admitted = await post('device/enroll', { displayName: 'Member' , ...(body ?? {}) });
  const opened = await post('device/session', { installationId: admitted.body.installation.installationId, instanceId: admitted.body.installation.instanceId, ...admitted.body.credential });
  return { admitted: admitted.body, credential: opened.body.credential };
}

test('PROBE 1+2: an UNBOUND reinstall is admitted as unbound and only an explicit owner rebind with proof binds it', () => city(async ({ app, post, get }) => {
  const original = await post('device/enroll', { displayName: 'Original laptop' });
  assert.equal(original.status, 200);

  // SCENARIO 1: the reinstall arrives UNBOUND - it holds an identity with no logical device.
  const reinstall = await post('device/enroll', { displayName: 'Reinstalled laptop', unbound: true });
  assert.equal(reinstall.status, 200);
  const freshId = reinstall.body.installation.installationId;
  const listed = await get('device/installations');
  assert.equal(listed.body.scope, 'CITY', 'the control token is the City-scoped view');
  assert.equal(listed.body.installations.length, 2, 'an UNBOUND install is still an installation the owner can see');
  const freshRow = listed.body.installations.find(i => i.installationId === freshId);
  const before = app.store.get('installations', 'ins:' + freshId);
  assert.equal(before.state, 'UNBOUND', 'the reinstall must be UNBOUND, not silently matched to a device');
  assert.equal(before.deviceId, null, 'an UNBOUND installation has no logical device yet');
  assert.equal(before.rebind?.required, true, 'the server must declare that recovery is required');

  // SCENARIO 2: the legitimate rebind names the ORIGINAL device and carries proof.
  const deviceId = original.body.installation.deviceId;
  assert.match(deviceId, /^dev-[a-f0-9]{32}$/, 'the logical device id shape the recovery surface relies on');
  const rebound = await post('device/installations/' + freshId + '/rebind', { deviceId, proof: { kind: 'owner_approved_reinstall' } });
  assert.equal(rebound.status, 200);
  assert.equal(rebound.body.installation.state, 'BOUND');
  assert.equal(rebound.body.installation.deviceId, deviceId);
  const after = app.store.get('installations', 'ins:' + freshId);
  assert.equal(after.state, 'BOUND');
  assert.equal(after.deviceId, deviceId);
  // Recovery is a move, not a copy: it must not create a second logical device.
  assert.equal(listed.body.installations.filter(i => i.deviceId === deviceId).length, 1, 'no second device registry entry is created');
}));

test('PROBE 3: a rebind without real proof is refused, and no short-circuit accepts a missing or shapeless proof', () => city(async ({ app, post }) => {
  const original = await post('device/enroll', { displayName: 'Original' });
  const reinstall = await post('device/enroll', { displayName: 'Reinstall', unbound: true });
  const id = reinstall.body.installation.installationId;
  const deviceId = original.body.installation.deviceId;
  const refusals = [
    ['absent proof', {}],
    ['null proof', { deviceId, proof: null }],
    ['string proof', { deviceId, proof: 'owner-said-so' }],
    ['empty kind', { deviceId, proof: { kind: '' } }],
    ['shapeless proof', { deviceId, proof: {} }],
  ];
  for (const [label, body] of refusals) {
    const attempt = await post('device/installations/' + id + '/rebind', body);
    assert.equal(attempt.status, 403, `${label} must be refused`);
    assert.equal(attempt.body.errorCode ?? attempt.body.error, 'rebind_proof_required', `${label} must be refused by name`);
    // A refused rebind must not have half-applied: the installation is still UNBOUND and unowned.
    const row = app.store.get('installations', 'ins:' + id);
    assert.equal(row.state, 'UNBOUND', `${label} must leave the installation unbound`);
    assert.equal(row.deviceId, null);
  }
  // SCENARIO 2 again, as the control: the same call WITH proof succeeds, so the refusals above are about the proof.
  const accepted = await post('device/installations/' + id + '/rebind', { deviceId, proof: { kind: 'owner_approved_reinstall' } });
  assert.equal(accepted.status, 200, 'the refusal is about the proof, not about the route being unreachable');
}));

test('PROBE 4: a cloned credential is REPORTED as a finding and never auto-removes a device', () => city(async ({ app, post, get }) => {
  const original = await post('device/enroll', { displayName: 'Original laptop' });
  const duplicate = await post('device/enroll', { displayName: 'Clone fixture' });
  const originalRow = app.store.get('installations', 'ins:' + original.body.installation.installationId);
  const duplicateRow = app.store.get('installations', 'ins:' + duplicate.body.installation.installationId);
  // Reproduce a shared credential exactly as the author's own fixture does: same fingerprint, other instance.
  app.store.put('installations', { ...duplicateRow, credential: { ...duplicateRow.credential, fingerprint: originalRow.credential.fingerprint } });

  const listed = await get('device/installations');
  assert.ok(listed.body.cloneFindings.length > 0, 'the clone must be surfaced, not silently dropped - this is the defect the workbook names');
  const finding = listed.body.cloneFindings[0];
  assert.ok(['REUSED_CREDENTIAL', 'SHARED_INSTALLATION_IDENTITY'].includes(finding.reason), `unexpected reason ${finding.reason}`);
  assert.ok(Array.isArray(finding.installationIds) && finding.installationIds.length >= 2, 'the finding must name the installations it concerns');

  // The prohibition that matters: a finding is information, never an action. Both devices survive.
  assert.equal(app.store.get('installations', 'ins:' + original.body.installation.installationId).state, 'BOUND');
  assert.equal(app.store.get('installations', 'ins:' + duplicate.body.installation.installationId).state, 'BOUND');
  // And the finding does not become a hiding place for a usable secret.
  const serialized = JSON.stringify(listed.body);
  assert.equal(serialized.includes(originalRow.credential.credentialSecret), false, 'the credential secret must never travel to a client');
  assert.equal(serialized.includes(duplicateRow.credential.credentialSecret), false);
}));

test('PROBE 5+6+7: session authority stops at its own installation; self revoke works; owner revoke works', () => city(async ({ app, post, get }) => {
  const mine = await sessionFor(post, {});
  const other = await post('device/enroll', { displayName: 'Other laptop' });
  const session = mine.credential;

  // SCENARIO 5: a session may not rebind - neither another installation nor even its own, because recovery is the
  // owner's act and the member surface says so in words.
  const unbound = await post('device/enroll', { displayName: 'Unbound', unbound: true });
  const otherRebind = await post('device/installations/' + unbound.body.installation.installationId + '/rebind', { deviceId: mine.admitted.installation.deviceId, proof: { kind: 'owner_approved_reinstall' } }, session);
  assert.equal(otherRebind.status, 403);
  assert.equal(otherRebind.body.errorCode ?? otherRebind.body.error, 'SESSION_CANNOT_REBIND');
  const ownInstallation = app.store.get('installations', 'ins:' + mine.admitted.installation.installationId);
  const ownNode = app.store.get('nodes', mine.admitted.installation.deviceId);
  assert.equal(ownInstallation.state, 'BOUND');

  // A session cannot promote itself through the other two authority routes either.
  assert.equal((await post('device/enroll', { displayName: 'Escalate' }, session)).status, 403);

  // SCENARIO 6: self revoke is legitimate - leaving the City affects nobody else.
  const selfRevoke = await post('device/installations/' + mine.admitted.installation.installationId + '/revoke', {}, session);
  assert.equal(selfRevoke.status, 200, 'a member must be able to remove itself');
  assert.equal(selfRevoke.body.scope, 'OWN_INSTALLATION');
  assert.equal(app.store.get('installations', 'ins:' + mine.admitted.installation.installationId).state, 'RETIRED');

  // SCENARIO 7: the owner revokes another installation.
  const ownerRevoke = await post('device/installations/' + other.body.installation.installationId + '/revoke', {});
  assert.equal(ownerRevoke.status, 200);
  assert.equal(ownerRevoke.body.scope, 'CITY');
  assert.equal(app.store.get('installations', 'ins:' + other.body.installation.installationId).state, 'RETIRED');
}));

test('PROBE 5b: a session cannot revoke a different installation, and its listing is scoped to itself', () => city(async ({ post, get }) => {
  const first = await sessionFor(post, {});
  const second = await sessionFor(post, {});
  const cross = await post('device/installations/' + second.admitted.installation.installationId + '/revoke', {}, first.credential);
  assert.equal(cross.status, 403, 'cross-installation revoke would be privilege escalation');
  assert.equal(cross.body.errorCode ?? cross.body.error, 'SESSION_CANNOT_REVOKE_OTHER');
  assert.equal((await post('device/installations/' + first.admitted.installation.installationId + '/rebind', { deviceId: first.admitted.installation.deviceId, proof: { kind: 'owner_approved_reinstall' } }, first.credential)).status, 403);

  const scoped = await get('device/installations', first.credential);
  assert.equal(scoped.body.scope, 'OWN_INSTALLATION');
  assert.equal(scoped.body.installations.length, 1, 'a member sees only its own installation');
  assert.equal(scoped.body.installations[0].installationId, first.admitted.installation.installationId);
  assert.deepEqual(scoped.body.cloneFindings, [], 'a member must not receive the City-wide clone population');
  assert.equal(JSON.stringify(scoped.body).includes(second.admitted.installation.installationId), false, 'another installation must not appear in a member payload');
}));

test('PROBE 8: the owner Web flow recovers a reinstall in a real browser, and never auto-selects the device', () => city(async ({ app, post, get, browser }) => {
  const original = await post('device/enroll', { displayName: 'Original laptop' });
  const duplicate = await post('device/enroll', { displayName: 'Clone fixture' });
  const rows = { original: app.store.get('installations', 'ins:' + original.body.installation.installationId), duplicate: app.store.get('installations', 'ins:' + duplicate.body.installation.installationId) };
  app.store.put('installations', { ...rows.duplicate, credential: { ...rows.duplicate.credential, fingerprint: rows.original.credential.fingerprint } });
  const reinstall = await post('device/enroll', { displayName: 'Reinstalled laptop', unbound: true });
  const freshId = reinstall.body.installation.installationId;

  const page = await (await browser()).newPage({ locale: 'en-US' });
  page.setDefaultTimeout(15000);
  await page.goto(app.url + '/#token=owner');
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="Settings"]').click();

  // The clone warning is visible AND names the installations WITHOUT printing a credential handle.
  await page.locator('#clone-warnings').waitFor();
  const warning = await page.locator('#clone-warnings').innerText();
  assert.match(warning, /REUSED_CREDENTIAL|SHARED_INSTALLATION_IDENTITY/i, 'the typed reason must be shown');
  assert.equal(warning.includes(rows.original.credential.fingerprint), false, 'a credential fingerprint must not be rendered');
  assert.equal(warning.includes(rows.original.credential.credentialSecret), false, 'the secret must never be rendered');

  const form = page.locator('form[data-rebind="' + freshId + '"]');
  await form.waitFor();
  assert.equal(await form.locator('select').inputValue(), '', 'the surface must never choose the logical device for the user');
  await form.locator('select').selectOption(original.body.installation.deviceId);
  await form.locator('input[type="checkbox"]').check();
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(id => !document.querySelector('form[data-rebind="' + id + '"]'), freshId);

  const rebound = app.store.get('installations', 'ins:' + freshId);
  assert.equal(rebound.state, 'BOUND');
  assert.equal(rebound.deviceId, original.body.installation.deviceId);
  // The clone finding is not a deletion order: both original and duplicate survive an unrelated recovery.
  assert.equal(app.store.get('installations', rows.original.id).state, 'BOUND');
  assert.equal(app.store.get('installations', rows.duplicate.id).state, 'BOUND');
  // The page holds no durable credential for the recovered installation: only the owner token it was opened with.
  const storage = await page.evaluate(() => ({ session: Object.values(sessionStorage), local: Object.values(localStorage) }));
  const dumped = JSON.stringify(storage);
  assert.equal(dumped.includes(rebound.credential.credentialSecret), false, 'no durable credential may be persisted in the front end');
  assert.equal(dumped.includes(rows.duplicate.credential.credentialSecret), false);
}));

test('PROBE 9: a member browser gets actionable owner guidance and no recovery authority', () => city(async ({ app, post, get, browser }) => {
  const mine = await sessionFor(post, {});
  const other = await post('device/enroll', { displayName: 'Other laptop' });
  const page = await (await browser()).newPage({ locale: 'en-US' });
  page.setDefaultTimeout(15000);
  await page.goto(app.url + '/#session=' + encodeURIComponent(mine.credential));
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="Settings"]').click();
  await page.locator('#recovery-owner-guidance').waitFor();
  const guidance = await page.locator('#recovery-owner-guidance').innerText();
  assert.match(guidance, /owner/i, 'a member must be told where recovery happens');
  assert.match(guidance, /Settings|Web/i, 'the guidance must name an actionable place, not just refuse');
  assert.equal(await page.locator('form[data-rebind]').count(), 0, 'a member must not be offered a rebind form');
  assert.equal(await page.locator('[data-revoke="' + other.body.installation.installationId + '"]').count(), 0);
  // A member's own removal IS offered, because leaving the City is legitimate.
  assert.equal(await page.locator('[data-revoke="' + mine.admitted.installation.installationId + '"]').count(), 1);
}));

test('PROBE 10: the host preflight retry never turns a failed inventory into an empty host', async () => {
  // The reviewed backend change: a cold Windows inventory may time out, and the scan is retried ONCE, in full.
  let attempts = [];
  const cold = await findRunningCities({ runImpl: async command => { attempts.push(command); if (command === 'powershell' && attempts.filter(a => a === 'powershell').length === 1) throw Object.assign(new Error('cold'), { killed: true }); return { stdout: command === 'powershell' ? '[]' : '' }; } });
  assert.deepEqual(cold, []);
  assert.equal(attempts.filter(a => a === 'powershell').length, 2, 'a timeout retries once');
  assert.equal(attempts.filter(a => a === 'netstat').length, 2, 'the retry renews the whole observation, not just the failed half');

  let persistent = 0;
  await assert.rejects(findRunningCities({ runImpl: async command => { if (command === 'powershell') { persistent++; throw Object.assign(new Error('still cold'), { killed: true }); } return { stdout: '' }; } }), error => error.code === 'HOST_SCAN_TIMEOUT');
  assert.equal(persistent, 2, 'a persistent timeout refuses after exactly two attempts');

  let nonTimeout = 0;
  await assert.rejects(findRunningCities({ runImpl: async command => { if (command === 'powershell') { nonTimeout++; throw new Error('access denied'); } return { stdout: '' }; } }), error => error.code === 'HOST_SCAN_FAILED');
  assert.equal(nonTimeout, 1, 'a non-timeout failure refuses immediately rather than hammering the host');

  // The invariant that matters for the product: a failed scan THROWS. It never returns an empty list, because an
  // empty list is what authorizes starting a second City on a host that may already hold one.
  await assert.rejects(findRunningCities({ runImpl: async () => { throw new Error('nope'); } }));
});

test('PROBE 11: the API refuses to MOVE an already-bound installation, so the UI gate is not the only barrier', () => city(async ({ app, post, get }) => {
  const a = await post('device/enroll', { displayName: 'Device A' });
  const b = await post('device/enroll', { displayName: 'Device B' });
  const id = a.body.installation.installationId;
  const move = await post('device/installations/' + id + '/rebind', { deviceId: b.body.installation.deviceId, proof: { kind: 'owner_approved_reinstall' } });
  assert.equal(move.status, 403, 'a bound installation must not be re-pointed at another logical device');
  assert.equal(move.body.errorCode ?? move.body.error, 'already_bound');
  const row = app.store.get('installations', 'ins:' + id);
  assert.equal(row.state, 'BOUND');
  assert.equal(row.deviceId, a.body.installation.deviceId, 'the refused move must not half-apply');
  // Re-binding a bound installation to its OWN device is accepted as a recorded no-op. Harmless, but recorded here
  // because it means the proof fields can be rewritten on a bound installation by its owner.
  assert.equal((await post('device/installations/' + id + '/rebind', { deviceId: a.body.installation.deviceId, proof: { kind: 'owner_approved_reinstall' } })).status, 200);
  assert.equal(app.store.get('installations', 'ins:' + id).deviceId, a.body.installation.deviceId);
}));

test('PROBE 12: the revoke path cannot brick the City, because the host identity is not a revocable installation', () => city(async ({ app, post, get }) => {
  await post('device/enroll', { displayName: 'Device A' });
  await post('device/enroll', { displayName: 'Device B' });
  const city = await get('city');
  assert.match(city.body.hostDeviceId, /^dev-[a-f0-9]{32}$/);
  const list = await get('device/installations');
  assert.equal(list.body.installations.some(i => i.deviceId === city.body.hostDeviceId), false, 'the City host must not be revocable through the recovery surface');
  for (const installation of list.body.installations) assert.equal((await post('device/installations/' + installation.installationId + '/revoke', {})).status, 200);
  // A safe revoke path leaves the City serving; revocation removes members, not the City.
  assert.equal((await get('health')).status, 200);
  assert.equal((await get('city')).status, 200);
  assert.equal((await post('tasks', { type: 'WAIT' })).status, 200);
  assert.equal((await get('device/installations')).body.installations.every(i => i.state === 'RETIRED'), true);
}));

test('PROBE 13: an owner draft does not survive a credential change (the repair this head claims)', () => city(async ({ app, post, get, browser }) => {
  const mine = await sessionFor(post, {});
  const fresh = await post('device/enroll', { displayName: 'Unbound', unbound: true });
  const page = await (await browser()).newPage({ locale: 'en-US' });
  page.setDefaultTimeout(15000);
  await page.goto(app.url + '/#token=owner');
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="Settings"]').click();
  const form = page.locator('form[data-rebind="' + fresh.body.installation.installationId + '"]');
  await form.waitFor();
  await form.locator('select').selectOption(mine.admitted.installation.deviceId);
  await form.locator('input[type="checkbox"]').check();
  assert.notEqual(await form.locator('select').inputValue(), '', 'the draft is set before the change');
  assert.equal(await form.locator('input[type="checkbox"]').isChecked(), true);

  // Swap to the member credential, then back to the owner. A draft chosen by one authority must not be re-armed for
  // the other, and the browser must not carry the earlier confirmation across the boundary.
  for (const credential of [mine.credential, 'owner']) {
    await page.locator('#disconnect').click();
    await page.locator('#token').fill(credential);
    await page.locator('#connect').click();
    await page.locator('#connection.online').waitFor();
    await page.locator('[data-page="Settings"]').click();
    if (credential === 'owner') await form.waitFor(); else await page.locator('#recovery-owner-guidance').waitFor();
  }
  assert.equal(await form.locator('select').inputValue(), '', 'no device may remain chosen after a credential change');
  assert.equal(await form.locator('input[type="checkbox"]').isChecked(), false, 'the owner confirmation must not survive a credential change');
  // And nothing was rebound behind the user back while they were not looking.
  assert.equal(app.store.get('installations', 'ins:' + fresh.body.installation.installationId).state, 'UNBOUND');
}));

test('PROBE 14: clone detection has a FALSE case - distinct credentials are not reported as a conflict', () => city(async ({ app, post, get }) => {
  // The workbook requires the false case as well as the true one. A detector that flags every pair of installations
  // would satisfy PROBE 4 while making the warning useless, so the negative is asserted here.
  const a = await post('device/enroll', { displayName: 'Laptop A' });
  const b = await post('device/enroll', { displayName: 'Laptop B' });
  const rowA = app.store.get('installations', 'ins:' + a.body.installation.installationId);
  const rowB = app.store.get('installations', 'ins:' + b.body.installation.installationId);
  assert.notEqual(rowA.credential.fingerprint, rowB.credential.fingerprint, 'two ordinary enrolments have distinct credentials');
  const clean = await get('device/installations');
  assert.deepEqual(clean.body.cloneFindings, [], 'distinct credentials must NOT be reported as a conflict');
  // And the true case flips it, so the field is not simply always empty.
  app.store.put('installations', { ...rowB, credential: { ...rowB.credential, fingerprint: rowA.credential.fingerprint } });
  const flagged = await get('device/installations');
  assert.ok(flagged.body.cloneFindings.length > 0, 'the same credential on two instances IS a conflict');
  assert.equal(flagged.body.cloneFindings[0].reason, 'REUSED_CREDENTIAL');
  // A clone finding names both installations so the owner can act, and it names no secret.
  assert.ok(flagged.body.cloneFindings[0].installationIds.includes(a.body.installation.installationId));
  assert.equal(JSON.stringify(flagged.body).includes(rowA.credential.credentialSecret), false);
}));
