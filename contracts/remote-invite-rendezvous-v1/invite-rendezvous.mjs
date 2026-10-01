// Remote invite / meeting code / deep-link rendezvous (RF-005).
//
// One versioned rendezvous object, four inert representations of it (short human code, `digitalcity://`
// deep link, HTTPS web link, QR-safe payload). The representations are *locators*: they carry a
// high-entropy rendezvous reference and nothing else. None of them is authentication, capability
// authorization or a trust record, and copying one creates no trust.
//
// Every successful rendezvous converges on the one RF-002 pairing protocol: a guest only ever reaches a
// pairing preview, the host identity is disclosed only after an explicit host confirmation, and the invite
// is not a data path — after trust the invite can no longer reconnect anything.
//
// Failures are generic on purpose: an unknown, expired, cancelled and already-used locator are
// indistinguishable to a caller, so guessing cannot reveal whether a device exists. Guessing is also
// rate-limited, and rate limiting never leaks existence either.
//
// Pure module: entropy and the clock are injected; no network, storage or ambient state.
export const INVITE_RENDEZVOUS_CONTRACT_VERSION = 1;

export const INVITE_STATES = Object.freeze(['ACTIVE', 'USED', 'EXPIRED', 'CANCELLED']);
export const TICKET_STATES = Object.freeze(['AWAITING_CONFIRMATION', 'ACCEPTED', 'REJECTED', 'EXPIRED']);
export const LOCATOR_KINDS = Object.freeze(['CODE', 'DEEP_LINK', 'WEB_LINK']);
export const PAIRING_ENTRY_POINT = 'DISCOVERY_REMOTE_INVITE';
export const DEEP_LINK_SCHEME = 'digitalcity://join';
export const WEB_LINK_BASE = 'https://digitalcity.local/join/';

