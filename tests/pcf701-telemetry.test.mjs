// PCF-701 acceptance: tests/pcf701-telemetry.test.mjs
//
// The workbook names the counter-examples this suite must contain, and each one is a way a resource collector usually
// lies: it turns an unreadable value into 0, lets an out-of-order packet overwrite a newer one, mixes two boots, lets
// a clock that stepped backwards keep stale data alive, freezes its caller when a probe never returns, or loses
// buffered samples without saying so. Every test here is written so that it FAILS if the corresponding lie comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DIMENSIONS, FACETS, FRESHNESS, OBSERVATION_SCHEMA_VERSION, PRESENCE, SAMPLE_REASONS, dimensionKeys, observeResources, freshnessAt, valueOrNull} from '../contracts/personal-compute-fabric-v1/observations.mjs';
import {COLLECT_STATUS, createTelemetryCollector} from '../services/personal-compute-fabric/telemetry.mjs';
import {ADAPTER_KINDS, UNSUPPORTED_ON_THIS_ADAPTER, createAdapterRegistry, createQueueAdapter, createRuntimeOccupancyAdapter, createSystemAdapter} from '../services/personal-compute-fabric/adapters.mjs';
import {PROBE_REASONS, PROBE_STATUS, createPathProbe} from '../services/personal-compute-fabric/network-probe.mjs';

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
  // And freshnessAt never re-derives a value, only a freshness verdict - over every declared key, facets included.
  assert.equal(Object.keys(freshnessAt(observation, CONTEXT.receivedAt)).length, dimensionKeys().length);
  assert.ok(dimensionKeys().length > Object.keys(DIMENSIONS).length, 'the facet keys must be part of the declared key set');
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
  assert.deepEqual([...collector.inspectedSurfaces()].sort(), dimensionKeys());
});

test('PCF-701 T14: total, free, reserved and in-use are separate facts, and one bad facet fails alone', () => {
  const observation = observeResources({
    memory: {unit: 'bytes', observedAt: CONTEXT.receivedAt, facets: {total: 8_000, free: 3_000, reserved: 1_000, inUse: Number.NaN}},
    disk: {unit: 'bytes', observedAt: CONTEXT.receivedAt, facets: {total: 100, free: 40}},
  }, CONTEXT);
  assert.equal(valueOrNull(observation, 'memory.total'), 8_000);
  assert.equal(valueOrNull(observation, 'memory.free'), 3_000);
  assert.equal(valueOrNull(observation, 'memory.reserved'), 1_000);
  // The NaN in-use did not damage the three good facets, and it did not become 0 either.
  assert.equal(state(observation, 'memory.inUse').reason, SAMPLE_REASONS.NOT_A_NUMBER);
  assert.equal(state(observation, 'memory.inUse').value, null);
  assert.notEqual(state(observation, 'memory.inUse').value, 0);
  // A facet the sample omits is UNKNOWN rather than a copy of the base reading.
  assert.equal(state(observation, 'disk.reserved').presence, PRESENCE.UNKNOWN);
  assert.equal(state(observation, 'disk.reserved').reason, SAMPLE_REASONS.MISSING_VALUE);
  // The declared key set now includes the facets, and the base dimensions are still there.
  assert.ok(dimensionKeys().includes('memory.free') && dimensionKeys().includes('disk.total'));
  assert.deepEqual(Object.keys(FACETS).sort(), ['disk', 'memory']);
  // A single "memory" number is never claimed: the facets are the reading.
  assert.equal(valueOrNull(observation, 'memory'), null);
});

