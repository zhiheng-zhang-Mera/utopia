/**
 * UXI-301 — the workbook's NAMED real-conditions cases, as separate named results.
 *
 * Step 7 names them: real concurrency, provider unavailable, device busy, remote handoff. The browser
 * E2E covers the surface end to end, but it folds several conditions into one narrative; this drives
 * each NAMED condition separately against a REAL gateway and a REAL reference node, and renders the
 * panel from the REAL feed, so the evidence maps one-to-one onto the workbook's list.
 *
 * Two of the four are NOT driven, and saying so is the point: a case that cannot be honestly induced on
 * this host is recorded with its reason rather than approximated and reported as coverage.
 */
import {spawn} from 'node:child_process';
import {writeFileSync, mkdirSync} from 'node:fs';
import {schedulerPanel} from '../apps/web/scheduler.js';
import {configureRuntime} from '../apps/web/i18n/index.js';

configureRuntime({storage: null, navigator: {language: 'en'}});

const PORT = Number(process.env.CITY_PORT || 4343);
const TOKEN = 'uxi301-cases-control';
const NODE_TOKEN = 'uxi301-cases-node';
const EVIDENCE = `${process.cwd()}/evidence/raw/mission-book/UXI-301`;
const children = [];

const api = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v0/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return {status: res.status, json: JSON.parse(text)}; } catch { return {status: res.status, json: null, text}; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startNode = () => {
  const child = spawn(process.execPath, ['agents/reference-node/main.mjs'], {
    cwd: process.cwd(),
    env: {...process.env, CITY_URL: `http://127.0.0.1:${PORT}`, CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN,
      CITY_DATA: `${process.cwd()}/.runtime`, CITY_WORKSPACE: `${process.cwd()}/.runtime/workspace`},
    stdio: 'ignore', windowsHide: true,
  });
  children.push(child);
  return child;
};
const waitFor = async (label, predicate, tries = 40, every = 500) => {
  for (let i = 0; i < tries; i++) { try { const v = await predicate(); if (v) return v; } catch { /* wait */ } await sleep(every); }
  throw new Error(`timed out waiting for ${label}`);
};

const cases = {};
const results = [];
const check = (id, ok, detail) => { results.push({id, ok, detail}); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ' - ' + detail : ''}`); };
const RAW = /SELECTABLE|DEVICE_UNREACHABLE|DEVICE_REFUSING|DEVICE_DISABLED|AT_CAPACITY|LOAD_UNMEASURED|PRESSURE_PAUSED|FRESHNESS_UNKNOWN|USER_DISABLED|POLICY_EXCLUDED|DEVICE_ONLINE|REMOTE_ONLINE/;

try {
  mkdirSync(EVIDENCE, {recursive: true});
  const gateway = spawn(process.execPath, ['services/dev-gateway/main.mjs'], {
    cwd: process.cwd(),
    env: {...process.env, CITY_HOST: '127.0.0.1', CITY_PORT: String(PORT), CITY_URL: `http://127.0.0.1:${PORT}`,
      CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN, CITY_DATA: `${process.cwd()}/.runtime`, CITY_WORKSPACE: `${process.cwd()}/.runtime/workspace`},
    stdio: 'ignore', windowsHide: true,
  });
  children.push(gateway);
  await waitFor('health', async () => (await api('health')).status === 200);
  const node = startNode();
  // Wait for an ONLINE node, not merely a known one: the store persists across runs and the gateway
  // marks every known node offline at startup, so a present record proves nothing about this run.
  await waitFor('an ONLINE node', async () => ((await api('city')).json?.nodes ?? []).some((n) => n.online === true));
  console.log('gateway + real reference node ready\n');

  /* ---------------------------------------------------- CASE 1: real concurrency */
  console.log('=== CASE 1: real concurrency ===');
  const submitted = await Promise.all([api('tasks', {type: 'CHECKPOINT_DEMO'}), api('tasks', {type: 'CHECKPOINT_DEMO'})]);
  const ids = submitted.map((r) => r.json?.id);
  check('two tasks submitted CONCURRENTLY are both accepted', submitted.every((r) => r.status === 200) && new Set(ids).size === 2, ids.join(', '));
  const feed = await api('presentation');
  const feedIds = (feed.json?.tasks ?? []).map((e) => e.taskId);
  check('the feed carries both in-flight tasks, so the surface sees the real concurrency', ids.every((id) => feedIds.includes(id)), `feed has ${feedIds.length} task(s)`);
  const panel = schedulerPanel(feed.json, {isOnline: true});
  const cards = (panel.match(/class="scheduler-task /g) ?? []).length;
  check('the panel renders one card per in-flight task, not a collapsed summary', cards >= 2, `cards=${cards}`);
  check('concurrent work does not leak raw vocabulary into the panel', !RAW.test(panel));
  cases.concurrency = {taskIds: ids, feedTaskCount: feedIds.length, panelCards: cards, pass: ids.every((id) => feedIds.includes(id)) && cards >= 2};

  /* ------------------------------------------------------- CASE 3: device busy, real */
  // Driven from REAL City state rather than a load burner or a synthetic record: RS-202's session ceiling
  // is 1, and the producer now counts the City's own in-flight tasks per node, so a node already running
  // work is genuinely at capacity for any other task. That is the workbook's named condition, induced
  // honestly - a CPU burner was rejected earlier because it would destabilise the host, and a synthetic
  // node record is the static mock step 7 forbids.
  console.log('\n=== CASE 3: device busy ===');
  const busyFeed = await api('presentation');
  const busyTerms = [...new Set((busyFeed.json?.tasks ?? []).flatMap((e) => (e.dto.providers ?? []).map((p) => p.term)))];
  const atCapacity = busyTerms.includes('AT_CAPACITY');
  const busyPanel = schedulerPanel(busyFeed.json, {isOnline: true});
  const eligibleForRunningOwn = (busyFeed.json?.tasks ?? []).some((e) =>
    e.taskState === 'RUNNING' && (e.dto.providers ?? []).some((p) => p.term === 'SELECTABLE'));
  check('a node already running work reports AT_CAPACITY to other tasks', atCapacity, busyTerms.join(', '));
  check('a RUNNING task is not blocked by its own occupancy, so it still reports as running', eligibleForRunningOwn,
    'a run must not be reported as queued because it occupies the node itself');
  check('the panel states the busy condition in user language', /busy at the moment|congested|paused while|catching up/i.test(busyPanel), busyPanel.slice(0, 160));
  check('the busy condition leaks no raw vocabulary', !RAW.test(busyPanel));
  cases.deviceBusy = {terms: busyTerms, atCapacity, eligibleForRunningOwn, panel: busyPanel.slice(0, 300), driven: true, pass: atCapacity && eligibleForRunningOwn && !RAW.test(busyPanel)};

  /* ------------------------------------------- CASE 2: provider unavailable (device gone) */
  console.log('\n=== CASE 2: provider unavailable ===');
  node.kill();
  await waitFor('the node to go offline', async () => ((await api('city')).json?.nodes ?? []).every((n) => n.online !== true));
  await sleep(1500);
  const starved = await api('presentation');
  const starvedPanel = schedulerPanel(starved.json, {isOnline: true});
  const terms = [...new Set((starved.json?.tasks ?? []).flatMap((e) => (e.dto.providers ?? []).map((p) => p.term)))];
  const structural = terms.filter((t) => ['DEVICE_UNREACHABLE', 'DEVICE_REFUSING', 'DEVICE_DISABLED'].includes(t));
  check('the contract reports a structural DEVICE refusal for the absent executor', structural.length > 0, terms.join(', ') || '(no providers)');
  check('the panel states that refusal in user language', /not available|can't be reached|isn't taking|turned off/i.test(starvedPanel), starvedPanel.slice(0, 150));
  check('and still leaks no raw vocabulary', !RAW.test(starvedPanel));
  cases.providerUnavailable = {terms, structuralTerms: structural, panel: starvedPanel.slice(0, 400), pass: structural.length > 0 && !RAW.test(starvedPanel)};

  /* ------------------------------------------------------------- the two NOT driven */
  cases.remoteHandoff = {
    driven: false,
    reason: 'REMOTE_HANDOFF requires a route stage the City does not produce: the feed calls projectStatus with routeStageRef null because no routing-sequence integration exists on this branch, and a handoff would need two real devices. Recorded as not driven rather than asserted from a fabricated route stage.',
  };
  console.log('\n=== NOT DRIVEN, and why ===');
  console.log('  remote handoff : ' + cases.remoteHandoff.reason);
  console.log('  (device busy is DRIVEN above, not owed)');

  const verdict = results.every((r) => r.ok) ? 'PASS' : 'FAIL';
  writeFileSync(`${EVIDENCE}/named-cases.json`, JSON.stringify({
    at: new Date().toISOString(), verdict, results, cases,
  }, null, 2));
  console.log(`\n=== VERDICT: ${verdict} (${results.filter((r) => r.ok).length}/${results.length}) ===`);
  console.log('evidence written to evidence/raw/mission-book/UXI-301/named-cases.json');
  process.exitCode = verdict === 'PASS' ? 0 : 1;
} catch (error) {
  console.error('FAILED:', error.message);
  writeFileSync(`${EVIDENCE}/named-cases-error.json`, JSON.stringify({verdict: 'ERROR', error: error.message, results, cases}, null, 2));
  process.exitCode = 1;
} finally {
  for (const child of children) { try { child.kill(); } catch { /* gone */ } }
}
