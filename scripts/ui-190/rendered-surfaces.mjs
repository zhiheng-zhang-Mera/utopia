#!/usr/bin/env node
/**
 * UI-190 · rendered cross-surface comparison, Web + Rooms, on the INTEGRATION branch.
 *
 * The source-level token check already proved the three surfaces share the C2 palette; it
 * does NOT prove any surface renders correctly. This captures the two captureable
 * surfaces from this tree and asserts the direction actually reached the pixels' DOM:
 * the Web shell must show the assistant slot with no engineering chrome and no banned
 * glyphs, and the standalone Room Hub must keep its own rail (embedded mode must NOT leak
 * into the standalone path).
 *
 * Android is NOT captured here - it needs a windowed emulator, and that is recorded as
 * not covered rather than implied.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const GATEWAY = process.env.CITY_URL || 'http://127.0.0.1:4310';
const HUB = process.env.CITY_HUB || 'http://127.0.0.1:4320';
const TOKEN = process.env.CITY_TOKEN;
const OUT = '.runtime/evidence/ui-190';
if (!TOKEN) throw new Error('CITY_TOKEN required');
mkdirSync(OUT, { recursive: true });

const launch = async () => { for (const o of [{ channel: 'msedge' }, {}]) { try { return await chromium.launch(o); } catch {} } throw new Error('no browser'); };
const browser = await launch();
const findings = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => findings.push(`web pageerror: ${e.message}`));
  await page.goto(GATEWAY, { waitUntil: 'load' });
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.getByText(/ONLINE|在线/).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(900);

  const web = await page.evaluate(() => {
    const txt = document.body.innerText;
    const cs = getComputedStyle(document.body);
    return {
      assistantSlot: !!document.querySelector('.operator .op-frame'),
      assistantArt: !!document.querySelector('.op-frame svg'),
      bodyBg: cs.backgroundColor,
      accentUsed: !!getComputedStyle(document.documentElement).getPropertyValue('--lime').trim(),
      chrome: /CONTROL SURFACE|WORKSPACE \/ ALIEN|Reference implementation|控制面板/.test(txt),
      glyph: /[◈▦◇≋◉▤≣⊞⚙▣]/.test(txt),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  console.log('[web] ' + JSON.stringify(web));
  if (!web.assistantSlot) findings.push('web home did not render the assistant slot (.operator .op-frame)');
  if (!web.assistantArt) findings.push('web assistant slot rendered without its portrait svg');
  if (web.chrome) findings.push('web default path still shows engineering chrome');
  if (web.glyph) findings.push('web default path renders a banned glyph');
  if (web.overflow > 1) findings.push(`web horizontal overflow ${web.overflow}px`);
  await page.screenshot({ path: `${OUT}/web-home.png`, fullPage: true });

  /* Rooms, STANDALONE: the embedded treatment must not leak here */
  const hub = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  hub.on('pageerror', (e) => findings.push(`hub pageerror: ${e.message}`));
  await hub.goto(`${HUB}/#/knowledge`, { waitUntil: 'networkidle' });
  await hub.waitForTimeout(700);
  const rooms = await hub.evaluate(() => {
    const rail = document.querySelector('.rail');
    return {
      embeddedFlag: document.body.dataset.embedded ?? null,
      railDisplay: rail ? getComputedStyle(rail).display : '(no .rail)',
      roomMounted: !!document.getElementById('room-root'),
      controls: document.querySelectorAll('#room-root button, #room-root input, #room-root select, #room-root textarea').length,
    };
  });
  console.log('[rooms standalone] ' + JSON.stringify(rooms));
  if (rooms.embeddedFlag === 'true') findings.push('the standalone hub is in embedded mode - the flag leaked outside the frame');
  if (rooms.railDisplay === 'none') findings.push('the standalone hub hid its rail - embedded styling leaked into the standalone path');
  if (!rooms.roomMounted) findings.push('the standalone hub did not mount the room');
  if (rooms.controls === 0) findings.push('the standalone hub mounted no interactive controls');
  await hub.screenshot({ path: `${OUT}/rooms-standalone.png`, fullPage: true });

  console.log('\nAndroid: NOT captured on this branch (needs a windowed emulator) - recorded as not covered, not as passed.');
  console.log(findings.length ? `\nFINDINGS (${findings.length}):\n - ${findings.join('\n - ')}` : '\nCLEAN: rendered Web + Rooms carry the direction and the embedded flag did not leak');
} finally { await browser.close(); }
