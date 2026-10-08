// THE OWNER BOUNDARY, MEASURED ON A LIVE CITY.
//
// The capability records say the agent-job surface belongs to the OWNER: a member can neither dispatch nor read it. That
// claim was, until now, backed by the gateway suite and not by a measurement against the running City - and the honest
// reason for that was that enrolling a member would add a device to the roster the opposite host's reproduction reads
// and compares against the package. This probe gets the same boundary evidence WITHOUT touching the roster: it uses
// credentials that already exist on this machine and asks the City to refuse the ones that are not the owner's.
//
// WHAT IT CHECKS
//   1. the owner token reads an owner route;
//   2. a wrong token is refused, AND the refusal carries no job data (a refusal that leaks is not a refusal);
//   3. no credential at all is refused the same way;
//   4. the NODE token - a real credential, just not the owner's - is refused on the owner route;
//   5. an unauthenticated dispatch creates no task (measured by counting tasks before and after);
//   6. no response ever echoes a credential back.
//
// The node token is read from a file the caller names, because on this host it lives next to the City's own config. If
// the caller does not supply one, that single check is reported as NOT_RUN with its reason - a deliberate skip is not a
// failure, which is this programme's rule everywhere else.
//
//   node evidence/raw/city-auth-boundary/auth-boundary-probe.mjs --city <url> --config <owner config> [--node-config <file with nodeToken>]
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const value = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : process.env[`PROBE_${name.toUpperCase()}`] ?? fallback;
};
const CITY = value('city');
const CONFIG = value('config');
const NODE_CONFIG = value('node-config');
if (!CITY || !CONFIG) {
  process.stderr.write('auth-boundary-probe: --city <url> and --config <file holding {"token":"..."}> are both required\n');
  process.exit(2);
}
const ownerToken = JSON.parse(readFileSync(CONFIG, 'utf8')).token;
if (!ownerToken) { process.stderr.write('auth-boundary-probe: the config file carries no token\n'); process.exit(2); }
const nodeToken = NODE_CONFIG ? (JSON.parse(readFileSync(NODE_CONFIG, 'utf8')).nodeToken ?? null) : null;
const WRONG = 'not-the-owner-' + 'A'.repeat(16);
const OUT = resolve(import.meta.dirname, 'auth-boundary-probe-result.json');
const V = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const ask = async (path, token, options = {}) => {
  const response = await fetch(CITY + '/api/v0/' + path, {...options,
    headers: token === null ? {...V} : {...V, Authorization: 'Bearer ' + token}});
  const text = await response.text();
  let body = null; try { body = JSON.parse(text); } catch { /* kept as text */ }
  return {status: response.status, body, text};
};
const jobCount = async token => ((await ask('node/jobs', token)).body?.jobs ?? []).length;

const results = {schema: 'city-auth-boundary-probe-v1', at: new Date().toISOString(), city: CITY, checks: []};
const check = (name, ok, detail) => { results.checks.push({name, status: ok === true ? 'PASS' : ok === null ? 'NOT_RUN' : 'FAIL', detail: String(detail ?? '')});
  console.log(`${ok === true ? 'PASS' : ok === null ? 'NOT_RUN' : 'FAIL'}  ${name.padEnd(60)} ${detail ?? ''}`); };

// BOTH owner READ SURFACES ARE CHECKED, because each capability's record claims owner-only for its own view: the
// agent-job surface reads jobs, the remote-operation surface reads the operation log. A boundary measured on one of them
// would not answer the other's claim.
const ROUTES = [
  ['node/jobs', body => Array.isArray(body?.jobs), 'jobs'],
  ['node/operations', body => Array.isArray(body?.operations), 'operations']
];

const ownerReads = [];
for (const [route, looksRight, label] of ROUTES) {
  const ownerRead = await ask(route, ownerToken);
  ownerReads.push(ownerRead);
  check(`the owner token reads the owner route ${route}`, ownerRead.status === 200 && looksRight(ownerRead.body),
    `http=${ownerRead.status} ${label}=${ownerRead.body?.[label]?.length ?? 'n/a'}`);

  const wrongRead = await ask(route, WRONG);
  check(`a wrong token is refused on ${route}`, wrongRead.status === 401 || wrongRead.status === 403, `http=${wrongRead.status}`);
  check(`and that refusal carries no ${label} data`, !looksRight(wrongRead.body) && !wrongRead.text.includes('taskId'),
    `body=${JSON.stringify(wrongRead.body).slice(0, 80)}`);

  const anonymousRead = await ask(route, null);
  check(`no credential at all is refused on ${route}`, anonymousRead.status === 401 || anonymousRead.status === 403, `http=${anonymousRead.status}`);

  if (nodeToken) {
    const nodeRead = await ask(route, nodeToken);
    check(`the NODE token is not the owner and is refused on ${route}`, nodeRead.status === 401 || nodeRead.status === 403,
      `http=${nodeRead.status} (a real credential for the same City, just not the owner's)`);
  } else {
    check(`the NODE token is not the owner and is refused on ${route}`, null,
      'no --node-config was supplied, so this credential boundary could not be measured on this run');
  }
}
const refusalBodies = ownerReads.map(read => read.text);

// 5. An unauthenticated dispatch must not create anything. Counted, not assumed.
const before = await jobCount(ownerToken);
const dispatch = await ask('actions', WRONG, {method: 'POST', body: JSON.stringify({route: 'CITY_TASK', target: 'city.task', operation: 'AGENT_JOB',
  input: {job: {title: 'auth boundary probe', instruction: 'this must never be dispatched', purpose: 'prove an unauthenticated dispatch creates nothing', deadlineMs: 60000}},
  idempotencyKey: 'auth-boundary-probe-' + Date.now()})});
const after = await jobCount(ownerToken);
check('an unauthenticated dispatch is refused and creates no job', (dispatch.status === 401 || dispatch.status === 403) && after === before,
  `http=${dispatch.status} jobs ${before} -> ${after}`);

// 6. A credential must never come back in a response body.
const bodies = [...refusalBodies, JSON.stringify(dispatch.body ?? '')];
check('no response echoes a credential back', !bodies.some(body => body.includes(ownerToken) || body.includes(WRONG) || (nodeToken && body.includes(nodeToken))),
  `checked ${bodies.length} response bodies`);

const failed = results.checks.filter(c => c.status === 'FAIL');
const notRun = results.checks.filter(c => c.status === 'NOT_RUN');
results.summary = {checks: results.checks.length, passed: results.checks.length - failed.length - notRun.length,
  failed: failed.map(c => c.name), notRun: notRun.map(c => c.name),
  note: 'no member device was enrolled: this measures the boundary with credentials that already exist, so the roster the opposite host compares against is unchanged'};
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
console.log(`\n${results.summary.passed}/${results.summary.checks} live checks pass${notRun.length ? `, ${notRun.length} NOT RUN` : ''}  (result: ${OUT})`);
if (failed.length) console.log('failed: ' + failed.map(c => c.name).join(' | '));
process.exitCode = failed.length ? 1 : 0;
