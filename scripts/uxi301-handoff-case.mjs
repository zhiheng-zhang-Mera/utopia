/**
 * UXI-301 — the REMOTE HANDOFF case, driven without inventing any City capability.
 *
 * Why the previous attempt failed: the City can only create one task type and it finishes in well under a
 * second, so "busy current device AND eligible alternative" drained before the planner could be asked. The
 * fix is sequencing rather than new product surface: place work on node A, then take node A AWAY while the
 * work is still assigned - the City only fails a task when its node RE-registers, so the assignment
 * survives - and bring node B online as a genuinely free alternative. That is a real condition a user can
 * be in: the device running my work has gone, and another of my devices is free.
 */
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {startAgent} from '../agents/reference-node/agent.mjs';
import {schedulerPanel} from '../apps/web/scheduler.js';
import {configureRuntime} from '../apps/web/i18n/index.js';

configureRuntime({storage: null, navigator: {language: 'en'}});

const PORT = Number(process.env.CITY_PORT || 4345);
const TOKEN = 'uxi301-handoff-control';
const NODE_TOKEN = 'uxi301-handoff-node';
const EVIDENCE = `${process.cwd()}/evidence/raw/mission-book/UXI-301`;
const children = [];
const agents = [];

const api = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v0/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return {status: res.status, json: JSON.parse(text)}; } catch { return {status: res.status, json: null}; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, predicate, tries = 40, every = 500) => {
  for (let i = 0; i < tries; i++) { try { const v = await predicate(); if (v) return v; } catch { /* wait */ } await sleep(every); }
  throw new Error(`timed out waiting for ${label}`);
};
const results = [];
const check = (id, ok, detail) => { results.push({id, ok, detail}); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ' - ' + detail : ''}`); };
const RAW = /SELECTABLE|DEVICE_UNREACHABLE|DEVICE_REFUSING|AT_CAPACITY|LOAD_UNMEASURED|PRESSURE_PAUSED|FRESHNESS_UNKNOWN|USER_DISABLED|POLICY_EXCLUDED|SWITCH_OFFERED|ALTERNATE_DEVICE|WAITING_USER|REMOTE_HANDOFF/;
const record = {};

const startB = async () => {
  const agent = await startAgent({url: `http://127.0.0.1:${PORT}`, token: NODE_TOKEN, id: 'uxi301-handoff-b', displayName: 'UXI-301 Handoff B', workspace: `${process.cwd()}/.runtime/ws-handoff-b`});
  agents.push(agent);
  return agent;
};

