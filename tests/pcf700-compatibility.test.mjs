// PCF-700 compatibility counter-examples / 兼容反例
//
// The workbook asks for compatibility COUNTER-EXAMPLES rather than happy paths: the behaviours the fabric must NOT
// break while PCF is built. Each test is a guard on an existing seam, so a red run here is a finding about this
// head, not a missing implementation. The audit's own claim - "a function is exported" is not "it is wired" - is
// itself encoded as a structural guard (C6/C7), so wiring one of those seams later cannot happen silently: it
// breaks a test and forces the ownership map to be updated.
//
// MEASURED along the way, and encoded rather than smoothed over:
//   * `POST /api/v0/tasks` accepts ONLY a task type ("parameters are not accepted"), so a strict target cannot be
//     smuggled in through it - the targeted-task path is the campaign runner, and the claim-time guard is what this
//     suite exercises by placing a targeted task in the canonical store, exactly as the runner does.
//   * `POST /api/v0/node/register` REQUIRES capabilities (array of strings) and treats `roles` as optional; the
//     descriptor contract is the layer that tolerates a legacy record, which is why C5 tests both layers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {describeLegacyNode, assertNodeDescriptor} from '../contracts/node-descriptor-v1/node-descriptor.mjs';
import {STRICT_TARGET_FIELD, TARGET_REASONS, claimAllowedByTarget, classifyTarget, isStrictTarget, isWaitingForTarget} from '../services/dev-gateway/targeting.mjs';

const H = credential => ({Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const ask = async (app, path, {body, credential = 'owner'} = {}) => {
  const response = await fetch(`${app.url}/api/v0/${path}`, {method: body ? 'POST' : 'GET', headers: H(credential), body: body ? JSON.stringify(body) : undefined});
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a non-JSON body is reported by its status */ }
  return {status: response.status, body: json, text};
};
const withCity = async fn => {
  const dir = await mkdtemp(resolve('.scratch-pcf700-'));
  const app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
  try { return await fn(app, dir); } finally { await app.close(); await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); }
};
/** Registration as the LIVE route requires it: capabilities are mandatory, roles are not. */
const register = (app, id, extra = {}) => ask(app, 'node/register', {credential: 'node', body: {id, displayName: id, capabilities: ['task.execute.safe', 'filesystem.temp'], metadata: {platform: 'reference'}, ...extra}});
const claimAs = (app, id) => ask(app, 'node/claim', {credential: 'node', body: {id}});
const source = rel => readFile(new URL(rel, import.meta.url), 'utf8');

test('PCF-700 C1: a City with no fabric or workbench configuration starts and serves with the default backend', async () => {
  await withCity(async (app, dir) => {
    const health = await ask(app, 'health');
    assert.equal(health.status, 200, 'a bare City must still answer health');
    const city = await ask(app, 'city');
    assert.equal(city.status, 200);
    assert.equal(city.body.executionBackend?.profile, 'STANDARD_DEVICES', 'the default profile must be the pre-PCF one');
    assert.equal(city.body.executionBackend?.backend?.backendId, 'standard-devices', 'the default backend must remain standard-devices');
    const entries = await readdir(dir);
    assert.ok(!entries.some(name => /personal-compute-fabric|pcf/i.test(name)), `a bare City must not create PCF state, saw: ${entries.join(', ')}`);
  });
});

test('PCF-700 C2: a legacy untargeted task is still claimable by any able node', async () => {
  await withCity(async app => {
    assert.equal((await register(app, 'legacy-worker')).status, 200);
    const created = await ask(app, 'tasks', {body: {type: 'WAIT'}});
    assert.equal(created.status, 200, `task creation answered ${created.status} ${created.text.slice(0, 120)}`);
    assert.equal(created.body[STRICT_TARGET_FIELD] ?? null, null, 'an untargeted task must carry no strict target');
    const claimed = await claimAs(app, 'legacy-worker');
    assert.equal(claimed.status, 200);
    assert.ok(claimed.body.task, 'an untargeted task must remain claimable by an able node');
    assert.equal(claimed.body.task.assignedNodeId, 'legacy-worker');
  });
});

test('PCF-700 C3: a task whose strict target is absent is withheld from other nodes, never silently re-routed', async () => {
  await withCity(async app => {
    assert.equal((await register(app, 'worker-a')).status, 200);
    // The runner creates a targeted task exactly like this; the claim POST below then goes through the real guard.
    const now = new Date().toISOString();
    app.store.put('tasks', {id: 'Q-pcf700-targeted', type: 'WAIT', domain: 'system', state: 'QUEUED', [STRICT_TARGET_FIELD]: 'ghost-node', createdAt: now, updatedAt: now});
    const claimed = await claimAs(app, 'worker-a');
    assert.equal(claimed.status, 200, `claim answered ${claimed.status} ${claimed.text.slice(0, 120)}`);
    assert.equal(claimed.body.task, null, 'an online node must not be handed a task that belongs to another device');
    const withheld = claimed.body.withheld ?? [];
    const row = withheld.find(entry => entry.taskId === 'Q-pcf700-targeted' || entry.id === 'Q-pcf700-targeted');
    assert.ok(row, `the withheld projection must name the work that is not this node's: ${JSON.stringify(withheld)}`);
    // MEASURED: from the claiming node's point of view the reason is BOUND, and it names the device the work is
    // held for - the target vocabulary, not a bare refusal.
    assert.equal(row.reason, TARGET_REASONS.BOUND, `the refusal must carry the target vocabulary, saw ${row.reason}`);
    assert.equal(row.heldFor, 'ghost-node', 'the withheld row must name the device the work is held for');
    assert.equal(row.askedBy, 'worker-a', 'the withheld row must name who asked');
    // The pure guard and the live route must agree, or one of them is the bug. classifyTarget answers the
    // node-centric question (KNOWN / ONLINE / ELIGIBLE) and reports `claimable`, not `ok`.
    assert.equal(claimAllowedByTarget({[STRICT_TARGET_FIELD]: 'ghost-node'}, 'worker-a'), false);
    const classified = classifyTarget({[STRICT_TARGET_FIELD]: 'ghost-node', nodes: app.store.list('nodes'), claimNodeFor: () => null, acceptsWork: () => true});
    assert.equal(classified.state, 'UNKNOWN', 'a target that never registered must classify as UNKNOWN');
    assert.equal(classified.claimable, false, 'an UNKNOWN target is never claimable');
    assert.equal(classified.reason, TARGET_REASONS.UNKNOWN);
    // And a live worker that is simply not the named device classifies as BOUND, which is what the route reports.
    assert.equal(isWaitingForTarget({[STRICT_TARGET_FIELD]: 'ghost-node', state: 'QUEUED'}, []), true);
    assert.deepEqual(isStrictTarget({[STRICT_TARGET_FIELD]: 'ghost-node'}), true);
  });
});

