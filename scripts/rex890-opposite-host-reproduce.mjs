// REX-890 — OPPOSITE-HOST reproduction harness.
//
// REX-890 says the opposite physical host must not merely READ the report. It must rebuild from the artifact and
// manifest, execute independently, recompute the key metrics, compare trace/provenance, and point out inconsistencies.
//
// THIS HARNESS FOLLOWS THE PACKAGE'S OWN RECIPE. `reproduction.json` inside the package states the steps and the exact
// definition of each metric; this script executes them against a City rather than reading the numbers the exporter
// printed. A reproduction that copies the first host's arithmetic is not a reproduction - so `normalized-dataset.json`
// is NOT read as an input: it is REBUILT here by joining each receipt run to its canonical task, which is the step the
// package asks for.
//
// WHY IT TAKES LOCAL PATHS. The artifact directory and, if the City needs one, a config file holding a credential are
// paths on the machine that runs this. Passing a token as a command-line argument would put a live credential into the
// City's own operation record, and an operation log is a record, not a secret store.
//
// USAGE
//   node scripts/rex890-opposite-host-reproduce.mjs --artifact <dir> --city <url> [--config <json with token>]
//                                                     [--repetitions N] [--out <dir>] [--label <host label>]
//
// EXIT  0 = this host reproduced every recomputed value and the package verifies
//       1 = it did not, and every disagreement is named
//       2 = the harness could not run or evidence could not be fully compared - NOT an acceptance
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {hostname} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
// The global WebSocket that Node ships, NOT the `ws` package: this harness must run from a BARE CHECKOUT, and a
// dependency would mean the reproducing host has to install the project before it can check anything. That is the
// difference between "fetch the branch and run one command" and "get a toolchain working first" - and an instrument
// that needs its own install is one more step that can fail for reasons that have nothing to do with the study. The API
// differs in exactly one place: the standard socket emits standard events, so `on('open')` becomes `addEventListener`.
const WebSocket = globalThis.WebSocket;
if (typeof WebSocket !== 'function') {
  process.stderr.write(`REX890 reproduction: this harness needs a Node with a global WebSocket (Node 22 or newer); found ${process.version}\n`);
  process.exit(2);
}

