// RS-202 step 6 conformance: the five coverage scenarios, plus the idempotency the gate demands.
//
// These are INTEGRATION tests: they compose pressure, routing, re-scan, anti-flap and the assignment
// guard rather than re-testing each in isolation, because the scenarios step 6 names are exactly the
// situations where those pieces have to agree with one another.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAntiFlap, DEFAULT_ANTI_FLAP_POLICY } from '../hysteresis.mjs';
import { createAssignmentGuard } from '../assignment-guard.mjs';
import { DEFAULT_PRESSURE_POLICY, evaluateEligibility } from '../pressure.mjs';
import { createRescanCoordinator, DEFAULT_RESCAN_POLICY } from '../rescan.mjs';
import { planRoute } from '../routing-sequence.mjs';

const idle = Object.freeze({ cpu: 0.05, memory: 0.05, gpu: 0.05, io: 0.05, network: 0.05 });
const hot = Object.freeze({ cpu: 0.97, memory: 0.2, gpu: 0.2, io: 0.2, network: 0.2 });
const device = (extra = {}) => ({ state: 'READY', presence: 'ONLINE', enablement: 'ENABLED', load: idle, sessionConcurrency: 0, providerConcurrency: 0, ...extra });

/* ------------------------------------------------- 1. several devices submitting at the same time */

test('RS-202 scenario: several devices submitting at once cannot double-execute the same subject', () => {
  // The review list names 重复调度 and 双执行. Two devices race for one subject; exactly one wins and the
  // other is refused, so "simultaneous submission" cannot become two runs of the same work.
  const guard = createAssignmentGuard();
  const first = guard.claim({ subjectRef: 'task-1', deviceRef: 'device-a', idempotencyKey: 'k1' });
  const second = guard.claim({ subjectRef: 'task-1', deviceRef: 'device-b', idempotencyKey: 'k2' });
  assert.equal(first.outcome, 'CLAIMED');
  assert.equal(second.outcome, 'ALREADY_CLAIMED');
  assert.equal(second.double_execution, false);
  assert.equal(second.held_by, 'device-a');
  assert.equal(guard.holder('task-1'), 'device-a');
  assert.equal(guard.active(), 1);
  // Different subjects are independent, so concurrency itself is not the thing being refused.
  assert.equal(guard.claim({ subjectRef: 'task-2', deviceRef: 'device-b', idempotencyKey: 'k2' }).outcome, 'CLAIMED');
  assert.equal(guard.active(), 2);
});

test('RS-202 scenario: a RETRY is idempotent while a second device on the same work is not', () => {
  const guard = createAssignmentGuard();
  guard.claim({ subjectRef: 'task-1', deviceRef: 'device-a', idempotencyKey: 'k1' });
  // Same device, same key: this is a retry, and it must not be counted as another execution.
  const retry = guard.claim({ subjectRef: 'task-1', deviceRef: 'device-a', idempotencyKey: 'k1' });
  assert.equal(retry.outcome, 'IDEMPOTENT');
  assert.equal(retry.idempotent, true);
  assert.equal(retry.double_execution, false);
  // Same device but a DIFFERENT key is a genuinely different operation and is refused while live.
  assert.equal(guard.claim({ subjectRef: 'task-1', deviceRef: 'device-a', idempotencyKey: 'k9' }).outcome, 'ALREADY_CLAIMED');
  assert.equal(guard.stats().idempotent, 1);
  assert.equal(guard.stats().refused, 1);
});

/* ------------------------------------------------------------- 2. one device under a high load */

