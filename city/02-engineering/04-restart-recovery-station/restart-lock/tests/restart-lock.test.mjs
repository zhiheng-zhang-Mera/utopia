/**
 * UTOPIA · Engineering — restart lock suite.
 *
 * Every edge, refusal detail, holder rule, history bound and release path restates
 * the donor `src/plugin/restart-lock.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd, with the `RestartLockState` and
 * `RestartRequestState` vocabularies taken from `src/shared/protocol.ts` at the same
 * commit. The donor reads `Date.now()` when no clock is injected; this port never
 * does, so every test drives an injected clock and asserts exact millisecond values.
 *
 * The last case proves the shared layer stayed a single source: the vocabularies this
 * module uses are the sibling `restart-protocol` module's own exports, by identity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  REQUEST_STATE,
  RESTART_LOCK_STATES,
  RESTART_REQUEST_STATES,
  TRANSITIONS,
  allowedTransitions,
  createFixedClock,
  holderRequiredRefusal,
  illegalTransition,
  isLegalTransition,
  restartLock,
  restartLockState,
  restartRequestState,
  transitionRecord,
  transitionRefusal,
} from '../restart-lock.mjs';
import * as lockContracts from '../contracts.mjs';
import * as sharedContracts from '../../restart-protocol/contracts.mjs';

/** The five working states, in the order the lock walks them. */
const CYCLE = ['REQUESTED', 'CHECKPOINTING', 'SHUTTING_DOWN', 'RELAUNCHING', 'VERIFYING'];

/** The donor's declared edges, restated independently of the module. */
const DECLARED_EDGES = [
  ['IDLE', 'REQUESTED'],
  ['REQUESTED', 'CHECKPOINTING'],
  ['REQUESTED', 'SHUTTING_DOWN'],
  ['REQUESTED', 'IDLE'],
  ['CHECKPOINTING', 'SHUTTING_DOWN'],
  ['CHECKPOINTING', 'IDLE'],
  ['SHUTTING_DOWN', 'RELAUNCHING'],
  ['SHUTTING_DOWN', 'IDLE'],
  ['RELAUNCHING', 'VERIFYING'],
  ['RELAUNCHING', 'IDLE'],
  ['VERIFYING', 'IDLE'],
];

const REFUSAL_KEYS = ['detail', 'from', 'to'];

/** An injectable clock, advanced by the test. */
function clockAt(startMs = 1000) {
  const clock = { at: startMs };
  return {
    clock,
    now: () => clock.at,
    advance(ms) {
      clock.at += ms;
      return clock.at;
    },
  };
}

/** Walk a fresh lock along a path. The clock is pinned so records are exact. */
function walk(path, options = { now: createFixedClock(1000) }) {
  const lock = restartLock(options);
  for (const state of path) {
    const refusal = lock.transition(state, state === 'REQUESTED' ? 'request-1' : null);
    assert.equal(refusal, null, `expected ${state} to be accepted`);
  }
  return lock;
}

/** The working-state path that parks a fresh lock in `state`; `IDLE` is the start. */
function pathTo(state) {
  return state === 'IDLE' ? [] : CYCLE.slice(0, CYCLE.indexOf(state) + 1);
}

