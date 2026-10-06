// WBC-604: the profile switch and the HYBRID precedence, tested as contracts rather than behaviours.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createExecutionProfileController, chooseHybridTarget, ProfileChangeError, PROFILE_CODES} from '../services/dev-gateway/execution-profile.mjs';

const registry = (state = 'READY') => ({readiness: () => ({state, reason: state === 'READY' ? null : 'POOL_HAS_NO_READY_NODE'})});
const withDir = async fn => {
  const dir = await mkdtemp(resolve('.scratch-wbc604-'));
  try { await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); }
};

test('WBC604 profile: STANDARD_DEVICES is the default and is always an available rollback', async () => {
  await withDir(async dir => {
    const controller = createExecutionProfileController({dir, registry: registry('UNAVAILABLE')});
    const state = controller.state();
    assert.equal(state.profile, 'STANDARD_DEVICES');
    assert.equal(state.defaultProfile, 'STANDARD_DEVICES');
    assert.equal(state.selection, 'DEFAULT');
    assert.deepEqual(state.profiles.map(entry => entry.profile), ['STANDARD_DEVICES', 'WORKER_POOL', 'HYBRID']);
    const rollback = state.profiles.find(entry => entry.profile === 'STANDARD_DEVICES');
    assert.equal(rollback.activatable, true, 'the rollback profile must stay enterable even when every pool is down');
    assert.equal(rollback.reason, 'ROLLBACK_PROFILE');
  });
});

test('WBC604 profile: a not-ready switch is REFUSED with a typed code and writes nothing at all', async () => {
  await withDir(async dir => {
    const controller = createExecutionProfileController({dir, registry: registry('DEGRADED')});
    assert.throws(() => controller.change('WORKER_POOL'), error => {
      assert.ok(error instanceof ProfileChangeError);
      assert.equal(error.code, PROFILE_CODES.NOT_READY);
      assert.equal(error.detail.kept, 'STANDARD_DEVICES', 'the refusal states which profile was kept');
      assert.equal(error.detail.state, 'DEGRADED');
      return true;
    });
    assert.equal(controller.profile(), 'STANDARD_DEVICES', 'a refused change must not half-switch');
    assert.equal(existsSync(resolve(dir, 'execution-profile.json')), false, 'a refused change must not persist anything');
  });
});

test('WBC604 profile: a ready switch activates, persists, and survives a restart', async () => {
  await withDir(async dir => {
    const first = createExecutionProfileController({dir, registry: registry('READY')});
    const receipt = first.change('WORKER_POOL');
    assert.equal(receipt.changed, true);
    assert.equal(receipt.from, 'STANDARD_DEVICES');
    assert.equal(receipt.to, 'WORKER_POOL');
    assert.equal(receipt.reason, 'ACTIVATED');
    const persisted = JSON.parse(await readFile(resolve(dir, 'execution-profile.json'), 'utf8'));
    assert.equal(persisted.profile, 'WORKER_POOL');

    const second = createExecutionProfileController({dir, registry: registry('READY')});
    assert.equal(second.profile(), 'WORKER_POOL', 'the selection must survive a restart without any code change');
    assert.equal(second.state().selection, 'PERSISTED');
  });
});

test('WBC604 profile: an untrustworthy persisted value recovers to the safe default instead of being obeyed', async () => {
  await withDir(async dir => {
    await writeFile(resolve(dir, 'execution-profile.json'), '{"profile":"TURBO_MODE"}', 'utf8');
    const controller = createExecutionProfileController({dir, registry: registry('READY')});
    assert.equal(controller.profile(), 'STANDARD_DEVICES', 'an unknown persisted profile must not be adopted');
    assert.equal(controller.state().selection, 'RECOVERED_TO_DEFAULT');
    assert.equal(controller.state().recovery.code, PROFILE_CODES.UNKNOWN_PROFILE);

    await writeFile(resolve(dir, 'execution-profile.json'), '{ this is not json', 'utf8');
    const broken = createExecutionProfileController({dir, registry: registry('READY')});
    assert.equal(broken.profile(), 'STANDARD_DEVICES');
    assert.equal(broken.state().recovery.code, PROFILE_CODES.RECOVERY_REQUIRED);
    assert.match(broken.state().recovery.detail, /unreadable/);
  });
});

test('WBC604 profile: unknown profiles and no-op changes are answered distinctly, never silently', async () => {
  await withDir(async dir => {
    const controller = createExecutionProfileController({dir, registry: registry('READY')});
    assert.throws(() => controller.change('HYBRID_V2'), error => {
      assert.equal(error.code, PROFILE_CODES.UNKNOWN_PROFILE);
      assert.deepEqual(error.detail.supported, ['STANDARD_DEVICES', 'WORKER_POOL', 'HYBRID']);
      return true;
    });
    const noop = controller.change('STANDARD_DEVICES');
    assert.equal(noop.changed, false);
    assert.equal(noop.reason, 'ALREADY_SELECTED');
  });
});

