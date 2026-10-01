#!/usr/bin/env node
/**
 * UI-000 · Mech's independent revision-review probes (C2 @ aea8361).
 *
 * Written for the §3 independent review of the C2 revision. It deliberately does
 * NOT reuse `parity.mjs` (Mech's own Development runner) or `review-probes.mjs`
 * (host Alien's), because §3 says review must not "只签字或复述作者测试".
 *
 * It checks three things neither existing instrument checks:
 *
 *  1. CONTRAST. The revision is a dark neon HUD (`--void #08070f` with violet,
 *     lime and hologram-cyan signals). Neither host has audited colour contrast.
 *     Every text-bearing element on the rendered surfaces is measured against its
 *     effective background and scored against WCAG 2.1 AA (4.5:1 normal, 3:1 large).
 *  2. THE REVISION'S OWN CLAIMS, taken from OWNER_STYLE_RULING.md §6.3, so the
 *     author's stated decisions are verified rather than trusted:
 *       - the anime register must NOT be carried by Japanese copy (kana scan, not a
 *         CJK scan — this is a zh-CN product, so Han characters are expected);
 *       - the assistant slot must expose NO interactive control (no new dead affordance);
 *       - the placeholder must be labelled as a placeholder, not implied finished art;
 *       - the slot must list the v2-invariant-4 configurable fields.
 *  3. BROKEN REQUESTS / console errors — a HUD built on CSS shapes should request no
 *     missing asset, and a 404 would otherwise be invisible behind the dark theme.
 *
 *   node scripts/ui-000/review-mech-probes.mjs --base http://127.0.0.1:4330 [--out <dir>]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_SURFACES, CANDIDATE_IDS } from '../../apps/web/candidates/shared/facts.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:4330');
const OUT = resolve(ROOT, arg('out', '.runtime/evidence/mission-book/UI-000'));

/** Japanese-only scripts. Han characters are NOT evidence of Japanese (zh-CN uses them). */
const KANA = /[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9D]/;

async function launch() {
  for (const opts of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) {
    try { return await chromium.launch(opts); } catch { /* next */ }
  }
  throw new Error('no usable chromium/edge build found');
}

const failures = [];
const report = { contrast: [], kana: [], assistantClaims: [], requests: [], errors: [] };

