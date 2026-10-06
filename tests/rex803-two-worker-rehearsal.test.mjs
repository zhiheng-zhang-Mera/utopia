// REX-803: the TWO-WORKER topology rehearsal — and the defect it found on its first run.
//
// WHY THIS EXISTS. Every campaign fixture in this task's suite, and both physical campaigns run on the real resident
// City, declared ONE worker. On the physical topology the Android handset was a CONTROL SURFACE, not a worker, so the
// placement rule below has never once run with more than one candidate:
//
//     const workers = context?.workers ?? [];
//     const target  = context?.targetDeviceRef ?? (workers.length > 0 ? workers[seed % workers.length] : null);
//
// With one worker `workers[seed % 1]` is always the only worker, so a fixture with one worker cannot tell the rule
// working from the rule never running. This file declares TWO workers and asserts the two things a reader of the
// receipt actually depends on: that each repetition's canonical task is TARGETED by the derived seed, and that it is
// therefore ASSIGNED to the worker the seed selects.
//
// It is a REHEARSAL, not the completion gate. The workbook's gate requires the Alien host's own node; two identities on
// one physical host cannot satisfy it, and this file claims nothing about that gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {WebSocket} from 'ws';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {runSeed} from '../services/dev-gateway/scenario-runner.mjs';

const HEADERS = {Authorization: 'Bearer owner', 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const NODE_HEADERS = {Authorization: 'Bearer node', 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const WORKERS = ['rehearsal-alpha', 'rehearsal-beta'];
const REPETITIONS = 6;
const SCENARIO = 'WAIT';

const call = async (app, path, body, headers = HEADERS) => {
  const response = await fetch(`${app.url}/api/v0/${path}`, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
};

const openSurface = async app => {
  const socket = new WebSocket(`${app.url.replace('http', 'ws')}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=web-rehearsal&clientLabel=RehearsalSurface`, ['city-token.' + Buffer.from('owner').toString('base64url')]);
  await new Promise((yes, no) => {socket.on('open', yes); socket.on('error', no);});
  return socket;
};

/** A campaign seed whose derived run seeds actually select BOTH workers, found by scanning. The first version of a probe
 *  for an earlier finding passed on the broken code because its fixture could agree with the defect by luck; this
 *  fixture is chosen so that it cannot: the assertion below fails unless the seed parities really do span both. */
function seedThatUsesBothWorkers() {
  for (let n = 0; n < 500; n += 1) {
    const seed = `rex803-rehearsal-${n}`;
    const targets = Array.from({length: REPETITIONS}, (_unused, index) => runSeed(seed, index) % WORKERS.length);
    if (new Set(targets).size === WORKERS.length) return {seed, targets};
  }
  return null;
}

const manifestFor = over => ({
  experimentId: 'two-worker-rehearsal',
  question: 'Does a repetition land on the worker its own derived seed selects, when more than one worker exists?',
  hypothesis: 'The placement rule is deterministic and uses the whole declared worker set.',
  topology: 'TWO_HOST_MESH',
  hosts: [...WORKERS],
  workers: [...WORKERS],
  controlSurfaces: ['web-rehearsal'],
  variables: {independent: ['scenario'], dependent: ['assignment'], controls: ['taskType']},
  repetitions: REPETITIONS,
  seedPolicy: 'PER_REPETITION',
  baseSeed: 20261006,
  requiredCapabilities: ['research.evidence.review'],
  stopConditions: [{kind: 'MAX_REPETITIONS', value: REPETITIONS}, {kind: 'MAX_FAILURES', value: REPETITIONS}],
  artifactPolicy: {retention: 'SUMMARY_ONLY'},
  acceptance: {primary: 'Every repetition is assigned by the declared rule'},
  softwareRefs: [`utopia@${'0'.repeat(40)}`],
  ...over,
});

/** A City with two live workers and a live control surface, the experiment registered, and a campaign started. */
async function rehearse(fn) {
  const fixture = seedThatUsesBothWorkers();
  assert.ok(fixture, 'the fixture must find a seed that exercises both workers, or it would only re-test the one-worker path');
  const dir = await mkdtemp(resolve('.scratch-rex803-rehearsal-'));
  let app = null, socket = null;
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
    socket = await openSurface(app);
    for (const id of WORKERS) {
      const registered = await call(app, 'node/register', {id, displayName: `Rehearsal ${id}`, capabilities: ['task.execute.safe', 'filesystem.temp'], roles: ['EXECUTION_NODE'], metadata: {platform: 'win32'}}, NODE_HEADERS);
      assert.equal(registered.status, 200, JSON.stringify(registered.body));
    }
    const manifest = manifestFor();
    const registered = await call(app, 'research/experiments', {manifest});
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    const listed = await call(app, 'research/campaigns');
    // The READY branch of the topology gate - the branch every earlier attempt in this programme was refused before.
    assert.equal(listed.body.topology.workers.length, WORKERS.length, 'both rehearsal workers must be live in the City the campaign reads');
    const started = await call(app, 'research/campaigns', {experimentId: manifest.experimentId, scenarioId: SCENARIO, repetitions: REPETITIONS, seed: fixture.seed});
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.started.campaignSeed, fixture.seed);

    /** Watch every canonical task the campaign creates, then drive both workers until it settles. */
    const seen = new Map();
    const claimNodeFor = async (taskId, id) => {
      const claimed = await call(app, 'node/claim', {id}, NODE_HEADERS);
      const taskIdClaimed = claimed.body?.task?.id;
      if (!taskIdClaimed) return null;
      return {taskId: taskIdClaimed, id, claimStatus: claimed.status};
    };
    const until = Date.now() + 25000;
    let live = (await call(app, 'research/campaigns')).body.live;
    while (Date.now() < until && !['COMPLETED', 'STOPPED', 'REFUSED', 'FAILED', 'INTERRUPTED'].includes(live.state)) {
      for (const task of app.store.list('tasks')) if (task.researchRunRef && !seen.has(task.id)) seen.set(task.id, task);
      for (const id of WORKERS) {
        const claimed = await claimNodeFor(null, id);
        if (!claimed) continue;
        await call(app, 'node/report', {id, taskId: claimed.taskId, state: 'RUNNING', progress: 50}, NODE_HEADERS);
        await call(app, 'node/report', {id, taskId: claimed.taskId, state: 'COMPLETED', progress: 100, result: {ok: true}}, NODE_HEADERS);
      }
      for (const task of app.store.list('tasks')) if (task.researchRunRef && !seen.has(task.id)) seen.set(task.id, task);
      await new Promise(r => setTimeout(r, 10));
      live = (await call(app, 'research/campaigns')).body.live;
    }
    const receipt = (await call(app, `research/campaigns/${started.body.started.campaignId}`)).body.campaign;
    return await fn({app, fixture, started, live, receipt, seenTasks: [...seen.values()]});
  } finally {
    try { socket?.close(); } catch { /* already closed */ }
    await app?.close();
    await rm(dir, {recursive: true, force: true});
  }
}

test('REX803 rehearsal: with TWO workers every repetition is TARGETED by its derived seed, not left to claim order', async () => {
  await rehearse(async ({fixture, started, seenTasks, receipt}) => {
    const runs = receipt.runs.filter(run => run.measured);
    assert.equal(runs.length, REPETITIONS, `every repetition must be measured: ${JSON.stringify(receipt.summary)}`);
    // THE DEFECT THIS REHEARSAL FOUND ON ITS FIRST RUN. `runOnce` reads `context?.workers`, but the campaign context
    // the route builds carries the topology under `context.manifest.workers`, so the read is always an empty array and
    // `workers[seed % workers.length]` never executes. Every run is therefore created UNTARGETED and the assignment is
    // decided by whichever able worker claims first - which is not the reproducibility property the module documents.
    const untargeted = seenTasks.filter(task => !task.targetDeviceRef);
    assert.equal(untargeted.length, 0,
      `${untargeted.length} of ${seenTasks.length} campaign task(s) were created with no targetDeviceRef, so the derived-seed placement rule never ran and the receipt's assignment is claim order, not the declared rule`);
    for (const run of runs) {
      const expected = WORKERS[fixture.targets[run.index]];
      const task = seenTasks.find(candidate => candidate.researchRunRef === `${receipt.campaignId}:${run.index}`);
      assert.ok(task, `no canonical task recorded for run ${run.index}`);
      assert.equal(task.targetDeviceRef, expected, `run ${run.index} should be targeted at ${expected}`);
    }
  });
});

test('REX803 rehearsal: the observed assignment equals the declared rule, and both workers are used', async () => {
  await rehearse(async ({fixture, started, live, receipt, seenTasks}) => {
    assert.equal(live.state, 'COMPLETED', JSON.stringify(receipt.summary));
    assert.equal(receipt.summary.accounted, receipt.summary.planned);
    const runs = receipt.runs.filter(run => run.measured);
    const observed = [];
    for (const run of runs) {
      const predicted = WORKERS[fixture.targets[run.index]];
      assert.ok(run.result?.assignedNodeId, `run ${run.index} recorded no assigned node: ${JSON.stringify(run.result)}`);
      assert.equal(run.result.assignedNodeId, predicted, `run ${run.index} (seed ${run.seed}) landed on ${run.result.assignedNodeId}, but the declared rule selects ${predicted}`);
      observed.push(run.result.assignedNodeId);
    }
    assert.deepEqual([...new Set(observed)].sort(), [...WORKERS].sort(), 'the rehearsal must actually have used BOTH workers, or it re-tested the degenerate case');
    assert.equal(seenTasks.length, REPETITIONS);
    assert.ok(started.body.started.campaignId);
  });
});
