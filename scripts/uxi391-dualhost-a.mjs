// UXI-391 Step 6 — DUAL-HOST acceptance, HOST A side (the development / resource host).
//
// The workbook prescribes a real two-physical-host acceptance and names the split: this host runs the Gateway,
// the original interaction surface and node A, stops A's WORKER once the target is RUNNING and assigned (the
// Gateway and the surface stay alive), and then waits for the review host to start node B and drive the switch
// / decline path through the UI. Everything this side asserts is about what THIS host can see for itself.
//
// Run it in ONE command (the harness kills the process tree when the invoking call ends), and run it as a
// background job on this machine so it survives while the review host works:
//
//   $env:DUALHOST_BIND='172.31.3.110'; $env:DUALHOST_PORT='4391'
//   $env:CITY_TOKEN='...'; $env:CITY_NODE_TOKEN='...'
//   node scripts/uxi391-dualhost-a.mjs
//
// It prints, and writes into its receipt, the exact URL and tokens the review host needs.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BIND = process.env.DUALHOST_BIND || '127.0.0.1';
const PORT = Number(process.env.DUALHOST_PORT || 4391);
const ROOT = process.cwd();
const DATA = `${ROOT}/.runtime-uxi391-dualhost-a`;
const TOKEN = process.env.CITY_TOKEN || 'uxi391-dualhost-control';
const NODE_TOKEN = process.env.CITY_NODE_TOKEN || 'uxi391-dualhost-node';
const A = process.env.DUALHOST_NODE_A || 'dualhost-node-a';
const WAIT_MS = Number(process.env.DUALHOST_WAIT_MS || 900000); // how long to wait for the review host

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
      ...process.env,
      CITY_HOST: BIND,
      CITY_PORT: String(PORT),
      CITY_URL: `http://${BIND}:${PORT}`,
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
  return child;
}

