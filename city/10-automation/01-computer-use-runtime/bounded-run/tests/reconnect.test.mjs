/**
 * UTOPIA · 10-automation / Computer Use Runtime — reconnect suite.
 *
 * Restates the DS-Hns donor `app/computer-use/reconnect.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the per-channel, per-step attempt
 * budget at, just below and just above its bound; the transport-failure
 * classification; the channel attribution rules; and the two donor defects this
 * port carries on purpose (a successful `recover()` still reports `world: null`,
 * and a `null` observation is `context_invalid`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createReconnectPolicy,
  createChannelRecovery,
  RECONNECT,
  isTransportFailure,
  channelOfError,
  channelHintFor,
  TRANSPORT_CODES,
  DEFAULT_MAX_ATTEMPTS,
} from '../reconnect.mjs';
import { ComputerUseError } from '../contracts.mjs';

/** A sleep spy: the policy's delay is injectable and is never actually waited. */
function sleepSpy() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('the outcome vocabulary and the donor default budget', () => {
  assert.deepEqual(RECONNECT, {
    RECONNECTED: 'reconnected',
    EXHAUSTED: 'exhausted',
    NOT_NEEDED: 'not_needed',
    CONTEXT_INVALID: 'context_invalid',
  });
  assert.equal(DEFAULT_MAX_ATTEMPTS, 2);
  assert.equal(createReconnectPolicy().maxAttempts, 2);
  assert.equal(createReconnectPolicy({ maxAttempts: 0 }).maxAttempts, 2);
  assert.equal(createReconnectPolicy({ maxAttempts: -3 }).maxAttempts, 2);
  assert.equal(createReconnectPolicy({ maxAttempts: 1 }).maxAttempts, 1);
  assert.equal(createReconnectPolicy({ maxAttempts: 4 }).maxAttempts, 4);
});

test('no reattach function is exhausted with zero attempts', async () => {
  const policy = createReconnectPolicy({ now: () => 0 });
  const outcome = await policy.reconnect({ channel: 'browser' });
  assert.deepEqual(outcome, {
    at: 0,
    channel: 'browser',
    outcome: 'exhausted',
    reason: 'no reattach function was supplied',
    attempts: 0,
  });
});

test('one attempt below the bound connects on the first try', async () => {
  const guard = sleepSpy();
  const policy = createReconnectPolicy({ sleep: guard.sleep, now: () => 5 });
  const seen = [];
  const outcome = await policy.reconnect({
    channel: 'browser',
    reattach: async (input) => {
      seen.push(input);
      return true;
    },
  });
  assert.deepEqual(seen, [{ channel: 'browser', attempt: 1, reason: null }]);
  assert.deepEqual(outcome, {
    at: 5,
    channel: 'browser',
    outcome: 'reconnected',
    attempt: 1,
    reason: 'browser reattached',
  });
  assert.deepEqual(guard.waits, []);
  assert.deepEqual(policy.budget('browser'), { channel: 'browser', used: 1, max: 2, remaining: 1, exhausted: false });
});

test('the budget is spent per channel and per step: at, just below and just above the bound', async () => {
  const guard = sleepSpy();
  const policy = createReconnectPolicy({ sleep: guard.sleep, backoffMs: 120, maxBackoffMs: 400, now: () => 0 });

  // Just below the bound: the first failure is retried and the second succeeds.
  let calls = 0;
  const recovered = await policy.reconnect({
    channel: 'desktop',
    reattach: async () => {
      calls += 1;
      return calls >= 2;
    },
  });
  assert.equal(recovered.outcome, 'reconnected');
  assert.equal(recovered.attempt, 2);
  assert.deepEqual(guard.waits, [120]);
  assert.deepEqual(policy.budget('desktop'), { channel: 'desktop', used: 2, max: 2, remaining: 0, exhausted: true });

  // At the bound: a second call may not spend anything.
  const spent = await policy.reconnect({ channel: 'desktop', reattach: async () => true });
  assert.equal(spent.outcome, 'exhausted');
  assert.equal(spent.reason, 'the reconnect budget for desktop is spent (2 attempts)');
  assert.equal(spent.attempts, 2);

  // A different channel has its own budget.
  const other = await policy.reconnect({ channel: 'vision', reattach: async () => true });
  assert.equal(other.outcome, 'reconnected');
  assert.deepEqual(policy.budget('vision'), { channel: 'vision', used: 1, max: 2, remaining: 1, exhausted: false });

  // Just above the bound: a fresh step resets every channel's budget.
  assert.deepEqual(policy.beginStep(), { at: 0 });
  assert.deepEqual(policy.budget('desktop'), { channel: 'desktop', used: 0, max: 2, remaining: 2, exhausted: false });
  const afterReset = await policy.reconnect({ channel: 'desktop', reattach: async () => true });
  assert.equal(afterReset.outcome, 'reconnected');
});

