// REX-803 adversarial regression guards: the two defects this task's own adversarial pass found in its own campaign
// surface, pinned so the opposite-host review cannot find them again.
//
//   R-1  a receipt store that cannot be written or listed made the campaign LIST route throw, so an operator watching a
//        running campaign lost sight of it. The store is now DEGRADED AND REPORTED, never thrown at a reader.
//   R-2  a canonical task cancelled from OUTSIDE the campaign was classified FAILED, which mis-attributed the cause.
//        It is now CANCELLED with a reason that names exactly what happened.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import WebSocket from 'ws';
import {createGateway} from '../services/dev-gateway/server.mjs';

const h = credential => ({Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const ask = async (app, path, body, credential = 'owner') => {
  const response = await fetch(app.url + '/api/v0/' + path, {method: body ? 'POST' : 'GET', headers: h(credential), body: body ? JSON.stringify(body) : undefined});
  return {status: response.status, body: await response.json()};
};
const manifest = over => ({
  experimentId: 'adversarial-fixture', question: 'Can the campaign surface survive its own store and an outside cancellation?',
  topology: 'SINGLE_CITY', hosts: ['node-a'], workers: ['node-a'], controlSurfaces: ['probe-surface'],
  variables: {independent: ['scenario'], dependent: ['completion'], controls: ['taskType']},
  repetitions: 2, seedPolicy: 'PER_REPETITION', baseSeed: 5, requiredCapabilities: ['research.evidence.review'],
  stopConditions: [{kind: 'MAX_REPETITIONS', value: 2}], artifactPolicy: {retention: 'SUMMARY_ONLY'},
  acceptance: {primary: 'every planned repetition is accounted for'}, softwareRefs: ['utopia@' + 'a'.repeat(40)],
  ...over,
});
const openSurface = async app => {
  const socket = new WebSocket(`${app.url.replace('http', 'ws')}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=probe-surface&clientLabel=Probe`, ['city-token.' + Buffer.from('owner').toString('base64url')]);
  await new Promise((yes, no) => {socket.on('open', yes); socket.on('error', no);});
  return socket;
};
const withCity = async fn => {
  const dir = await mkdtemp(resolve('.scratch-rex803-adversarial-'));
  let app = null, socket = null;
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
    socket = await openSurface(app);
    await ask(app, 'node/register', {id: 'node-a', displayName: 'node-a', metadata: {platform: 'reference'}, capabilities: ['task.execute.safe', 'filesystem.temp']}, 'node');
    await ask(app, 'node/heartbeat', {id: 'node-a'}, 'node');
    return await fn(app, dir);
  } finally {
    try { socket?.close(); } catch { /* already closed */ }
    await app?.close();
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  }
};
const waitForRunTask = async app => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = app.store.list('tasks').find(candidate => typeof candidate.researchRunRef === 'string');
    if (task) return task;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the campaign never created a task to observe');
};

test('REX803 adversarial R-1: a blocked receipt store degrades the campaign surface instead of failing it', async () => {
  await withCity(async (app, dir) => {
    await ask(app, 'research/experiments', {manifest: manifest({experimentId: 'blocked-store'})});
    // A file sits exactly where the receipt directory belongs. Before the repair this made `receipts()` throw ENOTDIR
    // inside the list route, so the operator could not see the campaign that was still running.
    await writeFile(join(dir, 'research', 'campaigns'), 'a file, not a directory');
    const started = await ask(app, 'research/campaigns', {experimentId: 'blocked-store', scenarioId: 'WAIT', repetitions: 1, warmup: 0});
    assert.equal(started.status, 200, 'the campaign still starts: the store is storage, not authority');
    // Drive the single repetition so the campaign reaches its end and tries (and fails) to file its receipt.
    const task = await waitForRunTask(app);
    await ask(app, 'node/claim', {id: 'node-a'}, 'node');
    await ask(app, 'node/report', {id: 'node-a', taskId: task.id, state: 'RUNNING', progress: 50}, 'node');
    await ask(app, 'node/report', {id: 'node-a', taskId: task.id, state: 'COMPLETED', progress: 100, result: {ok: true}}, 'node');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const live = (await ask(app, 'research/campaigns')).body.live;
      if (['COMPLETED', 'STOPPED', 'FAILED', 'REFUSED', 'INTERRUPTED'].includes(live.state)) break;
      await new Promise(r => setTimeout(r, 10));
    }
    // THE LIST ROUTE STILL ANSWERS, and it says the store is degraded rather than pretending there are no campaigns.
    const listed = await ask(app, 'research/campaigns');
    assert.equal(listed.status, 200, 'the campaign surface keeps answering with a blocked receipt store');
    assert.equal(listed.body.storeState, 'UNAVAILABLE');
    assert.match(listed.body.storeReason, /EEXIST|ENOTDIR|CAMPAIGN_STORE_UNAVAILABLE/);
    assert.equal(listed.body.live.state, 'COMPLETED', 'the campaign itself still completed');
    assert.match(listed.body.live.receiptFailure, /EEXIST|ENOTDIR/, 'the missing receipt is named on the campaign');
    assert.equal(listed.body.live.summary.measured, 1, 'the measured outcome is still reported');
    assert.equal((await ask(app, 'health')).status, 200, 'the City keeps serving');
    assert.equal(app.store.get('tasks', task.id).state, 'COMPLETED', 'canonical truth is untouched by the store failure');
  });
});

test('REX803 adversarial R-2: a canonical task cancelled from outside the campaign is CANCELLED, not FAILED', async () => {
  await withCity(async app => {
    await ask(app, 'research/experiments', {manifest: manifest({experimentId: 'external-cancel'})});
    await ask(app, 'research/campaigns', {experimentId: 'external-cancel', scenarioId: 'WAIT', repetitions: 1, warmup: 0});
    const task = await waitForRunTask(app);
    await ask(app, 'node/claim', {id: 'node-a'}, 'node');
    // The operator cancels the WORK through the canonical route - the campaign did not do this and did not ask for it.
    assert.equal((await ask(app, `tasks/${task.id}/cancel`, {})).status, 200);
    let live = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      live = (await ask(app, 'research/campaigns')).body.live;
      if (['COMPLETED', 'STOPPED', 'FAILED', 'REFUSED', 'INTERRUPTED'].includes(live.state)) break;
      await new Promise(r => setTimeout(r, 10));
    }
    const run = [...live.measured, ...live.notMeasured][0];
    assert.equal(run.state, 'CANCELLED', 'an outside cancellation is a cancellation, not a failure of the work');
    assert.equal(run.reason, 'the canonical task was cancelled outside the campaign');
    assert.equal(live.summary.cancelled, 1);
    assert.equal(live.summary.failed, 0, 'nothing failed here');
    assert.equal(live.summary.accounted, live.summary.planned, 'the planned repetition is still accounted for');
    assert.equal(app.store.get('tasks', task.id).state, 'CANCELLED');
  });
});
