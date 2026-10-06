// REX-803: the campaign control surface on a REAL City - one canonical task per repetition, owner-only control,
// measured topology readiness, typed refusals, and a stop that actually cancels the work it started.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import WebSocket from 'ws';
import {createGateway} from '../services/dev-gateway/server.mjs';

const h = credential => ({Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const ask = async (app, path, body, credential = 'owner') => {
  const response = await fetch(app.url + '/api/v0/' + path, {method: body ? 'POST' : 'GET', headers: h(credential), body: body ? JSON.stringify(body) : undefined});
  return {status: response.status, body: await response.json()};
};
const manifest = over => ({
  experimentId: 'campaign-fixture',
  question: 'Is a repetition a real canonical task that reaches a terminal state?',
  topology: 'SINGLE_CITY',
  hosts: ['node-fixture'], workers: ['node-fixture'], controlSurfaces: ['web-fixture'],
  variables: {independent: ['scenario'], dependent: ['completion'], controls: ['taskType']},
  repetitions: 3, seedPolicy: 'PER_REPETITION', baseSeed: 7,
  requiredCapabilities: ['research.evidence.review'],
  stopConditions: [{kind: 'MAX_REPETITIONS', value: 3}, {kind: 'MAX_FAILURES', value: 2}],
  artifactPolicy: {retention: 'SUMMARY_ONLY'},
  acceptance: {primary: 'Every repetition is a real canonical task that reached a terminal state'},
  softwareRefs: ['utopia@' + '0'.repeat(40)],
  ...over,
});
/** A live control surface: the readiness gate is decided against real sockets, so the test opens a real one. */
const openSurface = async app => {
  const socket = new WebSocket(`${app.url.replace('http', 'ws')}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=web-fixture&clientLabel=CampaignFixture`, ['city-token.' + Buffer.from('owner').toString('base64url')]);
  await new Promise((yes, no) => {socket.on('open', yes); socket.on('error', no);});
  return socket;
};
const registerWorker = (app, id = 'node-fixture') => ask(app, 'node/register', {id, displayName: 'Fixture worker', capabilities: ['task.execute.safe', 'filesystem.temp'], roles: ['EXECUTION_NODE'], metadata: {platform: 'win32'}}, 'node');
/** A worker that claims and completes whatever the campaign creates, until the campaign stops moving. */
const workUntilSettled = async (app, {deadlineMs = 10000, complete = true} = {}) => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const live = (await ask(app, 'research/campaigns')).body.live;
    if (['COMPLETED', 'STOPPED', 'REFUSED', 'FAILED', 'INTERRUPTED'].includes(live.state)) return live;
    const claimed = await ask(app, 'node/claim', {id: 'node-fixture'}, 'node');
    const taskId = claimed.body?.task?.id;
    if (taskId && complete) {
      await ask(app, 'node/report', {id: 'node-fixture', taskId, state: 'RUNNING', progress: 50}, 'node');
      await ask(app, 'node/report', {id: 'node-fixture', taskId, state: 'COMPLETED', progress: 100, result: {ok: true}}, 'node');
    }
    await new Promise(r => setTimeout(r, 10));
  }
  return (await ask(app, 'research/campaigns')).body.live;
};
const withCity = async (fn, {surface = true} = {}) => {
  const dir = await mkdtemp(resolve('.scratch-rex803-route-'));
  let app = null, socket = null;
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
    if (surface) socket = await openSurface(app);
    return await fn(app, {dir});
  } finally {
    try { socket?.close(); } catch { /* already closed */ }
    await app?.close();
    await rm(dir, {recursive: true, force: true});
  }
};

