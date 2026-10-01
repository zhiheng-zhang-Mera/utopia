// Conformance tests for BA-008 閳?embodiment event bus, execution leases and reconnect safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIENCES, CANONICAL_STATE_SOURCE, EmbodimentError, EVENT_KINDS, LEASE_STATES, PRIVACY_SCOPES,
  createEmbodimentBus, isIsoInstant,
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

// ---------------------------------------------------------------- Alien Correction regressions
// Every test below fails against the Development head and passes against the corrected head.

test('the canonical contract allow-list is decided by own keys', () => {
  const { bus } = busAt();
  for (const key of ['toString', 'constructor', 'valueOf', '__proto__']) {
    const error = failure(() => bus.publish({ ...eventFor(), [key]: 'smuggled' }));
    assert.equal(error.name, 'EmbodimentError', `${key} is not part of the canonical contract`);
  }
  assert.equal(bus.events().length, 0, 'nothing was admitted');
});

test('a caller instant must be real, not merely well shaped', () => {
  const { bus } = busAt();
  for (const at of ['garbage', '2026-13-45T99:99:99Z', '2026-02-30T00:00:00Z', 123]) {
    assert.equal(failure(() => bus.publish({ ...eventFor(), at })).name, 'EmbodimentError', `publish at=${String(at)}`);
    assert.equal(failure(() => bus.noteAuthoritativeTaskVersion({ task_ref: 'task:1', task_version: 1, at })).name, 'EmbodimentError', `noteAuthoritativeTaskVersion at=${String(at)}`);
  }
  const badClock = createEmbodimentBus({ clock: () => '2026-13-45T99:99:99Z' });
  assert.equal(failure(() => badClock.leases()).name, 'EmbodimentError', 'a shape-valid but impossible clock instant is refused too');
});

test('the bus policy bounds are validated rather than trusted', () => {
  for (const policy of [
    { max_lease_ttl_ms: NaN }, { max_lease_ttl_ms: Infinity }, { default_lease_ttl_ms: 1200000 },
    { require_action_key_for_exclusive: 'yes' }, { require_action_key_for_exclusive: 1 }, 'nonsense',
  ]) {
    assert.equal(failure(() => createEmbodimentBus({ clock: () => T0, policy })).name, 'EmbodimentError', `policy ${JSON.stringify(policy)}`);
  }
  const bus = createEmbodimentBus({ clock: () => T0, policy: { default_lease_ttl_ms: 500, max_lease_ttl_ms: 1000 } });
  assert.equal(bus.policy().max_lease_ttl_ms, 1000, 'a bounded policy still works');
});

test('a reconnecting device never revives a lease another holder has taken over', () => {
  const { bus } = busAt();
  const first = acquire(bus);
  bus.onDisconnect({ device_ref: 'device:alpha' });
  const takeover = acquire(bus, { device_ref: 'device:beta', holder_ref: 'assistant:butler-b', action_key: 'k-takeover' });
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:camera-capture' }), 1);

  // Authoritative state still lists the suspended lease, but the scope belongs to a newer holder.
  const reconciled = bus.reconcile({
    device_ref: 'device:alpha',
    authoritative: { assistant_ref: ASSISTANT, task_versions: { 'task:1': 1 }, lease_refs: [first.lease_ref] },
    local_intents: [{ intent_ref: 'intent:resume', task_ref: 'task:1', task_version: 1, lease_ref: first.lease_ref, holder_ref: 'assistant:butler-a', requires_side_effect: true }],
  });
  assert.deepEqual(reconciled.revalidated_lease_refs, [], 'a superseded lease is never revalidated');
  assert.deepEqual(reconciled.invalidated_lease_refs, [first.lease_ref]);
  assert.equal(bus.leaseState({ lease_ref: first.lease_ref }).state, 'REVOKED');
  assert.equal(bus.leaseState({ lease_ref: takeover.lease_ref }).state, 'ACTIVE', 'the takeover keeps the scope');
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:camera-capture' }), 1, 'still exactly one valid exclusive lease');
  assert.deepEqual(reconciled.dropped_intents.map(entry => [entry.intent_ref, entry.reason]), [['intent:resume', 'LEASE_NOT_REVALIDATED']]);
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: first.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'split-brain' })).code, 'LEASE_REVOKED');
  assert.equal(bus.journal().filter(entry => entry.event === 'SIDE_EFFECT_COMMITTED').length, 0, 'no side effect came out of the reconnect');
});

