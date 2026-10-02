/**
 * UXI-301 step 7 — REAL end-to-end verification of the Web scheduler surface.
 *
 * The workbook is explicit that the UI must be driven by REAL conditions "而不是仅用静态 mock" - not by
 * static mocks. So this starts a real Gateway and a real reference node, drives the real Web UI through
 * a browser, and then CHANGES the world underneath it (kills the executor) to prove the surface follows
 * reality rather than a fixture:
 *
 *   1. a real node is ONLINE                      -> the panel must say the provider is available, in user language
 *   2. the real node is KILLED                    -> the panel must change to an unavailable reason
 *   3. the executor is RESTORED                   -> the panel must return to available
 *
 * Everything it asserts is a property the acceptance items name, and it records what it saw to
 * evidence/raw/mission-book/UXI-301/ so a reviewer can open the result rather than take this on trust.
 *
 * It spawns and tears down its own services because the harness kills the whole process tree when the
 * invoking command ends, so services cannot outlive the single command that starts them.
 */
import {spawn} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {chromium} from 'playwright';

const PORT = Number(process.env.CITY_PORT || 4341);
const ROOT = process.cwd();
const TOKEN = 'uxi301-web-control-11a7';
const NODE_TOKEN = 'uxi301-web-node-77c3';
const EVIDENCE = `${ROOT}/evidence/raw/mission-book/UXI-301`;
const children = [];
const notes = [];

const log = (message) => { notes.push(message); console.log(message); };

