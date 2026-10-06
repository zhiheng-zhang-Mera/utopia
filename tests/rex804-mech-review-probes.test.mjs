// REX-804 opposite-host Formal Review probes (reviewer: Mech, COMPUTERNAME MEGA-REP).
//
// These are the REVIEWER's instruments, written against the reviewed head f76ccf53c4e2fecc32ce0ed8a8bb07daaa6935d5.
// They deliberately attack the parts of the fault surface the author's own tests do not exercise:
//   * TWO faults active at once on two different nodes, and no cross-talk between them;
//   * a second fault on the same node immediately after an emergency stop, with the stopped fault's timer proved dead;
//   * expiry observed on the PERSISTED RECEIPT FILE, so the timer path is exercised rather than the lazy read path;
//   * a delayed report released by the fault's own EXPIRY (not by a manual stop) and its recovery attributed;
//   * the owner-only boundary measured with an ENROLLED MEMBER credential, which the author's HTTP test does not use;
//   * the four-class matrix read from disk: startable, stoppable, recorded, recoverable - including the class whose
//     recovery metric is structurally NOT_MEASURED.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {createFaultController, FAULT_KINDS} from '../services/dev-gateway/research/faults.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const headers = token => ({Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const ask = async (app, path, body, token = 'ctl') => {
  const response = await fetch(app.url + '/api/v0/' + path, {method: body ? 'POST' : 'GET', headers: headers(token), body: body ? JSON.stringify(body) : undefined});
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return {status: response.status, body: parsed};
};
const admin = (app, path, body) => ask(app, path, body, 'ctl');
const node = (app, path, body) => ask(app, 'node/' + path, body, 'node');
const registerWorker = (app, id) => node(app, 'register', {id, displayName: id, metadata: {platform: 'reference'}, capabilities: ['task.execute.safe', 'filesystem.temp']});
const withCity = async (fn, options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'rex804-review-'));
  let app = null;
  try {
    app = await createGateway({dir, port: 0, token: 'ctl', nodeToken: 'node', roomsDisabled: true, heartbeatTimeout: 2000, ...options});
    return await fn(app, dir);
  } finally { await app?.close(); await rm(dir, {recursive: true, force: true}); }
};

test('REX804 review P1: two faults are live on two nodes at once and neither leaks into the other', async () => {
  await withCity(async app => {
    await registerWorker(app, 'alpha');
    await registerWorker(app, 'beta');
    await node(app, 'heartbeat', {id: 'alpha'});
    await node(app, 'heartbeat', {id: 'beta'});
    const started = [];
    for (const [kind, id] of [['HEARTBEAT_LOSS', 'alpha'], ['PROVIDER_UNAVAILABLE', 'beta']]) {
      const response = await admin(app, 'research/faults', {kind, nodeId: id, durationMs: 30000, confirmation: `FAULT:${kind}:${id}`});
      assert.equal(response.status, 200, JSON.stringify(response.body));
      started.push(response.body.fault);
    }
    assert.equal(new Set(started.map(row => row.faultId)).size, 2, 'two independent faults exist');
    const listed = await admin(app, 'research/faults');
    assert.equal(listed.body.faults.filter(row => row.status === 'ACTIVE').length, 2, 'both are live in the listing');
    // Each fault acts on its OWN node and on its OWN operation only.
    assert.equal((await node(app, 'heartbeat', {id: 'alpha'})).status, 503, 'the targeted heartbeat is refused');
    assert.equal((await node(app, 'heartbeat', {id: 'beta'})).status, 200, 'the other node\'s heartbeat is untouched');
    assert.equal((await node(app, 'claim', {id: 'beta'})).status, 503, 'the targeted claim is refused');
    assert.equal((await node(app, 'claim', {id: 'alpha'})).status, 200, 'the other node\'s claim is untouched');
    // Stopping one leaves the other exactly as it was.
    const stopped = await admin(app, `research/faults/${started[0].faultId}/stop`, {});
    assert.equal(stopped.body.fault.status, 'STOPPED');
    const survivor = await admin(app, `research/faults/${started[1].faultId}`);
    assert.equal(survivor.body.fault.status, 'ACTIVE', 'stopping one fault must not end the other');
    assert.equal((await node(app, 'heartbeat', {id: 'alpha'})).status, 200, 'the stopped fault no longer refuses');
    assert.equal((await node(app, 'claim', {id: 'beta'})).status, 503, 'the surviving fault still refuses');
    await admin(app, `research/faults/${started[1].faultId}/stop`, {});
    assert.equal((await node(app, 'claim', {id: 'beta'})).status, 200);
  });
});

