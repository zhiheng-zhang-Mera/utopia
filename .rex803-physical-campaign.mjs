// REX-803 physical campaign driver (Mech host).
//
// Runs ONE controlled campaign against the LIVE City on this host, using the campaign surface that this branch adds.
// It never fabricates a result: every number it writes comes from the City's own /api/v0/research/campaigns, and the
// canonical tasks the campaign measured are read back from /api/v0/city.
//
// Usage (from the utopia worktree so that playwright resolves):
//   node .rex803-physical-campaign.mjs [--port 4391] [--bind 172.31.12.151] [--repetitions 3] [--warmup 1]
//                                      [--out D:/utopia-chat/evidence/REX-803]
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith('--') ? [[value.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]] : []));
const hostConfig = 'C:/ProgramData/Utopia/host/city/local-config.json';
const config = JSON.parse(readFileSync(hostConfig, 'utf8'));
const base = `http://${args.bind ?? '172.31.12.151'}:${args.port ?? 4391}`;
const outDir = resolve(args.out ?? 'D:/utopia-chat/evidence/REX-803');
const repetitions = Number(args.repetitions ?? 3);
const warmup = Number(args.warmup ?? 1);
mkdirSync(outDir, {recursive: true});

const headers = {Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const ask = async (path, body) => {
  const response = await fetch(base + '/api/v0/' + path, {method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined});
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = {raw: text.slice(0, 500)}; }
  if (!response.ok) throw Object.assign(new Error(`${path} -> ${response.status}`), {status: response.status, body: parsed});
  return parsed;
};
const write = (name, value) => { writeFileSync(resolve(outDir, name), JSON.stringify(value, null, 2)); return name; };
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// 1. Pre-state, measured rather than assumed.
const health = await ask('health');
const before = await ask('city');
log('city', before.cityId, 'health', health.status);
log('nodes', before.nodes.map(node => `${node.id}:${node.online}`).join(' '));
log('surfaces', before.controlSurfaces.map(surface => `${surface.clientRef}:${surface.clientLabel}`).join(' '));
write('physical-pre-state.json', {observedAt: new Date().toISOString(), endpoint: base, health: health.status, cityId: before.cityId, nodes: before.nodes.map(node => ({id: node.id, online: node.online, sharingEnabled: node.sharingEnabled ?? null, lastHeartbeatAt: node.lastHeartbeatAt ?? null, capabilities: node.capabilities})), controlSurfaces: before.controlSurfaces, members: before.members, tasksBefore: before.tasks.length});

// 2. The campaign surface must exist; if it does not, the City is not running this head and the driver says so.
const listing = await ask('research/campaigns');
const workers = listing.topology.workers;
const surfaces = listing.topology.surfaces;
log('live workers', JSON.stringify(workers), 'live surfaces', JSON.stringify(surfaces));
write('physical-live-topology.json', {observedAt: new Date().toISOString(), workers, surfaces, scenarios: listing.scenarios, registeredExperiments: listing.experiments.map(experiment => experiment.experimentId)});
if (workers.length === 0) throw new Error('no live worker node in this City: a campaign could only run unplaced work');
if (surfaces.length === 0) throw new Error('no live control surface: the topology gate would refuse every campaign');

// 3. The experiment THIS City can actually run, declared against the identities it actually reports.
const worker = args.worker ?? workers[0];
const surface = args.surface ?? surfaces[0].ref;
const experimentId = args.experiment ?? 'mech-android-canonical-repetition';
const manifest = {
  experimentId,
  question: 'Does a canonical City task repeat with a reproducible seed, and is every repetition either measured or explained?',
  hypothesis: 'A derived seed per repetition makes the repetition set reproducible on the same declared topology.',
  topology: 'SINGLE_CITY',
  hosts: [worker], workers: [worker], controlSurfaces: [surface],
  variables: {independent: ['scenario'], dependent: ['completion'], controls: ['taskType']},
  repetitions,
  seedPolicy: 'PER_REPETITION',
  baseSeed: 20261006,
  requiredCapabilities: ['research.evidence.review'],
  stopConditions: [{kind: 'MAX_REPETITIONS', value: repetitions}, {kind: 'MAX_FAILURES', value: repetitions}],
  artifactPolicy: {retention: 'SUMMARY_ONLY'},
  acceptance: {primary: 'Every repetition is either a measured completion of a real canonical task or carries a typed reason it is not', minimumSuccessfulRuns: 1},
  softwareRefs: ['utopia@' + (args.sha ?? '85a79eca4fe0f4ad8882148725249e016434873e')],
};
const registered = await ask('research/experiments', {manifest});
log('experiment', registered.experimentId, 'status', registered.status, 'digest', registered.digest);
write('physical-experiment.json', {registeredAt: new Date().toISOString(), endpoint: base, experimentId: registered.experimentId, digest: registered.digest, status: registered.status, manifest: registered.manifest});

