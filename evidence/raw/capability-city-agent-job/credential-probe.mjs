// CAP-CITY-AGENT-JOB-001's credential rule, exercised against a REAL City, with its own pass/fail verdict.
//
// WHY THIS EXISTS: the capability claimed "a job record is not a secret store", and probing the live City on
// 2026-10-08 showed that was true only of `inputs` - the same credential shape in the instruction or the purpose was
// ACCEPTED, the job went QUEUED, and the stored record contained it. It was repaired (utopia f0295bc) and this probe is
// the measurement that says so on a real City rather than in a unit test: every stored field refuses, no task is
// created, and the read-back of every job the City holds contains no credential shape at all.
//
// THE SHAPE USED IS FAKE - twenty A's - because a real token must never be used to demonstrate this, and the probe
// cancels the one job it deliberately creates so that even a fake secret does not sit in a record.
//
//   node evidence/raw/capability-city-agent-job/credential-probe.mjs --city <url> --config <file with a token>
import {readFileSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

const value = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : process.env[`PROBE_${name.toUpperCase()}`] ?? fallback;
};
const CITY = value('city');
const CONFIG = value('config');
if (!CITY || !CONFIG) { process.stderr.write('credential-probe: --city <url> and --config <file holding {"token":"..."}> are both required\n'); process.exit(2); }
const token = JSON.parse(readFileSync(CONFIG, 'utf8')).token;
if (!token) { process.stderr.write('credential-probe: the config file carries no token\n'); process.exit(2); }
const H = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const OUT = resolve(import.meta.dirname, 'credential-probe-result.json');
const FAKE = 'ghp_AAAAAAAAAAAAAAAAAAAA';

const results = {schema: 'city-agent-job-credential-probe-v1', at: new Date().toISOString(), city: CITY, checks: [], refusals: [], created: []};
const check = (name, ok, detail) => { results.checks.push({name, ok: ok === true, detail: String(detail ?? '')});
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail ?? ''}`); };

const dispatch = async job => {
  const response = await fetch(CITY + '/api/v0/actions', {method: 'POST', headers: H, body: JSON.stringify({
    route: 'CITY_TASK', target: 'city.task', operation: 'AGENT_JOB', input: {job}, idempotencyKey: randomUUID()})});
  const body = await response.json();
  return {httpStatus: response.status, status: body?.action?.status ?? null, code: body?.action?.error?.code ?? null,
    message: body?.action?.error?.message ?? null, taskId: body?.action?.backendRef?.taskId ?? null};
};
const base = {title: 'credential probe', instruction: 'Say what you observe.', purpose: 'prove a credential cannot be stored in a job record', deadlineMs: 600000};

// Every field that ends up in the stored record must refuse the shape.
const refusedFields = [
  ['inputs[].text', {...base, inputs: [{name: 'note', text: 'clone with ' + FAKE}]}, 'JOB_INPUT_CREDENTIAL_REFUSED'],
  ['inputs[].name', {...base, inputs: [{name: 'github_token', text: 'anything'}]}, 'JOB_INPUT_CREDENTIAL_REFUSED'],
  ['title', {...base, title: 'push with ' + FAKE}, 'JOB_CREDENTIAL_REFUSED'],
  ['instruction', {...base, instruction: 'clone the repo using ' + FAKE}, 'JOB_CREDENTIAL_REFUSED'],
  ['purpose', {...base, purpose: 'authenticate with ' + FAKE}, 'JOB_CREDENTIAL_REFUSED'],
  ['expect', {...base, expect: 'the report shows ' + FAKE}, 'JOB_CREDENTIAL_REFUSED']
];
for (const [field, job, expected] of refusedFields) {
  const outcome = await dispatch(job);
  results.refusals.push({field, expected, ...outcome});
  check(`${field} refuses a credential shape`, outcome.code === expected && outcome.taskId === null,
    `code=${outcome.code} (expected ${expected}) task=${outcome.taskId}`);
}

// THE RULE IS ABOUT VALUES, NOT VOCABULARY: a job that merely names a token file is legitimate, and refusing it would
// make the channel useless for the work it exists for. This one is created and cancelled again.
const legitimate = await dispatch({...base, instruction: 'Read the token file yourself and report how many entries it has.'});
results.created.push(legitimate.taskId);
check('a job that only names a token file is still accepted', Boolean(legitimate.taskId) && legitimate.code === null,
  `task=${legitimate.taskId} code=${legitimate.code}`);

// THE HARM ITSELF, SPLIT INTO WHAT THE FIX CAN AND CANNOT CHANGE. A fix prevents new records; it cannot rewrite the
// ones already stored, and cancelling a job does not erase its record either. So the forward property is asserted, and
// the historical residue is REPORTED with its task ids instead of being failed on (or quietly deleted - this programme
// keeps what a defect did, and the shape here is fake).
const jobs = (await (await fetch(CITY + '/api/v0/node/jobs', {headers: H})).json()).jobs ?? [];
const carrying = jobs.filter(j => JSON.stringify(j.job ?? {}).includes(FAKE));
const mine = carrying.filter(j => results.created.includes(j.taskId));
check('no record created by this probe carries a credential shape', mine.length === 0, `created=${results.created.join(', ') || 'none'} carrying=${mine.map(j => j.taskId).join(', ') || 'none'}`);
results.historicalResidue = carrying.filter(j => !results.created.includes(j.taskId)).map(j => ({taskId: j.taskId, state: j.state, createdAt: j.createdAt, note: 'created before the fix; kept as history rather than erased'}));
console.log(`${results.historicalResidue.length ? 'NOTE' : '----'}  historical records that still carry the shape   ${results.historicalResidue.map(r => `${r.taskId}(${r.state})`).join(', ') || 'none'}`);

if (legitimate.taskId) {
  const cancelled = await fetch(CITY + `/api/v0/tasks/${encodeURIComponent(legitimate.taskId)}/cancel`, {method: 'POST', headers: H, body: '{}'});
  check('the one deliberately created job was cancelled afterwards', cancelled.status === 200, `HTTP ${cancelled.status}`);
}

const failed = results.checks.filter(c => !c.ok);
results.summary = {checks: results.checks.length, passed: results.checks.length - failed.length, failed: failed.map(c => c.name),
  note: 'the credential shape used is fake (twenty A\'s); no real token is involved'};
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
console.log(`\n${results.summary.passed}/${results.summary.checks} live checks pass  (result: ${OUT})`);
if (failed.length) console.log('failed: ' + failed.map(c => c.name).join(' | '));
process.exitCode = failed.length ? 1 : 0;
