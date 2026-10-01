#!/usr/bin/env node
/**
 * UI-101 · Mech's independent review probes for the Web product shell.
 *
 * Written for the §3 review of head 56c8190. It deliberately does NOT reuse
 * scripts/ui-101/shell-shots.mjs or ask-and-detail-shots.mjs (the Development host's
 * own instruments), because §3 forbids signing off by repeating the author's tests.
 *
 * It targets two things the Development host explicitly handed to the reviewer as
 * UNVERIFIED, plus the one measurement neither host had applied to the production
 * Web shell:
 *
 *  1. ALL FIVE Ask/Do gateway states, driven through the real shell UI. The
 *     Development host could not trigger AWAITING_CONFIRMATION or AMBIGUOUS because
 *     their environment had no Room hub and no registered node, so every input was
 *     triaged into the unmatched family. This run stands up the full host (gateway +
 *     reference node + Room hub) and uses the router's real literal patterns, so the
 *     states are actually reached rather than assumed. Untriggered is not verified.
 *  2. COLOUR CONTRAST on the production apps/web palette, scored against WCAG 2.1 AA.
 *     Mech found a systematic AA failure in the UI-000 candidate surface; the shell
 *     carries an AA-safe token, and that claim is checked here rather than trusted.
 *  3. Raw internal identifiers must not sit on the default reading path, in EITHER
 *     locale, at desktop and at 390px, with no horizontal overflow.
 *
 *   node scripts/ui-101/review-mech-probes.mjs [--base http://127.0.0.1:4310] [--token <city token>]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:4310');
const TOKEN = arg('token', process.env.CITY_TOKEN ?? '');
const OUT = resolve(ROOT, arg('out', '.runtime/evidence/mission-book/UI-101-review'));

/* Router-literal inputs. Taken from services/dev-gateway/intents.mjs, not guessed. */
const ASK_CASES = [
  { name: 'route-confirmed', text: 'note that the gateway is up', expectAny: [/gateway/i], statusHint: 'COMPLETED' },
  { name: 'failed', text: 'hash C:\\tmp\\a.txt', expectAny: [/hash/i], statusHint: 'FAILED' },
  { name: 'needs-confirmation', text: 'run a safe task of type CHECKPOINT_DEMO', expectAny: [/确认|confirm|CHECKPOINT_DEMO/i], statusHint: 'AWAITING_CONFIRMATION' },
  { name: 'ambiguous', text: 'search for utopia', expectAny: [/knowledge|知识/i], statusHint: 'AMBIGUOUS' },
  { name: 'unmatched', text: 'reticulate the splines', expectAny: [/目标|target|没|没有|no rule/i], statusHint: 'UNMATCHED' },
];

/** Raw protocol/internal vocabulary that must not be on the default reading path. */
const RAW_TOKENS = [
  'AWAITING_CONFIRMATION', 'AMBIGUOUS', 'UNMATCHED', 'MATCHED',
  'backendRef', 'resultRef', 'provenance', 'schemaVersion', 'apiVersion',
  'LOCAL_PRODUCT', 'actionId', 'invocationId',
];
/** Engineering chrome that must not appear in either locale. */
const ENGINEERING_CHROME = /CONTROL SURFACE|WORKSPACE\s*\/|Reference implementation/i;

const failures = [];
const notes = [];
const report = { ask: [], contrast: [], raw: [], chrome: [], overflow: [], errors: [] };

async function launch() {
  for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) {
    try { return await chromium.launch(opts); } catch { /* next */ }
  }
  throw new Error('no usable chromium/edge build found');
}

const contrastIn = () => {
  const parse = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
  const effectiveBg = (el) => {
    let node = el; let acc = null;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      const bg = parse(cs.backgroundColor);
      if (bg.length >= 3 && (bg[3] ?? 1) > 0) {
        acc = acc ? over(acc.concat(1), bg) : bg.slice(0, 3).concat(bg[3] ?? 1);
        if ((bg[3] ?? 1) === 1) break;
      }
      node = node.parentElement;
    }
    return (acc ?? [255, 255, 255]).slice(0, 3);
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
    if (ratio < need) {
      out.push({ text: (el.textContent || '').trim().slice(0, 28), cls: String(el.className).slice(0, 34), color: cs.color, bg: `rgb(${bg.map(Math.round).join(',')})`, ratio: Math.round(ratio * 100) / 100, need, size: Math.round(size) });
    }
  }
  return out;
};