test('RS-202 scenario: a heavily loaded device is paused while its peers stay eligible', () => {
  const loaded = evaluateEligibility({ device: { state: 'READY', presence: 'ONLINE' }, enablement: 'ENABLED', load: hot });
  const peer = evaluateEligibility({ device: { state: 'READY', presence: 'ONLINE' }, enablement: 'ENABLED', load: idle });
  assert.equal(loaded.reason, 'PRESSURE_PAUSED');
  assert.equal(loaded.eligible, false);
  assert.equal(loaded.load.binding_dimension, 'cpu', 'the saturated dimension is named, not averaged away');
  assert.equal(peer.eligible, true);
  // And the routing sequence diverts rather than failing.
  const plan = planRoute({
    originDeviceRef: 'loaded',
    current: device({ load: hot }),
    alternates: [{ deviceRef: 'peer', ...device() }],
    userDeclinedSwitch: true,
  });
  assert.equal(plan.stage, 'ALTERNATE_DEVICE');
  assert.equal(plan.chosen_device_ref, 'peer');
  assert.equal(plan.terminal_failure, false);
});

/* ------------------------------------------------------ 3. one provider session is congested */

test('RS-202 scenario: a congested provider session is queued or diverted, never terminal', () => {
  const congested = device({ providerConcurrency: DEFAULT_PRESSURE_POLICY.max_provider_concurrency });
  assert.equal(evaluateEligibility({ device: { state: 'READY', presence: 'ONLINE' }, enablement: 'ENABLED', providerConcurrency: 2, load: idle }).reason, 'AT_CAPACITY');
  // With the user declining a switch and nothing else spare, the sequence QUEUES - and says a re-scan is
  // worthwhile, because congestion is temporary rather than a refusal.
  const queued = planRoute({ originDeviceRef: 'congested', current: congested, alternates: [], userDeclinedSwitch: true });
  assert.equal(queued.stage, 'QUEUED');
  assert.equal(queued.no_resource.kind, 'TEMPORARY_NO_RESOURCE');
  assert.equal(queued.rescan_required, true);
  assert.equal(queued.terminal_failure, false);
  // Before the user declines, the choice is offered instead.
  const offered = planRoute({ originDeviceRef: 'congested', current: congested, candidateSwitchRef: 'provider-b' });
  assert.equal(offered.stage, 'SWITCH_OFFERED');
  assert.equal(offered.switch_offer.executed, false);
});

/* ------------------------------------------------------------- 4. a device goes offline and returns */