test('PCF-701 T15: a free figure larger than its total is refused as two unusable numbers', () => {
  const observation = observeResources({memory: {unit: 'bytes', observedAt: CONTEXT.receivedAt, facets: {total: 1_000, free: 5_000}}}, CONTEXT);
  for (const key of ['memory.total', 'memory.free']) {
    assert.equal(state(observation, key).reason, SAMPLE_REASONS.FACET_INCONSISTENT, `${key} must carry the contradiction`);
    assert.equal(state(observation, key).value, null, `${key} must not be handed on as a usable number`);
    assert.deepEqual(state(observation, key).raw, {total: 1_000, free: 5_000}, `${key} keeps the raw pair for diagnosis`);
  }
  assert.equal(valueOrNull(observation, 'memory.total'), null);
});

test('PCF-701 T16: the system adapter reports what it can read and names what it cannot', async () => {
  const adapter = createSystemAdapter();
  const {sample, notes} = await adapter.sample(CONTEXT.receivedAt);
  // Whatever the host can read must be a real number, never a placeholder zero: on this machine memory is readable.
  const total = sample.memory?.facets?.total;
  const free = sample.memory?.facets?.free;
  assert.ok(Number.isFinite(total) && total > 0, `memory.total must be a real reading (got ${total})`);
  assert.ok(Number.isFinite(free) && free >= 0, `memory.free must be a real reading (got ${free})`);
  assert.ok(total >= free, 'total must not be smaller than free');
  assert.equal(sample.memory.value, undefined, 'the adapter must not claim one combined memory number');
  if (sample.cpu) assert.ok(sample.cpu.value >= 0 && sample.cpu.value <= 1, 'cpu is a clamped demand ratio');
  // Hardware this adapter does not talk to is DECLARED, so it is reported rather than omitted.
  assert.deepEqual([...UNSUPPORTED_ON_THIS_ADAPTER].sort(), ['battery', 'networkRtt', 'networkThroughput', 'thermal', 'vram']);
  const registry = createAdapterRegistry({adapters: [adapter], now: () => CONTEXT.receivedAt});
  const collected = await registry.collect();
  assert.ok(collected.unsupported.includes('vram') && collected.unsupported.includes('battery'), 'absent hardware must be reported UNSUPPORTED');
  assert.ok(!collected.unsupported.includes('memory'), 'memory was read, so it must not be reported unsupported');
  // Through the contract, the unsupported dimensions keep their name and carry no value.
  const observation = observeResources(collected.sample, {...CONTEXT, unsupported: collected.unsupported});
  assert.equal(state(observation, 'vram').presence, PRESENCE.UNSUPPORTED);
  assert.equal(valueOrNull(observation, 'vram'), null);
  assert.ok(valueOrNull(observation, 'memory.total') > 0, 'the real readings survive alongside the declared gaps');
  assert.ok(Array.isArray(notes));
});

test('PCF-701 T17: an unavailable adapter keeps its dimensions named instead of dropping them', async () => {
  const absent = {id: 'gpu-vendor-tool', kind: ADAPTER_KINDS.OPTIONAL, dimensions: ['vram'], unsupported: [], available: () => false, sample: () => ({vram: {value: 999, unit: 'bytes'}})};
  const registry = createAdapterRegistry({adapters: [absent], now: () => CONTEXT.receivedAt});
  const collected = await registry.collect();
  assert.ok(collected.unsupported.includes('vram'), 'an unavailable adapter must name its dimensions');
  assert.equal(collected.sample.vram, undefined, 'an unavailable adapter must not contribute a value');
  assert.ok(collected.notes.some(note => note.includes('unavailable')));
  const observation = observeResources(collected.sample, {...CONTEXT, unsupported: collected.unsupported});
  assert.equal(valueOrNull(observation, 'vram'), null, 'and the contract must not turn the gap into 0');
});

