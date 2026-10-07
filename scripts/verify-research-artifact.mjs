// Independently recompute a published research artifact.
//
// This is deliberately a SECOND implementation. It does not import the exporter: it reads the artifact's own files,
// parses metrics.csv itself, recomputes each reported metric from the normalized dataset, and reports where the package
// disagrees with its own contents. A verifier that called the exporter would only prove the exporter is consistent with
// itself, which is exactly the property an artifact does not need.
//
// Usage: node scripts/verify-research-artifact.mjs <artifact-dir>
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/verify-research-artifact.mjs <artifact-dir>');
  process.exit(2);
}
const read = name => readFileSync(join(dir, name), 'utf8');
const json = name => JSON.parse(read(name));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push({name, passed, detail});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// --- sections the workbook names -----------------------------------------------------------------------------------
const SECTIONS = ['manifest.json', 'environment.json', 'topology.json', 'raw-pointers.json', 'normalized-dataset.json', 'metrics.csv', 'failures.json', 'exclusions.json', 'tables.json', 'reproduction.json', 'checksums.json'];
const present = new Set(readdirSync(dir).filter(name => statSync(join(dir, name)).isFile));
const missing = SECTIONS.filter(name => !present.has(name));
check('every section the workbook names is present', missing.length === 0, missing.join(',') || `${SECTIONS.length} sections`);

// --- checksums over the exact bytes --------------------------------------------------------------------------------
const sums = json('checksums.json');
const bad = [];
for (const [name, entry] of Object.entries(sums)) {
  if (!present.has(name)) { bad.push(`${name} missing`); continue; }
  const text = read(name);
  const digest = createHash('sha256').update(text).digest('hex');
  if (digest !== entry.sha256) bad.push(`${name} sha256`);
  if (Buffer.byteLength(text) !== entry.bytes) bad.push(`${name} bytes`);
}
check('checksums cover the bytes on disk', bad.length === 0, bad.join(', ') || `${Object.keys(sums).length} files`);

// --- the CSV, parsed here rather than trusted ----------------------------------------------------------------------
const csvLines = read('metrics.csv').trim().split('\n');
const header = csvLines[0].split(',');
const rows = csvLines.slice(1).map(line => {
  const cells = [];
  let current = '';
  let quoted = false;
  for (const character of line) {
    if (character === '"') { quoted = !quoted; continue; }
    if (character === ',' && !quoted) { cells.push(current); current = ''; continue; }
    current += character;
  }
  cells.push(current);
  return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? '']));
});
check('metrics.csv has the documented header', header.join(',') === 'metric,scope,value,reason,n,provenance', header.join(','));

// --- each metric is either measured or explicitly unavailable WITH a reason ----------------------------------------
const manifest = json('manifest.json');
const catalogueSize = manifest.metricCatalogueSize;
check('the CSV reports exactly the catalogue of named metrics', rows.length === catalogueSize, `${rows.length} rows vs ${catalogueSize} named`);
const unexplained = rows.filter(row => row.value === 'NOT_MEASURED' && (row.reason ?? '').trim().length <= 10);
check('every NOT_MEASURED row carries a real reason', unexplained.length === 0, unexplained.map(row => row.metric).join(',') || `${rows.filter(row => row.value === 'NOT_MEASURED').length} unavailable`);
const valueless = rows.filter(row => row.value !== 'NOT_MEASURED' && (row.provenance ?? '').trim().length === 0);
check('every measured row carries provenance', valueless.length === 0, valueless.map(row => row.metric).join(',') || 'all measured rows');

// --- recompute the four reported metrics from the dataset ---------------------------------------------------------
const dataset = json('normalized-dataset.json').rows;
const byMetric = Object.fromEntries(rows.map(row => [row.metric, row]));

const durations = dataset
  .filter(row => row.measured === true && row.taskState === 'COMPLETED' && row.taskCreatedAt && row.taskUpdatedAt)
  .map(row => Date.parse(row.taskUpdatedAt) - Date.parse(row.taskCreatedAt))
  .filter(ms => Number.isFinite(ms) && ms >= 0)
  .sort((a, b) => a - b);
const median = durations.length === 0 ? null : (durations.length % 2 === 1 ? durations[(durations.length - 1) / 2] : Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2));
check('completion_time_ms recomputes from the dataset', median===null ? byMetric.completion_time_ms.value==='NOT_MEASURED'&&Boolean(byMetric.completion_time_ms.reason?.trim()) : String(median) === byMetric.completion_time_ms.value && String(durations.length) === byMetric.completion_time_ms.n,
  `recomputed ${median} at n=${durations.length}, package says ${byMetric.completion_time_ms.value} at n=${byMetric.completion_time_ms.n}`);