// THE SOFTWARE IDENTITY OF *THIS* RUN, OBSERVED FROM THE CHECKOUT THAT IS ACTUALLY RUNNING.
//
// The first version hardcoded `utopia@185d043e...` - the 4-in-1 verified head the study was exported from - and the
// manifest contract rendered it as `exact: true` on EVERY reproduction campaign. So a run from any other checkout
// produced a receipt that claimed, exactly, a software identity which had not run it. Measured, not supposed: a
// rehearsal from 6014f94 wrote a campaign whose context.manifest.softwareRefs says 185d043e with exact:true. That is
// the declared-versus-observed failure this programme exists to catch, and this instrument wrote it.
//
// The contract requires at least one exact 40-character ref, so there is nothing honest to put there but the commit
// the harness is running from. When that cannot be observed, the correct answer is NOT to run: a campaign whose
// software identity nobody observed would manufacture precisely the provenance the rule forbids.
const checkoutRoot = resolve(import.meta.dirname, '..');
let softwareHead = null, softwareTreeClean = null, softwareIdentityFailure = null;
try {
  softwareHead = execFileSync('git', ['-C', checkoutRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8', timeout: 10000}).trim();
  softwareTreeClean = execFileSync('git', ['-C', checkoutRoot, 'status', '--porcelain'], {encoding: 'utf8', timeout: 10000}).trim() === '';
  if (!/^[0-9a-f]{40}$/.test(softwareHead)) { softwareIdentityFailure = 'HEAD_NOT_A_FULL_SHA'; softwareHead = null; }
} catch (error) { softwareIdentityFailure = 'CHECKOUT_NOT_READABLE'; softwareHead = null; }

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const ARTIFACT = resolve(flag('artifact', '.'));
const CITY = flag('city');
const CONFIG = flag('config');
const OUT = resolve(flag('out', join(ARTIFACT, '..', 'opposite-host-reproduction')));
const REPETITIONS = Number(flag('repetitions', '6'));
const LABEL = flag('label', hostname());

const NOTES = [];
const INCONSISTENCIES = [];
const EVIDENCE_GAPS = [];
const note = m => { NOTES.push(m); console.log('  ' + m); };
const disagree = (what, packageValue, recomputed) => { INCONSISTENCIES.push({what, packageValue, recomputed}); console.log(`  INCONSISTENT  ${what}: package=${JSON.stringify(packageValue)} recomputed=${JSON.stringify(recomputed)}`); };
const sha256 = text => createHash('sha256').update(text).digest('hex');
const median = values => { const s = [...values].sort((a, b) => a - b); if (!s.length) return null; const mid = s.length >> 1; return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2; };

/**
 * Minimal CSV reader. The metrics file quotes fields that contain commas, and a naive split would corrupt exactly the
 * provenance column this harness exists to check.
 */
function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.length > 1);
  return body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

if (!CITY) { console.error('--city is required: this harness must talk to a City, not read a report'); process.exit(2); }
if (!existsSync(ARTIFACT)) { console.error(`--artifact ${ARTIFACT} does not exist`); process.exit(2); }
const token = CONFIG && existsSync(CONFIG) ? JSON.parse(await readFile(CONFIG, 'utf8')).token : process.env.CITY_TOKEN;
if (!token) { console.error('a City token is required (--config <file with a token field> or CITY_TOKEN)'); process.exit(2); }
const H = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
// `{body}` is destructured on purpose. The sibling study script took a raw body, this one takes it wrapped, and the
// first version of THIS file posted `{"body":{...}}` because of the mismatch - which the City correctly refused with
// twelve missing fields while the manifest it never received was sitting one level too deep.
const ask = async (path, {body} = {}) => { const r = await fetch(`${CITY}/api/v0/${path}`, {method: body ? 'POST' : 'GET', headers: H, body: body ? JSON.stringify(body) : undefined}); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* kept as text */ } return {status: r.status, json: j, text: t}; };

console.log(`REX-890 opposite-host reproduction on ${LABEL}`);
console.log(`  artifact ${ARTIFACT}`);
console.log(`  city     ${CITY}`);

console.log('\n--- 0 read the package and the recipe it states ---');
const pkg = async name => JSON.parse(await readFile(join(ARTIFACT, name), 'utf8'));
const manifest = await pkg('manifest.json');
const recipe = await pkg('reproduction.json');
const checksums = await pkg('checksums.json');
const exclusions = await pkg('exclusions.json');
note(`package files: ${(await readdir(ARTIFACT)).length}`);
note(`artifact ${manifest.artifactId}: campaigns=${manifest.campaignIds.length} runs=${manifest.runCount} measured=${manifest.measuredRuns}`);
note(`the package states ${recipe.steps.length} reproduction steps; this harness executes them`);

console.log('\n--- verify the package against its own checksums ---');
let integrity = 'VERIFIED', bad = 0;
for (const [name, expected] of Object.entries(checksums)) {
  const want = typeof expected === 'object' ? expected.sha256 : expected;
  if (!existsSync(join(ARTIFACT, name))) { bad++; disagree(`checksum for ${name}`, want, 'FILE MISSING'); continue; }
  const actual = sha256(await readFile(join(ARTIFACT, name)));
  if (actual !== want) { bad++; disagree(`checksum for ${name}`, want, actual); }
}
if (bad) integrity = 'BROKEN';
note(`checksums: ${integrity} over ${Object.keys(checksums).length} files`);

