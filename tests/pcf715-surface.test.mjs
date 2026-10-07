// PCF-715 workbook acceptance surface.
// Workbook: dc/mission-book/mission-group/personal-compute-fabric/PCF-715-resource-control-and-monitor.md
// Real surface under test: services/personal-compute-fabric/presentation.mjs (the projection) and
// apps/web/pcf-panel.js (the rendered panel). tests/pcf715-controls.test.mjs and
// tests/pcf715-web-controls.test.mjs already own the control-form and browser paths, so this file covers
// the workbook's own acceptance list: the read-only projection, the forbidden execution lock, upward
// propagation of unknown/partial/active-risk values, honest disabled controls when a backend capability is
// absent, and the guarantee that a UI projection is neither the scheduler nor a second task truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderFabricPanel} from '../apps/web/pcf-panel.js';
import {buildFabricProjection} from '../services/personal-compute-fabric/presentation.mjs';
import {createGateway} from '../services/dev-gateway/server.mjs';

const snapshot = {version: 7, reservations: [{id: 'R-1'}], attempts: [{id: 'X-1', state: 'RUNNING'}, {id: 'X-2', state: 'SUCCEEDED'}]};
const pcfTask = overrides => ({id: 'T-1', executionBackendId: 'pcf-v1', pcfAppId: 'cpu-sum', state: 'RUNNING', parentSessionId: 'owner', originDeviceId: 'host', ...overrides});
const running = (tasks = [], extra = {}) => buildFabricProjection(snapshot, {backendConfigured: true, serviceState: 'RUNNING', tasks, ...extra});

// Workbook line 45: the normal entry point is the existing Settings/Advanced area, not a new row of
// top-level apps.
test('715 entry stays in the existing Settings/Advanced surface and adds no parallel top-level navigation', async () => {
  const app = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  const settingsIndex = app.indexOf("if(page==='Settings')$('#view').innerHTML=");
  assert.ok(settingsIndex > 0, 'the fabric panel is rendered from the existing Settings page branch');
  assert.ok(app.slice(settingsIndex, settingsIndex + 300).includes('renderFabricPanel('), 'Settings/Advanced is the entry point');
  const panel = renderFabricPanel(running([pcfTask()]), 'en');
  assert.ok(panel.startsWith('<details id="pcf-panel"><summary>'), 'the entry is an advanced disclosure, not a navigation row');
  assert.ok(!/data-page=/.test(panel), 'the panel adds no navigation entry');
});

// Workbook line 48: the projection is read-only; a UI projection holds no authority over execution.
test('715 projection is read-only: no execution authority in its value, no mutation of canonical input, immutable output', () => {
  const input = {version: 3, reservations: [{id: 'R-1'}], attempts: [{id: 'X-1', state: 'RUNNING'}]};
  const before = structuredClone(input);
  const projection = buildFabricProjection(input, {backendConfigured: true, serviceState: 'RUNNING', tasks: [pcfTask()]});
  assert.deepEqual(input, before, 'building the projection never mutates canonical state');
  assert.ok(Object.isFrozen(projection) && Object.isFrozen(projection.controls) && Object.isFrozen(projection.tasks));
  assert.equal(Object.values(projection).some(value => typeof value === 'function'), false, 'the projection exposes no callable authority');
  assert.deepEqual(buildFabricProjection(input, {backendConfigured: true, serviceState: 'RUNNING', tasks: [pcfTask()]}), projection, 'a repeated read is deterministic and decides nothing');
});

// Workbook line 48: a disconnected or absent Monitor/REX projection cannot lock execution and cannot invent
// a measurement while it is gone.
test('715 a missing projection renders an honest unavailable panel instead of throwing, locking or inventing zero', () => {
  for (const absent of [null, undefined]) {
    const html = renderFabricPanel(absent, 'en');
    assert.ok(html.includes('Fabric status is unavailable to this identity'), 'absence is stated, not faked');
    assert.ok(!html.includes('<form') && !/data-pcf-action/.test(html), 'no control is offered while the projection is absent');
  }
  const partial = renderFabricPanel({state: 'CANDIDATE_PENDING_VERIFICATION'}, 'en');
  assert.ok(partial.includes('CANDIDATE_PENDING_VERIFICATION'));
  assert.ok(!/\b0\b/.test(partial), 'an unmeasured value stays blank; it is never rendered as 0');
});