/** Crockford base32: no I, L, O or U, so a typed code cannot be misread. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_PAYLOAD_LENGTH = 8;

export const INVITE_CODES = Object.freeze([
  'INVALID_INVITE', 'ENTROPY_REQUIRED', 'INVALID_LOCATOR', 'INVALID_TICKET', 'UNKNOWN_TICKET',
  'NOT_THE_HOST', 'MULTI_USE_NOT_PERMITTED', 'CONFIRMATION_REQUIRED', 'ALREADY_CONFIRMED',
  'RENDEZVOUS_IS_NOT_RECONNECT_AUTHORITY', 'RENDEZVOUS_IS_NOT_A_CAPABILITY_PATH',
  // Deliberately one generic failure for every lookup outcome.
  'RENDEZVOUS_UNAVAILABLE', 'RATE_LIMITED',
]);

export class InviteError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'InviteError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'RENDEZVOUS_UNAVAILABLE' ? 404 : code === 'RATE_LIMITED' ? 429 : code === 'NOT_THE_HOST' ? 403 : 400;
    if (code === 'RENDEZVOUS_UNAVAILABLE') this.generic = true;
    Object.assign(this, extra);
  }
}

/** The single failure every unusable locator produces. Identical for unknown, expired, used, cancelled. */
export function rendezvousUnavailable() {
  return new InviteError('RENDEZVOUS_UNAVAILABLE', 'no usable rendezvous for that locator');
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
const isIsoInstantShape = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
/** Shape is not enough: an impossible instant parses to NaN, and a NaN comparison is always false. */
export const isIsoInstant = value => {
  if (!isIsoInstantShape(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
};
/**
 * A rendezvous window is short by nature. Policy may shorten it, never make a locator eternal: an
 * unvalidated max_ttl_ms accepted MAX_SAFE_INTEGER and minted a rendezvous good for centuries.
 */
export const MAX_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_RATE_LIMIT_ATTEMPTS = 1000;

/** Input tolerance for humans: case, spaces and separators are ignored, I/L look like 1 and O like 0. */
export function normalizeCodeInput(input) {
  if (!isText(input)) return null;
  const stripped = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return stripped.replace(/[IL]/g, '1').replace(/O/g, '0');
}

export function codeChecksum(payload) {
  let sum = 0;
  for (const character of payload) sum = (sum + CODE_ALPHABET.indexOf(character)) % CODE_ALPHABET.length;
  return CODE_ALPHABET[sum];
}

export function encodeRendezvousCode(hex) {
  let value = BigInt(`0x${hex}`);
  let payload = '';
  for (let index = 0; index < CODE_PAYLOAD_LENGTH; index += 1) {
    payload = CODE_ALPHABET[Number(value & 31n)] + payload;
    value >>= 5n;
  }
  return Object.freeze({
    payload,
    code: `${payload.slice(0, 4)}-${payload.slice(4, 8)}-${codeChecksum(payload)}`,
  });
}

/** Local, lookup-free validation: a caller learns whether their own input is well formed, nothing else. */
export function parseLocator(input) {
  if (!isText(input)) return freeze({ kind: null, code: null, format_valid: false, reason: 'EMPTY' });
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith(DEEP_LINK_SCHEME)) return locateFromUrl(trimmed, 'DEEP_LINK');
  if (/^https:\/\//i.test(trimmed)) return locateFromUrl(trimmed, 'WEB_LINK');
  const normalized = normalizeCodeInput(trimmed);
  if (normalized === null || normalized.length !== CODE_PAYLOAD_LENGTH + 1) {
    return freeze({ kind: 'CODE', code: null, format_valid: false, reason: 'BAD_LENGTH' });
  }
  const payload = normalized.slice(0, CODE_PAYLOAD_LENGTH);
  const check = normalized.slice(CODE_PAYLOAD_LENGTH);
  if ([...payload].some(character => !CODE_ALPHABET.includes(character))) {
    return freeze({ kind: 'CODE', code: null, format_valid: false, reason: 'BAD_ALPHABET' });
  }
  if (check !== codeChecksum(payload)) return freeze({ kind: 'CODE', code: null, format_valid: false, reason: 'BAD_CHECKSUM' });
  return freeze({ kind: 'CODE', code: `${payload.slice(0, 4)}-${payload.slice(4, 8)}-${check}`, format_valid: true, reason: null });
}

function locateFromUrl(url, kind) {
  const query = url.match(/[?&]c=([^&/#]+)/i);
  const path = url.match(/\/join\/([^?&#/]+)/i);
  // A hostile link with a malformed escape used to escape as an untyped URIError from
  // decodeURIComponent; parsing is local validation and must always return a verdict.
  let candidate = '';
  try {
    candidate = query ? decodeURIComponent(query[1]) : path ? decodeURIComponent(path[1]) : '';
  } catch {
    return freeze({ kind, code: null, format_valid: false, reason: 'BAD_LINK' });
  }
  const parsed = parseLocator(candidate);
  if (!parsed.format_valid || parsed.kind !== 'CODE') {
    return freeze({ kind, code: null, format_valid: false, reason: 'BAD_LINK' });
  }
  return freeze({ kind, code: parsed.code, format_valid: true, reason: null });
}

export function createInviteRendezvous({
  entropy,
  clock = () => new Date().toISOString(),
  policy = {},
} = {}) {
  if (typeof entropy !== 'function') throw new InviteError('ENTROPY_REQUIRED', 'an entropy source is required; this module must not invent its own randomness');
  if (typeof clock !== 'function') throw new InviteError('INVALID_INVITE', 'clock must be a function returning an ISO-8601 UTC instant');
  const config = {
    allow_multi_use: false,
    default_ttl_ms: 600000,
    max_ttl_ms: 3600000,
    max_uses_cap: 8,
    rate_limit: { max_attempts: 5, window_ms: 60000 },
    ...(isPlainObject(policy) ? policy : {}),
  };
  const rateLimit = { max_attempts: 5, window_ms: 60000, ...(isPlainObject(config.rate_limit) ? config.rate_limit : {}) };
  // Policy is configured authority, so its values still have to be real and bounded.
  const policyProblems = [];
  if (!Number.isSafeInteger(config.default_ttl_ms) || config.default_ttl_ms <= 0) policyProblems.push('default_ttl_ms');
  if (!Number.isSafeInteger(config.max_ttl_ms) || config.max_ttl_ms <= 0 || config.max_ttl_ms > MAX_INVITE_TTL_MS) policyProblems.push('max_ttl_ms');
  if (Number.isSafeInteger(config.default_ttl_ms) && Number.isSafeInteger(config.max_ttl_ms) && config.default_ttl_ms > config.max_ttl_ms) policyProblems.push('default_ttl_ms > max_ttl_ms');
  if (!Number.isSafeInteger(config.max_uses_cap) || config.max_uses_cap < 1) policyProblems.push('max_uses_cap');
  if (!Number.isSafeInteger(rateLimit.max_attempts) || rateLimit.max_attempts < 1 || rateLimit.max_attempts > MAX_RATE_LIMIT_ATTEMPTS) policyProblems.push('rate_limit.max_attempts');
  if (!Number.isSafeInteger(rateLimit.window_ms) || rateLimit.window_ms < 1) policyProblems.push('rate_limit.window_ms');
  if (typeof config.allow_multi_use !== 'boolean') policyProblems.push('allow_multi_use');
  if (policyProblems.length > 0) throw new InviteError('INVALID_INVITE', 'policy values are not usable: ' + policyProblems.join(', '));
  const ANONYMOUS_CLIENT = 'anonymous';
  const invites = new Map();
  const byCode = new Map();
  const tickets = new Map();
  const attempts = new Map();
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new InviteError('INVALID_INVITE', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const randomHex = (bytes, purpose) => {
    const produced = entropy(bytes);
    if (typeof produced !== 'string' || produced.length < bytes * 2 || !/^[0-9a-f]+$/i.test(produced)) {
      throw new InviteError('ENTROPY_REQUIRED', `the entropy source returned unusable material for ${purpose}`);
    }
    return produced.slice(0, bytes * 2).toLowerCase();
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const stateOf = (invite, at) => {
    if (invite.state === 'CANCELLED' || invite.state === 'USED') return invite.state;
    if (Date.parse(invite.expires_at) <= Date.parse(at)) return 'EXPIRED';
    return invite.state === 'ACTIVE' ? 'ACTIVE' : invite.state;
  };

  const usable = (invite, at) => {
    const state = stateOf(invite, at);
    if (state !== 'ACTIVE') return false;
    if (invite.uses >= invite.max_uses) return false;
    return true;
  };

  /** Every path validates the instant it is given: an unparseable one used to disable expiry entirely. */
  const requireInstant = (value, field) => {
    if (!isIsoInstant(value)) throw new InviteError('INVALID_INVITE', `${field} must be an ISO-8601 UTC instant`);
    return value;
  };

  const throttle = (client_ref, at) => {
    const timestamps = (attempts.get(client_ref) ?? []).filter(stamp => Date.parse(at) - Date.parse(stamp) < rateLimit.window_ms);
    if (timestamps.length >= rateLimit.max_attempts) {
      const oldest = Date.parse(timestamps[0]);
      const retryAfter = Math.max(0, rateLimit.window_ms - (Date.parse(at) - oldest));
      attempts.set(client_ref, timestamps);
      note('RATE_LIMITED', at, { client_ref });
      // An unnamed caller shares one bucket so enumeration is throttled even without a client_ref; its
      // over-limit answer stays the generic failure, so throttling reveals nothing about existence.
      if (client_ref === ANONYMOUS_CLIENT) throw rendezvousUnavailable();
      throw new InviteError('RATE_LIMITED', 'too many rendezvous attempts', { retry_after_ms: retryAfter, window_ms: rateLimit.window_ms });
    }
    timestamps.push(at);
    attempts.set(client_ref, timestamps);
    return true;
  };

  const representationsFor = invite => freeze({
    contract_version: INVITE_RENDEZVOUS_CONTRACT_VERSION,
    invite_id: invite.invite_id,
    rendezvous_ref: invite.rendezvous_ref,
    code: invite.code,
    deep_link: `${DEEP_LINK_SCHEME}?c=${invite.code}&v=${INVITE_RENDEZVOUS_CONTRACT_VERSION}`,
    web_link: `${WEB_LINK_BASE}${invite.code}`,
    qr_payload: `${DEEP_LINK_SCHEME}?c=${invite.code}&v=${INVITE_RENDEZVOUS_CONTRACT_VERSION}&src=qr`,
    separate_trust_records: 0,
    creates_trust: false,
    grants_permission: false,
    is_authentication: false,
    carries_private_key: false,
    carries_bearer_token: false,
    locator_only: true,
    expires_at: invite.expires_at,
  });

  const project = (invite, at) => freeze({
    contract_version: INVITE_RENDEZVOUS_CONTRACT_VERSION,
    invite_id: invite.invite_id,
    rendezvous_ref: invite.rendezvous_ref,
    host_device_ref: invite.host_device_ref,
    state: stateOf(invite, at),
    code: invite.code,
    max_uses: invite.max_uses,
    uses: invite.uses,
    multi_use: invite.max_uses > 1,
    created_at: invite.created_at,
    expires_at: invite.expires_at,
    representations: representationsFor(invite),
    path_independent: true,
    relay_coupled: false,
    reconnect_authority: false,
  });

  const api = {
    policy: () => freeze(clone(config)),

    createInvite({ host_device_ref, ttl_ms, max_uses = 1, allow_multi_use = false, at: when } = {}) {
      if (!isText(host_device_ref)) throw new InviteError('INVALID_INVITE', 'host_device_ref is required');
      const ttl = ttl_ms ?? config.default_ttl_ms;
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > config.max_ttl_ms) {
        throw new InviteError('INVALID_INVITE', `ttl_ms must be a positive integer up to ${config.max_ttl_ms}`);
      }
      if (!Number.isSafeInteger(max_uses) || max_uses < 1 || max_uses > config.max_uses_cap) {
        throw new InviteError('INVALID_INVITE', `max_uses must be between 1 and ${config.max_uses_cap}`);
      }
      if (max_uses > 1 && !(allow_multi_use === true && config.allow_multi_use === true)) {
        throw new InviteError('MULTI_USE_NOT_PERMITTED', 'a multi-use invite requires an explicit policy that permits it');
      }
      const created_at = when ?? now();
      if (!isIsoInstant(created_at)) throw new InviteError('INVALID_INVITE', 'at must be an ISO-8601 UTC instant');
      const rendezvous_ref = randomHex(16, 'rendezvous_ref');
      const code_source = randomHex(5, 'code');
      let attempt = 0;
      let encoded = encodeRendezvousCode(code_source);
      while (byCode.has(encoded.code) && attempt < 8) {
        encoded = encodeRendezvousCode(randomHex(5, 'code'));
        attempt += 1;
      }
      if (byCode.has(encoded.code)) throw new InviteError('INVALID_INVITE', 'could not mint a unique rendezvous code');
      const invite = {
        contract_version: INVITE_RENDEZVOUS_CONTRACT_VERSION,
        invite_id: `invite:${rendezvous_ref.slice(0, 16)}`,
        rendezvous_ref: `rendezvous:${rendezvous_ref}`,
        code: encoded.code,
        code_payload: encoded.payload,
        host_device_ref,
        state: 'ACTIVE',
        uses: 0,
        max_uses,
        created_at,
        expires_at: (() => {
          const expiresMs = Date.parse(created_at) + ttl;
          const produced = new Date(expiresMs);
          if (!Number.isFinite(produced.getTime())) throw new InviteError('INVALID_INVITE', 'expires_at is out of range');
          return produced.toISOString();
        })(),
        cancelled_at: null,
      };
      invites.set(invite.invite_id, invite);
      byCode.set(invite.code, invite.invite_id);
      note('INVITE_CREATED', created_at, { invite_id: invite.invite_id, max_uses });
      return project(invite, created_at);
    },

    getInvite(invite_id) {
      const invite = invites.get(invite_id);
      return invite ? project(invite, now()) : null;
    },

    /** All four representations of the same rendezvous. Copying one creates nothing. */
    representationsFor({ invite_id, at: when } = {}) {
      const invite = invites.get(invite_id);
      if (!invite) throw rendezvousUnavailable();
      return representationsFor(invite);
    },

    parseLocator,

    /**
     * The pre-pairing preview. It reaches the common pairing entry point and discloses no host identity,
     * so entering or clicking a locator cannot become a capability grant.
     */
    preview({ locator, client_ref, at: when } = {}) {
      const at = requireInstant(when ?? now(), 'at');
      // Rate limiting is not opt-in: omitting client_ref used to skip the limiter entirely, so an
      // enumerating caller simply left it out. An unnamed caller shares one anonymous bucket.
      throttle(isText(client_ref) ? client_ref : ANONYMOUS_CLIENT, at);
      const parsed = parseLocator(locator);
      if (!parsed.format_valid) throw rendezvousUnavailable();
      const invite = invites.get(byCode.get(parsed.code) ?? '');
      if (!invite || !usable(invite, at)) throw rendezvousUnavailable();
      note('PREVIEWED', at, { invite_id: invite.invite_id });
      return freeze({
        contract_version: INVITE_RENDEZVOUS_CONTRACT_VERSION,
        available: true,
        pairing_entry_point: PAIRING_ENTRY_POINT,
        converges_on_pairing: true,
        requires_confirmation: true,
        grants_trust: false,
        grants_permission: false,
        host_identity_disclosed: false,
        host_device_ref: null,
        capabilities_invocable: false,
        locator_kind: parsed.kind,
      });
    },

    /** Redeem the locator into a ticket that is explicitly waiting for the host's own confirmation. */
    redeem({ locator, client_ref, guest_device_ref, at: when } = {}) {
      const at = requireInstant(when ?? now(), 'at');
      if (!isText(guest_device_ref)) throw new InviteError('INVALID_TICKET', 'guest_device_ref is required');
      throttle(isText(client_ref) ? client_ref : ANONYMOUS_CLIENT, at);
      const parsed = parseLocator(locator);
      if (!parsed.format_valid) throw rendezvousUnavailable();
      const invite = invites.get(byCode.get(parsed.code) ?? '');
      if (!invite || !usable(invite, at)) throw rendezvousUnavailable();
      counter += 1;
      const ticket = {
        ticket_ref: `ticket:${invite.rendezvous_ref.slice('rendezvous:'.length, 'rendezvous:'.length + 8)}:${counter}`,
        invite_id: invite.invite_id,
        guest_device_ref,
        state: 'AWAITING_CONFIRMATION',
        created_at: at,
        use_consumed: false,
      };
      tickets.set(ticket.ticket_ref, ticket);
      note('REDEEMED', at, { invite_id: invite.invite_id, ticket_ref: ticket.ticket_ref });
      return freeze({
        contract_version: INVITE_RENDEZVOUS_CONTRACT_VERSION,
        ...clone(ticket),
        trust_established: false,
        capabilities_invocable: false,
        host_identity_disclosed: false,
        host_device_ref: null,
        pairing_entry_point: PAIRING_ENTRY_POINT,
        rendezvous_ref: invite.rendezvous_ref,
      });
    },

    /**
     * Host confirmation. Only this establishes anything, and only accepted confirmations consume a use:
     * a declined request leaves the invite usable rather than silently burning it.
     */
    confirm({ ticket_ref, host_device_ref, accepted = false, at: when } = {}) {
      const at = requireInstant(when ?? now(), 'at');
      const ticket = tickets.get(ticket_ref);
      if (!ticket) throw new InviteError('UNKNOWN_TICKET', `no rendezvous ticket ${String(ticket_ref)}`);
      if (ticket.state !== 'AWAITING_CONFIRMATION') throw new InviteError('ALREADY_CONFIRMED', `ticket ${ticket_ref} is ${ticket.state}`);
      const invite = invites.get(ticket.invite_id);
      if (!invite) throw rendezvousUnavailable();
      if (host_device_ref !== invite.host_device_ref) {
        note('CONFIRMATION_REFUSED_NOT_HOST', at, { invite_id: invite.invite_id });
        throw new InviteError('NOT_THE_HOST', 'only the inviting device may confirm this rendezvous');
      }
      if (!usable(invite, at)) {
        ticket.state = 'EXPIRED';
        throw rendezvousUnavailable();
      }
      if (accepted !== true) {
        ticket.state = 'REJECTED';
        note('CONFIRMATION_DECLINED', at, { invite_id: invite.invite_id, ticket_ref });
        return freeze({
          contract_version: INVITE_RENDEZVOUS_CONTRACT_VERSION,
          ticket_ref,
          ticket_state: 'REJECTED',
          trust_established: false,
          use_consumed: false,
          invite_state: stateOf(invite, at),
          capabilities_invocable: false,
          host_identity_disclosed: false,
        });
      }
      ticket.state = 'ACCEPTED';
      ticket.use_consumed = true;
      invite.uses += 1;
      if (invite.uses >= invite.max_uses) invite.state = 'USED';
      note('TRUST_ESTABLISHED', at, { invite_id: invite.invite_id, ticket_ref, uses: invite.uses });
      return freeze({
        contract_version: INVITE_RENDEZVOUS_CONTRACT_VERSION,
        ticket_ref,
        ticket_state: 'ACCEPTED',
        trust_established: true,
        use_consumed: true,
        uses: invite.uses,
        max_uses: invite.max_uses,
        invite_state: stateOf(invite, at),
        host_identity_disclosed: true,
        host_device_ref: invite.host_device_ref,
        granted_permission: false,
        on_the_rendezvous_service: false,
        pairing_handoff: freeze({
          entry_point: PAIRING_ENTRY_POINT,
          converges_on_pairing: true,
          host_device_ref: invite.host_device_ref,
          guest_device_ref: ticket.guest_device_ref,
          rendezvous_ref: invite.rendezvous_ref,
          pairwise_key_exchange: 'RF-002',
          capabilities_invocable: false,
          path_negotiation: 'RF-006',
        }),
      });
    },

    /** Cancellation before expiry. Only the host may cancel. */
    revoke({ invite_id, host_device_ref, at: when } = {}) {
      const at = requireInstant(when ?? now(), 'at');
      const invite = invites.get(invite_id);
      if (!invite) throw rendezvousUnavailable();
      if (host_device_ref !== invite.host_device_ref) throw new InviteError('NOT_THE_HOST', 'only the inviting device may cancel this rendezvous');
      // A consumed or already-cancelled rendezvous is terminal: revoking a USED invite used to rewrite
      // its recorded outcome to CANCELLED.
      if (stateOf(invite, at) !== 'ACTIVE') throw rendezvousUnavailable();
      invite.state = 'CANCELLED';
      invite.cancelled_at = at;
      note('REVOKED', at, { invite_id });
      return project(invite, at);
    },

    /**
     * The rendezvous is a bootstrap, not a session: after trust it proves nothing about the device, and
     * capabilities are invoked over the Fabric, never through an invite.
     */
    reconnectViaInvite() {
      throw new InviteError('RENDEZVOUS_IS_NOT_RECONNECT_AUTHORITY', 'an invite is a one-time rendezvous locator; reconnect requires current Fabric trust state');
    },

    invokeCapability({ ticket_ref, capability } = {}) {
      const ticket = tickets.get(ticket_ref);
      if (!ticket) throw new InviteError('UNKNOWN_TICKET', `no rendezvous ticket ${String(ticket_ref)}`);
      if (ticket.state !== 'ACCEPTED') {
        throw new InviteError('CONFIRMATION_REQUIRED', `ticket ${ticket_ref} is ${ticket.state}; nothing may be invoked before the host confirms`, { capability: capability ?? null, capabilities_invocable: false });
      }
      throw new InviteError('RENDEZVOUS_IS_NOT_A_CAPABILITY_PATH', 'capabilities are invoked over Fabric addressing, not through a rendezvous ticket', { capability: capability ?? null });
    },

    tickets: () => clone([...tickets.values()]).map(entry => freeze(entry)),
    invites: () => clone([...invites.values()]),
    journal: () => clone(journal),
  };
  return api;
}