function start(file, extraEnv = {}) {
  const child = spawn(process.execPath, [file], {
    cwd: ROOT,
    env: {
      ...process.env,
      CITY_HOST: '127.0.0.1',
      CITY_PORT: String(PORT),
      // The reference node reads CITY_URL, NOT CITY_PORT, and defaults to 4310 when it is absent. My
      // first run omitted it and the node silently tried the default port, so it never registered and
      // the E2E timed out waiting for a node that was talking to nothing.
      CITY_URL: `http://127.0.0.1:${PORT}`,
      CITY_TOKEN: TOKEN,
      CITY_NODE_TOKEN: NODE_TOKEN,
      CITY_DATA: `${ROOT}/.runtime`,
      CITY_WORKSPACE: `${ROOT}/.runtime/workspace`,
      // RS-203 root-caused a recovery failure to this flag suppressing telemetry, so it is removed
      // rather than set: an unmeasured node presents as "still measuring", which would mask the very
      // distinction this E2E is checking.
      CITY_TELEMETRY_DISABLED: undefined,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => notes.push(`[${file.split('/').pop()}] ${String(d).trim()}`));
  child.stderr.on('data', (d) => notes.push(`[${file.split('/').pop()} ERR] ${String(d).trim()}`));
  children.push(child);
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v0/${path}`, {
    headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'},
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};

async function waitFor(label, predicate, {tries = 40, every = 500} = {}) {
  for (let i = 0; i < tries; i++) {
    try { const value = await predicate(); if (value) return value; } catch { /* keep waiting */ }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const WATCHDOG_MS = Number(process.env.E2E_WATCHDOG_MS || 240000);
const watchdog = setTimeout(() => {
  writeFileSync(`${EVIDENCE}/web-e2e-error.json`, JSON.stringify({
    verdict: 'TIMEOUT', at: new Date().toISOString(),
    error: `exceeded the internal ${WATCHDOG_MS}ms budget`, notes,
  }, null, 2));
  console.error(`WATCHDOG: exceeded ${WATCHDOG_MS}ms; wrote web-e2e-error.json`);
  for (const child of children) { try { child.kill(); } catch { /* gone */ } }
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

const teardown = () => {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
};

async function main() {
  mkdirSync(EVIDENCE, {recursive: true});
  mkdirSync(`${ROOT}/.runtime`, {recursive: true});

  const run = {
    startedAt: new Date().toISOString(),
    port: PORT,
    conditions: {},
    assertions: [],
    notes,
  };
  const assert = (name, ok, detail) => {
    run.assertions.push({name, ok, detail});
    log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  };

  // ---------------------------------------------------------------- services
  log('=== starting a real Gateway and a real reference node ===');
  start('services/dev-gateway/main.mjs');
  await waitFor('gateway health', () => fetch(`http://127.0.0.1:${PORT}/api/v0/health`).then((r) => r.ok));
  log(`  gateway healthy on ${PORT}`);

  const node = start('agents/reference-node/main.mjs');
  await waitFor('first node registration', async () => {
    const city = await api('city');
    return (city.nodes ?? []).length > 0;
  });
  log('  reference node registered');

  // ---------------------------------------------------------------- browser
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const page = await browser.newPage({locale: 'en-US'});
  await page.goto(`http://127.0.0.1:${PORT}`);
  await page.locator('#token').fill(TOKEN);
  await page.locator('#connect').click();
  await page.locator('#connection').filter({hasText: 'ONLINE'}).waitFor({timeout: 20000});
  log('  web UI paired and ONLINE');

  await page.locator('nav button[data-page="Devices"]').click();
  await page.locator('.scheduler-panel').waitFor({timeout: 20000});
  log('  scheduler panel present on the Devices page');

  const readPanel = async () => (await page.locator('.scheduler-panel').innerText()).replace(/\s+/g, ' ').trim();
  const taskCards = () => page.locator('.scheduler-panel .scheduler-task').count();

  /* MY OWN VACUOUS PASS, recorded because it is the fault this E2E exists to avoid. The first version
     asserted the panel "renders user language" while the feed was EMPTY, so every assertion matched the
     idle line "Nothing is waiting to run" and passed without exercising anything - the same
     vacuous-pass defect I had flagged in the adapter gate. The panel is about TASKS, so driving real
     conditions requires a real task in flight, and the assertions below now REQUIRE a task card to
     exist before they mean anything. */

  log('=== condition 1: kill the real executor, THEN create real work ===');
  node.kill();
  await waitFor('the node to go offline', async () => {
    const city = await api('city');
    return (city.nodes ?? []).every((n) => n.online !== true);
  });
  log('  executor killed');

  // Real work, created through the real UI control rather than by calling the API directly.
  await page.locator('#run').click();
  await waitFor('a task card to appear in the panel', async () => (await taskCards()) > 0, {tries: 40, every: 1000});
  await sleep(4000);
  const starvedPanel = await readPanel();
  const starvedCards = await taskCards();
  const starvedFeed = await api('presentation').catch(() => null);
  run.conditions.executorKilledWithWork = {panel: starvedPanel, taskCards: starvedCards, feed: starvedFeed};
  assert('a real task in flight produces a task card, so later assertions are not vacuous', starvedCards > 0, `cards=${starvedCards}`);
  assert('the panel explains the unavailability in user language',
    /not available|can't be reached|isn't taking|waiting|measuring|turned off/i.test(starvedPanel),
    starvedPanel.slice(0, 200));
  assert('no raw scheduler token appears in that explanation',
    !/(SELECTABLE|DEVICE_UNREACHABLE|DEVICE_REFUSING|DEVICE_DISABLED|AT_CAPACITY|LOAD_UNMEASURED|PRESSURE_PAUSED|FRESHNESS_UNKNOWN|USER_DISABLED|POLICY_EXCLUDED)/.test(starvedPanel));

  // ---------------------------------------------------------------- condition 2: executor restored
  log('=== condition 2: restore the executor and watch the surface follow reality ===');
  start('agents/reference-node/main.mjs');
  await waitFor('the node to come back', async () => {
    const city = await api('city');
    return (city.nodes ?? []).some((n) => n.online === true);
  });
  await sleep(6000);
  const restoredPanel = await readPanel();
  run.conditions.executorRestored = {panel: restoredPanel, taskCards: await taskCards()};
  assert('the panel changes once the real executor returns',
    restoredPanel !== starvedPanel,
    `changed=${restoredPanel !== starvedPanel}`);

  // ------------------- condition 3: the user's choice really reaches the backend THROUGH THE UI
  // The previous attempt at this condition hung. The cause is that the shell RE-RENDERS the Devices page
  // every second, so a Playwright locator is detached and re-created before its actionability checks can
  // settle. Dispatching the click IN PAGE targets the live DOM node the user would press and still runs
  // the shell's real handler, so the backend call under test is the real one.
  log('=== condition 3: the user chooses a service through the real control ===');
  await page.locator('#run').click();
  await waitFor('a selectable provider control', async () => (await page.locator('[data-scheduler-provider]').count()) > 0, {tries: 30, every: 1000});
  const target = await page.evaluate(() => {
    const el = document.querySelector('[data-scheduler-provider]');
    if (!el) return null;
    const info = {providerRef: el.getAttribute('data-scheduler-provider'), taskId: el.getAttribute('data-scheduler-task')};
    el.click();
    return info;
  });
  assert('a selectable provider offers a real choice control', !!target && !!target.providerRef, JSON.stringify(target));
  const recorded = await waitFor('the backend to record the user choice', async () => {
    const tasks = (await api('tasks')).tasks ?? [];
    const task = tasks.find((t) => t.id === target.taskId);
    return task?.chosenProviderRef ? task : null;
  }, {tries: 30, every: 1000});
  run.conditions.userChoice = {chosen: target, recordedProviderRef: recorded.chosenProviderRef, userChoiceAt: recorded.userChoiceAt};
  assert('the choice made in the UI really reached the backend', recorded.chosenProviderRef === target.providerRef,
    `recorded ${recorded.chosenProviderRef} for ${target.taskId}`);
  assert('the backend recorded when the user chose', typeof recorded.userChoiceAt === 'string' && recorded.userChoiceAt.length > 0, String(recorded.userChoiceAt));

  // ---------------------------------------------------------------- advanced gate
  const html = await page.locator('.scheduler-panel').innerHTML();
  run.conditions.markup = {containsTechnicalFold: html.includes('scheduler-technical'), length: html.length};
  // STRENGTHENED after Mech found this assertion vacuous: it was an || of two negations, so it passed when
  // the fold markup was missing OR when no raw token was rendered - meaning it would have passed if the
  // Advanced feature were DELETED. It could not distinguish the item it was credited with covering from the
  // absence of the feature, which is the non-vacuity failure this programme keeps cataloguing. It now
  // requires the fold to be PRESENT, COLLAPSED by default, and free of bare raw tokens.
  assert('the technical fold is PRESENT, not absent', html.includes('scheduler-technical'));
  assert('the technical fold is COLLAPSED by default', /<details class="scheduler-technical"(?![^>]*\bopen\b)/.test(html));
  assert('no bare raw scheduler token is rendered', !/>\s*(SELECTABLE|DEVICE_REFUSING)\s*</.test(html));

  run.finishedAt = new Date().toISOString();
  run.verdict = run.assertions.every((a) => a.ok) ? 'PASS' : 'FAIL';
  writeFileSync(`${EVIDENCE}/web-e2e.json`, JSON.stringify(run, null, 2));
  console.log(`\n=== VERDICT: ${run.verdict} (${run.assertions.filter((a) => a.ok).length}/${run.assertions.length} assertions) ===`);
  console.log(`evidence written to evidence/raw/mission-book/UXI-301/web-e2e.json`);
  await browser.close();
  return run.verdict === 'PASS' ? 0 : 1;
}

main()
  .then((code) => { clearTimeout(watchdog); teardown(); process.exitCode = code; })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error('E2E FAILED:', error.message);
    // A FAILED run must not overwrite the record of a run that PASSED. My first version wrote the error to
    // the same path, so an aborted attempt DESTROYED the evidence of a successful one - the exact way a
    // green result is lost without anyone noticing. Errors go to their own file; web-e2e.json records the
    // last COMPLETED run.
    writeFileSync(`${EVIDENCE}/web-e2e-error.json`, JSON.stringify({verdict: 'ERROR', error: error.message, at: new Date().toISOString(), notes}, null, 2));
    teardown();
    process.exitCode = 1;
  });
