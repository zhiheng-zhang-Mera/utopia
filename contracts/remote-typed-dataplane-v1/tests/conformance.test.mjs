// Conformance tests for RF-008 閳?typed RPC / EVENT / STREAM + reliable commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_STATES, DOMAINS, DataplaneError, ENVELOPE_KINDS, STREAM_STATES, createDataplane,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const AT = ms => new Date(Date.parse(T0) + ms).toISOString();

function planeAt() {
  const state = { ms: 0 };
  const clock = () => AT(state.ms);
  clock.advance = ms => { state.ms += ms; return clock(); };
  return { plane: createDataplane({ clock }), clock };
}

const command = (overrides = {}) => ({
  envelope_kind: 'COMMAND',
  envelope_version: 1,
  command_id: 'command:1',
  attempt_id: 'attempt:1',
  origin_ref: 'device:laptop',
  target_ref: 'device:desktop',
  capability_id: 'camera.capture@1',
  capability_version: 1,
  task_ref: 'task:42',
  action_ref: 'action:42',
  side_effecting: true,
  idempotency_key: 'idem:1',
  deadline_at: AT(60000),
  payload_ref: 'payload:1',
  domain: 'BA',
  domain_envelope_ref: 'ba:envelope:1',
  at: T0,
  ...overrides,
});

const streamSetup = (overrides = {}) => ({
  envelope_kind: 'STREAM_SETUP',
  envelope_version: 1,
  stream_ref: 'stream:1',
  target_ref: 'device:phone',
  capability_id: 'screen.stream@1',
  capability_version: 1,
  stream_kind: 'VIDEO',
  direction: 'RECEIVE',
  window: 2,
  domain: 'GAI',
  domain_envelope_ref: 'gai:envelope:1',
  at: T0,
  ...overrides,
});

