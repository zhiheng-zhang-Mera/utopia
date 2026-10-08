// CAP-CITY-REMOTE-OPERATION-001 exercised against a REAL City, with its own pass/fail verdict.
//
// WHY THIS LIVES IN THE TREE: the capability record's known_gaps said the tests run a real gateway and a real node
// agent on ONE host and that the live run had not happened. A claim like "the owner can make another machine run an
// allowlisted program, by declarative argv, with no shell and with typed refusals" is worth exactly as much as the
// measurement behind it, so the measurement is filed next to the code that makes it true.
//
// WHAT IT PROVES, and what it does NOT: it proves the live City dispatches and re-checks, that the recorded `shell`
// flag is false, that a shell metacharacter inside an argv element is inert data, and that each refusal is typed and
// leaves no task behind. It does NOT prove the cross-PHYSICAL-host case: this targets the node on the SAME machine as
// the City. That case remains NOT RUN and is recorded as such.
//
//   node evidence/raw/capability-city-remote-operation/live-probe.mjs --city <url> --config <file with a token>
import {readFileSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

const value = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : process.env[`PROBE_${name.toUpperCase()}`] ?? fallback;
};
const CITY = value('city');
const CONFIG = value('config');
if (!CITY || !CONFIG) {
  process.stderr.write('live-probe: --city <url> and --config <file holding {"token":"..."}> are both required\n');
  process.exit(2);
}
const token = JSON.parse(readFileSync(CONFIG, 'utf8')).token;
if (!token) { process.stderr.write('live-probe: the config file carries no token\n'); process.exit(2); }
const H = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = resolve(import.meta.dirname, 'live-probe-result.json');

const city = await (await fetch(CITY + '/api/v0/city', {headers: H})).json();
const online = (city.nodes ?? []).filter(n => n.online === true).map(n => n.id);
const target = online[0] ?? null;
if (!target) { process.stderr.write('live-probe: no online node to target; this City cannot run the probe\n'); process.exit(2); }

const dispatch = async operation => {
  const response = await fetch(CITY + '/api/v0/actions', {method: 'POST', headers: H, body: JSON.stringify({
    route: 'CITY_TASK', target: 'city.task', operation: 'OWNER_REMOTE_OPERATION',
    input: {targetDeviceRef: target, operation}, idempotencyKey: randomUUID()})});
  const body = await response.json();
  return {httpStatus: response.status, actionStatus: body?.action?.status ?? null, errorCode: body?.action?.error?.code ?? null,
    errorMessage: body?.action?.error?.message ?? null, taskId: body?.action?.backendRef?.taskId ?? null};
};
const taskRow = async id => ((await (await fetch(CITY + '/api/v0/tasks', {headers: H})).json()).tasks ?? []).find(t => t.id === id) ?? null;
const operationRow = async id => ((await (await fetch(CITY + '/api/v0/node/operations', {headers: H})).json()).operations ?? []).find(o => o.taskId === id) ?? null;

const settle = async taskId => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const task = await taskRow(taskId);
    if (task && ['COMPLETED', 'FAILED', 'REFUSED', 'CANCELLED'].includes(task.state)) break;
    await sleep(1000);
  }
  const row = await operationRow(taskId);
  // The AUDIT fields are part of the row and have to be carried here too, or a check about the audit reads undefined
  // from a healthy City and reports a failure that is the probe's own - which is exactly what happened on the first
  // run of the bounds section.
  return row ? {state: row.state, assignedNodeId: row.assignedNodeId, shell: row.shell, operationDigest: row.operationDigest,
    purpose: row.purpose, executable: row.executable, argv: row.argv, cwd: row.cwd, timeoutMs: row.timeoutMs,
    maxOutputBytes: row.maxOutputBytes, result: row.result, receipt: row.receipt} : null;
};

const results = {schema: 'city-remote-operation-live-probe-v1', at: new Date().toISOString(), city: CITY, target,
  onlineNodes: online, checks: [], ran: {}, refusals: []};
