// RF-004 conformance suite — Bluetooth bootstrap and IP handoff.
//
// Acceptance: Bluetooth is a bootstrap entry point that converges on the one trust protocol; carrying a
// payload never grants trust; a MAC address is never authority; the IP handoff requires an established
// trust record and re-verifies the fingerprint over the new path; single-use nonces defeat replay; and
// scanning is bounded.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 BLUETOOTH_CODES, BLUETOOTH_LIMITS, BLUETOOTH_TRANSPORT_PORT, BOOTSTRAP_ENTRY_POINT,
 BOOTSTRAP_STATES, BluetoothBootstrapError, MAX_IP_CANDIDATES, MAX_SCAN_ROUNDS,
 REMOTE_BLUETOOTH_BOOTSTRAP_CONTRACT, createBluetoothBootstrap, createBluetoothTransportDouble,
 createBootstrapPayload
} from '../index.mjs';

const T0 = Date.parse('2026-09-30T12:00:00.000Z');
const ISO = ms => new Date(ms).toISOString();
const DEVICE = 'dev-11111111111111111111111111111111';
const FP = 'sha256:' + 'a'.repeat(64);
const FP_OTHER = 'sha256:' + 'b'.repeat(64);
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const payload = (overrides = {}) => createBootstrapPayload({
  deviceId: DEVICE, fingerprint: FP, installationRef: 'ins-1', ipCandidates: ['192.168.1.20', '10.0.0.5'], nonce: 'nonce-1', at: ISO(T0), ttlMs: 120_000, ...overrides,
});
const trustRecord = (overrides = {}) => ({ trust_id: 'trust-' + '1'.repeat(32), device_id: DEVICE, fingerprint: FP, state: 'TRUSTED', ...overrides });
const setup = ({ clockMs = T0, advertisements = [] } = {}) => {
  const adapter = createBluetoothTransportDouble({ payload: payload(), advertisements });
  const bootstrap = createBluetoothBootstrap({ adapter, clock: () => clockMs });
  return { adapter, bootstrap };
};

/* ------------------------------------------------ 1. bootstrap is a pointer */

test('a bootstrap payload is a pointer to the pairing path, never trust', () => {
  const { bootstrap } = setup();
  const received = bootstrap.receive(payload(), { at: ISO(T0) });
  assert.equal(received.accepted, true);
  assert.equal(received.entry_point, BOOTSTRAP_ENTRY_POINT);
  assert.equal(received.converges_on_pairing, true);
  assert.equal(received.device_id, DEVICE);
  assert.equal(received.fingerprint, FP);
  assert.deepEqual(received.ip_candidates, ['192.168.1.20', '10.0.0.5']);
  assert.equal(BLUETOOTH_LIMITS.grants_trust, false);
  assert.equal(BLUETOOTH_LIMITS.is_a_trust_flow, false);
  assert.equal(BLUETOOTH_LIMITS.bootstrap_only, true);
  assert.equal(BLUETOOTH_LIMITS.converges_on_one_trust_protocol, true);
  assert.equal(BLUETOOTH_TRANSPORT_PORT.carries_trust, false);
  assert.equal(BLUETOOTH_TRANSPORT_PORT.carries_bulk_data, false);
  assert.equal(REMOTE_BLUETOOTH_BOOTSTRAP_CONTRACT.converges_on_one_trust_protocol, true);
  // a payload that claims trust is refused outright
  const claimed = { ...payload(), grants_trust: true };
  expectCode(() => bootstrap.receive(claimed, { at: ISO(T0) }), 'BLUETOOTH_IS_NOT_TRUST');
  assert.equal(REMOTE_BLUETOOTH_BOOTSTRAP_CONTRACT.carries_trust, false);
});

