// MON-990 opposite-host review instruments (Mech). These are the reviewer's probes, not the author's, and they are
// aimed at the property this programme has found false four times: a surface that can look safe while it is missing
// information. Nothing here re-runs the author's suite; it drives the same real routes and the projection contract with
// inputs the author's fixtures do not use.
//
// Each probe states what its failure would mean, so a pass is a measurement and not a shrug.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {buildGraph} from '../services/dev-gateway/monitor-graph.mjs';

const H = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const withCity = async (fn, {before} = {}) => {
  const dir = await mkdtemp(resolve('.scratch-mon990-review-'));
  let app = null, browser = null;
  try {
    if (before) await before(dir);
    app = await createGateway({dir, port: 0, token: 'review-owner', nodeToken: 'review-node', roomsDisabled: true});
    const api = async (path, body) => {
      const response = await fetch(`${app.url}/api/v0/${path}`, {headers: {...H, Authorization: 'Bearer review-owner'}, ...(body ? {method: 'POST', body: JSON.stringify(body)} : {})});
      return {status: response.status, data: await response.json()};
    };
    browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
    return await fn({app, api, browser, dir});
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, {recursive: true, force: true});
  }
};
const openPage = async (browser, app, credential = 'review-owner') => {
  const page = await browser.newPage({locale: 'en-US'});
  page.setDefaultTimeout(12000);
  await page.goto(app.url);
  await page.locator('#token').fill(credential);
  await page.locator('#connect').click();
  await page.locator('#connection.online').waitFor();
  return page;
};

test('MON990 review R1: an unusable decision store is STATED on the surface, never shown as a calm empty window', async () => {
  // The defect shape this programme has recorded four times: absent data rendered as "nothing to see". A file where the
  // decision store belongs makes the overlay degrade; if the surface then says only "no decision has been recorded",
  // an owner reads that as "the City decided nothing" rather than "this City cannot record decisions right now".
  await withCity(async ({app, browser}) => {
    const page = await openPage(browser, app);
    await page.locator('nav [data-page="Monitor"]').click();
    await page.locator('.monitor-panel[data-loaded="true"]').waitFor();
    const link = page.locator('#view [data-page="Decisions"]');
    await link.click({timeout: 4000});
    // WAIT FOR THE PROJECTION, NOT FOR THE SHELL. The first version of this probe waited for `#monitor-decisions`,
    // which exists as soon as the page mounts with `data-loaded="false"`; on this reviewer's machine the fetch had
    // already resolved by then so the probe passed, and in CI it had not so the probe failed. That is the same
    // measurement defect MON-902's own browser probe had, found the same way - by CI disagreeing with a local pass.
    await page.locator('#monitor-decisions[data-loaded="true"]').waitFor();
    const text = await page.locator('#monitor-decisions').innerText();
    assert.match(text, /unavailable|not available|NOT_MEASURED|cannot/i,
      `the decision store is unusable and the surface says only: ${text.slice(0, 240)}`);
  }, {before: async dir => { await mkdir(dir, {recursive: true}); await writeFile(resolve(dir, 'monitor'), 'a file where the decision store directory belongs'); }});
});

test('MON990 review R2: the decision projection binds the canonical City and survives an observer failure', async () => {
  await withCity(async ({app, api}) => {
    assert.equal((await api('monitor/decisions')).data.cityId, app.store.cityId, 'the decision window must name the City it belongs to');
    // An observer that cannot answer must not take the decision surface or task creation with it.
    const refresh = app.observation.refresh;
    app.observation.refresh = async () => { throw Object.assign(new Error('CONTROLLED_OBSERVER_UNAVAILABLE'), {code: 'MONITOR_UNAVAILABLE'}); };
    try {
      const graph = await api('monitor/graph');
      assert.equal(graph.status, 500, 'an unavailable observer is a typed failure, not a quiet empty graph');
      const created = await api('tasks', {type: 'WAIT'});
      assert.equal(created.status, 200, 'canonical work must continue while the monitor is down');
      assert.equal(app.store.get('tasks', created.data.id).state, 'QUEUED');
      const decisions = await api('monitor/decisions');
      assert.equal(decisions.status, 200, 'the decision window is not downstream of the observer');
      assert.equal(decisions.data.cityId, app.store.cityId);
    } finally { app.observation.refresh = refresh; }
  });
});

