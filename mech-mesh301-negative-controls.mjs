// MESH-301 review instrument - NEGATIVE CONTROLS, rebuilt by the MECH host with its own values.
//
// The workbook's review section requires the reviewing host to run "at least one stale/duplicate/unauthorised
// target" negative control ITSELF, and the completion gate 6 requires the unavailable/unknown/duplicate family
// to fail honest. Alien's `negative` probe covers the same ground; this is not a re-run of it, it is an
// independent instrument with different probe values, so that agreement between the two means something.
//
// WHAT IS DELIBERATELY *NOT* HERE
//   * the raw `POST /api/v0/node/claim` attempt as the WRONG node. It is the most direct way to test the claim
//     guard, and it is also the only control that can leave damage: a manual claim that takes a QUEUED
//     untargeted task assigns it to this host's node with nothing to execute it, and a task stuck in ASSIGNED
//     is a worse outcome than a control not run. The same property is exercised without that risk by the
//     observation form (a strict task for the other device is never assigned here), and the away-target case
//     is covered by mech-mesh301-offline-target.mjs.
//   * anything that needs the OTHER host's worker to be offline. Only Alien may take Alien-Win away.
//
// USAGE
//   CITY_URL=... CITY_TOKEN=... node mech-mesh301-negative-controls.mjs
import {writeFileSync, mkdirSync} from 'node:fs';

const CITY = (process.env.CITY_URL || 'http://172.31.3.110:4391').replace(/\/$/, '');
const TOKEN = process.env.CITY_TOKEN || '';
const SELF = process.env.MESH_SELF || 'Mech-Win';
const OTHER = process.env.MESH_OTHER || 'Alien-Win';
const SURFACE_LABEL = process.env.MESH_SURFACE_LABEL || 'Mech-Win-Web';
const EVIDENCE = `${process.cwd()}/evidence/raw/mission-book/MESH-301/review-by-mech`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(m);

