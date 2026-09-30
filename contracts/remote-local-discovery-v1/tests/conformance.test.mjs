// RF-003 conformance suite — same-Wi-Fi / LAN discovery and the local direct path.
//
// Acceptance: adapters discover a peer on one LAN without manual IP entry; wired and Wi-Fi
// candidates normalize to the same device/pairing abstraction; stale or duplicate advertisements do
// not create duplicate logical devices; untrusted candidates cannot invoke capabilities; trusted
// nodes upgrade to an authenticated encrypted direct local transport; a local network change
// triggers rediscovery without changing logical identity.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 DISCOVERY_ADAPTER_PORT, DISCOVERY_SOURCES, INTERFACE_KINDS, LOCAL_DISCOVERY_CODES,
 LOCAL_DISCOVERY_CONTRACT, LocalDiscoveryError, MAX_SCAN_TARGETS, PATH_KINDS,
 RESOLUTION_ENTRY_POINTS, assertMayInvoke, createDiscoveryAdapterDouble, normalizeCandidates,
 onNetworkChange, planDirectScan, pruneStale, resolveToPairing, upgradeToDirectPath,
 validateAdvertisement, validateInterface
} from '../index.mjs';

const T0 = Date.parse('2026-09-30T12:00:00.000Z');
const ISO = ms => new Date(ms).toISOString();
const TTL = 30_000;
const DEVICE_A = 'dev-11111111111111111111111111111111';
const DEVICE_B = 'dev-22222222222222222222222222222222';
const FP_A = 'sha256:' + 'a'.repeat(64);
const FP_B = 'sha256:' + 'b'.repeat(64);
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const advertisement = (overrides = {}) => ({
  device_id: DEVICE_A,
  installation_ref: 'ins-1',
  display_name: 'Synthetic peer',
  addresses: ['192.168.1.20'],
  interfaces: [{ name: 'Wi-Fi', kind: 'WIFI', subnet: '192.168.1.0/24', address: '192.168.1.20' }],
  source: 'MDNS_DNS_SD',
  advertised_at: ISO(T0),
  ttl_ms: TTL,
  mac_evidence: { value: '3c:22:fb:11:22:33', authority: 'NOT_AUTHORITY' },
  platform: 'windows',
  ...overrides,
});

const trustRecord = (overrides = {}) => ({
  trust_id: 'trust-' + '1'.repeat(32),
  device_id: DEVICE_A,
  fingerprint: FP_A,
  state: 'TRUSTED',
  ...overrides,
});

/* ------------------------------------------------- 1. discovery, no manual IP */

test('an adapter discovers a peer on the LAN without manual address entry', () => {
  const adapter = createDiscoveryAdapterDouble({ source: 'MDNS_DNS_SD', advertisements: [[advertisement()]] });
  assert.deepEqual(adapter.describe(), { source: 'MDNS_DNS_SD', bounded: true, max_advertisements_per_round: 256 });
  const round = adapter.discover({ round: 0 });
  assert.equal(round.advertisements.length, 1);
  assert.equal(round.truncated, false);
  const normalized = normalizeCandidates(round.advertisements);
  assert.equal(normalized.candidates.length, 1);
  const resolved = resolveToPairing(normalized.candidates[0]);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.entry_point, 'DISCOVERY_LAN');
  assert.equal(resolved.device_id, DEVICE_A);
  assert.equal(resolved.is_trust, false, 'resolution is not trust');
  assert.equal(resolved.grants_trust, false);
  // a second adapter (broadcast) produces the same shape, so nothing above knows how it was found
  const broadcast = createDiscoveryAdapterDouble({ source: 'LAN_BROADCAST', advertisements: [[advertisement({ source: 'LAN_BROADCAST', addresses: ['192.168.1.21'] })]] });
  const other = normalizeCandidates(broadcast.discover({ round: 0 }).advertisements);
  assert.equal(other.candidates[0].candidate_ref, normalized.candidates[0].candidate_ref, 'the same device is one candidate whatever found it');
  assert.equal(DISCOVERY_ADAPTER_PORT.grants_trust, false);
  assert.equal(DISCOVERY_ADAPTER_PORT.is_a_trust_flow, false);
  assert.equal(LOCAL_DISCOVERY_CONTRACT.requires_manual_ip_entry, false);
  expectCode(() => createDiscoveryAdapterDouble({ source: 'TELEPATHY' }), 'UNKNOWN_SOURCE');
});