test('a channel that never comes back is exhausted after exactly maxAttempts attempts', async () => {
  const guard = sleepSpy();
  const policy = createReconnectPolicy({ sleep: guard.sleep, now: () => 0 });
  const attempts = [];
  const outcome = await policy.reconnect({
    channel: 'shell',
    reattach: async ({ attempt }) => {
      attempts.push(attempt);
      return { ok: false, reason: `attempt ${attempt} refused` };
    },
  });
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(guard.waits, [120]);
  assert.deepEqual(outcome, {
    at: 0,
    channel: 'shell',
    outcome: 'exhausted',
    attempts: 2,
    reason: 'shell did not come back within 2 bounded attempts (attempt 2 refused)',
  });
  assert.deepEqual(policy.events(), [
    { at: 0, channel: 'shell', outcome: 'attempt_failed', attempt: 1, reason: 'attempt 1 refused' },
    { at: 0, channel: 'shell', outcome: 'attempt_failed', attempt: 2, reason: 'attempt 2 refused' },
    { at: 0, channel: 'shell', outcome: 'exhausted', attempts: 2, reason: 'shell did not come back within 2 bounded attempts (attempt 2 refused)' },
  ]);
});

test('the backoff is bounded, and a one-attempt budget never spends it', async () => {
  const guard = sleepSpy();
  const policy = createReconnectPolicy({ sleep: guard.sleep, maxAttempts: 4, backoffMs: 300, maxBackoffMs: 500, now: () => 0 });
  await policy.reconnect({ channel: 'browser', reattach: async () => false });
  assert.deepEqual(guard.waits, [300, 500, 500]);

  const single = createReconnectPolicy({ sleep: guard.sleep, maxAttempts: 1, now: () => 0 });
  const one = await single.reconnect({ channel: 'browser', reattach: async () => false });
  assert.equal(one.outcome, 'exhausted');
  assert.equal(one.attempts, 1);
  assert.equal(one.reason, 'browser did not come back within 1 bounded attempts');
});

test('a reattach that throws is a failed attempt, and the message is carried', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, maxAttempts: 1, now: () => 0 });
  const outcome = await policy.reconnect({
    channel: 'browser',
    reattach: async () => {
      throw new Error('pipe is gone');
    },
  });
  assert.deepEqual(outcome, {
    at: 0,
    channel: 'browser',
    outcome: 'exhausted',
    attempts: 1,
    reason: 'browser did not come back within 1 bounded attempts (pipe is gone)',
  });
});

test('an undefined reattach result counts as attached, a bare false does not', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, now: () => 0 });
  assert.equal((await policy.reconnect({ channel: 'a', reattach: async () => undefined })).outcome, 'reconnected');
  assert.equal((await policy.reconnect({ channel: 'b', reattach: async () => false })).outcome, 'exhausted');
  const objectWithoutOk = await policy.reconnect({ channel: 'c', reattach: async () => ({ reason: 'no ok field' }) });
  assert.equal(objectWithoutOk.outcome, 'reconnected');
});

test('a fresh step resets the budget but not the event log', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, now: () => 0 });
  await policy.reconnect({ channel: 'browser', reattach: async () => true });
  assert.equal(policy.events().length, 1);
  policy.beginStep();
  assert.equal(policy.events().length, 1);
  const events = policy.events();
  events.length = 0;
  assert.equal(policy.events().length, 1);
});

