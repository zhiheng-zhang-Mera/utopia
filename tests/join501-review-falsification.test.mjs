// JOIN-501 FORMAL REVIEW — Mech's independent falsification instruments.
//
// These are NOT a re-run of the author's suite. Each one attacks a claim the workbook makes at a point the
// author's tests do not cover, and each is instrumented at two layers: what the PAGE sent (network requests)
// and what the CITY holds (canonical /pairing/info). A pairing rule can be broken in both directions - a dead
// code shown as live, or a live code lost - so both layers are checked in every case.
//
// Written by the reviewer on a different physical host from development, and checked in on the review branch so
// the claims in REVIEW_REPORT.md can be re-executed rather than believed.
//
// REVIEWER'S OWN INSTRUMENT DEFECT, recorded because it changed the method: the first version of the hidden-tab
// attack (A4) used a 10-minute TTL and then "waited out the expiry" for 20 seconds. The session could not have
// expired, and the empty display it saw came from an earlier attack's consumption - so it reported a product
// FAILURE that was entirely the instrument's fault. The instrument is now parameterised by the SAME expiresAt
// the City returned, and the assertion names EXPIRED specifically, so it cannot pass by observing consumption.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway } from '../services/dev-gateway/server.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const launch = () => chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });

/** A page connected to its own City, with every creation call it makes recorded at the network layer. */
async function connect(browser, app, token) {
  const page = await browser.newPage({ locale: 'en-US' });
  const creations = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/v0/pairing/session')) creations.push(Date.now()); });
  await page.goto(app.url);
  await page.getByLabel('Pairing token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="Pairing"]').click();
  return { page, creations };
}

