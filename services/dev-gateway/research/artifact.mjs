// Research artifact export: turn a set of REAL campaigns into an inspectable package.
//
// The workbook for this task names eleven sections (manifest, environment, topology, raw pointers, normalized dataset,
// metrics.csv, failures, exclusions, tables, reproduction, checksums) and about two dozen metrics, and it is explicit
// about what must NOT happen:
//
//   - a metric that cannot be derived must be NOT_MEASURED, never a fabricated zero;
//   - an intervention count of 0 is only allowed when a complete window was observed, otherwise the truth is "unknown";
//   - "it ran longer" is not autonomy, so idle loops, duplicate work and blocked polling must be classified separately;
//   - a survival curve with too few episodes exports the raw censored episodes instead of a confident curve;
//   - statistics stay separate from narrative, and nothing here may inflate a conclusion.
//
// So every metric row carries EITHER a value with provenance pointers into the exported records, OR the literal
// NOT_MEASURED with the reason it is unavailable. There is no third state, and no default of zero.
import {createHash} from 'node:crypto';

export const ARTIFACT_SCHEMA_VERSION = 1;
export const NOT_MEASURED = 'NOT_MEASURED';

export const ARTIFACT_CODES = Object.freeze({
  NO_SOURCE: 'ARTIFACT_NO_SOURCE',
  UNKNOWN_SECTION: 'ARTIFACT_UNKNOWN_SECTION',
  INVALID_SOURCE: 'ARTIFACT_INVALID_SOURCE',
});

export class ArtifactError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
    this.detail = detail;
    this.status = code === ARTIFACT_CODES.NO_SOURCE ? 422 : 400;
  }
}

// Every metric the workbook names, with the scope the guard assigns it. `derivableFrom` says which exported record
// could carry it; when that record is absent from the sources, the metric is NOT_MEASURED with that stated reason.
export const METRIC_SPEC = Object.freeze([
  {id: 'completion_time_ms', scope: 'G1', derivableFrom: 'canonical task timestamps of measured runs'},
  {id: 'recovery_time_ms', scope: 'G1', derivableFrom: 'fault/recovery receipts'},
  {id: 'handoff_time_ms', scope: 'G1', derivableFrom: 'handoff transitions between workers'},
  {id: 'failure_rate', scope: 'G1', derivableFrom: 'campaign run states'},
  {id: 'intervention_count', scope: 'G3', derivableFrom: 'a complete observed window of Owner actions'},
  {id: 'retry_count', scope: 'G2', derivableFrom: 'explicit retry events'},
  {id: 'duplicate_execution_count', scope: 'G1', derivableFrom: 'canonical tasks per run reference'},
  {id: 'convergence_missing_event_count', scope: 'G2', derivableFrom: 'run references without a canonical task'},
  {id: 'transitions_before_intervention', scope: 'G3', derivableFrom: 'task transitions plus Owner actions'},
  {id: 'time_to_first_intervention_ms', scope: 'G3', derivableFrom: 'a first Owner action'},
  {id: 'steps_to_first_intervention', scope: 'G3', derivableFrom: 'a first Owner action'},
  {id: 'intervention_free_survival', scope: 'G3', derivableFrom: 'censored intervention episodes'},
  {id: 'intervention_cause_taxonomy', scope: 'G3', derivableFrom: 'Owner actions with causes'},
  {id: 'task_pool_drain_before_intervention', scope: 'G3', derivableFrom: 'task pool plus Owner actions'},
  {id: 'control_plane_mismatch_count', scope: 'G4', derivableFrom: 'control-plane records reconciled against reality'},
  {id: 'control_plane_reconciliation_time_ms', scope: 'G4', derivableFrom: 'reconciliation episodes'},
  {id: 'exposure_lag_ms', scope: 'G4', derivableFrom: 'implementation/wiring/reachability/intent timestamps'},
  {id: 'intent_lag_ms', scope: 'G4', derivableFrom: 'implementation/wiring/reachability/intent timestamps'},
  {id: 'registry_localization_cost', scope: 'G4', derivableFrom: 'registry-assisted localization episodes'},
  {id: 'high_value_owner_decision_count', scope: 'G3', derivableFrom: 'Owner decisions with a stated value'},
  {id: 'avoidable_technical_escalation_count', scope: 'G3', derivableFrom: 'escalations classified as avoidable'},
  {id: 'repeat_clarification_count', scope: 'G3', derivableFrom: 'repeated clarifications'},
  {id: 'escalation_to_autonomy_resumed_ms', scope: 'G3', derivableFrom: 'escalation episodes with a resume time'},
  {id: 'batchable_escalation_count', scope: 'G3', derivableFrom: 'escalation bursts'},
  {id: 'rule_activation_conflict_falseblock_retirement', scope: 'G4', derivableFrom: 'rule lifecycle observations'},
  {id: 'textually_clean_semantic_failure_count', scope: 'G4', derivableFrom: 'integration episodes that merged cleanly but failed semantically'},
  {id: 'independently_green_integrated_failure_count', scope: 'G4', derivableFrom: 'components green alone that failed together'},
]);