console.log('\n--- rebuild the normalized dataset from the City ---');
const city = await ask('city');
if (city.status !== 200) { console.error(`the City is not reachable: HTTP ${city.status} ${city.text.slice(0, 120)}`); process.exit(2); }
note(`this reproduction host sees ${(city.json?.nodes ?? []).filter(n => n.online).length} online device(s)`);
const taskById = new Map(((await ask('tasks')).json?.tasks ?? []).map(t => [t.id, t]));
const rebuilt = [];
const receiptsSeen = [];
for (const campaignId of manifest.campaignIds) {
  const campaign = (await ask(`research/campaigns/${campaignId}`)).json?.campaign ?? null;
  if (!campaign) {
    note(`campaign ${campaignId} is not present in this City, so its runs cannot be rebuilt`);
    INCONSISTENCIES.push({what: `campaign ${campaignId} missing from this City`, packageValue: 'present', recomputed: 'absent'});
    continue;
  }
  receiptsSeen.push({campaignId, state: campaign.state, runs: (campaign.runs ?? []).length});
  for (const run of campaign.runs ?? []) {
    const taskRef = run.result?.taskRef ?? null;
    const task = taskRef ? taskById.get(taskRef) ?? null : null;
    const durationMs = task && task.createdAt && task.updatedAt ? Date.parse(task.updatedAt) - Date.parse(task.createdAt) : null;
    rebuilt.push({campaignId, index: run.index, state: run.state, measured: run.measured === true, taskRef,
      taskState: task?.state ?? null, durationMs, assignedNodeId: run.result?.assignedNodeId ?? null, rawPointer: `receipt:${campaignId}#runs[${run.index}]`});
  }
}
note(`rebuilt ${rebuilt.length} run references from ${receiptsSeen.length} receipts (the package claims ${manifest.runCount})`);
if (rebuilt.length !== manifest.runCount) disagree('rebuilt run count', manifest.runCount, rebuilt.length);

console.log('\n--- recompute the metrics by the definitions the package states ---');
const measuredCompleted = rebuilt.filter(r => r.measured && r.taskState === 'COMPLETED' && typeof r.durationMs === 'number');
const planned = receiptsSeen.reduce((sum, r) => sum + r.runs, 0);
const failed = rebuilt.filter(r => r.state === 'FAILED' || r.state === 'TIMED_OUT').length;
const taskOwners = new Map();
for (const r of rebuilt) if (r.taskRef) taskOwners.set(r.taskRef, (taskOwners.get(r.taskRef) ?? 0) + 1);
const recomputed = {
  completion_time_ms: median(measuredCompleted.map(r => r.durationMs)),
  completion_time_ms_n: measuredCompleted.length,
  failure_rate: planned ? Number((failed / planned).toFixed(6)) : null,
  failure_rate_n: planned,
  duplicate_execution_count: [...taskOwners.values()].filter(n => n > 1).length,
  convergence_missing_event_count: rebuilt.filter(r => r.measured && !r.taskRef).length,
  run_count: rebuilt.length,
};
note(`completion_time_ms=${recomputed.completion_time_ms} (n=${recomputed.completion_time_ms_n})  failure_rate=${recomputed.failure_rate} (n=${recomputed.failure_rate_n})`);
note(`duplicate_execution_count=${recomputed.duplicate_execution_count}  convergence_missing_event_count=${recomputed.convergence_missing_event_count}`);

