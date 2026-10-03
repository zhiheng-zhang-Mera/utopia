// JOIN-502 — the discovery ADAPTER and the nearby-City presentation rules.
//
// These are the deterministic half: no sockets, no browser, no clock. They exist because the two rules
// that matter most here are pure functions that are easy to get subtly wrong - deduplication by City
// identity rather than by address or name, and two-sided freshness - and because the RF-003 contract
// they sit on was written for exactly this purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nearbyCities, normalizeNearby, transportLabel, probeNearby, MAX_NEARBY_ROWS } from '../apps/web/discovery.js';
import { advertisementFromService, joinCapability, nearbyView, NEARBY_TTL_MS } from '../services/dev-gateway/nearby.mjs';
import { normalizeCandidates, resolveToPairing } from '../contracts/remote-local-discovery-v1/discovery.mjs';

const at = '2026-10-03T10:00:00.000Z';
const now = Date.parse(at) + 1000;
const row = patch => ({ cityRef: 'city-a', displayName: 'Utopia · Alien', address: '192.168.50.10', port: 4310, transport: 'LAN', lastSeenAt: at, ...patch });

test('JOIN-502 discovery adapter: a discovered City is a candidate, never a credential', () => {
  const [first] = nearbyCities([row()], { now });
  assert.equal(first.displayName, 'Utopia · Alien');
  assert.equal(first.endpoint, 'http://192.168.50.10:4310');
  // The three constants that stop a renderer from promoting metadata into trust.
  assert.equal(first.grantsTrust, false);
  assert.equal(first.isIdentity, false);
  assert.equal(first.displayNameIsMetadata, true);
  assert.equal(first.stale, false);
  assert.equal(transportLabel('LAN'), 'lan');
  assert.equal(transportLabel('BLE_BOOTSTRAP'), 'ble');
});

test('JOIN-502 discovery adapter: the same City advertised twice is ONE row, and the newest address wins', () => {
  const rows = nearbyCities([
    { ...row(), lastSeenAt: '2026-10-03T10:00:00.000Z' },
    { ...row(), address: '192.168.50.99', lastSeenAt: '2026-10-03T10:00:20.000Z' },
  ], { now });
  assert.equal(rows.length, 1, 'a City re-advertising must not appear twice');
  assert.equal(rows[0].address, '192.168.50.99', 'the most recent sighting carries the address');
});

test('JOIN-502 discovery adapter: a stale or future-dated sighting is not offered, and an unidentified one is not merged', () => {
  const stale = nearbyCities([row({ lastSeenAt: new Date(now - NEARBY_TTL_MS - 1).toISOString() })], { now });
  assert.deepEqual(stale, [], 'a sighting past its ttl must not be handed to a user as a join target');
  const future = nearbyCities([row({ lastSeenAt: new Date(now + 120000).toISOString() })], { now });
  assert.deepEqual(future, [], 'a sighting dated minutes ahead is replay evidence, not current evidence');
  // Two rows with no City identity but different addresses stay TWO rows: a display name is metadata
  // and may never join two devices, which is the RF-003 rule this adapter inherits rather than restates.
  const unidentified = nearbyCities([
    row({ cityRef: null, displayName: 'Utopia', address: '192.168.50.10' }),
    row({ cityRef: null, displayName: 'Utopia', address: '192.168.50.11' }),
  ], { now });
  assert.equal(unidentified.length, 2);
});

test('JOIN-502 discovery adapter: a row with no reachable endpoint is refused rather than offered', () => {
  assert.equal(normalizeNearby({ cityRef: 'c', displayName: 'x', address: '192.168.50.10', port: null, lastSeenAt: at }, { now }).endpoint, null);
  const [only] = nearbyCities([row({ port: null })], { now });
  assert.equal(only.endpoint, null);
  assert.equal(nearbyCities([], { now }).length, 0);
  assert.equal(nearbyCities(null, { now }).length, 0);
});

