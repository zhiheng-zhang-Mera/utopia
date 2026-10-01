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
 createRemoteSubworkerBridge, isIsoInstant, resolveInteractionSurface
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

/* ------------------------------------------------ Alien Correction regressions
   Every test below fails against the Development head and passes against the corrected head. */

test('the return path can only move onto a surface this module resolved for the same owner', () => {
  const { bridge } = dispatched();
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'RESULT', payload: { secret: 'user-data' } },
    { interactionSurface: { interaction_device_ref: 'device-stranger', authorised_device_refs: ['device-stranger'] } }), 'UNAUTHORIZED_INTERACTION_DEVICE');
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'ATTENTION' },
    { interactionSurface: { interaction_device_ref: 'device:attacker' } }), 'UNAUTHORIZED_INTERACTION_DEVICE');
  const otherOwner = resolveInteractionSurface({ ownerRef: 'owner-2', devices: [{ device_ref: 'device-elsewhere', authorized: true, online: true, is_current: true }] });
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'LOG' }, { interactionSurface: otherOwner }), 'OWNER_CHANGE_FORBIDDEN');
  const empty = resolveInteractionSurface({ ownerRef: 'owner-1', devices: [{ device_ref: 'device-stranger', authorized: false, online: true, is_current: true }] });
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'LOG' }, { interactionSurface: empty }), 'UNAUTHORIZED_INTERACTION_DEVICE');
  assert.equal(bridge.status('job-1').interaction_device_ref, 'device-phone', 'no refused surface moved the delivery target');
  assert.equal(bridge.status('job-1').applied_returns, 0, 'no event was applied while refusing surfaces');
  const moved = resolveInteractionSurface({ ownerRef: 'owner-1', devices: [{ device_ref: 'device-tablet', authorized: true, online: true, is_current: true }] });
  const returned = bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'LOG' }, { interactionSurface: moved });
  assert.equal(returned.returned.delivered_to_device_ref, 'device-tablet', 'a genuinely resolved new surface still receives the run');
  assert.deepEqual(bridge.status('job-1').interaction_device_ref, 'device-tablet');
});

