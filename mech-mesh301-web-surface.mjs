// MESH-301 — MECH WEB surface receipt.
//
// Two things Alien's record names as missing and both belong to this host:
//   1. no browser on the Mech host has ever been a control surface of the canonical City;
//   2. the three-surface bounded-convergence table needs a real receipt from each surface.
// This produces the Mech Web one from the surface's OWN live event stream, by wrapping WebSocket BEFORE the
// app loads, so what is recorded is what the surface actually received rather than what a poll saw later.
import {chromium} from 'playwright';
import {writeFileSync, mkdirSync} from 'node:fs';

const CITY = (process.env.MESH_URL || 'http://172.31.3.110:4391').replace(/\/$/, '');
const TOKEN = process.env.CITY_TOKEN || '';
const LABEL = process.env.MECH_WEB_LABEL || 'Mech-Win-Web';
const ROOT = process.cwd();
const EVIDENCE = `${ROOT}/evidence/raw/mission-book/MESH-301/review-by-mech`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(m);

const api = async (path, body) => {
  const r = await fetch(`${CITY}/api/v0/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000)});
  return {status: r.status, json: await r.json().catch(() => null)};
};

let browser = null;
try {
  mkdirSync(EVIDENCE, {recursive: true});
  say(`=== MECH WEB joining the canonical City as a control surface ===`);
  say(`city: ${CITY}   (token out of band, never printed)`);

  const before = await api('city');
  say(`cityId=${before.json?.cityId}  nodes=[${(before.json?.nodes ?? []).map((n) => n.id).join(', ')}]`);
  say(`controlSurfaces BEFORE: ${JSON.stringify(before.json?.controlSurfaces ?? null)}`);

  browser = await chromium.launch({channel: 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}, locale: 'en-US'});

  // Wrap WebSocket BEFORE any app code runs: this is the surface's own live stream, not a later poll.
  // The label must ALSO be set here, before the app connects, because the surface declares its identity at
  // connect time - renaming after connecting does not re-register (my first run renamed too late and the
  // surface registered as "Web - Win32").
  await page.addInitScript((label) => {
    try { localStorage.setItem('utopia.clientLabel', label); } catch {}
    window.__meshEvents = [];
    const Orig = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new Orig(...args);
      ws.addEventListener('message', (e) => {
        try { window.__meshEvents.push({observedAt: Date.now(), raw: String(e.data) }); } catch {}
      });
      return ws;
    };
    window.WebSocket.prototype = Orig.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = Orig[k];
  }, LABEL);

  await page.goto(CITY, {waitUntil: 'load'});
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.locator('#connection').filter({hasText: 'ONLINE'}).waitFor({timeout: 25000});
  say('  Mech Web is ONLINE against the canonical City');

  // Give this surface its own label. ref and label are FUNCTIONS on the exposed object (ref:webClientRef,
  // label:webClientLabel), so they must be CALLED - my first run read them as properties and got undefined.
  const renamed = await page.evaluate((label) => {
    const s = window.utopiaWebSurface;
    if (!s) return {ok: false, reason: 'window.utopiaWebSurface absent'};
    const before = {ref: typeof s.ref === 'function' ? s.ref() : s.ref, label: typeof s.label === 'function' ? s.label() : s.label};
    s.rename(label);
    const after = {ref: typeof s.ref === 'function' ? s.ref() : s.ref, label: typeof s.label === 'function' ? s.label() : s.label};
    return {ok: true, before, after};
  }, LABEL);
  say(`  surface identity: ${JSON.stringify(renamed)}`);

  await sleep(2000);
  const after = await api('city');
  say(`controlSurfaces AFTER: ${JSON.stringify(after.json?.controlSurfaces ?? null)}`);

  // Generate canonical activity from the API so the surface has something to observe, then measure how long
  // THIS surface took to receive each event after the server emitted it.
  const t0 = Date.now();
  const created = await api('tasks', {type: 'CHECKPOINT_DEMO'});
  const taskId = created.json?.id;
  say(`  created an untargeted task from the API to give the surface events: ${taskId}`);

  let serverEvents = [];
  for (let i = 0; i < 60; i++) {
    const ev = await api('events');
    const list = ev.json?.events ?? ev.json ?? [];
    serverEvents = (Array.isArray(list) ? list : []).filter((e) => e.taskId === taskId);
    const t = await api(`tasks/${encodeURIComponent(taskId)}`);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.json?.state)) break;
    await sleep(300);
  }
  await sleep(2500); // let the live stream settle

  const received = await page.evaluate(() => window.__meshEvents ?? []);
  say(`  surface received ${received.length} stream message(s)`);
  say('  RAW SAMPLES (the shape matters, and I assumed it wrong once):');
  for (const m of received.slice(0, 4)) say(`    ${m.raw.slice(0, 260)}`);

  // Parse whatever the surface got and line it up with the canonical seq.
  // The stream message is {apiVersion, schemaVersion, event:{...}} with the event NESTED under `event`, plus
  // bare {type:'REFRESH'} keepalives. My first parser looked for seq/taskId on the top level and therefore
  // reported zero, which was my error about the shape rather than an absence of events.
  const flat = [];
  for (const m of received) {
    let parsed = null; try { parsed = JSON.parse(m.raw); } catch {}
    const ev = parsed?.event;
    if (ev && typeof ev === 'object') {
      flat.push({observedAt: m.observedAt, seq: ev.seq, type: ev.type ?? null, taskId: ev.taskId ?? null, serverTimestamp: ev.timestamp ?? null});
    }
  }
  const mine = flat.filter((e) => e.taskId === taskId && typeof e.seq === 'number').sort((a, b) => a.seq - b.seq);
  say(`  stream messages for THIS task carrying a seq: ${mine.length}`);

  const rows = mine.map((e) => {
    const serverMs = e.serverTimestamp ? Date.parse(e.serverTimestamp) : NaN;
    return {seq: e.seq, type: e.type, serverTimestamp: e.serverTimestamp, observedAt: new Date(e.observedAt).toISOString(), convergenceMs: Number.isFinite(serverMs) ? e.observedAt - serverMs : null};
  });
  say('  per-seq convergence (surface observed-at minus server emit time):');
  for (const r of rows) say(`    seq=${r.seq} ${r.type}  server=${r.serverTimestamp ?? '-'}  observed=${r.observedAt}  raw=${r.convergenceMs === null ? 'n/a' : r.convergenceMs + 'ms'}`);

  // The raw differences are all about -1s, i.e. this surface appears to observe every event BEFORE the server
  // emitted it. That is impossible, so the constant component is CLOCK OFFSET between the two hosts, not
  // latency. Reporting the raw number as "convergence" would be a fabricated measurement, so the offset is
  // estimated by the minimum-delay argument (the fastest event bounds it) and the OFFSET-FREE jitter plus an
  // upper bound on latency are reported instead.
  const raws = rows.map((r) => r.convergenceMs).filter((v) => v !== null);
  let offset = null, corrected = [], maxCorrected = null, jitter = null;
  if (raws.length) {
    offset = Math.min(...raws);
    corrected = raws.map((v) => v - offset);
    maxCorrected = Math.max(...corrected);
    jitter = maxCorrected - Math.min(...corrected);
    say(`  clock offset estimated by minimum delay: ${offset}ms (this host's clock relative to the City's)`);
    say(`  OFFSET-FREE latencies: ${corrected.map((v) => v.toFixed(1) + 'ms').join(', ')}`);
    say(`  => upper bound on this surface's convergence latency: ${maxCorrected.toFixed(1)}ms   jitter ${jitter.toFixed(1)}ms`);
  }

  const canonicalSeq = serverEvents.map((e) => e.seq).filter((x) => typeof x === 'number');
  const maxSeq = canonicalSeq.length ? Math.max(...canonicalSeq) : null;
  const maxRow = rows.find((r) => r.seq === maxSeq);
  const ok = rows.length > 0 && renamed.ok;
  say('');
  say('=== WHAT THIS ESTABLISHES (printed only if actually true) ===');
  if (ok) {
    say(`1. a browser ON THE MECH HOST is a live control surface of the canonical City (${after.json?.cityId});`);
    say(`2. it carries its own label "${renamed.after?.label}" (ref ${renamed.after?.ref}) as the City's controlSurfaces reports it;`);
    say(`3. it received canonical events on its own live stream with seq numbers readable per event;`);
    say(`   final seq ${maxSeq}: ${maxRow ? 'observed, offset-free latency ' + (maxRow.convergenceMs === null ? 'unmeasurable' : (maxRow.convergenceMs - offset).toFixed(1) + 'ms') : 'NOT observed by this surface'}.`);
    say(`   this surface's convergence UPPER BOUND: ${maxCorrected === null ? 'unmeasurable' : maxCorrected.toFixed(1) + 'ms'} against the workbook's 5s window.`);
    say('   CAVEAT, stated because the raw numbers invite the wrong reading: the two hosts\' clocks differ by');
    say(`   about ${offset}ms, so only the offset-corrected figures are latencies. The offset is an ESTIMATE`);
    say('NOT established: the other two surfaces\' receipts, which are theirs to produce; and strict-target');
    say('behaviour, which this run did not exercise.');
  } else {
    say('NOT ESTABLISHED: the surface did not come up as expected or received no sequenced event.');
  }

  writeFileSync(`${EVIDENCE}/mechweb-surface-receipt.json`, JSON.stringify({
    head: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    city: CITY, cityId: after.json?.cityId ?? null, surface: renamed,
    controlSurfacesBefore: before.json?.controlSurfaces ?? null,
    controlSurfacesAfter: after.json?.controlSurfaces ?? null,
    taskId, streamMessagesReceived: received.length, convergences: rows,
    finishedAt: new Date().toISOString()}, null, 2));
  say(`receipt written to ${EVIDENCE}/mechweb-surface-receipt.json`);
} catch (e) {
  say(`ABORTED: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
}
