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
//
// WHY THIS SCRIPT LIVES IN THE REPOSITORY, and what changed when it moved here. Until now it existed only outside the
// tree, and it read the City token from one machine's absolute path. So the study that produced the artifact package
// could not be re-run by anyone who fetched the branch: the instrument was not in the tree, and the credential was
// looked for where only the development host keeps it. A study whose instrument cannot travel is not a reproducible
// study - the same declared-versus-available gap as the trace pointers, one level up.
//
// Now the checkout defaults to THIS repository, the City and the output directory are parameters, and the credential
// comes from a JSON file named by --config (or CITY_TOKEN), never from a path baked into the source. A missing
// credential is refused by name before anything runs.
//
//   node scripts/rex890-dev-study.mjs --city <url> --out <dir> --config <json with token> [--checkout <dir>] [--repetitions N]
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
// The global WebSocket Node ships, NOT the `ws` package: the study must start from a bare checkout, and a dependency
// would mean an install before anything could be measured. Same repair as the reproduction harness.
const WebSocket = globalThis.WebSocket;
if (typeof WebSocket !== 'function') {
  process.stderr.write(`REX890 dev study: this needs a Node with a global WebSocket (Node 22 or newer); found ${process.version}\n`);
  process.exit(2);
}

const flag = (name, env, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return (index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined) ?? process.env[env] ?? fallback;
};
const CITY = flag('city', 'REX890_CITY');
const OUT = flag('out', 'REX890_OUT');
const CHECKOUT = resolve(flag('checkout', 'REX890_CHECKOUT', resolve(import.meta.dirname, '..')));
const REPETITIONS = Number(flag('repetitions', 'REX890_REPETITIONS', 6));
const CONFIG = flag('config', 'REX890_CONFIG');
const missing = Object.entries({CITY, OUT}).filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  process.stderr.write(`REX890 dev study: missing ${missing.join(', ')} - pass --city and --out (or set REX890_CITY / REX890_OUT)\n`);
  process.exit(2);
}
const credential = (() => {
  if (CONFIG) { try { return JSON.parse(readFileSync(CONFIG, 'utf8')); } catch (error) { process.stderr.write(`REX890 dev study: --config ${CONFIG} is not readable JSON (${error.message})\n`); process.exit(2); } }
  if (process.env.CITY_TOKEN) return {token: process.env.CITY_TOKEN, nodeToken: process.env.CITY_NODE_TOKEN};
  process.stderr.write('REX890 dev study: a City token is required (--config <file with a token field>, or CITY_TOKEN)\n');
  process.exit(2);
})();
const token = credential.token;
const nodeToken = credential.nodeToken ?? process.env.CITY_NODE_TOKEN ?? null;
const H = c => ({Authorization: 'Bearer ' + c, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
// A DELIBERATE SKIP IS NOT A FAILURE. `ok === null` records NOT_RUN, which this programme's own rules keep distinct
// from FAIL: the fault-targeting probe is skipped on purpose when the City has queued work, because probing by
// claiming would STEAL that work. Reporting that as a failed check made the study look like it had a problem whenever
// a handoff job happened to be waiting - measured on 2026-10-08, when the study scored 20/21 for that reason alone.
const record = (name, ok, detail) => { results.push({name, status: ok === true ? 'PASS' : ok === null ? 'NOT_RUN' : 'FAIL', detail: String(detail ?? '')});
  console.log(`${ok === true ? 'PASS' : ok === null ? 'NOT_RUN' : 'FAIL'}  ${name.padEnd(58)} ${detail ?? ''}`); };
const phase = t => console.log(`\n--- ${t} ---`);

// THE STUDY DECLARES THE SOFTWARE IT ACTUALLY RAN FROM, AND REFUSES IF NOBODY CAN TELL IT. This used to be the
// literal string 'utopia@185d043e...' - a commit remembered from an earlier round, kept in the manifest while the tree
// moved on. A remembered identity is false the moment anything changes, and it is exactly the defect the reproduction
// harness was repaired for: a manifest that misnames its software makes every downstream comparison vacuous. So the
// identity is OBSERVED from the checkout the study runs out of. A dirty tree is still a real 40-character identity, so
// the study runs - but the state is recorded rather than hidden. Checked BEFORE the City is touched, so a study that
// cannot be attributed refuses without registering an experiment or opening a control surface.
const software = (() => {
  try {
    const head = execFileSync('git', ['-C', CHECKOUT, 'rev-parse', 'HEAD'], {encoding: 'utf8', timeout: 10000}).trim();
    if (!/^[0-9a-f]{40}$/.test(head)) return {ref: null, reason: `git rev-parse returned ${JSON.stringify(head)}`};
    const clean = execFileSync('git', ['-C', CHECKOUT, 'status', '--porcelain'], {encoding: 'utf8', timeout: 10000}).trim() === '';
    return {ref: `utopia@${head}`, clean, reason: null};
  } catch (error) { return {ref: null, reason: error.message}; }
})();
if (!software.ref) {
  process.stderr.write(`REX890 dev study: SOFTWARE_IDENTITY_UNOBSERVABLE in ${CHECKOUT} (${software.reason}) - refusing to register an experiment whose software nobody observed\n`);
  process.exit(2);
}
record('the study declares the software identity it actually ran from', true, `${software.ref} (tree ${software.clean ? 'clean' : 'DIRTY'})`);

const ask = async (path, {body, credential = token, method} = {}) => {
  let response;
  try {
    response = await fetch(`${CITY}/api/v0/${path}`, {method: method ?? (body ? 'POST' : 'GET'), headers: H(credential), body: body ? JSON.stringify(body) : undefined});
  } catch (error) {
    // Transport failure is an answer too: report it in the same shape as an HTTP response so every caller keeps its
    // existing check instead of each one needing its own try/catch.
    return {status: 0, body: null, text: `CITY_UNREACHABLE ${path}: ${error.message}`, unreachable: true};
  }
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

const log = (...a) => console.log(...a);

let socket = null;
const campaignIds = [];
// The record is written WHATEVER HAPPENS, which is why what it contains is decided outside the try: a study that
// stopped at phase 1 used to leave nothing on disk but a console tally, so a refusal could not be read back later.
let summary = null;
let failure = null;
try {
  phase('0 the study runs against the resident City, with the real agents');
  const city = await ask('city');
  // A City that does not answer is a PRECONDITION, not a mid-study crash: refuse by name, before registering an
  // experiment or attaching a control surface, exactly as an unattributable checkout is refused.
  if (city.status === 0) {
    process.stderr.write(`REX890 dev study: ${city.text} - refusing to run a study against a City that does not answer\n`);
    process.exit(2);
  }
  const nodes = city.body?.nodes ?? [];
  const devices = nodes.filter(n => n.online === true).map(n => n.id);
  // Nothing of the study's own is created until its preconditions hold: no output directory, no experiment record.
  await mkdir(resolve(OUT), {recursive: true});
  record('the resident City answers and has two online devices', city.status === 200 && devices.length >= 2, `city=${String(city.body?.cityId ?? 'unnamed').slice(0, 8)} devices=${devices.join(', ')}`);

  socket = new WebSocket(`${CITY.replace('http', 'ws')}/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=rex890-dev-surface&clientLabel=REX-890%20development%20surface`, ['city-token.' + Buffer.from(token).toString('base64url')]);
  await new Promise((yes, no) => { socket.addEventListener('open', yes, {once: true}); socket.addEventListener('error', no, {once: true}); });
  record('a real control surface is attached to this City', true, 'rex890-dev-surface');

  phase('1 register the experiment (REX-801 manifest)');
  const manifest = {
    // THE EXPERIMENT ID MUST BE FRESH, OR THE STUDY CANNOT BE RUN TWICE. It used to be the date alone, so a second run
    // on the same day collided with the first: HTTP 409 IMMUTABLE_MANIFEST, because the City is right to refuse an
    // experiment whose manifest changed under a name it already recorded - and the manifest did change, since the
    // software identity is now observed rather than remembered. An instrument that cannot be re-run is not an
    // instrument. The date is kept for readability and a short per-run token makes the record unique.
    experimentId: `rex890-dev-multi-device-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`,
    question: 'Can the Research Fabric produce a reproducible multi-device artifact with a real injected fault?',
    topology: 'TWO_HOST_MESH', hosts: devices, workers: devices, controlSurfaces: ['rex890-dev-surface'],
    variables: {independent: ['scenario'], dependent: ['completion'], controls: ['taskType']},
    repetitions: REPETITIONS, seedPolicy: 'PER_REPETITION', baseSeed: 20261007,
    requiredCapabilities: ['research.evidence.review'],
    stopConditions: [{kind: 'MAX_REPETITIONS', value: REPETITIONS}, {kind: 'MAX_FAILURES', value: REPETITIONS}],
    artifactPolicy: {retention: 'SUMMARY_ONLY'},
    acceptance: {primary: 'Every repetition is a canonical task that reached a terminal state, on the device the placement chose'},
    softwareRefs: [software.ref],
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
      record('the fault targeting check is NOT_RUN to avoid stealing queued work', null, `queued tasks present: ${queued}`);
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
  // WHICH RECORDED RUN TO REPLAY IS A DECISION, NOT A COIN FLIP.
  //
  // The ablation disables `alternate-device`, which fixes placement to the campaign's FIRST worker. Demonstrating that
  // the disabled mechanism CHANGED the placement therefore needs a source run that the mechanism had placed somewhere
  // else. Choosing "the first measured run" made that element a coin flip on the seed, and it came up wrong when this
  // study was re-run on 2026-10-08: the source run and the ablation landed on the SAME device, so the study scored
  // 18/20 with nothing wrong with the City. Selecting deliberately - and saying which run was selected and why - is
  // the honest repair: the mechanism is being demonstrated, not searched for.
  const sourceCampaign = (await ask(`research/campaigns/${campaignId}`)).body?.campaign ?? null;
  const fixedWorker = sourceCampaign?.context?.manifest?.workers?.[0] ?? null;
  const movable = runs.findIndex(r => r.measured === true && r.result?.assignedNodeId && fixedWorker && r.result.assignedNodeId !== fixedWorker);
  const sourceRunIndex = movable >= 0 ? movable : Math.max(0, runs.findIndex(r => r.measured === true));
  record('the replay source run is chosen so the ablation can demonstrate its mechanism',
    movable >= 0,
    movable >= 0
      ? `run ${sourceRunIndex} ran on ${String(runs[sourceRunIndex].result?.assignedNodeId).slice(0, 12)}, which the disabled mechanism moves to the first worker ${String(fixedWorker).slice(0, 12)}`
      : `no measured run was placed away from the first worker (${String(fixedWorker).slice(0, 12)}), so the ablation cannot show a placement change on this campaign`);
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
  summary = {
    schema: 'rex890-dev-study-v1', at: new Date().toISOString(), city: CITY, experimentId: manifest.experimentId,
    manifest, campaignId, replayId: replayId ?? null, ablationId: ablationId ?? null,
    devices: devices, devicesThatExecuted: devicesThatRan, repetitions: REPETITIONS, runs: runs.length,
    measured: runs.filter(r => r.measured).length,
    runAssignments: runs.map(r => ({index: r.index, state: r.state, measured: r.measured === true, device: r.result?.assignedNodeId ?? null})),
    replayAssignments: replayRuns.map(r => ({index: r.index, state: r.state, device: r.result?.assignedNodeId ?? null})),
    ablationAssignments: ablationRuns.map(r => ({index: r.index, state: r.state, device: r.result?.assignedNodeId ?? null})),
    checks: results,
  };
} catch (error) {
  // A MID-STUDY FAILURE IS AN OUTCOME, NOT A STACK TRACE. This used to propagate: no tally, no record on disk, just a
  // Node internal stack, which is the worst possible shape for an instrument the opposite host has to run because it
  // cannot tell a bad City endpoint from a broken study. Named, recorded, and still written out below.
  failure = `${error?.message || error?.error?.message || error?.type || String(error)}`;
  record('the study ran to the end without an unexpected failure', false, failure);
} finally {
  // CLOSE THE SOCKET BEFORE THE LOOP ENDS. Closing the control surface and then calling process.exit() in the same
  // tick aborts the process on Windows with a native libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`,
  // src\win\async.c), measured 2026-10-08 on the refusal path: exit code 0xC0000409 and no report. The instrument has
  // to fail legibly, so the close is awaited with a bound.
  await new Promise(done => {
    if (!socket) return done();
    const timer = setTimeout(done, 2000);
    try { socket.addEventListener('close', () => { clearTimeout(timer); done(); }, {once: true}); socket.close(); }
    catch { clearTimeout(timer); done(); }
  });
}
// THE RECORD IS WRITTEN WHATEVER HAPPENED. A completed run writes what phases 0-5 measured; a run that stopped early
// writes the checks it did reach plus the reason, flagged as incomplete, so a refusal is readable afterwards instead of
// existing only as console output that the next process scrolls away.
await mkdir(resolve(OUT), {recursive: true});
const studyRecord = summary ?? {schema: 'rex890-dev-study-v1', at: new Date().toISOString(), city: CITY, incomplete: true, failedBecause: failure, checks: results};
await writeFile(resolve(OUT, 'dev-study.json'), JSON.stringify(studyRecord, null, 2), 'utf8');
// THE LOG IS PART OF THE EVIDENCE, so it must say what the run said. This line still read `r.ok` after the check records
// moved to carrying a `status` (they need three values now that a deliberate skip is NOT_RUN, not FAIL). `r.ok` is
// undefined, so every line of the sidecar read FAIL - a log that lies about a study that passed.
await writeFile(resolve(OUT, 'dev-study.log'), results.map(r => `${r.status.padEnd(7)}  ${r.name}  ${r.detail}`).join('\n') + '\n', 'utf8');
const failed = results.filter(r => r.status === 'FAIL');
const notRun = results.filter(r => r.status === 'NOT_RUN');
console.log(`\n${results.length - failed.length - notRun.length}/${results.length} development-study checks pass`);
if (notRun.length) console.log(`not run (deliberately, and named rather than counted as failures): ${notRun.map(r => r.name).join(' | ')}`);
if (failed.length) console.log('failed: ' + failed.map(r => r.name).join(' | '));
// NO FORCED process.exit(). Calling it here aborted the process on Windows with a native libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c) whenever the control surface had just been closed - exit
// code 0xC0000409 instead of the report that had already been written. Awaiting the socket's close first was not
// enough, because the abort comes from tearing the loop down during exit, not from the socket. So the status is left
// for the runtime to honour once the loop drains, which is the same exit code without the race.
process.exitCode = failed.length ? 1 : 0;
