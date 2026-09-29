/**
 * UTOPIA · City Core — task lifecycle parity and behaviour tests.
 *
 * Ported from the Codex-Boss donor `src/shared/candidate-gate.ts` §35 @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * These tests assert the rules the donor's §35 exists to enforce: no jump from
 * RUNNING to COMPLETED, CANDIDATE is a real state that is NOT a release, repair is
 * exactly one step back, and ACCEPTED is terminal. They also pin the edge table to
 * the declared lifecycle order so a future edit cannot silently introduce a jump.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKWARD_EVENTS,
  CANDIDATE_GATE_VERSION,
  FORWARD_EVENTS,
  LIFECYCLE_EVENTS,
  TASK_LIFECYCLE,
  TASK_TRANSITIONS,
  TERMINAL_LIFECYCLE_STATES,
  TaskLifecycleError,
  advanceLifecycle,
  candidateIdFor,
  candidateRecordFor,
  isLifecycleEvent,
  isLifecycleState,
  lifecycleStep,
} from '../index.mjs';

test('the declared lifecycle is the donor order and ends in the terminal state', () => {
  assert.deepEqual(TASK_LIFECYCLE, ['RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING', 'CANDIDATE', 'ACCEPTED']);
  assert.deepEqual(LIFECYCLE_EVENTS, ['IMPLEMENTED', 'VERIFIED', 'REVIEWED', 'CANDIDATED', 'ACCEPTED', 'REPAIR']);
  assert.deepEqual(TERMINAL_LIFECYCLE_STATES, ['ACCEPTED']);
});

test('every edge table entry agrees with the declared order and the event tables', () => {
  for (const [index, state] of TASK_LIFECYCLE.entries()) {
    const forwardTarget = TASK_LIFECYCLE[index + 1];
    const backEntry = BACKWARD_EVENTS[state][0];
    const expected = [];
    if (forwardTarget !== undefined) expected.push(forwardTarget);
    if (backEntry) expected.push(backEntry[1]);
    assert.deepEqual(
      [...TASK_TRANSITIONS[state]].sort(),
      [...expected].sort(),
      `${state} edges must be exactly the forward target and the repair target`,
    );
  }
  assert.deepEqual(TASK_TRANSITIONS.ACCEPTED, [], 'ACCEPTED is terminal');
});

test('the lifecycle walks forward one declared state at a time and never jumps', () => {
  const events = ['IMPLEMENTED', 'VERIFIED', 'REVIEWED', 'CANDIDATED', 'ACCEPTED'];
  let state = 'RUNNING';
  const visited = [state];
  for (const event of events) {
    const result = advanceLifecycle(state, event);
    assert.equal(result.accepted, true, `${event} must be accepted from ${state}`);
    assert.equal(
      result.state,
      TASK_LIFECYCLE[TASK_LIFECYCLE.indexOf(state) + 1],
      `${event} must land on the next declared state, never further`,
    );
    assert.equal(result.reason, `${state} --${event}--> ${result.state}`);
    state = result.state;
    visited.push(state);
  }
  assert.deepEqual(visited, TASK_LIFECYCLE);
});

test('ACCEPTED cannot be left by any event, including REPAIR', () => {
  for (const event of LIFECYCLE_EVENTS) {
    const result = advanceLifecycle('ACCEPTED', event);
    assert.equal(result.accepted, false, `${event} must not leave ACCEPTED`);
    assert.equal(result.state, 'ACCEPTED');
    assert.deepEqual(result.allowed, []);
  }
});

test('a refused event keeps the current state and reports the allowed set', () => {
  const result = advanceLifecycle('RUNNING', 'ACCEPTED');
  assert.equal(result.accepted, false);
  assert.equal(result.state, 'RUNNING');
  assert.deepEqual(result.allowed, ['IMPLEMENTED']);
  assert.match(result.reason, /ACCEPTED is not legal from RUNNING/);
  assert.match(result.reason, /RUNNING → IMPLEMENTED → VERIFYING → REVIEWING → CANDIDATE → ACCEPTED/);
  assert.match(result.reason, /transitions are IMPLEMENTED/);
});

test('REPAIR moves exactly one step back and is reported as a repair', () => {
  const cases = [
    ['IMPLEMENTED', 'RUNNING'],
    ['VERIFYING', 'IMPLEMENTED'],
    ['REVIEWING', 'VERIFYING'],
    ['CANDIDATE', 'REVIEWING'],
  ];
  for (const [from, to] of cases) {
    const result = advanceLifecycle(from, 'REPAIR');
    assert.equal(result.accepted, true, `REPAIR must be accepted from ${from}`);
    assert.equal(result.state, to);
    assert.equal(result.reason, `${from} --REPAIR--> ${to} (repair)`);
  }
  const noRepair = advanceLifecycle('RUNNING', 'REPAIR');
  assert.equal(noRepair.accepted, false, 'RUNNING has nothing to repair back to');
  assert.equal(noRepair.state, 'RUNNING');
});

test('CANDIDATE is reachable but is not a release', () => {
  let state = 'RUNNING';
  for (const event of ['IMPLEMENTED', 'VERIFIED', 'REVIEWED', 'CANDIDATED']) {
    state = advanceLifecycle(state, event).state;
  }
  assert.equal(state, 'CANDIDATE');
  const record = candidateRecordFor({
    task_id: 'T-1',
    state,
    requirements: ['r1'],
    completion_evidence: ['build green'],
    guardian: { verdict: 'CANDIDATE', checks: [], blocking: [], released: false, reason: 'awaiting §36' },
    steps: [],
  });
  assert.equal(record.awaiting_release_permission, true, 'CANDIDATE still owes a release decision');
  assert.equal(record.version, CANDIDATE_GATE_VERSION);
  assert.equal(record.schemaVersion, 1);

  const accepted = candidateRecordFor({
    task_id: 'T-1',
    state: 'ACCEPTED',
    requirements: [],
    completion_evidence: [],
    guardian: { verdict: 'ACCEPTED', checks: [], blocking: [], released: true, reason: 'ok' },
    steps: [],
  });
  assert.equal(accepted.awaiting_release_permission, false);
});

test('a record built without a clock is deterministic and copies its inputs', () => {
  const requirements = ['a', 'b'];
  const first = candidateRecordFor({ task_id: 'T-1', state: 'RUNNING', requirements, completion_evidence: [], guardian: null, steps: [] });
  const second = candidateRecordFor({ task_id: 'T-1', state: 'RUNNING', requirements, completion_evidence: [], guardian: null, steps: [] });
  assert.deepEqual(first, second);
  assert.equal(first.created_at, new Date(0).toISOString(), 'the donor defaults to the epoch, not to now');
  requirements.push('c');
  assert.deepEqual(first.requirements, ['a', 'b'], 'the record copied the list rather than aliasing it');
});

test('candidateIdFor is stable and independent of requirement order', () => {
  const a = candidateIdFor('T-1', ['beta', 'alpha']);
  const b = candidateIdFor('T-1', ['alpha', 'beta']);
  assert.equal(a, b, 'sorting makes the id order-independent');
  assert.notEqual(a, candidateIdFor('T-2', ['alpha', 'beta']));
  assert.match(a, /^cand-[0-9a-f]{16}$/);
  // pinned vector: sha256('T-1\0alpha\0beta') truncated to 16 hex characters
  assert.equal(a, 'cand-6f6181a33382dced');
});

test('lifecycleStep validates its shape instead of accepting a nameless step', () => {
  const step = lifecycleStep({ state: 'VERIFYING', at: '2026-01-01T00:00:00.000Z', reason: 'verified', evidence: ['run-1'] });
  assert.deepEqual(step, { state: 'VERIFYING', at: '2026-01-01T00:00:00.000Z', reason: 'verified', evidence: ['run-1'] });
  assert.throws(() => lifecycleStep({ state: 'NOPE', at: 'x', reason: 'y' }), TaskLifecycleError);
  assert.throws(() => lifecycleStep({ state: 'RUNNING', at: '', reason: 'y' }), TaskLifecycleError);
  assert.throws(() => lifecycleStep({ state: 'RUNNING', at: 'x', reason: '' }), TaskLifecycleError);
  assert.throws(() => lifecycleStep({ state: 'RUNNING', at: 'x', reason: 'y', evidence: [1] }), TaskLifecycleError);
});

test('the walker refuses unknown states and events rather than guessing', () => {
  assert.throws(() => advanceLifecycle('COMPLETED', 'IMPLEMENTED'), TaskLifecycleError);
  assert.throws(() => advanceLifecycle('RUNNING', 'COMPLETED'), TaskLifecycleError);
  assert.equal(isLifecycleState('RUNNING'), true);
  assert.equal(isLifecycleState('COMPLETED'), false);
  assert.equal(isLifecycleEvent('REPAIR'), true);
  assert.equal(isLifecycleEvent('REPAIRING'), false);
  assert.equal(FORWARD_EVENTS.ACCEPTED, null, 'the donor leaves ACCEPTED without a forward event');
});
