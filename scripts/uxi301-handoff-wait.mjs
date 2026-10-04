/**
 * UXI-301 — the REMOTE HANDOFF case, driven with the task type that actually HOLDS a node.
 *
 * MY ERROR, CORRECTED HERE. I recorded that this City has one task type completing near-instantly, so a node
 * cannot be held occupied, and an Owner ruling accepted the handoff deferral on that basis. Alien measured
 * the premise and it is FALSE: contracts/city-control-v0/protocol.mjs declares FIVE task types, and the
 * runner's WAIT branch sleeps stepDelay five times - 1200ms x 5 = 6000ms - holding a node for six seconds. I
 * generalised a City-wide limitation from the single type I had been creating, without asking what the City
 * supports, and the protocol module lists them plainly.
 *
 * So the condition IS producible: hold node A with a WAIT task, ask for a second task whose own node is
 * therefore busy, bring node B online as the free alternative, and decline the provider switch.
 */
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {startAgent} from '../agents/reference-node/agent.mjs';
import {schedulerPanel} from '../apps/web/scheduler.js';
import {configureRuntime} from '../apps/web/i18n/index.js';

configureRuntime({storage: null, navigator: {language: 'en'}});

const PORT = Number(process.env.CITY_PORT || 4346);
const TOKEN = 'uxi301-wait-control';
const NODE_TOKEN = 'uxi301-wait-node';
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
const waitFor = async (label, predicate, tries = 40, every = 400) => {
  for (let i = 0; i < tries; i++) { try { const v = await predicate(); if (v) return v; } catch { /* wait */ } await sleep(every); }
  throw new Error(`timed out waiting for ${label}`);
};
const results = [];
const check = (id, ok, detail) => { results.push({id, ok, detail}); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ' - ' + detail : ''}`); };
const RAW = /SELECTABLE|DEVICE_UNREACHABLE|DEVICE_REFUSING|AT_CAPACITY|LOAD_UNMEASURED|PRESSURE_PAUSED|FRESHNESS_UNKNOWN|USER_DISABLED|POLICY_EXCLUDED|SWITCH_OFFERED|ALTERNATE_DEVICE|WAITING_USER|REMOTE_HANDOFF/;
// ISOLATED STORE, and the reason is a real finding: the shared .runtime holds tasks from every earlier run,
// and the claim path hands out the OLDEST claimable task - so the node was executing historical work and the
// WAIT task this case creates never reached RUNNING. A first-run-only harness would never have shown this.
const record = {};

try {
  const gateway = spawn(process.execPath, ['services/dev-gateway/main.mjs'], {
    cwd: process.cwd(),
    env: {...process.env, CITY_HOST: '127.0.0.1', CITY_PORT: String(PORT), CITY_URL: `http://127.0.0.1:${PORT}`,
      CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN, CITY_DATA: `${process.cwd()}/.runtime/wait-case`, CITY_WORKSPACE: `${process.cwd()}/.runtime/wait-case/workspace`},
    stdio: 'ignore', windowsHide: true,
  });
  children.push(gateway);
  await waitFor('health', async () => (await api('health')).status === 200);

  const nodeA = await startAgent({url: `http://127.0.0.1:${PORT}`, token: NODE_TOKEN, id: 'uxi301-wait-a', displayName: 'UXI-301 Wait A', workspace: `${process.cwd()}/.runtime/wait-case/ws-a`});
  agents.push(nodeA);
  await waitFor('node A online', async () => ((await api('city')).json?.nodes ?? []).some((n) => n.online === true && n.id === 'uxi301-wait-a'));

  const holder = await api('tasks', {type: 'WAIT'});
  check('a WAIT task is accepted, which is the type that HOLDS a node',
    holder.status === 200 && !!holder.json?.id, `status=${holder.status} id=${holder.json?.id}`);
  const holderId = holder.json.id;
  await waitFor('the WAIT task to be RUNNING on node A', async () => {
    const t = ((await api('tasks')).json?.tasks ?? []).find((x) => x.id === holderId);
    return t?.assignedNodeId === 'uxi301-wait-a' && t?.state === 'RUNNING' ? t : null;
  });
  const startedAt = Date.now();
  console.log(`WAIT task RUNNING on node A (${holderId})`);

  // A second task, whose own node is therefore BUSY with the WAIT task - which is what makes the current
  // device ineligible and puts the routing question to the planner.
  const second = await api('tasks', {type: 'CHECKPOINT_DEMO'});
  const secondId = second.json?.id;

  const nodeB = await startAgent({url: `http://127.0.0.1:${PORT}`, token: NODE_TOKEN, id: 'uxi301-wait-b', displayName: 'UXI-301 Wait B', workspace: `${process.cwd()}/.runtime/wait-case/ws-b`});
  agents.push(nodeB);
  await waitFor('node B online as the free alternative', async () => ((await api('city')).json?.nodes ?? []).some((n) => n.online === true && n.id === 'uxi301-wait-b'));

  const offered = await api('presentation');
  const offeredEntry = (offered.json?.tasks ?? []).find((e) => e.taskId === secondId);
  const heldMs = Date.now() - startedAt;
  record.hold = {taskType: 'WAIT', heldMs, offeredTerms: offeredEntry?.dto?.terms ?? null};
  check('the WAIT task held its node long enough to be observed', heldMs > 1000, `held ${heldMs}ms`);
  check('the planner is offered the switch: the current device is busy and another is free',
    (offeredEntry?.dto?.terms ?? []).includes('WAITING_USER'), `terms=${JSON.stringify(offeredEntry?.dto?.terms)}`);

  const declined = await api(`tasks/${encodeURIComponent(secondId)}/switch-declined`, {});
  check('the decline is recorded as an explicit user intent', declined.status === 200, `status=${declined.status}`);

  const after = await api('presentation');
  const afterEntry = (after.json?.tasks ?? []).find((e) => e.taskId === secondId);
  const afterPanel = schedulerPanel(after.json, {isOnline: true});
  const panelText = afterPanel.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  record.handoff = {terms: afterEntry?.dto?.terms ?? null, state: afterEntry?.dto?.state ?? null, panelText: panelText.slice(0, 280)};
  check('the planner HANDED THE WORK OFF, so REMOTE_HANDOFF is produced',
    (afterEntry?.dto?.terms ?? []).includes('REMOTE_HANDOFF'), `terms=${JSON.stringify(afterEntry?.dto?.terms)}`);
  check('the surface tells the user in their own language that it moved to another device',
    /another device/i.test(afterPanel) && !RAW.test(afterPanel), record.handoff.panelText);
  check('and reassures them they can stay where they are', /stay right here|stay here/i.test(afterPanel));

  record.verdict = results.every((r) => r.ok) ? 'PASS' : 'FAIL';
  record.results = results;
  writeFileSync(`${EVIDENCE}/handoff-case-wait.json`, JSON.stringify(record, null, 2));
  console.log(`\n=== VERDICT: ${record.verdict} (${results.filter((r) => r.ok).length}/${results.length}) ===`);
  process.exitCode = record.verdict === 'PASS' ? 0 : 1;
} catch (error) {
  console.error('FAILED:', error.message);
  writeFileSync(`${EVIDENCE}/handoff-case-wait-error.json`, JSON.stringify({verdict: 'ERROR', error: error.message, results, record}, null, 2));
  process.exitCode = 1;
} finally {
  for (const agent of agents) { try { await agent.stop(); } catch { /* gone */ } }
  for (const child of children) { try { child.kill(); } catch { /* gone */ } }
}
