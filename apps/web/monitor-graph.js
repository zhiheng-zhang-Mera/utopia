/**
 * MON-902 — Web control surface for the City Work Monitor.
 *
 * Renders the graph returned by `GET /api/v0/monitor/graph` for a person: what is happening in the city, why, who owns
 * it, and what happens next. Pure string builders with no DOM access, so the rendering rules are testable in Node
 * against the real projection rather than only in a browser.
 *
 * THE RULES THIS FILE EXISTS TO KEEP:
 *
 *   - The overview may collapse work but never hide risk: every node carrying ACTIVE risk is listed as a row with its
 *     own count, and clusters report the risk they contain. A person must never have to open something to discover
 *     that something is wrong.
 *   - A monitor that cannot see does not look calm. When the projection is partial, gapped, unavailable or stale, the
 *     overview says so at the top and says which claim it cannot make.
 *   - Raw projection vocabulary does not render by default. Risk codes, state tokens, exact refs, completeness numbers
 *     and the reflow key live in the explicit Technical details disclosure, which is built from one gate.
 *   - The monitor decides nothing. It offers no control that would change the city, because MON-902 is an observation
 *     surface; the decision overlay is MON-903.
 */

import {t,getLocale} from './i18n/index.js';

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** The risk codes the projection may emit. Kept here so a new code without copy fails the locale test instead of leaking. */
export const RISK_CODES = Object.freeze([
  'TASK_FAILED', 'TASK_REFUSED', 'TASK_UNAVAILABLE', 'OWNER_CONFIRMATION_REQUIRED', 'DEVICE_ROUTE_WAITING',
  'PATH_REPEATED', 'RETRY_HISTORY_NOT_OBSERVABLE', 'DEVICE_OFFLINE', 'DEVICE_OFFLINE_HOLDING_WORK',
  'DEVICE_STATE_UNKNOWN', 'WINDOW_INCOMPLETE', 'HISTORY_GAP', 'EDGE_CAUSALITY_MISSING',
  'MONITOR_PARTIAL', 'MONITOR_UNAVAILABLE', 'MONITOR_DISCONNECTED', 'MONITOR_STALE',
]);

/** What a person can do about a risk. The monitor states the next step; it does not take it. */
export const NEXT_STEP = Object.freeze({
  TASK_FAILED: 'next.inspectFailure', TASK_REFUSED: 'next.inspectFailure', TASK_UNAVAILABLE: 'next.inspectFailure',
  OWNER_CONFIRMATION_REQUIRED: 'next.confirmIt', DEVICE_ROUTE_WAITING: 'next.waitForDevice',
  PATH_REPEATED: 'next.breakTheLoop', RETRY_HISTORY_NOT_OBSERVABLE: 'next.cannotTell',
  DEVICE_OFFLINE: 'next.deviceOffline', DEVICE_OFFLINE_HOLDING_WORK: 'next.deviceOffline',
  DEVICE_STATE_UNKNOWN: 'next.cannotTell', WINDOW_INCOMPLETE: 'next.cannotTell', HISTORY_GAP: 'next.cannotTell',
  EDGE_CAUSALITY_MISSING: 'next.cannotTell', MONITOR_PARTIAL: 'next.cannotTell', MONITOR_UNAVAILABLE: 'next.cannotTell',
  MONITOR_DISCONNECTED: 'next.cannotTell', MONITOR_STALE: 'next.cannotTell',
});

const label = (key, fallback) => { const value = t(key); return value === key ? fallback : value; };
const riskLabel = code => (code ? label('monitor.risk.' + code, code.replaceAll('_', ' ').toLowerCase()) : '');
const stateLabel = state => label('monitor.state.' + String(state), String(state ?? '').replaceAll('_', ' ').toLowerCase());
const kindLabel = kind => label('monitor.kind.' + kind, kind.toLowerCase());

const riskOf = node => node.riskReasons.slice().sort((a, b) => ({ACTIVE: 3, WATCH: 2, NOT_OBSERVABLE: 1, NONE: 0}[b.level] - {ACTIVE: 3, WATCH: 2, NOT_OBSERVABLE: 1, NONE: 0}[a.level]))[0] ?? null;
const activeRisks = graph => graph.nodes.flatMap(node => node.riskReasons.filter(entry => entry.level === 'ACTIVE').map(entry => ({node, entry})));

