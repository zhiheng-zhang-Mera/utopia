// PCF-701 acceptance: tests/pcf701-telemetry.test.mjs
//
// The workbook names the counter-examples this suite must contain, and each one is a way a resource collector usually
// lies: it turns an unreadable value into 0, lets an out-of-order packet overwrite a newer one, mixes two boots, lets
// a clock that stepped backwards keep stale data alive, freezes its caller when a probe never returns, or loses
// buffered samples without saying so. Every test here is written so that it FAILS if the corresponding lie comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DIMENSIONS, FRESHNESS, OBSERVATION_SCHEMA_VERSION, PRESENCE, SAMPLE_REASONS, observeResources, freshnessAt, valueOrNull} from '../contracts/personal-compute-fabric-v1/observations.mjs';
import {COLLECT_STATUS, createTelemetryCollector} from '../services/personal-compute-fabric/telemetry.mjs';

const CONTEXT = {receivedAt: 1_000_000, bootId: 'boot-A', ttlMs: 1000, staleAfterMs: 3000, source: 'unit-test'};
const state = (observation, dimension) => observation.dimensions[dimension];

test('PCF-701 T1: missing, NaN, negative and wrong-unit values never become 0', () => {
  const observation = observeResources({
    cpu: {value: undefined, observedAt: CONTEXT.receivedAt},
    memory: {value: Number.NaN, unit: 'bytes', observedAt: CONTEXT.receivedAt},
    disk: {value: -1, unit: 'bytes', observedAt: CONTEXT.receivedAt},
    queue: {value: 3, unit: 'seconds', observedAt: CONTEXT.receivedAt},
    battery: {value: 1.5, unit: 'ratio', observedAt: CONTEXT.receivedAt},
  }, CONTEXT);

  const expected = {cpu: SAMPLE_REASONS.MISSING_VALUE, memory: SAMPLE_REASONS.NOT_A_NUMBER, disk: SAMPLE_REASONS.NEGATIVE, queue: SAMPLE_REASONS.WRONG_UNIT, battery: SAMPLE_REASONS.OUT_OF_RANGE};
  for (const [dimension, reason] of Object.entries(expected)) {
    const s = state(observation, dimension);
    assert.equal(s.reason, reason, `${dimension} must say why it has no value`);
    assert.equal(s.presence, PRESENCE.UNKNOWN, `${dimension} presence must be UNKNOWN`);
    assert.equal(s.value, null, `${dimension} must not carry a value`);
    assert.notEqual(s.value, 0, `${dimension} must not be turned into 0`);
    assert.equal(valueOrNull(observation, dimension), null, `${dimension} must read as null, not 0`);
  }
  assert.equal(observation.counters.accepted, 0);
  assert.equal(observation.counters.rejected, 5);
});

test('PCF-701 T2: an out-of-order sample does not overwrite a newer value', () => {
  const first = observeResources({memory: {value: 8, unit: 'bytes', sequence: 7, observedAt: CONTEXT.receivedAt}}, CONTEXT);
  assert.equal(valueOrNull(first, 'memory'), 8);
  const second = observeResources({memory: {value: 999, unit: 'bytes', sequence: 6, observedAt: CONTEXT.receivedAt}}, {...CONTEXT, receivedAt: CONTEXT.receivedAt + 10, previous: first});
  const s = state(second, 'memory');
  assert.equal(s.reason, SAMPLE_REASONS.OUT_OF_ORDER);
  assert.equal(s.value, null, 'the stale packet must not land as a value');
  assert.equal(second.counters.outOfOrder, 1);
  // The newer value is not silently replaced anywhere either: this observation simply has no memory reading.
  assert.equal(valueOrNull(second, 'memory'), null);
});

test('PCF-701 T3: a sample from another boot epoch is not mixed into this boot', () => {
  const observation = observeResources({cpu: {value: 0.5, unit: 'ratio', bootId: 'boot-B', observedAt: CONTEXT.receivedAt}}, CONTEXT);
  const s = state(observation, 'cpu');
  assert.equal(s.reason, SAMPLE_REASONS.REBOOT_EPOCH);
  assert.equal(s.value, null);
  assert.equal(valueOrNull(observation, 'cpu'), null);
});

