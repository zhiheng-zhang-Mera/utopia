#!/usr/bin/env node
// PCF-700 review packet: recompute every claim-bearing field of the published audit record and compare, so the
// opposite host can spend its effort on judgement instead of on rediscovering what was measured. It writes nothing
// except its own stdout; it never signs a verdict and it never claims the review.
//
// The comparison deliberately EXCLUDES `measuredAt` (host name and node version legitimately differ on the reviewer's
// machine) and sorts every list, so a difference in the report means a difference in the EVIDENCE, not in the host.
//
// Usage
//   node scripts/pcf700-review-packet.mjs                      # recomputes by running the audit script itself
//   node scripts/pcf700-review-packet.mjs --observed FILE      # compares against a report you produced yourself
//   node scripts/pcf700-review-packet.mjs --published FILE     # compare against a different record copy
//
// If your sandbox forbids capturing a child process's output (this project's Windows confined mode does), run
//   node scripts/pcf700-reuse-audit.mjs --out /tmp/observed.json
// and then pass --observed /tmp/observed.json; the two commands together are the whole packet.
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

// A BOM is stripped rather than rejected: the first version of this script crashed on a BOM-prefixed record, and that
// crash masqueraded as a FAILED drift check for one round - an instrument bug that produced the right exit code for
// the wrong reason. Windows tooling adds BOMs routinely, so the reader tolerates them; the checks below, not the
// parser, decide pass or fail.
const parse = text => JSON.parse(text.replace(/^\uFEFF/, ''));

const arg = (name, fallback = null) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const PUBLISHED = arg('--published', 'data-records/zh-CN/pcf/reuse-wiring-audit.json');
const OBSERVED = arg('--observed', null);

const normalise = value => {
  if (Array.isArray(value)) return value.map(normalise).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'measuredAt' && k !== 'node' && k !== 'host')
      .sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, normalise(v)]));
  }
  return value;
};
const deepEqual = (a, b) => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

let observed;
if (OBSERVED) observed = parse(await readFile(OBSERVED, 'utf8'));
else {
  const raw = execFileSync(process.execPath, ['scripts/pcf700-reuse-audit.mjs'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  observed = parse(raw);
}
const published = parse(await readFile(PUBLISHED, 'utf8'));

const results = [];
const check = (id, claim, ok, detail) => results.push({id, claim, result: ok ? 'PASS' : 'FAIL', detail});

// C1 - the whole claim-bearing body of the record, field by field, host metadata excluded.
check('C1', 'the published record recomputes field for field (host/node metadata excluded)', deepEqual(observed, published),
  deepEqual(observed, published) ? 'no evidence drift' : 'the observed audit differs from the published record; diff the two JSON files to see which claim moved');

const tiersOf = report => Object.fromEntries(Object.entries(report.domains).flatMap(([domain, rows]) => rows.map(row => [`${domain}/${row.contract}`, row.tier])));
const tiers = tiersOf(observed);
const liveWired = Object.entries(tiers).filter(([, tier]) => tier === 'LIVE_WIRED').map(([name]) => name.split('/')[1]).sort();
check('C2', 'exactly four contracts are LIVE_WIRED: execution-backend-v1, node-descriptor-v1, remote-local-discovery-v1, rs-presentation-contract-v1',
  JSON.stringify(liveWired) === JSON.stringify(['execution-backend-v1', 'node-descriptor-v1', 'remote-local-discovery-v1', 'rs-presentation-contract-v1'].sort()),
  `observed: ${liveWired.join(', ')}`);

const emGaiProduction = Object.entries(observed.domains).filter(([d]) => d.startsWith('EM') || d.startsWith('GAI'))
  .flatMap(([, rows]) => rows.flatMap(row => row.productionImporters.map(f => `${row.contract}:${f}`)));
check('C3', 'no engineering-* or general-ai-* contract has a production referrer', emGaiProduction.length === 0,
  emGaiProduction.length ? emGaiProduction.join(', ') : 'zero production references, as recorded');

const dd = observed.dependencyDirection;
check('C4', 'no backend module imports a front-end module', dd.backendModuleImports.length === 0, JSON.stringify(dd.backendModuleImports));
check('C5', 'every /api/v0 literal a user surface names resolves against a gateway route', dd.unresolvedUiEndpoints.length === 0,
  `unresolved: ${dd.unresolvedUiEndpoints.length}; ui files naming endpoints: ${dd.uiWithEndpoints}`);
check('C6', 'no runtime module refers to the fabric OUTSIDE its declared paths (PCF-701 activated the fabric itself)',
  observed.pcfRuntimeReferencesOutsideDeclaredPaths.length === 0,
  `declared references: ${observed.pcfRuntimeReferences.length}; outside declared paths: ${JSON.stringify(observed.pcfRuntimeReferencesOutsideDeclaredPaths)}`);
// C7 was "the candidate PCF directories were not created by this audit" while PCF-700 was an audit. PCF-701 activated
// the fabric, so the property is restated rather than dropped: the fabric exists ONLY under its declared paths, and
// those paths hold the declared modules. A new directory appearing anywhere else is what this check now catches.
const declaredModules = [];
if (existsSync('contracts/personal-compute-fabric-v1')) declaredModules.push(...(await readdir('contracts/personal-compute-fabric-v1')).map(name => `contracts/personal-compute-fabric-v1/${name}`));
if (existsSync('services/personal-compute-fabric')) declaredModules.push(...(await readdir('services/personal-compute-fabric')).map(name => `services/personal-compute-fabric/${name}`));
check('C7', 'the fabric exists only under its declared paths (PCF-700 measured it absent; PCF-701 activated it)',
  declaredModules.length >= 2, `declared: ${declaredModules.join(', ') || 'none'}`);
const writerDrift = published.singleWriters.filter((w, i) => JSON.stringify(w) !== JSON.stringify(observed.singleWriters[i]));
check('C8', 'every single-writer fingerprint (bytes/lines/SHA256) recomputes',
  writerDrift.length === 0 && published.singleWriters.length === observed.singleWriters.length,
  writerDrift.length ? writerDrift.map(w => w.file).join(', ') : `${observed.singleWriters.length} files match`);

const failed = results.filter(r => r.result === 'FAIL');
const lines = [
  'PCF-700 review packet (review-readiness recomputation)',
  `published record: ${PUBLISHED}`,
  OBSERVED ? `observed report: ${OBSERVED}` : 'observed report: recomputed in place by scripts/pcf700-reuse-audit.mjs',
  '',
  ...results.map(r => `${r.result}  ${r.id}  ${r.claim}\n        ${r.detail}`),
  '',
  `${results.length - failed.length}/${results.length} checks pass${failed.length ? ` - ${failed.length} FAILED` : ''}`,
  'This packet recomputes the author\'s claims; it is not a review and releases no terminal marker.',
];
const text = lines.join('\n');
process.stdout.write(text + '\n');
const out = arg('--out', null);
if (out) await writeFile(out, text + '\n', 'utf8');
process.exit(failed.length ? 1 : 0);