const copy = value => JSON.parse(JSON.stringify(value));
const median = values => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

// Derived only from records the caller actually handed over. Each row names the metric, its scope, the value or
// NOT_MEASURED, the reason when unavailable, and pointers into the exported records that a reviewer can re-read.
function deriveMetrics({receipts, tasks, events, comparisons}) {
  const rows = [];
  const add = (id, {value = NOT_MEASURED, reason = null, n = null, provenance = [], scope = null}) => {
    const spec = METRIC_SPEC.find(entry => entry.id === id);
    if (!spec) throw new ArtifactError(ARTIFACT_CODES.UNKNOWN_SECTION, `metric ${id} is not in the workbook's metric list`);
    // A value without provenance is not evidence, and NOT_MEASURED without a reason is not honest; the guard here is
    // what keeps a fabricated zero from ever reaching the CSV.
    if (value !== NOT_MEASURED && provenance.length === 0) throw new ArtifactError(ARTIFACT_CODES.INVALID_SOURCE, `metric ${id} has a value but no provenance pointer`);
    if (value === NOT_MEASURED && !reason) throw new ArtifactError(ARTIFACT_CODES.INVALID_SOURCE, `metric ${id} is NOT_MEASURED without a reason`);
    rows.push({metric: id, scope: scope ?? spec.scope, value, reason, n, provenance});
  };

  const taskById = new Map((tasks ?? []).map(task => [task.id, task]));
  const runs = (receipts ?? []).flatMap(receipt => (receipt.runs ?? []).map(run => ({receipt, run})));

  // --- completion time: real task timestamps, only for runs that were actually measured to completion --------------
  const completed = runs.filter(({run}) => run.state === 'MEASURED' && run.result?.taskRef && taskById.get(run.result.taskRef)?.state === 'COMPLETED');
  const durations = completed.map(({run}) => {
    const task = taskById.get(run.result.taskRef);
    return Date.parse(task.updatedAt) - Date.parse(task.createdAt);
  }).filter(ms => Number.isFinite(ms) && ms >= 0);
  if (durations.length > 0) {
    add('completion_time_ms', {value: median(durations), n: durations.length, provenance: completed.map(({receipt, run}) => `${receipt.campaignId}:${run.index} -> ${run.result.taskRef}`)});
  } else {
    add('completion_time_ms', {reason: 'no run in the provided sources reached a MEASURED completion with a canonical task'});
  }

  // --- failure rate: over ACCOUNTED runs, with the window stated, and the undelivered planned runs made visible ----
  // The first version divided failed+timedOut by the sum of PLANNED runs, so eight planned runs that never ran at all -
  // two campaigns refused with TOPOLOGY_NOT_READY - sat in the denominator while contributing nothing to the numerator,
  // and the artifact reported a calm 0. That is the "looks safe while information is missing" shape this programme keeps
  // finding, so the accounting is now explicit and the undelivered runs are named.
  const accounting = receipts.reduce((totals, receipt) => {
    const summary = receipt.summary ?? {};
    totals.planned += summary.planned ?? 0;
    totals.accounted += summary.accounted ?? 0;
    totals.measured += summary.measured ?? 0;
    totals.failed += summary.failed ?? 0;
    totals.timedOut += summary.timedOut ?? 0;
    totals.excluded += summary.excluded ?? 0;
    totals.cancelled += summary.cancelled ?? 0;
    totals.skipped += summary.skipped ?? 0;
    totals.interrupted += summary.interrupted ?? 0;
    if ((summary.accounted ?? 0) === 0 && (summary.planned ?? 0) > 0) totals.undeliveredCampaigns.push({campaignId: receipt.campaignId, state: receipt.state, reason: receipt.reason ?? null, planned: summary.planned ?? 0});
    return totals;
  }, {planned: 0, accounted: 0, measured: 0, failed: 0, timedOut: 0, excluded: 0, cancelled: 0, skipped: 0, interrupted: 0, undeliveredCampaigns: []});
  const unproductive = accounting.failed + accounting.timedOut;
  if (accounting.accounted > 0) {
    add('failure_rate', {value: Number((unproductive / accounting.accounted).toFixed(6)), n: accounting.accounted, provenance: [`accounted=${accounting.accounted} failed=${accounting.failed} timedOut=${accounting.timedOut} over terminal campaigns: ${receipts.map(receipt => receipt.campaignId).join(', ')}`, `undelivered planned runs=${accounting.planned - accounting.accounted} from ${accounting.undeliveredCampaigns.map(entry => `${entry.campaignId}(${entry.reason})`).join(', ') || 'none'}`]});
  } else {
    add('failure_rate', {reason: 'no campaign in the provided sources accounted for a single run, so a rate would have no denominator'});
  }

  // --- duplicate execution: the same run reference must never own two canonical tasks -----------------------------
  const refToTasks = new Map();
  for (const task of tasks ?? []) {
    if (!task.researchRunRef) continue;
    refToTasks.set(task.researchRunRef, [...(refToTasks.get(task.researchRunRef) ?? []), task.id]);
  }
  const duplicated = [...refToTasks.entries()].filter(([, ids]) => ids.length > 1);
  add('duplicate_execution_count', {value: duplicated.length, n: refToTasks.size, provenance: duplicated.length > 0 ? duplicated.map(([ref, ids]) => `${ref} -> ${ids.join(',')}`) : [`${refToTasks.size} run references, each owned by exactly one canonical task`]});

  // --- convergence: a measured run whose canonical task is missing from the export is a missing event --------------
  const measured = runs.filter(({run}) => run.state === 'MEASURED');
  const dangling = measured.filter(({run}) => !run.result?.taskRef || !taskById.has(run.result.taskRef));
  add('convergence_missing_event_count', {value: dangling.length, n: measured.length, provenance: dangling.length > 0 ? dangling.map(({receipt, run}) => `${receipt.campaignId}:${run.index} -> ${run.result?.taskRef ?? '<missing task reference>'}`) : [`${measured.length} measured runs all resolved to a canonical task in the export`]});

  // --- replay coverage: what the replay engine actually produced, from the receipts' own lineage -------------------
  const replays = receipts.filter(receipt => receipt.context?.replay);
  const ablation = replays.filter(receipt => receipt.context.replay.mode === 'ABLATION');
  add('retry_count', {reason: 'campaign repetitions are not retries and no retry event is recorded in these sources; counting repetitions here would inflate an autonomy number'});
  add('recovery_time_ms', {reason: 'no fault or recovery receipt is present in the provided sources'});
  add('handoff_time_ms', {reason: 'no handoff transition between workers appears in these sources; placements were seed-selected, not handed off'});

  // --- Owner-side metrics: not derivable from canonical City records at all, and the guard forbids guessing ---------
  add('intervention_count', {reason: 'Owner actions are not represented in the canonical City records, so no complete intervention window can be claimed; the guard forbids reporting 0 for an unknown window'});
  add('transitions_before_intervention', {reason: 'requires Owner actions, which these sources do not carry'});
  add('time_to_first_intervention_ms', {reason: 'requires a first Owner action, which these sources do not carry'});
  add('steps_to_first_intervention', {reason: 'requires a first Owner action, which these sources do not carry'});
  add('intervention_free_survival', {reason: 'no censored intervention episodes exist in these sources; the guard says export raw episodes rather than draw a curve, and there are none to export'});
  add('intervention_cause_taxonomy', {reason: 'requires Owner actions with stated causes'});
  add('task_pool_drain_before_intervention', {reason: 'requires Owner actions alongside the task pool'});
  add('high_value_owner_decision_count', {reason: 'requires Owner decisions with a stated value'});
  add('avoidable_technical_escalation_count', {reason: 'requires escalations classified as avoidable'});
  add('repeat_clarification_count', {reason: 'requires clarification episodes'});
  add('escalation_to_autonomy_resumed_ms', {reason: 'requires escalation episodes with a resume time'});
  add('batchable_escalation_count', {reason: 'requires escalation bursts, which these sources do not carry'});

  // --- control-plane and rule metrics need records this exporter was not given ------------------------------------
  add('control_plane_mismatch_count', {reason: 'requires control-plane records reconciled against observed reality; this exporter was given city records only'});
  add('control_plane_reconciliation_time_ms', {reason: 'requires reconciliation episodes, which are not City records'});
  add('exposure_lag_ms', {reason: 'requires implementation/wiring/reachability/intent timestamps; the trace records in these sources carry null provenance fields'});
  add('intent_lag_ms', {reason: 'requires the same transition timestamps, which are absent'});
  add('registry_localization_cost', {reason: 'requires registry-assisted localization episodes'});
  add('rule_activation_conflict_falseblock_retirement', {reason: 'requires rule lifecycle observations, which are not City records'});
  add('textually_clean_semantic_failure_count', {reason: 'requires integration episodes; these are programme records rather than City campaign data, and v1 of this exporter is deliberately campaign-scoped'});
  add('independently_green_integrated_failure_count', {reason: 'same integration-episode source as above'});

  return {
    rows,
    supporting: {
      campaigns: receipts.length,
      replays: replays.length,
      ablations: ablation.length,
      comparisonsProvided: (comparisons ?? []).length,
      accounting,
    },
  };
}

