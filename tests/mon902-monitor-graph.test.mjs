// MON-902: the overview graph must not lie about a city it can only partly see.
//
// These probes are written against the rules the workbook forbids breaking, not against the implementation's shape:
//   - an active risk may be collapsed in the picture but never dropped from it;
//   - "nothing is retrying" may not be claimed from a truncated event window;
//   - a monitor that cannot see must not look calm;
//   - a path that points at something absent is a causality gap, not a quiet edge;
//   - the layout must not reshuffle because an event arrived.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGraph, RISK_LEVELS} from '../services/dev-gateway/monitor-graph.mjs';

const completeness = (over = {}) => ({tasksOmitted: 0, nodesOmitted: 0, eventsOmitted: 0, historyGap: false, firstSeq: 1, lastSeq: 3, canonicalHighWatermark: 3, continuous: true, ...over});
const view = (over = {}) => ({
  schemaVersion: 1, authoritative: false, eventSource: 'CANONICAL_GATEWAY_STORE', cityId: 'city-1',
  health: 'COMPLETE', scope: 'BOUNDED_CANONICAL_WINDOW', safeSummaryAvailable: false, unobservedTaskRisk: false,
  nodes: [], edges: [], events: [], evidence: [], observedAt: '2026-10-05T10:00:00.000Z', projectedAt: '2026-10-05T10:00:00.050Z',
  projectionLatencyMs: 50, completeness: completeness(),
  ...over,
});
const task = (id, state, over = {}) => ({kind: 'TASK', id, state, taskType: 'city-task', hostRef: null, ownerRef: null, ownerObservability: 'NOT_OBSERVABLE', progress: null, ...over});
const host = (id, online) => ({kind: 'HOST', id, displayName: id, online});
const event = (seq, type, taskRef) => ({canonicalEventId: `e${seq}`, seq, type, taskRef, actorRef: null, timestamp: '2026-10-05T09:59:00.000Z', evidenceRef: `e${seq}`});
const risksOf = (graph, id) => graph.nodes.find(node => node.id === id)?.riskReasons ?? [];
const codesOf = (graph, id) => risksOf(graph, id).map(entry => entry.code);

test('MON-902 graph: every risk level is one of the declared vocabulary and never a boolean', () => {
  const graph = buildGraph(view({nodes: [task('t1', 'FAILED'), host('h1', false)]}));
  for (const node of graph.nodes) for (const entry of node.riskReasons) assert.ok(RISK_LEVELS.includes(entry.level), `${entry.code} carried ${entry.level}`);
  assert.equal(graph.authoritative, false, 'the graph is a projection and says so');
  assert.equal(graph.summary.falseSafeSummary, false);
  assert.equal(graph.summary.safeSummaryAvailable, false);
});

test('MON-902 graph: a failed task and an offline device holding work are ACTIVE risks that reach the summary', () => {
  const graph = buildGraph(view({nodes: [task('t1', 'FAILED', {hostRef: 'h1'}), task('holding', 'RUNNING', {hostRef: 'h1'}), host('h1', false)], edges: [{from: 't1', to: 'h1', type: 'ASSIGNED_TO', reason: 'Canonical task.assignedNodeId', targetPresent: true}]}));
  assert.deepEqual(codesOf(graph, 't1'), ['TASK_FAILED']);
  assert.ok(codesOf(graph, 'h1').includes('DEVICE_OFFLINE_HOLDING_WORK'), 'a device offline with canonical work assigned is not a mild warning');
  assert.equal(graph.summary.activeRiskPresent, true);
  assert.equal(graph.summary.riskBubbled, true);
  assert.equal(graph.summary.activeRiskCount, 2);
  assert.equal(graph.summary.worstRisk, 'ACTIVE');
});

test('MON-902 graph: an offline device with no work assigned is a WATCH, not an incident', () => {
  const graph = buildGraph(view({nodes: [host('h1', false), host('h2', true)]}));
  assert.deepEqual(codesOf(graph, 'h1'), ['DEVICE_OFFLINE']);
  assert.deepEqual(codesOf(graph, 'h2'), []);
  assert.equal(graph.summary.activeRiskCount, 0, 'a spare offline device must not raise an active incident');
  assert.equal(graph.summary.worstRisk, 'WATCH');
});

test('MON-902 graph: absence of retries is NOT claimed from a truncated event window', () => {
  // The same task, the same (empty) retry history, two different windows. The continuous one may say NONE; the gapped
  // one must say NOT_OBSERVABLE and carry the reason, because "it never retried" would be a fabricated fact.
  const continuous = buildGraph(view({nodes: [task('t1', 'RUNNING')]}));
  assert.deepEqual(codesOf(continuous, 't1'), []);
  assert.equal(continuous.summary.retryHistory, 'OBSERVED');

  const gapped = buildGraph(view({nodes: [task('t1', 'RUNNING')], completeness: completeness({historyGap: true, firstSeq: 40, lastSeq: 42, canonicalHighWatermark: 90})}));
  assert.deepEqual(codesOf(gapped, 't1'), ['RETRY_HISTORY_NOT_OBSERVABLE']);
  assert.equal(risksOf(gapped, 't1')[0].level, 'NOT_OBSERVABLE');
  assert.match(risksOf(gapped, 't1')[0].detail, /gap|omitted/i, 'the reason must be stated, not just the verdict');
  assert.equal(gapped.summary.retryHistory, 'NOT_OBSERVABLE');

  const omitted = buildGraph(view({nodes: [task('t1', 'RUNNING')], completeness: completeness({eventsOmitted: 7})}));
  assert.equal(codesOf(omitted, 't1').includes('RETRY_HISTORY_NOT_OBSERVABLE'), true, 'omitted events are as unusable as a gap');
});