test('RS-202 scenario: a device that drops offline is unreachable, and its return wakes the re-scan', async () => {
  const offline = evaluateEligibility({ device: { state: 'READY', presence: 'OFFLINE' }, enablement: 'ENABLED', load: idle });
  assert.equal(offline.reason, 'UNREACHABLE');
  assert.equal(offline.eligible, false);

  const coordinator = createRescanCoordinator({ policy: { ...DEFAULT_RESCAN_POLICY, ceiling_ms: 5000 } });
  let backOnline = false;
  const waiting = coordinator.awaitEligibility({ key: 'device-c', isEligible: () => backOnline, ceilingMs: 5000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.pending(), 1, 'nothing should wake before the device returns');
  backOnline = true;
  coordinator.signal('device-c', 'device returned');
  const wake = await waiting;
  assert.equal(wake.wake, 'EVENT');
  assert.equal(wake.event_driven, true);
  assert.equal(wake.terminal_failure, false);
});

test('RS-202 scenario: a claim survives a dropout by TRANSFER, and the old holder cannot retry it', () => {
  const guard = createAssignmentGuard();
  guard.claim({ subjectRef: 'task-1', deviceRef: 'device-a', idempotencyKey: 'k1' });
  // Only the current holder may hand work on, so an invented transfer cannot steal a live claim.
  assert.equal(guard.transfer({ subjectRef: 'task-1', fromDeviceRef: 'device-b', toDeviceRef: 'device-c' }).outcome, 'REFUSED');
  const moved = guard.transfer({ subjectRef: 'task-1', fromDeviceRef: 'device-a', toDeviceRef: 'device-b' });
  assert.equal(moved.outcome, 'TRANSFERRED');
  assert.equal(moved.epoch, 2, 'the epoch is bumped so the previous holder is no longer current');
  assert.equal(guard.holder('task-1'), 'device-b');
  // The old holder's late retry is now refused rather than idempotent, which is what stops a dropped
  // device from resuming work that has already been reassigned.
  const lateRetry = guard.claim({ subjectRef: 'task-1', deviceRef: 'device-a', idempotencyKey: 'k1' });
  assert.equal(lateRetry.outcome, 'ALREADY_CLAIMED');
  assert.equal(lateRetry.held_by, 'device-b');
  assert.equal(guard.release({ subjectRef: 'task-1', deviceRef: 'device-a' }).outcome, 'REFUSED');
  assert.equal(guard.release({ subjectRef: 'task-1', deviceRef: 'device-b' }).outcome, 'RELEASED');
});

/* --------------------------------------------------------------- 5. the eligible set goes 0 -> 1 */

test('RS-202 scenario: an eligible set going 0 -> 1 is a TEMPORARY absence that then wakes on an event', async () => {
  const exhausted = planRoute({
    originDeviceRef: 'device-a',
    current: device({ load: hot }),
    alternates: [{ deviceRef: 'device-b', ...device({ load: hot }) }],
    userDeclinedSwitch: true,
  });
  assert.equal(exhausted.no_resource.kind, 'TEMPORARY_NO_RESOURCE', 'saturation is absence, not ineligibility');
  assert.equal(exhausted.rescan_required, true);
  assert.equal(exhausted.terminal_failure, false);

  // The eligible set is empty, so the wait parks. When a device frees up, the EVENT wakes it - no polling.
  const coordinator = createRescanCoordinator({ policy: { ...DEFAULT_RESCAN_POLICY, ceiling_ms: 5000 } });
  let eligibleCount = 0;
  const waiting = coordinator.awaitEligibility({ key: 'pool', isEligible: () => eligibleCount > 0, ceilingMs: 5000 });
  await new Promise(resolve => setImmediate(resolve));
  // A signal while still empty must not wake it: that is the re-scan-storm guard.
  assert.equal(coordinator.signal('pool', 'still empty').woken, 0);
  eligibleCount = 1;
  assert.equal(coordinator.signal('pool', 'a device freed up').woken, 1);
  assert.equal((await waiting).wake, 'EVENT');
  assert.equal(coordinator.stats().event_wakes, 1);
  assert.equal(coordinator.stats().ceiling_wakes, 0);
});

/* --------------------------------------------------------------- cross-cutting: flapping vs. the claim */

test('RS-202 scenario: a flapping pool cannot move work that is already claimed', () => {
  // Anti-flap and the assignment guard defend different things: hysteresis stops the DECISION oscillating,
  // while the guard stops the WORK being executed twice. Together, a noisy pool leaves both stable.
  let clock = 0;
  const flap = createAntiFlap({ now: () => clock });
  const guard = createAssignmentGuard({ now: () => clock });
  const first = flap.consider({ subjectRef: 'task-1', candidateRef: 'device-a' });
  assert.equal(first.decision, 'ADOPTED');
  guard.claim({ subjectRef: 'task-1', deviceRef: 'device-a', idempotencyKey: 'k1' });
  clock += 1000000;
  // The pool flaps hard, but nothing is confirmed twice running, so nothing moves.
  for (const candidate of ['device-b', 'device-c', 'device-b', 'device-c']) {
    assert.equal(flap.consider({ subjectRef: 'task-1', candidateRef: candidate }).decision, 'HOLD');
  }
  assert.equal(flap.current('task-1'), 'device-a');
  assert.equal(guard.holder('task-1'), 'device-a');
  assert.equal(flap.switches('task-1'), 1, 'only the original adoption');
  // A device that ignores the decision and tries anyway is still refused by the guard.
  assert.equal(guard.claim({ subjectRef: 'task-1', deviceRef: 'device-c', idempotencyKey: 'kz' }).outcome, 'ALREADY_CLAIMED');
  assert.equal(DEFAULT_ANTI_FLAP_POLICY.min_consecutive_confirmations, 2);
});
