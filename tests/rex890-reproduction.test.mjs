import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

// Exercise the real CLI against bounded HTTP/WS responses. No physical-host
// evidence is claimed: these cases test whether incomplete evidence earns exit 0.
async function reproduce(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rex890-cli-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const runs = [{index: 0, state: 'COMPLETED', measured: true, result: {taskRef: 'task-a', assignedNodeId: 'worker-a'}},
    {index: 1, state: 'COMPLETED', measured: true, result: {taskRef: 'task-b', assignedNodeId: 'worker-b'}}];
  const files = {
    'manifest.json': JSON.stringify({artifactId: 'fixture', campaignIds: ['source'], runCount: 2, measuredRuns: 2}),
    'reproduction.json': JSON.stringify({steps: ['rebuild', 'execute']}),
    'exclusions.json': JSON.stringify({exclusions: []}),
    'topology.json': JSON.stringify({nodes: [{id: 'worker-a'}, {id: 'worker-b'}]}),
    'raw-pointers.json': JSON.stringify({traceRecords: ['trace:event-a'], canonicalTaskRuns: runs.map(r => ({taskRef: r.result.taskRef}))}),
    'metrics.csv': 'metric,group,value,reason,provenance\n' +
      (options.missingMetric ? '' : `completion_time_ms,G1,${options.metric ?? '1000'},,receipt:source\n`) +
      'failure_rate,G1,0,,receipt:source\nduplicate_execution_count,G1,0,,receipt:source\nconvergence_missing_event_count,G1,0,,receipt:source\n',
  };
  const checksums = {};
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(dir, name), bytes);
    checksums[name] = {sha256: createHash('sha256').update(bytes).digest('hex')};
  }
  await writeFile(join(dir, 'checksums.json'), JSON.stringify(checksums));
  await writeFile(join(dir, 'config.json'), JSON.stringify({token: 'fixture-only'}));
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    let answer;
    if (path.endsWith('/city')) answer = {nodes: [{id: 'worker-a', online: true}, {id: 'worker-b', online: true}]};
    else if (path.endsWith('/tasks')) answer = {tasks: runs.map(r => ({id: r.result.taskRef, state: 'COMPLETED', createdAt: '2026-01-01T00:00:00Z', updatedAt: options.missingDuration ? null : '2026-01-01T00:00:01Z'}))};
    else if (path.endsWith('/trace')) answer = {trace: {records: options.vacuousTrace ? [] : [{eventId: 'event-a'}], completeness: 'PARTIAL', retentionTruncated: true}};
    else if (path.endsWith('/trace/records')) { res.statusCode = 404; answer = {errorCode: 'HTTP_404'}; }
    else if (path.endsWith('/experiments')) answer = {};
    else if (path.endsWith('/campaigns')) answer = {started: {campaignId: 'independent'}};
    else if (path.endsWith('/source')) answer = {campaign: {state: 'COMPLETED', runs}};
    else if (path.endsWith('/independent')) answer = {campaign: {state: options.campaignState ?? 'COMPLETED', runs: options.shortRuns ? runs.slice(0, 1) : runs}};
    else { res.statusCode = 404; answer = {}; }
    req.resume(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(answer));
  });
  const ws = new WebSocketServer({server});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const city = `http://127.0.0.1:${server.address().port}`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/rex890-opposite-host-reproduce.mjs', '--artifact', dir, '--config', join(dir, 'config.json'), '--city', city, '--out', dir, '--repetitions', '2'], {stdio: ['ignore', 'pipe', 'pipe']});
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    child.on('error', reject); child.on('close', code => resolve({code, output}));
  });
  return {...result, report: JSON.parse(await readFile(join(dir, 'opposite-host-reproduction.json'), 'utf8'))};
}

test('complete evidence and two-device independent execution can return zero', async t => {
  const result = await reproduce(t);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.report.reproductionComplete, true);
});
for (const [name, options] of [
  ['a numeric package metric whose recomputation is null', {missingDuration: true}],
  ['a missing required metric row', {missingMetric: true}],
  ['a nonnumeric measured metric', {metric: 'garbage'}],
  ['an independent campaign that failed', {campaignState: 'FAILED'}],
  ['an independent campaign with missing repetitions', {shortRuns: true}],
  ['a trace comparison that could not read any evidence', {vacuousTrace: true}],
]) test(`does not return zero for ${name}`, async t => {
  const result = await reproduce(t, options);
  assert.equal(result.code, options.vacuousTrace ? 2 : 1, result.output);
  assert.equal(result.report.reproductionComplete, false);
});