const BASE = `http://${BIND}:${PORT}`;
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/api/v0/${path}`, {
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
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(`${DATA}/workspace`, { recursive: true });
  note(`=== UXI-391 dual-host acceptance, HOST A on ${BIND}:${PORT} ===`);
  note(`  review host needs: URL=${BASE}  CITY_TOKEN=${TOKEN}  CITY_NODE_TOKEN=${NODE_TOKEN}`);

  start('services/dev-gateway/main.mjs');
  await waitFor('gateway health', () => fetch(`${BASE}/api/v0/health`).then((r) => r.ok), 60, 500);
  note('  gateway healthy and bound to the LAN interface');

  const nodeA = start('scripts/uxi391-node.mjs', [A, 'Dual-host node A']);
  await waitFor('node A registered', async () => ((await api('city')).nodes ?? []).some((n) => n.id === A && n.online === true));
  note('  node A registered and online');

  const created = await api('tasks', { method: 'POST', body: JSON.stringify({ type: 'WAIT' }) });
  const targetId = created?.id ?? created?.task?.id;
  note(`  target WAIT created: ${targetId}`);

  await waitFor('the target RUNNING on A', async () => { const t = await api(`tasks/${targetId}`); return t.state === 'RUNNING' && t.assignedNodeId === A; });
  await sleep(1500);
  const held = await api(`tasks/${targetId}`);
  assert('node A really ran the target, and the hold is sustained', held.state === 'RUNNING' && held.assignedNodeId === A && held.progress > 0,
    `state=${held.state} assigned=${held.assignedNodeId} progress=${held.progress}`);

  // The original interaction surface: opened BEFORE A's worker dies and kept open for the whole acceptance.
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.locator('#connection').filter({ hasText: 'ONLINE' }).waitFor({ timeout: 25000 });
  await page.evaluate(() => { window.__uxi391DualhostOpenedAt = Date.now(); });
  await page.locator('nav button[data-page="Devices"]').click();
  await sleep(1500);
  const panelBefore = (await page.locator('.scheduler-panel').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  assert('the original surface shows the run before the handoff', panelBefore.includes(targetId), panelBefore.slice(0, 140));

  // Stop A's WORKER only: the Gateway and the surface stay alive, which is what makes this a handoff rather
  // than a restart.
  nodeA.kill();
  await waitFor('A swept offline', async () => ((await api('city')).nodes ?? []).some((n) => n.id === A && !n.online));
  const afterDrop = await api(`tasks/${targetId}`);
  assert('the assignment survives the worker leaving', afterDrop.assignedNodeId === A, `assigned=${afterDrop.assignedNodeId}`);
  note('  node A worker stopped; Gateway and surface still alive - the review host may now start node B');

  // ------------------------------------------------------------------ wait for the REVIEW HOST to act
  const deadline = Date.now() + WAIT_MS;
  let sawB = false;
  let moved = null;
  let completed = null;
  while (Date.now() < deadline) {
    const city = await api('city');
    if (!sawB && (city.nodes ?? []).some((n) => n.id !== A && n.online === true)) {
      sawB = true;
      note(`  review host's node appeared: ${(city.nodes ?? []).filter((n) => n.id !== A && n.online).map((n) => n.id).join(',')}`);
    }
    const t = await api(`tasks/${targetId}`);
    if (!moved && t.handoffTargetRef && t.handoffTargetRef !== A) { moved = t; note(`  transfer observed: ${t.handoffFromRef} -> ${t.handoffTargetRef}`); }
    if (t.state === 'COMPLETED' || t.state === 'FAILED' || t.state === 'CANCELLED') { completed = t; break; }
    await sleep(2000);
  }

  assert('the review host started a second device', sawB, `sawB=${sawB}`);
  assert('ownership moved away from node A', Boolean(moved), moved ? JSON.stringify({from: moved.handoffFromRef, to: moved.handoffTargetRef}) : 'no transfer observed');
  assert('the SAME task finished on the other host', Boolean(completed) && completed.id === targetId, completed ? `state=${completed.state}` : 'never terminal');
  if (completed?.state === 'COMPLETED') {
    assert('the result came from real execution', completed.result?.waitedMs === 6000, JSON.stringify(completed.result));
  }

  // Result return, measured at the surface that never moved and never reloaded.
  const stillOpen = await page.evaluate(() => typeof window.__uxi391DualhostOpenedAt === 'number');
  assert('the surface was never reloaded during the acceptance', stillOpen);
  await page.locator('nav button[data-page="Tasks"]').click();
  await sleep(2500);
  const tasksText = (await page.locator('#view').innerText()).replace(/\s+/g, ' ').trim();
  assert('the original surface shows the finished run', tasksText.includes(targetId) && /COMPLETED/i.test(tasksText), tasksText.slice(0, 200));
  assert('no raw scheduler token leaked onto the surface',
    !/(SELECTABLE|DEVICE_REFUSING|AT_CAPACITY|LOAD_UNMEASURED|USER_DISABLED|REMOTE_HANDOFF)/.test(tasksText));
  await browser.close();

  const receipt = {
    task: 'UXI-391', step: '6 (dual-host acceptance, HOST A side)', at: new Date().toISOString(),
    bind: BIND, port: PORT, url: BASE, nodeA: A, targetTaskId: targetId,
    sawSecondDevice: sawB, transfer: moved ? {from: moved.handoffFromRef, to: moved.handoffTargetRef, epoch: moved.handoffEpoch} : null,
    completed: completed ? {state: completed.state, result: completed.result} : null,
    surface: {panelBefore, tasksText: tasksText.slice(0, 600), reloaded: !stillOpen},
    failures, log,
  };
  mkdirSync(`${ROOT}/evidence/raw/mission-book/UXI-391`, { recursive: true });
  writeFileSync(`${ROOT}/evidence/raw/mission-book/UXI-391/dualhost-host-a.json`, JSON.stringify(receipt, null, 2));

  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  say(failures.length === 0 ? 'RESULT: PASS - the handoff completed across the two hosts'
    : `RESULT: FAIL - ${failures.length} assertion(s): ${failures.join(' | ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  say(`FAILED: ${e.message}`);
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  process.exit(1);
});
