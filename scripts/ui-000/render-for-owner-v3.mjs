#!/usr/bin/env node
/**
 * UI-000 · Owner round-3 render set.
 *
 * Owner ruling, second round: "紧凑程度正确，但是希望继续向日系科幻二次元主题偏移，
 * 参考明日方舟/战双帕弥什/鸣潮的感觉，主页人物就是后期设置的助理。"
 *
 * Renders the current direction (C″) and builds sheets comparing the PREVIOUS
 * accepted density pass (C′, from the round-2 folder) against C″ and against B.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:4330';
const OUT = process.argv[3] || 'D:/UI-000-candidates-v3';
const PREV = process.argv[4] || 'D:/UI-000-candidates-v2/cprime';
const REF = process.argv[5] || 'D:/UI-000-candidates/web';
const PRIMARY = ['home', 'ask', 'tools', 'devices', 'activity'];
const ADVANCED = ['services', 'tasks', 'actions', 'pairing', 'settings'];
const launch = async () => { for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} } throw new Error('no browser'); };

const browser = await launch();
try {
  await mkdir(`${OUT}/c2`, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`${BASE}/apps/web/candidates/c/`, { waitUntil: 'load' });
  for (const s of [...PRIMARY, ...ADVANCED]) {
    await page.evaluate((x) => window.__ui000.go(x), s);
    await page.waitForTimeout(180);
    await page.screenshot({ path: `${OUT}/c2/${s}-desktop.png` });
  }
  await page.setViewportSize({ width: 414, height: 896 });
  for (const s of PRIMARY) { await page.evaluate((x) => window.__ui000.go(x), s); await page.waitForTimeout(170); await page.screenshot({ path: `${OUT}/c2/${s}-mobile.png` }); }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const s of PRIMARY) { await page.evaluate((x) => window.__ui000.go(x), s); await page.waitForTimeout(150); await page.screenshot({ path: `${OUT}/c2/${s}-390.png` }); }
  await page.close();

  await mkdir(`${OUT}/compare`, { recursive: true });
  const sheet = async (name, title, cols) => {
    const fig = ([f, l]) => `<figure><figcaption>${l}</figcaption><img src="${pathToFileURL(f).href}"></figure>`;
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#05040a;color:#e8e4f5;font:13px/1.4 "Segoe UI",system-ui,sans-serif}
      h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;margin:16px 20px 10px;color:#5ee7ff}
      .row{display:grid;grid-template-columns:repeat(${cols.length},1fr);gap:10px;padding:0 20px 22px}
      figure{margin:0;border:1px solid rgba(94,231,255,.35)}
      figcaption{font-size:11px;letter-spacing:.14em;padding:6px 9px;background:rgba(139,92,246,.16)}
      img{display:block;width:100%}
    </style><h1>UI-000 · ${title}</h1><div class="row">${cols.map(fig).join('')}</div>`;
    const tmp = `${OUT}/compare/_${name}.html`;
    await writeFile(tmp, html);
    const p = await browser.newPage({ viewport: { width: 1560, height: 820 } });
    await p.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
    await p.waitForTimeout(220);
    await p.screenshot({ path: `${OUT}/compare/${name}.png`, fullPage: true });
    await p.close();
  };

  for (const s of ['home', 'tools', 'ask', 'devices']) {
    await sheet(s, `${s} · C′（上一轮）↔ C″（二次元）↔ B`, [
      [`${PREV}/${s}-desktop.png`, 'C′ 上一轮 · 已认可的密度'],
      [`${OUT}/c2/${s}-desktop.png`, 'C″ 本轮 · 日系科幻二次元'],
      [`${REF}/b-${s}-desktop.png`, 'B · 简洁基准'],
    ]);
  }
  await sheet('home-mobile', 'home 390px · C′ ↔ C″', [
    [`${PREV}/home-390.png`, 'C′ · 390px'],
    [`${OUT}/c2/home-390.png`, 'C″ · 390px'],
  ]);
} finally { await browser.close(); }
console.log(`rendered -> ${OUT}`);