test('the lock vocabulary and the declared transition table are the donor vocabulary', () => {
  assert.deepEqual(RESTART_LOCK_STATES, ['IDLE', 'REQUESTED', 'CHECKPOINTING', 'SHUTTING_DOWN', 'RELAUNCHING', 'VERIFYING']);
  assert.deepEqual(RESTART_REQUEST_STATES, ['rejected', 'queued', 'checkpointing', 'shutting_down', 'relaunching', 'verifying', 'completed', 'failed', 'cancelled']);
  assert.deepEqual(TRANSITIONS.IDLE, ['REQUESTED']);
  assert.deepEqual(TRANSITIONS.REQUESTED, ['CHECKPOINTING', 'SHUTTING_DOWN', 'IDLE']);
  assert.deepEqual(TRANSITIONS.CHECKPOINTING, ['SHUTTING_DOWN', 'IDLE']);
  assert.deepEqual(TRANSITIONS.SHUTTING_DOWN, ['RELAUNCHING', 'IDLE']);
  assert.deepEqual(TRANSITIONS.RELAUNCHING, ['VERIFYING', 'IDLE']);
  assert.deepEqual(TRANSITIONS.VERIFYING, ['IDLE']);
  assert.deepEqual(Object.keys(TRANSITIONS), RESTART_LOCK_STATES, 'every lock state declares its edges');

  assert.equal(Object.isFrozen(TRANSITIONS), true);
  for (const state of RESTART_LOCK_STATES) assert.equal(Object.isFrozen(TRANSITIONS[state]), true, `${state} edges are frozen`);

  // the declared table is also derived, state by state, from the migration contract
  for (const state of RESTART_LOCK_STATES) assert.deepEqual(allowedTransitions(state), DECLARED_EDGES.filter(([from]) => from === state).map(([, to]) => to));
  assert.deepEqual(REQUEST_STATE, {
    IDLE: 'completed',
    REQUESTED: 'queued',
    CHECKPOINTING: 'checkpointing',
    SHUTTING_DOWN: 'shutting_down',
    RELAUNCHING: 'relaunching',
    VERIFYING: 'verifying',
  });

  // the vocabulary gate is the single entry point for a state name
  assert.equal(restartLockState('VERIFYING'), 'VERIFYING');
  assert.throws(() => restartLockState('REQUESTING'), TypeError);
  assert.equal(restartRequestState('checkpointing'), 'checkpointing');
  assert.throws(() => restartRequestState('COMPLETED'), TypeError);
  assert.equal(isLegalTransition('IDLE', 'REQUESTED'), true);
  assert.equal(isLegalTransition('IDLE', 'VERIFYING'), false);
});

test('every declared edge is accepted, and no declared edge is missing', () => {
  for (const [from, to] of DECLARED_EDGES) {
    const lock = walk(pathTo(from));
    assert.equal(lock.state, from, `${from} is reachable`);
    const refusal = lock.transition(to, to === 'REQUESTED' ? 'request-1' : null);
    assert.equal(refusal, null, `${from} -> ${to} is declared`);
    assert.equal(lock.state, to);
    assert.deepEqual(lock.transitions.at(-1), { from, to, atMs: 1000 }, 'the accepted edge is recorded');
  }

  // no undeclared edge is accepted: for every state, exactly the declared edges move it
  for (const from of RESTART_LOCK_STATES) {
    for (const to of RESTART_LOCK_STATES) {
      const declared = DECLARED_EDGES.some(([a, b]) => a === from && b === to);
      const lock = walk(pathTo(from));
      const refusal = lock.transition(to, 'request-1');
      assert.equal(refusal === null, declared, `${from} -> ${to} must be ${declared ? 'accepted' : 'refused'}`);
      assert.equal(lock.state, declared ? to : from);
    }
  }
});