test('REX804 review P2: a new fault may follow a stopped one immediately, and the stopped fault\'s timer is dead', async () => {
  await withCity(async app => {
    await registerWorker(app, 'alpha');
    await node(app, 'heartbeat', {id: 'alpha'});
    const first = (await admin(app, 'research/faults', {kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 400, confirmation: 'FAULT:HEARTBEAT_LOSS:alpha'})).body.fault;
    await admin(app, `research/faults/${first.faultId}/stop`, {});
    // A second fault on the same node starts at once: FAULT_TARGET_BUSY must not be raised by a STOPPED fault.
    const second = await admin(app, 'research/faults', {kind: 'PROVIDER_UNAVAILABLE', nodeId: 'alpha', durationMs: 30000, confirmation: 'FAULT:PROVIDER_UNAVAILABLE:alpha'});
    assert.equal(second.status, 200, JSON.stringify(second.body));
    // Wait past the FIRST fault's original expiry window: it must stay STOPPED, and the live fault must stay ACTIVE.
    await sleep(700);
    assert.equal((await admin(app, `research/faults/${first.faultId}`)).body.fault.status, 'STOPPED', 'a stopped fault must not be re-labelled EXPIRED by its orphaned timer');
    assert.equal((await admin(app, `research/faults/${second.body.fault.faultId}`)).body.fault.status, 'ACTIVE', 'the new fault must not be ended by the old timer');
    assert.equal((await node(app, 'claim', {id: 'alpha'})).status, 503, 'the new fault is the one in force');
    await admin(app, `research/faults/${second.body.fault.faultId}/stop`, {});
  });
});

test('REX804 review P3: expiry is written to the persisted receipt by the timer, without any API read', async () => {
  await withCity(async (app, dir) => {
    await registerWorker(app, 'alpha');
    await node(app, 'heartbeat', {id: 'alpha'});
    const row = (await admin(app, 'research/faults', {kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 60, confirmation: 'FAULT:HEARTBEAT_LOSS:alpha'})).body.fault;
    const file = join(dir, 'research', 'faults', row.faultId + '.json');
    await sleep(400);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.status, 'EXPIRED', 'the expiry timer itself must persist the terminal state');
    assert.equal(persisted.stopReason, 'DURATION_EXPIRED');
    assert.ok(persisted.endedAt, 'an ended fault states when it ended');
  });
});

test('REX804 review P4: a delayed report is released by the fault\'s own EXPIRY, and its recovery is attributed', async () => {
  await withCity(async app => {
    await registerWorker(app, 'alpha');
    await node(app, 'heartbeat', {id: 'alpha'});
    const task = (await admin(app, 'tasks', {type: 'WAIT'})).body;
    assert.equal((await node(app, 'claim', {id: 'alpha'})).status, 200);
    const row = (await admin(app, 'research/faults', {kind: 'DELAY_RESULT', nodeId: 'alpha', durationMs: 300, confirmation: 'FAULT:DELAY_RESULT:alpha'})).body.fault;
    let settled = false;
    const held = node(app, 'report', {id: 'alpha', taskId: task.id, state: 'RUNNING', progress: 40}).then(result => { settled = true; return result; });
    await sleep(80);
    assert.equal(settled, false, 'the report is held while the fault is live');
    const released = await held;                       // resolves only when the fault expires on its own
    assert.equal(released.status, 200, 'the held report must be RELEASED by expiry, not failed');
    assert.equal(settled, true);
    assert.equal(app.store.get('tasks', task.id).state, 'RUNNING', 'the released report reaches canonical truth');
    const finished = (await admin(app, `research/faults/${row.faultId}`)).body.fault;
    assert.equal(finished.status, 'EXPIRED');
    assert.equal(finished.metrics.delayedReportCount, 1);
    assert.ok(finished.metrics.recoveryTimeMs !== null, 'a released delayed report is a measurable recovery');
  });
});

