/**
 * UTOPIA · Automation District — Action Contract parity.
 *
 * Pins the donor `app/computer-use/action.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the per-type parameter rules, every
 * normalization rule with its exact message and details, the closed
 * expected-effect vocabulary, the destructive-kind derivation, and the two pure
 * target helpers the donor `action.cjs` / `contract.cjs` imported from
 * `target.cjs`. The donor defects the port keeps are pinned explicitly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VALID_ACTION_TYPES,
  EXPECTED_EFFECT_KEYS,
  PARAM_RULES,
  TARGET_KINDS,
  normalizeAction,
  validateAction,
  normalizeExpectedEffect,
  normalizeStabilization,
  normalizePrecondition,
  normalizeRetry,
  normalizeDestructive,
  requiresTarget,
  describeAction,
  destructiveKinds,
  normalizeTarget,
  describeTarget
} from '../action.mjs';
import { ACTION_TYPE_LIST, CAPABILITIES } from '../contracts.mjs';
import { CODES } from '../errors.mjs';

const LONG_MESSAGES = {
  notAnAction: 'an action must be an object or an action type string',
  targetEmpty: 'a target must carry at least one of: selector, accessibility, semantic, window, bbox, point, ref',
  targetShape: 'a target must be a string, object or array of candidates',
  targetStringEmpty: 'a target string may not be empty',
  stabilizationOrder: 'stabilization.minimum_ms may not exceed stabilization.maximum_ms',
  destructiveShape: 'destructive must be a boolean, a kind string or an object',
  effectShape: 'expected_effect must be an object, string or array',
  effectEmpty: 'an expected effect needs at least one signal'
};

/** Captures the thrown error (assert.throws returns undefined). */
function capture(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

test('the action type set, expected-effect and parameter vocabularies are exactly the donor lists', () => {
  assert.ok(VALID_ACTION_TYPES instanceof Set);
  assert.equal(VALID_ACTION_TYPES.size, 36);
  assert.deepEqual([...VALID_ACTION_TYPES], [...ACTION_TYPE_LIST]);
  assert.deepEqual(EXPECTED_EFFECT_KEYS, [
    'toast', 'text_appears', 'text_disappears', 'control_state_changed', 'target_disappears', 'target_appears',
    'url_changed', 'url_matches', 'file_created', 'file_modified', 'file_exists', 'file_missing', 'process_exited',
    'exit_code', 'stdout_matches', 'stderr_matches', 'focus_changed', 'window_changed', 'value_equals',
    'checked_equals', 'dom_mutated', 'navigation', 'visual_change', 'event'
  ]);
  assert.equal(EXPECTED_EFFECT_KEYS.length, 24);
  assert.deepEqual(Object.keys(PARAM_RULES), [...ACTION_TYPE_LIST]);
  assert.deepEqual(PARAM_RULES, {
    MOVE: { any: ['point', 'target'] },
    CLICK: { any: ['target', 'point'] },
    DOUBLE_CLICK: { any: ['target', 'point'] },
    RIGHT_CLICK: { any: ['target', 'point'] },
    TYPE: { requires: ['text'] },
    KEY_PRESS: { requires: ['key'] },
    HOTKEY: { requires: ['keys'] },
    SCROLL: { any: ['target', 'point', 'dy', 'dx'], requires: [] },
    DRAG: { requires: ['from', 'to'] },
    FOCUS: { any: ['target', 'window'] },
    SELECT: { requires: ['target'], any: ['value', 'text', 'index'] },
    OPEN_APP: { requires: ['application'] },
    CLOSE_WINDOW: { any: ['target', 'window'], requires: [] },
    SWITCH_WINDOW: { any: ['target', 'window'], requires: [] },
    BROWSER_NAVIGATE: { requires: ['url'] },
    BROWSER_BACK: {},
    BROWSER_FORWARD: {},
    BROWSER_REFRESH: {},
    DOM_CLICK: { requires: ['target'] },
    DOM_TYPE: { requires: ['target'], any: ['text', 'value'] },
    DOM_SELECT: { requires: ['target'], any: ['value', 'text', 'index'] },
    ACCESSIBILITY_INVOKE: { requires: ['target'] },
    ACCESSIBILITY_SET_VALUE: { requires: ['target'], any: ['value', 'text'] },
    SHELL_EXEC: { requires: ['command'] },
    FILE_READ: { requires: ['path'] },
    FILE_WRITE: { requires: ['path'], any: ['content', 'text'] },
    FILE_COPY: { requires: ['path'], any: ['to', 'destination'] },
    FILE_MOVE: { requires: ['path'], any: ['to', 'destination'] },
    FILE_DELETE: { requires: ['path'] },
    FILE_MKDIR: { requires: ['path'] },
    FILE_EXISTS: { requires: ['path'] },
    WAIT_EVENT: { any: ['waitFor', 'event'] },
    WAIT_STATE: { any: ['expect', 'target', 'waitFor'] },
    SCREENSHOT_REGION: { any: ['target', 'clip', 'region'] },
    SCREENSHOT_WINDOW: { any: ['window', 'target'], requires: [] },
    SCREENSHOT_FULL: { requires: [] }
  });
});

test('a bare action type and the documented envelope both normalize to one action object', () => {
  const refresh = normalizeAction('BROWSER_REFRESH');
  assert.deepEqual(refresh, {
    type: 'BROWSER_REFRESH',
    capability: 'browser',
    target: null,
    params: {},
    precondition: { targetExists: true, targetEnabled: true, targetVisible: true, windowForeground: null, focusMatches: null, custom: [] },
    stabilization: { minimumMs: 50, maximumMs: 300, requireStable: true, waitForQuiet: true },
    expectedEffect: null,
    timeoutMs: 3000,
    retry: { maxAttempts: 2, allowAlternative: true, backoffMs: 80 },
    destructive: null,
    id: null,
    description: null,
    sensitive: false
  });
  assert.deepEqual(Object.keys(refresh), [
    'type', 'capability', 'target', 'params', 'precondition', 'stabilization', 'expectedEffect', 'timeoutMs',
    'retry', 'destructive', 'id', 'description', 'sensitive'
  ]);

  assert.deepEqual(normalizeAction({ type: 'click', target: '#save' }), {
    type: 'CLICK',
    capability: 'desktop',
    target: { selector: '#save', kinds: ['selector'], rank: 1, primaryKind: 'selector' },
    params: { target: '#save' },
    precondition: { targetExists: true, targetEnabled: true, targetVisible: true, windowForeground: null, focusMatches: null, custom: [] },
    stabilization: { minimumMs: 50, maximumMs: 300, requireStable: true, waitForQuiet: true },
    expectedEffect: null,
    timeoutMs: 3000,
    retry: { maxAttempts: 2, allowAlternative: true, backoffMs: 80 },
    destructive: null,
    id: null,
    description: null,
    sensitive: false
  });

  // `{ action: { ... } }` merges the envelope's own keys over the inner action.
  const envelope = normalizeAction({ action: { type: 'TYPE', text: 'x' }, id: 'a', sensitive: true });
  assert.equal(envelope.type, 'TYPE');
  assert.equal(envelope.id, 'a');
  assert.equal(envelope.sensitive, true);
  assert.deepEqual(envelope.params, { text: 'x' });
});

test('unsupported and non-object actions fail with the donor ACTION_INVALID shape', () => {
  const unsupported = capture(() => normalizeAction({ type: 'TELEPORT' }));
  assert.equal(unsupported.name, 'ComputerUseError');
  assert.equal(unsupported.code, CODES.ACTION_INVALID);
  assert.equal(unsupported.message, 'unsupported action type: TELEPORT');
  assert.deepEqual(unsupported.details, { type: 'TELEPORT', supported: [...ACTION_TYPE_LIST] });

  const missing = capture(() => normalizeAction({}));
  assert.equal(missing.code, CODES.ACTION_INVALID);
  assert.equal(missing.message, 'unsupported action type: (missing)');
  assert.deepEqual(missing.details, { type: null, supported: [...ACTION_TYPE_LIST] });

  for (const [input, received] of [[5, 'number'], [null, 'object'], [[], 'object'], [undefined, 'undefined'], [true, 'boolean']]) {
    const error = capture(() => normalizeAction(input));
    assert.equal(error.code, CODES.ACTION_INVALID);
    assert.equal(error.message, LONG_MESSAGES.notAnAction);
    assert.deepEqual(error.details, { received });
  }
  assert.equal(LONG_MESSAGES.notAnAction.length, 52);
});

test('parameters are collected in donor order, with keys/args coercion and the raw timeout kept alongside the resolved one', () => {
  const action = normalizeAction({
    type: 'TYPE',
    text: 'b',
    params: { text: 'a', keep: 1 },
    timeout_ms: 1500.6,
    keys: [1, 2],
    args: 'x'
  });
  assert.deepEqual(Object.keys(action.params), ['text', 'keep', 'keys', 'args', 'timeout_ms']);
  assert.deepEqual(action.params, { text: 'b', keep: 1, keys: ['1', '2'], args: ['x'], timeout_ms: 1500.6 });
  assert.equal(action.timeoutMs, 1501);
  assert.equal(normalizeAction({ type: 'BROWSER_REFRESH', timeout_ms: -5 }).timeoutMs, 3000);
  assert.equal(normalizeAction({ type: 'BROWSER_REFRESH', timeout_ms: 0 }).timeoutMs, 3000);
  assert.equal(normalizeAction({ type: 'BROWSER_REFRESH', timeoutMs: '250' }).timeoutMs, 250);
  assert.deepEqual(normalizeAction({ type: 'HOTKEY', keys: ['Control', 'S'] }).params, { keys: ['Control', 'S'] });
  assert.deepEqual(normalizeAction({ type: 'SCROLL', dy: 5 }).params, { dy: 5 });
});

test('preconditions default to the donor tri-state', () => {
  assert.deepEqual(normalizePrecondition(undefined), {
    targetExists: true,
    targetEnabled: true,
    targetVisible: true,
    windowForeground: null,
    focusMatches: null,
    custom: []
  });
  assert.deepEqual(normalizePrecondition({ target_exists: 0, target_enabled: '', target_visible: null }), {
    targetExists: false,
    targetEnabled: false,
    targetVisible: false,
    windowForeground: null,
    focusMatches: null,
    custom: []
  });
  assert.deepEqual(normalizePrecondition({ target_exists: 0, focus_matches: 1, custom: ['a'] }), {
    targetExists: false,
    targetEnabled: true,
    targetVisible: true,
    windowForeground: null,
    focusMatches: true,
    custom: ['a']
  });
  const source = ['a'];
  assert.notEqual(normalizePrecondition({ custom: source }).custom, source);
});

test('stabilization is clamped into the donor band and rejects an inverted window', () => {
  assert.deepEqual(normalizeStabilization(), { minimumMs: 50, maximumMs: 300, requireStable: true, waitForQuiet: true });
  assert.deepEqual(normalizeStabilization({ minimum_ms: 100.4 }), { minimumMs: 100.4, maximumMs: 300, requireStable: true, waitForQuiet: true });
  assert.deepEqual(normalizeStabilization({ minimum_ms: -5, maximum_ms: 5000 }), { minimumMs: 0, maximumMs: 300, requireStable: true, waitForQuiet: true });
  assert.deepEqual(normalizeStabilization({ minimum_ms: 50, maximum_ms: 50 }), { minimumMs: 50, maximumMs: 50, requireStable: true, waitForQuiet: true });
  assert.deepEqual(normalizeStabilization({ require_stable: 0, wait_for_quiet: 0 }), { minimumMs: 50, maximumMs: 300, requireStable: false, waitForQuiet: false });
  assert.deepEqual(normalizeStabilization({ minimum_ms: 'abc' }), { minimumMs: 50, maximumMs: 300, requireStable: true, waitForQuiet: true });
  // `options.settleMinMs` is the runtime's own floor, read nullish (not falsy).
  assert.deepEqual(normalizeStabilization({ minimum_ms: 'abc' }, { settleMinMs: 120 }), { minimumMs: 120, maximumMs: 300, requireStable: true, waitForQuiet: true });
  assert.deepEqual(normalizeStabilization({ minimum_ms: 'abc' }, { settleMinMs: 0 }), { minimumMs: 0, maximumMs: 300, requireStable: true, waitForQuiet: true });

  const inverted = capture(() => normalizeAction({ type: 'BROWSER_REFRESH', stabilization: { minimum_ms: 300, maximum_ms: 100 } }));
  assert.equal(inverted.code, CODES.ACTION_INVALID);
  assert.equal(inverted.message, LONG_MESSAGES.stabilizationOrder);
  assert.equal(LONG_MESSAGES.stabilizationOrder.length, 64);
  assert.deepEqual(inverted.details, { minimumMs: 300, maximumMs: 100 });
});

test('expected effects normalize into one closed shape and reject unknown keys', () => {
  assert.equal(normalizeExpectedEffect(undefined), null);
  assert.equal(normalizeExpectedEffect(null), null);
  assert.deepEqual(normalizeExpectedEffect('ready'), { any: [{ event: 'ready' }] });
  assert.deepEqual(normalizeExpectedEffect(['ready', { toast: 'done' }]), { any: [{ event: 'ready' }, { toast: 'done' }] });
  assert.deepEqual(normalizeExpectedEffect({ any: [{ toast: 'done' }, 'ready'] }), { any: [{ toast: 'done' }, { event: 'ready' }], mode: 'any' });
  assert.deepEqual(normalizeExpectedEffect({ all: [{ toast: 'done' }] }), { all: [{ toast: 'done' }], mode: 'all' });
  assert.deepEqual(normalizeExpectedEffect({ textAppears: 'hi' }), { any: [{ text_appears: 'hi' }], mode: 'any' });
  assert.deepEqual(normalizeExpectedEffect({ url_matches: '/done$/' }), { any: [{ url_matches: '/done$/' }], mode: 'any' });

  const unknownKey = capture(() => normalizeExpectedEffect({ URLChanged: 1 }));
  assert.equal(unknownKey.code, CODES.ACTION_INVALID);
  assert.equal(unknownKey.message, 'unknown expected_effect key: URLChanged');
  assert.deepEqual(unknownKey.details, { key: 'URLChanged', supported: [...EXPECTED_EFFECT_KEYS] });

  const shape = capture(() => normalizeExpectedEffect(5));
  assert.equal(shape.code, CODES.ACTION_INVALID);
  assert.equal(shape.message, LONG_MESSAGES.effectShape);
  assert.equal(LONG_MESSAGES.effectShape.length, 50);
  assert.deepEqual(shape.details, { received: 'number' });

  const empty = capture(() => normalizeExpectedEffect({}));
  assert.equal(empty.message, LONG_MESSAGES.effectEmpty);

  const nested = capture(() => normalizeExpectedEffect([[1]]));
  assert.equal(nested.message, 'an expected effect must be an object');
  assert.deepEqual(nested.details, { received: 'object' });

  // Donor quirk: `{ any: 'x' }` is not an array, so the whole object is fed to
  // the single-effect normalizer and fails on the `any` key itself.
  const notAnArray = capture(() => normalizeExpectedEffect({ any: 'x' }));
  assert.equal(notAnArray.message, 'unknown expected_effect key: any');
});

test('retry budgets clamp to the donor 0..5 attempt window without rounding', () => {
  assert.deepEqual(normalizeRetry(), { maxAttempts: 2, allowAlternative: true, backoffMs: 80 });
  assert.deepEqual(normalizeRetry({ max_attempts: 2.5 }), { maxAttempts: 2.5, allowAlternative: true, backoffMs: 80 });
  assert.deepEqual(normalizeRetry({ max_attempts: 9 }), { maxAttempts: 5, allowAlternative: true, backoffMs: 80 });
  assert.deepEqual(normalizeRetry({ max_attempts: -1 }), { maxAttempts: 0, allowAlternative: true, backoffMs: 80 });
  assert.deepEqual(normalizeRetry({ max_attempts: 0 }), { maxAttempts: 0, allowAlternative: true, backoffMs: 80 });
  assert.deepEqual(normalizeRetry({ max_attempts: 'abc' }), { maxAttempts: 2, allowAlternative: true, backoffMs: 80 });
  assert.deepEqual(normalizeRetry({}, { maxRetriesPerAction: 4 }), { maxAttempts: 4, allowAlternative: true, backoffMs: 80 });
  assert.deepEqual(normalizeRetry({ allow_alternative: 0, backoff_ms: 9999 }), { maxAttempts: 2, allowAlternative: false, backoffMs: 400 });
  assert.deepEqual(normalizeRetry({ backoff_ms: 'abc' }), { maxAttempts: 2, allowAlternative: true, backoffMs: 80 });
});

test('destructive is normalized into the donor kind list, defaulting to DELETE', () => {
  assert.deepEqual(normalizeDestructive(true), { kinds: ['DELETE'], explicit: true });
  assert.deepEqual(normalizeDestructive('delete'), { kinds: ['DELETE'], explicit: true });
  assert.deepEqual(normalizeDestructive('send'), { kinds: ['SEND'], explicit: true });
  assert.equal(normalizeDestructive(false), null);
  assert.equal(normalizeDestructive(undefined), null);
  assert.equal(normalizeDestructive(null), null);
  assert.deepEqual(normalizeDestructive({ kinds: ['delete'], kind: 'send', purchase: true, explicit: false }), {
    kinds: ['DELETE', 'SEND', 'PURCHASE'],
    explicit: false
  });
  assert.deepEqual(normalizeDestructive({ purchase: false }), { kinds: ['DELETE'], explicit: true });
  const shape = capture(() => normalizeDestructive(7));
  assert.equal(shape.code, CODES.ACTION_INVALID);
  assert.equal(shape.message, LONG_MESSAGES.destructiveShape);
  assert.equal(LONG_MESSAGES.destructiveShape.length, 57);
  assert.deepEqual(shape.details, { received: 'number' });

  // Body-level `destructive` wins when truthy, but a falsy body value falls
  // through to `safety` — the donor's `body.destructive || body.safety`.
  assert.deepEqual(normalizeAction({ type: 'FILE_DELETE', path: 'p', safety: { kind: 'format' } }).destructive, { kinds: ['FORMAT'], explicit: true });
  assert.deepEqual(normalizeAction({ type: 'FILE_DELETE', path: 'p', destructive: false, safety: { kind: 'format' } }).destructive, { kinds: ['FORMAT'], explicit: true });
  assert.deepEqual(normalizeAction({ type: 'FILE_DELETE', path: 'p', destructive: true }).destructive, { kinds: ['DELETE'], explicit: true });
});

test('validation rejects an action that is missing the thing it must act on', () => {
  const click = capture(() => normalizeAction({ type: 'CLICK' }));
  assert.equal(click.code, CODES.ACTION_INVALID);
  assert.equal(click.message, 'CLICK requires one of: target, point');
  assert.deepEqual(click.details, { type: 'CLICK', requiredAny: ['target', 'point'] });

  const scroll = capture(() => normalizeAction({ type: 'SCROLL' }));
  assert.equal(scroll.message, 'SCROLL requires one of: target, point, dy, dx');
  assert.deepEqual(scroll.details, { type: 'SCROLL', requiredAny: ['target', 'point', 'dy', 'dx'] });

  const fileWrite = capture(() => normalizeAction({ type: 'FILE_WRITE', path: 'p' }));
  assert.equal(fileWrite.message, 'FILE_WRITE requires one of: content, text');

  const typeMissing = capture(() => normalizeAction({ type: 'TYPE' }));
  assert.equal(typeMissing.message, 'TYPE requires "text"');
  assert.deepEqual(typeMissing.details, { type: 'TYPE', missing: 'text' });

  assert.equal(capture(() => normalizeAction({ type: 'TYPE', text: '' })).message, 'TYPE requires "text"');
  assert.equal(capture(() => normalizeAction({ type: 'SHELL_EXEC', command: '' })).message, 'SHELL_EXEC requires "command"');

  const typeNotString = capture(() => normalizeAction({ type: 'TYPE', text: 5 }));
  assert.equal(typeNotString.message, 'TYPE requires text to be a string');
  assert.deepEqual(typeNotString.details, { received: 'number' });

  assert.equal(capture(() => normalizeAction({ type: 'HOTKEY', keys: 'ctrl' })).message, 'HOTKEY requires a non-empty keys array');
  assert.equal(capture(() => normalizeAction({ type: 'HOTKEY', keys: [] })).message, 'HOTKEY requires a non-empty keys array');
  assert.equal(capture(() => normalizeAction({ type: 'SHELL_EXEC', command: 5 })).message, 'SHELL_EXEC requires command to be a string');

  // A no-parameter action still validates, and validateAction echoes its input.
  const refresh = normalizeAction('BROWSER_REFRESH');
  assert.equal(validateAction(refresh), refresh);
});

test('the donor `any` fallback to the resolved target lets a DOM_TYPE through without text (preserved donor defect)', () => {
  // The `any` rule reads `action.params[key] ?? action.target`, so a present
  // target satisfies `any: ['text', 'value']` even though no text was written.
  const action = normalizeAction({ type: 'DOM_TYPE', target: '#x' });
  assert.deepEqual(action.params, { target: '#x' });
  assert.equal(action.params.text, undefined);
  assert.deepEqual(action.target, { selector: '#x', kinds: ['selector'], rank: 1, primaryKind: 'selector' });
  const select = normalizeAction({ type: 'SELECT', target: '#x' });
  assert.equal(select.params.value, undefined);
});

test('requiresTarget is the donor action list plus any resolved target', () => {
  assert.equal(requiresTarget(normalizeAction({ type: 'BROWSER_REFRESH' })), false);
  assert.equal(requiresTarget(normalizeAction({ type: 'SCROLL', dy: 5 })), false);
  assert.equal(requiresTarget(normalizeAction({ type: 'MOVE', point: { x: 1, y: 2 } })), false);
  // The donor list is unconditional: a CLICK is on it even when it carries a raw point.
  assert.equal(requiresTarget(normalizeAction({ type: 'CLICK', point: { x: 1, y: 2 } })), true);
  assert.equal(requiresTarget(normalizeAction({ type: 'CLICK', target: '#a' })), true);
  for (const type of ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'DOM_CLICK', 'DOM_TYPE', 'DOM_SELECT', 'ACCESSIBILITY_INVOKE', 'ACCESSIBILITY_SET_VALUE', 'FOCUS', 'SELECT']) {
    assert.equal(requiresTarget(normalizeAction({ type, target: '#a' })), true, type);
  }
});

