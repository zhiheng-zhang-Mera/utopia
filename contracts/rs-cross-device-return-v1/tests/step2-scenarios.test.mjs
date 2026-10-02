// RS-203 step 2 — the eight lifecycle situations the workbook names, as an executable scenario
// suite rather than a description: remote start, progress, waiting for user, success, failure,
// cancel, device disconnect, recovery.
//
// Each scenario drives the bridge through the ACTUAL sequence a remote run produces, so a reader
// can see the whole walk rather than isolated assertions.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createReturnBridge, REMOTE_STATES } from '../return-bridge.mjs';

const AT = '2026-10-02T00:00:00.000Z';
const mk = (resolver = () => ({ device_ref: 'device-interaction' })) =>
  createReturnBridge({ resolveSurface: resolver, clock: () => AT });
const start = (bridge) => bridge.register({
  actionRef: 'action-1', interactionDeviceRef: 'device-interaction',
  executionDeviceRef: 'device-remote', ownerRef: 'owner-1',
});

test('RS-203 scenario 1: remote execution START is correlated before anything is returned', () => {
  const bridge = mk();
  const record = start(bridge);
  assert.equal(record.state, 'DISPATCHED');
  assert.equal(record.remote_state, 'ONLINE');
  assert.equal(record.devices_differ, true);
  assert.equal(record.applied_events, 0);
  assert.equal(record.terminal, false);
});

test('RS-203 scenario 2: PROGRESS returns on the PROGRESS channel and moves the run to RUNNING', () => {
  const bridge = mk();
  start(bridge);
  const out = bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS', payload: { percent: 40 } });
  assert.equal(out.canonical_state, 'RUNNING');
  assert.equal(out.channel, 'PROGRESS');
  assert.equal(out.state_changed, true);
  assert.equal(out.projection, 'PROJECTED');
  assert.equal(out.projected_to, 'device-interaction');
});

test('RS-203 scenario 3: WAITING FOR USER is reachable, and is cleared the same way it is set', () => {
  const bridge = mk();
  start(bridge);
  bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS' });
  const waiting = bridge.apply({ actionRef: 'action-1', sequence: 2, kind: 'STATUS', attention: true });
  assert.equal(waiting.canonical_state, 'AWAITING_USER');
  assert.equal(waiting.state_changed, true);
  const resumed = bridge.apply({ actionRef: 'action-1', sequence: 3, kind: 'STATUS', attention: false });
  assert.equal(resumed.canonical_state, 'AWAITING_USER', 'a plain STATUS must NOT silently resume the run');
  const afterRespond = bridge.apply({ actionRef: 'action-1', sequence: 4, kind: 'PROGRESS' });
  assert.equal(afterRespond.canonical_state, 'RUNNING');
});

test('RS-203 scenario 3b: attention on a non-STATUS kind is REFUSED rather than guessed', () => {
  const bridge = mk();
  start(bridge);
  assert.throws(
    () => bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS', attention: true }),
    (e) => e.code === 'INVALID_REQUEST',
  );
});

test('RS-203 scenario 4: SUCCESS lands truthfully only when it actually reached the user', () => {
  const bridge = mk();
  start(bridge);
  const out = bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'FINAL' });
  assert.equal(out.canonical_state, 'SUCCEEDED');
  assert.equal(out.terminal, true);
  assert.equal(out.truthful_success, true);
  assert.equal(out.channel, 'STATE');
});

test('RS-203 scenario 5: FAILURE is terminal and reports no success', () => {
  const bridge = mk();
  start(bridge);
  const out = bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'ERROR', payload: { code: 'BOOM' } });
  assert.equal(out.canonical_state, 'FAILED');
  assert.equal(out.terminal, true);
  assert.equal(out.truthful_success, false);
});

test('RS-203 scenario 6: CANCEL is terminal and sticky against later events', () => {
  const bridge = mk();
  start(bridge);
  const cancelled = bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'CANCELLED' });
  assert.equal(cancelled.canonical_state, 'CANCELLED');
  assert.equal(cancelled.terminal, true);
  const after = bridge.apply({ actionRef: 'action-1', sequence: 2, kind: 'FINAL' });
  assert.equal(after.applied, false);
  assert.equal(after.verdict, 'LATE_EVENT_AFTER_TERMINAL');
  assert.equal(bridge.correlation('action-1').state, 'CANCELLED', 'a late FINAL must not overwrite a cancel');
});

test('RS-203 scenario 7: DEVICE DISCONNECT degrades knowledge without moving the run or claiming success', () => {
  const bridge = mk();
  start(bridge);
  bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS' });
  const gone = bridge.markDisconnected({ actionRef: 'action-1', detail: 'execution host unreachable' });
  assert.equal(gone.canonical_state, 'RUNNING', 'the run truth is unchanged by losing contact');
  assert.equal(gone.state_changed, false);
  assert.equal(gone.remote_state, 'UNKNOWN');
  assert.equal(gone.truthful_success, false);
  assert.equal(gone.terminal, false, 'a disconnect must not be mistaken for an ending');
  assert.ok(REMOTE_STATES.includes(gone.remote_state));
});

test('RS-203 scenario 8: RECOVERY clears the degraded state and the run can still finish', () => {
  const bridge = mk();
  start(bridge);
  bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS' });
  bridge.markDisconnected({ actionRef: 'action-1' });
  const back = bridge.apply({ actionRef: 'action-1', sequence: 2, kind: 'PROGRESS' });
  assert.equal(back.remote_state, 'ONLINE');
  assert.equal(back.remote_state_recovered, true);
  const done = bridge.apply({ actionRef: 'action-1', sequence: 3, kind: 'FINAL' });
  assert.equal(done.canonical_state, 'SUCCEEDED');
  assert.equal(done.truthful_success, true);
});

test('RS-203 scenario 8b: a disconnect AFTER a terminal result changes nothing about it', () => {
  const bridge = mk();
  start(bridge);
  bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'FINAL' });
  const gone = bridge.markDisconnected({ actionRef: 'action-1' });
  assert.equal(gone.canonical_state, 'SUCCEEDED');
  assert.equal(gone.remote_state, 'ONLINE', 'a disconnect cannot retract a result that already landed');
  assert.equal(gone.terminal, true);
});

test('RS-203: the full eight-situation walk leaves the counters consistent', () => {
  const bridge = mk();
  start(bridge);
  bridge.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS' });
  bridge.apply({ actionRef: 'action-1', sequence: 2, kind: 'STATUS', attention: true });
  bridge.apply({ actionRef: 'action-1', sequence: 3, kind: 'PROGRESS' });
  bridge.apply({ actionRef: 'action-1', sequence: 3, kind: 'PROGRESS' });   // duplicate
  bridge.apply({ actionRef: 'action-1', sequence: 2, kind: 'PROGRESS' });   // out of order
  bridge.markDisconnected({ actionRef: 'action-1' });
  bridge.apply({ actionRef: 'action-1', sequence: 4, kind: 'FINAL' });
  bridge.apply({ actionRef: 'action-1', sequence: 5, kind: 'PROGRESS' });   // late
  const stats = bridge.stats();
  assert.equal(stats.registered, 1);
  assert.equal(stats.applied, 4);
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.out_of_order, 1);
  assert.equal(stats.late, 1);
  assert.equal(stats.disconnected, 1);
  assert.equal(bridge.correlation('action-1').state, 'SUCCEEDED');
});
