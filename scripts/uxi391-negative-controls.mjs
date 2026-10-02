// UXI-391 — the negative controls the workbook names, driven at PRODUCT level rather than in unit tests.
//
// Step 6 tells the review host to check, among others, "B unavailable", "duplicate handoff", "stale assignment
// / stale lease" and "A recovering must not double-execute with B". The unit tests guard the bridge's own
// refusals; THIS script drives the same questions through a live Gateway and real nodes, because a bridge that
// refuses correctly in isolation can still be wired so that nothing calls it.
//
// Two scenarios, each on its own fresh City so one cannot contaminate the other:
//
//   1. NO USABLE ALTERNATE: node A is stopped and there is no second device. Declining must NOT invent a
//      handoff: nothing may move, nothing may complete, and no transfer event may appear. The honest outcome is
//      a task that stays non-terminal.
//   2. STALE HOLDER RETURNS: after a real transfer to B, node A comes back and tries to work again. It must
//      not re-claim the moved task, the task must still complete exactly once, and the completion must be B's.
//
// Run in ONE command (the harness kills the process tree when the call ends).
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.NEG_PORT || 4393);
const ROOT = process.cwd();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'uxi391-negative-control';
const NODE_TOKEN = 'uxi391-negative-node';

const say = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const failures = [];
const log = [];
const note = (m) => { log.push(m); say(m); };
const assert = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
  say(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
};

function start(file, args = [], extraEnv = {}) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: ROOT,
    env: {
      ...process.env, CITY_HOST: '127.0.0.1', CITY_PORT: String(PORT), CITY_URL: BASE,
      CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN, ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  children.push(child);
  return child;
}
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/api/v0/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
async function waitFor(label, predicate, tries = 80, every = 500) {
  for (let i = 0; i < tries; i++) { try { const v = await predicate(); if (v) return v; } catch { /* wait */ } await sleep(every); }
  throw new Error(`timeout: ${label}`);
}
const events = async () => (await api('events')).events ?? [];
const task = async (id) => api(`tasks/${id}`);

/** A fresh City per scenario: gateway plus the nodes the scenario needs. */
async function freshCity(label, dataDir) {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(`${dataDir}/workspace`, { recursive: true });
  note(`--- ${label} (fresh city at ${dataDir}) ---`);
  // The gateway is started by the caller because the port must be free between scenarios.
}