test('MON990 review R3: with no coverage metadata at all, the summary reports a risk rather than a safe picture', async () => {
  // Module-level because this is the projection contract itself, and the route cannot be made to omit its own
  // completeness record. The claim under test is the one the programme keeps finding false: missing metadata is a
  // finding, not a zero.
  const view = {
    cityId: 'city-review', observedAt: '2026-10-06T00:00:00.000Z', projectedAt: '2026-10-06T00:00:01.000Z',
    health: 'COMPLETE', scope: null, eventSource: null,
    nodes: [{id: 't1', kind: 'TASK', state: 'COMPLETED', hostRef: null, taskType: 'WAIT'}],
    edges: [], events: [], evidence: [],
    // completeness DELIBERATELY ABSENT
  };
  const graph = buildGraph(view, {});
  assert.equal(graph.summary.activeRiskPresent, true, 'absent coverage metadata must raise a risk, not a calm summary');
  assert.equal(graph.summary.falseSafeSummary, false);
  assert.equal(graph.summary.unobserved.tasks, null, 'an unobserved count is null, never 0');
  assert.ok(graph.nodes.some(node => (node.riskReasons ?? []).some(reason => reason.code === 'WINDOW_INCOMPLETE')), 'the missing coverage must be named on the projection');
});

test('MON990 review R4: a collapsed view cannot hide the one node carrying an ACTIVE risk', async () => {
  const nodes = [];
  for (let n = 0; n < 200; n += 1) nodes.push({id: `t${n}`, kind: 'TASK', state: n === 137 ? 'FAILED' : 'COMPLETED', hostRef: null, taskType: 'WAIT'});
  const view = {
    cityId: 'city-review', observedAt: '2026-10-06T00:00:00.000Z', projectedAt: '2026-10-06T00:00:01.000Z',
    health: 'COMPLETE', scope: null, eventSource: null, nodes, edges: [], events: [], evidence: [],
    completeness: {tasksOmitted: 0, nodesOmitted: 0, eventsOmitted: 0, historyGap: false},
  };
  const graph = buildGraph(view, {maxVisibleNodes: 24});
  assert.ok(graph.clusters.length > 0, 'the fixture must actually collapse something');
  assert.equal(graph.summary.activeRiskPresent, true, 'a summary that hides an ACTIVE risk is the failure this task names');
  assert.ok(graph.visibleNodeIds.includes('t137'), 'the FAILED task must remain visible even inside a collapsed view');
  const visibleFailed = graph.nodes.find(node => node.id === 't137');
  assert.equal(visibleFailed.clusterRef ?? null, null, 'the risk-carrying node must not be absorbed into a cluster');
});

test('MON990 review R5: a decision receipt is advisory - it never moves the canonical task', async () => {
  await withCity(async ({app, api}) => {
    const created = await api('tasks', {type: 'WAIT'});
    assert.equal(created.status, 200);
    const submitted = await api('monitor/decisions', {kind: 'OWNER_DECISION_CANDIDATE', taskRef: created.data.id, reason: 'review probe'});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    await new Promise(r => setTimeout(r, 120));
    const window = await api('monitor/decisions');
    const row = window.data.window.decisions.find(decision => decision.taskRef === created.data.id);
    assert.ok(row, 'the decision must be recorded');
    assert.equal(row.appliedBy, null, 'a recommendation is not an action');
    assert.equal(row.application, 'RECORDED_ONLY');
    assert.equal(app.store.get('tasks', created.data.id).state, 'QUEUED', 'the canonical task must be exactly where it was');
  });
});