test('an action key stays the same action across renewal and reassignment', () => {
  const { bus } = busAt();
  const lease = acquire(bus);
  assert.equal(bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'AK' }).executed, true);
  const renewed = bus.renewLease({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', ttl_ms: 5000 });
  const retry = bus.commitSideEffect({ lease_ref: renewed.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'AK' });
  assert.equal(retry.executed, false, 'renewal mints a reference, not a new action');
  assert.equal(retry.duplicate, true);
  assert.equal(retry.external_side_effect, false);
  const reassigned = bus.reassignLease({ lease_ref: renewed.lease_ref, to_device_ref: 'device:gamma', to_holder_ref: 'assistant:butler-c' });
  const afterHandoff = bus.commitSideEffect({ lease_ref: reassigned.lease_ref, holder_ref: 'assistant:butler-c', action_key: 'AK' });
  assert.equal(afterHandoff.executed, false, 'a handoff is not a licence to re-execute the action');
  assert.equal(bus.journal().filter(entry => entry.event === 'SIDE_EFFECT_COMMITTED').length, 1);
  // A different action on the same scope is a different action and still executes.
  assert.equal(bus.commitSideEffect({ lease_ref: reassigned.lease_ref, holder_ref: 'assistant:butler-c', action_key: 'AK-2' }).executed, true);
});

test('renewal retires the previous lease reference instead of aliasing it', () => {
  const { bus } = busAt();
  const lease = acquire(bus);
  const renewed = bus.renewLease({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', ttl_ms: 5000 });
  assert.notEqual(renewed.lease_ref, lease.lease_ref);
  assert.deepEqual(bus.leases().map(entry => entry.lease_ref), [renewed.lease_ref], 'one lease is one entry');
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:camera-capture' }), 1);
  assert.equal(failure(() => bus.leaseState({ lease_ref: lease.lease_ref })).code, 'UNKNOWN_LEASE', 'the retired reference no longer resolves');
  assert.equal(bus.currentLeaseFor({ action_scope: 'action:camera-capture' }).lease_ref, renewed.lease_ref);
  // A second holder is refused against the real count, and its refusal reports that count.
  const conflict = failure(() => acquire(bus, { device_ref: 'device:beta', holder_ref: 'assistant:butler-b', action_key: 'k2' }));
  assert.equal(conflict.code, 'EXCLUSIVE_LEASE_HELD');
  assert.equal(conflict.valid_exclusive_leases, 1);
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: renewed.lease_ref, holder_ref: 'assistant:butler-b', action_key: 'k3' })).code, 'NOT_LEASE_HOLDER');
});

test('authority is never anonymous: acting on a lease needs the holder it names', () => {
  const { bus } = busAt();
  const lease = acquire(bus);
  assert.equal(failure(() => bus.renewLease({ lease_ref: lease.lease_ref, ttl_ms: 5000 })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: lease.lease_ref, action_key: 'anonymous' })).code, 'INVALID_REQUEST');
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'ACTIVE', 'the refused requests changed nothing');
  assert.equal(bus.journal().filter(entry => entry.event === 'SIDE_EFFECT_COMMITTED').length, 0);
  // A reassignment that names the wrong acting holder is refused.
  assert.equal(failure(() => bus.reassignLease({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-b', to_device_ref: 'device:gamma', to_holder_ref: 'assistant:butler-c' })).code, 'NOT_LEASE_HOLDER');
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).holder_ref, 'assistant:butler-a');
});

test('an expired lease cannot be revived with a backdated instant', () => {
  const { bus, clock } = busAt();
  const lease = acquire(bus, { ttl_ms: 1000 });
  clock.advance(2000);
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'EXPIRED');
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'rewound', at: AT(500) })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bus.renewLease({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', ttl_ms: 1000, at: AT(999) })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bus.leaseState({ lease_ref: lease.lease_ref, at: AT(400) })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bus.reassignLease({ lease_ref: lease.lease_ref, to_device_ref: 'device:beta', to_holder_ref: 'assistant:butler-b', at: AT(1) })).code, 'INVALID_REQUEST');
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'EXPIRED', 'the lease is still expired after the refused rewinds');
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:camera-capture' }), 0);
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'rewound' })).code, 'LEASE_EXPIRED');
});

