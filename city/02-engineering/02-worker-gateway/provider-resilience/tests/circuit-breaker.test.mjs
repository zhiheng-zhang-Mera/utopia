/**
 * UTOPIA · Worker Gateway — circuit breaker suite.
 *
 * Every case restates the Codex-Boss donor `electron/commander/circuit-breaker.ts`
 * @ 8df428eaa437a409368401e95194e40266b83080. The donor's persistence is not
 * ported, so the persistence cases are replaced by snapshot/restore cases, and
 * the clock is injected in every test: this module has no clock of its own.
 *
 * Two shapes are exercised:
 *   - the value-level reducer (`state`, `admit`, `observeFailure`, ...), which
 *     returns the next core state and is how a caller replays or persists; and
 *   - the `createCircuitBreaker` factory, which mirrors the donor's methods and
 *     returns the donor's own values (a state string, a boolean).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CIRCUIT_DEFAULTS,
  CircuitOptionError,
  CircuitRecordError,
  INTERRUPTION_KINDS,
  NON_TECHNICAL_INTERRUPTION_KINDS,
  NON_TECHNICAL_KINDS,
  PROVIDER_TECHNICAL_KINDS,
  admit,
  cancelProbe,
  createCircuitBreaker,
  emptyCircuitSnapshot,
  isOpen,
  list,
  loadCircuitSnapshot,
  observeFailure,
  observeSuccess,
  providerTechnicalInterruption,
  reset,
  snapshot,
  state,
} from '../index.mjs';

const T0 = 1_760_000_000_000;

/** A mutable clock: the module under test never reads a clock by itself. */
function clock(start = T0) {
  const time = { value: start };
  return {
    now: () => time.value,
    advance: (ms) => {
      time.value += ms;
    },
  };
}

/** A factory breaker with the donor defaults unless overridden. */
function breaker(overrides = {}) {
  const time = clock(overrides.at ?? T0);
  const value = createCircuitBreaker({
    state: overrides.state,
    options: { now: time.now, failureThreshold: overrides.failureThreshold, cooldownMs: overrides.cooldownMs },
  });
  return { breaker: value, time };
}

/** Fail one observation at a time, threading the returned core state forward. */
function failOnce(cb, runtimeId, core) {
  return observeFailure(
    { core, now: cb.now, cooldownMs: cb.cooldownMs, failureThreshold: cb.failureThreshold },
    runtimeId,
  );
}

/** `count` consecutive failures against one runtime, threading the core state. */
function failTimes(cb, runtimeId, count) {
  let core = cb.core();
  for (let index = 0; index < count; index += 1) core = failOnce(cb, runtimeId, core).core;
  return core;
}

test('an unknown runtime is CLOSED and is never listed', () => {
  const { breaker: cb } = breaker();
  assert.equal(cb.state('web:never-seen'), 'CLOSED');
  assert.equal(cb.isOpen('web:never-seen'), false);
  assert.deepEqual(cb.list(), [], 'an absent record is not a stored fact');
  assert.equal(cb.admit('web:never-seen'), true, 'a CLOSED circuit admits');
  assert.deepEqual(cb.list(), [], 'admitting a CLOSED runtime records nothing');
  assert.deepEqual(cb.snapshot(), { schemaVersion: 1, records: [], probes: [] });
});

