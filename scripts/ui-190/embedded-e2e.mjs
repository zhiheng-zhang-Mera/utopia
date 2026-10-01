#!/usr/bin/env node
/**
 * UI-190 · cross-surface integration probe — the embedded-hub seam, END TO END.
 *
 * This is the check UI-101's delta re-verification explicitly handed to UI-190. Its
 * reviewer recorded the reason precisely: the shell passes ?embedded=1 to the room
 * iframe, but a UI-101 worktree serves a main-based hub that has no embedded support at
 * all, so only the URL could be asserted there and never the EFFECT. Both halves now sit
 * on this integration branch, so the effect is checkable: inside the frame the hub must
 * set body[data-embedded="true"] and hide its own rail, because the Web shell owns the
 * frame and a second rail inside it would be a visible integration defect.
 *
 *   CITY_TOKEN=<token> node scripts/ui-190/embedded-e2e.mjs [gatewayUrl] [hubUrl]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const GATEWAY = process.argv[2] || process.env.CITY_URL || 'http://127.0.0.1:4310';
const HUB = process.argv[3] || 'http://127.0.0.1:4320';
const TOKEN = process.env.CITY_TOKEN;
const OUT = '.runtime/evidence/ui-190';
if (!TOKEN) throw new Error('CITY_TOKEN is required to pair');
mkdirSync(OUT, { recursive: true });

const launch = async () => { for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} } throw new Error('no browser'); };

const browser = await launch();
const findings = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => findings.push(`shell pageerror: ${e.message}`));

  await page.goto(GATEWAY, { waitUntil: 'load' });
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.getByText(/ONLINE|在线/).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);

  await page.locator('nav button[data-page="Rooms"]').first().click();
  await page.waitForTimeout(800);
  const openBtn = page.locator('#view [data-terminal="room-open"]').first();
  if (!(await openBtn.count())) { findings.push('no room-open control: the Rooms surface did not render, so the seam cannot be exercised'); }
  else {
    await openBtn.click();
    await page.waitForTimeout(2500);
    const frame = page.locator('iframe.terminal-frame').first();
    if (!(await frame.count())) findings.push('no room iframe rendered');
    else {
      const src = await frame.getAttribute('src');
      console.log(`[shell] iframe src = ${src}`);
      if (!src || !src.includes('embedded=1')) findings.push(`embedded flag missing from the iframe src: ${JSON.stringify(src)}`);
      else if (src.indexOf('embedded=1') > src.indexOf('#')) findings.push(`embedded flag sits after the fragment, so location.search is empty: ${JSON.stringify(src)}`);
      if (src && !src.startsWith(HUB)) findings.push(`iframe points somewhere other than the UI-190 hub ${HUB}: ${src}`);

      /* THE EFFECT, inside the frame — the half neither UI-101 nor its reviewer could check */
      const frames = page.frames().filter((f) => f !== page.mainFrame());
      const roomFrame = frames.find((f) => f.url().includes('/#/')) || frames[0];
      if (!roomFrame) findings.push('no child frame found to inspect');
      else {
        await roomFrame.waitForLoadState('load').catch(() => {});
        await roomFrame.waitForTimeout(800);
        const inner = await roomFrame.evaluate(() => {
          const rail = document.querySelector('.rail');
          return {
            url: location.href,
            search: location.search,
            embeddedFlag: document.body.dataset.embedded ?? null,
            htmlPending: document.documentElement.dataset.embeddedPending ?? null,
            railDisplay: rail ? getComputedStyle(rail).display : '(no .rail)',
            shellColumns: (() => { const s = document.querySelector('.shell'); return s ? getComputedStyle(s).gridTemplateColumns : '(no .shell)'; })(),
            roomMounted: !!document.getElementById('room-root'),
          };
        });
        console.log('[frame] ' + JSON.stringify(inner));
        await page.screenshot({ path: `${OUT}/embedded-end-to-end.png`, fullPage: true });
        if (inner.search !== '?embedded=1') findings.push(`inside the frame location.search is ${JSON.stringify(inner.search)}, not '?embedded=1'`);
        if (inner.embeddedFlag !== 'true') findings.push(`the hub did NOT enter embedded mode: body[data-embedded] is ${JSON.stringify(inner.embeddedFlag)}`);
        if (inner.railDisplay !== 'none') findings.push(`the hub rail is still '${inner.railDisplay}' inside the shell frame - a second rail would be visible`);
        if (!inner.roomMounted) findings.push('the room did not mount inside the frame');
      }
    }
  }
  console.log(findings.length ? `\nFINDINGS (${findings.length}):\n - ${findings.join('\n - ')}` : '\nCLEAN: embedded seam verified END TO END (url AND effect)');
} finally { await browser.close(); }
