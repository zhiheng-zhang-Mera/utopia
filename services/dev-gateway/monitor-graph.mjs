// MON-902: the overview graph is a PROJECTION of one MON-901 observation view.
//
// The City Work Monitor README is explicit that the monitor must never become a second task truth, so this module adds
// no state, no timer, no scheduler and no decision: `buildGraph(view)` is a pure function of one bounded observation
// view. Everything it says about a task is derived from that view, and every derived claim carries the evidence
// reference it came from.
//
// Three rules shape the code more than the rest:
//
//   1. RISK MAY BE COLLAPSED, NEVER HIDDEN. When the graph is too big to draw, unremarkable nodes are clustered but a
//      node carrying ACTIVE risk is always rendered on its own, and every cluster reports the risk it contains.
//   2. ABSENCE IS NOT CLAIMED FROM A TRUNCATED WINDOW. "This task was never retried" is only sayable when the event
//      window is continuous; otherwise the answer is NOT_OBSERVABLE with the reason, never a comfortable zero.
//   3. A MONITOR THAT CANNOT SEE MUST NOT LOOK CALM. PARTIAL/UNAVAILABLE/DISCONNECTED health and an incomplete window
//      are themselves ACTIVE risks on an OBSERVATION node, so the overview cannot show a quiet city while blind.

/** Risk vocabulary. NOT_OBSERVABLE is a first-class answer, not a synonym for NONE. */
export const RISK_LEVELS = Object.freeze(['NONE', 'WATCH', 'ACTIVE', 'NOT_OBSERVABLE']);
import {terminal} from '../../contracts/city-control-v0/protocol.mjs';
const finished = state => terminal.includes(state) || ['SUCCEEDED','REFUSED','UNAVAILABLE'].includes(state);
const SEVERITY = {NOT_OBSERVABLE: 0, NONE: 1, WATCH: 2, ACTIVE: 3};
const worst = levels => levels.slice().sort((a, b) => SEVERITY[b] - SEVERITY[a])[0] ?? 'NONE';

/** Canonical task statuses that mean "a person is being waited on". */
const OWNER_WAITING_STATES = Object.freeze(['WAITING_CONFIRMATION']);
/** Canonical states that are failures or refusals rather than progress. */
const TASK_RISK_STATES = Object.freeze({FAILED: 'TASK_FAILED', REFUSED: 'TASK_REFUSED', UNAVAILABLE: 'TASK_UNAVAILABLE'});
/** Events that mean the task was sent somewhere and came back. Two of them for one task is a repeated path. */
const RETRY_EVENTS = Object.freeze(['TASK_HANDOFF_REFUSED', 'TASK_SWITCH_DECLINED']);
const REPEATED_RETRY_THRESHOLD = 2;

const risk = (code, level, detail, evidenceRef = null) => ({code, level, detail, evidenceRef});
const validCompleteness = value => value && ['tasksOmitted','nodesOmitted','eventsOmitted'].every(k=>Number.isInteger(value[k])&&value[k]>=0) && typeof value.historyGap==='boolean';

/**
 * Is the event window continuous enough to say that something did NOT happen?
 *
 * A bounded window that starts mid-history, skipped events, or omitted events cannot support an absence claim. The
 * distinction matters because "no repeated retry" and "the retry history is not observable" lead a person to opposite
 * conclusions about a stuck task.
 */
function windowContinuity(completeness) {
  if (!validCompleteness(completeness)) return {continuous: false, reason: 'The observation view carried no valid completeness record, so the event window cannot be shown to be continuous.'};
  if (completeness.historyGap) return {continuous: false, reason: 'The canonical event window has a gap (firstSeq ' + String(completeness.firstSeq) + ', lastSeq ' + String(completeness.lastSeq) + ', high watermark ' + String(completeness.canonicalHighWatermark) + ').'};
  if (Number(completeness.eventsOmitted) > 0) return {continuous: false, reason: String(completeness.eventsOmitted) + ' canonical events were omitted from this bounded window.'};
  return {continuous: true, reason: null};
}

/** Stable ordering: a refresh must not reshuffle the graph, so order depends on structure only, never on arrival time. */
const orderKey = node => [node.kind === 'OBSERVATION' ? '0' : node.kind === 'TASK' ? '1' : '2', node.id ?? ''].join('|');

