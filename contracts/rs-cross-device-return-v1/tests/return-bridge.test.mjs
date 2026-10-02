// RS-203 step 1 — return-bridge conformance.
//
// Written FIRST as the properties the bridge must hold, because every claim in the module comment
// is a claim that has to be executable. Covers the workbook's named review attacks that belong to
// this seam: duplicate messages, out-of-order progress, and a result that must not read as success
// when it cannot reach the user.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_STATES } from '../../general-ai-remote-execution-v1/remote-execution.mjs';
import { RETURN_CHANNELS } from '../../engineering-return-control-v1/return-control.mjs';
import {
  BRIDGE_CODES, CHANNEL_FOR_KIND, RETURN_BRIDGE_VERSION, ReturnBridgeError, STATE_FOR_KIND,
  createReturnBridge,
} from '../return-bridge.mjs';

const AT = '2026-10-02T00:00:00.000Z';
const surface = (ref) => ({ device_ref: ref, owner_ref: 'owner-1' });
const mk = (resolver = () => surface('device-interaction')) =>
  createReturnBridge({ resolveSurface: resolver, clock: () => AT });
const corr = (bridge, over = {}) =>
  bridge.register({ actionRef: 'action-1', interactionDeviceRef: 'device-interaction', executionDeviceRef: 'device-remote', ...over });

test('RS-203: the correlation carries BOTH devices and asserts that they may differ', () => {
  const bridge = mk();
  const record = corr(bridge);
  assert.equal(record.interaction_device_ref, 'device-interaction');
  assert.equal(record.execution_device_ref, 'device-remote');
  assert.equal(record.devices_differ, true);
  assert.equal(record.state, 'DISPATCHED');
});

test('RS-203: a handoff moves the execution device and never the interaction device', () => {
  const bridge = mk();
  corr(bridge);
  const moved = bridge.handoff({ actionRef: 'action-1', toExecutionDeviceRef: 'device-remote-2' });
  assert.equal(moved.execution_device_ref, 'device-remote-2');
  assert.equal(moved.interaction_device_ref, 'device-interaction');
  assert.equal(moved.interaction_device_unchanged, true);
  assert.equal(bridge.correlation('action-1').interaction_device_ref, 'device-interaction');
});

test('RS-203: DUPLICATE messages are ignored rather than applied twice', () => {
  const bridge = mk();
  corr(bridge);
  bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS' });
  const again = bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS' });
  assert.equal(again.applied, false);
  assert.equal(again.verdict, 'DUPLICATE_EVENT');
  assert.equal(bridge.correlation('action-1').applied_events, 1);
});

test('RS-203: OUT-OF-ORDER progress is refused and cannot move the state backwards', () => {
  const bridge = mk();
  corr(bridge);
  bridge.apply({ actionRef: 'action-1', sequence: 5, kind: 'PROGRESS' });
  const stale = bridge.apply({ actionRef: 'action-1', sequence: 3, kind: 'PROGRESS' });
  assert.equal(stale.applied, false);
  assert.equal(stale.verdict, 'OUT_OF_ORDER');
  assert.equal(stale.canonical_state, 'RUNNING');
});

test('RS-203: an event after a terminal state is LATE and does not resurrect the run', () => {
  const bridge = mk();
  corr(bridge);
  bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'FINAL' });
  assert.equal(bridge.correlation('action-1').state, 'SUCCEEDED');
  const late = bridge.apply({ actionRef: 'action-1', sequence: 2, kind: 'PROGRESS' });
  assert.equal(late.applied, false);
  assert.equal(late.verdict, 'LATE_EVENT_AFTER_TERMINAL');
  assert.equal(late.canonical_state, 'SUCCEEDED');
});

test('RS-203: every kind maps to a DECLARED canonical state and a DECLARED return channel', () => {
  for (const [kind, state] of Object.entries(STATE_FOR_KIND)) {
    if (state !== null) assert.ok(ACTION_STATES.includes(state), `${kind} -> ${state} is not a declared ACTION_STATE`);
    assert.ok(RETURN_CHANNELS.includes(CHANNEL_FOR_KIND[kind]), `${kind} -> ${CHANNEL_FOR_KIND[kind]} is not a declared RETURN_CHANNEL`);
  }
});

test('RS-203: canonical state advances for each terminal kind, and terminal is sticky', () => {
  for (const [kind, expected] of [['FINAL', 'SUCCEEDED'], ['ERROR', 'FAILED'], ['CANCELLED', 'CANCELLED']]) {
    const bridge = mk();
    corr(bridge);
    const out = bridge.apply({ actionRef: 'action-1', sequence: 1, kind });
    assert.equal(out.canonical_state, expected);
    assert.equal(out.terminal, true);
  }
});

test('RS-203: a result that CANNOT reach the user is never reported as truthful success', () => {
  const bridge = mk(() => null);            // no authorized surface available
  corr(bridge);
  const out = bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'FINAL' });
  assert.equal(out.canonical_state, 'SUCCEEDED');   // the run really did finish
  assert.equal(out.projection, 'UNKNOWN');          // but nobody was told
  assert.equal(out.truthful_success, false);        // and it must NOT read as success
});

test('RS-203: a resolver that THROWS degrades rather than propagating into the caller', () => {
  const bridge = mk(() => { throw new Error('surface registry unavailable'); });
  corr(bridge);
  const out = bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'FINAL' });
  assert.equal(out.projection, 'DEGRADED');
  assert.equal(out.truthful_success, false);
  assert.equal(out.projected_to, null);
});

test('RS-203: a projected success reports where it landed', () => {
  const bridge = mk();
  corr(bridge);
  const out = bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'FINAL' });
  assert.equal(out.projection, 'PROJECTED');
  assert.equal(out.projected_to, 'device-interaction');
  assert.equal(out.truthful_success, true);
});

test('RS-203: unknown correlations, unknown kinds and bad sequences are refused with typed codes', () => {
  const bridge = mk();
  assert.throws(() => bridge.apply({ actionRef: 'nope', sequence: 1, kind: 'FINAL' }), (e) => e instanceof ReturnBridgeError && e.code === 'UNKNOWN_CORRELATION');
  corr(bridge);
  assert.throws(() => bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'NOPE' }), (e) => e.code === 'UNKNOWN_EVENT_KIND');
  assert.throws(() => bridge.apply({ actionRef: 'action-1', sequence: -1, kind: 'FINAL' }), (e) => e.code === 'INVALID_REQUEST');
  assert.throws(() => corr(bridge), (e) => e.code === 'DUPLICATE_CORRELATION');
  assert.ok(BRIDGE_CODES.includes('OUT_OF_ORDER') && BRIDGE_CODES.includes('LATE_EVENT_AFTER_TERMINAL'));
});

test('RS-203: the bridge refuses to be constructed without an injected surface resolver', () => {
  assert.throws(() => createReturnBridge({}), (e) => e.code === 'INVALID_SURFACE_RESOLVER');
  assert.throws(() => createReturnBridge({ resolveSurface: () => null, clock: 5 }), (e) => e.code === 'INVALID_CLOCK');
});

test('RS-203: a STATUS event reports without moving the state', () => {
  const bridge = mk();
  corr(bridge);
  const out = bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'STATUS' });
  assert.equal(out.applied, true);
  assert.equal(out.state_changed, false);
  assert.equal(out.canonical_state, 'DISPATCHED');
  assert.equal(out.channel, 'STATE');
});

test('RS-203: the contract version is declared', () => {
  assert.equal(RETURN_BRIDGE_VERSION, 1);
});
