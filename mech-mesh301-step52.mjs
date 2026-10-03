// MESH-301 step 5.2 -- MECH control surface -> ALIEN worker, strict-targeted, produced by the MECH host.
//
// WHAT MESH-301 ASKS FOR HERE, verbatim from the workbook:
//   Step 5.2  "Mech control surface -> Alien worker"
//   Step 5.3  pick TASK_CREATED / TASK_STARTED / TASK_COMPLETED among the observed events
//   Step 5.4  record this surface's observed-at per canonical server seq
// The Alien record (RECORD_STEP5_CROSS_HOST_STRICT_TARGET_AND_NEGATIVE_CONTROLS.md, section 5) states the
// remaining gap in exactly these words: "One direction only. Alien control surface -> Mech worker is done.
// Mech control surface -> Alien worker is not, and only the Mech host can produce it."
//
// WHY A BROWSER AND NOT A POST. The workbook's allowed-change boundary 2 is "the minimal interaction by
// which Web / Android issue a strict-target safe task". A script that POSTs the Action route proves the
// ROUTE works; it does not prove the SURFACE can issue the instruction. This drives the real affordance the
// product ships - the `#run-target` selector built from the City's own node list, beside the existing `#run`
// button - so the evidence is about the surface a user actually has.
//
// WHY NOT ALIEN'S SCRIPT. scripts/mesh301-web-surface.mjs is the development host's instrument, and it was
// used for the Alien->Mech direction. Independent review requires my own instrument (workbook: "用你自己的
// 仪器重建...不得只用开发主机的脚本"), so this is written from the contract rather than copied. It DOES emit
// the same JSONL record vocabulary, because that is interop with the shared merge, not dependence on it.
//
// TWO THINGS THIS FILE REFUSES TO DO:
//   * it never prints the token, and never writes it to a receipt;
//   * it never converts a raw (surface observed-at - server timestamp) difference into a latency. The two
//     hosts' clocks differ; that difference is a clock, and calling it latency would be a fabricated number.
//     Only the offset-corrected figures are reported as latencies, and the correction is stated as an estimate.
//
// USAGE
//   CITY_URL=http://172.31.3.110:4391 CITY_TOKEN=... node mech-mesh301-step52.mjs
import {chromium} from 'playwright';
import {writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const CITY = (process.env.MESH_URL || process.env.CITY_URL || 'http://172.31.3.110:4391').replace(/\/$/, '');
const TOKEN = process.env.CITY_TOKEN || '';
const TARGET = process.env.MESH_TARGET || 'Alien-Win';
const SELF = process.env.MESH_SELF || 'Mech-Win';
const LABEL = process.env.MECH_WEB_LABEL || 'Mech-Win-Web';
const ROOT = process.cwd();
const EVIDENCE = `${ROOT}/evidence/raw/mission-book/MESH-301/review-by-mech`;
const OUT_JSONL = `${EVIDENCE}/mech-web-strict-target.jsonl`;
const OUT_JSON = `${EVIDENCE}/mech-web-strict-target.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(m);
if (!TOKEN) { console.error('CITY_TOKEN is required (never passed on a command line, never printed)'); process.exit(2); }

const api = async (path, body) => {
  const r = await fetch(`${CITY}/api/v0/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)});
  return {status: r.status, json: await r.json().catch(() => null)};
};

const head = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(); } catch { return null; } })();

