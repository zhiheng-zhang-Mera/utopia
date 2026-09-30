// Bluetooth bootstrap + IP handoff (RF-004).
//
// Bluetooth is a *bootstrap* entry point: it carries a pointer to an invitation, and it never carries
// trust. Everything it learns must be re-verified over the path that will actually be used, which is why
// the handoff below requires an already-established trust record and re-checks the fingerprint on the new
// transport. A MAC address is never consulted for a decision here.
//
// Pure module: no radios, sockets, clock or ambient state.
export const BLUETOOTH_BOOTSTRAP_VERSION = 1;

export const BOOTSTRAP_ENTRY_POINT = 'DISCOVERY_BLUETOOTH';
export const BOOTSTRAP_STATES = Object.freeze(['ADVERTISED', 'RECEIVED', 'HANDED_OFF', 'EXPIRED', 'REFUSED']);
export const MAX_IP_CANDIDATES = 8;
export const MAX_SCAN_ROUNDS = 16;
export const BLUETOOTH_CODES = Object.freeze([
  'INVALID_BOOTSTRAP', 'ADAPTER_REQUIRED', 'BOOTSTRAP_EXPIRED', 'BOOTSTRAP_REPLAYED',
  'TRUST_REQUIRED_FOR_HANDOFF', 'FINGERPRINT_MISMATCH', 'NO_IP_CANDIDATE', 'UNBOUNDED_SCAN_REFUSED',
  'BLUETOOTH_IS_NOT_TRUST', 'MAC_NOT_AUTHORITY', 'UNKNOWN_BOOTSTRAP', 'HANDOFF_ALREADY_DONE',
]);

export class BluetoothBootstrapError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BluetoothBootstrapError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * A bootstrap payload must carry its fields as own properties on a bare object: reading them through
 * the prototype chain let an inherited payload be received as though it were advertised.
 */
const isBareObject = value => isPlainObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const isIsoInstantShape = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
/** Shape is not enough: an impossible instant parses to NaN, and a NaN comparison is always false. */
export const isIsoInstant = value => {
  if (!isIsoInstantShape(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
};
/**
 * A bootstrap is a pointer with a short life. Without a ceiling a payload could advertise an expiry
 * years away (or omit it entirely, which also used to be accepted) and stay valid forever.
 */
export const MAX_BOOTSTRAP_TTL_MS = 10 * 60 * 1000;

/** Build an instant, refusing an out-of-range millisecond value with a typed error. */
const instantOf = (ms, field) => {
  const value = new Date(ms);
  if (!Number.isFinite(value.getTime())) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', field + ' is out of range');
  return value.toISOString();
};
/** Exactly the fields a bootstrap payload may carry; anything else is refused. */
export const BOOTSTRAP_PAYLOAD_FIELDS = Object.freeze([
  'bootstrap_version', 'device_id', 'installation_ref', 'fingerprint', 'ip_candidates', 'nonce',
  'advertised_at', 'expires_at', 'entry_point', 'grants_trust', 'is_trust', 'mac_is_authority',
]);
export const DEVICE_ID_PATTERN = /^dev-[0-9a-f]{32}$/;
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IP_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,45}$/i;

/** Bluetooth must never be treated as sufficient for trust, and a MAC is never authority. */
export const BLUETOOTH_LIMITS = Object.freeze({
  grants_trust: false,
  is_a_trust_flow: false,
  mac_is_authority: false,
  bootstrap_only: true,
  converges_on_one_trust_protocol: true,
  max_scan_rounds: MAX_SCAN_ROUNDS,
  max_ip_candidates: MAX_IP_CANDIDATES,
});

/** The radio adapter contract: advertise, scan and exchange a small payload. */
export const BLUETOOTH_TRANSPORT_PORT = Object.freeze({
  interface: 'BluetoothBootstrapTransportPort',
  version: BLUETOOTH_BOOTSTRAP_VERSION,
  methods: Object.freeze(['describe', 'advertise', 'scan', 'exchange']),
  carries_trust: false,
  carries_bulk_data: false,
});

export function createBluetoothTransportDouble({ payload = null, advertisements = [] } = {}) {
  // Copied on the way in: holding the caller's array meant a later mutation changed what a scan returns.
  const scripted = Array.isArray(advertisements) ? structuredClone(advertisements) : [];
  const scans = [];
  return Object.freeze({
    describe: () => ({ transport: 'BLE', bootstrap_only: true, carries_trust: false, payload_bytes_bounded: true }),
    advertise: () => ({ advertised: payload !== null, payload: payload ? structuredClone(payload) : null }),
    scan: ({ round = 0, maxRounds = MAX_SCAN_ROUNDS } = {}) => {
      if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_SCAN_ROUNDS) {
        throw new BluetoothBootstrapError('UNBOUNDED_SCAN_REFUSED', `maxRounds must be between 1 and ${MAX_SCAN_ROUNDS}`);
      }
      const bounded = scripted.slice(0, maxRounds);
      scans.push({ round, emitted: bounded.length });
      return { advertisements: bounded.map(entry => structuredClone(entry)), truncated: scripted.length > bounded.length };
    },
    exchange: ({ advertisement_ref }) => ({ advertisement_ref, payload: payload ? structuredClone(payload) : null }),
    __scans: scans,
  });
}

