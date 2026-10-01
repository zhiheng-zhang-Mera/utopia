#!/usr/bin/env node
/**
 * UI-000 evidence helper — Android representative-screen capture.
 *
 * Captures one Home screen per visual direction from the temporary
 * CandidateGalleryActivity on a real emulator/device.
 *
 * Why this is a script and not three adb commands: on a software/host-GPU
 * emulator the first Compose frame takes ~20-25 s, the system raises "System UI
 * isn't responding" meanwhile, and `am start` reuses an existing instance unless
 * it is force-stopped. Naive capture therefore produces the splash screen three
 * times, or the same direction three times. This script waits for the real
 * `Displayed …` logcat line and dismisses the blocking system dialog first.
 *
 *   node scripts/ui-000/android-screens.mjs [--out .runtime/evidence/mission-book/UI-000/android-candidates]
 *
 * Writes to the git-ignored raw evidence area (PROCESS_DATA_POLICY.md Layer 1).
 * Evidence tooling for the UI-000 Owner gate; delete with apps/web/candidates/.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = resolve(ROOT, arg('out', '.runtime/evidence/mission-book/UI-000/android-candidates'));
const ADB = process.env.ADB
  || resolve(process.env.ANDROID_HOME ?? '', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const PKG = 'city.utopia.control';
const ACTIVITY = `${PKG}/.ui000.CandidateGalleryActivity`;
const CANDIDATES = ['a', 'b', 'c'];
const DISPLAY_TIMEOUT_MS = 120_000;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...args) => execFileSync(ADB, args, { maxBuffer: 32 * 1024 * 1024 }).toString();
const adbBuffer = (...args) => execFileSync(ADB, args, { maxBuffer: 32 * 1024 * 1024 });

function decode(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Nodes from a uiautomator dump, with decoded text and parsed bounds. */
function uiNodes() {
  adb('shell', 'uiautomator', 'dump', '/data/local/tmp/ui000-ui.xml');
  const xml = adb('shell', 'cat', '/data/local/tmp/ui000-ui.xml');
  return [...xml.matchAll(/<node\b([^>]*?)\/?>/g)].map((m) => {
    const node = {};
    for (const a of m[1].matchAll(/([\w:-]+)=(["'])([\s\S]*?)\2/g)) node[a[1]] = decode(a[3]);
    node.box = (node.bounds?.match(/\d+/g) ?? []).map(Number);
    return node;
  });
}

/** Dismiss a blocking system ANR dialog so it cannot hide the screenshot. */
function clearBlockingDialog() {
  try {
    const target = uiNodes().find((n) => ['Wait', '等待'].includes(n.text) && n.box.length === 4);
    if (!target) return false;
    const [x1, y1, x2, y2] = target.box;
    adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
    return true;
  } catch {
    return false;
  }
}

/** Wait until the launcher reports the activity's first real frame. */
async function waitForDisplayed(since) {
  const deadline = Date.now() + DISPLAY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const log = adb('logcat', '-d', '-t', '400');
    const line = log.split('\n').filter((l) => l.includes('Displayed') && l.includes('CandidateGalleryActivity')).at(-1);
    if (line && (!since || log.indexOf(line) >= 0)) return line.trim();
    await pause(2000);
  }
  throw new Error('CandidateGalleryActivity never reported Displayed');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  /* A busy emulator raises "System UI isn't responding" over the app. Suppress the
     system error dialogs so the captured frame is the product, not a dialog; this
     is an emulator setting, not an app change. */
  try { adb('shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1'); } catch { /* older images */ }
  const results = [];
  for (const id of CANDIDATES) {
    adb('logcat', '-c');
    adb('shell', 'am', 'force-stop', PKG);
    await pause(500);
    adb('shell', 'am', 'start', '-n', ACTIVITY, '--es', 'candidate', id);
    const displayed = await waitForDisplayed(true);
    await pause(2500);
    if (clearBlockingDialog()) await pause(1500);
    const png = adbBuffer('exec-out', 'screencap', '-p');
    const file = resolve(OUT, `candidate-${id}-home.png`);
    await writeFile(file, png);
    const top = adb('shell', 'dumpsys', 'activity', 'activities')
      .split('\n').find((l) => l.includes('topResumedActivity'))?.trim() ?? '';
    results.push({ candidate: id, file: file.replace(ROOT, ''), bytes: png.length, displayed, top });
    console.log(`[android] candidate ${id}: ${png.length} bytes — ${displayed}`);
  }
  await writeFile(resolve(OUT, 'manifest.json'), JSON.stringify({ captured_at: new Date().toISOString(), results }, null, 2));
  console.log('[android] done');
}

main().catch((e) => { console.error(e); process.exit(1); });
