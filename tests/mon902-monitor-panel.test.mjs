// MON-902: the monitor surface must be readable by a person and must not overclaim about a city it can only partly see.
//
// The rules asserted here are the workbook's, not the implementation's shape:
//   - active risk is VISIBLE on the overview without opening anything;
//   - raw projection vocabulary never renders outside the explicit Technical details disclosure;
//   - a calm banner is never printed over a city the projection admits it cannot see;
//   - a task's paths are reachable from the task, within the interaction budget;
//   - both locales carry every word the surface uses, including every risk code;
//   - the page is wired to the REAL gateway route, not to a fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {buildGraph} from '../services/dev-gateway/monitor-graph.mjs';
import {monitorOverview, monitorNodePanel, monitorPathPanel, RISK_CODES, NEXT_STEP, esc} from '../apps/web/monitor-graph.js';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {configureRuntime, getLocale, resetLocaleCache, t} from '../apps/web/i18n/index.js';

const useLocale = locale => { configureRuntime({storage: null, navigator: {language: locale}}); resetLocaleCache(); };
useLocale('en');

const completeness = (over = {}) => ({tasksOmitted: 0, nodesOmitted: 0, eventsOmitted: 0, historyGap: false, firstSeq: 1, lastSeq: 3, canonicalHighWatermark: 3, continuous: true, ...over});
const view = (over = {}) => ({
  schemaVersion: 1, authoritative: false, eventSource: 'CANONICAL_GATEWAY_STORE', cityId: 'city-1', health: 'COMPLETE',
  scope: 'BOUNDED_CANONICAL_WINDOW', safeSummaryAvailable: false, unobservedTaskRisk: false, nodes: [], edges: [], events: [],
  evidence: [], observedAt: '2026-10-05T10:00:00.000Z', projectedAt: '2026-10-05T10:00:00.050Z', projectionLatencyMs: 50,
  completeness: completeness(), ...over,
});
const task = (id, state, over = {}) => ({kind: 'TASK', id, state, taskType: 'city-task', hostRef: null, ownerRef: null, ownerObservability: 'NOT_OBSERVABLE', progress: null, ...over});
const host = (id, online) => ({kind: 'HOST', id, displayName: id, online});

/** Everything a person can read without expanding the disclosure. */
const visible = html => html.replace(/<details[\s\S]*?<\/details>/g, '');

test('MON-902 panel: an active risk is visible on the overview without opening anything', () => {
  const graph = buildGraph(view({nodes: [task('t1', 'FAILED', {taskType: 'Image render'})]}));
  const html = monitorOverview(graph);
  assert.match(html, /monitor-banner alert/);
  assert.match(html, /Things need attention/);
  assert.match(html, /This task failed/, 'the reason is in user language, not a token');
  assert.match(html, /data-monitor-node="t1"/, 'the row is the control that opens the inspector');
  assert.match(html, /At risk now/);
});

test('MON-902 panel: raw projection vocabulary does not render outside the disclosure', () => {
  const graph = buildGraph(view({
    health: 'PARTIAL',
    nodes: [task('t1', 'FAILED'), task('t2', 'WAITING_CONFIRMATION'), host('h1', false)],
    edges: [{from: 't2', to: 'h1', type: 'ASSIGNED_TO', reason: null, targetPresent: false}],
    completeness: completeness({tasksOmitted: 4, historyGap: true}),
  }));
  const html = visible(monitorOverview(graph));
  for (const code of RISK_CODES) assert.doesNotMatch(html, new RegExp(code), `${code} leaked into the readable page`);
  assert.doesNotMatch(html, /PARTIAL/, 'the health token is not user language');
  assert.doesNotMatch(html, /WAITING_CONFIRMATION/);
  assert.doesNotMatch(html, /NOT_OBSERVABLE/);
  // ...but the exact fields ARE available in the disclosure, which is the whole point of an explicit gate.
  assert.match(monitorOverview(graph), /monitor-technical/);
  // The disclosure is escaped HTML like everything else, so the field name is asserted in its escaped form.
  assert.match(monitorOverview(graph), /authoritative/, 'the disclosure carries the projection\'s own provenance');
  assert.match(monitorOverview(graph), /&quot;authoritative&quot;: false/);
});

