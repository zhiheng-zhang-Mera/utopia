import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway } from '../services/dev-gateway/server.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const launch = () => chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
async function session(app) {
  const r = await fetch(app.url + '/api/v0/pairing/session', { method: 'POST', headers: { ...V, Authorization: 'Bearer search-owner', 'Content-Type': 'application/json' }, body: '{}' });
  return r.json();
}
async function fixture(run) {
  const dir = await mkdtemp(resolve('.scratch-pair-search-'));
  const peerDir = await mkdtemp(resolve('.scratch-pair-peer-'));
  let app, peer, browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'search-owner', nodeToken: 'search-node', roomsDisabled: true });
    peer = await createGateway({ host: '127.0.0.1', port: 0, dir: peerDir, token: 'search-peer', nodeToken: 'search-peer-node', roomsDisabled: true });
    browser = await launch();
    const page = await browser.newPage({ locale: 'en-US' });
    await page.route('**/api/v0/join/nearby*', route => route.fulfill({ json: { apiVersion: 0, schemaVersion: 0, nearby: [], unavailable: false } }));
    await run({ app, peer, browser, page });
  } finally {
    await browser?.close(); await app?.close(); await peer?.close();
    await rm(dir, { recursive: true, force: true }); await rm(peerDir, { recursive: true, force: true });
  }
}

test('pairing input survives slow typing, refresh, navigation and a failed attempt', () => fixture(async ({ app, page }) => {
  await page.goto(app.url + '/#token=search-owner');
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="Pairing"]').click();
  const field = page.locator('#swap-code');
  await field.fill('12');
  await page.waitForTimeout(4800);
  assert.equal(await field.inputValue(), '12', 'background refresh must preserve partial input');
  await field.press('End'); await field.pressSequentially('3456', { delay: 900 });
  assert.equal(await field.inputValue(), '123456', 'typing must retain focus across refresh');
  await page.locator('[data-page="Home"]').click();
  await page.locator('[data-page="Pairing"]').click();
  assert.equal(await field.inputValue(), '123456');
  const s = await session(app);
  const wrong = s.shortCode === '000000' ? '111111' : '000000';
  await field.fill(wrong); await page.locator('#swap-code-connect').click();
  await page.waitForFunction(() => document.querySelector('#swap-code-note')?.textContent.includes('wrong'));
  await page.waitForTimeout(4500);
  assert.equal(await field.inputValue(), wrong);
  assert.match(await page.locator('#swap-code-note').innerText(), /wrong/);
}));

test('a six digit code pairs to the City serving the disconnected page', () => fixture(async ({ app, page }) => {
  const s = await session(app);
  await page.goto(app.url);
  await page.locator('#pair-code').fill(s.shortCode);
  await page.locator('#pair-code-connect').click();
  await page.locator('#connection.online').waitFor({ timeout: 10000 });
  const info = await fetch(app.url + '/api/v0/pairing/info').then(r => r.json());
  assert.equal(info.activeSession, false, 'the real single-use exchange consumed this code');
}));

for (const transport of ['LAN','BLE_BOOTSTRAP']) test(`${transport} search selects a peer and hands the code to its origin without a cross-origin POST`, () => fixture(async ({ app, peer, page }) => {
  const response = await fetch(peer.url + '/api/v0/pairing/session', { method: 'POST', headers: { ...V, Authorization: 'Bearer search-peer', 'Content-Type': 'application/json' }, body: '{}' });
  const s = await response.json();
  const address = new URL(peer.url);
  await page.route('**/api/v0/join/nearby*', route => route.fulfill({ json: { apiVersion: 0, schemaVersion: 0, nearby: [{ cityRef: s.descriptor.cityId, displayName: 'Nearby laptop', address: address.hostname, port: Number(address.port), transport, lastSeenAt: new Date().toISOString() }] } }));
  await page.goto(app.url + '/#token=search-owner');
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="Pairing"]').click();
  await page.locator(transport==='LAN'?'#swap-nearby-browse':'#swap-nearby-ble').click();
  await page.locator('#swap-nearby-host [data-pair-target]').click();
  await page.locator('#swap-code').fill(s.shortCode);
  const posts = [];
  const methods = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/pairing/exchange')) { posts.push(r.url()); methods.push(r.postDataJSON().method); } });
  await page.locator('#swap-code-connect').click();
  await page.waitForURL(peer.url + '/**');
  await page.locator('#connection.online').waitFor({ timeout: 10000 });
  assert.deepEqual(posts, [peer.url + '/api/v0/pairing/exchange']);
  assert.deepEqual(methods, [transport==='LAN'?'mdns':'ble']);
  assert.equal(await page.evaluate(() => location.hash), '', 'code handoff is removed from address bar');
}));

test('Bluetooth search is actionable and explains an unavailable radio', () => fixture(async ({ app, page }) => {
  let scans = 0;
  await page.route('**/api/v0/join/nearby*', route => {
    if (new URL(route.request().url()).searchParams.get('transport') === 'ble') scans++;
    return route.fulfill({ json: { apiVersion: 0, schemaVersion: 0, nearby: [], unavailable: true, reason: 'BLUETOOTH_DISABLED' } });
  });
  await page.goto(app.url);
  await page.locator('#nearby-ble').click();
  await page.waitForFunction(() => document.querySelector('#nearby-host')?.textContent.includes('Bluetooth is off'));
  assert.equal(scans, 1);
  assert.equal(await page.locator('#pair-code').isEnabled(), true, 'manual pairing remains usable');
}));

test('a failed code handoff retains the target identity on retries', () => fixture(async ({ app, page }) => {
  const s = await session(app);
  const handoff = new URLSearchParams({ city: 'a-different-city', code: s.shortCode, method: 'ble' });
  await page.goto(app.url + '/#short-pair=' + encodeURIComponent(handoff.toString()));
  await page.waitForFunction(() => document.querySelector('#pair-code-note')?.textContent.includes('identity'));
  await page.locator('#pair-code-connect').click();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#content').isVisible(), false, 'retry cannot drop the identity pin and authenticate another City');
  assert.equal((await fetch(app.url + '/api/v0/pairing/info').then(r => r.json())).activeSession, true, 'the wrong City code must remain unconsumed');
}));