test('PCF-701 T4: a backwards clock cannot keep stale data fresh', () => {
  const fresh = observeResources({cpu: {value: 0.25, unit: 'ratio', observedAt: CONTEXT.receivedAt}}, CONTEXT);
  assert.equal(state(fresh, 'cpu').freshness, FRESHNESS.FRESH);
  // The receiver's clock jumps backwards; the sample is the same one, so it is older than the clock now claims.
  const afterRollback = observeResources({cpu: {value: 0.25, unit: 'ratio', observedAt: CONTEXT.receivedAt}}, {...CONTEXT, receivedAt: CONTEXT.receivedAt - 5000, previous: fresh});
  assert.equal(afterRollback.clockRollback, true, 'the collection must record that its clock went backwards');
  assert.notEqual(state(afterRollback, 'cpu').freshness, FRESHNESS.FRESH, 'a rollback may never leave data FRESH');
  // Age is monotonic by hand: it must not become negative or shrink.
  assert.ok(state(afterRollback, 'cpu').ageMs >= state(fresh, 'cpu').ageMs, 'age must not go backwards with the clock');
  // THE ACCEPTED-VALUE ROLLBACK: the clock moves backwards but the sample is genuinely older than the new "now" and
  // within TTL, so it IS accepted - and the collection's rollback flag must downgrade it from FRESH to STALE. Without
  // this case the rollback branch inside the freshness rule is never exercised (proven by falsification: deleting
  // that branch left the suite green until this test existed).
  const older = observeResources({cpu: {value: 0.25, unit: 'ratio', observedAt: CONTEXT.receivedAt - 10, sequence: 1}}, CONTEXT);
  assert.equal(state(older, 'cpu').freshness, FRESHNESS.FRESH);
  // The sample is 5ms old against the REWOUND clock and 10ms old against the recorded age, so it is well inside the
  // TTL: only the collection's rollback flag can stop it being reported FRESH.
  const acceptedAfterRollback = observeResources({cpu: {value: 0.3, unit: 'ratio', observedAt: CONTEXT.receivedAt - 5005, sequence: 2}}, {...CONTEXT, receivedAt: CONTEXT.receivedAt - 5000, previous: older});
  assert.equal(acceptedAfterRollback.clockRollback, true);
  assert.equal(state(acceptedAfterRollback, 'cpu').value, 0.3, 'a sample older than the rewound clock is still a real measurement');
  assert.equal(state(acceptedAfterRollback, 'cpu').freshness, FRESHNESS.STALE, 'the rollback flag must downgrade FRESH to STALE');
  assert.equal(state(acceptedAfterRollback, 'cpu').reason, SAMPLE_REASONS.CLOCK_ROLLBACK);
  // A future-dated sample is recorded, never called fresh.
  const future = observeResources({cpu: {value: 0.25, unit: 'ratio', observedAt: CONTEXT.receivedAt + 60_000}}, CONTEXT);
  assert.equal(state(future, 'cpu').reason, SAMPLE_REASONS.CLOCK_ROLLBACK);
  assert.equal(state(future, 'cpu').value, null);
});

test('PCF-701 T5: freshness at a later time expires, and a rewound caller clock cannot resurrect it', () => {
  const observation = observeResources({cpu: {value: 0.5, unit: 'ratio', observedAt: CONTEXT.receivedAt}}, CONTEXT);
  assert.equal(freshnessAt(observation, CONTEXT.receivedAt + 500).cpu, FRESHNESS.FRESH);
  assert.equal(freshnessAt(observation, CONTEXT.receivedAt + 2000).cpu, FRESHNESS.STALE);
  assert.equal(freshnessAt(observation, CONTEXT.receivedAt + 99_999).cpu, FRESHNESS.EXPIRED);
  // A value that arrived long ago stays old even if the caller's clock is rewound past its arrival: age is floored by
  // what was already recorded, so staleness cannot be undone by moving the clock.
  const stale = observeResources({cpu: {value: 0.5, unit: 'ratio', observedAt: CONTEXT.receivedAt - 5000}}, CONTEXT);
  assert.equal(state(stale, 'cpu').freshness, FRESHNESS.EXPIRED);
  assert.equal(freshnessAt(stale, CONTEXT.receivedAt - 99_999).cpu, FRESHNESS.EXPIRED);
  assert.notEqual(freshnessAt(stale, CONTEXT.receivedAt - 99_999).cpu, FRESHNESS.FRESH);
  // And freshnessAt never re-derives a value, only a freshness verdict.
  assert.equal(Object.keys(freshnessAt(observation, CONTEXT.receivedAt)).length, Object.keys(DIMENSIONS).length);
});

