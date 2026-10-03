// JOIN-502 — the onboarding SURFACE, in a real browser against a real City.
//
// What this file is for: the workbook's product claim is not "an endpoint exists" but "a new PC opens
// Utopia, sees a nearby City, asks to join, and an existing device approves". So this drives the actual
// page: the browse, the hand-off to the discovered City, the pending ask, the approval card an owner
// sees, and the credential that arrives only after that approval.
//
// The DISCOVERED LIST is scripted through the page's own route, because a browser cannot listen to
// multicast DNS and the real browse (`browseNearby`, including the identification round trip) is covered
// by join502-nearby.test.mjs. Everything after the click is the real thing: the real gateway, the real
// fragment hand-off, the real approval route and the real credential exchange.
//
// Waiting is done on SERVER FACTS through `until` wherever a server fact exists, and on the DOM only for
// the wording the workbook requires. A test that sleeps and then asserts cannot say which of the two was
// wrong when it fails.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway } from '../services/dev-gateway/server.mjs';

const CONTROL = 'join-ui-token';
const NODE = 'join-ui-node';
const VERSION = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const ownerHeaders = { Authorization: `Bearer ${CONTROL}`, 'Content-Type': 'application/json', ...VERSION };

// Every browser this file opens is closed by the file's `after` hook as well as by each test: a failure
// before a test's own finally block would otherwise leave a browser process holding the event loop, and a
// suite that reports failures but never exits is a suite nobody can act on.
const opened = new Set();
after(async () => { for (const browser of opened) { try { await browser.close(); } catch { /* already gone */ } } opened.clear(); });

const until = async (check, { timeoutMs = 20000, stepMs = 300, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`not met in time: ${label}`);
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
};

/** The City's own public identity, read the way the gateway's browse reads it (nearby.mjs identifyCity).
 *  The mDNS TXT record only carries a short prefix and is deliberately NOT used as the join pin. */
const cityIdOf = async url => (await (await fetch(`${url}/api/v0/join/info`, { headers: VERSION })).json()).cityId;
const joinRequests = async url => (await (await fetch(`${url}/api/v0/join/requests`, { headers: ownerHeaders })).json());

const nearbyFixture = (address, port, cityRef) => ({
  apiVersion: 0,
  schemaVersion: 0,
  nearby: [{ cityRef, displayName: 'Utopia · Nearby', address, port, transport: 'LAN', lastSeenAt: new Date().toISOString(), stale: false, grantsTrust: false }],
  bounded: true,
  discovered: 1,
  unavailable: false,
});

/** Answer the browse route with a scripted LAN sighting. `page.route` REPLACES an earlier handler for the
 *  same URL, so a test can script the browse more than once without unwinding its own routes. */
function scriptBrowse(page, answer) {
  return page.route('**/api/v0/join/nearby', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) }));
}
function breakBrowse(page) {
  return page.route('**/api/v0/join/nearby', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ apiVersion: 0, schemaVersion: 0, error: 'browse failed' }) }));
}

const launchBrowser = async () => { const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true }); opened.add(browser); return browser; };
const hostText = page => page.locator('#nearby-host').innerText();