test('an undeclared edge is refused with the donor detail and leaves the state alone', () => {
  const lock = restartLock({ now: createFixedClock(1000) });

  assert.deepEqual(lock.transition('CHECKPOINTING'), {
    from: 'IDLE',
    to: 'CHECKPOINTING',
    detail: 'illegal restart lock transition IDLE -> CHECKPOINTING; allowed: REQUESTED',
  });
  assert.deepEqual(lock.transition('SHUTTING_DOWN'), {
    from: 'IDLE',
    to: 'SHUTTING_DOWN',
    detail: 'illegal restart lock transition IDLE -> SHUTTING_DOWN; allowed: REQUESTED',
  });

  assert.equal(lock.transition('REQUESTED', 'request-1'), null);
  assert.deepEqual(lock.transition('RELAUNCHING'), {
    from: 'REQUESTED',
    to: 'RELAUNCHING',
    detail: 'illegal restart lock transition REQUESTED -> RELAUNCHING; allowed: CHECKPOINTING, SHUTTING_DOWN, IDLE',
  });

  assert.equal(lock.transition('CHECKPOINTING'), null);
  assert.deepEqual(lock.transition('RELAUNCHING'), {
    from: 'CHECKPOINTING',
    to: 'RELAUNCHING',
    detail: 'illegal restart lock transition CHECKPOINTING -> RELAUNCHING; allowed: SHUTTING_DOWN, IDLE',
  });

  assert.equal(lock.transition('SHUTTING_DOWN'), null);
  assert.deepEqual(lock.transition('VERIFYING'), {
    from: 'SHUTTING_DOWN',
    to: 'VERIFYING',
    detail: 'illegal restart lock transition SHUTTING_DOWN -> VERIFYING; allowed: RELAUNCHING, IDLE',
  });

  assert.equal(lock.transition('RELAUNCHING'), null);
  assert.deepEqual(lock.transition('CHECKPOINTING'), {
    from: 'RELAUNCHING',
    to: 'CHECKPOINTING',
    detail: 'illegal restart lock transition RELAUNCHING -> CHECKPOINTING; allowed: VERIFYING, IDLE',
  });

  assert.equal(lock.transition('VERIFYING'), null);
  assert.deepEqual(lock.transition('REQUESTED', 'request-2'), {
    from: 'VERIFYING',
    to: 'REQUESTED',
    detail: 'illegal restart lock transition VERIFYING -> REQUESTED; allowed: IDLE',
  });

  // ...and the lock is still exactly where it was, so the legal next step still works
  assert.equal(lock.state, 'VERIFYING');
  assert.equal(lock.transition('IDLE'), null);
  assert.equal(lock.state, 'IDLE');

  const fresh = restartLock({ now: createFixedClock(1000) });
  assert.deepEqual(fresh.transition('IDLE'), {
    from: 'IDLE',
    to: 'IDLE',
    detail: 'illegal restart lock transition IDLE -> IDLE; allowed: REQUESTED',
  });
  assert.equal(fresh.state, 'IDLE');
  assert.deepEqual(fresh.transitions, [], 'a refusal is not recorded as a transition');

  // a name outside the vocabulary is refused at the gate instead of entering the lock
  assert.throws(() => fresh.transition('REQUESTING', 'request-1'), TypeError);
  assert.equal(fresh.state, 'IDLE');
  assert.equal(fresh.currentHolder, null);

  // the refusal shape is a frozen copy
  const refusal = fresh.transition('CHECKPOINTING');
  assert.deepEqual(Object.keys(refusal).sort(), REFUSAL_KEYS);
  assert.equal(Object.isFrozen(refusal), true);
  assert.deepEqual(illegalTransition('IDLE', 'CHECKPOINTING'), refusal);
  assert.deepEqual(transitionRefusal('IDLE', 'CHECKPOINTING', refusal.detail), refusal);
  assert.throws(() => transitionRefusal('IDLE', 'CHECKPOINTING', ''), TypeError);
});