export function createBootstrapPayload({ deviceId, fingerprint, installationRef = null, ipCandidates = [], nonce, at, ttlMs = 120_000 } = {}) {
  if (!isText(deviceId) || !DEVICE_ID_PATTERN.test(deviceId)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', `deviceId ${JSON.stringify(deviceId)} is not a dev-<32 hex> identity`);
  if (!isText(fingerprint) || !FINGERPRINT_PATTERN.test(fingerprint)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'fingerprint must be a sha256:<hex> reference');
  if (!isText(nonce)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'a single-use nonce is required');
  if (!isIsoInstant(at)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'at must be an ISO-8601 UTC instant');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'ttlMs must be a positive integer');
  if (ttlMs > MAX_BOOTSTRAP_TTL_MS) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'ttlMs must be at most ' + MAX_BOOTSTRAP_TTL_MS);
  if (!Array.isArray(ipCandidates) || ipCandidates.length > MAX_IP_CANDIDATES) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', `at most ${MAX_IP_CANDIDATES} IP candidates`);
  for (const candidate of ipCandidates) if (!isText(candidate) || !IP_PATTERN.test(candidate)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', `${JSON.stringify(candidate)} is not an address`);
  return Object.freeze({
    bootstrap_version: BLUETOOTH_BOOTSTRAP_VERSION,
    device_id: deviceId,
    installation_ref: installationRef,
    fingerprint,
    ip_candidates: Object.freeze([...ipCandidates]),
    nonce,
    advertised_at: at,
    expires_at: instantOf(Date.parse(at) + ttlMs, 'expires_at'),
    entry_point: BOOTSTRAP_ENTRY_POINT,
    // A bootstrap is a pointer to the pairing path, not a trust decision.
    grants_trust: false,
    is_trust: false,
    mac_is_authority: false,
  });
}

