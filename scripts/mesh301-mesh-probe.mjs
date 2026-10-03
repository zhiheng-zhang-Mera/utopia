// MESH-301 steps 5 and 6 — the two instruments that belong to no claim.
//
// WHY THIS IS A SEPARATE PROGRAM AND NOT A TEST
//
// The three-end claim is about three machines observing ONE City. A single-process test can assert that a
// gateway emitted events in an order; it cannot witness what a surface on another host saw and when. So this
// is a deployable instrument with two halves that meet in a file:
//
//   observe   run ON a surface's host; writes one JSONL receipt of what THAT surface observed, and when
//   merge     run anywhere; reads N receipts and produces the convergence table and the verdict
//
// The receipts are the evidence. `merge` never invents an observation for a surface that did not report one —
// a surface that stayed silent is reported as MISSING, not as converged, because the whole point of step 5 is
// to stop "the UI looked right" from standing in for "the backend agreed".
//
// WHAT IT MEASURES, AND AGAINST WHAT
//
// Against the canonical server `seq` and the server's own `at` timestamp, not against any device's clock.
// A device clock that is wrong cannot make this instrument pass: the latency it reports is
// `local observed-at` minus `server at`, and both a missing observation and a late one are failures.
//
// THE OFFLINE CASE IS A FIRST-CLASS CASE
//
// Step 5.6 says an offline surface need not update while offline, but must show stale/offline and must
// re-converge on return. `observe` therefore records the socket dropping (`stale`), the socket returning
// (`reconnected`), and — crucially — a `resync` record carrying the highest `seq` the SERVER had when the
// surface asked, so "it re-converged" is evidenced by a server read rather than by a cache the surface happened
// to be holding. `merge` fails a reconnect that produced no resync.
//
// USAGE
//
//   node scripts/mesh301-mesh-probe.mjs observe --surface Alien-Web --out alien.jsonl [--maxMs 600000]
//   node scripts/mesh301-mesh-probe.mjs merge --window 5000 --out convergence.json alien.jsonl mech.jsonl android.jsonl
//   node scripts/mesh301-mesh-probe.mjs negative --target Alien-Win --other Mech-Win [--out negatives.json]
//
// Connection settings come from the environment so a token never reaches a command line, a shell history, a
// screenshot or a receipt: CITY_URL, CITY_TOKEN, CITY_NODE_TOKEN.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flagAll = name => argv.reduce((acc, a, i) => (a === `--${name}` ? [...acc, argv[i + 1]] : acc), []);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

const URL_BASE = (flag('url') ?? process.env.CITY_URL ?? '').replace(/\/$/, '');
const TOKEN = flag('token') ?? process.env.CITY_TOKEN ?? '';
const NODE_TOKEN = flag('nodeToken') ?? process.env.CITY_NODE_TOKEN ?? '';

function apiHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json' };
}

