// Which City should host — the decision table, without a browser, a LAN or a City.
//
// The Owner's requirement for this module: several PCs each run Utopia, all disconnected, and they must end up in
// ONE City they can all see each other in. Which City that is must follow from network position and hardware, not
// from who clicked first. These tests pin that, and they also pin the refusals: no invented telemetry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WEIGHTS, rankPrimaryCity, scoreCapacity, scoreNetwork, scoreRole } from '../apps/web/primary-city.js';

const city = (over = {}) => ({ cityRef: 'city-a', displayName: 'A', host: '192.168.1.10', port: 4391, transport: 'lan', ...over });
const telemetry = (over = {}) => ({ cpu: { usagePercent: 10 }, memory: { usedBytes: 2e9, totalBytes: 8e9 }, disk: { freeBytes: 40e9, totalBytes: 100e9 }, cores: 8, ...over });

test('network: loopback beats LAN beats an unmeasured path, and latency only ever removes score', () => {
  const loop = scoreNetwork({ host: '127.0.0.1', transport: 'lan' });
  const lan = scoreNetwork({ host: '192.168.1.10', transport: 'lan' });
  const ble = scoreNetwork({ host: '192.168.1.10', transport: 'bluetooth' });
  const unknown = scoreNetwork({});
  assert.equal(loop.kind, 'loopback');
  assert.equal(loop.loopback, true);
  assert.ok(loop.score > lan.score, 'this machine is the strongest network position from here');
  assert.ok(lan.score > ble.score && ble.score > unknown.score);
  const slow = scoreNetwork({ host: '192.168.1.10', transport: 'lan', rttMs: 300 });
  assert.ok(slow.score < lan.score, 'a measured slow path scores below an unmeasured fast one');
  assert.equal(lan.measured, false, 'an unmeasured path says so rather than pretending to be 0ms');
});

test('capacity: missing telemetry is EXCLUDED, never defaulted to a middle value', () => {
  const none = scoreCapacity({});
  assert.equal(none.known, false);
  assert.equal(none.score, null);
  assert.equal(none.fields, 0);
  const onlyCpu = scoreCapacity({ cpu: { usagePercent: 20 } });
  assert.equal(onlyCpu.known, true);
  assert.equal(onlyCpu.fields, 1, 'the row reports how thinly it was evidenced');
  const full = scoreCapacity(telemetry());
  assert.equal(full.fields, 4);
  // An idle machine scores above a busy one on the same hardware.
  assert.ok(scoreCapacity(telemetry({ cpu: { usagePercent: 5 } })).score > scoreCapacity(telemetry({ cpu: { usagePercent: 95 } })).score);
  // A fuller disk scores below an emptier one.
  assert.ok(scoreCapacity(telemetry({ disk: { freeBytes: 80e9, totalBytes: 100e9 } })).score > scoreCapacity(telemetry({ disk: { freeBytes: 1e9, totalBytes: 100e9 } })).score);
});

test('role: a City already carrying devices outranks an identical empty one, and a known City outranks a stranger', () => {
  assert.ok(scoreRole({ attachedNodes: 3 }).score > scoreRole({ attachedNodes: 0 }).score);
  assert.ok(scoreRole({ previouslyJoined: true }).score > scoreRole({ previouslyJoined: false }).score);
});

test('recommendation: the best carrier wins on network + capacity together, not on either alone', () => {
  const weakButNear = city({ cityRef: 'near-weak', host: '192.168.1.20', transport: 'lan', rttMs: 5, telemetry: telemetry({ cpu: { usagePercent: 92 }, memory: { usedBytes: 7.5e9, totalBytes: 8e9 }, disk: { freeBytes: 2e9, totalBytes: 100e9 }, cores: 2 }) });
  const strongButFar = city({ cityRef: 'far-strong', host: '192.168.1.30', transport: 'lan', rttMs: 120, telemetry: telemetry({ cpu: { usagePercent: 3 }, memory: { usedBytes: 1e9, totalBytes: 32e9 }, disk: { freeBytes: 400e9, totalBytes: 500e9 }, cores: 16 }) });
  const { recommended, ranked, reason } = rankPrimaryCity([weakButNear, strongButFar]);
  assert.equal(ranked.length, 2);
  assert.equal(recommended.cityRef, 'far-strong', 'a much stronger machine with a still-fine LAN path is the better carrier');
  assert.match(reason, /best combination/);
});

test('recommendation: a candidate with NO telemetry falls back to network+role rather than scoring zero capacity', () => {
  const unmeasured = city({ cityRef: 'unmeasured', host: '192.168.1.40', transport: 'lan' });
  const modest = city({ cityRef: 'modest', host: '192.168.1.41', transport: 'lan', telemetry: telemetry({ cpu: { usagePercent: 60 }, memory: { usedBytes: 6e9, totalBytes: 8e9 }, disk: { freeBytes: 10e9, totalBytes: 100e9 }, cores: 4 }) });
  const { recommended, ranked } = rankPrimaryCity([unmeasured, modest]);
  const row = ranked.find(r => r.cityRef === 'unmeasured');
  assert.equal(row.capacityKnown, false);
  assert.equal(typeof row.score, 'number', 'it still gets a score, from the parts that were measured');
  assert.ok(row.score > 0);
  assert.ok(recommended, 'a recommendation exists even with thin evidence');
});

test('recommendation: an EMPTY list recommends nothing, and says why instead of throwing', () => {
  const { recommended, ranked, reason } = rankPrimaryCity([]);
  assert.equal(recommended, null);
  assert.deepEqual(ranked, []);
  assert.match(reason, /no candidate/i);
  assert.equal(rankPrimaryCity(undefined).recommended, null, 'junk input is answered, not thrown at');
});

test('recommendation: the order is DETERMINISTIC for equal scores, so the list cannot reshuffle between renders', () => {
  const a = city({ cityRef: 'aaa', host: '192.168.1.50', telemetry: telemetry() });
  const b = city({ cityRef: 'bbb', host: '192.168.1.51', telemetry: telemetry() });
  const first = rankPrimaryCity([a, b]).ranked.map(r => r.cityRef);
  const second = rankPrimaryCity([b, a]).ranked.map(r => r.cityRef);
  assert.deepEqual(first, ['aaa', 'bbb']);
  assert.deepEqual(second, ['aaa', 'bbb'], 'input order must not change the ranking');
});

test('recommendation: a single loopback City is recommended with the honest reason that it is the only one', () => {
  const only = city({ cityRef: 'me', host: '127.0.0.1', transport: 'loopback', telemetry: telemetry() });
  const { recommended, reason } = rankPrimaryCity([only]);
  assert.equal(recommended.cityRef, 'me');
  assert.equal(recommended.network.loopback, true);
  assert.match(reason, /only City visible/);
});

test('weights are exported and the balance is visible rather than guessed', () => {
  assert.equal(typeof DEFAULT_WEIGHTS.network, 'number');
  const sum = DEFAULT_WEIGHTS.network + DEFAULT_WEIGHTS.capacity + DEFAULT_WEIGHTS.role;
  assert.ok(Math.abs(sum - 1) < 1e-9, 'the default weights are a partition of 1');
});
