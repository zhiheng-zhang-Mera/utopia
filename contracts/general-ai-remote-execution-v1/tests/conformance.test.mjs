// Conformance tests for GAI-007 鈥?device-aware remote execution + result return.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_STATES, EVENT_KINDS, EXCLUSION_REASONS, RemoteExecutionError, REMOTE_EXECUTION_PORT,
  STAGING_POLICIES, createRemoteExecutionRouter,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const LAPTOP = 'device:laptop';
const DESKTOP = 'device:desktop';
const TABLET = 'device:tablet';

const endpoint = (overrides = {}) => ({
  endpoint_ref: `endpoint:${overrides.device_ref ?? LAPTOP}`,
  device_ref: LAPTOP,
  presence: 'ONLINE',
  web_ready: true,
  session_available: true,
  input_locality_ok: true,
  load: 0.2,
  freshness_ms: 1000,
  provider_ready: true,
  hardware_auth_required: false,
  ...overrides,
});

function portWith(endpoints, { cancelSupported = true } = {}) {
  const calls = { listEndpoints: 0, dispatch: [], cancel: [] };
  const port = {
    listEndpoints() { calls.listEndpoints += 1; return endpoints.map(entry => ({ ...entry })); },
    dispatch(request) { calls.dispatch.push(request); return { receipt_ref: `receipt:${calls.dispatch.length}`, accepted: true }; },
  };
  if (cancelSupported) port.cancel = request => { calls.cancel.push(request); return { receipt_ref: `cancel-receipt:${calls.cancel.length}`, accepted: true }; };
  return { port, calls };
}

