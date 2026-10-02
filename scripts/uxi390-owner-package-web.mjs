// UXI-390 step 5 — capture the Web half of the minimal Owner-facing package.
//
// The workbook's step 5 asks for a MINIMAL set for the Owner's FINAL_VISUAL_ACCEPTANCE gate: Web Home / Ask /
// Tools, one Room, and one provider switch or remote-handoff state. This script drives the REAL product shell
// against a REAL gateway and a REAL reference node, and writes PNGs plus a receipt.
//
// Why the images land in THIS repository and not in Digital-City: PROCESS_DATA_POLICY.md line 16 says terminal
// logs, screenshots and raw traces must not be piled into City, and line 53 allows a small amount of
// non-sensitive cross-host evidence to be published selectively on the mission branch under
// evidence/raw/mission-book/<ID>/. City therefore gets a pointer + digest + summary, not the pixels.
//
// The script starts and stops its own services, because the harness kills the whole process tree when the
// invoking command ends.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const PORT = Number(process.env.CITY_PORT || 4357);
const ROOT = process.cwd();
const TOKEN = 'uxi390-ownerpkg-web-4c19';
const NODE_TOKEN = 'uxi390-ownerpkg-node-9e02';
const DATA = `${ROOT}/.runtime-ownerpkg-web`;
const OUT = `${ROOT}/evidence/raw/mission-book/UXI-390/owner-package`;
const WATCHDOG_MS = Number(process.env.CAPTURE_WATCHDOG_MS || 240000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const log = [];
const say = (m) => { log.push(m); console.log(m); };

const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: exceeded ${WATCHDOG_MS}ms`);
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

function start(file, extraEnv = {}) {
  const child = spawn(process.execPath, [file], {
    cwd: ROOT,
    env: {
      ...process.env,
      CITY_HOST: '127.0.0.1',
      CITY_PORT: String(PORT),
      CITY_URL: `http://127.0.0.1:${PORT}`,   // the reference node reads CITY_URL, not CITY_PORT
      CITY_TOKEN: TOKEN,
      CITY_NODE_TOKEN: NODE_TOKEN,
      CITY_DATA: DATA,
      CITY_WORKSPACE: `${DATA}/workspace`,
      CITY_TELEMETRY_DISABLED: undefined,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  child.stdout.on('data', (d) => { if (process.env.CAPTURE_VERBOSE) process.stdout.write(`[${file}] ${d}`); });
  child.stderr.on('data', (d) => { if (process.env.CAPTURE_VERBOSE) process.stdout.write(`[${file} ERR] ${d}`); });
  return child;
}

const api = async (path) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v0/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};

