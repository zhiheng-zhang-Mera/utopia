// MESH-301 review instrument - OFFLINE TARGET, run by the MECH host against the shared canonical City.
//
// Why this one is uniquely the Mech host's: the control needs a worker that is genuinely away, and the only
// worker this host may take away is its own. v2 of the resident supervisor added a control file for exactly
// this, so the outage is a bounded, reversible action rather than a gamble: `.runtime/mesh301-resident-control.json`
// with {"shared":"down"} stops the shared-City worker ON PURPOSE and {"shared":"up"} brings it back.
//
// What it establishes, each as a check rather than a narrative:
//   * a strict task aimed at a device that is AWAY is created and WAITS - it is not refused, and it is not
//     rerouted to the healthy device that is sitting right there;
//   * the healthy device never takes it while the named device is away;
//   * when the named device returns, canonical truth emits TASK_TARGET_READY and ONLY then does that device
//     claim, run and finish it;
//   * the whole offline -> waiting -> ready -> completed transition is visible in canonical seq.
//
// It deliberately does NOT claim anything about Android (gate 9 is Android's offline/reconnect), and it is not
// review evidence against the reviewed head until it is re-run on that head; this run also validates the
// mechanism, which has to be proven before the review can depend on it.
import {writeFileSync, mkdirSync} from 'node:fs';

const CITY = (process.env.CITY_URL || 'http://172.31.3.110:4391').replace(/\/$/, '');
const TOKEN = process.env.CITY_TOKEN || '';
const MINE = process.env.MESH_SELF || 'Mech-Win';
const OTHER = process.env.MESH_OTHER || 'Alien-Win';
const CONTROL = process.env.RESIDENT_CONTROL_FILE || 'D:/A-utopia/.runtime/mesh301-resident-control.json';
const EVIDENCE = `${process.cwd()}/evidence/raw/mission-book/MESH-301/review-by-mech`;
const DOWN_TIMEOUT_MS = 45000;
const BACK_TIMEOUT_MS = 60000;
const NO_FALLBACK_WATCH_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const say = (m) => console.log(m);