export function createBluetoothBootstrap({ adapter, clock = () => null } = {}) {
  if (!adapter || typeof adapter.scan !== 'function') throw new BluetoothBootstrapError('ADAPTER_REQUIRED', 'a bluetooth transport adapter is required');
  const seenNonces = new Set();
  const bootstraps = new Map();
  let counter = 0;

  const requireBootstrap = bootstrapRef => {
    const record = bootstraps.get(bootstrapRef);
    if (!record) throw new BluetoothBootstrapError('UNKNOWN_BOOTSTRAP', String(bootstrapRef));
    return record;
  };
  const nowMs = () => {
    const value = clock();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return isIsoInstant(value) ? Date.parse(value) : null;
  };

  const bootstrap = {
    limits: BLUETOOTH_LIMITS,

    /**
     * Receive a bootstrap. It yields the *entry point* the common pairing path expects — plus the
     * addresses to try next — and nothing that could be mistaken for trust.
     */
    receive(payload, { at = clock() } = {}) {
      if (!isBareObject(payload) || !isText(payload.device_id)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'a bootstrap payload must be a plain own-property object');
      // Strict shape: a transport- or caller-specific extension (including a prototype-named key) is
      // not part of a bootstrap payload, so admitting it silently is not an option.
      for (const key of Reflect.ownKeys(payload)) if (!BOOTSTRAP_PAYLOAD_FIELDS.includes(key)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'payload.' + String(key) + ' is not part of a bootstrap payload');
      if (payload.bootstrap_version !== BLUETOOTH_BOOTSTRAP_VERSION) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', `bootstrap_version ${JSON.stringify(payload.bootstrap_version)} is not supported`);
      if (!DEVICE_ID_PATTERN.test(payload.device_id) || !FINGERPRINT_PATTERN.test(payload.fingerprint)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'the payload must carry a device id and a fingerprint');
      if (payload.grants_trust === true || payload.is_trust === true) throw new BluetoothBootstrapError('BLUETOOTH_IS_NOT_TRUST', 'a bootstrap payload may not claim trust');
      // The single-use nonce is what makes a replayed advertisement useless, so it must be real.
      if (!isText(payload.nonce)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'a single-use nonce is required');
      // The payload's own expiry is caller-supplied, so it must be a real instant inside a bounded window.
      if (!isIsoInstant(payload.expires_at)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'expires_at must be an ISO-8601 UTC instant');
      if (isIsoInstant(payload.advertised_at) && Date.parse(payload.expires_at) - Date.parse(payload.advertised_at) > MAX_BOOTSTRAP_TTL_MS) {
        throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'the advertised bootstrap window is longer than ' + MAX_BOOTSTRAP_TTL_MS + 'ms');
      }
      if (!Array.isArray(payload.ip_candidates) || payload.ip_candidates.length > MAX_IP_CANDIDATES) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', `at most ${MAX_IP_CANDIDATES} IP candidates`);
      for (const candidate of payload.ip_candidates) if (!isText(candidate) || !IP_PATTERN.test(candidate)) throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', `${JSON.stringify(candidate)} is not an address`);
      // A clock that cannot be read is a refusal, not a reason to skip the expiry check.
      if (at !== null && at !== undefined && !(typeof at === 'number' && Number.isFinite(at)) && !isIsoInstant(at)) {
        throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'at must be an ISO-8601 UTC instant');
      }
      const atMs = typeof at === 'number' ? at : Date.parse(at);
      if (Number.isFinite(atMs) && Date.parse(payload.expires_at) <= atMs) {
        return { accepted: false, code: 'BOOTSTRAP_EXPIRED', detail: `bootstrap ${payload.device_id} expired at ${payload.expires_at}`, entry_point: null };
      }
      // The nonce is single-use, so an observed advertisement cannot be replayed.
      if (seenNonces.has(payload.nonce)) {
        return { accepted: false, code: 'BOOTSTRAP_REPLAYED', detail: `nonce for ${payload.device_id} was already used`, entry_point: null };
      }
      seenNonces.add(payload.nonce);
      counter += 1;
      const bootstrapRef = `bootstrap-${counter}`;
      const record = {
        bootstrap_ref: bootstrapRef,
        device_id: payload.device_id,
        installation_ref: payload.installation_ref ?? null,
        fingerprint: payload.fingerprint,
        nonce: payload.nonce,
        ip_candidates: [...payload.ip_candidates],
        expires_at: payload.expires_at,
        state: 'RECEIVED',
        received_at: isText(at) ? at : null,
        handed_off: false,
        grants_trust: false,
        is_trust: false,
        mac_is_authority: false,
      };
      bootstraps.set(bootstrapRef, record);
      return {
        accepted: true,
        code: null,
        bootstrap_ref: bootstrapRef,
        // This is what the caller feeds to the one pairing/trust state machine.
        entry_point: BOOTSTRAP_ENTRY_POINT,
        device_id: record.device_id,
        fingerprint: record.fingerprint,
        ip_candidates: [...record.ip_candidates],
        converges_on_pairing: true,
      };
    },

    /**
     * Hand off to an IP path. A bootstrap alone is never enough: an established trust record for this
     * device *and* the matching fingerprint are required, and the fingerprint is re-checked over the new
     * path before the handoff is reported as usable.
     */
    handoffToIp(bootstrapRef, { trust, verifiedFingerprint, preferredCandidate = null, at = clock() } = {}) {
      const record = requireBootstrap(bootstrapRef);
      if (record.handed_off) throw new BluetoothBootstrapError('HANDOFF_ALREADY_DONE', `${bootstrapRef} already handed off`);
      // Expiry is re-checked at handoff: the window is short, and a bootstrap received before it lapsed
      // must not become usable long after. EXPIRED was declared vocabulary that nothing ever reached.
      if (at !== null && at !== undefined && !(typeof at === 'number' && Number.isFinite(at)) && !isIsoInstant(at)) {
        throw new BluetoothBootstrapError('INVALID_BOOTSTRAP', 'at must be an ISO-8601 UTC instant');
      }
      const handoffMs = typeof at === 'number' ? at : Date.parse(at);
      if (Number.isFinite(handoffMs) && Date.parse(record.expires_at) <= handoffMs) {
        record.state = 'EXPIRED';
        throw new BluetoothBootstrapError('BOOTSTRAP_EXPIRED', `${bootstrapRef} expired at ${record.expires_at}`);
      }
      if (!isPlainObject(trust) || trust.state !== 'TRUSTED' || trust.device_id !== record.device_id) {
        throw new BluetoothBootstrapError('TRUST_REQUIRED_FOR_HANDOFF', `bluetooth bootstrap for ${record.device_id} cannot hand off without an established trust record`);
      }
      if (verifiedFingerprint !== record.fingerprint || trust.fingerprint !== verifiedFingerprint) {
        throw new BluetoothBootstrapError('FINGERPRINT_MISMATCH', 'the fingerprint re-verified over the IP path is not the trusted one');
      }
      const address = preferredCandidate ?? record.ip_candidates[0] ?? null;
      if (!isText(address) || !record.ip_candidates.includes(address)) {
        throw new BluetoothBootstrapError('NO_IP_CANDIDATE', `${bootstrapRef} has no usable IP candidate`);
      }
      record.state = 'HANDED_OFF';
      record.handed_off = true;
      return Object.freeze({
        bootstrap_ref: bootstrapRef,
        path: 'IP_DIRECT',
        address,
        device_id: record.device_id,
        trust_id: trust.trust_id ?? null,
        authenticated: true,
        encrypted: true,
        // The handoff is only usable because identity was re-verified on the new path.
        verified_over_new_path: true,
        bluetooth_carried_trust: false,
        at: isText(at) ? at : null,
      });
    },

    state(bootstrapRef) {
      const record = requireBootstrap(bootstrapRef);
      return Object.freeze({ bootstrap_ref: bootstrapRef, device_id: record.device_id, state: record.state, handed_off: record.handed_off });
    },

    /** Bounded scanning: a caller cannot ask for an unbounded radio sweep. */
    scan({ rounds = 1, maxRounds = MAX_SCAN_ROUNDS, at = clock() } = {}) {
      if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_SCAN_ROUNDS || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > maxRounds) {
        throw new BluetoothBootstrapError('UNBOUNDED_SCAN_REFUSED', `rounds must be between 1 and ${Math.min(maxRounds, MAX_SCAN_ROUNDS)}`);
      }
      const results = [];
      for (let round = 0; round < rounds; round += 1) {
        const scan = adapter.scan({ round, maxRounds });
        results.push({ round, advertisements: scan.advertisements.length, truncated: scan.truncated });
      }
      return Object.freeze({ rounds: results.length, results: Object.freeze(results.map(Object.freeze)), bounded: true, at: isText(at) ? at : null });
    },
  };

  return Object.freeze(bootstrap);
}