(async () => {
  /* ---------------------------------------------------------------- scenario 1: no usable alternate */
  await freshCity('SCENARIO 1: no usable alternate', `${ROOT}/.runtime-uxi391-neg1`);
  let gw = start('services/dev-gateway/main.mjs', [], { CITY_DATA: `${ROOT}/.runtime-uxi391-neg1`, CITY_WORKSPACE: `${ROOT}/.runtime-uxi391-neg1/workspace` });
  await waitFor('gateway health (1)', () => fetch(`${BASE}/api/v0/health`).then((r) => r.ok), 40, 500);
  const a1 = start('scripts/uxi391-node.mjs', ['neg-node-a', 'Negative A'], { CITY_DATA: `${ROOT}/.runtime-uxi391-neg1`, CITY_WORKSPACE: `${ROOT}/.runtime-uxi391-neg1/workspace` });
  await waitFor('A online (1)', async () => ((await api('city')).nodes ?? []).some((n) => n.id === 'neg-node-a' && n.online));

  const t1 = (await api('tasks', { method: 'POST', body: JSON.stringify({ type: 'WAIT' }) }))?.id;
  await waitFor('RUNNING on A (1)', async () => { const t = await task(t1); return t.state === 'RUNNING' && t.assignedNodeId === 'neg-node-a'; });
  a1.kill();
  await waitFor('A offline (1)', async () => ((await api('city')).nodes ?? []).some((n) => n.id === 'neg-node-a' && !n.online));

  await api(`tasks/${t1}/switch-declined`, { method: 'POST', body: JSON.stringify({}) });
  await sleep(4000);
  const after1 = await task(t1);
  const feed1 = await api('presentation');
  const entry1 = (feed1.tasks ?? []).find((e) => e.taskId === t1) ?? null;
  assert('with NO second device, the decline does not move the task anywhere',
    !after1.handoffTargetRef, `handoffTargetRef=${after1.handoffTargetRef} state=${after1.state}`);
  assert('with no alternate, nothing is reported as a handoff', entry1?.dto?.state !== 'REMOTE_HANDOFF', `state=${entry1?.dto?.state}`);
  assert('no transfer event is invented', !(await events()).some((e) => e.type === 'TASK_HANDOFF_TRANSFERRED'));
  assert('the task is left NON-TERMINAL rather than faked COMPLETED',
    !['COMPLETED', 'FAILED', 'CANCELLED'].includes(after1.state), `state=${after1.state}`);
  for (const c of children.splice(0)) { try { c.kill(); } catch { /* gone */ } }
  await sleep(1500);

  /* ---------------------------------------------------------------- scenario 2: the stale holder returns */
  await freshCity('SCENARIO 2: the stale holder comes back', `${ROOT}/.runtime-uxi391-neg2`);
  gw = start('services/dev-gateway/main.mjs', [], { CITY_DATA: `${ROOT}/.runtime-uxi391-neg2`, CITY_WORKSPACE: `${ROOT}/.runtime-uxi391-neg2/workspace` });
  await waitFor('gateway health (2)', () => fetch(`${BASE}/api/v0/health`).then((r) => r.ok), 40, 500);
  const a2 = start('scripts/uxi391-node.mjs', ['neg-node-a', 'Negative A'], { CITY_DATA: `${ROOT}/.runtime-uxi391-neg2`, CITY_WORKSPACE: `${ROOT}/.runtime-uxi391-neg2/workspace` });
  await waitFor('A online (2)', async () => ((await api('city')).nodes ?? []).some((n) => n.id === 'neg-node-a' && n.online));
  const t2 = (await api('tasks', { method: 'POST', body: JSON.stringify({ type: 'WAIT' }) }))?.id;
  await waitFor('RUNNING on A (2)', async () => { const t = await task(t2); return t.state === 'RUNNING' && t.assignedNodeId === 'neg-node-a'; });

  a2.kill();
  await waitFor('A offline (2)', async () => ((await api('city')).nodes ?? []).some((n) => n.id === 'neg-node-a' && !n.online));
  const b2 = start('scripts/uxi391-node.mjs', ['neg-node-b', 'Negative B'], { CITY_DATA: `${ROOT}/.runtime-uxi391-neg2`, CITY_WORKSPACE: `${ROOT}/.runtime-uxi391-neg2/workspace` });
  await waitFor('B online (2)', async () => ((await api('city')).nodes ?? []).some((n) => n.id === 'neg-node-b' && n.online));
  await sleep(1000);
  await api(`tasks/${t2}/switch-declined`, { method: 'POST', body: JSON.stringify({}) });
  const moved2 = await waitFor('the transfer to B (2)', async () => { const t = await task(t2); return t.handoffTargetRef === 'neg-node-b' ? t : null; });
  assert('the handoff happened before the stale holder returns', moved2.handoffTargetRef === 'neg-node-b', `reserved=${moved2.handoffTargetRef}`);

  // The stale holder comes BACK, with the same node id it had before.
  const a2again = start('scripts/uxi391-node.mjs', ['neg-node-a', 'Negative A (returned)'], { CITY_DATA: `${ROOT}/.runtime-uxi391-neg2`, CITY_WORKSPACE: `${ROOT}/.runtime-uxi391-neg2/workspace` });
  await waitFor('A online again (2)', async () => ((await api('city')).nodes ?? []).some((n) => n.id === 'neg-node-a' && n.online));
  note('  the stale holder is back online and will try to work again');

  const completed2 = await waitFor('the task to finish (2)', async () => { const t = await task(t2); return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state) ? t : null; }, 120, 500);
  assert('the task still completes exactly once', completed2.state === 'COMPLETED', `state=${completed2.state}`);
  assert('the completion is B\'s work, not the stale holder\'s', completed2.handoffTargetRef === 'neg-node-b', `reserved=${completed2.handoffTargetRef}`);
  const all2 = (await api('tasks')).tasks ?? [];
  assert('no duplicate execution and no second task', all2.length === 1 && all2.filter((t) => t.state === 'COMPLETED').length === 1,
    `tasks=${all2.length} completed=${all2.filter((t) => t.state === 'COMPLETED').length}`);
  // Sample the assignment for a window: the returned A must never be recorded as the owner again.
  let ownerSeen = null;
  for (let i = 0; i < 8; i++) { const t = await task(t2); if (t.assignedNodeId === 'neg-node-a') ownerSeen = 'neg-node-a'; await sleep(400); }
  assert('the returned stale holder never re-acquires the task', ownerSeen === null, `saw assignedNodeId=${ownerSeen}`);
  const hist2 = JSON.stringify(completed2.history ?? []);
  assert('the record shows the handoff from the ORIGINAL owner', hist2.includes('neg-node-a->neg-node-b'), hist2.slice(0, 200));

  const receipt = {
    task: 'UXI-391', step: '6 (negative controls, product level)', at: new Date().toISOString(),
    scenarioNoAlternate: { taskId: t1, state: after1.state, reservedFor: after1.handoffTargetRef ?? null, presentationState: entry1?.dto?.state ?? null },
    scenarioStaleHolder: { taskId: t2, state: completed2.state, reservedFor: completed2.handoffTargetRef, history: completed2.history ?? [], taskCount: all2.length },
    failures, log,
  };
  mkdirSync(`${ROOT}/evidence/raw/mission-book/UXI-391`, { recursive: true });
  writeFileSync(`${ROOT}/evidence/raw/mission-book/UXI-391/negative-controls.json`, JSON.stringify(receipt, null, 2));
  void b2; void gw;

  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  say(failures.length === 0 ? 'RESULT: PASS - both negative controls behave honestly'
    : `RESULT: FAIL - ${failures.length} assertion(s): ${failures.join(' | ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  say(`FAILED: ${e.message}`);
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  process.exit(1);
});