const api = async (path, body) => {
  const r = await fetch(`${CITY}/api/v0/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)});
  return {status: r.status, json: await r.json().catch(() => null)};
};
// One strict-target instruction through the canonical user-level Action route - the same route the Android
// client uses and the same one the Web surface's Run control submits to.
const strictAction = (target, key) => api('actions', {route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input: {targetDeviceRef: target}, idempotencyKey: key});
// The route answers failures in TWO different envelopes, and an instrument that only knows one of them reports
// "no error" for the other. Measured, not guessed:
//   * a target the City refuses      -> http 200 with an ACTION whose status is REFUSED and action.error.code set
//   * an idempotency key reused for a different request -> http 400 with a TOP-LEVEL {error, errorCode} and no
//     action at all, because the refusal happens before an Action exists.
// My first run of this suite read only the action envelope and therefore scored the key-reuse refusal as a FAIL
// with `status=undefined code=undefined` - the refusal was correct and my reading of it was wrong.
const errCode = (res) => res?.json?.errorCode ?? res?.json?.action?.error?.code ?? null;
const taskIdOf = (res) => res?.json?.action?.backendRef?.taskId ?? null;
const taskCount = async (pred) => ((await api('tasks')).json?.tasks ?? []).filter(pred).length;

const checks = [];
const check = (name, verdict, evidence) => { checks.push({name, verdict, evidence}); say(`  ${verdict.padEnd(5)} ${name}\n        ${evidence}`); };
const run = Date.now();
const key = (s) => `mech-neg-${s}-${run}`;

if (!TOKEN) { console.error('CITY_TOKEN required'); process.exit(2); }
mkdirSync(EVIDENCE, {recursive: true});

const findings = {};
try {
  say('=== MESH-301 review instrument: negative controls (Mech host, own values) ===');
  const city = (await api('city')).json;
  const fleet = (city?.nodes ?? []).map((n) => `${n.id}:${n.online}`).join(', ');
  say(`cityId=${city?.cityId}  nodes=${fleet}`);
  check('the control runs against a City with both real workers online',
    (city?.nodes ?? []).length === 2 && (city.nodes ?? []).every((n) => n.online) ? 'PASS' : 'FAIL', `nodes=${fleet}`);

  // 1. unknown target: a well-formed name that never registered.
  const unknownName = 'Mech-Review-Phantom';
  const r1 = await strictAction(unknownName, key('unknown'));
  findings.unknown = {http: r1.status, status: r1.json?.action?.status, code: errCode(r1), taskId: taskIdOf(r1)};
  check('an unknown but well-formed device is refused with a TYPED code and creates no task',
    errCode(r1) === 'TARGET_DEVICE_UNKNOWN' && !taskIdOf(r1) ? 'PASS' : 'FAIL',
    `http=${r1.status} status=${r1.json?.action?.status} code=${errCode(r1)} taskId=${taskIdOf(r1)}`);

  // 2. malformed target: not a node identity at all, and clearly distinguishable from "unknown".
  const badName = 'not a valid id!';
  const r2 = await strictAction(badName, key('malformed'));
  findings.malformed = {http: r2.status, status: r2.json?.action?.status, code: errCode(r2), taskId: taskIdOf(r2)};
  check('a malformed device id is refused as MALFORMED, not silently treated as unknown',
    errCode(r2) === 'TARGET_DEVICE_MALFORMED' && !taskIdOf(r2) ? 'PASS' : 'FAIL',
    `http=${r2.status} status=${r2.json?.action?.status} code=${errCode(r2)} taskId=${taskIdOf(r2)}`);

  // 3. a CONTROL SURFACE name offered as a device. This is the confusion the MESH-301 audit exists for, and the
  //    value is visible in the same City snapshot, so accepting it would be easy and wrong.
  const r3 = await strictAction(SURFACE_LABEL, key('surface-as-device'));
  findings.surfaceAsDevice = {http: r3.status, status: r3.json?.action?.status, code: errCode(r3), taskId: taskIdOf(r3)};
  check('a control surface\'s label is refused as a DEVICE, even though the City shows that label',
    errCode(r3) === 'TARGET_DEVICE_UNKNOWN' && !taskIdOf(r3) ? 'PASS' : 'FAIL',
    `target=${SURFACE_LABEL} http=${r3.status} status=${r3.json?.action?.status} code=${errCode(r3)} taskId=${taskIdOf(r3)}`);

  // 4. duplicate submit: the same user action retried must REPLAY, not execute twice.
  const dupKey = key('duplicate');
  const d1 = await strictAction(OTHER, dupKey);
  const d2 = await strictAction(OTHER, dupKey);
  const t1 = taskIdOf(d1);
  const t2 = taskIdOf(d2);
  const sameAction = d1.json?.action?.actionId && d1.json.action.actionId === d2.json?.action?.actionId;
  findings.duplicate = {firstTask: t1, secondTask: t2, sameActionId: Boolean(sameAction), replayHttp: d2.status};
  check('a retried identical instruction replays the SAME task and does not execute twice',
    Boolean(t1) && t1 === t2 ? 'PASS' : 'FAIL',
    `first=${t1} second=${t2} sameActionId=${Boolean(sameAction)} replayHttp=${d2.status}`);
  await sleep(1500);
  const dupTasks = await taskCount((t) => t.id === t1);
  check('exactly one task exists for the replayed instruction',
    dupTasks === 1 ? 'PASS' : 'FAIL', `tasks with id ${t1}: ${dupTasks}`);

  // 5. one key must not be made to mean two different devices.
  // The check is a SET DIFFERENCE, not a lookup: City tasks carry no idempotencyKey field (their keys are
  // apiVersion, schemaVersion, id, type, domain, state, createdAt, updatedAt, assignedNodeId, progress,
  // lastCheckpoint, result, error, targetDeviceRef, targetIntentAt, targetStateAtCreation), so asking a task
  // for "its key" would compare against undefined and pass vacuously - a check that cannot fail is not a check.
  const selfTasksBefore = new Set(((await api('tasks')).json?.tasks ?? []).filter((t) => t.targetDeviceRef === SELF).map((t) => t.id));
  const r5 = await strictAction(SELF, dupKey);
  await sleep(1500);
  const selfTasksAfter = ((await api('tasks')).json?.tasks ?? []).filter((t) => t.targetDeviceRef === SELF).map((t) => t.id);
  const newSelfTasks = selfTasksAfter.filter((id) => !selfTasksBefore.has(id));
  findings.keyReuse = {http: r5.status, code: errCode(r5), taskId: taskIdOf(r5), rawError: r5.json?.error ?? null, newTasksTargetedAtSelf: newSelfTasks};
  check('one idempotency key cannot be reused for a DIFFERENT device',
    r5.status === 400 && errCode(r5) === 'IDEMPOTENCY_KEY_REUSED' ? 'PASS' : 'FAIL',
    `same key, target ${SELF}: http=${r5.status} code=${errCode(r5)} message=${JSON.stringify(r5.json?.error ?? r5.json?.action?.error?.message ?? null)} taskId=${taskIdOf(r5)}`);
  check('the refused reuse created no task aimed at the wrong device',
    newSelfTasks.length === 0 ? 'PASS' : 'FAIL', `new tasks targeted at ${SELF} created by that attempt: ${newSelfTasks.length ? newSelfTasks.join(', ') : 'none'}`);

  // 6. no silent fallback, observed rather than asserted: a strict task for the other device must never land here.
  let strictTask = t1;
  let assignee = null;
  for (let i = 0; i < 40; i++) {
    const t = (await api(`tasks/${encodeURIComponent(strictTask)}`)).json;
    assignee = t?.assignedNodeId ?? null;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(t?.state)) break;
    await sleep(500);
  }
  const strictFinal = (await api(`tasks/${encodeURIComponent(strictTask)}`)).json;
  findings.noFallback = {taskId: strictTask, assignedNodeId: strictFinal?.assignedNodeId ?? null, state: strictFinal?.state};
  check(`a strict task for ${OTHER} is executed by ${OTHER} and never by this host`,
    strictFinal?.assignedNodeId === OTHER && !['FAILED', 'CANCELLED'].includes(strictFinal?.state) ? 'PASS' : 'FAIL',
    `taskId=${strictTask} assignedNodeId=${strictFinal?.assignedNodeId} state=${strictFinal?.state} progress=${strictFinal?.progress}`);

  // 7. untargeted regression, inside this run: ordinary tasks must still be scheduled and finished normally.
  const plain = [];
  for (let i = 0; i < 3; i++) { const t = (await api('tasks', {type: 'CHECKPOINT_DEMO'})).json; plain.push(t?.id); await sleep(600); }
  let plainOk = 0;
  const plainAssignees = [];
  for (const id of plain) {
    for (let i = 0; i < 60; i++) {
      const t = (await api(`tasks/${encodeURIComponent(id)}`)).json;
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(t?.state)) { if (t.state === 'COMPLETED') plainOk += 1; plainAssignees.push(`${id}:${t.state}/${t.assignedNodeId}`); break; }
      await sleep(500);
    }
  }
  findings.untargeted = {created: plain.length, completed: plainOk, assignees: plainAssignees};
  check('untargeted tasks are still scheduled and completed with no regression',
    plainOk === plain.length ? 'PASS' : 'FAIL', `created=${plain.length} completed=${plainOk} :: ${plainAssignees.join(' ')}`);
  check('untargeted work is still taken by the two REAL workers only',
    plainAssignees.every((s) => s.endsWith(SELF) || s.endsWith(OTHER)) ? 'PASS' : 'FAIL',
    `assignees=${plainAssignees.join(' ')}`);

  const verdict = checks.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL';
  say(`\nVERDICT: ${verdict}`);
  writeFileSync(`${EVIDENCE}/mech-negative-controls.json`, JSON.stringify({
    instrument: 'mech-mesh301-negative-controls/1', city: CITY, cityId: city?.cityId ?? null,
    self: SELF, other: OTHER, surfaceLabel: SURFACE_LABEL, checks, findings, verdict,
    note: 'the raw node/claim attempt as the wrong node is deliberately absent; see the header for why',
    finishedAt: new Date().toISOString()}, null, 2));
  say(`receipt: ${EVIDENCE}/mech-negative-controls.json`);
  if (verdict !== 'PASS') process.exitCode = 1;
} catch (e) {
  say(`ABORTED: ${e.message}`);
  process.exitCode = 1;
}
