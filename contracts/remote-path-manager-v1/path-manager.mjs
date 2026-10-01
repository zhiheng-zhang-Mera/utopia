// Secure transport path manager + relay fallback (RF-006).
//
// One replaceable connectivity layer. Callers use `connect` / `send` / `close` and never learn whether the
// bytes travelled over a LAN socket, a NAT-traversed pair, a public address or a relay: transport specifics
// live behind the injected `TransportAdapterPort`, so swapping adapters changes no caller code.
//
// Paths are chosen in a fixed preference order â€?local direct, Internet direct, NAT traversal, relay â€?and a
// path is adopted only if it is BOTH authenticated and encrypted. LAN is held to exactly the same
// requirement, so an unauthenticated neighbour cannot be adopted just because it is nearby. Relay is a
// forwarder of opaque end-to-end protected payloads: it can never authorize a peer, never sees plaintext and
// never becomes a permanent mandated route while a direct path is usable.
//
// Session truth is logical, not path-derived: migrating to another path keeps the same `session_ref` and the
// same logical `device_id`, replays no command, and never leaves two authoritative sessions for one
// exclusive action. Path quality is reported, and grants nothing.
//
// Pure module: adapters and the clock are injected; no sockets, no ambient state.
export const PATH_MANAGER_CONTRACT_VERSION = 1;

export const TRANSPORT_CLASSES = Object.freeze(['LAN_DIRECT', 'INTERNET_DIRECT', 'NAT_TRAVERSAL', 'RELAY']);
/** Preference semantics are part of the contract, not an implementation detail. */
export const PATH_PREFERENCE = Object.freeze(['LAN_DIRECT', 'INTERNET_DIRECT', 'NAT_TRAVERSAL', 'RELAY']);
export const DIRECT_CLASSES = Object.freeze(['LAN_DIRECT', 'INTERNET_DIRECT', 'NAT_TRAVERSAL']);
export const RELAY_MODE = 'OPAQUE_FORWARD';

export const TRANSPORT_ADAPTER_PORT = Object.freeze({
  interface: 'TransportAdapterPort',
  version: 1,
  methods: Object.freeze(['probe', 'connect', 'send', 'close']),
  carries_business_semantics: false,
});

export const SELECTION_REASONS = Object.freeze([
  'PREFERRED_DIRECT', 'DIRECT_AFTER_FAILURE', 'RELAY_FALLBACK', 'MIGRATED', 'REUSED_SESSION',
]);

export const PATH_CODES = Object.freeze([
  'INVALID_PEER', 'INVALID_ADAPTER', 'INVALID_CLOCK', 'INVALID_REQUEST', 'TRUST_REQUIRED',
  'UNAUTHENTICATED_PATH_REFUSED', 'PLAINTEXT_PATH_REFUSED', 'NO_USABLE_PATH', 'UNKNOWN_SESSION',
  'SESSION_ALREADY_ACTIVE', 'RELAY_CANNOT_AUTHORIZE', 'PAYLOAD_MUST_BE_PROTECTED', 'DUPLICATE_COMMAND',
  'ACTION_KEY_REQUIRED', 'UNKNOWN_PATH', 'MIGRATION_RACE_LOST',
]);

const CONFLICT_CODES = new Set(['NO_USABLE_PATH', 'SESSION_ALREADY_ACTIVE', 'DUPLICATE_COMMAND', 'MIGRATION_RACE_LOST', 'TRUST_REQUIRED']);

export class PathManagerError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PathManagerError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_SESSION' || code === 'UNKNOWN_PATH' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
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

const SECRET_KEY_SHAPE = /(secret|token|password|api_?key|private_?key|session_key|key_material|^key$)/i;