const event = (overrides = {}) => ({
  envelope_kind: 'EVENT',
  envelope_version: 1,
  event_id: 'event:1',
  topic: 'capability.changed',
  sequence: 1,
  correlation_ref: 'corr:1',
  domain: 'EM',
  domain_envelope_ref: 'em:envelope:1',
  at: T0,
  ...overrides,
});

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof DataplaneError, `expected a DataplaneError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('RPC, EVENT and STREAM are separate versioned envelopes with opaque domain payloads', () => {
  const { plane } = planeAt();
  assert.deepEqual([...ENVELOPE_KINDS], ['COMMAND', 'EVENT', 'STREAM_SETUP', 'STREAM_DATA', 'STREAM_CONTROL']);
  assert.deepEqual([...DOMAINS], ['BA', 'GAI', 'EM']);

  const accepted = plane.dispatchCommand(command());
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(accepted.envelope_version, 1);
  assert.equal(accepted.domain, 'BA');
  assert.equal(accepted.domain_envelope_ref, 'ba:envelope:1');
  assert.equal(accepted.domain_payload_canonical_source, 'DOMAIN', 'the domain envelope stays canonical');
  assert.equal(accepted.rf_envelope_is_canonical, false, 'an RF envelope never becomes the domain model');
  assert.equal(accepted.task_truth_in_transport, false);
  assert.equal(accepted.owns_task_ownership, false);
  assert.equal(accepted.task_ref, 'task:42', 'task truth is referenced, never duplicated');

  // A payload body is refused: only references travel.
  assert.equal(failure(() => plane.dispatchCommand(command({ command_id: 'c2', payload: { body: 'x' } }))).code, 'INVALID_ENVELOPE');
  assert.equal(failure(() => plane.dispatchCommand(command({ command_id: 'c3', domain: 'RF' }))).code, 'INVALID_ENVELOPE');
  assert.equal(failure(() => plane.dispatchCommand(command({ command_id: 'c4', envelope_version: 2 }))).code, 'INVALID_ENVELOPE');
  assert.equal(failure(() => plane.dispatchCommand(command({ command_id: 'c5', envelope_kind: 'MESSAGE' }))).code, 'INVALID_ENVELOPE');
  assert.equal(failure(() => plane.dispatchCommand(command({ command_id: 'c6', side_effecting: true, idempotency_key: null }))).code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(failure(() => plane.publishEvent(event({ sequence: 5 }))).code, 'EVENT_OUT_OF_ORDER');
  assert.equal(failure(() => plane.openStream(streamSetup({ window: 0 }))).code, 'INVALID_ENVELOPE');
  assert.equal(failure(() => plane.openStream(streamSetup({ stream_kind: 'TELEPATHY' }))).code, 'INVALID_ENVELOPE');

  const separation = plane.separation();
  assert.equal(separation.owns_domain_state, false);
  assert.equal(separation.delivery_ack_is_execution_success, false);
  const rejected = failure(() => plane.dispatchCommand(command({ command_id: 'c7', extra: true })));
  assert.equal(rejected.code, 'INVALID_ENVELOPE');
});

test('a retried idempotent command does not repeat the effect, and a new command id is a new action', () => {
  const { plane } = planeAt();
  plane.dispatchCommand(command());
  plane.acknowledgeDelivery({ command_id: 'command:1' });
  plane.applyResult({ command_id: 'command:1', state: 'SUCCEEDED', result_ref: 'result:1' });

  // A transport retry with a new attempt id reuses the cached result.
  const retry = plane.dispatchCommand(command({ attempt_id: 'attempt:2' }));
  assert.equal(retry.retry, true);
  assert.equal(retry.new_user_action, false, 'a transport retry is not a new user action');
  assert.equal(retry.replayed, true);
  assert.equal(retry.executed, false);
  assert.equal(retry.external_effect_repeated, false);
  assert.equal(retry.replayed_result_ref, 'result:1');
  assert.equal(retry.attempts, 2);
  assert.equal(retry.attempt_id, 'attempt:2');

  // The same attempt id again is a duplicated envelope.
  const duplicate = plane.dispatchCommand(command({ attempt_id: 'attempt:2' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.executed, false);
  assert.equal(duplicate.new_user_action, false);

  // A new command id with identical arguments is a new action and is accepted as such.
  const fresh = plane.dispatchCommand(command({ command_id: 'command:2', attempt_id: 'attempt:1', idempotency_key: 'idem:2' }));
  assert.equal(fresh.new_user_action, true, 'new command ids represent new actions even with matching arguments');
  assert.equal(fresh.duplicate, false);
  assert.equal(fresh.command_id, 'command:2');
  assert.equal(plane.commands().length, 2);

  // Reusing a command id with a different canonical action is refused.
  const reused = failure(() => plane.dispatchCommand(command({ command_id: 'command:1', attempt_id: 'attempt:9', action_ref: 'action:other' })));
  assert.equal(reused.code, 'COMMAND_ID_REUSED_WITH_DIFFERENT_ACTION');

  // A second command sharing an idempotency key is a different command id, so it is a new action.
  const sharedKey = plane.dispatchCommand(command({ command_id: 'command:3', attempt_id: 'attempt:1', idempotency_key: 'idem:1' }));
  assert.equal(sharedKey.new_user_action, true);
  assert.equal(failure(() => plane.applyResult({ command_id: 'command:nope', state: 'SUCCEEDED' })).code, 'UNKNOWN_COMMAND');
});

test('delivery, acceptance, running and completion are observably distinct, and ack is never success', () => {
  const { plane } = planeAt();
  const accepted = plane.dispatchCommand(command({ side_effecting: false, idempotency_key: null }));
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(accepted.delivery_acknowledged, false);
  assert.equal(accepted.delivery_ack_is_execution_success, false);
  assert.equal(accepted.executed, false);

  const queued = plane.acknowledgeDelivery({ command_id: 'command:1' });
  assert.equal(queued.state, 'QUEUED', 'acceptance and delivery are distinct states');
  assert.equal(queued.delivery_acknowledged, true);
  assert.equal(queued.delivery_ack_is_execution_success, false, 'transport 200 is not task success');
  assert.equal(queued.executed, false);

  const running = plane.transitionCommand({ command_id: 'command:1', state: 'RUNNING' });
  assert.equal(running.state, 'RUNNING');
  assert.equal(running.terminal, false);
  const waiting = plane.transitionCommand({ command_id: 'command:1', state: 'WAITING_CONFIRMATION' });
  assert.equal(waiting.state, 'WAITING_CONFIRMATION');

  // A terminal success may only come from an execution result.
  const falseSuccess = failure(() => plane.transitionCommand({ command_id: 'command:1', state: 'SUCCEEDED' }));
  assert.equal(falseSuccess.code, 'FALSE_SUCCESS_REFUSED');
  assert.equal(falseSuccess.delivered, true);
  assert.equal(falseSuccess.executed, false);
  assert.equal(plane.command('command:1').state, 'WAITING_CONFIRMATION', 'the refused transition changed nothing');

  const completed = plane.applyResult({ command_id: 'command:1', state: 'SUCCEEDED', result_ref: 'result:ok' });
  assert.equal(completed.state, 'SUCCEEDED');
  assert.equal(completed.terminal, true);
  assert.equal(completed.execution_result_ref, 'result:ok');
  assert.equal(completed.executed, true);

  // Terminal truth is immutable, and a typed failure is distinct from a refusal.
  assert.equal(failure(() => plane.transitionCommand({ command_id: 'command:1', state: 'RUNNING' })).code, 'TERMINAL_COMMAND');
  assert.equal(plane.applyResult({ command_id: 'command:1', state: 'SUCCEEDED' }).duplicate, true, 'a repeated result is absorbed, not applied twice');
  plane.dispatchCommand(command({ command_id: 'command:5', attempt_id: 'a5', side_effecting: false, idempotency_key: null }));
  const refused = plane.applyResult({ command_id: 'command:5', state: 'REFUSED', error: { code: 'PERMISSION_DENIED', detail: 'no grant' } });
  assert.equal(refused.state, 'REFUSED');
  assert.equal(refused.terminal, true);
  assert.equal(refused.error.code, 'PERMISSION_DENIED');
  assert.equal(refused.error.retryable, false);
  assert.equal(refused.external_effect, false, 'a refusal produced no external effect');
  assert.deepEqual([...COMMAND_STATES], ['ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'REFUSED', 'UNAVAILABLE', 'CANCELLED', 'TIMEOUT', 'UNKNOWN']);
});

test('a deadline stops a stale interactive command from executing later', () => {
  const { plane, clock } = planeAt();
  const stale = failure(() => plane.dispatchCommand(command({ command_id: 'command:late', attempt_id: 'a', deadline_at: T0 })));
  assert.equal(stale.code, 'DEADLINE_EXPIRED');
  assert.equal(stale.executed, false);
  assert.equal(stale.external_effect, false);
  assert.equal(plane.command('command:late'), null, 'nothing was accepted');
  assert.equal(plane.journal().some(entry => entry.event === 'COMMAND_DEADLINE_EXPIRED'), true);

  // A command accepted in time but never answered times out rather than running later.
  plane.dispatchCommand(command({ command_id: 'command:queued', attempt_id: 'a', deadline_at: AT(1000), side_effecting: false, idempotency_key: null }));
  clock.advance(500);
  assert.deepEqual(plane.sweepExpired().timed_out_commands, [], 'not yet expired');
  clock.advance(1000);
  const swept = plane.sweepExpired();
  assert.deepEqual(swept.timed_out_commands, ['command:queued']);
  assert.deepEqual(swept.executed_after_deadline, []);
  const timedOut = plane.command('command:queued');
  assert.equal(timedOut.state, 'TIMEOUT');
  assert.equal(timedOut.error.code, 'DEADLINE_EXPIRED');
  assert.equal(timedOut.terminal, true);
  clock.advance(600000);
  assert.deepEqual(plane.sweepExpired().timed_out_commands, [], 'a terminal command is never swept twice');
  assert.equal(plane.command('command:queued').state, 'TIMEOUT');
});

test('event subscriptions reconnect and replay with ordering, causation and gap reporting', () => {
  const { plane } = planeAt();
  const subscription = plane.subscribe({ subscription_ref: 'sub:1', topic: 'capability.changed', target_ref: 'device:phone', from_sequence: 1 });
  assert.equal(subscription.is_rpc, false);
  assert.equal(subscription.reconnectable, true);
  assert.equal(subscription.resume_from_sequence, 1);

  plane.publishEvent(event({ event_id: 'e1', sequence: 1, caused_by: 'loss:1' }));
  plane.publishEvent(event({ event_id: 'e2', sequence: 2, correlation_ref: 'corr:1' }));
  plane.publishEvent(event({ event_id: 'e3', sequence: 3 }));
  const duplicate = plane.publishEvent(event({ event_id: 'e2', sequence: 2 }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.applied, false, 'a replayed envelope is handled deterministically');
  assert.equal(duplicate.rf_envelope_is_canonical, false);

  const replay = plane.replayFrom({ subscription_ref: 'sub:1' });
  assert.deepEqual(replay.events.map(entry => entry.sequence), [1, 2, 3], 'replay preserves order');
  assert.equal(replay.gap_detected, false);
  assert.equal(replay.next_sequence, 4);
  assert.equal(replay.reconnects, 1);
  assert.equal(replay.events[0].caused_by, 'loss:1', 'causal metadata survives replay');
  assert.equal(replay.events[1].correlation_ref, 'corr:1');

  // A reconnect from an older point replays only the missing tail.
  const tail = plane.replayFrom({ subscription_ref: 'sub:1', from_sequence: 3 });
  assert.deepEqual(tail.events.map(entry => entry.sequence), [3]);
  assert.equal(tail.is_rpc, false);

  // The plane refuses to create a sequence gap in the first place, so a replay never has holes.
  assert.equal(failure(() => plane.publishEvent(event({ event_id: 'e9', sequence: 9 }))).code, 'EVENT_OUT_OF_ORDER');
  const ahead = plane.replayFrom({ subscription_ref: 'sub:1', from_sequence: 99 });
  assert.equal(ahead.replayed_count, 0);
  assert.equal(ahead.gap_detected, false, 'a resume point beyond the head has nothing missing');
  assert.deepEqual(ahead.missing_sequences, []);
  assert.equal(failure(() => plane.replayFrom({ subscription_ref: 'sub:nope' })).code, 'UNKNOWN_SUBSCRIPTION');
  assert.equal(failure(() => plane.subscribe({ subscription_ref: 'sub:2', topic: 't', target_ref: 'd', from_sequence: -1 })).code, 'INVALID_REQUEST');
  assert.deepEqual(plane.events({ topic: 'capability.changed' }).map(entry => entry.sequence), [1, 2, 3]);
  assert.deepEqual(plane.events({ topic: 'other' }), []);
});

test('stream lifecycle, backpressure and cancellation are independent of RPC', () => {
  const { plane } = planeAt();
  plane.dispatchCommand(command({ side_effecting: false, idempotency_key: null }));
  const opened = plane.openStream(streamSetup());
  assert.equal(opened.state, 'OPEN');
  assert.equal(opened.is_rpc, false);
  assert.equal(opened.credit, 2);
  assert.deepEqual([...STREAM_STATES], ['IDLE', 'OPENING', 'OPEN', 'PAUSED', 'CLOSED', 'CANCELLED']);

  const first = plane.sendStreamData({ stream_ref: 'stream:1', sequence: 1, payload_ref: 'frame:1', bytes: 100 });
  assert.equal(first.accepted, true);
  assert.equal(first.credit, 1);
  const second = plane.sendStreamData({ stream_ref: 'stream:1', sequence: 2, payload_ref: 'frame:2', bytes: 120 });
  assert.equal(second.credit, 0);

  // Backpressure pauses the stream instead of dropping or blocking silently.
  const third = plane.sendStreamData({ stream_ref: 'stream:1', sequence: 3, payload_ref: 'frame:3' });
  assert.equal(third.accepted, false);
  assert.equal(third.backpressure, true);
  assert.equal(third.state, 'PAUSED');
  assert.equal(third.reason, 'NO_CREDIT');
  assert.equal(plane.stream('stream:1').state, 'PAUSED');

  const credited = plane.streamCredit({ stream_ref: 'stream:1', credit: 3 });
  assert.equal(credited.credit, 3);
  assert.equal(credited.state, 'OPEN', 'credit resumes a paused stream');
  assert.equal(credited.backpressure, false);
  assert.equal(plane.sendStreamData({ stream_ref: 'stream:1', sequence: 3, payload_ref: 'frame:3' }).accepted, true);
  // A reordered frame is refused while the stream has credit (backpressure is reported first otherwise).
  assert.equal(failure(() => plane.sendStreamData({ stream_ref: 'stream:1', sequence: 9 })).code, 'EVENT_OUT_OF_ORDER');

  // Cancelling the stream leaves the command untouched, and vice versa.
  const cancelled = plane.cancelStream({ stream_ref: 'stream:1', by_ref: 'device:laptop' });
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.is_rpc, false);
  assert.equal(cancelled.affects_commands, false);
  assert.equal(plane.cancelStream({ stream_ref: 'stream:1' }).duplicate, true);
  assert.equal(plane.command('command:1').state, 'ACCEPTED', 'stream cancellation did not touch the command');
  assert.equal(failure(() => plane.closeStream({ stream_ref: 'stream:1' })).code, 'STREAM_NOT_OPEN', 'a cancelled stream cannot be closed again');

  const other = plane.openStream(streamSetup({ stream_ref: 'stream:2', window: 1 }));
  assert.equal(other.stream_ref, 'stream:2');
  assert.equal(plane.stream('stream:2').credit, 1);
  assert.equal(plane.closeStream({ stream_ref: 'stream:2' }).state, 'CLOSED');
  assert.equal(plane.stream('stream:2').frames_sent, 0, 'closing reports the frame count truthfully');
  assert.equal(failure(() => plane.closeStream({ stream_ref: 'stream:2' })).code, 'STREAM_NOT_OPEN');
  assert.equal(failure(() => plane.sendStreamData({ stream_ref: 'stream:nope' })).code, 'UNKNOWN_STREAM');
  assert.equal(failure(() => plane.cancelStream({ stream_ref: 'stream:nope' })).code, 'UNKNOWN_STREAM');
  assert.equal(failure(() => plane.streamCredit({ stream_ref: 'stream:nope', credit: 1 })).code, 'UNKNOWN_STREAM');
  assert.equal(plane.stream('stream:nope'), null, 'an unknown stream is a typed absence');
});

test('the data plane is strict, frozen, and keeps task truth outside the transport session', () => {
  const { plane } = planeAt();
  const accepted = plane.dispatchCommand(command({ side_effecting: false, idempotency_key: null }));
  assert.throws(() => { accepted.state = 'SUCCEEDED'; }, TypeError, 'results are frozen');
  assert.throws(() => { accepted.task_ref = 'task:hijacked'; }, TypeError);

  // Two planes share no state, so a session is not the source of task truth.
  const other = planeAt().plane;
  assert.equal(other.commands().length, 0);
  assert.equal(other.events().length, 0);
  assert.equal(plane.command('command:1').task_ref, 'task:42');
  assert.equal(other.command('command:1'), null);

  assert.equal(failure(() => createDataplane({ clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(plane.policy().policy_ref, 'policy:rf-dataplane-default');
  assert.equal(plane.separation().task_truth_in_transport, false);
  assert.equal(plane.journal().some(entry => entry.event === 'COMMAND_ACCEPTED'), true);
  assert.equal(plane.commands().length, 1);
  assert.equal(plane.envelopeKinds().includes('STREAM_CONTROL'), true);
  assert.equal(failure(() => plane.transitionCommand({ command_id: 'command:nope', state: 'RUNNING' })).status, 404);
  assert.equal(failure(() => plane.transitionCommand({ command_id: 'command:1', state: 'TELEPORTING' })).code, 'INVALID_TRANSITION');
});

// ---------------------------------------------------------------- Alien Correction regressions
// Every test below fails against the Development head and passes against the corrected head.

test('canonical envelopes are decided by own keys on a plain record', () => {
  const { plane } = planeAt();
  for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__']) {
    assert.equal(failure(() => plane.dispatchCommand(command({ command_id: `c:${key}`, [key]: 'smuggled' }))).code, 'INVALID_ENVELOPE', `${key} is not a canonical envelope field`);
  }
  class Smuggled {}
  const instance = Object.assign(new Smuggled(), command({ command_id: 'c:instance' }));
  assert.equal(failure(() => plane.dispatchCommand(instance)).code, 'INVALID_ENVELOPE', 'a canonical envelope is a plain record, not an exotic object');
  assert.deepEqual(plane.commands(), []);
});

test('reference fields are text, so a cyclic object cannot reach the freezer', () => {
  const { plane } = planeAt();
  const cycle = {};
  cycle.self = cycle;
  assert.equal(failure(() => plane.publishEvent(event({ payload_ref: cycle }))).code, 'INVALID_ENVELOPE');
  assert.equal(failure(() => plane.publishEvent(event({ caused_by: cycle }))).code, 'INVALID_ENVELOPE');
  assert.equal(failure(() => plane.dispatchCommand(command({ command_id: 'c:cyc', payload_ref: cycle }))).code, 'INVALID_ENVELOPE');
  assert.equal(failure(() => plane.dispatchCommand(command({ command_id: 'c:cyc2', task_ref: 7 }))).code, 'INVALID_ENVELOPE');
  plane.openStream(streamSetup());
  assert.equal(failure(() => plane.cancelStream({ stream_ref: 'stream:1', by_ref: cycle })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => plane.closeStream({ stream_ref: 'stream:1', reason: cycle })).code, 'INVALID_REQUEST');
  assert.deepEqual(plane.events(), []);
  assert.equal(plane.stream('stream:1').state, 'OPEN', 'the refused cancellation changed nothing');
});

test('an object-valued action reference cannot turn a retry into a different action', () => {
  const { plane } = planeAt();
  assert.equal(failure(() => plane.dispatchCommand(command({ action_ref: { task: 't' } }))).code, 'INVALID_ENVELOPE');
  plane.dispatchCommand(command());
  const retry = plane.dispatchCommand(command({ attempt_id: 'attempt:2' }));
  assert.equal(retry.retry, true);
  assert.equal(retry.new_user_action, false);
  assert.equal(retry.attempts, 2);
});

test('a malformed caller instant is refused as a typed error', () => {
  const { plane } = planeAt();
  plane.dispatchCommand(command({ side_effecting: false, idempotency_key: null }));
  plane.openStream(streamSetup());
  plane.subscribe({ subscription_ref: 'sub:1', topic: 't', target_ref: 'd', from_sequence: 1 });
  for (const at of ['garbage', '2026-01-01', '2026-13-45T99:99:99Z', 123, {}]) {
    assert.equal(failure(() => plane.acknowledgeDelivery({ command_id: 'command:1', at })).code, 'INVALID_REQUEST', `acknowledgeDelivery at=${String(at)}`);
    assert.equal(failure(() => plane.transitionCommand({ command_id: 'command:1', state: 'RUNNING', at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => plane.applyResult({ command_id: 'command:1', state: 'FAILED', at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => plane.sweepExpired({ at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => plane.subscribe({ subscription_ref: 'sub:x', topic: 't', target_ref: 'd', at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => plane.replayFrom({ subscription_ref: 'sub:1', at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => plane.streamCredit({ stream_ref: 'stream:1', credit: 1, at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => plane.sendStreamData({ stream_ref: 'stream:1', sequence: 1, at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => plane.cancelStream({ stream_ref: 'stream:1', at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => plane.closeStream({ stream_ref: 'stream:1', at })).code, 'INVALID_REQUEST');
  }
  assert.equal(plane.command('command:1').state, 'ACCEPTED', 'no refused call mutated a state');
  assert.throws(
    () => createDataplane({ clock: () => '2026-13-45T99:99:99Z' }).sweepExpired(),
    error => error instanceof DataplaneError && error.code === 'INVALID_CLOCK',
    'a shape-valid but impossible clock instant is refused too',
  );
});

test('a deadline is judged at the registry clock and bounded by policy', () => {
  const stale = planeAt();
  stale.clock.advance(600000);
  assert.equal(failure(() => stale.plane.dispatchCommand(command({ command_id: 'c:stale', deadline_at: AT(60000) }))).code, 'DEADLINE_EXPIRED', 'an envelope cannot declare itself fresh');
  assert.equal(stale.plane.command('c:stale'), null, 'nothing was accepted');
  assert.equal(stale.plane.journal().some(entry => entry.event === 'COMMAND_DEADLINE_EXPIRED'), true);

  const { plane } = planeAt();
  assert.equal(failure(() => plane.dispatchCommand(command({ command_id: 'c:far', deadline_at: '2126-01-01T00:00:00Z' }))).code, 'INVALID_ENVELOPE', 'the configured maximum deadline is a real bound');
  assert.equal(plane.dispatchCommand(command({ command_id: 'c:ok', deadline_at: AT(300000) })).state, 'ACCEPTED');
  for (const policy of [{ max_deadline_ms: Infinity }, { max_stream_window: 0 }, { default_stream_window: 900, max_stream_window: 8 }, 'nonsense']) {
    assert.equal(failure(() => createDataplane({ clock: () => T0, policy })).code, 'INVALID_REQUEST', `policy ${JSON.stringify(policy)}`);
  }
});

test('a sweep cannot expire a command before its deadline by naming a later instant', () => {
  const { plane } = planeAt();
  plane.dispatchCommand(command({ command_id: 'c:future', deadline_at: AT(200000), side_effecting: false, idempotency_key: null }));
  assert.deepEqual(plane.sweepExpired({ at: AT(900000) }).timed_out_commands, [], 'the registry clock decides expiry');
  assert.equal(plane.command('c:future').state, 'ACCEPTED');
});

test('a contiguous replay never reports a phantom gap, and its resume point is validated', () => {
  const { plane } = planeAt();
  plane.subscribe({ subscription_ref: 'sub:default', topic: 't', target_ref: 'd' });
  plane.publishEvent(event({ event_id: 'e1', sequence: 1, topic: 't' }));
  plane.publishEvent(event({ event_id: 'e2', sequence: 2, topic: 't' }));
  const replay = plane.replayFrom({ subscription_ref: 'sub:default' });
  assert.deepEqual(replay.events.map(entry => entry.sequence), [1, 2]);
  assert.equal(replay.gap_detected, false, 'event sequences start at 1, so resume 0 is not a gap');
  assert.deepEqual(replay.missing_sequences, []);
  assert.equal(replay.next_sequence, 3);
  for (const from_sequence of [-5, 2.5, NaN, '2']) {
    assert.equal(failure(() => plane.replayFrom({ subscription_ref: 'sub:default', from_sequence })).code, 'INVALID_REQUEST', `from_sequence ${String(from_sequence)}`);
  }
});

test('an execution result must be terminal and must carry a real result reference', () => {
  const { plane } = planeAt();
  plane.dispatchCommand(command({ command_id: 'c:run', side_effecting: false, idempotency_key: null }));
  for (const state of ['ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'UNKNOWN']) {
    assert.equal(failure(() => plane.applyResult({ command_id: 'c:run', state })).code, 'INVALID_TRANSITION', `${state} is not an execution result`);
  }
  assert.equal(failure(() => plane.applyResult({ command_id: 'c:run', state: 'SUCCEEDED' })).code, 'FALSE_SUCCESS_REFUSED', 'a success reference is never synthesized');
  assert.equal(plane.command('c:run').state, 'ACCEPTED', 'no refused result mutated the command');
  assert.equal(plane.command('c:run').execution_result_ref, null);
  const failed = plane.applyResult({ command_id: 'c:run', state: 'FAILED', result_ref: 'result:diag', error: { code: 'X' } });
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.execution_result_ref, 'result:diag', 'a failure keeps its evidence reference too');
});

test('a retry may only replay the result its own command produced', () => {
  const { plane } = planeAt();
  plane.dispatchCommand(command({ command_id: 'command:1', idempotency_key: 'shared' }));
  plane.transitionCommand({ command_id: 'command:1', state: 'RUNNING' });
  assert.equal(plane.dispatchCommand(command({ command_id: 'command:2', idempotency_key: 'shared' })).new_user_action, true, 'a new command id is still a new action');
  plane.applyResult({ command_id: 'command:2', state: 'SUCCEEDED', result_ref: 'result:2' });

  const retry = plane.dispatchCommand(command({ command_id: 'command:1', idempotency_key: 'shared', attempt_id: 'attempt:2' }));
  assert.equal(retry.retry, true);
  assert.equal(retry.replayed, false, "another command's result is not this command's result");
  assert.equal(retry.state, 'RUNNING', 'the retry must not report a success this command never had');
  assert.equal(plane.command('command:1').execution_result_ref, null);

  plane.applyResult({ command_id: 'command:1', state: 'SUCCEEDED', result_ref: 'result:1' });
  const own = plane.dispatchCommand(command({ command_id: 'command:1', idempotency_key: 'shared', attempt_id: 'attempt:3' }));
  assert.equal(own.replayed, true);
  assert.equal(own.replayed_result_ref, 'result:1');
  assert.equal(own.replayed_from_command_id, 'command:1');
});

test('a reused command id may not silently change the subject it addresses', () => {
  const { plane } = planeAt();
  plane.dispatchCommand(command());
  const spoof = failure(() => plane.dispatchCommand(command({ target_ref: 'device:door-B', capability_id: 'door.open@9', attempt_id: 'attempt:2' })));
  assert.equal(spoof.code, 'COMMAND_ID_REUSED_WITH_DIFFERENT_ACTION');
  assert.equal(spoof.diverged_fields.includes('target_ref'), true);
  assert.equal(spoof.diverged_fields.includes('capability_id'), true);
  assert.equal(plane.command('command:1').target_ref, 'device:desktop', 'the stored subject is unchanged');
  assert.equal(plane.command('command:1').attempts, 1, 'the refused retry did not count as an attempt');
  assert.equal(failure(() => plane.dispatchCommand(command({ origin_ref: 'device:attacker', attempt_id: 'attempt:3' }))).code, 'COMMAND_ID_REUSED_WITH_DIFFERENT_ACTION');
});

test('stream accounting cannot run backwards or exceed the configured window', () => {
  const { plane } = planeAt();
  plane.openStream(streamSetup());
  assert.equal(failure(() => plane.sendStreamData({ stream_ref: 'stream:1', sequence: 1, bytes: -5000 })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => plane.sendStreamData({ stream_ref: 'stream:1', sequence: 1, bytes: 1.5 })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => plane.sendStreamData({ stream_ref: 'stream:1', sequence: 1, bytes: NaN })).code, 'INVALID_REQUEST');
  assert.equal(plane.sendStreamData({ stream_ref: 'stream:1', sequence: 1, bytes: 100 }).bytes, 100);
  assert.equal(failure(() => plane.sendStreamData({ stream_ref: 'stream:1', sequence: 2, payload_ref: {} })).code, 'INVALID_REQUEST');

  const bounded = planeAt().plane;
  bounded.openStream(streamSetup({ stream_ref: 's:bounded' }));
  assert.equal(failure(() => bounded.streamCredit({ stream_ref: 's:bounded', credit: 9007199254740991 })).code, 'BACKPRESSURE', 'replenishment is still bounded by the configured window');
  assert.equal(bounded.streamCredit({ stream_ref: 's:bounded', credit: 3 }).credit, 5, 'the window opened with 2 credits and 3 were granted');
});

test('a replayed setup envelope cannot clobber live state', () => {
  const { plane } = planeAt();
  plane.openStream(streamSetup());
  plane.sendStreamData({ stream_ref: 'stream:1', sequence: 1, bytes: 100 });
  assert.equal(failure(() => plane.openStream(streamSetup())).code, 'DUPLICATE_ENVELOPE');
  assert.equal(failure(() => plane.openStream(streamSetup({ stream_kind: 'SENSOR', direction: 'SEND' }))).code, 'DUPLICATE_ENVELOPE');
  assert.equal(plane.stream('stream:1').frames_sent, 1, 'the live stream survived the replay');
  plane.cancelStream({ stream_ref: 'stream:1' });
  assert.equal(failure(() => plane.openStream(streamSetup())).code, 'DUPLICATE_ENVELOPE', 'a cancelled stream is not resurrected');

  plane.subscribe({ subscription_ref: 'sub:1', topic: 't', target_ref: 'd', from_sequence: 1 });
  plane.publishEvent(event({ event_id: 'e1', sequence: 1, topic: 't' }));
  assert.equal(plane.replayFrom({ subscription_ref: 'sub:1' }).reconnects, 1);
  assert.equal(failure(() => plane.subscribe({ subscription_ref: 'sub:1', topic: 't', target_ref: 'other' })).code, 'DUPLICATE_ENVELOPE');
  const replay = plane.replayFrom({ subscription_ref: 'sub:1' });
  assert.equal(replay.reconnects, 2, 'replay state was not reset by the refused re-subscribe');
  assert.deepEqual(replay.events, [], 'already-acknowledged events are not replayed again');
});

test('data and control paths declare their arguments instead of swallowing envelope tags', () => {
  const { plane } = planeAt();
  plane.openStream(streamSetup());
  assert.equal(failure(() => plane.sendStreamData({ stream_ref: 'stream:1', sequence: 1, envelope_kind: 'STREAM_DATA', envelope_version: 99 })).code, 'INVALID_REQUEST', 'a mismatched declared version cannot travel with a frame');
  assert.equal(failure(() => plane.streamCredit({ stream_ref: 'stream:1', credit: 1, envelope_version: 2 })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => plane.sweepExpired({ envelope_kind: 'STREAM_CONTROL' })).code, 'INVALID_REQUEST');
  assert.equal(plane.sendStreamData({ stream_ref: 'stream:1', sequence: 1 }).accepted, true, 'the declared arguments still work');
});