test('reconciliation requires an authoritative lease inventory', () => {
  const { bus } = busAt();
  const lease = acquire(bus);
  bus.onDisconnect({ device_ref: 'device:alpha' });
  assert.equal(failure(() => bus.reconcile({ device_ref: 'device:alpha', authoritative: {} })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bus.reconcile({ device_ref: 'device:alpha', authoritative: { lease_refs: 'nonsense' } })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bus.reconcile({ device_ref: 'device:alpha', authoritative: { lease_refs: [7] } })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => bus.reconcile({ device_ref: 'device:alpha', authoritative: { lease_refs: [lease.lease_ref], task_versions: { 'task:1': 'current' } } })).code, 'INVALID_REQUEST');
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'SUSPENDED', 'a refused reconciliation grants nothing');
  assert.equal(bus.deviceState('device:alpha').connected, false, 'a refused reconciliation does not reconnect the device');
  // Authority that does not list the lease's task version has moved on: the lease is revoked.
  const reconciled = bus.reconcile({ device_ref: 'device:alpha', authoritative: { assistant_ref: ASSISTANT, task_versions: {}, lease_refs: [lease.lease_ref] } });
  assert.deepEqual(reconciled.revalidated_lease_refs, []);
  assert.deepEqual(reconciled.invalidated_lease_refs, [lease.lease_ref]);
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'REVOKED');
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'after' })).code, 'LEASE_REVOKED');
});

test('routing never delivers to a device the bus knows is disconnected', () => {
  const { bus } = busAt();
  const lease = acquire(bus);
  bus.onDisconnect({ device_ref: 'device:alpha' });
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'SUSPENDED');
  const routed = bus.routeOutput({
    assistant_ref: ASSISTANT,
    audience: 'USER',
    privacy: 'PRIVATE',
    foreground_device_ref: 'device:alpha',
    candidates: [{ device_ref: 'device:alpha', available: true, in_audience: true }],
  });
  assert.deepEqual(routed.deliveries, [], 'a candidate cannot claim availability the bus has observed to be false');
  assert.equal(routed.delivery_count, 0);
  assert.deepEqual(routed.withheld.map(entry => [entry.device_ref, entry.reason]), [['device:alpha', 'DEVICE_UNAVAILABLE']]);
  assert.equal(routed.private_response_broadcast, false);
  assert.equal(routed.broadcast, false);
});

test('staleness and replay absorption do not depend on an optional command reference', () => {
  const { bus } = busAt();
  bus.noteAuthoritativeTaskVersion({ task_ref: 'task:1', task_version: 5 });
  assert.equal(failure(() => bus.publish(eventFor({ event_id: 'n1', task_ref: 'task:1', task_version: 3 }))).code, 'STALE_EVENT');
  const first = bus.publish(eventFor({ event_id: 'n2', action_key: 'AK-1' }));
  const replay = bus.publish(eventFor({ event_id: 'n3', action_key: 'AK-1' }));
  assert.equal(first.applied, true);
  assert.equal(replay.applied, false, 'an action key alone identifies the action');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.idempotent, true);
  const current = bus.publish(eventFor({ event_id: 'n4', task_ref: 'task:1', task_version: 5, action_key: 'AK-2' }));
  assert.equal(current.applied, true, 'the authoritative version is still accepted without a command reference');
  assert.equal(bus.events().filter(event => event.kind === 'INPUT').length, 3);
});