const check = (name, ok, detail) => { results.checks.push({name, ok: ok === true, detail: String(detail ?? '')});
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail ?? ''}`); };

// 1. An allowlisted program, described declaratively.
const allowed = await dispatch({executable: 'git', argv: ['--version'], cwd: 'D:/utopia-remote-op',
  purpose: 'CAP-CITY-REMOTE-OPERATION-001 live probe: dispatch an allowlisted program and read the receipt', timeoutMs: 30000});
const allowedRow = allowed.taskId ? await settle(allowed.taskId) : null;
results.ran.allowed = {...allowed, row: allowedRow};
check('the live City accepted a declarative dispatch', allowed.httpStatus === 200 && Boolean(allowed.taskId), `http=${allowed.httpStatus} task=${allowed.taskId}`);
check('the program really ran on the named node', allowedRow?.state === 'COMPLETED' && allowedRow?.result?.exitCode === 0 && /^git version /.test(String(allowedRow?.result?.stdout)), `state=${allowedRow?.state} exit=${allowedRow?.result?.exitCode} stdout=${JSON.stringify(String(allowedRow?.result?.stdout ?? '').trim())}`);
check('the node that ran it is the node the owner named', allowedRow?.assignedNodeId === target, `assigned=${allowedRow?.assignedNodeId} named=${target}`);
check('the City re-checked the receipt and records that it is not an acceptance', allowedRow?.receipt?.valid === true && allowedRow?.receipt?.acceptanceAuthority === false, JSON.stringify(allowedRow?.receipt ?? null));

// 2. NO SHELL EXISTS. The metacharacters are ONE argv element, so git must report the whole string as a single unknown
//    subcommand. If a shell were anywhere in the path, `echo INERT` would have run and stdout would say INERT.
const noShell = await dispatch({executable: 'git', argv: ['rev-parse;echo INERT'], cwd: 'D:/utopia-remote-op',
  purpose: 'CAP-CITY-REMOTE-OPERATION-001 live probe: show that ; is data and no shell interprets it', timeoutMs: 30000});
const noShellRow = noShell.taskId ? await settle(noShell.taskId) : null;
results.ran.noShell = {...noShell, row: noShellRow};
check('the operation row records shell:false', noShellRow?.shell === false, `shell=${JSON.stringify(noShellRow?.shell)}`);
check('the metacharacter string is reported as ONE argv element by the program', String(noShellRow?.result?.stderr ?? '').includes("'rev-parse;echo INERT'"), JSON.stringify(String(noShellRow?.result?.stderr ?? '').trim()));
check('nothing was interpreted as a second command', noShellRow?.result?.stdout === '' && !/\bINERT\b/.test(String(noShellRow?.result?.stdout ?? '')), `stdout=${JSON.stringify(String(noShellRow?.result?.stdout ?? ''))}`);

// 3. BOUNDS AND AUDIT, measured rather than read off the source. The narrative in this record says the capability is
//    BOUNDED; these are the measurements behind that. Note the shape of the answer: a value above the ceiling is
//    REFUSED BY NAME, not silently reduced - which is what the contract's code does, and what its own header comment
//    said loosely ("clamped"). A caller that believes a too-large number was quietly capped would design against a
//    guarantee that does not exist.
const overTimeout = await dispatch({executable: 'git', argv: ['--version'], cwd: 'D:/utopia-remote-op',
  purpose: 'live probe bounds: timeout above the ceiling', timeoutMs: 99999999});
results.bounds = {overTimeout};
check('a timeout above the ceiling is refused by name', overTimeout.errorCode === 'TIMEOUT_EXCEEDS_LIMIT' && overTimeout.taskId === null,
  `code=${overTimeout.errorCode} task=${overTimeout.taskId}`);

const overOutput = await dispatch({executable: 'git', argv: ['--version'], cwd: 'D:/utopia-remote-op',
  purpose: 'live probe bounds: output cap above the ceiling', timeoutMs: 30000, maxOutputBytes: 99999999});
results.bounds.overOutput = overOutput;
check('an output cap above the ceiling is refused by name', overOutput.errorCode === 'OUTPUT_LIMIT_EXCEEDS_LIMIT' && overOutput.taskId === null,
  `code=${overOutput.errorCode} task=${overOutput.taskId}`);

const zeroTimeout = await dispatch({executable: 'git', argv: ['--version'], cwd: 'D:/utopia-remote-op',
  purpose: 'live probe bounds: zero timeout', timeoutMs: 0});
results.bounds.zeroTimeout = zeroTimeout;
check('a non-positive bound is refused by name', zeroTimeout.errorCode === 'BOUNDS_INVALID' && zeroTimeout.taskId === null,
  `code=${zeroTimeout.errorCode} task=${zeroTimeout.taskId}`);

// Environment injection is refused by PRESENCE, so an EMPTY env object must be refused too - otherwise "no environment
// injection" would depend on what the object happened to contain.
const emptyEnv = await dispatch({executable: 'git', argv: ['--version'], cwd: 'D:/utopia-remote-op',
  purpose: 'live probe bounds: environment override', timeoutMs: 30000, env: {}});
results.bounds.emptyEnv = emptyEnv;
check('an environment override is refused even when empty', emptyEnv.errorCode === 'ENVIRONMENT_OVERRIDE_REFUSED' && emptyEnv.taskId === null,
  `code=${emptyEnv.errorCode} task=${emptyEnv.taskId}`);

// The bound has to BIND: a program that outlives its timeout must be killed, and the receipt must say so.
const slow = await dispatch({executable: 'node', argv: ['-e', 'setTimeout(()=>{}, 15000)'], cwd: 'D:/utopia-remote-op',
  purpose: 'live probe bounds: a program that outlives its timeout must be stopped', timeoutMs: 1500});
const slowRow = slow.taskId ? await settle(slow.taskId) : null;
results.bounds.timedOutRun = {dispatch: slow, row: slowRow};
check('a program that outlives its timeout is stopped and the receipt says so', slowRow?.result?.timedOut === true,
  `state=${slowRow?.state} timedOut=${JSON.stringify(slowRow?.result?.timedOut)} durationMs=${slowRow?.result?.durationMs}`);

// And the output cap has to bind too: a program that prints more than the cap must come back truncated.
const loud = await dispatch({executable: 'node', argv: ['-e', "process.stdout.write('x'.repeat(400000))"], cwd: 'D:/utopia-remote-op',
  purpose: 'live probe bounds: output beyond the cap must be truncated', timeoutMs: 30000, maxOutputBytes: 4096});
const loudRow = loud.taskId ? await settle(loud.taskId) : null;
results.bounds.truncatedRun = {dispatch: loud, row: loudRow};
check('output beyond the declared cap comes back truncated', loudRow?.result?.truncated === true,
  `truncated=${JSON.stringify(loudRow?.result?.truncated)} stdoutBytes=${JSON.stringify(loudRow?.result?.stdoutBytes ?? String(loudRow?.result?.stdout ?? '').length)}`);

// AUDIT: the purpose is not decoration - it is stored on the row with the program, the argv and the workspace.
check('the audit row carries the purpose, program, argv and workspace', Boolean(loudRow?.purpose && loudRow?.executable && Array.isArray(loudRow?.argv) && loudRow?.cwd),
  `purpose=${JSON.stringify(String(loudRow?.purpose ?? '').slice(0, 40))} executable=${loudRow?.executable} cwd=${loudRow?.cwd}`);

// 4. Typed refusals, each of which must be named AND must leave no task behind.
const refusals = [
  ['executable not on the allowlist', {executable: 'powershell', argv: ['-Command', 'echo no'], cwd: 'D:/utopia-remote-op', purpose: 'live probe refusal check', timeoutMs: 30000}, 'EXECUTABLE_NOT_ALLOWED'],
  ['an absolute path instead of a program name', {executable: 'C:/Windows/System32/cmd.exe', argv: ['/c', 'echo no'], cwd: 'D:/utopia-remote-op', purpose: 'live probe refusal check', timeoutMs: 30000}, 'EXECUTABLE_REQUIRED'],
  ['a working directory outside every declared workspace root', {executable: 'git', argv: ['--version'], cwd: 'E:/outside-the-roots', purpose: 'live probe refusal check', timeoutMs: 30000}, 'WORKING_DIRECTORY_OUTSIDE_WORKSPACE'],
  ['a working directory that climbs out with ..', {executable: 'git', argv: ['--version'], cwd: 'D:/utopia-remote-op/../../Windows', purpose: 'live probe refusal check', timeoutMs: 30000}, 'WORKING_DIRECTORY_OUTSIDE_WORKSPACE'],
  ['no purpose at all', {executable: 'git', argv: ['--version'], cwd: 'D:/utopia-remote-op', timeoutMs: 30000}, 'PURPOSE_REQUIRED'],
  ['argv is not an array of strings', {executable: 'git', argv: ['--version', 7], cwd: 'D:/utopia-remote-op', purpose: 'live probe refusal check', timeoutMs: 30000}, 'ARGV_INVALID'],
  ['an argument carrying a NUL byte', {executable: 'git', argv: ['--version\0x'], cwd: 'D:/utopia-remote-op', purpose: 'live probe refusal check', timeoutMs: 30000}, 'ARGV_INVALID']
];
for (const [name, operation, expected] of refusals) {
  const refused = await dispatch(operation);
  results.refusals.push({name, expected, ...refused});
  check(`refused by name: ${name}`, refused.errorCode === expected && refused.taskId === null,
    `code=${refused.errorCode} (expected ${expected}) task=${refused.taskId}`);
}

const failed = results.checks.filter(c => !c.ok);
results.summary = {checks: results.checks.length, passed: results.checks.length - failed.length, failed: failed.map(c => c.name),
  scope: 'same physical host: the City and the node it targets run on this machine. The cross-host case is NOT RUN.'};
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
console.log(`\n${results.summary.passed}/${results.summary.checks} live checks pass  (result: ${OUT})`);
if (failed.length) console.log('failed: ' + failed.map(c => c.name).join(' | '));
process.exitCode = failed.length ? 1 : 0;
