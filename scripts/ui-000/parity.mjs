#!/usr/bin/env node
/**
 * UI-000 evidence helper — capability parity runner.
 *
 * Drives each candidate in a real browser and asserts that every canonical
 * capability is still expressed. This is the machine-checked half of the
 * workbook rule "三套必须共享同样功能事实" (the other half is the independent
 * host's visual critique).
 *
 *   node scripts/ui-000/parity.mjs [--base http://127.0.0.1:4330] [--out evidence/raw/ui-000]
 *
 * Exits non-zero on the first candidate with a failed probe.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURFACE_PROBES, TECHNICAL_PROBES, ASK_PROBES, ACTION_PROBES } from '../../apps/web/candidates/shared/parity-probes.js';
import { REQUIRED_SURFACES, REQUIRED_CAPABILITIES, CANDIDATE_IDS } from '../../apps/web/candidates/shared/facts.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:4330');
const OUT = resolve(ROOT, arg('out', 'evidence/raw/ui-000'));

const fail = [];
const results = [];

async function run() {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const id of CANDIDATE_IDS) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });

      await page.goto(`${BASE}/apps/web/candidates/${id}/`, { waitUntil: 'load' });

      const declared = await page.evaluate(() => window.__ui000?.surfaces ?? []);
      const missingSurfaces = REQUIRED_SURFACES.filter((s) => !declared.includes(s));
      if (missingSurfaces.length) fail.push(`${id}: surfaces not declared: ${missingSurfaces.join(', ')}`);

      /* Pass 1 — product facts must read on their own surface, untouched. */
      for (const surface of REQUIRED_SURFACES) {
        await page.evaluate((s) => window.__ui000.go(s), surface);
        await page.waitForTimeout(60);
        const text = await page.evaluate(() => document.body.textContent);
        for (const probe of SURFACE_PROBES.filter((p) => p.surface === surface)) {
          for (const token of probe.expect) {
            const ok = text.includes(token);
            results.push({ candidate: id, probe: 'surface', where: surface, cap: probe.cap, token, ok });
            if (!ok) fail.push(`${id}: surface ${surface} / ${probe.cap} missing ${JSON.stringify(token)}`);
          }
        }
      }

      /* Pass 2 — technical values: forbidden on the reading path, must be reachable. */
      const revealed = await page.evaluate(() => {
        const parts = [];
        for (const surface of window.__ui000.surfaces) {
          window.__ui000.go(surface);
          if (typeof window.__ui000.revealAll === 'function') window.__ui000.revealAll();
          parts.push(document.body.textContent);
        }
        return parts.join('\n');
      });
      for (const probe of TECHNICAL_PROBES) {
        for (const token of probe.expect) {
          const ok = revealed.includes(token);
          results.push({ candidate: id, probe: 'technical', where: 'revealed', cap: probe.cap, token, ok });
          if (!ok) fail.push(`${id}: technical ${probe.field} (${probe.cap}) unreachable: ${JSON.stringify(token)}`);
        }
      }

      for (const probe of ASK_PROBES) {
        await page.evaluate((s) => { window.__ui000.go('ask'); window.__ui000.setAsk(s); }, probe.state);
        await page.waitForTimeout(60);
        const text = await page.evaluate(() => document.body.textContent);
        for (const token of probe.expect) {
          const ok = text.includes(token);
          results.push({ candidate: id, probe: 'ask', where: `ask:${probe.state}`, cap: 'ask-states', token, ok });
          if (!ok) fail.push(`${id}: ask/${probe.state} missing ${JSON.stringify(token)}`);
        }
      }

      /* Pass 3 — actions: click the real control and assert the produced fact.
         A control that renders but does nothing fails here. */
      const actionOrder = ['openRoom', 'openHub', 'invoke', 'createDemoTask', 'cancelTask', 'startPairing', 'disconnect'];
      for (const action of actionOrder) {
        const probe = ACTION_PROBES.find((p) => p.action === action);
        if (!probe) continue;
        await page.evaluate((s) => window.__ui000.go(s), probe.surface);
        await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
        let clicked = null;
        for (const label of probe.labels) {
          /* Only enabled controls count: a disabled button is not an affordance,
             and clicking one would time out rather than prove anything. */
          const handle = page.locator('button:enabled', { hasText: label }).first();
          if (await handle.count()) {
            try { await handle.click({ timeout: 3000 }); clicked = label; break; } catch { /* try next wording */ }
          }
        }
        if (!clicked) {
          fail.push(`${id}: action ${probe.action} has no clickable control on ${probe.surface} (labels: ${probe.labels.join(' / ')})`);
          continue;
        }
        await page.waitForTimeout(60);
        const after = await page.evaluate(() => document.body.textContent);
        const opened = await page.evaluate(() => window.__opened ?? []);
        results.push({ candidate: id, probe: 'action', where: `${probe.surface}:${clicked}`, cap: probe.action, token: `click:${clicked}`, ok: true });
        if (probe.expectOpened && !opened.some((u) => u.includes(probe.expectOpened))) {
          fail.push(`${id}: action ${probe.action} did not open ${probe.expectOpened} (opened: ${JSON.stringify(opened)})`);
        }
        for (const token of probe.expect ?? []) {
          const ok = after.includes(token);
          results.push({ candidate: id, probe: 'action', where: `${probe.surface}:${clicked}`, cap: probe.action, token, ok });
          if (!ok) fail.push(`${id}: action ${probe.action} did not produce ${JSON.stringify(token)}`);
        }
      }

      if (errors.length) fail.push(`${id}: page errors: ${errors.join(' | ')}`);
      const mine = results.filter((r) => r.candidate === id);
      console.log(`[parity] candidate ${id}: ${mine.filter((r) => r.ok).length}/${mine.length} probes passed`);
      await page.close();
    }
  } finally {
    await browser.close();
  }

  await mkdir(OUT, { recursive: true });
  const report = {
    generated_at: new Date().toISOString(),
    base: BASE,
    candidates: CANDIDATE_IDS,
    required_surfaces: REQUIRED_SURFACES,
    required_capabilities: REQUIRED_CAPABILITIES,
    probes_total: results.length,
    probes_passed: results.filter((r) => r.ok).length,
    failures: fail,
    results,
  };
  await writeFile(resolve(OUT, 'parity-report.json'), JSON.stringify(report, null, 2));

  const lines = [
    '# UI-000 capability parity report',
    '',
    `- generated: ${report.generated_at}`,
    `- candidates: ${CANDIDATE_IDS.join(', ')}`,
    `- probes: ${report.probes_passed}/${report.probes_total} passed`,
    `- result: ${fail.length ? 'FAIL' : 'PASS'}`,
    '',
    ...(fail.length ? ['## Failures', '', ...fail.map((f) => `- ${f}`), ''] : []),
    '| candidate | probe | where | capability | token | ok |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.candidate} | ${r.probe} | ${r.where} | ${r.cap} | ${String(r.token).replace(/\|/g, '\\|')} | ${r.ok ? 'yes' : 'NO'} |`),
  ];
  await writeFile(resolve(OUT, 'parity-report.md'), lines.join('\n'));

  console.log(`[parity] ${report.probes_passed}/${report.probes_total} probes passed`);
  if (fail.length) {
    console.error(`[parity] FAIL — ${fail.length} problem(s):`);
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[parity] PASS');
}

run().catch((e) => { console.error(e); process.exit(1); });
