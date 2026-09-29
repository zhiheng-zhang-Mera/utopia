/**
 * UTOPIA · Automation District — execution-contract vocabulary parity.
 *
 * Pins every closed vocabulary and its order, every threshold, and the
 * `resolveComputerUseOptions` precedence/clamping rules against the DS-Hns
 * donor `app/computer-use/constants.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b, including the donor quirks the
 * port deliberately keeps (shallow freeze, duplicate capability pass-through,
 * `Number(null) === 0`, `TypeError` on a `null` config block).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_TYPES,
  ACTION_TYPE_LIST,
  ACTION_CAPABILITY,
  CAPABILITY_CONTROLLER,
  ROUTE_CHANNELS,
  CU_STATES,
  CU_TRANSITIONS,
  TERMINAL_STATES,
  VERIFICATION_KINDS,
  VERDICTS,
  SCREENSHOT_LEVELS,
  CAPABILITIES,
  DESTRUCTIVE_KINDS,
  DESTRUCTIVE_MODES,
  SCREENSHOT_RETENTION,
  STEP_RESULTS,
  RUN_STATUS,
  TARGET_MOVEMENT,
  TIMING,
  STALL,
  RETRY,
  CONTRACT_DEFAULTS,
  resolveComputerUseOptions
} from '../contracts.mjs';

test('the action surface is the donor closed list, in donor order', () => {
  assert.deepEqual(ACTION_TYPE_LIST, [
    'MOVE', 'CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'TYPE', 'KEY_PRESS', 'HOTKEY', 'SCROLL', 'DRAG', 'FOCUS',
    'SELECT', 'OPEN_APP', 'CLOSE_WINDOW', 'SWITCH_WINDOW', 'BROWSER_NAVIGATE', 'BROWSER_BACK', 'BROWSER_FORWARD',
    'BROWSER_REFRESH', 'DOM_CLICK', 'DOM_TYPE', 'DOM_SELECT', 'ACCESSIBILITY_INVOKE', 'ACCESSIBILITY_SET_VALUE',
    'SHELL_EXEC', 'FILE_READ', 'FILE_WRITE', 'FILE_COPY', 'FILE_MOVE', 'FILE_DELETE', 'FILE_MKDIR', 'FILE_EXISTS',
    'WAIT_EVENT', 'WAIT_STATE', 'SCREENSHOT_REGION', 'SCREENSHOT_WINDOW', 'SCREENSHOT_FULL'
  ]);
  assert.equal(ACTION_TYPE_LIST.length, 36);
  assert.deepEqual(Object.keys(ACTION_TYPES), [...ACTION_TYPE_LIST]);
  for (const type of ACTION_TYPE_LIST) assert.equal(ACTION_TYPES[type], type);
  assert.equal(Object.isFrozen(ACTION_TYPES), true);
  assert.equal(Object.isFrozen(ACTION_TYPE_LIST), true);
});

test('capability routing covers every action and uses the donor capability names', () => {
  assert.deepEqual(Object.keys(ACTION_CAPABILITY), [...ACTION_TYPE_LIST]);
  assert.equal(Object.keys(ACTION_CAPABILITY).length, 36);
  assert.equal(ACTION_CAPABILITY.MOVE, 'desktop');
  assert.equal(ACTION_CAPABILITY.BROWSER_NAVIGATE, 'browser');
  assert.equal(ACTION_CAPABILITY.DOM_SELECT, 'browser');
  assert.equal(ACTION_CAPABILITY.ACCESSIBILITY_INVOKE, 'desktop');
  assert.equal(ACTION_CAPABILITY.SHELL_EXEC, 'shell');
  assert.equal(ACTION_CAPABILITY.FILE_DELETE, 'filesystem');
  assert.equal(ACTION_CAPABILITY.WAIT_STATE, 'desktop');
  assert.equal(ACTION_CAPABILITY.SCREENSHOT_FULL, 'vision');
});

test('the route ladder is cheapest-first and the controller map is the donor map', () => {
  assert.deepEqual(ROUTE_CHANNELS, ['api', 'file', 'shell', 'dom', 'accessibility', 'gui', 'vision']);
  assert.equal(ROUTE_CHANNELS.length, 7);
  assert.deepEqual(CAPABILITY_CONTROLLER, {
    browser: 'browser',
    dom: 'browser',
    desktop: 'desktop',
    accessibility: 'desktop',
    vision: 'vision',
    screenshot: 'vision',
    shell: 'shell',
    process: 'shell',
    filesystem: 'file',
    file: 'file'
  });
  assert.deepEqual(Object.keys(CAPABILITY_CONTROLLER), [
    'browser', 'dom', 'desktop', 'accessibility', 'vision', 'screenshot', 'shell', 'process', 'filesystem', 'file'
  ]);
});

test('the state machine, its transitions and its terminal states are the donor lists', () => {
  assert.deepEqual(Object.keys(CU_STATES), [
    'IDLE', 'RECEIVING_TASK', 'OBSERVING', 'PLANNING_ACTION', 'STABILIZING', 'REVALIDATING', 'ACTING',
    'POST_ACTION_GRACE', 'VERIFYING', 'RETRYING', 'RECOVERING', 'REPLANNING', 'STALLED', 'COMPLETED', 'FAILED'
  ]);
  assert.equal(Object.keys(CU_STATES).length, 15);
  for (const state of Object.keys(CU_STATES)) assert.equal(CU_STATES[state], state);
  assert.deepEqual(CU_TRANSITIONS, {
    IDLE: ['RECEIVING_TASK'],
    RECEIVING_TASK: ['OBSERVING', 'FAILED'],
    OBSERVING: ['PLANNING_ACTION', 'COMPLETED', 'FAILED'],
    PLANNING_ACTION: ['STABILIZING', 'COMPLETED', 'REPLANNING', 'FAILED'],
    STABILIZING: ['REVALIDATING', 'OBSERVING', 'RETRYING', 'RECOVERING', 'FAILED'],
    REVALIDATING: ['ACTING', 'OBSERVING', 'RETRYING', 'RECOVERING', 'FAILED'],
    ACTING: ['POST_ACTION_GRACE', 'RETRYING', 'RECOVERING', 'FAILED'],
    POST_ACTION_GRACE: ['VERIFYING', 'RETRYING', 'FAILED'],
    VERIFYING: ['OBSERVING', 'RETRYING', 'RECOVERING', 'REPLANNING', 'STALLED', 'COMPLETED', 'FAILED'],
    RETRYING: ['STABILIZING', 'RECOVERING', 'REPLANNING', 'OBSERVING', 'PLANNING_ACTION', 'FAILED'],
    RECOVERING: ['OBSERVING', 'STABILIZING', 'RETRYING', 'REPLANNING', 'PLANNING_ACTION', 'STALLED', 'FAILED'],
    REPLANNING: ['OBSERVING', 'PLANNING_ACTION', 'FAILED'],
    STALLED: ['OBSERVING', 'STABILIZING', 'PLANNING_ACTION', 'RECOVERING', 'REPLANNING', 'FAILED'],
    COMPLETED: [],
    FAILED: []
  });
  assert.deepEqual(Object.keys(CU_TRANSITIONS), Object.keys(CU_STATES));
  assert.deepEqual(TERMINAL_STATES, ['COMPLETED', 'FAILED']);
  // Donor freeze is shallow: the transition lists themselves stay mutable.
  assert.equal(Object.isFrozen(CU_TRANSITIONS), true);
  assert.equal(Object.isFrozen(CU_TRANSITIONS.IDLE), false);
});

test('verification kinds, verdicts and screenshot levels are the donor values', () => {
  assert.deepEqual(VERIFICATION_KINDS, {
    DIRECT: 'direct',
    STATE: 'state',
    NAVIGATION: 'navigation',
    FILE: 'file',
    PROCESS: 'process',
    VISUAL: 'visual',
    FOCUS: 'focus',
    EVENT: 'event',
    NONE: 'none'
  });
  assert.deepEqual(Object.keys(VERIFICATION_KINDS), [
    'DIRECT', 'STATE', 'NAVIGATION', 'FILE', 'PROCESS', 'VISUAL', 'FOCUS', 'EVENT', 'NONE'
  ]);
  assert.deepEqual(VERDICTS, { SUCCESS: 'success', FAILURE: 'failure', UNKNOWN: 'unknown' });
  assert.equal(Object.keys(VERDICTS).length, 3);
  assert.deepEqual(SCREENSHOT_LEVELS, { NONE: 0, REGION: 1, WINDOW: 2, FULL: 3 });
});

test('capabilities, destructive kinds/modes, retention, step results and run status are the donor lists', () => {
  assert.deepEqual(CAPABILITIES, ['browser', 'desktop', 'shell', 'filesystem', 'vision']);
  assert.deepEqual(DESTRUCTIVE_KINDS, [
    'DELETE', 'PURCHASE', 'SEND', 'PUBLISH', 'INSTALL', 'UNINSTALL', 'FORMAT', 'ACCOUNT_CHANGE'
  ]);
  assert.equal(DESTRUCTIVE_KINDS.length, 8);
  assert.deepEqual(DESTRUCTIVE_MODES, { ALLOWED: 'allowed', CONFIRM: 'confirm', FORBIDDEN: 'forbidden' });
  assert.deepEqual(SCREENSHOT_RETENTION, {
    DEBUG: 'debug',
    AUDIT: 'audit',
    FAILURE: 'failure',
    REQUESTED: 'requested',
    NEVER: 'never'
  });
  assert.deepEqual(STEP_RESULTS, {
    SUCCESS: 'success',
    FAILURE: 'failure',
    UNKNOWN: 'unknown',
    SKIPPED: 'skipped',
    REFUSED: 'refused'
  });
  assert.deepEqual(RUN_STATUS, { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', BLOCKED: 'blocked' });
});

test('timing, movement, stall, retry and contract defaults keep the donor thresholds', () => {
  assert.deepEqual(TARGET_MOVEMENT, { stablePx: 3, updatePx: 10 });
  assert.deepEqual(TIMING, {
    settleMinMs: 50,
    settlePreferredMs: 100,
    settleComplexMs: 200,
    settleMaxMs: 300,
    graceMinMs: 80,
    gracePreferredMs: 150,
    graceMaxMs: 250,
    cooldownBaseMs: 80,
    cooldownStepMs: 80,
    cooldownSoftMaxMs: 400,
    cooldownHardMaxMs: 500,
    navigationCooldownMs: 800,
    navigationCooldownMaxMs: 1000,
    eventPollMs: 40,
    defaultActionTimeoutMs: 3000,
    defaultWaitTimeoutMs: 5000,
    appStartTimeoutMs: 20000
  });
  assert.equal(Object.keys(TIMING).length, 17);
  assert.deepEqual(STALL, { consecutiveActions: 3, maxRecoveries: 2 });
  assert.deepEqual(RETRY, { maxAttempts: 2, alternateAtAttempt: 2 });
  assert.deepEqual(CONTRACT_DEFAULTS, {
    maxSteps: 200,
    maxRetriesPerAction: 2,
    maxStallRecoveries: 2,
    destructiveActions: 'confirm',
    allowedCapabilities: ['browser', 'desktop', 'shell', 'filesystem', 'vision'],
    stepTimeoutMs: 30_000,
    runTimeoutMs: 30 * 60_000,
    screenshotRetention: 'failure',
    allowFullScreenFallback: true,
    autonomyEnabled: false,
    unscopedFilesystem: false,
    allowOutsideWorkspace: false
  });
  // The donor reuses the live constants rather than copies.
  assert.equal(CONTRACT_DEFAULTS.allowedCapabilities, CAPABILITIES);
  assert.equal(CONTRACT_DEFAULTS.maxRetriesPerAction, RETRY.maxAttempts);
  assert.equal(CONTRACT_DEFAULTS.maxStallRecoveries, STALL.maxRecoveries);
  assert.equal(CONTRACT_DEFAULTS.destructiveActions, DESTRUCTIVE_MODES.CONFIRM);
  assert.equal(CONTRACT_DEFAULTS.screenshotRetention, SCREENSHOT_RETENTION.FAILURE);
});

test('resolveComputerUseOptions with no config block is exactly the donor default resolution', () => {
  const options = resolveComputerUseOptions();
  assert.deepEqual(options, {
    workspace: null,
    maxSteps: 200,
    maxRetriesPerAction: 2,
    maxStallRecoveries: 2,
    stepTimeoutMs: 30000,
    runTimeoutMs: 1800000,
    destructiveActions: 'confirm',
    allowedCapabilities: ['browser', 'desktop', 'shell', 'filesystem', 'vision'],
    screenshotRetention: 'failure',
    allowFullScreenFallback: true,
    unscopedFilesystem: false,
    allowOutsideWorkspace: false,
    autonomyEnabled: false,
    timing: {
      settleMinMs: 50,
      settlePreferredMs: 100,
      gracePreferredMs: 150,
      cooldownSoftMaxMs: 400,
      navigationCooldownMs: 800,
      eventPollMs: 40
    },
    targetMovement: { stablePx: 3, updatePx: 10 },
    stall: { consecutiveActions: 3 }
  });
  assert.deepEqual(Object.keys(options), [
    'workspace', 'maxSteps', 'maxRetriesPerAction', 'maxStallRecoveries', 'stepTimeoutMs', 'runTimeoutMs',
    'destructiveActions', 'allowedCapabilities', 'screenshotRetention', 'allowFullScreenFallback',
    'unscopedFilesystem', 'allowOutsideWorkspace', 'autonomyEnabled', 'timing', 'targetMovement', 'stall'
  ]);
  assert.deepEqual(Object.keys(options.timing), [
    'settleMinMs', 'settlePreferredMs', 'gracePreferredMs', 'cooldownSoftMaxMs', 'navigationCooldownMs', 'eventPollMs'
  ]);
  // The parameter replaces the donor's init-time `config/app.json` read; the
  // empty block is the donor's "missing or damaged config" branch.
  assert.deepEqual(resolveComputerUseOptions(), resolveComputerUseOptions({}, {}));
});

test('the config block is the middle layer: defaults, then block, then overrides', () => {
  const block = {
    workspace: 'C:/workspace',
    limits: { maxSteps: 9, maxRetriesPerAction: 4, maxStallRecoveries: 6, stepTimeoutMs: 111, runTimeoutMs: 222, unscopedFilesystem: true, allowOutsideWorkspace: true },
    timing: { settleMinMs: 77, settlePreferredMs: 88, gracePreferredMs: 99, cooldownSoftMaxMs: 123, navigationCooldownMs: 456, eventPollMs: 55 },
    safety: { destructiveActions: 'forbidden' },
    vision: { retention: 'audit', allowFullScreenFallback: false },
    allowedCapabilities: ['browser', 'nope', 'shell'],
    autonomyEnabled: true,
    stall: { consecutiveActions: 7 }
  };
  const options = resolveComputerUseOptions({}, block);
  assert.equal(options.workspace, 'C:/workspace');
  assert.equal(options.maxSteps, 9);
  assert.equal(options.maxRetriesPerAction, 4);
  assert.equal(options.maxStallRecoveries, 6);
  assert.equal(options.stepTimeoutMs, 111);
  assert.equal(options.runTimeoutMs, 222);
  assert.equal(options.unscopedFilesystem, true);
  assert.equal(options.allowOutsideWorkspace, true);
  assert.deepEqual(options.timing, {
    settleMinMs: 77,
    settlePreferredMs: 88,
    gracePreferredMs: 99,
    cooldownSoftMaxMs: 123,
    navigationCooldownMs: 456,
    eventPollMs: 55
  });
  assert.equal(options.destructiveActions, 'forbidden');
  assert.equal(options.screenshotRetention, 'audit');
  assert.equal(options.allowFullScreenFallback, false);
  assert.deepEqual(options.allowedCapabilities, ['browser', 'shell']);
  assert.equal(options.autonomyEnabled, true);
  assert.deepEqual(options.stall, { consecutiveActions: 7 });

  const overridden = resolveComputerUseOptions(
    { workspace: 'D:/other', maxSteps: 3, destructiveActions: 'ALLOWED', screenshotRetention: 'NEVER', autonomyEnabled: false, stallConsecutiveActions: 2 },
    block
  );
  assert.equal(overridden.workspace, 'D:/other');
  assert.equal(overridden.maxSteps, 3);
  assert.equal(overridden.destructiveActions, 'allowed');
  assert.equal(overridden.screenshotRetention, 'NEVER');
  assert.equal(overridden.autonomyEnabled, false);
  assert.deepEqual(overridden.stall, { consecutiveActions: 2 });
});

test('positive limits accept integers only and otherwise keep the shipped default', () => {
  assert.equal(resolveComputerUseOptions({ maxSteps: '42' }).maxSteps, 42);
  assert.equal(resolveComputerUseOptions({ maxSteps: 2.5 }).maxSteps, 200);
  assert.equal(resolveComputerUseOptions({ maxSteps: 0 }).maxSteps, 200);
  assert.equal(resolveComputerUseOptions({ maxSteps: -1 }).maxSteps, 200);
  assert.equal(resolveComputerUseOptions({ maxSteps: 'lots' }).maxSteps, 200);
  assert.equal(resolveComputerUseOptions({ maxRetriesPerAction: 7 }).maxRetriesPerAction, 7);
  assert.equal(resolveComputerUseOptions({ runTimeoutMs: 1000 }).runTimeoutMs, 1000);
});

test('an unknown destructive mode falls back to confirm instead of widening the gate', () => {
  assert.equal(resolveComputerUseOptions({ destructiveActions: 'ALLOWED' }).destructiveActions, 'allowed');
  assert.equal(resolveComputerUseOptions({ destructiveActions: 'Allowed' }).destructiveActions, 'allowed');
  assert.equal(resolveComputerUseOptions({ destructiveActions: 'forbidden' }).destructiveActions, 'forbidden');
  assert.equal(resolveComputerUseOptions({ destructiveActions: 'yolo' }).destructiveActions, 'confirm');
  assert.equal(resolveComputerUseOptions({ destructiveActions: '' }).destructiveActions, 'confirm');
  assert.equal(resolveComputerUseOptions({ destructiveActions: 0 }).destructiveActions, 'confirm');
  assert.equal(resolveComputerUseOptions({}, { safety: { destructiveActions: 'FORBIDDEN' } }).destructiveActions, 'forbidden');
});

test('capability lists are filtered without de-duplication, and a non-array keeps the shipped list by identity', () => {
  assert.deepEqual(resolveComputerUseOptions({ allowedCapabilities: ['browser', 'browser', 'nope'] }).allowedCapabilities, ['browser', 'browser']);
  assert.deepEqual(resolveComputerUseOptions({ allowedCapabilities: ['nope'] }).allowedCapabilities, []);
  const fallback = resolveComputerUseOptions({ allowedCapabilities: 'browser' });
  assert.equal(fallback.allowedCapabilities, CAPABILITIES);
  assert.equal(resolveComputerUseOptions({}, { allowedCapabilities: 'shell' }).allowedCapabilities, CAPABILITIES);
  assert.deepEqual(resolveComputerUseOptions({}, { allowedCapabilities: ['vision'] }).allowedCapabilities, ['vision']);
});

test('the filesystem escape hatches are strict booleans', () => {
  assert.equal(resolveComputerUseOptions({ unscopedFilesystem: true }).unscopedFilesystem, true);
  assert.equal(resolveComputerUseOptions({ unscopedFilesystem: 1 }).unscopedFilesystem, false);
  assert.equal(resolveComputerUseOptions({ unscopedFilesystem: 'true' }).unscopedFilesystem, false);
  assert.equal(resolveComputerUseOptions({ allowOutsideWorkspace: true }).allowOutsideWorkspace, true);
  assert.equal(resolveComputerUseOptions({ allowOutsideWorkspace: 'yes' }).allowOutsideWorkspace, false);
});

test('timing values are rounded and clamped into the donor bands', () => {
  assert.equal(resolveComputerUseOptions({ settleMinMs: 5000 }).timing.settleMinMs, 300);
  assert.equal(resolveComputerUseOptions({ settleMinMs: -10 }).timing.settleMinMs, 0);
  assert.equal(resolveComputerUseOptions({ settleMinMs: 100.6 }).timing.settleMinMs, 101);
  assert.equal(resolveComputerUseOptions({ settleMinMs: 'abc' }).timing.settleMinMs, 50);
  assert.equal(resolveComputerUseOptions({ settlePreferredMs: 999 }).timing.settlePreferredMs, 300);
  assert.equal(resolveComputerUseOptions({ gracePreferredMs: 999 }).timing.gracePreferredMs, 250);
  assert.equal(resolveComputerUseOptions({ cooldownSoftMaxMs: 10 }).timing.cooldownSoftMaxMs, 80);
  assert.equal(resolveComputerUseOptions({ cooldownSoftMaxMs: 9999 }).timing.cooldownSoftMaxMs, 500);
  assert.equal(resolveComputerUseOptions({ navigationCooldownMs: 10 }).timing.navigationCooldownMs, 80);
  assert.equal(resolveComputerUseOptions({ navigationCooldownMs: 9999 }).timing.navigationCooldownMs, 1000);
  assert.equal(resolveComputerUseOptions({ eventPollMs: 5 }).timing.eventPollMs, 10);
  assert.equal(resolveComputerUseOptions({ eventPollMs: 5000 }).timing.eventPollMs, 1000);
});

test('target movement is copied unsmoothed, and a null override reads as 0 (donor quirk)', () => {
  assert.deepEqual(resolveComputerUseOptions({ stablePx: '5' }).targetMovement, { stablePx: 5, updatePx: 10 });
  assert.deepEqual(resolveComputerUseOptions({ stablePx: 3.7 }).targetMovement, { stablePx: 3.7, updatePx: 10 });
  assert.deepEqual(resolveComputerUseOptions({ stablePx: Number.NaN }).targetMovement, { stablePx: 3, updatePx: 10 });
  assert.deepEqual(resolveComputerUseOptions({ updatePx: null }).targetMovement, { stablePx: 3, updatePx: 0 });
});

test('the stall threshold comes from the config block, never from a zero override', () => {
  assert.deepEqual(resolveComputerUseOptions({}, { stall: { consecutiveActions: 7 } }).stall, { consecutiveActions: 7 });
  assert.deepEqual(resolveComputerUseOptions({ stallConsecutiveActions: 5 }).stall, { consecutiveActions: 5 });
  assert.deepEqual(resolveComputerUseOptions({ stallConsecutiveActions: 0 }).stall, { consecutiveActions: 3 });
});

test('a null config block still throws the donor TypeError (preserved donor defect)', () => {
  // The donor never produced `null` from its file read, so this path was never
  // exercised; the port keeps the same unguarded `configBlock.workspace` access.
  assert.throws(() => resolveComputerUseOptions({}, null), TypeError);
  // An omitted block is the default `{}`, so two-argument donor calls keep working.
  assert.deepEqual(resolveComputerUseOptions({}, undefined), resolveComputerUseOptions());
  assert.deepEqual(resolveComputerUseOptions(undefined, undefined), resolveComputerUseOptions());
});