export function buildArtifact({cityId, generatedAt, environment = {}, topology = {}, receipts = [], sourceReadFailures = [], tasks = [], events = [], traceRecords = [], experiments = [], comparisons = []} = {}) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    throw new ArtifactError(ARTIFACT_CODES.NO_SOURCE, 'an artifact must be built from at least one real campaign receipt; an empty export would be a shape with nothing behind it');
  }
  const incomplete = receipts.filter(receipt => !receipt.campaignId || !Array.isArray(receipt.runs));
  if (incomplete.length > 0) throw new ArtifactError(ARTIFACT_CODES.INVALID_SOURCE, `${incomplete.length} receipt(s) are unreadable as campaign receipts`, incomplete.map(receipt => receipt?.campaignId ?? null));

  const {rows, supporting} = deriveMetrics({receipts, tasks, events, comparisons});

  // The normalized dataset is one row per run: the unit a reviewer recomputes from, with the pointers back to the raw
  // receipt and the canonical task.
  //
  // Placement is judged against the EFFECTIVE policy rather than against the seed alone. An ablation with
  // alternate-device disabled deliberately pins the first declared worker, so comparing it to the seed predicts a
  // mismatch that is the policy working correctly - the first version of this column reported exactly that on the two
  // physical ablation campaigns, which would have read as a broken seed rule.
  const dataset = receipts.flatMap(receipt => (receipt.runs ?? []).map(run => {
    const task = (tasks ?? []).find(candidate => candidate.id === run.result?.taskRef) ?? null;
    const workers = receipt.context?.manifest?.workers ?? [];
    const ablationPolicy = receipt.context?.replay?.mode === 'ABLATION' && (receipt.context.replay.disabledMechanisms ?? []).includes('alternate-device');
    const placementRule = ablationPolicy ? 'POLICY_ALTERNATE_DEVICE_DISABLED_PINS_FIRST_DECLARED_WORKER' : 'SEEDED_WORKER_SELECTION';
    const expected = workers.length === 0 ? null : (ablationPolicy ? workers[0] : workers[run.seed % workers.length]);
    const assigned = run.result?.assignedNodeId ?? null;
    return {
      campaignId: receipt.campaignId,
      scenarioId: receipt.scenarioId,
      experimentId: receipt.context?.experimentId ?? null,
      index: run.index,
      state: run.state,
      measured: run.measured === true,
      warmup: run.warmup === true,
      seed: run.seed,
      assignedNodeId: assigned,
      placementRule,
      expectedNodeIdByPolicy: expected,
      placementMatchesPolicy: expected === null ? null : expected === assigned,
      placementMatchesSeedAlone: workers.length === 0 ? null : workers[run.seed % workers.length] === assigned,
      taskRef: run.result?.taskRef ?? null,
      taskState: task?.state ?? null,
      taskCreatedAt: task?.createdAt ?? null,
      taskUpdatedAt: task?.updatedAt ?? null,
      durationMs: run.durationMs ?? null,
      replayMode: receipt.context?.replay?.mode ?? null,
      rawPointer: `receipt:${receipt.campaignId}#runs[${run.index}]`,
    };
  }));

  // Runs that did not measure are classified rather than lumped together: a WARMUP run is not a failure, and a campaign
  // refused before it started has no runs to fail. Reporting warmups as failures was this exporter's first defect.
  const unmeasuredRuns = (receipts ?? []).flatMap(receipt => (receipt.runs ?? [])
    .filter(run => run.state !== 'MEASURED' && run.warmup !== true)
    .map(run => ({campaignId: receipt.campaignId, index: run.index, state: run.state, reason: run.reason ?? null, rawPointer: `receipt:${receipt.campaignId}#runs[${run.index}]`})));
  const warmupRuns = (receipts ?? []).flatMap(receipt => (receipt.runs ?? [])
    .filter(run => run.warmup === true)
    .map(run => ({campaignId: receipt.campaignId, index: run.index, state: run.state, rawPointer: `receipt:${receipt.campaignId}#runs[${run.index}]`})));
  const campaignOutcomes = (receipts ?? [])
    .filter(receipt => receipt.reason && receipt.reason !== 'REPETITIONS_FINISHED')
    .map(receipt => ({campaignId: receipt.campaignId, state: receipt.state, reason: receipt.reason, planned: receipt.summary?.planned ?? 0, accounted: receipt.summary?.accounted ?? 0, rawPointer: `receipt:${receipt.campaignId}`}));
  const failures = {unmeasuredRuns, warmupRuns, campaignOutcomes};
  // A downloaded partial study must carry the known source loss itself; stderr is not part of its provenance.
  // Omit the field for a complete source set, preserving existing complete-package reproduction bytes.
  if (sourceReadFailures.length) failures.sourceReadFailures = copy(sourceReadFailures);

  const exclusions = [
    {what: 'Owner-side metrics', why: 'the canonical City records do not represent Owner actions, so no intervention window can be claimed', wouldRequire: 'an Owner-action log with a declared observation window'},
    {what: 'integration-episode metrics', why: 'those are programme records rather than campaign data, and this exporter is campaign-scoped in v1', wouldRequire: 'a programme-record source with merge and test outcomes'},
    {what: 'fault and recovery metrics', why: 'no fault receipt is present in the provided sources', wouldRequire: 'a fault-injection receipt set'},
  ];

  const tables = {
    paper_ready: rows.filter(row => ['G3', 'G4'].includes(row.scope)).map(row => ({metric: row.metric, scope: row.scope, value: row.value, reason: row.reason})),
    supporting: rows.filter(row => ['G1', 'G2'].includes(row.scope)).map(row => ({metric: row.metric, scope: row.scope, value: row.value, n: row.n})),
    note: 'G3/G4 metrics are listed first because the workbook prioritizes them for paper-ready tables; in this export they are NOT_MEASURED with reasons, which is the honest state rather than a gap to be filled with inference.',
  };

  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    manifest: {
      artifactId: `artifact-${cityId ?? 'unknown-city'}-${(receipts.length)}-campaigns`,
      cityId: cityId ?? null,
      generatedAt: generatedAt ?? null,
      campaignIds: receipts.map(receipt => receipt.campaignId),
      runCount: dataset.length,
      measuredRuns: dataset.filter(row => row.measured).length,
      metricsReported: rows.filter(row => row.value !== NOT_MEASURED).length,
      metricsNotMeasured: rows.filter(row => row.value === NOT_MEASURED).length,
      metricCatalogueSize: METRIC_SPEC.length,
      supporting,
      ...(sourceReadFailures.length?{sourceCoverage:{status:'PARTIAL',knownSourceLossCount:sourceReadFailures.length}}:{}),
      narrative: 'Statistics only. No claim is made here about autonomy, performance or causality; duration deltas do not establish performance and NOT_MEASURED is not zero.',
    },
    environment: copy(environment),
    topology: copy(topology),
    rawPointers: {
      receipts: receipts.map(receipt => `receipt:${receipt.campaignId}`),
      canonicalTasks: (tasks ?? []).map(task => `task:${task.id}`),
      traceRecords: (traceRecords ?? []).map(record => `trace:${record.eventId ?? record.sourceSeq ?? 'unknown'}`),
      experiments: (experiments ?? []).map(experiment => `experiment:${experiment.experimentId ?? experiment}`),
      events: (events ?? []).map(event => `event:${event.id ?? event.seq ?? 'unknown'}`),
    },
    dataset,
    metrics: rows,
    failures,
    exclusions,
    tables,
    reproduction: {
      steps: [
        'read the raw pointers listed in rawPointers from the City that produced them (owner credential required)',
        'rebuild the normalized dataset by joining each receipt run to its canonical task on result.taskRef',
        'recompute each reported metric from the dataset: completion_time_ms is the median of task updatedAt-createdAt over MEASURED runs whose task is COMPLETED; failure_rate is (failed+timedOut)/planned summed over receipts; duplicate_execution_count counts run references owned by more than one task; convergence_missing_event_count counts measured runs whose task is absent',
        'compare the recomputed values with metrics.csv and confirm every NOT_MEASURED row against its stated reason',
        'verify checksums.json against the emitted bytes',
      ],
      command: 'node --test tests/rex806-artifact.test.mjs  (structural checks) and the exporter CLI for a live City',
    },
  };
}