test('REX803 campaigns: every repetition is a real canonical task, and the receipt accounts for all of them', async () => {
  await withCity(async app => {
    assert.equal((await registerWorker(app)).status, 200);
    assert.equal((await ask(app, 'research/experiments', {manifest: manifest()})).status, 200);
    const listed = await ask(app, 'research/campaigns');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.scenarios.map(scenario => scenario.id), ['WAIT', 'CREATE_TEMP_ARTIFACT', 'HASH_TEMP_ARTIFACT', 'DELETE_TEMP_ARTIFACT', 'CHECKPOINT_DEMO']);
    assert.deepEqual(listed.body.experiments.map(experiment => experiment.experimentId), ['campaign-fixture']);
    assert.equal(listed.body.live.state, 'IDLE');
    assert.equal(listed.body.unfinished, false);

    const started = await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT'});
    assert.equal(started.status, 200);
    assert.equal(started.body.started.totalRuns, 3);
    // The campaign seed is a SHORT identity derived from the registered manifest, not the manifest itself. The first
    // physical campaign used the registry's `digest` field directly, which is a canonical serialisation rather than a
    // hash, so the seed contained the whole document (defect D-7).
    assert.match(started.body.started.campaignSeed, /^campaign-fixture@[0-9a-f]{32}$/);
    const campaignId = started.body.started.campaignId;

    const done = await workUntilSettled(app);
    assert.equal(done.state, 'COMPLETED');
    assert.equal(done.summary.measured, 3);
    assert.equal(done.summary.accounted, done.summary.planned, 'every planned repetition is accounted for');
    assert.equal(done.context.experimentId, 'campaign-fixture');
    // The measured outcomes come from the CANONICAL tasks, one per repetition, each carrying its run reference.
    const tasks = app.store.list('tasks');
    assert.equal(tasks.length, 3);
    for (const task of tasks) {
      assert.equal(task.state, 'COMPLETED');
      assert.equal(task.type, 'WAIT');
      assert.match(task.researchRunRef, new RegExp(`^${campaignId}:\\d$`));
    }
    assert.deepEqual(tasks.map(task => task.researchRunRef).sort(), [`${campaignId}:0`, `${campaignId}:1`, `${campaignId}:2`]);
    for (const run of done.measured) {
      assert.equal(typeof run.durationMs, 'number');
      assert.ok(run.seed >= 0);
      assert.ok(run.result.taskRef);
    }
    // The research trace carries one receipt per settled run, pointing at the canonical task it measured.
    await app.researchTrace.flush();
    const trace = (await ask(app, 'research/trace')).body.trace;
    const receipts = trace.records.filter(record => record.type === 'RESEARCH_RUN_RECEIPT');
    assert.equal(receipts.length, 3, 'one run receipt per repetition');
    for (const receipt of receipts) {
      assert.equal(receipt.dimensions.experimentRef, 'campaign-fixture');
      assert.match(receipt.dimensions.experimentRunRef, new RegExp(`^${campaignId}:\\d$`));
      assert.ok(tasks.some(task => task.id === receipt.canonicalRefs.taskRef), 'the receipt points at the real task');
      assert.equal(typeof receipt.metrics.latencyMs.value, 'number');
    }
    // The receipt survives the campaign, and the live view reports the same campaign.
    const filed = await ask(app, 'research/campaigns/' + campaignId);
    assert.equal(filed.status, 200);
    assert.equal(filed.body.campaign.summary.measured, 3);
    assert.equal(filed.body.campaign.context.manifest.softwareRefs[0].component, 'utopia');
    assert.match(filed.body.campaign.context.manifestIdentity, /^[0-9a-f]{32}$/, 'the receipt carries a short manifest identity, not the manifest');
    assert.equal((await ask(app, 'research/campaigns')).body.receipts.length, 1);
    // This surface never becomes a second task database: the tasks it created are ordinary City tasks.
    assert.equal(app.store.list('tasks').every(task => task.domain === 'system'), true);
    // REPRODUCIBILITY ON THE SAME MANIFEST: a second campaign of the same registered experiment derives the same seed
    // sequence, so the two campaigns are the same experiment rather than two experiment-shaped runs.
    const again = await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT', repetitions: 1});
    assert.equal(again.status, 200);
    assert.equal(again.body.started.campaignSeed, started.body.started.campaignSeed);
    await workUntilSettled(app);
  });
});