test('describeAction is log-safe: targets labelled, secrets redacted, long payloads truncated', () => {
  assert.equal(describeAction(normalizeAction({ type: 'CLICK', target: '#save' })), 'CLICK selector:#save target="#save"');
  assert.equal(
    describeAction(normalizeAction({ type: 'TYPE', text: 'hunter2', target: '#pw', sensitive: true })),
    'TYPE selector:#pw text="[redacted]" target="#pw"'
  );
  const longText = 'x'.repeat(61);
  const truncated = describeAction(normalizeAction({ type: 'TYPE', text: longText, target: '#pw' }));
  assert.equal(truncated, `TYPE selector:#pw text="${'x'.repeat(60)}..." target="#pw"`);
  assert.equal(truncated.includes(longText), false);
  const longCommand = 'y'.repeat(81);
  assert.equal(describeAction(normalizeAction({ type: 'SHELL_EXEC', command: longCommand })), `SHELL_EXEC command="${'y'.repeat(80)}..."`);
  assert.equal(
    describeAction(normalizeAction({ type: 'SELECT', target: '#a', value: 'secret-value', sensitive: true })),
    'SELECT selector:#a value="[redacted]" target="#a"'
  );
  // 60 characters is exactly at the limit, so it is not truncated.
  assert.equal(describeAction(normalizeAction({ type: 'TYPE', text: 'x'.repeat(60), target: '#p' })).includes('...'), false);
});