test('PCF-701 T6: an absent optional adapter is UNSUPPORTED, not zero', () => {
  const observation = observeResources({cpu: 0.1}, {...CONTEXT, unsupported: ['vram', 'battery', 'thermal']});
  for (const dimension of ['vram', 'battery', 'thermal']) {
    assert.equal(state(observation, dimension).presence, PRESENCE.UNSUPPORTED, `${dimension} must be UNSUPPORTED`);
    assert.equal(state(observation, dimension).reason, SAMPLE_REASONS.NO_ADAPTER);
    assert.equal(valueOrNull(observation, dimension), null, `${dimension} must not read as 0`);
  }
  // A dimension nobody mentioned is UNKNOWN rather than unsupported: the two are different facts.
  assert.equal(state(observation, 'networkRtt').presence, PRESENCE.UNKNOWN);
});

test('PCF-701 T7: a probe that never returns does not freeze the executor', async () => {
  let calls = 0;
  const hanging = createTelemetryCollector({sample: () => { calls += 1; return new Promise(() => {}); }, now: () => CONTEXT.receivedAt, budgetMs: 25, minIntervalMs: 0});
  const started = Date.now();
  const outcome = await hanging.collect();
  assert.equal(outcome.status, COLLECT_STATUS.TIMEOUT, 'a hung adapter must become a bounded TIMEOUT');
  assert.ok(Date.now() - started < 1000, 'collect() must resolve near its budget, not hang with the adapter');
  for (const dimension of Object.keys(DIMENSIONS)) {
    assert.equal(state(outcome.observation, dimension).presence, PRESENCE.UNKNOWN, `${dimension} must be UNKNOWN after a timeout`);
    assert.equal(state(outcome.observation, dimension).value, null, `${dimension} must not be filled in as 0`);
  }
  assert.equal(hanging.stats().timeouts, 1);
  // The collector is not poisoned: the next call runs the adapter again and reports a real value.
  const later = createTelemetryCollector({sample: () => ({cpu: 0.4}), now: () => CONTEXT.receivedAt, budgetMs: 25, minIntervalMs: 0});
  const ok = await later.collect();
  assert.equal(ok.status, COLLECT_STATUS.OBSERVED);
  assert.equal(valueOrNull(ok.observation, 'cpu'), 0.4);
  assert.equal(calls, 1, 'the hung adapter was invoked exactly once and then abandoned');
});

test('PCF-701 T8: a failed sampler is reported, and still no value is invented', async () => {
  const failing = createTelemetryCollector({sample: () => { throw new Error('adapter exploded'); }, now: () => CONTEXT.receivedAt, minIntervalMs: 0});
  const outcome = await failing.collect();
  assert.equal(outcome.status, COLLECT_STATUS.SAMPLE_FAILED);
  assert.match(outcome.error, /adapter exploded/);
  assert.equal(valueOrNull(outcome.observation, 'memory'), null);
  assert.equal(failing.stats().failures, 1);
});

test('PCF-701 T9: the buffer is bounded and its drops are visible', () => {
  const clock = {t: CONTEXT.receivedAt};
  const collector = createTelemetryCollector({sample: () => ({cpu: 0.1}), now: () => clock.t, monotonic: () => clock.t, bufferLimit: 3, minIntervalMs: 0});
  for (let index = 0; index < 5; index += 1) { clock.t += 10; collector.ingest({memory: {value: index, unit: 'bytes', sequence: index, observedAt: clock.t}}); }
  const stats = collector.stats();
  assert.equal(stats.buffered, 3, 'the ring must never exceed its capacity');
  assert.equal(stats.dropped, 2, 'two samples left the ring and the loss must be readable');
  assert.ok(Object.keys(stats.droppedReasons).length >= 1, 'drops must carry a reason');
  const history = collector.history();
  assert.equal(history.length, 3);
  assert.equal(valueOrNull(history[0], 'memory'), 4, 'history is newest first');
  assert.equal(valueOrNull(history[2], 'memory'), 2, 'the oldest surviving sample is the third one written');
});