test('REX804 review P5: the fault surface is owner-only, and an enrolled member is refused with a typed code', async () => {
  await withCity(async app => {
    await registerWorker(app, 'alpha');
    await node(app, 'heartbeat', {id: 'alpha'});
    const enrollment = (await admin(app, 'device/enroll', {displayName: 'Member'})).body;
    const session = (await admin(app, 'device/session', {installationId: enrollment.installation.installationId, instanceId: enrollment.installation.instanceId, ...enrollment.credential})).body.credential;
    const asMember = await ask(app, 'research/faults', undefined, session);
    assert.equal(asMember.status, 403);
    assert.equal(asMember.body.errorCode, 'RESEARCH_OWNER_REQUIRED');
    const injectAsMember = await ask(app, 'research/faults', {kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 1000, confirmation: 'FAULT:HEARTBEAT_LOSS:alpha'}, session);
    assert.equal(injectAsMember.status, 403);
    assert.equal((await node(app, 'heartbeat', {id: 'alpha'})).status, 200, 'a refused injection must not be in force');
    // Typed refusals over HTTP, not trusted from the unit tests.
    assert.equal((await admin(app, 'research/faults', {kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 1000, confirmation: 'nope'})).body.errorCode, 'FAULT_CONFIRMATION_REQUIRED');
    assert.equal((await admin(app, 'research/faults', {kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 30001, confirmation: 'FAULT:HEARTBEAT_LOSS:alpha'})).body.errorCode, 'INVALID_FAULT');
    assert.equal((await admin(app, 'research/faults', {kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 10, confirmation: 'FAULT:HEARTBEAT_LOSS:alpha', extra: 1})).body.errorCode, 'INVALID_FAULT');
    assert.equal((await admin(app, 'research/faults', {kind: 'NOT_A_FAULT', nodeId: 'alpha', durationMs: 10, confirmation: 'FAULT:NOT_A_FAULT:alpha'})).body.errorCode, 'INVALID_FAULT');
    assert.equal((await admin(app, 'research/faults', {kind: 'HEARTBEAT_LOSS', nodeId: 'ghost', durationMs: 10, confirmation: 'FAULT:HEARTBEAT_LOSS:ghost'})).body.errorCode, 'FAULT_TARGET_NOT_READY');
    assert.equal((await admin(app, 'research/faults/fault-00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await admin(app, 'research/faults/fault-00000000-0000-4000-8000-000000000000/stop', {})).status, 404);
  });
});

test('REX804 review P6: the four-class matrix is startable, stoppable, recorded on disk, and its recovery is measured or honestly absent', async () => {
  for (const kind of FAULT_KINDS) {
    await withCity(async (app, dir) => {
      await registerWorker(app, 'alpha');
      await node(app, 'heartbeat', {id: 'alpha'});
      const row = (await admin(app, 'research/faults', {kind, nodeId: 'alpha', durationMs: 150, confirmation: `FAULT:${kind}:alpha`})).body.fault;
      assert.equal(row.status, 'ACTIVE', `${kind} starts`);
      const receiptPath = join(dir, 'research', 'faults', row.faultId + '.json');
      const onDisk = JSON.parse(await readFile(receiptPath, 'utf8'));
      assert.equal(onDisk.status, 'ACTIVE', `${kind} is recorded on disk at start`);
      assert.equal(onDisk.scope, 'CANONICAL_NODE_REQUEST_OR_RESEARCH_OBSERVATION_ONLY');
      // Exercise the class so its counters move, then let it expire by itself.
      if (kind === 'HEARTBEAT_LOSS') await node(app, 'heartbeat', {id: 'alpha'});
      if (kind === 'PROVIDER_UNAVAILABLE') await node(app, 'claim', {id: 'alpha'});
      if (kind === 'DELAY_RESULT') { const task = (await admin(app, 'tasks', {type: 'WAIT'})).body; await node(app, 'claim', {id: 'alpha'}); void node(app, 'report', {id: 'alpha', taskId: task.id, state: 'RUNNING', progress: 25}); }
      if (kind === 'DUPLICATE_EVENT') { const task = (await admin(app, 'tasks', {type: 'WAIT'})).body; void task; app.faults.capture({id: 'probe-' + kind, actor: 'alpha', type: 'TASK_RUNNING', timestamp: new Date().toISOString()}); }
      await sleep(350);
      const ended = JSON.parse(await readFile(receiptPath, 'utf8'));
      assert.equal(ended.status, 'EXPIRED', `${kind} stops by its own bound`);
      assert.equal(ended.stopReason, 'DURATION_EXPIRED');
      const exercised = ended.metrics.injectedFailureCount + ended.metrics.delayedReportCount + ended.metrics.duplicateObservationCount;
      assert.ok(exercised >= 1, `${kind} recorded that it was exercised (got ${exercised})`);
      if (kind === 'DUPLICATE_EVENT') {
        // FINDING F1 (reviewer): this class has no canonical operation to restore, so the author's recovery definition
        // can never be satisfied for it and the metric stays null with a reason. Recorded, not silently counted as 0.
        assert.equal(ended.metrics.recoveryTimeMs, null);
        assert.match(ended.metrics.missingReasons.recoveryTimeMs, /^NOT_MEASURED/);
      }
      assert.equal((await admin(app, `research/faults/${row.faultId}/stop`, {})).body.fault.status, 'EXPIRED', 'stopping an ended fault is an idempotent read');
    });
  }
});

test('REX804 review P7: a receipt left ACTIVE by a dead process is disabled on the next start, and the disk agrees', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rex804-review-restart-'));
  try {
    // The exact shape a process killed with a live fault leaves behind (written by hand, because a graceful close
    // stops its faults as PROCESS_CLOSE and would test the wrong path - the first version of this probe did that and
    // reported PROCESS_CLOSE, which was a defect in the PROBE, not in the product).
    await mkdir(join(dir, 'research', 'faults'), {recursive: true});
    const crashed = {
      schemaVersion: 1, faultId: 'fault-11111111-2222-4333-8444-555555555555', kind: 'PROVIDER_UNAVAILABLE', nodeId: 'alpha',
      durationMs: 30000, confirmed: true, status: 'ACTIVE', startedAt: new Date(Date.now() - 5000).toISOString(),
      expiresAt: new Date(Date.now() + 25000).toISOString(), endedAt: null, stopReason: null,
      scope: 'CANONICAL_NODE_REQUEST_OR_RESEARCH_OBSERVATION_ONLY', detectedAt: null, recoveredAt: null,
      metrics: {injectedFailureCount: 1, duplicateObservationCount: 0, delayedReportCount: 0, detectionTimeMs: null, recoveryTimeMs: null, missingReasons: {}},
    };
    await writeFile(join(dir, 'research', 'faults', crashed.faultId + '.json'), JSON.stringify(crashed));
    const restarted = await createGateway({dir, port: 0, token: 'ctl', nodeToken: 'node', roomsDisabled: true});
    try {
      const after = (await admin(restarted, 'research/faults/' + crashed.faultId)).body.fault;
      assert.equal(after.status, 'INTERRUPTED');
      assert.equal(after.stopReason, 'PROCESS_RESTART');
      const onDisk = JSON.parse(await readFile(join(dir, 'research', 'faults', crashed.faultId + '.json'), 'utf8'));
      assert.equal(onDisk.status, 'INTERRUPTED', 'the recovery is persisted, not only held in memory');
      await node(restarted, 'register', {id: 'alpha', displayName: 'alpha', metadata: {platform: 'reference'}, capabilities: ['task.execute.safe', 'filesystem.temp']});
      assert.equal((await node(restarted, 'claim', {id: 'alpha'})).status, 200, 'the interrupted fault is NOT still in force');
    } finally { await restarted.close(); await sleep(200); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('REX804 review P8 (B1 regression guard): an unreadable fault receipt is REPORTED and never prevents the City starting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rex804-review-corrupt-'));
  try {
    await mkdir(join(dir, 'research', 'faults'), {recursive: true});
    await writeFile(join(dir, 'research', 'faults', 'fault-11111111-2222-4333-8444-555555555555.json'), '{not json');
    // FINDING B1, observed at the reviewed head: the constructor parsed every matching file unguarded, so this single
    // file made createGateway throw an untyped SyntaxError and the City never started. The repair is part of this
    // review branch; this probe is its regression guard.
    const app = await createGateway({dir, port: 0, token: 'ctl', nodeToken: 'node', roomsDisabled: true});
    try {
      assert.equal((await admin(app, 'health')).status, 200, 'the City must start with a broken receipt present');
      const listed = (await admin(app, 'research/faults')).body;
      assert.equal(listed.faults.length, 0, 'a broken receipt is not adopted as a fault');
      assert.deepEqual(listed.broken, [{file: 'fault-11111111-2222-4333-8444-555555555555.json', reason: 'UNREADABLE_RECEIPT'}]);
      // The fault surface still works afterwards.
      await registerWorker(app, 'alpha');
      await node(app, 'heartbeat', {id: 'alpha'});
      const started = await admin(app, 'research/faults', {kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 50, confirmation: 'FAULT:HEARTBEAT_LOSS:alpha'});
      assert.equal(started.status, 200, 'a broken neighbouring receipt must not disable injection');
      await admin(app, `research/faults/${started.body.fault.faultId}/stop`, {});
    } finally { await app.close(); await sleep(200); }
  } finally { await rm(dir, {recursive: true, force: true}).catch(() => {}); }
});

test('REX804 review P9 (B3 regression guard): a shapeless receipt is reported as broken, not adopted without identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rex804-review-shapeless-'));
  try {
    await mkdir(join(dir, 'research', 'faults'), {recursive: true});
    await writeFile(join(dir, 'research', 'faults', 'fault-11111111-2222-4333-8444-555555555555.json'), JSON.stringify({hello: 'world'}));
    const app = await createGateway({dir, port: 0, token: 'ctl', nodeToken: 'node', roomsDisabled: true});
    try {
      const listed = (await admin(app, 'research/faults')).body;
      assert.equal(listed.faults.length, 0, 'a receipt with no identity must not become a fault row');
      assert.deepEqual(listed.broken, [{file: 'fault-11111111-2222-4333-8444-555555555555.json', reason: 'RECEIPT_SHAPE_MISMATCH'}]);
    } finally { await app.close(); await sleep(200); }
  } finally { await rm(dir, {recursive: true, force: true}).catch(() => {}); }
});
