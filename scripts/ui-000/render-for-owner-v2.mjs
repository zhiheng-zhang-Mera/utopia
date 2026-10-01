#!/usr/bin/env node
/**
 * UI-000 · Owner round-2 render set.
 *
 * Renders the revised direction C′ (Owner ruling 2026-10-01: keep C's theme, drop
 * the big sparse cards, tighten toward B, game-HUD register) and builds side-by-side
 * comparison sheets: OLD C  <->  NEW C′  <->  B (the concision reference).
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:4330';
const OUT = process.argv[3] || 'D:/UI-000-candidates-v2';
const OLD = process.argv[4] || 'D:/UI-000-candidates/web';
const PRIMARY = ['home', 'ask', 'tools', 'devices', 'activity'];
const ADVANCED = ['services', 'tasks', 'actions', 'pairing', 'settings'];
const launch = async () => { for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} } throw new Error('no browser'); };

const browser = await launch();
const made = [];
try {
  await mkdir(`${OUT}/cprime`, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`${BASE}/apps/web/candidates/c/`, { waitUntil: 'load' });
  for (const surface of [...PRIMARY, ...ADVANCED]) {
    await page.evaluate((s) => window.__ui000.go(s), surface);
    await page.waitForTimeout(170);
    await page.screenshot({ path: `${OUT}/cprime/${surface}-desktop.png` });
  }
  await page.setViewportSize({ width: 414, height: 896 });
  for (const surface of PRIMARY) {
    await page.evaluate((s) => window.__ui000.go(s), surface);
    await page.waitForTimeout(170);
    await page.screenshot({ path: `${OUT}/cprime/${surface}-mobile.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const surface of PRIMARY) {
    await page.evaluate((s) => window.__ui000.go(s), surface);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/cprime/${surface}-390.png` });
  }
  await page.close();

  /* ---- side-by-side comparison sheets ---- */
  await mkdir(`${OUT}/compare`, { recursive: true });
  const sheet = async (name, surface, leftFile, leftLabel, midFile, midLabel, rightFile, rightLabel) => {
    const img = (f, l) => `<figure><figcaption>${l}</figcaption><img src="${pathToFileURL(f).href}"></figure>`;
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#05040a;color:#e8e4f5;font:13px/1.4 "Segoe UI",system-ui,sans-serif}
      h1{font-size:14px;letter-spacing:.22em;text-transform:uppercase;margin:16px 20px 8px;color:#c6f24e}
      .row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:0 20px 20px}
      figure{margin:0;border:1px solid rgba(139,92,246,.35)}
      figcaption{font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:6px 9px;background:rgba(139,92,246,.14)}
      img{display:block;width:100%}
    </style><h1>UI-000 · ${surface} · 旧 C ↔ 新 C′ ↔ B（简洁基准）</h1><div class="row">
      ${img(leftFile, leftLabel)}${img(midFile, midLabel)}${img(rightFile, rightLabel)}
    </div>`;
    const tmp = `${OUT}/compare/_${name}.html`;
    await writeFile(tmp, html);
    const p = await browser.newPage({ viewport: { width: 1560, height: 780 } });
    await p.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
    await p.waitForTimeout(220);
    await p.screenshot({ path: `${OUT}/compare/${name}.png`, fullPage: true });
    await p.close();
    made.push(`${OUT}/compare/${name}.png`);
  };
  for (const surface of ['home', 'tools', 'ask', 'devices', 'services']) {
    await sheet(surface, surface,
      `${OLD}/c-${surface}-desktop.png`, 'OLD C · 大卡片',
      `${OUT}/cprime/${surface}-desktop.png`, 'NEW C′ · HUD 紧凑',
      `${OLD}/b-${surface}-desktop.png`, 'B · 简洁基准');
  }
  await sheet('mobile-home', 'home（390px）',
    `${OLD}/c-home-mobile.png`, 'OLD C · mobile',
    `${OUT}/cprime/home-390.png`, 'NEW C′ · 390px',
    `${OLD}/b-home-mobile.png`, 'B · mobile');

  /* carry the reference captures the Owner already has */
  await copyFile(`${OLD}/00-candidate-index.png`, `${OUT}/00-candidate-index.png`).catch(() => {});
} finally { await browser.close(); }
console.log(`rendered -> ${OUT}\n` + made.join('\n'));
