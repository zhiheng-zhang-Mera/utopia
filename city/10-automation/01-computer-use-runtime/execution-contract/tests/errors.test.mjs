/**
 * UTOPIA · Automation District — typed failure parity.
 *
 * Pins every `CODES` member in donor order (including the two aliases), the
 * whole `defaultRetryable` table, the `ComputerUseError` shape and the
 * redaction rule against the DS-Hns donor `app/computer-use/errors.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CODES, ComputerUseError, fail, redactDetails, defaultRetryable } from '../errors.mjs';

const EXPECTED_CODES = [
  ['CONTRACT_INVALID', 'CONTRACT_INVALID'],
  ['CONTRACT_GOAL_MISSING', 'CONTRACT_GOAL_MISSING'],
  ['CONTRACT_LIMIT_EXCEEDED', 'CONTRACT_LIMIT_EXCEEDED'],
  ['PLAN_EXHAUSTED', 'PLAN_EXHAUSTED'],
  ['PLAN_INVALID', 'PLAN_INVALID'],
  ['STATE_INVALID', 'STATE_INVALID'],
  ['STATE_TRANSITION_INVALID', 'STATE_TRANSITION_INVALID'],
  ['TARGET_INVALID', 'TARGET_INVALID'],
  ['TARGET_NOT_FOUND', 'TARGET_NOT_FOUND'],
  ['TARGET_STALE', 'TARGET_STALE'],
  ['TARGET_NOT_ACTIONABLE', 'TARGET_NOT_ACTIONABLE'],
  ['TARGET_AMBIGUOUS', 'TARGET_AMBIGUOUS'],
  ['CONTROLLER_UNAVAILABLE', 'CONTROLLER_UNAVAILABLE'],
  ['TRANSPORT_LOST', 'CONTROLLER_UNAVAILABLE'],
  ['CONTROLLER_FAILED', 'CONTROLLER_FAILED'],
  ['CONTROLLER_TIMEOUT', 'CONTROLLER_TIMEOUT'],
  ['CAPABILITY_NOT_ALLOWED', 'CAPABILITY_NOT_ALLOWED'],
  ['CAPABILITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'],
  ['ACTION_UNSUPPORTED', 'ACTION_UNSUPPORTED'],
  ['ACTION_INVALID', 'ACTION_INVALID'],
  ['ACTION_TIMEOUT', 'ACTION_TIMEOUT'],
  ['VERIFICATION_FAILED', 'VERIFICATION_FAILED'],
  ['VERIFICATION_UNKNOWN', 'VERIFICATION_UNKNOWN'],
  ['ACTION_MISSED', 'ACTION_MISSED'],
  ['UI_UNSTABLE', 'UI_UNSTABLE'],
  ['WINDOW_MISMATCH', 'WINDOW_MISMATCH'],
  ['FOCUS_MISMATCH', 'FOCUS_MISMATCH'],
  ['SAFETY_REFUSED', 'SAFETY_REFUSED'],
  ['DESTRUCTIVE_FORBIDDEN', 'DESTRUCTIVE_FORBIDDEN'],
  ['DESTRUCTIVE_NEEDS_CONFIRMATION', 'DESTRUCTIVE_NEEDS_CONFIRMATION'],
  ['MODAL_BLOCKING', 'MODAL_BLOCKING'],
  ['MODAL_REQUIRES_USER', 'MODAL_BLOCKING'],
  ['STALL_DETECTED', 'STALL_DETECTED'],
  ['STEP_LIMIT_REACHED', 'STEP_LIMIT_REACHED'],
  ['RUN_TIMEOUT', 'RUN_TIMEOUT'],
  ['RUN_CANCELLED', 'RUN_CANCELLED'],
  ['OBSERVATION_EMPTY', 'OBSERVATION_EMPTY'],
  ['VISION_UNAVAILABLE', 'VISION_UNAVAILABLE'],
  ['SCREENSHOT_FAILED', 'SCREENSHOT_FAILED'],
  ['WORKSPACE_UNAVAILABLE', 'WORKSPACE_UNAVAILABLE'],
  ['WORKSPACE_MISMATCH', 'WORKSPACE_MISMATCH'],
  ['MUTATION_UNVERIFIED', 'MUTATION_UNVERIFIED'],
  ['COMMAND_INVALID', 'COMMAND_INVALID'],
  ['PROCESS_INVALID', 'PROCESS_INVALID'],
  ['PROCESS_LOST', 'PROCESS_LOST'],
  ['RESOURCE_LIMIT', 'RESOURCE_LIMIT'],
  ['RECONNECT_EXHAUSTED', 'RECONNECT_EXHAUSTED'],
  ['EVIDENCE_INSUFFICIENT', 'EVIDENCE_INSUFFICIENT'],
  ['STATE_INTEGRITY_UNCERTAIN', 'STATE_INTEGRITY_UNCERTAIN']
];

const RETRYABLE_CODE_VALUES = new Set([
  'TARGET_STALE',
  'TARGET_NOT_ACTIONABLE',
  'ACTION_MISSED',
  'CONTROLLER_UNAVAILABLE',
  'VERIFICATION_FAILED',
  'VERIFICATION_UNKNOWN',
  'ACTION_TIMEOUT',
  'CONTROLLER_TIMEOUT',
  'UI_UNSTABLE',
  'STALL_DETECTED',
  'MODAL_BLOCKING',
  'CAPABILITY_UNAVAILABLE',
  'PROCESS_LOST',
  'EVIDENCE_INSUFFICIENT'
]);

test('CODES holds every donor member, in donor order, with the donor values', () => {
  assert.deepEqual(Object.keys(CODES), EXPECTED_CODES.map(([name]) => name));
  assert.equal(Object.keys(CODES).length, 49);
  for (const [name, value] of EXPECTED_CODES) {
    assert.equal(CODES[name], value, `${name} must be ${value}`);
    assert.equal(typeof CODES[name], 'string');
    assert.ok(CODES[name].length > 0);
  }
});

test('the two donor aliases stay aliases, not copies', () => {
  assert.equal(CODES.TRANSPORT_LOST, CODES.CONTROLLER_UNAVAILABLE);
  assert.equal(CODES.MODAL_REQUIRES_USER, CODES.MODAL_BLOCKING);
  assert.equal(CODES.TRANSPORT_LOST, 'CONTROLLER_UNAVAILABLE');
  assert.equal(CODES.MODAL_REQUIRES_USER, 'MODAL_BLOCKING');
});

test('defaultRetryable is the donor table and nothing wider', () => {
  for (const name of Object.keys(CODES)) {
    const expected = RETRYABLE_CODE_VALUES.has(CODES[name]);
    assert.equal(defaultRetryable(CODES[name]), expected, `${name} retryability`);
  }
  // Because TRANSPORT_LOST is the same value as CONTROLLER_UNAVAILABLE, asking
  // about either name answers "retryable" — donor behaviour, kept verbatim.
  assert.equal(defaultRetryable(CODES.CONTROLLER_UNAVAILABLE), true);
  assert.equal(defaultRetryable(CODES.TRANSPORT_LOST), true);
  assert.equal(defaultRetryable(CODES.MODAL_BLOCKING), true);
  assert.equal(defaultRetryable(CODES.MODAL_REQUIRES_USER), true);
  assert.equal(RETRYABLE_CODE_VALUES.size, 14);
});

test('ComputerUseError carries code, message, details, retryability and fault boundary', () => {
  const error = new ComputerUseError(CODES.TARGET_STALE, 'the target moved', { controllerId: 'desktop-1', state: 'REVALIDATING' });
  assert.ok(error instanceof Error);
  assert.ok(error instanceof ComputerUseError);
  assert.equal(error.name, 'ComputerUseError');
  assert.equal(error.message, 'the target moved');
  assert.equal(error.code, CODES.TARGET_STALE);
  assert.deepEqual(error.details, { controllerId: 'desktop-1', state: 'REVALIDATING' });
  assert.equal(error.retryable, true);
  assert.equal(error.controllerId, 'desktop-1');
  assert.equal(error.state, 'REVALIDATING');
  assert.equal(typeof error.stack, 'string');
});

test('the message falls back to the code, and empty fault fields become null', () => {
  const error = new ComputerUseError(CODES.CONTRACT_GOAL_MISSING);
  assert.equal(error.message, CODES.CONTRACT_GOAL_MISSING);
  assert.deepEqual(error.details, {});
  assert.equal(error.retryable, false);
  assert.equal(error.controllerId, null);
  assert.equal(error.state, null);
  const empty = new ComputerUseError(CODES.RUN_TIMEOUT, '', { controllerId: '', state: '' });
  assert.equal(empty.message, CODES.RUN_TIMEOUT);
  assert.equal(empty.controllerId, null);
  assert.equal(empty.state, null);
});

test('an explicit retryable detail wins over the default table, coerced to boolean', () => {
  assert.equal(new ComputerUseError(CODES.TARGET_STALE, 'm', { retryable: false }).retryable, false);
  assert.equal(new ComputerUseError(CODES.TARGET_STALE, 'm', { retryable: 0 }).retryable, false);
  assert.equal(new ComputerUseError(CODES.RUN_TIMEOUT, 'm', { retryable: true }).retryable, true);
  assert.equal(new ComputerUseError(CODES.RUN_TIMEOUT, 'm', { retryable: 'yes' }).retryable, true);
  assert.equal(new ComputerUseError(CODES.RUN_TIMEOUT, 'm', {}).retryable, false);
});

test('toJSON is the log shape, with details redacted and no extra keys', () => {
  const error = new ComputerUseError(CODES.SAFETY_REFUSED, 'refused', {
    password: 'hunter2',
    nested: { apiKey: 'k', ok: 1 },
    retryable: false
  });
  const json = error.toJSON();
  assert.deepEqual(Object.keys(json), ['code', 'message', 'retryable', 'controllerId', 'state', 'details']);
  assert.deepEqual(json, {
    code: CODES.SAFETY_REFUSED,
    message: 'refused',
    retryable: false,
    controllerId: null,
    state: null,
    details: { password: '[redacted]', nested: { apiKey: '[redacted]', ok: 1 }, retryable: false }
  });
});

test('redaction matches the donor key pattern, recursively, and only on keys', () => {
  assert.equal(redactDetails(null), null);
  assert.equal(redactDetails(undefined), undefined);
  assert.equal(redactDetails(42), 42);
  assert.equal(redactDetails('plain'), 'plain');
  assert.deepEqual(redactDetails(['password', 'text']), ['password', 'text']);
  assert.deepEqual(
    redactDetails({
      password: 'p',
      passphrase: 'p',
      token: 't',
      secret: 's',
      apiKey: 'k',
      'api-key': 'k',
      api_key: 'k',
      credential: 'c',
      authorization: 'a',
      cookie: 'c',
      PASSWORD: 'p',
      myToken: 't',
      text: 'not redacted',
      value: { note: 'nested' }
    }),
    {
      password: '[redacted]',
      passphrase: '[redacted]',
      token: '[redacted]',
      secret: '[redacted]',
      apiKey: '[redacted]',
      'api-key': '[redacted]',
      api_key: '[redacted]',
      credential: '[redacted]',
      authorization: '[redacted]',
      cookie: '[redacted]',
      PASSWORD: '[redacted]',
      myToken: '[redacted]',
      text: 'not redacted',
      value: { note: 'nested' }
    }
  );
  // The pattern is a substring match, so a key that merely contains a sensitive
  // word is redacted as well.
  assert.deepEqual(redactDetails({ secretish: 'nested', api: 1, cook: 2 }), { secretish: '[redacted]', api: 1, cook: 2 });
  // The pattern reads keys, never values: a secret under an innocent key is kept.
  assert.deepEqual(redactDetails([{ text: 'hunter2' }]), [{ text: 'hunter2' }]);
});

test('redaction turns any non-plain object into its enumerable entries (preserved donor defect)', () => {
  // `Object.entries(new Date())` is empty, so a Date in error details is
  // silently reduced to `{}`. The donor did exactly this; the port keeps it.
  assert.deepEqual(redactDetails(new Date(0)), {});
  const map = new Map([['a', 1]]);
  assert.deepEqual(redactDetails(map), {});
  assert.deepEqual(redactDetails({ when: new Date(0) }), { when: {} });
});

test('fail() is the donor constructor shorthand', () => {
  const error = fail(CODES.PLAN_INVALID, 'bad plan', { step: 2 });
  assert.ok(error instanceof ComputerUseError);
  assert.equal(error.code, CODES.PLAN_INVALID);
  assert.equal(error.message, 'bad plan');
  assert.deepEqual(error.details, { step: 2 });
  assert.equal(error.retryable, false);
});