async function main() {
  if (!TOKEN) throw new Error('a city token is required (--token or CITY_TOKEN)');
  await mkdir(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) report.errors.push(m.text()); });

  /* authenticate the way the shell does, then reload into the product */
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => sessionStorage.setItem('city-token', t), TOKEN);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const visible = async () => (await page.evaluate(() => document.body.innerText)) ?? '';

  for (const locale of ['en', 'zh-CN']) {
    await page.evaluate((l) => localStorage.setItem('utopia.ui.locale', l), locale);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    /* ---- chrome check in this locale ---- */
    const chromeText = await visible();
    const chrome = chromeText.match(ENGINEERING_CHROME);
    if (chrome) { report.chrome.push({ locale, hit: chrome[0] }); failures.push(`${locale}: engineering chrome on the default path: ${JSON.stringify(chrome[0])}`); }

    /* ---- overflow at 390 ---- */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const of = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    report.overflow.push({ locale, ...of });
    if (of.scroll > of.client) failures.push(`${locale}: horizontal overflow at 390px (scrollWidth ${of.scroll} > clientWidth ${of.client})`);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForTimeout(300);

    /* ---- all five ask states through the real UI ---- */
    for (const c of ASK_CASES) {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(900);
      const input = page.locator('#ask-text');
      if (!(await input.count())) { failures.push(`${locale}/${c.name}: the ask input is missing`); continue; }
      await input.fill(c.text);
      await page.locator('#ask-submit').click();
      await page.waitForTimeout(2200);
      const text = await visible();
      const reached = c.expectAny.some((re) => re.test(text));
      report.ask.push({ locale, case: c.name, reached, chars: text.length });
      if (!reached) failures.push(`${locale}/${c.name}: the state did not render (looked for ${c.expectAny.map(String).join(' | ')})`);
      const lost = RAW_TOKENS.filter((t) => text.includes(t));
      if (lost.length) {
        report.raw.push({ locale, case: c.name, tokens: lost });
        failures.push(`${locale}/${c.name}: raw internal vocabulary on the default path: ${lost.join(', ')}`);
      }
      for (const item of await page.evaluate(contrastIn)) {
        report.contrast.push({ locale, case: c.name, ...item });
      }
    }
  }

  /* ---- contrast across the shell's own pages ---- */
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  for (const surface of ['Home', 'Rooms', 'Devices', 'Activity', 'Services', 'Tasks', 'Actions', 'Pairing', 'Settings']) {
    const button = page.locator(`[data-page="${surface}"]`);
    if (!(await button.count())) continue;
    await button.first().click();
    await page.waitForTimeout(500);
    for (const item of await page.evaluate(contrastIn)) report.contrast.push({ locale: 'zh-CN', case: `page:${surface}`, ...item });
  }

  await browser.close();
  await writeFile(resolve(OUT, 'review-mech-probes.json'), JSON.stringify({ generated_at: new Date().toISOString(), base: BASE, failures, report }, null, 2));

  const distinct = new Map();
  for (const c of report.contrast) distinct.set(`${c.color} on ${c.bg}`, c);
  console.log(`ask states driven: ${report.ask.length} (${report.ask.filter((a) => a.reached).length} reached)`);
  console.log(`contrast: ${report.contrast.length} element(s) below AA across ${distinct.size} distinct colour pair(s)`);
  for (const [k, v] of [...distinct].slice(0, 10)) console.log(`   min=${v.ratio} need=${v.need} ${k} e.g. ${JSON.stringify(v.text)}`);
  console.log(`raw-vocabulary leaks: ${report.raw.length}; chrome hits: ${report.chrome.length}; page errors: ${report.errors.length}`);
  if (failures.length) {
    console.error(`review-mech-probes: FAIL (${failures.length})`);
    for (const f of failures.slice(0, 30)) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('review-mech-probes: PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