export function metricsCsv(artifact) {
  const escape = value => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = 'metric,scope,value,reason,n,provenance';
  const lines = artifact.metrics.map(row => [row.metric, row.scope, row.value, row.reason ?? '', row.n ?? '', (row.provenance ?? []).join(' | ')].map(escape).join(','));
  return [header, ...lines].join('\n') + '\n';
}

// Every file the workbook names, as text. The exporter writes these and then a checksums file over their exact bytes.
export function artifactFiles(artifact) {
  return {
    'manifest.json': JSON.stringify(artifact.manifest, null, 2) + '\n',
    'environment.json': JSON.stringify(artifact.environment, null, 2) + '\n',
    'topology.json': JSON.stringify(artifact.topology, null, 2) + '\n',
    'raw-pointers.json': JSON.stringify(artifact.rawPointers, null, 2) + '\n',
    'normalized-dataset.json': JSON.stringify({rows: artifact.dataset}, null, 2) + '\n',
    'metrics.csv': metricsCsv(artifact),
    'failures.json': JSON.stringify({failures: artifact.failures}, null, 2) + '\n',
    'exclusions.json': JSON.stringify({exclusions: artifact.exclusions}, null, 2) + '\n',
    'tables.json': JSON.stringify(artifact.tables, null, 2) + '\n',
    'reproduction.json': JSON.stringify(artifact.reproduction, null, 2) + '\n',
  };
}

export function checksumsFor(files) {
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [name, {bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex')}]));
}