async function run() {
  const browser = await launch();
  try {
    for (const id of CANDIDATE_IDS) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const badRequests = [];
      page.on('requestfailed', (r) => badRequests.push(`${r.url()} (${r.failure()?.errorText})`));
      page.on('response', (r) => { if (r.status() >= 400) badRequests.push(`${r.status()} ${r.url()}`); });
      page.on('pageerror', (e) => report.errors.push(`${id}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`${id}: ${m.text()}`); });

      await page.goto(`${BASE}/apps/web/candidates/${id}/`, { waitUntil: 'load' });

      /* ---- 1 / 3: contrast + requests, measured per surface in the default state ---- */
      for (const surface of REQUIRED_SURFACES) {
        await page.evaluate((s) => window.__ui000.go(s), surface);
        await page.waitForTimeout(60);
        const found = await page.evaluate(() => {
          const parse = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
          const lum = ([r, g, b]) => {
            const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          const over = (fg, bg) => { // alpha-composite fg over bg
            const a = fg[3] ?? 1;
            return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
          };
          const effectiveBg = (el) => {
            let node = el;
            let acc = null;
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
          for (const el of document.querySelectorAll('#root *, main *')) {
            const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
            if (!own) continue;
            const box = el.getBoundingClientRect();
            if (box.width < 1 || box.height < 1) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.15) continue;
            const fg = parse(cs.color);
            if (fg.length < 3) continue;
            const bg = effectiveBg(el);
            const composed = over(fg.length === 4 ? fg : fg.concat(1), bg);
            const l1 = lum(composed); const l2 = lum(bg);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const size = parseFloat(cs.fontSize);
            const weight = Number(cs.fontWeight) || 400;
            const large = size >= 24 || (size >= 18.66 && weight >= 700);
            out.push({
              text: (el.textContent || '').trim().slice(0, 28),
              cls: (el.className || el.tagName).toString().slice(0, 40),
              color: cs.color, bg: `rgb(${bg.map(Math.round).join(',')})`,
              size: Math.round(size * 10) / 10, large,
              ratio: Math.round(ratio * 100) / 100,
              need: large ? 3 : 4.5,
            });
          }
          return out;
        });
        for (const item of found) {
          if (item.ratio < item.need) {
            report.contrast.push({ candidate: id, surface, ...item });
          }
        }
      }

      /* ---- 2: the revision's own claims, on candidate C only ---- */
      if (id === 'c') {
        const kana = await page.evaluate(() => document.body.textContent);
        const hits = kana.match(/[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9D]/g) ?? [];
        if (hits.length) {
          report.kana.push({ candidate: id, hits: [...new Set(hits)].slice(0, 12) });
          failures.push(`c: Japanese kana present in rendered copy (${[...new Set(hits)].join(' ')}) — the ruling says the register must be carried by geometry/type/colour, not Japanese copy`);
        }

        await page.evaluate(() => window.__ui000.go('home'));
        await page.waitForTimeout(80);
        const claims = await page.evaluate(() => {
          const slot = document.querySelector('.operator');
          if (!slot) return { present: false };
          const interactive = [...slot.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [tabindex]')]
            .map((n) => `${n.tagName}${n.className ? '.' + n.className : ''}`);
          const text = slot.textContent;
          return {
            present: true,
            interactive,
            hasPlaceholderNote: /占位/.test(text),
            labels: {
              assistant: /ASSISTANT/.test(text),
              slot01: /SLOT\s*0?1/.test(text),
              unassigned: /UNASSIGNED|未指派/.test(text),
            },
            fields: {
              naming: /命名/.test(text),
              appearance: /形象/.test(text),
              voice: /语音/.test(text),
              duty: /职务/.test(text),
            },
            hasImg: slot.querySelectorAll('img, image, use[href], [style*="url("]').length,
          };
        });
        report.assistantClaims.push({ candidate: id, ...claims });
        if (!claims.present) failures.push('c: the assistant/operator slot the ruling requires is missing from Home');
        else {
          if (claims.interactive.length) failures.push(`c: the assistant slot exposes interactive controls (${claims.interactive.join(', ')}) — the ruling says it must be purely presentational to avoid a dead affordance`);
          if (!claims.hasPlaceholderNote) failures.push('c: the assistant slot does not say it is a placeholder — the ruling requires an honest placeholder, not implied finished art');
          for (const [k, v] of Object.entries(claims.labels)) if (!v) failures.push(`c: assistant slot is missing its "${k}" label`);
          for (const [k, v] of Object.entries(claims.fields)) if (!v) failures.push(`c: assistant slot does not list the configurable "${k}" field required by v2 invariant 4`);
          if (claims.hasImg) failures.push(`c: assistant art references an image/url (${claims.hasImg}) — the repo has no character asset, so it must be drawn`);
        }
      }

      if (badRequests.length) {
        report.requests.push({ candidate: id, badRequests });
        failures.push(`${id}: ${badRequests.length} failed/4xx request(s): ${badRequests.slice(0, 3).join(' | ')}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, 'review-mech-probes.json'), JSON.stringify({ generated_at: new Date().toISOString(), base: BASE, failures, report }, null, 2));

  const bySurface = {};
  for (const c of report.contrast) bySurface[`${c.candidate}/${c.surface}`] = (bySurface[`${c.candidate}/${c.surface}`] ?? 0) + 1;
  console.log(`contrast: ${report.contrast.length} element(s) below WCAG AA`);
  for (const [k, v] of Object.entries(bySurface)) console.log(`  ${k}: ${v}`);
  console.log(`failed/4xx requests: ${report.requests.reduce((n, r) => n + r.badRequests.length, 0)}`);
  console.log(`page errors: ${report.errors.length}`);
  if (failures.length) {
    console.error(`review-mech-probes: FAIL (${failures.length})`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('review-mech-probes: PASS (no assertion failures; see contrast report)');
}

run().catch((e) => { console.error(e); process.exit(1); });