test('the event log is bounded at 100 entries', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, maxAttempts: 1, now: () => 0 });
  for (let index = 0; index < 120; index += 1) {
    await policy.reconnect({ channel: `channel-${index}`, reattach: async () => true });
  }
  assert.equal(policy.events().length, 100);
});

test('the transport codes are exactly the donor four', () => {
  assert.deepEqual(TRANSPORT_CODES, [
    'CONTROLLER_UNAVAILABLE',
    'CONTROLLER_FAILED',
    'CONTROLLER_TIMEOUT',
    'CAPABILITY_UNAVAILABLE',
  ]);
  assert.equal(TRANSPORT_CODES.length, 4);
});

test('isTransportFailure classifies the donor codes, the raw transport messages and nothing else', () => {
  for (const code of TRANSPORT_CODES) {
    assert.equal(isTransportFailure({ code }), true, code);
  }
  assert.equal(isTransportFailure({ details: { code: 'CONTROLLER_TIMEOUT' } }), true);
  assert.equal(isTransportFailure({ code: 'TARGET_STALE' }), false);
  assert.equal(isTransportFailure({ code: 'VERIFICATION_FAILED' }), false);
  assert.equal(isTransportFailure({ code: 'CAPABILITY_NOT_ALLOWED' }), false);
  assert.equal(isTransportFailure({ code: 'SAFETY_REFUSED' }), false);
  assert.equal(isTransportFailure(null), false);
  assert.equal(isTransportFailure(undefined), false);

  const messages = [
    'the socket disconnected',
    'detached from the page',
    'EPIPE while writing',
    'ECONNRESET',
    'Target closed',
    'no such session',
    'the pipe is closed',
    'not connected to the browser',
    'the connection was CLOSED',
  ];
  for (const message of messages) assert.equal(isTransportFailure({ message }), true, message);

  assert.equal(isTransportFailure({ message: 'the element was not found' }), false);
  assert.equal(isTransportFailure('plain string with no transport word'), false);
  // A raw string is stringified and tested too.
  assert.equal(isTransportFailure('the socket is gone'), true);
});

test('channelOfError prefers the error-named channel and never guesses', () => {
  assert.equal(channelOfError({ details: { channel: 'desktop' } }), 'desktop');
  assert.equal(channelOfError({ details: { controller: 'vision' } }), 'vision');
  assert.equal(channelOfError({ details: { channel: 'desktop', controller: 'vision' } }), 'desktop');
  assert.equal(channelOfError({ details: {} }, 'browser'), 'browser');
  assert.equal(channelOfError(new Error('no channel'), 'browser'), 'browser');
  assert.equal(channelOfError(new Error('no channel')), null);
  assert.equal(channelOfError({ details: { channel: 7 } }), '7');
});

test('channelHintFor reads the last route, then the capability map, and never guesses', () => {
  assert.equal(channelHintFor({ capability: 'filesystem' }), 'file');
  assert.equal(channelHintFor({ capability: 'screenshot' }), 'vision');
  assert.equal(channelHintFor({ capability: 'desktop' }), 'desktop');
  assert.equal(channelHintFor({ capability: 'unknown-capability' }), null);
  assert.equal(channelHintFor({}), null);
  assert.equal(channelHintFor(null), null);
  assert.equal(channelHintFor({ capability: 'desktop' }, { lastRoute: { controller: 'browser' } }), 'browser');
  assert.equal(channelHintFor({ capability: 'desktop' }, { lastRoute: {} }), 'desktop');
  assert.equal(channelHintFor({ capability: 'desktop' }, null), 'desktop');
});

test('exhaustedError is the donor RECONNECT_EXHAUSTED failure', async () => {
  const policy = createReconnectPolicy({ now: () => 0 });
  const outcome = await policy.reconnect({ channel: 'browser' });
  const error = policy.exhaustedError(outcome);
  assert.ok(error instanceof ComputerUseError);
  assert.equal(error.code, 'RECONNECT_EXHAUSTED');
  assert.equal(error.message, 'no reattach function was supplied');
  assert.deepEqual(error.details, { channel: 'browser', attempts: 0 });
  assert.equal(error.retryable, false);

  const bare = policy.exhaustedError(null);
  assert.equal(bare.message, 'the reconnect budget is spent');
  assert.deepEqual(bare.details, { channel: null, attempts: 0 });
});