test('entering REQUESTED needs a holder, and only IDLE -> REQUESTED sets it', () => {
  const lock = restartLock({ now: createFixedClock(1000) });
  const detail = 'entering REQUESTED requires a request id';

  assert.deepEqual(lock.transition('REQUESTED'), { from: 'IDLE', to: 'REQUESTED', detail });
  assert.deepEqual(lock.transition('REQUESTED', ''), { from: 'IDLE', to: 'REQUESTED', detail });
  assert.deepEqual(lock.transition('REQUESTED'), { from: 'IDLE', to: 'REQUESTED', detail });
  assert.deepEqual(holderRequiredRefusal('IDLE'), { from: 'IDLE', to: 'REQUESTED', detail });
  assert.equal(lock.state, 'IDLE', 'a refused claim does not move the lock');
  assert.equal(lock.currentHolder, null);
  assert.equal(lock.idle, true);

  assert.equal(lock.transition('REQUESTED', 'request-1'), null);
  assert.equal(lock.currentHolder, 'request-1');
  assert.equal(lock.transition('CHECKPOINTING', 'request-2'), null, 'no holder is required once the lock is held');
  assert.equal(lock.currentHolder, 'request-1', 'only IDLE -> REQUESTED sets the holder');
  assert.equal(lock.transition('SHUTTING_DOWN', 'request-3'), null);
  assert.equal(lock.currentHolder, 'request-1');
  assert.equal(lock.transition('RELAUNCHING', 'request-4'), null);
  assert.equal(lock.currentHolder, 'request-1');
  assert.equal(lock.transition('VERIFYING', 'request-5'), null);
  assert.equal(lock.currentHolder, 'request-1');
  assert.equal(lock.transition('IDLE'), null);
  assert.equal(lock.currentHolder, null, 'the holder is cleared on the way back to IDLE');

  // the lock is claimable again, under a new request id
  assert.equal(lock.transition('REQUESTED', 'request-2'), null);
  assert.equal(lock.currentHolder, 'request-2');
});

test('history is bounded by maxHistory and drops the oldest record first', () => {
  const lock = restartLock({ maxHistory: 3, now: createFixedClock(1000) });
  for (let round = 1; round <= 3; round += 1) {
    for (const state of [...CYCLE, 'IDLE']) {
      assert.equal(lock.transition(state, state === 'REQUESTED' ? `request-${round}` : null), null);
    }
  }

  const history = lock.transitions;
  assert.equal(lock.maxHistory, 3);
  assert.equal(history.length, 3, 'the bound is enforced');
  assert.deepEqual(history, [
    { from: 'SHUTTING_DOWN', to: 'RELAUNCHING', atMs: 1000 },
    { from: 'RELAUNCHING', to: 'VERIFYING', atMs: 1000 },
    { from: 'VERIFYING', to: 'IDLE', atMs: 1000 },
  ], 'the newest records survive and the oldest are gone');

  const tight = restartLock({ maxHistory: 1, now: createFixedClock(1000) });
  assert.equal(tight.transition('REQUESTED', 'request-1'), null);
  assert.equal(tight.transition('CHECKPOINTING'), null);
  assert.deepEqual(tight.transitions, [{ from: 'REQUESTED', to: 'CHECKPOINTING', atMs: 1000 }]);

  const zero = restartLock({ maxHistory: 0, now: createFixedClock(1000) });
  assert.equal(zero.transition('REQUESTED', 'request-1'), null);
  assert.deepEqual(zero.transitions, []);

  // the default bound is the donor's 50
  const defaults = restartLock({ now: createFixedClock(1000) });
  assert.equal(defaults.maxHistory, 50);
  for (let round = 0; round < 12; round += 1) {
    for (const state of [...CYCLE, 'IDLE']) assert.equal(defaults.transition(state, state === 'REQUESTED' ? 'request-1' : null), null);
  }
  assert.equal(defaults.transitions.length, 50, 'twelve rounds is more history than the lock keeps');

  assert.throws(() => restartLock({ maxHistory: -1 }), TypeError);
  assert.throws(() => restartLock({ maxHistory: 1.5 }), TypeError);
});