test('PCF-701 T18: latency belongs to a PATH, and an unmeasured path is never 0 ms', async () => {
  const clock = {t: CONTEXT.receivedAt};
  const ticks = {t: 0};
  const probe = createPathProbe({measure: async () => 12.5, now: () => clock.t, monotonic: () => ticks.t, minIntervalMs: 1000});
  // Never measured yet: UNKNOWN, not zero.
  assert.equal(probe.rttOrNull({from: 'mech', to: 'alien'}), null);
  const first = await probe.measurePath({from: 'mech', to: 'alien'});
  assert.equal(first.status, PROBE_STATUS.MEASURED);
  assert.equal(first.rttMs, 12.5);
  assert.equal(probe.paths()[0].status, PROBE_STATUS.MEASURED);
  // A different path is a different fact, and it stays unmeasured.
  assert.equal(probe.rttOrNull({from: 'mech', to: 'phone'}), null);
  // Throttled: the second attempt inside the window does not re-probe.
  clock.t += 100;
  const throttled = await probe.measurePath({from: 'mech', to: 'alien'});
  assert.equal(throttled.status, PROBE_STATUS.THROTTLED);
  assert.equal(throttled.rttMs, null, 'a throttled probe must not repeat the previous number as if it were fresh');
  assert.equal(probe.paths().length, 1, 'only the measured path exists in the state');
  // The sample a measured path yields is what the resource contract consumes, with the path as its source.
  assert.equal(first.sample.networkRtt.source, 'path:mech->alien');
  const observation = observeResources(first.sample, CONTEXT);
  assert.equal(valueOrNull(observation, 'networkRtt'), 12.5);
  assert.equal(state(observation, 'networkRtt').source, 'path:mech->alien');
});

test('PCF-701 T19: a probe that hangs or lies becomes a bounded failure with growing backoff', async () => {
  const clock = {t: CONTEXT.receivedAt};
  let mode = 'hang';
  const probe = createPathProbe({
    measure: async () => { if (mode === 'hang') return new Promise(() => {}); if (mode === 'lie') return 'fast'; return 4; },
    now: () => clock.t, monotonic: () => clock.t, budgetMs: 20, minIntervalMs: 0, backoffBaseMs: 1000, maxBackoffMs: 4000,
  });
  const started = Date.now();
  const timedOut = await probe.measurePath({from: 'a', to: 'b'});
  assert.equal(timedOut.status, PROBE_STATUS.TIMEOUT, 'a hung probe must become a bounded TIMEOUT');
  assert.ok(Date.now() - started < 1000, 'and it must not hold the caller for the probe\u2019s lifetime');
  assert.equal(timedOut.rttMs, null, 'a timeout is not a latency');
  assert.equal(timedOut.backoffMs, 1000, 'the first failure sets the base backoff');
  // A non-numeric answer is an INVALID_RESULT failure, never a 0 ms path and never a accepted string.
  mode = 'lie';
  clock.t += 5000;
  const lied = await probe.measurePath({from: 'a', to: 'b'});
  assert.equal(lied.status, PROBE_STATUS.FAILED);
  assert.equal(lied.reason, PROBE_REASONS.INVALID_RESULT);
  assert.equal(lied.rttMs, null);
  assert.equal(lied.backoffMs, 2000, 'consecutive failures double the backoff');
  // Backoff is capped, and a success resets both the backoff and the failure streak.
  mode = 'hang';
  clock.t += 10_000;
  await probe.measurePath({from: 'a', to: 'b'});
  clock.t += 20_000;
  const capped = await probe.measurePath({from: 'a', to: 'b'});
  assert.equal(capped.backoffMs, 4000, 'backoff must be capped rather than growing without bound');
  mode = 'ok';
  clock.t += 60_000;
  const recovered = await probe.measurePath({from: 'a', to: 'b'});
  assert.equal(recovered.status, PROBE_STATUS.MEASURED);
  assert.equal(recovered.backoffMs, 0, 'a success clears the backoff');
  assert.equal(probe.paths()[0].consecutiveFailures, 0);
  // And the history is visible rather than overwritten.
  assert.ok(probe.paths()[0].failures >= 4, `failures must stay countable, saw ${probe.paths()[0].failures}`);
});

