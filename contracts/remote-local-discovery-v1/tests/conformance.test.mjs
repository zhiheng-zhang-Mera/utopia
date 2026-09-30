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
 LOCAL_DISCOVERY_CONTRACT, LocalDiscoveryError, MAX_ADVERTISEMENTS_PER_ROUND, MAX_CLOCK_SKEW_MS,
 MAX_SCAN_TARGETS, PATH_KINDS, RESOLUTION_ENTRY_POINTS, assertMayInvoke, createDiscoveryAdapterDouble,
 freshnessOf, isIsoInstant, normalizeCandidates, onNetworkChange, planDirectScan, pruneStale,
 resolveToPairing, upgradeToDirectPath, validateAdvertisement, validateInterface
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

/* --------------------------------- 8. regressions (Correction, host Alien) */

// Every refusal below is paired with the legitimate neighbour that must still pass, so the guard
// cannot be satisfied by refusing everything.

test('freshness is a two-sided bound: a replayed future sighting is never current', () => {
  const year = 365 * 24 * 3600 * 1000;
  // genuinely old: one millisecond past its own ttl
  const old = normalizeCandidates([advertisement({ advertised_at: ISO(T0 - TTL - 1), ttl_ms: TTL })], { nowMs: T0 }).candidates[0];
  assert.equal(old.stale, true);
  assert.deepEqual([...pruneStale([old], T0).stale], [DEVICE_A]);
  // dated far ahead: the previous one-sided sum satisfied this for as long as the date was future
  const replayed = normalizeCandidates([advertisement({ advertised_at: ISO(T0 + 10 * year), ttl_ms: 1 })], { nowMs: T0 }).candidates[0];
  assert.equal(replayed.stale, true, 'a sighting dated ten years ahead is not current evidence');
  assert.deepEqual([...pruneStale([replayed], T0).stale], [DEVICE_A]);
  // neighbour: an ordinary in-window peer clock ahead by a minute is NOT invalidated
  const skewed = normalizeCandidates([advertisement({ advertised_at: ISO(T0 + 60_000) })], { nowMs: T0 }).candidates[0];
  assert.equal(skewed.stale, false, 'ordinary clock skew must not invalidate a genuine peer');
  assert.equal(60_000 < MAX_CLOCK_SKEW_MS, true);
  // neighbour: an in-window fresh sighting is still fresh
  const fresh = normalizeCandidates([advertisement({ advertised_at: ISO(T0) })], { nowMs: T0 }).candidates[0];
  assert.equal(fresh.stale, false);
  assert.equal(pruneStale([fresh, skewed], T0).candidates.length, 2);
});

test('an impossible calendar instant is refused, not read as "not stale"', () => {
  // every NaN comparison is false, so these used to validate and report stale=false
  assert.equal(isIsoInstant('2026-13-45T99:99:99Z'), false);
  assert.equal(isIsoInstant('2026-02-30T00:00:00.000Z'), false);
  assert.equal(validateAdvertisement(advertisement({ advertised_at: '2026-13-45T99:99:99Z' })).ok, false);
  // neighbours: both accepted spellings of a real instant still pass
  assert.equal(isIsoInstant('2026-09-30T12:00:00Z'), true);
  assert.equal(isIsoInstant('2026-09-30T12:00:00.000Z'), true);
  assert.equal(validateAdvertisement(advertisement({ advertised_at: ISO(T0) })).ok, true);
  assert.equal(validateAdvertisement(advertisement({ advertised_at: '2026-09-30T12:00:00Z' })).ok, true);
});

test('an advertisement must carry its fields as own properties on a bare object', () => {
  const carried = {
    device_id: DEVICE_A, display_name: 'Prototype peer', addresses: ['192.168.1.20'], interfaces: [],
    source: 'MDNS_DNS_SD', advertised_at: ISO(T0), ttl_ms: TTL,
  };
  const smuggled = Object.assign(Object.create(carried), { platform: 'windows' });
  assert.deepEqual(Object.keys(smuggled), ['platform']);
  assert.equal(validateAdvertisement(smuggled).ok, false, 'inherited fields are not part of an advertisement');
  expectCode(() => normalizeCandidates([smuggled]), 'INVALID_CANDIDATE');
  const interfaceCarried = Object.assign(Object.create({ kind: 'WIFI', subnet: '192.168.1.0/24', address: '192.168.1.20' }), { name: 'Wi-Fi' });
  assert.equal(validateInterface(interfaceCarried).length > 0, true, 'inherited interface fields are not an interface');
  // a prototype-bearing mac_evidence is refused too
  assert.equal(validateAdvertisement(advertisement({ mac_evidence: Object.create({ value: 'aa:bb:cc:dd:ee:ff' }) })).ok, false);
  // neighbours: the same values as own properties pass, and a null-prototype record is still fine
  assert.equal(validateAdvertisement(advertisement({ platform: 'windows' })).ok, true);
  assert.equal(validateInterface({ name: 'Wi-Fi', kind: 'WIFI', subnet: '192.168.1.0/24', address: '192.168.1.20' }).length, 0);
  assert.equal(validateAdvertisement(Object.assign(Object.create(null), advertisement())).ok, true);
  assert.equal(normalizeCandidates([Object.assign(Object.create(null), advertisement())]).candidates[0].device_id, DEVICE_A);
});