test('MON-902 panel: a calm banner is never printed over a city the projection cannot see', () => {
  const blind = buildGraph(view({health: 'PARTIAL', completeness: completeness({tasksOmitted: 9, historyGap: true})}));
  const html = visible(monitorOverview(blind));
  assert.match(html, /What this picture cannot tell you/);
  assert.match(html, /Some tasks exist that this picture does not contain/, 'the blind spot is stated in plain words');
  assert.match(html, /Whether anything has been retrying cannot be told from this window/);

  // A complete, quiet city is the only case allowed to read as calm. The permanent limitation of the observation model
  // (Owner gates are not projected) is still stated - quietly, as scope - rather than dropped or shouted.
  const quiet = visible(monitorOverview(buildGraph(view({nodes: [task('t1', 'RUNNING')]}))));
  assert.match(quiet, /Nothing is failing or blocked/);
  assert.doesNotMatch(quiet, /What this picture cannot tell you/, 'no invented incident on a complete window');
  assert.match(quiet, /Always true of this monitor/, 'the standing limitation is still disclosed');
  assert.match(quiet, /Whether the owner is needed cannot be told from here/);
  assert.match(monitorOverview(buildGraph(view({nodes: [task('t1', 'WAITING_CONFIRMATION')]}))), /Owner action is visible only where a task is waiting for confirmation/);
});

test('MON-902 panel: a collapsed cluster still reports the risk it contains', () => {
  const nodes = [task('risky', 'FAILED')];
  for (let i = 0; i < 200; i += 1) nodes.push(task(`ok-${i}`, 'RUNNING'));
  const graph = buildGraph(view({nodes}), {maxVisibleNodes: 50});
  const html = visible(monitorOverview(graph));
  assert.match(html, /monitor-cluster/);
  assert.match(html, /Collapsed/);
  assert.match(html, /200/, 'the number of collapsed tasks is stated');
  assert.match(html, /data-monitor-node="risky"/, 'the risk itself is never collapsed away');
});

