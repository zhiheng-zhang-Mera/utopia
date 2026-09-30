/**
 * UTOPIA · City · Worker Gateway — provider lifecycle state suite.
 *
 * Donor parity suite. The AUTO_ACTIONS / PAUSED_ACTIONS sets, the default reason
 * strings, the `autoResume` values, the conditional `retryAt` and the `updatedAt`
 * format restate Codex-Boss `src/shared/provider-state.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * One adaptation is asserted: the donor defaulted `now` to `Date.now()`, while
 * this module takes the millisecond timestamp as a parameter, so a case that
 * named no clock would produce a different record on every run. Here the clock is
 * always a test argument and every record is compared exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_REASON,
  AUTO_ACTIONS,
  AUTO_REASON,
  PAUSED_ACTIONS,
  PAUSED_REASON,
  PROVIDER_STATE_LABELS,
  PROVIDER_STATES,
  pausedForProvider,
  providerStateLabel,
  providerStateRecord,
  stateForRecovery,
} from '../index.mjs';

const NOW = 1_774_000_000_000;
const UPDATED_AT = new Date(NOW).toISOString();
const RETRY_AT = NOW + 60_000;

// ---------------------------------------------------------------------------
// the closed vocabularies
// ---------------------------------------------------------------------------

test('the action sets and the state vocabulary are the donor sets', () => {
  assert.deepEqual(AUTO_ACTIONS, ['WAIT', 'RETRY', 'RECONSTRUCT', 'DEFER']);
  assert.deepEqual(PAUSED_ACTIONS, ['HUMAN_REQUIRED', 'VERIFY_SIDE_EFFECT']);
  assert.deepEqual(PROVIDER_STATES, ['ACTIVE', 'WAITING_PROVIDER', 'PAUSED_PROVIDER']);
  assert.equal(AUTO_REASON, '等待服务商恢复');
  assert.equal(PAUSED_REASON, '等待服务商人工处理');
  assert.equal(ACTIVE_REASON, '运行中');
  assert.equal(AUTO_ACTIONS.some((action) => PAUSED_ACTIONS.includes(action)), false, 'the two sets are disjoint');
});

// ---------------------------------------------------------------------------
// stateForRecovery
// ---------------------------------------------------------------------------

test('every AUTO_ACTION waits and auto-resumes', () => {
  assert.equal(AUTO_ACTIONS.length, 4);
  for (const action of AUTO_ACTIONS) {
    const record = stateForRecovery(action, 'provider is reconnecting', undefined, NOW);
    assert.equal(record.state, 'WAITING_PROVIDER', `${action} must wait`);
    assert.equal(record.autoResume, true, `${action} must auto-resume`);
    assert.equal(record.reason, 'provider is reconnecting');
    assert.equal(record.updatedAt, UPDATED_AT);
  }
});

test('every PAUSED_ACTION pauses and must not auto-resume', () => {
  assert.equal(PAUSED_ACTIONS.length, 2);
  for (const action of PAUSED_ACTIONS) {
    const record = stateForRecovery(action, 'human must sign in', undefined, NOW);
    assert.equal(record.state, 'PAUSED_PROVIDER', `${action} must pause`);
    assert.equal(record.autoResume, false, `${action} must not auto-resume`);
    assert.equal(record.reason, 'human must sign in');
    assert.equal(record.updatedAt, UPDATED_AT);
  }
});

test('an action in neither set is ACTIVE and auto-resumes', () => {
  for (const action of ['NONE', 'RUN', 'CONTINUE', 'wait', '', 'UNLISTED_ACTION']) {
    const record = stateForRecovery(action, 'nothing is waiting', undefined, NOW);
    assert.equal(record.state, 'ACTIVE', `${JSON.stringify(action)} must fall through to ACTIVE`);
    assert.equal(record.autoResume, true);
  }

  // And the listed actions really are listed: the same call with WAIT differs.
  assert.notEqual(stateForRecovery('WAIT', 'x', undefined, NOW).state, stateForRecovery('NONE', 'x', undefined, NOW).state);
});

test('a falsy reason falls back to that state default, a real reason is kept', () => {
  assert.equal(stateForRecovery('WAIT', '', undefined, NOW).reason, AUTO_REASON);
  assert.equal(stateForRecovery('WAIT', undefined, undefined, NOW).reason, AUTO_REASON);
  assert.equal(stateForRecovery('HUMAN_REQUIRED', '', undefined, NOW).reason, PAUSED_REASON);
  assert.equal(stateForRecovery('HUMAN_REQUIRED', undefined, undefined, NOW).reason, PAUSED_REASON);
  assert.equal(stateForRecovery('NONE', '', undefined, NOW).reason, ACTIVE_REASON);
  assert.equal(stateForRecovery('NONE', undefined, undefined, NOW).reason, ACTIVE_REASON);

  assert.equal(stateForRecovery('WAIT', 'rate limit resets at 12:00', undefined, NOW).reason, 'rate limit resets at 12:00');
  assert.equal(stateForRecovery('VERIFY_SIDE_EFFECT', 'confirm the write', undefined, NOW).reason, 'confirm the write');
});

test('retryAt is present only when it was defined', () => {
  const withDeadline = stateForRecovery('RETRY', 'later', RETRY_AT, NOW);
  assert.equal(withDeadline.retryAt, RETRY_AT);
  assert.deepEqual(withDeadline, {
    state: 'WAITING_PROVIDER',
    reason: 'later',
    autoResume: true,
    retryAt: RETRY_AT,
    updatedAt: UPDATED_AT,
  });

  const withoutDeadline = stateForRecovery('RETRY', 'later', undefined, NOW);
  assert.equal('retryAt' in withoutDeadline, false, 'an undefined retryAt must not become a field');
  assert.deepEqual(withoutDeadline, {
    state: 'WAITING_PROVIDER',
    reason: 'later',
    autoResume: true,
    updatedAt: UPDATED_AT,
  });

  const zero = stateForRecovery('RETRY', 'later', 0, NOW);
  assert.equal(zero.retryAt, 0, 'zero is a defined deadline and must survive');
  assert.equal('retryAt' in zero, true);

  const paused = stateForRecovery('HUMAN_REQUIRED', 'later', RETRY_AT, NOW);
  assert.equal(paused.retryAt, RETRY_AT, 'the donor did not special-case the paused branch');
  assert.equal(paused.autoResume, false);

  const active = stateForRecovery('NONE', 'later', RETRY_AT, NOW);
  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.retryAt, RETRY_AT);
});

test('updatedAt is the injected clock in ISO form, and the clock is required', () => {
  assert.equal(stateForRecovery('WAIT', 'x', undefined, NOW).updatedAt, new Date(NOW).toISOString());
  assert.equal(stateForRecovery('WAIT', 'x', undefined, 0).updatedAt, new Date(0).toISOString());
  assert.match(stateForRecovery('WAIT', 'x', undefined, NOW).updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const earlier = stateForRecovery('WAIT', 'x', undefined, NOW);
  const later = stateForRecovery('WAIT', 'x', undefined, NOW + 1000);
  assert.notEqual(earlier.updatedAt, later.updatedAt, 'the injected clock is really read');

  assert.throws(() => stateForRecovery('WAIT', 'x', undefined), TypeError);
  assert.throws(() => stateForRecovery('WAIT', 'x', undefined, 'now'), TypeError);
  assert.throws(() => stateForRecovery('WAIT', 'x', 'soon', NOW), TypeError);
});

// ---------------------------------------------------------------------------
// pausedForProvider
// ---------------------------------------------------------------------------

test('pausedForProvider pauses, never auto-resumes and never writes a deadline', () => {
  const record = pausedForProvider('budget exhausted', NOW);
  assert.deepEqual(record, {
    state: 'PAUSED_PROVIDER',
    reason: 'budget exhausted',
    autoResume: false,
    updatedAt: UPDATED_AT,
  });
  assert.equal('retryAt' in record, false, 'a human-gated pause has no retry deadline');
  assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  assert.equal(pausedForProvider('登录过期', NOW).reason, '登录过期');
  assert.throws(() => pausedForProvider('budget exhausted'), TypeError, 'the clock is a parameter here');
  assert.throws(() => pausedForProvider('', NOW), TypeError, 'the reason is used as given, never defaulted or repaired');
});

// ---------------------------------------------------------------------------
// providerStateLabel
// ---------------------------------------------------------------------------

test('the three labels are the donor labels', () => {
  assert.deepEqual(PROVIDER_STATE_LABELS, {
    ACTIVE: '等待中',
    WAITING_PROVIDER: '等待服务商恢复',
    PAUSED_PROVIDER: '等待服务商人工处理',
  });
  assert.equal(providerStateLabel('ACTIVE'), '等待中');
  assert.equal(providerStateLabel('WAITING_PROVIDER'), '等待服务商恢复');
  assert.equal(providerStateLabel('PAUSED_PROVIDER'), '等待服务商人工处理');

  for (const state of PROVIDER_STATES) {
    assert.equal(providerStateLabel(state), PROVIDER_STATE_LABELS[state]);
    assert.equal(typeof providerStateLabel(state), 'string');
    assert.notEqual(providerStateLabel(state), 'undefined');
  }

  // The donor's table lookup returned undefined for anything else; this refuses.
  assert.throws(() => providerStateLabel('WAITING'), TypeError);
  assert.throws(() => providerStateLabel(undefined), TypeError);
});

// ---------------------------------------------------------------------------
// the record shape
// ---------------------------------------------------------------------------

test('providerStateRecord validates the donor shape instead of repairing it', () => {
  const record = providerStateRecord({
    state: 'WAITING_PROVIDER',
    reason: AUTO_REASON,
    autoResume: true,
    retryAt: RETRY_AT,
    updatedAt: UPDATED_AT,
  });
  assert.deepEqual(record, {
    state: 'WAITING_PROVIDER',
    reason: AUTO_REASON,
    autoResume: true,
    retryAt: RETRY_AT,
    updatedAt: UPDATED_AT,
  });

  const noDeadline = providerStateRecord({
    state: 'ACTIVE',
    reason: ACTIVE_REASON,
    autoResume: true,
    updatedAt: UPDATED_AT,
  });
  assert.equal('retryAt' in noDeadline, false);

  // Copy-on-construct.
  const caller = { state: 'ACTIVE', reason: ACTIVE_REASON, autoResume: true, updatedAt: UPDATED_AT };
  const copy = providerStateRecord(caller);
  caller.state = 'PAUSED_PROVIDER';
  caller.reason = 'mutated';
  assert.equal(copy.state, 'ACTIVE');
  assert.equal(copy.reason, ACTIVE_REASON);

  // No repair, no defaulting.
  assert.throws(() => providerStateRecord({ state: 'WAITING', reason: 'x', autoResume: true, updatedAt: UPDATED_AT }), TypeError);
  assert.throws(() => providerStateRecord({ state: 'ACTIVE', reason: '', autoResume: true, updatedAt: UPDATED_AT }), TypeError);
  assert.throws(() => providerStateRecord({ state: 'ACTIVE', reason: 'x', autoResume: 'yes', updatedAt: UPDATED_AT }), TypeError);
  assert.throws(() => providerStateRecord({ state: 'ACTIVE', reason: 'x', autoResume: true, updatedAt: '' }), TypeError);
  assert.throws(() => providerStateRecord({ state: 'ACTIVE', reason: 'x', autoResume: true, retryAt: 'later', updatedAt: UPDATED_AT }), TypeError);
});
