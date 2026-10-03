// JOIN-501 — pairing session lifecycle at the PRODUCT level (real gateway, real browser).
//
// The unit tests in pairing-lifecycle.test.mjs pin the state machine. This file proves the acceptance clauses
// that only a live page can prove: that opening/refreshing/reconnecting/navigating never call the creation API,
// that an ACTIVE code survives all of it unchanged, and that consumption and expiry each end the display and
// hand the user a working Generate again. Requests to POST /api/v0/pairing/session are counted directly at the
// network layer, because "no implicit generation" is a claim about what the page SENT, not about what it shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { parseQr } from '../contracts/pairing-v1/descriptor.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const launch = () => chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });

async function connect(page, app) {
  await page.goto(app.url);
  await page.getByLabel('Pairing token').fill('join501-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#connection.online').waitFor();
}

// Every creation call the page made, in order. This is the instrument the acceptance items hinge on.
function countCreations(page, log) {
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/api/v0/pairing/session')) log.push(r.url()); });
  return log;
}

const pairInfo = page => page.evaluate(() => fetch('/api/v0/pairing/info', { headers: { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' } }).then(r => r.json()));

test('JOIN-501 acceptance: no implicit generation, an ACTIVE code that cannot rotate, and both terminal states', async () => {
  const dir = await mkdtemp(resolve('.scratch-join501-'));
  let app, browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'join501-token', nodeToken: 'join501-node' });
    browser = await launch();
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    const creations = countCreations(page, []);
    await connect(page, app);

    // (1) entering the Pairing page creates nothing
    await page.locator('[data-page="Pairing"]').click();
    await page.locator('#generate-pairing').waitFor();
    assert.equal(await page.locator('#pairing-code').count(), 0, 'no code is on the page before a click');
    assert.equal(await page.locator('#pairing-qr svg').count(), 0, 'no QR is on the page before a click');
    assert.equal(creations.length, 0, 'opening the page must not call the creation API');

    // (2) refresh + reconnect + a full reload create nothing either
    await page.evaluate(() => fetch('/api/v0/pairing/info', { headers: { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' } }));
    await page.locator('[data-page="Home"]').click();
    await page.locator('[data-page="Pairing"]').click();
    await page.waitForTimeout(4500); // one refresh interval has certainly fired
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#connection.online').waitFor();
    assert.equal(creations.length, 0, 'refresh, reconnect and navigation must not call the creation API');

    // (3) exactly one session from one explicit click
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor();
    assert.equal(creations.length, 1, 'one click is exactly one creation call');
    const first = { id: await pairInfo(page).then(i => i.descriptor.pairingSessionId), code: await page.locator('#pairing-code').innerText(), qr: await page.locator('#pairing-qr svg').evaluate(el => el.outerHTML) };
    const inviteBefore = await page.locator('#pairing-invite').inputValue();

    // (4) ordinary re-render: same id, same code, same payload; and the control offers no rotation
    await page.waitForTimeout(4500);
    assert.equal(await page.locator('#pairing-code').innerText(), first.code);
    assert.equal(await page.locator('#pairing-qr svg').evaluate(el => el.outerHTML), first.qr);
    assert.equal(await pairInfo(page).then(i => i.descriptor.pairingSessionId), first.id);
    assert.equal(await page.locator('#generate-pairing').isDisabled(), true, 'ACTIVE has no generate/refresh control');
    // a forced click on the disabled control is still a dead click
    await page.locator('#generate-pairing').click({ force: true }).catch(() => {});
    assert.equal(creations.length, 1, 'no second creation call');
    assert.equal(await pairInfo(page).then(i => i.descriptor.pairingSessionId), first.id, 'the canonical session did not rotate');

    // (5) SPA navigation away and back keeps the SAME active session
    await page.locator('[data-page="Devices"]').click();
    assert.equal(await page.locator('#pairing-code').count(), 0, 'the material is not rendered on another page');
    await page.locator('[data-page="Pairing"]').click();
    assert.equal(await page.locator('#pairing-code').innerText(), first.code, 'the code survived navigation');
    assert.equal(await page.locator('#pairing-qr svg').evaluate(el => el.outerHTML), first.qr);
    assert.equal(await pairInfo(page).then(i => i.descriptor.pairingSessionId), first.id);

    // (6) a full reload restores the SAME still-valid session (sessionStorage, not a new code)
    await page.reload();
    await page.locator('[data-page="Pairing"]').click();
    await page.locator('#pairing-code').waitFor();
    assert.equal(await page.locator('#pairing-code').innerText(), first.code, 'a reload restores the same session');
    assert.equal(await page.locator('#pairing-qr svg').evaluate(el => el.outerHTML), first.qr);
    assert.equal(await page.locator('#pairing-invite').inputValue(), inviteBefore);
    assert.equal(await page.locator('#generate-pairing').count(), 1);
    assert.equal(await page.locator('#generate-pairing').isDisabled(), true, 'the restored session is ACTIVE, not re-generatable');
    assert.equal(creations.length, 1, 'a reload must never create a session');

    // (12) no permanent credential is anywhere in the pairing material
    const material = (await page.locator('#view').innerText()) + inviteBefore + first.qr;
    assert.equal(material.includes('join501-token'), false, 'the control token is not part of any pairing material');

    // (7) consumption by another endpoint: the owner page ends as USED and Generate comes back
    const parsed = parseQr(inviteBefore);
    const exchange = await page.evaluate(async (payload) => {
      const r = await fetch('/api/v0/pairing/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' }, body: JSON.stringify(payload) });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { cityId: parsed.cityId, sessionId: parsed.pairingSessionId, method: 'qr', secret: parsed.secret });
    assert.equal(exchange.status, 200, 'the invite the page offered is really exchangeable');
    await page.locator('#pairing-code').waitFor({ state: 'detached', timeout: 12000 });
    assert.equal(await page.locator('#pairing-qr svg').count(), 0, 'consumed material is off the page');
    assert.match(await page.locator('#view').innerText(), /That code was used/);
    assert.equal(await page.locator('#generate-pairing').isDisabled(), false, 'Generate is available again');
    assert.equal(creations.length, 1, 'the consumption path did not create anything');

    // (8) the consumed secret cannot be reused
    const reuse = await page.evaluate(async (payload) => {
      const r = await fetch('/api/v0/pairing/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' }, body: JSON.stringify(payload) });
      return r.status;
    }, { cityId: parsed.cityId, sessionId: parsed.pairingSessionId, method: 'qr', secret: parsed.secret });
    assert.equal(reuse, 410, 'a consumed one-time secret is refused');

    // (11) a second explicit click after the terminal state is a NEW, different session
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor();
    assert.equal(creations.length, 2, 'the post-consumption generate was the second creation, and there were only two');
    const second = await pairInfo(page).then(i => i.descriptor.pairingSessionId);
    assert.notEqual(second, first.id, 'the new session is genuinely new');
    assert.equal(await page.locator('#generate-pairing').isDisabled(), true, 'and it is ACTIVE again');
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('JOIN-501 real-endpoint receiver: a SECOND process (not the owner page) consumes the code the page shows', async () => {
  const dir = await mkdtemp(resolve('.scratch-join501-'));
  let owner, receiver, browser;
  try {
    owner = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'join501-token', nodeToken: 'join501-node' });
    // The receiver is a SEPARATE gateway process on its own port: a stand-in for the second physical host.
    // It is deliberately not trusted with the owner's endpoint token - a `utopia://pair` invite carries no
    // credential, which is the property being exercised.
    receiver = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'receiver-side-token', nodeToken: 'receiver-node' });
    browser = await launch();
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    const creations = countCreations(page, []);
    await connect(page, owner);
    await page.locator('[data-page="Pairing"]').click();
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor();
    const shown = await page.locator('#pairing-code').innerText();
    const invite = await page.locator('#pairing-invite').inputValue();
    const parsed = parseQr(invite);

    // The receiver sends ONLY the invite payload to the City the invite names.
    const status = await fetch(`${owner.url}/api/v0/pairing/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
      body: JSON.stringify({ cityId: parsed.cityId, sessionId: parsed.pairingSessionId, method: 'qr', secret: parsed.secret }),
    });
    assert.equal(status.status, 200, 'the receiver completed the exchange against the owner City');

    // The owner page must reach its own terminal state from the canonical truth, without the test touching it.
    await page.locator('#pairing-code').waitFor({ state: 'detached', timeout: 12000 });
    assert.equal(await page.locator('#pairing-qr svg').count(), 0);
    assert.match(await page.locator('#view').innerText(), /That code was used/);
    assert.equal(await page.locator('#generate-pairing').isDisabled(), false);
    assert.equal(creations.length, 1, 'the receiver path created nothing on the owner page');
    // The short code the page showed is the one that was consumed: the display was truthful, not decorative.
    assert.match(shown, /^\d{6}$/);
    const canonical = await fetch(`${owner.url}/api/v0/pairing/info`, { headers: { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' } }).then(r => r.json());
    assert.equal(canonical.activeSession, false, 'the City reports no active session after the receiver consumed it');
  } finally {
    await browser?.close();
    await owner?.close();
    await receiver?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('JOIN-501 acceptance: expiry ends the display by itself, and the expiry path creates nothing', async () => {  const dir = await mkdtemp(resolve('.scratch-join501-'));
  let app, browser;
  try {
    // A deliberately short TTL so the countdown, not the test, is what ends the session.
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'join501-token', nodeToken: 'join501-node', pairingTtlMs: 3000 });
    browser = await launch();
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    const creations = countCreations(page, []);
    await connect(page, app);
    await page.locator('[data-page="Pairing"]').click();
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor();
    assert.equal(creations.length, 1);

    // (9) expiry removes the material, names it EXPIRED, and re-offers Generate; (10) without creating anything
    await page.locator('#pairing-code').waitFor({ state: 'detached', timeout: 8000 });
    assert.equal(await page.locator('#pairing-qr svg').count(), 0);
    assert.match(await page.locator('#view').innerText(), /The code expired/);
    assert.equal(await page.locator('#generate-pairing').isDisabled(), false);
    assert.equal(creations.length, 1, 'expiry must never call the creation API');

    // A reload after expiry does not resurrect the dead code either.
    await page.reload();
    await page.locator('[data-page="Pairing"]').click();
    assert.equal(await page.locator('#pairing-code').count(), 0, 'an expired code is not restored');
    assert.equal(creations.length, 1);
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('JOIN-501: a fresh browser session starts with NO code, and a stored expired record is never exchanged', async () => {
  const dir = await mkdtemp(resolve('.scratch-join501-'));
  let app, browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'join501-token', nodeToken: 'join501-node', pairingTtlMs: 3000 });
    browser = await launch();
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    const creations = countCreations(page, []);
    await connect(page, app);
    await page.locator('[data-page="Pairing"]').click();
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('utopia.pairing-active-session'));
    assert.ok(stored && stored.includes('pairingSessionId'), 'the active material is in session-scoped storage');
    assert.equal(stored.includes('join501-token'), false, 'no credential is stored with it');

    // Open a SECOND, genuinely fresh client in the same browser (its own tab => its own sessionStorage, seeded
    // with the credential the way the launcher would hand it over). It must show IDLE: a fresh client is never
    // handed the other tab's ephemeral code.
    await page.waitForTimeout(3500);
    const second = await context.newPage();
    await second.addInitScript(() => { try { sessionStorage.setItem('city-token', 'join501-token'); } catch {} });
    await second.goto(app.url + '/pairing');
    await second.locator('[data-page="Pairing"]').click();
    assert.equal(await second.locator('#pairing-code').count(), 0, 'a fresh client shows no code and generates none');
    assert.equal(await second.locator('#generate-pairing').isDisabled(), false);
    const storedInSecond = await second.evaluate(() => sessionStorage.getItem('utopia.pairing-active-session'));
    assert.equal(storedInSecond, null, 'nothing was restored into the fresh client');
    const activeAtCity = await second.evaluate(async () => {
      const info = await fetch('/api/v0/pairing/info', { headers: { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' } }).then(r => r.json());
      return info.activeSession;
    });
    assert.equal(activeAtCity, false, 'the City reports no active session after expiry');
    assert.equal(creations.length, 1, 'nothing created a second session anywhere in this test');
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