/** Recursive scan used to prove path metadata stays bounded and secret-free. */
export function findSecretFields(value, path = 'record', found = [], seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return found;
    seen.add(value);
    value.forEach((item, index) => findSecretFields(item, `${path}[${index}]`, found, seen));
    return found;
  }
  if (!isPlainObject(value)) return found;
  if (seen.has(value)) return found;
  seen.add(value);
  // Own keys of any enumerability: a non-enumerable own session_key was invisible to the scan. The walk
  // covers caller data, so it is cycle-safe rather than a stack overflow.
  for (const key of Reflect.ownKeys(value)) {
    const child = value[key];
    const childPath = `${path}.${String(key)}`;
    if (typeof key === 'string' && SECRET_KEY_SHAPE.test(key) && !/_ref$/.test(key)) found.push(childPath);
    findSecretFields(child, childPath, found, seen);
  }
  return found;
}

export const DEFAULT_PATH_POLICY = Object.freeze({
  policy_ref: 'policy:rf-path-default',
  preference: PATH_PREFERENCE,
  allow_relay: true,
  relay_requires_direct_failure: true,
  require_authenticated_encryption: true,
  max_probe_ms: 2000,
});

export function createPathManager({ adapters = {}, clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (!isPlainObject(adapters)) throw new PathManagerError('INVALID_ADAPTER', 'adapters must be a map keyed by transport class');
  if (typeof clock !== 'function') throw new PathManagerError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const config = { ...DEFAULT_PATH_POLICY, ...(isPlainObject(policy) ? policy : {}) };
  if (!Array.isArray(config.preference) || config.preference.length === 0) throw new PathManagerError('INVALID_ADAPTER', 'the preference list must be a non-empty array');
  // A repeated class would probe and connect the same transport once per entry.
  if (new Set(config.preference).size !== config.preference.length) throw new PathManagerError('INVALID_ADAPTER', 'the preference list must not repeat a transport class');
  // A probe budget is a positive, bounded number of milliseconds.
  if (!Number.isSafeInteger(config.max_probe_ms) || config.max_probe_ms < 1 || config.max_probe_ms > 60000) {
    throw new PathManagerError('INVALID_ADAPTER', 'max_probe_ms must be an integer between 1 and 60000');
  }
  for (const transport_class of config.preference) {
    if (!TRANSPORT_CLASSES.includes(transport_class)) throw new PathManagerError('INVALID_ADAPTER', `unknown transport class ${transport_class} in the preference list`);
  }
  // "Paths are chosen in a fixed preference order" is stated in the header and the workbook asks that
  // selection "prefers usable direct routes and falls back to relay honestly". A policy could reorder the
  // list so RELAY came first and was adopted while a direct path was available, so the list must be a
  // subsequence of the canonical order: a policy may drop classes, never promote a worse one.
  let cursor = 0;
  for (const transport_class of config.preference) {
    const index = PATH_PREFERENCE.indexOf(transport_class);
    if (index < cursor) throw new PathManagerError('INVALID_ADAPTER', 'the preference list may only narrow the canonical order ' + PATH_PREFERENCE.join(' > '));
    cursor = index + 1;
  }

  const sessions = new Map();
  const sessionsByPeer = new Map();
  const paths = new Map();
  const audit = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new PathManagerError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  /** A caller-supplied instant is validated wherever it enters: any path used to accept any string. */
  const requireInstant = (value, field) => {
    if (!isIsoInstant(value)) throw new PathManagerError('INVALID_REQUEST', `${field} must be an ISO-8601 UTC instant`);
    return value;
  };

  const note = (event, at, detail = {}) => {
    audit.push(freeze({ event, at, ...detail }));
    return audit.length - 1;
  };

  const requireTrust = trust => {
    if (!isPlainObject(trust) || trust.trust_state !== 'TRUSTED' || !isText(trust.device_id)) {
      throw new PathManagerError('TRUST_REQUIRED', 'a path may only be opened to a peer whose RF-002 trust state is TRUSTED');
    }
    // A peer/trust record is a reference set, not a place for credentials: they are forwarded verbatim to
    // the adapter, so secret-shaped fields must not travel with them.
    const leaked = findSecretFields(trust, 'trust');
    if (leaked.length > 0) throw new PathManagerError('TRUST_REQUIRED', 'a trust record may not carry secret material: ' + leaked.join(', '));
    return trust;
  };

  const adapterFor = transport_class => {
    const adapter = adapters[transport_class];
    if (!isPlainObject(adapter) || typeof adapter.connect !== 'function') return null;
    return adapter;
  };

  /** Probe candidates in preference order. A probe failure or an unusable class is recorded, not fatal. */
  const candidates = ({ peer, trust, at }) => {
    const considered = [];
    for (const transport_class of config.preference) {
      const adapter = adapterFor(transport_class);
      if (adapter === null) { considered.push({ transport_class, available: false, reason: 'NO_ADAPTER' }); continue; }
      if (transport_class === 'RELAY' && config.allow_relay !== true) { considered.push({ transport_class, available: false, reason: 'RELAY_DISABLED_BY_POLICY' }); continue; }
      let probe = null;
      try {
        probe = adapter.probe({ peer, trust, at, timeout_ms: config.max_probe_ms });
      } catch (error) {
        considered.push({ transport_class, available: false, reason: 'PROBE_FAILED', detail: String(error?.message ?? error) });
        continue;
      }
      const available = probe === true || probe?.available === true;
      considered.push({
        transport_class,
        available,
        reason: available ? 'AVAILABLE' : isText(probe?.reason) ? probe.reason : 'NOT_AVAILABLE',
        latency_ms: Number.isFinite(probe?.latency_ms) ? probe.latency_ms : null,
      });
    }
    return freeze(considered);
  };

  const pathDescriptor = path => freeze({
    contract_version: PATH_MANAGER_CONTRACT_VERSION,
    path_ref: path.path_ref,
    transport_class: path.transport_class,
    direct: DIRECT_CLASSES.includes(path.transport_class),
    relay: path.transport_class === 'RELAY',
    relay_mode: path.transport_class === 'RELAY' ? RELAY_MODE : null,
    relay_plaintext_access: false,
    authenticated: path.authenticated === true,
    encrypted: path.encrypted === true,
    latency_ms: path.latency_ms,
    quality: path.quality,
    opened_at: path.opened_at,
    path_quality_grants_permission: false,
    identifies_device: false,
  });

  const sessionDescriptor = session => freeze({
    contract_version: PATH_MANAGER_CONTRACT_VERSION,
    session_ref: session.session_ref,
    device_id: session.device_id,
    installation_id: session.installation_id,
    exclusive_action_key: session.exclusive_action_key,
    path: pathDescriptor(session.path),
    logical_device_changed: false,
    path_derived_identity: false,
    permission_granted: false,
    authoritative_sessions: 1,
    commands_sent: session.commands.length,
    migrated: session.migrated,
  });

  const openPath = ({ peer, trust, transport_class, at, reason }) => {
    const adapter = adapterFor(transport_class);
    let raw;
    try {
      raw = adapter.connect({ peer: clone(peer), trust: clone(trust), at });
    } catch (error) {
      return { ok: false, code: 'UNAVAILABLE', detail: String(error?.message ?? error), transport_class };
    }
    if (!isPlainObject(raw) || !isText(raw.path_ref)) {
      return { ok: false, code: 'UNAVAILABLE', detail: 'the adapter returned no path reference', transport_class };
    }
    // A relay is a forwarder: it may not claim to have authorized the peer or seen plaintext.
    if (transport_class === 'RELAY' && (raw.peer_authorized === true || raw.plaintext_access === true || raw.authorizes === true)) {
      // The transport was already connected: close it before refusing, so a refused relay leaves no open
      // transport behind.
      try { if (typeof adapter.close === 'function') adapter.close({ path_ref: raw.path_ref }); } catch { /* nothing to close */ }
      note('RELAY_AUTHORIZATION_REFUSED', at, { path_ref: raw.path_ref });
      throw new PathManagerError('RELAY_CANNOT_AUTHORIZE', 'a relay forwards protected payloads; it never authorizes a peer or sees plaintext', { transport_class });
    }
    if (config.require_authenticated_encryption === true) {
      if (raw.authenticated !== true) {
        note('PATH_REFUSED_UNAUTHENTICATED', at, { transport_class, path_ref: raw.path_ref });
        return { ok: false, code: 'UNAUTHENTICATED_PATH_REFUSED', detail: `${transport_class} path is not authenticated`, transport_class };
      }
      if (raw.encrypted !== true) {
        note('PATH_REFUSED_PLAINTEXT', at, { transport_class, path_ref: raw.path_ref });
        return { ok: false, code: 'PLAINTEXT_PATH_REFUSED', detail: `${transport_class} path is not encrypted`, transport_class };
      }
    }
    const path = {
      path_ref: raw.path_ref,
      transport_class,
      // Recorded as measured. The descriptor used to hardcode authenticated: true / encrypted: true, so a
      // policy that waived the requirement produced a plaintext path still described as protected.
      authenticated: raw.authenticated === true,
      encrypted: raw.encrypted === true,
      transport_ref: raw.transport_ref ?? null,
      latency_ms: Number.isFinite(raw.latency_ms) ? raw.latency_ms : null,
      quality: isText(raw.quality) ? raw.quality : 'UNKNOWN',
      opened_at: at,
      selected_reason: reason,
      adapter,
    };
    // A path reference is not a capability handle to be overwritten: two paths may not share one ref, or
    // onPathLost/close would act on the wrong session.
    if (paths.has(path.path_ref)) {
      try { if (typeof adapter.close === 'function') adapter.close({ path_ref: path.path_ref }); } catch { /* nothing to close */ }
      return { ok: false, code: 'DUPLICATE_PATH_REF', detail: 'path reference ' + path.path_ref + ' is already registered', transport_class };
    }
    paths.set(path.path_ref, path);
    return { ok: true, path };
  };

  const api = {
    policy: () => freeze(clone(config)),
    transportPort: () => TRANSPORT_ADAPTER_PORT,

    candidatesFor({ peer, trust, at: when } = {}) {
      requireTrust(trust);
      if (!isText(peer?.device_id)) throw new PathManagerError('INVALID_PEER', 'a peer needs a device_id');
      return candidates({ peer, trust, at: when ?? now() });
    },

    /**
     * Open (or reuse) the authoritative session for a peer. Selection is race-safe: the first usable
     * authenticated+encrypted path wins, and one peer has at most one authoritative session.
     */
    connect({ peer, trust, session_intent = 'NONE', exclusive_action_key = null, at: when } = {}) {
      const trusted = requireTrust(trust);
      if (!isText(peer?.device_id)) throw new PathManagerError('INVALID_PEER', 'a peer needs a device_id');
      const peerLeak = findSecretFields(peer, 'peer');
      if (peerLeak.length > 0) throw new PathManagerError('INVALID_PEER', 'a peer record may not carry secret material: ' + peerLeak.join(', '));
      if (!['NONE', 'EXCLUSIVE'].includes(session_intent)) throw new PathManagerError('INVALID_REQUEST', 'session_intent must be NONE or EXCLUSIVE');
      if (session_intent === 'EXCLUSIVE' && !isText(exclusive_action_key)) throw new PathManagerError('ACTION_KEY_REQUIRED', 'an exclusive session needs an action key so a failover retry cannot duplicate a side effect');
      const at = requireInstant(when ?? now(), 'at');

      const existing = sessionsByPeer.get(peer.device_id) ?? null;
      if (existing !== null) {
        if (existing.exclusive_action_key !== null && existing.exclusive_action_key === exclusive_action_key) {
          note('SESSION_REUSED', at, { session_ref: existing.session_ref, device_id: peer.device_id });
          return freeze({ ...sessionDescriptor(existing), reused: true, selection_reason: 'REUSED_SESSION', attempts: freeze([]) });
        }
        throw new PathManagerError('SESSION_ALREADY_ACTIVE', `device ${peer.device_id} already has authoritative session ${existing.session_ref}`, {
          session_ref: existing.session_ref,
          concurrent_authoritative_sessions: 1,
          authoritative_sessions: 1,
        });
      }

      const considered = candidates({ peer, trust: trusted, at });
      const attempts = [];
      let adopted = null;
      for (const candidate of considered) {
        if (candidate.available !== true) { attempts.push({ ...candidate, adopted: false }); continue; }
        const reason = adopted === null && DIRECT_CLASSES.includes(candidate.transport_class) && attempts.every(entry => entry.adopted !== true && entry.transport_class !== candidate.transport_class)
          ? 'PREFERRED_DIRECT'
          : candidate.transport_class === 'RELAY' ? 'RELAY_FALLBACK' : 'DIRECT_AFTER_FAILURE';
        const opened = openPath({ peer, trust: trusted, transport_class: candidate.transport_class, at, reason });
        if (opened.ok !== true) {
          attempts.push({ transport_class: candidate.transport_class, available: true, adopted: false, reason: opened.code, detail: opened.detail });
          continue;
        }
        attempts.push({ transport_class: candidate.transport_class, available: true, adopted: true, reason: opened.path.selected_reason });
        adopted = opened.path;
        break;
      }
      if (adopted === null) {
        note('NO_USABLE_PATH', at, { device_id: peer.device_id, attempts: attempts.map(entry => entry.transport_class) });
        throw new PathManagerError('NO_USABLE_PATH', 'no authenticated, encrypted path could be established', { attempts: freeze(clone(attempts)), degraded: true, connected: false });
      }

      counter += 1;
      const session = {
        session_ref: `session:${peer.device_id}:${counter}`,
        device_id: peer.device_id,
        installation_id: peer.installation_id ?? null,
        exclusive_action_key: session_intent === 'EXCLUSIVE' ? exclusive_action_key : null,
        path: adopted,
        // The trust the session was opened with, reused on migration instead of a fabricated record.
        trust: clone(trusted),
        commands: [],
        migrated: false,
        opened_at: at,
      };
      sessions.set(session.session_ref, session);
      sessionsByPeer.set(peer.device_id, session);
      note('SESSION_OPENED', at, { session_ref: session.session_ref, transport_class: adopted.transport_class, reason: adopted.selected_reason });
      return freeze({
        ...sessionDescriptor(session),
        reused: false,
        selection_reason: adopted.selected_reason,
        attempts: freeze(clone(attempts)),
        direct_preferred: adopted.transport_class !== 'RELAY',
        relay_used: adopted.transport_class === 'RELAY',
      });
    },

    /**
     * Migrate a lost path. The logical session and device identity are unchanged, no command is replayed,
     * and only one migration may win a race.
     */
    migrate({ session_ref, reason = 'PATH_LOST', at: when } = {}) {
      const session = sessions.get(session_ref);
      if (!session) throw new PathManagerError('UNKNOWN_SESSION', `no session ${String(session_ref)}`);
      const at = requireInstant(when ?? now(), 'at');
      const previous = session.path;
      const attempted = [];
      for (const transport_class of config.preference) {
        if (transport_class === previous.transport_class && attempted.length === 0) { attempted.push({ transport_class, tried: false, reason: 'CURRENT_PATH' }); continue; }
        const adapter = adapterFor(transport_class);
        if (adapter === null || (transport_class === 'RELAY' && config.allow_relay !== true)) { attempted.push({ transport_class, tried: false, reason: 'NO_ADAPTER' }); continue; }
        // The session's own recorded trust, not a synthetic 'TRUSTED' record invented at migration time.
        const opened = openPath({ peer: { device_id: session.device_id, installation_id: session.installation_id }, trust: clone(session.trust ?? { device_id: session.device_id, trust_state: 'TRUSTED' }), transport_class, at, reason: 'MIGRATED' });
        if (opened.ok !== true) { attempted.push({ transport_class, tried: true, adopted: false, reason: opened.code }); continue; }
        attempted.push({ transport_class, tried: true, adopted: true });
        if (previous.adapter && typeof previous.adapter.close === 'function') {
          try { previous.adapter.close({ path_ref: previous.path_ref }); } catch { /* a lost path may already be gone */ }
        }
        paths.delete(previous.path_ref);
        session.path = opened.path;
        session.migrated = true;
        // A migrated session has a live path again: the loss flag was recorded, so it must be cleared.
        session.path_lost = false;
        session.commands_replayed = false;
        note('PATH_MIGRATED', at, { session_ref, from: previous.transport_class, to: transport_class, reason });
        return freeze({
          ...sessionDescriptor(session),
          migrated_from: previous.transport_class,
          migrated_to: transport_class,
          migration_reason: reason,
          commands_replayed: false,
          logical_device_changed: false,
          old_path_closed: true,
          concurrent_authoritative_sessions: 1,
          attempts: freeze(clone(attempted)),
        });
      }
      note('MIGRATION_EXHAUSTED', at, { session_ref, reason });
      throw new PathManagerError('NO_USABLE_PATH', 'the path was lost and no alternative authenticated, encrypted path is available', {
        session_ref,
        degraded: true,
        connected: false,
        attempts: freeze(clone(attempted)),
        authoritative_sessions: 1,
      });
    },

    /** One send surface. Payloads are end-to-end protected envelopes, and a retry cannot duplicate work. */
    send({ session_ref, envelope, command_ref, action_key = null, at: when } = {}) {
      const session = sessions.get(session_ref);
      if (!session) throw new PathManagerError('UNKNOWN_SESSION', `no session ${String(session_ref)}`);
      if (!isText(command_ref)) throw new PathManagerError('INVALID_REQUEST', 'a command needs a stable correlation id');
      if (!isPlainObject(envelope)) throw new PathManagerError('INVALID_REQUEST', 'an envelope is required');
      if (envelope.plaintext === true || envelope.protected === false) {
        throw new PathManagerError('PAYLOAD_MUST_BE_PROTECTED', 'only end-to-end protected payloads may be sent; a relay must never be handed plaintext');
      }
      if (session.exclusive_action_key !== null && !isText(action_key)) {
        throw new PathManagerError('ACTION_KEY_REQUIRED', 'an exclusive session requires the action key on every side-effecting command');
      }
      const at = requireInstant(when ?? now(), 'at');
      // onPathLost recorded session.path_lost and nothing read it, so a send after the path was declared
      // lost still called the adapter and reported sent: true.
      if (session.path_lost === true) {
        throw new PathManagerError('NO_USABLE_PATH', 'the path for this session was reported lost; migrate before sending');
      }
      const duplicate = session.commands.find(entry => entry.command_ref === command_ref && entry.action_key === action_key);
      if (duplicate) {
        return freeze({
          sent: false,
          duplicate: true,
          command_ref,
          action_key,
          session_ref,
          path_ref: session.path.path_ref,
          transport_class: session.path.transport_class,
          adapter_called: false,
          side_effect_repeated: false,
          at,
        });
      }
      let result;
      try {
        result = session.path.adapter.send({
        path_ref: session.path.path_ref,
        envelope: clone(envelope),
        command_ref,
        action_key,
          relay_plaintext_access: session.path.transport_class === 'RELAY' ? false : null,
        });
      } catch (error) {
        // A transport fault is data, not an escape: the caller gets a typed result and no command is
        // recorded, so a retry with the same command_ref is still the first attempt.
        note('SEND_FAILED', at, { session_ref, command_ref, code: String(error?.code ?? 'ADAPTER_FAILED') });
        return freeze({
          sent: false,
          duplicate: false,
          fault: freeze({ code: String(error?.code ?? 'ADAPTER_FAILED'), detail: String(error?.message ?? error) }),
          command_ref,
          action_key,
          session_ref,
          path_ref: session.path.path_ref,
          transport_class: session.path.transport_class,
          adapter_called: true,
          side_effect_repeated: false,
          at,
        });
      }
      session.commands.push({ command_ref, action_key, at });
      return freeze({
        sent: true,
        duplicate: false,
        command_ref,
        action_key,
        session_ref,
        path_ref: session.path.path_ref,
        transport_class: session.path.transport_class,
        direct: DIRECT_CLASSES.includes(session.path.transport_class),
        relay: session.path.transport_class === 'RELAY',
        adapter_called: true,
        adapter_result: freeze(clone(result ?? null)),
        relay_plaintext_access: false,
        permission_granted: false,
        at,
      });
    },

    /** A failed or lost path is reported, and the caller decides whether to migrate. */
    onPathLost({ path_ref, at: when } = {}) {
      const path = paths.get(path_ref);
      if (!path) throw new PathManagerError('UNKNOWN_PATH', `no path ${String(path_ref)}`);
      const at = requireInstant(when ?? now(), 'at');
      const session = [...sessions.values()].find(entry => entry.path.path_ref === path_ref) ?? null;
      paths.delete(path_ref);
      if (session) session.path_lost = true;
      note('PATH_LOST', at, { path_ref, transport_class: path.transport_class });
      return freeze({
        path_ref,
        transport_class: path.transport_class,
        session_ref: session?.session_ref ?? null,
        session_still_logical: session !== null,
        device_changed: false,
        alternative_available: candidates({ peer: { device_id: session?.device_id ?? 'device:unknown' }, trust: { device_id: session?.device_id ?? 'device:unknown', trust_state: 'TRUSTED' }, at })
          .some(entry => entry.available === true && entry.transport_class !== path.transport_class),
        reported: true,
        connected: false,
      });
    },

    close({ session_ref, at: when } = {}) {
      const session = sessions.get(session_ref);
      if (!session) throw new PathManagerError('UNKNOWN_SESSION', `no session ${String(session_ref)}`);
      const at = requireInstant(when ?? now(), 'at');
      if (session.path.adapter && typeof session.path.adapter.close === 'function') {
        try { session.path.adapter.close({ path_ref: session.path.path_ref }); } catch { /* already gone */ }
      }
      paths.delete(session.path.path_ref);
      sessions.delete(session_ref);
      sessionsByPeer.delete(session.device_id);
      note('SESSION_CLOSED', at, { session_ref, device_id: session.device_id });
      return freeze({ session_ref, closed: true, device_id: session.device_id, at });
    },

    sessionFor(device_id) {
      const session = sessionsByPeer.get(device_id);
      return session ? sessionDescriptor(session) : null;
    },

    pathMetadata({ session_ref } = {}) {
      const session = sessions.get(session_ref);
      if (!session) throw new PathManagerError('UNKNOWN_SESSION', `no session ${String(session_ref)}`);
      return pathDescriptor(session.path);
    },

    /** Introspection returns descriptors only: an adapter implementation is never handed out. */
    sessions: () => [...sessions.values()].map(session => freeze({
      session_ref: session.session_ref,
      device_id: session.device_id,
      installation_id: session.installation_id,
      exclusive_action_key: session.exclusive_action_key,
      path: pathDescriptor(session.path),
      migrated: session.migrated,
      commands_sent: session.commands.length,
      opened_at: session.opened_at,
    })),
    auditTrail: () => clone(audit),
  };
  return Object.freeze(api);
}