test('destructiveKinds derives DELETE/FORMAT/INSTALL/PUBLISH from structured and shell actions', () => {
  assert.deepEqual(destructiveKinds(normalizeAction({ type: 'FILE_DELETE', path: 'p' })), ['DELETE']);
  assert.deepEqual(destructiveKinds(normalizeAction({ type: 'SHELL_EXEC', command: 'rm -rf /tmp' })), ['DELETE']);
  assert.deepEqual(destructiveKinds(normalizeAction({ type: 'SHELL_EXEC', command: 'echo hi' })), []);
  assert.deepEqual(
    destructiveKinds(normalizeAction({ type: 'SHELL_EXEC', command: 'rm -rf /tmp && format c: && npm install x && git push' })),
    ['DELETE', 'FORMAT', 'INSTALL', 'PUBLISH']
  );
  assert.deepEqual(
    destructiveKinds(normalizeAction({ type: 'SHELL_EXEC', command: 'powershell Install-Module x; diskpart; pip install y; git push origin main' })),
    ['FORMAT', 'INSTALL', 'PUBLISH']
  );
  // An explicit destructive block wins over the derived families.
  assert.deepEqual(destructiveKinds(normalizeAction({ type: 'FILE_DELETE', path: 'p', destructive: { kinds: ['send'] } })), ['SEND']);
  assert.deepEqual(destructiveKinds(normalizeAction({ type: 'TYPE', text: 'hi' })), []);
  assert.ok(CAPABILITIES.includes(normalizeAction({ type: 'FILE_DELETE', path: 'p' }).capability));
});

