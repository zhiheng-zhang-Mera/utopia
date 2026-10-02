/**
 * UXI-301 — the route-stage case, driven with TWO REAL nodes.
 *
 * The feed's route stage was always null because the City produced none. RS-202's own planner now decides
 * it over real City state, and this drives the condition that actually reaches it: one real node already
 * occupied, a second real node free, so the planner offers a switch.
 *
 * TWO nodes are started through the agent LIBRARY with distinct ids rather than through
 * agents/reference-node/main.mjs, which hardcodes one default id - so this changes no product or harness
 * file to get a second real node.
 *
 * ALTERNATE_DEVICE (the automatic handoff) is NOT driven and the reason is measured, not assumed: probing
 * planRoute shows it is reached only when userDeclinedSwitch is set, and this City has no switch-decline
 * flow, so an automatic handoff cannot occur yet. Claiming it from a fabricated flag would be the mock
 * step 7 forbids.
 */
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {startAgent} from '../agents/reference-node/agent.mjs';
import {schedulerPanel} from '../apps/web/scheduler.js';
import {configureRuntime} from '../apps/web/i18n/index.js';
import {routeStageFor} from '../services/dev-gateway/presentation.mjs';
import {planRoute} from '../city/00-foundation/01-city-core/fleet-routing/routing-sequence.mjs';

configureRuntime({storage: null, navigator: {language: 'en'}});

const PORT = Number(process.env.CITY_PORT || 4344);
const TOKEN = 'uxi301-route-control';
const NODE_TOKEN = 'uxi301-route-node';
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
const RAW = /SELECTABLE|DEVICE_UNREACHABLE|DEVICE_REFUSING|AT_CAPACITY|LOAD_UNMEASURED|PRESSURE_PAUSED|FRESHNESS_UNKNOWN|USER_DISABLED|POLICY_EXCLUDED|SWITCH_OFFERED|ALTERNATE_DEVICE|WAITING_USER/;
const record = {};

