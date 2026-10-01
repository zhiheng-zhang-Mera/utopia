#!/usr/bin/env node
/**
 * UI-101 · browser acceptance capture.
 *
 * Pairs against a running dev gateway and screenshots every shell page plus a
 * narrow viewport, which is what UI-101 step 8 asks for. Writes only into
 * .runtime/ (git-ignored) per PROCESS_DATA_POLICY; the bounded conclusions go to
 * the City report.
 *
 *   CITY_TOKEN=<token> node scripts/ui-101/shell-shots.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || process.env.CITY_URL || 'http://127.0.0.1:4310';
const TOKEN = process.env.CITY_TOKEN;
const OUT = '.runtime/evidence/ui-101';
if (!TOKEN) throw new Error('CITY_TOKEN is required to pair');
mkdirSync(OUT, { recursive: true });

const PAGES = ['Home', 'Rooms', 'Devices', 'Activity', 'Services', 'Tasks', 'Actions', 'Pairing', 'Settings'];
const launch = async () => { for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} } throw new Error('no browser'); };

const browser = await launch();
const findings = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  /* locate by id, not by label text: the shell localises, and this host renders zh-CN */
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.getByText(/ONLINE|在线/).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);

  for (const name of PAGES) {
    const btn = page.locator(`nav button[data-page="${name}"]`);
    if (!(await btn.count())) { findings.push(`nav button for ${name} missing`); continue; }
    await btn.first().click();
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${OUT}/${name.toLowerCase()}-desktop.png`, fullPage: true });
    /* engineering chrome must not survive on a product surface */
    const text = await page.evaluate(() => document.body.innerText);
    for (const bad of ['CONTROL SURFACE', 'WORKSPACE / ALIEN', 'Reference implementation', 'DIGITAL CITY / 01', '控制面板', '工作区 / ALIEN', '参考实现', '数字城市 / 01']) {
      if (text.includes(bad)) findings.push(`${name}: engineering chrome still visible: ${JSON.stringify(bad)}`);
    }
    for (const glyph of ['◈', '▦', '◇', '≋', '◉', '▤', '≣', '⊞', '⚙', '▣']) {
      if (text.includes(glyph)) findings.push(`${name}: ASCII/Unicode glyph rendered as icon: ${glyph}`);
    }
    /* internal vocabulary and ids must not sit on the default reading path */
    for (const leak of ['CLIENT_CONNECTED', 'CITY_STARTED', 'task.completed', 'task.progress', 'node.heartbeat', 'text-workshop', 'data-lab', 'LOCAL_PRODUCT', 'backendRef', 'provenance']) {
      if (text.includes(leak)) findings.push(`${name}: raw internal vocabulary visible by default: ${leak}`);
    }
    const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (of > 1) findings.push(`${name}: desktop horizontal overflow ${of}px`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['Home', 'Rooms', 'Devices']) {
    await page.locator(`nav button[data-page="${name}"]`).first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${name.toLowerCase()}-390.png`, fullPage: true });
    const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (of > 1) findings.push(`${name}: 390px horizontal overflow ${of}px`);
  }

  if (errors.length) findings.push(`page errors: ${JSON.stringify(errors.slice(0, 4))}`);
  console.log(findings.length ? `FINDINGS:\n - ${findings.join('\n - ')}` : 'CLEAN: no findings');
} finally { await browser.close(); }
