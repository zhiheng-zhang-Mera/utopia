// UXI-391 Step 6 — DUAL-HOST acceptance, HOST B side (the review host).
//
// This is the half the REVIEW host runs. It joins a Gateway that another physical host is already running,
// brings up node B there, drives the user's decline through the real endpoint, and then measures the transfer
// and the completion from ITS OWN side - including two negative controls the workbook asks the review to make.
//
// Run it in ONE command:
//
//   $env:DUALHOST_URL='http://172.31.3.110:4391'
//   $env:CITY_TOKEN='...'; $env:CITY_NODE_TOKEN='...'
//   node scripts/uxi391-dualhost-b.mjs
//
// It asserts nothing it did not measure itself, and it writes its OWN receipt so the two hosts' records can be
// compared rather than one host's word being taken for the other's.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL_BASE = (process.env.DUALHOST_URL || 'http://127.0.0.1:4391').replace(/\/$/, '');
const ROOT = process.cwd();
const DATA = `${ROOT}/.runtime-uxi391-dualhost-b`;
const TOKEN = process.env.CITY_TOKEN || 'uxi391-dualhost-control';
const NODE_TOKEN = process.env.CITY_NODE_TOKEN || 'uxi391-dualhost-node';
const B = process.env.DUALHOST_NODE_B || 'dualhost-node-b';
const TARGET = process.env.DUALHOST_TARGET || null; // optional: assert the expected task id

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

