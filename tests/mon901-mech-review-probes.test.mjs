// MON-901 · OPPOSITE-HOST REVIEW probes (Mech).
//
// The workbook names four things the reviewer must verify from the EXACT-HEAD runtime rather than from the report:
//
//   1. the monitor projection does not become task truth;
//   2. a JEV sidecar failure does not freeze tasks;
//   3. the projection agrees with canonical runtime;
//   4. an observed risk leaves an exact evidence pointer.
//
// Each probe below attacks one of them against a REAL gateway, and each is written so that it fails if the property
// is only true in the author's fixtures. Verdict and findings: mission-book/reports/MON-901/REVIEW_REPORT.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway, REQUIRED_TASK_CAPABILITIES } from '../services/dev-gateway/server.mjs';

const V = { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const auth = token => ({ ...V, Authorization: 'Bearer ' + token });

async function city(fn) {
  const dir = await mkdtemp(resolve('.scratch-mon901-review-'));
  let app;
  try {
    app = await createGateway({ dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true });
    const get = async (path, token = 'owner') => { const r = await fetch(app.url + '/api/v0/' + path, { headers: auth(token) }); return { status: r.status, body: await r.json() }; };
    const post = async (path, body, token = 'node') => { const r = await fetch(app.url + '/api/v0/' + path, { method: 'POST', headers: auth(token), body: JSON.stringify(body ?? {}) }); const json = await r.json(); if (!r.ok) throw Object.assign(new Error(json.error), { code: json.errorCode ?? 'REFUSAL', status: r.status }); return json; };
    await fn({ app, get, post, createTask: () => post('tasks', { type: 'CHECKPOINT_DEMO' }, 'owner') });
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('PROBE 1: the projection is not task truth — reading it changes nothing canonical, and it cannot write', () => city(async ({ app, get, post, createTask }) => {
  await post('node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: [...REQUIRED_TASK_CAPABILITIES] });
  const task = await createTask();
  await post('node/claim', { id: 'n1' });
  await post('node/report', { id: 'n1', taskId: task.id, state: 'RUNNING', progress: 40 });

  const canonicalBefore = JSON.stringify(app.store.list('tasks'));
  const nodesBefore = JSON.stringify(app.store.list('nodes'));
  const eventsBefore = app.store.events().length;

  const first = await get('monitor');
  const second = await get('monitor');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.monitor.authoritative, false, 'the projection must declare itself non-authoritative');
  assert.equal(first.body.monitor.eventSource, 'CANONICAL_GATEWAY_STORE');

  assert.equal(JSON.stringify(app.store.list('tasks')), canonicalBefore, 'reading the monitor must not change tasks');
  assert.equal(JSON.stringify(app.store.list('nodes')), nodesBefore, 'reading the monitor must not change nodes');
  assert.equal(app.store.events().length, eventsBefore, 'reading the monitor must not append canonical events');

  // The projection carries no API for writing truth: it is a snapshot object, not a store handle.
  assert.equal(typeof first.body.monitor.put, 'undefined');
  assert.equal(typeof first.body.monitor.create, 'undefined');
  assert.equal(typeof first.body.monitor.dispatch, 'undefined');
  assert.equal(Object.hasOwn(first.body.monitor, 'tasks'), false, 'the projection must not expose a task collection that could be mistaken for the store');

  // The canonical task is the only thing that decides the task's state, and it still says what the City said.
  const live = await get('tasks/' + task.id);
  assert.equal(live.body.state, 'RUNNING');
  assert.equal(live.body.progress, 40);
  assert.equal(app.store.get('tasks', task.id).assignedNodeId, 'n1');
}));

test('PROBE 2: an observer that fails is honest and does not freeze the task path', () => city(async ({ app, get, post, createTask }) => {
  // Drive the sidecar into its failure branch by making the canonical reader throw, then prove that ordinary work
  // still completes while the monitor reports UNAVAILABLE rather than pretending to be live.
  const original = app.store.observationWindow.bind(app.store);
  let broken = false;
  app.store.observationWindow = (...args) => { if (broken) throw new Error('canonical source unavailable (review probe)'); return original(...args); };

  await post('node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: [...REQUIRED_TASK_CAPABILITIES] });
  const healthy = await get('monitor');
  assert.equal(healthy.status, 200);
  assert.notEqual(healthy.body.monitor.health, 'UNAVAILABLE');

  broken = true;
  const failed = await get('monitor');
  assert.equal(failed.status, 200, 'a failed observation must answer, not 500');
  assert.equal(failed.body.monitor.health, 'UNAVAILABLE');
  assert.equal(failed.body.monitor.failure, 'CANONICAL_SOURCE_UNAVAILABLE');
  assert.equal(failed.body.monitor.authoritative, false);

  // THE POINT: canonical work is unaffected by the dead observer. Claim → RUNNING → COMPLETED, all while broken.
  const task = await createTask();
  const claimed = await post('node/claim', { id: 'n1' });
  assert.equal(claimed.task.id, task.id, 'the observer failure must not stop a claim');
  assert.equal((await post('node/report', { id: 'n1', taskId: task.id, state: 'RUNNING', progress: 30 })).state, 'RUNNING');
  assert.equal((await post('node/report', { id: 'n1', taskId: task.id, state: 'COMPLETED', progress: 100, result: { ok: true } })).state, 'COMPLETED');
  assert.equal(app.store.get('tasks', task.id).state, 'COMPLETED');

  // Recovery is a read, not a restart: with the reader restored the monitor reports a live view again.
  broken = false;
  const recovered = await get('monitor');
  assert.notEqual(recovered.body.monitor.health, 'UNAVAILABLE');
  assert.equal(recovered.body.monitor.stale, undefined, 'a recovered view must not still be flagged stale');
  app.store.observationWindow = original;
}));

test('PROBE 3: the projection agrees with canonical truth, and says what it omitted', () => city(async ({ app, get, post, createTask }) => {
  await post('node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: [...REQUIRED_TASK_CAPABILITIES] });
  const first = await createTask();
  await post('node/claim', { id: 'n1' });
  await post('node/report', { id: 'n1', taskId: first.id, state: 'RUNNING', progress: 55 });
  const second = await createTask();

  const view = (await get('monitor')).body.monitor;
  const taskNodes = new Map(view.nodes.filter(n => n.kind === 'TASK').map(n => [n.id, n]));
  for (const task of [first, second]) {
    const projected = taskNodes.get(task.id);
    assert.ok(projected, `canonical task ${task.id} must appear in the projection`);
    assert.equal(projected.state, app.store.get('tasks', task.id).state, 'projected state must equal canonical state');
    assert.equal(projected.hostRef, app.store.get('tasks', task.id).assignedNodeId ?? null, 'projected host must equal canonical assignment');
    assert.equal(projected.progress, app.store.get('tasks', task.id).progress, 'projected progress must equal canonical progress');
    assert.equal(projected.ownerRef, null);
    assert.equal(projected.ownerObservability, 'NOT_OBSERVABLE', 'an unknown owner must be declared unknown, not invented');
  }
  // The edge set is derived from the canonical assignment and says so.
  const edge = view.edges.find(e => e.from === first.id);
  assert.ok(edge, 'an assigned task must project an edge to its host');
  assert.equal(edge.to, 'n1');
  assert.equal(edge.type, 'ASSIGNED_TO');
  assert.equal(edge.reason, 'Canonical task.assignedNodeId');
  assert.equal(edge.targetPresent, true, 'the host is registered, so the edge target must be present');

  // Events are the canonical events, with their canonical ids and sequence numbers.
  const canonical = app.store.events();
  const projectedEvents = view.events.map(e => e.canonicalEventId);
  const canonicalIds = canonical.map(e => e.id);
  assert.ok(projectedEvents.length > 0);
  for (const id of projectedEvents) assert.ok(canonicalIds.includes(id), `projected event ${id} must be a canonical event id`);
  for (let i = 0; i < view.events.length; i += 1) {
    const projected = view.events[i];
    const source = canonical.find(e => e.id === projected.canonicalEventId);
    assert.equal(projected.seq, source.seq, 'projected seq must be the canonical seq');
    assert.equal(projected.type, source.type);
    assert.equal(projected.actorRef ?? null, source.actor ?? null);
  }

  // Completeness is stated as data. With a small population nothing is omitted, and the window is continuous from 1.
  assert.deepEqual(view.completeness.tasksOmitted, 0);
  assert.deepEqual(view.completeness.nodesOmitted, 0);
  assert.deepEqual(view.completeness.historyGap, false);
  assert.equal(view.health, 'COMPLETE');
  assert.deepEqual(view.unsupportedSources.length > 0, true, 'sources this slice cannot see must be named');
}));

test('PROBE 4: an omitted population is exposed as a gap rather than smoothed over', () => city(async ({ app, get, post, createTask }) => {
  // Make the population larger than the window, so the projection MUST admit that it is partial. A dashboard that
  // silently showed a truncated view as live is the failure this field exists to prevent.
  const limit = 8;
  const original = app.store.observationWindow.bind(app.store);
  app.store.observationWindow = (options = {}) => original({ ...options, limit });
  for (let i = 0; i < limit + 5; i += 1) await createTask();
  const view = (await get('monitor')).body.monitor;
  assert.equal(view.scope, 'BOUNDED_CANONICAL_WINDOW');
  assert.ok(view.completeness.tasksOmitted > 0, `expected an admitted task gap, got ${JSON.stringify(view.completeness)}`);
  assert.equal(view.health, 'PARTIAL');
  assert.equal(view.unobservedTaskRisk, true, 'a truncated view must flag the risk of an unobserved task');
  assert.ok(view.completeness.tasksOmitted === app.store.list('tasks').length - view.nodes.filter(n => n.kind === 'TASK').length);

  // PROBE 4b: an observed risk must leave an EXACT evidence pointer, not prose.
  assert.ok(view.evidence.length > 0, 'the projection must carry evidence pointers');
  for (const pointer of view.evidence) {
    assert.equal(pointer.source, 'CANONICAL_GATEWAY_STORE');
    assert.equal(pointer.path, '/api/v0/events');
    assert.ok(typeof pointer.canonicalEventId === 'string' && pointer.canonicalEventId.length > 0);
    assert.ok(Number.isInteger(pointer.seq));
  }
  // The pointer is checkable against the canonical store: its seq and id must be real.
  const canonical = app.store.events();
  assert.ok(canonical.some(e => e.id === view.evidence.at(-1).canonicalEventId), 'the last evidence pointer must resolve to a canonical event');
  app.store.observationWindow = original;
}));

test('PROBE 5 (FINDING F1): a complete contiguous window reports historyGap=false together with continuous=false', () => city(async ({ app, get, post, createTask }) => {
  // F1 is a LOW-severity, non-blocking finding: `completeness.continuous` is a hardcoded constant that sits inside
  // the COMPUTED completeness object, next to the computed `historyGap` that already carries the same meaning.
  // The author documents it as a deliberate contract flag ("this slice does not claim continuous telemetry"), and
  // the constant is conservative - it can never over-claim - so it is not a truthfulness defect. The defect is that
  // a consumer of the completeness OBJECT reads `continuous` as a property OF THIS WINDOW: for a window that is in
  // fact complete and contiguous from seq 1 it is told the window is not continuous, and every MON-902 dashboard
  // that renders completeness would raise that false alarm. The counter-example is the assertion below.
  await post('node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: [...REQUIRED_TASK_CAPABILITIES] });
  await createTask();
  await createTask();
  const view = (await get('monitor')).body.monitor;

  const canonicalSeqs = app.store.events().map(e => e.seq);
  assert.deepEqual(canonicalSeqs, canonicalSeqs.map((_, i) => i + 1), 'the canonical history really is contiguous from 1');
  assert.equal(view.completeness.firstSeq, 1, 'the window starts at the first canonical event');
  assert.equal(view.completeness.lastSeq, canonicalSeqs.at(-1), 'the window ends at the last canonical event');
  assert.equal(view.completeness.eventsOmitted, 0);
  assert.equal(view.completeness.historyGap, false, 'nothing is missing, so there is no gap');
  assert.equal(view.health, 'COMPLETE');

  // THE COUNTER-EXAMPLE: for this complete, contiguous window the projection still reports `continuous:false`.
  assert.equal(view.completeness.continuous, false, 'F1: the field is a constant and contradicts historyGap=false');

  // Proof that it is a constant rather than a measurement: no reachable canonical state changes it. It is `false` on
  // an empty City, on a complete window, and on a deliberately truncated one (PROBE 4), while the computed field
  // beside it moved from false to true.
  const truncated = app.store.observationWindow.bind(app.store);
  app.store.observationWindow = (options = {}) => truncated({ ...options, limit: 1 });
  const partial = (await get('monitor')).body.monitor;
  assert.equal(partial.completeness.historyGap, true, 'the computed field does move when history is really missing');
  assert.equal(partial.completeness.continuous, false, 'F1: the constant is unchanged, so it is not derived from the window');
  assert.equal(partial.health, 'PARTIAL');
  app.store.observationWindow = truncated;

  // The workbook-named field for this question is `drop_or_gap`, which the projection carries CORRECTLY as
  // `historyGap`; the finding is confined to the redundant constant and does not weaken the required evidence.
  assert.equal(typeof view.completeness.historyGap, 'boolean');
}));