test('JOIN-502 discovery adapter: the probe fails SOFT - no probe, no fetch or a bad answer is an empty list', async () => {
  const offline = await probeNearby({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(offline.cities, []);
  assert.equal(offline.unavailable, true);
  const noFetch = await probeNearby({ fetchImpl: null });
  assert.equal(noFetch.reason, 'NO_FETCH');
  const refused = await probeNearby({ fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(refused.reason, 'HTTP_401');
  // A successful probe with more rows than the bound keeps only the bound.
  const many = Array.from({ length: MAX_NEARBY_ROWS + 5 }, (_, index) => row({ cityRef: `city-${index}` }));
  const bounded = await probeNearby({ now, fetchImpl: async () => ({ ok: true, json: async () => ({ nearby: many }) }) });
  assert.equal(bounded.cities.length, MAX_NEARBY_ROWS);
});

test('JOIN-502 gateway browse: mDNS records become RF-003 advertisements, and the contract still refuses to pair from them', () => {
  const service = { name: 'Utopia-58daf0a4', host: 'utopia-58daf0a4.local', port: 4310, addresses: ['192.168.50.10'], txt: { v: '1', city: 'city-a', api: '0', schema: '0', session: 'sess-1', join: '1' } };
  const advertisement = advertisementFromService(service, { advertisedAt: at });
  assert.equal(advertisement.device_id, null, 'a City has no Remote Fabric dev- id and this module must not mint one');
  assert.equal(advertisement.installation_ref, 'city-a');
  assert.deepEqual(advertisement.addresses, ['192.168.50.10', 'utopia-58daf0a4.local']);
  assert.equal(advertisement.source, 'MDNS_DNS_SD');
  assert.equal(advertisementFromService({ name: '', host: 'h' }), null, 'an unusable record is dropped, not guessed at');

  const { candidates } = normalizeCandidates([advertisement], { nowMs: now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].identified, false);
  // The contract's OWN refusal, not a home-made one: discovery is not a path into pairing.
  const resolution = resolveToPairing(candidates[0], { nowMs: now });
  assert.equal(resolution.resolved, false);
  assert.equal(resolution.code, 'DEVICE_ID_REQUIRED');
  assert.equal(candidates[0].display_name_is_metadata, true);
  assert.equal(candidates[0].mac_evidence_is_authority, false);
});

test('JOIN-502 gateway browse: the view carries the ADVERTISED address and withholds it once stale', () => {
  const candidate = { candidate_ref: 'unidentified:abc', installation_ref: 'city-a', display_name: 'Utopia-58daf0a4', addresses: ['192.168.50.10'], sources: ['MDNS_DNS_SD'], last_seen_at: at, stale: false };
  const live = nearbyView(candidate, { port: 4310 });
  assert.equal(live.joinEndpoint, 'http://192.168.50.10:4310');
  assert.equal(live.grantsTrust, false);
  // Stale local state must not hand anyone an address to act on (RF-003's resolution rule).
  const dead = nearbyView({ ...candidate, stale: true }, { port: 4310 });
  assert.equal(dead.joinEndpoint, null);
  assert.equal(nearbyView(candidate, { port: null }).joinEndpoint, null);
});

test('JOIN-502 capability statement: a City states what it accepts instead of a client guessing', () => {
  const capability = joinCapability({ cityId: 'city-a', displayName: 'Utopia · Alien' });
  assert.equal(capability.joinProtocolVersion, 1);
  assert.equal(capability.cityId, 'city-a');
  assert.equal(capability.acceptsRequests, true);
  // The discovery states are REPORTED, never asserted: a City whose publisher failed must say so, and a
  // constant "PUBLISHED" here would be a polite lie on the one endpoint a joining PC trusts to decide
  // whether discovery works.
  assert.equal(capability.discovery.mdns, 'UNKNOWN');
  assert.equal(capability.discovery.ble, 'UNKNOWN');
  const reporting = joinCapability({ cityId: 'city-a' }, { mdns: { state: 'ERROR', reason: 'mDNS socket unavailable' }, ble: { state: 'ACTIVE' } });
  assert.equal(reporting.discovery.mdns, 'ERROR');
  assert.equal(reporting.discovery.mdnsReason, 'mDNS socket unavailable');
  assert.equal(reporting.discovery.ble, 'ACTIVE');
});
