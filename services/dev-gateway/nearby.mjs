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
import { isIP } from 'node:net';
import { scanBle } from '../../platform/windows/ble.mjs';
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
 * Is this discovery candidate THIS City's own advertisement?
 *
 * mDNS/DNS-SD returns every advertisement on the segment, including the one this City publishes, so without this check
 * a City listed itself as a neighbour - the reported defect "I can search up my own main city, it is a duplicate".
 *
 * Self is decided by IDENTITY first: if the advertisement names a City and that City is us, it is us. Only when an
 * advertisement does NOT identify a City do address and port decide, and then BOTH must match this City's own address
 * and listening port - a bare port match would hide a genuine neighbour that happens to use the same port. Display names
 * are deliberately never used, because two machines may legitimately share one.
 */
export function isSelfAdvertisement(candidate, { selfCityId = null, selfAddresses = [], selfPort = null } = {}) {
  if (!candidate || typeof candidate !== 'object') return false;
  const ref = typeof candidate.cityId === 'string' ? candidate.cityId : (typeof candidate.cityRef === 'string' ? candidate.cityRef : null);
  if (ref && selfCityId && ref === selfCityId) return true;
  const address = typeof candidate.address === 'string' ? candidate.address.trim().toLowerCase() : null;
  if (!address) return false;
  const candidatePort = Number(candidate.port);
  if (!Number.isInteger(candidatePort) || !Number.isInteger(selfPort)) return false;
  const addresses = Array.isArray(selfAddresses) || selfAddresses instanceof Set ? [...selfAddresses] : [];
  const mine = new Set(addresses.filter(isText).map(value => value.trim().toLowerCase()));
  return candidatePort === selfPort && mine.has(address);
}

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
export async function identifyCity(endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl(`${endpoint}/api/v0/join/info`, {
      method: 'GET',
      headers: { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = await response.json();
    // The carrier facts travel with the identification, because this is the ONLY moment a remote surface can learn
    // what the other machine is: after this pass the client holds an endpoint and a name, and nothing else.
    return typeof body?.cityId === 'string' && body.cityId ? { cityId: body.cityId, displayName: typeof body.displayName === 'string' ? body.displayName : null, acceptsRequests: body.acceptsRequests !== false, carrierFacts: body.carrierFacts ?? null } : null;
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
  let unavailable = false;
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
        browser.on?.('error', () => { unavailable = true; finish(); });
      } catch {
        // A machine with no usable multicast interface is not an error the onboarding page should
        // crash on: it is the "nothing discovered" case, and the fallbacks must still be offered.
        unavailable = true; finish();
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
        const candidate = candidates.find(c => c.candidate_ref === view.candidateRef);
        // A multi-NIC host can advertise an unreachable adapter before its Wi-Fi IP.
        // Try all advertised addresses within one timeout, then retain the one that answered.
        const addresses = (candidate?.addresses ?? [view.address]).filter(a => typeof a === 'string' && /^[a-zA-Z0-9.:-]+$/.test(a) && !a.startsWith('fe80:'));
        const rank = a => isIP(a) === 4 && !a.startsWith('169.254.') && !a.startsWith('127.') ? 0 : isIP(a) === 6 ? 2 : 1;
        addresses.sort((a,b) => rank(a)-rank(b));
        const replies = await Promise.all(addresses.slice(0,8).map(async address => {
          const endpoint = `http://${isIP(address) === 6 ? `[${address}]` : address}:${view.port}`;
          return { address, endpoint, identity: await identifyCity(endpoint, { fetchImpl }) };
        }));
        const reply = replies.find(r => r.identity && r.identity.acceptsRequests !== false);
        if (!reply) return null;
        const identity = reply.identity;
        return { ...view, address: reply.address, joinEndpoint: reply.endpoint, cityId: identity.cityId, displayName: identity.displayName ?? view.displayName, carrierFacts: identity.carrierFacts ?? null };
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
      unavailable,
    });
  } catch {
    return Object.freeze({ candidates: Object.freeze([]), stale: Object.freeze([]), resolutions: Object.freeze([]), bounded: true, max, discovered: 0, unavailable: true });
  } finally {
    try { browser?.stop?.(); } catch {}
    try { bonjour?.destroy?.(); } catch {}
  }
}