test('the donor defaults are a threshold of 3 and a 60 s cooldown', () => {
  assert.deepEqual(CIRCUIT_DEFAULTS, { failureThreshold: 3, cooldownMs: 60000 });
  const { breaker: cb } = breaker();
  assert.equal(cb.failureThreshold, 3);
  assert.equal(cb.cooldownMs, 60000);
  let steps = failOnce(cb, 'web:a', cb.core());
  assert.equal(steps.state, 'CLOSED', 'the first failure is below the threshold');
  steps = failOnce(cb, 'web:a', steps.core);
  assert.equal(steps.state, 'CLOSED', 'the second failure is below the threshold');
  steps = failOnce(cb, 'web:a', steps.core);
  assert.equal(steps.state, 'OPEN', 'the third consecutive failure trips the breaker');
  assert.equal(state({ core: steps.core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a'), 'OPEN');
});

test('failureThreshold is clamped to 1..20 and a non-integer throws', () => {
  assert.equal(breaker({ failureThreshold: 1 }).breaker.failureThreshold, 1, 'the lower edge is kept');
  assert.equal(breaker({ failureThreshold: 20 }).breaker.failureThreshold, 20, 'the upper edge is kept');
  assert.equal(breaker({ failureThreshold: 0 }).breaker.failureThreshold, 1, 'below the lower edge is clamped up');
  assert.equal(breaker({ failureThreshold: -7 }).breaker.failureThreshold, 1);
  assert.equal(breaker({ failureThreshold: 21 }).breaker.failureThreshold, 20, 'above the upper edge is clamped down');
  assert.equal(breaker({ failureThreshold: 9999 }).breaker.failureThreshold, 20);
  assert.equal(breaker({ failureThreshold: null }).breaker.failureThreshold, 3, 'the donor default stands for an omitted option');
  for (const invalid of [1.5, NaN, Infinity, -Infinity, '3', {}]) {
    assert.throws(
      () => breaker({ failureThreshold: invalid }),
      CircuitOptionError,
      `failureThreshold=${String(invalid)} must throw rather than being rounded or coerced`,
    );
  }
});

test('cooldownMs is clamped to 1..604800000 and a non-integer throws', () => {
  assert.equal(breaker({ cooldownMs: 1 }).breaker.cooldownMs, 1, 'the lower edge is kept');
  assert.equal(breaker({ cooldownMs: 604800000 }).breaker.cooldownMs, 604800000, '7 days is the upper edge and is kept');
  assert.equal(breaker({ cooldownMs: 0 }).breaker.cooldownMs, 1, 'below the lower edge is clamped up');
  assert.equal(breaker({ cooldownMs: -1 }).breaker.cooldownMs, 1);
  assert.equal(breaker({ cooldownMs: 604800001 }).breaker.cooldownMs, 604800000, 'above the upper edge is clamped down');
  assert.equal(breaker({ cooldownMs: 8.64e15 }).breaker.cooldownMs, 604800000);
  assert.equal(breaker({ cooldownMs: null }).breaker.cooldownMs, 60000, 'the donor default stands for an omitted option');
  for (const invalid of [0.5, NaN, Infinity, -Infinity, '60000', []]) {
    assert.throws(
      () => breaker({ cooldownMs: invalid }),
      CircuitOptionError,
      `cooldownMs=${String(invalid)} must throw rather than being rounded or coerced`,
    );
  }
});

test('the clock is the caller’s, and there is no built-in one', () => {
  const { breaker: cb } = breaker();
  assert.equal(typeof cb.now, 'function');
  assert.equal(cb.now(), T0);
  assert.throws(() => createCircuitBreaker().state('web:a'), CircuitOptionError, 'no clock means no derived state');
  assert.throws(() => createCircuitBreaker().list(), CircuitOptionError, 'list reports derived state, so it needs the clock too');
  const injected = createCircuitBreaker({ options: { now: () => T0 } });
  assert.equal(injected.state('web:a'), 'CLOSED', 'with a clock injected the same call is ordinary');
});

test('CLOSED reaches OPEN exactly at the failure threshold, and not before', () => {
  const { breaker: cb } = breaker({ failureThreshold: 1 });
  const opened = failOnce(cb, 'web:a', cb.core());
  assert.equal(opened.state, 'OPEN', 'threshold 1 opens on the first failure');
  assert.equal(state({ core: opened.core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a'), 'OPEN');
  assert.equal(snapshot({ core: opened.core }).records[0].consecutiveFailures, 1);

  const three = breaker();
  let core = three.breaker.core();
  for (let index = 1; index <= 2; index += 1) {
    const step = failOnce(three.breaker, 'web:a', core);
    core = step.core;
    assert.equal(step.state, 'CLOSED', `failure ${index} is below the threshold of 3`);
    assert.equal(snapshot({ core }).records[0].consecutiveFailures, index, 'the streak is reported while closing');
  }
  const third = failOnce(three.breaker, 'web:a', core);
  assert.equal(third.state, 'OPEN', 'the third consecutive failure opens the breaker');
  assert.equal(snapshot({ core: third.core }).records[0].consecutiveFailures, 3);
});

test('isOpen is true only while the reported state is OPEN', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 1, cooldownMs: 1000 });
  assert.equal(cb.isOpen('web:a'), false, 'CLOSED is not open');
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  const opened = { core: cb.core() };
  assert.equal(isOpen({ core: opened.core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a'), true);
  time.advance(1000);
  assert.equal(isOpen({ core: opened.core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a'), false, 'HALF_OPEN is not open');
  assert.equal(cb.isOpen('web:a'), false, 'the live breaker agrees');
});

test('HALF_OPEN appears exactly at the cooldown boundary', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 1, cooldownMs: 1000 });
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  const opened = { core: cb.core() };
  const before = snapshot({ core: opened.core });

  time.advance(999);
  assert.equal(cb.state('web:a'), 'OPEN', 'one millisecond short of the cooldown');
  assert.deepEqual(
    snapshot({ core: opened.core }),
    before,
    'deriving the state reads the record and never rewrites it',
  );

  time.advance(1);
  assert.equal(cb.state('web:a'), 'HALF_OPEN', 'exactly at the cooldown the state is derived HALF_OPEN');
  assert.equal(cb.isOpen('web:a'), false);

  time.advance(1);
  assert.equal(cb.state('web:a'), 'HALF_OPEN', 'and it stays HALF_OPEN until an outcome decides');
});

test('a failure while OPEN inside the cooldown stays OPEN and leaves openedAt unchanged', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 1, cooldownMs: 1000 });
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  const opened = { core: cb.core() };
  const before = snapshot({ core: opened.core });
  assert.equal(before.records[0].openedAt, T0);
  assert.equal(before.records[0].consecutiveFailures, 1);

  time.advance(200);
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  const after = snapshot({ core: cb.core() });
  assert.equal(after.records[0].openedAt, T0, 'a long outage must not extend the cooldown forever');
  assert.equal(after.records[0].consecutiveFailures, 1, 'and it must not inflate the streak either');
  assert.equal(after.records[0].updatedAt, before.records[0].updatedAt, 'the record is untouched, not rewritten at a new time');

  time.advance(700);
  assert.equal(cb.state('web:a'), 'OPEN', 'still 100 ms short of the cooldown');
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  assert.equal(snapshot({ core: cb.core() }).records[0].openedAt, T0, 'failures inside the cooldown still do not move openedAt');
});

test('HALF_OPEN admits at most one probe, and the probe counter is per runtime', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 1, cooldownMs: 1000 });
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  const a = { core: cb.core() };
  assert.equal(cb.observeFailure('web:b'), 'OPEN');
  const b = { core: cb.core() };
  assert.equal(snapshot({ core: a.core }).records.length, 1, 'web:a is recorded in the state captured after its own failure');
  assert.equal(snapshot({ core: b.core }).records.length, 2, 'web:b is added by the second failure');
  assert.equal(cb.admit('web:c'), true, 'CLOSED admits every dispatch');

  time.advance(1000);
  const view = { core: b.core, now: cb.now, cooldownMs: cb.cooldownMs };
  assert.equal(state(view, 'web:a'), 'HALF_OPEN');

  const first = admit(view, 'web:a');
  assert.equal(first.admitted, true, 'the single probe is admitted');
  const second = admit({ ...view, core: first.core }, 'web:a');
  assert.equal(second.admitted, false, 'a second probe is refused');
  const third = admit({ ...view, core: second.core }, 'web:a');
  assert.equal(third.admitted, false, 'and refused again');
  assert.equal(snapshot({ core: third.core }).probes.length, 1, 'web:a carries exactly one consumed probe');

  const other = admit({ ...view, core: third.core }, 'web:b');
  assert.equal(other.admitted, true, 'web:b is a separate circuit');
  assert.equal(snapshot({ core: other.core }).probes.length, 2, 'the probe counter is per runtime');
  assert.deepEqual(
    snapshot({ core: other.core }).probes,
    [
      { runtimeId: 'web:a', probes: 1 },
      { runtimeId: 'web:b', probes: 1 },
    ],
    'each runtime counts its own probe',
  );

  assert.deepEqual(snapshot({ core: a.core }).probes, [], 'the state captured before admit carries no probe');
});