console.log('\n--- compare with the reported metrics ---');
const reported = parseCsv(await readFile(join(ARTIFACT, 'metrics.csv'), 'utf8'));
const byMetric = new Map(reported.map(r => [r.metric, r]));
const compare = (name, value) => {
  const row = byMetric.get(name);
  if (!row) { disagree(`${name}: required metric row missing`, 'present', null); return; }
  if (row.value === 'NOT_MEASURED') {
    // A NOT_MEASURED claim must be reproduced TOO. If this host can measure it, that is itself a finding.
    if (value !== null && value !== undefined) disagree(`${name} is reported NOT_MEASURED but is measurable here`, 'NOT_MEASURED', value);
    else if (!row.reason) disagree(`${name} is NOT_MEASURED without a stated reason`, 'reason', null);
    else note(`${name}: NOT_MEASURED, and the package states why (${String(row.reason).slice(0, 70)})`);
    return;
  }
  const claimedValue = Number(row.value);
  if (!row.value.trim() || !Number.isFinite(claimedValue)) disagree(`${name}: invalid measured value`, 'finite number', row.value);
  else if (typeof value !== 'number' || !Number.isFinite(value)) disagree(`${name}: recomputation unavailable`, claimedValue, value);
  else if (claimedValue !== value) disagree(name, claimedValue, value);
  else note(`${name}: ${row.value} agrees`);
};
compare('completion_time_ms', recomputed.completion_time_ms);
compare('failure_rate', recomputed.failure_rate);
compare('duplicate_execution_count', recomputed.duplicate_execution_count);
compare('convergence_missing_event_count', recomputed.convergence_missing_event_count);
const provenanceMissing = reported.filter(r => r.value !== 'NOT_MEASURED' && !r.provenance);
if (provenanceMissing.length) disagree('measured metrics without provenance', 0, provenanceMissing.map(r => r.metric));
else note('every measured metric carries provenance');
note(`the package declares ${exclusions.exclusions?.length ?? 0} exclusion(s); this host does not claim them either`);