export function buildGraph(view, options = {}) {
  const {maxVisibleNodes = 120, edgeTypes = ['ASSIGNED_TO']} = options;
  if (!view || typeof view !== 'object' || !Array.isArray(view.nodes) || !Array.isArray(view.edges) || !Array.isArray(view.events)) throw new TypeError('A bounded observation view is required');
  const continuity = windowContinuity(view.completeness);
  const completeness = view.completeness ?? {};
  const observedAt = view.observedAt ?? null;

  // --- what the window itself is worth -------------------------------------------------------------------------
  // The monitor's own blind spots are risks, because a person reading the overview needs to know how much of the city
  // this picture actually covers.
  const observationRisks = [];
  if (!validCompleteness(view.completeness)) observationRisks.push(risk('WINDOW_INCOMPLETE','ACTIVE','Coverage metadata was not observed; missing populations cannot be treated as zero.','observation:completeness'));
  const omitted = [
    Number(completeness.tasksOmitted) > 0 ? `${completeness.tasksOmitted} tasks` : null,
    Number(completeness.nodesOmitted) > 0 ? `${completeness.nodesOmitted} devices` : null,
    Number(completeness.eventsOmitted) > 0 ? `${completeness.eventsOmitted} events` : null,
  ].filter(Boolean);
  if (omitted.length) observationRisks.push(risk('WINDOW_INCOMPLETE', 'ACTIVE', `This picture omits ${omitted.join(', ')} that exist in the City.`, 'observation:completeness'));
  if (completeness.historyGap) observationRisks.push(risk('HISTORY_GAP', 'ACTIVE', continuity.reason, 'observation:completeness'));
  const knownHealth=['COMPLETE','PARTIAL','UNAVAILABLE','DISCONNECTED'].includes(view.health)?view.health:'UNAVAILABLE';
  if (knownHealth !== 'COMPLETE') observationRisks.push(risk(`MONITOR_${knownHealth}`, 'ACTIVE', `The observation source reports ${view.health || 'no health metadata'}${view.failure ? ` (${view.failure})` : ''}.`, 'observation:health'));
  if (view.stale) observationRisks.push(risk('MONITOR_STALE', 'WATCH', 'The last successful projection is being shown after a later failure.', 'observation:stale'));

  // --- events, grouped per task --------------------------------------------------------------------------------
  const retryCounts = new Map();
  const waitingForDevice = new Map();
  for (const event of view.events) {
    const taskRef = event.taskRef ?? null;
    if (!taskRef) continue;
    if (RETRY_EVENTS.includes(event.type)) retryCounts.set(taskRef, (retryCounts.get(taskRef) ?? 0) + 1);
    if (event.type === 'TASK_TARGET_WAITING') waitingForDevice.set(taskRef, event.evidenceRef ?? event.canonicalEventId ?? null);
    if (event.type === 'TASK_TARGET_READY') waitingForDevice.delete(taskRef);
  }

  // --- nodes ----------------------------------------------------------------------------------------------------
  const hosts = view.nodes.filter(node => node.kind === 'HOST');
  const hostHasTask = new Set(view.nodes.filter(node => node.kind === 'TASK' && node.hostRef && !finished(node.state)).map(node => node.hostRef));
  const nodes = [];
  for (const node of view.nodes) {
    const reasons = [];
    if (node.kind === 'TASK') {
      const stateRisk = TASK_RISK_STATES[node.state];
      const taskEvents = view.events.filter(event=>event.taskRef===node.id);
      const transition = taskEvents.filter(event=>event.type==='TASK_'+node.state).at(-1);
      if (stateRisk) reasons.push(risk(stateRisk, 'ACTIVE', `The task is ${node.state} in the canonical City.`, transition?.evidenceRef ?? transition?.canonicalEventId ?? node.id));
      if (OWNER_WAITING_STATES.includes(node.state)) reasons.push(risk('OWNER_CONFIRMATION_REQUIRED', 'ACTIVE', 'The task is waiting for a person to confirm it, so it will not progress by itself.', node.id));
      if (!finished(node.state) && waitingForDevice.has(node.id)) reasons.push(risk('DEVICE_ROUTE_WAITING', 'WATCH', 'The task was reported waiting for its target device to become ready.', waitingForDevice.get(node.id)));
      const retries = retryCounts.get(node.id) ?? 0;
      if (!finished(node.state) && retries >= REPEATED_RETRY_THRESHOLD) reasons.push(risk('PATH_REPEATED', 'ACTIVE', `The task was handed off or declined ${retries} times in this window: a path is repeating rather than progressing.`, node.id));
      else if (retries === 0 && !continuity.continuous) reasons.push(risk('RETRY_HISTORY_NOT_OBSERVABLE', 'NOT_OBSERVABLE', continuity.reason, 'observation:completeness'));
      nodes.push({id: node.id, kind: 'TASK', label: node.taskType ?? node.id, state: node.state ?? null, hostRef: node.hostRef ?? null, progress: node.progress ?? null, ownerObservability: node.ownerObservability ?? 'NOT_OBSERVABLE', riskReasons: reasons, historicalRetryCount:retries, evidenceRefs:taskEvents.map(e=>e.evidenceRef??e.canonicalEventId).filter(Boolean)});
    } else if (node.kind === 'HOST') {
      if (node.online === false && hostHasTask.has(node.id)) reasons.push(risk('DEVICE_OFFLINE_HOLDING_WORK', 'ACTIVE', 'The device is offline while canonical work is assigned to it, so that work cannot run.', node.id));
      else if (node.online === false) reasons.push(risk('DEVICE_OFFLINE', 'WATCH', 'The device is offline. No canonical work is assigned to it right now.', node.id));
      else if (node.online === null) reasons.push(risk('DEVICE_STATE_UNKNOWN', 'NOT_OBSERVABLE', 'The device presence could not be read from this window.', node.id));
      nodes.push({id: node.id, kind: 'HOST', label: node.displayName ?? node.id, state: node.online === true ? 'ONLINE' : node.online === false ? 'OFFLINE' : 'UNKNOWN', hostRef: null, progress: null, ownerObservability: 'NOT_OBSERVABLE', riskReasons: reasons});
    }
  }
  if (observationRisks.length) nodes.push({id: 'observation:window', kind: 'OBSERVATION', label: 'Observation window', state: view.health ?? 'UNKNOWN', hostRef: null, progress: null, ownerObservability: 'NOT_OBSERVABLE', riskReasons: observationRisks});

  // --- edges ----------------------------------------------------------------------------------------------------
  const edges = [];
  for (const edge of view.edges) {
    if (!edgeTypes.includes(edge.type)) continue;
    const reason = typeof edge.reason === 'string' && edge.reason.length > 0 ? edge.reason : null;
    const relatedEvents = view.events.filter(event=>event.taskRef===edge.from);
    edges.push({id: `${edge.from}->${edge.to}:${edge.type}`, from: edge.from, to: edge.to, type: edge.type, reason, reasonSource: reason ? 'CANONICAL' : 'MISSING', targetPresent: edge.targetPresent === true, incomplete: reason === null || edge.targetPresent !== true, relatedEvents, evidenceRefs:relatedEvents.map(e=>e.evidenceRef??e.canonicalEventId).filter(Boolean), timestamp:edge.timestamp??null,durationMs:edge.durationMs??null, metadataNotObservable:['model/provider routes','review handoffs',...(edge.timestamp?[]:['assignment timestamp']),...(Number.isFinite(edge.durationMs)?[]:['duration'])]});
  }
  const danglingEdges = edges.filter(edge => !edge.targetPresent);
  if (danglingEdges.length) {
    // A path that points at something the window cannot see is a causality gap, not a quiet edge.
    const target = nodes.find(node => node.kind === 'OBSERVATION');
    const entry = risk('EDGE_CAUSALITY_MISSING', 'WATCH', `${danglingEdges.length} path(s) point at a device this window does not contain, so the route cannot be followed.`, 'observation:edges');
    if (target) target.riskReasons.push(entry);
    else nodes.push({id: 'observation:window', kind: 'OBSERVATION', label: 'Observation window', state: view.health ?? 'UNKNOWN', hostRef: null, progress: null, ownerObservability: 'NOT_OBSERVABLE', riskReasons: [entry]});
  }

  // --- cluster what is unremarkable, never what is at risk ------------------------------------------------------
  const activeNodes = nodes.filter(node => node.riskReasons.some(entry => entry.level === 'ACTIVE'));
  const clusters = [];
  const collapsed = new Map();
  if (nodes.length > maxVisibleNodes) {
    for (const node of nodes) {
      if (node.kind !== 'TASK' || node.riskReasons.some(entry=>['ACTIVE','WATCH'].includes(entry.level))) continue;
      const key = node.state ?? 'UNKNOWN';
      if (!collapsed.has(key)) collapsed.set(key, []);
      collapsed.get(key).push(node);
    }
    for (const [state, members] of collapsed) {
      clusters.push({id: `cluster:TASK:${state}`, kind: 'TASK', state, count: members.length, nodeIds: members.map(node => node.id).sort(), collapsed: true, activeRiskCount: members.filter(node => node.riskReasons.some(entry => entry.level === 'ACTIVE')).length, worstRisk: worst(members.flatMap(node => node.riskReasons.map(entry => entry.level)))});
    }
  }
  for (const cluster of clusters) for (const id of cluster.nodeIds) { const node = nodes.find(candidate => candidate.id === id); if (node) node.clusterRef = cluster.id; }

  const visible = nodes.filter(node => !node.clusterRef);
  visible.sort((a, b) => orderKey(a).localeCompare(orderKey(b)));

  // --- summary --------------------------------------------------------------------------------------------------
  const allReasons = nodes.flatMap(node => node.riskReasons);
  const activeRisks = allReasons.filter(entry => entry.level === 'ACTIVE');
  const counts = {};
  for (const node of nodes) if (node.kind === 'TASK') counts[node.state ?? 'UNKNOWN'] = (counts[node.state ?? 'UNKNOWN'] ?? 0) + 1;
  const ownerTasks = nodes.filter(node => node.kind === 'TASK' && OWNER_WAITING_STATES.includes(node.state));
  const ownerRequired = ownerTasks.length > 0
    ? {state: 'OBSERVED', count: ownerTasks.length, refs: ownerTasks.map(node => node.id), reason: 'Canonical tasks are waiting for confirmation.'}
    : {state: 'NOT_OBSERVABLE', count: null, refs: [], reason: 'This window projects canonical tasks only; Mission Book Owner gates and escalations are not part of MON-901, so "no Owner action is required" cannot be claimed from it.'};

  return {
    schemaVersion: 1,
    authoritative: false,
    projectionOf: {cityId: view.cityId ?? null, observedAt, projectedAt: view.projectedAt ?? null, health: knownHealth, reportedHealth:view.health??null, scope: view.scope ?? null, eventSource: view.eventSource ?? null},
    nodes, edges, clusters, visibleNodeIds: visible.map(node => node.id), events:view.events,evidence:view.evidence??[],
    summary: {
      taskCounts: counts, activeRiskPresent: activeRisks.length > 0, activeRiskCount: activeRisks.length,
      riskBubbled: activeRisks.length > 0, worstRisk: worst(allReasons.map(entry => entry.level)),
      falseSafeSummary: false, safeSummaryAvailable: false,
      unobserved: {tasks: validCompleteness(completeness)?completeness.tasksOmitted:null, nodes: validCompleteness(completeness)?completeness.nodesOmitted:null, events: validCompleteness(completeness)?completeness.eventsOmitted:null, historyGap: validCompleteness(completeness)?completeness.historyGap:null},
      retryHistory: continuity.continuous ? 'OBSERVED' : 'NOT_OBSERVABLE', retryHistoryReason: continuity.reason,
      ownerRequired, incompleteEdges: edges.filter(edge => edge.incomplete).length,
    },
    navigation: {budgetSteps: 3, designedMaxSteps:3,worstSteps:null,measurementStatus:'NOT_OBSERVABLE', note: 'The design budget is three interactions. Actual navigation measurements belong to browser/runtime evidence, not this projection.'},
    layout: {reflowKey: `n${visible.length}:e${edges.length}:c${clusters.length}:${visible.map(node => node.id).join(',')}`, stable: true},
  };
}
