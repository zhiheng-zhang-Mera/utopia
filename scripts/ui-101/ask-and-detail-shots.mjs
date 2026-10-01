#!/usr/bin/env node
/**
 * UI-101 · steps 4 and 8 — Ask/Do state presentation and the Action-detail advanced view.
 *
 * Pairs against a running dev gateway, drives the shell's one natural-language entry
 * (the #ask-form the shell owns) through each state it must distinguish, and then
 * opens an Action row to check that raw details are folded by default but reachable.
 *
 *   CITY_TOKEN=<token> node scripts/ui-101/ask-and-detail-shots.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || process.env.CITY_URL || 'http://127.0.0.1:4310';
const TOKEN = process.env.CITY_TOKEN;
const OUT = '.runtime/evidence/ui-101';
if (!TOKEN) throw new Error('CITY_TOKEN is required to pair');
mkdirSync(OUT, { recursive: true });

/* Each input must land in a distinguishable presentation. `marker` is what the shell
   must show for that state; `raw` is internal vocabulary that must NOT appear. */
const CASES = [
  { name: 'route-confirmed', input: 'hash C:\\tmp\\a.txt', marker: /Hash Room|哈希/, expectShot: true },
  { name: 'needs-choice', input: 'clean up my downloads folder', marker: /确认|选择|Document intake/, expectShot: true },
  { name: 'ambiguous', input: 'open my notes', marker: /Knowledge Room|知识/, expectShot: true },
  { name: 'unmatched', input: 'reticulate the splines', marker: /Focus Room|Data Lab|没有|未匹配|手动/, expectShot: true },
];

const launch = async () => { for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} } throw new Error('no browser'); };

const browser = await launch();
const findings = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.getByText(/ONLINE|在线/).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);

  /* ---- step 4: Ask/Do states ---- */
  const observed = [];
  for (const c of CASES) {
    await page.locator('#ask-text').fill(c.input);
    await page.locator('#ask-submit').click();
    await page.waitForTimeout(1800);
    const view = await page.locator('#view').innerText();
    const badgeLabel = (await page.locator('#ask-result .badge').count())
      ? (await page.locator('#ask-result .badge').first().innerText()).trim() : '(no state badge)';
    const actions = await page.locator('#ask-result [data-terminal^="ask-"]').count();
    observed.push(`${c.name}: state="${badgeLabel}" controls=${actions}`);
    console.log(`[ask] ${c.name.padEnd(16)} state=${JSON.stringify(badgeLabel)} controls=${actions}`);
    await page.screenshot({ path: `${OUT}/ask-${c.name}.png`, fullPage: true });
    /* the ask surface must not leak raw internal vocabulary by default */
    for (const leak of ['AWAITING_CONFIRMATION', 'AMBIGUOUS', 'UNMATCHED', 'MATCHED', 'idempotencyKey', 'backendRef']) {
      if (view.includes(leak)) findings.push(`ask ${c.name}: raw protocol token visible: ${leak}`);
    }
  }
  const distinct = new Set(observed.map((o) => o.split('state=')[1].split(' controls')[0]));
  if (distinct.size < 2) findings.push(`ask: all four inputs produced the same state presentation (${[...distinct].join(', ')}), so the states are not distinguished`);

  /* ---- step 8: Action detail, folded by default then reachable ---- */
  await page.locator('nav button[data-page="Actions"]').first().click();
  await page.waitForTimeout(800);
  const before = await page.locator('#view').innerText();
  for (const leak of ['backendRef', 'provenance', 'resultRef', 'act-']) {
    if (before.includes(leak)) findings.push(`actions list: raw detail visible by default: ${leak}`);
  }
  const row = page.locator('#view [data-terminal="action-open"]').first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(700); }
  else findings.push('actions: no action-open row exists, so the detail view could not be opened');
  await page.screenshot({ path: `${OUT}/action-detail-collapsed.png`, fullPage: true });
  const details = page.locator('#view details');
  const n = await details.count();
  for (let i = 0; i < n; i += 1) { await details.nth(i).evaluate((d) => { d.open = true; }); }
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/action-detail-advanced.png`, fullPage: true });
  const after = await page.locator('#view').innerText();
  if (n === 0) findings.push('actions: no folded run-details block exists, so raw detail has nowhere to be reachable');
  else if (!/backendRef|provenance|resultRef|route|act-/i.test(after)) findings.push('actions: expanding run-details did not reveal any raw detail (folded but not reachable)');

  if (errors.length) findings.push(`page errors: ${JSON.stringify(errors.slice(0, 4))}`);
  console.log(findings.length ? `FINDINGS:\n - ${findings.join('\n - ')}` : 'CLEAN: no findings');
} finally { await browser.close(); }