/**
 * Is this projection able to support the calm reading a person will otherwise make?
 *
 * When it is not, the overview must lead with that instead of with a reassuring count of zero risks. This is the
 * difference between "nothing is wrong" and "I could not see everything".
 */
export function blindSpots(graph) {
  const lines = [];
  if (graph.projectionOf.health !== 'COMPLETE') lines.push(label('monitor.blind.health', 'The observation source is not complete:') + ' ' + stateLabel(graph.projectionOf.health));
  if (graph.summary.unobserved.historyGap) lines.push(label('monitor.blind.gap', 'Part of the city history is missing from this window.'));
  if (graph.summary.unobserved.tasks > 0) lines.push(label('monitor.blind.tasks', 'Some tasks exist that this picture does not contain:') + ' ' + graph.summary.unobserved.tasks);
  if (graph.summary.retryHistory !== 'OBSERVED') lines.push(label('monitor.blind.retry', 'Whether anything has been retrying cannot be told from this window.'));
  if (graph.summary.incompleteEdges > 0) lines.push(label('monitor.blind.edges', 'Some paths point at something this picture does not contain:') + ' ' + graph.summary.incompleteEdges);
  return lines;
}

/**
 * What this monitor never covers, by design, even when everything above is complete.
 *
 * This is deliberately NOT mixed into `blindSpots`: a permanent limitation of the observation model is not an incident,
 * and a caveat that cries wolf on every healthy city is one a person learns to ignore. It is stated anyway, quietly and
 * always, because "no owner action is required" is a claim this projection cannot make - canonical tasks show a waiting
 * confirmation, but Mission Book Owner gates and escalations are not part of MON-901.
 */
export function scopeCaveats(graph) {
  const lines = [];
  if (graph.summary.ownerRequired.state !== 'OBSERVED') lines.push(label('monitor.blind.owner', 'Whether the owner is needed cannot be told from here.'));
  if (graph.summary.ownerRequired.state === 'OBSERVED') lines.push(label('monitor.scope.ownerObserved', 'Owner action is visible only where a task is waiting for confirmation.'));
  return lines;
}

/** One inspectable row. The whole row is the control, and it carries the node id so the caller can open the inspector. */
function riskRow(node, entry) {
  return `<li class="monitor-row risk-${esc(entry.level.toLowerCase())}" data-monitor-node="${esc(node.id)}"><span class="monitor-dot" aria-hidden="true"></span>`
    + `<span class="monitor-row-label">${esc(node.label ?? node.id)}</span>`
    + `<span class="monitor-row-why">${esc(riskLabel(entry.code))}</span>`
    + `<span class="monitor-row-state">${esc(stateLabel(node.state))}</span></li>`;
}

