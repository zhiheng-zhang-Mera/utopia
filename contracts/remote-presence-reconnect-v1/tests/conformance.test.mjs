// Conformance tests for RF-009 鈥?presence / offline / reconnect + audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_KINDS, PATH_CLASSES, PENDING_STATES, PRESENCE_STATES, PresenceError, QUEUE_POLICIES,
  createPresenceTracker, findForbiddenAuditFields,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const AT = ms => new Date(Date.parse(T0) + ms).toISOString();
const PHONE = 'node:phone';
const DESKTOP = 'node:desktop';

function trackerAt(policy = {}) {
  const state = { ms: 0 };
  const clock = () => AT(state.ms);
  clock.advance = ms => { state.ms += ms; return clock(); };
  const tracker = createPresenceTracker({ clock, policy });
  tracker.registerNode({ node_ref: PHONE, device_id: 'device:phone', installation_id: 'installation:1' });
  tracker.registerNode({ node_ref: DESKTOP, device_id: 'device:desktop' });
  return { tracker, clock };
}

const refreshed = (overrides = {}) => ({
  device_id: 'device:phone',
  trust_state: 'TRUSTED',
  capability_available: true,
  presence_state: 'ONLINE',
  session_ref: 'session:1',
  ...overrides,
});

const AUTHORITY = { lease_ref: 'lease:1', lease_valid: true };

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof PresenceError, `expected a PresenceError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('presence is honest, distinct and never collapses into ONLINE or FAILED', () => {
  const { tracker } = trackerAt();
  assert.deepEqual([...PRESENCE_STATES], ['ONLINE', 'OFFLINE', 'SLEEPING', 'BUSY', 'DEGRADED', 'UNREACHABLE', 'UNKNOWN']);
  assert.deepEqual([...PATH_CLASSES], ['LAN_DIRECT', 'INTERNET_DIRECT', 'NAT_TRAVERSAL', 'RELAY', 'NONE']);

  const initial = tracker.presenceOf({ node_ref: PHONE });
  assert.equal(initial.state, 'UNKNOWN');
  assert.equal(initial.reachable, false, 'an unknown node is not reachable');

  const sleeping = tracker.observePresence({ node_ref: PHONE, state: 'SLEEPING', path_class: 'LAN_DIRECT', latency_ms: 12, network_quality: 'GOOD', power: 'BATTERY' });
  assert.equal(sleeping.state, 'SLEEPING');
  assert.equal(sleeping.reachable, false, 'a sleeping device is not online');
  assert.equal(sleeping.path_class, 'LAN_DIRECT');
  assert.equal(sleeping.quality.latency_ms, 12);
  assert.equal(sleeping.device_id, 'device:phone', 'logical identity is preserved across presence changes');
  assert.equal(sleeping.presence_is_reachability_only, true);
  assert.equal(sleeping.presence_is_not_ownership, true);
  assert.equal(sleeping.presence_grants_permission, false);

  assert.equal(tracker.observePresence({ node_ref: PHONE, state: 'BUSY' }).state, 'BUSY');
  const degraded = tracker.observePresence({ node_ref: PHONE, state: 'DEGRADED', path_class: 'RELAY' });
  assert.equal(degraded.state, 'DEGRADED');
  assert.equal(degraded.reachable, true, 'a degraded node is still reachable');
  assert.equal(tracker.observePresence({ node_ref: PHONE, state: 'OFFLINE' }).state, 'OFFLINE');
  assert.equal(failure(() => tracker.observePresence({ node_ref: PHONE, state: 'FINE' })).code, 'INVALID_PRESENCE');
  assert.equal(failure(() => tracker.observePresence({ node_ref: PHONE, state: 'ONLINE', path_class: 'MAGIC' })).code, 'INVALID_PRESENCE');
  assert.equal(failure(() => tracker.presenceOf({ node_ref: 'node:nope' })).status, 404);
  assert.equal(failure(() => tracker.registerNode({ node_ref: '', device_id: 'd' })).code, 'INVALID_REQUEST');
});

test('a silent node becomes UNREACHABLE rather than ONLINE or FAILED', () => {
  const { tracker, clock } = trackerAt({ offline_after_ms: 1000 });
  tracker.observePresence({ node_ref: PHONE, state: 'ONLINE' });
  assert.equal(tracker.presenceOf({ node_ref: PHONE }).state, 'ONLINE');
  clock.advance(500);
  assert.equal(tracker.presenceOf({ node_ref: PHONE }).state, 'ONLINE', 'still within the freshness window');

  clock.advance(1000);
  const unreachable = tracker.presenceOf({ node_ref: PHONE });
  assert.equal(unreachable.state, 'UNREACHABLE', 'a silent node is unreachable, not failed and not online');
  assert.equal(unreachable.reachable, false);
  assert.equal(unreachable.stale, true);
  assert.equal(unreachable.timed_out_from, 'ONLINE');
  assert.equal(unreachable.reported_state, 'ONLINE', 'the last reported state is preserved for debugging');

  // An explicitly offline node stays offline rather than becoming unreachable.
  tracker.observePresence({ node_ref: PHONE, state: 'OFFLINE' });
  clock.advance(5000);
  assert.equal(tracker.presenceOf({ node_ref: PHONE }).state, 'OFFLINE');
  assert.equal(failure(() => tracker.assertReachable({ node_ref: PHONE })).code, 'NOT_REACHABLE');
  assert.equal(failure(() => tracker.assertReachable({ node_ref: PHONE })).pretended_success, false);
});

test('queueable work expires and live-only actions never run late', () => {
  const { tracker, clock } = trackerAt({ default_queue_deadline_ms: 1000, max_queue_deadline_ms: 120000 });
  assert.deepEqual([...QUEUE_POLICIES], ['QUEUEABLE', 'LIVE_ONLY']);
  assert.deepEqual([...PENDING_STATES], ['PENDING', 'UNKNOWN', 'CONFIRMED_SUCCEEDED', 'CONFIRMED_FAILED', 'EXPIRED', 'REFUSED', 'DUPLICATE_SUPPRESSED']);

  // A live action while the node is unreachable is refused outright.
  const refused = failure(() => tracker.enqueueAction({ command_ref: 'cmd:click', node_ref: PHONE, action_ref: 'action:click', queue_policy: 'LIVE_ONLY' }));
  assert.equal(refused.code, 'LIVE_ACTION_NOT_QUEUEABLE');
  assert.equal(refused.queued, false);
  assert.equal(refused.expires_later, false);
  assert.equal(refused.interactive_action_must_not_run_late, true);

  // A live action does not become queueable merely by asking nicely.
  tracker.observePresence({ node_ref: PHONE, state: 'ONLINE' });
  const live = tracker.enqueueAction({ command_ref: 'cmd:capture', node_ref: PHONE, action_ref: 'action:capture', queue_policy: 'LIVE_ONLY' });
  assert.equal(live.accepted, true);
  assert.equal(live.queued, false);
  assert.equal(live.queue_policy, 'LIVE_ONLY');

  // Queueable work carries an explicit deadline.
  const queued = tracker.enqueueAction({ command_ref: 'cmd:sync', node_ref: PHONE, action_ref: 'action:sync', deadline_at: AT(60000) });
  assert.equal(queued.queued, true);
  assert.equal(queued.queue_expires_at, AT(60000));
  assert.equal(failure(() => tracker.enqueueAction({ command_ref: 'c', node_ref: PHONE, deadline_at: AT(99999999) })).code, 'DEADLINE_REQUIRED');
  assert.equal(failure(() => tracker.enqueueAction({ command_ref: 'c2', node_ref: PHONE, deadline_at: T0 })).code, 'ACTION_EXPIRED');

  // Time passes: the live action's context is gone and the queued work expires.
  clock.advance(70000);
  const reconciled = tracker.reconcile({ node_ref: PHONE, refreshed: refreshed(), authority: AUTHORITY });
  const outcomes = Object.fromEntries(reconciled.outcomes.map(entry => [entry.command_ref, entry]));
  assert.equal(outcomes['cmd:capture'].outcome, 'DROPPED_LIVE_CONTEXT_LOST', 'a live action never executes after its context');
  assert.equal(outcomes['cmd:capture'].executed, false);
  assert.equal(outcomes['cmd:sync'].outcome, 'DROPPED_EXPIRED');
  assert.equal(outcomes['cmd:sync'].expired_at, AT(60000));
  assert.deepEqual(reconciled.resumed_commands, []);
  assert.equal(reconciled.side_effects_resumed_without_revalidation, false);
  assert.equal(tracker.pendingCommands({ node_ref: PHONE }).find(entry => entry.command_ref === 'cmd:sync').state, 'EXPIRED');
});

test('an unknown transport outcome stays UNKNOWN until it is reconciled', () => {
  const { tracker } = trackerAt();
  tracker.observePresence({ node_ref: PHONE, state: 'ONLINE' });
  tracker.enqueueAction({ command_ref: 'cmd:1', node_ref: PHONE, action_ref: 'action:1', deadline_at: AT(600000) });
  const unknown = tracker.markOutcomeUnknown({ command_ref: 'cmd:1', reason: 'CONNECTION_RESET_MID_REQUEST' });
  assert.equal(unknown.state, 'UNKNOWN');
  assert.equal(unknown.reported_success, false, 'an unknown outcome is never reported as success');
  assert.equal(unknown.reported_failure, false, 'nor as a confirmed failure');
  assert.equal(unknown.unknown_outcome_is_not_success, true);
  assert.equal(unknown.reconciliation_required, true);

  // Reconciliation refuses to resume it: the caller must reconcile, not assume.
  const reconciled = tracker.reconcile({ node_ref: PHONE, refreshed: refreshed(), authority: AUTHORITY });
  const outcome = reconciled.outcomes.find(entry => entry.command_ref === 'cmd:1');
  assert.equal(outcome.outcome, 'DROPPED_UNKNOWN');
  assert.equal(outcome.executed, false);
  assert.equal(outcome.reconciliation_required, true);
  assert.deepEqual(reconciled.resumed_commands, []);
  assert.equal(failure(() => tracker.markOutcomeUnknown({ command_ref: 'cmd:nope' })).code, 'INVALID_REQUEST');
});

test('reconnect revalidates identity, trust, capability, presence and authority before resuming', () => {
  const { tracker } = trackerAt();
  const enqueue = () => {
    tracker.enqueueAction({ command_ref: 'cmd:resume', node_ref: PHONE, action_ref: 'action:resume', deadline_at: AT(600000) });
  };
  tracker.observePresence({ node_ref: PHONE, state: 'ONLINE' });

  // Each missing refresh drops the pending command with a distinct reason.
  const cases = [
    [{ trust_state: 'UNPAIRED' }, AUTHORITY, 'TRUST_NOT_REFRESHED'],
    [{ capability_available: false }, AUTHORITY, 'CAPABILITY_NOT_REFRESHED'],
    [{ device_id: 'device:other' }, AUTHORITY, 'IDENTITY_MISMATCH'],
    [{ presence_state: 'OFFLINE' }, AUTHORITY, 'PRESENCE_NOT_REACHABLE'],
    [{}, { lease_ref: 'lease:1', lease_valid: false }, 'AUTHORITY_NOT_REVALIDATED'],
    [{}, null, 'AUTHORITY_NOT_REVALIDATED'],
  ];
  for (const [refreshOverride, authority, expectedReason] of cases) {
    enqueue();
    const result = tracker.reconcile({ node_ref: PHONE, refreshed: refreshed(refreshOverride), authority });
    const outcome = result.outcomes.find(entry => entry.command_ref === 'cmd:resume');
    assert.equal(outcome.outcome, 'DROPPED_NOT_REVALIDATED', `expected a drop for ${expectedReason}`);
    assert.equal(outcome.reason, expectedReason);
    assert.equal(outcome.executed, false);
  }

  // With everything refreshed the command may resume 鈥?but only the caller dispatches it.
  enqueue();
  const ok = tracker.reconcile({ node_ref: PHONE, refreshed: refreshed(), authority: AUTHORITY });
  assert.equal(ok.outcomes.find(entry => entry.command_ref === 'cmd:resume').outcome, 'RESUMED');
  assert.equal(ok.outcomes.find(entry => entry.command_ref === 'cmd:resume').executed, false, 'reconciliation resumes state, it does not execute');
  assert.equal(ok.identity_preserved, true);
  assert.equal(ok.trust_refreshed, true);
  assert.equal(ok.capability_refreshed, true);
  assert.equal(ok.presence_reachable, true);
  assert.equal(ok.authority_revalidated, true);
  assert.equal(ok.stale_local_state_used_as_authority, false);
  assert.equal(failure(() => tracker.reconcile({ node_ref: PHONE })).code, 'INVALID_REQUEST');
});

test('a stale replay after reconnect cannot duplicate a completed side effect', () => {
  const { tracker } = trackerAt();
  tracker.observePresence({ node_ref: PHONE, state: 'ONLINE' });
  tracker.enqueueAction({ command_ref: 'cmd:effect', node_ref: PHONE, action_ref: 'action:effect', deadline_at: AT(600000) });
  const confirmed = tracker.confirmEffect({ node_ref: PHONE, effect_ref: 'effect:1', command_ref: 'cmd:effect' });
  assert.equal(confirmed.duplicate_suppression_armed, true);
  assert.equal(confirmed.hasOwnProperty('node_ref'), true);

  // The same action replayed later is refused rather than repeated.
  const duplicate = failure(() => tracker.assertNotDuplicate({ node_ref: PHONE, action_ref: 'action:effect' }));
  assert.equal(duplicate.code, 'DUPLICATE_COMPLETED_EFFECT');
  assert.equal(duplicate.executed, false);
  assert.equal(duplicate.completed_effect_ref, 'effect:1');

  // Reconciliation suppresses it as well, and it is not resumed.
  tracker.enqueueAction({ command_ref: 'cmd:effect-2', node_ref: PHONE, action_ref: 'action:effect', deadline_at: AT(600000) });
  const reconciled = tracker.reconcile({ node_ref: PHONE, refreshed: refreshed(), authority: AUTHORITY });
  const suppressed = reconciled.outcomes.find(entry => entry.command_ref === 'cmd:effect-2');
  assert.equal(suppressed.outcome, 'DUPLICATE_SUPPRESSED');
  assert.equal(suppressed.executed, false);
  assert.equal(reconciled.resumed_commands.includes('cmd:effect-2'), false);

  // A different action on the same node is unaffected.
  assert.equal(tracker.assertNotDuplicate({ node_ref: PHONE, action_ref: 'action:other' }).duplicate, false);
  assert.equal(failure(() => tracker.confirmEffect({ node_ref: PHONE })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => tracker.confirmEffect({ node_ref: PHONE, effect_ref: 'e', outcome: 'MAYBE' })).code, 'INVALID_REQUEST');
  assert.equal(tracker.completedEffects().length, 1, 'a refused duplication did not create another effect');
  assert.equal(findForbiddenAuditFields({ node_ref: PHONE, state: 'ONLINE' }).length, 0);
});

test('the audit log carries causal identifiers and no secrets, and state is isolated', () => {
  const { tracker } = trackerAt();
  tracker.observePresence({ node_ref: PHONE, state: 'ONLINE', session_ref: 'session:1' });
  tracker.enqueueAction({ command_ref: 'cmd:1', node_ref: PHONE, action_ref: 'action:1', deadline_at: AT(600000) });
  tracker.markOutcomeUnknown({ command_ref: 'cmd:1' });
  tracker.reconcile({ node_ref: PHONE, refreshed: refreshed(), authority: AUTHORITY });
  const log = tracker.auditLog();
  assert.equal(log.length > 0, true);
  assert.deepEqual([...AUDIT_KINDS], ['PAIRING', 'TRUST', 'SESSION', 'PATH', 'COMMAND', 'PRESENCE']);
  for (const entry of log) {
    assert.equal(entry.append_only, true);
    assert.equal(entry.contains_secret_material, false);
    assert.equal(entry.contains_private_payload, false);
    assert.equal(entry.causal_identifiers_present, true, 'every entry can be debugged from its identifiers');
    assert.equal(entry.hasOwnProperty('node_ref'), true);
  }
  assert.equal(log.some(entry => entry.kind === 'PRESENCE' && entry.to_state === 'ONLINE'), true);
  assert.equal(log.some(entry => entry.kind === 'COMMAND' && entry.outcome === 'UNKNOWN_OUTCOME_UNRECONCILED'), true);
  assert.equal(log.some(entry => entry.kind === 'SESSION' && entry.outcome === 'RECONCILED'), true);
  assert.deepEqual(findForbiddenAuditFields(log), [], 'the audit log stores no secret material or payload body');
  assert.deepEqual(findForbiddenAuditFields({ token: 'x' }), ['audit.token']);
  assert.deepEqual(findForbiddenAuditFields({ nested: { payload_body: 'x' } }), ['audit.nested.payload_body']);
  assert.equal(tracker.auditFor({ node_ref: PHONE }).length, log.filter(entry => entry.node_ref === PHONE).length);
  assert.equal(tracker.auditFor({ node_ref: DESKTOP }).length, 1, 'the desktop node has only its own registration entry');

  // The audit log is bounded, and two trackers share no state.
  const bounded = trackerAt({ max_audit_entries: 3 }).tracker;
  for (let index = 0; index < 10; index += 1) bounded.observePresence({ node_ref: PHONE, state: 'ONLINE' });
  assert.equal(bounded.auditLog().length, 3, 'the audit log is bounded');
  const other = trackerAt().tracker;
  assert.equal(other.pendingCommands().length, 0);
  assert.equal(other.completedEffects().length, 0);
  assert.equal(failure(() => createPresenceTracker({ clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(tracker.policy().policy_ref, 'policy:rf-presence-default');
  assert.throws(() => { const presence = tracker.presenceOf({ node_ref: PHONE }); presence.state = 'ONLINE'; }, TypeError);
});