try {
  const gateway = spawn(process.execPath, ['services/dev-gateway/main.mjs'], {
    cwd: process.cwd(),
    env: {...process.env, CITY_HOST: '127.0.0.1', CITY_PORT: String(PORT), CITY_URL: `http://127.0.0.1:${PORT}`,
      CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN, CITY_DATA: `${process.cwd()}/.runtime`, CITY_WORKSPACE: `${process.cwd()}/.runtime/workspace`},
    stdio: 'ignore', windowsHide: true,
  });
  children.push(gateway);
  await waitFor('health', async () => (await api('health')).status === 200);

  const nodeA = await startAgent({url: `http://127.0.0.1:${PORT}`, token: NODE_TOKEN, id: 'uxi301-handoff-a', displayName: 'UXI-301 Handoff A', workspace: `${process.cwd()}/.runtime/ws-handoff-a`});
  agents.push(nodeA);
  await waitFor('node A online', async () => ((await api('city')).json?.nodes ?? []).some((n) => n.online === true && n.id === 'uxi301-handoff-a'));

  // A BATCH, and node A is torn down IMMEDIATELY - not after awaiting a single task's assignment, which
  // loses the race because the executor finishes in milliseconds.
  const batch = await Promise.all(Array.from({length: 10}, () => api('tasks', {type: 'CHECKPOINT_DEMO'})));
  const batchIds = new Set(batch.map((r) => r.json?.id).filter(Boolean));
  const stopA = nodeA.stop();
  await waitFor('node A to be seen offline', async () => ((await api('city')).json?.nodes ?? []).every((n) => n.online !== true || n.id !== 'uxi301-handoff-a'));
  await stopA.catch(() => {});
  const surviving = ((await api('tasks')).json?.tasks ?? [])
    .filter((x) => batchIds.has(x.id) && x.assignedNodeId === 'uxi301-handoff-a' && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(x.state));
  const taskId = surviving[0]?.id ?? null;
  record.surviving = {batch: batchIds.size, stillAssignedAndInFlight: surviving.length, picked: taskId, states: surviving.map((x) => x.state)};
  check('work survives its device disappearing, assigned and still in flight',
    surviving.length > 0, `${surviving.length} of ${batchIds.size} task(s) survived on node A`);
  if (taskId === null) throw new Error('no work survived on node A; the handoff condition cannot be produced in this City');

  await startB();
  await waitFor('node B online as the free alternative', async () => ((await api('city')).json?.nodes ?? []).some((n) => n.online === true && n.id === 'uxi301-handoff-b'));

  const offered = await api('presentation');
  const offeredEntry = (offered.json?.tasks ?? []).find((e) => e.taskId === taskId);
  const offeredPanel = schedulerPanel(offered.json, {isOnline: true});
  record.switchOffer = {terms: offeredEntry?.dto?.terms ?? null, state: offeredEntry?.dto?.state ?? null};
  check('the planner offers a switch: the current device is gone and another is free',
    (offeredEntry?.dto?.terms ?? []).includes('WAITING_USER'), `terms=${JSON.stringify(offeredEntry?.dto?.terms)}`);
  check('the offer is put to the user in their own language',
    /waiting for your decision|another available/i.test(offeredPanel) && !RAW.test(offeredPanel),
    offeredPanel.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150));

  // The user declines the provider switch, so the planner uses another of their own devices.
  const declined = await api(`tasks/${encodeURIComponent(taskId)}/switch-declined`, {});
  check('the decline is recorded as an explicit user intent', declined.status === 200, `status=${declined.status}`);

  const after = await api('presentation');
  const afterEntry = (after.json?.tasks ?? []).find((e) => e.taskId === taskId);
  const afterPanel = schedulerPanel(after.json, {isOnline: true});
  record.handoff = {
    terms: afterEntry?.dto?.terms ?? null,
    state: afterEntry?.dto?.state ?? null,
    panelText: afterPanel.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260),
  };
  check('the planner now HANDED THE WORK OFF, so REMOTE_HANDOFF is produced',
    (afterEntry?.dto?.terms ?? []).includes('REMOTE_HANDOFF'), `terms=${JSON.stringify(afterEntry?.dto?.terms)}`);
  check('the surface tells the user the work moved to another device, in their own language',
    /another device/i.test(afterPanel) && !RAW.test(afterPanel), record.handoff.panelText);
  check('the surface keeps reassuring them they can stay where they are', /stay right here|stay here/i.test(afterPanel));

  record.verdict = results.every((r) => r.ok) ? 'PASS' : 'FAIL';
  record.results = results;
  writeFileSync(`${EVIDENCE}/handoff-case.json`, JSON.stringify(record, null, 2));
  console.log(`\n=== VERDICT: ${record.verdict} (${results.filter((r) => r.ok).length}/${results.length}) ===`);
  process.exitCode = record.verdict === 'PASS' ? 0 : 1;
} catch (error) {
  console.error('FAILED:', error.message);
  writeFileSync(`${EVIDENCE}/handoff-case-error.json`, JSON.stringify({verdict: 'ERROR', error: error.message, results, record}, null, 2));
  process.exitCode = 1;
} finally {
  for (const agent of agents) { try { await agent.stop(); } catch { /* gone */ } }
  for (const child of children) { try { child.kill(); } catch { /* gone */ } }
}
