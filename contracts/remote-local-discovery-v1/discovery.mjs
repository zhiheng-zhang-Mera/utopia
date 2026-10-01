// Local discovery (same-Wi-Fi / LAN) contract (RF-003).
//
// Discovery is an *entry point*, never trust. This module finds nearby City nodes, normalizes what
// it hears into one logical-device abstraction and hands candidates to the common pairing path; it
// grants nothing, invokes nothing and never treats an address, hostname, display name or MAC as
// identity. Pure module: no sockets, clock, filesystem or ambient state.
export const LOCAL_DISCOVERY_VERSION = 1;

export const DISCOVERY_SOURCES = Object.freeze(['MDNS_DNS_SD', 'LAN_BROADCAST', 'LAN_MULTICAST', 'DIRECT_ADDRESS', 'KNOWN_PEER']);
export const INTERFACE_KINDS = Object.freeze(['WIFI', 'ETHERNET', 'OTHER']);
export const RESOLUTION_ENTRY_POINTS = Object.freeze(['DISCOVERY_LAN', 'DIRECT_ADDRESS']);
export const PATH_KINDS = Object.freeze(['LOCAL_DIRECT']);
/** Discovery traffic is bounded: a subnet is never scanned in full. */
export const MAX_SCAN_TARGETS = 64;
export const MAX_ADVERTISEMENTS_PER_ROUND = 256;
/**
 * Tolerance for a peer clock that runs ahead of ours. A sighting is only rejected as future-dated
 * beyond this window, so ordinary NTP skew does not invalidate a genuine peer, while a replayed or
 * hostile sighting dated minutes/hours/years ahead is never accepted as current evidence.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const LOCAL_DISCOVERY_CODES = Object.freeze([
  'INVALID_CANDIDATE', 'INVALID_INTERFACE', 'DUPLICATE_CANDIDATE', 'STALE_ADVERTISEMENT',
  'UNTRUSTED_CANDIDATE', 'UNKNOWN_SOURCE', 'UNBOUNDED_SCAN_REFUSED', 'BOUNDED_SCAN_REQUIRED',
  'TRUST_REQUIRED_FOR_DIRECT_PATH', 'FINGERPRINT_MISMATCH', 'DEVICE_ID_REQUIRED', 'ADAPTER_REQUIRED',
]);

export class LocalDiscoveryError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LocalDiscoveryError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * A value this module accepts as a record must carry its fields as *own* properties on a bare
 * object. Validating key names while reading values through the prototype chain is not a shape
 * check: an object with no own keys but a prototype supplying `device_id`, `addresses` and
 * `advertised_at` would otherwise validate clean and become an identified candidate, and re-pointing
 * that prototype would silently change what the next call consumes.
 */
const isBareObject = value => isPlainObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (source, key) => (Object.hasOwn(source, key) ? source[key] : undefined);
const isText = value => typeof value === 'string' && value.trim().length > 0;
/** Addresses are canonically lower-case and unpadded, so one address has exactly one spelling. */
const canonicalAddress = value => value.trim().toLowerCase();
const clone = value => (value === undefined ? undefined : structuredClone(value));
const isIsoInstantShape = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
/**
 * Shape is not enough: `2026-13-45T99:99:99Z` matches the regex but parses to NaN, and every `NaN`
 * comparison is false — so an "unparseable" timestamp used to read as *not stale* (current
 * evidence). The instant must also round-trip to the calendar date it claims.
 */
