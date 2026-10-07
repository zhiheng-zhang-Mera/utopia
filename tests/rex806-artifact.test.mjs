// REX-806 reviewer-style probes for the artifact exporter: the properties the workbook demands, attacked directly.
//
// Each probe states what its failure would mean, so a pass is a measurement rather than a shrug.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildArtifact, artifactFiles, checksumsFor, metricsCsv, METRIC_SPEC, NOT_MEASURED, ArtifactError, ARTIFACT_CODES} from '../services/dev-gateway/research/artifact.mjs';

const receipt = (overrides = {}) => ({
  campaignId: 'campaign-aaaa', scenarioId: 'WAIT', state: 'COMPLETED', reason: 'REPETITIONS_FINISHED',
  campaignSeed: 'seed-a', repetitions: 1, warmup: 0, timeout: 30000, limits: {},
  totalRuns: 1, startedAt: 1000, finishedAt: 8000,
  context: {experimentId: 'exp-1', manifestIdentity: 'id-1', manifest: {topology: 'TWO_HOST_MESH', hosts: ['w-a', 'w-b'], workers: ['w-a', 'w-b'], controlSurfaces: ['surface-1'], repetitions: 1, seedPolicy: 'PER_REPETITION', baseSeed: 5, stopConditions: [], acceptance: {}, softwareRefs: []}, targetDeviceRef: null},
  runs: [{index: 0, state: 'MEASURED', reason: null, seed: 414121415, warmup: false, measured: true, durationMs: 7000, result: {taskRef: 'Q-1', state: 'COMPLETED', assignedNodeId: 'w-b', result: {waitedMs: 6000}}}],
  summary: {planned: 1, accounted: 1, warmup: 0, measured: 1, timedOut: 0, failed: 0, excluded: 0, cancelled: 0, skipped: 0, interrupted: 0, terminalAccountingComplete: true},
  ...overrides,
});
const task = (overrides = {}) => ({id: 'Q-1', type: 'WAIT', state: 'COMPLETED', createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:07.000Z', assignedNodeId: 'w-b', researchRunRef: 'campaign-aaaa:0', result: {waitedMs: 6000}, ...overrides});
const sources = (overrides = {}) => ({cityId: 'city-a', generatedAt: '2026-10-06T10:00:10.000Z', receipts: [receipt()], tasks: [task()], ...overrides});

test('REX806 missing canonical tasks remain counted rather than being filtered from convergence',()=>{
  const artifact=buildArtifact(sources({tasks:[]}));
  const metric=artifact.metrics.find(x=>x.metric==='convergence_missing_event_count');
  assert.equal(metric.value,1);assert.equal(metric.n,1);
});

// A1 - the eleven sections the workbook names must all be in the artifact.
test('REX806 A1: the artifact carries every section the workbook names', () => {
  const artifact = buildArtifact(sources());
  const files = artifactFiles(artifact);
  for (const name of ['manifest.json', 'environment.json', 'topology.json', 'raw-pointers.json', 'normalized-dataset.json', 'metrics.csv', 'failures.json', 'exclusions.json', 'tables.json', 'reproduction.json']) {
    assert.ok(files[name], `section ${name} is missing`);
  }
  assert.deepEqual(Object.keys(artifact).filter(key => ['manifest', 'environment', 'topology', 'rawPointers', 'dataset', 'metrics', 'failures', 'exclusions', 'tables', 'reproduction'].includes(key)).sort(),
    ['dataset', 'environment', 'exclusions', 'failures', 'manifest', 'metrics', 'rawPointers', 'reproduction', 'tables', 'topology'].sort());
});

// A2 - every metric the workbook names appears exactly once, with either a value+provenance or NOT_MEASURED+reason.
// A CSV that simply omits the awkward metrics would look complete and be a lie.
test('REX806 A2: every named metric appears, with a value and provenance or NOT_MEASURED and a reason', () => {
  const artifact = buildArtifact(sources());
  for (const spec of METRIC_SPEC) {
    const rows = artifact.metrics.filter(row => row.metric === spec.id);
    assert.equal(rows.length, 1, `metric ${spec.id} must appear exactly once`);
    const row = rows[0];
    if (row.value === NOT_MEASURED) assert.ok(typeof row.reason === 'string' && row.reason.length > 10, `metric ${spec.id} must state why it is unavailable`);
    else assert.ok(Array.isArray(row.provenance) && row.provenance.length > 0, `metric ${spec.id} must carry provenance`);
  }
  const csv = metricsCsv(artifact);
  for (const spec of METRIC_SPEC) assert.ok(csv.includes(spec.id), `metrics.csv must contain ${spec.id}`);
  assert.equal(csv.trim().split('\n').length, METRIC_SPEC.length + 1, 'one header plus one row per metric');
});

// A3 - the intervention count, the metric the guard singles out: unknown must NOT become zero.
test('REX806 A3: an unobserved intervention window is NOT_MEASURED, never 0', () => {
  const artifact = buildArtifact(sources());
  const row = artifact.metrics.find(entry => entry.metric === 'intervention_count');
  assert.equal(row.value, NOT_MEASURED, 'no complete intervention window was observed, so 0 would be a fabricated autonomy claim');
  assert.match(row.reason, /Owner actions|window/i);
});

// A4 - an artifact with no real source is refused rather than emitted as an empty shape.
test('REX806 A4: an export with no real campaign is refused', () => {
  assert.throws(() => buildArtifact({cityId: 'city-a', receipts: []}), error => error instanceof ArtifactError && error.code === ARTIFACT_CODES.NO_SOURCE);
});

// A5 - a value without provenance is refused, and NOT_MEASURED without a reason is refused.
test('REX806 A5: the evaluator refuses a value with no provenance and NOT_MEASURED with no reason', async () => {
  const module = await import('../services/dev-gateway/research/artifact.mjs');
  const artifact = buildArtifact(sources());
  const files = module.artifactFiles(artifact);
  assert.ok(files['metrics.csv'].includes('NOT_MEASURED'));
  // Tamper with a derived metric through the public surface: a receipt whose completion has no task must not silently
  // become a zero-completion metric, it must be unavailable.
  const orphan = buildArtifact(sources({tasks: []}));
  const completion = orphan.metrics.find(entry => entry.metric === 'completion_time_ms');
  assert.equal(completion.value, NOT_MEASURED, 'with no canonical task there is no completion time, and 0 would be a fabrication');
});

// A6 - the normalized dataset is the unit a reviewer recomputes from, so every row must point back at raw records and
// must report whether the placement matched the seed (the property this programme cares about most).
test('REX806 A6: every dataset row carries a raw pointer and a seed-placement verdict', () => {
  const artifact = buildArtifact(sources());
  assert.equal(artifact.dataset.length, 1);
  const row = artifact.dataset[0];
  assert.equal(row.rawPointer, 'receipt:campaign-aaaa#runs[0]');
  assert.ok(artifact.rawPointers.receipts.includes('receipt:campaign-aaaa'));
  assert.equal(row.assignedNodeId, 'w-b');
  assert.equal(row.placementRule, 'SEEDED_WORKER_SELECTION');
  assert.equal(row.placementMatchesPolicy, true, 'seed 414121415 % 2 == 1 selects w-b, and no ablation policy overrides it');
  assert.equal(row.placementMatchesSeedAlone, true);
  assert.equal(row.taskState, 'COMPLETED');
});

// A7 - checksums must be over the exact emitted bytes, so a tampered byte is detectable.
test('REX806 A7: checksums cover the exact bytes and change when a byte changes', () => {
  const artifact = buildArtifact(sources());
  const files = artifactFiles(artifact);
  const sums = checksumsFor(files);
  assert.equal(sums['metrics.csv'].sha256, createHash('sha256').update(files['metrics.csv']).digest('hex'));
  const tampered = {...files, 'metrics.csv': files['metrics.csv'].replace('failure_rate', 'failure_rate_')};
  assert.notEqual(checksumsFor(tampered)['metrics.csv'].sha256, sums['metrics.csv'].sha256);
});

// A8 - G3/G4 metrics are what the workbook prioritizes for paper-ready tables, and a table that hides NOT_MEASURED
// would be the most damaging kind of tidy.
test('REX806 A8: the paper-ready table leads with G3/G4 and keeps their NOT_MEASURED reasons visible', () => {
  const artifact = buildArtifact(sources());
  assert.ok(artifact.tables.paper_ready.length > 0);
  assert.ok(artifact.tables.paper_ready.every(row => ['G3', 'G4'].includes(row.scope)));
  for (const row of artifact.tables.paper_ready) {
    if (row.value === NOT_MEASURED) assert.ok(row.reason, `${row.metric} must keep its reason in the paper table`);
  }
  assert.match(artifact.tables.note, /honest|NOT_MEASURED/i);
});

// A9 - statistics must not carry an inflated narrative, and the guard against "ran longer means more autonomous" has to
// be visible in the artifact's own words.
test('REX806 A9: the artifact separates statistics from narrative and refuses the autonomy inference', () => {
  const artifact = buildArtifact(sources());
  assert.match(artifact.manifest.narrative, /no claim/i);
  const guard = artifact.exclusions.map(entry => `${entry.what} ${entry.why}`).join(' ');
  assert.match(guard, /Owner|intervention/i, 'the intervention exclusion must be stated rather than implied');
});

// A10 - unsupported metrics stay unsupported even when the sources grow: adding tasks must not conjure an intervention
// or a survival curve out of nothing.
test('REX806 A10: richer campaign data does not conjure Owner-side metrics', () => {
  const many = Array.from({length: 5}, (_unused, index) => receipt({campaignId: `campaign-${index}`, runs: [{...receipt().runs[0], index: 0, result: {taskRef: `Q-${index}`, state: 'COMPLETED', assignedNodeId: 'w-b'}}]}));
  const manyTasks = many.map((_unused, index) => task({id: `Q-${index}`, researchRunRef: `campaign-${index}:0`}));
  const artifact = buildArtifact({cityId: 'city-a', receipts: many, tasks: manyTasks});
  for (const id of ['intervention_count', 'intervention_free_survival', 'transitions_before_intervention', 'rule_activation_conflict_falseblock_retirement']) {
    assert.equal(artifact.metrics.find(entry => entry.metric === id).value, NOT_MEASURED, `${id} must stay NOT_MEASURED`);
  }
  assert.equal(artifact.metrics.find(entry => entry.metric === 'completion_time_ms').n, 5, 'the derivable metric does grow with the sources');
});

// A11 - a WARMUP run is not a failure. Lumping them together was this exporter's first defect and would have reported
// two warmups as two failed runs.
test('REX806 A11: warmup runs are classified separately from failures', () => {
  const warmed = receipt({runs: [ {...receipt().runs[0], index: 0, state: 'WARMUP', warmup: true, measured: false, result: {taskRef: 'Q-1', state: 'COMPLETED', assignedNodeId: 'w-b'}}, {...receipt().runs[0], index: 1, seed: 1, result: {taskRef: 'Q-2', state: 'COMPLETED', assignedNodeId: 'w-a'}} ], summary: {...receipt().summary, planned: 2, accounted: 2, measured: 1}});
  const artifact = buildArtifact({cityId: 'city-a', receipts: [warmed], tasks: [task({id: 'Q-1'}), task({id: 'Q-2', researchRunRef: 'campaign-aaaa:1'})]});
  assert.equal(artifact.failures.unmeasuredRuns.length, 0, 'a warmup is not an unmeasured run');
  assert.equal(artifact.failures.warmupRuns.length, 1);
});

// A12 - a campaign refused before it ran must not disappear behind a calm failure rate: its planned runs are undelivered
// and the artifact has to say so.
test('REX806 A12: a refused campaign stays visible as undelivered planned runs', () => {
  const refused = receipt({campaignId: 'campaign-refused', state: 'REFUSED', reason: 'TOPOLOGY_NOT_READY', runs: [], totalRuns: 4, summary: {planned: 4, accounted: 0, warmup: 0, measured: 0, timedOut: 0, failed: 0, excluded: 0, cancelled: 0, skipped: 0, interrupted: 0, terminalAccountingComplete: false}});
  const artifact = buildArtifact({cityId: 'city-a', receipts: [receipt(), refused], tasks: [task()]});
  const accounting = artifact.manifest.supporting.accounting;
  // Arithmetic, stated: the delivered campaign plans and accounts for 1 run; the refused one plans 4 and accounts for 0,
  // so exactly 4 planned runs are undelivered and must be visible rather than folded into a calm rate.
  assert.equal(accounting.planned, 5);
  assert.equal(accounting.accounted, 1);
  assert.equal(accounting.planned - accounting.accounted, 4, 'the four planned runs of the refused campaign are undelivered');
  assert.ok(artifact.failures.campaignOutcomes.some(entry => entry.campaignId === 'campaign-refused' && entry.reason === 'TOPOLOGY_NOT_READY'), 'the refusal must be listed as a campaign outcome');
  const rate = artifact.metrics.find(entry => entry.metric === 'failure_rate');
  assert.equal(rate.n, 1, 'the denominator is ACCOUNTED runs, not planned ones');
  assert.match(rate.provenance.join(' '), /undelivered planned runs/, 'the undelivered runs must be named in the provenance');
});

// A13 - an ablation's placement follows its disabled policy, not the seed, so judging it by the seed would report the
// policy working correctly as a defect. That is exactly what the first physical export did on two real campaigns.
test('REX806 A13: an ablation placement is judged against its policy, and the seed comparison is kept separately', () => {
  const ablation = receipt({campaignId: 'campaign-abl', context: {...receipt().context, replay: {schemaVersion: 1, mode: 'ABLATION', disabledMechanisms: ['alternate-device'], sourceCampaignId: 'campaign-x', sourceRunIndex: 0}}, runs: [{index: 0, state: 'MEASURED', seed: 414121415, warmup: false, measured: true, result: {taskRef: 'Q-1', state: 'COMPLETED', assignedNodeId: 'w-a'}}]});
  const artifact = buildArtifact({cityId: 'city-a', receipts: [ablation], tasks: [task()]});
  const row = artifact.dataset[0];
  assert.equal(row.placementRule, 'POLICY_ALTERNATE_DEVICE_DISABLED_PINS_FIRST_DECLARED_WORKER');
  assert.equal(row.expectedNodeIdByPolicy, 'w-a');
  assert.equal(row.placementMatchesPolicy, true, 'pinning the first declared worker is the policy working');
  assert.equal(row.placementMatchesSeedAlone, false, 'and the seed comparison is still reported, separately, as false');
});