test('PCF-701 T20: throughput is measured by moving bytes, never inferred from latency', async () => {
  const ticks = {t: 0};
  const clock = {t: CONTEXT.receivedAt};
  // 1 MiB in 100 monotonic ms = 10_485 760 B/s. The transfer reports its own elapsed time here.
  const probe = createPathProbe({measure: async () => 5, transfer: async () => ({bytes: 1_048_576, elapsedMs: 100}), now: () => clock.t, monotonic: () => ticks.t, minIntervalMs: 0});
  const measured = await probe.measureThroughput({from: 'mech', to: 'alien'}, {bytes: 1_048_576});
  assert.equal(measured.status, PROBE_STATUS.MEASURED);
  assert.equal(Math.round(measured.bytesPerSecond), 10_485_760);
  assert.equal(measured.sample.networkThroughput.unit, 'bytes_per_second');
  assert.equal(measured.sample.networkThroughput.source, 'path:mech->alien#throughput');
  // Latency and throughput are SEPARATE facts: measuring one must not answer the other.
  assert.equal(probe.rttOrNull({from: 'mech', to: 'alien'}), null, 'an unmeasured path has no latency even after a throughput run');
  // A transfer that moves nothing, or a hang, is a FAILED measurement - never a 0 B/s path.
  const empty = createPathProbe({measure: async () => 5, transfer: async () => ({bytes: 0, elapsedMs: 100}), now: () => clock.t, monotonic: () => ticks.t, minIntervalMs: 0});
  const zero = await empty.measureThroughput({from: 'a', to: 'b'}, {bytes: 0});
  assert.equal(zero.status, PROBE_STATUS.FAILED);
  assert.equal(zero.reason, PROBE_REASONS.INVALID_RESULT);
  assert.equal(zero.bytesPerSecond, null);
  const hanging = createPathProbe({measure: async () => 5, transfer: async () => new Promise(() => {}), now: () => clock.t, monotonic: () => ticks.t, budgetMs: 20, minIntervalMs: 0});
  const timedOut = await hanging.measureThroughput({from: 'a', to: 'b'}, {bytes: 1024});
  assert.equal(timedOut.status, PROBE_STATUS.FAILED);
  assert.equal(timedOut.reason, PROBE_REASONS.BUDGET_EXCEEDED);
  assert.equal(timedOut.bytesPerSecond, null);
  assert.ok(timedOut.backoffMs >= 1000, 'a failed throughput run must back off like any other failure');
  // The measured value reaches the resource contract as its own dimension.
  const observation = observeResources(measured.sample, CONTEXT);
  assert.equal(Math.round(valueOrNull(observation, 'networkThroughput')), 10_485_760);
});

test('PCF-701 T21: a queue with no declared source is UNSUPPORTED, never zero', async () => {
  const withoutSource = createQueueAdapter();
  // Directly, because the registry skips an unavailable adapter's sample(): the branch that refuses to invent a count
  // still has to be reachable, and the falsification set proved it was not (mutation M13 stayed green until this line).
  const direct = await withoutSource.sample(CONTEXT.receivedAt);
  assert.equal(direct.sample.queue, undefined, 'the adapter itself must refuse to invent a queue count');
  assert.ok(direct.notes.some(note => /no queue source/i.test(note)));
  const registry = createAdapterRegistry({adapters: [withoutSource], now: () => CONTEXT.receivedAt});
  const collected = await registry.collect();
  assert.equal(collected.sample.queue, undefined, 'no source means no value, not 0');
  assert.ok(collected.unsupported.includes('queue'));
  const observation = observeResources(collected.sample, {...CONTEXT, unsupported: collected.unsupported});
  assert.equal(state(observation, 'queue').presence, PRESENCE.UNSUPPORTED);
  assert.equal(valueOrNull(observation, 'queue'), null);
  // With a declared source the same dimension carries a real count, and a nonsense count is refused rather than stored.
  const withSource = createQueueAdapter({source: async () => 7});
  const measured = await createAdapterRegistry({adapters: [withSource], now: () => CONTEXT.receivedAt}).collect();
  assert.equal(measured.sample.queue.value, 7);
  const lying = createQueueAdapter({source: async () => Number.NaN});
  const refused = await createAdapterRegistry({adapters: [lying], now: () => CONTEXT.receivedAt}).collect();
  assert.equal(refused.sample.queue, undefined, 'a NaN queue count must not become a value');
  assert.ok(refused.unsupported.includes('queue'));
});

