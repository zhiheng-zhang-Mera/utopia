// REX-890 READINESS CHECK - read-only, so it can be run BEFORE the reproduction without changing what it measures.
//
// WHY THIS EXISTS SEPARATELY FROM THE HARNESS: the harness legitimately STARTS a campaign, which adds a receipt to the
// City and therefore moves the environment it is measuring. A host that wants to know "can this City still substantiate
// this package?" before committing to a run needs an answer that costs nothing - this sends only GETs, creates no task
// and starts no campaign.
//
// WHAT IT VERIFIES
//   1. the package's own checksums, over the files it lists;
//   2. the external MANIFEST.sha256 beside the package, over the whole file set;
//   3. the package's trace coverage: listed == captured, which is what makes the trace element independent of the City;
//   4. the City still serves EVERY campaign the package names, read BY ID, summing to the run count the package claims;
//   5. every canonical task the rebuilt runs point at still exists;
//   6. and it REPORTS the City's bounded receipt window (total/limit/truncated) rather than failing on it, because the
//      window bounds a LISTING and this check - like the harness - asks for each campaign by id.
//
// Exit 0 = ready. Exit 2 = not ready, with each failing item named and no side effects.
//
//   node evidence/raw/rex890-studies/2026-10-08-B/readiness-check.mjs --artifact <dir> --city <url> --config <file>
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, join, basename} from 'node:path';
import {tmpdir} from 'node:os';

