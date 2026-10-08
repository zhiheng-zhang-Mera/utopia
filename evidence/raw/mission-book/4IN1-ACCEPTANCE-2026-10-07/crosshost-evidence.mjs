// Cross-host acceptance evidence for the 4-in-1 integration pack, taken against the LIVE City that runs the
// verified head. Two real machines, one City: the Mech host (COMPUTERNAME MEGA-REP) and the Alien node
// (Mera-Alianware). Everything here is read back from the City, nothing is asserted from memory.
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const CITY = process.env.EVIDENCE_CITY ?? 'http://172.31.12.151:4310';
const OUT = resolve('D:/utopia-chat/4in1-acceptance-2026-10-07/crosshost-evidence');
const TREE = 'D:/utopia-rex-pcf-merge';
const token = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command',
  "Get-Content 'C:\\ProgramData\\Utopia\\host\\city\\local-config.json' -Raw"], {encoding: 'utf8'})).token;
const H = {'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'};
const get = async path => (await fetch(CITY + '/api/v0/' + path, {headers: H})).json();
const post = async (path, body) => (await fetch(CITY + '/api/v0/' + path, {method: 'POST', headers: H, body: JSON.stringify(body ?? {})})).json();
const sha = t => execFileSync('git', ['-C', TREE, 'rev-parse', t], {encoding: 'utf8'}).trim();

const evidence = {schema: '4in1-crosshost-evidence-v1', takenAt: new Date().toISOString(), city: CITY};
evidence.implementation = {head: sha('HEAD'), branch: execFileSync('git', ['-C', TREE, 'rev-parse', '--abbrev-ref', 'HEAD'], {encoding: 'utf8'}).trim(), treeClean: execFileSync('git', ['-C', TREE, 'status', '--porcelain'], {encoding: 'utf8'}).trim().length === 0};

// 1. Both hosts, as the City describes them.
const nodes = await get('nodes');
evidence.nodes = nodes.nodes.map(node => ({
  id: node.id, displayName: node.displayName, hostname: node.metadata?.hostname, online: node.online,
  agentVersion: node.agentVersion, lastHeartbeatAt: node.lastHeartbeatAt,
  descriptor: (nodes.nodeDescriptors ?? []).find(d => d.nodeId === node.id) ?? null,
}));

// 2. A canonical task strictly targeted at the Alien node, and one at this host, executed for real.
const dispatch = async (node, label) => {
  const action = await post('actions', {route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO',
    input: {targetDeviceRef: node.id}, idempotencyKey: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`});
  const taskId = action?.action?.backendRef?.taskId;
  const targetStateAtCreation = action?.action?.provenance?.targetStateAtCreation ?? null;
  let task = null;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 2500));
    task = ((await get('tasks')).tasks ?? []).find(t => t.id === taskId) ?? null;
    if (task && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.state)) break;
  }
  return {label, requestedTarget: node.id, targetStateAtCreation, taskId, state: task?.state ?? 'NOT_OBSERVED',
    progress: task?.progress ?? null, assignedNodeId: task?.assignedNodeId ?? null, result: task?.result ?? null,
    assignedToRequestedTarget: task?.assignedNodeId === node.id};
};
const alien = evidence.nodes.find(n => /alien/i.test(n.displayName) || /alianware/i.test(n.hostname ?? ''));
const local = evidence.nodes.find(n => n !== alien);
evidence.execution = [];
if (alien) evidence.execution.push(await dispatch(alien, 'alien'));
if (local) evidence.execution.push(await dispatch(local, 'mech'));

// 3. The public LAN browse on the shipped head (the route whose self-filter used to throw on shutdown).
try {
  const browse = await (await fetch(CITY + '/api/v0/join/nearby', {headers: {'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'}})).json();
  evidence.lanBrowse = {status: 'OK', bounded: browse.bounded ?? null, discovered: browse.discovered ?? null,
    excludedSelf: browse.excludedSelf ?? null, unavailable: browse.unavailable === true, reason: browse.reason ?? null, rows: (browse.nearby ?? []).length};
} catch (error) { evidence.lanBrowse = {status: 'ERROR', message: error.message}; }

// 4. City health + the four series' surfaces the pack claims to expose.
evidence.health = await get('health');
evidence.tasksTotal = ((await get('tasks')).tasks ?? []).length;
evidence.pcf = (await get('pcf'))?.fabric?.completeness ?? null;
evidence.governance = (await get('governance'))?.governance ? 'AVAILABLE' : 'UNAVAILABLE';

await mkdir(OUT, {recursive: true});
await writeFile(resolve(OUT, 'crosshost-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