const api = async (path, body) => {
  const r = await fetch(`${CITY}/api/v0/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)});
  return {status: r.status, json: await r.json().catch(() => null)};
};
const setControl = async (shared) => {
  writeFileSync(CONTROL, JSON.stringify({shared, local: 'up'}));
  say(`  control file -> shared:${shared}`);
};
const nodeState = async (id) => ((await api('city')).json?.nodes ?? []).find((n) => n.id === id) ?? null;
const maxSeq = async () => Math.max(0, ...((await api('events')).json?.events ?? []).map((e) => e.seq ?? 0));

const checks = [];
const check = (name, verdict, evidence) => { checks.push({name, verdict, evidence}); say(`  ${verdict.padEnd(5)} ${name} -- ${evidence}`); };
const timeline = [];
const note = (seq, type, taskId, payload, timestamp) => timeline.push({seq, type, taskId, payload, timestamp});

if (!TOKEN) { console.error('CITY_TOKEN required'); process.exit(2); }
mkdirSync(EVIDENCE, {recursive: true});

let taskId = null;
let restored = false;
try {
  say('=== MESH-301 review instrument: OFFLINE TARGET (Mech host takes its own worker away) ===');
  say(`city ${CITY}   target ${MINE}   healthy other ${OTHER}`);
  const before = await nodeState(MINE);
  check(`${MINE} is online before the control`, before?.online === true ? 'PASS' : 'FAIL', `online=${before?.online} hb=${before?.lastHeartbeatAt}`);

  const baseSeq = await maxSeq();
  say(`  canonical seq before the control: ${baseSeq}`);

  // ---- 1. take my own worker away, on purpose -------------------------------------------------------------
  const tDown = Date.now();
  await setControl('down');
  let away = null;
  while (Date.now() - tDown < DOWN_TIMEOUT_MS) {
    away = await nodeState(MINE);
    if (away && away.online === false) break;
    await sleep(1000);
  }
  const offlineAt = Date.now();
  check(`the City marks ${MINE} offline after the worker is stopped`, away?.online === false ? 'PASS' : 'FAIL', `online=${away?.online} after ${offlineAt - tDown}ms`);

  // ---- 2. a strict instruction for the AWAY device --------------------------------------------------------
  const onlineOther = await nodeState(OTHER);
  const created = await api('actions', {
    route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO',
    input: {targetDeviceRef: MINE}, idempotencyKey: `mech-offline-target-${Date.now()}`});
  const action = created.json?.action ?? null;
  taskId = action?.backendRef?.taskId ?? null;
  check('a strict task for an AWAY device is created, not refused', Boolean(taskId) && action?.status !== 'REFUSED' ? 'PASS' : 'FAIL',
    `httpStatus=${created.status} actionStatus=${action?.status} error=${JSON.stringify(action?.error ?? null)} taskId=${taskId}`);
  const task0 = taskId ? (await api(`tasks/${encodeURIComponent(taskId)}`)).json : null;
  check('the task carries the target and records the target state at creation',
    task0?.targetDeviceRef === MINE && task0?.targetStateAtCreation && task0.targetStateAtCreation !== 'ELIGIBLE' ? 'PASS' : 'FAIL',
    `targetDeviceRef=${task0?.targetDeviceRef} targetStateAtCreation=${task0?.targetStateAtCreation} assignedNodeId=${task0?.assignedNodeId}`);

  // ---- 3. the healthy device must NOT take it -------------------------------------------------------------
  say(`  watching ${NO_FALLBACK_WATCH_MS}ms for a silent reassignment to ${OTHER} (which is online=${onlineOther?.online})...`);
  let assigned = null;
  const watchEnd = Date.now() + NO_FALLBACK_WATCH_MS;
  while (Date.now() < watchEnd) {
    const t = (await api(`tasks/${encodeURIComponent(taskId)}`)).json;
    if (t?.assignedNodeId) { assigned = t.assignedNodeId; break; }
    await sleep(1000);
  }
  const taskAway = (await api(`tasks/${encodeURIComponent(taskId)}`)).json;
  check(`the online device ${OTHER} does NOT take a task strictly targeted at the away device`,
    assigned === null && taskAway?.assignedNodeId === null ? 'PASS' : 'FAIL',
    `assignedNodeId=${taskAway?.assignedNodeId ?? null} state=${taskAway?.state} after ${NO_FALLBACK_WATCH_MS}ms with ${OTHER} online=${onlineOther?.online}`);

  const during = (await api('events')).json?.events ?? [];
  for (const e of during) if (e.taskId === taskId) note(e.seq, e.type, e.taskId, e.payload, e.timestamp);
  const waiting = during.find((e) => e.taskId === taskId && e.type === 'TASK_TARGET_WAITING');
  check('canonical truth says WHY nothing moved (TASK_TARGET_WAITING with the target state)',
    Boolean(waiting) && waiting.payload?.targetState && waiting.payload.targetState !== 'ELIGIBLE' ? 'PASS' : 'FAIL',
    waiting ? `seq ${waiting.seq} targetState=${waiting.payload.targetState} reason=${waiting.payload.reason}` : 'no TASK_TARGET_WAITING event for this task');

  // ---- 4. bring my worker back, and let the wait resolve --------------------------------------------------
  const tUp = Date.now();
  await setControl('up');
  let back = null;
  while (Date.now() - tUp < BACK_TIMEOUT_MS) {
    back = await nodeState(MINE);
    if (back && back.online === true) break;
    await sleep(1000);
  }
  const onlineAt = Date.now();
  check(`${MINE} returns to canonical truth as online`, back?.online === true ? 'PASS' : 'FAIL', `online=${back?.online} after ${onlineAt - tUp}ms`);

  let task = null;
  const settleEnd = Date.now() + 90000;
  while (Date.now() < settleEnd) {
    task = (await api(`tasks/${encodeURIComponent(taskId)}`)).json;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task?.state)) break;
    await sleep(1000);
  }
  check(`ONLY the returning device claims and finishes it`, task?.assignedNodeId === MINE && task?.state === 'COMPLETED' ? 'PASS' : 'FAIL',
    `assignedNodeId=${task?.assignedNodeId} state=${task?.state} progress=${task?.progress} result=${JSON.stringify(task?.lastCheckpoint ?? null)}`);

  const after = (await api('events')).json?.events ?? [];
  for (const e of after) if (e.taskId === taskId && !timeline.some((x) => x.seq === e.seq)) note(e.seq, e.type, e.taskId, e.payload, e.timestamp);
  timeline.sort((a, b) => a.seq - b.seq);
  const ready = timeline.find((e) => e.type === 'TASK_TARGET_READY');
  const assignedEv = timeline.find((e) => e.type === 'TASK_ASSIGNED');
  check('TASK_TARGET_READY fires on the device return, before the claim',
    Boolean(ready) && (!assignedEv || ready.seq < assignedEv.seq) ? 'PASS' : 'FAIL',
    ready ? `ready seq ${ready.seq}; assigned seq ${assignedEv?.seq ?? '-'}` : 'no TASK_TARGET_READY event');
  check(`the ${OTHER} node never claimed it anywhere in the timeline`,
    timeline.every((e) => !(e.type === 'TASK_ASSIGNED' && e.payload?.assignedNodeId === OTHER)) ? 'PASS' : 'FAIL',
    `assignment events: ${JSON.stringify(timeline.filter((e) => e.type === 'TASK_ASSIGNED').map((e) => e.payload))}`);

  restored = back?.online === true;
  const verdict = checks.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL';
  say('');
  say(`VERDICT: ${verdict}`);
  for (const t of timeline) say(`  seq ${t.seq} ${t.type} ${JSON.stringify(t.payload).slice(0, 150)}`);

  writeFileSync(`${EVIDENCE}/mech-offline-target-negative-control.json`, JSON.stringify({
    instrument: 'mech-mesh301-offline-target/1', city: CITY, target: MINE, other: OTHER,
    controlFile: CONTROL,
    window: {downRequestedAt: new Date(tDown).toISOString(), offlineObservedAt: new Date(offlineAt).toISOString(),
             upRequestedAt: new Date(tUp).toISOString(), onlineObservedAt: new Date(onlineAt).toISOString(),
             awayMs: onlineAt - offlineAt},
    taskId, action: action ? {actionId: action.actionId, status: action.status, backendRef: action.backendRef, error: action.error} : null,
    task: task ? {state: task.state, assignedNodeId: task.assignedNodeId, targetDeviceRef: task.targetDeviceRef, targetStateAtCreation: task.targetStateAtCreation, progress: task.progress, result: task.lastCheckpoint} : null,
    timeline, checks, verdict, finishedAt: nowIso(),
  }, null, 2));
  say(`receipt: ${EVIDENCE}/mech-offline-target-negative-control.json`);
  if (verdict !== 'PASS') process.exitCode = 1;
} catch (e) {
  say(`ABORTED: ${e.message}`);
  process.exitCode = 1;
} finally {
  // The worker MUST go back up, whatever happened above. Leaving endpoint A down because a control failed
  // would turn a measurement into an outage.
  try {
    const s = await nodeState(MINE);
    if (restored !== true || s?.online !== true) {
      say('restoring the worker unconditionally (this is a safety net, not part of the measurement)');
      await setControl('up');
      for (let i = 0; i < 60; i++) { const n = await nodeState(MINE); if (n?.online === true) { say(`${MINE} is back online`); break; } await sleep(1000); }
    }
  } catch (e) { say(`RESTORE FAILED - the resident control file is set to up, but check the window: ${e.message}`); }
}