const routerWith = (endpoints, policy = {}, options = {}) => {
  const { port, calls } = portWith(endpoints, options);
  return { router: createRemoteExecutionRouter({ executionPort: port, clock: () => T0, policy }), calls };
};

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof RemoteExecutionError, `expected a RemoteExecutionError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('a healthy current device is preferred, so nothing moves and nothing is interrupted', () => {
  const { router, calls } = routerWith([endpoint(), endpoint({ device_ref: DESKTOP, load: 0.05 })]);
  const proposal = router.proposeDeviceSwitch({ action_ref: 'action:1', interaction_device_ref: LAPTOP });
  assert.equal(proposal.route, 'LOCAL_WEB');
  assert.equal(proposal.execution_device_ref, LAPTOP);
  assert.equal(proposal.requires_confirmation, false, 'no user interruption when the current device can do the work');
  assert.equal(proposal.confirmed, true);
  assert.equal(proposal.interaction_device_unchanged, true);
  assert.equal(proposal.granted_execution_authority, false);
  assert.equal(proposal.selection_reason, 'CURRENT_DEVICE_HEALTHY');
  assert.equal(proposal.dispatch_performed, false);
  assert.equal(proposal.ai_requests_launched, 0, 'ranking never launches an AI request');
  assert.deepEqual(calls.dispatch, [], 'ranking never dispatches');

  const dispatched = router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' });
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.execution_device_ref, LAPTOP);
  assert.equal(dispatched.interaction_device_unchanged, true);
  assert.equal(dispatched.remote_desktop_stream, false);
  assert.equal(dispatched.semantic_transport, true);
  assert.equal(dispatched.actions_created_on_execution_host, 1);
  assert.equal(calls.dispatch.length, 1);
  assert.equal(REMOTE_EXECUTION_PORT.implements_trust_or_transport, false, 'the facade implements no trust or transport itself');
  assert.equal(REMOTE_EXECUTION_PORT.facade_over, 'REMOTE_FABRIC_PUBLIC_API');
});

test('endpoints are ranked from metadata only, and stale or offline ones are never healthy', () => {
  const { router, calls } = routerWith([
    endpoint({ device_ref: LAPTOP, session_available: false, load: 0.95, freshness_ms: 200000 }),
    endpoint({ device_ref: DESKTOP, load: 0.1, freshness_ms: 500 }),
    endpoint({ device_ref: TABLET, presence: 'OFFLINE', freshness_ms: 100 }),
  ]);
  const proposal = router.proposeDeviceSwitch({ action_ref: 'action:2', interaction_device_ref: LAPTOP, requirements: { requires_session: true } });
  assert.equal(proposal.route, 'REMOTE_DEVICE');
  assert.equal(proposal.execution_device_ref, DESKTOP);
  assert.equal(proposal.selection_reason, 'LOCAL_WEB_NOT_HEALTHY');
  assert.equal(proposal.local_exclusion_reasons.includes('OVERLOADED'), true);
  assert.equal(proposal.local_exclusion_reasons.includes('STALE_ENDPOINT'), true);
  assert.equal(proposal.local_exclusion_reasons.includes('NO_SESSION'), true);
  const ranked = proposal.ranked;
  assert.equal(ranked[0].device_ref, DESKTOP, 'the healthy, fresh endpoint ranks first');
  const tablet = ranked.find(entry => entry.device_ref === TABLET);
  assert.equal(tablet.eligible, false);
  assert.deepEqual(tablet.exclusion_reasons, ['OFFLINE'], 'an offline endpoint reports the one reason that matters');
  assert.deepEqual(proposal.excluded.map(entry => entry.device_ref).sort(), [LAPTOP, TABLET].sort());
  assert.equal(proposal.ai_requests_launched, 0);
  assert.equal(proposal.probes_sent, 0);
  assert.deepEqual(calls.dispatch, [], 'discovery and ranking launched no AI request as a probe');
  assert.equal(ranked[0].score_breakdown.load.weight > 0, true, 'the score breakdown is published');
  assert.deepEqual([...EXCLUSION_REASONS].includes('STALE_ENDPOINT'), true);

  // With nothing healthy the router refuses instead of picking something stale.
  const { router: staleOnly } = routerWith([endpoint({ device_ref: DESKTOP, presence: 'OFFLINE', freshness_ms: 500000 })]);
  const none = failure(() => staleOnly.proposeDeviceSwitch({ action_ref: 'action:3', interaction_device_ref: LAPTOP }));
  assert.equal(none.code, 'NO_HEALTHY_ENDPOINT');
  assert.equal(none.ai_requests_launched, 0);
  assert.deepEqual(none.stale_or_offline_excluded, [DESKTOP]);
  assert.equal(router.portCalls().dispatch, 0);
  assert.equal(failure(() => staleOnly.proposeDeviceSwitch({ action_ref: '', interaction_device_ref: LAPTOP })).code, 'INVALID_REQUEST');
});

test('no execution begins before the V1 device-switch confirmation', () => {
  const { router, calls } = routerWith([endpoint({ device_ref: LAPTOP, web_ready: false }), endpoint({ device_ref: DESKTOP })]);
  const proposal = router.proposeDeviceSwitch({ action_ref: 'action:4', interaction_device_ref: LAPTOP });
  assert.equal(proposal.route, 'REMOTE_DEVICE');
  assert.equal(proposal.execution_device_ref, DESKTOP);
  assert.equal(proposal.requires_confirmation, true);
  assert.equal(proposal.confirmed, false);
  assert.equal(proposal.granted_execution_authority, false);

  // Dispatch before confirmation is refused, and nothing reaches the host.
  const gated = failure(() => router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:4' }));
  assert.equal(gated.code, 'CONFIRMATION_REQUIRED');
  assert.equal(gated.dispatch_performed, false);
  assert.equal(gated.interaction_device_unchanged, true);
  assert.deepEqual(calls.dispatch, []);

  // A denial is recorded and still blocks dispatch.
  const denied = router.confirmProposal({ proposal_ref: proposal.proposal_ref, confirmed: false, user_ref: 'user:owner' });
  assert.equal(denied.confirmed, false);
  assert.equal(denied.dispatch_may_proceed, false);
  assert.equal(denied.grants_execution_authority, false);
  assert.equal(failure(() => router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:4' })).code, 'PROPOSAL_NOT_CONFIRMED');

  // Approval allows exactly one dispatch, and the interaction device stays put.
  const second = router.proposeDeviceSwitch({ action_ref: 'action:5', interaction_device_ref: LAPTOP });
  const approved = router.confirmProposal({ proposal_ref: second.proposal_ref, confirmed: true, user_ref: 'user:owner' });
  assert.equal(approved.dispatch_may_proceed, true);
  assert.equal(approved.grants_execution_authority, false, 'a confirmation is not an authority transfer');
  assert.equal(router.confirmProposal({ proposal_ref: second.proposal_ref, confirmed: true }).duplicate, true, 'confirmation is idempotent');
  const dispatched = router.dispatch({ proposal_ref: second.proposal_ref, action_id: 'action:5' });
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.interaction_device_ref, LAPTOP, 'the user keeps their interaction device');
  assert.equal(dispatched.execution_device_ref, DESKTOP);
  assert.equal(dispatched.interaction_device_unchanged, true);
  assert.equal(dispatched.action_created_on_interaction_device, false);
  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.dispatch[0].semantic_rpc, true);
  assert.equal(calls.dispatch[0].action_id, 'action:5');
  assert.equal(failure(() => router.dispatch({ proposal_ref: 'proposal:nope', action_id: 'x' })).code, 'UNKNOWN_PROPOSAL');
  assert.equal(failure(() => router.confirmProposal({ proposal_ref: 'proposal:nope' })).code, 'UNKNOWN_PROPOSAL');
  assert.equal(failure(() => router.dispatch({ proposal_ref: second.proposal_ref, action_id: '' })).code, 'INVALID_REQUEST');
});

test('exactly one canonical Action exists on the execution host, and every event correlates to it', () => {
  const { router, calls } = routerWith([endpoint({ device_ref: LAPTOP, web_ready: false }), endpoint({ device_ref: DESKTOP })]);
  const proposal = router.proposeDeviceSwitch({ action_ref: 'action:6', interaction_device_ref: LAPTOP });
  router.confirmProposal({ proposal_ref: proposal.proposal_ref, confirmed: true });
  const dispatched = router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:6' });
  assert.equal(dispatched.canonical_action_id, 'action:6');
  assert.equal(dispatched.actions_created_on_execution_host, 1);

  // A second dispatch for the same canonical id is absorbed, not repeated.
  const duplicate = router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:6' });
  assert.equal(duplicate.dispatched, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.actions_created_on_execution_host, 1);
  assert.equal(calls.dispatch.length, 1, 'the host was contacted once');

  // Progress, partial, error and final all correlate to the same action id.
  assert.equal(router.recordEvent({ action_id: 'action:6', kind: 'STATUS', text: 'queued' }).correlated_action_id, 'action:6');
  assert.equal(router.recordEvent({ action_id: 'action:6', kind: 'PROGRESS', text: 'working' }).correlated_action_id, 'action:6');
  const partial = router.recordEvent({ action_id: 'action:6', kind: 'PARTIAL', text: 'half' });
  assert.equal(partial.terminal, false, 'a partial is never terminal');
  assert.equal(partial.correlated_action_id, 'action:6');
  assert.equal(failure(() => router.recordEvent({ action_id: 'action:6', kind: 'PROGRESS', seq: 99 })).code, 'EVENT_OUT_OF_ORDER');
  const final = router.recordEvent({ action_id: 'action:6', kind: 'FINAL', payload_ref: 'result:1' });
  assert.equal(final.terminal, true);
  assert.equal(final.state, 'SUCCEEDED');

  const status = router.statusFor({ action_id: 'action:6' });
  assert.deepEqual(status.correlated_action_ids, ['action:6'], 'exactly one action id correlates the whole run');
  assert.equal(status.final_ref, 'result:1');
  assert.equal(status.partial_refs.length, 1);
  assert.equal(status.progress_events, 2);
  assert.equal(status.interaction_device_unchanged, true);
  assert.equal(status.permission_granted_by_router, false);
  assert.equal(status.remote_desktop_stream, false);
  assert.equal(router.statusFor({ action_id: 'action:6' }).state, 'SUCCEEDED');
  assert.deepEqual([...ACTION_STATES], ['DISPATCHED', 'RUNNING', 'AWAITING_USER', 'CANCELLED', 'SUCCEEDED', 'FAILED']);
  assert.deepEqual([...EVENT_KINDS], ['STATUS', 'PROGRESS', 'PARTIAL', 'ERROR', 'FINAL', 'CANCELLED']);

  // Late and duplicate events after the terminal state are reconciled, never applied.
  const late = router.recordEvent({ action_id: 'action:6', kind: 'FINAL', payload_ref: 'result:late' });
  assert.equal(late.applied, false);
  assert.equal(late.reconciled, true);
  assert.equal(late.reason, 'LATE_EVENT_AFTER_TERMINAL');
  assert.equal(router.statusFor({ action_id: 'action:6' }).final_ref, 'result:1', 'the first terminal result stands');
  assert.equal(router.statusFor({ action_id: 'action:6' }).reconciled_event_count, 1);
  assert.equal(failure(() => router.recordEvent({ action_id: 'action:nope', kind: 'STATUS' })).code, 'UNKNOWN_ACTION');
  assert.equal(failure(() => router.recordEvent({ action_id: 'action:6', kind: 'TELEMETRY' })).code, 'INVALID_REQUEST');
});

test('remote cancel works from any authorized device and reconciles late results', () => {
  const { router, calls } = routerWith([endpoint({ device_ref: LAPTOP, web_ready: false }), endpoint({ device_ref: DESKTOP })]);
  const proposal = router.proposeDeviceSwitch({ action_ref: 'action:7', interaction_device_ref: LAPTOP });
  router.confirmProposal({ proposal_ref: proposal.proposal_ref, confirmed: true });
  router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:7' });
  router.recordEvent({ action_id: 'action:7', kind: 'PROGRESS' });

  // An unrelated device may not cancel.
  assert.equal(failure(() => router.cancel({ action_id: 'action:7', by_device_ref: 'device:intruder' })).code, 'NOT_AUTHORIZED_TO_CANCEL');

  // The interaction device can cancel without operating the execution host.
  const cancelled = router.cancel({ action_id: 'action:7', by_device_ref: LAPTOP, reason: 'USER_CANCELLED' });
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.cancelled_from, 'INTERACTION_DEVICE');
  assert.equal(cancelled.interaction_device_is_only_cancel_authority, false);
  assert.equal(cancelled.remote_cancel_receipt_ref, 'cancel-receipt:1');
  assert.equal(calls.cancel.length, 1);
  assert.equal(router.cancel({ action_id: 'action:7', by_device_ref: TABLET }).duplicate, true, 'a repeat is idempotent for any authorized viewer');

  // A late final result after cancellation is reconciled rather than accepted.
  const late = router.recordEvent({ action_id: 'action:7', kind: 'FINAL', payload_ref: 'result:late-7' });
  assert.equal(late.reconciled, true);
  assert.equal(late.applied, false);
  assert.equal(router.statusFor({ action_id: 'action:7' }).state, 'CANCELLED');
  assert.equal(router.statusFor({ action_id: 'action:7' }).final_ref, null, 'no late result becomes canonical');
  assert.equal(router.cancel({ action_id: 'action:7', by_device_ref: LAPTOP }).duplicate, true, 'cancellation stays idempotent after a late event');

  // Any authorized viewer can also cancel a running action (the execution host is in the viewer set).
  const second = router.proposeDeviceSwitch({ action_ref: 'action:8', interaction_device_ref: LAPTOP });
  router.confirmProposal({ proposal_ref: second.proposal_ref, confirmed: true });
  router.dispatch({ proposal_ref: second.proposal_ref, action_id: 'action:8' });
  const fromHost = router.cancel({ action_id: 'action:8', by_device_ref: DESKTOP });
  assert.equal(fromHost.cancelled_from, 'OTHER_AUTHORIZED_DEVICE');
  assert.equal(router.statusFor({ action_id: 'action:8' }).state, 'CANCELLED');

  // A terminal action cannot be cancelled afterwards.
  router.recordEvent({ action_id: 'action:8', kind: 'FINAL' }).reconciled === true;
  const third = router.proposeDeviceSwitch({ action_ref: 'action:9', interaction_device_ref: LAPTOP });
  router.confirmProposal({ proposal_ref: third.proposal_ref, confirmed: true });
  router.dispatch({ proposal_ref: third.proposal_ref, action_id: 'action:9' });
  router.recordEvent({ action_id: 'action:9', kind: 'FINAL', payload_ref: 'result:9' });
  assert.equal(failure(() => router.cancel({ action_id: 'action:9', by_device_ref: LAPTOP })).code, 'LATE_EVENT_AFTER_TERMINAL');
  assert.equal(failure(() => router.cancel({ action_id: 'action:nope', by_device_ref: LAPTOP })).code, 'UNKNOWN_ACTION');
  assert.equal(failure(() => router.cancel({ action_id: 'action:9' })).code, 'INVALID_REQUEST');
});

test('hardware-bound authentication surfaces as ATTENTION_REQUIRED, never as false success', () => {
  const { router, calls } = routerWith([
    endpoint({ device_ref: LAPTOP, web_ready: false }),
    endpoint({ device_ref: DESKTOP, hardware_auth_required: true }),
  ]);
  const proposal = router.proposeDeviceSwitch({ action_ref: 'action:10', interaction_device_ref: LAPTOP });
  router.confirmProposal({ proposal_ref: proposal.proposal_ref, confirmed: true });
  const result = router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:10' });
  assert.equal(result.dispatched, false, 'a hardware-bound host is not a success');
  assert.equal(result.attention_required, true);
  assert.equal(result.execution_started, false);
  assert.equal(result.actions_created_on_execution_host, 0);
  assert.equal(result.interaction_device_unchanged, true);
  assert.equal(result.delivered_to_interaction_device, true);
  assert.equal(result.attention.kind, 'DEVICE_ACTION');
  assert.equal(result.attention.blocking, true);
  assert.equal(result.attention.delivered_to, LAPTOP, 'the request goes to the device the user is holding');
  assert.equal(result.attention.execution_device_ref, DESKTOP);
  assert.equal(result.attention.user_must_operate_execution_host, false, 'the user is not sent to walk to the other machine');
  assert.deepEqual(calls.dispatch, [], 'no execution was started on the hardware-bound host');

  // An in-flight action can raise attention later, and it is delivered remotely too.
  const { router: plain } = routerWith([endpoint({ device_ref: LAPTOP })]);
  const local = plain.proposeDeviceSwitch({ action_ref: 'action:11', interaction_device_ref: LAPTOP });
  plain.dispatch({ proposal_ref: local.proposal_ref, action_id: 'action:11' });
  const attention = plain.raiseAttention({ action_id: 'action:11', question: 'Which account should I use?' });
  assert.equal(attention.delivered_to, LAPTOP);
  assert.equal(attention.delivered_remotely, true);
  assert.equal(attention.user_must_operate_execution_host, false);
  assert.equal(plain.statusFor({ action_id: 'action:11' }).state, 'AWAITING_USER');
  assert.equal(plain.statusFor({ action_id: 'action:11' }).attention.attention_ref, attention.attention_ref);
  assert.equal(failure(() => plain.raiseAttention({ action_id: 'action:11' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => plain.raiseAttention({ action_id: 'action:nope', question: 'x' })).code, 'UNKNOWN_ACTION');
});

test('semantic input staging carries an explicit cleanup policy, and the router is strict', () => {
  const { router } = routerWith([endpoint({ device_ref: LAPTOP })]);
  const proposal = router.proposeDeviceSwitch({ action_ref: 'action:12', interaction_device_ref: LAPTOP });
  const dispatched = router.dispatch({
    proposal_ref: proposal.proposal_ref,
    action_id: 'action:12',
    input_bundle_refs: [
      { bundle_ref: 'bundle:temp', staging_policy: 'DELETE_AFTER_USE', cleanup_by: '2026-01-01T01:00:00Z' },
      { bundle_ref: 'bundle:inline', staging_policy: 'NO_STAGING' },
    ],
  });
  assert.equal(dispatched.staged_inputs.length, 2);
  assert.deepEqual(dispatched.staged_inputs.map(entry => [entry.bundle_ref, entry.cleanup_required]), [['bundle:temp', true], ['bundle:inline', false]]);
  assert.equal(dispatched.staged_inputs[0].canonical_local_path, null, 'staging is semantic, not a filesystem path');
  assert.deepEqual([...STAGING_POLICIES], ['NO_STAGING', 'DELETE_AFTER_USE', 'RETAIN']);

  const second = router.proposeDeviceSwitch({ action_ref: 'action:13', interaction_device_ref: LAPTOP });
  assert.equal(failure(() => router.dispatch({ proposal_ref: second.proposal_ref, action_id: 'action:13', input_bundle_refs: [{ bundle_ref: 'bundle:x' }] })).code, 'STAGING_POLICY_REQUIRED');
  assert.equal(failure(() => router.dispatch({ proposal_ref: second.proposal_ref, action_id: 'action:13', input_bundle_refs: [{ bundle_ref: 'bundle:x', staging_policy: 'SOMETIME' }] })).code, 'STAGING_POLICY_REQUIRED');
  assert.equal(failure(() => router.dispatch({ proposal_ref: second.proposal_ref, action_id: 'action:13', input_bundle_refs: ['bundle:x'] })).code, 'STAGING_POLICY_REQUIRED');

  // The approved endpoint must still be the one the proposal named.
  const { router: moving, calls } = routerWith([endpoint({ device_ref: LAPTOP, web_ready: false }), endpoint({ device_ref: DESKTOP })]);
  const remote = moving.proposeDeviceSwitch({ action_ref: 'action:14', interaction_device_ref: LAPTOP });
  moving.confirmProposal({ proposal_ref: remote.proposal_ref, confirmed: true });
  const swapped = routerWith([endpoint({ device_ref: LAPTOP, web_ready: false }), endpoint({ device_ref: DESKTOP })]);
  assert.equal(swapped.router.proposeDeviceSwitch({ action_ref: 'action:14', interaction_device_ref: LAPTOP }).execution_device_ref, DESKTOP);
  assert.equal(failure(() => createRemoteExecutionRouter({ executionPort: {} })).code, 'INVALID_PORT');
  assert.equal(failure(() => createRemoteExecutionRouter({ executionPort: calls.port ?? {}, clock: 'now' })).code, 'INVALID_PORT');
  assert.throws(() => { moving.statusFor({ action_id: 'action:14' }); }, error => error.code === 'UNKNOWN_ACTION');

  // Frozen results, and two routers share no state.
  const first = moving.dispatch({ proposal_ref: remote.proposal_ref, action_id: 'action:14' });
  assert.throws(() => { first.dispatched = false; }, TypeError);
  const other = routerWith([endpoint({ device_ref: LAPTOP })]).router;
  assert.equal(other.actions().length, 0);
  assert.equal(other.proposals().length, 0);
  assert.equal(router.policy().policy_ref, 'policy:gai-remote-default');
  assert.equal(router.executionPort().implements_presence_or_identity, false);
  assert.equal(router.journal().some(entry => entry.event === 'ACTION_DISPATCHED'), true);
});

// ---------------------------------------------------------------- Alien Correction regressions
// Every test below fails against the Development head and passes against the corrected head.

const remoteProposal = (router, action_ref = 'action:1') => {
  const proposal = router.proposeDeviceSwitch({ action_ref, interaction_device_ref: LAPTOP });
  router.confirmProposal({ proposal_ref: proposal.proposal_ref, confirmed: true });
  return proposal;
};

test('the policy cannot switch off confirmation or the health ceilings', () => {
  const endpoints = [endpoint({ device_ref: LAPTOP, presence: 'OFFLINE' }), endpoint({ device_ref: DESKTOP })];
  for (const policy of [
    { v1_confirmation_required: 'yes' }, { v1_confirmation_required: 1 },
    { max_freshness_ms: Infinity }, { max_freshness_ms: 0 },
    { max_load: Infinity }, { max_load: 2 },
    { weights: { presence: 'high' } }, { cancel_authorized_states: [] }, 'nonsense',
  ]) {
    assert.equal(failure(() => routerWith(endpoints, policy).router).code, 'INVALID_REQUEST', `policy ${JSON.stringify(policy)}`);
  }
  const { router } = routerWith(endpoints);
  const proposal = router.proposeDeviceSwitch({ action_ref: 'action:1', interaction_device_ref: LAPTOP });
  assert.equal(proposal.requires_confirmation, true);
  assert.equal(failure(() => router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' })).code, 'CONFIRMATION_REQUIRED');
});

test('the approved endpoint must still be healthy at dispatch time', () => {
  const endpoints = [endpoint({ device_ref: DESKTOP })];
  const { router } = routerWith(endpoints);
  const proposal = remoteProposal(router);
  assert.equal(proposal.route, 'REMOTE_DEVICE');
  endpoints[0].presence = 'OFFLINE';
  endpoints[0].freshness_ms = 600000;
  const refused = failure(() => router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' }));
  assert.equal(refused.code, 'NO_HEALTHY_ENDPOINT');
  assert.equal(refused.dispatch_performed, false);
  assert.equal(refused.exclusion_reasons.includes('OFFLINE'), true);
  endpoints[0].presence = 'ONLINE';
  endpoints[0].freshness_ms = 1000;
  assert.equal(router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' }).dispatched, true, 'a healthy endpoint still dispatches');
});

test('a malformed caller instant is refused as a typed error', () => {
  const { router } = routerWith([endpoint({ device_ref: DESKTOP })]);
  for (const at of ['garbage', '2026-13-45T99:99:99Z', '2026-02-30T00:00:00Z', 123]) {
    assert.equal(failure(() => router.proposeDeviceSwitch({ action_ref: 'a', interaction_device_ref: LAPTOP, at })).code, 'INVALID_REQUEST', `propose at=${String(at)}`);
  }
  const proposal = remoteProposal(router);
  for (const at of ['garbage', '2026-13-45T99:99:99Z']) {
    assert.equal(failure(() => router.confirmProposal({ proposal_ref: proposal.proposal_ref, confirmed: true, at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1', at })).code, 'INVALID_REQUEST');
  }
  assert.equal(router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' }).dispatched, true);
  assert.equal(failure(() => router.recordEvent({ action_id: 'action:1', kind: 'STATUS', at: 'garbage' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => router.cancel({ action_id: 'action:1', by_device_ref: LAPTOP, at: 'garbage' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => router.raiseAttention({ action_id: 'action:1', question: 'q', at: 'garbage' })).code, 'INVALID_REQUEST');
  assert.equal(router.statusFor({ action_id: 'action:1' }).state, 'DISPATCHED', 'no refused call changed the action');

  const stagedRun = routerWith([endpoint({ device_ref: DESKTOP })]);
  const next = remoteProposal(stagedRun.router, 'action:2');
  const staged = stagedRun.router.dispatch({
    proposal_ref: next.proposal_ref, action_id: 'action:2',
    input_bundle_refs: [{ bundle_ref: 'bundle:1', staging_policy: 'DELETE_AFTER_USE', cleanup_by: '2026-13-45T99:99:99Z' }],
  });
  assert.equal(staged.staged_inputs[0].cleanup_by, null, 'an impossible cleanup deadline is not stored');
});

test('a settled action is not regressed by a late attention request', () => {
  const { router } = routerWith([endpoint({ device_ref: DESKTOP })]);
  const proposal = remoteProposal(router);
  router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' });
  router.recordEvent({ action_id: 'action:1', kind: 'FINAL', payload_ref: 'result:1' });
  assert.equal(router.statusFor({ action_id: 'action:1' }).state, 'SUCCEEDED');
  const refused = failure(() => router.raiseAttention({ action_id: 'action:1', question: 'still there?' }));
  assert.equal(refused.code, 'LATE_EVENT_AFTER_TERMINAL');
  assert.equal(refused.attention_raised, false);
  assert.equal(router.statusFor({ action_id: 'action:1' }).state, 'SUCCEEDED', 'the terminal truth stands');
  assert.equal(router.statusFor({ action_id: 'action:1' }).attention, null);
});

test('a cancellation event is terminal because the action is', () => {
  const { router } = routerWith([endpoint({ device_ref: DESKTOP })]);
  const proposal = remoteProposal(router);
  router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' });
  router.recordEvent({ action_id: 'action:1', kind: 'PROGRESS' });
  router.cancel({ action_id: 'action:1', by_device_ref: LAPTOP });
  const action = router.actions().find(entry => entry.action_id === 'action:1');
  const cancellationEvent = action.events.find(event => event.kind === 'CANCELLED');
  assert.equal(cancellationEvent.terminal, true, 'a cancelled action reports a terminal event');
  assert.equal(router.statusFor({ action_id: 'action:1' }).terminal, true);
});

test('a cyclic caller value cannot crash the freezer, and stored text is typed', () => {
  const { router } = routerWith([endpoint({ device_ref: DESKTOP })]);
  const proposal = router.proposeDeviceSwitch({ action_ref: 'a', interaction_device_ref: LAPTOP });
  const cycle = {};
  cycle.self = cycle;
  assert.equal(failure(() => router.confirmProposal({ proposal_ref: proposal.proposal_ref, confirmed: true, user_ref: cycle })).code, 'INVALID_REQUEST');
  router.confirmProposal({ proposal_ref: proposal.proposal_ref, confirmed: true });
  router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' });
  assert.equal(failure(() => router.recordEvent({ action_id: 'action:1', kind: 'STATUS', payload_ref: cycle })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => router.recordEvent({ action_id: 'action:1', kind: 'STATUS', text: cycle })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => router.cancel({ action_id: 'action:1', by_device_ref: LAPTOP, reason: cycle })).code, 'INVALID_REQUEST');
  assert.equal(router.statusFor({ action_id: 'action:1' }).state, 'DISPATCHED', 'no refused call changed the action');

  const weights = {};
  weights.nested = weights;
  assert.equal(failure(() => routerWith([endpoint({ device_ref: DESKTOP })], { weights }).router).code, 'INVALID_REQUEST', 'a cyclic policy value is refused, not recursed');
});

test('a non-boolean requirement cannot skip an exclusion', () => {
  const { router } = routerWith([endpoint({ device_ref: DESKTOP, input_locality_ok: false, session_available: false })]);
  assert.equal(failure(() => router.proposeDeviceSwitch({ action_ref: 'a', interaction_device_ref: LAPTOP, requirements: { requires_local_input: 1 } })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => router.proposeDeviceSwitch({ action_ref: 'a', interaction_device_ref: LAPTOP, requirements: { requires_session: 'true' } })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => router.proposeDeviceSwitch({ action_ref: 'a', interaction_device_ref: LAPTOP, requirements: { requires_local_input: true } })).code, 'NO_HEALTHY_ENDPOINT', 'the boolean still excludes an unsuitable endpoint');
});

test('a live action id cannot bypass the confirmation gates', () => {
  assert.equal(failure(() => routerWith([endpoint({ device_ref: DESKTOP })], { v1_confirmation_required: false }).router).code, 'INVALID_REQUEST', 'V1 confirmation is not a switch');

  const { router } = routerWith([endpoint({ device_ref: DESKTOP }), endpoint({ device_ref: TABLET, load: 0.5, freshness_ms: 2000 })]);
  const approved = remoteProposal(router, 'action:A');
  const deniedProposal = router.proposeDeviceSwitch({ action_ref: 'action:B', interaction_device_ref: LAPTOP });
  router.confirmProposal({ proposal_ref: deniedProposal.proposal_ref, confirmed: false });
  router.dispatch({ proposal_ref: approved.proposal_ref, action_id: 'shared' });

  const reused = failure(() => router.dispatch({ proposal_ref: deniedProposal.proposal_ref, action_id: 'shared' }));
  assert.equal(reused.code, 'PROPOSAL_NOT_CONFIRMED', 'a denied proposal is still denied when the action id exists');
  assert.equal(reused.dispatch_performed, false);

  const mismatched = failure(() => router.dispatch({ proposal_ref: approved.proposal_ref, action_id: 'shared', action_ref: 'action:OTHER' }));
  assert.equal(mismatched.code, 'DUPLICATE_DISPATCH', 'a different action reference is not the same action');
  assert.equal(mismatched.duplicate_dispatch, true);
  assert.equal(router.dispatch({ proposal_ref: approved.proposal_ref, action_id: 'shared' }).duplicate, true, 'the same proposal and reference is still absorbed');
});

test('an executor refusal is not recorded as a dispatch', () => {
  const { port } = portWith([endpoint({ device_ref: DESKTOP })]);
  port.dispatch = () => ({ accepted: false, receipt_ref: null, detail: 'executor refused' });
  const router = createRemoteExecutionRouter({ executionPort: port, clock: () => T0 });
  const proposal = remoteProposal(router);
  const refused = failure(() => router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' }));
  assert.equal(refused.code, 'INVALID_PORT');
  assert.equal(refused.executor_accepted, false);
  assert.equal(refused.dispatch_performed, false);
  assert.equal(router.actions().length, 0, 'no action was created for a refused dispatch');
  assert.equal(failure(() => router.statusFor({ action_id: 'action:1' })).code, 'UNKNOWN_ACTION');
});

test('a hardware-bound action stays addressable while it awaits the user', () => {
  const { router } = routerWith([endpoint({ device_ref: DESKTOP, hardware_auth_required: true })]);
  const proposal = remoteProposal(router);
  const dispatched = router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' });
  assert.equal(dispatched.attention_required, true);
  assert.equal(dispatched.actions_created_on_execution_host, 0, 'nothing executed on the host');
  const status = router.statusFor({ action_id: 'action:1' });
  assert.equal(status.state, 'AWAITING_USER');
  assert.equal(status.terminal, false);
  assert.equal(status.attention.attention_ref, dispatched.attention.attention_ref, 'the pending decision is addressable');
  assert.equal(status.execution_device_ref, DESKTOP);
});

test('a success carries its result, and an exact replay is not applied twice', () => {
  const { router } = routerWith([endpoint({ device_ref: DESKTOP })]);
  const proposal = remoteProposal(router);
  router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' });
  assert.equal(failure(() => router.recordEvent({ action_id: 'action:1', kind: 'FINAL' })).code, 'INVALID_REQUEST', 'a final without a result is not a success');
  assert.equal(router.statusFor({ action_id: 'action:1' }).state, 'DISPATCHED');

  const partial = router.recordEvent({ action_id: 'action:1', kind: 'PARTIAL', text: 'half' });
  const replay = router.recordEvent({ action_id: 'action:1', kind: 'PARTIAL', text: 'half' });
  assert.equal(partial.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.duplicate, true, 'an exact replay is suppressed');
  assert.equal(router.statusFor({ action_id: 'action:1' }).partial_refs.length, 1, 'the replay did not inflate the partial list');
  assert.equal(router.recordEvent({ action_id: 'action:1', kind: 'FINAL', payload_ref: 'result:1' }).state, 'SUCCEEDED');
});

test('a cancellation is only reported when the executor accepted it', () => {
  const { port } = portWith([endpoint({ device_ref: DESKTOP })]);
  port.cancel = () => ({ accepted: false, detail: 'past the cancellation point' });
  const router = createRemoteExecutionRouter({ executionPort: port, clock: () => T0 });
  const proposal = remoteProposal(router);
  router.dispatch({ proposal_ref: proposal.proposal_ref, action_id: 'action:1' });
  const refused = failure(() => router.cancel({ action_id: 'action:1', by_device_ref: LAPTOP }));
  assert.equal(refused.code, 'INVALID_PORT');
  assert.equal(refused.cancellation_performed, false);
  assert.equal(router.statusFor({ action_id: 'action:1' }).state, 'DISPATCHED', 'the action stays live');

  const strict = routerWith([endpoint({ device_ref: DESKTOP })], { cancel_authorized_states: ['RUNNING'] });
  const second = remoteProposal(strict.router, 'action:2');
  strict.router.dispatch({ proposal_ref: second.proposal_ref, action_id: 'action:2' });
  assert.equal(failure(() => strict.router.cancel({ action_id: 'action:2', by_device_ref: LAPTOP })).code, 'INVALID_REQUEST', 'the declared cancellation policy is enforced');
  strict.router.recordEvent({ action_id: 'action:2', kind: 'PROGRESS' });
  assert.equal(strict.router.cancel({ action_id: 'action:2', by_device_ref: LAPTOP }).state, 'CANCELLED');
});
