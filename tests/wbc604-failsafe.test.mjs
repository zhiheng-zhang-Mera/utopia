// WBC-604 fail-safe / rollback evidence, as the workbook's "Fail-safe / rollback" section demands.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createExecutionProfileController} from '../services/dev-gateway/execution-profile.mjs';
import {createGateway} from '../services/dev-gateway/server.mjs';

const H = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const withDir = async fn => { const dir = await mkdtemp(resolve('.scratch-wbc604-safe-')); try { await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); } };
const registry = state => ({readiness: () => ({state})});

test('WBC604 fail-safe: a persisted profile whose backend is no longer ready degrades to the rollback profile', async () => {
  await withDir(async dir => {
    await writeFile(resolve(dir, 'execution-profile.json'), JSON.stringify({profile: 'WORKER_POOL', changedAt: 1}), 'utf8');
    // The pool existed when the selection was made and is gone at restart: the City must still run, and must say so.
    const controller = createExecutionProfileController({dir, registry: registry('ABSENT')});
    assert.equal(controller.profile(), 'STANDARD_DEVICES', 'an unusable persisted profile must not be the running profile');
    const state = controller.state();
    assert.equal(state.selection, 'DEGRADED_TO_DEFAULT');
    assert.equal(state.selectedProfile, 'WORKER_POOL', 'the request stays visible rather than being forgotten');
    assert.equal(state.degradedFrom, 'WORKER_POOL');
    assert.equal(state.recovery.code, 'PROFILE_NOT_READY');
    assert.match(state.recovery.detail, /WORKER_POOL is ABSENT/);

    // ...and when the pool is ready again the same persisted selection is simply adopted.
    const healthy = createExecutionProfileController({dir, registry: registry('READY')});
    assert.equal(healthy.profile(), 'WORKER_POOL');
    assert.equal(healthy.state().selection, 'PERSISTED');
    assert.equal(healthy.state().degradedFrom, null);
  });
});

test('WBC604 fail-safe: a change never leaves the persisted file disagreeing with the running profile', async () => {
  await withDir(async dir => {
    let state = 'READY';
    const controller = createExecutionProfileController({dir, registry: {readiness: () => ({state})}});
    controller.change('WORKER_POOL');
    // The pool disappears between two requests: the refusal must not have touched what is on disk.
    state = 'UNAVAILABLE';
    assert.throws(() => controller.change('HYBRID'), /not ready/);
    const persisted = JSON.parse(await readFile(resolve(dir, 'execution-profile.json'), 'utf8'));
    assert.equal(persisted.profile, 'WORKER_POOL', 'a refused change writes nothing');
    assert.equal(controller.profile(), 'WORKER_POOL', 'and the running profile is untouched');
    // Rollback still works with the pool gone, and it is what the file then records.
    controller.rollback();
    assert.equal(JSON.parse(await readFile(resolve(dir, 'execution-profile.json'), 'utf8')).profile, 'STANDARD_DEVICES');
  });
});

test('WBC604 fail-safe: changing or rolling back the profile never rewrites canonical task truth', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc604-truth-'));
  const app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
  const call = async (path, {method = 'GET', body} = {}) => {
    const response = await fetch(app.url + '/api/v0/' + path, {method, headers: {...H, Authorization: 'Bearer owner'}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, data: await response.json()};
  };
  try {
    const created = await call('tasks', {method: 'POST', body: {type: 'WAIT'}});
    assert.equal(created.status, 200);
    const before = await call('city');
    const taskBefore = before.data.tasks.find(task => task.id === created.data.id);
    assert.ok(taskBefore, 'the fixture needs one canonical task');

    // Every profile action a City can currently take, including the ones that are refused.
    assert.equal((await call('execution-profile', {method: 'POST', body: {profile: 'WORKER_POOL'}})).status, 409);
    assert.equal((await call('execution-profile', {method: 'POST', body: {action: 'ROLLBACK'}})).status, 200);
    assert.equal((await call('execution-profile', {method: 'POST', body: {profile: 'HYBRID'}})).status, 409);

    const after = await call('city');
    const taskAfter = after.data.tasks.find(task => task.id === created.data.id);
    assert.deepEqual(taskAfter, taskBefore, 'profile changes must not touch a canonical task record');
    assert.equal(after.data.executionBackend.profile, 'STANDARD_DEVICES', 'and the snapshot reports the live profile');
  } finally { await app.close(); await rm(dir, {recursive: true, force: true}); }
});

test('WBC604 fail-safe: readiness is re-read on every question, never cached into a stale answer', async () => {
  await withDir(async dir => {
    let state = 'ABSENT';
    const reasonFor = s => (s === 'READY' ? null : 'POOL_HAS_NO_READY_NODE');
    const controller = createExecutionProfileController({dir, registry: {readiness: () => ({state, reason: reasonFor(state)})}});
    assert.equal(controller.state().profiles.find(entry => entry.profile === 'WORKER_POOL').activatable, false);
    state = 'READY';
    assert.equal(controller.state().profiles.find(entry => entry.profile === 'WORKER_POOL').activatable, true, 'a pool that becomes ready must become switchable without a restart');
    const switched = controller.change('HYBRID');
    assert.equal(switched.to, 'HYBRID');
    state = 'DEGRADED';
    const stale = controller.state().profiles.find(entry => entry.profile === 'HYBRID');
    assert.equal(stale.activatable, false, 'and a pool that degrades again must be reported as not activatable');
    assert.equal(stale.reason, 'POOL_HAS_NO_READY_NODE', 'with the reason, not just the verdict');
  });
});
