// REX-890 — the DEVELOPMENT-HOST study.
//
// This is the first half of REX-890: run a representative multi-device study on the Research Fabric. It runs against
// the RESIDENT City (not a temp one) precisely so that "multi-device execution" means two REAL machines running REAL
// agents, not two workers this script answers on their behalf.
//
// The eight elements the workbook names, in the order they are produced here:
//   multi-device execution · repetitions · one injected fault · recovery · one replay · one ablation · artifact export
//   (and the eighth, handoff-or-routing, is the placement decision - v1 has no handoff scenario, which is recorded,
//    not hidden)
//
// Everything is read back from the City. Nothing is asserted from the script's own belief about what happened.
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import WebSocket from 'ws';

const CITY = process.env.REX890_CITY ?? 'http://172.31.12.151:4310';
const OUT = process.env.REX890_OUT ?? 'D:/utopia-chat/4in1-acceptance-2026-10-07/rex890-dev-study';
const CHECKOUT = process.env.REX890_CHECKOUT ?? 'D:/utopia-remote-op';
const REPETITIONS = Number(process.env.REX890_REPETITIONS ?? 6);
const token = JSON.parse(readFileSync('C:/ProgramData/Utopia/host/city/local-config.json', 'utf8')).token;
const nodeToken = process.env.CITY_NODE_TOKEN ?? JSON.parse(readFileSync('C:/ProgramData/Utopia/host/city/local-config.json', 'utf8')).nodeToken;
const H = c => ({Authorization: 'Bearer ' + c, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => { results.push({name, ok: ok === true, detail: String(detail ?? '')}); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail ?? ''}`); };
const phase = t => console.log(`\n--- ${t} ---`);

const ask = async (path, {body, credential = token, method} = {}) => {
  const response = await fetch(`${CITY}/api/v0/${path}`, {method: method ?? (body ? 'POST' : 'GET'), headers: H(credential), body: body ? JSON.stringify(body) : undefined});
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* kept as text */ }
  return {status: response.status, body: json, text};
};
const runChild = (args, timeoutMs = 120000) => new Promise(resolveRun => {
  const child = spawn(process.execPath, args, {cwd: CHECKOUT, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.on('close', code => { clearTimeout(timer); resolveRun({status: code, stdout, stderr}); });
});

await mkdir(resolve(OUT), {recursive: true});
const log = (...a) => console.log(...a);

let socket = null;
const campaignIds = [];
try {
  phase('0 the study runs against the resident City, with the real agents');
  const city = await ask('city');
  const nodes = city.body?.nodes ?? [];
  const devices = nodes.filter(n => n.online === true).map(n => n.id);
  record('the resident City answers and has two online devices', city.status === 200 && devices.length >= 2, `city=${String(city.body?.cityId).slice(0, 8)} devices=${devices.join(', ')}`);

  socket = new WebSocket(`${CITY.replace('http', 'ws')}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=rex890-dev-surface&clientLabel=REX-890%20development%20surface`, ['city-token.' + Buffer.from(token).toString('base64url')]);
  await new Promise((yes, no) => { socket.on('open', yes); socket.on('error', no); });
  record('a real control surface is attached to this City', true, 'rex890-dev-surface');

  phase('1 register the experiment (REX-801 manifest)');
  const manifest = {
    experimentId: 'rex890-dev-multi-device-' + new Date().toISOString().slice(0, 10),
    question: 'Can the Research Fabric produce a reproducible multi-device artifact with a real injected fault?',
    topology: 'TWO_HOST_MESH', hosts: devices, workers: devices, controlSurfaces: ['rex890-dev-surface'],
    variables: {independent: ['scenario'], dependent: ['completion'], controls: ['taskType']},
    repetitions: REPETITIONS, seedPolicy: 'PER_REPETITION', baseSeed: 20261007,
    requiredCapabilities: ['research.evidence.review'],
    stopConditions: [{kind: 'MAX_REPETITIONS', value: REPETITIONS}, {kind: 'MAX_FAILURES', value: REPETITIONS}],
    artifactPolicy: {retention: 'SUMMARY_ONLY'},
    acceptance: {primary: 'Every repetition is a canonical task that reached a terminal state, on the device the placement chose'},
    softwareRefs: ['utopia@185d043e11ae8516a1e7a492d09d031610be576b'],
  };
  const registered = await ask('research/experiments', {body: {manifest}});
  record('the experiment registers', registered.status === 200, `HTTP ${registered.status} ${JSON.stringify(registered.body ?? registered.text).slice(0, 140)}`);
  if (registered.status !== 200) throw new Error('experiment refused');

  phase('2 a campaign of real repetitions, executed by the real agents');
  const started = await ask('research/campaigns', {body: {experimentId: manifest.experimentId, scenarioId: 'WAIT'}});
  record('the campaign starts', started.status === 200, `HTTP ${started.status} ${JSON.stringify(started.body?.started ?? started.body?.live ?? started.body ?? started.text).slice(0, 160)}`);
  if (started.status !== 200) throw new Error('campaign refused');
  // The start response nests the new campaign under `started`; the list response nests the running one under `live`.
  // Reading the wrong one yields `undefined`, which is exactly how the first run of this study produced a
  // REPLAY_SOURCE_INVALID that looked like a product refusal but was the script's own field error.
  const campaignId = started.body?.started?.campaignId ?? started.body?.live?.campaignId ?? null;
  if (!campaignId) throw new Error('the City started a campaign but named no id');
  campaignIds.push(campaignId);

  const terminal = ['COMPLETED', 'STOPPED', 'REFUSED', 'FAILED', 'INTERRUPTED'];
  let live = started.body?.live ?? null, lastState = null;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline && !(live && terminal.includes(live.state))) {
    if (live?.state !== lastState) { log(`   campaign ${live?.state ?? 'n/a'} runs=${live?.totalRuns ?? '?'}`); lastState = live?.state; }
    await sleep(1500);
    live = (await ask('research/campaigns')).body?.live ?? live;
  }
  record('the campaign settles without this script driving the workers', Boolean(live) && terminal.includes(live.state), `state=${live?.state} runs=${live?.totalRuns ?? '?'} measured=${live?.summary?.measured ?? '?'}`);

  const receipts = (await ask('research/campaigns')).body?.receipts ?? [];
  record('the City holds a receipt for the campaign', receipts.some(r => r.campaignId === campaignId), `receipts=${receipts.length}`);
  // The runs and their device assignment live on the campaign DETAIL; the list carries only a summary. Multi-device
  // execution is then a measurement of who really executed, not an inference from the topology that was declared.
  const detail = (await ask(`research/campaigns/${campaignId}`)).body?.campaign ?? null;
  const runs = detail?.runs ?? [];
  const devicesThatRan = [...new Set(runs.map(r => r.result?.assignedNodeId).filter(Boolean))];
  record('MULTI-DEVICE: the repetitions really ran on more than one machine', devicesThatRan.length >= 2, `devices that executed: ${devicesThatRan.join(', ') || 'none'} of ${devices.join(', ')}`);
  record('REPETITIONS: every planned repetition is accounted for', runs.length === REPETITIONS, `runs=${runs.length}/${REPETITIONS} measured=${runs.filter(r => r.measured).length}`);
  record('ROUTING: the placement decision chose the executing device for each repetition', runs.every(r => Boolean(r.result?.assignedNodeId)), `assignments=${runs.map(r => String(r.result?.assignedNodeId ?? '?').slice(0, 12)).join(',')}`);

  phase('3 one injected fault, targeting, and observable recovery');
  const faultTarget = devices.find(d => d !== runs[0]?.result?.assignedNodeId) ?? devices[1] ?? devices[0];
  const kind = 'PROVIDER_UNAVAILABLE';
  const inject = await ask('research/faults', {body: {kind, nodeId: faultTarget, durationMs: 12000, confirmation: `FAULT:${kind}:${faultTarget}`}});
  const fault = inject.body?.fault;
  record('a real fault is injected into this City', inject.status === 200 && Boolean(fault?.faultId), `HTTP ${inject.status} ${fault?.faultId ?? inject.text.slice(0, 80)}`);
  const faultedClaim = {status: 0}, otherClaim = {status: 0};
  if (fault) {
    // The fault must refuse the FAULTED node and leave the other alone. This check asks for work on behalf of the
    // real agents, so it MUST NOT run while any task is queued - that would steal a repetition from the agent that
    // owns it. The campaign has settled by now; the guard makes that a measurement rather than an assumption.
    const queued = ((await ask('tasks')).body?.tasks ?? []).filter(t => t.state === 'QUEUED').length;
    if (queued === 0) {
      const a = await ask('node/claim', {credential: nodeToken, body: {id: faultTarget}});
      const b = await ask('node/claim', {credential: nodeToken, body: {id: devices.find(d => d !== faultTarget)}});
      record('the fault is TARGETED: only the faulted device is refused', a.status === 503 && b.status === 200, `faulted=HTTP ${a.status} other=HTTP ${b.status}`);
    } else {
      record('the fault targeting check is NOT_RUN to avoid stealing queued work', false, `queued tasks present: ${queued}`);
    }
    // Detection needs the device to be observed offline, which needs the fault to outlive the heartbeat timeout.
    log('   waiting for the City to observe the faulted device (detection is a measurement, not a guess)');
    await sleep(14000);
    const stopped = await ask(`research/faults/${fault.faultId}/stop`, {body: {}});
    await sleep(4000);
    const detail = await ask(`research/faults/${fault.faultId}`);
    const metrics = detail.body?.fault?.metrics;
    record('RECOVERY is observable: the faulted device can take work again after the stop',
      stopped.status === 200 && metrics?.recoveryTimeMs != null,
      `stop=HTTP ${stopped.status} recovery=${metrics?.recoveryTimeMs ?? 'null'}`);
    record('the fault receipt records what was observed, and leaves the unmeasured typed',
      detail.status === 200 && Boolean(metrics),
      `status=${detail.body?.fault?.status} injected=${metrics?.injectedFailureCount} detection=${metrics?.detectionTimeMs ?? 'null'} recovery=${metrics?.recoveryTimeMs ?? 'null'}`);
  }

  phase('4 replay and ablation (REX-805)');
  // A replay is only accepted while the recorded topology is live, so the control surface stays attached throughout -
  // and the ablation may only start once the replay has finished, because the City refuses a second campaign while
  // one is running (REPLAY_BUSY). Both facts were measured on this City, not assumed.
  const settle = async id => {
    const until = Date.now() + 180000;
    for (;;) {
      const row = (await ask(`research/campaigns/${id}`)).body?.campaign ?? null;
      if (row && terminal.includes(row.state)) return row;
      if (Date.now() > until) return row ?? null;
      await sleep(1500);
    }
  };
  const sourceRunIndex = Math.max(0, runs.findIndex(r => r.measured === true));
  const replay = await ask('research/replays', {body: {sourceCampaignId: campaignId, sourceRunIndex, mode: 'REPLAY'}});
  const replayId = replay.body?.started?.campaignId ?? null;
  record('REPLAY of a recorded run is accepted', replay.status === 200 && Boolean(replayId), `HTTP ${replay.status} ${JSON.stringify(replay.body?.started?.campaignId ?? replay.body ?? replay.text).slice(0, 150)}`);
  if (replayId) campaignIds.push(replayId);
  const replayReceipt = replayId ? await settle(replayId) : null;
  const replayRuns = replayReceipt?.runs ?? [];
  record('the replay reaches a terminal state on a real device', Boolean(replayReceipt) && terminal.includes(replayReceipt.state), `state=${replayReceipt?.state ?? 'n/a'} runs=${replayRuns.length} on=${[...new Set(replayRuns.map(r => r.result?.assignedNodeId))].join(',') || 'none'}`);

  const ablation = await ask('research/replays', {body: {sourceCampaignId: campaignId, sourceRunIndex, mode: 'ABLATION', disabledMechanisms: ['alternate-device']}});
  const ablationId = ablation.body?.started?.campaignId ?? null;
  record('ABLATION with one mechanism disabled is accepted', ablation.status === 200 && Boolean(ablationId), `HTTP ${ablation.status} ${JSON.stringify(ablation.body?.started?.campaignId ?? ablation.body ?? ablation.text).slice(0, 150)}`);
  if (ablationId) campaignIds.push(ablationId);
  const ablationReceipt = ablationId ? await settle(ablationId) : null;
  const ablationRuns = ablationReceipt?.runs ?? [];
  record('the ablation reaches a terminal state on a real device', Boolean(ablationReceipt) && terminal.includes(ablationReceipt.state), `state=${ablationReceipt?.state ?? 'n/a'} runs=${ablationRuns.length} on=${[...new Set(ablationRuns.map(r => r.result?.assignedNodeId))].join(',') || 'none'}`);
  // The ablation disables alternate-device, so its assignment must differ from the source run's: a difference that is
  // the POINT of the ablation, and is only meaningful if it is read from the receipts rather than asserted.
  const sourceDevice = runs[sourceRunIndex]?.result?.assignedNodeId ?? null;
  record('ABLATION: disabling alternate-device changed the placement the source run used', ablationRuns.length > 0 && sourceDevice !== null && ablationRuns[0].result?.assignedNodeId !== sourceDevice, `source=${String(sourceDevice).slice(0, 12)} ablation=${String(ablationRuns[0]?.result?.assignedNodeId).slice(0, 12)}`);

  phase('5 artifact export with the real CLI, then the independent verifier');
  const configPath = resolve(OUT, 'study-config.json');
  await writeFile(configPath, JSON.stringify({token}), 'utf8');
  const artifactDir = resolve(OUT, 'artifact');
  const exported = await runChild(['scripts/export-research-artifact.mjs', '--city', CITY, '--out', artifactDir, '--config', configPath], 180000);
  log('   export exit ' + exported.status);
  if (exported.stdout) log(exported.stdout.trim().split('\n').slice(0, 6).map(l => '     ' + l).join('\n'));
  if (exported.stderr) log('     stderr: ' + exported.stderr.trim().split('\n').slice(0, 3).join(' | '));
  record('the real exporter CLI produces a package from the resident City', exported.status === 0, `exit=${exported.status}`);
  if (exported.status === 0) {
    const verified = await runChild(['scripts/verify-research-artifact.mjs', artifactDir], 120000);
    const tail = (verified.stdout ?? '').trim().split('\n');
    log(tail.slice(-3).map(l => '     ' + l).join('\n'));
    record('the independent verifier accepts the produced package', verified.status === 0, `exit=${verified.status} ${tail[tail.length - 1] ?? ''}`);
  }

  phase('6 the study record');
  const summary = {
    schema: 'rex890-dev-study-v1', at: new Date().toISOString(), city: CITY, experimentId: manifest.experimentId,
    manifest, campaignId, replayId: replayId ?? null, ablationId: ablationId ?? null,
    devices: devices, devicesThatExecuted: devicesThatRan, repetitions: REPETITIONS, runs: runs.length,
    measured: runs.filter(r => r.measured).length,
    runAssignments: runs.map(r => ({index: r.index, state: r.state, measured: r.measured === true, device: r.result?.assignedNodeId ?? null})),
    replayAssignments: replayRuns.map(r => ({index: r.index, state: r.state, device: r.result?.assignedNodeId ?? null})),
    ablationAssignments: ablationRuns.map(r => ({index: r.index, state: r.state, device: r.result?.assignedNodeId ?? null})),
    checks: results,
  };
  await writeFile(resolve(OUT, 'dev-study.json'), JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(resolve(OUT, 'dev-study.log'), results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`).join('\n') + '\n', 'utf8');
} finally {
  try { socket?.close(); } catch { /* already closed */ }
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} development-study checks pass`);
if (failed.length) console.log('failed: ' + failed.map(r => r.name).join(' | '));
process.exit(failed.length ? 1 : 0);
