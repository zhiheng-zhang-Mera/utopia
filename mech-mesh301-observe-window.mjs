// MESH-301 gate-8 window - the MECH surface observes a long, self-generated canonical window.
//
// WHY THIS SHAPE. Gate 8 needs the three online surfaces to converge on the SAME canonical seq range, and
// Alien's record calls the coordination a scheduling problem. A tightly synchronised start would need the two
// hosts to agree on a clock and a minute; a LONG window does not. This surface connects, holds the live stream,
// and stays for `--minutes`, generating its own canonical activity inside the window, so the other two surfaces
// only have to be up at SOME point during it. Seq bounds outside a surface's own range are reported by the
// merge as BEFORE_OBSERVATION / AFTER_OBSERVATION, which is why a wide window costs nothing and buys robustness.
//
// WHY IT GENERATES ITS OWN EVENTS. A window with nothing in it converges vacuously - the instrument defect
// Alien already found once ("CONVERGED on an empty timeline"). So this produces, in order:
//   * an UNTARGETED task        -> gate 7 (no regression) inside the same window as everything else;
//   * a task strict-targeted at the OTHER host -> PC -> PC inside the same window;
//   * a deliberate NODE_OFFLINE / NODE_ONLINE of THIS host's own worker -> step 5.3's "node offline/online or
//     ownership change" event, which a task-only window cannot supply.
// The node transition uses the resident supervisor's control file, so it is reversible by construction.
//
// WHAT IT IS NOT. It is not a measurement of the other two surfaces, and it does not claim gate 8 by itself:
// one surface's receipt cannot make a three-surface table. It is the Mech row, produced by the Mech surface.
//
// USAGE
//   CITY_URL=... CITY_TOKEN=... node mech-mesh301-observe-window.mjs --minutes 16
import {chromium} from 'playwright';
import {writeFileSync, mkdirSync} from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const CITY = (flag('url') ?? process.env.CITY_URL ?? 'http://172.31.3.110:4391').replace(/\/$/, '');
const TOKEN = flag('token') ?? process.env.CITY_TOKEN ?? '';
const LABEL = flag('label', 'Mech-Win-Web');
const OTHER = flag('other', 'Alien-Win');
const SELF = flag('self', 'Mech-Win');
const MINUTES = Number(flag('minutes', 16));
const CONTROL = flag('control', 'D:/A-utopia/.runtime/mesh301-resident-control.json');
const EVIDENCE = `${process.cwd()}/evidence/raw/mission-book/MESH-301/review-by-mech`;
const OUT_JSONL = `${EVIDENCE}/mech-web-gate8-window.jsonl`;
const OUT_JSON = `${EVIDENCE}/mech-web-gate8-window.json`;
if (!TOKEN) { console.error('CITY_TOKEN required'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const api = async (path, body) => {
  const r = await fetch(`${CITY}/api/v0/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)});
  return {status: r.status, json: await r.json().catch(() => null)};
};
const nodeOnline = async (id) => ((await api('city')).json?.nodes ?? []).find((n) => n.id === id)?.online === true;
const setControl = (shared) => { writeFileSync(CONTROL, JSON.stringify({shared, local: 'up'})); say(`control file -> shared:${shared}`); };

const records = [];
const rec = (r) => records.push({surface: LABEL, at: new Date().toISOString(), ...r});
const flush = () => {
  records.sort((a, b) => (a.observedAt ?? Date.parse(a.at)) - (b.observedAt ?? Date.parse(b.at)));
  writeFileSync(OUT_JSONL, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
};

const generated = [];
let taskUntargeted = null, taskTargeted = null, offlineSeq = null, onlineSeq = null;
let browser = null, restored = true;

try {
  mkdirSync(EVIDENCE, {recursive: true});
  say(`=== gate-8 window: surface "${LABEL}" on the MECH host, ${MINUTES} minutes ===`);
  const before = await api('city');
  say(`cityId=${before.json?.cityId}  nodes=${JSON.stringify((before.json?.nodes ?? []).map((n) => n.id + ':' + n.online))}`);

  browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
  const context = await browser.newContext();
  const page = await context.newPage({viewport: {width: 1440, height: 900}});
  await page.addInitScript(({label}) => {
    try {
      localStorage.setItem('utopia.clientLabel', label);
      if (!localStorage.getItem('utopia.clientRef')) localStorage.setItem('utopia.clientRef', `web-mech-${Math.random().toString(36).slice(2, 10)}`);
    } catch { /* storage disabled: still a surface, just not a nameable one */ }
    window.__obs = [];
    const Native = window.WebSocket;
    const stamp = () => Date.now();
    window.WebSocket = function (...args) {
      const ws = new Native(...args);
      ws.addEventListener('open', () => window.__obs.push({kind: 'open', observedAt: stamp()}));
      ws.addEventListener('close', () => window.__obs.push({kind: 'stale', observedAt: stamp()}));
      ws.addEventListener('message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m && m.event) window.__obs.push({kind: 'event', seq: m.event.seq ?? null, type: m.event.type ?? null, taskId: m.event.taskId ?? null, serverAt: m.event.timestamp ?? null, observedAt: stamp()});
          else if (m && m.type) window.__obs.push({kind: 'control', messageType: m.type, observedAt: stamp()});
        } catch { /* not JSON: not an event */ }
      });
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
  }, {label: LABEL});

  const t0 = Date.now();
  await page.goto(CITY, {waitUntil: 'domcontentloaded'});
  await page.fill('#token', TOKEN);
  await page.click('#connect');
  await page.waitForFunction(() => (document.querySelector('#connection')?.className ?? '').includes('online'), null, {timeout: 25000});
  rec({kind: 'start', cityUrl: CITY, note: 'gate-8 window opens'});
  const surface = await page.evaluate(() => {
    const s = window.utopiaWebSurface;
    return s ? {ref: typeof s.ref === 'function' ? s.ref() : s.ref, label: typeof s.label === 'function' ? s.label() : s.label} : null;
  });
  const openSeq = Math.max(0, ...((await api('events')).json?.events ?? []).map((e) => e.seq ?? 0));
  rec({kind: 'resync', maxSeq: openSeq, observedAt: Date.now(), source: 'server'});
  say(`surface=${JSON.stringify(surface)}  window opens at seq ${openSeq}; DEADLINE ${new Date(t0 + MINUTES * 60000).toISOString()}`);

  const step = async (label, fn, waitMs) => {
    say(`--- ${label}`);
    const r = await fn();
    say(`    ${JSON.stringify(r).slice(0, 240)}`);
    generated.push({label, at: new Date().toISOString(), result: r});
    if (waitMs) await sleep(waitMs);
    return r;
  };

  // 1. UNTARGETED task (gate 7 inside this window).
  await step('untargeted task (no strict target)', async () => {
    const t = (await api('tasks', {type: 'CHECKPOINT_DEMO'})).json;
    taskUntargeted = t?.id ?? null;
    return {taskId: taskUntargeted};
  }, 6000);

  // 2. STRICT task at the other host.
  await step(`strict task targeted at ${OTHER}`, async () => {
    const a = (await api('actions', {route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO',
      input: {targetDeviceRef: OTHER}, idempotencyKey: `mech-gate8-strict-${Date.now()}`})).json?.action;
    taskTargeted = a?.backendRef?.taskId ?? null;
    return {taskId: taskTargeted, status: a?.status, error: a?.error ?? null, targetStateAtCreation: null};
  }, 8000);

  // 3. NODE OFFLINE / ONLINE of THIS host's worker (step 5.3's non-task event).
  await step(`take ${SELF} away, then bring it back`, async () => {
    const beforeSeq = Math.max(0, ...((await api('events')).json?.events ?? []).map((e) => e.seq ?? 0));
    setControl('down');
    for (let i = 0; i < 45 && await nodeOnline(SELF); i++) await sleep(1000);
    let ev = (await api('events')).json?.events ?? [];
    offlineSeq = ev.find((e) => e.type === 'NODE_OFFLINE' && e.payload?.nodeId === SELF && e.seq > beforeSeq)?.seq ?? null;
    // A strict task aimed at the device that is away, created while it is away: gate 6's case, inside the window.
    const a = (await api('actions', {route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO',
      input: {targetDeviceRef: SELF}, idempotencyKey: `mech-gate8-away-${Date.now()}`})).json?.action;
    const awayTask = a?.backendRef?.taskId ?? null;
    await sleep(4000);
    setControl('up');
    for (let i = 0; i < 60 && !(await nodeOnline(SELF)); i++) await sleep(1000);
    ev = (await api('events')).json?.events ?? [];
    onlineSeq = ev.find((e) => e.type === 'NODE_ONLINE' && e.payload?.nodeId === SELF && e.seq > beforeSeq)?.seq ?? null;
    restored = await nodeOnline(SELF);
    return {offlineSeq, onlineSeq, awayTask, restored};
  }, 3000);

  // 4. Hold the stream open for the rest of the window, so the other two surfaces have room to overlap.
  const deadline = t0 + MINUTES * 60000;
  say(`--- holding the surface open until ${new Date(deadline).toISOString()}`);
  while (Date.now() < deadline) {
    await sleep(15000);
    const left = Math.round((deadline - Date.now()) / 1000);
    if (left > 0) say(`    ${left}s left`);
  }

  const observed = await page.evaluate(() => window.__obs ?? []);
  for (const o of observed) rec(o);
  const finalSeq = Math.max(0, ...((await api('events')).json?.events ?? []).map((e) => e.seq ?? 0));
  rec({kind: 'stop', eventsObserved: observed.filter((o) => o.kind === 'event').length, serverMaxSeq: finalSeq});
  flush();

  // The offset estimate uses EVERY event the surface saw, not only the generated ones: the offset is a property
  // of the two hosts and more samples can only tighten the minimum-delay estimate.
  const pairs = observed.filter((o) => o.kind === 'event' && o.seq != null && o.serverAt)
    .map((o) => ({seq: o.seq, raw: o.observedAt - Date.parse(o.serverAt)})).filter((p) => Number.isFinite(p.raw));
  const offset = pairs.length ? Math.min(...pairs.map((p) => p.raw)) : null;
  say(`records ${records.length}; ${observed.filter((o) => o.kind === 'event').length} event frames; offset estimate ${offset}ms`);

  writeFileSync(OUT_JSON, JSON.stringify({
    instrument: 'mech-mesh301-observe-window/1', surface: LABEL, city: CITY,
    cityId: before.json?.cityId ?? null, surfaceIdentity: surface,
    windowOpenedAt: new Date(t0).toISOString(), windowClosedAt: new Date().toISOString(),
    windowSeconds: Math.round((Date.now() - t0) / 1000),
    seqAtOpen: openSeq, seqAtClose: finalSeq,
    generated, nodeTransition: {offlineSeq, onlineSeq, self: SELF, restored},
    eventFramesObserved: observed.filter((o) => o.kind === 'event').length,
    clockOffsetEstimateMs: offset,
    note: 'one surface\'s receipt; gate 8 needs this row beside Alien Web and Android over an overlapping range',
    jsonl: OUT_JSONL, finishedAt: new Date().toISOString(),
  }, null, 2));
  say(`receipt: ${OUT_JSON}`);
} catch (e) {
  say(`ABORTED: ${e.message}`);
  try { rec({kind: 'stop', aborted: e.message}); flush(); } catch {}
  process.exitCode = 1;
} finally {
  if (!restored || !(await nodeOnline(SELF).catch(() => false))) {
    say('SAFETY NET: bringing this host\'s worker back up');
    try { setControl('up'); await sleep(12000); say(`online=${await nodeOnline(SELF)}`); } catch (e) { say(`restore failed: ${e.message}`); }
  }
  if (browser) await browser.close().catch(() => {});
}