test('a verified success closes the breaker and clears the streak and the probe', () => {
  const { breaker: cb } = breaker({ failureThreshold: 2, cooldownMs: 1000 });
  assert.equal(cb.observeFailure('web:a'), 'CLOSED', 'the first failure is below the threshold');
  assert.equal(cb.observeFailure('web:a'), 'OPEN', 'the second failure opens');
  assert.equal(snapshot({ core: cb.core() }).records[0].consecutiveFailures, 2);

  // A restored OPEN breaker whose cooldown has elapsed: consume the probe, then succeed.
  const restored = createCircuitBreaker({
    state: {
      schemaVersion: 1,
      records: [
        {
          runtimeId: 'web:a',
          state: 'OPEN',
          consecutiveFailures: 2,
          openedAt: T0,
          updatedAt: new Date(T0).toISOString(),
        },
      ],
    },
    options: { now: () => T0 + 1000, failureThreshold: 2, cooldownMs: 1000 },
  });
  assert.equal(restored.state('web:a'), 'HALF_OPEN');
  assert.equal(restored.admit('web:a'), true, 'the probe is admitted');
  assert.equal(snapshot({ core: restored.core() }).probes.length, 1);

  assert.equal(restored.observeSuccess('web:a'), 'CLOSED');
  const after = snapshot({ core: restored.core() });
  assert.equal(after.records[0].state, 'CLOSED');
  assert.equal(after.records[0].consecutiveFailures, 0, 'the streak is cleared');
  assert.equal(after.records[0].openedAt, undefined, 'a closed record carries no openedAt');
  assert.deepEqual(after.probes, [], 'the consumed probe is freed');
  assert.equal(restored.state('web:a'), 'CLOSED');
  assert.equal(restored.admit('web:a'), true, 'a CLOSED circuit admits again');
});