try {
  const env = {...process.env, CITY_URL: `http://127.0.0.1:${PORT}`, CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN,
    CITY_DATA: `${process.cwd()}/.runtime`, CITY_WORKSPACE: `${process.cwd()}/.runtime/workspace`};
  const gateway = spawn(process.execPath, ['services/dev-gateway/main.mjs'], {
    cwd: process.cwd(),
    env: {...env, CITY_HOST: '127.0.0.1', CITY_PORT: String(PORT)},
    stdio: 'ignore', windowsHide: true,
  });
  children.push(gateway);
  await waitFor('health', async () => (await api('health')).status === 200);

  // TWO real nodes, distinct ids, through the agent library.
  const nodeA = await startAgent({url: `http://127.0.0.1:${PORT}`, token: NODE_TOKEN, id: 'uxi301-node-a', displayName: 'UXI-301 Node A', workspace: `${process.cwd()}/.runtime/workspace-a`});
  const nodeB = await startAgent({url: `http://127.0.0.1:${PORT}`, token: NODE_TOKEN, id: 'uxi301-node-b', displayName: 'UXI-301 Node B', workspace: `${process.cwd()}/.runtime/workspace-b`});
  agents.push(nodeA, nodeB);
  await waitFor('two ONLINE nodes', async () => ((await api('city')).json?.nodes ?? []).filter((n) => n.online === true).length >= 2);
  const online = ((await api('city')).json?.nodes ?? []).filter((n) => n.online === true).map((n) => n.id);
  console.log(`two real nodes online: ${online.join(', ')}\n`);

  // Occupy one node with real work, then ask the feed again: the OTHER task should be offered a switch.
  const first = await api('tasks', {type: 'CHECKPOINT_DEMO'});
  await waitFor('the first task to be assigned', async () => {
    const t = ((await api('tasks')).json?.tasks ?? []).find((x) => x.id === first.json.id);
    return t?.assignedNodeId ? t : null;
  });
  const assignedNode = ((await api('tasks')).json?.tasks ?? []).find((x) => x.id === first.json.id).assignedNodeId;
  console.log(`first task ${first.json.id} occupies ${assignedNode}`);

  // A BATCH, read immediately: one task finishes too fast for its node to look occupied, and the condition
  // I am driving is capacity pressure, which only exists WHILE work is in flight.
  const batch = await Promise.all(Array.from({length: 6}, () => api('tasks', {type: 'CHECKPOINT_DEMO'})));
  const feed = await api('presentation');
  const panel = schedulerPanel(feed.json, {isOnline: true});
  const entries = feed.json?.tasks ?? [];
  const busyEntries = entries.filter((e) => (e.dto.providers ?? []).some((x) => x.term === 'AT_CAPACITY'));
  const offeredEntries = entries.filter((e) => (e.dto.terms ?? []).includes('WAITING_USER'));
  record.feedEntry = {
    batchIds: batch.map((r) => r.json?.id),
    taskCount: entries.length,
    busyTaskCount: busyEntries.length,
    switchOfferedTaskCount: offeredEntries.length,
    sampleBusyTerms: busyEntries[0]?.dto?.providers?.map((x) => x.term) ?? null,
    sampleOfferedTerms: offeredEntries[0]?.dto?.terms ?? null,
  };

  check('an occupied node is reported as busy while the work is in flight', busyEntries.length > 0,
    `${busyEntries.length} of ${entries.length} tasks see AT_CAPACITY`);
  check('the route stage is now produced rather than always null', offeredEntries.length > 0,
    `${offeredEntries.length} task(s) carry WAITING_USER from the switch offer`);
  check('the surface asks the user rather than silently deciding for them',
    /waiting for your decision|choose another service|use another available/i.test(panel), panel.slice(0, 200));
  check('the route-stage surface leaks no raw vocabulary', !RAW.test(panel));

  // And the reason ALTERNATE_DEVICE is not driven, measured rather than assumed.
  const idleLoad = {cpu: 0.05, memory: 0.05, gpu: 0.05, io: 0.05, network: 0.05};
  const dev = (extra = {}) => ({state: 'READY', presence: 'ONLINE', enablement: 'ENABLED', load: idleLoad, sessionConcurrency: 0, providerConcurrency: 0, ...extra});
  const offered = planRoute({originDeviceRef: 'a', current: dev({sessionConcurrency: 1}), alternates: [{deviceRef: 'b', ...dev()}]});
  const handedOff = planRoute({originDeviceRef: 'a', current: dev({sessionConcurrency: 1}), alternates: [{deviceRef: 'b', ...dev()}], userDeclinedSwitch: true});
  record.plannerEvidence = {withoutDecline: offered.stage, withDecline: handedOff.stage};
  check('the planner reaches ALTERNATE_DEVICE only AFTER a declined switch, which is why it is not driven',
    offered.stage === 'SWITCH_OFFERED' && handedOff.stage === 'ALTERNATE_DEVICE',
    `withoutDecline=${offered.stage} withDecline=${handedOff.stage}`);

  record.verdict = results.every((r) => r.ok) ? 'PASS' : 'FAIL';
  record.results = results;
  record.notDriven = {
    alternateDevice: 'ALTERNATE_DEVICE (automatic remote handoff) is reached by planRoute only when userDeclinedSwitch is set. This City has no switch-decline flow, so an automatic handoff cannot occur yet, and it is NOT asserted from a fabricated flag - the planner evidence above shows the exact condition it needs. REMOTE_HANDOFF remains owed with that precise cause.',
  };
  writeFileSync(`${EVIDENCE}/route-stage-case.json`, JSON.stringify(record, null, 2));
  console.log(`\n=== VERDICT: ${record.verdict} (${results.filter((r) => r.ok).length}/${results.length}) ===`);
  process.exitCode = record.verdict === 'PASS' ? 0 : 1;
} catch (error) {
  console.error('FAILED:', error.message);
  writeFileSync(`${EVIDENCE}/route-stage-case-error.json`, JSON.stringify({verdict: 'ERROR', error: error.message, results, record}, null, 2));
  process.exitCode = 1;
} finally {
  for (const agent of agents) { try { await agent.stop(); } catch { /* gone */ } }
  for (const child of children) { try { child.kill(); } catch { /* gone */ } }
}