// 4. Start the campaign and watch it with the City's own progress view.
const beforeTaskIds = new Set(before.tasks.map(task => task.id));
const started = await ask('research/campaigns', {experimentId, scenarioId: args.scenario ?? 'WAIT', repetitions, warmup});
log('started', started.started.campaignId, 'totalRuns', started.started.totalRuns, 'seed', started.started.campaignSeed);
const campaignId = started.started.campaignId;
const progressPath = [started.progress];
const deadline = Date.now() + Number(args.deadlineMs ?? 300000);
let live = started.progress;
while (!['COMPLETED', 'STOPPED', 'REFUSED', 'FAILED', 'INTERRUPTED'].includes(live.state) && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 1000));
  live = (await ask('research/campaigns')).live;
  progressPath.push(live);
  log('progress', live.state, JSON.stringify(live.totals), live.reason ?? '');
}
write('physical-campaign-progress.json', {observedAt: new Date().toISOString(), campaignId, samples: progressPath.length, final: live});
log('final', live.state, live.reason ?? '', JSON.stringify(live.summary));

// 5. The canonical tasks the campaign created, read back from the City (not from the runner's word).
const after = await ask('city');
const campaignTasks = after.tasks.filter(task => typeof task.researchRunRef === 'string' && task.researchRunRef.startsWith(campaignId));
write('physical-canonical-tasks.json', {observedAt: new Date().toISOString(), campaignId, cityTasks: campaignTasks.map(task => ({id: task.id, type: task.type, state: task.state, researchRunRef: task.researchRunRef, assignedNodeId: task.assignedNodeId ?? null, progress: task.progress, createdAt: task.createdAt, updatedAt: task.updatedAt})), tasksCreatedByThisCampaign: after.tasks.filter(task => !beforeTaskIds.has(task.id)).length});

// 6. The research trace rows this campaign produced.
const trace = (await ask('research/trace')).trace;
const receipts = trace.records.filter(record => record.type === 'RESEARCH_RUN_RECEIPT' && record.dimensions?.experimentRunRef?.startsWith(campaignId));
write('physical-run-receipts.json', {observedAt: new Date().toISOString(), campaignId, receipts, traceCompleteness: trace.completeness, traceStorageState: trace.storageState, traceRunId: trace.runId, traceRecordedTypes: trace.recordedTypes});

// 7. The filed receipt, as the City answers it.
const filed = await ask('research/campaigns/' + campaignId);
write('physical-campaign-receipt.json', {observedAt: new Date().toISOString(), campaign: filed.campaign});

// 8. The owner's own surface, screenshotted against the live City.
const browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
try {
  const page = await browser.newPage({locale: 'en-US', viewport: {width: 1440, height: 1100}});
  page.setDefaultTimeout(20000);
  await page.goto(`${base}/#token=${encodeURIComponent(config.token)}`);
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="ResearchCampaign"]').click();
  await page.locator('#research-campaign[data-loaded="true"]').waitFor();
  await page.waitForFunction(id => document.querySelector('#rc-status')?.textContent.includes(id) || document.querySelector('#rc-receipts')?.textContent.includes(id), campaignId).catch(() => {});
  await page.screenshot({path: resolve(outDir, 'physical-campaign-live-surface.png'), fullPage: true});
  const statusText = await page.locator('#rc-status').innerText();
  const totalsText = await page.locator('#rc-totals').innerText().catch(() => '');
  const excludedText = await page.locator('#rc-excluded').innerText().catch(() => '');
  log('ui', statusText, '|', totalsText);
  write('physical-surface-observation.json', {observedAt: new Date().toISOString(), endpoint: base, campaignId, statusText, totalsText, excludedText, pageText: (await page.locator('#research-campaign').innerText()).slice(0, 4000)});
} finally {
  await browser.close();
}

log('evidence written to', outDir);
