// RS-202 step 3 conformance: the routing sequence.
//
// The three properties worth defending are the workbook's own constraints, so each is tested directly:
//   - a switch is OFFERED and never executed;
//   - transient no-resource is never a terminal failure;
//   - ineligibility and temporary absence are different facts.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ROUTE_POLICY, NO_RESOURCE_KINDS, RESOURCE_REASONS, ROUTE_CONTRACT_VERSION, ROUTE_STAGES,
  STRUCTURAL_REASONS, classifyNoResource, planRoute,
} from '../routing-sequence.mjs';

const idle = Object.freeze({ cpu: 0.05, memory: 0.05, gpu: 0.05, io: 0.05, network: 0.05 });
const saturated = Object.freeze({ cpu: 0.95, memory: 0.9, gpu: 0.9, io: 0.9, network: 0.9 });
const healthy = (extra = {}) => ({ state: 'READY', presence: 'ONLINE', enablement: 'ENABLED', load: idle, ...extra });

/* ------------------------------------------------------------------------ stage 1: direct */

test('RS-202: an eligible current device runs DIRECTLY, without offering anything', () => {
  const plan = planRoute({ originDeviceRef: 'device-a', current: healthy() });
  assert.equal(plan.stage, 'DIRECT');
  assert.equal(plan.decision, 'DIRECT');
  assert.equal(plan.chosen_device_ref, 'device-a');
  assert.equal(plan.switch_offer, null);
  assert.equal(plan.terminal_failure, false);
  assert.equal(plan.rescan_required, false);
});

/* ------------------------------------------------------------------------ stage 2: the offer */

test('RS-202: an unavailable current device produces a SWITCH OFFER that is data, not an action', () => {
  const plan = planRoute({ originDeviceRef: 'device-a', current: healthy({ load: saturated }), candidateSwitchRef: 'provider-b' });
  assert.equal(plan.stage, 'SWITCH_OFFERED');
  assert.equal(plan.switch_offer.executed, false, 'offering a switch must never execute one');
  assert.equal(plan.switch_offer.requires_user_confirmation, true);
  assert.equal(plan.switch_offer.suggested_ref, 'provider-b');
  assert.equal(plan.chosen_device_ref, null, 'nothing is chosen while the user is still deciding');
  // And the plan itself is not an execution.
  assert.equal(plan.executed, false);
});

test('RS-202: the offer is made BEFORE any queueing, so the user gets the choice first', () => {
  // Even with a perfectly good alternate available, the choice stage comes first: silently diverting to
  // another device would take the decision the user is entitled to make.
  const plan = planRoute({
    originDeviceRef: 'device-a',
    current: healthy({ load: saturated }),
    alternates: [{ deviceRef: 'device-c', ...healthy() }],
    candidateSwitchRef: 'provider-b',
  });
  assert.equal(plan.stage, 'SWITCH_OFFERED');
  assert.equal(plan.chosen_device_ref, null);
  // Only once the user declines does the alternate become reachable.
  const afterDecline = planRoute({
    originDeviceRef: 'device-a',
    current: healthy({ load: saturated }),
    alternates: [{ deviceRef: 'device-c', ...healthy() }],
    userDeclinedSwitch: true,
  });
  assert.equal(afterDecline.stage, 'ALTERNATE_DEVICE');
  assert.equal(afterDecline.chosen_device_ref, 'device-c');
});

/* ------------------------------------------------------------------------ stage 3: alternate/queue */

test('RS-202: after a declined switch the sequence diverts to an eligible alternate device', () => {
  const plan = planRoute({
    originDeviceRef: 'device-a',
    current: healthy({ load: saturated }),
    alternates: [
      { deviceRef: 'device-busy', ...healthy({ load: saturated }) },
      { deviceRef: 'device-free', ...healthy() },
    ],
    userDeclinedSwitch: true,
  });
  assert.equal(plan.stage, 'ALTERNATE_DEVICE');
  assert.equal(plan.chosen_device_ref, 'device-free', 'the first ELIGIBLE alternate wins, not merely the first');
  // Every alternate is reported with its own verdict, so the rejection of the others is explainable.
  assert.equal(plan.alternates.length, 2);
  const busy = plan.alternates.find(entry => entry.device_ref === 'device-busy');
  assert.equal(busy.reason, 'PRESSURE_PAUSED');
});

test('RS-202: with no spare candidate the sequence QUEUES with a bounded, event-driven deadline', () => {
  const plan = planRoute({
    originDeviceRef: 'device-a',
    current: healthy({ load: saturated }),
    alternates: [{ deviceRef: 'device-busy', ...healthy({ load: saturated }) }],
    userDeclinedSwitch: true,
  });
  assert.equal(plan.stage, 'QUEUED');
  assert.equal(plan.queue.event_driven, true, 're-scan must be event-driven first');
  assert.equal(plan.queue.poll_based, false, 'the workbook forbids resolving contention by polling');
  assert.equal(plan.queue.deadline_ms, DEFAULT_ROUTE_POLICY.queue_deadline_ms);
  assert.equal(plan.queue.rescan_ceiling_ms, DEFAULT_ROUTE_POLICY.rescan_ceiling_ms);
});

/* ------------------------------------------------- transient absence is not terminal failure */