// ------------------------------------------------------------------ observation receipt (merge vocabulary)
const records = [];
const rec = (r) => records.push({surface: LABEL, at: new Date().toISOString(), ...r});
const flush = () => {
  records.sort((a, b) => (a.observedAt ?? Date.parse(a.at)) - (b.observedAt ?? Date.parse(b.at)));
  writeFileSync(OUT_JSONL, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
};

const findings = [];
const notEstablished = [];
let browser = null;

try {
  mkdirSync(EVIDENCE, {recursive: true});
  say('=== MESH-301 step 5.2 -- Mech control surface -> Alien worker (strict target) ===');
  say(`city   : ${CITY}   (token out of band, never printed)`);
  say(`surface: label "${LABEL}" on the MECH host;  target "${TARGET}";  self "${SELF}"`);
  say(`local head under measurement: ${head}`);

  const cityBefore = await api('city');
  const cityId = cityBefore.json?.cityId ?? null;
  const nodesBefore = (cityBefore.json?.nodes ?? []).map((n) => `${n.id}:${n.online}`).join(', ');
  const surfacesBefore = (cityBefore.json?.controlSurfaces ?? []).map((s) => `${s.clientLabel}<${s.clientRef}>`).join(', ');
  say(`cityId=${cityId}`);
  say(`nodes BEFORE           : ${nodesBefore}`);
  say(`controlSurfaces BEFORE : ${surfacesBefore || '(none)'}`);
  if (!(cityBefore.json?.nodes ?? []).some((n) => n.id === TARGET && n.online)) {
    // A strict target that is away is a legitimate state (the task waits) but it is NOT the measurement this
    // run is for, and silently producing a "waited" receipt would look like a completed step 5.2.
    notEstablished.push(`${TARGET} was not ONLINE at the start of this run, so this receipt cannot show a strict-target EXECUTION`);
  }

  browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
  const context = await browser.newContext();
  const page = await context.newPage();

  // Identity and observer go in BEFORE any app code runs.
  // The label MUST be set here: the surface declares clientRef/clientLabel in the stream handshake at connect
  // time, so renaming after connecting does not re-register it (an earlier run of mine registered as the
  // default "Web - Win32" for exactly this reason).
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
        } catch { /* a frame that is not JSON is not an event */ }
      });
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = Native[k];
  }, {label: LABEL});

  rec({kind: 'start', cityUrl: CITY});
  await page.goto(CITY, {waitUntil: 'domcontentloaded'});
  await page.fill('#token', TOKEN);
  await page.click('#connect');
  // Locale-independent readiness: the UI localises the WORD but `status()` always sets this className.
  await page.waitForFunction(() => (document.querySelector('#connection')?.className ?? '').includes('online'), null, {timeout: 25000});
  say('  the Mech Web surface is ONLINE against the canonical City');

  const identity = await page.evaluate(() => {
    const s = window.utopiaWebSurface;
    if (!s) return {ok: false, reason: 'window.utopiaWebSurface absent'};
    return {ok: true, ref: typeof s.ref === 'function' ? s.ref() : s.ref, label: typeof s.label === 'function' ? s.label() : s.label};
  });
  say(`  surface identity: ${JSON.stringify(identity)}`);

  // The affordance itself is evidence: if the surface does not offer the device, step 5.2 is not performable
  // from the surface at all, and saying so is more useful than POSTing around it.
  const options = await page.$$eval('#run-target option', (els) => els.map((e) => ({value: e.value, text: e.textContent.trim()})));
  say(`  the surface's target selector offers: ${JSON.stringify(options)}`);
  if (!options.some((o) => o.value === TARGET)) {
    findings.push({check: 'the surface offers the target device', verdict: 'FAIL', detail: `it offers ${options.map((o) => o.value || '(any)').join(', ')}`});
    throw new Error(`the surface does not offer ${TARGET}`);
  }
  findings.push({check: 'the surface offers the target device', verdict: 'PASS', detail: options.map((o) => o.value || '(any)').join(', ')});

  const maxSeqBefore = Math.max(0, ...((await api('events')).json?.events ?? []).map((e) => e.seq ?? 0));
  // The task set BEFORE the instruction, so "which task did MY press create" is answered by difference rather
  // than by a guess. My first attempt looked for the target inside `TASK_CREATED.payload.targetDeviceRef` and
  // found nothing: that event's payload is `{}` because the target is a property of the TASK, not of the
  // creation event. The instruction had in fact run (seq 326-332, completed on Alien-Win); the instrument was
  // what failed, and it aborted a successful run with a message that would have read as a product fault.
  const tasksBefore = new Set(((await api('tasks')).json?.tasks ?? []).map((t) => t.id));
  rec({kind: 'resync', maxSeq: maxSeqBefore, observedAt: Date.now(), source: 'server'});
  say(`  canonical baseline seq before the instruction: ${maxSeqBefore}; tasks known: ${tasksBefore.size}`);

  // ---- THE INSTRUCTION, issued through the surface's own affordance ---------------------------------------
  await page.selectOption('#run-target', TARGET);
  const chosen = await page.$eval('#run-target', (e) => e.value);
  rec({kind: 'instruction', target: chosen, observedAt: Date.now()});
  const pressedAt = Date.now();
  await page.click('#run');
  say(`  pressed Run on the surface with target="${chosen}" at ${new Date(pressedAt).toISOString()}`);

  // ---- canonical truth: find the task this created and follow it to a terminal state ----------------------
  let taskId = null;
  for (let i = 0; i < 40 && !taskId; i++) {
    const list = (await api('tasks')).json?.tasks ?? [];
    const fresh = list.find((t) => !tasksBefore.has(t.id) && t.targetDeviceRef === TARGET);
    if (fresh) taskId = fresh.id;
    else await sleep(500);
  }
  if (!taskId) throw new Error(`no NEW task strictly targeted at ${TARGET} appeared in canonical truth after the surface pressed Run`);

  const uiError = await page.$eval('#error', (e) => e.textContent.trim()).catch(() => '');
  say(`  canonical task: ${taskId}   (surface #error element: ${uiError ? JSON.stringify(uiError) : 'empty'})`);

  let task = null;
  for (let i = 0; i < 120; i++) {
    task = (await api(`tasks/${encodeURIComponent(taskId)}`)).json;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task?.state)) break;
    await sleep(500);
  }
  say(`  task settled: state=${task?.state} assignedNodeId=${task?.assignedNodeId} targetDeviceRef=${task?.targetDeviceRef}`);

  const events = (await api('events')).json?.events ?? [];
  const taskEvents = events.filter((e) => e.taskId === taskId);
  rec({kind: 'resync', maxSeq: Math.max(0, ...events.map((e) => e.seq ?? 0)), observedAt: Date.now(), source: 'server'});

  // The Action that carries the user-level intent. Step 3 requires the intent to live in canonical Action
  // truth, so it is read back rather than assumed from the task row.
  const actions = (await api('actions')).json?.actions ?? [];
  const action = actions.find((a) => a?.backendRef?.taskId === taskId) ?? null;

  // ---- convergence, measured from the SURFACE's own observations ------------------------------------------
  await sleep(2500);
  const observed = await page.evaluate(() => window.__obs ?? []);
  for (const o of observed) rec(o);
  const seqObserved = new Map();
  for (const o of observed) if (o.kind === 'event' && o.seq != null && !seqObserved.has(o.seq)) seqObserved.set(o.seq, o.observedAt);
  say(`  the surface received ${observed.filter((o) => o.kind === 'event').length} event frame(s); ${seqObserved.size} distinct seq(s)`);

  // Everything the surface observed (not only this task) bounds the clock offset, because the offset is a
  // property of the two hosts and more samples can only tighten the minimum-delay estimate.
  const allRaw = [];
  for (const o of observed) {
    if (o.kind !== 'event' || o.seq == null || !o.serverAt) continue;
    const serverMs = Date.parse(o.serverAt);
    if (Number.isFinite(serverMs)) allRaw.push({seq: o.seq, raw: o.observedAt - serverMs});
  }
  const offset = allRaw.length ? Math.min(...allRaw.map((r) => r.raw)) : null;
  say(`  clock offset estimated by minimum delay: ${offset}ms (this host's clock minus the City's)`);

  const taskSeqRows = taskEvents
    .filter((e) => typeof e.seq === 'number')
    .sort((a, b) => a.seq - b.seq)
    .map((e) => {
      const serverMs = Date.parse(e.timestamp);
      const seen = seqObserved.get(e.seq);
      const raw = seen === undefined || !Number.isFinite(serverMs) ? null : seen - serverMs;
      return {
        seq: e.seq, type: e.type,
        serverTimestamp: e.timestamp ?? null,
        observedAt: seen === undefined ? null : new Date(seen).toISOString(),
        rawDeltaMs: raw,
        offsetFreeMs: raw === null || offset === null ? null : raw - offset,
      };
    });
  say('  per-seq, for THIS task (offset-free figures are the latencies; the raw column is a clock difference):');
  for (const r of taskSeqRows) {
    say(`    seq=${r.seq} ${r.type}  server=${r.serverTimestamp ?? '-'}  observed=${r.observedAt ?? 'NOT OBSERVED'}  raw=${r.rawDeltaMs ?? 'n/a'}  offset-free=${r.offsetFreeMs === null ? 'n/a' : r.offsetFreeMs.toFixed(1) + 'ms'}`);
  }
  const corrected = taskSeqRows.map((r) => r.offsetFreeMs).filter((v) => v !== null);
  const upperBound = corrected.length ? Math.max(...corrected) : null;
  const jitter = corrected.length ? Math.max(...corrected) - Math.min(...corrected) : null;
  const missed = taskSeqRows.filter((r) => r.observedAt === null).map((r) => r.seq);
  say(`  => upper bound on this surface's convergence for this task: ${upperBound === null ? 'unmeasurable' : upperBound.toFixed(1) + 'ms'}   jitter ${jitter === null ? 'n/a' : jitter.toFixed(1) + 'ms'}`);

  // ---- the checks that decide PASS/FAIL, each stated as a check rather than a narrative -------------------
  const assigned = taskEvents.find((e) => e.type === 'TASK_ASSIGNED');
  findings.push({
    check: `the strict target is persisted on the canonical task`,
    verdict: task?.targetDeviceRef === TARGET ? 'PASS' : 'FAIL',
    detail: `task.targetDeviceRef=${task?.targetDeviceRef ?? null} targetStateAtCreation=${task?.targetStateAtCreation ?? null}`,
  });
  findings.push({
    check: `the user-level intent is visible in canonical Action truth`,
    verdict: action?.provenance?.targetDeviceRef === TARGET || action?.backendRef?.targetDeviceRef === TARGET ? 'PASS' : 'FAIL',
    detail: action ? `actionId=${action.actionId} route=${action.route} status=${action.status} backendRef.targetDeviceRef=${action.backendRef?.targetDeviceRef ?? null} provenance.targetDeviceRef=${action.provenance?.targetDeviceRef ?? null}` : 'no Action carrying this taskId was found',
  });
  findings.push({
    check: `ONLY the named device claimed it (${TARGET})`,
    verdict: task?.assignedNodeId === TARGET ? 'PASS' : 'FAIL',
    detail: `TASK_ASSIGNED assignedNodeId=${assigned?.payload?.nodeId ?? task?.assignedNodeId ?? null}; this surface's own worker is ${SELF}, which must NOT appear`,
  });
  findings.push({
    check: `the run reached a real terminal state with a result`,
    verdict: task?.state === 'COMPLETED' && Boolean(task?.lastCheckpoint?.sha256 ?? task?.resultRef?.digest) ? 'PASS' : 'FAIL',
    detail: `state=${task?.state} progress=${task?.progress} result=${JSON.stringify(task?.lastCheckpoint ?? task?.resultRef ?? null)}`,
  });
  findings.push({
    check: `the surface observed every canonical seq of its own instruction`,
    verdict: missed.length === 0 && taskSeqRows.length > 0 ? 'PASS' : 'FAIL',
    detail: missed.length === 0 ? `${taskSeqRows.length} seq(s) observed` : `never observed ${missed.join(', ')}`,
  });
  findings.push({
    check: `bounded convergence against the 5s workbook window`,
    verdict: upperBound !== null && upperBound <= 5000 ? 'PASS' : 'FAIL',
    detail: `offset-free upper bound ${upperBound === null ? 'unmeasurable' : upperBound.toFixed(1) + 'ms'} (offset estimate ${offset}ms)`,
  });

  // ---- one independent negative control, chosen because MESH-301's audit is ABOUT this confusion ----------
  // A control surface is not a worker node. The value below is this surface's OWN label, which is a plausible
  // thing for a user (or a bug) to name as a target, and it must be refused as an unknown DEVICE rather than
  // silently accepted because the label is visible in the City.
  const misdirected = await page.evaluate(async ({city, token, badTarget}) => {
    const r = await fetch(`${city}/api/v0/actions`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'},
      body: JSON.stringify({route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input: {targetDeviceRef: badTarget}, idempotencyKey: `mech-neg-surface-as-device-${Date.now()}`}),
      signal: AbortSignal.timeout(10000)});
    const body = await r.json().catch(() => null);
    return {httpStatus: r.status, code: body?.action?.error?.code ?? null, status: body?.action?.status ?? null, message: body?.action?.error?.message ?? null, taskId: body?.action?.backendRef?.taskId ?? null};
  }, {city: CITY, token: TOKEN, badTarget: LABEL});
  say(`  negative control (a control SURFACE named as a target DEVICE): ${JSON.stringify(misdirected)}`);
  findings.push({
    check: 'a control surface is refused as a target device (fail-honest, no task created)',
    verdict: misdirected.code === 'TARGET_DEVICE_UNKNOWN' && !misdirected.taskId ? 'PASS' : 'FAIL',
    detail: JSON.stringify(misdirected),
  });

  rec({kind: 'stop', eventsObserved: observed.filter((o) => o.kind === 'event').length, serverMaxSeq: Math.max(0, ...events.map((e) => e.seq ?? 0))});
  flush();

  notEstablished.push('the OTHER two surfaces\' receipts for this window: this receipt is Mech Web only, and a three-surface table needs all three, each produced by its own surface');
  notEstablished.push('that the mechanism is correct for devices this run did not use: an offline-target wait was not exercised here (both nodes were online), and Alien recorded that case separately');
  notEstablished.push('Formal Review: this run is endpoint-A evidence, not the review verdict on the head');

  const verdict = findings.every((f) => f.verdict === 'PASS') ? 'PASS' : 'FAIL';
  say('');
  say('=== CHECKS ===');
  for (const f of findings) say(`  ${f.verdict}  ${f.check}  -- ${f.detail}`);
  say(`VERDICT: ${verdict}`);
  say('');
  say('=== WHAT THIS DOES NOT ESTABLISH ===');
  for (const n of notEstablished) say(`  - ${n}`);

  writeFileSync(OUT_JSON, JSON.stringify({
    instrument: 'mech-mesh301-step52/1',
    head, city: CITY, cityId, surfaceLabel: LABEL, self: SELF, target: TARGET,
    surfaceIdentity: identity, selectorOptions: options, chosenTarget: chosen, pressedAt: new Date(pressedAt).toISOString(),
    controlSurfacesBefore: cityBefore.json?.controlSurfaces ?? null,
    taskId, task: {state: task?.state ?? null, assignedNodeId: task?.assignedNodeId ?? null, targetDeviceRef: task?.targetDeviceRef ?? null, targetStateAtCreation: task?.targetStateAtCreation ?? null, progress: task?.progress ?? null, result: task?.lastCheckpoint ?? task?.resultRef ?? null},
    action: action ? {actionId: action.actionId, route: action.route, status: action.status, backendRef: action.backendRef ?? null, provenance: action.provenance ?? null} : null,
    taskEvents: taskEvents.map((e) => ({seq: e.seq, type: e.type, actor: e.actor, timestamp: e.timestamp, payload: e.payload})),
    convergence: {clockOffsetMs: offset, perSeq: taskSeqRows, upperBoundMs: upperBound, jitterMs: jitter, missedSeqs: missed, note: 'only the offset-free column is a latency; the raw difference is dominated by the inter-host clock offset'},
    negativeControlSurfaceAsDevice: misdirected,
    findings, verdict, notEstablished,
    jsonl: OUT_JSONL,
    finishedAt: new Date().toISOString(),
  }, null, 2));
  say(`receipt: ${OUT_JSON}`);
  say(`observation receipt (merge vocabulary): ${OUT_JSONL}`);
} catch (e) {
  say(`ABORTED: ${e.message}`);
  try { rec({kind: 'stop', aborted: e.message}); flush(); } catch {}
  // A failed run must leave a receipt too. An instrument that only writes evidence when it succeeds cannot
  // be told apart from one that was never run, and my first attempt here failed after a real product run.
  try {
    writeFileSync(OUT_JSON, JSON.stringify({
      instrument: 'mech-mesh301-step52/1', head, city: CITY, surfaceLabel: LABEL, self: SELF, target: TARGET,
      aborted: e.message, findings, notEstablished, jsonl: OUT_JSONL, finishedAt: new Date().toISOString(),
    }, null, 2));
    say(`receipt (failed run): ${OUT_JSON}`);
  } catch {}
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