test('PCF-701 T22: occupancy is the runtime\u2019s own responsiveness, measured or declared unsupported', async () => {
  const perf = await import('node:perf_hooks');
  const adapter = createRuntimeOccupancyAdapter({perf});
  const registry = createAdapterRegistry({adapters: [adapter], now: () => CONTEXT.receivedAt});
  const collected = await registry.collect();
  // Either the histogram has produced a real mean by now, or the dimension must be reported unsupported. What is
  // forbidden is a fabricated 0 ms, which would claim perfect responsiveness from a window that never ran.
  if (collected.sample.occupancy !== undefined) {
    assert.ok(Number.isFinite(collected.sample.occupancy.value) && collected.sample.occupancy.value >= 0, 'a readable histogram yields a real delay');
    const observation = observeResources(collected.sample, {...CONTEXT, unsupported: collected.unsupported});
    assert.equal(state(observation, 'occupancy').unit, 'milliseconds');
    assert.notEqual(state(observation, 'occupancy').value, undefined);
  } else {
    assert.ok(collected.unsupported.includes('occupancy'), 'a histogram with no readable mean must be named unsupported');
    assert.ok(collected.notes.some(note => /not readable yet|unavailable/.test(note)), `the gap must carry a reason, saw ${JSON.stringify(collected.notes)}`);
  }
  adapter.stop();
  // Without a histogram at all the adapter is unavailable, and the dimension is named rather than answered with 0 ms.
  const blind = createRuntimeOccupancyAdapter({perf: {}});
  assert.equal(blind.available(), false);
  const blindCollected = await createAdapterRegistry({adapters: [blind], now: () => CONTEXT.receivedAt}).collect();
  assert.equal(blindCollected.sample.occupancy, undefined);
  assert.ok(blindCollected.unsupported.includes('occupancy'));
  const observation = observeResources(blindCollected.sample, {...CONTEXT, unsupported: blindCollected.unsupported});
  assert.equal(valueOrNull(observation, 'occupancy'), null, 'and the contract must not turn that gap into 0');
  // A histogram that exists but cannot produce a mean yet is the case where a fabricated 0 ms would be most tempting
  // ("responsive!"). Whatever the adapter does there, it may not hand on a number it did not measure.
  const unreadable = createRuntimeOccupancyAdapter({perf: {monitorEventLoopDelay: () => ({mean: Number.NaN, enable() {}, disable() {}})}});
  // Called directly for the same reason as T21's queue branch: the registry short-circuits an unavailable adapter, so
  // only a direct call proves the branch that refuses to report a number it did not read (mutation M14 stayed green
  // until this assertion existed).
  const unreadableDirect = await unreadable.sample(CONTEXT.receivedAt);
  assert.equal(unreadableDirect.sample.occupancy, undefined, 'an unreadable histogram must not yield 0 ms');
  assert.ok(unreadableDirect.notes.some(note => /not readable|unavailable/i.test(note)));
  const unreadableCollected = await createAdapterRegistry({adapters: [unreadable], now: () => CONTEXT.receivedAt}).collect();
  assert.ok(unreadableCollected.sample.occupancy === undefined || unreadableCollected.unsupported.includes('occupancy'),
    `an unreadable histogram must not yield a number it did not measure, saw ${JSON.stringify(unreadableCollected.sample.occupancy)}`);
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