test('a dispatch validates the executor reference and the capability list', () => {
  const { bridge, surface } = setup();
  expectCode(() => bridge.dispatch({ job: job(), proposal: proposal(), interactionSurface: surface }), 'INVALID_REQUEST');
  expectCode(() => bridge.dispatch({ job: { job_ref: 'job-2', owner_ref: 'owner-1', required_capabilities: 'FILESYSTEM' }, proposal: proposal({ job_ref: 'job-2' }), executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'INVALID_REQUEST');
  expectCode(() => bridge.dispatch({ job: { job_ref: 'job-3', owner_ref: 'owner-1', required_capabilities: ['FILESYSTEM', 7] }, proposal: proposal({ job_ref: 'job-3' }), executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'INVALID_REQUEST');
  // a host that names no device cannot be selected by an absent reference either
  const ghostPort = createRemoteExecutionPortDouble({ hosts: [{ capability_refs: ['FILESYSTEM'] }] });
  const ghostBridge = createRemoteSubworkerBridge({ port: ghostPort, clock: () => TS });
  expectCode(() => ghostBridge.dispatch({ job: job(), proposal: proposal(), interactionSurface: surface }), 'INVALID_REQUEST');
  assert.equal(bridge.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop', interactionSurface: surface }).executor_kind, 'REMOTE');
});

test('the bridge itself refuses a second dispatch and keeps the run ledger', () => {
  const calls = [];
  const permissive = {
    listEligibleRemoteHosts: () => [{ host_ref: 'device-desktop', device_ref: 'device-desktop' }],
    dispatch: payload => { calls.push(payload); return { job_ref: payload.job_ref, dispatched: true }; },
    control: () => ({ accepted: true }),
    respond: () => ({ accepted: true }),
  };
  const bridge = createRemoteSubworkerBridge({ port: permissive, clock: () => TS });
  const surface = resolveInteractionSurface({ ownerRef: 'owner-1', devices: devices() });
  const record = bridge.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop', interactionSurface: surface });
  assert.equal(record.last_sequence, 0);
  assert.equal(bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 9, channel: 'PROGRESS' }).applied, true);
  expectCode(() => bridge.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'DUPLICATE_EXECUTION');
  assert.equal(calls.length, 1, 'the port was never asked to execute the job twice');
  assert.equal(bridge.status('job-1').applied_returns, 1, 'the live ledger survived the refused re-dispatch');
  const replay = bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 9, channel: 'PROGRESS' });
  assert.equal(replay.applied, false, 'the sequence space was not reopened');
  assert.equal(replay.reason, 'STALE_EVENT');
});

test('an execution port that refuses is never reported as success', () => {
  const surface = resolveInteractionSurface({ ownerRef: 'owner-1', devices: devices() });
  const refusingDispatch = {
    listEligibleRemoteHosts: () => [{ host_ref: 'device-desktop' }],
    dispatch: () => ({ dispatched: false, reason: 'HOST_REJECTED' }),
    control: () => ({ accepted: true }),
    respond: () => ({ accepted: true }),
  };
  const refused = createRemoteSubworkerBridge({ port: refusingDispatch, clock: () => TS });
  expectCode(() => refused.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'DUPLICATE_EXECUTION');
  expectCode(() => refused.status('job-1'), 'UNKNOWN_JOB');
  const refusingControl = {
    listEligibleRemoteHosts: () => [{ host_ref: 'device-desktop' }],
    dispatch: () => ({ dispatched: true }),
    control: () => ({ accepted: false, reason: 'EXECUTOR_GONE' }),
    respond: () => ({ accepted: false, reason: 'EXECUTOR_GONE' }),
  };
  const gone = createRemoteSubworkerBridge({ port: refusingControl, clock: () => TS });
  gone.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop', interactionSurface: surface });
  expectCode(() => gone.applyControl('job-1', { command: 'PAUSE', fromDeviceRef: 'device-phone', commandId: 'c-1' }), 'CONTROL_ALREADY_APPLIED');
  assert.equal(gone.status('job-1').control_applied, 0, 'a control the executor refused is not recorded as applied');
  expectCode(() => gone.applyControl('job-1', { command: 'RESPOND', fromDeviceRef: 'device-phone', commandId: 'c-2', attentionId: 'attention-1', response: { decision: 'ALLOW' } }), 'CONTROL_ALREADY_APPLIED');
});

test('an attention reply reaches the originating worker through the respond path', () => {
  const { bridge, port } = dispatched();
  assert.ok(Array.isArray(port.__responses), 'the port double records replies');
  const reply = bridge.applyControl('job-1', { command: 'RESPOND', fromDeviceRef: 'device-phone', commandId: 'reply-1', attentionId: 'attention-7', response: { decision: 'ALLOW' } });
  assert.equal(reply.applied, true);
  assert.deepEqual(port.__responses.map(entry => [entry.job_ref, entry.attention_id, entry.response]), [['job-1', 'attention-7', { decision: 'ALLOW' }]]);
  assert.equal(port.__controls.length, 0, 'a reply is a reply, not a bare control command');
  expectCode(() => bridge.applyControl('job-1', { command: 'RESPOND', fromDeviceRef: 'device-phone', commandId: 'reply-2', attentionId: 'attention-7' }), 'INVALID_REQUEST');
  expectCode(() => bridge.applyControl('job-1', { command: 'RESPOND', fromDeviceRef: 'device-phone', commandId: 'reply-3', response: { decision: 'DENY' } }), 'INVALID_REQUEST');
  assert.equal(port.__responses.length, 1, 'the malformed replies were refused before reaching the worker');
});

test('a control command without an idempotency key is refused rather than swallowed', () => {
  const { bridge, port } = dispatched();
  expectCode(() => bridge.applyControl('job-1', { command: 'PAUSE', fromDeviceRef: 'device-phone' }), 'INVALID_REQUEST');
  assert.equal(port.__controls.length, 0, 'nothing reached the executor');
  bridge.applyControl('job-1', { command: 'PAUSE', fromDeviceRef: 'device-phone', commandId: 'c-1' });
  const different = bridge.applyControl('job-1', { command: 'CANCEL', fromDeviceRef: 'device-phone', commandId: 'c-2' });
  assert.equal(different.applied, true, 'a distinct command is not an idempotent replay');
  assert.deepEqual(port.__controls.map(entry => entry.command), ['PAUSE', 'CANCEL']);
});

test('an untransferable remote payload is refused without consuming its sequence', () => {
  const { bridge } = dispatched();
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 7, channel: 'LOG', payload: { fn: () => 1 } }), 'INVALID_ENVELOPE');
  const applied = bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 7, channel: 'LOG', payload: { ok: true } });
  assert.equal(applied.applied, true, 'the refused event did not consume the sequence');
  assert.equal(bridge.status('job-1').applied_returns, 1);
  assert.equal(bridge.status('job-1').stale_or_duplicate, 0);
});

