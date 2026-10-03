// MESH-301 FORMAL REVIEW - the reviewer REBUILDS the three-surface scenario with its OWN instruments.
//
// The workbook's review section: "用你自己的仪器重建三端同 City 的场景（不得只用开发主机的脚本）". The Android
// device is the development host's to drive, so the third surface cannot be mine; what CAN be mine is the whole
// mechanism: three surfaces of my own, opened at once against the canonical City, one of them the product's real
// browser UI, each writing its own observation receipt, and convergence computed by MY arithmetic rather than by
// the shared merge (which is then run beside it as an interop cross-check, not as the source of the verdict).
//
// This is deliberately NOT a claim about Android. It is a claim that the reviewer, on its own host, with its own
// code, can produce three simultaneous surfaces, a dense canonical window, and a bounded-convergence verdict.
import {chromium} from 'playwright';
import {WebSocket} from 'ws';
import {writeFileSync, mkdirSync} from 'node:fs';

const CITY = (process.env.CITY_URL || 'http://172.31.3.110:4391').replace(/\/$/, '');
const TOKEN = process.env.CITY_TOKEN || '';
const WS_BASE = CITY.replace(/^http/, 'ws');
const H = {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const EVIDENCE = `${process.cwd()}/evidence/raw/mission-book/MESH-301/review-by-mech`;
const WINDOW_MS = 5000;
const OBSERVE_MS = 75000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const TAG = Date.now().toString(36).slice(-5);

const api = async (path, body) => {
  const r = await fetch(`${CITY}/api/v0/${path}`, {method: body === undefined ? 'GET' : 'POST', headers: {...H, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)});
  return {status: r.status, json: await r.json().catch(() => null)};
};
const maxSeq = async () => Math.max(0, ...((await api('events')).json?.events ?? []).map((e) => e.seq ?? 0));

if (!TOKEN) { console.error('CITY_TOKEN required'); process.exit(2); }
mkdirSync(EVIDENCE, {recursive: true});

// ---------------------------------------------------------------- three surfaces
const surfaces = [
  {name: `Mech-Scenario-Web-${TAG}`, kind: 'browser', records: []},
  {name: `Mech-Scenario-Probe1-${TAG}`, kind: 'probe', records: []},
  {name: `Mech-Scenario-Probe2-${TAG}`, kind: 'probe', records: []},
];
const rec = (s, r) => s.records.push({surface: s.name, at: new Date().toISOString(), ...r});

let browser = null;
const sockets = [];
try {
  const before = (await api('city')).json;
  say(`city ${before?.cityId}  nodes=${JSON.stringify((before?.nodes ?? []).map((n) => n.id + ':' + n.online))}`);

  // surface 1 - the product's own browser UI, labelled before load so the stream handshake declares it
  browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  await page.addInitScript(({label}) => {
    try { localStorage.setItem('utopia.clientLabel', label); localStorage.setItem('utopia.clientRef', 'web-' + Math.random().toString(36).slice(2, 10)); } catch {}
    window.__obs = [];
    const Native = window.WebSocket; const stamp = () => Date.now();
    window.WebSocket = function (...a) {
      const ws = new Native(...a);
      ws.addEventListener('open', () => window.__obs.push({kind: 'open', observedAt: stamp()}));
      ws.addEventListener('close', () => window.__obs.push({kind: 'stale', observedAt: stamp()}));
      ws.addEventListener('message', (ev) => { try { const m = JSON.parse(ev.data);
        if (m && m.event) window.__obs.push({kind: 'event', seq: m.event.seq ?? null, type: m.event.type ?? null, taskId: m.event.taskId ?? null, serverAt: m.event.timestamp ?? null, observedAt: stamp()});
      } catch {} });
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
  }, {label: surfaces[0].name});
  await page.goto(CITY, {waitUntil: 'domcontentloaded'});
  await page.fill('#token', TOKEN);
  await page.click('#connect');
  await page.waitForFunction(() => (document.querySelector('#connection')?.className ?? '').includes('online'), null, {timeout: 25000});
  say(`browser surface online as "${surfaces[0].name}"`);

  // surfaces 2 and 3 - my own stream probes, distinct clientRefs.
  // The ref must come from the INDEX, not from a character of the name: my first version took `name.slice(-1)`,
  // which is the last character of the random TAG rather than the probe number, so BOTH probes connected with the
  // SAME clientRef and the City listed only two of my three surfaces. That is defect D-R1 making my own scenario
  // look wrong, and it is exactly the kind of self-inflicted result that must not be reported as a product
  // finding. The check `mineListedOfThree` below exists to catch precisely this.
  for (const [i, s] of surfaces.slice(1).entries()) {
    const ws = new WebSocket(`${WS_BASE}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=probe-${TAG}-${i + 1}&clientLabel=${encodeURIComponent(s.name)}`, {headers: H});
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('open timeout')), 8000); });
    ws.on('message', (data) => { try { const m = JSON.parse(String(data));
      if (m && m.event) rec(s, {kind: 'event', seq: m.event.seq ?? null, type: m.event.type ?? null, taskId: m.event.taskId ?? null, serverAt: m.event.timestamp ?? null, observedAt: Date.now()});
      else if (m && m.type) rec(s, {kind: 'control', messageType: m.type, observedAt: Date.now()});
    } catch {} });
    sockets.push(ws);
    say(`probe surface online as "${s.name}"`);
  }

  const openSeq = await maxSeq();
  // The boundary record matters and my first version omitted it: the shared merge establishes WHEN a surface
  // started watching from the receipt's `resync` record, not from its first event. Without it the merge treated
  // every canonical seq from 1 to 1376 as "online surface never observed seq N" and returned FAILED with 4128
  // failures against three surfaces that had in fact missed nothing. My own arithmetic did not need the record,
  // which is exactly why it was missing - a receipt that only satisfies its author's reader is not a receipt.
  for (const s of surfaces) { rec(s, {kind: 'start', cityUrl: CITY, note: 'scenario rebuild by the reviewer'}); rec(s, {kind: 'resync', maxSeq: openSeq, observedAt: Date.now(), source: 'server'}); }
  const cityNow = (await api('city')).json;
  const listed = [...new Map((cityNow.controlSurfaces ?? []).map((c) => [c.clientRef, c])).values()];
  say(`controlSurfaces (de-duplicated by ref) at the start: ${JSON.stringify(listed.map((c) => c.clientLabel))}`);
  const mineListed = surfaces.filter((s) => listed.some((c) => c.clientLabel === s.name)).length;
  say(`of those, mine: ${mineListed} of 3`);

  // ---------------------------------------------------------------- generate a dense canonical window
  const generated = [];
  const gen = async (label, fn) => { const r = await fn(); generated.push({label, at: new Date().toISOString(), result: r}); say(`${label}: ${JSON.stringify(r)}`); };
  await gen('untargeted task', async () => (await api('tasks', {type: 'CHECKPOINT_DEMO'})).json?.id ?? null);
  await sleep(1500);
  await gen('strict task -> Alien-Win', async () => {
    const a = (await api('actions', {route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input: {targetDeviceRef: 'Alien-Win'}, idempotencyKey: `mech-scenario-${TAG}-1`})).json?.action;
    return {taskId: a?.backendRef?.taskId ?? null, status: a?.status ?? null};
  });
  await sleep(1500);
  await gen('strict task -> Mech-Win', async () => {
    const a = (await api('actions', {route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input: {targetDeviceRef: 'Mech-Win'}, idempotencyKey: `mech-scenario-${TAG}-2`})).json?.action;
    return {taskId: a?.backendRef?.taskId ?? null, status: a?.status ?? null};
  });

  say(`observing for ${OBSERVE_MS / 1000}s while the three surfaces stream...`);
  const deadline = Date.now() + OBSERVE_MS;
  while (Date.now() < deadline) { await sleep(5000); }
  const closeSeq = await maxSeq();

  // collect from the browser last, and stamp its stop
  const observed = await page.evaluate(() => window.__obs ?? []);
  for (const o of observed) rec(surfaces[0], o);
  for (const s of surfaces) rec(s, {kind: 'stop', eventsObserved: s.records.filter((r) => r.kind === 'event').length, serverMaxSeq: closeSeq});
  for (const ws of sockets) ws.close();

  const files = surfaces.map((s) => `${EVIDENCE}/mech-scenario-${s.name}.jsonl`);
  surfaces.forEach((s, i) => {
    s.records.sort((a, b) => (a.observedAt ?? Date.parse(a.at)) - (b.observedAt ?? Date.parse(b.at)));
    writeFileSync(files[i], `${s.records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  });

  // ---------------------------------------------------------------- MY OWN convergence arithmetic
  const events = (await api('events')).json?.events ?? [];
  const serverAt = new Map(events.filter((e) => e.seq != null).map((e) => [e.seq, Date.parse(e.timestamp)]));
  const analysis = [];
  for (const s of surfaces) {
    const evs = s.records.filter((r) => r.kind === 'event' && r.seq != null && r.serverAt);
    const raws = evs.map((r) => r.observedAt - Date.parse(r.serverAt)).filter(Number.isFinite);
    const offset = raws.length ? Math.min(...raws) : null;
    const seen = new Map();
    for (const r of evs) if (!seen.has(r.seq)) seen.set(r.seq, r.observedAt);
    const first = Math.min(...seen.keys()), last = Math.max(...seen.keys());
    const lats = [];
    for (const [seq, at] of seen) { const sa = serverAt.get(seq); if (Number.isFinite(sa)) lats.push(at - sa - offset); }
    lats.sort((a, b) => a - b);
    analysis.push({
      surface: s.name, kind: s.kind, eventsObserved: evs.length, distinctSeqs: seen.size,
      seqRange: [first, last], clockOffsetMs: offset,
      latencyMs: lats.length ? {min: lats[0], median: lats[Math.floor(lats.length / 2)], p95: lats[Math.floor(lats.length * 0.95)], max: lats[lats.length - 1]} : null,
      breaches: lats.filter((v) => v > WINDOW_MS).length,
      overWindow: lats.length ? lats[lats.length - 1] > WINDOW_MS : null,
    });
  }
  say('');
  for (const a of analysis) say(`${a.surface}: ${a.distinctSeqs} seqs ${JSON.stringify(a.seqRange)} offset ${a.clockOffsetMs}ms latency ${JSON.stringify(a.latencyMs)} breaches ${a.breaches}`);

  // canonical seqs inside the intersection of the three surfaces' observation ranges
  const lo = Math.max(...analysis.map((a) => a.seqRange[0]));
  const hi = Math.min(...analysis.map((a) => a.seqRange[1]));
  const inCommon = [...serverAt.keys()].filter((s) => s >= lo && s <= hi).sort((a, b) => a - b);
  const perSurfaceMisses = surfaces.map((s, i) => {
    const seen = new Set(s.records.filter((r) => r.kind === 'event' && r.seq != null).map((r) => r.seq));
    return {surface: s.name, missingInCommonRange: inCommon.filter((q) => !seen.has(q))};
  });
  const breached = analysis.filter((a) => a.breaches > 0);
  const totalMissing = perSurfaceMisses.reduce((n, p) => n + p.missingInCommonRange.length, 0);
  const verdict = breached.length === 0 && totalMissing === 0 && inCommon.length > 0 ? 'CONVERGED' : (inCommon.length === 0 ? 'INCOMPLETE' : 'FAILED');
  say(`common seq range ${lo}..${hi} = ${inCommon.length} seqs; missing observations in it: ${totalMissing}; breaches: ${breached.length}`);
  say(`VERDICT (my arithmetic, window ${WINDOW_MS}ms): ${verdict}`);

  writeFileSync(`${EVIDENCE}/mech-scenario-verdict.json`, JSON.stringify({
    instrument: 'mech-mesh301-three-surface-scenario/1', cityId: before?.cityId, openedAtSeq: openSeq, closedAtSeq: closeSeq,
    surfaces: surfaces.map((s) => s.name), files, generated, listedAtStart: listed.map((c) => ({ref: c.clientRef, label: c.clientLabel})), mineListedOfThree: mineListed,
    analysis, commonRange: [lo, hi], commonSeqs: inCommon.length, perSurfaceMisses, verdict,
    computedBy: 'the reviewer\'s own arithmetic in this file, NOT the shared merge',
    finishedAt: new Date().toISOString()}, null, 2));
  say(`verdict receipt: ${EVIDENCE}/mech-scenario-verdict.json`);
  say(`receipts: ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`);
  if (verdict !== 'CONVERGED') process.exitCode = 1;
} catch (e) {
  say(`ABORTED: ${e.message}`);
  process.exitCode = 1;
} finally {
  for (const ws of sockets) { try { ws.close(); } catch {} }
  if (browser) await browser.close().catch(() => {});
}
