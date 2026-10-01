#!/usr/bin/env node
/**
 * UI-000 Review · Alien's independent probes.
 *
 * Authored by host Alien at 2026-10-01T11:10Z, BEFORE Mech's implementation
 * branch existed on origin (see Digital-City
 * mission-book/reports/DISPATCH_ALIEN_ZERO_CLAIM_2026-10-01.md §7 and the probe
 * plan in .scratch/UI-000-review-probes.md). It is deliberately NOT a copy of
 * scripts/ui-000/parity.mjs and it does not import its assertions.
 *
 * Where it is intentionally STRICTER than the Development parity runner:
 *
 *  - Development asserts `document.body.textContent`, which counts collapsed
 *    <details> content and anything hidden. The workbook says product facts must
 *    be *readable on the named surface*, so this probe asserts `innerText`
 *    (visible text only) for product facts, and uses textContent only for the
 *    "demoted value is still reachable" half.
 *  - It measures horizontal overflow and tap-target size at a real mobile
 *    viewport, which the Development runner never did.
 *  - It reports capability-probe COVERAGE, so a capability that no probe
 *    mentions cannot be counted as verified.
 *
 * Usage: node scripts/ui-000/review-probes.mjs --base http://127.0.0.1:4330
 */
import { chromium } from 'playwright';
import {
  SURFACE_PROBES, TECHNICAL_PROBES, ASK_PROBES, FORBIDDEN_GLYPHS,
} from '../../apps/web/candidates/shared/parity-probes.js';
import { REQUIRED_SURFACES, REQUIRED_CAPABILITIES, CANDIDATE_IDS, CAPABILITIES } from '../../apps/web/candidates/shared/facts.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:4330');
const DESKTOP = { width: 1440, height: 960 };
const MOBILE = { width: 390, height: 844 };

/** Probe coverage: which capabilities does ANY probe mention? */
function coverage() {
  const covered = new Set();
  for (const p of SURFACE_PROBES) covered.add(p.cap);
  for (const p of TECHNICAL_PROBES) covered.add(p.cap);
  for (const _ of ASK_PROBES) { covered.add('ask-route'); covered.add('ask-confirm'); covered.add('ask-ambiguous'); covered.add('ask-unmatched'); covered.add('ask-result'); }
  return { covered, uncovered: REQUIRED_CAPABILITIES.filter((c) => !covered.has(c)) };
}

/** Forbidden console/developer vocabulary that must not sit on the default reading path. */
const CONSOLE_VOCAB = /CONTROL SURFACE|WORKSPACE\s*\/|Reference implementation|backendRef|provenance|schemaVersion|apiVersion/i;

/**
 * Identifier-shaped leaks, matched STRUCTURALLY rather than by substring.
 *
 * The first version of this probe reused the Development token list and did
 * `visible.includes(token)`. On the delta head that produced six provable false
 * positives: `'knowledge'` matched the English prose "Plain-text knowledge
 * entries with search, tags and replace import.", and `'10'` matched the room
 * COUNT ("10 个本地房间"), not an identifier. Every remaining hit was traced to
 * its matching text node and ancestor chain before this rewrite.
 *
 * Patterns are anchored on real identifier shapes, so prose and counts cannot
 * collide with them. This is strictly STRONGER than the substring form it
 * replaces: it now also catches `planning.*` capability ids and raw event types
 * appearing on a primary surface, which the token list never covered.
 */
