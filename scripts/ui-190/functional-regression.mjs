#!/usr/bin/env node
/**
 * UI-190 step 5 · FUNCTIONAL REGRESSION across the nine surfaces the workbook names.
 *
 * Step 5: "回归现有 Ask/Action/Rooms/Devices/Services/Tasks/Activity/Pairing/Settings
 * 功能可达性". The handoff notes list this as owed and it is the last item this task's
 * Development host can discharge before the forbidden step 3/4 independent critic rounds.
 *
 * SCOPE DISCIPLINE, stated because it is why this file may exist at all: this probe makes
 * NO aesthetic judgement and produces NO visual score. Step 3 forbids the implementing
 * context from grading its own implementation. Measured here is only whether each surface
 * can be REACHED and MOUNTS something real - DOM facts, not taste.
 *
 * DEFECT THIS PROBE WAS REWRITTEN TO AVOID (first version, recorded rather than hidden):
 * v1 asserted only that `#action-detail` was PRESENT, and it passed green on a 14-character
 * placeholder ("pick an action") because the dev gateway exposes ZERO actions until an Ask
 * produces one. That is the same false-clean shape this programme already caught once in
 * ui-101's ask-and-detail-shots.mjs, so v2 (a) SEEDS real data before asserting, and
 * (b) requires the detail pane to exceed the placeholder length, so a placeholder can no
 * longer satisfy the check. A surface that cannot be exercised is reported UNEXERCISED
 * with its reason - never as passed.
 *
 *   CITY_TOKEN=... CITY_NODE_TOKEN=... node services/dev-gateway/main.mjs
 *   CITY_TOKEN=... node scripts/ui-190/functional-regression.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const GATEWAY = process.env.CITY_URL || 'http://127.0.0.1:4310';
const TOKEN = process.env.CITY_TOKEN;
const NODE_TOKEN = process.env.CITY_NODE_TOKEN;
const OUT = '.runtime/evidence/ui-190';
if (!TOKEN) throw new Error('CITY_TOKEN required');
mkdirSync(OUT, { recursive: true });

/* A synthetic runtime node, so the Devices surface is exercised with a real card rather
   than only its empty state. This also lights up the `lastHeartbeatAt` render path, which
   is the exact field UI-102's delta repaired - and Web is that repair's parity baseline,
   so asserting here that the copy shows a RELATIVE age and leaks no raw ISO-8601 is a
   real check of the repaired contract, not decoration. */
const NODE = { id: 'sim-ui190-node', displayName: 'SIM · UI-190 node', metadata: { platform: 'simulated' }, agentVersion: '0.1.0', capabilities: ['fs.read', 'shell.exec'] };
async function registerNode() {
  if (!NODE_TOKEN) return { registered: false, reason: 'CITY_NODE_TOKEN not set' };
  const call = async (path, body) => {
    const r = await fetch(GATEWAY + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + NODE_TOKEN, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status };
  };
  const reg = await call('/api/v0/node/register', NODE);
  const hb = await call('/api/v0/node/heartbeat', { ...NODE, metrics: { cpuPercent: 12, memoryPercent: 34 } });
  return { registered: reg.ok, registerStatus: reg.status, heartbeatOk: hb.ok };
}

/* A phrase intents.mjs genuinely has a rule for, chosen from its RULES table rather than
   invented - the ui-101 probe defect was caused by using phrases no rule matched, which
   silently produced UNMATCHED three times out of four. */
const SEED_PHRASE = 'add buy milk to my checklist';
const PLACEHOLDER_MAX = 30; // "pick an action" placeholder is ~14 chars; a real action is far longer

const SURFACES = [
  { need: 'Devices',  nav: 'Devices',  marker: '#view section.panel', note: 'node rows' },
  { need: 'Activity', nav: 'Activity', marker: '#view section.panel', note: 'event timeline' },
  { need: 'Services', nav: 'Services', marker: '#services-shell',     note: 'service cards + editor' },
  { need: 'Tasks',    nav: 'Tasks',    marker: '#view section.panel', note: 'task registry' },
  { need: 'Action',   nav: 'Actions',  marker: '#action-detail',      note: 'action list + detail host' },
  { need: 'Pairing',  nav: 'Pairing',  marker: '#view section.panel', note: 'pairing session' },
  { need: 'Settings', nav: 'Settings', marker: '#view section.panel', note: 'language + diagnostics' },
  { need: 'Rooms',    nav: 'Rooms',    marker: '#view',               note: 'terminal rooms view' },
  { need: 'Home',     nav: 'Home',     marker: '.operator .op-frame', note: 'assistant slot' },
];

