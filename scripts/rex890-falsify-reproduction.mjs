// FALSIFY the REX-890 reproduction harness.
//
// "0 inconsistencies" is only worth something if the harness CAN report one. This script builds two deliberately
// tampered copies of the real package and requires the harness to refuse them, and builds one that tampers with a file
// the harness is supposed to IGNORE, to prove it really rebuilds the dataset instead of reading the package's copy.
//
//   case A: metrics.csv edited AND its checksum refreshed  -> the harness must report a METRIC disagreement (exit 1)
//   case B: normalized-dataset.json edited AND its checksum refreshed -> the harness must NOT report a metric
//           disagreement, because it never reads that file (exit 0, with the untouched metrics still agreeing)
//   case C: metrics.csv edited with its checksum LEFT STALE -> the harness must report a CHECKSUM failure (exit 1)
//
// Every case is produced from the pristine package by copying, so the real artifact is never modified.
import {mkdir, rm, cp, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const SRC = resolve(process.argv[2] ?? 'D:/utopia-chat/4in1-acceptance-2026-10-07/rex890-dev-study/artifact');
const WORK = resolve(process.argv[3] ?? 'D:/utopia-chat/4in1-acceptance-2026-10-07/rex890-dev-study/falsify');
const CHECKOUT = process.argv[4] ?? 'D:/utopia-remote-op';
const CITY = process.argv[5] ?? 'http://172.31.12.151:4310';
const CONFIG = resolve(process.argv[6] ?? 'D:/utopia-chat/4in1-acceptance-2026-10-07/rex890-dev-study/study-config.json');
const HARNESS = 'scripts/rex890-opposite-host-reproduce.mjs';
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const run = (args, timeoutMs = 300000) => new Promise(resolveRun => {
  const child = spawn(process.execPath, args, {cwd: CHECKOUT, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.on('close', code => { clearTimeout(timer); resolveRun({status: code, stdout, stderr}); });
});

// NOTE the `m` flag on every tampering regex. The first version of this falsification omitted it, so `^` anchored to
// the start of the whole file instead of the start of the line, both replacements silently did nothing, and the run
// reported the HARNESS as failing when in fact the falsification never happened. A test that cannot apply its own
// tampering is worse than no test: it reports a defect in the thing it is supposed to be checking.
const results = [];
const check = (name, ok, detail) => { results.push({name, ok: ok === true, detail: String(detail ?? '')}); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`); };

await rm(WORK, {recursive: true, force: true});
await mkdir(WORK, {recursive: true});

/** Copy the package, apply a change, optionally refresh that file's checksum, then run the harness against it. */
async function attempt(label, mutate, {refreshChecksum}) {
  const dir = join(WORK, label);
  await cp(SRC, dir, {recursive: true});
  await mutate(dir);
  if (refreshChecksum) {
    const sums = JSON.parse(await readFile(join(dir, 'checksums.json'), 'utf8'));
    for (const name of Object.keys(sums)) {
      const bytes = await readFile(join(dir, name));
      sums[name] = {bytes: bytes.length, sha256: sha256(bytes)};
    }
    await writeFile(join(dir, 'checksums.json'), JSON.stringify(sums, null, 2), 'utf8');
  }
  const out = join(WORK, label + '-out');
  const result = await run([HARNESS, '--artifact', dir, '--city', CITY, '--config', CONFIG, '--out', out, '--label', 'falsify-' + label]);
  let report = null;
  try { report = JSON.parse(await readFile(join(out, 'opposite-host-reproduction.json'), 'utf8')); } catch { /* absent */ }
  return {result, report};
}

console.log('falsifying the reproduction harness against tampered packages\n');

// --- case A: the metric the harness must recompute is changed, and the package is made internally consistent again.
{
  const {result, report} = await attempt('A-metric-lie', async dir => {
    const csv = await readFile(join(dir, 'metrics.csv'), 'utf8');
    await writeFile(join(dir, 'metrics.csv'), csv.replace(/^completion_time_ms,G1,\d+/m, 'completion_time_ms,G1,999999'), 'utf8');
  }, {refreshChecksum: true});
  const named = (report?.inconsistencies ?? []).some(i => String(i.what).includes('completion_time_ms'));
  check('A: an internally consistent package that LIES about a metric is caught', result.status === 1 && named,
    `exit=${result.status} inconsistencies=${report?.inconsistencies?.length ?? 'n/a'} named=${named}`);
  check('A: the package still verifies its own checksums, so the finding is the metric and not the hash', report?.packageIntegrity === 'VERIFIED', `integrity=${report?.packageIntegrity}`);
}

// --- case B: a file the harness must IGNORE is changed. If the harness read the package's dataset instead of
// rebuilding from the City, this case would produce a metric disagreement - so it is the control for "really rebuilt".
{
  const {result, report} = await attempt('B-dataset-tamper', async dir => {
    const data = JSON.parse(await readFile(join(dir, 'normalized-dataset.json'), 'utf8'));
    for (const row of data.rows) row.durationMs = 1;
    await writeFile(join(dir, 'normalized-dataset.json'), JSON.stringify(data, null, 2), 'utf8');
  }, {refreshChecksum: true});
  const named = (report?.inconsistencies ?? []).some(i => String(i.what).includes('completion_time_ms'));
  check('B: tampering the package dataset does NOT move the recomputed metric (it is not read)', result.status === 0 && !named,
    `exit=${result.status} metricDisagreement=${named} recomputed=${report?.recomputed?.completion_time_ms}`);
}

// --- case C: the metric is changed and the checksum is NOT refreshed, so the package contradicts itself.
{
  const {result, report} = await attempt('C-checksum-stale', async dir => {
    const csv = await readFile(join(dir, 'metrics.csv'), 'utf8');
    await writeFile(join(dir, 'metrics.csv'), csv.replace(/^failure_rate,G1,[\d.]+/m, 'failure_rate,G1,0.5'), 'utf8');
  }, {refreshChecksum: false});
  const named = (report?.inconsistencies ?? []).some(i => String(i.what).includes('checksum for metrics.csv'));
  check('C: a package whose bytes do not match its own manifest is caught as that', result.status === 1 && named,
    `exit=${result.status} integrity=${report?.packageIntegrity} named=${named}`);
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} falsification checks pass`);
if (failed.length) console.log('failed: ' + failed.map(r => r.name).join(' | '));
process.exitCode = failed.length ? 1 : 0;
