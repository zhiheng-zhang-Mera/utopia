// RS-202 step 5 conformance: anti-flap and hysteresis.
//
// The two damping rules are tested separately because they defeat different oscillations: persistence
// stops a single noisy reading from moving work, and the dwell bounds the switch RATE when a pool
// genuinely alternates. A test with a controllable clock exercises each without real waiting.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ANTI_FLAP_POLICY, FLAP_CONTRACT_VERSION, FLAP_DECISIONS, createAntiFlap,
} from '../hysteresis.mjs';

const make = (policy = {}) => {
  let clock = 0;
  const flap = createAntiFlap({ policy: { ...DEFAULT_ANTI_FLAP_POLICY, ...policy }, now: () => clock });
  return { flap, advance: ms => { clock += ms; } };
};

test('RS-202: the first selection is ADOPTED immediately, because a non-flap should not pay latency', () => {
  const { flap } = make();
  const first = flap.consider({ subjectRef: 'task-1', candidateRef: 'device-a' });
  assert.equal(first.decision, 'ADOPTED');
  assert.equal(first.current_ref, 'device-a');
  assert.equal(flap.current('task-1'), 'device-a');
  assert.equal(flap.stats().adopted, 1);
});

test('RS-202: a single different reading never moves work - persistence is required', () => {
  const { flap, advance } = make();
  flap.consider({ subjectRef: 't', candidateRef: 'a' });
  advance(100000);
  const one = flap.consider({ subjectRef: 't', candidateRef: 'b' });
  assert.equal(one.decision, 'HOLD');
  assert.equal(one.confirmations, 1);
  assert.equal(flap.current('t'), 'a', 'one odd sample must not relocate the work');
  // A returning reading clears the pending alternative entirely.
  const back = flap.consider({ subjectRef: 't', candidateRef: 'a' });
  assert.equal(back.decision, 'HOLD');
  assert.equal(back.confirmations, 0);
});

test('RS-202: two consecutive confirmations satisfy persistence but the DWELL still suppresses', () => {
  const { flap } = make();
  flap.consider({ subjectRef: 't', candidateRef: 'a' });      // adopted at clock 0
  flap.consider({ subjectRef: 't', candidateRef: 'b' });      // 1/2
  const persistent = flap.consider({ subjectRef: 't', candidateRef: 'b' }); // 2/2, but dwell not met
  assert.equal(persistent.decision, 'SUPPRESSED');
  assert.equal(persistent.confirmations, 2);
  assert.equal(persistent.since_last_switch_ms, 0);
  assert.match(persistent.detail, /inside the 30000ms dwell/);
  assert.equal(flap.current('t'), 'a', 'a suppressed switch must not have happened');
  assert.equal(flap.stats().suppressed, 1);
});

test('RS-202: past the dwell a persistent alternative switches, exactly once', () => {
  const { flap, advance } = make();
  flap.consider({ subjectRef: 't', candidateRef: 'a' });
  flap.consider({ subjectRef: 't', candidateRef: 'b' });
  flap.consider({ subjectRef: 't', candidateRef: 'b' });      // suppressed
  advance(DEFAULT_ANTI_FLAP_POLICY.min_dwell_ms);
  const moved = flap.consider({ subjectRef: 't', candidateRef: 'b' });
  assert.equal(moved.decision, 'SWITCH');
  assert.equal(flap.current('t'), 'b');
  assert.equal(flap.switches('t'), 2, 'the adoption plus this switch');
  // And the dwell restarts, so an immediate second switch is suppressed again.
  const again = flap.consider({ subjectRef: 't', candidateRef: 'c' });
  flap.consider({ subjectRef: 't', candidateRef: 'c' });
  assert.equal(again.decision, 'HOLD');
  assert.equal(flap.consider({ subjectRef: 't', candidateRef: 'c' }).decision, 'SUPPRESSED');
});

