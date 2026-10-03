// MESH-301 FORMAL REVIEW - the reviewer's own analysis over canonical truth.
//
// Written as a FILE rather than an inline `node -e` on purpose: this review has already lost two measurements to
// PowerShell quoting, once in this very session (a `$` escaped into a JS regex, so the connectivity analysis
// matched nothing and reported "false" for all three surfaces instead of failing loudly). Inline scripts through
// a shell are how a null result gets mistaken for a negative one.
//
// It answers, from the City's own records and nothing else:
//   GATE 1  were three NAMED control surfaces connected to the same canonical City at the same time?
//   GATE 2  are there two real distinct worker nodes, both online, with fresh telemetry?
//   GATE 3  is there any Android node identity (there must not be)?
//   GATE 4/5/6  every strict-target task: what was it aimed at, what state was the target in at creation, and
//               which node actually claimed it?
//   GATE 7  were untargeted tasks still scheduled normally, and taken only by the two real workers?
// It also states the ONE thing canonical truth cannot answer - which surface issued an instruction - so the
// review's gate-4 evidence is bounded in writing rather than by omission.
//
// USAGE: CITY_URL=... CITY_TOKEN=... node mech-mesh301-review-analysis.mjs
import {writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const CITY = (process.env.CITY_URL || 'http://172.31.3.110:4391').replace(/\/$/, '');
const TOKEN = process.env.CITY_TOKEN || '';
const OUT_DIR = `${process.cwd()}/evidence/raw/mission-book/MESH-301/review-by-mech`;
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const WINDOW2_OPEN = Date.parse('2026-10-03T04:00:25Z');
const WINDOW2_CLOSE = Date.parse('2026-10-03T04:26:00Z');
const head = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(); } catch { return null; } })();