/* ------------------------------------------------- 2. wired + Wi-Fi normalize */

test('wired and Wi-Fi sightings normalize to the same device abstraction', () => {
  const normalized = normalizeCandidates([
    advertisement({ addresses: ['192.168.1.20'], interfaces: [{ name: 'Wi-Fi', kind: 'WIFI', subnet: '192.168.1.0/24', address: '192.168.1.20' }] }),
    advertisement({ addresses: ['10.0.0.5'], source: 'LAN_BROADCAST', interfaces: [{ name: 'Ethernet', kind: 'ETHERNET', subnet: '10.0.0.0/24', address: '10.0.0.5' }] }),
  ]);
  assert.equal(normalized.candidates.length, 1, 'one logical device, two interfaces');
  const candidate = normalized.candidates[0];
  assert.deepEqual(candidate.addresses, ['10.0.0.5', '192.168.1.20']);
  assert.deepEqual(candidate.interface_kinds, ['ETHERNET', 'WIFI']);
  assert.deepEqual([...candidate.sources], ['MDNS_DNS_SD', 'LAN_BROADCAST']);
  assert.equal(candidate.sightings, 2);
  assert.deepEqual(normalized.duplicates.map(entry => entry.reason), ['DUPLICATE_ADVERTISEMENT']);
  assert.deepEqual(resolveToPairing(candidate).addresses, ['10.0.0.5', '192.168.1.20']);
  // a direct-address preference changes the entry point, not the identity
  const direct = resolveToPairing(candidate, { preferDirect: true });
  assert.equal(direct.entry_point, 'DIRECT_ADDRESS');
  assert.equal(direct.device_id, DEVICE_A);
  assert.deepEqual([...RESOLUTION_ENTRY_POINTS], ['DISCOVERY_LAN', 'DIRECT_ADDRESS']);
  assert.deepEqual([...INTERFACE_KINDS], ['WIFI', 'ETHERNET', 'OTHER']);
});

/* ------------------------------------------------- 3. duplicates and staleness */

test('duplicate and stale advertisements never create duplicate logical devices', () => {
  const twice = normalizeCandidates([advertisement(), advertisement(), advertisement({ addresses: ['192.168.1.20'] })]);
  assert.equal(twice.candidates.length, 1);
  assert.equal(twice.candidates[0].sightings, 3);
  assert.equal(twice.duplicates.length, 2);
  // two different devices with the same display name stay two devices
  const sameName = normalizeCandidates([
    advertisement(),
    advertisement({ device_id: DEVICE_B, addresses: ['192.168.1.30'], installation_ref: 'ins-2' }),
  ]);
  assert.equal(sameName.candidates.length, 2, 'a display name is not an identity');
  // an unidentified sighting is kept, but it is not a logical device and cannot pair
  const unidentified = normalizeCandidates([advertisement({ device_id: null })]);
  assert.equal(unidentified.candidates.length, 1);
  assert.equal(unidentified.candidates[0].identified, false);
  assert.equal(resolveToPairing(unidentified.candidates[0]).code, 'DEVICE_ID_REQUIRED');
  expectCode(() => assertMayInvoke(unidentified.candidates[0], trustRecord()), 'DEVICE_ID_REQUIRED');
  // staleness is visible, and pruning drops the sighting without touching identity
  const aged = normalizeCandidates([advertisement()], { nowMs: T0 + TTL + 1 });
  assert.equal(aged.candidates[0].stale, true);
  const pruned = pruneStale(aged.candidates, T0 + TTL + 1);
  assert.deepEqual(pruned.candidates, []);
  assert.deepEqual([...pruned.stale], [DEVICE_A]);
  assert.equal(LOCAL_DISCOVERY_CONTRACT.duplicate_advertisements_create_devices, false);
});

/* ------------------------------------------------- 4. discovery is not trust */