console.log('\n--- compare trace and provenance with the City ---');
const pointers = await pkg('raw-pointers.json');
const traceNow = (await ask('research/trace')).json?.trace ?? null;
const tracedIds = new Set((traceNow?.records ?? []).map(r => r.eventId).filter(Boolean));
const taskIdsNow = new Set(taskById.keys());
const pointerChecks = {};
for (const [name, listed] of Object.entries(pointers)) {
  if (!Array.isArray(listed)) continue;
  if (name === 'traceRecords') {
    // The trace SURFACE is a ROLLING WINDOW, so a pointer missing from it is not automatically a defect. It is reported
    // as a measured number together with what the City's own trace says about its completeness, and the package's claim
    // is only contradicted if the City says nothing was dropped while pointers are missing.
    //
    // MEASURED, and the reason this second question exists: the package publishes 206 pointers, and once the window has
    // moved on the snapshot resolves NONE of them while all 206 are still in the City's durable store. Reporting only
    // the window number tells a reader "0/206" and nothing about whether the evidence is gone or merely unasked - and a
    // reproduction host on ANOTHER machine cannot go behind the API to find out. So the pointers the window cannot
    // serve are asked for BY ID, and absence from BOTH is the only absence that means the records are really gone.
    const ids = listed.map(p => String(p).replace(/^trace:/, ''));
    const inWindow = ids.filter(id => tracedIds.has(id));
    const outside = ids.filter(id => !tracedIds.has(id));
    let inStore = [], storeScope = null, storeTruncated = null, storeFailure = null;
    if (outside.length) {
      // Asked in CHUNKS: 206 ids in one query string is a ~7.6 KB URL, uncomfortably close to the header limit, and a
      // refusal there would look like a City fault rather than a client that asked too much at once.
      const CHUNK = 100;
      for (let i = 0; i < outside.length; i += CHUNK) {
        const slice = outside.slice(i, i + CHUNK);
        const response = await ask('research/trace/records?ids=' + encodeURIComponent(slice.join(',')));
        const answer = response.json?.lookup ?? null;
        if (!answer) { storeFailure = response.json?.errorCode ?? `HTTP_${response.status}`; break; }
        inStore.push(...(answer.found ?? []));
        storeScope = answer.storeScope ?? storeScope;
        storeTruncated = answer.storeTruncated ?? storeTruncated;
      }
    }
    const resolvable = inWindow.length + inStore.length;
    if (resolvable < ids.length) EVIDENCE_GAPS.push({what: 'trace comparison incomplete', listed: ids.length, resolvable, storeFailure});
    pointerChecks.traceRecords = {listed: ids.length, presentInRetainedWindow: inWindow.length,
      presentInDurableStore: inStore.length, resolvable, absent: ids.length - resolvable,
      storeScope, storeTruncated, storeFailure,
      cityCompleteness: traceNow?.completeness ?? null, cityDropped: traceNow?.droppedRecords ?? null, cityTruncated: traceNow?.retentionTruncated ?? null};
    note(`trace pointers: ${inWindow.length}/${ids.length} in the retained window, +${inStore.length} resolved from the durable store = ${resolvable}/${ids.length} (city completeness=${traceNow?.completeness ?? 'n/a'} dropped=${JSON.stringify(traceNow?.droppedRecords ?? null)})`);
    // VACUOUS IS NOT VERIFIED. If the window moved on and the store could not be asked, this element compared NOTHING,
    // and saying "0 inconsistencies" without saying that would be the exact overclaim this programme exists to avoid.
    if (inWindow.length === 0 && outside.length && inStore.length === 0 && storeFailure) {
      note(`trace comparison is VACUOUS: the retained window holds none of the pointers and the durable store could not be asked (${storeFailure})`);
    }
    if (resolvable < ids.length && traceNow?.completeness === 'COMPLETE' && traceNow?.retentionTruncated !== true) {
      disagree('trace pointers missing while the City call its own trace complete', ids.length, resolvable);
    }
    continue;
  }
  if (name === 'canonicalTasks') {
    const ids = listed.map(p => String(p).replace(/^task:/, ''));
    const present = ids.filter(id => taskIdsNow.has(id)).length;
    pointerChecks.canonicalTasks = {listed: ids.length, presentInCity: present, absent: ids.length - present};
    note(`canonical task pointers: ${present}/${ids.length} still exist in this City`);
    // A distinct task that the package points at and the City no longer has would mean the export describes state the
    // City cannot reproduce - so it is only a note when the task was never part of the runs this reproduction checks.
    continue;
  }
  if (name === 'canonicalTaskRuns') {
    // The join the package asks for, re-done here from the pointers: each run reference must map to a task that exists.
    const broken = listed.filter(p => !p?.taskRef || !taskIdsNow.has(p.taskRef));
    pointerChecks.canonicalTaskRuns = {listed: listed.length, broken: broken.length};
    note(`run-to-task join: ${listed.length - broken.length}/${listed.length} pointers still resolve`);
    if (broken.length) disagree('run-to-task pointers that no longer resolve', listed.length, broken.length);
    continue;
  }
  pointerChecks[name] = {listed: listed.length};
  note(`${name}: ${listed.length} pointer(s) listed`);
}
// Every run reference in the rebuilt dataset must carry the pointer it came from: provenance that cannot be followed
// is not provenance, and the package's own recipe starts by reading these pointers.
const withoutPointer = rebuilt.filter(r => !r.rawPointer || !r.taskRef);
if (withoutPointer.length) disagree('run references with no followable pointer', 0, withoutPointer.map(r => `${r.campaignId}:${r.index}`));
else note('every rebuilt run reference carries both its receipt pointer and its canonical task reference');