test('a physical-action block is observable and blocks a fabricated success', () => {
  const { bridge } = dispatched();
  bridge.recordPhysicalActionRequired('job-1', { detail: 'plug the device in' });
  assert.equal(bridge.status('job-1').blocking_state, 'PHYSICAL_ACTION_REQUIRED');
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'RESULT', payload: { status: 'SUCCEEDED' } }), 'PHYSICAL_ACTION_CANNOT_SUCCEED');
  assert.equal(bridge.status('job-1').applied_returns, 1, 'only the blocker is recorded');
  assert.equal(bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'LOG', payload: { line: 'blocked' } }).applied, true, 'the run still reports progress while blocked');
});

test('recording instants are validated rather than stored as given', () => {
  const { bridge } = dispatched();
  assert.equal(isIsoInstant('2026-09-30T12:00:00.000Z'), true);
  assert.equal(isIsoInstant('2026-13-45T99:99:99Z'), false, 'an unparseable instant is not an instant');
  assert.equal(isIsoInstant(12345), false);
  // a shape-valid, parseable but calendar-impossible instant is refused where it would be recorded
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'LOG' }, { at: '2026-02-30T00:00:00Z' }), 'INVALID_REQUEST');
  expectCode(() => bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'LOG' }, { at: '2026-13-45T99:99:99Z' }), 'INVALID_REQUEST');
  expectCode(() => bridge.recordPhysicalActionRequired('job-1', { detail: 'x', at: 'not-an-instant' }), 'INVALID_REQUEST');
  expectCode(() => bridge.applyControl('job-1', { command: 'PAUSE', fromDeviceRef: 'device-phone', commandId: 'c-1', at: 12345 }), 'INVALID_REQUEST');
  assert.equal(bridge.status('job-1').applied_returns, 0);
  assert.equal(bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'LOG' }).returned.at, TS, 'the injected clock instant is still recorded');
});

test('the approval gate reads the proposal itself, not its prototype', () => {
  const { bridge, surface } = setup();
  const ghost = Object.create({ job_ref: 'job-1', owner_ref: 'owner-1', status: 'APPROVED' });
  expectCode(() => bridge.dispatch({ job: job(), proposal: ghost, executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'APPROVED_PROPOSAL_REQUIRED');
  class Fabricated { constructor() { this.job_ref = 'job-1'; this.owner_ref = 'owner-1'; this.status = 'APPROVED'; } }
  expectCode(() => bridge.dispatch({ job: job(), proposal: new Fabricated(), executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'APPROVED_PROPOSAL_REQUIRED');
  // an approval that does not name an owner cannot be checked against the job's owner, so it is not an approval
  expectCode(() => bridge.dispatch({ job: job(), proposal: { job_ref: 'job-1', status: 'APPROVED' }, executionDeviceRef: 'device-desktop', interactionSurface: surface }), 'APPROVED_PROPOSAL_REQUIRED');
  assert.equal(bridge.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop', interactionSurface: surface }).executor_kind, 'REMOTE', 'a real plain approved proposal still dispatches');
});

test('a refused replay does not move where the run returns are delivered', () => {
  const { bridge } = dispatched();
  bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 5, channel: 'PROGRESS', payload: {} });
  const moved = resolveInteractionSurface({ ownerRef: 'owner-1', devices: [{ device_ref: 'device-tablet', authorized: true, online: true, is_current: true }] });
  const stale = bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 5, channel: 'PROGRESS', payload: {} }, { interactionSurface: moved });
  assert.equal(stale.applied, false);
  assert.equal(bridge.status('job-1').interaction_device_ref, 'device-phone', 'a refused replay moved nothing');
  const applied = bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 6, channel: 'PROGRESS', payload: {} }, { interactionSurface: moved });
  assert.equal(applied.returned.delivered_to_device_ref, 'device-tablet', 'the next applied event carries the move');
});

test('an envelope field is validated and used exactly once', () => {
  const { bridge } = dispatched();
  let originReads = 0;
  const twoFaced = { sequence: 1, channel: 'LOG', payload: { ok: true } };
  Object.defineProperty(twoFaced, 'origin_device_ref', { enumerable: true, configurable: true, get() { originReads += 1; return originReads === 1 ? 'device-desktop' : 'device-elsewhere'; } });
  const applied = bridge.applyRemoteEvent('job-1', twoFaced);
  assert.equal(applied.applied, true);
  assert.equal(applied.returned.origin_device_ref, 'device-desktop', 'the validated origin is the projected origin');
  assert.equal(originReads, 1, 'the origin is read once');
  let channelReads = 0;
  const shifting = { origin_device_ref: 'device-desktop', sequence: 2, payload: { ok: true } };
  Object.defineProperty(shifting, 'channel', { enumerable: true, configurable: true, get() { channelReads += 1; return channelReads === 1 ? 'LOG' : 'TELEPATHY'; } });
  assert.equal(bridge.applyRemoteEvent('job-1', shifting).returned.channel, 'LOG');
  assert.equal(channelReads, 1, 'the channel is read once');
  expectCode(() => bridge.applyRemoteEvent('job-1', 'not-an-envelope'), 'INVALID_ENVELOPE');
});

