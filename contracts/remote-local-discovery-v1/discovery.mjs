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
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
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
  if (!isPlainObject(entry)) return [`${path} must be an object`];
  for (const key of Object.keys(entry)) if (!['name', 'kind', 'subnet', 'address'].includes(key)) errors.push(`${path}.${key} is not part of an interface description`);
  if (!isText(entry.name)) errors.push(`${path}.name must be nonempty text`);
  if (!INTERFACE_KINDS.includes(entry.kind)) errors.push(`${path}.kind must be one of ${INTERFACE_KINDS.join(', ')}`);
  if (entry.subnet !== null && entry.subnet !== undefined && !isText(entry.subnet)) errors.push(`${path}.subnet must be text or null`);
  if (entry.address !== null && entry.address !== undefined && !isText(entry.address)) errors.push(`${path}.address must be text or null`);
  return errors;
}

/**
 * Validate an advertisement. `device_id` is required because logical identity is cryptographic:
 * a candidate with no device id can be shown to a human but is not a logical device.
 */
export function validateAdvertisement(advertisement, { requireDeviceId = false, path = 'advertisement' } = {}) {
  const errors = [];
  if (!isPlainObject(advertisement)) return { ok: false, errors: [`${path} must be an object`] };
  const allowed = ['device_id', 'installation_ref', 'display_name', 'addresses', 'interfaces', 'source', 'advertised_at', 'ttl_ms', 'mac_evidence', 'platform'];
  for (const key of Object.keys(advertisement)) if (!allowed.includes(key)) errors.push(`${path}.${key} is not part of an advertisement`);
  if (requireDeviceId) {
    if (!isText(advertisement.device_id) || !DEVICE_ID_PATTERN.test(advertisement.device_id)) errors.push(`${path}.device_id must be a Remote Fabric dev-<32 hex> identity`);
  } else if (advertisement.device_id !== null && advertisement.device_id !== undefined && !DEVICE_ID_PATTERN.test(advertisement.device_id)) {
    errors.push(`${path}.device_id must be a dev-<32 hex> identity or null`);
  }
  if (advertisement.installation_ref !== null && advertisement.installation_ref !== undefined && !isText(advertisement.installation_ref)) errors.push(`${path}.installation_ref must be text or null`);
  if (!isText(advertisement.display_name)) errors.push(`${path}.display_name must be nonempty text`);
  if (!Array.isArray(advertisement.addresses)) errors.push(`${path}.addresses must be an array`);
  else advertisement.addresses.forEach((address, index) => { if (!isText(address)) errors.push(`${path}.addresses[${index}] must be nonempty text`); });
  if (!Array.isArray(advertisement.interfaces)) errors.push(`${path}.interfaces must be an array`);
  else advertisement.interfaces.forEach((entry, index) => errors.push(...validateInterface(entry, `${path}.interfaces[${index}]`)));
  if (!DISCOVERY_SOURCES.includes(advertisement.source)) errors.push(`${path}.source must be one of ${DISCOVERY_SOURCES.join(', ')}`);
  if (!isIsoInstant(advertisement.advertised_at)) errors.push(`${path}.advertised_at must be an ISO-8601 UTC instant`);
  if (!Number.isSafeInteger(advertisement.ttl_ms) || advertisement.ttl_ms < 0) errors.push(`${path}.ttl_ms must be a non-negative integer`);
  // Metadata is never authority: a MAC may be shown, and it may never be required or trusted.
  if (advertisement.mac_evidence !== null && advertisement.mac_evidence !== undefined && !isPlainObject(advertisement.mac_evidence)) errors.push(`${path}.mac_evidence must be an object or null`);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertAdvertisement(advertisement, options) {
  const verdict = validateAdvertisement(advertisement, options);
  if (!verdict.ok) throw new LocalDiscoveryError('INVALID_CANDIDATE', verdict.errors.slice(0, 3).join('; '));
  return advertisement;
}

// ---- candidate normalization --------------------------------------------

const addressKey = advertisement => [...(advertisement.addresses ?? [])].map(address => address.toLowerCase()).sort().join('|');
const sourceRank = source => DISCOVERY_SOURCES.indexOf(source);

/**
 * Normalize advertisements into logical-device candidates.
 *
 * Two rules, both required by the workbook:
 *   - wired and Wi-Fi sightings of one device normalize to the SAME candidate, keyed by the
 *     cryptographic `device_id` when present (never by address, hostname or display name);
 *   - duplicates collapse, so repeated advertisements never create a second logical device.
 * When a device id is absent the sighting is kept as an `unidentified` candidate (human preview
 * only) rather than being merged into a device it may not be.
 */
export function normalizeCandidates(advertisements, { nowMs = null } = {}) {
  if (!Array.isArray(advertisements)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'advertisements must be an array');
  const byDevice = new Map();
  const unidentified = new Map();
  const duplicates = [];
  for (const advertisement of advertisements) {
    const verdict = validateAdvertisement(advertisement);
    if (!verdict.ok) throw new LocalDiscoveryError('INVALID_CANDIDATE', verdict.errors.slice(0, 3).join('; '));
    if (advertisement.device_id === null || advertisement.device_id === undefined) {
      const key = `${advertisement.display_name}|${addressKey(advertisement)}`;
      if (unidentified.has(key)) { duplicates.push({ reason: 'DUPLICATE_UNADDRESSED_SIGHTING', key }); continue; }
      unidentified.set(key, { candidate_ref: `unidentified:${key}`, device_id: null, identified: false, sources: [advertisement.source], display_name: advertisement.display_name, addresses: [...advertisement.addresses], interfaces: clone(advertisement.interfaces), installation_ref: advertisement.installation_ref ?? null, first_seen_at: advertisement.advertised_at, last_seen_at: advertisement.advertised_at, ttl_ms: advertisement.ttl_ms, sightings: 1, platform: advertisement.platform ?? null });
      continue;
    }
    const existing = byDevice.get(advertisement.device_id);
    if (existing) {
      // merge: union of addresses/interfaces/sources, best-ranked source, latest sighting
      const merged = new Set([...existing.addresses, ...advertisement.addresses.map(address => address.toLowerCase())]);
      const interfaceKeys = new Set([...existing.interfaces, ...advertisement.interfaces].map(entry => `${entry.kind}:${entry.name}`));
      const interfaces = [...existing.interfaces, ...advertisement.interfaces].filter((entry, index, all) => all.findIndex(candidate => `${candidate.kind}:${candidate.name}` === `${entry.kind}:${entry.name}`) === index);
      const sources = [...new Set([...existing.sources, advertisement.source])].sort((left, right) => sourceRank(left) - sourceRank(right));
      duplicates.push({ reason: 'DUPLICATE_ADVERTISEMENT', device_id: advertisement.device_id, merged_addresses: merged.size });
      byDevice.set(advertisement.device_id, {
        ...existing,
        addresses: [...merged].sort(),
        interfaces,
        sources,
        sightings: existing.sightings + 1,
        last_seen_at: advertisement.advertised_at > existing.last_seen_at ? advertisement.advertised_at : existing.last_seen_at,
        ttl_ms: Math.max(existing.ttl_ms, advertisement.ttl_ms),
        installation_ref: existing.installation_ref ?? advertisement.installation_ref ?? null,
        platform: existing.platform ?? advertisement.platform ?? null,
        interface_kinds: [...new Set(interfaces.map(entry => entry.kind))].sort(),
      });
      continue;
    }
    byDevice.set(advertisement.device_id, {
      candidate_ref: `device:${advertisement.device_id}`,
      device_id: advertisement.device_id,
      identified: true,
      display_name: advertisement.display_name,
      addresses: [...new Set(advertisement.addresses.map(address => address.toLowerCase()))].sort(),
      interfaces: clone(advertisement.interfaces),
      interface_kinds: [...new Set(advertisement.interfaces.map(entry => entry.kind))].sort(),
      sources: [advertisement.source],
      installation_ref: advertisement.installation_ref ?? null,
      first_seen_at: advertisement.advertised_at,
      last_seen_at: advertisement.advertised_at,
      ttl_ms: advertisement.ttl_ms,
      sightings: 1,
      platform: advertisement.platform ?? null,
      mac_evidence_is_authority: false,
    });
  }
  const candidates = [...byDevice.values(), ...unidentified.values()].sort((left, right) => left.candidate_ref.localeCompare(right.candidate_ref));
  const withFreshness = nowMs === null ? candidates : candidates.map(candidate => ({
    ...candidate,
    stale: Date.parse(candidate.last_seen_at) + candidate.ttl_ms <= nowMs,
  }));
  return Object.freeze({
    candidates: Object.freeze(withFreshness),
    duplicates: Object.freeze(duplicates.map(Object.freeze)),
    unidentified_count: unidentified.size,
  });
}

/** Drop stale sightings. Logical identity does not change when an advertisement ages out. */
export function pruneStale(candidates, nowMs) {
  if (!Array.isArray(candidates)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'candidates must be an array');
  const fresh = [];
  const stale = [];
  for (const candidate of candidates) {
    if (Date.parse(candidate.last_seen_at) + candidate.ttl_ms <= nowMs) stale.push(candidate.device_id ?? candidate.candidate_ref);
    else fresh.push(candidate);
  }
  return Object.freeze({ candidates: Object.freeze(fresh), stale: Object.freeze(stale.sort()) });
}

// ---- resolution into the common pairing path -----------------------------

/**
 * Resolve a candidate into the *common* pairing entry, never a LAN-specific trust flow. The result
 * is an entry point plus hints; trust is established by the one pairing state machine (RF-002).
 */
export function resolveToPairing(candidate, { preferDirect = false } = {}) {
  if (!isPlainObject(candidate)) throw new LocalDiscoveryError('INVALID_CANDIDATE', 'a candidate is required');
  if (!candidate.identified) return Object.freeze({ resolved: false, code: 'DEVICE_ID_REQUIRED', detail: 'an unidentified sighting can be shown to a human but cannot start a pairing', entry_point: null });
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
  const retained = previousCandidates.map(candidate => {
    const stillReachable = candidate.interfaces.some(entry => entry.subnet === null || usableSubnets.has(entry.subnet));
    return { ...candidate, reachable: stillReachable, addresses: stillReachable ? [...candidate.addresses] : [] };
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
        sources: [...new Set([...existing.sources, ...candidate.sources])].sort((left, right) => sourceRank(left) - sourceRank(right)),
        reachable: true,
      }
      : candidate);
  }
  const candidates = [...merged.values()];
  const identitiesAfter = [...new Set(candidates.map(candidate => candidate.device_id).filter(Boolean))].sort();
  return Object.freeze({
    candidates: Object.freeze(candidates),
    reResolved: true,
    // A network change re-addresses peers; it never rewrites who they are.
    logical_identity_changed: false,
    identities_preserved: identitiesBefore.every(identity => identitiesAfter.includes(identity)),
    retained_identities: Object.freeze(identitiesBefore),
    observed_identities: Object.freeze(identitiesAfter),
    rediscovery_required: candidates.some(candidate => !candidate.reachable),
  });
}