test('the per-round advertisement cap is two-sided', () => {
  const many = Array.from({ length: 300 }, (unused, index) => advertisement({ addresses: [`192.168.1.${index % 250}`] }));
  const adapter = createDiscoveryAdapterDouble({ advertisements: [many] });
  // a negative limit is a valid slice offset, and used to emit the whole round minus one
  expectCode(() => adapter.discover({ round: 0, limit: -1 }), 'INVALID_CANDIDATE');
  expectCode(() => adapter.discover({ round: 0, limit: -5 }), 'INVALID_CANDIDATE');
  expectCode(() => adapter.discover({ round: 0, limit: 1.5 }), 'INVALID_CANDIDATE');
  // neighbours: the declared cap still applies, and a smaller limit still bounds
  assert.equal(adapter.discover({ round: 0, limit: MAX_ADVERTISEMENTS_PER_ROUND + 100 }).advertisements.length, MAX_ADVERTISEMENTS_PER_ROUND);
  assert.equal(adapter.discover({ round: 0, limit: 0 }).advertisements.length, 0);
  assert.equal(adapter.discover({ round: 0, limit: 4 }).advertisements.length, 4);
  assert.equal(adapter.discover({ round: 0 }).advertisements.length, MAX_ADVERTISEMENTS_PER_ROUND);
});

test('two different unidentified devices never collapse on a display name', () => {
  const base = { device_id: null, addresses: [], interfaces: [], display_name: 'Phone' };
  const macOne = { ...base, mac_evidence: { value: 'aa:bb:cc:dd:ee:01', authority: 'NOT_AUTHORITY' } };
  const macTwo = { ...base, mac_evidence: { value: 'aa:bb:cc:dd:ee:02', authority: 'NOT_AUTHORITY' } };
  // the previous key was `display_name|addresses`, so these two collapsed into one candidate
  assert.equal(normalizeCandidates([advertisement(macOne), advertisement(macTwo)]).candidates.length, 2, 'different MAC evidence is a different observation');
  assert.equal(normalizeCandidates([advertisement(macOne), advertisement({ ...macOne, platform: 'android' })]).candidates.length, 2, 'a different platform is a different observation');
  assert.equal(normalizeCandidates([advertisement(macOne), advertisement({ ...macOne, source: 'LAN_BROADCAST' })]).candidates.length, 2, 'a different source is a different observation');
  const two = normalizeCandidates([advertisement(macOne), advertisement(macTwo)]).candidates;
  assert.equal(two.every(candidate => candidate.identified === false), true);
  assert.equal(two.every(candidate => candidate.device_id === null), true);
  assert.equal(two.every(candidate => candidate.display_name_is_metadata === true), true);
  // neighbour: the identical observation repeated is a duplicate, not a second device
  const repeated = normalizeCandidates([advertisement(macOne), advertisement({ ...macOne })]);
  assert.equal(repeated.candidates.length, 1);
  assert.equal(repeated.candidates[0].sightings, 2);
  assert.equal(repeated.duplicates[0].reason, 'DUPLICATE_UNADDRESSED_SIGHTING');
  // neighbour: an unidentified sighting is still preview-only and can neither pair nor invoke
  assert.equal(resolveToPairing(repeated.candidates[0]).code, 'DEVICE_ID_REQUIRED');
  expectCode(() => assertMayInvoke(repeated.candidates[0], trustRecord()), 'DEVICE_ID_REQUIRED');
});

test('one address has exactly one canonical spelling', () => {
  assert.equal(validateAdvertisement(advertisement({ addresses: [' 192.168.1.20 '] })).ok, false);
  assert.equal(validateAdvertisement(advertisement({ addresses: ['192.168.1.20A'] })).ok, false);
  expectCode(() => normalizeCandidates([advertisement({ addresses: [' 192.168.1.20 '] })]), 'INVALID_CANDIDATE');
  // neighbours: a canonical address is accepted, and a plain re-sighting still unions to one address
  assert.equal(validateAdvertisement(advertisement({ addresses: ['192.168.1.20'] })).ok, true);
  assert.equal(validateAdvertisement(advertisement({ addresses: ['192.168.1.20', '2001:db8::1'] })).ok, true);
  const unioned = normalizeCandidates([advertisement(), advertisement({ addresses: ['192.168.1.20'], source: 'LAN_BROADCAST' })]);
  assert.deepEqual([...unioned.candidates[0].addresses], ['192.168.1.20']);
  assert.equal(unioned.candidates[0].sightings, 2);
});