test('an untrusted candidate cannot invoke anything', () => {
  const candidate = normalizeCandidates([advertisement()]).candidates[0];
  expectCode(() => assertMayInvoke(candidate, null), 'UNTRUSTED_CANDIDATE');
  expectCode(() => assertMayInvoke(candidate, { state: 'QUARANTINED', device_id: DEVICE_A }), 'UNTRUSTED_CANDIDATE');
  expectCode(() => assertMayInvoke(candidate, { state: 'TRUSTED', device_id: DEVICE_B }), 'UNTRUSTED_CANDIDATE');
  assert.equal(assertMayInvoke(candidate, trustRecord()).may_invoke, true);
  // a spoofed display name or MAC grants nothing, because neither is consulted
  const spoofed = normalizeCandidates([advertisement({ display_name: 'Owner laptop', mac_evidence: { value: '3c:22:fb:11:22:33', authority: 'AUTHORITY' } })]).candidates[0];
  expectCode(() => assertMayInvoke(spoofed, null), 'UNTRUSTED_CANDIDATE');
  assert.equal(spoofed.mac_evidence_is_authority, false);
  assert.equal(LOCAL_DISCOVERY_CONTRACT.discovery_grants_trust, false);
  assert.equal(LOCAL_DISCOVERY_CONTRACT.mac_is_authority, false);
  assert.equal(LOCAL_DISCOVERY_CONTRACT.untrusted_candidate_may_invoke, false);
});

/* ------------------------------------------------- 5. authenticated direct path */

test('only a trusted node with the right fingerprint upgrades to an encrypted direct path', () => {
  const candidate = normalizeCandidates([advertisement()]).candidates[0];
  expectCode(() => upgradeToDirectPath(candidate, null, { deviceFingerprint: FP_A, nowMs: T0 }), 'UNTRUSTED_CANDIDATE');
  expectCode(() => upgradeToDirectPath(candidate, trustRecord({ fingerprint: FP_B }), { deviceFingerprint: FP_A, nowMs: T0 }), 'FINGERPRINT_MISMATCH');
  expectCode(() => upgradeToDirectPath(candidate, trustRecord(), { deviceFingerprint: 'not-a-fingerprint', nowMs: T0 }), 'FINGERPRINT_MISMATCH');
  const path = upgradeToDirectPath(candidate, trustRecord(), { deviceFingerprint: FP_A, nowMs: T0 });
  assert.equal(path.path, 'LOCAL_DIRECT');
  assert.equal(path.authenticated, true);
  assert.equal(path.encrypted, true);
  assert.equal(path.device_id, DEVICE_A);
  assert.deepEqual([...path.quality.interface_kinds], ['WIFI']);
  assert.equal(path.quality.address_count, 1);
  assert.equal(path.quality.established_at, ISO(T0));
  assert.deepEqual([...PATH_KINDS], ['LOCAL_DIRECT']);
  assert.equal(LOCAL_DISCOVERY_CONTRACT.direct_path_requires_trust_and_fingerprint, true);
});

/* ------------------------------------------------- 6. network change */

test('a local network change re-resolves addresses without changing logical identity', () => {
  const before = normalizeCandidates([advertisement()]).candidates;
  const after = onNetworkChange(before, {
    interfaces: [{ name: 'Ethernet', kind: 'ETHERNET', subnet: '10.0.0.0/24', address: '10.0.0.5' }],
    nowMs: T0 + 1000,
  });
  assert.equal(after.logical_identity_changed, false);
  assert.equal(after.identities_preserved, true);
  assert.deepEqual([...after.retained_identities], [DEVICE_A]);
  assert.equal(after.rediscovery_required, true, 'the peer is no longer reachable on the old subnet');
  assert.deepEqual(after.candidates[0].addresses, []);
  // rediscovery on the new subnet finds the same logical device with a new address
  const rediscovered = onNetworkChange(before, {
    interfaces: [{ name: 'Ethernet', kind: 'ETHERNET', subnet: '10.0.0.0/24', address: '10.0.0.5' }],
    advertisements: [advertisement({ addresses: ['10.0.0.5'], source: 'LAN_BROADCAST', interfaces: [{ name: 'Ethernet', kind: 'ETHERNET', subnet: '10.0.0.0/24', address: '10.0.0.5' }] })],
    nowMs: T0 + 2000,
  });
  const identityForDevice = rediscovered.candidates.find(candidate => candidate.device_id === DEVICE_A);
  assert.deepEqual(identityForDevice.addresses, ['10.0.0.5']);
  assert.equal(identityForDevice.candidate_ref, `device:${DEVICE_A}`, 'the same logical device, a new address');
  assert.equal(rediscovered.logical_identity_changed, false);
  expectCode(() => onNetworkChange(before, { interfaces: [{ name: 'X', kind: 'TELEPATHY' }] }), 'INVALID_INTERFACE');
  // a malformed interface is refused and identity is untouched
  assert.equal(validateInterface({ name: 'Wi-Fi', kind: 'WIFI', subnet: 'x', address: null }).length, 0);
  assert.equal(validateInterface({ name: '', kind: 'WIFI' }).length > 0, true);
});