// Workbook line 46: no backend capability means an explicit disabled control and honest reason - never a
// fake button for sharing/drain/quota/protection/consent/revoke/profile.
test('715 absent backend capability keeps one explicitly disabled control and renders no fake button', () => {
  const absent = buildFabricProjection(snapshot, {backendConfigured: false});
  assert.equal(absent.controls.enabled, false);
  assert.equal(absent.controls.reason, 'NOT_CONFIGURED');
  const absentHtml = renderFabricPanel(absent, 'en');
  assert.equal((absentHtml.match(/<button/g) ?? []).length, 1);
  assert.ok(absentHtml.includes('<button disabled>Local service is not enabled</button>'));
  assert.ok(!absentHtml.includes('<form') && !/data-pcf-action/.test(absentHtml));
  for (const serviceState of ['DRAINING', 'STOPPED', 'READY_NOT_STARTED', null]) {
    const projection = buildFabricProjection(snapshot, {backendConfigured: true, serviceState});
    assert.equal(projection.controls.enabled, false, 'controls stay disabled while the service is not RUNNING: ' + String(serviceState));
    assert.equal(projection.controls.reason, 'OPPOSITE_HOST_ACCEPTANCE_PENDING');
    const html = renderFabricPanel(projection, 'en');
    assert.ok(html.includes('<button disabled>'));
    for (const capability of ['sharing', 'drain', 'quota', 'foreground', 'protection', 'consent', 'revoke', 'rollback', 'profile']) {
      assert.ok(!new RegExp('<button[^>]*>[^<]*' + capability, 'i').test(html), 'no fake ' + capability + ' button');
    }
  }
});

// Workbook spec revision 2, line 56: sharingEnabled=true alone must not claim active compute contribution,
// and the six states are separate readings rather than one green light.
test('715 sharing does not imply executor readiness and the six states stay separate', () => {
  const projection = buildFabricProjection(snapshot, {
    backendConfigured: true,
    serviceState: 'READY_NOT_STARTED',
    sharingEnabled: true,
    node: {sharingEnabled: true, executorReady: false},
    tasks: [pcfTask({state: 'COMPLETED', pcfDeliveredSessionId: 'owner'})],
  });
  assert.equal(projection.sharingDoesNotImplyExecutionReadiness, true);
  assert.equal(projection.controls.enabled, false, 'sharingEnabled alone must not enable compute controls');
  assert.equal(projection.running, 1, 'running is bound to measured attempts, not to sharing');
  assert.equal(projection.reservations, 1);
  assert.equal(projection.resultReturned, 1);
  assert.equal(projection.callerAcknowledged, 0);
  assert.equal(projection.agentConsumed, 'NOT_OBSERVED', 'an unobserved consumption is a named state, not 0 or false');
  assert.notEqual(projection.agentConsumed, 0);
  assert.ok(renderFabricPanel(projection, 'en').includes('sharing does not imply executor readiness'));
});

// Workbook line 47 + revision 2 line 56: UNKNOWN is not zero, and an unknown task state reaches the panel.
test('715 unknown values travel upward: an unknown task state is shown verbatim instead of being hidden', () => {
  const projection = running([pcfTask({state: 'UNKNOWN'})]);
  assert.equal(projection.tasks[0].state, 'UNKNOWN');
  assert.ok(renderFabricPanel(projection, 'en').includes('cpu-sum · UNKNOWN'));
});

// Workbook line 47: "unknown, stale, partial data and active risk must propagate upward". The canonical risk field
// written by admission.commitResult for an uncertain side effect is pcfAttention. FIXED: the projection now carries it.
test('715 active canonical risk bubbles to the overview', () => {
  const projection = running([pcfTask({pcfAttention: 'SIDE_EFFECT_UNKNOWN'})]);
  assert.ok(JSON.stringify(projection).includes('SIDE_EFFECT_UNKNOWN'), 'the canonical risk reason must reach the overview');
  assert.equal(projection.activeRisk.present, true);
  assert.equal(projection.activeRisk.count, 1);
  assert.equal(projection.activeRisk.bubblesToOverview, true);
  assert.deepEqual(projection.activeRisk.items, [{id: projection.activeRisk.items[0].id, state: 'RUNNING', attention: 'SIDE_EFFECT_UNKNOWN'}]);
  // The panel that consumes the projection shows it too, so the bubble does not stop at the JSON boundary.
  assert.ok(renderFabricPanel(projection, 'en').includes('SIDE_EFFECT_UNKNOWN'), 'the rendered panel shows the risk');
  // A calm fleet says so explicitly rather than leaving the field absent.
  assert.equal(running([]).activeRisk.present, false);
  assert.equal(running([]).activeRisk.bubblesToOverview, true);
});