/** Level 0: the city overview. Risk first, then the work, then what the picture cannot see. */
export function monitorOverview(graph, {expandedClusters=new Set()}={}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new TypeError('A monitor graph is required');
  const shown=new Set(graph.visibleNodeIds??graph.nodes.map(n=>n.id));
  const visibleNodes=graph.nodes.filter(n=>shown.has(n.id)||expandedClusters.has(n.clusterRef)).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const active = visibleNodes.flatMap(node=>node.riskReasons.filter(entry=>entry.level==='ACTIVE').map(entry=>({node,entry})));
  const blind = blindSpots(graph);
  const banner = active.length
    ? `<p class="monitor-banner alert" role="status">${esc(t('monitor.overview.needsAttention'))} <strong>${active.length}</strong></p>`
    : `<p class="monitor-banner calm" role="status">${esc(t('monitor.overview.nothingActive'))}</p>`;
  const blindBlock = blind.length
    ? `<div class="monitor-blind" role="status"><p><strong>${esc(t('monitor.overview.cannotSee'))}</strong></p><ul>${blind.map(line => `<li>${esc(line)}</li>`).join('')}</ul></div>`
    : '';
  const watch = visibleNodes.flatMap(node => node.riskReasons.filter(entry => entry.level === 'WATCH').map(entry => ({node, entry})));
  const notObservable = visibleNodes.flatMap(node => node.riskReasons.filter(entry => entry.level === 'NOT_OBSERVABLE').map(entry => ({node, entry})));
  const rows = (items, empty) => items.length
    ? `<ul class="monitor-rows">${items.map(({node, entry}) => riskRow(node, entry)).join('')}</ul>`
    : `<p class="muted">${esc(empty)}</p>`;
  const work = visibleNodes.filter(node => node.kind === 'TASK' && !node.riskReasons.length);
  const clusters = graph.clusters.map(cluster => `<li class="monitor-cluster"><button data-monitor-cluster="${esc(cluster.id)}" aria-expanded="${expandedClusters.has(cluster.id)}">${esc(t(expandedClusters.has(cluster.id)?'monitor.collapse':'monitor.overview.collapsed'))} <strong>${cluster.count}</strong> ${esc(stateLabel(cluster.state))} · ${esc(t(expandedClusters.has(cluster.id)?'monitor.collapse':'monitor.expand'))}</button>${cluster.worstRisk==='NOT_OBSERVABLE'?` <span>${esc(t('monitor.blind.retry'))}</span>`:''}${cluster.activeRiskCount ? ` <span class="risk-active">${esc(t('monitor.overview.containsRisk'))} ${cluster.activeRiskCount}</span>` : ''}</li>`).join('');
  // `data-loaded` makes the page's own state machine-readable, so a reader (and a test) can tell the difference between
  // "the panel exists" and "the projection has arrived". The first version of this panel had no such marker, and the
  // browser test asserted loaded-state copy as soon as the shell appeared: it passed locally and in one CI run, then
  // failed in the push run with 'CITY MONITOR\n\nLoading from the Gateway...' - a measurement defect (the test raced the
  // fetch), not a rendering bug. The marker is the regression guard.
  return `<section class="panel monitor-panel" data-loaded="true" aria-labelledby="monitor-title">`
    + `<h2 id="monitor-title">${esc(t('monitor.title'))}</h2>`
    + `<p class="muted">${esc(t('monitor.subtitle'))}</p>`
    + banner + blindBlock
    + `<h3>${esc(t('monitor.overview.riskTitle'))}</h3>` + rows(active, t('monitor.overview.noActiveRisk'))
    + `<h3>${esc(t('monitor.overview.watchTitle'))}</h3>` + rows(watch, t('monitor.overview.noWatch'))
    + (notObservable.length ? `<h3>${esc(t('monitor.overview.unknownTitle'))}</h3>` + rows(notObservable, '') : '')
    + `<h3>${esc(t('monitor.overview.workTitle'))}</h3>`
    + (work.length ? `<ul class="monitor-rows">${work.map(node => riskRow(node, {level: 'NONE', code: null})).join('')}</ul>` : `<p class="muted">${esc(t('monitor.overview.noWork'))}</p>`)
    + (clusters ? `<ul class="monitor-clusters">${clusters}</ul>` : '')
    + `<p class="muted monitor-scope">${esc(t('monitor.overview.scope'))} ${scopeCaveats(graph).map(esc).join(' ')}</p>`
    + `<p class="muted">${esc(t('monitor.overview.budget'))}</p>`
    + monitorTechnical(graph)
    + `</section>`;
}

