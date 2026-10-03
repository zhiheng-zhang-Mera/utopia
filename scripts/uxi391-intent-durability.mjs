// UXI-391 — REPRODUCTION of Mech's finding: a recorded user intent is DROPPED if no alternate is eligible at
// the instant of the decline, and nothing ever re-evaluates it.
//
// WHY THIS EXISTS AS A TEST RATHER THAN AN ARGUMENT: Mech measured the defect on the real two-host path and
// stated the mechanism; this is my own instrument reproducing it, so the record does not rest on one host's
// word. It also becomes the regression test the repair must turn green - which means it is EXPECTED TO FAIL
// against the current head, and a failure here is the finding being confirmed rather than a broken harness.
//
// THE SCENARIO, and it is the one nobody had driven: record the user's decline while there is NO usable
// alternate at all, and only THEN make one available. A correct implementation honours the intent that is
// already on the task; a single-shot trigger does nothing, ever.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.INTENT_PORT || 4395);
const ROOT = process.cwd();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'uxi391-intent-durability';
const NODE_TOKEN = 'uxi391-intent-node';
const dataDir = `${ROOT}/.runtime-uxi391-intent`;

const say = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let failures = 0;
const log = [];
const note = (m) => { log.push(m); say(m); };
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  say(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
};
function start(file, args = []) {
  const c = spawn(process.execPath, [file, ...args], {
    cwd: ROOT,
    env: { ...process.env, CITY_HOST: '127.0.0.1', CITY_PORT: String(PORT), CITY_URL: BASE, CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN, CITY_DATA: dataDir, CITY_WORKSPACE: `${dataDir}/workspace`, CITY_TELEMETRY_DISABLED: undefined },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  children.push(c);
  return c;
}
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/api/v0/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
async function waitFor(label, pred, tries = 80, every = 500) {
  for (let i = 0; i < tries; i++) { try { const v = await pred(); if (v) return v; } catch { /* wait */ } await sleep(every); }
  throw new Error(`timeout: ${label}`);
}

(async () => {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(`${dataDir}/workspace`, { recursive: true });
  note(`=== UXI-391 intent-durability reproduction: port ${PORT} ===`);

  start('services/dev-gateway/main.mjs');
  await waitFor('health', () => fetch(`${BASE}/api/v0/health`).then((r) => r.ok), 40, 500);
  const nodeA = start('scripts/uxi391-node.mjs', ['intent-node-a', 'Intent A']);
  await waitFor('A online', async () => ((await api('city')).nodes ?? []).some((n) => n.id === 'intent-node-a' && n.online));

  const target = (await api('tasks', { method: 'POST', body: JSON.stringify({ type: 'WAIT' }) }))?.id;
  await waitFor('target RUNNING on A', async () => { const t = await api(`tasks/${target}`); return t.state === 'RUNNING' && t.assignedNodeId === 'intent-node-a'; });

  // Stop A's worker: the run stays RUNNING on a dead device, which is the long honest window.
  nodeA.kill();
  await waitFor('A offline', async () => ((await api('city')).nodes ?? []).some((n) => n.id === 'intent-node-a' && !n.online));

  // ---- THE USER DECLINES while NO alternate exists at all -----------------------------------------
  await api(`tasks/${target}/switch-declined`, { method: 'POST', body: JSON.stringify({}) });
  const atDecline = await api(`tasks/${target}`);
  check('the decline is recorded even with no usable alternate', atDecline.switchDeclined === true, `switchDeclined=${atDecline.switchDeclined}`);
  check('at that instant nothing moves - there is nowhere to move to', !atDecline.handoffTargetRef, `target=${atDecline.handoffTargetRef ?? 'none'}`);

  // ---- NOW an eligible alternate appears ----------------------------------------------------------
  const nodeB = start('scripts/uxi391-node.mjs', ['intent-node-b', 'Intent B']);
  await waitFor('B online', async () => ((await api('city')).nodes ?? []).some((n) => n.id === 'intent-node-b' && n.online));
  await sleep(2000);
  const feed = await api('presentation');
  const entry = (feed.tasks ?? []).find((e) => e.taskId === target) ?? null;
  const bTerm = (entry?.dto?.providers ?? []).find((p) => p.index === 1)?.term ?? null;
  note(`  after B came online: dto.state=${entry?.dto?.state} provider[1].term=${bTerm} selectable=${(entry?.dto?.providers ?? []).find((p) => p.index === 1)?.selectable}`);
  check('a usable alternate now EXISTS (so the intent COULD be honoured)', bTerm === 'SELECTABLE', `term=${bTerm}`);

  // ---- Does the already-recorded intent get honoured, or is it dropped for ever? -------------------
  let moved = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const t = await api(`tasks/${target}`);
    if (t.handoffTargetRef || t.assignedNodeId === 'intent-node-b' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state)) { moved = t; break; }
  }
  const after = moved ?? await api(`tasks/${target}`);
  check('THE FINDING: a recorded decline is honoured once an eligible alternate appears (no re-decline needed)',
    Boolean(after.handoffTargetRef || after.assignedNodeId === 'intent-node-b'),
    `state=${after.state} assigned=${after.assignedNodeId} target=${after.handoffTargetRef ?? 'none'} - the intent has been stranded for ${30}s`);

  // A second decline proves the intent is not LOST, only unhonoured - which is the repair's target, and shows
  // how the current code recovers only if something re-drives the endpoint.
  await api(`tasks/${target}/switch-declined`, { method: 'POST', body: JSON.stringify({}) });
  const afterSecond = await waitFor('a SECOND decline to move it (proving the intent survived)', async () => {
    const t = await api(`tasks/${target}`);
    return t.handoffTargetRef === 'intent-node-b' ? t : null;
  }, 20, 500).catch(() => null);
  check('a second decline does move it - so the intent was not lost, only never re-evaluated',
    Boolean(afterSecond), afterSecond ? `target=${afterSecond.handoffTargetRef} epoch=${afterSecond.handoffEpoch}` : 'even a second decline did not move it');

  const receipt = {
    task: 'UXI-391', control: 'intent durability (Mech finding reproduction)', at: new Date().toISOString(),
    port: PORT, targetTaskId: target, stateAfterFirstDecline: atDecline.state,
    alternateTermAfterB: bTerm, movedWithoutSecondDecline: Boolean(moved),
    movedWithSecondDecline: Boolean(afterSecond), failures, log,
  };
  mkdirSync(`${ROOT}/evidence/raw/mission-book/UXI-391`, { recursive: true });
  writeFileSync(`${ROOT}/evidence/raw/mission-book/UXI-391/intent-durability.json`, JSON.stringify(receipt, null, 2));

  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  say(failures === 0
    ? 'RESULT: PASS - the recorded intent is honoured without a second decline'
    : `RESULT: FAIL - ${failures} assertion(s): this is Mech's finding CONFIRMED by my own instrument`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  say(`FAILED: ${e.message}`);
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  process.exit(1);
});