test('REVIEW JOIN-501 A1: when ANOTHER client replaces the canonical session, the first page stops showing a dead code', async () => {
  // The Owner rule forbids the OWNER's page rotating a live code. This attacks the mirror image: the City's
  // session changes underneath a page that did nothing, and that page must not keep advertising a code that can
  // no longer be exchanged. The author's suite never changes canonical state behind the page's back.
  const dir = await mkdtemp(resolve('.scratch-review-join501-'));
  const token = 'review-a1-token';
  let app, browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token, nodeToken: 'review-a1-node', pairingTtlMs: 600000 });
    const canonical = async () => (await (await fetch(`${app.url}/api/v0/pairing/info`, { headers: V })).json());
    browser = await launch();
    const { page, creations } = await connect(browser, app, token);
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor();
    const mine = (await canonical()).descriptor.pairingSessionId;

    // A second control client of the same City creates its own session. Nothing touches the page under test.
    await fetch(`${app.url}/api/v0/pairing/session`, { method: 'POST', headers: { ...V, Authorization: `Bearer ${token}` } });
    const theirs = (await canonical()).descriptor.pairingSessionId;
    assert.notEqual(theirs, mine, 'the City really replaced the session');

    await page.locator('#pairing-code').waitFor({ state: 'detached', timeout: 15000 });
    assert.equal(await page.locator('#pairing-qr svg').count(), 0, 'the superseded material left the page');
    assert.match(await page.locator('#view').innerText(), /That code was used/i);
    assert.equal(creations.length, 1, 'noticing the replacement created nothing');
  } finally { await browser?.close(); await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('REVIEW JOIN-501 A2: a real WebSocket drop and the product\u2019s own reconnect neither create nor lose a session', async () => {
  // The workbook names "WebSocket reconnect" as a path that must not clear an active code. The author tests a
  // synthetic offline/online EVENT; this closes the live socket so the product's own onclose/reconnect path runs.
  const dir = await mkdtemp(resolve('.scratch-review-join501-'));
  const token = 'review-a2-token';
  let app, browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token, nodeToken: 'review-a2-node', pairingTtlMs: 600000 });
    const canonical = async () => (await (await fetch(`${app.url}/api/v0/pairing/info`, { headers: V })).json());
    browser = await launch();
    const { page, creations } = await connect(browser, app, token);
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor();
    const before = await canonical();
    const codeBefore = await page.locator('#pairing-code').innerText();
    const qrBefore = await page.locator('#pairing-qr svg').evaluate(el => el.outerHTML);

    await page.evaluate(() => {
      for (const key of Object.keys(window)) {
        const value = window[key];
        if (value && value.constructor && value.constructor.name === 'WebSocket' && value.readyState === 1) value.close();
      }
    });
    await page.locator('#connection.online').waitFor({ timeout: 15000 });
    await page.waitForTimeout(2500);

    assert.equal(creations.length, 1, 'the reconnect path created no session');
    assert.equal((await canonical()).descriptor.pairingSessionId, before.descriptor.pairingSessionId, 'the canonical session did not rotate');
    assert.equal(await page.locator('#pairing-code').innerText(), codeBefore, 'the same code is still shown');
    assert.equal(await page.locator('#pairing-qr svg').evaluate(el => el.outerHTML), qrBefore, 'the same QR is still shown');
  } finally { await browser?.close(); await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('REVIEW JOIN-501 A3: a burst of same-task clicks can create at most one session', async () => {
  // "No silent rotation" must not be a race that a fast double click can win. The three clicks are dispatched in
  // ONE task, before any await can resolve, which is the worst case for a busy-flag guard - and the assertions
  // are made against the number of creation CALLS and the City's own session count, not against the button.
  const dir = await mkdtemp(resolve('.scratch-review-join501-'));
  const token = 'review-a3-token';
  let app, browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token, nodeToken: 'review-a3-node', pairingTtlMs: 600000 });
    const canonical = async () => (await (await fetch(`${app.url}/api/v0/pairing/info`, { headers: V })).json());
    browser = await launch();
    const { page, creations } = await connect(browser, app, token);

    // Consume whatever is showing so that the next state is a terminal one with Generate available.
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor();
    const exchanged = await page.evaluate(async () => {
      const invite = document.querySelector('#pairing-invite').value;
      const u = new URL(invite);
      const r = await fetch('/api/v0/pairing/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' }, body: JSON.stringify({ cityId: u.searchParams.get('city'), sessionId: u.searchParams.get('session'), method: 'qr', secret: u.searchParams.get('secret') }) });
      return r.status;
    });
    assert.equal(exchanged, 200, 'the offered invite was really exchangeable');
    await page.locator('#pairing-code').waitFor({ state: 'detached', timeout: 15000 });
    const beforeBurst = creations.length;

    await page.evaluate(() => { const button = document.querySelector('#generate-pairing'); button.click(); button.click(); button.click(); });
    await page.waitForTimeout(4000);

    assert.equal(creations.length, beforeBurst + 1, 'a three-click burst issued exactly one creation call');
    assert.equal((await canonical()).activeSession, true, 'exactly one active session exists afterwards');
    assert.equal(await page.locator('#generate-pairing').isDisabled(), true, 'and the page is ACTIVE again, offering no rotation');
  } finally { await browser?.close(); await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('REVIEW JOIN-501 A4: a code that expires while the tab is HIDDEN is not restored as ACTIVE', async () => {
  // The hidden-tab case is where a countdown interval is throttled or frozen. The wait is derived from the City's
  // OWN expiresAt, and the assertion names EXPIRED specifically, so this cannot pass by observing consumption.
  const dir = await mkdtemp(resolve('.scratch-review-join501-'));
  const token = 'review-a4-token';
  let app, browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token, nodeToken: 'review-a4-node', pairingTtlMs: 6000 });
    const canonical = async () => (await (await fetch(`${app.url}/api/v0/pairing/info`, { headers: V })).json());
    browser = await launch();
    const { page, creations } = await connect(browser, app, token);
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor();
    const live = await canonical();
    assert.equal(live.activeSession, true, 'the session was really active before hiding');

    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(Math.max(0, Date.parse(live.descriptor.expiresAt) - Date.now()) + 3500);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.locator('#pairing-code').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const shown = await page.locator('#view').innerText();
    assert.equal(await page.locator('#pairing-code').count(), 0, 'no dead code is displayed after being shown');
    assert.match(shown, /The code expired/i, 'the terminal reason is EXPIRY, not consumption');
    assert.equal(creations.length, 1, 'nothing along this path created a session');
    assert.equal((await canonical()).activeSession, false, 'the City agrees the session is gone');
    assert.equal(await page.locator('#generate-pairing').isDisabled(), false, 'Generate is available again');

    // And the next explicit click is one genuinely new session, not a resurrection.
    await page.getByRole('button', { name: 'Generate pairing session', exact: true }).click();
    await page.locator('#pairing-qr svg').waitFor({ timeout: 8000 });
    const after = await canonical();
    assert.equal(creations.length, 2, 'the post-expiry click was the second and last creation');
    assert.equal(after.activeSession, true);
    assert.notEqual(after.descriptor.pairingSessionId, live.descriptor.pairingSessionId, 'the new session is genuinely new');
  } finally { await browser?.close(); await app?.close(); await rm(dir, { recursive: true, force: true }); }
});