console.log('\n--- execute independently on this host ---');
const executed = {attempted: false, reason: null, campaignId: null, state: null, runs: [], devices: []};
const topology = await pkg('topology.json').catch(() => null);
const nodes = (topology?.nodes ?? []).map(n => n.id);
// A TWO_HOST_MESH topology requires at least one live control surface, and the recorded one is gone by the time anyone
// reproduces. This host therefore attaches its OWN surface and declares that: the reproduction is a new run, not a
// replay of the first host's session, and a topology that named a dead surface would be refused - correctly.
const surfaceRef = 'rex890-repro-' + Date.now().toString(36);
let surface = null;
try {
  surface = new WebSocket(CITY.replace('http', 'ws') + `/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=${surfaceRef}&clientLabel=REX-890%20reproduction%20surface`, ['city-token.' + Buffer.from(token).toString('base64url')]);
  await new Promise((yes, no) => { surface.addEventListener('open', yes, {once: true}); surface.addEventListener('error', no, {once: true}); });
  note(`attached control surface ${surfaceRef}`);
} catch (error) {
  executed.reason = `could not attach a control surface: ${error.message}`;
  note('INDEPENDENT EXECUTION NOT RUN: ' + executed.reason);
}
const reproductionManifest = {
  // The id is kept SHORT and the provenance is carried in the question and the acceptance notes instead: the manifest
  // contract bounds experimentId, and the first version of this harness embedded the whole artifactId in it and got a
  // 12-issue refusal that looked like a product rejection but was a length the contract had every right to refuse.
  experimentId: ('rex890-repro-' + Date.now().toString(36)).slice(0, 60),
  question: `Opposite-host reproduction of ${manifest.artifactId}`,
  topology: 'TWO_HOST_MESH', hosts: nodes, workers: nodes,
  controlSurfaces: [surfaceRef],
  variables: {independent: ['scenario'], dependent: ['completion'], controls: ['taskType']},
  repetitions: REPETITIONS, seedPolicy: 'PER_REPETITION', baseSeed: 20261007,
  requiredCapabilities: ['research.evidence.review'],
  stopConditions: [{kind: 'MAX_REPETITIONS', value: REPETITIONS}, {kind: 'MAX_FAILURES', value: REPETITIONS}],
  artifactPolicy: {retention: 'SUMMARY_ONLY'},
  acceptance: {primary: 'Every repetition is a canonical task that reached a terminal state', notes: [manifest.artifactId, `reproduced by ${LABEL}`]},
  softwareRefs: [`utopia@${softwareHead ?? 'UNOBSERVED'}`],
};
const registered = surface && softwareHead ? await ask('research/experiments', {body: {manifest: reproductionManifest}}) : {status: 0, text: softwareHead ? 'no control surface, so no reproduction manifest' : `software identity not observable (${softwareIdentityFailure})`};
if (!softwareHead) { executed.reason = `SOFTWARE_IDENTITY_UNOBSERVABLE: ${softwareIdentityFailure}`; note('INDEPENDENT EXECUTION NOT RUN: a campaign would have to declare an exact software identity nobody observed'); }
else if (registered.status !== 200) { executed.reason = `manifest refused: HTTP ${registered.status} ${registered.text.slice(0, 200)}`; note('INDEPENDENT EXECUTION NOT RUN: ' + executed.reason); }
else {
  const started = await ask('research/campaigns', {body: {experimentId: reproductionManifest.experimentId, scenarioId: 'WAIT'}});
  const campaignId = started.json?.started?.campaignId ?? null;
  if (started.status !== 200 || !campaignId) { executed.reason = `campaign refused: HTTP ${started.status} ${started.text.slice(0, 200)}`; note('INDEPENDENT EXECUTION NOT RUN: ' + executed.reason); }
  else {
    executed.attempted = true; executed.campaignId = campaignId;
    const terminal = ['COMPLETED', 'STOPPED', 'REFUSED', 'FAILED', 'INTERRUPTED'];
    const until = Date.now() + 300000;
    let campaign = null;
    for (;;) {
      campaign = (await ask(`research/campaigns/${campaignId}`)).json?.campaign ?? null;
      if (campaign && terminal.includes(campaign.state)) break;
      if (Date.now() > until) { note('the reproduction campaign did not settle inside this harness budget'); break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    executed.state = campaign?.state ?? null;
    // TWO VOCABULARIES, KEPT APART. A receipt run is MEASURED; the canonical task that run executed is COMPLETED.
    // The check below originally asked a run for `COMPLETED` and therefore flagged EVERY healthy run on a real City -
    // a false inconsistency, and the mirror image of the false successes this instrument was repaired to stop. It was
    // found by running the repaired harness against the real City, whose receipts say `state: "MEASURED"` with the task
    // state nested under `result.state`. Each field is now judged by its own words.
    executed.runs = (campaign?.runs ?? []).map(r => ({index: r.index, runState: r.state, taskState: r.result?.state ?? null, measured: r.measured === true, device: r.result?.assignedNodeId ?? null}));
    executed.devices = [...new Set(executed.runs.map(r => r.device).filter(Boolean))];
    note(`independent campaign ${campaignId} -> ${executed.state} runs=${executed.runs.length} devices=${executed.devices.join(',') || 'none'}`);
    if (executed.state !== 'COMPLETED') disagree('independent campaign terminal state', 'COMPLETED', executed.state);
    if (executed.runs.length !== REPETITIONS) disagree('independent campaign repetition count', REPETITIONS, executed.runs.length);
    const incomplete = executed.runs.filter(r => r.measured !== true || r.taskState !== 'COMPLETED' || !r.device);
    if (incomplete.length) disagree('independent runs without completed measured device evidence', 0, incomplete);
    const missingDevices = nodes.filter(id => !executed.devices.includes(id));
    if (missingDevices.length) disagree('declared devices not exercised independently', [], missingDevices);
  }
}

await mkdir(OUT, {recursive: true});
// A DIRTY TREE IS NOT REPRODUCIBLE FROM ITS COMMIT. The SHA is still a real 40-character identity, so the manifest is
// well formed - but nobody can re-create this run from that commit alone, which makes it an evidence gap rather than a
// silent detail. Recorded before the report so `reproductionComplete` accounts for it.
if (softwareHead) {
  note(`software identity observed from the checkout: utopia@${softwareHead} (tree ${softwareTreeClean ? 'clean' : 'DIRTY'})`);
  if (softwareTreeClean === false) EVIDENCE_GAPS.push({what: 'checkout has uncommitted changes, so this run is not reproducible from its declared commit', head: softwareHead});
} else {
  note(`software identity NOT OBSERVABLE (${softwareIdentityFailure}); no independent execution was attempted`);
}
const report = {
  schema: 'rex890-opposite-host-reproduction-v1', at: new Date().toISOString(),
  host: LABEL, hostname: hostname(), platform: process.platform, node: process.version,
  city: CITY, artifact: ARTIFACT, artifactId: manifest.artifactId,
  // The software identity is OBSERVED here, not assumed: it names the commit that ran this harness, which is what the
  // campaign's exact software ref must mean.
  software: {observedHead: softwareHead, treeClean: softwareTreeClean, source: softwareHead ? 'OBSERVED_FROM_CHECKOUT' : null, failure: softwareIdentityFailure},
  packageIntegrity: integrity, recipe: recipe.steps,
  rebuilt, receiptsSeen, recomputed, reportedMetrics: reported, pointerChecks,
  executed, inconsistencies: INCONSISTENCIES, evidenceGaps: EVIDENCE_GAPS, notes: NOTES,
  reproductionComplete: executed.attempted && INCONSISTENCIES.length === 0 && EVIDENCE_GAPS.length === 0,
  // This harness is the OPPOSITE HOST's instrument, not an acceptance: the verdict belongs to the record holder.
  authority: 'REPRODUCTION_EVIDENCE_ONLY',
};
try { surface?.close(); } catch { /* already closed */ }
await writeFile(join(OUT, 'opposite-host-reproduction.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\n${INCONSISTENCIES.length} inconsistenc${INCONSISTENCIES.length === 1 ? 'y' : 'ies'} found`);
console.log(`report: ${join(OUT, 'opposite-host-reproduction.json')}`);
if (!executed.attempted) console.log('INDEPENDENT EXECUTION DID NOT RUN - this is not an acceptance');
if (EVIDENCE_GAPS.length) console.log('COMPARISON INCOMPLETE - missing evidence is not a successful reproduction');
// Set the code and let the process drain: calling process.exit() here crashed libuv on Windows with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" because this harness has just finished many fetches. The
// exit code is what a caller reads, so the abrupt exit bought nothing and cost a crash after a successful run.
process.exitCode = INCONSISTENCIES.length ? 1 : (!executed.attempted || EVIDENCE_GAPS.length ? 2 : 0);