test('RS-202: TRANSIENT no-resource is never a terminal failure', () => {
  const plan = planRoute({
    originDeviceRef: 'device-a',
    current: healthy({ load: saturated }),
    alternates: [{ deviceRef: 'device-busy', ...healthy({ load: saturated }) }],
    userDeclinedSwitch: true,
  });
  assert.equal(plan.no_resource.kind, 'TEMPORARY_NO_RESOURCE');
  assert.equal(plan.terminal_failure, false, 'a busy candidate frees up; this is not the end of the task');
  assert.equal(plan.rescan_required, true, 'the honest signal is that a re-scan is needed');
});

test('RS-202: ineligibility and temporary absence are DIFFERENT facts, not one bucket', () => {
  // Every candidate structurally refused -> someone must act, waiting will not help.
  const ineligible = classifyNoResource([
    { eligible: false, reason: 'USER_DISABLED' },
    { eligible: false, reason: 'UNREACHABLE' },
  ]);
  assert.equal(ineligible.kind, 'INELIGIBLE');
  assert.match(ineligible.detail, /needs someone to act, not to wait/);
  // One merely busy candidate is enough to make the pool temporary: there is hope.
  const temporary = classifyNoResource([
    { eligible: false, reason: 'USER_DISABLED' },
    { eligible: false, reason: 'AT_CAPACITY' },
  ]);
  assert.equal(temporary.kind, 'TEMPORARY_NO_RESOURCE');
  assert.match(temporary.detail, /can become usable without anything being fixed/);
  // A structurally refused pool needs no re-scan, because scanning again changes nothing.
  const plan = planRoute({
    originDeviceRef: 'device-a',
    current: healthy({ enablement: 'DISABLED' }),
    alternates: [{ deviceRef: 'device-b', ...healthy({ enablement: 'DISABLED' }) }],
    userDeclinedSwitch: true,
  });
  assert.equal(plan.no_resource.kind, 'INELIGIBLE');
  assert.equal(plan.rescan_required, false);
  assert.equal(plan.terminal_failure, false, 'even a refused pool is not routing deciding the task is over');
});

test('RS-202: an empty pool is an absence of candidates rather than a refusal of them', () => {
  assert.equal(classifyNoResource([]).kind, 'TEMPORARY_NO_RESOURCE');
  assert.match(classifyNoResource([]).detail, /absence of candidates/);
});

/* ------------------------------------------------------------------------ bounded retry */

test('RS-202: retry is bounded and reaching the bound still does not end the task', () => {
  const fresh = planRoute({ originDeviceRef: 'd', current: healthy({ load: saturated }), userDeclinedSwitch: true });
  assert.equal(fresh.retry.attempts_used, 0);
  assert.equal(fresh.retry.remaining, DEFAULT_ROUTE_POLICY.max_retry_attempts);
  assert.equal(fresh.retry.bounded, true);
  const spent = planRoute({
    originDeviceRef: 'd', current: healthy({ load: saturated }), userDeclinedSwitch: true,
    attemptsUsed: DEFAULT_ROUTE_POLICY.max_retry_attempts,
  });
  assert.equal(spent.stage, 'EXHAUSTED');
  assert.equal(spent.retry.remaining, 0);
  // Even exhausted, this is a no-resource condition rather than a terminal failure: the workbook forbids
  // mistaking transient absence for the end of a task, and a bound on RETRIES is not a verdict.
  assert.equal(spent.terminal_failure, false);
});

/* ------------------------------------------------------------------------ invariants */

test('RS-202: the result always returns to the ORIGIN device on every path', () => {
  const paths = [
    planRoute({ originDeviceRef: 'origin-1', current: healthy() }),
    planRoute({ originDeviceRef: 'origin-1', current: healthy({ load: saturated }) }),
    planRoute({ originDeviceRef: 'origin-1', current: healthy({ load: saturated }), userDeclinedSwitch: true, alternates: [{ deviceRef: 'x', ...healthy() }] }),
    planRoute({ originDeviceRef: 'origin-1', current: healthy({ load: saturated }), userDeclinedSwitch: true }),
  ];
  for (const plan of paths) {
    assert.equal(plan.origin_device_ref, 'origin-1');
    assert.equal(plan.returns_to, 'origin-1', 'the user must not have to walk to the executing device');
    assert.equal(plan.executed, false, 'planning is never execution');
    assert.equal(plan.terminal_failure, false, 'no routing path may declare the task over');
    assert.equal(plan.route_version, ROUTE_CONTRACT_VERSION);
  }
});

test('RS-202: the stage vocabulary is ordered as data, and the reason sets do not overlap', () => {
  assert.deepEqual([...ROUTE_STAGES], ['DIRECT', 'SWITCH_OFFERED', 'ALTERNATE_DEVICE', 'QUEUED', 'EXHAUSTED']);
  assert.deepEqual([...NO_RESOURCE_KINDS], ['NONE', 'TEMPORARY_NO_RESOURCE', 'INELIGIBLE']);
  // A reason cannot be both structural and resource, or the two classifications would be interchangeable.
  const overlap = STRUCTURAL_REASONS.filter(reason => RESOURCE_REASONS.includes(reason));
  assert.deepEqual(overlap, [], 'structural and resource reasons must be disjoint');
});