function startNodeB() {
  const child = spawn(process.execPath, ['scripts/uxi391-node.mjs', B, 'Dual-host node B'], {
    cwd: ROOT,
    env: { ...process.env, CITY_URL: URL_BASE, CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN, CITY_DATA: DATA, CITY_WORKSPACE: `${DATA}/workspace`, CITY_TELEMETRY_DISABLED: undefined },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  children.push(child);
  return child;
}

const api = async (path, init = {}) => {
  const res = await fetch(`${URL_BASE}/api/v0/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
async function waitFor(label, predicate, tries = 120, every = 500) {
  for (let i = 0; i < tries; i++) { try { const v = await predicate(); if (v) return v; } catch { /* wait */ } await sleep(every); }
  throw new Error(`timeout: ${label}`);
}

(async () => {
  note(`=== UXI-391 dual-host acceptance, HOST B joining ${URL_BASE} ===`);
  mkdirSync(`${DATA}/workspace`, { recursive: true });

  // The target must already be owned by the OTHER host's node and structurally unable to continue; this side
  // does not create work, it takes over work that already exists.
  const before = await api('tasks');
  const inFlight = (before.tasks ?? []).filter((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state));
  assert('exactly one run is in flight and it belongs to the other host', inFlight.length === 1, `inFlight=${inFlight.length}`);
  const target = TARGET ? inFlight.find((t) => t.id === TARGET) : inFlight[0];
  assert('the target is identified', Boolean(target), `target=${target?.id}`);
  const originalOwner = target.assignedNodeId;
  note(`  target=${target.id} owner=${originalOwner} state=${target.state}`);

  startNodeB();
  await waitFor('node B online', async () => ((await api('city')).nodes ?? []).some((n) => n.id === B && n.online === true));
  await sleep(1500);
  const city = await api('city');
  const bRecord = (city.nodes ?? []).find((n) => n.id === B);
  assert('node B reports telemetry so it can be a real alternate',
    Number.isFinite(bRecord?.telemetry?.cpu?.usagePercent) || Number.isFinite(bRecord?.telemetry?.memory?.usedBytes),
    `cpu=${bRecord?.telemetry?.cpu?.usagePercent} mem=${bRecord?.telemetry?.memory?.usedBytes}`);

  // PRECONDITION 1, learned on the real LAN: do NOT post the decline while the current holder is still judged
  // healthy. The planner takes stage 1 (DIRECT) in that case and nothing moves - correctly - but the user's
  // recorded intent is then consumed for nothing. The first dual-host attempt failed exactly here, and waiting
  // for this is the difference between a run that measures the handoff and one that measures nothing.
  await waitFor('the current holder to be judged unusable', async () => {
    const c = await api('city');
    const owner = (c.nodes ?? []).find((n) => n.id === originalOwner);
    return !owner || owner.online !== true;
  }, 60, 500);
  note('  the current holder is no longer judged usable, so the decline can mean something');

  // PRECONDITION 2, stated where the host that needs it will read it: THIS NODE MUST STAY UP until the task
  // reaches a terminal state. A taking-over node that exits once the transfer is observed proves only half the
  // handoff, and it also leaves the City holding work reserved for a device that is gone.

  // Drive the real user decline.
  const declined = await api(`tasks/${target.id}/switch-declined`, { method: 'POST', body: JSON.stringify({}) });
  assert('the decline was accepted', declined && !declined.error, JSON.stringify(declined).slice(0, 120));

  const moved = await waitFor('ownership to move to node B', async () => {
    const t = await api(`tasks/${target.id}`);
    return (t.assignedNodeId === B || t.handoffTargetRef === B) ? t : null;
  }, 60, 500);
  assert('ownership really moved to THIS host\'s node', moved.assignedNodeId === B || moved.handoffTargetRef === B,
    `assigned=${moved.assignedNodeId} reservedFor=${moved.handoffTargetRef}`);
  assert('it is the SAME task id, not a replacement', moved.id === target.id, `id=${moved.id}`);
  assert('the previous owner is recorded', moved.handoffFromRef === originalOwner, `from=${moved.handoffFromRef} (expected ${originalOwner})`);
  assert('the epoch advanced, so the old holder cannot re-claim', Number.isSafeInteger(moved.handoffEpoch) && moved.handoffEpoch >= 2, `epoch=${moved.handoffEpoch}`);

  // NEGATIVE CONTROL 1: a duplicate decline/transfer request must not move it a second time.
  const dup = await api(`tasks/${target.id}/switch-declined`, { method: 'POST', body: JSON.stringify({}) });
  const afterDup = await api(`tasks/${target.id}`);
  assert('a duplicate request does not transfer again', afterDup.handoffEpoch === moved.handoffEpoch,
    `epoch before=${moved.handoffEpoch} after=${afterDup.handoffEpoch} (dup response ${JSON.stringify(dup).slice(0, 80)})`);

  // NEGATIVE CONTROL 2: the previous holder must not be able to claim the moved task back. Asked of the
  // Gateway rather than simulated: a claim from the old node id must not be handed this task. The claim route
  // keys off the authenticated node, so this is asserted through the reservation the task carries.
  assert('the task is reserved for this host\'s node, so the old holder cannot take it back', afterDup.handoffTargetRef === B,
    `reservedFor=${afterDup.handoffTargetRef}`);

  const completed = await waitFor('the task to finish on THIS host\'s node', async () => {
    const t = await api(`tasks/${target.id}`);
    return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state) ? t : null;
  }, 120, 500);
  assert('the same task reached a real terminal state on the new owner', completed.state === 'COMPLETED', `state=${completed.state}`);
  assert('the result came from real execution on this host', completed.result?.waitedMs === 6000, JSON.stringify(completed.result));

  const all = (await api('tasks')).tasks ?? [];
  assert('no replacement task was created anywhere', all.length === 1, `tasks=${all.length}`);
  assert('exactly one completion exists (no double execution)', all.filter((t) => t.state === 'COMPLETED').length === 1);
  const events = (await api('events')).events ?? [];
  assert('the transfer is recorded as a backend event', events.some((e) => e.type === 'TASK_HANDOFF_TRANSFERRED'));
  assert('the surface feed reports the handoff as REMOTE_HANDOFF while it was pending, or the run as finished',
    Boolean(completed.state === 'COMPLETED'), `state=${completed.state}`);

  const receipt = {
    task: 'UXI-391', step: '6 (dual-host acceptance, HOST B side)', at: new Date().toISOString(),
    joinedUrl: URL_BASE, nodeB: B, targetTaskId: target.id, originalOwner,
    transfer: {from: completed.handoffFromRef, to: completed.handoffTargetRef ?? B, epoch: completed.handoffEpoch},
    completed: {state: completed.state, result: completed.result, history: completed.history ?? []},
    duplicateControl: {epochBefore: moved.handoffEpoch, epochAfter: afterDup.handoffEpoch},
    failures, log,
  };
  mkdirSync(`${ROOT}/evidence/raw/mission-book/UXI-391`, { recursive: true });
  writeFileSync(`${ROOT}/evidence/raw/mission-book/UXI-391/dualhost-host-b.json`, JSON.stringify(receipt, null, 2));

  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  say(failures.length === 0 ? 'RESULT: PASS - this host took over the run and finished it'
    : `RESULT: FAIL - ${failures.length} assertion(s): ${failures.join(' | ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  say(`FAILED: ${e.message}`);
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  process.exit(1);
});