export async function browseBluetooth({ scan = scanBle, fetchImpl = globalThis.fetch, timeoutMs = 5000, now = Date.now } = {}) {
  const result = await scan({ timeoutMs });
  if (result.unavailable) return { candidates: [], bounded: true, discovered: 0, unavailable: true, reason: result.reason };
  const endpoints = [...new Set(result.endpoints ?? [])].slice(0, MAX_NEARBY);
  const candidates = (await Promise.all(endpoints.map(async endpoint => {
    const identity = await identifyCity(endpoint, { fetchImpl });
    if (!identity || identity.acceptsRequests === false) return null;
    const url = new URL(endpoint);
    return { cityId: identity.cityId, cityRef: identity.cityId, displayName: identity.displayName, address: url.hostname, port: Number(url.port||80), transport: 'BLE_BOOTSTRAP', lastSeenAt: new Date(now()).toISOString(), grantsTrust: false, carrierFacts: identity.carrierFacts };
  }))).filter(Boolean);
  return { candidates, bounded: true, discovered: endpoints.length, unavailable: false };
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
/**
 * What THIS host can honestly say about itself as a carrier.
 *
 * Split out — and taking its inputs as arguments — so it can be tested with fixed numbers instead of the machine
 * it happens to run on, and so the one place that touches `node:os` is visible rather than scattered.
 *
 * `attachment` and `metered` are NOT derivable from node's standard library, so they are passed in (a caller that
 * knows, from configuration, may fill them) and default to null. Null means "unknown", never "wifi": the scoring
 * side must not be handed a guess dressed as a measurement.
 */
export function hostCarrierFacts({ cores, totalMemoryBytes, freeMemoryBytes, loadAverage1m = null, attachment = null, metered = null, platform = process.platform, now = () => Date.now() } = {}) {
  return {
    cores: Number.isFinite(cores) ? cores : null,
    memoryTotalBytes: Number.isFinite(totalMemoryBytes) ? totalMemoryBytes : null,
    memoryFreeBytes: Number.isFinite(freeMemoryBytes) ? freeMemoryBytes : null,
    // loadAverage is always 0 on Windows, so a 0 is reported as-is: it is what the platform says, and the
    // scoring side treats 0 as "no evidence of load", not as proof of an idle machine.
    loadAverage1m: Number.isFinite(loadAverage1m) ? loadAverage1m : null,
    attachment: typeof attachment === 'string' ? attachment : null,
    metered: typeof metered === 'boolean' ? metered : null,
    platform: typeof platform === 'string' ? platform : null,
    measuredAt: new Date(now()).toISOString(),
  };
}

export function joinCapability(descriptor, discoveryState = null, carrierFacts = null) {
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
    // WHAT KIND OF CARRIER THIS HOST WOULD BE, published so a REMOTE client (one that cannot read this
    // machine's filesystem and has never spoken to it) can weigh it against its own machine and the other PCs it
    // can see. Without this the only thing a remote surface could score is the network path, and "which PC should
    // host" would degenerate into "whichever answered first".
    //
    // EVERY FIELD IS OPTIONAL ON PURPOSE, and a field this host cannot measure is published as null rather than
    // guessed: node has no portable way to say whether the link is wired or wireless, or whether it is metered, so
    // those are null here and the scoring side treats null as "unknown attachment" instead of assuming wifi.
    carrierFacts: carrierFacts === null ? null : Object.freeze({
      cores: Number.isFinite(carrierFacts?.cores) ? carrierFacts.cores : null,
      memoryTotalBytes: Number.isFinite(carrierFacts?.memoryTotalBytes) ? carrierFacts.memoryTotalBytes : null,
      memoryFreeBytes: Number.isFinite(carrierFacts?.memoryFreeBytes) ? carrierFacts.memoryFreeBytes : null,
      loadAverage1m: Number.isFinite(carrierFacts?.loadAverage1m) ? carrierFacts.loadAverage1m : null,
      attachment: typeof carrierFacts?.attachment === 'string' ? carrierFacts.attachment : null,
      metered: typeof carrierFacts?.metered === 'boolean' ? carrierFacts.metered : null,
      platform: typeof carrierFacts?.platform === 'string' ? carrierFacts.platform : null,
      measuredAt: typeof carrierFacts?.measuredAt === 'string' ? carrierFacts.measuredAt : null,
    }),
  });
}
