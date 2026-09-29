/**
 * UTOPIA · 10-automation / Computer Use Runtime — state machine suite.
 *
 * Restates the DS-Hns donor `app/computer-use/state-machine.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b. The machine is *closed*: every one of
 * the 15 × 15 ordered state pairs is walked here and asserted against
 * `CU_TRANSITIONS` edge for edge — an edge that was added, removed or reordered by
 * this port fails this suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CU_STATES,
  CU_TRANSITIONS,
  TERMINAL_STATES,
  createStateMachine,
} from '../index.mjs';

const STATES = Object.freeze(Object.values(CU_STATES));

test('the donor machine is fifteen states and two terminal states', () => {
  assert.equal(STATES.length, 15);
  assert.deepEqual(STATES, [
    'IDLE',
    'RECEIVING_TASK',
    'OBSERVING',
    'PLANNING_ACTION',
    'STABILIZING',
    'REVALIDATING',
    'ACTING',
    'POST_ACTION_GRACE',
    'VERIFYING',
    'RETRYING',
    'RECOVERING',
    'REPLANNING',
    'STALLED',
    'COMPLETED',
    'FAILED',
  ]);
  assert.deepEqual(TERMINAL_STATES, ['COMPLETED', 'FAILED']);
  assert.deepEqual(Object.keys(CU_TRANSITIONS), STATES);
});

test('the transition table is the donor table, edge for edge and in order', () => {
  assert.deepEqual(CU_TRANSITIONS, {
    IDLE: ['RECEIVING_TASK'],
    RECEIVING_TASK: ['OBSERVING', 'FAILED'],
    OBSERVING: ['PLANNING_ACTION', 'COMPLETED', 'FAILED'],
    PLANNING_ACTION: ['STABILIZING', 'COMPLETED', 'REPLANNING', 'FAILED'],
    STABILIZING: ['REVALIDATING', 'OBSERVING', 'RETRYING', 'RECOVERING', 'FAILED'],
    REVALIDATING: ['ACTING', 'OBSERVING', 'RETRYING', 'RECOVERING', 'FAILED'],
    ACTING: ['POST_ACTION_GRACE', 'RETRYING', 'RECOVERING', 'FAILED'],
    POST_ACTION_GRACE: ['VERIFYING', 'RETRYING', 'FAILED'],
    VERIFYING: ['OBSERVING', 'RETRYING', 'RECOVERING', 'REPLANNING', 'STALLED', 'COMPLETED', 'FAILED'],
    RETRYING: ['STABILIZING', 'RECOVERING', 'REPLANNING', 'OBSERVING', 'PLANNING_ACTION', 'FAILED'],
    RECOVERING: ['OBSERVING', 'STABILIZING', 'RETRYING', 'REPLANNING', 'PLANNING_ACTION', 'STALLED', 'FAILED'],
    REPLANNING: ['OBSERVING', 'PLANNING_ACTION', 'FAILED'],
    STALLED: ['OBSERVING', 'STABILIZING', 'PLANNING_ACTION', 'RECOVERING', 'REPLANNING', 'FAILED'],
    COMPLETED: [],
    FAILED: [],
  });
  // Both terminal states are genuinely closed, and every listed edge names a state
  // that exists.
  for (const terminal of TERMINAL_STATES) assert.deepEqual(CU_TRANSITIONS[terminal], []);
  for (const allowed of Object.values(CU_TRANSITIONS)) {
    for (const target of allowed) assert.ok(STATES.includes(target), `unknown target ${target}`);
  }
});

test('every ordered state pair is exactly as legal as CU_TRANSITIONS says', () => {
  let legal = 0;
  let selfPairs = 0;
  let illegal = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      const expected = from === to || CU_TRANSITIONS[from].includes(to);
      const machine = createStateMachine({ initialState: from, now: () => 0 });
      // A self-pair is never in the edge table, so `canTransition` is false there.
      assert.equal(machine.canTransition(to), CU_TRANSITIONS[from].includes(to), `canTransition ${from} -> ${to}`);

      if (from === to) {
        // A self-transition is a no-op, never a recorded edge.
        assert.equal(machine.transition(to), from, `self transition ${from}`);
        assert.deepEqual(machine.history(), [], `self transition ${from} records nothing`);
        selfPairs += 1;
        continue;
      }

      if (expected) {
        legal += 1;
        assert.equal(machine.transition(to, { reason: 'checked', step: 1 }), to);
        assert.deepEqual(machine.history(), [{
          from,
          to,
          at: 0,
          reason: 'checked',
          step: 1,
          action: null,
          direction: 'forward',
        }]);
        assert.equal(machine.previous, from);
        assert.equal(machine.path().length, 2);
      } else {
        illegal += 1;
        assert.throws(
          () => machine.transition(to),
          (error) => {
            assert.equal(error.name, 'ComputerUseError');
            assert.equal(error.code, 'STATE_TRANSITION_INVALID');
            assert.equal(error.message, `illegal transition ${from} -> ${to}`);
            assert.deepEqual(error.details, {
              from,
              to,
              allowed: CU_TRANSITIONS[from],
              reason: null,
            });
            return true;
          },
          `expected ${from} -> ${to} to be illegal`,
        );
        // An illegal transition leaves the machine where it was.
        assert.equal(machine.state, from);
        assert.deepEqual(machine.history(), []);
      }
    }
  }
  // 56 legal edges, 154 illegal ordered pairs and 15 self-pairs make the full
  // 15 × 15 matrix. Illegal means "not in the table", which includes the
  // terminal states' every outgoing pair.
  assert.equal(legal, 56);
  assert.equal(illegal, 154);
  assert.equal(selfPairs, 15);
  assert.equal(legal + illegal + selfPairs, STATES.length * STATES.length);
});

test('an unknown state is STATE_INVALID from canTransition, transition and force', () => {
  const machine = createStateMachine({ now: () => 0 });
  assert.equal(machine.canTransition('NOPE'), false);
  for (const call of [
    () => machine.transition('NOPE'),
    () => machine.force('NOPE'),
  ]) {
    assert.throws(call, (error) => {
      assert.equal(error.code, 'STATE_INVALID');
      assert.equal(error.message, 'unknown state: NOPE');
      assert.deepEqual(error.details, { state: 'NOPE', from: 'IDLE' });
      return true;
    });
  }
});

test('an unknown initial state is STATE_INVALID and names the state', () => {
  assert.throws(
    () => createStateMachine({ initialState: 'RUNNING' }),
    (error) => {
      assert.equal(error.code, 'STATE_INVALID');
      assert.equal(error.message, 'unknown initial state: RUNNING');
      assert.deepEqual(error.details, { state: 'RUNNING' });
      return true;
    },
  );
});

test('force bypasses the edge table but is labelled forced in the history', () => {
  const machine = createStateMachine({ initialState: 'ACTING', now: () => 7 });
  // ACTING may not transition to COMPLETED legally.
  assert.throws(() => machine.transition('COMPLETED'), /illegal transition ACTING -> COMPLETED/);
  assert.equal(machine.force('COMPLETED', { reason: 'cancelled' }), 'COMPLETED');
  assert.deepEqual(machine.history(), [{
    from: 'ACTING',
    to: 'COMPLETED',
    at: 7,
    reason: 'cancelled',
    step: null,
    action: null,
    direction: 'forced',
  }]);
  assert.equal(machine.isTerminal(), true);
  assert.equal(machine.force('COMPLETED'), 'COMPLETED');
  assert.equal(machine.history().length, 1);
});

test('isTerminal is true only for COMPLETED and FAILED', () => {
  for (const state of STATES) {
    const machine = createStateMachine({ initialState: state, now: () => 0 });
    assert.equal(machine.isTerminal(), TERMINAL_STATES.includes(state), `isTerminal ${state}`);
  }
});

test('the reason carried into a transition is the previous meta reason when meta omits one', () => {
  const machine = createStateMachine({ now: () => 0 });
  machine.transition('RECEIVING_TASK', { reason: 'task accepted' });
  machine.transition('OBSERVING');
  // The reason of the *previous* edge is carried forward verbatim.
  assert.deepEqual(machine.history().map((entry) => entry.reason), ['task accepted', 'task accepted']);
  assert.equal(machine.history()[1].action, null);
  assert.equal(machine.history()[1].step, null);

  // An empty-meta transition carries the standing reason; a transition that states
  // its own reason replaces it, and the next meta-less edge carries the new one.
  const second = createStateMachine({ now: () => 0 });
  second.transition('RECEIVING_TASK', { reason: 'task accepted' });
  second.transition('OBSERVING', {});
  second.transition('PLANNING_ACTION', { reason: 'goal understood' });
  second.transition('STABILIZING');
  assert.deepEqual(second.history().map((entry) => entry.reason), ['task accepted', 'task accepted', 'goal understood', 'goal understood']);
});

test('a transition listener sees the edge and can never break the run', () => {
  const seen = [];
  const machine = createStateMachine({
    now: () => 0,
    onTransition(event) {
      seen.push(event);
      throw new Error('a listener must never break the run');
    },
  });
  assert.equal(machine.transition('RECEIVING_TASK', { reason: 'go' }), 'RECEIVING_TASK');
  assert.deepEqual(seen, [{ from: 'IDLE', to: 'RECEIVING_TASK', meta: { reason: 'go' } }]);
  assert.equal(machine.state, 'RECEIVING_TASK');

  const bare = createStateMachine({ now: () => 0, onTransition: (event) => seen.push(event) });
  bare.transition('RECEIVING_TASK');
  assert.deepEqual(seen[1], { from: 'IDLE', to: 'RECEIVING_TASK', meta: {} });
});

test('path, previous, reset and the history copy', () => {
  let tick = 0;
  const machine = createStateMachine({ now: () => tick++ });
  assert.equal(machine.previous, null);
  machine.transition('RECEIVING_TASK', { step: 1, action: 'OPEN_APP' });
  machine.transition('OBSERVING', { step: 2 });
  assert.deepEqual(machine.path(), ['IDLE', 'RECEIVING_TASK', 'OBSERVING']);
  assert.equal(machine.previous, 'RECEIVING_TASK');
  assert.equal(machine.history()[0].action, 'OPEN_APP');
  assert.deepEqual(machine.history().map((entry) => entry.at), [0, 1]);

  const copy = machine.history();
  copy.length = 0;
  assert.equal(machine.history().length, 2);

  assert.equal(machine.reset(), 'IDLE');
  assert.equal(machine.state, 'IDLE');
  assert.deepEqual(machine.history(), []);
  assert.deepEqual(machine.path(), ['IDLE']);
  assert.equal(machine.previous, null);
});

test('a custom initial state starts the path there', () => {
  const machine = createStateMachine({ initialState: 'STALLED', now: () => 0 });
  assert.equal(machine.state, 'STALLED');
  assert.equal(machine.isTerminal(), false);
  assert.deepEqual(machine.path(), ['STALLED']);
  assert.equal(machine.transition('FAILED'), 'FAILED');
  assert.deepEqual(machine.path(), ['STALLED', 'FAILED']);
});

test('the default clock is a deterministic step clock', () => {
  const first = createStateMachine();
  const second = createStateMachine();
  first.transition('RECEIVING_TASK');
  second.transition('RECEIVING_TASK');
  assert.equal(first.history()[0].at, 0);
  assert.deepEqual(first.history(), second.history());
});