// Workbook line 47: partial/stale observations must bubble upward rather than break the overview read.
// FIXED: a partial canonical snapshot is reported as PARTIAL/UNKNOWN instead of throwing a raw TypeError.
test('715 partial canonical data bubbles upward instead of crashing the overview read', () => {
  const partial = buildFabricProjection({version: 3, attempts: []}, {});
  assert.equal(partial.completeness, 'PARTIAL', 'a partial snapshot is reported as partial');
  assert.equal(partial.unknown.reservations, true, 'the missing half is named as unknown, not read as zero');
  assert.equal(partial.unknown.attempts, false);
  assert.equal(partial.unknown.reason, 'CANONICAL_STATE_INCOMPLETE');
  // An unreadable snapshot does not become an idle-looking one, and the read still completes.
  assert.equal(partial.reservations, 0);
  assert.equal(buildFabricProjection({}, {}).completeness, 'PARTIAL');
  assert.equal(buildFabricProjection(undefined, {}).completeness, 'PARTIAL');
  assert.equal(buildFabricProjection({version: 3, reservations: [], attempts: []}, {}).completeness, 'COMPLETE');
  assert.equal(buildFabricProjection({version: 3, reservations: [], attempts: []}, {}).unknown.reason, null);
});

// Workbook line 48: UI changes must not alter scheduler order or create a second task truth. The gateway
// feed is the real read path the panel consumes.
test('715 UI reads and panel re-renders create no second task truth and do not reorder the scheduler feed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf715-surface-'));
  let city;
  try {
    city = await createGateway({dir, port: 0, token: 'pcf715-owner', nodeToken: 'pcf715-node', hostDeviceId: 'pcf715-host', roomsDisabled: true, pcf: {enabled: true, approvedLocalContext: {deviceId: 'pcf715-host'}}});
    const get = async path => {
      const response = await fetch(city.url + path, {headers: {Authorization: 'Bearer pcf715-owner', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'}});
      assert.equal(response.status, 200, path);
      return response.json();
    };
    const feedBefore = await get('/api/v0/presentation');
    const fabric = (await get('/api/v0/pcf')).fabric;
    assert.equal(fabric.controls.scope, 'APPROVED_LOCAL_CPU_ONLY', 'only the approved local CPU backend is exposed');
    assert.equal(fabric.controls.enabled, true, 'the approved local service is running, so its local controls exist');
    assert.equal(fabric.controls.reason, 'OPPOSITE_HOST_ACCEPTANCE_PENDING', 'opposite-host capability stays unclaimed');
    const auxiliaryBefore = city.store.db.prepare("SELECT value FROM settings WHERE key='pcf.execution.v1'").get();
    for (let index = 0; index < 5; index += 1) {
      renderFabricPanel(fabric, 'en', '9,6,5', 'cpu-sum', 'stale-output');
      renderFabricPanel(fabric, 'zh-CN');
    }
    await get('/api/v0/pcf');
    assert.deepEqual({...await get('/api/v0/presentation'), generatedAt: null}, {...feedBefore, generatedAt: null}, 'a read-only projection cannot reorder the scheduler feed');
    assert.equal(city.store.list('tasks').length, 0, 'a UI read creates no canonical task');
    assert.equal(city.store.list('actions').length, 0, 'a UI read creates no canonical action');
    const auxiliaryAfter = city.store.db.prepare("SELECT value FROM settings WHERE key='pcf.execution.v1'").get();
    assert.deepEqual(auxiliaryAfter, auxiliaryBefore, 'a UI read writes no auxiliary state');
    assert.equal(Object.hasOwn(JSON.parse(auxiliaryAfter.value), 'tasks'), false, 'the auxiliary canonical state holds reservations/attempts, never a second task list');
  } finally {
    await city?.close();
    await rm(dir, {recursive: true, force: true});
  }
});