test('a MAC address is never consulted for a decision', () => {
  const { bootstrap } = setup();
  const received = bootstrap.receive(payload(), { at: ISO(T0) });
  assert.equal(received.accepted, true);
  assert.equal(BLUETOOTH_LIMITS.mac_is_authority, false);
  assert.equal(REMOTE_BLUETOOTH_BOOTSTRAP_CONTRACT.mac_is_authority, false);
  // a MAC-looking device id is still refused: identity is cryptographic only
  expectCode(() => createBootstrapPayload({ deviceId: '3c:22:fb:11:22:33', fingerprint: FP, nonce: 'n', at: ISO(T0) }), 'INVALID_BOOTSTRAP');
  expectCode(() => createBootstrapPayload({ deviceId: DEVICE, fingerprint: 'not-a-fingerprint', nonce: 'n', at: ISO(T0) }), 'INVALID_BOOTSTRAP');
  assert.deepEqual([...BOOTSTRAP_STATES], ['ADVERTISED', 'RECEIVED', 'HANDED_OFF', 'EXPIRED', 'REFUSED']);
});

/* ------------------------------------------------ 2. expiry and replay */

test('an expired or replayed bootstrap is refused without partial state', () => {
  const { bootstrap } = setup({ clockMs: T0 + 200_000 });
  const expired = bootstrap.receive(payload(), { at: ISO(T0 + 200_000) });
  assert.equal(expired.accepted, false);
  assert.equal(expired.code, 'BOOTSTRAP_EXPIRED');
  assert.equal(expired.entry_point, null);

  const fresh = setup();
  assert.equal(fresh.bootstrap.receive(payload(), { at: ISO(T0) }).accepted, true);
  // the same advertisement observed again is a replay, not a second invitation
  const replayed = fresh.bootstrap.receive(payload(), { at: ISO(T0 + 1000) });
  assert.equal(replayed.accepted, false);
  assert.equal(replayed.code, 'BOOTSTRAP_REPLAYED');
  assert.equal(REMOTE_BLUETOOTH_BOOTSTRAP_CONTRACT.nonce_is_single_use, true);
  // a different nonce is a different invitation
  assert.equal(fresh.bootstrap.receive(payload({ nonce: 'nonce-2' }), { at: ISO(T0 + 1000) }).accepted, true);
});

/* ------------------------------------------------ 3. IP handoff */

test('the IP handoff requires trust and re-verifies the fingerprint on the new path', () => {
  const { bootstrap } = setup();
  const received = bootstrap.receive(payload(), { at: ISO(T0) });
  // a bootstrap alone can never hand off
  expectCode(() => bootstrap.handoffToIp(received.bootstrap_ref, { trust: null, verifiedFingerprint: FP, at: ISO(T0) }), 'TRUST_REQUIRED_FOR_HANDOFF');
  expectCode(() => bootstrap.handoffToIp(received.bootstrap_ref, { trust: { state: 'QUARANTINED', device_id: DEVICE, fingerprint: FP }, verifiedFingerprint: FP, at: ISO(T0) }), 'TRUST_REQUIRED_FOR_HANDOFF');
  expectCode(() => bootstrap.handoffToIp(received.bootstrap_ref, { trust: trustRecord({ device_id: 'dev-22222222222222222222222222222222' }), verifiedFingerprint: FP, at: ISO(T0) }), 'TRUST_REQUIRED_FOR_HANDOFF');
  // trust for this device, but the new path presents a different fingerprint
  expectCode(() => bootstrap.handoffToIp(received.bootstrap_ref, { trust: trustRecord(), verifiedFingerprint: FP_OTHER, at: ISO(T0) }), 'FINGERPRINT_MISMATCH');
  expectCode(() => bootstrap.handoffToIp(received.bootstrap_ref, { trust: trustRecord({ fingerprint: FP_OTHER }), verifiedFingerprint: FP, at: ISO(T0) }), 'FINGERPRINT_MISMATCH');

  const handed = bootstrap.handoffToIp(received.bootstrap_ref, { trust: trustRecord(), verifiedFingerprint: FP, at: ISO(T0 + 1000) });
  assert.equal(handed.path, 'IP_DIRECT');
  assert.equal(handed.address, '192.168.1.20');
  assert.equal(handed.device_id, DEVICE);
  assert.equal(handed.authenticated, true);
  assert.equal(handed.encrypted, true);
  assert.equal(handed.verified_over_new_path, true);
  assert.equal(handed.bluetooth_carried_trust, false);
  assert.equal(bootstrap.state(received.bootstrap_ref).state, 'HANDED_OFF');
  // a second handoff for the same bootstrap is refused
  expectCode(() => bootstrap.handoffToIp(received.bootstrap_ref, { trust: trustRecord(), verifiedFingerprint: FP, at: ISO(T0 + 2000) }), 'HANDOFF_ALREADY_DONE');
  // and an address that was never advertised is not usable
  const second = setup(); const other = second.bootstrap.receive(payload({ nonce: 'nonce-9' }), { at: ISO(T0) });
  expectCode(() => second.bootstrap.handoffToIp(other.bootstrap_ref, { trust: trustRecord(), verifiedFingerprint: FP, preferredCandidate: '8.8.8.8', at: ISO(T0) }), 'NO_IP_CANDIDATE');
  assert.equal(REMOTE_BLUETOOTH_BOOTSTRAP_CONTRACT.ip_handoff_requires_trust, true);
  assert.equal(REMOTE_BLUETOOTH_BOOTSTRAP_CONTRACT.ip_handoff_reverifies_fingerprint, true);
});