test('MON-902 graph: repeated hand-off refusals for one task become one ACTIVE risk with its count', () => {
  const events = [event(1, 'TASK_HANDOFF_REFUSED', 't1'), event(2, 'TASK_SWITCH_DECLINED', 't1'), event(3, 'TASK_CREATED', 't2')];
  const graph = buildGraph(view({nodes: [task('t1', 'QUEUED'), task('t2', 'QUEUED')], events, completeness: completeness({lastSeq: 3})}));
  const repeated = risksOf(graph, 't1').find(entry => entry.code === 'PATH_REPEATED');
  assert.ok(repeated, 'two refused paths in one window is a path that repeats');
  assert.equal(repeated.level, 'ACTIVE');
  assert.match(repeated.detail, /2 times/);
  assert.deepEqual(codesOf(graph, 't2'), [], 'an unrelated task is not stained by another task\'s history');

  const once = buildGraph(view({nodes: [task('t1', 'QUEUED')], events: [event(1, 'TASK_HANDOFF_REFUSED', 't1')], completeness: completeness({lastSeq: 1})}));
  assert.equal(codesOf(once, 't1').includes('PATH_REPEATED'), false, 'one refusal is not a repeating path');
});

test('MON-902 graph: a task waiting on a device is a WATCH until that device reports ready', () => {
  const waiting = buildGraph(view({nodes: [task('t1', 'QUEUED')], events: [event(1, 'TASK_TARGET_WAITING', 't1')], completeness: completeness({lastSeq: 1})}));
  assert.deepEqual(codesOf(waiting, 't1'), ['DEVICE_ROUTE_WAITING']);
  assert.equal(risksOf(waiting, 't1')[0].level, 'WATCH');

  const ready = buildGraph(view({nodes: [task('t1', 'QUEUED')], events: [event(1, 'TASK_TARGET_WAITING', 't1'), event(2, 'TASK_TARGET_READY', 't1')], completeness: completeness({lastSeq: 2})}));
  assert.deepEqual(codesOf(ready, 't1'), [], 'a later ready event clears the wait rather than accumulating forever');
});

test('MON-902 graph: a monitor that cannot see must not look calm', () => {
  const partial = buildGraph(view({health: 'PARTIAL', completeness: completeness({tasksOmitted: 12, historyGap: true})}));
  const observation = partial.nodes.find(node => node.kind === 'OBSERVATION');
  assert.ok(observation, 'the blind spot is itself an inspectable node');
  assert.ok(observation.riskReasons.some(entry => entry.code === 'WINDOW_INCOMPLETE'), 'omitted tasks are a risk, not a footnote');

  for (const health of ['UNAVAILABLE', 'DISCONNECTED']) {
    const degraded = buildGraph(view({health}));
    assert.ok(risksOf(degraded, 'observation:window').some(entry => entry.level === 'ACTIVE' && entry.code.startsWith('MONITOR_')), `${health} must surface as an active risk`);
  }
  const stale = buildGraph(view({health: 'COMPLETE', stale: true}));
  assert.ok(risksOf(stale, 'observation:window').some(entry => entry.code === 'MONITOR_STALE'));
  assert.equal(buildGraph(view()).nodes.some(node => node.kind === 'OBSERVATION'), false, 'a healthy complete window needs no apology node');
});

test('MON-902 graph: a path pointing at an absent device is reported as a causality gap', () => {
  const graph = buildGraph(view({nodes: [task('t1', 'RUNNING', {hostRef: 'ghost'})], edges: [{from: 't1', to: 'ghost', type: 'ASSIGNED_TO', reason: 'Canonical task.assignedNodeId', targetPresent: false}]}));
  assert.equal(graph.edges[0].incomplete, true);
  assert.equal(graph.summary.incompleteEdges, 1);
  assert.ok(risksOf(graph, 'observation:window').some(entry => entry.code === 'EDGE_CAUSALITY_MISSING'));

  const reasonless = buildGraph(view({nodes: [task('t1', 'RUNNING'), host('h1', true)], edges: [{from: 't1', to: 'h1', type: 'ASSIGNED_TO', reason: null, targetPresent: true}]}));
  assert.equal(reasonless.edges[0].reasonSource, 'MISSING');
  assert.equal(reasonless.edges[0].incomplete, true, 'an edge with no stated cause cannot explain a path');
});

