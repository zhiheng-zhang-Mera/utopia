// REX-802 路 OPPOSITE-HOST REVIEW probes (Mech).
//
// The workbook's Review section names the conditions the reviewer must MANUFACTURE rather than read about:
//
//   missing event 路 duplicate event 路 out-of-order event 路 stale clock 路 restart 路 partial trace 路 collector
//   failure - and it requires proof that a collector failure does not drag down Utopia product operation.
//
// Every probe below runs against a REAL createGateway instance (real store, real routes, real collector as wired by
// the gateway), or against a real collector with an injected storage. None of them calls a helper the author's own
// tests call in the same way, and none of them asserts what a comment claims. Verdict and findings:
// mission-book/reports/REX-802/REVIEW_REPORT.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway, REQUIRED_TASK_CAPABILITIES } from '../services/dev-gateway/server.mjs';
import { createTraceCollector, canonicalEventRecord } from '../services/research-trace/index.mjs';

const V = { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const auth = token => ({ ...V, Authorization: 'Bearer ' + token });
// A node may only be handed work when it advertises the City's required capabilities; several probes below failed on
// their first draft because they registered a node with a hand-written capability list and then wondered why the
// claim returned no task. Recorded here so the corrected draft is not mistaken for a product change.
const CAPS = [...REQUIRED_TASK_CAPABILITIES];

async function city(options, fn) {
  const dir = await mkdtemp(resolve('.scratch-rex802-review-'));
  let app;
  try {
    app = await createGateway({ dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true, ...options });
    const get = async (path, token = 'owner') => { const r = await fetch(app.url + '/api/v0/' + path, { headers: auth(token) }); return { status: r.status, body: await r.json() }; };
    const post = async (path, body, token = 'node') => { const r = await fetch(app.url + '/api/v0/' + path, { method: 'POST', headers: auth(token), body: JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json() }; };
    return await fn({ app, get, post, dir });
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
}

const registerNode = (post, id = 'n1', telemetry) => post('node/register', { id, displayName: id, metadata: { platform: 'win32' }, capabilities: CAPS, ...(telemetry === undefined ? {} : { telemetry }) });
const HANG = () => new Promise(() => {});

test('PROBE A: a collector that never finishes cannot slow, block or fail real City work', () => city({ researchTraceStorage: { load: HANG, append: HANG } }, async ({ get, post }) => {
  // The strongest form of "collector failure does not drag down the product": the storage does not fail, it simply
  // NEVER ANSWERS. Nothing in the request path may await it.
  const t0 = Date.now();
  assert.equal((await post('node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: CAPS })).status, 200);
  const created = await post('tasks', { type: 'WAIT' }, 'owner');
  assert.equal(created.status, 200, 'task creation must succeed while storage is hung');
  const claimed = await post('node/claim', { id: 'n1' });
  assert.equal(claimed.status, 200, 'a claim must succeed while storage is hung');
  assert.equal((await post('node/report', { id: 'n1', taskId: claimed.body.task.id, state: 'RUNNING', progress: 30 })).status, 200);
  assert.equal((await post('node/report', { id: 'n1', taskId: claimed.body.task.id, state: 'COMPLETED', progress: 100, result: { ok: true } })).status, 200);
  const elapsed = Date.now() - t0;
  assert.equal(claimed.body.task.id, created.body.id);
  assert.ok(elapsed < 10000, `the whole lifecycle took ${elapsed}ms; a hung collector must not be awaited on the task path`);

  // Canonical truth is unaffected, and the trace answers honestly instead of hanging with the storage.
  assert.equal((await get('tasks/' + created.body.id)).body.state, 'COMPLETED');
  const hungRead = await Promise.race([get('research/trace'), new Promise(r => setTimeout(() => r('TIMEOUT'), 5000))]);
  assert.notEqual(hungRead, 'TIMEOUT', 'the trace endpoint must answer even when its storage never does');
  assert.equal(hungRead.status, 200);
  assert.notEqual(hungRead.body.trace.completeness, 'COMPLETE', 'a never-answered storage must not be reported as a complete recording');
  assert.equal(hungRead.body.trace.recording, true);
}));

test('PROBE B: a collector failure is typed, silent to the product path and free of private detail', () => {
  const PRIVATE = 'PRIVATE_COLLECTOR_MESSAGE_MUST_NOT_ESCAPE';
  return city({ researchTraceStorage: { load: async () => [], append: async () => { throw Object.assign(new Error(PRIVATE), { code: 'EIO' }); } } }, async ({ get, post }) => {
    const created = await post('tasks', { type: 'WAIT' }, 'owner');
    assert.equal(created.status, 200);
    const claimed = await post('node/claim', { id: 'n1' });
    // The claim fails for its own reason (no node registered), but the failure must be a typed refusal, not a 500
    // from the collector.
    assert.equal(claimed.status, 404);
    await post('node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: CAPS });
    assert.equal((await post('node/claim', { id: 'n1' })).status, 200, 'a failing collector must not stop claims');
    assert.equal((await get('health')).status, 200, 'health must stay up with a failing collector');
    await new Promise(r => setTimeout(r, 50));
    const trace = (await get('research/trace')).body.trace;
    assert.equal(trace.storageState, 'FAILED');
    assert.equal(trace.completeness, 'PARTIAL');
    assert.ok(trace.failures.some(f => /^[A-Z0-9_]+$/.test(f.code)), 'failures must be typed codes');
    assert.equal(JSON.stringify(trace).includes(PRIVATE), false, 'the private exception message must never reach the trace');
  });
});

test('PROBE C: missing, duplicate, out-of-order and stale-clock observations are each surfaced as data', () => city({}, async ({ app }) => {
  // Drive the collector that the REAL gateway constructed, with canonical-shaped events that carry the seven
  // manufactured conditions. `canonicalEventRecord` is the same tap the gateway uses, so this is the production
  // path, not a parallel one.
  const ev = (id, seq, at, payload = {}) => ({ id, seq, type: 'TASK_STARTED', timestamp: new Date(at).toISOString(), payload, actor: 'gateway' });
  const now = Date.now();
  app.researchTrace.captureCanonical(ev('e1', 1, now));
  app.researchTrace.captureCanonical(ev('e2', 2, now));                 // contiguous
  app.researchTrace.captureCanonical(ev('e1', 1, now));                 // duplicate id
  app.researchTrace.captureCanonical(ev('e3', 7, now));                 // sequence gap -> missing events 3..6
  app.researchTrace.captureCanonical(ev('e4', 5, now));                 // out of order (behind the watermark 7)
  app.researchTrace.captureCanonical(ev('e5', 8, now - 600000));        // stale source timestamp
  await app.researchTrace.flush();

  const trace = app.researchTrace.snapshot();
  const byId = new Map(trace.records.map(r => [r.eventId, r]));
  assert.ok(byId.get('e1').annotations.includes('DUPLICATE_EVENT'), 'a repeated event id must be annotated, not silently merged');
  assert.ok(byId.get('e3').annotations.includes('SOURCE_SEQUENCE_GAP'), 'a jump in source sequence must be admitted as missing events');
  assert.ok(byId.get('e4').annotations.includes('OUT_OF_ORDER_EVENT'), 'an event behind the watermark must be annotated');
  assert.ok(byId.get('e5').annotations.includes('STALE_SOURCE_TIMESTAMP'), 'an old source timestamp must be annotated');
  assert.equal(byId.get('e2').annotations.length, 0, 'a clean event must not be annotated');
  assert.equal(trace.completeness, 'PARTIAL', 'annotated records must make the recording partial');

  // The annotation is an OBSERVATION about the source, and the canonical sequence is not rewritten by it.
  assert.equal(byId.get('e4').sourceSeq, 5, 'normalization must not renumber the source sequence');
  assert.equal(byId.get('e4').canonicalRefs.taskRef ?? null, null);
}));

test('PROBE D: a restart starts a new epoch, restores the previous window, and does not restate it as this run', () => city({}, async ({ app, get, post, dir }) => {
  await post('tasks', { type: 'WAIT' }, 'owner');
  await app.researchTrace.flush();
  const first = await get('research/trace');
  const firstRunId = first.body.trace.runId;
  assert.ok(first.body.trace.records.length > 0);
  await app.close();

  // Restart: a genuinely NEW gateway over the SAME directory, exactly what an operator restart does.
  const second = await createGateway({ dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true });
  try {
    await second.researchTrace.flush();
    const trace = (await (await fetch(second.url + '/api/v0/research/trace', { headers: auth('owner') })).json()).trace;
    assert.notEqual(trace.runId, firstRunId, 'a restart must produce a new recording epoch');
    assert.ok(trace.records.length >= first.body.trace.records.length, 'the retained window must survive a restart');
    assert.equal(trace.storageState, 'READY');
    assert.equal(trace.recording, true);
    // FINDING F2 evidence: the top-level run id describes THIS process, while the restored records carry the run id of
    // the process that actually observed them. The two are exposed in one object with no per-record run filter.
    const foreign = trace.records.filter(r => r.runId !== trace.runId);
    assert.ok(foreign.length > 0, 'restored records must carry the previous epoch run id');
    assert.equal(foreign.every(r => r.runId === firstRunId), true, 'restored records must keep their own run id, not be relabelled');
  } finally { await second.close(); }
}));

test('PROBE E: a truncated or dropped recording is admitted and never described as complete', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex802-review-'));
  let collector;
  try {
    // queueLimit 1 + a storage that never answers => the queue drops, the window stays bounded.
    collector = createTraceCollector({ directory: dir, recordLimit: 3, queueLimit: 1, storage: { load: async () => [], append: HANG } });
    await collector.flush();
    for (let i = 1; i <= 10; i += 1) collector.record({ eventId: 'e' + i, type: 'TASK_STARTED', timestamp: new Date().toISOString(), sourceSeq: i, canonicalRefs: { taskRef: 'Q-x' } });
    assert.equal(await collector.flush(30), false, 'a hung writer must make flush time out rather than block');
    const trace = collector.snapshot();
    assert.ok(trace.droppedRecords > 0, 'dropped records must be counted, not hidden');
    assert.ok(trace.records.length <= 3, 'the retained window must stay bounded');
    assert.equal(trace.completeness, 'PARTIAL');
    assert.equal(trace.counterScope, 'CURRENT_COLLECTOR_EPOCH_AND_RETAINED_WINDOW', 'the accounting scope must be declared');
    // The declaration is not decoration: it is the honest statement that the counters cover this epoch only.
    assert.ok(trace.droppedRecords >= 10 - 3);
  } finally { await collector?.close(20); await rm(dir, { recursive: true, force: true }); }
});

test('PROBE F: the collector invents no measurement and no campaign of its own', () => city({ researchTraceSoftwareRefs: { softwareSha: '0e9bea3ce739b979e582a428af8fb233045a5e75' } }, async ({ app, get, post }) => {
  // A real node, a real task, and a resource sample that genuinely measured zero.
  const observedAt = new Date().toISOString();
  await post('node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: CAPS, telemetry: { observedAt, uptimeSeconds: 5, cpu: { usagePercent: 0 }, memory: { usedBytes: 0, totalBytes: 1024 }, disk: null } });
  const created = await post('tasks', { type: 'WAIT' }, 'owner');
  await post('node/claim', { id: 'n1' });
  assert.equal((await post('node/heartbeat', { id: 'n1' })).status, 200); // no telemetry supplied this time
  await app.researchTrace.flush();

  const trace = (await get('research/trace')).body.trace;
  const sample = trace.records.find(r => r.type === 'RESOURCE_OBSERVATION');
  assert.ok(sample, 'a supplied resource sample must be recorded');
  assert.equal(sample.metrics.cpuPercent.value, 0, 'a measured zero must stay zero');
  assert.equal(sample.metrics.cpuPercent.reason, null);
  assert.equal(sample.clocks.source, 'EXTERNAL_DECLARED_WALL_UTC', 'the declared clock source must travel with the sample');
  assert.equal(trace.records.filter(r => r.type === 'RESOURCE_OBSERVATION').length, 1, 'an omitted heartbeat sample must not replay a cached measurement');

  // The metrics this foundation cannot observe must be unknown WITH a reason - never 0, never a plausible guess.
  for (const name of ['autonomousSpanMs', 'taskTransitionCount', 'latencyMs', 'backoffMs']) {
    assert.equal(sample.metrics[name].value, null, `${name} must be unknown, not invented`);
    assert.match(sample.metrics[name].reason, /^NOT_OBSERVABLE/, `${name} must carry a NOT_OBSERVABLE reason`);
  }
  assert.equal(trace.metricsAvailability.autonomousSpanMs.available, false);
  // No policy from a registered node may be mistaken for a declaration about this recording run.
  assert.equal(trace.experimentRunRef, null);
  assert.match(trace.experimentRunReason, /^NOT_OBSERVABLE/);
  // And the canonical task reference is a reference: the canonical state is untouched by the trace.
  assert.equal(app.store.get('tasks', created.body.id).state, 'ASSIGNED');
}));

test('PROBE G: only the owner may read the trace, and canonical payload never reaches it', () => city({}, async ({ app, get, post }) => {
  const SECRET = 'MECH-REX802-CANARY-51ab';
  const anonymous = await fetch(app.url + '/api/v0/research/trace', { headers: V });
  assert.equal(anonymous.status, 401, 'the trace must not be readable without a credential');
  assert.equal((await fetch(app.url + '/api/v0/research/trace', { headers: auth('node') })).status, 401, 'a worker token must not read the trace');

  const admission = (await post('device/enroll', { displayName: 'Member' }, 'owner')).body;
  const session = (await post('device/session', { installationId: admission.installation.installationId, instanceId: admission.installation.instanceId, ...admission.credential })).body.credential;
  const asMember = await fetch(app.url + '/api/v0/research/trace', { headers: auth(session) });
  assert.equal(asMember.status, 403, 'an enrolled member must be refused');
  assert.match((await asMember.json()).errorCode, /OWNER_REQUIRED$/, 'the refusal must name the owner requirement');
  // The trace cannot be written through: there is no mutation route behind this path, so a POST is not a no-op success.
  assert.equal((await post('research/trace', { records: [] }, 'owner')).status, 404, 'the trace must be read-only at the HTTP boundary');

  // Plant a canary where canonical truth really carries it. The first draft of this probe tried a task `input` and a
  // node `metadata.seed` and could not find the canary in canonical truth at all - the City drops both, which is
  // itself worth knowing - so the canary travels in a reported failure result/error, which canonical truth does keep.
  await post('node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: CAPS });
  const created = await post('tasks', { type: 'WAIT' }, 'owner');
  const claimed = await post('node/claim', { id: 'n1' });
  await post('node/report', { id: 'n1', taskId: claimed.body.task.id, state: 'RUNNING', progress: 10 });
  await post('node/report', { id: 'n1', taskId: claimed.body.task.id, state: 'FAILED', progress: 100, error: { message: SECRET }, result: { secret: SECRET } });
  const canonical = JSON.stringify(app.store.events());
  assert.ok(canonical.includes(SECRET), 'the canary really is in canonical truth (otherwise this probe proves nothing)');
  await app.researchTrace.flush();
  const trace = (await get('research/trace')).body.trace;
  assert.equal(JSON.stringify(trace).includes(SECRET), false, 'canonical payload material must not be copied into the trace');
  assert.ok(trace.records.some(r => r.type === 'TASK_FAILED'), 'the event itself must still be recorded, by identity');
  const recorded = trace.records.find(r => r.type === 'TASK_FAILED');
  assert.equal(recorded.canonicalRefs.taskRef, created.body.id, 'the record must reference the canonical task');
  assert.equal(app.store.get('tasks', created.body.id).state, 'FAILED', 'the canonical truth holds the failure that the trace only references');
}));

test('PROBE H (FINDING F1): completeness is a constant PARTIAL for every record the Gateway can produce', () => city({ researchTraceSoftwareRefs: { softwareSha: '0e9bea3ce739b979e582a428af8fb233045a5e75', configRef: 'config/default.json' } }, async ({ app, get, post }) => {
  // `completeness` is computed as: storage not READY, or drops, or retention truncation, or failures, or ANY record
  // carrying an annotation or a missing optional field. The last clause means the field measures "are all optional
  // EXTERNAL identities declared", not "is this recording trustworthy".
  await post('node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: CAPS });
  await post('tasks', { type: 'WAIT' }, 'owner');
  await app.researchTrace.flush();
  const trace = (await get('research/trace')).body.trace;

  // Nothing is wrong with this recording: no drops, no truncation, no failures, no annotation anywhere.
  assert.equal(trace.droppedRecords, 0);
  assert.equal(trace.retentionTruncated, false);
  assert.deepEqual(trace.failures, []);
  assert.equal(trace.storageState, 'READY');
  assert.equal(trace.records.every(r => r.annotations.length === 0), true, 'no event was missing, duplicated, reordered or stale');

  // And yet the user-visible completeness is PARTIAL, because every gateway-emitted event lacks the optional
  // experiment/provider/model/channel identities that only an external producer could declare.
  assert.equal(trace.completeness, 'PARTIAL', 'F1: a healthy recording still reports PARTIAL');
  const missing = new Set(trace.records.flatMap(r => r.missingFields));
  for (const field of ['experimentRef', 'experimentRunRef', 'providerRef', 'modelRef', 'channelRef']) assert.ok(missing.has(field), `${field} is always absent from gateway-emitted events`);

  // Proof that the field is reachable in principle and therefore not simply broken: a fully-declared record on a
  // fresh collector does reach COMPLETE. So the defect is REPRESENTATION - the surface cannot distinguish "the
  // recording is trustworthy but the City does not run experiments" from "history is missing" - not a broken computation.
  const dir = await mkdtemp(resolve('.scratch-rex802-review-'));
  let full, bare;
  try {
    full = createTraceCollector({ directory: dir, storage: { load: async () => [], append: async () => ({}) }, softwareRefs: { softwareSha: '0e9bea3ce739b979e582a428af8fb233045a5e75', configRef: 'config/default.json' } });
    await full.flush();
    full.record({ eventId: 'declared-1', type: 'EXPERIMENT_STEP', timestamp: new Date().toISOString(), sourceSeq: 1, sourceClock: 'HOST_WALL_UTC', dimensions: { experimentRef: 'exp-1', experimentRunRef: 'run-1', providerRef: 'p-1', modelRef: 'm-1', channelRef: 'c-1' }, canonicalRefs: {} });
    assert.equal(full.snapshot().completeness, 'COMPLETE', 'COMPLETE is reachable when every optional identity is declared');

    // The empty-set corner, measured rather than argued. A BARE collector with zero records reports COMPLETE, because
    // "nothing is missing from an empty set" is vacuously true. This state is NOT reachable through the Gateway - it
    // emits CITY_STARTED before it can answer any request, which is why the real recording above is PARTIAL - but the
    // two measurements together show the field is inverted relative to usefulness: empty reads COMPLETE, real activity
    // reads PARTIAL. Recorded so the corner is not mistaken for a product-visible state.
    const bareDir = await mkdtemp(resolve('.scratch-rex802-bare-'));
    try {
      bare = createTraceCollector({ directory: bareDir, storage: { load: async () => [], append: async () => ({}) } });
      await bare.flush();
      assert.equal(bare.snapshot().records.length, 0);
      assert.equal(bare.snapshot().completeness, 'COMPLETE', 'an empty set is reported as COMPLETE');
    } finally { await bare?.close(20); await rm(bareDir, { recursive: true, force: true }); }
    assert.ok(trace.records.some(r => r.type === 'CITY_STARTED'), 'the Gateway always records CITY_STARTED, so the empty state is unreachable in the product');
  } finally { await full?.close(20); await rm(dir, { recursive: true, force: true }); }
}));