async function control(path, body) {
  const r = await fetch(`${URL_BASE}/api/v0/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: apiHeaders(TOKEN),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function nodeCall(path, body) {
  const r = await fetch(`${URL_BASE}/api/v0/node/${path}`, { method: 'POST', headers: apiHeaders(NODE_TOKEN), body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
}

// ---------------------------------------------------------------------------- observe

// One session is one receipt. An earlier version appended across runs, so a file held the start, resync and
// stale boundaries of TWO sessions interleaved; the merge then took the first session's resync bound and
// reported the second session's ordinary behaviour as convergence failures. Mixing two observation windows
// into one file makes the receipt unreadable rather than merely untidy, so the first record of a run truncates.
const startedFiles = new Set();
function append(file, record) {
  const line = `${JSON.stringify({ ...record, at: record.at ?? now() })}\n`;
  if (!startedFiles.has(file)) { startedFiles.add(file); writeFileSync(file, line); return; }
  appendFileSync(file, line);
}

async function observe() {
  const surface = flag('surface');
  const out = flag('out', `mesh301-${surface ?? 'surface'}.jsonl`);
  const maxMs = Number(flag('maxMs', 10 * 60 * 1000));
  if (!surface) throw new Error('observe requires --surface <name>');
  if (!URL_BASE) throw new Error('observe requires --url or CITY_URL');
  if (!TOKEN) throw new Error('observe requires --token or CITY_TOKEN');
  const deadline = Date.now() + maxMs;
  let stopped = false;
  process.on('SIGINT', () => { stopped = true; });

  append(out, { surface, kind: 'start', cityUrl: URL_BASE });
  let wasDown = false;
  let events = 0;

  while (!stopped && Date.now() < deadline) {
    await new Promise(resolve => {
      const ws = new WebSocket(`${URL_BASE}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=${encodeURIComponent('probe-' + surface.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}&clientLabel=${encodeURIComponent(surface)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const hangGuard = setTimeout(() => { try { ws.terminate(); } catch {} resolve(); }, Math.max(1000, deadline - Date.now()));
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(hangGuard); resolve(); };
      ws.on('open', async () => {
        if (wasDown) { append(out, { surface, kind: 'reconnected', observedAt: Date.now() }); wasDown = false; }
        // The server is asked what the truth is NOW. A surface that trusts its own cache here would report
        // convergence it never observed, which is the one thing this instrument exists to catch.
        try {
          const snapshot = await control('events');
          const maxSeq = snapshot.body.events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
          append(out, { surface, kind: 'resync', maxSeq, observedAt: Date.now(), source: 'server' });
        } catch (error) {
          append(out, { surface, kind: 'resync_failed', error: String(error?.message ?? error), observedAt: Date.now() });
        }
      });
      ws.on('message', raw => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.event) {
          const e = message.event;
          // The store's own field is `timestamp` (services/dev-gateway/store.mjs:23). An earlier version of
          // this probe read `at`, so every server timestamp came back null and the merge silently had nothing
          // to measure latencies against. Reading the real field is the whole point of the instrument.
          const serverAt = e.timestamp ?? e.at ?? null;
          if (serverAt === null) throw new Error('event carried no server timestamp; the probe cannot measure convergence against a clock it does not have');
          append(out, { surface, kind: 'event', seq: e.seq ?? null, type: e.type ?? null, taskId: e.taskId ?? null, serverAt, observedAt: Date.now() });
          events += 1;
        } else if (message.type) {
          append(out, { surface, kind: 'control', messageType: message.type, observedAt: Date.now() });
        }
      });
      ws.on('close', () => {
        if (!stopped && Date.now() < deadline) { wasDown = true; append(out, { surface, kind: 'stale', observedAt: Date.now() }); }
        finish();
      });
      ws.on('error', () => finish());
    });
    if (!stopped && Date.now() < deadline) await sleep(500);
  }
  // The stop record carries the server's own seq at the moment observation ended, which is what makes the
  // AFTER_OBSERVATION bound above a server fact rather than a guess about the local clock.
  let finalMaxSeq = null;
  try {
    const snapshot = await control('events');
    finalMaxSeq = snapshot.body.events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
  } catch { /* recorded as null; merge then treats the window as open-ended, which is the strict choice */ }
  append(out, { surface, kind: 'stop', eventsObserved: events, serverMaxSeq: finalMaxSeq });
  console.log(`observed ${events} events as ${surface} -> ${out}`);
}

// ---------------------------------------------------------------------------- merge

/**
 * Read one surface's receipt and answer two questions: was it up at time T, and what did it see?
 * "Up" is decided from the receipt's own stale/reconnected records, so a surface that was offline when an
 * event was emitted is not failed for missing it - it is reported as offline, which is the truth.
 */
