// RS-202 step 4 conformance: bounded, event-driven re-scan.
//
// Three properties are defended directly, because each corresponds to a named failure mode:
//   - event FIRST and ceiling only as a backstop, so nothing dead-waits;
//   - a signal that changes nothing must NOT wake a waiter, which is the re-scan-storm guard;
//   - no polling anywhere, measured through stats() rather than asserted in a comment.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RESCAN_POLICY, RESCAN_CONTRACT_VERSION, RESCAN_WAKE_REASONS, createRescanCoordinator,
} from '../rescan.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('RS-202: an already-eligible key resolves IMMEDIATELY without waiting at all', async () => {
  const coordinator = createRescanCoordinator();
  const wake = await coordinator.awaitEligibility({ key: 'p', isEligible: () => true });
  assert.equal(wake.wake, 'IMMEDIATE');
  assert.equal(wake.event_driven, true);
  assert.equal(wake.rescan_required, false);
  assert.equal(wake.waited_ms, 0);
  assert.equal(coordinator.stats().immediate, 1);
});

test('RS-202: an EVENT wake is the primary mechanism, and it beats the ceiling', async () => {
  const coordinator = createRescanCoordinator({ policy: { ...DEFAULT_RESCAN_POLICY, ceiling_ms: 5000 } });
  let eligible = false;
  const waiting = coordinator.awaitEligibility({ key: 'p', isEligible: () => eligible, ceilingMs: 5000 });
  await flush();
  assert.equal(coordinator.pending(), 1, 'the waiter should be parked, not spinning');
  eligible = true;
  const delivered = coordinator.signal('p', 'provider freed up');
  assert.equal(delivered.woken, 1);
  const wake = await waiting;
  assert.equal(wake.wake, 'EVENT');
  assert.equal(wake.event_driven, true);
  assert.equal(wake.detail, 'provider freed up');
  assert.ok(wake.waited_ms < 5000, 'the event should have resolved it long before the ceiling');
  assert.equal(coordinator.stats().event_wakes, 1);
  assert.equal(coordinator.stats().ceiling_wakes, 0);
});

test('RS-202: a signal that changes NOTHING must not wake the waiter - the re-scan-storm guard', async () => {
  const coordinator = createRescanCoordinator({ policy: { ...DEFAULT_RESCAN_POLICY, ceiling_ms: 5000 } });
  // This is the review list's "re-scan storm": a chatty producer fires constantly and every firing is
  // mistaken for a reason to re-scan. A signal is only a PROMPT TO RE-EVALUATE, never a wake-up.
  const waiting = coordinator.awaitEligibility({ key: 'p', isEligible: () => false, ceilingMs: 5000 });
  await flush();
  for (let i = 0; i < 5; i += 1) {
    const result = coordinator.signal('p', 'noise');
    assert.equal(result.woken, 0, `signal ${i} should have woken nobody`);
  }
  await flush();
  assert.equal(coordinator.pending(), 1, 'five useless signals must leave the waiter exactly where it was');
  assert.equal(coordinator.stats().ignored_signals, 5);
  assert.equal(coordinator.stats().event_wakes, 0);
  coordinator.cancelAll();
  assert.equal((await waiting).wake, 'CANCELLED');
});

test('RS-202: the CEILING is a backstop that prompts a re-scan instead of hanging forever', async () => {
  const coordinator = createRescanCoordinator();
  const wake = await coordinator.awaitEligibility({ key: 'p', isEligible: () => false, ceilingMs: 30 });
  assert.equal(wake.wake, 'CEILING');
  assert.equal(wake.event_driven, false);
  // A ceiling wake says "re-scan", NOT "this will never work".
  assert.equal(wake.rescan_required, true);
  assert.equal(wake.terminal_failure, false, 'running out of patience is not the end of a task');
  assert.match(wake.detail, /no event arrived within the 30ms ceiling/);
  assert.equal(coordinator.stats().ceiling_wakes, 1);
});

test('RS-202: the default ceiling is the 20-minute policy figure and is a bound, not an interval', () => {
  const coordinator = createRescanCoordinator();
  assert.equal(coordinator.policy().ceiling_ms, 1200000);
  assert.equal(coordinator.policy().ceiling_ms, DEFAULT_RESCAN_POLICY.ceiling_ms);
  // There is no interval anywhere in the policy, because there is no polling loop to drive.
  assert.equal('interval_ms' in coordinator.policy(), false);
  assert.equal('tick_ms' in coordinator.policy(), false);
});

test('RS-202: signals are scoped to their key, so one pool cannot wake another pool waiters', async () => {
  const coordinator = createRescanCoordinator({ policy: { ...DEFAULT_RESCAN_POLICY, ceiling_ms: 5000 } });
  let aEligible = false;
  const waiting = coordinator.awaitEligibility({ key: 'pool-a', isEligible: () => aEligible, ceilingMs: 5000 });
  await flush();
  assert.equal(coordinator.signal('pool-b').woken, 0);
  assert.equal(coordinator.pending(), 1);
  aEligible = true;
  assert.equal(coordinator.signal('pool-a').woken, 1);
  assert.equal((await waiting).key, 'pool-a');
});

test('RS-202: a predicate that throws degrades to not-eligible instead of breaking the main path', async () => {
  const coordinator = createRescanCoordinator({ policy: { ...DEFAULT_RESCAN_POLICY, ceiling_ms: 5000 } });
  const waiting = coordinator.awaitEligibility({ key: 'p', isEligible: () => { throw new Error('telemetry exploded'); }, ceilingMs: 5000 });
  await flush();
  // An exploding predicate must not reject into the caller, and must not be read as eligible.
  assert.equal(coordinator.signal('p').woken, 0);
  assert.equal(coordinator.pending(), 1);
  coordinator.cancelAll();
  const wake = await waiting;
  assert.equal(wake.wake, 'CANCELLED');
  assert.equal(wake.terminal_failure, false);
});

test('RS-202: cancellation resolves every waiter and reports that no re-scan is required', async () => {
  const coordinator = createRescanCoordinator({ policy: { ...DEFAULT_RESCAN_POLICY, ceiling_ms: 5000 } });
  const one = coordinator.awaitEligibility({ key: 'a', isEligible: () => false, ceilingMs: 5000 });
  const two = coordinator.awaitEligibility({ key: 'b', isEligible: () => false, ceilingMs: 5000 });
  await flush();
  assert.equal(coordinator.pending(), 2);
  assert.equal(coordinator.cancelAll(), 2);
  assert.equal(coordinator.pending(), 0);
  for (const wake of [await one, await two]) {
    assert.equal(wake.wake, 'CANCELLED');
    assert.equal(wake.rescan_required, false);
    assert.equal(wake.terminal_failure, false);
  }
  assert.equal(coordinator.stats().cancelled, 2);
});

test('RS-202: no wake path can ever report a terminal failure', async () => {
  const coordinator = createRescanCoordinator();
  const paths = [
    await coordinator.awaitEligibility({ key: 'x', isEligible: () => true }),
    await coordinator.awaitEligibility({ key: 'x', isEligible: () => false, ceilingMs: 20 }),
  ];
  for (const wake of paths) {
    assert.equal(wake.terminal_failure, false, `${wake.wake} must not end the task`);
    assert.equal(wake.rescan_version, RESCAN_CONTRACT_VERSION);
  }
  assert.deepEqual([...RESCAN_WAKE_REASONS], ['IMMEDIATE', 'EVENT', 'CEILING', 'CANCELLED']);
});