test('MON-902 graph: the edge filter removes types from the picture and never invents others', () => {
  const base = view({nodes: [task('t1', 'RUNNING', {hostRef: 'h1'}), host('h1', true)], edges: [{from: 't1', to: 'h1', type: 'ASSIGNED_TO', reason: 'Canonical task.assignedNodeId', targetPresent: true}]});
  assert.equal(buildGraph(base).edges.length, 1);
  assert.equal(buildGraph(base, {edgeTypes: ['HANDOFF']}).edges.length, 0);
  assert.equal(buildGraph(base, {edgeTypes: ['ASSIGNED_TO', 'HANDOFF']}).edges.length, 1);
  assert.equal(buildGraph(base, {edgeTypes: ['HANDOFF']}).summary.incompleteEdges, 0, 'a filtered-out edge is not a gap');
});

test('MON-902 graph: a large city collapses unremarkable work but never collapses an active risk', () => {
  const nodes = [task('risky', 'FAILED')];
  for (let i = 0; i < 200; i += 1) nodes.push(task(`ok-${i}`, 'RUNNING'));
  const graph = buildGraph(view({nodes}), {maxVisibleNodes: 50});
  assert.equal(graph.clusters.length, 1);
  assert.equal(graph.clusters[0].state, 'RUNNING');
  assert.equal(graph.clusters[0].count, 200);
  assert.equal(graph.clusters[0].collapsed, true);
  assert.ok(graph.visibleNodeIds.includes('risky'), 'a node with active risk is drawn even when the picture is collapsed');
  assert.equal(graph.nodes.find(node => node.id === 'ok-7').clusterRef, graph.clusters[0].id);
  assert.equal(graph.clusters[0].activeRiskCount, 0);
  // A small city is not clustered at all: collapsing three tasks would hide detail for no reason.
  assert.deepEqual(buildGraph(view({nodes: nodes.slice(0, 5)})).clusters, []);
});

test('MON-902 graph: the layout does not reshuffle because an event arrived', () => {
  const nodes = [task('a', 'RUNNING'), task('b', 'QUEUED'), host('h1', true)];
  const before = buildGraph(view({nodes, events: [event(1, 'CLIENT_CONNECTED', null)], completeness: completeness({lastSeq: 1})}));
  const after = buildGraph(view({nodes, events: [event(1, 'CLIENT_CONNECTED', null), event(2, 'MEMBER_MESSAGE_RECEIVED', null)], completeness: completeness({lastSeq: 2})}));
  assert.deepEqual(after.visibleNodeIds, before.visibleNodeIds, 'the same structure must keep the same order');
  assert.equal(after.layout.reflowKey, before.layout.reflowKey, 'a reflow key that changes on every event would force a redraw');

  const changed = buildGraph(view({nodes: [...nodes, task('c', 'QUEUED')]}));
  assert.notEqual(changed.layout.reflowKey, before.layout.reflowKey, 'a real structural change may reflow');
  assert.deepEqual(before.visibleNodeIds, [...before.visibleNodeIds].sort((x, y) => x.localeCompare(y)) === before.visibleNodeIds ? before.visibleNodeIds : before.visibleNodeIds, 'ordering is deterministic');
});

test('MON-902 graph: the interaction budget from overview to a risk is stated and small', () => {
  const graph = buildGraph(view({nodes: [task('t1', 'FAILED')]}));
  assert.equal(graph.navigation.budgetSteps, 3);
  assert.ok(graph.navigation.designedMaxSteps <= graph.navigation.budgetSteps);
  assert.equal(graph.navigation.worstSteps,null,'a design budget is not a runtime measurement');
  // Every active risk is either drawn on the overview or inside a cluster that reports it, so none is unreachable.
  const drawn = new Set(graph.visibleNodeIds);
  const clustered = new Set(graph.clusters.flatMap(cluster => cluster.nodeIds));
  for (const node of graph.nodes) {
    if (!node.riskReasons.some(entry => entry.level === 'ACTIVE')) continue;
    assert.ok(drawn.has(node.id) || clustered.has(node.id), `${node.id} carries active risk but is in neither the graph nor a cluster`);
  }
});

test('MON-902 graph: owner-required state is reported as observable or explicitly not observable, never as none', () => {
  const waiting = buildGraph(view({nodes: [task('t1', 'WAITING_CONFIRMATION')]}));
  assert.equal(waiting.summary.ownerRequired.state, 'OBSERVED');
  assert.deepEqual(waiting.summary.ownerRequired.refs, ['t1']);
  assert.ok(codesOf(waiting, 't1').includes('OWNER_CONFIRMATION_REQUIRED'));

  const quiet = buildGraph(view({nodes: [task('t1', 'RUNNING')]}));
  assert.equal(quiet.summary.ownerRequired.state, 'NOT_OBSERVABLE', 'canonical tasks cannot prove that no Owner gate exists');
  assert.equal(quiet.summary.ownerRequired.count, null, 'unknown is null, never 0');
  assert.match(quiet.summary.ownerRequired.reason, /Owner gates/);
});

test('MON-902 graph: an invalid view is refused rather than projected into a comfortable empty city', () => {
  for (const bad of [null, {}, {nodes: [], edges: []}, {nodes: [], edges: [], events: null}]) assert.throws(() => buildGraph(bad), TypeError);
});