test('RS-202: an ALTERNATING pool never earns a switch - the anti-flap case itself', () => {
  const { flap, advance } = make();
  flap.consider({ subjectRef: 't', candidateRef: 'a' });
  advance(1000000); // make the dwell a non-factor, so this tests persistence ALONE
  for (const candidate of ['b', 'c', 'b', 'c', 'b', 'c']) {
    const decision = flap.consider({ subjectRef: 't', candidateRef: candidate });
    // Each candidate resets the counter for the other, so nothing is ever confirmed twice running.
    assert.equal(decision.decision, 'HOLD', `${candidate} should not have been actioned`);
    assert.equal(decision.confirmations, 1);
  }
  assert.equal(flap.current('t'), 'a', 'a flapping pool must leave the task where it is');
  assert.equal(flap.switches('t'), 1, 'only the original adoption');
});

test('RS-202: with nothing eligible the decision HOLDS rather than moving to nothing', () => {
  const { flap } = make();
  flap.consider({ subjectRef: 't', candidateRef: 'a' });
  const none = flap.consider({ subjectRef: 't', candidateRef: null, eligible: false, reason: 'TEMPORARY_NO_RESOURCE' });
  assert.equal(none.decision, 'HOLD');
  assert.equal(none.current_ref, 'a');
  assert.match(none.detail, /no eligible candidate to move to/);
  // An ineligible but named candidate is also held, since eligibility is what licenses a move.
  assert.equal(flap.consider({ subjectRef: 't', candidateRef: 'b', eligible: false }).decision, 'HOLD');
  assert.equal(flap.current('t'), 'a');
});

test('RS-202: subjects are damped independently, so one task cannot suppress another', () => {
  const { flap, advance } = make();
  flap.consider({ subjectRef: 't1', candidateRef: 'a' });
  flap.consider({ subjectRef: 't2', candidateRef: 'x' });
  advance(100000);
  flap.consider({ subjectRef: 't1', candidateRef: 'b' });
  flap.consider({ subjectRef: 't2', candidateRef: 'y' });
  assert.equal(flap.current('t1'), 'a');
  assert.equal(flap.current('t2'), 'x');
  assert.equal(flap.consider({ subjectRef: 't1', candidateRef: 'b' }).decision, 'SWITCH');
  assert.equal(flap.current('t1'), 'b');
  assert.equal(flap.current('t2'), 'x', 't2 must be unaffected by t1 switching');
});

test('RS-202: the damping policy and decision vocabulary are inspectable, and flapping is measurable', () => {
  const { flap } = make({ min_consecutive_confirmations: 3, min_dwell_ms: 1000 });
  assert.equal(flap.policy().min_consecutive_confirmations, 3);
  assert.equal(flap.policy().min_dwell_ms, 1000);
  flap.consider({ subjectRef: 't', candidateRef: 'a' });     // 1 adopted
  assert.equal(flap.consider({ subjectRef: 't', candidateRef: 'b' }).decision, 'HOLD');       // 2, 1/3
  assert.equal(flap.consider({ subjectRef: 't', candidateRef: 'b' }).decision, 'HOLD');       // 3, 2/3
  // The third confirmation DOES satisfy the raised persistence requirement, and is then stopped by the
  // dwell - so the raised threshold genuinely changed what it took to get that far.
  const third = flap.consider({ subjectRef: 't', candidateRef: 'b' });                        // 4, 3/3 then dwell
  assert.equal(third.decision, 'SUPPRESSED');
  assert.equal(third.confirmations, 3);
  const stats = flap.stats();
  assert.equal(stats.considerations, 4);
  assert.equal(stats.switched, 0);
  assert.equal(stats.suppressed, 1);
  assert.deepEqual([...FLAP_DECISIONS], ['ADOPTED', 'HOLD', 'SWITCH', 'SUPPRESSED']);
  assert.equal(flap.policy().policy_ref, DEFAULT_ANTI_FLAP_POLICY.policy_ref);
});
