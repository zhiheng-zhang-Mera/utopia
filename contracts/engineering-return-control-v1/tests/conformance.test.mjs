// EM-007 conformance suite — remote Sub-worker execution and automatic return/control.
//
// Acceptance: an approved fallback is required before dispatch; the remote host becomes executor only and
// the logical owner is preserved; state/progress/logs/attention/result/artifact all return to the user's
// current authorised interaction surface; control from any authorised device is forwarded idempotently;
// stale and duplicate remote events are reconciled; and normal operation never requires operating the
// remote host or remote-desktop video.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 CONTROL_COMMANDS, ENGINEERING_REMOTE_EXECUTION_PORT, ENGINEERING_RETURN_CONTROL_CONTRACT,
 RETURN_CHANNELS, RETURN_CONTROL_CODES, ReturnControlError, createRemoteExecutionPortDouble,
 createRemoteSubworkerBridge, resolveInteractionSurface
} from '../index.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const DIGEST = 'sha256:' + 'a'.repeat(64);
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const devices = () => [
  { device_ref: 'device-phone', authorized: true, online: true, is_current: true, last_interacted_at: TS },
  { device_ref: 'device-tablet', authorized: true, online: true, is_current: false, last_interacted_at: TS },
  { device_ref: 'device-stranger', authorized: false, online: true, is_current: false, last_interacted_at: TS },
];
const job = () => ({ job_ref: 'job-1', owner_ref: 'owner-1', required_capabilities: ['FILESYSTEM'] });
const proposal = (overrides = {}) => ({ job_ref: 'job-1', owner_ref: 'owner-1', status: 'APPROVED', requires_user_approval: true, ...overrides });

const setup = ({ script = [] } = {}) => {
  const port = createRemoteExecutionPortDouble({
    hosts: [{ host_ref: 'device-desktop', device_ref: 'device-desktop', capability_refs: ['FILESYSTEM'] }, { host_ref: 'device-weak', device_ref: 'device-weak', capability_refs: [] }],
    script,
  });
  const bridge = createRemoteSubworkerBridge({ port, clock: () => TS });
  const surface = resolveInteractionSurface({ ownerRef: 'owner-1', devices: devices() });
  return { port, bridge, surface };
};

const dispatched = () => {
  const context = setup();
  context.dispatched = context.bridge.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop', interactionSurface: context.surface });
  return context;
};

/* ------------------------------------------------ 1. approval and eligibility */