test('a device field is validated and projected exactly once', () => {
  let reads = 0;
  const shifty = { authorized: true, online: true, is_current: true, last_interacted_at: TS };
  Object.defineProperty(shifty, 'device_ref', { enumerable: true, configurable: true, get() { reads += 1; return reads === 1 ? 'device-phone' : 'device:attacker'; } });
  const resolved = resolveInteractionSurface({ ownerRef: 'owner-1', devices: [shifty] });
  assert.equal(resolved.interaction_device_ref, 'device-phone', 'the checked device reference is the resolved one');
  assert.deepEqual([...resolved.authorised_device_refs], ['device-phone']);
  assert.equal(reads, 1, 'the device reference is read once');
});

test('context staging enforces the bound and the cleanup policy it advertises', () => {
  const { bridge } = dispatched();
  const entries = Array.from({ length: 65 }, (_, index) => ({ ref: `ref-${index}`, digest: DIGEST }));
  expectCode(() => bridge.stageContext('job-1', { entries }), 'INVALID_REQUEST');
  const atBound = bridge.stageContext('job-1', { entries: entries.slice(0, 64) });
  assert.equal(atBound.staged.length, 64);
  assert.equal(atBound.max_entries, 64, 'the advertised bound is the enforced bound');
  expectCode(() => bridge.stageContext('job-1', { entries: [{ ref: 'r', digest: DIGEST, cleanup: 'FOREVER' }] }), 'INVALID_REQUEST');
  expectCode(() => bridge.stageContext('job-1', { entries: 'nope' }), 'INVALID_REQUEST');
  assert.equal(bridge.stageContext('job-1', { entries: [{ ref: 'r', digest: DIGEST, cleanup: 'AFTER_CANCEL' }] }).staged[0].cleanup, 'AFTER_CANCEL');
});

test('a return that reaches nobody is not normal remote-free operation', () => {
  const port = createRemoteExecutionPortDouble({ hosts: [{ host_ref: 'device-desktop', device_ref: 'device-desktop', capability_refs: ['FILESYSTEM'] }] });
  const bridge = createRemoteSubworkerBridge({ port, clock: () => TS });
  bridge.dispatch({ job: job(), proposal: proposal(), executionDeviceRef: 'device-desktop' });
  assert.equal(bridge.status('job-1').interaction_device_ref, null, 'no surface was supplied');
  bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'ATTENTION', payload: { question: 'approve?' } });
  expectCode(() => bridge.assertNoRemoteHostInteraction('job-1'), 'REMOTE_HOST_INTERACTION_REQUIRED');
  // and a surface that moves mid-run does not retroactively make earlier attention remote-bound
  const second = dispatched();
  second.bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 1, channel: 'ATTENTION', payload: { question: 'approve?' } });
  const moved = resolveInteractionSurface({ ownerRef: 'owner-1', devices: [{ device_ref: 'device-tablet', authorized: true, online: true, is_current: true }] });
  second.bridge.applyRemoteEvent('job-1', { origin_device_ref: 'device-desktop', sequence: 2, channel: 'PROGRESS', payload: {} }, { interactionSurface: moved });
  assert.equal(second.bridge.assertNoRemoteHostInteraction('job-1').normal_operation_remote_free, true);
});

test('a surface is resolved only from devices belonging to that owner', () => {
  const mixed = resolveInteractionSurface({ ownerRef: 'owner-1', devices: [
    { device_ref: 'device-elsewhere', owner_ref: 'owner-2', authorized: true, online: true, is_current: true, last_interacted_at: TS },
    { device_ref: 'device-phone', owner_ref: 'owner-1', authorized: true, online: true, is_current: false, last_interacted_at: TS },
  ] });
  assert.equal(mixed.interaction_device_ref, 'device-phone', 'another owner\'s device is not this owner\'s surface');
  assert.deepEqual([...mixed.authorised_device_refs], ['device-phone']);
  const unowned = resolveInteractionSurface({ ownerRef: 'owner-1', devices: [{ device_ref: 'device-phone', authorized: true, online: true, is_current: true }] });
  assert.equal(unowned.interaction_device_ref, 'device-phone', 'a device that declares no owner is still usable');
  expectCode(() => resolveInteractionSurface({ ownerRef: 'owner-1', devices: 'nope' }), 'INVALID_REQUEST');
});
