#!/usr/bin/env node
/**
 * UI-190 · keyboard / focus traversal on the integrated Web shell.
 *
 * Both the UI-101 review and its delta re-verification recorded keyboard/focus traversal
 * as covered by NEITHER of them, so this closes a gap this programme has carried.
 *
 * It does not just list the tab order: it checks the two failure modes that a
 * presentation rewrite can introduce silently -
 *   1. a focus stop that exists in the DOM but is not actually focusable/visible
 *      (zero size, or hidden), and
 *   2. a focus ring that cannot be seen because an ancestor clips it. The shell design
 *      system uses clip-path on every panel, and a CSS clip-path clips the outline too,
 *      so this is a real risk introduced by the direction itself rather than a generic
 *      accessibility platitude.
 *
 *   CITY_TOKEN=<token> node scripts/ui-190/focus-traversal.mjs [gatewayUrl]
 */
import { chromium } from 'playwright';

const GATEWAY = process.argv[2] || process.env.CITY_URL || 'http://127.0.0.1:4310';
const TOKEN = process.env.CITY_TOKEN;
if (!TOKEN) throw new Error('CITY_TOKEN required');

const launch = async () => { for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} } throw new Error('no browser'); };
const browser = await launch();
const findings = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => findings.push(`pageerror: ${e.message}`));
  await page.goto(GATEWAY, { waitUntil: 'load' });
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.getByText(/ONLINE|在线/).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);

  const stops = [];
  for (let i = 0; i < 18; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: 'BODY', id: '', text: '', w: 0, h: 0 };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      /* the nearest ancestor that clips, if any - a clip-path clips the focus ring too */
      let clipper = null;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).clipPath && getComputedStyle(p).clipPath !== 'none') { clipper = p.tagName + '.' + String(p.className || '').split(' ')[0]; break; }
      }
      return {
        tag: el.tagName, id: el.id || '', text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 26),
        w: Math.round(r.width), h: Math.round(r.height),
        outline: cs.outlineStyle + ' ' + cs.outlineWidth,
        clipper,
      };
    });
    stops.push(info);
  }

  console.log('tab order:');
  stops.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.tag}${s.id ? '#' + s.id : ''} "${s.text}" ${s.w}x${s.h} outline=${s.outline}${s.clipper ? ' CLIPPED_BY=' + s.clipper : ''}`));

  const invisible = stops.filter((s) => s.tag !== 'BODY' && (s.w < 2 || s.h < 2));
  if (invisible.length) findings.push(`${invisible.length} focus stop(s) have no visible box: ${invisible.map((s) => s.tag + (s.id ? '#' + s.id : '')).join(', ')}`);
  if (!stops.some((s) => s.id === 'ask-text')) findings.push('the Ask input (#ask-text) was never reached by Tab');
  if (!stops.some((s) => s.tag === 'BUTTON')) findings.push('no button was reached by Tab');
  const clipped = stops.filter((s) => s.clipper);
  if (clipped.length) findings.push(`${clipped.length} focus stop(s) sit inside a clip-path ancestor, so the focus ring may be visually cut: ${clipped.map((s) => (s.tag + (s.id ? '#' + s.id : '')) + ' in ' + s.clipper).join(' | ')}`);
  const noOutline = stops.filter((s) => s.tag !== 'BODY' && /none/.test(s.outline));
  if (noOutline.length) findings.push(`${noOutline.length} focus stop(s) have outline:none, so keyboard focus may be invisible: ${noOutline.map((s) => s.tag + (s.id ? '#' + s.id : '')).join(', ')}`);

  console.log(findings.length ? `\nFINDINGS (${findings.length}):\n - ${findings.join('\n - ')}` : '\nCLEAN: focus reaches the shell controls in order with a visible ring');
} finally { await browser.close(); }