test('REX803 campaigns: the surface is owner-only, and every refusal is typed', async () => {
  await withCity(async app => {
    await registerWorker(app);
    await ask(app, 'research/experiments', {manifest: manifest()});
    // A node credential describes a worker and must not reach the campaign surface at all.
    assert.equal((await ask(app, 'research/campaigns', undefined, 'node')).status, 401);
    // An enrolled installation is a member, not the owner.
    const enrollment = (await ask(app, 'device/enroll', {displayName: 'Member'})).body;
    const session = (await ask(app, 'device/session', {installationId: enrollment.installation.installationId, instanceId: enrollment.installation.instanceId, ...enrollment.credential})).body.credential;
    const asMember = await ask(app, 'research/campaigns', undefined, session);
    assert.equal(asMember.status, 403);
    assert.equal(asMember.body.errorCode, 'RESEARCH_OWNER_REQUIRED');
    assert.equal((await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT'}, session)).status, 403);

    assert.equal((await ask(app, 'research/campaigns', {experimentId: 'no-such-experiment', scenarioId: 'WAIT'})).status, 404);
    assert.equal((await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'FLY_TO_MARS'})).body.errorCode, 'SCENARIO_UNKNOWN');
    assert.equal((await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT', repetitions: 9})).body.errorCode, 'REPETITIONS_EXCEED_DECLARED');
    assert.equal((await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT', repetitions: 0})).body.errorCode, 'REPETITIONS_INVALID');
    assert.equal((await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT', targetDeviceRef: 'some-other-pc'})).body.errorCode, 'INVALID_CAMPAIGN_TARGET');
    assert.equal((await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT', limits: {maxFailures: 99}})).body.errorCode, 'LIMITS_EXCEED_DECLARED');
    assert.equal((await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT', limits: {madeUp: 1}})).body.errorCode, 'LIMITS_INVALID');
    assert.equal((await ask(app, 'research/campaigns/campaign-00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await ask(app, 'research/campaigns/not-a-campaign')).body.errorCode, 'CAMPAIGN_UNKNOWN');
    // None of the refusals left a campaign behind that pretends to be running.
    assert.equal((await ask(app, 'research/campaigns')).body.live.state, 'IDLE');
    assert.equal(app.store.list('tasks').length, 0);
  });
});

test('REX803 campaigns: the topology gate is measured against live refs, and its refusal states what was missing', async () => {
  await withCity(async app => {
    await registerWorker(app);
    await ask(app, 'research/experiments', {manifest: manifest()});
    // The declared worker is online but the declared CONTROL SURFACE is not connected, so this topology is not here.
    const refused = await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT'});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.errorCode, 'TOPOLOGY_NOT_READY');
    assert.deepEqual(refused.body.detail.missing, ['web-fixture']);
    assert.equal(refused.body.detail.state, 'NOT_READY');
    const live = (await ask(app, 'research/campaigns')).body.live;
    assert.equal(live.state, 'REFUSED', 'a refused campaign is recorded rather than leaving no trace');
    assert.equal(live.reason, 'TOPOLOGY_NOT_READY');
    assert.equal(app.store.list('tasks').length, 0, 'a refused campaign must not create work');
  }, {surface: false});
});

test('REX803 campaigns: stopping cancels the canonical task the run had already created', async () => {
  await withCity(async app => {
    await registerWorker(app);
    await ask(app, 'research/experiments', {manifest: manifest()});
    // Nobody completes the work: the campaign sits inside its first repetition with a real task outstanding.
    const started = await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT'});
    assert.equal(started.status, 200);
    const campaignId = started.body.started.campaignId;
    let outstanding = null;
    for (let attempt = 0; attempt < 200 && !outstanding; attempt += 1) {
      outstanding = app.store.list('tasks').find(task => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.state)) ?? null;
      if (!outstanding) await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(outstanding, 'the campaign must have created a canonical task to observe');
    const stopped = await ask(app, 'research/campaigns/stop', {campaignId, reason: 'operator stopped the campaign'});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.stop.stopped, true);
    const settled = await workUntilSettled(app, {complete: false, deadlineMs: 5000});
    assert.equal(settled.state, 'STOPPED');
    assert.equal(settled.reason, 'operator stopped the campaign');
    assert.equal(settled.summary.measured, 0);
    assert.equal(settled.summary.accounted, settled.summary.planned);
    assert.equal(settled.summary.cancelled, 3);
    // The stop reached the WORK: no canonical task is left non-terminal by a stopped campaign.
    for (const task of app.store.list('tasks')) assert.equal(task.state, 'CANCELLED', `task ${task.id} was left ${task.state}`);
    // A campaign that is no longer running cannot be stopped, and a stale surface cannot stop a different one.
    const stale = await ask(app, 'research/campaigns/stop', {campaignId: 'campaign-00000000-0000-4000-8000-000000000000'});
    assert.equal(stale.body.stop.stopped, false);
    const afterStart = await ask(app, 'research/campaigns', {experimentId: 'campaign-fixture', scenarioId: 'WAIT', repetitions: 1});
    assert.equal(afterStart.status, 200, 'the City is usable again once the stopped campaign has drained');
    const mismatched = await ask(app, 'research/campaigns/stop', {campaignId: 'campaign-00000000-0000-4000-8000-000000000000'});
    assert.equal(mismatched.status, 409);
    assert.equal(mismatched.body.errorCode, 'CAMPAIGN_MISMATCH');
    await ask(app, 'research/campaigns/stop', {campaignId: afterStart.body.started.campaignId, reason: 'test cleanup'});
    await workUntilSettled(app, {complete: false, deadlineMs: 5000});
  });
});