function readReceipt(file) {
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const surface = records.find(r => r.surface)?.surface ?? file;
  const observed = new Map();
  for (const r of records) if (r.kind === 'event' && r.seq != null) if (!observed.has(r.seq)) observed.set(r.seq, r.observedAt);
  const serverAt = new Map();
  for (const r of records) if (r.kind === 'event' && r.seq != null && r.serverAt) if (!serverAt.has(r.seq)) serverAt.set(r.seq, Date.parse(r.serverAt));
  const downIntervals = [];
  let downFrom = null;
  for (const r of records) {
    if (r.kind === 'stale') downFrom = r.observedAt;
    if (r.kind === 'reconnected' && downFrom !== null) { downIntervals.push([downFrom, r.observedAt]); downFrom = null; }
  }
  const openDown = downFrom !== null ? [downFrom, Infinity] : null;
  // The surface's own accountability boundary, in server `seq` terms rather than in wall-clock terms, so a
  // clock difference between hosts can never widen or narrow it.
  //
  //   streamStartSeq  the highest seq the server already had when this surface first looked. Anything at or
  //                   below it happened before the surface was watching (or was delivered by its resync), so
  //                   the surface is not failed for it - the resync record is the evidence for that state.
  //   stopSeq         the highest seq the server had when this surface stopped watching. Anything above it
  //                   may have been emitted after the surface left, so it is out of scope too.
  //
  // Between those two bounds the surface was watching, and an unobserved seq there is a real miss. Without
  // these bounds the instrument reported the probe's own start and stop as convergence failures, which is the
  // mirror image of the earlier false pass: an instrument that fails for its own reasons is as useless as one
  // that cannot fail.
  const firstResync = records.find(r => r.kind === 'resync');
  const streamStartSeq = firstResync?.maxSeq ?? -1;
  const stopRecord = [...records].reverse().find(r => r.kind === 'stop');
  const stopSeq = stopRecord?.serverMaxSeq ?? Number.MAX_SAFE_INTEGER;
  // The highest seq this surface actually saw. Between it and `stopSeq` the surface was being torn down, and a
  // bounded run CANNOT measure its own shutdown boundary: the last events emitted while its socket was closing
  // are neither evidence of convergence nor evidence of a miss. They are reported as unmeasured, and the run's
  // verdict becomes INCOMPLETE rather than CONVERGED - an unmeasurable case is not a passing case.
  const lastObservedSeq = observed.size > 0 ? Math.max(...observed.keys()) : streamStartSeq;
  // Gaps the surface declared about ITSELF (R1). Used to tell "the surface lost this and says so" apart from
  // "the surface lost this and says nothing", which are very different failures.
  const gaps = records.filter(r => r.kind === 'gap' && Number.isFinite(r.gapFrom) && Number.isFinite(r.gapTo));
  return { file, surface, records, observed, serverAt, downIntervals, openDown, streamStartSeq, stopSeq, lastObservedSeq, gaps };
}

function wasOfflineAt(receipt, atMs) {
  if (receipt.downIntervals.some(([a, b]) => atMs >= a && atMs <= b)) return true;
  return receipt.openDown !== null && atMs >= receipt.openDown[0];
}