test('a remote dispatch needs an approved proposal and an eligible host', () => {
  const { bridge, surface } = setup();
  expectCode(() => bridge.dispatch({ job: job(), proposal: null, executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'APPROVED_PROPOSAL_REQUIRED');
  expectCode(() => bridge.dispatch({ job: job(), proposal: proposal({ status: 'PROPOSED' }), executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'APPROVED_PROPOSAL_REQUIRED');
  expectCode(() => bridge.dispatch({ job: job(), proposal: proposal({ job_ref: 'job-9' }), executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'APPROVED_PROPOSAL_REQUIRED');
  // a host that does not satisfy the required capabilities is refused
  expectCode(() => bridge.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-weak', interactionSurface: surface }), 'INELIGIBLE_REMOTE_HOST');
  // a proposal may not smuggle an owner change
  expectCode(() => bridge.dispatch({ job: job(), proposal: proposal({ owner_ref: 'owner-2' }), executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'OWNER_CHANGE_FORBIDDEN');
  const record = bridge.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop', interactionSurface: surface });
  assert.equal(record.executor_kind, 'REMOTE');
  assert.equal(record.owner_ref, 'owner-1');
  assert.equal(record.owner_preserved, true, 'the remote host is the executor, not the owner');
  assert.equal(record.execution_device_ref, 'device-desktop');
  assert.equal(record.interaction_device_ref, 'device-phone');
  expectCode(() => createRemoteSubworkerBridge({}), 'PORT_REQUIRED');
});

/* ------------------------------------------------ 2. the return path */

test('every channel returns to the current interaction surface, not to the execution device', () => {
  const { bridge } = dispatched();
  const channels = ['STATE', 'STAGE', 'PROGRESS', 'EVENT', 'LOG', 'ATTENTION', 'RESULT', 'ARTIFACT'];
  let sequence = 0;
  for (const channel of channels) {
    sequence += 1;
    const outcome = bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence, channel, payload: { channel } });
    assert.equal(outcome.applied, true, channel);
    assert.equal(outcome.returned.delivered_to_device_ref, 'device-phone', channel);
    assert.equal(outcome.returned.origin_device_ref, 'device-desktop', channel);
    assert.equal(outcome.returned.requires_remote_host_interaction, false, channel);
    assert.equal(outcome.returned.owner_ref, 'owner-1', channel);
  }
  assert.deepEqual([...RETURN_CHANNELS], channels);
  assert.equal(bridge.assertNoRemoteHostInteraction('job-1').normal_operation_remote_free, true);
  // an event claiming another origin is refused
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-elsewhere', sequence: 99, channel: 'LOG' }), 'INVALID_ENVELOPE');
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 99, channel: 'TELEPATHY' }), 'INVALID_ENVELOPE');
  expectCode(() => bridge.applyRemoteEvent('job-1', { sequence: 99, channel: 'LOG' }), 'INVALID_ENVELOPE');
  assert.equal(ENGINEERING_RETURN_CONTROL_CONTRACT.every_channel_returns, true);
});

test('the control plane follows the user when they move to another surface', () => {
  const { bridge, surface } = dispatched();
  assert.equal(bridge.status('job-1').interaction_device_ref, 'device-phone');
  // the user picks up the tablet mid-run
  const moved = resolveInteractionSurface({ ownerRef: 'owner-1', devices: [{ device_ref: 'device-tablet', authorized: true, online: true, is_current: true }, { device_ref: 'device-phone', authorized: true, online: true, is_current: false, last_interacted_at: '2026-09-30T11:00:00.000Z' }] });
  assert.equal(moved.interaction_device_ref, 'device-tablet');
  const outcome = bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'PROGRESS', payload: { percent: 40 } }, { interactionSurface: moved });
  assert.equal(outcome.returned.delivered_to_device_ref, 'device-tablet', 'the new surface receives the rest of the run');
  assert.equal(bridge.status('job-1').interaction_device_ref, 'device-tablet');
  assert.equal(bridge.status('job-1').execution_device_ref, 'device-desktop', 'execution did not move with the user');
  assert.equal(ENGINEERING_RETURN_CONTROL_CONTRACT.control_plane, 'FOLLOWS_THE_USER');
  // an unauthorised device never becomes the surface
  // two devices claiming the current surface is refused rather than resolved by ordering
  expectCode(() => resolveInteractionSurface({ ownerRef: 'owner-1', devices: [{ device_ref: 'device-a', authorized: true, online: true, is_current: true }, { device_ref: 'device-b', authorized: true, online: true, is_current: true }] }), 'INVALID_REQUEST');
  const unauthorised = resolveInteractionSurface({ ownerRef: 'owner-1', devices: [{ device_ref: 'device-stranger', authorized: false, online: true, is_current: true }] });
  assert.equal(unauthorised.interaction_device_ref, null);
  assert.equal(unauthorised.resolved_from, 'NONE');
  expectCode(() => resolveInteractionSurface({}), 'INVALID_REQUEST');
});

test('stale and duplicate remote events are reconciled instead of re-applied', () => {
  const { bridge } = dispatched();
  assert.equal(bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 2, channel: 'PROGRESS' }).applied, true);
  const duplicate = bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 2, channel: 'PROGRESS' });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reason, 'STALE_EVENT');
  const late = bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'LOG' });
  assert.equal(late.applied, false);
  assert.equal(late.reason, 'STALE_EVENT');
  assert.equal(bridge.status('job-1').applied_returns, 1);
  assert.equal(bridge.status('job-1').stale_or_duplicate, 2);
  // a duplicate dispatch attempt is refused rather than producing a second execution
  expectCode(() => bridge.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop', interactionSurface: bridge.status('job-1') && { interaction_device_ref: 'device-phone', authorised_device_refs: ['device-phone', 'device-tablet'] } }), 'DUPLICATE_EXECUTION');
  expectCode(() => bridge.status('job-missing'), 'UNKNOWN_JOB');
  assert.equal(ENGINEERING_RETURN_CONTROL_CONTRACT.remote_host_is_new_owner, false);
});

