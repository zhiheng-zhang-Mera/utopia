// WBC-604: the control surface as it is actually reachable from a running City.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';

const H = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};

test('WBC604 route: the City reports its profile, refuses an absent pool, and can always roll back', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc604-route-'));
  const app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
  const call = async (path, {method = 'GET', body, credential = 'owner'} = {}) => {
    const response = await fetch(app.url + '/api/v0/' + path, {method, headers: {...H, Authorization: 'Bearer ' + credential}, body: body === undefined ? undefined : JSON.stringify(body)});
    let data = null; try { data = await response.json(); } catch {}
    return {status: response.status, data};
  };
  try {
    const state = await call('execution-profile');
    assert.equal(state.status, 200);
    assert.equal(state.data.executionProfile.profile, 'STANDARD_DEVICES', 'a City starts on the rollback profile');
    assert.equal(state.data.executionProfile.defaultProfile, 'STANDARD_DEVICES');
    assert.deepEqual(state.data.executionProfile.profiles.map(entry => entry.profile), ['STANDARD_DEVICES', 'WORKER_POOL', 'HYBRID']);
    assert.equal(state.data.executionProfile.profiles.find(entry => entry.profile === 'STANDARD_DEVICES').activatable, true);

    // The WORKER_POOL backend is registered DORMANT, so readiness is ABSENT and the switch must be REFUSED with the
    // profile unchanged - the workbook's "no-workbench environment stays fully usable" requirement.
    const refused = await call('execution-profile', {method: 'POST', body: {profile: 'WORKER_POOL'}});
    assert.equal(refused.status, 409);
    assert.equal(refused.data.error, 'PROFILE_NOT_READY', 'a dormant pool must be a typed refusal, not a crash and not a switch');
    const after = await call('execution-profile');
    assert.equal(after.data.executionProfile.profile, 'STANDARD_DEVICES', 'the City kept the working profile');

    // Rollback is a first-class action and is idempotent.
    const rollback = await call('execution-profile', {method: 'POST', body: {action: 'ROLLBACK'}});
    assert.equal(rollback.status, 200);
    assert.equal(rollback.data.receipt.changed, false);
    assert.equal(rollback.data.receipt.reason, 'ALREADY_SELECTED');

    // Unknown profile -> typed refusal, and the City is untouched.
    const unknown = await call('execution-profile', {method: 'POST', body: {profile: 'TURBO'}});
    assert.equal(unknown.status, 409);
    assert.equal(unknown.data.error, 'PROFILE_UNKNOWN');

    // The City still works after every refusal.
    assert.equal((await call('city')).status, 200);

    // A member session may neither read nor change the profile: where work runs is an owner-level decision.
    const memberRead = await call('execution-profile', {credential: 'not-an-owner'});
    assert.ok([401, 403].includes(memberRead.status), 'a non-owner credential must not read the control surface (got ' + memberRead.status + ')');
  } finally { await app.close(); await rm(dir, {recursive: true, force: true}); }
});

test('WBC604 route: a persisted selection is what the restarted City runs', async () => {
  const dir = await mkdtemp(resolve('.scratch-wbc604-restart-'));
  let app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
  try {
    // No profile is switchable while the pool is dormant, so the persisted value is seeded directly - this asserts the
    // RESTART half (the controller reads its own file), not the readiness gate already covered above.
    const {writeFile} = await import('node:fs/promises');
    await app.close();
    await writeFile(resolve(dir, 'execution-profile.json'), JSON.stringify({profile: 'STANDARD_DEVICES', changedAt: Date.now()}), 'utf8');
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
    const state = await fetch(app.url + '/api/v0/execution-profile', {headers: {...H, Authorization: 'Bearer owner'}}).then(r => r.json());
    assert.equal(state.executionProfile.profile, 'STANDARD_DEVICES');
    assert.equal(state.executionProfile.selection, 'PERSISTED', 'the City must read its own persisted selection');
  } finally { await app.close(); await rm(dir, {recursive: true, force: true}); }
});
