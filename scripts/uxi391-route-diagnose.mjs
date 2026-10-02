// UXI-391 diagnostic — WHY does the route refuse an alternate that the surface calls SELECTABLE?
//
// The E2E reaches stage 3 (the user declined, the current device is structurally refusing) and then finds no
// eligible alternate, so `routeStageFor` returns null. The presentation TERM for the same candidate reads
// SELECTABLE, which is the two-predicates-one-candidate discrepancy Alien reported during UXI-390. This script
// prints the actual verdict inputs and reasons for every candidate instead of leaving it as a hypothesis.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const PORT = Number(process.env.E2E_PORT || 4372);
const ROOT = process.cwd();
const DATA = `${ROOT}/.runtime-uxi391-diag`;
const TOKEN = 'uxi391-diag-control';
const NODE_TOKEN = 'uxi391-diag-node';
const A = 'uxi391-diag-a';
const B = 'uxi391-diag-b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const say = (m) => console.log(m);

function start(file, args = []) {
  const c = spawn(process.execPath, [file, ...args], {
    cwd: ROOT,
    env: { ...process.env, CITY_HOST: '127.0.0.1', CITY_PORT: String(PORT), CITY_URL: `http://127.0.0.1:${PORT}`, CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN, CITY_DATA: DATA, CITY_WORKSPACE: `${DATA}/workspace`, CITY_TELEMETRY_DISABLED: undefined },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  children.push(c);
  return c;
}
const api = async (path, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v0/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
async function waitFor(label, predicate, tries = 80, every = 250) {
  for (let i = 0; i < tries; i++) { try { if (await predicate()) return true; } catch { /* wait */ } await sleep(every); }
  throw new Error(`timeout: ${label}`);
}

(async () => {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(`${DATA}/workspace`, { recursive: true });

  const { candidateFromNode, routeStageFor } = await import('../services/dev-gateway/presentation.mjs');
  const { planRoute } = await import('../city/00-foundation/01-city-core/fleet-routing/routing-sequence.mjs');
  const { evaluateEligibility, DEFAULT_PRESSURE_POLICY } = await import('../city/00-foundation/01-city-core/fleet-routing/pressure.mjs');

  start('services/dev-gateway/main.mjs');
  await waitFor('health', () => fetch(`http://127.0.0.1:${PORT}/api/v0/health`).then((r) => r.ok));
  const nodeA = start('scripts/uxi391-node.mjs', [A, 'Diag A']);
  await waitFor('A online', async () => ((await api('city')).nodes ?? []).some((n) => n.id === A && n.online));

  const created = await api('tasks', { method: 'POST', body: JSON.stringify({ type: 'WAIT' }) });
  say(`create response: ${JSON.stringify(created).slice(0, 300)}`);
  const targetId = created?.task?.id ?? created?.id;
  say(`targetId=${targetId}`);
  let lastState = '';
  try {
    await waitFor('RUNNING on A', async () => {
      const t = await api(`tasks/${targetId}`);
      const now = `${t?.state}/${t?.assignedNodeId}/${t?.progress}`;
      if (now !== lastState) { lastState = now; say(`  task ${now}`); }
      return t?.state === 'RUNNING' && t?.assignedNodeId === A;
    });
  } catch (e) {
    const all = await api('tasks');
    say(`task list: ${JSON.stringify(all).slice(0, 400)}`);
    throw e;
  }

  nodeA.kill();
  await waitFor('A offline', async () => ((await api('city')).nodes ?? []).some((n) => n.id === A && !n.online));
  start('scripts/uxi391-node.mjs', [B, 'Diag B']);
  await waitFor('B online', async () => ((await api('city')).nodes ?? []).some((n) => n.id === B && n.online));
  await sleep(1500);

  await api(`tasks/${targetId}/switch-declined`, { method: 'POST', body: JSON.stringify({}) });
  await sleep(500);

  const city = await api('city');
  const task = await api(`tasks/${targetId}`);
  const candidates = (city.nodes ?? []).map(candidateFromNode);

  say(`target=${targetId} state=${task.state} assigned=${task.assignedNodeId} switchDeclined=${task.switchDeclined}`);
  say(`candidates=${candidates.length}`);
  for (const n of city.nodes ?? []) {
    say(`  node ${n.id} online=${n.online} cpu=${n.telemetry?.cpu?.usagePercent} memUsed=${n.telemetry?.memory?.usedBytes} memTotal=${n.telemetry?.memory?.totalBytes}`);
  }
  for (const c of candidates) {
    say(`  candidate ${c.deviceRef}: state=${c.device.state} presence=${c.device.presence} load=${JSON.stringify(c.load)} enablement=${JSON.stringify(c.enablement ?? null)}`);
    const verdict = evaluateEligibility({
      device: { state: c.device.state, presence: c.device.presence },
      enablement: c.enablement ?? null,
      sessionConcurrency: 0, providerConcurrency: 0,
      load: c.load ?? null, policy: DEFAULT_PRESSURE_POLICY, excludedByPolicy: false,
    });
    say(`     verdict: eligible=${verdict.eligible} reason=${verdict.reason} observed=${JSON.stringify(verdict.observed)} missing=${JSON.stringify(verdict.missing)} detail=${verdict.detail ?? ''}`);
  }

  const current = candidates.find((c) => c.deviceRef === task.assignedNodeId);
  const alternates = candidates.filter((c) => c.deviceRef !== task.assignedNodeId)
    .map((c) => ({ deviceRef: c.deviceRef, ...c.device, enablement: c.enablement ?? null, load: c.load ?? null, sessionConcurrency: 0 }));
  const plan = planRoute({
    originDeviceRef: task.assignedNodeId,
    current: current ? { ...current.device, load: current.load ?? null, sessionConcurrency: 0 } : {},
    alternates,
    userDeclinedSwitch: task.switchDeclined === true,
  });
  say(`planRoute: stage=${plan.stage} chosen=${plan.chosen_device_ref} alternates=${JSON.stringify(plan.alternates ?? [])}`);
  const stage = routeStageFor({ task, candidates, otherInFlightByNode: new Map() });
  say(`routeStageFor -> ${stage}`);

  const feed = await api(`presentation`);
  const entry = (feed?.tasks ?? []).find((e) => (e.taskId ?? e.id) === targetId) ?? null;
  say(`FEED entry keys: ${entry ? Object.keys(entry).join(",") : "none"}`);
  say(`FEED entry: ${JSON.stringify(entry).slice(0, 900)}`);
  say(`FEED dto state: ${entry?.dto?.state} terms: ${JSON.stringify(entry?.dto?.terms)}`);
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  process.exit(0);
})().catch((e) => { say(`FAILED: ${e.message}`); for (const c of children) { try { c.kill(); } catch { /* gone */ } } process.exit(1); });