test('MON990 review R6: normal Web diagnosis reaches exact canonical evidence in THREE interactions', async () => {
  // The workbook's check 11 is a user-facing property - "normal diagnosis within 2-3 interactions to exact evidence" -
  // and a number like that is exactly the kind this programme has seen fabricated before. So it is counted here rather
  // than read: a canonical FAILED task is produced first, then the reviewer walks the surface and counts.
  await withCity(async ({app, api, browser}) => {
    const H_NODE = {...H, Authorization: 'Bearer review-node'};
    await api('node/register', {id: 'review-worker', displayName: 'Review worker', capabilities: ['task.execute.safe', 'filesystem.temp'], roles: ['EXECUTION_NODE'], metadata: {platform: 'win32'}});
    // register through the node credential so the City treats it as a real endpoint
    const registered = await fetch(`${app.url}/api/v0/node/register`, {method: 'POST', headers: H_NODE, body: JSON.stringify({id: 'review-worker', displayName: 'Review worker', capabilities: ['task.execute.safe', 'filesystem.temp'], roles: ['EXECUTION_NODE'], metadata: {platform: 'win32'}})});
    assert.equal(registered.status, 200);
    const created = await api('tasks', {type: 'WAIT'});
    const claim = await(await fetch(`${app.url}/api/v0/node/claim`, {method: 'POST', headers: H_NODE, body: JSON.stringify({id: 'review-worker'})})).json();
    const taskId = claim.task?.id ?? created.data.id;
    for (const state of ['RUNNING', 'FAILED']) {
      const reported = await fetch(`${app.url}/api/v0/node/report`, {method: 'POST', headers: H_NODE, body: JSON.stringify({id: 'review-worker', taskId, state, progress: 0, error: {code: 'REVIEW_PROBE_FAILURE', message: 'review probe'}})});
      assert.equal(reported.status, 200);
    }
    assert.equal(app.store.get('tasks', taskId).state, 'FAILED', 'the fixture needs a canonical FAILED task');

    const page = await openPage(browser, app);
    let interactions = 0;
    await page.locator('nav [data-page="Monitor"]').click();
    interactions += 1;
    await page.locator('.monitor-panel[data-loaded="true"]').waitFor();
    const nodeButton = page.locator(`[data-monitor-node="${taskId}"]`);
    await nodeButton.waitFor();
    await nodeButton.click();
    interactions += 1;
    const inspector = page.locator(`[data-inspector="${taskId}"]`);
    await inspector.waitFor();
    const riskText = await inspector.innerText();
    assert.match(riskText, /risk|failed|FAILED/i, `the inspector must show why this task is a risk: ${riskText.slice(0, 200)}`);
    const evidenceButton = inspector.locator('[data-evidence]').first();
    await evidenceButton.click();
    interactions += 1;
    const evidence = page.locator('#monitor-evidence pre');
    await evidence.waitFor();
    const payload = await evidence.innerText();
    assert.ok(payload.length > 0, 'the evidence panel must carry the canonical record');
    assert.match(payload, /REVIEW_PROBE_FAILURE|FAILED|canonical/i, `the evidence must be the canonical record, not a summary: ${payload.slice(0, 200)}`);
    assert.ok(interactions <= 3, `the diagnostics claim a 3-interaction budget and this walk took ${interactions}`);
  });
});


test('MON990 review R7: a node whose model/owner metadata was never observed is marked unknown, not filled in', async () => {
  // Workbook check 2: node owner/host/model metadata against runtime truth. The failure this looks for is a projection
  // that presents a plausible default where the runtime said nothing.
  const view = {
    cityId: 'city-review', observedAt: '2026-10-06T00:00:00.000Z', projectedAt: '2026-10-06T00:00:01.000Z',
    health: 'COMPLETE', scope: null, eventSource: null,
    nodes: [{id: 'host-unknown', kind: 'HOST', online: true}],
    edges: [], events: [], evidence: [],
    completeness: {tasksOmitted: 0, nodesOmitted: 0, eventsOmitted: 0, historyGap: false},
  };
  const graph = buildGraph(view, {});
  const host = graph.nodes.find(node => node.id === 'host-unknown');
  assert.ok(host, 'the host must appear');
  const serialised = JSON.stringify(host);
  for (const invented of ['model', 'owner', 'provider']) {
    assert.ok(!new RegExp(`"${invented}"\\s*:\\s*"[^"]`).test(serialised), `the projection invented a ${invented} the runtime never reported: ${serialised}`);
  }
});