async function merge() {
  // MECH'S DEFECT 1, fixed. The positional-file list used to be "any argv that does not start with --", which
  // swallowed the VALUE of the preceding flag: `merge --skew Mech-Win-Web=-1001 --out x.json mech.jsonl` fed
  // `Mech-Win-Web=-1001` to readFileSync as if it were a receipt. A walker that skips each known flag's value
  // is the only shape that cannot do that.
  const VALUED = new Set(['url', 'token', 'nodeToken', 'out', 'window', 'skew', 'file', 'surface', 'maxMs', 'target', 'other', 'label', 'observeMs']);
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === 'merge') continue;
    if (a.startsWith('--')) { if (VALUED.has(a.slice(2))) i += 1; continue; }
    positional.push(a);
  }
  const files = flagAll('file').length ? flagAll('file') : positional;
  const windowMs = Number(flag('window', 5000));
  const out = flag('out', 'mesh301-convergence.json');
  // Per-surface clock offsets, declared rather than assumed: `--skew PERM00=592` means that surface's clock
  // reads 592 ms AHEAD of the server's. This exists because the first two-surface run measured Android at
  // ~606 ms for every single event while the other surface measured 0-1 ms - a constant offset is a clock,
  // not a latency, and reporting it as convergence latency would have been a 600 ms lie in the shape of a
  // measurement. Both the raw and the corrected figure are kept, because the correction itself carries the
  // uncertainty of however the offset was measured.
  const skews = Object.fromEntries(flagAll('skew').map(s => { const i = s.lastIndexOf('='); return i === -1 ? [s, 0] : [s.slice(0, i), Number(s.slice(i + 1))]; }));
  if (files.length === 0) throw new Error('merge requires at least one receipt file');
  const receipts = files.map(readReceipt);
  if (receipts.length === 0) throw new Error('no receipts');

  // The canonical timeline. Built from the receipts by default, but a receipts-only union can only contain
  // seqs that SOME surface happened to report - so an event emitted while every surface was away would be
  // invisible, and "nobody reported it" would silently read as "nothing to report". When the City is
  // reachable, the server's own event table is used instead, which makes a miss detectable for every seq that
  // really existed. The receipt records which source was used, so a weaker run cannot be mistaken for a
  // stronger one.
  let timelineSource = 'receipts-union';
  const timeline = new Map();
  for (const r of receipts) for (const [seq, serverAt] of r.serverAt) if (!timeline.has(seq)) timeline.set(seq, serverAt);
  if (URL_BASE && TOKEN) {
    try {
      const snapshot = await control('events');
      let added = 0;
      for (const e of snapshot.body.events) {
        const at = Date.parse(e.timestamp);
        if (Number.isFinite(at) && e.seq != null) { timeline.set(e.seq, at); added += 1; }
      }
      timelineSource = `server (${added} events)`;
    } catch (error) {
      timelineSource = `receipts-union (server read failed: ${String(error?.message ?? error)})`;
    }
  }
  const seqs = [...timeline.keys()].sort((a, b) => a - b);

  const rows = [];
  const failures = [];
  const unmeasured = [];
  // FAIL CLOSED ON AN EMPTY TIMELINE. An earlier version of this merge reported CONVERGED when it had no
  // observations at all, because "no surface breached the window" is vacuously true of nothing. That is the
  // exact class of false pass this programme keeps finding: an instrument that cannot fail is not evidence.
  // So convergence is only ever claimed over a non-empty timeline that every surface actually contributed to.
  if (seqs.length === 0) {
    failures.push({ seq: null, surface: '*', complaint: 'no canonical seq was observed by any surface; convergence cannot be claimed from an empty timeline' });
  }
  for (const r of receipts) {
    if (r.observed.size === 0) failures.push({ seq: null, surface: r.surface, complaint: 'this surface reported no events at all, so its convergence is unknown, not satisfied' });
  }
  for (const seq of seqs) {
    const serverAt = timeline.get(seq);
    const perSurface = {};
    for (const r of receipts) {
      if (seq <= r.streamStartSeq) { perSurface[r.surface] = { state: 'BEFORE_OBSERVATION', latencyMs: null }; continue; }
      if (seq > r.stopSeq) { perSurface[r.surface] = { state: 'AFTER_OBSERVATION', latencyMs: null }; continue; }
      if (wasOfflineAt(r, serverAt)) { perSurface[r.surface] = { state: 'OFFLINE_AT_EMIT', latencyMs: null }; continue; }
      // R1: a gap the SURFACE declared about itself. Reported as a declared hole, never as a silent miss and
      // never as convergence - the workbook's prohibition is on presenting missing events as live consistency,
      // and a labelled hole is not that. It still cannot pass: a hole is a hole.
      const gap = r.gaps.find(g => seq >= g.gapFrom && seq <= g.gapTo);
      if (gap) {
        perSurface[r.surface] = { state: 'GAP_DECLARED', latencyMs: null };
        unmeasured.push({ seq, surface: r.surface, complaint: `inside a gap the surface declared for itself (${gap.gapFrom}..${gap.gapTo})` });
        continue;
      }
      if (seq > r.lastObservedSeq) {
        perSurface[r.surface] = { state: 'AT_SHUTDOWN', latencyMs: null };
        unmeasured.push({ seq, surface: r.surface, complaint: `emitted while this surface was shutting down; a bounded run cannot measure its own shutdown boundary` });
        continue;
      }
      const seen = r.observed.get(seq);
      // MECH'S DEFECT 2, fixed - and this was the dangerous one. `--skew` defaulted to 0, so a table built
      // WITHOUT declaring an offset still printed CONVERGED while a surface's clock offset sat in the latency
      // column wearing the shape of a latency. Mech measured a surface whose raw numbers scored as converged
      // at a ~1 s offset; on a 5 s window that is a false pass with a number attached, which is the worst kind
      // because it looks like evidence.
      //
      // The fix refuses to read an undeclared clock rather than assuming one. `--skew <surface>=0` is how an
      // operator states that assumption explicitly, so the run can never be silent about it.
      if (!(r.surface in skews)) {
        perSurface[r.surface] = { state: 'CLOCK_UNDECLARED', latencyMs: null };
        unmeasured.push({ seq, surface: r.surface, complaint: 'no --skew was declared for this surface, so its clock offset is unknown and its latencies cannot be read as convergence; declare --skew ' + r.surface + '=0 to state the assumption explicitly' });
        continue;
      }
      if (seen === undefined) {
        perSurface[r.surface] = { state: 'MISSING', latencyMs: null };
        failures.push({ seq, surface: r.surface, complaint: `online surface never observed seq ${seq}` });
      } else {
        const raw = seen - serverAt;
        const skew = skews[r.surface] ?? 0;
        const latency = raw - skew;
        const ok = latency <= windowMs;
        perSurface[r.surface] = { state: ok ? 'CONVERGED' : 'LATE', latencyMs: latency, rawLatencyMs: raw, declaredClockSkewMs: skew };
        if (!ok) failures.push({ seq, surface: r.surface, complaint: `observed seq ${seq} after ${latency}ms${skew ? ` (raw ${raw}ms, declared clock skew ${skew}ms)` : ''}, window is ${windowMs}ms` });
      }
    }
    rows.push({ seq, serverAt: new Date(serverAt).toISOString(), type: flag('type') ?? null, surfaces: perSurface });
  }

  // Reconnect convergence: a surface that came back must have re-read the SERVER, and what it read must be at
  // least as new as the last event emitted before it returned. A socket that merely reopened proves nothing.
  const reconnects = [];
  for (const r of receipts) {
    const stale = r.records.filter(x => x.kind === 'stale').map(x => x.observedAt);
    const back = r.records.filter(x => x.kind === 'reconnected').map(x => x.observedAt);
    for (let i = 0; i < back.length; i += 1) {
      const returnedAt = back[i];
      const awaySince = stale[i] ?? returnedAt;
      const resync = r.records.find(x => x.kind === 'resync' && x.observedAt >= returnedAt);
      const latestWhileAway = seqs.filter(s => timeline.get(s) <= returnedAt).at(-1) ?? 0;
      const entry = { surface: r.surface, awaySince: new Date(awaySince).toISOString(), returnedAt: new Date(returnedAt).toISOString(), latestSeqWhileAway: latestWhileAway, resync: resync ? { maxSeq: resync.maxSeq, afterMs: resync.observedAt - returnedAt } : null };
      if (!resync) { entry.verdict = 'NO_RESYNC'; failures.push({ seq: latestWhileAway, surface: r.surface, complaint: 'reconnected without re-reading the server; re-convergence is not evidenced' }); }
      else if (resync.maxSeq < latestWhileAway) { entry.verdict = 'RESYNC_STALE'; failures.push({ seq: latestWhileAway, surface: r.surface, complaint: `resync saw maxSeq ${resync.maxSeq} but ${latestWhileAway} had already been emitted` }); }
      else if (resync.observedAt - returnedAt > windowMs) { entry.verdict = 'RESYNC_LATE'; failures.push({ seq: latestWhileAway, surface: r.surface, complaint: `resync took ${resync.observedAt - returnedAt}ms, window is ${windowMs}ms` }); }
      else entry.verdict = 'RECONVERGED';
      reconnects.push(entry);
    }
  }

  const receipt = {
    instrument: 'mesh301-mesh-probe/merge',
    generatedAt: now(),
    window_ms: windowMs,
    declared_clock_skews_ms: skews,
    timeline_source: timelineSource,
    surfaces: receipts.map(r => ({ surface: r.surface, file: r.file, eventsObserved: r.observed.size, wentOffline: r.downIntervals.length > 0 || r.openDown !== null })),
    timeline: rows,
    reconnects,
    unmeasured,
    // FAILED outranks INCOMPLETE: a measured breach is a result, an unmeasured case is the absence of one.
    verdict: failures.length > 0 ? 'FAILED' : unmeasured.length > 0 ? 'INCOMPLETE' : 'CONVERGED',
    failures,
  };
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);

  const surfaces = receipts.map(r => r.surface);
  console.log(`seq  ${surfaces.map(s => s.padEnd(14)).join('')}`);
  for (const row of rows) {
    console.log(`${String(row.seq).padEnd(5)}${surfaces.map(s => { const c = row.surfaces[s]; return `${c.state === 'CONVERGED' ? `${c.latencyMs}ms` : c.state}`.padEnd(14); }).join('')}`);
  }
  console.log(`\n${receipt.verdict}  window=${windowMs}ms  surfaces=${surfaces.join(', ')}  -> ${out}`);
  for (const f of failures) console.log(`  FAIL seq ${f.seq} ${f.surface}: ${f.complaint}`);
  for (const u of unmeasured) console.log(`  UNMEASURED seq ${u.seq} ${u.surface}: ${u.complaint}`);
  // Anything other than a clean CONVERGED is not evidence of bounded convergence, so it must not exit 0.
  if (receipt.verdict !== 'CONVERGED') process.exitCode = 1;
}