const value = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : process.env[`READINESS_${name.toUpperCase()}`] ?? fallback;
};
const ARTIFACT = value('artifact');
const CITY = value('city');
const CONFIG = value('config');
if (!ARTIFACT || !CITY || !CONFIG) {
  process.stderr.write('readiness-check: --artifact <dir> --city <url> --config <file holding {"token":"..."}> are all required\n');
  process.exit(2);
}
if (!existsSync(ARTIFACT)) { process.stderr.write(`readiness-check: the artifact directory does not exist: ${ARTIFACT}\n`); process.exit(2); }
const token = JSON.parse(readFileSync(CONFIG, 'utf8')).token;
if (!token) { process.stderr.write('readiness-check: the config file carries no token\n'); process.exit(2); }
const H = {Authorization: 'Bearer ' + token, 'Accept': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
// OUTSIDE THE CHECKOUT BY DEFAULT, AND THAT MATTERS MORE HERE THAN ANYWHERE. This check is meant to be run immediately
// before the reproduction, and the harness reports a DIRTY CHECKOUT as an evidence gap - so a pre-flight that wrote its
// result into the tree would have sabotaged the very run it was preparing. Measured: that was true of the first version,
// which wrote beside itself. A caller who wants the result filed passes --out.
const OUT = value('out') ?? resolve(tmpdir(), 'readiness-check-result.json');

const problems = [];
const results = {schema: 'rex890-readiness-check-v1', at: new Date().toISOString(), artifact: ARTIFACT, city: CITY, checks: [], info: {}};
const check = (name, ok, detail) => { results.checks.push({name, status: ok ? 'PASS' : 'FAIL', detail: String(detail ?? '')});
  if (!ok) problems.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail ?? ''}`); };

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// 1. the package's own checksums
const checksums = JSON.parse(readFileSync(join(ARTIFACT, 'checksums.json'), 'utf8'));
const listed = checksums.files ?? checksums;
const bad = Object.entries(listed).filter(([name, meta]) => sha256(join(ARTIFACT, name)) !== (meta.sha256 ?? meta));
check(`the package's own checksums verify (${Object.keys(listed).length} files)`, bad.length === 0, bad.map(([n]) => n).join(', ') || 'all match');

// 2. the external manifest, which covers the whole file set rather than the checksummed subset
const manifestFile = join(ARTIFACT, '..', 'MANIFEST.sha256');
if (existsSync(manifestFile)) {
  const lines = readFileSync(manifestFile, 'utf8').split('\n').filter(l => l.trim());
  const mismatched = [];
  for (const line of lines) {
    const match = /^([0-9a-f]{64})\s+(.+?)\s*$/.exec(line);
    if (!match) { mismatched.push(`unparseable line: ${line.slice(0, 40)}`); continue; }
    const target = resolve(join(ARTIFACT, '..'), match[2]);
    if (!existsSync(target) || sha256(target) !== match[1]) mismatched.push(basename(target));
  }
  check(`the external manifest verifies (${lines.length} entries)`, mismatched.length === 0, mismatched.join(', ') || 'all match');
} else {
  check('the external manifest exists beside the package', false, `missing: ${manifestFile}`);
}

// 3. trace coverage: this is what makes the trace element independent of the City's retention
const coverageFile = join(ARTIFACT, 'trace-coverage.json');
if (existsSync(coverageFile)) {
  const coverage = JSON.parse(readFileSync(coverageFile, 'utf8'));
  check('the package carries the trace records it points at', coverage.listed === coverage.captured,
    `listed=${coverage.listed} captured=${coverage.captured} source=${coverage.source}`);
  results.info.traceCoverage = {listed: coverage.listed, captured: coverage.captured};
} else {
  check('the package carries the trace records it points at', false, 'trace-coverage.json is missing');
}

// 4/5. the City side, read by id
const manifest = JSON.parse(readFileSync(join(ARTIFACT, 'manifest.json'), 'utf8'));
const pointers = JSON.parse(readFileSync(join(ARTIFACT, 'raw-pointers.json'), 'utf8'));
const ask = async path => {
  const response = await fetch(`${CITY}/api/v0/${path}`, {headers: H});
  const text = await response.text();
  let body = null; try { body = JSON.parse(text); } catch { /* kept as text */ }
  return {status: response.status, body, text};
};
const city = await ask('city');
if (city.status !== 200) { check('the City answers with the owner credential', false, `HTTP ${city.status} ${city.text.slice(0, 80)}`); }
else {
  check('the City answers with the owner credential', true, `HTTP 200, ${(city.body?.nodes ?? []).filter(n => n.online).length} online device(s)`);

  let runs = 0;
  const missing = [];
  for (const campaignId of manifest.campaignIds ?? []) {
    const campaign = (await ask(`research/campaigns/${campaignId}`)).body?.campaign ?? null;
    if (!campaign) { missing.push(campaignId); continue; }
    runs += (campaign.runs ?? []).length;
  }
  check(`every campaign the package names is still readable by id (${(manifest.campaignIds ?? []).length})`, missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : 'all present');
  check(`the runs still sum to the package's claim (${manifest.runCount})`, runs === manifest.runCount, `read ${runs}`);

  const tasks = new Map(((await ask('tasks')).body?.tasks ?? []).map(t => [t.id, t]));
  const refs = (pointers.canonicalTaskRuns ?? []).map(r => r?.taskRef).filter(Boolean);
  const absent = refs.filter(ref => !tasks.has(ref));
  check(`every canonical task the runs point at still exists (${refs.length})`, absent.length === 0, absent.length ? `absent: ${absent.slice(0, 5).join(', ')}` : 'all present');

  // 6. the bounded window is reported, not failed on: it bounds a listing, and both this check and the harness ask by id.
  const campaigns = await ask('research/campaigns');
  const window = campaigns.body?.receiptWindow ?? null;
  results.info.receiptWindow = window ? {total: window.total, limit: window.limit, truncated: window.truncated} : null;
  const hiddenByWindow = window ? (manifest.campaignIds ?? []).filter(id => !(window.receipts ?? []).some(r => r.campaignId === id)) : [];
  console.log(`INFO  receipt window total=${window?.total} limit=${window?.limit} truncated=${window?.truncated}; package campaigns not in the LISTING: ${hiddenByWindow.length} (they are still read by id, as above)`);
  results.info.packageCampaignsOutsideTheListing = hiddenByWindow;
  results.info.onlineDevices = (city.body?.nodes ?? []).filter(n => n.online).map(n => n.id);
}
results.ready = problems.length === 0;
results.problems = problems;
results.note = 'read-only: no task was created and no campaign was started, so running this does not move what it measures';
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
console.log(`\n${results.checks.filter(c => c.status === 'PASS').length}/${results.checks.length} readiness checks pass  (result: ${OUT})`);
if (problems.length) console.log('NOT READY: ' + problems.join(' | '));
process.exitCode = problems.length ? 2 : 0;