test('PCF-701 T10: collection is rate limited and a throttled call does not probe', async () => {
  let calls = 0;
  const clock = {t: CONTEXT.receivedAt};
  const collector = createTelemetryCollector({sample: () => { calls += 1; return {cpu: 0.2}; }, now: () => clock.t, monotonic: () => clock.t, minIntervalMs: 1000});
  const first = await collector.collect();
  assert.equal(first.status, COLLECT_STATUS.OBSERVED);
  clock.t += 200;
  const throttled = await collector.collect();
  assert.equal(throttled.status, COLLECT_STATUS.THROTTLED);
  assert.equal(calls, 1, 'a throttled call must not invoke the adapter');
  assert.equal(throttled.observation, first.observation, 'it returns the previous observation rather than inventing one');
  clock.t += 2000;
  const third = await collector.collect();
  assert.equal(third.status, COLLECT_STATUS.OBSERVED);
  assert.equal(calls, 2);
});

test('PCF-701 T11: measurement overhead is measured, not guessed', async () => {
  const wall = {t: CONTEXT.receivedAt};
  const ticks = {t: 0};
  // The adapter itself burns 5 monotonic ticks, which is exactly the quantity the collector must attribute.
  const collector = createTelemetryCollector({sample: () => { ticks.t += 5; return {cpu: 0.3}; }, now: () => wall.t, monotonic: () => ticks.t, minIntervalMs: 0});
  await collector.collect();
  wall.t += 1000;
  await collector.collect();
  const stats = collector.stats();
  assert.equal(stats.overheadMs.last, 5, 'the last attempt must report what the adapter cost');
  assert.equal(stats.overheadMs.max, 5);
  assert.equal(stats.overheadMs.total, 10, 'overhead accumulates across attempts');
  assert.equal(stats.observed, 2);
});

test('PCF-701 T12: only authorised surfaces are ever looked at', () => {
  const observation = observeResources({
    cpu: 0.5,
    processName: {value: 'secret-application'},
    windowTitle: {value: 'private document'},
    personalFile: {value: '/home/someone/notes.txt'},
  }, CONTEXT);
  for (const forbidden of ['processName', 'windowTitle', 'personalFile']) {
    const s = state(observation, forbidden);
    assert.equal(s.presence, PRESENCE.UNSUPPORTED, `${forbidden} must be UNSUPPORTED`);
    assert.equal(s.reason, SAMPLE_REASONS.UNKNOWN_DIMENSION);
    assert.equal(s.value, null, `${forbidden} must never be stored as data`);
  }
  assert.equal(valueOrNull(observation, 'processName'), null);
  // The collector states its surfaces, so an auditor can diff them against the workbook instead of trusting prose.
  const collector = createTelemetryCollector({sample: () => ({cpu: 0.1}), now: () => CONTEXT.receivedAt, minIntervalMs: 0});
  collector.ingest({cpu: 0.1});
  assert.deepEqual([...collector.inspectedSurfaces()].sort(), Object.keys(DIMENSIONS).sort());
});

test('PCF-701 T13: the same sample and context always produce the same observation (replayable)', () => {
  const sample = {cpu: {value: 0.4, unit: 'ratio', sequence: 3, observedAt: CONTEXT.receivedAt - 10}, memory: {value: 1024, unit: 'bytes', sequence: 3, observedAt: CONTEXT.receivedAt - 10}};
  const first = observeResources(sample, CONTEXT);
  const second = observeResources(sample, CONTEXT);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.equal(first.schemaVersion, OBSERVATION_SCHEMA_VERSION);
  assert.equal(first.receivedAt, CONTEXT.receivedAt);
  assert.equal(first.bootId, 'boot-A');
  // Source, units and both timestamps survive into the record.
  assert.equal(state(first, 'cpu').unit, 'ratio');
  assert.equal(state(first, 'cpu').source, 'unit-test');
  assert.equal(state(first, 'cpu').observedAt, CONTEXT.receivedAt - 10);
  assert.equal(state(first, 'cpu').receivedAt, CONTEXT.receivedAt);
  assert.equal(state(first, 'cpu').ttlMs, 1000);
  // A context that cannot say when the sample arrived is a programming error, and it is loud.
  assert.throws(() => observeResources({cpu: 0.5}, {bootId: 'boot-A'}), /CONTEXT_INVALID/);
});