test('the policy exposes the donor RECONNECT vocabulary', () => {
  assert.equal(createReconnectPolicy().RECONNECT, RECONNECT);
});

test('channel recovery needs a reconnect policy', () => {
  assert.throws(
    () => createChannelRecovery({}),
    (error) => {
      assert.ok(error instanceof ComputerUseError);
      assert.equal(error.code, 'CONTRACT_INVALID');
      assert.equal(error.message, 'channel recovery needs a reconnect policy');
      return true;
    },
  );
  assert.throws(() => createChannelRecovery({ policy: {} }), /channel recovery needs a reconnect policy/);
  assert.doesNotThrow(() => createChannelRecovery({ policy: createReconnectPolicy() }));
});

test('recover reattaches through the controller, then proves it with a fresh observation', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, now: () => 0 });
  const events = [];
  const reconnected = [];
  const probed = [];
  const facts = [];
  const recovery = createChannelRecovery({
    policy,
    controllers: {
      browser: {
        probe: async () => { probed.push('probe'); return { available: true }; },
        facts: async () => { facts.push('facts'); return { url: 'about:blank' }; },
      },
    },
    observe: async ({ channel, attempt, action }) => ({ channel, attempt, action }),
    stillValid: () => true,
    onEvent: (event) => events.push(event),
    onReconnected: (channel) => reconnected.push(channel),
  });

  const result = await recovery.recover('browser', { action: { type: 'CLICK' } });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  // Donor defect, preserved: the fresh observation proves the channel and is then
  // dropped, so a successful recovery still reports `world: null`.
  assert.equal(result.world, null);
  assert.deepEqual(probed, ['probe']);
  assert.deepEqual(facts, ['facts']);
  assert.deepEqual(reconnected, ['browser']);
  assert.deepEqual(events, [
    { type: 'channel-reattach', channel: 'browser', attempt: 1 },
    { type: 'reconnect', channel: 'browser', outcome: 'reconnected', attempt: 1, reason: 'browser is usable again with a fresh observation' },
  ]);
  assert.equal(recovery.policy, policy);
  assert.equal(typeof recovery.reattach('browser'), 'function');
});

test('recover fails when no controller implements the channel', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, now: () => 0 });
  const recovery = createChannelRecovery({ policy, controllers: {} });
  const result = await recovery.recover('desktop');
  assert.equal(result.ok, false);
  assert.equal(result.world, null);
  assert.equal(result.outcome.outcome, 'exhausted');
  assert.equal(result.outcome.reason, 'desktop did not come back within 2 bounded attempts (no controller implements the desktop channel)');
  assert.equal(result.error.code, 'RECONNECT_EXHAUSTED');
});

test('a controller that still reports unavailable spends the whole budget', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, now: () => 0 });
  const recovery = createChannelRecovery({
    policy,
    controllers: { vision: { probe: async () => ({ available: false, reason: 'screenshot service is down' }) } },
  });
  const result = await recovery.recover('vision');
  assert.equal(result.ok, false);
  assert.equal(result.outcome.reason, 'vision did not come back within 2 bounded attempts (screenshot service is down)');
});

test('a probe with no reason falls back to the donor sentence', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, maxAttempts: 1, now: () => 0 });
  const recovery = createChannelRecovery({ policy, controllers: { vision: { probe: async () => ({ available: false }) } } });
  const result = await recovery.recover('vision');
  assert.equal(result.outcome.reason, 'vision did not come back within 1 bounded attempts (vision is still unavailable)');
});

