#!/usr/bin/env node
/**
 * UI-103 Review · Alien's independent probe.
 *
 * Deliberately not a copy of scripts/ui-103/verify-hub.mjs: section 3 forbids
 * signing off by repeating the author's own instrument. This probe was written
 * against the task text and the live page, and it adds the check the author's list
 * does not cover as a first-class item — ACTUAL CONTRAST ARITHMETIC over every
 * rendered text node — because a previous review on this programme found a
 * systematic WCAG AA failure that a probe without contrast checks had passed.
 *
 *   node scripts/ui-103/review-alien-probe.mjs [--base http://127.0.0.1:4320]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:4320');
const OUT = '.runtime/evidence/ui-103/review-alien';
const ROOMS = ['knowledge', 'bookmarks', 'checklist', 'prompts', 'text-workshop', 'hash', 'data-lab', 'focus', 'calendar', 'decisions'];

const launch = async () => { for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} } throw new Error('no browser'); };

/* relative luminance + contrast, computed in-page so real computed colours are used */
const CONTRAST_FN = `(() => {
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (s) => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const bgOf = (el) => { let n = el; while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.5) return c.rgb; n = n.parentElement; } return [8, 7, 15]; };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const text = (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) ? el.innerText : '';
    if (!text || !text.trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.5) continue;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const L1 = lum(fg.rgb), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio + 0.005 < need) out.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 30), size, ratio: Math.round(ratio * 100) / 100, need, sample: text.trim().slice(0, 40) });
  }
  return out;
})()`;

const browser = await launch();
const findings = [];
const perRoom = [];
mkdirSync(OUT, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });

  for (const room of ROOMS) {
    await page.goto(`${BASE}/#/${room}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const visible = document.body.innerText;
      const root = document.getElementById('room-root');
      return {
        visible,
        controls: root ? root.querySelectorAll('button, input, select, textarea').length : 0,
        nodes: root ? root.querySelectorAll('*').length : 0,
        roomsErrors: Array.isArray(window.__roomsErrors) ? window.__roomsErrors.slice(0, 2) : [],
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    const contrast = await page.evaluate(CONTRAST_FN);

    if (info.nodes < 5) findings.push(`${room}: room root rendered almost nothing (${info.nodes} nodes)`);
    if (info.controls === 0) findings.push(`${room}: no interactive control mounted`);
    if (info.roomsErrors.length) findings.push(`${room}: room mount errors ${JSON.stringify(info.roomsErrors)}`);
    if (info.overflow > 1) findings.push(`${room}: horizontal overflow ${info.overflow}px at 1440`);
    /* dev-tool vocabulary must not be on the default reading path */
    for (const leak of ['127.0.0.1', '.runtime-rooms/', 'ROOM PACK', 'LOCAL ·']) {
      if (info.visible.includes(leak)) findings.push(`${room}: dev-tool copy on the default path: ${JSON.stringify(leak)}`);
    }
    /* banned glyph-as-icon */
    for (const g of ['◈', '▦', '◇', '≋', '◉', '▤', '≣', '⊞', '⚙', '▣', '✦', '❖', '◆', '■', '▲']) {
      if (info.visible.includes(g)) findings.push(`${room}: banned glyph rendered: ${g}`);
    }
    if (contrast.length) {
      const worst = contrast.slice(0, 3).map((c) => `${c.tag}.${c.cls}@${c.size}px ${c.ratio}:1<${c.need}`).join(' | ');
      findings.push(`${room}: ${contrast.length} text elements below WCAG AA — ${worst}`);
    }
    perRoom.push(`${room.padEnd(14)} nodes=${String(info.nodes).padStart(4)} controls=${String(info.controls).padStart(3)} aaFailures=${contrast.length}`);
    await page.screenshot({ path: `${OUT}/${room}-1440.png`, fullPage: true });
  }

  /* narrow screen pass on three representative rooms */
  await page.setViewportSize({ width: 390, height: 844 });
  for (const room of ['knowledge', 'data-lab', 'checklist']) {
    await page.goto(`${BASE}/#/${room}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(350);
    const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (of > 1) findings.push(`${room}: horizontal overflow ${of}px at 390`);
    await page.screenshot({ path: `${OUT}/${room}-390.png`, fullPage: true });
  }

  /* the hub index itself */
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/hub-index.png`, fullPage: true });

  if (errors.length) findings.push(`page errors across the pass: ${JSON.stringify(errors.slice(0, 4))}`);
  console.log(perRoom.join('\n'));
  console.log(findings.length ? `\nFINDINGS (${findings.length}):\n - ${findings.join('\n - ')}` : '\nCLEAN: no findings');
} finally { await browser.close(); }