test('a refused reconciliation grants no authority', () => {
  const { bus } = busAt();
  const lease = acquire(bus);
  bus.onDisconnect({ device_ref: 'device:alpha' });
  const cyclic = {};
  cyclic.self = cyclic;
  const cyclicRefusal = failure(() => bus.reconcile({ device_ref: 'device:alpha', authoritative: { lease_refs: [lease.lease_ref], task_versions: { 'task:1': 1, evil: cyclic } } }));
  assert.equal(cyclicRefusal.code, 'INVALID_REQUEST');
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'SUSPENDED', 'the cyclic payload granted nothing');
  assert.equal(bus.deviceState('device:alpha').connected, false);
  const uncloneable = failure(() => bus.reconcile({
    device_ref: 'device:alpha',
    authoritative: { lease_refs: [lease.lease_ref], task_versions: { 'task:1': 1 } },
    local_intents: [{ intent_ref: 'intent:resume', task_ref: 'task:1', task_version: 1, lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', requires_side_effect: true, fn: () => 1 }],
  }));
  assert.equal(uncloneable.code, 'INVALID_REQUEST');
  assert.equal(bus.leaseState({ lease_ref: lease.lease_ref }).state, 'SUSPENDED', 'an uncloneable intent did not revalidate the lease');
  assert.equal(bus.deviceState('device:alpha').connected, false, 'a failed reconciliation does not reconnect the device');
  assert.equal(failure(() => bus.commitSideEffect({ lease_ref: lease.lease_ref, holder_ref: 'assistant:butler-a', action_key: 'after' })).code, 'REVALIDATION_REQUIRED');
});

test('the canonical event carries the declared identity and transport correlation', () => {
  const { bus } = busAt();
  const published = bus.publish(eventFor({ event_id: 'event:declared-1', embodiment_kind: 'device.kind.camera', transport_ref: 'rf:path:9' }));
  assert.equal(published.event_id, 'event:declared-1', 'the declared event identity is not overwritten');
  assert.equal(published.embodiment_kind, 'device.kind.camera');
  assert.equal(published.transport_ref, 'rf:path:9');
  assert.equal(published.transport_envelope_is_canonical, false, 'carrying a transport reference is not becoming one');
  assert.equal(failure(() => bus.publish(eventFor({ event_id: 'event:declared-1' }))).code, 'INVALID_EVENT');
  assert.equal(failure(() => bus.publish(eventFor({ event_id: 'event:7' }))).code, 'INVALID_EVENT', 'the bus owns the event:<n> identity namespace it generates');
  assert.equal(bus.events().length, 1);
});

test('an envelope field is validated and used exactly once', () => {
  const { bus } = busAt();
  let atReads = 0;
  const twoFaced = eventFor({ event_id: 'event:twice' });
  Object.defineProperty(twoFaced, 'at', { enumerable: true, configurable: true, get() { atReads += 1; return atReads === 1 ? T0 : 'NOT-AN-INSTANT'; } });
  const published = bus.publish(twoFaced);
  assert.equal(published.at, T0, 'the validated instant is the recorded instant');
  assert.equal(atReads, 1, 'the field is read once');
  let deviceReads = 0;
  const twoDevices = eventFor({ event_id: 'event:twice-2' });
  Object.defineProperty(twoDevices, 'source_device_ref', { enumerable: true, configurable: true, get() { deviceReads += 1; return deviceReads === 1 ? 'device:alpha' : 'device:smuggled'; } });
  const second = bus.publish(twoDevices);
  assert.equal(second.source_device_ref, 'device:alpha', 'the validated device is the recorded device');
  assert.equal(deviceReads, 1);
  assert.equal(bus.deviceState('device:smuggled'), null, 'the unvalidated device was never registered');
});

test('exclusivity is a boolean grant, not a truthy flag', () => {
  const { bus } = busAt();
  for (const exclusive of ['true', 1, 'yes', 0]) {
    assert.equal(failure(() => acquire(bus, { action_scope: 'action:bool', action_key: null, exclusive })).code, 'INVALID_LEASE', `exclusive=${String(exclusive)}`);
  }
  const exclusiveLease = acquire(bus, { action_scope: 'action:bool', action_key: 'BK' });
  assert.equal(exclusiveLease.exclusive, true);
  assert.equal(exclusiveLease.action_key, 'BK', 'the declared action key is observable on the lease');
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:bool' }), 1);
  assert.equal(failure(() => acquire(bus, { action_scope: 'action:bool', device_ref: 'device:beta', holder_ref: 'assistant:butler-b', action_key: 'BK-2' })).code, 'EXCLUSIVE_LEASE_HELD');
  const shared = acquire(bus, { action_scope: 'action:shared', exclusive: false });
  assert.equal(shared.exclusive, false, 'a deliberate non-exclusive lease is still allowed');
  assert.equal(bus.validExclusiveLeaseCount({ action_scope: 'action:shared' }), 0);
});

test('an instant helper that guards decisions is not shape-only', () => {
  assert.equal(isIsoInstant('2026-01-01T00:00:00Z'), true);
  assert.equal(isIsoInstant('2026-01-01T00:00:00.123Z'), true);
  assert.equal(isIsoInstant('2026-13-01T00:00:00Z'), false);
  assert.equal(isIsoInstant('2026-01-01T25:00:00Z'), false);
  assert.equal(isIsoInstant(123), false);
  assert.equal(isIsoInstant('yesterday'), false);
});