test('a reattached channel with an unobservable state is context_invalid', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, now: () => 0 });
  const nullObservation = createChannelRecovery({
    policy,
    controllers: { browser: {} },
    observe: async () => null,
  });
  const invalid = await nullObservation.recover('browser');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.outcome.outcome, 'context_invalid');
  assert.equal(invalid.outcome.reason, 'browser reattached but the state could not be re-observed');
  assert.equal(invalid.error.code, 'RECONNECT_EXHAUSTED');

  const throwing = createChannelRecovery({
    policy: createReconnectPolicy({ sleep: async () => {}, now: () => 0 }),
    controllers: { browser: {} },
    observe: async () => { throw new Error('the page is gone'); },
  });
  const failed = await throwing.recover('browser');
  assert.equal(failed.outcome.outcome, 'context_invalid');
  assert.equal(failed.outcome.reason, 'browser reattached but observing the current state failed: the page is gone');

  const falsy = createChannelRecovery({
    policy: createReconnectPolicy({ sleep: async () => {}, now: () => 0 }),
    controllers: { browser: {} },
    observe: async () => false,
  });
  assert.equal((await falsy.recover('browser')).outcome.outcome, 'context_invalid');
});

test('a contract that is no longer valid after the reconnect is exhausted', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, now: () => 0 });
  const falseVerdict = createChannelRecovery({ policy, controllers: { browser: {} }, stillValid: () => false });
  const invalid = await falseVerdict.recover('browser');
  assert.equal(invalid.outcome.outcome, 'exhausted');
  assert.equal(invalid.outcome.reason, 'the contract is no longer valid after the reconnect');
  assert.equal(invalid.outcome.attempt, 1);

  const throwing = createChannelRecovery({
    policy: createReconnectPolicy({ sleep: async () => {}, now: () => 0 }),
    controllers: { browser: {} },
    stillValid: () => { throw new Error('the contract reader broke'); },
  });
  assert.equal((await throwing.recover('browser')).outcome.outcome, 'exhausted');
});

test('recover without an observer or a validity check still reconnects', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, now: () => 0 });
  const recovery = createChannelRecovery({ policy, controllers: { shell: {} } });
  const result = await recovery.recover('shell');
  assert.equal(result.ok, true);
  assert.equal(result.outcome.reason, 'shell reattached');
  assert.equal(result.world, null);
});

test('recover defaults a missing channel name to "unknown"', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, maxAttempts: 1, now: () => 0 });
  const events = [];
  const recovery = createChannelRecovery({ policy, controllers: {}, onEvent: (event) => events.push(event) });
  const result = await recovery.recover(undefined);
  assert.equal(result.outcome.channel, 'unknown');
  // The `reconnect` event is always emitted, but the `channel-reattach` event is
  // only reached once a controller exists to reattach.
  assert.deepEqual(events, [{
    type: 'reconnect',
    channel: 'unknown',
    outcome: 'exhausted',
    attempt: undefined,
    reason: 'unknown did not come back within 1 bounded attempts (no controller implements the unknown channel)',
  }]);
  assert.equal(result.error.details.channel, 'unknown');
});

test('a controller with no probe or facts is reattached on the host\'s word', async () => {
  const policy = createReconnectPolicy({ sleep: async () => {}, now: () => 0 });
  const events = [];
  const recovery = createChannelRecovery({ policy, controllers: { desktop: {} }, onEvent: (event) => events.push(event) });
  assert.equal((await recovery.recover('desktop')).ok, true);
  assert.deepEqual(events, [
    { type: 'channel-reattach', channel: 'desktop', attempt: 1 },
    { type: 'reconnect', channel: 'desktop', outcome: 'reconnected', attempt: 1, reason: 'desktop reattached' },
  ]);
});

test('channel recovery exposes the donor attribution helpers', () => {
  const recovery = createChannelRecovery({ policy: createReconnectPolicy() });
  assert.equal(recovery.channelOfError, channelOfError);
  assert.equal(recovery.channelHintFor, channelHintFor);
});

test('the default clock and delay are deterministic', async () => {
  const first = createReconnectPolicy();
  const second = createReconnectPolicy();
  const a = await first.reconnect({ channel: 'browser', reattach: async () => true });
  const b = await second.reconnect({ channel: 'browser', reattach: async () => true });
  assert.deepEqual(a, b);
  assert.equal(a.at, 0);
});