test('a verified success also closes a record that is still stored OPEN but past its cooldown', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 1, cooldownMs: 1000 });
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  time.advance(1000);
  const storedBefore = snapshot({ core: cb.core() }).records[0].state;
  assert.equal(storedBefore, 'OPEN', 'the stored record is still OPEN');
  assert.equal(cb.state('web:a'), 'HALF_OPEN', 'while the derived state is HALF_OPEN');
  assert.equal(cb.observeSuccess('web:a'), 'CLOSED');
  const after = snapshot({ core: cb.core() });
  assert.equal(after.records[0].state, 'CLOSED');
  assert.equal(after.records[0].consecutiveFailures, 0);
  assert.equal(after.records[0].openedAt, undefined);
});

test('a failed probe reopens with a fresh cooldown and the streak at the threshold', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 3, cooldownMs: 1000 });
  let core = failTimes(cb, 'web:a', 3);
  assert.equal(state({ core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a'), 'OPEN');

  time.advance(1000);
  assert.equal(state({ core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a'), 'HALF_OPEN');
  const reopened = observeFailure({ core, now: cb.now, cooldownMs: cb.cooldownMs, failureThreshold: cb.failureThreshold }, 'web:a');
  assert.equal(reopened.state, 'OPEN');
  const record = snapshot({ core: reopened.core }).records[0];
  assert.equal(record.openedAt, T0 + 1000, 'the cooldown is fresh');
  assert.equal(record.consecutiveFailures, 3, 'the streak is set to the threshold, not incremented past it');

  time.advance(999);
  assert.equal(state({ core: reopened.core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a'), 'OPEN', 'the fresh cooldown is real');
  time.advance(1);
  assert.equal(state({ core: reopened.core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a'), 'HALF_OPEN', 'and it elapses exactly once');
});

test('cancelProbe frees a consumed probe without changing breaker state', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 1, cooldownMs: 1000 });
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  const opened = { core: cb.core() };
  time.advance(1000);
  const view = { core: opened.core, now: cb.now, cooldownMs: cb.cooldownMs };
  const first = admit(view, 'web:a');
  assert.equal(first.admitted, true);
  assert.equal(admit({ ...view, core: first.core }, 'web:a').admitted, false);

  const recordBefore = snapshot({ core: first.core }).records;
  const released = cancelProbe({ core: first.core }, 'web:a');
  assert.deepEqual(snapshot({ core: released.core }).records, recordBefore, 'the record is untouched');
  assert.deepEqual(snapshot({ core: released.core }).probes, [], 'the probe is freed');
  assert.equal(state({ core: released.core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a'), 'HALF_OPEN', 'the breaker state is unchanged');
  assert.equal(admit({ ...view, core: released.core }, 'web:a').admitted, true, 'a freed probe may be consumed again');

  const absent = cancelProbe({ core: released.core }, 'web:c');
  assert.deepEqual(snapshot({ core: absent.core }).records, recordBefore, 'cancelling an unknown runtime changes nothing');
  assert.equal(absent.core, released.core, 'and it returns the very same state');
});

test('reset removes the record and the probe, so the runtime is CLOSED again', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 1, cooldownMs: 1000 });
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  const opened = { core: cb.core() };
  time.advance(1000);
  const view = { core: opened.core, now: cb.now, cooldownMs: cb.cooldownMs };
  const probe = admit(view, 'web:a');
  assert.equal(probe.admitted, true);
  assert.equal(list({ ...view, core: probe.core }).length, 1);

  const cleared = reset({ core: probe.core }, 'web:a');
  assert.deepEqual(snapshot({ core: cleared.core }).records, []);
  assert.deepEqual(snapshot({ core: cleared.core }).probes, []);
  assert.equal(state({ ...view, core: cleared.core }, 'web:a'), 'CLOSED');
  assert.deepEqual(list({ ...view, core: cleared.core }), []);

  const again = observeFailure({ ...view, core: cleared.core, failureThreshold: cb.failureThreshold }, 'web:a');
  assert.equal(snapshot({ core: again.core }).records[0].consecutiveFailures, 1, 'the streak starts over, not at the old value');
});

test('list reports each runtime’s current state and streak', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 2, cooldownMs: 1000 });
  let core = cb.core();
  core = observeFailure({ core, now: cb.now, cooldownMs: cb.cooldownMs, failureThreshold: cb.failureThreshold }, 'web:a').core;
  core = observeFailure({ core, now: cb.now, cooldownMs: cb.cooldownMs, failureThreshold: cb.failureThreshold }, 'web:a').core;
  core = observeFailure({ core, now: cb.now, cooldownMs: cb.cooldownMs, failureThreshold: cb.failureThreshold }, 'web:b').core;
  const view = { core, now: cb.now, cooldownMs: cb.cooldownMs };
  assert.deepEqual(list(view), [
    { runtimeId: 'web:a', state: 'OPEN', consecutiveFailures: 2 },
    { runtimeId: 'web:b', state: 'CLOSED', consecutiveFailures: 1 },
  ]);

  time.advance(1000);
  assert.deepEqual(list(view), [
    { runtimeId: 'web:a', state: 'HALF_OPEN', consecutiveFailures: 2 },
    { runtimeId: 'web:b', state: 'CLOSED', consecutiveFailures: 1 },
  ], 'list reports the derived state, not the stored one');

  const healthy = observeSuccess({ ...view, core }, 'web:a');
  assert.deepEqual(list({ ...view, core: healthy.core }), [
    { runtimeId: 'web:a', state: 'CLOSED', consecutiveFailures: 0 },
    { runtimeId: 'web:b', state: 'CLOSED', consecutiveFailures: 1 },
  ], 'a success clears only its own streak');
});

test('a snapshot restores exactly, and the effective options travel with it', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 5, cooldownMs: 1000 });
  let core = failTimes(cb, 'web:a', 5);
  time.advance(1000);
  const probe = admit({ core, now: cb.now, cooldownMs: cb.cooldownMs }, 'web:a');
  assert.equal(probe.admitted, true, 'the breaker is HALF_OPEN, so one probe is admitted');
  core = probe.core;

  const persisted = snapshot({ core });
  assert.equal(persisted.schemaVersion, 1);
  assert.deepEqual(persisted.records, [
    {
      runtimeId: 'web:a',
      state: 'OPEN',
      consecutiveFailures: 5,
      openedAt: T0,
      updatedAt: new Date(T0).toISOString(),
    },
  ]);
  assert.deepEqual(persisted.probes, [{ runtimeId: 'web:a', probes: 1 }]);

  const restored = createCircuitBreaker({
    state: JSON.parse(JSON.stringify(persisted)),
    options: { now: time.now, failureThreshold: 5, cooldownMs: 1000 },
  });
  assert.equal(restored.failureThreshold, 5);
  assert.equal(restored.cooldownMs, 1000);
  assert.equal(restored.admit('web:a'), false, 'the consumed probe survived the round trip');
  assert.deepEqual(restored.list(), [{ runtimeId: 'web:a', state: 'HALF_OPEN', consecutiveFailures: 5 }]);

  const empty = emptyCircuitSnapshot();
  assert.deepEqual(empty, { schemaVersion: 1, records: [], probes: [] });
  assert.deepEqual(createCircuitBreaker({ state: empty, options: { now: time.now } }).list(), []);
});

test('a malformed snapshot throws instead of being repaired', () => {
  const record = { runtimeId: 'web:a', state: 'OPEN', consecutiveFailures: 1, openedAt: T0, updatedAt: new Date(T0).toISOString() };
  const good = { schemaVersion: 1, records: [record], probes: [] };
  assert.deepEqual(loadCircuitSnapshot(good).records, [record], 'a well-formed snapshot round-trips');
  assert.equal(loadCircuitSnapshot({ schemaVersion: 1, records: [record] }).probes.length, 0, 'probes are optional');

  const rejected = [
    ['no schemaVersion', { records: [] }],
    ['unknown schemaVersion', { schemaVersion: 2, records: [] }],
    ['records not an array', { schemaVersion: 1, records: {} }],
    ['record not an object', { schemaVersion: 1, records: [null] }],
    ['empty runtimeId', { schemaVersion: 1, records: [{ ...record, runtimeId: '' }] }],
    ['non-string runtimeId', { schemaVersion: 1, records: [{ ...record, runtimeId: 7 }] }],
    ['HALF_OPEN is not storable', { schemaVersion: 1, records: [{ ...record, state: 'HALF_OPEN' }] }],
    ['unknown state', { schemaVersion: 1, records: [{ ...record, state: 'BROKEN' }] }],
    ['fractional streak', { schemaVersion: 1, records: [{ ...record, consecutiveFailures: 1.5 }] }],
    ['negative streak', { schemaVersion: 1, records: [{ ...record, consecutiveFailures: -1 }] }],
    ['missing streak', { schemaVersion: 1, records: [{ runtimeId: 'web:a', state: 'OPEN', updatedAt: new Date(T0).toISOString() }] }],
    ['missing updatedAt', { schemaVersion: 1, records: [{ runtimeId: 'web:a', state: 'OPEN', consecutiveFailures: 1 }] }],
    ['non-finite openedAt', { schemaVersion: 1, records: [{ ...record, openedAt: 'yesterday' }] }],
    ['duplicate runtime', { schemaVersion: 1, records: [record, record] }],
    ['zero probes', { schemaVersion: 1, records: [record], probes: [{ runtimeId: 'web:a', probes: 0 }] }],
    ['fractional probes', { schemaVersion: 1, records: [record], probes: [{ runtimeId: 'web:a', probes: 0.5 }] }],
    ['probes not an array', { schemaVersion: 1, records: [record], probes: {} }],
    ['duplicate probe', { schemaVersion: 1, records: [record], probes: [{ runtimeId: 'web:a', probes: 1 }, { runtimeId: 'web:a', probes: 1 }] }],
    ['not an object', []],
  ];
  for (const [name, value] of rejected) {
    assert.throws(() => loadCircuitSnapshot(value), CircuitRecordError, name);
  }
  assert.throws(
    () => createCircuitBreaker({ state: { schemaVersion: 9, records: [] }, options: { now: () => T0 } }),
    CircuitRecordError,
    'the factory applies the same validation as the loader',
  );
});

test('the value-level calls return new state and never mutate the state they were given', () => {
  const { breaker: cb, time } = breaker({ failureThreshold: 1, cooldownMs: 1000 });
  assert.deepEqual(snapshot({ core: cb.core() }), { schemaVersion: 1, records: [], probes: [] }, 'a fresh breaker holds nothing');
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  const opened = { core: cb.core() };

  time.advance(1000);
  // A deliberately independent copy of the OPEN state.
  const frozen = {
    records: new Map(opened.core.records),
    halfOpenProbes: new Map(opened.core.halfOpenProbes),
  };
  const view = { core: frozen, now: cb.now, cooldownMs: cb.cooldownMs };
  const once = admit(view, 'web:a');
  assert.equal(once.admitted, true);
  assert.deepEqual(snapshot({ core: frozen }).probes, [], 'the admitted-probe state is a new value');
  assert.deepEqual(snapshot({ core: once.core }).probes, [{ runtimeId: 'web:a', probes: 1 }]);
  assert.equal(once.core.records, frozen.records, 'records are shared when nothing changed them');
  assert.equal(admit({ ...view, core: once.core }, 'web:a').admitted, false, 'the copy is what consumed the probe');

  const success = observeSuccess({ ...view, core: once.core }, 'web:a');
  assert.deepEqual(snapshot({ core: once.core }).probes, [{ runtimeId: 'web:a', probes: 1 }], 'the previous state keeps its probe');
  assert.deepEqual(snapshot({ core: success.core }).probes, [], 'the success clears it in the returned state only');
  assert.equal(success.state, 'CLOSED');
});

test('only the six provider-technical kinds trip the breaker', () => {
  assert.deepEqual([...PROVIDER_TECHNICAL_KINDS], [
    'NETWORK_FAILURE',
    'PROVIDER_5XX',
    'TOOL_TIMEOUT',
    'BROWSER_CRASH',
    'PROCESS_CRASH',
    'RESOURCE_EXHAUSTED',
  ]);
  assert.deepEqual([...NON_TECHNICAL_KINDS], [
    'RATE_LIMIT',
    'QUOTA_EXHAUSTED',
    'CREDIT_EXHAUSTED',
    'SESSION_EXPIRED',
    'AUTH_EXPIRED',
    'DEPENDENCY_FAILURE',
    'HUMAN_APPROVAL_REQUIRED',
    'UNKNOWN_INTERRUPTION',
  ]);
  assert.equal(PROVIDER_TECHNICAL_KINDS.length + NON_TECHNICAL_INTERRUPTION_KINDS.length, INTERRUPTION_KINDS.length);

  const technical = { NETWORK_FAILURE: true, PROVIDER_5XX: true, TOOL_TIMEOUT: true, BROWSER_CRASH: true, PROCESS_CRASH: true, RESOURCE_EXHAUSTED: true };
  for (const kind of INTERRUPTION_KINDS) {
    assert.equal(
      providerTechnicalInterruption(kind),
      technical[kind] ?? false,
      `${kind} must be ${technical[kind] ? 'technical' : 'non-technical'}`,
    );
  }

  assert.equal(providerTechnicalInterruption('AUTH_REQUIRED'), false, 'the runtime code form is not a kind');
  assert.equal(providerTechnicalInterruption('BUDGET_EXHAUSTED'), false, 'a quota code must not trip the breaker');
  assert.equal(providerTechnicalInterruption('NETWORK_FAILURE '), false, 'no trimming, no guessing');
  assert.equal(providerTechnicalInterruption(''), false);
  assert.equal(providerTechnicalInterruption(undefined), false);
  assert.equal(providerTechnicalInterruption(null), false);
  assert.equal(providerTechnicalInterruption(7), false);
});

test('one broken runtime does not disturb another', () => {
  const { breaker: cb } = breaker({ failureThreshold: 1 });
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  assert.equal(cb.state('web:b'), 'CLOSED');
  assert.equal(cb.isOpen('web:b'), false);
  assert.deepEqual(cb.list(), [{ runtimeId: 'web:a', state: 'OPEN', consecutiveFailures: 1 }]);
});

test('an option that cannot be an integer fails closed', () => {
  assert.throws(() => createCircuitBreaker({ options: { now: () => T0, failureThreshold: 2.0000001 } }), CircuitOptionError);
  assert.throws(() => createCircuitBreaker({ options: { now: 'now' } }), CircuitOptionError, 'the clock must be callable');
  assert.throws(() => createCircuitBreaker({ options: { now: () => T0, cooldownMs: [604800000] } }), CircuitOptionError, 'an array is not an integer');
  assert.throws(() => createCircuitBreaker('breaker.json'), CircuitOptionError, 'the configuration must be an object');
  assert.equal(createCircuitBreaker({ options: { now: () => T0, cooldownMs: null } }).cooldownMs, 60000, 'null is the donor default, not an error');
});

test('a caller-supplied file path is not part of this module’s shape', () => {
  // The donor's constructor takes an optional path and persists through it.
  // Persistence is deferred here, so a path is simply not an argument: no file
  // is opened, and the breaker behaves exactly as an in-memory breaker.
  assert.throws(() => createCircuitBreaker('breaker.json'), CircuitOptionError, 'a path is not a configuration');
  const { breaker: cb } = breaker({ failureThreshold: 1 });
  assert.equal(cb.observeFailure('web:a'), 'OPEN');
  assert.equal(snapshot({ core: cb.core() }).records.length, 1, 'the record lives in the returned state, not on disk');
});
