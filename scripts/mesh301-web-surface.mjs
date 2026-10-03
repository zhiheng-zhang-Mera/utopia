// MESH-301 — drive the Web control surface in a REAL browser, and record what IT observed.
//
// Two jobs, because they are the same session:
//
//   1. exercise the surface the way a user would - connect, pick a target, press Run - so the Web half of
//      "Web / Android 发起 strict-target safe task 的最小交互" is demonstrated rather than asserted;
//   2. write that surface's OWN observation receipt in the same JSONL vocabulary as
//      `mesh301-mesh-probe.mjs`, so `merge` can put the browser, the Android device and any desktop probe
//      on ONE convergence table.
//
// The observations come from inside the page: `WebSocket` is wrapped before the app loads, so the record is
// what the BROWSER received and when, not what this script inferred afterwards. That distinction is the
// whole point of step 5 - a number computed outside the surface is a claim about it.
//
// USAGE
//   node scripts/mesh301-web-surface.mjs --label "Alien Web" --target Mech-Win --out web.jsonl [--observeMs 30000]
// Connection settings come from the environment so the token never reaches a command line:
//   CITY_URL, CITY_TOKEN
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const URL_BASE = (flag('url') ?? process.env.CITY_URL ?? '').replace(/\/$/, '');
const TOKEN = flag('token') ?? process.env.CITY_TOKEN ?? '';
const LABEL = flag('label', 'Web browser');
const TARGET = flag('target', '');
const OUT = flag('out', 'mesh301-web-surface.jsonl');
const OBSERVE_MS = Number(flag('observeMs', 20000));
if (!URL_BASE || !TOKEN) { console.error('need --url/CITY_URL and --token/CITY_TOKEN'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Every record is buffered and written ONCE, sorted by observation time.
//
// Not tidiness: `merge` reconstructs a surface's offline interval by walking `stale` -> `reconnected` in file
// ORDER, and the browser's `stale` arrives from inside the page while `reconnected` is stamped by this
// script. Appending them as they happen would put the pair in the wrong order and the offline interval would
// silently vanish - the surface would look like it never went away, which is the opposite of the truth.
const records = [];
function record(r) { records.push({ surface: LABEL, at: new Date().toISOString(), ...r }); }
function flush() {
  records.sort((a, b) => (a.observedAt ?? Date.parse(a.at)) - (b.observedAt ?? Date.parse(b.at)));
  writeFileSync(OUT, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);
}

async function serverMaxSeq() {
  const r = await fetch(`${URL_BASE}/api/v0/events`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' } });
  const body = await r.json();
  return (body.events ?? []).reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
}

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const context = await browser.newContext();
const page = await context.newPage();

// The identity and the observation recorder are installed BEFORE any app code runs, so neither can be
// skipped by a race with page load.
await page.addInitScript(({ label }) => {
  try {
    localStorage.setItem('utopia.clientLabel', label);
    if (!localStorage.getItem('utopia.clientRef')) localStorage.setItem('utopia.clientRef', 'web-' + Math.random().toString(36).slice(2, 10));
  } catch { /* a browser with storage disabled is still a surface; it just cannot be renamed */ }
  window.__obs = [];
  const Native = window.WebSocket;
  const stamp = () => Date.now();
  window.WebSocket = function (...args) {
    const ws = new Native(...args);
    window.__ws = ws;
    ws.addEventListener('open', () => window.__obs.push({ kind: 'open', observedAt: stamp() }));
    ws.addEventListener('close', () => window.__obs.push({ kind: 'stale', observedAt: stamp() }));
    ws.addEventListener('message', ev => {
      try {
        const m = JSON.parse(ev.data);
        if (m && m.event) {
          const seq = m.event.seq ?? null;
          // R1 for the browser, same as the Android surface. Events emitted between the network dying and the
          // socket's close firing are gone before any staleness signal exists, so a receipt cannot bound a gap
          // it never saw begin - but the surface CAN see the discontinuity itself. Measured: this surface lost
          // exactly one seq (505) in the gate-8 window and, without this, the merge could only call it MISSING.
          if (seq != null && window.__lastSeq != null && seq > window.__lastSeq + 1) window.__obs.push({ kind: 'gap', gapFrom: window.__lastSeq + 1, gapTo: seq - 1, observedAt: stamp() });
          if (seq != null) window.__lastSeq = seq;
          window.__obs.push({ kind: 'event', seq, type: m.event.type ?? null, taskId: m.event.taskId ?? null, serverAt: m.event.timestamp ?? null, observedAt: stamp() });
        }
        else if (m && m.type) window.__obs.push({ kind: 'control', messageType: m.type, observedAt: stamp() });
      } catch { /* a frame that is not JSON is not an event */ }
    });
    return ws;
  };
  window.WebSocket.prototype = Native.prototype;
}, { label: LABEL });

record({ kind: 'start', cityUrl: URL_BASE });
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await page.fill('#token', TOKEN);
await page.click('#connect');
// Locale-INDEPENDENT readiness. The first version of this waited for the literal text "ONLINE" and timed out
// against a UI that was rendering the localised word for it - the surface was connected the whole time.
// `status()` sets this element's className, which does not move when the language does.
await page.waitForFunction(() => (document.querySelector('#connection')?.className ?? '').includes('online'), null, { timeout: 20000 });
record({ kind: 'resync', maxSeq: await serverMaxSeq(), observedAt: Date.now(), source: 'server' });
console.log(`web surface "${LABEL}" is ONLINE on ${URL_BASE}`);

if (TARGET) {
  const options = await page.$$eval('#run-target option', els => els.map(e => e.value));
  if (!options.includes(TARGET)) throw new Error(`the surface does not offer ${TARGET}; it offers ${options.join(', ') || '(nothing)'}`);
  await page.selectOption('#run-target', TARGET);
  await page.click('#run');
  await sleep(6000);
  console.log(`pressed Run with target=${TARGET}`);
}

// A deliberate disconnect, so the offline/reconnect half of step 5 is exercised by a REAL surface and not
// only by the desktop probe.
const beforeClose = await page.evaluate(() => window.__obs.length);
await context.setOffline(true);
await sleep(2500);
await context.setOffline(false);
await sleep(4000);
record({ kind: 'reconnected', observedAt: Date.now() });
record({ kind: 'resync', maxSeq: await serverMaxSeq(), observedAt: Date.now(), source: 'server' });
console.log(`offline/reconnect exercised (observations before the cut: ${beforeClose})`);

await sleep(Math.max(0, OBSERVE_MS - 12000));
const observed = await page.evaluate(() => window.__obs);
for (const o of observed) record(o);
record({ kind: 'stop', eventsObserved: observed.filter(o => o.kind === 'event').length, serverMaxSeq: await serverMaxSeq() });
flush();
await browser.close();
console.log(`wrote ${records.length} records to ${OUT}`);