export const isIsoInstant = value => {
  if (!isIsoInstantShape(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
};
export const DEVICE_ID_PATTERN = /^dev-[0-9a-f]{32}$/;
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * The adapter contract every discovery mechanism implements. mDNS/DNS-SD, LAN broadcast, LAN
 * multicast and the direct-address/known-peer fallback all produce the *same* candidate shape, so
 * nothing above this layer knows how a peer was found.
 */
export const DISCOVERY_ADAPTER_PORT = Object.freeze({
  interface: 'LocalDiscoveryAdapterPort',
  version: LOCAL_DISCOVERY_VERSION,
  methods: Object.freeze(['describe', 'discover']),
  grants_trust: false,
  is_a_trust_flow: false,
  bounded: true,
});

/** Deterministic adapter double: scripted advertisements, no sockets. */
export function createDiscoveryAdapterDouble({ source = 'MDNS_DNS_SD', advertisements = [] } = {}) {
  if (!DISCOVERY_SOURCES.includes(source)) throw new LocalDiscoveryError('UNKNOWN_SOURCE', String(source));
  const rounds = [];
  return Object.freeze({
    describe: () => ({ source, bounded: true, max_advertisements_per_round: MAX_ADVERTISEMENTS_PER_ROUND }),
    /** `round` selects a scripted set, so tests can simulate duplicates and staleness. */
    discover: ({ round = 0, limit = MAX_ADVERTISEMENTS_PER_ROUND } = {}) => {
      // The cap is two-sided too: a negative `limit` is a valid slice *offset*, so clamping only from
      // above let `limit: -1` emit the whole round minus one and defeat the declared bound.
      if (!Number.isSafeInteger(limit) || limit < 0) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'limit must be a non-negative integer');
      const scripted = advertisements[round] ?? advertisements.at(-1) ?? [];
      const bounded = scripted.slice(0, Math.min(limit, MAX_ADVERTISEMENTS_PER_ROUND));
      rounds.push({ round, emitted: bounded.length });
      return { source, advertisements: bounded.map(clone), truncated: scripted.length > bounded.length };
    },
    __rounds: rounds,
  });
}

export function validateInterface(entry, path = 'interface') {
  const errors = [];
  if (!isBareObject(entry)) return [`${path} must be a plain own-property object`];
  for (const key of Object.keys(entry)) if (!['name', 'kind', 'subnet', 'address'].includes(key)) errors.push(`${path}.${key} is not part of an interface description`);
  const name = own(entry, 'name');
  const kind = own(entry, 'kind');
  const subnet = own(entry, 'subnet');
  const address = own(entry, 'address');
  if (!isText(name)) errors.push(`${path}.name must be nonempty text`);
  // An interface name is part of the interface merge key, which compares exactly; a padded name
  // would create a second interface for the same hardware.
  else if (name !== name.trim()) errors.push(`${path}.name must not be padded with whitespace`);
  if (!INTERFACE_KINDS.includes(kind)) errors.push(`${path}.kind must be one of ${INTERFACE_KINDS.join(', ')}`);
  if (subnet !== null && subnet !== undefined && !isText(subnet)) errors.push(`${path}.subnet must be text or null`);
  else if (typeof subnet === 'string' && subnet !== subnet.trim()) errors.push(`${path}.subnet must not be padded with whitespace`);
  if (address !== null && address !== undefined && !isText(address)) errors.push(`${path}.address must be text or null`);
  else if (typeof address === 'string' && address !== address.trim()) errors.push(`${path}.address must not be padded with whitespace`);
  return errors;
}

/**
 * Validate an advertisement. `device_id` is required because logical identity is cryptographic:
 * a candidate with no device id can be shown to a human but is not a logical device.
 */
export function validateAdvertisement(advertisement, { requireDeviceId = false, path = 'advertisement' } = {}) {
  const errors = [];
  if (!isBareObject(advertisement)) return { ok: false, errors: [`${path} must be a plain own-property object`] };
  const allowed = ['device_id', 'installation_ref', 'display_name', 'addresses', 'interfaces', 'source', 'advertised_at', 'ttl_ms', 'mac_evidence', 'platform'];
  for (const key of Object.keys(advertisement)) if (!allowed.includes(key)) errors.push(`${path}.${key} is not part of an advertisement`);
  // Every field is read as an own property: scanning own key *names* while reading values through
  // the prototype chain would accept an object that supplies its whole payload by inheritance.
  const deviceId = own(advertisement, 'device_id');
  const installationRef = own(advertisement, 'installation_ref');
  const displayName = own(advertisement, 'display_name');
  const addresses = own(advertisement, 'addresses');
  const interfaces = own(advertisement, 'interfaces');
  const source = own(advertisement, 'source');
  const advertisedAt = own(advertisement, 'advertised_at');
  const ttlMs = own(advertisement, 'ttl_ms');
  const macEvidence = own(advertisement, 'mac_evidence');
  if (requireDeviceId) {
    if (!isText(deviceId) || !DEVICE_ID_PATTERN.test(deviceId)) errors.push(`${path}.device_id must be a Remote Fabric dev-<32 hex> identity`);
  } else if (deviceId !== null && deviceId !== undefined && !DEVICE_ID_PATTERN.test(deviceId)) {
    errors.push(`${path}.device_id must be a dev-<32 hex> identity or null`);
  }
  if (installationRef !== null && installationRef !== undefined && !isText(installationRef)) errors.push(`${path}.installation_ref must be text or null`);
  if (!isText(displayName)) errors.push(`${path}.display_name must be nonempty text`);
  if (!Array.isArray(addresses)) errors.push(`${path}.addresses must be an array`);
  else addresses.forEach((address, index) => {
    if (!isText(address)) errors.push(`${path}.addresses[${index}] must be nonempty text`);
    // Canonical form only: one address has exactly one spelling, so the dedupe/merge key below can
    // never be defeated by padding, and two spellings cannot pose as two addresses.
    else if (!/^\S+$/.test(address) || address !== canonicalAddress(address)) errors.push(`${path}.addresses[${index}] must be a canonical address (no whitespace, lower-case)`);
  });
  if (!Array.isArray(interfaces)) errors.push(`${path}.interfaces must be an array`);
  else interfaces.forEach((entry, index) => errors.push(...validateInterface(entry, `${path}.interfaces[${index}]`)));
  if (!DISCOVERY_SOURCES.includes(source)) errors.push(`${path}.source must be one of ${DISCOVERY_SOURCES.join(', ')}`);
  if (!isIsoInstant(advertisedAt)) errors.push(`${path}.advertised_at must be an ISO-8601 UTC instant`);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) errors.push(`${path}.ttl_ms must be a non-negative integer`);
  // Metadata is never authority: a MAC may be shown, and it may never be required or trusted.
  if (macEvidence !== null && macEvidence !== undefined && !isBareObject(macEvidence)) errors.push(`${path}.mac_evidence must be a plain object or null`);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertAdvertisement(advertisement, options) {
  const verdict = validateAdvertisement(advertisement, options);
  if (!verdict.ok) throw new LocalDiscoveryError('INVALID_CANDIDATE', verdict.errors.slice(0, 3).join('; '));
  return advertisement;
}

// ---- candidate normalization --------------------------------------------

const sourceRank = source => DISCOVERY_SOURCES.indexOf(source);

/** Stable content digest, so an observation can be referenced without exposing its contents. */
const digest = value => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * Freshness is a *two-sided* bound, and that is the only correct form.
 *
 * A sighting is stale once its ttl has elapsed, and it is equally unusable while its own timestamp
 * lies in the future: a replayed, clock-skewed or hostile advertisement dated ahead of `nowMs` must
 * never be treated as current evidence. `Date.parse(last_seen_at) + ttl_ms <= nowMs` alone satisfies
 * a future date for as long as that date is in the future, so such a sighting never ages out — the
 * exact shape of a replay that survives pruning. Only a peer clock running ahead by more than
 * `MAX_CLOCK_SKEW_MS` is rejected, so ordinary NTP skew cannot invalidate a genuine peer.
 * Unparseable evidence is not fresh either.
 */
const isStaleSighting = (lastSeenAt, ttlMs, nowMs) => {
  const observed = Date.parse(lastSeenAt);
  if (!Number.isFinite(observed)) return true;
  const age = nowMs - observed;
  if (age < -MAX_CLOCK_SKEW_MS) return true;
  return age >= (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0);
};

/**
 * A candidate is stale when normalization already judged it so, or when `nowMs` proves it. With no
 * time source the module makes no freshness claim (it is pure, and has no clock), so an unjudged
 * candidate is not silently promoted to fresh — see `upgradeToDirectPath`, which refuses on either.
 */
const isStaleCandidate = (candidate, nowMs = null) => {
  if (candidate?.stale === true) return true;
  if (nowMs === null || typeof candidate?.last_seen_at !== 'string') return false;
  return isStaleSighting(candidate.last_seen_at, candidate.ttl_ms, nowMs);
};

/**
 * Unidentified sightings carry no cryptographic identity, so they may never be merged on metadata.
 *
 * Two observations collapse only when the *whole* observation is the same — same source, addresses,
 * interfaces, MAC evidence, platform, installation and advertised_at — which means "the same
 * advertisement was heard twice" rather than "two things looked alike". The previous key was
 * `display_name|addresses`, so two genuinely different devices that happened to share a display name
 * and no address collapsed into one candidate, and an advertiser could claim another device's
 * candidate merely by repeating its display name. A display name is metadata (see the module header
 * and the workbook: identity is cryptographic), so it may neither join nor split devices on its own;
 * here it participates only as one field of a full-observation match.
 */
const unidentifiedKey = advertisement => digest(JSON.stringify({
  source: advertisement.source,
  addresses: [...(advertisement.addresses ?? [])].map(address => address.toLowerCase()).sort(),
  interfaces: [...(advertisement.interfaces ?? [])]
    .map(entry => `${entry.kind}:${entry.name}:${entry.subnet ?? ''}:${entry.address ?? ''}`)
    .sort(),
  mac_evidence: advertisement.mac_evidence ?? null,
  platform: advertisement.platform ?? null,
  installation_ref: advertisement.installation_ref ?? null,
  display_name: advertisement.display_name,
  advertised_at: advertisement.advertised_at,
  ttl_ms: advertisement.ttl_ms,
}));

/**
 * Normalize advertisements into logical-device candidates.
 *
 * Two rules, both required by the workbook:
 *   - wired and Wi-Fi sightings of one device normalize to the SAME candidate, keyed by the
 *     cryptographic `device_id` when present (never by address, hostname or display name);
 *   - duplicates collapse, so repeated advertisements never create a second logical device.
 * When a device id is absent the sighting is kept as an `unidentified` candidate (human preview
 * only) rather than being merged into a device it may not be. Unidentified sightings are therefore
 * keyed by the whole observation, never by a display name or an address on its own.
 */
export function normalizeCandidates(advertisements, { nowMs = null } = {}) {
  if (!Array.isArray(advertisements)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'advertisements must be an array');
  const byDevice = new Map();
  const unidentified = new Map();
  const duplicates = [];
  for (const advertisement of advertisements) {
    const verdict = validateAdvertisement(advertisement);
    if (!verdict.ok) throw new LocalDiscoveryError('INVALID_CANDIDATE', verdict.errors.slice(0, 3).join('; '));
    // Validation has already refused any non-bare object, but every consumed field is still read as
    // an *own* property so a polluted Object.prototype can never supply one.
    const sighting = {
      device_id: own(advertisement, 'device_id') ?? null,
      installation_ref: own(advertisement, 'installation_ref') ?? null,
      display_name: own(advertisement, 'display_name'),
      addresses: own(advertisement, 'addresses').map(canonicalAddress),
      interfaces: own(advertisement, 'interfaces'),
      source: own(advertisement, 'source'),
      advertised_at: own(advertisement, 'advertised_at'),
      ttl_ms: own(advertisement, 'ttl_ms'),
      mac_evidence: own(advertisement, 'mac_evidence') ?? null,
      platform: own(advertisement, 'platform') ?? null,
    };
    if (sighting.device_id === null) {
      const key = unidentifiedKey(sighting);
      const seen = unidentified.get(key);
      if (seen) {
        // Only a repeat of the identical observation is a duplicate; nothing here is an identity.
        duplicates.push({ reason: 'DUPLICATE_UNADDRESSED_SIGHTING', key, observation_digest: key });
        unidentified.set(key, {
          ...seen,
          sightings: seen.sightings + 1,
          last_seen_at: sighting.advertised_at > seen.last_seen_at ? sighting.advertised_at : seen.last_seen_at,
          ttl_ms: Math.max(seen.ttl_ms, sighting.ttl_ms),
        });
        continue;
      }
      unidentified.set(key, { candidate_ref: `unidentified:${key}`, device_id: null, identified: false, sources: [sighting.source], display_name: sighting.display_name, addresses: [...sighting.addresses], interfaces: clone(sighting.interfaces), installation_ref: sighting.installation_ref, first_seen_at: sighting.advertised_at, last_seen_at: sighting.advertised_at, ttl_ms: sighting.ttl_ms, sightings: 1, platform: sighting.platform, display_name_is_metadata: true, mac_evidence_is_authority: false });
      continue;
    }
    const existing = byDevice.get(sighting.device_id);
    if (existing) {
      // merge: union of addresses/interfaces/sources, best-ranked source, latest sighting
      const merged = new Set([...existing.addresses, ...sighting.addresses]);
      const interfaces = [...existing.interfaces, ...sighting.interfaces].filter((entry, index, all) => all.findIndex(candidate => `${candidate.kind}:${candidate.name}` === `${entry.kind}:${entry.name}`) === index);
      const sources = [...new Set([...existing.sources, sighting.source])].sort((left, right) => sourceRank(left) - sourceRank(right));
      duplicates.push({ reason: 'DUPLICATE_ADVERTISEMENT', device_id: sighting.device_id, merged_addresses: merged.size });
      byDevice.set(sighting.device_id, {
        ...existing,
        addresses: [...merged].sort(),
        interfaces,
        sources,
        sightings: existing.sightings + 1,
        last_seen_at: sighting.advertised_at > existing.last_seen_at ? sighting.advertised_at : existing.last_seen_at,
        ttl_ms: Math.max(existing.ttl_ms, sighting.ttl_ms),
        installation_ref: existing.installation_ref ?? sighting.installation_ref,
        platform: existing.platform ?? sighting.platform,
        interface_kinds: [...new Set(interfaces.map(entry => entry.kind))].sort(),
        // No freshness verdict is carried over from the earlier sighting: the snapshot below is taken
        // once, against the merged `last_seen_at`.
      });
      continue;
    }
    byDevice.set(sighting.device_id, {
      candidate_ref: `device:${sighting.device_id}`,
      device_id: sighting.device_id,
      identified: true,
      display_name: sighting.display_name,
      addresses: [...new Set(sighting.addresses)].sort(),
      interfaces: clone(sighting.interfaces),
      interface_kinds: [...new Set(sighting.interfaces.map(entry => entry.kind))].sort(),
      sources: [sighting.source],
      installation_ref: sighting.installation_ref,
      first_seen_at: sighting.advertised_at,
      last_seen_at: sighting.advertised_at,
      ttl_ms: sighting.ttl_ms,
      sightings: 1,
      platform: sighting.platform,
      display_name_is_metadata: true,
      mac_evidence_is_authority: false,
    });
  }
  const candidates = [...byDevice.values(), ...unidentified.values()].sort((left, right) => left.candidate_ref.localeCompare(right.candidate_ref));
  // `stale` is a snapshot taken at `nowMs`, never a durable property of the candidate: consumers must
  // re-derive it (see `freshnessOf`) because a verdict that stays `false` forever is not freshness.
  const withFreshness = nowMs === null ? candidates : candidates.map(candidate => ({
    ...candidate,
    stale: isStaleSighting(candidate.last_seen_at, candidate.ttl_ms, nowMs),
  }));
  return Object.freeze({
    candidates: Object.freeze(withFreshness),
    duplicates: Object.freeze(duplicates.map(Object.freeze)),
    unidentified_count: unidentified.size,
  });
}

/**
 * Re-derive the freshness of a candidate's address evidence at the moment it is acted on.
 *
 * `normalizeCandidates` records `stale` as a *snapshot* taken at its own `nowMs`; that verdict is
 * evidence about the past and must never be re-emitted as a current one. Every boundary that acts on
 * an address calls this, so a sighting cannot be resolved, made reachable or upgraded after its ttl
 * has elapsed merely because someone snapshotted it while it was still fresh.
 */
export function freshnessOf(candidate, nowMs = null) {
  if (!isPlainObject(candidate)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'a candidate is required');
  const judged = candidate.stale === true;
  const derivable = nowMs !== null && typeof candidate.last_seen_at === 'string';
  const stale = judged || (derivable && isStaleSighting(candidate.last_seen_at, candidate.ttl_ms, nowMs));
  return Object.freeze({
    stale,
    // `checked` is false when the caller supplied no time and the snapshot had not judged it: the
    // module has no clock, so it reports "not known to be stale", not "verified fresh".
    checked: judged || derivable,
    last_seen_at: candidate.last_seen_at ?? null,
    ttl_ms: candidate.ttl_ms ?? null,
    now_ms: nowMs,
  });
}

/** Drop stale sightings. Logical identity does not change when an advertisement ages out. */
export function pruneStale(candidates, nowMs) {
  if (!Array.isArray(candidates)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'candidates must be an array');
  const fresh = [];
  const stale = [];
  for (const candidate of candidates) {
    if (isStaleSighting(candidate.last_seen_at, candidate.ttl_ms, nowMs)) stale.push(candidate.device_id ?? candidate.candidate_ref);
    else fresh.push(candidate);
  }
  return Object.freeze({ candidates: Object.freeze(fresh), stale: Object.freeze(stale.sort()) });
}

// ---- resolution into the common pairing path -----------------------------

/**
 * Resolve a candidate into the *common* pairing entry, never a LAN-specific trust flow. The result
 * is an entry point plus hints; trust is established by the one pairing state machine (RF-002).
 *
 * A candidate whose address evidence has expired resolves to nothing: resolution is what hands a
 * caller an address to act on, and "stale local state cannot resume a side effect without current
 * authority/revalidation" (workbook). The refusal is fail-closed — a sighting known to be stale is
 * refused whether or not the caller supplied `nowMs`.
 */
export function resolveToPairing(candidate, { preferDirect = false, nowMs = null } = {}) {
  if (!isPlainObject(candidate)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'a candidate is required');
  if (!candidate.identified) return Object.freeze({ resolved: false, code: 'DEVICE_ID_REQUIRED', detail: 'an unidentified sighting can be shown to a human but cannot start a pairing', entry_point: null, freshness: freshnessOf(candidate, nowMs) });
  const freshness = freshnessOf(candidate, nowMs);
  if (freshness.stale) return Object.freeze({ resolved: false, code: 'STALE_ADVERTISEMENT', detail: 'the address evidence has expired; re-discover the peer and revalidate before acting', entry_point: null, device_id: candidate.device_id, freshness });
  const direct = preferDirect && candidate.addresses.length > 0;
  return Object.freeze({
    resolved: true,
    code: null,
    entry_point: direct ? 'DIRECT_ADDRESS' : 'DISCOVERY_LAN',
    device_id: candidate.device_id,
    installation_ref: candidate.installation_ref ?? null,
    addresses: Object.freeze([...candidate.addresses]),
    sources: Object.freeze([...candidate.sources]),
    // Recorded so the caller cannot mistake resolution for trust.
    is_trust: false,
    grants_trust: false,
    display_name_is_metadata: true,
    freshness,
  });
}

/**
 * An untrusted candidate may not invoke anything. Trust comes from a record established by the
 * pairing/trust lifecycle, and the presented fingerprint must be the trusted one.
 */
export function assertMayInvoke(candidate, trust) {
  if (!isPlainObject(candidate)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'a candidate is required');
  if (!candidate.identified) throw new LocalDiscoveryError('DEVICE_ID_REQUIRED', 'an unidentified sighting cannot invoke');
  if (!isPlainObject(trust) || trust.state !== 'TRUSTED' || trust.device_id !== candidate.device_id) {
    throw new LocalDiscoveryError('UNTRUSTED_CANDIDATE', `${candidate.device_id} is discovered but not trusted; discovery never grants invocation`);
  }
  return { device_id: candidate.device_id, trust_id: trust.trust_id ?? null, may_invoke: true };
}

/**
 * Upgrade a trusted local peer to an authenticated, encrypted direct path.
 *
 * Both the trust record and the fingerprint are required: a same-LAN neighbour is never trusted by
 * proximity, and discovery cannot stand in for the credential.
 */
export function upgradeToDirectPath(candidate, trust, { deviceFingerprint, nowMs = null } = {}) {
  assertMayInvoke(candidate, trust);
  // Opening a path is a side effect on address evidence, so the evidence must still be current. A
  // candidate the module itself labelled `stale` is refused whether or not the caller passed `nowMs`;
  // `nowMs` was previously accepted here and used only to stamp `established_at`.
  const freshness = freshnessOf(candidate, nowMs);
  if (freshness.stale) throw new LocalDiscoveryError('STALE_ADVERTISEMENT', 'the address evidence for this candidate has expired; re-discover the peer before opening a direct path');
  if (!isText(deviceFingerprint) || !FINGERPRINT_PATTERN.test(deviceFingerprint)) throw new LocalDiscoveryError('FINGERPRINT_MISMATCH', 'the peer must present its sha256:<hex> fingerprint');
  if (trust.fingerprint !== deviceFingerprint) throw new LocalDiscoveryError('FINGERPRINT_MISMATCH', 'the presented fingerprint is not the trusted one');
  if (candidate.addresses.length === 0) throw new LocalDiscoveryError('BOUNDED_SCAN_REQUIRED', 'a direct path needs at least one resolved address');
  return Object.freeze({
    path: 'LOCAL_DIRECT',
    device_id: candidate.device_id,
    trust_id: trust.trust_id ?? null,
    addresses: Object.freeze([...candidate.addresses]),
    authenticated: true,
    encrypted: true,
    freshness,
    // Metadata for the future path manager; it is not a routing decision.
    quality: Object.freeze({
      interface_kinds: Object.freeze([...candidate.interface_kinds ?? []]),
      address_count: candidate.addresses.length,
      source_rank: candidate.sources[0] ?? null,
      established_at: nowMs === null ? null : new Date(nowMs).toISOString(),
    }),
  });
}

// ---- bounded scanning and network change --------------------------------

/**
 * Plan a direct-address fallback scan. A subnet is never walked in full: the caller states its
 * target list and the plan caps it, refusing an unbounded request outright.
 */
export function planDirectScan({ targets = [], maxTargets = MAX_SCAN_TARGETS } = {}) {
  if (!Array.isArray(targets)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'targets must be an array');
  if (!Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > MAX_SCAN_TARGETS) {
    throw new LocalDiscoveryError('UNBOUNDED_SCAN_REFUSED', `maxTargets must be between 1 and ${MAX_SCAN_TARGETS}`);
  }
  const bounded = targets.slice(0, maxTargets);
  return Object.freeze({
    targets: Object.freeze([...bounded]),
    planned: bounded.length,
    refused: Math.max(0, targets.length - bounded.length),
    bounded: true,
    sweep_entire_subnet: false,
  });
}

/**
 * A local network change (subnet change, interface up/down, Wi-Fi/Ethernet switch) invalidates
 * *addresses*, never identity: candidates are re-resolved and stale addresses dropped while the
 * logical device ids stay exactly as they were.
 */
export function onNetworkChange(previousCandidates, { interfaces = [], advertisements = [], nowMs = null } = {}) {
  if (!Array.isArray(previousCandidates)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'previousCandidates must be an array');
  for (const entry of interfaces) {
    const errors = validateInterface(entry);
    if (errors.length) throw new LocalDiscoveryError('INVALID_INTERFACE', errors.slice(0, 3).join('; '));
  }
  const usableSubnets = new Set(interfaces.map(entry => entry.subnet).filter(Boolean));
  // Identity is bound to the candidate ref it was observed under, so a re-resolution can be *checked*
  // rather than asserted: a ref that changes hands between device ids is a changed logical identity.
  const identityConflicts = [];
  const refToIdentity = new Map();
  for (const candidate of previousCandidates) {
    if (!candidate.device_id || typeof candidate.candidate_ref !== 'string') continue;
    const known = refToIdentity.get(candidate.candidate_ref);
    if (known !== undefined && known !== candidate.device_id) identityConflicts.push({ candidate_ref: candidate.candidate_ref, before: known, after: candidate.device_id });
    refToIdentity.set(candidate.candidate_ref, candidate.device_id);
  }
  const retained = previousCandidates.map(candidate => {
    const onKnownSubnet = candidate.interfaces.some(entry => entry.subnet === null || usableSubnets.has(entry.subnet));
    // Reachability is address evidence, so a sighting that has aged out is not reachable: without
    // this, a long-dead peer on an unchanged subnet is announced as reachable and a direct path can
    // be opened to it, because subnet membership was the only test ever applied.
    const stillReachable = onKnownSubnet && !freshnessOf(candidate, nowMs).stale;
    const stale = freshnessOf(candidate, nowMs).stale;
    return { ...candidate, stale, reachable: stillReachable, addresses: stillReachable ? [...candidate.addresses] : [] };
  });
  const normalized = advertisements.length > 0 ? normalizeCandidates(advertisements, { nowMs }).candidates : [];
  const identitiesBefore = retained.map(candidate => candidate.device_id).filter(Boolean).sort();
  // A freshly observed sighting supersedes the retained addresses for the SAME logical device: the
  // device is who it is, but where it is reachable has changed.
  const merged = new Map(retained.map(entry => [entry.candidate_ref, entry]));
  for (const candidate of normalized) {
    const existing = merged.get(candidate.candidate_ref);
    merged.set(candidate.candidate_ref, existing
      ? {
        ...existing,
        addresses: [...candidate.addresses],
        interfaces: clone(candidate.interfaces),
        interface_kinds: candidate.interface_kinds,
        last_seen_at: candidate.last_seen_at,
        ttl_ms: candidate.ttl_ms ?? existing.ttl_ms,
        // Recomputed against this call's `nowMs`; the snapshot carried in from the previous
        // resolution is evidence about the past, not a current verdict.
        stale: freshnessOf({ ...existing, last_seen_at: candidate.last_seen_at, ttl_ms: candidate.ttl_ms ?? existing.ttl_ms }, nowMs).stale,
        sources: [...new Set([...existing.sources, ...candidate.sources])].sort((left, right) => sourceRank(left) - sourceRank(right)),
        reachable: true,
      }
      : candidate);
  }
  const candidates = [...merged.values()];
  const identitiesAfter = [...new Set(candidates.map(candidate => candidate.device_id).filter(Boolean))].sort();
  // A retained identity is preserved only if some candidate still carries it AND no candidate ref
  // was handed to a different device id.
  const lostIdentities = identitiesBefore.filter(identity => !identitiesAfter.includes(identity));
  const logicalIdentityChanged = lostIdentities.length > 0 || identityConflicts.length > 0;
  return Object.freeze({
    candidates: Object.freeze(candidates),
    reResolved: true,
    // A network change re-addresses peers; it never rewrites who they are — computed, not asserted.
    logical_identity_changed: logicalIdentityChanged,
    identities_preserved: !logicalIdentityChanged,
    lost_identities: Object.freeze(lostIdentities),
    identity_conflicts: Object.freeze(identityConflicts.map(Object.freeze)),
    retained_identities: Object.freeze(identitiesBefore),
    observed_identities: Object.freeze(identitiesAfter),
    rediscovery_required: candidates.some(candidate => !candidate.reachable),
  });
}
