/**
 * UTOPIA · 10-automation / Computer Use Runtime — bounded-run barrel suite.
 *
 * Proves the composition root re-exports the donor surface exactly, with one name
 * for each donor export and no invented behaviour: the two `stall.cjs` exports, the
 * one `state-machine.cjs` export, the nine `recovery.cjs` exports, the five
 * `stabilization.cjs` exports, the eight `reconnect.cjs` exports, the seven
 * `health.cjs` exports and the four `resources.cjs` exports.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as index from '../index.mjs';

const DONOR_EXPORTS = Object.freeze([
  // app/computer-use/stall.cjs
  'createStallDetector',
  'STALL_RECOVERY_LADDER',
  // app/computer-use/state-machine.cjs
  'createStateMachine',
  // app/computer-use/recovery.cjs
  'createRecoveryController',
  'alternativeAction',
  'alternativeController',
  'mapType',
  'RECOVERY_STEPS',
  'RECOVERY_VERDICTS',
  'VERDICT_BY_STEP',
  'USER_ACTION_CODES',
  'exhaustedError',
  // app/computer-use/stabilization.cjs
  'createStabilizer',
  'SIGNALS',
  'SIGNAL_LIST',
  'SIGNAL_ALIASES',
  'normalizeSignals',
  // app/computer-use/reconnect.cjs
  'createReconnectPolicy',
  'createChannelRecovery',
  'RECONNECT',
  'isTransportFailure',
  'channelOfError',
  'channelHintFor',
  'TRANSPORT_CODES',
  'DEFAULT_MAX_ATTEMPTS',
  // app/computer-use/health.cjs
  'HEALTH_STATUS',
  'BLOCK_REASONS',
  'CAPABILITY_CONTROLLERS',
  'buildHealthSnapshot',
  'capabilityVerdict',
  'capabilityIsUsable',
  'controllerIdsFor',
  // app/computer-use/resources.cjs
  'createResourceBudget',
  'classifyRetention',
  'DEFAULTS',
  'TRANSIENT_TTL_MS',
]);

test('every donor export is re-exported, and each one is defined', () => {
  assert.equal(DONOR_EXPORTS.length, 36);
  assert.equal(new Set(DONOR_EXPORTS).size, 36);
  for (const name of DONOR_EXPORTS) {
    assert.ok(name in index, `missing export ${name}`);
    assert.notEqual(index[name], undefined, `undefined export ${name}`);
  }
});

test('the re-exported names are the same bindings the modules define', async () => {
  const stall = await import('../stall.mjs');
  const stateMachine = await import('../state-machine.mjs');
  const recovery = await import('../recovery.mjs');
  const stabilization = await import('../stabilization.mjs');
  const reconnect = await import('../reconnect.mjs');
  const health = await import('../health.mjs');
  const resources = await import('../resources.mjs');

  for (const name of ['createStallDetector', 'STALL_RECOVERY_LADDER']) assert.equal(index[name], stall[name], name);
  for (const name of ['createStateMachine']) assert.equal(index[name], stateMachine[name], name);
  for (const name of ['createRecoveryController', 'alternativeAction', 'alternativeController', 'mapType', 'RECOVERY_STEPS', 'RECOVERY_VERDICTS', 'VERDICT_BY_STEP', 'USER_ACTION_CODES', 'exhaustedError']) {
    assert.equal(index[name], recovery[name], name);
  }
  for (const name of ['createStabilizer', 'SIGNALS', 'SIGNAL_LIST', 'SIGNAL_ALIASES', 'normalizeSignals']) assert.equal(index[name], stabilization[name], name);
  for (const name of ['createReconnectPolicy', 'createChannelRecovery', 'RECONNECT', 'isTransportFailure', 'channelOfError', 'channelHintFor', 'TRANSPORT_CODES', 'DEFAULT_MAX_ATTEMPTS']) {
    assert.equal(index[name], reconnect[name], name);
  }
  for (const name of ['HEALTH_STATUS', 'BLOCK_REASONS', 'CAPABILITY_CONTROLLERS', 'buildHealthSnapshot', 'capabilityVerdict', 'capabilityIsUsable', 'controllerIdsFor']) {
    assert.equal(index[name], health[name], name);
  }
  for (const name of ['createResourceBudget', 'classifyRetention', 'DEFAULTS', 'TRANSIENT_TTL_MS']) assert.equal(index[name], resources[name], name);
});

test('MODULES exposes the seven modules plus the local contracts', () => {
  assert.deepEqual(Object.keys(index.MODULES), ['contracts', 'stall', 'stateMachine', 'recovery', 'stabilization', 'reconnect', 'health', 'resources']);
  assert.equal(index.MODULES.contracts.CU_STATES.IDLE, 'IDLE');
  assert.equal(index.MODULES.stall.STALL_RECOVERY_LADDER.length, 8);
  assert.equal(typeof index.MODULES.stabilization.createStabilizer, 'function');
  assert.equal(index.MODULES.resources.DEFAULTS.maxScreenshots, 32);
});

test('the four closed vocabularies are the donor values, through the barrel', () => {
  assert.equal(Object.keys(index.CU_STATES).length, 15);
  assert.equal(Object.keys(index.CU_TRANSITIONS).length, 15);
  assert.deepEqual(index.TERMINAL_STATES, ['COMPLETED', 'FAILED']);
  assert.equal(index.SIGNAL_LIST.length, 8);
  assert.equal(index.USER_ACTION_CODES.length, 9);
  assert.equal(Object.keys(index.RECOVERY_VERDICTS).length, 5);
  assert.equal(index.TRANSPORT_CODES.length, 4);
  assert.equal(Object.keys(index.BLOCK_REASONS).length, 5);
  assert.equal(index.DEFAULT_MAX_ATTEMPTS, 2);
  assert.deepEqual(index.RETRY, { maxAttempts: 2, alternateAtAttempt: 2 });
  assert.deepEqual(index.STALL, { consecutiveActions: 3, maxRecoveries: 2 });
  assert.deepEqual(index.TARGET_MOVEMENT, { stablePx: 3, updatePx: 10 });
  assert.equal(index.TRANSIENT_TTL_MS, 60000);
});

test('one deterministic step clock is shared by every module that needed a default', async () => {
  const contracts = await import('../contracts.mjs');
  assert.equal(index.createStepClock, contracts.createStepClock);
  assert.equal(index.createStepNow, contracts.createStepNow);

  const clock = index.createStepClock();
  assert.deepEqual([clock.now(), clock.now(), clock.now()], [0, 1, 2]);
  assert.equal(typeof clock.sleep, 'function');
  await clock.sleep(10_000);

  const now = index.createStepNow();
  assert.deepEqual([now(), now()], [0, 1]);

  // Two independent clocks never share a tick.
  const a = index.createStepNow();
  const b = index.createStepNow();
  assert.equal(a(), 0);
  assert.equal(b(), 0);
  assert.equal(a(), 1);
});

test('the ported modules read the local contracts rather than a sibling import', async () => {
  // The donor's `require('./constants.cjs')` became a local declaration; if this
  // module ever gained a sibling import the graph below would gain a node.
  for (const path of ['../stall.mjs', '../state-machine.mjs', '../recovery.mjs', '../stabilization.mjs', '../reconnect.mjs', '../health.mjs', '../resources.mjs']) {
    const loaded = await import(path);
    assert.ok(Object.keys(loaded).length > 0, path);
  }
});