test('the target ladder vocabulary is the donor list, cheapest and most stable first', () => {
  assert.deepEqual(TARGET_KINDS, [
    { kind: 'selector', rank: 1, label: 'DOM selector' },
    { kind: 'accessibility', rank: 2, label: 'accessibility node' },
    { kind: 'semantic', rank: 3, label: 'semantic element' },
    { kind: 'window', rank: 4, label: 'window' },
    { kind: 'bbox', rank: 5, label: 'bounding box' },
    { kind: 'visual', rank: 6, label: 'visual target' },
    { kind: 'point', rank: 7, label: 'visual coordinate' }
  ]);
  assert.equal(TARGET_KINDS.length, 7);
});

test('normalizeTarget accepts the donor shapes and records kinds, rank and primaryKind', () => {
  assert.deepEqual(normalizeTarget('#save'), { selector: '#save', kinds: ['selector'], rank: 1, primaryKind: 'selector' });
  assert.deepEqual(normalizeTarget('Save'), { semantic: { text: 'Save' }, kinds: ['semantic'], rank: 3, primaryKind: 'semantic' });
  assert.deepEqual(normalizeTarget({ text: 'Save' }), { semantic: { text: 'Save' }, kinds: ['semantic'], rank: 3, primaryKind: 'semantic' });
  assert.deepEqual(normalizeTarget({ role: 'button', name: 'Save' }), {
    accessibility: { role: 'button', name: 'Save' },
    kinds: ['accessibility'],
    rank: 2,
    primaryKind: 'accessibility'
  });
  assert.deepEqual(normalizeTarget({ dom_selector: '#a' }), { selector: '#a', kinds: ['selector'], rank: 1, primaryKind: 'selector' });
  assert.deepEqual(normalizeTarget({ bbox: { x: 1, y: 2, width: 3, height: 4 } }), {
    bbox: { x: 1, y: 2, width: 3, height: 4 },
    kinds: ['bbox'],
    rank: 5,
    primaryKind: 'bbox'
  });
  assert.deepEqual(normalizeTarget({ x: 1, y: 2 }), { point: { x: 1, y: 2 }, kinds: ['point'], rank: 7, primaryKind: 'point' });
  assert.deepEqual(normalizeTarget({ window: 'W' }), { window: { title: 'W' }, kinds: ['window'], rank: 4, primaryKind: 'window' });
  assert.deepEqual(normalizeTarget({ visual: { paint: { color: '#fff' } } }), {
    visual: { paint: { color: '#fff' } },
    kinds: ['visual'],
    rank: 6,
    primaryKind: 'visual'
  });
  assert.deepEqual(normalizeTarget({ accessibility: {} }), { accessibility: {}, kinds: ['accessibility'], rank: 2, primaryKind: 'accessibility' });
  // A window is a locator context when another rung is present, never a rung of its own.
  assert.deepEqual(normalizeTarget({ selector: '#a', window: { title: 'W' } }).kinds, ['selector']);
  // Several rungs are reported best-first, and the rank is the best one.
  const twoRungs = normalizeTarget({ selector: '#a', point: { x: 1, y: 2 } });
  assert.deepEqual(twoRungs.kinds, ['selector', 'point']);
  assert.equal(twoRungs.rank, 1);
  // A candidate list is the ladder written by hand.
  const list = normalizeTarget(['#a', { text: 'b' }]);
  assert.deepEqual(list.kinds, ['selector', 'semantic']);
  assert.equal(list.rank, 1);
  assert.equal(list.primaryKind, 'selector');
  assert.deepEqual(list.candidates.map((entry) => entry.kinds), [['selector'], ['semantic']]);
});