/** Level 1: what / why / who / what next for one node, plus the exact canonical reference behind every claim. */
export function monitorNodePanel(graph, id) {
  const node = graph.nodes.find(candidate => candidate.id === id);
  if (!node) return `<section class="monitor-inspector"><p class="muted">${esc(t('monitor.inspector.gone'))}</p></section>`;
  const top = riskOf(node);
  const what = node.kind === 'TASK'
    ? `${kindLabel('TASK')} ${node.label ?? node.id} — ${stateLabel(node.state)}`
    : node.kind === 'HOST' ? `${kindLabel('HOST')} ${node.label ?? node.id} — ${stateLabel(node.state)}` : `${kindLabel('OBSERVATION')}`;
  const who = node.kind === 'TASK' ? (node.hostRef ? `${t('monitor.inspector.assignedTo')} ${node.hostRef}` : t('monitor.inspector.unassigned')) : t('monitor.inspector.notApplicable');
  const why = node.riskReasons.length
    ? `<ul class="monitor-why">${node.riskReasons.map(entry => `<li><span class="monitor-why-label">${esc(riskLabel(entry.code))}</span> <span class="muted">${esc(entry.detail ?? '')}</span>${entry.evidenceRef ? ` <button class="link" data-evidence="${esc(entry.evidenceRef)}">${esc(t('monitor.inspector.evidence'))}</button>` : ''}</li>`).join('')}</ul>`
    : `<p class="muted">${esc(t('monitor.inspector.noReason'))}</p>`;
  const next = top ? label('monitor.' + (NEXT_STEP[top.code] ?? 'next.cannotTell'), t('monitor.next.cannotTell')) : t('monitor.next.none');
  // A node's paths are reachable from the node itself, which is what keeps a route explanation inside the interaction
  // budget: overview row (1) -> this panel (2) -> the path's own explanation and evidence (3).
  const paths = graph.edges.filter(edge => edge.from === node.id || edge.to === node.id);
  const pathList = paths.length
    ? `<ul class="monitor-rows">${paths.map(edge => `<li class="monitor-row${edge.incomplete ? ' risk-watch' : ''}" data-monitor-edge="${esc(edge.id)}"><span class="monitor-row-label">${esc(edge.type)}</span><span class="monitor-row-why">${esc(edge.reason ?? t('monitor.path.noTrigger'))}</span></li>`).join('')}</ul>`
    : `<p class="muted">${esc(t('monitor.inspector.noPaths'))}</p>`;
  return `<section class="monitor-inspector" data-inspector="${esc(node.id)}">`
    + `<h3>${esc(t('monitor.inspector.title'))}</h3>`
    + `<dl class="monitor-facts">`
    + `<dt>${esc(t('monitor.inspector.what'))}</dt><dd>${esc(what)}</dd>`
    + `<dt>${esc(t('monitor.inspector.why'))}</dt><dd>${why}</dd>`
    + `<dt>${esc(t('monitor.inspector.who'))}</dt><dd>${esc(who)}</dd>`
    + `<dt>${esc(t('monitor.inspector.next'))}</dt><dd>${esc(next)}</dd>`
    + `<dt>${esc(t('monitor.inspector.paths'))}</dt><dd>${pathList}</dd>`
    + `</dl>`
    + `<button data-evidence="${esc(node.id)}">${esc(t('monitor.inspector.evidence'))}</button>`
    + `<details class="monitor-technical"><summary>${esc(t('monitor.technical.disclosure'))}</summary><pre>${esc(JSON.stringify(node, null, 2))}</pre></details>`
    + `</section>`;
}

/** Level 1: one path. An edge with no stated trigger is shown as an unexplained path, not as a silent one. */
export function monitorPathPanel(graph, edgeId) {
  const edge = graph.edges.find(candidate => candidate.id === edgeId);
  if (!edge) return `<section class="monitor-inspector"><p class="muted">${esc(t('monitor.inspector.gone'))}</p></section>`;
  const from = graph.nodes.find(node => node.id === edge.from);
  const to = graph.nodes.find(node => node.id === edge.to);
  return `<section class="monitor-inspector" data-path="${esc(edge.id)}">`
    + `<h3>${esc(t('monitor.path.title'))}</h3>`
    + `<dl class="monitor-facts">`
    + `<dt>${esc(t('monitor.path.type'))}</dt><dd>${esc(edge.type)}</dd>`
    + `<dt>${esc(t('monitor.path.source'))}</dt><dd>${esc(from?.label ?? edge.from)}</dd>`
    + `<dt>${esc(t('monitor.path.destination'))}</dt><dd>${esc(to?.label ?? edge.to)}${edge.targetPresent ? '' : ` — <span class="risk-active">${esc(t('monitor.path.absent'))}</span>`}</dd>`
    + `<dt>${esc(t('monitor.path.trigger'))}</dt><dd>${edge.reason ? esc(edge.reason) : `<span class="risk-watch">${esc(t('monitor.path.noTrigger'))}</span>`}</dd>`
    + `</dl>`
    + `<p>${esc(t('monitor.path.related'))}</p>${(edge.evidenceRefs??[]).map(ref=>`<button data-evidence="${esc(ref)}">${esc(ref)}</button>`).join('')}`
    + `<p>${esc(t('monitor.path.unobserved'))} ${esc((edge.metadataNotObservable??[]).join(', '))}</p>`
    + (edge.incomplete ? `<p class="monitor-blind" role="status">${esc(t('monitor.path.incomplete'))}</p>` : '')
    + `<details class="monitor-technical"><summary>${esc(t('monitor.technical.disclosure'))}</summary><pre>${esc(JSON.stringify(edge, null, 2))}</pre></details>`
    + `</section>`;
}