const api = async (path) => {
  const r = await fetch(`${CITY}/api/v0/${path}`, {headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'}, signal: AbortSignal.timeout(10000)});
  return r.json();
};

const city = await api('city');
const events = (await api('events')).events ?? [];
const tasks = (await api('tasks')).tasks ?? [];
const nodes = city.nodes ?? [];
const findings = {};

// ---------------------------------------------------------------- GATE 1
// Intervals are built from the City's own CLIENT_CONNECTED / CLIENT_DISCONNECTED events. An entry with a null
// clientRef is a stream client that declared no identity: it is counted separately and NEVER as an endpoint.
const open = new Map();
const intervals = [];
for (const e of events) {
  const payload = e.payload ?? {};
  const ref = payload.clientRef ?? null;
  const label = payload.clientLabel ?? null;
  if (e.type === 'CLIENT_CONNECTED') {
    if (open.has(ref)) intervals.push({ref, label, from: open.get(ref), to: e.timestamp, end: 'superseded'});
    open.set(ref, e.timestamp);
  } else if (e.type === 'CLIENT_DISCONNECTED' && open.has(ref)) {
    intervals.push({ref, label, from: open.get(ref), to: e.timestamp, end: 'closed'});
    open.delete(ref);
  }
}
for (const [ref, from] of open) intervals.push({ref, label: null, from, to: null, end: 'still-open'});
const named = intervals.filter((i) => i.label !== null && i.label !== undefined);
const anonymous = intervals.filter((i) => i.label === null || i.label === undefined);
const covers = (label, t0, t1) => named.some((i) => i.label === label && Date.parse(i.from) <= t0 && (i.to === null || Date.parse(i.to) >= t1));
findings.gate1 = {
  namedIntervals: named.slice(-16),
  anonymousConnectionCount: anonymous.length,
  anonymousNote: 'a stream client that declares no identity appears in controlSurfaces with clientRef/clientLabel null; it is a client, not an attributable endpoint',
  window2: {
    window: [new Date(WINDOW2_OPEN).toISOString(), new Date(WINDOW2_CLOSE).toISOString()],
    alienWeb: covers('Alien Web', WINDOW2_OPEN, WINDOW2_CLOSE),
    mechWeb: covers('Mech-Win-Web', WINDOW2_OPEN, WINDOW2_CLOSE),
    android: covers('PERM00', WINDOW2_OPEN, WINDOW2_CLOSE),
  },
  // THIS BLOCK IS A CORRECTION TO MY OWN METHOD, not an extra. The reconstruction above reads presence from
  // CLIENT_CONNECTED/CLIENT_DISCONNECTED, and the City emits a CLIENT-LEVEL disconnect when ANY socket for a
  // clientRef closes while the map is keyed by socket. So the event-based answer above is WRONG for any surface
  // that has ever held two sockets - it reported android:false for the whole gate-8 window while the Android
  // receipt observed until 04:27:30Z. Presence must be read from the City's own live list, de-duplicated by
  // clientRef, which is what this block does. The event-based numbers are kept beside it deliberately: an
  // instrument that silently changes its method is worse than one that shows both and says which it trusts.
  presenceFromCityList: {
    observedAt: new Date().toISOString(),
    raw: (city.controlSurfaces ?? []),
    deduplicatedByRef: [...new Map((city.controlSurfaces ?? []).map((s) => [s.clientRef, s])).values()],
    duplicatesPresent: (city.controlSurfaces ?? []).length !== new Set((city.controlSurfaces ?? []).map((s) => s.clientRef)).size,
  },
  methodWarning: 'the event-based fields above are unreliable for surfaces that held more than one socket (defect D-R1). Use presenceFromCityList.',
};

// ---------------------------------------------------------------- GATE 2/3
findings.gate2 = nodes.map((n) => ({
  id: n.id, principal: n.devicePrincipalId, platform: n.metadata?.platform, online: n.online,
  heartbeatAt: n.lastHeartbeatAt, telemetryAt: n.telemetry?.observedAt, capabilities: n.capabilities,
}));
findings.gate3 = {nodeCount: nodes.length, androidNamedNodes: nodes.filter((n) => /android|perm/i.test(String(n.id))).length, controlSurfacesNamed: (city.controlSurfaces ?? []).map((s) => s.clientLabel)};

// ---------------------------------------------------------------- GATE 4/5/6 - strict targets
const strict = tasks.filter((t) => typeof t.targetDeviceRef === 'string' && t.targetDeviceRef.length > 0);
findings.strictTargets = strict.map((t) => {
  const chain = events.filter((e) => e.taskId === t.id).sort((a, b) => a.seq - b.seq);
  const assigned = chain.find((e) => e.type === 'TASK_ASSIGNED');
  return {
    id: t.id, createdAt: t.createdAt, target: t.targetDeviceRef, state: t.state,
    assignedNodeId: t.assignedNodeId ?? null, targetStateAtCreation: t.targetStateAtCreation ?? null,
    seqFrom: chain[0]?.seq ?? null, seqTo: chain[chain.length - 1]?.seq ?? null,
    assignedEventSeq: assigned?.seq ?? null,
    assignedToTheTarget: (t.assignedNodeId ?? null) === t.targetDeviceRef,
    sequence: chain.map((e) => `${e.seq}:${e.type}`),
  };
});
findings.strictSummary = {
  count: strict.length,
  allAssignedToTheirTarget: findings.strictTargets.every((s) => s.assignedToTheTarget),
  allTerminalCompleted: findings.strictTargets.every((s) => s.state === 'COMPLETED'),
  aimedAtAlien: findings.strictTargets.filter((s) => s.target === 'Alien-Win').length,
  aimedAtMech: findings.strictTargets.filter((s) => s.target === 'Mech-Win').length,
  createdWhileTargetOffline: findings.strictTargets.filter((s) => s.targetStateAtCreation === 'OFFLINE').map((s) => s.id),
};

// ---------------------------------------------------------------- GATE 7 - untargeted
const plain = tasks.filter((t) => !t.targetDeviceRef);
findings.untargeted = {
  count: plain.length,
  completed: plain.filter((t) => t.state === 'COMPLETED').length,
  failed: plain.filter((t) => t.state === 'FAILED').length,
  assignees: [...new Set(plain.map((t) => t.assignedNodeId).filter(Boolean))],
  anyAssignedToNonWorker: plain.filter((t) => t.assignedNodeId && !nodes.some((n) => n.id === t.assignedNodeId)).map((t) => t.id),
};

// ---------------------------------------------------------------- what truth cannot answer
findings.attributionBound = {
  actionFields: Object.keys((await api('actions')).actions?.[0] ?? {}),
  taskFields: Object.keys(tasks[0] ?? {}),
  statement: 'neither the Action nor the City task carries a requester/clientRef/actor for the instruction that created it, so canonical truth cannot say WHICH surface issued a strict-target instruction; an Android-issued run and a script-issued run are indistinguishable except by the opaque idempotencyKey',
};

mkdirSync(OUT_DIR, {recursive: true});
const receipt = {instrument: 'mech-mesh301-review-analysis/1', head, cityUrl: CITY, cityId: city.cityId, generatedAt: new Date().toISOString(), maxSeq: Math.max(0, ...events.map((e) => e.seq ?? 0)), findings};
writeFileSync(`${OUT_DIR}/mech-review-analysis.json`, JSON.stringify(receipt, null, 2));

console.log(`head ${head}`);
console.log(`GATE 1 three named surfaces across window 2 (04:00:25-04:26:00Z): ${JSON.stringify(findings.gate1.window2)}`);
console.log(`        named intervals recorded: ${named.length}; anonymous (unattributable) connection episodes: ${anonymous.length}`);
console.log(`GATE 2 nodes: ${findings.gate2.map((n) => `${n.id}(${n.platform},online=${n.online})`).join(' ')}`);
console.log(`GATE 3 android-named nodes: ${findings.gate3.androidNamedNodes}; named control surfaces now: ${JSON.stringify(findings.gate3.controlSurfacesNamed)}`);
console.log(`GATE 4/5/6 strict tasks: ${findings.strictSummary.count} (Alien ${findings.strictSummary.aimedAtAlien} / Mech ${findings.strictSummary.aimedAtMech}), all assigned to their target: ${findings.strictSummary.allAssignedToTheirTarget}, all COMPLETED: ${findings.strictSummary.allTerminalCompleted}`);
console.log(`        created while the target was OFFLINE: ${findings.strictSummary.createdWhileTargetOffline.length}`);
console.log(`GATE 7 untargeted: ${findings.untargeted.count} total, ${findings.untargeted.completed} completed, ${findings.untargeted.failed} failed, assignees=${JSON.stringify(findings.untargeted.assignees)}, assigned to a non-worker: ${findings.untargeted.anyAssignedToNonWorker.length}`);
console.log(`receipt: ${OUT_DIR}/mech-review-analysis.json`);
