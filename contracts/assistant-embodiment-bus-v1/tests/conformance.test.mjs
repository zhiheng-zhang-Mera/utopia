// Conformance tests for BA-008 閳?embodiment event bus, execution leases and reconnect safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIENCES, CANONICAL_STATE_SOURCE, EmbodimentError, EVENT_KINDS, LEASE_STATES, PRIVACY_SCOPES,
  createEmbodimentBus,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const AT = ms => new Date(Date.parse(T0) + ms).toISOString();
const ASSISTANT = 'assistant:butler-a';

function busAt() {
  const state = { ms: 0 };
  const clock = () => AT(state.ms);
  clock.advance = ms => { state.ms += ms; return clock(); };
  return { bus: createEmbodimentBus({ clock }), clock };
}

const eventFor = (overrides = {}) => ({
  event_id: 'event:manual-1',
  assistant_ref: ASSISTANT,
  kind: 'INPUT',
  direction: 'INBOUND',
  source_device_ref: 'device:alpha',
  audience: 'ASSISTANT',
  privacy: 'SHARED',
  correlation_ref: 'corr:1',
  at: T0,
  ...overrides,
});

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof EmbodimentError, `expected an EmbodimentError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

const acquire = (bus, overrides = {}) => bus.acquireLease({
  assistant_ref: ASSISTANT,
  device_ref: 'device:alpha',
  holder_ref: 'assistant:butler-a',
  action_scope: 'action:camera-capture',
  task_ref: 'task:1',
  task_version: 1,
  action_key: 'action-key-1',
  ...overrides,
});

test('embodiment events are the canonical Assistant model and transport stays non-canonical', () => {
  const { bus } = busAt();
  const published = bus.publish(eventFor({ transport_ref: 'rf:path:9', payload_ref: 'blob:1' }));
  assert.equal(published.bus_seq, 1);
  assert.equal(published.canonical_state_source, CANONICAL_STATE_SOURCE);
  assert.equal(published.transport_envelope_is_canonical, false, 'an RF envelope never becomes the Assistant event');
  assert.equal(published.assistant_event_is_transport_envelope, false);
  assert.equal(published.applied, true);
  assert.equal(published.duplicate, false);
  assert.equal(published.external_side_effect, false, 'publishing an event is not a side effect');
  const second = bus.publish(eventFor({ event_id: 'event:manual-2', correlation_ref: 'corr:2', command_ref: 'command:1', kind: 'INPUT' }));
  assert.equal(second.bus_seq, 2, 'the bus sequences events');
  assert.throws(() => { published.bus_seq = 9; }, TypeError, 'events are frozen');
  assert.deepEqual([...EVENT_KINDS], ['INPUT', 'OUTPUT', 'LEASE', 'RECONCILE', 'LIFECYCLE']);
  assert.deepEqual([...AUDIENCES], ['USER', 'ASSISTANT', 'DEVICE', 'WORKSPACE', 'PUBLIC']);
  assert.deepEqual([...PRIVACY_SCOPES], ['PRIVATE', 'SHARED']);

  // Strict envelopes.
  assert.equal(failure(() => bus.publish(eventFor({ event_id: 'x', extra: true }))).code, 'INVALID_EVENT');
  assert.equal(failure(() => bus.publish(eventFor({ event_id: 'x', audience: 'EVERYONE' }))).code, 'INVALID_EVENT');
  assert.equal(failure(() => bus.publish(eventFor({ event_id: 'x', at: 'yesterday' }))).code, 'INVALID_EVENT');
  assert.equal(failure(() => bus.publish({})).code, 'INVALID_EVENT');
  assert.equal(bus.events().length, 2);
});

test('contradictory commands from two devices cannot produce two exclusive side effects', () => {
  const { bus } = busAt();
  const first = acquire(bus);
  assert.equal(first.state, 'ACTIVE');
  assert.equal(first.valid_exclusive_leases, 1);
  assert.equal(first.authority_is_local, false);

  // The second device cannot take the same action scope, and the refusal names the holder.
  const conflict = failure(() => acquire(bus, { device_ref: 'device:beta', holder_ref: 'assistant:butler-b', action_key: 'action-key-2' }));
  assert.equal(conflict.code, 'EXCLUSIVE_LEASE_HELD');
  assert.equal(conflict.held_by_device_ref, 'device:alpha');
  assert.equal(conflict.valid_exclusive_leases, 1);
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:camera-capture' }), 1);

  // The loser cannot commit a side effect at all 閳?it has no lease, and then a lease it does not hold.
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: first.lease_ref, holder_ref: 'assistant:butler-b', action_key: 'action-key-2' })).code, 'NOT_LEASE_HOLDER');
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: 'lease:nope#1', holder_ref: 'assistant:butler-b', action_key: 'action-key-2' })).code, 'UNKNOWN_LEASE');

  // The holder commits exactly one external effect.
  const committed = bus.commitSideEffect({ lease_ref: first.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'action-key-1' });
  assert.equal(committed.executed, true);
  assert.equal(committed.external_side_effect, true);
  assert.equal(committed.duplicate_external_side_effects, 0);
  assert.equal(committed.authority_is_local, false);

  // A different action scope is a different lease and is allowed.
  const other = acquire(bus, { action_scope: 'action:screen-stream', action_key: 'action-key-3' });
  assert.equal(other.state, 'ACTIVE');
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:screen-stream' }), 1);
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:camera-capture' }), 1);
});

test('retries and replays with the same action key never duplicate the external side effect', () => {
  const { bus } = busAt();
  const lease = acquire(bus);
  const first = bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'action-key-1' });
  const retry = bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'action-key-1' });
  assert.equal(first.executed, true);
  assert.equal(retry.executed, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.external_side_effect, false);
  assert.equal(retry.duplicate_external_side_effects, 0);
  assert.equal(bus.journal().filter(entry => entry.event === 'SIDE_EFFECT_COMMITTED').length, 1, 'exactly one external effect happened');
  assert.equal(bus.journal().filter(entry => entry.event === 'SIDE_EFFECT_DUPLICATE_SUPPRESSED').length, 1);

  // A missing action key is refused rather than treated as "no retry protection needed".
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a' })).code, 'ACTION_KEY_REQUIRED');
  assert.equal(failure(() => acquire(bus, { action_scope: 'action:other', action_key: null })).code, 'ACTION_KEY_REQUIRED');

  // Replaying the same device command is absorbed; the same command with a different key is refused.
  const firstPublish = bus.publish(eventFor({ event_id: 'e1', command_ref: 'command:1', action_key: 'k1' }));
  const replay = bus.publish(eventFor({ event_id: 'e2', command_ref: 'command:1', action_key: 'k1' }));
  assert.equal(firstPublish.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.idempotent, true);
  assert.equal(failure(() => bus.publish(eventFor({ event_id: 'e3', command_ref: 'command:1', action_key: 'k2' }))).code, 'DUPLICATE_ACTION_KEY');

  // An event that carries an older authoritative task version is stale and rejected.
  bus.noteAuthoritativeTaskVersion({ task_ref: 'task:1', task_version: 5 });
  const stale = failure(() => bus.publish(eventFor({ event_id: 'e4', command_ref: 'command:2', task_ref: 'task:1', task_version: 3 })));
  assert.equal(stale.code, 'STALE_EVENT');
  assert.equal(stale.authoritative_task_version, 5);
  assert.equal(failure(() => bus.noteAuthoritativeTaskVersion({ task_ref: 'task:1', task_version: 4 })).code, 'STALE_EVENT');
  const current = bus.publish(eventFor({ event_id: 'e5', command_ref: 'c3', task_ref: 'task:1', task_version: 5 }));
  assert.equal(current.applied, true, 'the current version is accepted');
});

test('lease expiry, revocation and reassignment are authoritative and observable', () => {
  const { bus, clock } = busAt();
  const lease = acquire(bus, { ttl_ms: 1000 });
  assert.equal(lease.lease_version, 1);

  // Expiry: the lease stops being authority and stops blocking the scope.
  clock.advance(2000);
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'EXPIRED');
  const expiredCommit = failure(() => bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'k' }));
  assert.equal(expiredCommit.code, 'LEASE_EXPIRED');
  assert.equal(expiredCommit.external_side_effect, undefined);
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:camera-capture' }), 0, 'an expired lease holds nothing');
  assert.equal(failure(() => bus.renewLease({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', ttl_ms: 1000 })).code, 'LEASE_EXPIRED');
  const takeover = acquire(bus, { device_ref: 'device:beta', holder_ref: 'assistant:butler-b', action_key: 'k2', at: AT(2000) });
  assert.equal(takeover.state, 'ACTIVE');
  assert.equal(takeover.lease_version, 2, 'authority moved on after expiry');

  // Revocation is observable through a lease event, and idempotent.
  const revoked = bus.revokeLease({ lease_ref: takeover.lease_ref, reason: 'USER_REVOKED', by_ref: 'user:owner' });
  assert.equal(revoked.state, 'REVOKED');
  assert.equal(revoked.observable, true);
  assert.equal(revoked.already_revoked, false);
  assert.equal(bus.events().some(event => event.kind === 'LEASE' && event.lease_ref === takeover.lease_ref), true, 'lease changes are observable as events');
  assert.equal(bus.revokeLease({ lease_ref: takeover.lease_ref }).already_revoked, true);
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: takeover.lease_ref, holder_ref: 'assistant:butler-b', action_key: 'k9' })).code, 'LEASE_REVOKED');

  // Renewal bumps the lease version and only the holder may renew.
  const renewed = acquire(bus, { device_ref: 'device:alpha', holder_ref: 'assistant:butler-a', action_key: 'k3', at: AT(2500) });
  assert.equal(failure(() => bus.renewLease({ lease_ref: renewed.lease_ref, holder_ref: 'assistant:butler-b', ttl_ms: 5000 })).code, 'NOT_LEASE_HOLDER');
  const extended = bus.renewLease({ lease_ref: renewed.lease_ref, holder_ref: 'assistant:butler-a', ttl_ms: 120000, at: AT(2600) });
  assert.equal(extended.lease_version, renewed.lease_version + 1);
  assert.equal(extended.state, 'ACTIVE');
  assert.equal(Date.parse(extended.expires_at) > Date.parse(renewed.expires_at), true);

  // Reassignment is optimistic and supersedes the old lease.
  const conflict = failure(() => bus.reassignLease({ lease_ref: extended.lease_ref, to_device_ref: 'device:gamma', to_holder_ref: 'assistant:butler-c', expect_lease_version: 99 }));
  assert.equal(conflict.code, 'LEASE_VERSION_CONFLICT');
  assert.equal(conflict.current_lease_version, extended.lease_version);
  const reassigned = bus.reassignLease({ lease_ref: extended.lease_ref, to_device_ref: 'device:gamma', to_holder_ref: 'assistant:butler-c', expect_lease_version: extended.lease_version, at: AT(2700) });
  assert.equal(reassigned.reassigned, true);
  assert.equal(reassigned.superseded_lease_ref, extended.lease_ref);
  assert.equal(reassigned.holder_ref, 'assistant:butler-c');
  assert.equal(bus.leaseState({ lease_ref: extended.lease_ref }).state, 'SUPERSEDED');
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: extended.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'k4' })).code, 'LEASE_SUPERSEDED');
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:camera-capture' }), 1, 'still exactly one valid exclusive lease');
  assert.deepEqual([...LEASE_STATES], ['ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'SUPERSEDED']);
});

test('after a disconnect nothing resumes on a stale local lease', () => {
  const { bus } = busAt();
  const lease = acquire(bus);
  const disconnected = bus.onDisconnect({ device_ref: 'device:alpha', reason: 'NETWORK_LOST' });
  assert.deepEqual(disconnected.suspended_lease_refs, [lease.lease_ref]);
  assert.equal(disconnected.resumed_work, false);
  assert.equal(disconnected.side_effects_resumed, false);
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'SUSPENDED');

  // A suspended lease is not authority, and a disconnected device may not even publish.
  const suspended = failure(() => bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'after-disconnect' }));
  assert.equal(suspended.code, 'REVALIDATION_REQUIRED');
  assert.equal(suspended.lease_state, 'SUSPENDED');
  assert.equal(failure(() => bus.publish(eventFor({ event_id: 'e' }))).code, 'REVALIDATION_REQUIRED');
  assert.equal(failure(() => acquire(bus, { action_scope: 'action:other' })).code, 'REVALIDATION_REQUIRED');

  // Reconciliation consults authoritative state and drops work whose lease was not revalidated.
  const reconciled = bus.reconcile({
    device_ref: 'device:alpha',
    authoritative: { assistant_ref: ASSISTANT, task_versions: { 'task:1': 1 }, lease_refs: [lease.lease_ref] },
    local_intents: [
      { intent_ref: 'intent:resume-capture', task_ref: 'task:1', task_version: 1, lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', requires_side_effect: true },
      { intent_ref: 'intent:stale-work', task_ref: 'task:1', task_version: 0, lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', requires_side_effect: true },
      { intent_ref: 'intent:no-lease', task_ref: 'task:1', task_version: 1, lease_ref: null, holder_ref: 'assistant:butler-a', requires_side_effect: true },
      { intent_ref: 'intent:read-only', task_ref: 'task:1', task_version: 1, requires_side_effect: false },
    ],
  });
  assert.deepEqual(reconciled.revalidated_lease_refs, [lease.lease_ref]);
  assert.deepEqual(reconciled.resumed_intents.map(entry => entry.intent_ref), ['intent:resume-capture', 'intent:read-only']);
  assert.deepEqual(reconciled.dropped_intents.map(entry => [entry.intent_ref, entry.reason]), [
    ['intent:stale-work', 'STALE_LOCAL_TASK_VERSION'],
    ['intent:no-lease', 'LEASE_NOT_REVALIDATED'],
  ]);
  assert.equal(reconciled.stale_local_work_resumed, false);
  assert.equal(reconciled.authoritative_state_consulted, true);
  assert.equal(reconciled.ready_to_resume, false, 'dropped work means the device is not fully ready');
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'ACTIVE', 'the revalidated lease is authority again');
  assert.equal(bus.deviceState('device:alpha').connected, true);
  assert.equal(bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'post-reconcile' }).executed, true);

  // Authoritative state that no longer lists the lease revokes it instead of resurrecting it.
  bus.onDisconnect({ device_ref: 'device:alpha' });
  const revoked = bus.reconcile({ device_ref: 'device:alpha', authoritative: { assistant_ref: ASSISTANT, task_versions: {}, lease_refs: [] }, local_intents: [] });
  assert.deepEqual(revoked.invalidated_lease_refs, [lease.lease_ref], 'a lease authoritative state no longer lists is revoked, never resumed');
  assert.deepEqual(revoked.revalidated_lease_refs, []);
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'REVOKED');
  const second = acquire(bus, { action_scope: 'action:other', action_key: 'k-other' });
  bus.onDisconnect({ device_ref: 'device:alpha' });
  const invalidated = bus.reconcile({ device_ref: 'device:alpha', authoritative: { assistant_ref: ASSISTANT, task_versions: {}, lease_refs: [] }, local_intents: [] });
  assert.deepEqual(invalidated.invalidated_lease_refs, [second.lease_ref]);
  assert.equal(bus.leaseState({ lease_ref: second.lease_ref }).state, 'REVOKED');
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: second.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'x' })).code, 'LEASE_REVOKED');
});

test('output routing respects availability, foreground and privacy without broadcasting', () => {
  const { bus } = busAt();
  const candidates = [
    { device_ref: 'device:alpha', available: true, in_audience: true },
    { device_ref: 'device:beta', available: true, in_audience: false },
    { device_ref: 'device:gamma', available: false, in_audience: true },
    { device_ref: 'device:alpha', available: true, in_audience: true },
  ];
  const privateResponse = bus.routeOutput({ assistant_ref: ASSISTANT, audience: 'USER', privacy: 'PRIVATE', candidates });
  assert.deepEqual(privateResponse.deliveries.map(delivery => delivery.device_ref), ['device:alpha'], 'a private response reaches only its audience');
  assert.equal(privateResponse.broadcast, false);
  assert.equal(privateResponse.private_response_broadcast, false);
  assert.deepEqual(privateResponse.withheld.map(entry => [entry.device_ref, entry.reason]), [
    ['device:beta', 'NOT_IN_AUDIENCE'],
    ['device:gamma', 'DEVICE_UNAVAILABLE'],
    ['device:alpha', 'DUPLICATE_SUPPRESSED'],
  ]);
  assert.equal(bus.journal().some(entry => entry.event === 'OUTPUT_WITHHELD_PRIVATE'), true);

  // A foreground device is preferred, but it does not override privacy.
  const withForeground = bus.routeOutput({ assistant_ref: ASSISTANT, audience: 'USER', privacy: 'PRIVATE', foreground_device_ref: 'device:beta', candidates: [{ device_ref: 'device:beta', available: true, in_audience: false }, { device_ref: 'device:alpha', available: true, in_audience: true }] });
  assert.deepEqual(withForeground.deliveries.map(delivery => delivery.device_ref), ['device:alpha']);
  assert.deepEqual(withForeground.withheld.map(entry => [entry.device_ref, entry.reason]), [['device:beta', 'PRIVACY_WITHHELD']]);

  // A shared response goes to its audience; a foreground device outside the audience is still withheld.
  const shared = bus.routeOutput({ assistant_ref: ASSISTANT, audience: 'WORKSPACE', privacy: 'SHARED', foreground_device_ref: 'device:beta', candidates });
  assert.deepEqual(shared.deliveries.map(delivery => [delivery.device_ref, delivery.reason]), [['device:alpha', 'AUDIENCE_MATCH']], 'audience membership gates delivery, and foreground is only a preference among permitted devices');
  assert.deepEqual(shared.withheld.map(entry => [entry.device_ref, entry.reason]), [
    ['device:beta', 'NOT_IN_AUDIENCE'],
    ['device:gamma', 'DEVICE_UNAVAILABLE'],
    ['device:alpha', 'DUPLICATE_SUPPRESSED'],
  ]);
  const sharedForeground = bus.routeOutput({
    assistant_ref: ASSISTANT,
    audience: 'WORKSPACE',
    privacy: 'SHARED',
    foreground_device_ref: 'device:beta',
    candidates: [{ device_ref: 'device:beta', available: true, in_audience: true }, { device_ref: 'device:alpha', available: true, in_audience: true }],
  });
  assert.deepEqual(sharedForeground.deliveries.map(delivery => [delivery.device_ref, delivery.reason]), [['device:beta', 'FOREGROUND'], ['device:alpha', 'AUDIENCE_MATCH']]);
  assert.equal(shared.duplicate_side_effects, 0);
  assert.equal(shared.canonical_state_source, CANONICAL_STATE_SOURCE);
  assert.equal(failure(() => bus.routeOutput({ assistant_ref: ASSISTANT, audience: 'NOPE', privacy: 'SHARED' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bus.routeOutput({ assistant_ref: ASSISTANT, audience: 'USER', privacy: 'PRIVATE', candidates: 'x' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bus.routeOutput({ assistant_ref: ASSISTANT, audience: 'USER', privacy: 'PRIVATE', candidates: [], payload_ref: 5 })).code, 'INVALID_REQUEST');
});

test('the bus is strict, frozen and free of ambient state', () => {
  const { bus } = busAt();
  const lease = acquire(bus);
  assert.throws(() => { lease.state = 'REVOKED'; }, TypeError, 'lease projections are frozen');
  assert.equal(failure(() => createEmbodimentBus({ clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(failure(() => acquire(bus, { action_scope: '' })).code, 'INVALID_LEASE');
  assert.equal(failure(() => acquire(bus, { action_scope: 'action:big', ttl_ms: 99999999 })).code, 'INVALID_LEASE');
  assert.equal(failure(() => bus.leaseState({ lease_ref: 'lease:nope#1' })).status, 404);
  assert.equal(bus.currentLeaseFor({ action_scope: 'action:none' }), null, 'an unheld scope is a typed absence');
  assert.equal(bus.deviceState('device:never-seen'), null);

  const other = busAt();
  other.bus.publish(eventFor({ event_id: 'e' }));
  assert.equal(other.bus.events().length, 1);
  assert.equal(bus.events().length, 1, 'buses share no state');
  assert.equal(other.bus.currentLeaseFor({ action_scope: 'action:camera-capture' }), null);
  assert.equal(bus.policy().policy_ref, 'policy:ba-embodiment-default');
  assert.equal(bus.journal().some(entry => entry.event === 'LEASE_ACQUIRED'), true);
  assert.equal(bus.leases().length, 1);
  assert.equal(bus.leases()[0].lease_ref, lease.lease_ref);
});
