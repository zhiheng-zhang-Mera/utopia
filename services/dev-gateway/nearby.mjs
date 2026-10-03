// JOIN-502 step 1: BROWSING for nearby Cities — the client half of RF-003 local discovery.
//
// The gap this closes, stated exactly: RF-003's contract (contracts/remote-local-discovery-v1) already
// defines what an advertisement and a normalized candidate ARE, and the gateway already ADVERTISES a
// City over mDNS (`services/dev-gateway/discovery.mjs` publishes `_utopia-city._tcp` with an
// `mdnsTxt()` payload). What did not exist is anything that BROWSE the same service type, so the
// product surface could only render the City's own mDNS diagnostics and had nothing to offer a new PC
// to pick. That is the seam the workbook section 2 names: build the integration/adapter/presentation,
// do not build a second discovery protocol.
//
// So this module deliberately does NOT invent an advertisement format. It converts the mDNS records it
// hears into the RF-003 advertisement shape, hands them to the contract's own `normalizeCandidates`,
// and lets the contract decide duplicate collapsing, metadata-vs-identity and freshness. Nothing here
// grants trust: `resolveToPairing` on these candidates reports `DEVICE_ID_REQUIRED`, because a City is
// not a Remote Fabric device and the contract refuses to start a pairing from an unidentified
// sighting. That refusal is the honest answer and the product path uses the City's own join endpoint
// instead (see join.mjs) rather than pretending discovery was authentication.

import Bonjour from 'bonjour-service';
import { normalizeCandidates, pruneStale, resolveToPairing } from '../../contracts/remote-local-discovery-v1/discovery.mjs';

export const NEARBY_SERVICE = Object.freeze({ type: 'utopia-city', protocol: 'tcp' });
/** The advertisement TTL is the same 30s the publisher stamps on its A records, so a City that stops
 *  advertising stops being offered within one TTL instead of lingering in the list for ever. */
export const NEARBY_TTL_MS = 30000;
/** One browse round is bounded in both directions: at most this many records are normalized, and a
 *  growing list can never turn the onboarding page into an unbounded render. */
export const MAX_NEARBY = 32;

const isText = value => typeof value === 'string' && value.trim().length > 0;

/**
 * Convert one mDNS service record into an RF-003 advertisement.
 *
 * `device_id` is left null ON PURPOSE. A City advertises a `cityId`, not a Remote Fabric
 * `dev-<32 hex>` logical device identity, and minting a `dev-` id out of a cityId here would be
 * exactly the "second identity / metadata as identity" move the workbook forbids - it would make an
 * address or a name look like a cryptographic anchor. The contract already models this: an
 * unidentified sighting is a human preview that cannot start a pairing.
 */
export function advertisementFromService(service, { advertisedAt = new Date().toISOString(), ttlMs = NEARBY_TTL_MS } = {}) {
  if (!isText(service?.name) || !isText(service?.host)) return null;
  const txt = service.txt && typeof service.txt === 'object' ? service.txt : {};
  const addresses = [...new Set([...(service.addresses ?? []), service.host].filter(isText).map(a => a.trim().toLowerCase()))].sort();
  if (addresses.length === 0) return null;
  return {
    device_id: null,
    installation_ref: isText(txt.city) ? txt.city : null,
    display_name: String(service.name),
    addresses,
    interfaces: [{ name: 'mdns', kind: 'OTHER', subnet: null, address: addresses[0] }],
    source: 'MDNS_DNS_SD',
    advertised_at: advertisedAt,
    ttl_ms: ttlMs,
    mac_evidence: null,
    platform: isText(txt.api) ? `city-api-${txt.api}` : null,
  };
}

/**
 * What the product surface is allowed to say about a discovered record.
 *
 * `join_endpoint` is built from the ADVERTISED host and port, never from anything the caller passed,
 * so the address on screen is the address the City published. `transport` is a hint about how the
 * record arrived and is never an identity. The City's `pairingSessionId` from the TXT record is
 * carried as `advertised_session` for diagnostics only: it is not a secret, not a code, and the
 * surface must not present it as one - the Owner's rule (JOIN-501) is that no temporary pairing
 * material exists before an explicit Generate.
 */
export function nearbyView(candidate, { port = null } = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const unresolved = candidate.stale === true;
  const address = (candidate.addresses ?? [])[0] ?? null;
  return Object.freeze({
    candidateRef: candidate.candidate_ref,
    cityRef: candidate.installation_ref ?? null,
    displayName: candidate.display_name,
    address,
    port: Number.isInteger(port) ? port : null,
    // The address on screen is the address the City PUBLISHED, rebuilt from the record's own host and
    // port. A candidate whose evidence has expired has no endpoint at all: stale local state must not
    // hand a caller an address to act on.
    joinEndpoint: unresolved || !address || !Number.isInteger(port) ? null : `http://${address}:${port}`,
    transport: (candidate.sources ?? [])[0] ?? 'MDNS_DNS_SD',
    lastSeenAt: candidate.last_seen_at,
    stale: unresolved,
    // Both are contract constants, re-stated so a renderer cannot accidentally promote them.
    displayNameIsMetadata: true,
    macIsAuthority: false,
    grantsTrust: false,
  });
}

