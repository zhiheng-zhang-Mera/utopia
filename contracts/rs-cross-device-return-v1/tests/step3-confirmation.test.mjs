// RS-203 step 3 — confirmation routing, timeout, and the offline path.
//
// The workbook's two halves, tested against each other: a confirmation must return to the CURRENT
// AUTHORIZED interaction surface, and a timeout or offline surface must take an EXPLAINABLE
// recovery path. Neither is allowed to weaken the other, and no path may make the user change
// devices.
import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_CODES, createReturnBridge } from '../return-bridge.mjs';

const AT = '2026-10-02T00:00:00.000Z';
let currentSurface = { device_ref: 'device-interaction' };
const mk = () => createReturnBridge({ resolveSurface: () => currentSurface, clock: () => AT });
const start = (b) => {
  b.register({ actionRef: 'action-1', interactionDeviceRef: 'device-interaction', executionDeviceRef: 'device-remote', ownerRef: 'owner-1' });
  b.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS' });
  return b.apply({ actionRef: 'action-1', sequence: 2, kind: 'STATUS', attention: true });
};

test('RS-203 step 3: a request is delivered to the CURRENT authorized surface', () => {
  const b = mk();
  start(b);
  const req = b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  assert.equal(req.status, 'PENDING');
  assert.equal(req.delivered_to, 'device-interaction');
  assert.equal(req.recovery.code, 'ANSWERABLE');
});

test('RS-203 step 3: an answer from the current authorized surface is accepted', () => {
  const b = mk();
  start(b);
  b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  const out = b.respond({ promptRef: 'prompt-1', decision: 'APPROVE', viaDeviceRef: 'device-interaction' });
  assert.equal(out.accepted, true);
  assert.equal(out.verdict, 'ANSWERED');
  assert.equal(out.answer, 'APPROVE');
});

test('RS-203 step 3: an answer from ANY OTHER device is REFUSED, however well-informed it is', () => {
  const b = mk();
  start(b);
  b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  const out = b.respond({ promptRef: 'prompt-1', decision: 'APPROVE', viaDeviceRef: 'device-remote' });
  assert.equal(out.accepted, false);
  assert.equal(out.verdict, 'NOT_AUTHORIZED_SURFACE');
  assert.equal(out.current_surface_ref, 'device-interaction');
  assert.equal(b.confirmation('prompt-1').status, 'PENDING', 'a refused answer must not consume the prompt');
});

test('RS-203 step 3: when the surface MOVED, the answer must come from where the user now is', () => {
  const b = mk();
  start(b);
  b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  currentSurface = { device_ref: 'device-interaction-2' };     // user moved
  const fromOld = b.respond({ promptRef: 'prompt-1', decision: 'APPROVE', viaDeviceRef: 'device-interaction' });
  assert.equal(fromOld.accepted, false);
  const fromNew = b.respond({ promptRef: 'prompt-1', decision: 'APPROVE', viaDeviceRef: 'device-interaction-2' });
  assert.equal(fromNew.accepted, true);
  currentSurface = { device_ref: 'device-interaction' };
});

test('RS-203 step 3: an answer cannot arrive when NO surface is authorized', () => {
  const b = mk();
  start(b);
  b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  currentSurface = null;
  const out = b.respond({ promptRef: 'prompt-1', decision: 'APPROVE', viaDeviceRef: 'device-interaction' });
  assert.equal(out.accepted, false);
  assert.match(String(out.detail), /no authorized interaction surface/);
  currentSurface = { device_ref: 'device-interaction' };
});

