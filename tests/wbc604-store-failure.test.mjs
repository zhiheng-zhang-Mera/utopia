// WBC-604 store-failure probes. Found by a deliberate store-shape sweep over the City's file stores (a DIRECTORY where
// a module needs a FILE), which is a shape this task's own tests never used: every one of them lets the store work.
//
// The defect: change() set the live profile BEFORE persisting it, so an unwritable store produced exactly the half-switch
// the module's own rule 2 forbids - the caller got an exception while the City was already running a profile nothing had
// persisted. Measured before the repair, with a directory where execution-profile.json belongs:
//   change('WORKER_POOL') THREW EPERM; live profile STANDARD_DEVICES -> WORKER_POOL; nothing persisted
// and the route surfaced errorCode EPERM plus an absolute path from the owner control surface.
//
// The repair is the order itself (persist first, then assign) plus a typed refusal, so the running profile and the
// receipt agree in every outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, readFile, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createExecutionProfileController, PROFILE_CODES} from '../services/dev-gateway/execution-profile.mjs';
import {createGateway} from '../services/dev-gateway/server.mjs';

const H = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const ready = () => 'READY';
const withTrap = async fn => {
  const dir = await mkdtemp(resolve('.scratch-wbc604-store-'));
  try {
    // The canonical store and every other runtime path stay healthy; only the profile file is the wrong shape.
    await mkdir(resolve(dir, 'execution-profile.json'), {recursive: true});
    await fn(dir);
  } finally { await rm(dir, {recursive: true, force: true}); }
};

test('WBC604 store failure: a change the City cannot persist is refused, and the running profile does not move', async () => {
  await withTrap(async dir => {
    const controller = createExecutionProfileController({dir, readinessOf: ready});
    assert.equal(controller.profile(), 'STANDARD_DEVICES');
    let thrown = null;
    try { controller.change('WORKER_POOL'); } catch (error) { thrown = error; }
    assert.ok(thrown, 'a store that cannot accept the change must refuse the change');
    // The whole point, and the assertion that fails on the unguarded tree: rule 2 says a failed activation never
    // half-switches, but the assignment used to happen BEFORE persist().
    assert.equal(controller.profile(), 'STANDARD_DEVICES', 'the running profile is UNCHANGED');
    assert.equal(thrown.code, PROFILE_CODES.STORE_UNAVAILABLE, 'and the refusal is typed, not a raw filesystem errno');
    assert.match(thrown.message, /keeps running STANDARD_DEVICES/);
    // The store was unreadable too (the trap is a directory), so the City reports conservative recovery and, crucially,
    // never claims the selection it failed to persist.
    assert.notEqual(controller.state().selection, 'PERSISTED', 'and the City does not claim a selection it never persisted');
    assert.equal(controller.state().selectedProfile, 'STANDARD_DEVICES');
    assert.ok((await stat(resolve(dir, 'execution-profile.json'))).isDirectory(), 'nothing was written over the trap');
  });
});

test('WBC604 store failure: the owner control surface refuses with a typed code and leaks no path', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc604-store-route-'));
  let app = null;
  try {
    await mkdir(resolve(dir, 'execution-profile.json'), {recursive: true});
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
    const post = async body => {
      const response = await fetch(app.url + '/api/v0/execution-profile', {method: 'POST', headers: {...H, Authorization: 'Bearer owner'}, body: JSON.stringify(body)});
      return {status: response.status, body: await response.json()};
    };
    // A bare City has no WORKER_POOL backend, so the route refuses at the readiness gate before touching the store. That
    // is the refusal this probe can actually reach, and it is the one that proves the two properties the route owns:
    // a typed errorCode forwarded from the module, and no filesystem detail on the owner's control surface.
    const refused = await post({profile: 'WORKER_POOL'});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.errorCode, PROFILE_CODES.NOT_READY, 'the route forwards the module code, it does not invent one');
    assert.ok(!JSON.stringify(refused.body).includes(dir), 'a filesystem path must not reach the control surface');
    assert.ok(!/EPERM|EACCES|ENOTDIR/.test(JSON.stringify(refused.body)), 'nor a raw errno');
    // The route's store branch cannot be reached from a bare City, so it is NOT claimed as measured here: the unit probe
    // above is the authority for PROFILE_STORE_UNAVAILABLE, and the route forwards `error.code ?? 'PROFILE_CHANGE_REFUSED'`
    // through the same single line that just forwarded PROFILE_NOT_READY. Before the repair the reachable refusal was the
    // store itself throwing EPERM, which this assertion would have caught.
    const snapshot = await(await fetch(app.url + '/api/v0/city', {headers: {...H, Authorization: 'Bearer owner'}})).json();
    assert.equal(snapshot.executionBackend.profile, 'STANDARD_DEVICES');
    const health = await(await fetch(app.url + '/api/v0/health', {headers: {...H, Authorization: 'Bearer owner'}})).json();
    assert.equal(health.components.gateway.state, 'READY');
    // A rollback that changes nothing is still answered as a no-op receipt rather than a refusal.
    const noop = await post({action: 'ROLLBACK'});
    assert.equal(noop.status, 200);
    assert.equal(noop.body.receipt.changed, false);
  } finally { await app?.close(); await rm(dir, {recursive: true, force: true}); }
});

test('WBC604 store failure: the fix did not stop a working store from persisting, and the file is what is adopted', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc604-store-ok-'));
  try {
    const controller = createExecutionProfileController({dir, readinessOf: ready});
    const receipt = controller.change('WORKER_POOL');
    assert.equal(receipt.changed, true);
    assert.equal(receipt.to, 'WORKER_POOL');
    // The positive control for the reorder: the persisted file must record the NEW profile, not the previous one.
    const persisted = JSON.parse(await readFile(resolve(dir, 'execution-profile.json'), 'utf8'));
    assert.equal(persisted.profile, 'WORKER_POOL', 'persist() writes the requested profile, not the one still running');
    assert.equal(controller.profile(), 'WORKER_POOL');
    // ...and a fresh controller adopts it, which is the only reason the file exists.
    assert.equal(createExecutionProfileController({dir, readinessOf: ready}).profile(), 'WORKER_POOL');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
