// CAP-CITY-AGENT-JOB-001's DELIVERY RECEIPT, exercised against a REAL City.
//
// WHY THIS CAN BE MEASURED WITHOUT CLAIMING ANYTHING: the receipt is the OWNER's act on a job that already carries a
// report, and taking delivery twice is idempotent by contract. So this probe never claims, never reports and never
// creates a task - it re-reads a job the City already holds. That matters here: the live City has a strict-targeted job
// queued for the opposite host, and `/api/v0/node/claim` takes only a node id and not a task id, so a claim-based probe
// could consume THEIR request. This one cannot.
//
// WHAT IT CHECKS, and why each one is worth a check rather than a glance:
//   1. the receipt says on its face WHAT IT IS - an acknowledgement by a reader, never a verification of the work;
//   2. it BINDS to the exact report: reportDigest is recomputed here from the report the City stores, using the
//      contract's own canonicalisation, and compared - not compared against itself;
//   3. taking delivery AGAIN returns the recorded receipt with the same digest and timestamp (idempotent);
//   4. a DIFFERENT note is refused - a recorded act cannot be rewritten;
//   5. the receipt is the READER's act, so the job and its report are unchanged by it.
//
//   node evidence/raw/capability-city-agent-job/consumption-probe.mjs --city <url> --config <file with a token> [--task <taskId>]
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {jobDigest} from '../../../contracts/city-agent-job-v1/job.mjs';

const value = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : process.env[`PROBE_${name.toUpperCase()}`] ?? fallback;
};
const CITY = value('city');
const CONFIG = value('config');
if (!CITY || !CONFIG) { process.stderr.write('consumption-probe: --city <url> and --config <file holding {"token":"..."}> are both required\n'); process.exit(2); }
const token = JSON.parse(readFileSync(CONFIG, 'utf8')).token;
if (!token) { process.stderr.write('consumption-probe: the config file carries no token\n'); process.exit(2); }
const H = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const OUT = value('out') ?? resolve(tmpdir(), 'consumption-probe-result.json');

const jobs = async () => ((await (await fetch(CITY + '/api/v0/node/jobs', {headers: H})).json()).jobs ?? []);
const tasks = async () => ((await (await fetch(CITY + '/api/v0/tasks', {headers: H})).json()).tasks ?? []);
const consume = body => fetch(CITY + `/api/v0/node/jobs/${encodeURIComponent(TASK)}/consumed`, {method: 'POST', headers: H, body: JSON.stringify(body ?? {})});

const ledger = await jobs();
let TASK = value('task');
if (!TASK) {
  const collected = ledger.find(row => row.consumptionState === 'COLLECTED');
  if (!collected) { process.stderr.write('consumption-probe: this City holds no job with a recorded delivery receipt, so there is nothing to verify; pass --task <id> or take delivery once first\n'); process.exit(2); }
  TASK = collected.taskId;
}
const before = (await jobs()).find(row => row.taskId === TASK);
const taskBefore = (await tasks()).find(t => t.id === TASK);
if (!before) { process.stderr.write(`consumption-probe: no job ${TASK} on this City\n`); process.exit(2); }

const results = {schema: 'city-agent-job-consumption-probe-v1', at: new Date().toISOString(), city: CITY, taskId: TASK, checks: []};
const check = (name, ok, detail) => { results.checks.push({name, ok: ok === true, detail: String(detail ?? '')});
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail ?? ''}`); };

check('the job is already collected, so a receipt exists to inspect', before.consumptionState === 'COLLECTED', `consumptionState=${before.consumptionState}`);
const recorded = before.consumption ?? null;
check('the recorded receipt states what it is', recorded?.authority === 'ACKNOWLEDGEMENT_NOT_VERIFICATION' && recorded?.verification === 'AGENT_OBSERVATION_NOT_CITY_VERIFICATION',
  `authority=${JSON.stringify(recorded?.authority)} verification=${JSON.stringify(recorded?.verification)}`);
check('the receipt is not the agent consuming its own result', recorded?.agentConsumption === false, `agentConsumption=${JSON.stringify(recorded?.agentConsumption)}`);
check('the receipt names the job it belongs to', recorded?.taskId === TASK, `receipt.taskId=${recorded?.taskId}`);

// 2. BINDING: recompute the digest of the report the City STORES, with the contract's own canonicalisation.
const stored = taskBefore?.result ?? null;
const recomputed = stored ? jobDigest(stored) : null;
check('the receipt binds to the bytes the City stores, recomputed independently', Boolean(recomputed) && recomputed === recorded?.reportDigest,
  `recomputed=${String(recomputed).slice(0, 16)}… receipt=${String(recorded?.reportDigest).slice(0, 16)}…`);
results.binding = {recomputed, recorded: recorded?.reportDigest ?? null, jobDigest: recorded?.jobDigest ?? null};

// 3. IDEMPOTENT: taking delivery again returns the RECORDED receipt, not a new one.
const againResponse = await consume({});
const again = await againResponse.json();
check('taking delivery again is idempotent and returns the recorded receipt', againResponse.status === 200 && again.idempotent === true
  && again.consumption?.receiptDigest === recorded?.receiptDigest && again.consumption?.consumedAt === recorded?.consumedAt,
  `http=${againResponse.status} idempotent=${JSON.stringify(again.idempotent)} sameReceipt=${again.consumption?.receiptDigest === recorded?.receiptDigest} sameTime=${again.consumption?.consumedAt === recorded?.consumedAt}`);

// 4. A DIFFERENT note cannot rewrite a recorded act.
const rewritten = await consume({note: 'a different story, told later'});
const rewrittenBody = await rewritten.json().catch(() => null);
check('a different note is refused rather than allowed to rewrite the receipt', rewritten.status === 409 && JSON.stringify(rewrittenBody).includes('CONSUMPTION_ALREADY_RECORDED'),
  `http=${rewritten.status} body=${JSON.stringify(rewrittenBody).slice(0, 90)}`);

// 5. The reader's act does not change the work: job and report identical afterwards.
const after = (await jobs()).find(row => row.taskId === TASK);
const taskAfter = (await tasks()).find(t => t.id === TASK);
check('the receipt changed neither the job state nor the stored report',
  after?.state === before.state && after?.consumptionState === before.consumptionState
  && JSON.stringify(after?.job ?? null) === JSON.stringify(before.job ?? null)
  && JSON.stringify(taskAfter?.result ?? null) === JSON.stringify(stored),
  `state ${before.state}->${after?.state} consumptionState ${before.consumptionState}->${after?.consumptionState} reportUnchanged=${JSON.stringify(taskAfter?.result ?? null) === JSON.stringify(stored)}`);

const failed = results.checks.filter(c => !c.ok);
results.summary = {checks: results.checks.length, passed: results.checks.length - failed.length, failed: failed.map(c => c.name),
  note: 'no claim, no report and no task was created by this probe; it re-reads a receipt the City already held'};
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
console.log(`\n${results.summary.passed}/${results.summary.checks} live checks pass  (result: ${OUT})`);
if (failed.length) console.log('failed: ' + failed.map(c => c.name).join(' | '));
process.exitCode = failed.length ? 1 : 0;