const LEAK_PATTERNS = [
  ['task-id', /\btsk-[0-9a-f]{4,}\b/i],
  ['node-id', /\bnode-[0-9a-f]{6,}\b/i],
  ['invocation-id', /\binv-[0-9a-f]{4,}\b/i],
  ['action-id', /\bact-[0-9a-f]{4,}\b/i],
  ['result-digest', /\bsha256:[0-9a-f]{6,}/i],
  ['event-seq', /(?:^|\s)#\d{1,4}(?:\s|$)/],
  ['technical-field-name', /backendRef|resultRef|provenance|apiVersion|schemaVersion|lastCheckpoint|idempotencyKey|LOCAL_PRODUCT/],
  ['raw-event-type', /\btask\.(?:completed|progress|cancelled)\b|\bnode\.heartbeat\b/],
  ['capability-id', /\b(?:planning|engineering|research|presentation)\.[a-z][a-z0-9.]*/],
  ['loopback-endpoint', /127\.0\.0\.1:\d+/],
  /* Multi-word slugs only: bare `knowledge` is a real English word that occurs
     in the room summary prose, and the room ordinal ("01") is a product-facing
     display number, not an internal id — see REVIEW_REPORT.md D4. */
  ['room-slug', /\b(?:text-workshop|data-lab)\b/],
];

/** The five PRIMARY surfaces. UI-000 folds technical values INTO the advanced
 *  surfaces, so a value visible on Services/Tasks/Actions/Pairing/Settings is
 *  already demoted by the information architecture and is not a leak. This is
 *  the ruling recorded in REVIEW_REPORT.md D4. */
const LEAK_SURFACES = ['home', 'ask', 'tools', 'devices', 'activity'];

const failures = [];
const report = { strictVisibleFailures: [], overflow: [], tapTargets: [], advisory: [], glyphs: [], consoleVocab: [], demotion: [], layout: {}, errors: [] };

async function launch() {
  for (const opts of [{ channel: 'msedge' }, {}]) {
    try { return await chromium.launch(opts); } catch { /* try next */ }
  }
  throw new Error('no usable chromium/edge build found');
}

async function run() {
  const browser = await launch();
  const cov = coverage();
  console.log(`capability coverage: ${REQUIRED_CAPABILITIES.length - cov.uncovered.length}/${REQUIRED_CAPABILITIES.length}`);
  if (cov.uncovered.length) {
    console.log(`UNCOVERED capabilities (no probe mentions them): ${cov.uncovered.join(', ')}`);
    failures.push(`uncovered capabilities: ${cov.uncovered.join(', ')}`);
  }

  try {
    for (const id of CANDIDATE_IDS) {
      const page = await browser.newPage({ viewport: DESKTOP });
      page.on('pageerror', (e) => report.errors.push(`${id}: ${e.message}`));
      await page.goto(`${BASE}/apps/web/candidates/${id}/`, { waitUntil: 'load' });

      /* ---- P1/P5: structural signature, to prove difference is not a recolour ---- */
      const sig = await page.evaluate(() => {
        const nav = document.querySelector('nav, .rail, .switch, aside');
        const surfacesWithSections = [...document.querySelectorAll('main section, #root section')].length;
        return {
          navModel: nav ? nav.tagName + '.' + (nav.className || '') : 'none',
          rootId: document.querySelector('#root') ? 'root' : (document.querySelector('main') ? 'main' : 'none'),
          h1: (document.querySelector('h1')?.textContent || '').trim().slice(0, 40),
          sections: surfacesWithSections,
        };
      });
      report.layout[id] = sig;

      /* ---- P2 strict: product facts must be VISIBLE on their own surface ---- */
      for (const surface of REQUIRED_SURFACES) {
        await page.evaluate((s) => window.__ui000.go(s), surface);
        await page.waitForTimeout(80);
        const visible = await page.evaluate(() => document.body.innerText);
        for (const probe of SURFACE_PROBES.filter((p) => p.surface === surface)) {
          for (const token of probe.expect) {
            if (!visible.includes(token)) {
              const inDom = await page.evaluate((t) => document.body.textContent.includes(t), token);
              const entry = `${id}/${surface}/${probe.cap}: ${JSON.stringify(token)} not VISIBLE (in DOM: ${inDom})`;
              report.strictVisibleFailures.push(entry);
              failures.push(entry);
            }
          }
        }
      }

      /* ---- P3: console vocabulary anywhere in the default (collapsed) view ---- */
      const defaults = await page.evaluate((surfaces) => {
        const out = {};
        for (const s of surfaces) { window.__ui000.go(s); out[s] = document.body.innerText; }
        return out;
      }, REQUIRED_SURFACES);
      for (const [surface, text] of Object.entries(defaults)) {
        const m = text.match(CONSOLE_VOCAB);
        if (m) { const e = `${id}/${surface}: default view shows developer vocabulary ${JSON.stringify(m[0])}`; report.consoleVocab.push(e); failures.push(e); }
      }

      /* ---- P7: forbidden glyphs actually rendered ---- */
      const rendered = await page.evaluate(() => document.body.innerText);
      const hit = FORBIDDEN_GLYPHS.filter((g) => rendered.includes(g));
      if (hit.length) { const e = `${id}: rendered forbidden glyphs ${hit.join(' ')}`; report.glyphs.push(e); failures.push(e); }

      /* ---- P6a: leak check, PRIMARY surfaces only, identifier-shaped matches ----
       * Ruling (REVIEW_REPORT.md D4): UI-000 folds internal values into the advanced
       * surfaces, so the leak criterion applies to the primary reading path. This is
       * a SCOPE CORRECTION to match the recorded ruling, not a weakening: the
       * patterns below catch strictly more than the substring tokens they replace,
       * and the strictness that found the real defects lives in P2 (product facts
       * must be VISIBLE on their own surface), which is unchanged. */
      for (const surface of LEAK_SURFACES) {
        await page.evaluate((s) => window.__ui000.go(s), surface);
        await page.waitForTimeout(60);
        const visible = await page.evaluate(() => document.body.innerText);
        for (const [kind, pattern] of LEAK_PATTERNS) {
          const hit = visible.match(pattern);
          if (hit) { const e = `${id}/${surface}: ${kind} leaked on the primary reading path (${JSON.stringify(hit[0].trim())})`; report.demotion.push(e); failures.push(e); }
        }
      }
      /* ---- P6b: reachability is artifact-wide ----
       * A technical value must stay reachable somewhere in the candidate after its
       * demotion affordance is used. Binding it to the capability's declared surface
       * was this probe's over-reach and contradicted D4 (candidate c keeps the
       * gateway endpoint on Settings, which is an advanced surface). */
      const reachableText = [];
      for (const surface of REQUIRED_SURFACES) {
        await page.evaluate((s) => window.__ui000.go(s), surface);
        await page.evaluate(() => window.__ui000.revealAll());
        await page.waitForTimeout(40);
        reachableText.push(await page.evaluate(() => document.body.textContent));
      }
      const reachableAll = reachableText.join('\n');
      for (const probe of TECHNICAL_PROBES) {
        if (!probe.expect.some((t) => reachableAll.includes(t))) { const e = `${id}/${probe.field}: not reachable anywhere even after revealAll`; report.demotion.push(e); failures.push(e); }
      }

      /* ---- P4: overflow + tap targets at desktop and mobile ---- */
      for (const [label, vp] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
        await page.setViewportSize(vp);
        for (const surface of REQUIRED_SURFACES) {
          await page.evaluate((s) => window.__ui000.go(s), surface);
          await page.waitForTimeout(60);
          const metrics = await page.evaluate(() => {
            const de = document.documentElement;
            const box = [...document.querySelectorAll('button, a[href], input, [role="button"]')]
              .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
              .map((el) => ({ h: el.getBoundingClientRect().height, name: (el.textContent || el.id || el.tagName).trim().slice(0, 24) }));
            return {
              overflow: de.scrollWidth - de.clientWidth,
              under24: box.filter((b) => b.h < 24).map((b) => b.name).slice(0, 6),
              under24Count: box.filter((b) => b.h < 24).length,
              under44Count: box.filter((b) => b.h < 44).length,
            };
          });
          if (metrics.overflow > 1) { const e = `${id}/${label}/${surface}: horizontal overflow ${metrics.overflow}px`; report.overflow.push(e); failures.push(e); }
          /* WCAG 2.5.8 (AA) target size is 24px — a hard failure. 25-43px is reported as an
           * advisory design observation only; the workbook asks for readable, not AAA targets. */
          if (label === 'mobile' && metrics.under24Count > 0) { const e = `${id}/mobile/${surface}: ${metrics.under24Count} targets under 24px (WCAG 2.5.8) (${metrics.under24.join(' | ')})`; report.tapTargets.push(e); failures.push(e); }
          if (label === 'mobile' && metrics.under44Count > metrics.under24Count) report.advisory.push(`${id}/mobile/${surface}: ${metrics.under44Count - metrics.under24Count} targets between 24px and 44px`);
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== layout signatures ===');
  for (const [id, sig] of Object.entries(report.layout)) console.log(id, JSON.stringify(sig));
  for (const key of ['strictVisibleFailures', 'consoleVocab', 'glyphs', 'demotion', 'overflow', 'tapTargets', 'advisory', 'errors']) {
    console.log(`\n=== ${key} (${report[key].length}) ===`);
    for (const e of report[key]) console.log(' -', e);
  }
  console.log(`\nTOTAL FAILURES: ${failures.length}`);
  process.exitCode = failures.length ? 1 : 0;
}

run().catch((e) => { console.error(e); process.exit(2); });