test('a stale freshness snapshot is never re-emitted as a current verdict', () => {
  const snapshot = normalizeCandidates([advertisement()], { nowMs: T0 }).candidates[0];
  assert.equal(snapshot.stale, false);
  const later = T0 + TTL + 1;
  // the snapshot says fresh forever; the derived verdict does not
  assert.equal(snapshot.stale, false);
  assert.equal(freshnessOf(snapshot, later).stale, true);
  assert.equal(freshnessOf(snapshot, later).checked, true);
  assert.equal(freshnessOf(snapshot, T0).stale, false);
  // neighbours: with no time source an unjudged candidate is not announced as verified fresh
  const unjudged = normalizeCandidates([advertisement()]).candidates[0];
  assert.equal(freshnessOf(unjudged).checked, false);
  assert.equal(freshnessOf(unjudged).stale, false);
  assert.equal(resolveToPairing(unjudged).resolved, true);
  // resolveToPairing hands out an address, so an expired sighting resolves to nothing
  assert.equal(resolveToPairing(snapshot, { preferDirect: true, nowMs: later }).code, 'STALE_ADVERTISEMENT');
  assert.equal(resolveToPairing(snapshot, { preferDirect: true, nowMs: T0 }).entry_point, 'DIRECT_ADDRESS');
  // ...and a direct path is not opened on expired address evidence
  expectCode(() => upgradeToDirectPath(snapshot, trustRecord(), { deviceFingerprint: FP_A, nowMs: later }), 'STALE_ADVERTISEMENT');
  expectCode(() => upgradeToDirectPath({ ...snapshot, stale: true }, trustRecord(), { deviceFingerprint: FP_A, nowMs: T0 }), 'STALE_ADVERTISEMENT');
  assert.equal(upgradeToDirectPath(snapshot, trustRecord(), { deviceFingerprint: FP_A, nowMs: T0 }).path, 'LOCAL_DIRECT');
  // ...and an aged sighting on an unchanged subnet is not announced as reachable
  const aged = normalizeCandidates([advertisement({ advertised_at: ISO(T0 - 3_600_000) })], { nowMs: T0 }).candidates;
  const after = onNetworkChange(aged, { interfaces: [{ name: 'Wi-Fi', kind: 'WIFI', subnet: '192.168.1.0/24', address: '192.168.1.20' }], nowMs: T0 });
  assert.equal(after.candidates[0].reachable, false, 'subnet membership is not evidence that a sighting is current');
  assert.equal(after.rediscovery_required, true);
  // neighbour: a fresh sighting on a known subnet stays reachable
  const liveAfter = onNetworkChange(normalizeCandidates([advertisement()], { nowMs: T0 }).candidates, { interfaces: [{ name: 'Wi-Fi', kind: 'WIFI', subnet: '192.168.1.0/24', address: '192.168.1.20' }], nowMs: T0 });
  assert.equal(liveAfter.candidates[0].reachable, true);
  assert.equal(liveAfter.rediscovery_required, false);
});

test('logical identity preservation is computed, not asserted', () => {
  // an identity handed to a different device under the same candidate ref is a changed identity
  const conflicted = onNetworkChange([
    { candidate_ref: `device:${DEVICE_A}`, device_id: DEVICE_A, interfaces: [], addresses: [] },
    { candidate_ref: `device:${DEVICE_A}`, device_id: DEVICE_B, interfaces: [], addresses: [] },
  ], { interfaces: [], nowMs: T0 });
  assert.equal(conflicted.logical_identity_changed, true, 'a candidate ref may not change hands between devices');
  assert.equal(conflicted.identities_preserved, false);
  assert.equal(conflicted.identity_conflicts.length, 1);
  // neighbours: an ordinary re-resolution preserves identity and reports no conflict
  const previous = normalizeCandidates([advertisement()], { nowMs: T0 }).candidates;
  const ordinary = onNetworkChange(previous, { interfaces: [{ name: 'Ethernet', kind: 'ETHERNET', subnet: '10.0.0.0/24', address: '10.0.0.5' }], nowMs: T0 });
  assert.equal(ordinary.logical_identity_changed, false);
  assert.equal(ordinary.identities_preserved, true);
  assert.deepEqual([...ordinary.lost_identities], []);
  assert.deepEqual([...ordinary.identity_conflicts], []);
  assert.deepEqual([...ordinary.retained_identities], [DEVICE_A]);
});