const launch = async () => {
  for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} }
  throw new Error('no browser');
};

const report = { gateway: GATEWAY, seed: {}, surfaces: [], ask: null, actionDetail: null, findings: [], unexercised: [] };
const F = (m) => report.findings.push(m);
const U = (m) => report.unexercised.push(m);

report.node = await registerNode();
console.log('[node] ' + JSON.stringify(report.node));
if (!report.node.registered) {
  U(`Devices: no runtime node could be registered (${report.node.reason || 'register status ' + report.node.registerStatus}), so Devices is exercised in its empty state only`);
}

const browser = await launch();

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => F(`pageerror: ${e.message}`));
  await page.goto(GATEWAY, { waitUntil: 'load' });
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.getByText(/ONLINE|在线/).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(900);

  /* ---- SEED REAL DATA so the surfaces are exercised with content, not only empty states ---- */
  await page.locator('#run').click();                       // creates a real CHECKPOINT_DEMO task
  await page.waitForTimeout(2500);
  await page.locator('#ask-text').fill(SEED_PHRASE);        // creates a real Action via the router
  await page.locator('#ask-submit').click();
  await page.waitForTimeout(3000);
  report.seed = await page.evaluate(async () => {
    const h = { Authorization: 'Bearer ' + sessionStorage.getItem('city-token'), 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
    const get = async (p) => (await (await fetch('/api/v0/' + p, { headers: h })).json());
    const [city, actions] = await Promise.all([get('city'), get('actions')]);
    return { nodes: city.nodes.length, tasks: city.tasks.length, events: city.events.length, actions: actions.actions.length };
  });
  console.log('[seed] ' + JSON.stringify(report.seed));
  if (report.seed.tasks === 0) F('seed: clicking Run Test Task created no task - the Tasks/Activity surfaces cannot be exercised with data');
  if (report.seed.actions === 0) U('Action detail: no action could be seeded, so the detail pane is exercised only as a placeholder');
  if (report.seed.nodes === 0) U('Devices: the gateway has no registered node, so Devices is exercised in its empty state only');

  const CHROME = /CONTROL SURFACE|WORKSPACE \/ ALIEN|Reference implementation|控制面板/;

  for (const s of SURFACES) {
    await page.locator(`nav button[data-page="${s.nav}"]`).click();
    await page.waitForTimeout(s.nav === 'Rooms' || s.nav === 'Actions' ? 1800 : 800);
    const m = await page.evaluate((sel) => {
      const view = document.querySelector('#view');
      const txt = view ? view.innerText : '';
      return {
        marker: !!document.querySelector(sel),
        viewLen: txt.trim().length,
        error: (document.querySelector('#error')?.textContent || '').trim(),
        heading: (document.querySelector('#heading')?.textContent || '').trim(),
        chrome: /CONTROL SURFACE|WORKSPACE \/ ALIEN|Reference implementation|控制面板/.test(document.body.innerText),
        glyph: /[\u25C8\u25A6\u25C7\u224B\u25C9\u25A4\u2263\u229E\u2699\u25A3]/.test(txt),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        interactive: view ? view.querySelectorAll('button,input,select,textarea,summary,a[href]').length : 0,
        unavailable: /unavailable|不可用|not live|不可达/i.test(txt),
        /* raw ISO-8601 must never surface as user copy - the repaired contract renders a
           relative age instead (Web is the parity baseline UI-102's delta was matched to) */
        iso: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(txt),
        deviceCards: view ? view.querySelectorAll('.device-card').length : 0,
      };
    }, s.marker);
    const reached = m.marker && m.viewLen > 0 && !m.error;
    report.surfaces.push({ need: s.need, nav: s.nav, note: s.note, reached, ...m });
    console.log(`[${reached ? 'REACHED' : 'UNREACHED'}] ${s.need.padEnd(9)} marker=${m.marker} len=${m.viewLen} ctrl=${m.interactive}${m.unavailable ? ' (honest-degraded)' : ''}${m.error ? ' ERR=' + m.error : ''}`);
    if (!reached) F(`${s.need}: not reachable (marker=${m.marker} viewLen=${m.viewLen} error="${m.error}")`);
    if (m.chrome) F(`${s.need}: engineering chrome visible on this surface`);
    if (m.glyph) F(`${s.need}: banned glyph in rendered copy`);
    if (m.overflow > 1) F(`${s.need}: horizontal overflow ${m.overflow}px`);
    if (m.iso) F(`${s.need}: raw ISO-8601 timestamp leaked into user copy (the repaired contract renders a relative age)`);
    if (s.need === 'Devices' && m.deviceCards === 0) U('Devices: rendered no .device-card, so the node-card path was not exercised');
    await page.screenshot({ path: `${OUT}/surface-${s.nav.replace(/\W/g, '')}.png` });
  }

  /* ---- Ask: the tenth named capability, reached through the ask bar ---- */
  await page.locator('#ask-text').fill('what is the city status');
  await page.locator('#ask-submit').click();
  await page.waitForTimeout(2500);
  report.ask = await page.evaluate(() => {
    const txt = document.querySelector('#view')?.innerText || '';
    return {
      resultMounted: !!document.querySelector('#ask-result'),
      viewLen: txt.trim().length,
      statesRouter: /router|deterministic|llm|路由|控制来源/i.test(txt),
      error: (document.querySelector('#error')?.textContent || '').trim(),
    };
  });
  console.log('[ask] ' + JSON.stringify(report.ask));
  if (!report.ask.resultMounted || report.ask.viewLen === 0) F('Ask: the ask bar did not mount its result view');
  if (!report.ask.statesRouter) F('Ask: rendered result does not state the routing source (the shell must not imply an AI chose the route)');
  await page.screenshot({ path: `${OUT}/surface-Ask.png` });

  /* ---- Action detail: must now be a REAL action, not the placeholder ---- */
  await page.locator('nav button[data-page="Actions"]').click();
  await page.waitForTimeout(2200);
  const actionBtn = page.locator('#view .panel button, #view button[data-terminal]').first();
  const actionCount = await actionBtn.count();
  if (actionCount) { await actionBtn.click().catch(() => {}); await page.waitForTimeout(2000); }
  report.actionDetail = await page.evaluate(() => {
    const d = document.querySelector('#action-detail');
    return { present: !!d, len: d ? d.innerText.trim().length : 0, text: d ? d.innerText.trim().slice(0, 160) : '' };
  });
  console.log('[action detail] ' + JSON.stringify(report.actionDetail));
  if (!report.actionDetail.present) F('Action: the detail host #action-detail is absent');
  else if (report.actionDetail.len <= PLACEHOLDER_MAX)
    U(`Action detail: only ${report.actionDetail.len} chars rendered (<=${PLACEHOLDER_MAX}), so this is still the placeholder - the detail path was NOT exercised`);
  await page.screenshot({ path: `${OUT}/surface-ActionDetail.png` });

  const reachedCount = report.surfaces.filter((s) => s.reached).length;
  console.log(`\nSURFACES REACHED: ${reachedCount}/${report.surfaces.length}`);
  console.log(report.findings.length ? `FINDINGS (${report.findings.length}):\n - ${report.findings.join('\n - ')}` : 'FINDINGS: none');
  console.log(report.unexercised.length ? `NOT FULLY EXERCISED (${report.unexercised.length}) - recorded, not passed:\n - ${report.unexercised.join('\n - ')}` : 'NOT FULLY EXERCISED: none');
  writeFileSync(`${OUT}/functional-regression.json`, JSON.stringify(report, null, 2));
  console.log(`\nreport -> ${OUT}/functional-regression.json`);
} finally { await browser.close(); }