test('PCF-700 C4: a result returns to the canonical origin surface, not only to the executor', async () => {
  await withCity(async app => {
    assert.equal((await register(app, 'worker-a')).status, 200);
    const task = (await ask(app, 'tasks', {body: {type: 'WAIT'}})).body;
    const claimed = await claimAs(app, 'worker-a');
    assert.equal(claimed.body.task?.id, task.id, 'the task must be claimable before it can report');
    await ask(app, 'node/report', {credential: 'node', body: {id: 'worker-a', taskId: task.id, state: 'RUNNING', progress: 50}});
    const marker = {ok: true, pcf700: 'origin-read'};
    assert.equal((await ask(app, 'node/report', {credential: 'node', body: {id: 'worker-a', taskId: task.id, state: 'COMPLETED', progress: 100, result: marker}})).status, 200);
    const listed = await ask(app, 'tasks');
    const row = (listed.body.tasks ?? []).find(entry => entry.id === task.id);
    assert.ok(row, 'the canonical task must be readable from the City');
    assert.equal(row.state, 'COMPLETED');
    assert.deepEqual(row.result, marker, 'the canonical result must be the one the origin reads');
  });
});

test('PCF-700 C5: a legacy descriptor is tolerated by the contract, and the live route states what it requires', async () => {
  const legacyRecord = {id: 'legacy-node', displayName: 'Legacy node', metadata: {platform: 'reference'}};
  const descriptor = describeLegacyNode(legacyRecord);
  assert.equal(descriptor.nodeId, 'legacy-node');
  assert.equal(descriptor.roleSource, 'LEGACY_DEFAULT', 'a record with no roles must be described with defaults, not rejected');
  assert.ok(Array.isArray(descriptor.roles) && descriptor.roles.length >= 1);
  assert.doesNotThrow(() => assertNodeDescriptor(descriptor), 'the described legacy node must satisfy the contract');
  await withCity(async app => {
    // MEASURED: the live register route requires capabilities and treats roles as optional - a record with neither
    // is refused 400 with the route's own message. Recorded as a finding for the seam, not smoothed over here.
    const withoutCapabilities = await ask(app, 'node/register', {credential: 'node', body: legacyRecord});
    assert.equal(withoutCapabilities.status, 400, 'the live route requires capabilities; if this changes the map must be updated');
    const registered = await ask(app, 'node/register', {credential: 'node', body: {id: 'legacy-node', displayName: 'Legacy node', capabilities: ['task.execute.safe'], metadata: {platform: 'reference'}}});
    assert.equal(registered.status, 200, `registration without roles must succeed, answered ${registered.status} ${registered.text.slice(0, 140)}`);
    const nodes = await ask(app, 'nodes');
    const row = (nodes.body.nodes ?? []).find(entry => entry.id === 'legacy-node');
    assert.ok(row, 'the legacy node must appear in the live node list');
    const described = (nodes.body.nodeDescriptors ?? []).find(entry => (entry.nodeId ?? entry.id) === 'legacy-node');
    assert.ok(described, 'the live node list must describe the legacy node');
    assert.equal(described.roleSource, 'LEGACY_DEFAULT', 'a registration without roles must be described as a legacy default');
  });
});

test('PCF-700 C6: the HYBRID helper is exported but NOT wired into the gateway (frozen as NOT_WIRED)', async () => {
  const gateway = await source('../services/dev-gateway/server.mjs');
  assert.ok(!/chooseHybridTarget\s*\(/.test(gateway),
    'the gateway now calls chooseHybridTarget: HYBRID selection has been wired, so the ownership map must move it off NOT_WIRED');
  const profileModule = await import('../services/dev-gateway/execution-profile.mjs');
  assert.equal(typeof profileModule.chooseHybridTarget, 'function', 'the pure helper itself must keep existing');
});

test('PCF-700 C7: the pooled backend is registered but not active, and the strict-target guard is wired into claim', async () => {
  await withCity(async app => {
    const city = await ask(app, 'city');
    assert.equal(city.body.executionBackend?.backend?.backendId, 'standard-devices', 'the worker pool must not become active merely by being registered');
    const gateway = await source('../services/dev-gateway/server.mjs');
    assert.ok(/register\(createWorkerPoolBackend\(\)\)/.test(gateway), 'the pool registration call is the seam the map records');
    const backend = await source('../services/dev-gateway/execution-backend/standard-devices.mjs');
    assert.ok(/claimAllowedByTarget\(task, ?row\.endpointRef\)|claimAllowedByTarget\(task, ?target\.id\)/.test(backend),
      'the claim path must consult the strict-target guard at dispatch time, not only inside a helper');
  });
});