async function waitFor(label, predicate, { tries = 60, every = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await predicate(); if (v) return v; } catch { /* keep waiting */ }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const shots = [];
async function shot(page, name, note, region = '#view') {
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  const bytes = readFileSync(file);
  // Excerpt the CONTENT region, not the whole body: the body starts with the sidebar, so a whole-body excerpt
  // is the same 220 characters in every shot and cannot discriminate one surface from another. That was a real
  // defect in the first version of this script, caught because two images came out byte-identical.
  let text = '';
  try { text = (await page.locator(region).first().innerText()).replace(/\s+/g, ' ').trim(); } catch { /* fall back */ }
  if (!text) text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  const record = {
    file: `evidence/raw/mission-book/UXI-390/owner-package/${name}.png`,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    note,
    region,
    contentChars: text.length,
    contentExcerpt: text.slice(0, 400),
  };
  shots.push(record);
  say(`  captured ${name}.png  ${bytes.length} bytes  sha256=${record.sha256.slice(0, 16)}…  region=${region}`);
  say(`    content: ${text.slice(0, 240)}`);
  return record;
}

const teardown = () => { for (const c of children) { try { c.kill(); } catch { /* gone */ } } };

(async () => {
  rmSync(DATA, { recursive: true, force: true });   // a fresh city, so nothing stale can be captured
  mkdirSync(OUT, { recursive: true });
  mkdirSync(`${DATA}/workspace`, { recursive: true });

  const head = spawn('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  let headSha = '';
  head.stdout.on('data', (d) => { headSha += d.toString().trim(); });
  await new Promise((r) => head.on('close', r));

  say(`=== UXI-390 step 5, Web package: port ${PORT}, fresh CITY_DATA, head ${headSha} ===`);

  say('starting the real Room Hub, the real Gateway and a real reference node');
  // The gateway's Room Pack client defaults to http://127.0.0.1:4320 (rooms.mjs DEFAULT_ROOM_HUB_URL) and
  // main.mjs does not override it, so the hub must be started on its own default port or the Rooms page
  // truthfully reports "ROOM HUB UNAVAILABLE (ECONNREFUSED)" and no room can be opened at all. That is what
  // the first run of this script captured, and it is why the hub is now started BEFORE the gateway.
  start('apps/rooms/hub/server.mjs', { ROOMS_PORT: '4320' });
  // Readiness is probed at the hub root: the hub's data API base is /local-rooms/v1 (manifest.mjs
  // ROOM_API_BASE), NOT /api/rooms, and probing the wrong path here is what made the second run time out
  // while the hub was in fact serving all ten rooms.
  await waitFor('the Room Hub to answer', () => fetch('http://127.0.0.1:4320/').then((r) => r.ok));
  start('services/dev-gateway/main.mjs');
  await waitFor('gateway health', () => fetch(`http://127.0.0.1:${PORT}/api/v0/health`).then((r) => r.ok));
  const node = start('agents/reference-node/main.mjs');
  await waitFor('node registration', async () => ((await api('city')).nodes ?? []).length > 0);
  // Asserted, not assumed: with the hub absent the Rooms page renders a truthful unavailability state and the
  // room-open control does not exist, so the capture must refuse rather than ship a page that cannot open a room.
  // The room STATE lives at payload.rooms (the envelope is {apiVersion, schemaVersion, rooms:{...}}); reading
  // `available` off the envelope is what made the third run refuse a healthy city.
  const roomsEnvelope = await api('rooms');
  const roomsState = roomsEnvelope.rooms ?? {};
  if (roomsState.available !== true) {
    throw new Error(`the gateway reports rooms unavailable (${roomsState.reason}) - refusing to capture a Rooms surface that cannot open a room`);
  }
  const roomCount = Number(roomsState.count ?? (roomsState.rooms ?? []).length);
  say(`  hub, gateway healthy, node registered: ${((await api('city')).nodes ?? []).map((n) => n.id).join(', ')}; rooms available = true, ${roomCount} rooms, hub ${roomsState.hubUrl}`);

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));

  await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.locator('#connection').filter({ hasText: 'ONLINE' }).waitFor({ timeout: 25000 });
  say('  paired and ONLINE');

  // 1 — Home
  await page.locator('nav button[data-page="Home"]').click();
  await sleep(2500);
  await shot(page, '01-web-home', 'Web Home, paired and ONLINE, with the assistant slot and the rooms grid');

  // 2 — Ask / Do, driven through the real control rather than by calling the API
  await page.locator('#ask-text').fill('What is my city doing right now?');
  await page.locator('#ask-submit').click();
  await sleep(4000);
  await shot(page, '02-web-ask', 'Web Ask/Do mounted by submitting a real prompt through the real control');

  // 3 — Tools / Rooms (the nav entry is labelled "Tools / Rooms")
  await page.locator('nav button[data-page="Rooms"]').click();
  await sleep(2500);
  await shot(page, '03-web-tools-rooms', 'Web Tools / Rooms surface as the nav opens it');

  // 4 — one Room actually OPENED. The first version of this script clicked `#home-rooms-body button`, which is
  // a card carrying data-goto="Rooms" -- it only navigates to the Rooms page, so the "room opened" shot came
  // out BYTE-IDENTICAL to the Rooms shot while the text comparison still said the surface had changed. The
  // real control is the per-room `button[data-terminal="room-open"]`, and the open state is proved by the
  // presence of its counterpart `button[data-terminal="room-close"]`.
  const roomsContent = (await page.locator('#view').innerText()).replace(/\s+/g, ' ').trim();
  const roomId = await page.locator('button[data-terminal="room-open"]').first().getAttribute('data-room');
  let roomOpened = false;
  try {
    await page.locator('button[data-terminal="room-open"]').first().click({ timeout: 6000 });
    await page.locator('button[data-terminal="room-close"]').first().waitFor({ timeout: 15000 });
    // Scroll the OPENED room into view before photographing it. The room opens into an embedded hub frame
    // further down a long room list, so a viewport-only screenshot taken from the top of the page came out
    // BYTE-IDENTICAL to the overview even though the DOM had genuinely changed -- the instrument was
    // photographing a part of the page the change was not in, which is the failure this programme keeps
    // cataloguing. The duplicate-hash guard is what caught it.
    await page.locator('button[data-terminal="room-close"]').first().scrollIntoViewIfNeeded();
    await sleep(3000);
    roomOpened = true;
  } catch (e) { say(`  room open failed: ${e.message.slice(0, 140)}`); }
  const roomShot = await shot(page, '04-web-room-open',
    `One Room OPENED from the Rooms page (room id ${roomId}); the close control is present, so the surface is in the open state`);
  if (roomShot.sha256 === shots[2].sha256) {
    throw new Error('the room shot is byte-identical to the Rooms shot - the room did not open, so the capture is vacuous');
  }
  if (roomsContent === roomShot.contentExcerpt.slice(0, roomsContent.length) && roomOpened !== true) {
    throw new Error('the Rooms content did not change after opening a room');
  }

  // 5 — one provider / device failure state, produced rather than mocked: kill the executor, then create work
  await page.locator('nav button[data-page="Devices"]').click();
  await sleep(2000);
  node.kill();
  await waitFor('the node to go offline', async () => ((await api('city')).nodes ?? []).every((n) => n.online !== true));
  say('  executor killed; creating real work through the real control');
  await page.locator('#run').click();
  const taskCards = () => page.locator('.scheduler-panel .scheduler-task').count();
  let cards = 0;
  for (let i = 0; i < 40 && cards === 0; i++) { await sleep(1000); cards = await taskCards(); }
  await sleep(3000);
  await shot(page, '05-web-provider-state',
    `Real task in flight with the executor gone; scheduler task cards = ${cards}`, '.scheduler-panel');

  // The package's own anti-vacuity guard: two identical images mean one of them is not evidence of anything.
  const hashes = shots.map((s) => s.sha256);
  const duplicates = hashes.filter((h, i) => hashes.indexOf(h) !== i);
  if (duplicates.length) throw new Error(`duplicate screenshots in the package: ${duplicates.length}`);

  const receipt = {
    task: 'UXI-390',
    step: '5 (Web half of the minimal Owner-facing package)',
    capturedAt: new Date().toISOString(),
    implementationHead: headSha,
    port: PORT,
    freshCityData: DATA,
    viewport: '1440x900',
    locale: 'en-US',
    browser: 'msedge headless via Playwright',
    pageErrors,
    taskCardsInProviderShot: cards,
    roomSurfaceChanged: roomOpened,
    images: shots,
    log,
  };
  writeFileSync(`${OUT}/capture-receipt.json`, JSON.stringify(receipt, null, 2));
  say(`=== wrote ${shots.length} images and capture-receipt.json to ${OUT} ===`);
  say(`page errors: ${pageErrors.length}${pageErrors.length ? ' -> ' + pageErrors.join(' | ') : ''}`);
  say(`room surface changed: ${roomOpened}; provider-state task cards: ${cards}`);

  await browser.close();
  teardown();
  const ok = shots.length === 5 && roomOpened && cards > 0 && pageErrors.length === 0;
  say(ok ? 'RESULT: PASS - the Web half of step 5 is captured and every anti-vacuity condition held'
         : 'RESULT: PARTIAL - see the conditions above; the package must state whatever did not hold');
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  say(`FAILED: ${e.message}`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/capture-receipt.json`, JSON.stringify({ failed: true, error: e.message, log }, null, 2));
  teardown();
  process.exit(1);
});