test('JOIN-502 surface: a nearby City is offered without being trusted, and joining waits for an approval', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-ui-'));
  const targetDir = await mkdtemp(resolve('.scratch-join-target-'));
  let app, target, browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
    // The advertised City is a SECOND City the joining page navigates to - a different origin, which is
    // the whole reason the ask travels in a fragment instead of as a cross-origin POST.
    target = await createGateway({ host: '127.0.0.1', port: 0, dir: targetDir, token: CONTROL, nodeToken: NODE });
    browser = await launchBrowser();
    const asking = await browser.newPage({ locale: 'en-US' });
    await asking.goto(app.url);
    await asking.locator('#nearby-host').waitFor();
    // The onboarding block belongs to the first-run panel, and no City client exists yet.
    assert.equal(await asking.locator('#content').isVisible(), false);

    await scriptBrowse(asking, nearbyFixture(new URL(target.url).hostname, Number(new URL(target.url).port), await cityIdOf(target.url)));
    await asking.getByRole('button', { name: 'Search for nearby Cities' }).click();
    await until(async () => (await hostText(asking)).includes('Utopia · Nearby'), { label: 'the discovered City is offered' });
    assert.match(await hostText(asking), /Discovered, not trusted/);
    // Discovery is not an ask, and it is not a credential: the joins list stays empty until a human acts.
    assert.equal((await joinRequests(target.url)).pending, 0);

    // Handing the ask to the discovered City is a NAVIGATION.
    await asking.getByRole('button', { name: 'Request join' }).click();
    await asking.waitForURL(`${target.url}/**`, { timeout: 20000 });
    const ask = await until(async () => (await joinRequests(target.url)).requests.find(row => row.state === 'PENDING'), { label: 'exactly one pending ask against the discovered City' });
    await until(async () => (await hostText(asking)).includes('Waiting for approval'), { label: 'the joining page reports it is waiting' });
    assert.equal((await joinRequests(target.url)).pending, 1, 'the browse must create no ask; the join must create exactly one');
    const listed = JSON.stringify(await joinRequests(target.url));
    assert.ok(!listed.includes(CONTROL), 'an approval card must never carry the City credential');
    assert.ok(!listed.includes('claimDigest'));

    // The owner's side, on an already trusted surface of the SAME City.
    const owner = await browser.newPage({ locale: 'en-US' });
    await owner.goto(target.url);
    await owner.getByLabel('Pairing token').fill(CONTROL);
    await owner.getByRole('button', { name: 'Connect', exact: true }).click();
    await owner.locator('#connection.online').waitFor({ timeout: 20000 });
    await owner.locator('[data-page="Pairing"]').click();
    const card = owner.locator(`[data-join-row="${ask.id}"]`);
    await until(async () => (await card.count()) === 1, { label: 'the approval card is on the owner surface' });
    const cardText = await card.innerText();
    // The card says what asked, on what platform, and under which non-secret reference - and it does not
    // render the credential it is about to release.
    assert.match(cardText, new RegExp(ask.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(cardText, new RegExp(ask.shortRef));
    assert.match(cardText, /WAITING/i);
    assert.ok(!cardText.includes(CONTROL));

    // THE GATE. Approve returns to the backend; the joining page then collects the credential over its
    // own origin and comes online as that City's client.
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await until(async () => (await joinRequests(target.url)).requests.find(row => row.id === ask.id)?.state === 'CONSUMED', { label: 'the approved request is collected exactly once' });
    await asking.locator('#connection.online').waitFor({ timeout: 30000 });
    assert.equal(await asking.locator('#content').isVisible(), true);
    assert.equal((await joinRequests(target.url)).pending, 0);
    // The session credential is used, never rendered.
    assert.ok(!(await asking.content()).includes(CONTROL), 'the session credential must not be rendered into the page');
  } finally {
    await browser?.close(); await app?.close(); await target?.close();
    await rm(dir, { recursive: true, force: true }); await rm(targetDir, { recursive: true, force: true });
  }
});

test('JOIN-502 surface: a refused browse still offers the fallbacks, and a rejected ask leaves the device untrusted', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-ui-'));
  let app, browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: NODE });
    browser = await launchBrowser();
    const page = await browser.newPage({ locale: 'en-US' });
    await page.goto(app.url);
    await page.locator('#nearby-host').waitFor();

    // Discovery FAILING must not look like an empty network, and the manual / QR / code / link fallbacks
    // must survive it. Both are asserted because either one alone is a defect.
    await breakBrowse(page);
    await page.getByRole('button', { name: 'Search for nearby Cities' }).click();
    await until(async () => (await hostText(page)).includes('Local discovery is unavailable'), { label: 'discovery failure is stated' });
    assert.equal(await page.getByLabel('Pairing token').count(), 1, 'the manual fallback must remain available');
    await page.getByText('Pairing token', { exact: true }).waitFor();

    // A rejected ask is an answer: the page says so, and the device stays outside the City.
    await scriptBrowse(page, nearbyFixture(new URL(app.url).hostname, Number(new URL(app.url).port), await cityIdOf(app.url)));
    await page.getByRole('button', { name: 'Search for nearby Cities' }).click();
    await until(async () => (await hostText(page)).includes('Utopia · Nearby'), { label: 'the discovered City is offered again' });
    await page.getByRole('button', { name: 'Request join' }).click();
    const ask = await until(async () => (await joinRequests(app.url)).requests[0], { label: 'the ask is recorded' });
    await until(async () => (await hostText(page)).includes('Waiting for approval'), { label: 'the joining page reports it is waiting' });
    await fetch(`${app.url}/api/v0/join/requests/${ask.id}/reject`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({}) });
    await until(async () => (await hostText(page)).includes('rejected this join request'), { label: 'the rejection is shown to the requester' });
    assert.equal(await page.locator('#content').isVisible(), false);
    assert.equal(await page.locator('#connection').innerText(), 'OFFLINE');
    // No credential was ever released for the rejected request.
    assert.equal((await joinRequests(app.url)).pending, 0);
  } finally {
    await browser?.close(); await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
