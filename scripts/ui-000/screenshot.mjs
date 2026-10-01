#!/usr/bin/env node
/**
 * UI-000 evidence helper — deterministic screenshot harness.
 *
 * Captures the three candidate directions (and the current product, for the
 * before/after comparison the Owner reads) at desktop and narrow widths.
 *
 * Uses the SYSTEM Chrome/Edge channel rather than a downloaded Playwright
 * browser, matching how the existing web tests launch on win32.
 *
 *   node scripts/ui-000/screenshot.mjs [--out .runtime/evidence/mission-book/UI-000] [--only a,b,c]
 *
 * Writes to the git-ignored raw evidence area by default, per
 * mission-book/PROCESS_DATA_POLICY.md Layer 1. A bounded, curated subset is then
 * published to evidence/raw/mission-book/UI-000/ for the Owner and the review host.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const OUT = resolve(ROOT, arg('out', '.runtime/evidence/mission-book/UI-000'));
const ONLY = arg('only', 'a,b,c').split(',').map((s) => s.trim()).filter(Boolean);
const CANDIDATE_PORT = Number(arg('candidate-port', 4330));
const PRODUCT_PORT = Number(arg('product-port', 4310));
const ROOMS_PORT = Number(arg('rooms-port', 4320));

/* Fixed viewports so two runs are byte-comparable. */
const VIEWPORTS = {
  desktop: { width: 1440, height: 960 },
  narrow: { width: 414, height: 896 },
};

/* One capture per information-architecture surface. */
const CANDIDATE_SHOTS = [
  { surface: 'home', name: 'home' },
  { surface: 'ask', name: 'ask' },
  { surface: 'tools', name: 'tools' },
  { surface: 'devices', name: 'devices' },
  { surface: 'activity', name: 'activity' },
  { surface: 'services', name: 'advanced-services' },
  { surface: 'tasks', name: 'advanced-tasks' },
  { surface: 'pairing', name: 'advanced-pairing' },
  { surface: 'settings', name: 'advanced-settings' },
];

/* The current product, for the before/after page the Owner compares against. */
const PRODUCT_SHOTS = [
  { hash: '#home', name: 'home', ready: '#view .stats' },
  { hash: '#rooms', name: 'tools-rooms', ready: '#view' },
  { hash: '#devices', name: 'devices', ready: '#view .device-card' },
  { hash: '#activity', name: 'activity', ready: '#view' },
  { hash: '#services', name: 'services', ready: '#view' },
];

const log = (...a) => console.log('[ui-000]', ...a);

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      const browser = await chromium.launch({ channel, args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
      log(`browser: ${channel}`);
      return browser;
    } catch (error) {
      log(`channel ${channel} unavailable: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error('no system Chrome/Edge channel available for Playwright');
}

async function shoot(page, file) {
  await page.screenshot({ path: file, fullPage: true });
  log('captured', file.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
}

const menu = async (page) => {
  page.on('pageerror', (e) => log('PAGE ERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE ERROR:', m.text()); });
};

async function captureCandidates(browser) {
  for (const id of ONLY) {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      const page = await browser.newPage({ viewport });
      await menu(page);
      const size = `${viewport.width}x${viewport.height}`;
      const dir = resolve(OUT, `candidate-${id}`);
      await mkdir(dir, { recursive: true });
      for (const shot of CANDIDATE_SHOTS) {
        await page.goto(`http://127.0.0.1:${CANDIDATE_PORT}/apps/web/candidates/${id}/#${shot.surface}`, { waitUntil: 'load' });
        await page.evaluate((s) => window.__ui000?.go(s), shot.surface);
        await page.waitForTimeout(180);
        await shoot(page, resolve(dir, `${size}-${shot.name}.png`));
      }
      /* Candidate C's Ask/Do is a full-bleed spotlight, so capture it opened. */
      await page.goto(`http://127.0.0.1:${CANDIDATE_PORT}/apps/web/candidates/${id}/#ask`, { waitUntil: 'load' });
      const opened = await page.evaluate(() => {
        if (typeof window.__ui000?.openSpotlight === 'function') { window.__ui000.openSpotlight(); return true; }
        return false;
      });
      if (opened) {
        await page.waitForTimeout(180);
        await shoot(page, resolve(dir, `${size}-ask-spotlight.png`));
      }
      await page.close();
    }
  }
}

async function captureRoomThemes(browser) {
  const dir = resolve(OUT, 'rooms');
  await mkdir(dir, { recursive: true });
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await menu(page);
  try {
    for (const theme of ['none', 'a', 'b', 'c']) {
      const query = theme === 'none' ? '' : `?theme=${theme}`;
      for (const room of ['knowledge', 'focus']) {
        await page.goto(`http://127.0.0.1:${ROOMS_PORT}/${query}#/${room}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(700);
        await shoot(page, resolve(dir, `${theme}-${room}.png`));
      }
    }
  } catch (error) {
    log('room theme capture skipped:', error.message.split('\n')[0]);
  } finally {
    await page.close();
  }
}

async function captureProduct(browser, token) {
  const dir = resolve(OUT, 'before');
  await mkdir(dir, { recursive: true });
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await menu(page);
  await page.goto(`http://127.0.0.1:${PRODUCT_PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => sessionStorage.setItem('city-token', t), token);
  await page.goto(`http://127.0.0.1:${PRODUCT_PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  for (const shot of PRODUCT_SHOTS) {
    await page.goto(`http://127.0.0.1:${PRODUCT_PORT}/${shot.hash}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((h) => { window.location.hash = h; }, shot.hash);
    await page.waitForTimeout(1100);
    await shoot(page, resolve(dir, `${shot.name}.png`));
  }
  await page.close();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await launch();
  try {
    if (ONLY.length) await captureCandidates(browser);
    await captureRoomThemes(browser);
    const token = process.env.CITY_TOKEN;
    if (token) await captureProduct(browser, token);
    else log('CITY_TOKEN not set — skipping current-product captures');
  } finally {
    await browser.close();
  }
  const manifest = {
    captured_at: new Date().toISOString(),
    candidates: ONLY,
    viewports: VIEWPORTS,
    surfaces: CANDIDATE_SHOTS.map((s) => s.surface),
  };
  await writeFile(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