// ---------------------------------------------------------------------------- negative controls

/**
 * The negative controls step 6 asks for, run against the LIVE canonical City over the network.
 *
 * A control that cannot be run is reported as SKIPPED with its reason, never as a pass. The alternative -
 * silently not running a control and printing a green tick - is the failure mode these controls exist to
 * detect in the first place.
 */
async function negative() {
  const target = flag('target');
  const other = flag('other');
  const out = flag('out', 'mesh301-negatives.json');
  const checks = [];
  const record = (name, verdict, evidence) => { checks.push({ name, verdict, evidence }); console.log(`${verdict.padEnd(8)} ${name}`); };

  // 1. A target that is not a known City node identity must be refused, at creation, with a typed code.
  //
  // The probe value must be WELL-FORMED but nonexistent. An earlier version used `__no_such_device__`,
  // whose underscores are not a valid node identity at all, so the City correctly answered MALFORMED and
  // this control reported a failure that was really a defect in the control. A negative control that cannot
  // tell "the product refused for the wrong reason" from "the probe asked the wrong question" is not a
  // control, so both cases are now checked, and each is checked with a value that can only trigger it.
  const unknown = await control('actions', { route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input: { targetDeviceRef: 'No-Such-Device' }, idempotencyKey: `mesh301-neg-unknown-${Date.now()}` });
  const unknownCode = unknown.body.action?.error?.code ?? unknown.body.errorCode ?? null;
  record('unknown target is refused with a typed code', unknownCode === 'TARGET_DEVICE_UNKNOWN' ? 'PASS' : 'FAIL', { code: unknownCode, message: unknown.body.action?.error?.message ?? null });

  // 2. A malformed target must be refused rather than silently dropped.
  const malformed = await control('actions', { route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input: { targetDeviceRef: 'not a valid id' }, idempotencyKey: `mesh301-neg-malformed-${Date.now()}` });
  record('malformed target is refused, not dropped', malformed.body.action?.error?.code === 'TARGET_DEVICE_MALFORMED' ? 'PASS' : 'FAIL', malformed.body);

  // 3. Duplicate user action: one key, one task. Same key with a DIFFERENT target is a contract rejection.
  const key = `mesh301-neg-dup-${Date.now()}`;
  const first = await control('actions', { route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input: { targetDeviceRef: target }, idempotencyKey: key });
  const second = await control('actions', { route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input: { targetDeviceRef: target }, idempotencyKey: key });
  const replayedSameTask = second.body.replayed === true && second.body.action?.backendRef?.taskId === first.body.action?.backendRef?.taskId;
  record('duplicate action replays the same task and does not execute twice', replayedSameTask ? 'PASS' : 'FAIL', { first: first.body.action?.backendRef?.taskId ?? null, second: second.body.replayed ?? null });
  const conflict = await control('actions', { route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input: { targetDeviceRef: other }, idempotencyKey: key });
  record('one idempotency key cannot be made to mean two devices', conflict.body.errorCode === 'IDEMPOTENCY_KEY_REUSED' ? 'PASS' : 'FAIL', conflict.body);

  // 4. A strict task for a device that is away must WAIT, and must never acquire a handoff reservation -
  //    because a reservation is releasable by the City's own sweep, and the user's target is not.
  const strictId = first.body.action?.backendRef?.taskId ?? null;
  if (strictId) {
    const task = (await control(`tasks/${strictId}`)).body;
    const waiting = task.state === 'QUEUED' && task.assignedNodeId === null && task.targetDeviceRef === target;
    record('strict task for an away device waits instead of rerouting', waiting ? 'PASS' : 'FAIL', { state: task.state, targetDeviceRef: task.targetDeviceRef ?? null, targetStateAtCreation: task.targetStateAtCreation ?? null });
    record('strict task carries no releasable handoff reservation', task.handoffTargetRef === undefined ? 'PASS' : 'FAIL', { handoffTargetRef: task.handoffTargetRef ?? null });
    await control(`tasks/${strictId}/switch-declined`, {});
    const after = (await control(`tasks/${strictId}`)).body;
    const held = after.handoffTargetRef === undefined && after.assignedNodeId === null;
    const refused = (await control('events')).body.events.some(e => e.taskId === strictId && e.type === 'TASK_HANDOFF_REFUSED' && e.payload?.reason === 'STRICT_TARGET_BOUND');
    record('declining a switch cannot move a user-targeted run', held && refused ? 'PASS' : 'FAIL', { handoffTargetRef: after.handoffTargetRef ?? null, refusalRecorded: refused });

    // 5. The non-target device must be told WHY it got nothing, and must not receive the work.
    const nodes = (await control('nodes')).body.nodes;
    const otherNode = nodes.find(n => n.id === other);
    if (!otherNode || otherNode.online !== true) {
      record('non-target device is refused with a stated reason', 'SKIPPED', { reason: `${other} is not online in the canonical City right now`, otherOnline: otherNode ? otherNode.online : null });
    } else {
      const claim = await nodeCall('claim', { id: other });
      const withheld = (claim.body.withheld ?? []).find(w => w.taskId === strictId);
      record('non-target device is refused with a stated reason', claim.body.task === null && withheld?.reason === 'STRICT_TARGET_BOUND' ? 'PASS' : 'FAIL', { claimedTask: claim.body.task?.id ?? null, withheld: withheld ?? null });
    }
  } else {
    record('strict task for an away device waits instead of rerouting', 'SKIPPED', { reason: 'the strict task was not created', response: first.body });
  }

  const receipt = { instrument: 'mesh301-mesh-probe/negative', generatedAt: now(), cityUrl: URL_BASE, target, other, checks, verdict: checks.some(c => c.verdict === 'FAIL') ? 'FAILED' : checks.some(c => c.verdict === 'SKIPPED') ? 'INCOMPLETE' : 'PASSED' };
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\n${receipt.verdict} -> ${out}`);
  if (receipt.verdict === 'FAILED') process.exitCode = 1;
}

// ---------------------------------------------------------------------------- entry

const commands = { observe, merge, negative };
if (!commands[command]) {
  console.error('usage: mesh301-mesh-probe.mjs <observe|merge|negative> [options]\nsee the header of this file');
  process.exit(2);
}
await commands[command]();