test('WBC604 profile: rollback returns to STANDARD_DEVICES even after the pool disappears', async () => {
  await withDir(async dir => {
    let state = 'READY';
    const controller = createExecutionProfileController({dir, registry: {readiness: () => ({state})}});
    controller.change('HYBRID');
    assert.equal(controller.profile(), 'HYBRID');
    state = 'UNAVAILABLE';
    const back = controller.rollback();
    assert.equal(back.changed, true);
    assert.equal(back.to, 'STANDARD_DEVICES');
    assert.equal(controller.profile(), 'STANDARD_DEVICES', 'rollback must not depend on the pool being healthy');
    const refused = (() => { try { controller.change('HYBRID'); return null; } catch (error) { return error; } })();
    assert.equal(refused?.code, PROFILE_CODES.NOT_READY, 'and it must not be able to go back out while the pool is down');
  });
});

test('WBC604 hybrid: an explicit strict target outranks every general rule and is never reinterpreted', () => {
  const candidates = [{nodeId: 'fast', freeSlots: 9, capabilities: ['task.execute.safe']}, {nodeId: 'strict', freeSlots: 0, capabilities: []}];
  const chosen = chooseHybridTarget({task: {strictTargetRef: 'strict'}, candidates});
  assert.equal(chosen.chosen, 'strict');
  assert.equal(chosen.rule, 'STRICT_TARGET');
  assert.equal(chooseHybridTarget({task: {strictTargetRef: 'ghost'}, candidates}).chosen, null);
  assert.equal(chooseHybridTarget({task: {strictTargetRef: 'ghost'}, candidates}).rule, 'STRICT_TARGET_ABSENT');
  assert.equal(chooseHybridTarget({task: {strictTargetRef: 'strict'}, candidates: [{nodeId: 'strict', trusted: false}]}).rule, 'STRICT_TARGET_UNTRUSTED');
});

test('WBC604 hybrid: a hard capability requirement outranks load, and validation work goes to a validation node', () => {
  const candidates = [
    {nodeId: 'idle', freeSlots: 99, capabilities: ['task.execute.safe'], ready: true},
    {nodeId: 'capable', freeSlots: 1, capabilities: ['task.execute.safe', 'filesystem.temp'], ready: true},
  ];
  const chosen = chooseHybridTarget({task: {requiredCapabilities: ['filesystem.temp']}, candidates});
  assert.equal(chosen.chosen, 'capable', 'a hard requirement decides, not free capacity');
  assert.equal(chosen.rule, 'HARD_REQUIREMENT');

  const validation = chooseHybridTarget({task: {requiredCapabilities: ['filesystem.temp'], requiredPlatform: 'win32'}, candidates: [...candidates, {nodeId: 'validator', freeSlots: 0, capabilities: ['filesystem.temp'], platform: 'win32', roles: ['EXECUTION_NODE', 'VALIDATION_NODE'], validationCapable: true, ready: true}]});
  assert.equal(validation.chosen, 'validator');
  assert.equal(validation.rule, 'VALIDATION_NODE');

  assert.equal(chooseHybridTarget({task: {requiredCapabilities: ['gpu.render']}, candidates}).rule, 'NO_CAPABLE_NODE');
});

test('WBC604 hybrid: a legacy task that declares nothing keeps the compatible default', () => {
  const candidates = [{nodeId: 'pool-1', freeSlots: 5, ready: true}];
  const legacy = chooseHybridTarget({task: {}, candidates});
  assert.equal(legacy.chosen, null, 'a task with no requirements must not be rerouted by the new resource model');
  assert.equal(legacy.rule, 'LEGACY_DEFAULT');
  assert.equal(chooseHybridTarget({task: {policyAllowsFallback: true}, candidates}).rule, 'LOAD_PREFERENCE');
  assert.equal(chooseHybridTarget({task: {policyAllowsFallback: true}, candidates, poolAvailable: false}).rule, 'POOL_UNAVAILABLE');
});

test('WBC604 hybrid: an untrusted node is never a candidate, whatever its capacity', () => {
  const chosen = chooseHybridTarget({task: {policyAllowsFallback: true}, candidates: [{nodeId: 'untrusted', freeSlots: 99, ready: true, trusted: false}]});
  assert.equal(chosen.chosen, null);
  assert.equal(chosen.rule, 'NO_READY_NODE');
});
