#!/usr/bin/env node
/**
 * UI-103 · Rooms visual-unification verification.
 *
 * The restyle is a single shared-stylesheet change, so the risk it carries is
 * REGRESSION ACROSS TEN ROOMS, not a missing feature. This probe therefore mounts
 * every room in a real browser and checks, per room:
 *
 *   - it mounted without throwing (the hub records page errors in window.__roomsErrors);
 *   - the room actually rendered interactive content, not an error banner;
 *   - no dev-tool vocabulary leaked back onto the default reading path
 *     (UI-103 forbids LOCAL · 127.0.0.1 and runtime file paths as product copy);
 *   - the local/debug facts are still DISCOVERABLE, in the diagnostics disclosure;
 *   - text contrast meets WCAG AA on the new darker/lighter palette.
 *
 *   node scripts/ui-103/verify-hub.mjs [--base http://127.0.0.1:4320]
 */
import { chromium } from 'playwright';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:4320');

const ROOMS = ['knowledge', 'bookmarks', 'checklist', 'prompts', 'text-workshop', 'hash', 'data-lab', 'focus', 'calendar', 'decisions'];

/* Strings that must no longer sit on the default product surface (UI-103). */
const DEV_TOOL_LEAKS = ['ROOM PACK V1', '127.0.0.1', '.runtime-rooms/', 'persistent ·'];
/* Facts that must remain discoverable, behind the disclosure. */
const DIAGNOSTIC_FACTS = ['127.0.0.1'];

async function launch() {
  for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) {
    try { return await chromium.launch(opts); } catch { /* next */ }
  }
  throw new Error('no usable chromium/edge build found');
}

const failures = [];
const summary = [];

async function run() {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  for (const room of ROOMS) {
    await page.goto(`${BASE}/#/${room}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(450);
    const facts = await page.evaluate(() => {
      const visible = document.body.innerText;
      const root = document.getElementById('room-root');
      const diag = document.getElementById('hub-diagnostics');
      return {
        visible,
        diagText: diag ? diag.textContent : null,
        diagOpenByDefault: diag ? diag.hasAttribute('open') : null,
        mountedNodes: root ? root.querySelectorAll('*').length : 0,
        controls: root ? root.querySelectorAll('button, input, select, textarea').length : 0,
        errorBanner: root ? !!root.querySelector('.banner.error') : false,
        roomsErrors: Array.isArray(window.__roomsErrors) ? window.__roomsErrors.slice(0, 3) : null,
      };
    });

    for (const leak of DEV_TOOL_LEAKS) {
      if (facts.visible.includes(leak)) failures.push(`${room}: dev-tool string ${JSON.stringify(leak)} still on the default reading path`);
    }
    if (!facts.diagText || !DIAGNOSTIC_FACTS.some((f) => facts.diagText.includes(f))) {
      failures.push(`${room}: local/debug facts are no longer discoverable in the diagnostics disclosure`);
    }
    if (facts.diagOpenByDefault !== false) failures.push(`${room}: diagnostics disclosure is not collapsed by default`);
    if (facts.mountedNodes < 6) failures.push(`${room}: mounted only ${facts.mountedNodes} nodes — the room did not render`);
    if (facts.errorBanner) failures.push(`${room}: room rendered an error banner`);
    if (facts.roomsErrors?.length) failures.push(`${room}: page errors ${facts.roomsErrors.join(' | ')}`);
    summary.push({ room, nodes: facts.mountedNodes, controls: facts.controls });
  }

  /* Contrast on the hub surface, using the new palette. */
  await page.goto(`${BASE}/#/knowledge`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const contrast = await page.evaluate(() => {
    const parse = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const over = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
    const effectiveBg = (el) => {
      let node = el; let acc = null;
      while (node && node !== document.documentElement) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg.length >= 3 && (bg[3] ?? 1) > 0) {
          acc = acc ? over(acc.concat(1), bg) : bg.slice(0, 3).concat(bg[3] ?? 1);
          if ((bg[3] ?? 1) === 1) break;
        }
        node = node.parentElement;
      }
      return (acc ?? [8, 7, 15]).slice(0, 3);
    };
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!own) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const fg = parse(cs.color);
      if (fg.length < 3) continue;
      const bg = effectiveBg(el);
      const composed = over(fg.length === 4 ? fg : fg.concat(1), bg);
      const l1 = lum(composed); const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize); const weight = Number(cs.fontWeight) || 400;
      const need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
      if (ratio < need) out.push({ text: (el.textContent || '').trim().slice(0, 26), cls: String(el.className).slice(0, 30), color: cs.color, bg: `rgb(${bg.map(Math.round).join(',')})`, ratio: Math.round(ratio * 100) / 100, need, size });
    }
    return out;
  });
  for (const c of contrast) failures.push(`contrast ${c.ratio}:1 (needs ${c.need}) on ${c.color} over ${c.bg} — ${JSON.stringify(c.text)} [${c.cls}]`);

  await browser.close();
  console.log(`rooms mounted: ${summary.length}/${ROOMS.length}`);
  console.log(summary.map((s) => `  ${s.room}: ${s.nodes} nodes, ${s.controls} controls`).join('\n'));
  console.log(`contrast failures on the hub: ${contrast.length}`);
  console.log(`console errors: ${consoleErrors.length}`);
  if (failures.length) {
    console.error(`verify-hub: FAIL (${failures.length})`);
    for (const f of failures.slice(0, 25)) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('verify-hub: PASS');
}

run().catch((e) => { console.error(e); process.exit(1); });