test('release forces IDLE from every working state, and is null when already idle', () => {
  for (const state of CYCLE) {
    const lock = walk(pathTo(state));
    const before = lock.transitions.length;
    assert.equal(lock.state, state);
    assert.equal(lock.idle, false);
    assert.deepEqual(lock.release('operator cancelled'), { from: state, reason: 'operator cancelled' });
    assert.equal(lock.state, 'IDLE');
    assert.equal(lock.idle, true);
    assert.equal(lock.currentHolder, null, `releasing from ${state} clears the holder`);
    assert.deepEqual(lock.transitions.at(-1), { from: state, to: 'IDLE', atMs: 1000 }, 'the forced move is recorded');
    assert.equal(lock.transitions.length, before + 1);
    assert.equal(lock.transition('REQUESTED', 'request-2'), null, 'the lock is reusable after a release');
  }

  const idle = restartLock({ now: createFixedClock(1000) });
  assert.equal(idle.release('nothing to release'), null);
  assert.deepEqual(idle.transitions, [], 'a no-op release records nothing');
  // an already-idle lock answers before anything is validated, exactly like the donor
  assert.equal(idle.release(''), null);
  assert.equal(idle.release(null), null);

  const held = walk(['REQUESTED']);
  assert.throws(() => held.release(''), TypeError, 'a real release must carry a reason');
  assert.equal(held.state, 'REQUESTED', 'the refused release changed nothing');
  assert.throws(() => restartLock({ now: 0 }), TypeError, 'the clock must be a function');
  assert.throws(() => restartLock(null), TypeError, 'the options must be an object');
});

test('heldForMs reads the injected clock, and requestState names each lock state', () => {
  const time = clockAt(1000);
  const lock = restartLock({ now: time.now });
  assert.equal(lock.heldForMs(), 0);

  time.advance(250);
  assert.equal(lock.heldForMs(), 250, 'time in the initial state counts');

  assert.equal(lock.transition('REQUESTED', 'request-1'), null);
  assert.equal(lock.heldForMs(), 0, 'entering a state resets the clock');
  time.advance(1250);
  assert.equal(lock.heldForMs(), 1250);

  assert.equal(lock.transition('CHECKPOINTING'), null);
  time.advance(60);
  assert.equal(lock.heldForMs(), 60);
  assert.deepEqual(lock.release('checkpoint refused'), { from: 'CHECKPOINTING', reason: 'checkpoint refused' });
  assert.equal(lock.heldForMs(), 0);

  // a clock that stands still, and one that goes backwards, never report negative time
  const still = restartLock({ now: createFixedClock(500) });
  assert.equal(still.heldForMs(), 0);
  const backwards = clockAt(1000);
  const reversed = restartLock({ now: backwards.now });
  backwards.advance(-5000);
  assert.equal(reversed.heldForMs(), 0, 'Math.max(0, ...) holds');

  // requestState for each lock state in place
  const expected = { IDLE: 'completed', REQUESTED: 'queued', CHECKPOINTING: 'checkpointing', SHUTTING_DOWN: 'shutting_down', RELAUNCHING: 'relaunching', VERIFYING: 'verifying' };
  assert.equal(restartLock({ now: createFixedClock() }).requestState, expected.IDLE);
  for (const state of CYCLE) {
    assert.equal(walk(pathTo(state)).requestState, expected[state], `${state} reports ${expected[state]}`);
  }
  assert.equal(walk([...CYCLE, 'IDLE']).requestState, 'completed', 'a finished restart reports completed');
});

test('transitions returns a copy, and the lock object is frozen', () => {
  const lock = walk(['REQUESTED', 'CHECKPOINTING']);
  const snapshot = lock.transitions;
  assert.deepEqual(snapshot, [
    { from: 'IDLE', to: 'REQUESTED', atMs: 1000 },
    { from: 'REQUESTED', to: 'CHECKPOINTING', atMs: 1000 },
  ]);
  assert.equal(Object.isFrozen(snapshot[0]), true, 'a recorded transition cannot be rewritten after the fact');
  assert.throws(() => (snapshot[0].from = 'VERIFYING'), TypeError);
  snapshot.push({ from: 'CHECKPOINTING', to: 'IDLE', atMs: 0 });
  assert.equal(lock.transitions.length, 2, 'mutating the copy does not touch the lock');
  assert.equal(lock.transitions[0].from, 'IDLE');

  const picture = lock.snapshot();
  assert.deepEqual(picture, { state: 'CHECKPOINTING', holder: 'request-1', enteredAtMs: 1000, history: lock.transitions });
  assert.equal(Object.isFrozen(picture), true);
  assert.equal(Object.isFrozen(picture.history), true);
  assert.throws(() => (picture.state = 'IDLE'), TypeError);

  assert.equal(Object.isFrozen(lock), true);
  assert.throws(() => (lock.state = 'IDLE'), TypeError);
  assert.throws(() => lock.transition(), TypeError);
  assert.equal(lock.transition('SHUTTING_DOWN'), null, 'an argument-less refusal attempt does not move the lock');

  const record = transitionRecord({ from: 'IDLE', to: 'REQUESTED', atMs: 7 });
  assert.deepEqual(record, { from: 'IDLE', to: 'REQUESTED', atMs: 7 });
  assert.equal(Object.isFrozen(record), true);
  assert.throws(() => transitionRecord({ from: 'IDLE', to: 'REQUESTED' }), TypeError);
});