test('MON990 review R8: an edge without a canonical reason says MISSING and carries no invented provenance', async () => {
  // Workbook check 3: edge reason against a real handoff/retry/review/routing event.
  const withReason = buildGraph({
    cityId: 'c', observedAt: 'o', projectedAt: 'p', health: 'COMPLETE', scope: null, eventSource: null,
    nodes: [{id: 't1', kind: 'TASK', state: 'RUNNING', hostRef: 'h1'}, {id: 'h1', kind: 'HOST', online: true}],
    edges: [{from: 't1', to: 'h1', type: 'ASSIGNED_TO', reason: 'TASK_ASSIGNED', targetPresent: true}],
    events: [{type: 'TASK_ASSIGNED', taskRef: 't1', canonicalEventId: 'e-1', evidenceRef: 'e-1'}],
    evidence: [], completeness: {tasksOmitted: 0, nodesOmitted: 0, eventsOmitted: 0, historyGap: false},
  }, {});
  const edge = withReason.edges[0];
  assert.equal(edge.reasonSource, 'CANONICAL');
  assert.equal(edge.incomplete, false);
  assert.ok((edge.evidenceRefs ?? []).includes('e-1'), 'the edge must carry the canonical event reference it came from');

  const withoutReason = buildGraph({
    cityId: 'c', observedAt: 'o', projectedAt: 'p', health: 'COMPLETE', scope: null, eventSource: null,
    nodes: [{id: 't1', kind: 'TASK', state: 'RUNNING', hostRef: 'h1'}, {id: 'h1', kind: 'HOST', online: true}],
    edges: [{from: 't1', to: 'h1', type: 'ASSIGNED_TO', reason: null, targetPresent: true}],
    events: [], evidence: [], completeness: {tasksOmitted: 0, nodesOmitted: 0, eventsOmitted: 0, historyGap: false},
  }, {});
  assert.equal(withoutReason.edges[0].reasonSource, 'MISSING');
  assert.equal(withoutReason.edges[0].incomplete, true, 'a path with no canonical reason is incomplete, not silently fine');
  assert.equal((withoutReason.edges[0].evidenceRefs ?? []).length, 0, 'no evidence may be invented for a missing reason');
});

test('MON990 review R9: a decision receipt records the canonical post-state it actually observed', async () => {
  // Workbook check 4: receipt against an actual state transition.
  await withCity(async ({app, api}) => {
    const H_NODE = {...H, Authorization: 'Bearer review-node'};
    await fetch(`${app.url}/api/v0/node/register`, {method: 'POST', headers: H_NODE, body: JSON.stringify({id: 'review-worker', displayName: 'W', capabilities: ['task.execute.safe', 'filesystem.temp'], roles: ['EXECUTION_NODE'], metadata: {platform: 'win32'}})});
    const created = await api('tasks', {type: 'WAIT'});
    const claim = await(await fetch(`${app.url}/api/v0/node/claim`, {method: 'POST', headers: H_NODE, body: JSON.stringify({id: 'review-worker'})})).json();
    const taskId = claim.task?.id ?? created.data.id;
    for (const state of ['RUNNING', 'FAILED']) await fetch(`${app.url}/api/v0/node/report`, {method: 'POST', headers: H_NODE, body: JSON.stringify({id: 'review-worker', taskId, state, progress: 0, error: {code: 'REVIEW_PROBE', message: 'probe'}})});
    const submitted = await api('monitor/decisions', {kind: 'FAILED', taskRef: taskId, reason: 'review probe'});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    await new Promise(r => setTimeout(r, 150));
    const row = (await api('monitor/decisions')).data.window.decisions.find(decision => decision.taskRef === taskId);
    assert.ok(row, 'the decision must be recorded');
    assert.equal(row.preState, 'FAILED', 'the pre-state is what the canonical store said at decision time');
    assert.equal(row.postState, app.store.get('tasks', taskId).state, 'the post-state must be what the canonical store actually held');
    assert.equal(row.postState, 'FAILED');
  });
});