/* ------------------------------------------------- 7. bounded traffic */

test('discovery and fallback scanning stay bounded', () => {
  const plan = planDirectScan({ targets: ['192.168.1.10', '192.168.1.11', '192.168.1.12'] });
  assert.equal(plan.planned, 3);
  assert.equal(plan.bounded, true);
  assert.equal(plan.sweep_entire_subnet, false);
  const capped = planDirectScan({ targets: Array.from({ length: 500 }, (unused, index) => `192.168.1.${index}`) });
  assert.equal(capped.planned, MAX_SCAN_TARGETS);
  assert.equal(capped.refused, 500 - MAX_SCAN_TARGETS);
  expectCode(() => planDirectScan({ targets: [], maxTargets: MAX_SCAN_TARGETS + 1 }), 'UNBOUNDED_SCAN_REFUSED');
  expectCode(() => planDirectScan({ targets: [], maxTargets: 0 }), 'UNBOUNDED_SCAN_REFUSED');
  const many = Array.from({ length: 400 }, (unused, index) => advertisement({ addresses: [`192.168.1.${index % 250}`], advertised_at: ISO(T0) }));
  const round = createDiscoveryAdapterDouble({ advertisements: [many] }).discover({ round: 0 });
  assert.equal(round.advertisements.length, 256);
  assert.equal(round.truncated, true);
  assert.equal(LOCAL_DISCOVERY_CONTRACT.bounded_scanning, true);
  assert.deepEqual([...DISCOVERY_SOURCES].includes('DIRECT_ADDRESS'), true);
  assert.equal(new Set(LOCAL_DISCOVERY_CODES).size, LOCAL_DISCOVERY_CODES.length);
});

test('advertisements are strict, and metadata is never a required identity', () => {
  assert.equal(validateAdvertisement(advertisement()).ok, true);
  assert.equal(validateAdvertisement(advertisement({ source: 'TELEPATHY' })).ok, false);
  assert.equal(validateAdvertisement(advertisement({ advertised_at: 'yesterday' })).ok, false);
  assert.equal(validateAdvertisement(advertisement({ addresses: 'not-an-array' })).ok, false);
  assert.equal(validateAdvertisement(advertisement({ interfaces: [{ name: 'Wi-Fi' }] })).ok, false);
  assert.equal(validateAdvertisement(advertisement({ device_id: 'not-a-device' })).ok, false);
  assert.equal(validateAdvertisement(advertisement({ device_id: null }), { requireDeviceId: true }).ok, false);
  assert.equal(validateAdvertisement(advertisement({ identity: 'x' })).ok, false);
  expectCode(() => normalizeCandidates('not-an-array'), 'INVALID_CANDIDATE');
  expectCode(() => normalizeCandidates([advertisement({ source: 'NOPE' })]), 'INVALID_CANDIDATE');
  expectCode(() => pruneStale('not-an-array', T0), 'INVALID_CANDIDATE');
  assert.equal(new LocalDiscoveryError('X', 'y').status, 409);
  assert.equal(LOCAL_DISCOVERY_CONTRACT.identity_is_network_derived, false);
});