/** Read-only exact reference from the bounded projection; never a second task store. */
export function monitorEvidencePanel(graph,ref){
 const event=(graph.events??[]).find(e=>e.canonicalEventId===ref||e.evidenceRef===ref);
 const pointer=(graph.evidence??[]).find(e=>e.canonicalEventId===ref);
 const node=graph.nodes.find(n=>n.id===ref);
 const record=event?{source:'CANONICAL_GATEWAY_STORE',reference:ref,pointer,event}:node?{source:'CANONICAL_NODE_PROJECTION',reference:ref,node,events:(graph.events??[]).filter(e=>e.taskRef===ref)}:ref.startsWith('observation:')?{source:'CANONICAL_OBSERVATION_PROJECTION',reference:ref,projection:graph.projectionOf,summary:graph.summary}:{source:'NOT_OBSERVABLE',reference:ref,reason:'Reference is outside this bounded projection; no record was invented.'};
 return `<section id="monitor-evidence" class="panel" tabindex="-1"><h3>${esc(t('monitor.evidence.title'))}</h3><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(record,null,2))}</pre></section>`;
}

/** Page-local lifecycle; late responses must not cross credential, City, navigation or connectivity boundaries. */
export function createMonitorGraphView(){
 let context=null,epoch=0,graph=null,pending=false,error='',loadedAt=null,currentSnapshotAt=null,selected=null,evidence=null,filter='ALL',expanded=new Set(),signature='';
 function reset(){context=null;epoch++;graph=null;pending=false;error='';loadedAt=null;selected=null;evidence=null;filter='ALL';expanded.clear();signature='';}
 function render(host,{contextKey,cityId,online,snapshotAt,api,isCurrent}){
  const key=contextKey+'|'+online;
  if(context!==key){reset();context=key;}
  currentSnapshotAt=snapshotAt;
  const current=()=>context===key&&isCurrent();
  function draw(){
   if(!current())return;
   const semanticGraph=graph?{...graph,projectionOf:{...graph.projectionOf,observedAt:null,projectedAt:null},events:[],evidence:[]}:null;
   const renderKey=JSON.stringify([getLocale(),online,error,filter,selected,evidence,[...expanded],semanticGraph]);
   const refresh=host.querySelector('#monitor-refresh');if(refresh)refresh.disabled=pending||!online;
   if(renderKey===signature&&host.querySelector('#monitor-edge-filter')){
    const technical=host.querySelector('.monitor-panel > .monitor-technical pre');if(technical&&graph)technical.textContent=JSON.stringify(monitorTechnicalData(graph),null,2);
    if(graph&&evidence){const pane=host.querySelector('#monitor-evidence pre');if(pane){const template=host.ownerDocument.createElement('template');template.innerHTML=monitorEvidencePanel(graph,evidence);pane.textContent=template.content.querySelector('pre').textContent;}}
    return;
   }
   const controls=`<div class="monitor-controls"><label for="monitor-edge-filter">${esc(t('monitor.filter'))}</label><select id="monitor-edge-filter">${['ALL','NONE','ASSIGNED_TO','HANDOFF','RETRY','REVIEW','DEVICE_ROUTE','MODEL_ROUTE'].map(type=>`<option value="${type}" ${filter===type?'selected':''}>${esc(type==='ALL'?t('monitor.filter.all'):type==='NONE'?t('monitor.filter.none'):t('monitor.edge.'+type))}</option>`).join('')}</select><button id="monitor-refresh" ${pending||!online?'disabled':''}>${esc(t('monitor.refresh'))}</button><button data-page="Decisions">${esc(t('nav.decisions'))}</button></div>`;
   const body=!online?`<section class="panel monitor-panel" data-loaded="false"><p role="status">${esc(t('monitor.offline'))}</p></section>`:error?`<section class="panel monitor-panel" data-loaded="error"><p role="alert">${esc(error)}</p></section>`:graph?monitorOverview(graph,{expandedClusters:expanded}):`<section class="panel monitor-panel" data-loaded="false"><p>${esc(t('terminal.loading'))}</p></section>`;
   const inspector=graph&&selected?(selected.kind==='node'?monitorNodePanel(graph,selected.id):monitorPathPanel(graph,selected.id)):'';
   const html=controls+body+inspector+(graph&&evidence?monitorEvidencePanel(graph,evidence):'');
   signature=renderKey;
   const open=[...host.querySelectorAll('details')].map(d=>d.open);
   const focus=host.contains(host.ownerDocument.activeElement)?host.ownerDocument.activeElement.id:null;
   host.innerHTML=html;
   [...host.querySelectorAll('details')].forEach((d,i)=>{if(open[i])d.open=true;});
   if(focus)host.querySelector('#'+focus)?.focus({preventScroll:true});
   host.querySelector('#monitor-refresh').onclick=()=>{loadedAt=null;void load();};
   host.querySelector('#monitor-edge-filter').onchange=e=>{filter=e.target.value;epoch++;pending=false;graph=null;selected=null;evidence=null;loadedAt=null;void load();};
   host.querySelectorAll('[data-monitor-cluster]').forEach(button=>button.onclick=()=>{const id=button.dataset.monitorCluster;if(expanded.has(id))expanded.delete(id);else expanded.add(id);draw();});
   host.querySelectorAll('[data-monitor-node]').forEach(button=>{button.setAttribute('role','button');button.tabIndex=0;button.onclick=()=>{selected={kind:'node',id:button.dataset.monitorNode};evidence=null;draw();};button.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();button.click();}};});
   host.querySelectorAll('[data-monitor-edge]').forEach(button=>{button.setAttribute('role','button');button.tabIndex=0;button.onclick=()=>{selected={kind:'edge',id:button.dataset.monitorEdge};evidence=null;draw();};button.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();button.click();}};});
   host.querySelectorAll('[data-evidence]').forEach(button=>button.onclick=()=>{evidence=button.dataset.evidence;draw();host.querySelector('#monitor-evidence')?.focus();});
  }
  async function load(){
   if(pending||!online||!current())return;
   const ticket=++epoch,requestedAt=currentSnapshotAt;pending=true;draw();
   try{
    const result=await api(filter==='ALL'?'monitor/graph':'monitor/graph?edges='+encodeURIComponent(filter==='NONE'?'NOT_A_TYPE':filter));
    if(!current()||ticket!==epoch)return;
    if(!result?.graph||result.graph.projectionOf?.cityId!==cityId)throw Error('Monitor City identity mismatch');
    graph=result.graph;error='';
   }catch(reason){if(current()&&ticket===epoch){graph=null;error=t('monitor.error');}}
   finally{if(current()&&ticket===epoch){pending=false;loadedAt=requestedAt;draw();if(currentSnapshotAt!==loadedAt)void load();}}
  }
  draw();if(online&&loadedAt!==snapshotAt&&!pending)void load();
 }
 return {render,reset};
}

/** Level 2: the projection's own provenance. One explicit gate, so raw vocabulary cannot leak by accident. */
function monitorTechnicalData(graph){
  return {
    authoritative: graph.authoritative, schemaVersion: graph.schemaVersion,
    projectionOf: graph.projectionOf, summary: graph.summary, navigation: graph.navigation, layout: graph.layout,
    completeness: graph.summary.unobserved, clusters: graph.clusters.map(cluster => ({id: cluster.id, count: cluster.count, state: cluster.state, activeRiskCount: cluster.activeRiskCount})),
    counts: {nodes: graph.nodes.length, edges: graph.edges.length},
  };
}
export function monitorTechnical(graph) {
  const meta = monitorTechnicalData(graph);
  return `<details class="monitor-technical"><summary>${esc(t('monitor.technical.disclosure'))}</summary>`
    + `<p class="muted">${esc(t('monitor.technical.note'))}</p><pre>${esc(JSON.stringify(meta, null, 2))}</pre></details>`;
}