/* ------------------------------------------------ 4. bounded scanning and strictness */

test('scanning is bounded and payloads are strict', () => {
  const advertisements = Array.from({ length: 40 }, (unused, index) => ({ advertisement_ref: `adv-${index}`, device_id: DEVICE }));
  const { bootstrap, adapter } = setup({ advertisements });
  const scan = bootstrap.scan({ rounds: 2 });
  assert.equal(scan.bounded, true);
  assert.equal(scan.rounds, 2);
  assert.equal(adapter.__scans.length, 2);
  expectCode(() => bootstrap.scan({ rounds: MAX_SCAN_ROUNDS + 1 }), 'UNBOUNDED_SCAN_REFUSED');
  expectCode(() => bootstrap.scan({ rounds: 0 }), 'UNBOUNDED_SCAN_REFUSED');
  expectCode(() => createBluetoothTransportDouble({}).scan({ maxRounds: MAX_SCAN_ROUNDS + 1 }), 'UNBOUNDED_SCAN_REFUSED');
  assert.equal(REMOTE_BLUETOOTH_BOOTSTRAP_CONTRACT.bounded_scanning, true);

  assert.equal(payload().grants_trust, false);
  expectCode(() => createBootstrapPayload({ deviceId: DEVICE, fingerprint: FP, nonce: 'n', at: ISO(T0), ipCandidates: Array.from({ length: MAX_IP_CANDIDATES + 1 }, unused => '192.168.1.1') }), 'INVALID_BOOTSTRAP');
  expectCode(() => createBootstrapPayload({ deviceId: DEVICE, fingerprint: FP, nonce: 'n', at: ISO(T0), ipCandidates: ['not an address'] }), 'INVALID_BOOTSTRAP');
  expectCode(() => createBootstrapPayload({ deviceId: DEVICE, fingerprint: FP, nonce: '', at: ISO(T0) }), 'INVALID_BOOTSTRAP');
  expectCode(() => createBootstrapPayload({ deviceId: DEVICE, fingerprint: FP, nonce: 'n', at: 'yesterday' }), 'INVALID_BOOTSTRAP');
  expectCode(() => createBluetoothBootstrap({}), 'ADAPTER_REQUIRED');
  const { bootstrap: fresh } = setup();
  expectCode(() => fresh.state('bootstrap-missing'), 'UNKNOWN_BOOTSTRAP');
  expectCode(() => fresh.handoffToIp('bootstrap-missing', { trust: trustRecord(), verifiedFingerprint: FP }), 'UNKNOWN_BOOTSTRAP');
  assert.equal(new Set(BLUETOOTH_CODES).size, BLUETOOTH_CODES.length);
  assert.equal(new BluetoothBootstrapError('X', 'y').status, 409);
  assert.equal(BLUETOOTH_LIMITS.max_ip_candidates, MAX_IP_CANDIDATES);
  assert.equal(BOOTSTRAP_ENTRY_POINT, 'DISCOVERY_BLUETOOTH');
});