test('RS-203 step 3: OFFLINE asks are HELD with a reason and a recovery path, not dropped or failed', () => {
  currentSurface = null;
  const b = mk();
  start(b);
  const req = b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  assert.equal(req.status, 'UNDELIVERABLE');
  assert.equal(req.delivered_to, null);
  assert.match(String(req.reason), /no authorized interaction surface/);
  assert.equal(req.recovery.code, 'AWAIT_SURFACE');
  assert.equal(req.recovery.next, 'RESUME_WHEN_AUTHORIZED');
  currentSurface = { device_ref: 'device-interaction' };
  // and it is still answerable once a surface returns - held, not lost
  const out = b.respond({ promptRef: 'prompt-1', decision: 'APPROVE', viaDeviceRef: 'device-interaction' });
  assert.equal(out.accepted, true);
});

test('RS-203 step 3: TIMEOUT is explained and recoverable, and is NEVER a failure', () => {
  const b = mk();
  start(b);
  b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1', deadlineMs: 1000 });
  const out = b.expire({ promptRef: 'prompt-1' });
  assert.equal(out.expired, true);
  assert.equal(out.status, 'EXPIRED');
  assert.equal(out.truthful_success, false);
  assert.equal(out.recovery.code, 'STILL_ANSWERABLE');
  assert.match(String(out.reason), /did not answer within the deadline/);
  // the run's own state is untouched by a timeout
  assert.equal(b.correlation('action-1').state, 'AWAITING_USER');
  assert.equal(b.correlation('action-1').terminal, false);
});

test('RS-203 step 3: a timeout cannot retract an answer that already arrived', () => {
  const b = mk();
  start(b);
  b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  b.respond({ promptRef: 'prompt-1', decision: 'DENY', viaDeviceRef: 'device-interaction' });
  const late = b.expire({ promptRef: 'prompt-1' });
  assert.equal(late.expired, false);
  assert.equal(late.status, 'ANSWERED');
  assert.match(String(late.reason), /cannot retract an answer/);
});

test('RS-203 step 3: a double answer is refused rather than silently overwriting the first', () => {
  const b = mk();
  start(b);
  b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  b.respond({ promptRef: 'prompt-1', decision: 'APPROVE', viaDeviceRef: 'device-interaction' });
  assert.throws(
    () => b.respond({ promptRef: 'prompt-1', decision: 'DENY', viaDeviceRef: 'device-interaction' }),
    (e) => e.code === 'CONFIRMATION_ALREADY_ANSWERED',
  );
});

test('RS-203 step 3: only RESPOND is accepted, and only APPROVE or DENY decide', () => {
  const b = mk();
  start(b);
  b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  assert.throws(() => b.respond({ promptRef: 'prompt-1', decision: 'APPROVE', viaDeviceRef: 'device-interaction', command: 'CANCEL' }), (e) => e.code === 'INVALID_REQUEST');
  assert.throws(() => b.respond({ promptRef: 'prompt-1', decision: 'MAYBE', viaDeviceRef: 'device-interaction' }), (e) => e.code === 'INVALID_DECISION');
  assert.throws(() => b.respond({ promptRef: 'nope', decision: 'APPROVE', viaDeviceRef: 'device-interaction' }), (e) => e.code === 'UNKNOWN_CONFIRMATION');
});

test('RS-203 step 3: a HANDOFF does not move where the user is asked', () => {
  const b = mk();
  start(b);
  b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-1' });
  b.handoff({ actionRef: 'action-1', toExecutionDeviceRef: 'device-remote-2' });
  const after = b.requestConfirmation({ actionRef: 'action-1', promptRef: 'prompt-2' });
  assert.equal(after.delivered_to, 'device-interaction', 'the prompt still goes to the interaction device');
  assert.equal(b.correlation('action-1').interaction_device_ref, 'device-interaction');
  assert.equal(b.correlation('action-1').execution_device_ref, 'device-remote-2');
});

test('RS-203 step 3: the codes are declared, not invented at the throw site', () => {
  for (const code of ['NOT_AUTHORIZED_SURFACE', 'UNKNOWN_CONFIRMATION', 'CONFIRMATION_ALREADY_ANSWERED', 'INVALID_DECISION']) {
    assert.ok(BRIDGE_CODES.includes(code), `${code} is not in BRIDGE_CODES`);
  }
});
