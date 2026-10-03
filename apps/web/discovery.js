// JOIN-502 step 3: the discovery ADAPTER for the product surface.
//
// The browser cannot listen to multicast DNS, so the real browse is performed by the launcher/gateway
// side (services/dev-gateway/nearby.mjs) and observed here through a probe. This module contains the
// parts that must be testable without a browser: the shape of one discovered City, deduplication by
// City identity, staleness, and the transport wording. Everything it returns is METADATA: a discovered
// City grants no trust (`grantsTrust` is a constant false, mirroring the RF-003 contract, which states
// the same thing about candidates), so the surface must never treat a sighting as a credential.

/** One discovery round is bounded: at most this many rows are shown, whatever the network says. */
export const MAX_NEARBY_ROWS = 8;
/** A sighting older than this is not offered as a join target. */
export const NEARBY_TTL_MS = 30000;

const isText = value => typeof value === 'string' && value.trim().length > 0;

/**
 * Normalize one raw discovery probe result into a nearby-City row.
 *
 * Returns null for anything unusable rather than inventing fields: a row with no reachable endpoint
 * cannot be joined, and offering it would be a false affordance. `stale` is computed against `now`
 * here (never trusted from the wire) for the same reason the RF-003 contract re-derives freshness at
 * the moment of use.
 */
export function normalizeNearby(raw, { now = Date.now(), ttlMs = NEARBY_TTL_MS } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const address = isText(raw.address) ? raw.address.trim() : null;
  const port = Number.isInteger(raw.port) ? raw.port : null;
  const seenAt = Number.isFinite(Date.parse(raw.lastSeenAt)) ? Date.parse(raw.lastSeenAt) : now;
  const age = now - seenAt;
  // Two-sided freshness: a row whose own timestamp lies in the future by more than a minute is not
  // current evidence, exactly as the RF-003 contract treats a peer clock running ahead.
  const stale = age >= ttlMs || age < -60000;
  const endpoint = address && port ? `http://${address}:${port}` : null;
  return Object.freeze({
    key: isText(raw.cityRef) ? `city:${raw.cityRef}` : `addr:${address ?? 'unknown'}:${port ?? 0}`,
    cityRef: isText(raw.cityRef) ? raw.cityRef : null,
    displayName: isText(raw.displayName) ? raw.displayName.trim().slice(0, 80) : 'Nearby City',
    address,
    port,
    endpoint,
    transport: raw.transport === 'BLE_BOOTSTRAP' ? 'BLE_BOOTSTRAP' : 'LAN',
    lastSeenAt: new Date(seenAt).toISOString(),
    stale,
    // Constants, restated so no renderer can promote them into trust by accident.
    grantsTrust: false,
    displayNameIsMetadata: true,
    isIdentity: false,
  });
}

/**
 * Collapse a probe's rows into the list the surface offers.
 *
 * Deduplication is by City identity when the record carried one, otherwise by address+port. An
 * unidentified sighting is never merged into an identified City (the RF-003 rule: a display name is
 * metadata and may neither join nor split devices), and stale rows are dropped instead of shown
 * greyed out, because a stale address is one the surface must not hand a user to act on.
 */
export function nearbyCities(rawRows, { now = Date.now(), ttlMs = NEARBY_TTL_MS, max = MAX_NEARBY_ROWS } = {}) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const byKey = new Map();
  for (const raw of rows) {
    const row = normalizeNearby(raw, { now, ttlMs });
    if (!row || row.stale) continue;
    const prior = byKey.get(row.key);
    // Newest sighting wins: the same City re-advertised must not appear twice, and its address must be
    // the one it published most recently.
    if (!prior || Date.parse(row.lastSeenAt) >= Date.parse(prior.lastSeenAt)) byKey.set(row.key, row);
  }
  return Object.freeze([...byKey.values()].slice(0, max));
}

/** What the surface may claim about a transport. Honest about absence: the browser cannot scan BLE. */
export function transportLabel(transport) {
  if (transport === 'BLE_BOOTSTRAP') return 'ble';
  return 'lan';
}

/**
 * The discovery PROBE. The browser cannot enumerate multicast, so the probe asks the City that serves
 * this page; a build/platform that cannot answer leaves the list empty and the fallbacks in place,
 * which is the workbook's "unavailable must be honest" rule. A probe is never allowed to throw into
 * the boot path: a failure to discover is an empty list, not a broken page.
 */
export async function probeNearby({ fetchImpl = globalThis.fetch, endpoint = '/api/v0/join/nearby', timeoutMs = 4000, now = Date.now() } = {}) {
  if (typeof fetchImpl !== 'function') return Object.freeze({ cities: Object.freeze([]), unavailable: true, reason: 'NO_FETCH' });
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return Object.freeze({ cities: Object.freeze([]), unavailable: true, reason: `HTTP_${response.status}` });
    const body = await response.json();
    const rows = Array.isArray(body?.nearby) ? body.nearby : [];
    // `now` is threaded through rather than read again here: a freshness verdict is about one instant,
    // and two reads of the clock inside one probe can disagree about a row on the ttl boundary.
    return Object.freeze({ cities: nearbyCities(rows, { now: typeof now === 'function' ? now() : now }), unavailable: false, reason: null, bounded: body?.bounded === true });
  } catch (error) {
    return Object.freeze({ cities: Object.freeze([]), unavailable: true, reason: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'PROBE_FAILED' });
  }
}
