#!/usr/bin/env node
/**
 * UI-000 · Owner review render set (host Alien).
 * Renders the three candidate directions from the reviewed head into a plain local
 * folder so the Owner can open them without a running server.
 */
import { chromium } from 'playwright';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:4330';
const OUT = process.argv[3] || 'D:/UI-000-candidates';
const SURFACES = ['home', 'ask', 'tools', 'devices', 'activity'];
const launch = async () => { for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} } throw new Error('no browser'); };

const browser = await launch();
const made = [];
try {
  await mkdir(`${OUT}/web`, { recursive: true });
  for (const id of ['a', 'b', 'c']) {
    for (const vp of [['desktop', { width: 1440, height: 960 }], ['mobile', { width: 414, height: 896 }]]) {
      const page = await browser.newPage({ viewport: vp[1] });
      await page.goto(`${BASE}/apps/web/candidates/${id}/`, { waitUntil: 'load' });
      for (const surface of SURFACES) {
        await page.evaluate((s) => window.__ui000.go(s), surface);
        await page.waitForTimeout(180);
        const file = `${OUT}/web/${id}-${surface}-${vp[0]}.png`;
        await page.screenshot({ path: file });
        made.push(file);
      }
      await page.close();
    }
  }
  const gate = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await gate.goto(`${BASE}/apps/web/candidates/`, { waitUntil: 'load' });
  await gate.screenshot({ path: `${OUT}/web/00-candidate-index.png`, fullPage: true });
  await gate.close();
  made.push(`${OUT}/web/00-candidate-index.png`);
} finally { await browser.close(); }

/* Carry the Development host's own Rooms and Android captures alongside. */
await mkdir(`${OUT}/rooms`, { recursive: true });
await mkdir(`${OUT}/android`, { recursive: true });
const carry = [
  ['evidence/raw/mission-book/UI-000/rooms/none-knowledge.png', `${OUT}/rooms/room-hub-default.png`],
  ['evidence/raw/mission-book/UI-000/rooms/a-knowledge.png', `${OUT}/rooms/room-hub-theme-a.png`],
  ['evidence/raw/mission-book/UI-000/rooms/b-knowledge.png', `${OUT}/rooms/room-hub-theme-b.png`],
  ['evidence/raw/mission-book/UI-000/rooms/c-knowledge.png', `${OUT}/rooms/room-hub-theme-c.png`],
  ['evidence/raw/mission-book/UI-000/before/home.png', `${OUT}/before-web-home.png`],
  ['evidence/raw/mission-book/UI-000/before/tools-rooms.png', `${OUT}/before-web-tools.png`],
  ['evidence/raw/mission-book/UI-000/android-candidates/candidate-a-home.png', `${OUT}/android/a-home.png`],
  ['evidence/raw/mission-book/UI-000/android-candidates/candidate-b-home.png', `${OUT}/android/b-home.png`],
  ['evidence/raw/mission-book/UI-000/android-candidates/candidate-c-home.png', `${OUT}/android/c-home.png`],
];
const carried = [];
for (const [from, to] of carry) { try { await copyFile(from, to); carried.push(to); } catch { /* absent */ } }

await writeFile(`${OUT}/README.md`, `# UI-000 视觉方向候选 — 可对比图集

来源：Utopia 分支 \`ui/UI-000-visual-direction-candidates\`，**复核结论头 \`727a254\`**
（Development 主机 Mech，独立复核主机 Alien）。由 Alien 于本机用 Edge 重新渲染。

## web/ — 三套候选的真实渲染（本次重新截图）
文件名 \`<候选>-<页面>-<desktop|mobile>.png\`，候选 a=Halo / b=Atlas / c=Prism。
- \`home\` 首屏、\`ask\` 对话·执行、\`tools\` 工具/房间、\`devices\` 设备、\`activity\` 动态
- desktop = 1440×960，mobile = 414×896
- \`00-candidate-index.png\` 是三选一入口页

## rooms/ — Rooms Hub 三套主题（Development 提供）
同一 Knowledge Room，default 为现状，theme-a/b/c 为三套方向下的呈现。

## android/ — Android 代表页（Development 提供）
每套方向一张 Compose Home 代表屏。

## before-*.png — 改造前的现状
Web 首页与 Tools/Rooms 页，用于对照「是否仍有工程后台气质」。
`);
console.log(`rendered ${made.length} web images, carried ${carried.length} images -> ${OUT}`);