test('MON-902 panel: the node inspector answers what, why, who and what-next, and keeps the exact reference', () => {
  const graph = buildGraph(view({nodes: [task('t1', 'FAILED', {taskType: 'Image render', hostRef: 'h1'}), host('h1', true)], edges: [{from: 't1', to: 'h1', type: 'ASSIGNED_TO', reason: 'Canonical task.assignedNodeId', targetPresent: true}]}));
  const html = visible(monitorNodePanel(graph, 't1'));
  assert.match(html, /Details/);
  for (const label of ['What', 'Why', 'Who', 'What next']) assert.match(html, new RegExp(label));
  assert.match(html, /Image render/);
  assert.match(html, /Assigned to/);
  assert.match(html, /Open the task to see what it reported/, 'the next step is stated rather than left to the reader');
  assert.match(html, /data-monitor-edge="/, 'the task\'s paths are reachable from the task');
  assert.match(html, /Evidence/, 'the canonical reference is offered next to the claim');
  assert.match(monitorNodePanel(graph, 't1'), /riskReasons/, 'the raw node is in the disclosure');
  assert.match(visible(monitorNodePanel(graph, 't1')), /This task failed/);
  assert.doesNotMatch(visible(monitorNodePanel(graph, 't1')), /TASK_FAILED/, 'the code stays behind the gate');
});

test('MON-902 panel: a path with no stated cause is shown as unexplained, not as fine', () => {
  const graph = buildGraph(view({nodes: [task('t1', 'RUNNING'), host('h1', true)], edges: [{from: 't1', to: 'h1', type: 'ASSIGNED_TO', reason: null, targetPresent: true}]}));
  const edgeId = graph.edges[0].id;
  const html = visible(monitorPathPanel(graph, edgeId));
  assert.match(html, /the city did not state why this path exists/);
  assert.match(html, /treat it as unexplained rather than as fine/);
  assert.match(html, /Path/);

  const absent = buildGraph(view({nodes: [task('t1', 'RUNNING', {hostRef: 'ghost'})], edges: [{from: 't1', to: 'ghost', type: 'ASSIGNED_TO', reason: 'Canonical task.assignedNodeId', targetPresent: false}]}));
  const absentHtml = visible(monitorPathPanel(absent, absent.edges[0].id));
  assert.match(absentHtml, /not in this picture/);
});

test('MON-902 panel: a stale selection says so instead of rendering an empty panel', () => {
  const graph = buildGraph(view({nodes: [task('t1', 'RUNNING')]}));
  assert.match(monitorNodePanel(graph, 'gone'), /no longer in this picture/);
  assert.match(monitorPathPanel(graph, 'gone'), /no longer in this picture/);
});

test('MON-902 panel: ids and labels from the city are escaped in text and attribute positions', () => {
  const nasty = 't1"><script>alert(1)</script>';
  const graph = buildGraph(view({nodes: [task(nasty, 'FAILED', {taskType: '<img src=x onerror=alert(1)>'})]}));
  const html = monitorOverview(graph);
  assert.doesNotMatch(html, /<script>/, 'a task id cannot become markup');
  assert.doesNotMatch(html, /<img src=x/, 'a task label cannot become markup');
  assert.match(html, /&lt;script&gt;/);
  assert.equal(esc('<&">\''), '&lt;&amp;&quot;&gt;&#39;');
});

test('MON-902 panel: every word the surface uses exists in both locale packs, including every risk code', async () => {
  const en = (await import('../apps/web/i18n/en.js')).messages;
  const zh = (await import('../apps/web/i18n/zh-CN.js')).messages;
  const used = new Set(['nav.monitor', 'heading.monitor', 'monitor.title', 'monitor.error', 'monitor.refresh']);
  const source = readFileSync(resolve(import.meta.dirname, '..', 'apps', 'web', 'monitor-graph.js'), 'utf8');
  // Literal keys, minus the ones the file composes at runtime (which are added explicitly below).
  for (const match of source.matchAll(/'monitor\.[A-Za-z0-9._]+'/g)) {
    const key = match[0].slice(1, -1);
    if (!key.endsWith('.')) used.add(key);
  }
  for (const code of RISK_CODES) used.add(`monitor.risk.${code}`);
  for (const step of Object.values(NEXT_STEP)) used.add('monitor.' + step);
  for (const state of ['FAILED', 'REFUSED', 'UNAVAILABLE', 'WAITING_CONFIRMATION', 'RUNNING', 'QUEUED', 'SUCCEEDED', 'CANCELLED', 'ONLINE', 'OFFLINE', 'UNKNOWN', 'COMPLETE', 'PARTIAL', 'DISCONNECTED']) used.add(`monitor.state.${state}`);
  for (const kind of ['TASK', 'HOST', 'OBSERVATION']) used.add(`monitor.kind.${kind}`);
  const missingEn = [...used].filter(key => !en[key]);
  const missingZh = [...used].filter(key => !zh[key]);
  assert.deepEqual(missingEn, [], 'English copy is missing');
  assert.deepEqual(missingZh, [], 'Chinese copy is missing');

  useLocale('zh-CN');
  const chinese = visible(monitorOverview(buildGraph(view({nodes: [task('t1', 'FAILED')]}))));
  assert.match(chinese, /全城监视器/);
  assert.match(chinese, /该任务失败/);
  assert.doesNotMatch(chinese, /This task failed/);
  useLocale('en');
});

test('MON-902 panel: the shell exposes the page and fetches the real route', () => {
  const shell = readFileSync(resolve(import.meta.dirname, '..', 'apps', 'web', 'index.html'), 'utf8');
  assert.match(shell, /data-page="Monitor"/);
  assert.match(shell, /data-i18n="nav.monitor"/);
  const app = readFileSync(resolve(import.meta.dirname, '..', 'apps', 'web', 'app.js'), 'utf8');
  assert.match(app, /from '\.\/monitor-graph\.js'/);
  const monitor=readFileSync(resolve(import.meta.dirname, '..', 'apps', 'web', 'monitor-graph.js'),'utf8');
  assert.match(monitor, /api\(filter==='ALL'\?'monitor\/graph'/, 'the page controller reads the canonical projection route, not a local copy');
  assert.match(app, /if\(page==='Monitor'\)renderMonitor\(\)/);
  // No id may be duplicated in the shell document: a second #view would silently split the page.
  const ids = [...shell.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'the shell document has duplicate ids');
});

test('MON-902 panel: the page is wired to the real gateway projection route end to end', async () => {
  const dir = await mkdtemp(resolve('.scratch-mon902-'));
  const app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
  try {
    const headers = {'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', Authorization: 'Bearer owner'};
    const created = await fetch(app.url + '/api/v0/tasks', {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify({type: 'WAIT'})});
    assert.equal(created.ok, true, 'the fixture needs one real canonical task: ' + await created.text());
    const response = await fetch(app.url + '/api/v0/monitor/graph', {headers});
    assert.equal(response.status, 200);
    const {graph} = await response.json();
    assert.equal(graph.authoritative, false, 'the monitor is a projection and the API says so');
    assert.equal(graph.projectionOf.cityId, app.store.cityId);
    assert.ok(graph.nodes.some(node => node.kind === 'TASK'), 'the graph describes the real canonical task');
    // The rendered page is built from THAT payload, so the surface cannot drift from the route it claims to read.
    assert.match(monitorOverview(graph), /monitor-panel/);
    const filtered = await fetch(app.url + '/api/v0/monitor/graph?edges=NOT_A_TYPE', {headers});
    assert.deepEqual((await filtered.json()).graph.edges, [], 'the edge filter is applied by the real route');
    assert.equal((await fetch(app.url + '/api/v0/monitor/graph?collapse=0', {headers})).status, 400, 'an unbounded collapse is refused rather than honoured');
    assert.equal((await fetch(app.url + '/api/v0/monitor/graph')).status, 401, 'the graph is not readable without a credential');
  } finally { await app.close(); await rm(dir, {recursive: true, force: true}); }
});