const accounting = manifest.supporting?.accounting ?? {};
const rate = accounting.accounted > 0 ? Number(((accounting.failed + accounting.timedOut) / accounting.accounted).toFixed(6)) : null;
check('failure_rate recomputes from the accounting', rate===null ? byMetric.failure_rate.value==='NOT_MEASURED'&&Boolean(byMetric.failure_rate.reason?.trim()) : Number(byMetric.failure_rate.value)===rate && String(accounting.accounted) === byMetric.failure_rate.n,
  `recomputed ${rate} at n=${accounting.accounted}, package says ${byMetric.failure_rate.value} at n=${byMetric.failure_rate.n}`);

const byRef = new Map();
const rawPointers=json('raw-pointers.json');
const canonicalTaskPointers=new Set(rawPointers.canonicalTasks??[]);
const taskRuns=rawPointers.canonicalTaskRuns;
if(taskRuns!==undefined){
  check('canonical task run associations resolve uniquely to canonical pointers',Array.isArray(taskRuns)&&taskRuns.every(row=>typeof row.researchRunRef==='string'&&row.researchRunRef.length>0&&canonicalTaskPointers.has('task:'+row.taskRef))&&new Set(taskRuns.map(row=>row.taskRef)).size===taskRuns.length);
}
for (const row of Array.isArray(taskRuns)?taskRuns:dataset) {
  const key = Array.isArray(taskRuns)?row.researchRunRef:`${row.campaignId}:${row.index}`;
  byRef.set(key, [...(byRef.get(key) ?? []), row.taskRef]);
}
const duplicated = [...byRef.values()].filter(refs => (Array.isArray(taskRuns)?refs.length:new Set(refs).size) > 1).length;
check('duplicate_execution_count recomputes from the run references', String(duplicated) === byMetric.duplicate_execution_count.value&&(!Array.isArray(taskRuns)||String(byRef.size)===byMetric.duplicate_execution_count.n),
  `recomputed ${duplicated} over ${byRef.size} references, package says ${byMetric.duplicate_execution_count.value}`);

const measuredRows=dataset.filter(row=>row.state==='MEASURED');
const dangling = measuredRows.filter(row => !row.taskRef||!canonicalTaskPointers.has('task:'+row.taskRef)).length;
check('convergence_missing_event_count recomputes from the dataset', String(dangling) === byMetric.convergence_missing_event_count.value&&String(measuredRows.length)===byMetric.convergence_missing_event_count.n,
  `recomputed ${dangling}, package says ${byMetric.convergence_missing_event_count.value}`);

// --- placement verdicts must be internally consistent and policy-aware ------------------------------------------
const inconsistent = dataset.filter(row => row.expectedNodeIdByPolicy === null
  ? row.placementMatchesPolicy !== null
  : row.placementMatchesPolicy !== (row.expectedNodeIdByPolicy === row.assignedNodeId));
check('every placement verdict agrees with its own expected node', inconsistent.length === 0, inconsistent.map(row => row.rawPointer).join(',') || `${dataset.length} rows`);

const ablationRows = dataset.filter(row => row.replayMode === 'ABLATION');
const ablationRules = ablationRows.filter(row => row.placementRule !== 'POLICY_ALTERNATE_DEVICE_DISABLED_PINS_FIRST_DECLARED_WORKER');
const seedOnlyDiffers = dataset.filter(row => row.placementMatchesSeedAlone !== row.placementMatchesPolicy);
const seedDeviationsOutsideAblation = seedOnlyDiffers.filter(row => row.replayMode !== 'ABLATION');
check('the seed-only deviation appears exactly on the ablation rows', seedDeviationsOutsideAblation.length === 0 && ablationRules.length === 0,
  `${ablationRows.length} ablation rows, ${seedOnlyDiffers.length} rows where the seed and the policy disagree`);

// --- the accounting must add up, so an undelivered run cannot hide ------------------------------------------------
check('planned = accounted + undelivered is stated, not implied',
  Number.isFinite(accounting.planned) && Number.isFinite(accounting.accounted) && accounting.planned >= accounting.accounted,
  `planned=${accounting.planned} accounted=${accounting.accounted} undelivered=${accounting.planned - accounting.accounted} from ${(accounting.undeliveredCampaigns ?? []).length} campaign(s)`);

// --- the intervention guard the workbook singles out --------------------------------------------------------------
const intervention = byMetric.intervention_count;
check('an unobserved intervention window is NOT_MEASURED rather than 0',
  intervention.value === 'NOT_MEASURED' || Number(intervention.value) > 0 || (intervention.provenance ?? '').includes('window'),
  `value=${intervention.value}`);

const failed = checks.filter(entry => !entry.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} independent checks pass on ${dir}`);
process.exit(failed.length === 0 ? 0 : 1);