/* ------------------------------------------------ 3. control and blockers */

test('control is forwarded from any authorised device and applied once', () => {
  const { bridge, port } = dispatched();
  const fromTablet = bridge.applyControl('job-1', { command: 'PAUSE', fromDeviceRef: 'device-tablet', commandId: 'command-1' });
  assert.equal(fromTablet.applied, true);
  assert.equal(fromTablet.delivered_to_executor, 'device-desktop');
  assert.equal(fromTablet.owner_preserved, true);
  assert.deepEqual(port.__controls, [{ job_ref: 'job-1', command: 'PAUSE' }]);
  // a duplicate command id is idempotent
  const again = bridge.applyControl('job-1', { command: 'PAUSE', fromDeviceRef: 'device-tablet', commandId: 'command-1' });
  assert.equal(again.applied, false);
  assert.equal(again.idempotent, true);
  assert.equal(port.__controls.length, 1);
  // an unauthorised device cannot control the run
  expectCode(() => bridge.applyControl('job-1', { command: 'CANCEL', fromDeviceRef: 'device-stranger', commandId: 'command-2' }), 'UNAUTHORIZED_INTERACTION_DEVICE');
  expectCode(() => bridge.applyControl('job-1', { command: 'REBOOT', fromDeviceRef: 'device-phone', commandId: 'command-3' }), 'INVALID_REQUEST');
  assert.deepEqual([...CONTROL_COMMANDS], ['PAUSE', 'RESUME', 'CANCEL', 'RESPOND']);
  // the control acknowledgement itself returns to the interaction surface
  assert.equal(bridge.status('job-1').interaction_device_ref, 'device-phone');
});

test('a hardware-bound action is a typed blocker, never a fabricated success', () => {
  const { bridge } = dispatched();
  const blocker = bridge.recordPhysicalActionRequired('job-1', { detail: 'the device must be plugged in' });
  assert.equal(blocker.payload.blocking_state, 'PHYSICAL_ACTION_REQUIRED');
  assert.equal(blocker.payload.fabricated_success, false);
  assert.equal(blocker.delivered_to_device_ref, 'device-phone', 'even the blocker returns to the user');
  assert.equal(blocker.requires_remote_host_interaction, false);
  assert.equal(ENGINEERING_RETURN_CONTROL_CONTRACT.hardware_bound_action_is_typed_blocker, true);
  assert.equal(ENGINEERING_RETURN_CONTROL_CONTRACT.requires_remote_desktop_video, false);
  assert.equal(ENGINEERING_RETURN_CONTROL_CONTRACT.requires_walking_to_the_remote_host, false);
});

test('context is staged semantically, and the port contract owns trust and transport elsewhere', () => {
  const { bridge } = dispatched();
  const staged = bridge.stageContext('job-1', { entries: [{ ref: 'repo-1', digest: DIGEST }, { ref: 'context-1', digest: DIGEST, cleanup: 'AFTER_CANCEL' }] });
  assert.equal(staged.staged.length, 2);
  assert.equal(staged.opaque_bulk_transfer, false);
  assert.equal(staged.staged[0].cleanup, 'AFTER_RESULT');
  assert.equal(staged.staged[1].cleanup, 'AFTER_CANCEL');
  expectCode(() => bridge.stageContext('job-1', { entries: [{ ref: 'repo-1', digest: 'not-a-digest' }] }), 'INVALID_REQUEST');
  expectCode(() => bridge.stageContext('job-1', { entries: [{ digest: DIGEST }] }), 'INVALID_REQUEST');
  assert.equal(ENGINEERING_REMOTE_EXECUTION_PORT.owns_node_trust, false);
  assert.equal(ENGINEERING_REMOTE_EXECUTION_PORT.owns_transport, false);
  assert.equal(ENGINEERING_REMOTE_EXECUTION_PORT.owns_device_identity, false);
  assert.equal(ENGINEERING_REMOTE_EXECUTION_PORT.adapts_remote_fabric_public_api, true);
  assert.equal(ENGINEERING_RETURN_CONTROL_CONTRACT.remote_dispatch_requires_approved_proposal, true);
  assert.equal(new Set(RETURN_CONTROL_CODES).size, RETURN_CONTROL_CODES.length);
  assert.equal(new ReturnControlError('X', 'y').status, 409);
});
