/**
 * UTOPIA · Automation District — Execution Contract parity.
 *
 * Pins the donor `app/computer-use/contract.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the contract shape and field order,
 * goal intake, the closed capability / destructive-mode / retention
 * vocabularies, the limit clamps, plan envelopes and `PLAN_INVALID` wrapping,
 * capability assertion and the log-safe summary.
 *
 * The one adaptation is exercised here too: the resolved `computerUse` config
 * block is the explicit third parameter of `createContract` (the donor read it
 * from `config/app.json` inside `constants.cjs`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContract,
  normalizePlan,
  hasCapability,
  assertCapability,
  declaredDestructiveKinds,
  describeContract,
  CONTRACT_DEFAULTS
} from '../contract.mjs';
import { CAPABILITIES, DESTRUCTIVE_MODES, SCREENSHOT_RETENTION } from '../contracts.mjs';
import { CODES } from '../errors.mjs';

function capture(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

test('a minimal contract is the donor default document, field for field', () => {
  const contract = createContract({ goal: '  do the thing  ' });
  assert.deepEqual(contract, {
    id: null,
    goal: 'do the thing',
    successCriteria: [],
    allowedCapabilities: ['browser', 'desktop', 'shell', 'filesystem', 'vision'],
    safety: {
      destructiveActions: 'confirm',
      confirm: null,
      requireForegroundWindow: true,
      requireFocusForTyping: true,
      forbiddenTargets: [],
      allowedCommands: null,
      forbiddenCommands: []
    },
    limits: {
      maxSteps: 200,
      maxRetriesPerAction: 2,
      maxStallRecoveries: 2,
      stepTimeoutMs: 30000,
      runTimeoutMs: 1800000
    },
    vision: { retention: 'failure', allowFullScreenFallback: true, maxScreenshots: 200 },
    plan: [],
    autonomyEnabled: false,
    workspace: null,
    metadata: {},
    source: 'unknown'
  });
  assert.deepEqual(Object.keys(contract), [
    'id', 'goal', 'successCriteria', 'allowedCapabilities', 'safety', 'limits', 'vision', 'plan',
    'autonomyEnabled', 'workspace', 'metadata', 'source'
  ]);
  assert.deepEqual(Object.keys(contract.safety), [
    'destructiveActions', 'confirm', 'requireForegroundWindow', 'requireFocusForTyping', 'forbiddenTargets',
    'allowedCommands', 'forbiddenCommands'
  ]);
  // The contract builder hands back the live vocabulary by value, never a widened one.
  assert.deepEqual(contract.allowedCapabilities, [...CAPABILITIES]);
  assert.equal(CONTRACT_DEFAULTS.maxSteps, 200);
});

test('a contract must be an object and must carry a goal', () => {
  const notObject = capture(() => createContract(null));
  assert.equal(notObject.code, CODES.CONTRACT_INVALID);
  assert.equal(notObject.message, 'an execution contract must be an object');
  assert.equal(notObject.message.length, 39);
  assert.deepEqual(notObject.details, { received: 'object' });
  assert.equal(capture(() => createContract('goal')).message, 'an execution contract must be an object');
  assert.equal(capture(() => createContract([])).details.received, 'object');

  const missing = capture(() => createContract({}));
  assert.equal(missing.code, CODES.CONTRACT_GOAL_MISSING);
  assert.equal(missing.message, 'an execution contract needs a goal');
  assert.equal(missing.retryable, false);
  assert.equal(capture(() => createContract({ goal: '   ' })).code, CODES.CONTRACT_GOAL_MISSING);
  assert.equal(capture(() => createContract({ goal: 0 })).code, CODES.CONTRACT_GOAL_MISSING);
  assert.equal(createContract({ objective: 'from objective' }).goal, 'from objective');
  assert.equal(createContract({ goal: 'win', objective: 'lose' }).goal, 'win');
  assert.equal(createContract({ goal: 'g', id: 5 }).id, '5');
  assert.equal(createContract({ goal: 'g', source: 'planner' }).source, 'planner');
});

test('capabilities are a closed vocabulary: deduplicated, never guessed', () => {
  assert.deepEqual(createContract({ goal: 'g', allowed_capabilities: ['browser', 'browser', 'shell'] }).allowedCapabilities, ['browser', 'shell']);
  assert.deepEqual(createContract({ goal: 'g', allowedCapabilities: ['vision'] }).allowedCapabilities, ['vision']);
  assert.deepEqual(createContract({ goal: 'g', allowed_capabilities: [] }).allowedCapabilities, []);

  const unknown = capture(() => createContract({ goal: 'g', allowed_capabilities: ['nope', 'bad'] }));
  assert.equal(unknown.code, CODES.CONTRACT_INVALID);
  assert.equal(unknown.message, 'unknown capabilities: nope, bad');
  assert.deepEqual(unknown.details, { supported: [...CAPABILITIES] });

  const notArray = capture(() => createContract({ goal: 'g', allowed_capabilities: 'browser' }));
  assert.equal(notArray.message, 'allowed_capabilities must be an array');
  assert.deepEqual(notArray.details, {});

  // The effective runtime options are the fallback when nothing is written.
  assert.deepEqual(createContract({ goal: 'g' }, { allowedCapabilities: ['shell'] }).allowedCapabilities, ['shell']);
});

test('the destructive mode is a closed vocabulary that fails loud instead of defaulting open', () => {
  assert.equal(createContract({ goal: 'g', safety: { destructive_actions: 'FORBIDDEN' } }).safety.destructiveActions, 'forbidden');
  assert.equal(createContract({ goal: 'g', safety: { destructiveActions: 'Allowed' } }).safety.destructiveActions, 'allowed');
  assert.equal(createContract({ goal: 'g', destructive_actions: 'allowed' }).safety.destructiveActions, 'allowed');

  const invalid = capture(() => createContract({ goal: 'g', safety: { destructive_actions: 'yolo' } }));
  assert.equal(invalid.code, CODES.CONTRACT_INVALID);
  assert.equal(invalid.message, 'destructive_actions must be one of: allowed, confirm, forbidden');
  assert.equal(invalid.message.length, 63);
  assert.deepEqual(invalid.details, { received: 'yolo' });
  assert.deepEqual(Object.values(DESTRUCTIVE_MODES), ['allowed', 'confirm', 'forbidden']);

  // Only the runtime options can lower the gate; the contract inherits them.
  assert.equal(createContract({ goal: 'g' }, { destructiveActions: 'allowed' }).safety.destructiveActions, 'allowed');
});

test('safety posture keeps the donor defaults and normalizes forbidden targets through the target model', () => {
  const contract = createContract({
    goal: 'g',
    confirm: () => 'yes',
    safety: {
      confirm: () => 'no',
      require_foreground_window: 0,
      require_focus_for_typing: '',
      forbidden_targets: ['#x', { text: 'no' }],
      allowed_commands: ['ls', 5],
      forbidden_commands: ['rm']
    }
  });
  assert.equal(typeof contract.safety.confirm, 'function');
  assert.equal(contract.safety.confirm(), 'yes');
  assert.equal(contract.safety.requireForegroundWindow, false);
  assert.equal(contract.safety.requireFocusForTyping, false);
  assert.deepEqual(contract.safety.forbiddenTargets, [
    { selector: '#x', kinds: ['selector'], rank: 1, primaryKind: 'selector' },
    { semantic: { text: 'no' }, kinds: ['semantic'], rank: 3, primaryKind: 'semantic' }
  ]);
  assert.deepEqual(contract.safety.allowedCommands, ['ls', '5']);
  assert.deepEqual(contract.safety.forbiddenCommands, ['rm']);
  assert.equal(createContract({ goal: 'g', safety: { allowed_commands: 'ls' } }).safety.allowedCommands, null);
  assert.deepEqual(createContract({ goal: 'g', safety: { forbidden_commands: 'rm' } }).safety.forbiddenCommands, []);

  // A malformed forbidden target fails with the target model's own code.
  const badTarget = capture(() => createContract({ goal: 'g', safety: { forbidden_targets: [5] } }));
  assert.equal(badTarget.code, CODES.TARGET_INVALID);
  assert.equal(badTarget.message, 'a target must be a string, object or array of candidates');
});

test('limits are clamped to the donor windows and fall back to the effective options', () => {
  const contract = createContract({
    goal: 'g',
    limits: {
      max_steps: 7,
      max_retries_per_action: -3,
      max_stall_recoveries: 99,
      step_timeout_ms: 1,
      run_timeout_ms: 'abc'
    }
  });
  assert.deepEqual(contract.limits, {
    maxSteps: 7,
    maxRetriesPerAction: 0,
    maxStallRecoveries: 10,
    stepTimeoutMs: 1,
    runTimeoutMs: 1800000
  });

  assert.equal(createContract({ goal: 'g', limits: { max_steps: 0 } }).limits.maxSteps, 200);
  assert.equal(createContract({ goal: 'g', limits: { max_retries_per_action: 7 } }).limits.maxRetriesPerAction, 5);
  assert.equal(createContract({ goal: 'g', limits: { max_retries_per_action: 2.5 } }).limits.maxRetriesPerAction, 2);
  assert.equal(createContract({ goal: 'g', limits: { maxStallRecoveries: 4 } }).limits.maxStallRecoveries, 4);
  assert.equal(createContract({ goal: 'g', limits: { stepTimeoutMs: '250' } }).limits.stepTimeoutMs, 250);
  assert.equal(createContract({ goal: 'g' }, { maxSteps: 9, runTimeoutMs: 42 }).limits.maxSteps, 9);
  assert.equal(createContract({ goal: 'g' }, { maxSteps: 9 }).limits.runTimeoutMs, 1800000);
});

test('vision retention is a closed vocabulary and screenshot ceilings keep the donor defaults', () => {
  assert.equal(createContract({ goal: 'g', vision: { retention: 'DEBUG' } }).vision.retention, 'debug');
  assert.equal(createContract({ goal: 'g', screenshot_retention: 'audit' }).vision.retention, 'audit');
  assert.equal(createContract({ goal: 'g', screenshotRetention: 'never' }).vision.retention, 'never');
  assert.equal(createContract({ goal: 'g', vision: { retention: 'audit' }, screenshot_retention: 'never' }).vision.retention, 'audit');

  const invalid = capture(() => createContract({ goal: 'g', vision: { retention: 'always' } }));
  assert.equal(invalid.code, CODES.CONTRACT_INVALID);
  assert.equal(invalid.message, 'screenshot retention must be one of: debug, audit, failure, requested, never');
  assert.equal(invalid.message.length, 76);
  assert.deepEqual(invalid.details, { received: 'always' });
  assert.deepEqual(Object.values(SCREENSHOT_RETENTION), ['debug', 'audit', 'failure', 'requested', 'never']);

  assert.equal(createContract({ goal: 'g', vision: { max_screenshots: 5 } }).vision.maxScreenshots, 5);
  assert.equal(createContract({ goal: 'g', vision: { max_screenshots: 0 } }).vision.maxScreenshots, 200);
  assert.equal(createContract({ goal: 'g' }, { allowFullScreenFallback: false }).vision.allowFullScreenFallback, false);
  assert.equal(createContract({ goal: 'g', vision: { allow_full_screen_fallback: 0 } }).vision.allowFullScreenFallback, false);
});

test('autonomy is opt-in and the workspace never invents a cwd', () => {
  assert.equal(createContract({ goal: 'g' }).autonomyEnabled, false);
  assert.equal(createContract({ goal: 'g' }, { autonomyEnabled: true }).autonomyEnabled, true);
  assert.equal(createContract({ goal: 'g', autonomy_enabled: 1 }).autonomyEnabled, true);
  assert.equal(createContract({ goal: 'g', autonomyEnabled: 'yes' }).autonomyEnabled, true);
  assert.equal(createContract({ goal: 'g', autonomy_enabled: 0 }).autonomyEnabled, false);
  assert.equal(createContract({ goal: 'g', workspace: '' }).workspace, null);
  assert.equal(createContract({ goal: 'g', workspace: 'C:/w' }).workspace, 'C:/w');
  assert.equal(createContract({ goal: 'g' }, { workspace: 'D:/w' }).workspace, 'D:/w');
  assert.deepEqual(createContract({ goal: 'g', metadata: { a: 1 } }).metadata, { a: 1 });
  assert.deepEqual(createContract({ goal: 'g', metadata: 'x' }).metadata, {});
  const source = { a: 1 };
  assert.notEqual(createContract({ goal: 'g', metadata: source }).metadata, source);
});

test('success criteria are normalized up front, so a bad criterion fails at contract time', () => {
  const contract = createContract({ goal: 'g', success_criteria: ['the page shows done', { type: 'file_exists', path: 'p' }] });
  assert.deepEqual(contract.successCriteria.map((criterion) => criterion.kind), ['custom', 'file_exists']);
  assert.equal(contract.successCriteria[1].description, 'file exists: p');
  assert.deepEqual(createContract({ goal: 'g', successCriteria: [] }).successCriteria, []);
  assert.equal(capture(() => createContract({ goal: 'g', success_criteria: [{ kind: 'nope' }] })).code, CODES.CONTRACT_INVALID);
});

test('plan steps are normalized into donor envelopes and invalid actions are wrapped as PLAN_INVALID', () => {
  assert.deepEqual(normalizePlan(undefined), []);
  assert.deepEqual(normalizePlan([]), []);
  const notArray = capture(() => normalizePlan('BROWSER_REFRESH'));
  assert.equal(notArray.code, CODES.CONTRACT_INVALID);
  assert.equal(notArray.message, 'plan must be an array of steps');
  assert.equal(capture(() => normalizePlan([null])).message, 'plan step #0 is empty');
  assert.equal(capture(() => normalizePlan([undefined])).message, 'plan step #0 is empty');
  assert.equal(capture(() => normalizePlan([{ action: 'BROWSER_REFRESH' }, null])).message, 'plan step #1 is empty');

  const single = normalizePlan(['BROWSER_REFRESH']);
  assert.deepEqual(Object.keys(single[0]), ['id', 'description', 'actions', 'optional', 'maxAttempts', 'expectedEffect', 'when']);
  assert.equal(single[0].id, 'step-1');
  assert.equal(single[0].description, null);
  assert.equal(single[0].optional, false);
  assert.equal(single[0].maxAttempts, null);
  assert.equal(single[0].expectedEffect, null);
  assert.equal(single[0].when, null);
  assert.equal(single[0].actions.length, 1);
  assert.equal(single[0].actions[0].type, 'BROWSER_REFRESH');

  const envelope = normalizePlan([
    {
      id: 's1',
      description: 'do it',
      actions: [{ type: 'BROWSER_BACK' }, 'BROWSER_FORWARD'],
      optional: 1,
      max_attempts: 9,
      expected_effect: { toast: 'ok' },
      when: 1
    }
  ]);
  assert.equal(envelope[0].id, 's1');
  assert.equal(envelope[0].description, 'do it');
  assert.deepEqual(envelope[0].actions.map((action) => action.type), ['BROWSER_BACK', 'BROWSER_FORWARD']);
  assert.equal(envelope[0].optional, true);
  assert.equal(envelope[0].maxAttempts, 5);
  assert.deepEqual(envelope[0].expectedEffect, { toast: 'ok' });
  assert.equal(envelope[0].when, '1');

  // Falsy envelope fields fall back to the donor defaults.
  const falsy = normalizePlan([{ action: 'BROWSER_REFRESH', id: 0, description: 0, when: 0, max_attempts: 2.5 }]);
  assert.equal(falsy[0].id, 'step-1');
  assert.equal(falsy[0].description, null);
  assert.equal(falsy[0].when, null);
  assert.equal(falsy[0].maxAttempts, null);

  // A step object that is itself an action needs no envelope.
  const bare = normalizePlan([{ type: 'BROWSER_REFRESH' }]);
  assert.equal(bare[0].actions[0].type, 'BROWSER_REFRESH');

  const bad = capture(() => normalizePlan(['CLICK']));
  assert.equal(bad.code, CODES.PLAN_INVALID);
  assert.equal(bad.message, 'plan step 0 is not a valid action: CLICK requires one of: target, point');
  assert.equal(bad.message.length, 71);
  assert.deepEqual(bad.details, { step: '0', cause: CODES.ACTION_INVALID });

  const badNested = capture(() => normalizePlan([{ actions: [{ type: 'BROWSER_REFRESH' }, 'CLICK'] }]));
  assert.equal(badNested.message, 'plan step 0.1 is not a valid action: CLICK requires one of: target, point');
  assert.deepEqual(badNested.details, { step: '0.1', cause: CODES.ACTION_INVALID });
});

test('the donor plan step keeps the contract retry limit out of its actions (preserved donor defect)', () => {
  // `wrapAction` calls `normalizeAction(input)` with no options, so a step's
  // retry budget always comes from RETRY.maxAttempts, never from
  // `limits.max_retries_per_action`.
  const contract = createContract({ goal: 'g', limits: { max_retries_per_action: 5 }, plan: [{ action: { type: 'BROWSER_REFRESH' } }] });
  assert.equal(contract.limits.maxRetriesPerAction, 5);
  assert.equal(contract.plan[0].actions[0].retry.maxAttempts, 2);
});

test('capability assertion fails closed with the donor codes and messages', () => {
  const contract = createContract({ goal: 'g', allowed_capabilities: ['browser'] });
  assert.equal(hasCapability(contract, 'browser'), true);
  assert.equal(hasCapability(contract, 'shell'), false);
  assert.equal(assertCapability(contract, 'browser'), true);

  const noContract = capture(() => assertCapability(null, 'browser'));
  assert.equal(noContract.code, CODES.CONTRACT_INVALID);
  assert.equal(noContract.message, 'no execution contract is active');
  assert.equal(noContract.message.length, 31);

  const denied = capture(() => assertCapability(contract, 'shell'));
  assert.equal(denied.code, CODES.CAPABILITY_NOT_ALLOWED);
  assert.equal(denied.message, 'capability "shell" is not allowed by this contract');
  assert.equal(denied.message.length, 50);
  assert.deepEqual(denied.details, { capability: 'shell', allowed: ['browser'] });
  assert.equal(denied.retryable, false);

  // The extra details are spread last, so a caller can overwrite the donor fields.
  const overridden = capture(() => assertCapability(contract, 'shell', { allowed: ['x'], capability: 'other' }));
  assert.deepEqual(overridden.details, { capability: 'other', allowed: ['x'] });
});

test('declared destructive kinds are filtered against the closed donor families', () => {
  assert.deepEqual(
    declaredDestructiveKinds(createContract({ goal: 'g', metadata: { destructive_kinds: ['delete', 'NOPE', 'send'] } })),
    ['DELETE', 'SEND']
  );
  assert.deepEqual(declaredDestructiveKinds(createContract({ goal: 'g' })), []);
  assert.deepEqual(declaredDestructiveKinds(createContract({ goal: 'g', metadata: { destructive_kinds: 'delete' } })), []);
  assert.deepEqual(declaredDestructiveKinds(null), []);
});

test('describeContract is a log-safe summary, never the plan payload', () => {
  const contract = createContract({
    goal: 'publish the release',
    plan: [{ action: { type: 'BROWSER_REFRESH' } }],
    success_criteria: [{ type: 'file_exists', path: 'p' }]
  });
  assert.deepEqual(describeContract(contract), {
    id: null,
    goal: 'publish the release',
    capabilities: ['browser', 'desktop', 'shell', 'filesystem', 'vision'],
    destructiveActions: 'confirm',
    steps: 1,
    criteria: ['file exists: p'],
    limits: { maxSteps: 200, maxRetriesPerAction: 2, maxStallRecoveries: 2, stepTimeoutMs: 30000, runTimeoutMs: 1800000 },
    autonomyEnabled: false
  });
  assert.deepEqual(Object.keys(describeContract(contract)), [
    'id', 'goal', 'capabilities', 'destructiveActions', 'steps', 'criteria', 'limits', 'autonomyEnabled'
  ]);
});

test('the resolved config block is an explicit parameter, replacing the donor file read', () => {
  const configBlock = {
    workspace: 'C:/from-config',
    limits: { maxSteps: 5 },
    safety: { destructiveActions: 'forbidden' },
    allowedCapabilities: ['shell'],
    autonomyEnabled: true,
    stall: { consecutiveActions: 4 }
  };
  const contract = createContract({ goal: 'g' }, {}, configBlock);
  assert.equal(contract.workspace, 'C:/from-config');
  assert.equal(contract.limits.maxSteps, 5);
  assert.equal(contract.safety.destructiveActions, 'forbidden');
  assert.deepEqual(contract.allowedCapabilities, ['shell']);
  assert.equal(contract.autonomyEnabled, true);

  // Explicit overrides still win over the block, and the two-argument donor call
  // behaves exactly like the donor's "missing config file" branch.
  const overridden = createContract({ goal: 'g' }, { maxSteps: 3, destructiveActions: 'allowed' }, configBlock);
  assert.equal(overridden.limits.maxSteps, 3);
  assert.equal(overridden.safety.destructiveActions, 'allowed');
  assert.deepEqual(createContract({ goal: 'g' }), createContract({ goal: 'g' }, {}, {}));
  assert.equal(createContract({ goal: 'g' }).limits.maxSteps, 200);
  assert.equal(createContract({ goal: 'g' }, {}, {}).safety.destructiveActions, 'confirm');
});
