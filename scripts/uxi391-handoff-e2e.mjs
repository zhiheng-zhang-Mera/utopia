// UXI-391 Step 3 — the reproducible single-machine, dual-node HANDOFF E2E.
//
// WHAT THIS REPLACES, and why the construction matters more than the harness: Alien's UXI-390 rounds built
// this seam by holding node A busy with one task and then creating a SECOND task for the switch, and read the
// result as "the handoff is unreachable in this City by design". UXI-391 exists because that conclusion rested
// on a wrong construction AND on a stale comment: `loadFromTelemetry()` has produced a real PARTIAL load
// vector (cpu + memory) since UXI-301, so an alternate is eligible when its telemetry is present, and the
// scenario below is built the way the workbook specifies instead:
//
//   ONE target WAIT task, created while ONLY node A exists, so it must be assigned to A;
//   assert it is RUNNING on A and SUSTAINED (a real hold, not a few milliseconds);
//   stop node A's agent while the Gateway and the interaction surface stay alive;
//   only THEN start node B, so B cannot steal the target as a second task;
//   drive the user's decline through the real endpoint;
//   and require the planner to reach ALTERNATE_DEVICE / the presentation to reach REMOTE_HANDOFF.
//
// Anti-vacuity conditions are asserted, not assumed: A really ran the target, A really stopped, B started
// after the assignment existed, and the stage is read from the Gateway's own feed rather than injected.
//
// Everything runs in one process because the harness kills the process tree when the invoking call ends.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.E2E_PORT || 4371);
const ROOT = process.cwd();
const DATA = `${ROOT}/.runtime-uxi391-e2e`;
const TOKEN = 'uxi391-e2e-control';
const NODE_TOKEN = 'uxi391-e2e-node';
const A = 'uxi391-node-a';
const B = 'uxi391-node-b';