test('MON990 review R10: an ordinary refresh does not reflow the graph, and a filter changes the drawn edges only', async () => {
  // Workbook check 10: large-graph collapse/filter/stable layout. Stability is a stated requirement, so it is measured
  // as an equality between two projections of the same structure rather than as a promise in a comment.
  const view = () => ({
    cityId: 'c', observedAt: 'o', projectedAt: 'p', health: 'COMPLETE', scope: null, eventSource: null,
    nodes: [{id: 't1', kind: 'TASK', state: 'RUNNING', hostRef: 'h1'}, {id: 'h1', kind: 'HOST', online: true}],
    edges: [{from: 't1', to: 'h1', type: 'ASSIGNED_TO', reason: 'TASK_ASSIGNED', targetPresent: true}, {from: 't1', to: 'h1', type: 'RETRY_PATH', reason: 'x', targetPresent: true}],
    events: [], evidence: [], completeness: {tasksOmitted: 0, nodesOmitted: 0, eventsOmitted: 0, historyGap: false},
  });
  const first = buildGraph(view(), {});
  const second = buildGraph(view(), {});
  assert.equal(first.layout.reflowKey, second.layout.reflowKey, 'two projections of the same structure must share a reflow key, or every refresh reflows the graph');
  assert.deepEqual(first.visibleNodeIds, second.visibleNodeIds);
  const filtered = buildGraph(view(), {edgeTypes: ['ASSIGNED_TO']});
  assert.equal(filtered.edges.length, 1, 'the edge filter must change the drawn paths');
  assert.deepEqual(filtered.visibleNodeIds, first.visibleNodeIds, 'and it must not change which nodes are visible');
});

test('MON990 review R11: a stuck resolver blocks only its own task, and the timeout is attributed', async () => {
  // Workbook check 7: a decision timeout affects only the target task. The reviewer drives the accepted MON-903
  // overlay directly with an injected resolver that never answers, because the route does not accept resolver
  // injection and a fixture that cannot hang cannot test a timeout.
  const {createDecisionOverlay} = await import('../services/dev-gateway/decision.mjs');
  const dir = await mkdtemp(resolve('.scratch-mon990-review-r11-'));
  let release;
  const hang = new Promise(resolveHang => { release = resolveHang; });
  const overlay = createDecisionOverlay({
    dir,
    tasks: () => [{id: 'stuck', state: 'FAILED'}, {id: 'other', state: 'RUNNING'}],
    fastModel: async () => { await hang; return {action: 'DEFER_TO_SCHEDULER'}; },
    clock: () => Date.now(),
    stageTimeoutMs: 200,
  });
  try {
    const stuck = overlay.submit({kind: 'FAILED', taskRef: 'stuck', origin: 'SUBMITTED'});
    const other = overlay.submit({kind: 'RESOURCE_CONFLICT', taskRef: 'other', origin: 'SUBMITTED'});
    await new Promise(r => setTimeout(r, 700));
    const decisions = overlay.snapshot(50).decisions;
    const otherRow = decisions.find(row => row.decisionId === other.decisionId);
    const stuckRow = decisions.find(row => row.decisionId === stuck.decisionId);
    assert.ok(otherRow, 'the unrelated task must still get its decision');
    assert.equal(otherRow.action, 'DEFER_TO_SCHEDULER', 'the unrelated task was resolved by its own rule, not held behind the stuck one');
    assert.ok(stuckRow, 'the stuck task must end in a recorded outcome rather than hanging the queue');
    assert.equal(stuckRow.ownerRequired, true, 'an undecidable trigger escalates rather than being invented');
    assert.ok((stuckRow.timeoutOrFallback ?? []).includes('RESOLVER_TIMEOUT'), 'the timeout must be attributed on the receipt');
    assert.notEqual(otherRow.taskRef, stuckRow.taskRef);
  } finally { release(); await rm(dir, {recursive: true, force: true}); }
});