test('the vocabularies have one declaration: this module imports them from the shared layer', async () => {
  // Identity, not equality: the lock must use the shared layer's own objects, so a
  // drift between the two is impossible rather than merely unlikely.
  assert.equal(RESTART_LOCK_STATES, sharedContracts.RESTART_LOCK_STATES);
  assert.equal(RESTART_REQUEST_STATES, sharedContracts.RESTART_REQUEST_STATES);
  assert.equal(lockContracts.RESTART_LOCK_STATES, sharedContracts.RESTART_LOCK_STATES);
  assert.equal(lockContracts.RESTART_REQUEST_STATES, sharedContracts.RESTART_REQUEST_STATES);
  assert.equal(Object.isFrozen(RESTART_LOCK_STATES), true);
  assert.equal(Object.isFrozen(RESTART_REQUEST_STATES), true);

  // the lock's own tables stay local declarations
  assert.notEqual(TRANSITIONS, sharedContracts.TRANSITIONS);
  assert.equal('TRANSITIONS' in sharedContracts, false, 'the protocol layer does not declare the lock edges');
  assert.equal('REQUEST_STATE' in sharedContracts, false, 'the protocol layer does not declare the lock/request mapping');

  // ...and the local tables agree with the shared vocabulary, state for state
  assert.deepEqual(Object.keys(TRANSITIONS), [...sharedContracts.RESTART_LOCK_STATES]);
  assert.deepEqual(Object.values(REQUEST_STATE), ['completed', 'queued', 'checkpointing', 'shutting_down', 'relaunching', 'verifying']);
  for (const state of Object.values(REQUEST_STATE)) {
    assert.ok(sharedContracts.RESTART_REQUEST_STATES.includes(state), `${state} is a declared request state`);
  }
  for (const edges of Object.values(TRANSITIONS)) {
    for (const edge of edges) assert.ok(sharedContracts.RESTART_LOCK_STATES.includes(edge), `${edge} is a declared lock state`);
  }

  // a re-declared copy would pass deepEqual but fail this: the module must not
  // construct its own vocabulary array anywhere in its source
  const moduleDir = join(import.meta.dirname, '..');
  const code = (await readFile(join(moduleDir, 'contracts.mjs'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.ok(!/export const RESTART_LOCK_STATES/.test(code), 'RESTART_LOCK_STATES must not be declared here');
  assert.ok(!/export const RESTART_REQUEST_STATES/.test(code), 'RESTART_REQUEST_STATES must not be declared here');
  assert.match(code, /from '\.\.\/restart-protocol\/contracts\.mjs'/, 'the vocabularies come from the sibling shared layer');
});

test('the module is self-contained: no donor checkout, no ambient clock, no runtime dependency', async () => {
  const moduleDir = join(import.meta.dirname, '..');
  for (const file of ['contracts.mjs', 'restart-lock.mjs', 'index.mjs']) {
    const code = (await readFile(join(moduleDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["from 'node:", "require('", "from 'app/", 'writeFileSync', 'process.env', 'Math.random']) {
      assert.ok(!code.includes(forbidden), `${file} must not carry a runtime dependency (${forbidden})`);
    }
    assert.ok(!/Date\.now/.test(code), `${file} must never read the ambient clock`);
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
});