/**
 * Ask a discovered City who it is.
 *
 * WHY THIS EXISTS. The mDNS TXT record carries `city` as a SHORT prefix (see discovery.mjs, which
 * publishes `Utopia-<8 chars>`), because a service label and a TXT budget are not a place for a full
 * UUID - but the join protocol pins the FULL identity, so a surface that used the advertisement as the
 * pinned identity would refuse its own City (measured: "this join link names a different City"). Rather
 * than loosen the pin to a prefix match, which would weaken exactly the check that stops an ask being
 * delivered to the wrong City, the full identity is read from the City's own capability endpoint. It is
 * a GET of public information, bounded, and a City that cannot answer is dropped from the list instead
 * of being offered as a target that cannot be joined.
 */
async function identifyCity(endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl(`${endpoint}/api/v0/join/info`, {
      method: 'GET',
      headers: { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.cityId === 'string' && body.cityId ? { cityId: body.cityId, displayName: typeof body.displayName === 'string' ? body.displayName : null, acceptsRequests: body.acceptsRequests !== false } : null;
  } catch {
    return null;
  }
}

/**
 * Browse for nearby Cities for a bounded window and return normalized candidates.
 *
 * Injected dependencies are the whole point of the signature: the RF-003 double
 * (`createDiscoveryAdapterDouble`) can drive this in a test with no sockets and no network, while a
 * real run passes the bonjour browser. The returned shape is the contract's, not ours.
 */
export async function browseNearby({
  bonjourFactory = options => new Bonjour(options),
  timeoutMs = 2500,
  max = MAX_NEARBY,
  now = () => Date.now(),
  interface: iface,
  fetchImpl = globalThis.fetch,
  identify = true,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('browseNearby needs a positive timeoutMs');
  if (!Number.isSafeInteger(max) || max <= 0) throw new Error('browseNearby needs a positive integer max');
  const seen = [];
  let bonjour = null;
  let browser = null;
  try {
    bonjour = bonjourFactory(iface ? { interface: iface } : {});
    await new Promise(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      try {
        browser = bonjour.find({ ...NEARBY_SERVICE }, service => {
          if (seen.length >= max) return;
          const advertisement = advertisementFromService(service, { advertisedAt: new Date(now()).toISOString() });
          if (advertisement) seen.push({ advertisement, port: Number.isInteger(service.port) ? service.port : null });
        });
        browser.on?.('error', finish);
      } catch {
        // A machine with no usable multicast interface is not an error the onboarding page should
        // crash on: it is the "nothing discovered" case, and the fallbacks must still be offered.
        finish();
      }
    });
    const normalized = normalizeCandidates(seen.map(entry => entry.advertisement), { nowMs: now() });
    const { candidates, stale } = pruneStale(normalized.candidates, now());
    const portFor = candidate => seen.find(entry => entry.advertisement.installation_ref !== null && entry.advertisement.installation_ref === candidate.installation_ref)?.port ?? null;
    const views = candidates.slice(0, max).map(candidate => nearbyView(candidate, { port: portFor(candidate) }));
    // Bounded identification pass: only rows with a usable endpoint, only in parallel, each with its own
    // short timeout, and a row that fails identification is DROPPED rather than offered un-joinable.
    let offered = views;
    if (identify) {
      const identified = await Promise.all(views.map(async view => {
        if (!view.joinEndpoint) return null;
        const identity = await identifyCity(view.joinEndpoint, { fetchImpl });
        if (!identity || identity.acceptsRequests === false) return null;
        return { ...view, cityId: identity.cityId, displayName: identity.displayName ?? view.displayName };
      }));
      offered = identified.filter(Boolean);
    }
    return Object.freeze({
      candidates: Object.freeze(offered.map(view => Object.freeze(view))),
      stale: Object.freeze(stale),
      // Resolution through the SAME contract the rest of RF uses, so a caller that expects a pairing
      // entry point gets the contract's refusal rather than a home-made one.
      resolutions: Object.freeze(candidates.slice(0, max).map(candidate => resolveToPairing(candidate, { nowMs: now() }))),
      bounded: true,
      max,
      discovered: seen.length,
    });
  } catch {
    return Object.freeze({ candidates: Object.freeze([]), stale: Object.freeze([]), resolutions: Object.freeze([]), bounded: true, max, discovered: 0, unavailable: true });
  } finally {
    try { browser?.stop?.(); } catch {}
    try { bonjour?.destroy?.(); } catch {}
  }
}

/**
 * The City-side capability statement. A joining surface asks the City what it supports instead of
 * inferring it from a version string, and a City that does not answer this route is simply not a
 * join target - which is how "unavailable" stays honest.
 *
 * `discovery` is passed IN rather than asserted here: the workbook requires the surface to say
 * "unavailable" truthfully, and a City whose mDNS publisher failed must not announce that it is
 * published. A constant would have made this endpoint a polite lie.
 */
export function joinCapability(descriptor, discoveryState = null) {
  const d = descriptor ?? {};
  const mdns = discoveryState?.mdns?.state ?? 'UNKNOWN';
  const ble = discoveryState?.ble?.state ?? 'UNKNOWN';
  return Object.freeze({
    joinProtocolVersion: 1,
    cityId: d.cityId ?? null,
    displayName: d.displayName ?? null,
    // Whether there is an APPROVED join request waiting is not disclosed unauthenticated: the surface
    // only needs to know the City accepts requests.
    acceptsRequests: true,
    // Stated so the client can offer the right fallbacks rather than guess.
    discovery: { mdns, ble, mdnsReason: discoveryState?.mdns?.reason ?? null, bleReason: discoveryState?.ble?.reason ?? null },
  });
}