test('the donor reads a bare lowercase word as a CSS selector (preserved donor defect)', () => {
  // `looksLikeSelector` matches any `[a-z][a-z0-9-]*`, so "save" never becomes
  // the semantic target an author probably meant. Kept verbatim.
  assert.deepEqual(normalizeTarget('save'), { selector: 'save', kinds: ['selector'], rank: 1, primaryKind: 'selector' });
  assert.deepEqual(normalizeTarget('my-button'), { selector: 'my-button', kinds: ['selector'], rank: 1, primaryKind: 'selector' });
  assert.deepEqual(normalizeTarget('Save As'), { semantic: { text: 'Save As' }, kinds: ['semantic'], rank: 3, primaryKind: 'semantic' });
});

test('normalizeTarget rejects malformed targets with the donor TARGET_INVALID messages', () => {
  const emptyString = capture(() => normalizeTarget('   '));
  assert.equal(emptyString.code, CODES.TARGET_INVALID);
  assert.equal(emptyString.message, LONG_MESSAGES.targetStringEmpty);

  const emptyObject = capture(() => normalizeTarget({}));
  assert.equal(emptyObject.code, CODES.TARGET_INVALID);
  assert.equal(emptyObject.message, LONG_MESSAGES.targetEmpty);
  assert.equal(emptyObject.message.length, 96);
  assert.equal(LONG_MESSAGES.targetEmpty.length, 96);
  assert.deepEqual(emptyObject.details, { received: {} });

  const shape = capture(() => normalizeTarget(5));
  assert.equal(shape.message, LONG_MESSAGES.targetShape);
  assert.equal(LONG_MESSAGES.targetShape.length, 56);
  assert.deepEqual(shape.details, { received: 'number' });

  const bboxShape = capture(() => normalizeTarget({ bbox: 5 }));
  assert.equal(bboxShape.message, 'bbox must be an object with x, y, width, height');
  assert.deepEqual(bboxShape.details, { received: 'number' });

  assert.equal(capture(() => normalizeTarget({ bbox: { x: 1, y: 2, width: 'a', height: 4 } })).message, 'bbox needs finite x, y, width and height');
  assert.equal(capture(() => normalizeTarget({ bbox: { x: 1, y: 2, width: 0, height: 4 } })).message, 'bbox must have a positive width and height');
  assert.equal(capture(() => normalizeTarget({ point: 5 })).message, 'point must be an object with x and y');
  assert.equal(capture(() => normalizeTarget({ point: { x: 1 } })).message, 'point needs finite x and y');
  assert.equal(capture(() => normalizeTarget({ window: 5 })).message, 'window must be a string or an object');
});

test('describeTarget labels the target the way the execution log reads it', () => {
  assert.equal(describeTarget(null), '(no target)');
  assert.equal(describeTarget({}), '(unresolved)');
  assert.equal(describeTarget({ selector: '#a' }), 'selector:#a');
  assert.equal(describeTarget({ accessibility: { role: 'button', name: 'Save' } }), 'ax:button/Save');
  assert.equal(describeTarget({ accessibility: {} }), 'ax:(any)');
  assert.equal(describeTarget({ semantic: { text: 'Save' } }), 'semantic:Save');
  assert.equal(describeTarget({ window: { title: 'W' } }), 'window:W');
  assert.equal(describeTarget({ window: {} }), 'window:(any)');
  assert.equal(describeTarget({ bbox: { x: 1, y: 2, width: 3, height: 4 } }), 'bbox:1,2,3x4');
  assert.equal(describeTarget({ point: { x: 1, y: 2 } }), 'point:1,2');
  assert.equal(describeTarget({ visual: { paint: { color: '#fff' } } }), 'visual:"#fff"');
  assert.equal(describeTarget({ visual: { template: 'x' } }), 'visual:template');
  assert.equal(describeTarget(normalizeTarget('#a')), 'selector:#a');
});