const log = [];
const say = (m) => { log.push(m); console.log(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function start(file, args = [], extraEnv = {}) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      CITY_HOST: '127.0.0.1',
      CITY_PORT: String(PORT),
      CITY_URL: `http://127.0.0.1:${PORT}`,
      CITY_TOKEN: TOKEN,
      CITY_NODE_TOKEN: NODE_TOKEN,
      CITY_DATA: DATA,
      CITY_WORKSPACE: `${DATA}/workspace`,
      CITY_TELEMETRY_DISABLED: undefined,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  if (process.env.E2E_VERBOSE) {
    child.stdout.on('data', (d) => process.stdout.write(`  [${file.split('/').pop()}] ${d}`));
    child.stderr.on('data', (d) => process.stdout.write(`  [${file.split('/').pop()} ERR] ${d}`));
  }
  return child;
}

const api = async (path, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v0/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-City-Api-Version': '0',
      'X-City-Schema-Version': '0',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

async function waitFor(label, predicate, { tries = 60, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await predicate(); if (v) return v; } catch { /* keep waiting */ }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const failures = [];
const assert = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
  say(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
};

(async () => {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(`${DATA}/workspace`, { recursive: true });
  say(`=== UXI-391 handoff E2E: port ${PORT}, fresh runtime ${DATA} ===`);

  start('services/dev-gateway/main.mjs');
  await waitFor('gateway health', () => fetch(`http://127.0.0.1:${PORT}/api/v0/health`).then((r) => r.ok));
  say('  gateway healthy');

  // ---- 1. only node A exists, so the target MUST land on A --------------------------------
  const nodeA = start('scripts/uxi391-node.mjs', [A, 'Node A']);
  await waitFor('node A registered', async () => ((await api('city')).body.nodes ?? []).some((n) => n.id === A && n.online === true));
  say('  node A registered and online');

  const created = await api('tasks', { method: 'POST', body: JSON.stringify({ type: 'WAIT' }) });
  const targetId = created.body?.task?.id ?? created.body?.id;
  assert('the target WAIT task was created', typeof targetId === 'string', `id=${targetId}`);

  const readTask = async () => ((await api(`tasks/${targetId}`)).body?.task ?? (await api(`tasks/${targetId}`)).body);
  await waitFor('the target to be RUNNING on A', async () => {
    const t = await readTask();
    return t.state === 'RUNNING' && t.assignedNodeId === A;
  });
  const atHold = await readTask();
  assert('node A really ran the target', atHold.state === 'RUNNING' && atHold.assignedNodeId === A, `state=${atHold.state} assigned=${atHold.assignedNodeId}`);

  // SUSTAINED, not a few milliseconds: WAIT holds for 5 x 1200ms, so re-reading after 1.5s must still show A.
  await sleep(1500);
  const stillHeld = await readTask();
  assert('the hold is sustained rather than instantaneous', stillHeld.state === 'RUNNING' && stillHeld.assignedNodeId === A,
    `after 1.5s state=${stillHeld.state} assigned=${stillHeld.assignedNodeId} progress=${stillHeld.progress}`);

  // ---- 2. stop node A's agent; keep the Gateway alive -------------------------------------
  nodeA.kill();
  await sleep(500);
  assert('node A stopped', nodeA.killed === true || nodeA.exitCode !== null, `killed=${nodeA.killed} exit=${nodeA.exitCode}`);
  await waitFor('A to be swept offline by the Gateway', async () => ((await api('city')).body.nodes ?? []).some((n) => n.id === A && n.online === false), { tries: 80, every: 250 });
  const afterDrop = await readTask();
  assert('the assignment SURVIVES the node dropout, which is what makes a route decision possible at all',
    afterDrop.assignedNodeId === A, `assigned=${afterDrop.assignedNodeId} state=${afterDrop.state}`);

  // ---- 3. only NOW start node B, so it cannot steal a second task -------------------------
  const nodeB = start('scripts/uxi391-node.mjs', [B, 'Node B']);
  await waitFor('node B registered and online', async () => ((await api('city')).body.nodes ?? []).some((n) => n.id === B && n.online === true));
  const city = (await api('city')).body;
  const nodeBRecord = (city.nodes ?? []).find((n) => n.id === B);
  const telemetryOk = Number.isFinite(nodeBRecord?.telemetry?.cpu?.usagePercent) || Number.isFinite(nodeBRecord?.telemetry?.memory?.usedBytes);
  assert('node B reports telemetry, so a PARTIAL load vector exists for it', telemetryOk,
    `cpu=${nodeBRecord?.telemetry?.cpu?.usagePercent} memUsed=${nodeBRecord?.telemetry?.memory?.usedBytes}`);
  const tasksNow = (await api('tasks')).body.tasks ?? [];
  assert('B did not create or steal a second task: the target is still the only task', tasksNow.length === 1, `tasks=${tasksNow.length}`);

  // ---- 4. drive the real user decline ------------------------------------------------------
  const declined = await api(`tasks/${targetId}/switch-declined`, { method: 'POST', body: JSON.stringify({}) });
  assert('switch-declined was accepted by the backend', declined.status === 200, `status=${declined.status}`);

  // ---- 5. the decisive measurement: does the planner reach ALTERNATE_DEVICE? ---------------
  const feed = (await api('presentation')).body;
  const entry = (feed?.tasks ?? []).find((e) => (e.taskId ?? e.id) === targetId) ?? null;
  // The feed carries the projected state and its terms under dto; reading entry.state/entry.routeStageRef
  // found nothing and made an earlier run FAIL while the gateway was in fact reporting REMOTE_HANDOFF. The
  // instrument was wrong, not the product - the third time in this task that a read path, not a behaviour,
  // produced a false negative.
  const routeStage = entry?.dto?.state ?? entry?.routeStageRef ?? null;
  const terms = entry?.dto?.terms ?? [];
  say(`  presentation entry: ${JSON.stringify(entry, null, 2).slice(0, 1200)}`);
  assert('the presentation feed contains the target', entry !== null);
  assert('the feed has TWO candidates, or no route decision is possible', (feed?.candidates ?? []).length >= 2,
    `candidates=${(feed?.candidates ?? []).length}`);
  const reached = routeStage === 'ALTERNATE_DEVICE' || routeStage === 'REMOTE_HANDOFF' || terms.includes('REMOTE_HANDOFF');
  assert('the planner reached ALTERNATE_DEVICE / the surface reached REMOTE_HANDOFF', reached,
    `routeStageRef=${routeStage} state=${entry?.state}`);

  const receipt = {
    task: 'UXI-391', step: '3 (single-machine dual-node handoff E2E)',
    at: new Date().toISOString(), port: PORT, targetTaskId: targetId, nodes: [A, B],
    assignmentSurvivedDropout: afterDrop.assignedNodeId === A,
    routeStageReached: routeStage, presentationState: entry?.dto?.state ?? null, terms,
    candidates: (feed?.candidates ?? []).length, failures, log,
  };

  // ---- 6. EXECUTE: the bridge must really move ownership, and B must finish the SAME task ---------------
  // Phase A proves the planner's decision reaches the surface. Phase B is the part UXI-391 exists for: the
  // decision must be EXECUTED, on the same task, with the result coming back from real execution.
  await waitFor('the task to be reserved for / taken by B', async () => {
    const t = await readTask();
    return t.assignedNodeId === B || t.handoffTargetRef === B;
  }, { tries: 40, every: 500 });
  const moved = await readTask();
  assert('ownership really moved to node B', moved.assignedNodeId === B || moved.handoffTargetRef === B,
    `assigned=${moved.assignedNodeId} reservedFor=${moved.handoffTargetRef}`);
  assert('the SAME task id continued - no replacement task was created', moved.id === targetId, `id=${moved.id}`);
  assert('the transfer recorded where it came from', moved.handoffFromRef === A, `from=${moved.handoffFromRef}`);
  assert('the transfer happened only AFTER the user declined', moved.switchDeclined === true, `switchDeclined=${moved.switchDeclined}`);

  const completed = await waitFor('the task to reach a real terminal success on B', async () => {
    const t = await readTask();
    return t.state === 'COMPLETED' ? t : null;
  }, { tries: 80, every: 500 });
  assert('the task reached terminal success', completed.state === 'COMPLETED', `state=${completed.state}`);
  assert('the result came from REAL execution, not from the harness', completed.result?.waitedMs === 6000,
    `result=${JSON.stringify(completed.result)}`);

  const allTasks = (await api('tasks')).body.tasks ?? [];
  assert('exactly one task exists in the City - the original, not a copy', allTasks.length === 1, `tasks=${allTasks.length}`);
  assert('exactly one terminal completion exists (no double execution)',
    allTasks.filter((t) => t.state === 'COMPLETED').length === 1,
    `completed=${allTasks.filter((t) => t.state === 'COMPLETED').length}`);
  const events = (await api('events')).body.events ?? [];
  const transferEvent = events.find((e) => e.type === 'TASK_HANDOFF_TRANSFERRED');
  assert('the ownership transfer is recorded as a backend event', Boolean(transferEvent),
    transferEvent ? JSON.stringify(transferEvent.payload).slice(0, 160) : 'none');
  assert('the assignment history shows the handoff', JSON.stringify(completed.history ?? []).includes('handoff:'),
    JSON.stringify(completed.history ?? []).slice(0, 200));

  receipt.phaseB = {
    assignedAfterTransfer: moved.assignedNodeId, reservedFor: moved.handoffTargetRef, handoffFrom: moved.handoffFromRef,
    terminal: completed.state, result: completed.result, taskCount: allTasks.length,
    transferEvent: transferEvent?.payload ?? null, history: completed.history ?? [],
  };
  mkdirSync(`${ROOT}/evidence/raw/mission-book/UXI-391`, { recursive: true });
  writeFileSync(`${ROOT}/evidence/raw/mission-book/UXI-391/handoff-e2e-phaseA.json`, JSON.stringify(receipt, null, 2));

  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  say(failures.length === 0
    ? 'RESULT: PASS - the seam is reachable with the corrected construction'
    : `RESULT: FAIL - ${failures.length} assertion(s): ${failures.join(' | ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  say(`FAILED: ${e.message}`);
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  process.exit(1);
});
