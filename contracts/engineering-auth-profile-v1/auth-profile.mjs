// Credential references + persistent connector profiles/sessions (EM-008).
//
// Auth is connector-neutral. A profile says HOW a connector authenticates (mode), WHERE its secret
// handle lives and HOW FRESH that answer is — it never holds a secret itself. Raw secret material is
// handed to the neutral 00-Foundation `SecureHandleStorePort` and only the returned handle reference is
// kept, so canonical job/connector/task state, logs, reports, artifacts and diagnostics carry references
// instead of plaintext.
//
// What is enforced rather than assumed: a handle reference may never itself be secret material (neither a
// caller-supplied one nor one a store hands back), a superseded handle is revoked instead of abandoned,
// canonical records are plain own-key objects, instants must survive a calendar round trip so an
// uninterpretable expiry can never read as READY, a restart snapshot is validated as strictly as a fresh
// registration, revocation stays observable, and no recursion over caller data can blow the stack or leak a
// secret into a log.
//
// If no secure store is available the layer degrades HONESTLY: it reports UNAVAILABLE / MISSING and
// refuses to bind a secret. There is no plaintext fallback, ever.
//
// Pure module: no ambient state, filesystem, network or process.env; the store and the clock are injected.
export const AUTH_PROFILE_CONTRACT_VERSION = 1;

/** Auth modes: the connector-neutral vocabulary that replaces DeepSeek-only .env assumptions. */
export const AUTH_MODES = Object.freeze(['API_KEY', 'OAUTH', 'DEVICE_CODE', 'CLI_SESSION', 'BROWSER_PROFILE', 'DESKTOP_SESSION', 'NONE']);

/** Identical vocabulary to EM-004's registry auth status, so the two never disagree in a report. */
export const AUTH_STATUSES = Object.freeze(['READY', 'MISSING', 'EXPIRED', 'NEEDS_USER', 'REFRESHING', 'UNAVAILABLE', 'UNKNOWN']);

/** The three reference kinds the workbook names, one per auth mode family. */
export const REFERENCE_KINDS = Object.freeze(['CREDENTIAL', 'PROFILE', 'SESSION']);

/** Which reference kind each mode produces. */
export const MODE_REFERENCE = Object.freeze({
  API_KEY: 'CREDENTIAL',
  OAUTH: 'CREDENTIAL',
  DEVICE_CODE: 'CREDENTIAL',
  BROWSER_PROFILE: 'PROFILE',
  DESKTOP_SESSION: 'PROFILE',
  CLI_SESSION: 'SESSION',
  NONE: null,
});

/** Only a session-like mode may survive a restart. A bearer credential is not a session. */
export const PERSISTABLE_MODES = Object.freeze(['CLI_SESSION', 'BROWSER_PROFILE', 'DESKTOP_SESSION']);
export const PERSISTENCE_KINDS = Object.freeze(['EPHEMERAL', 'PERSISTENT']);

/** The neutral storage primitive Engineering Manager must consume instead of growing its own store. */
export const SECURE_HANDLE_STORE_PORT = Object.freeze({
  interface: 'SecureHandleStorePort',
  version: 1,
  methods: Object.freeze(['putHandle', 'resolveHandle', 'revokeHandle']),
  owner: 'neutral 00-Foundation SecureHandleStorePort',
  engineering_may_define_its_own_store: false,
  stores_raw_bytes_in_profile_records: false,
});

export const AUTH_PROFILE_CODES = Object.freeze([
  'INVALID_PROFILE', 'INVALID_MODE', 'INVALID_PERSISTENCE', 'UNKNOWN_PROFILE', 'DUPLICATE_PROFILE',
  'PROFILE_VERSION_CONFLICT', 'MODE_REQUIRES_NO_HANDLE', 'MODE_NOT_PERSISTABLE', 'SECURE_STORE_REQUIRED',
  'SECURE_STORE_UNAVAILABLE', 'SECURE_STORE_FAILED', 'SECRET_VALUE_REQUIRED', 'HANDLE_REQUIRED',
  'HANDLE_NOT_RESOLVABLE', 'PLAINTEXT_REFUSED', 'UNKNOWN_LEGACY_SOURCE', 'JOB_REF_REQUIRED',
]);

const CONFLICT_CODES = new Set(['PROFILE_VERSION_CONFLICT', 'DUPLICATE_PROFILE', 'PLAINTEXT_REFUSED', 'SECURE_STORE_FAILED']);
const UNAVAILABLE_CODES = new Set(['SECURE_STORE_UNAVAILABLE', 'SECURE_STORE_REQUIRED', 'HANDLE_NOT_RESOLVABLE']);

export class AuthProfileError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AuthProfileError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_PROFILE' ? 404 : CONFLICT_CODES.has(code) ? 409 : UNAVAILABLE_CODES.has(code) ? 503 : 400;
  }
}

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
/** Cycle-safe: a self-referential caller value must not be able to blow the stack. */
const freeze = value => {
  const seen = new WeakSet();
  const walk = node => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);
    for (const child of Object.values(node)) walk(child);
    return Object.freeze(node);
  };
  return walk(value);
};
/** Account for the calendar: a well-shaped string can still be an impossible date, or not parse at all. */
export const isIsoInstant = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && !Number.isNaN(Date.parse(value));

const INSTANT_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const isRealInstant = value => {
  if (!isIsoInstant(value)) return false;
  const parts = INSTANT_PARTS.exec(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return date.getUTCFullYear() === Number(parts[1])
    && date.getUTCMonth() + 1 === Number(parts[2])
    && date.getUTCDate() === Number(parts[3])
    && date.getUTCHours() === Number(parts[4])
    && date.getUTCMinutes() === Number(parts[5])
    && date.getUTCSeconds() === Number(parts[6]);
};

const SECRET_KEY_SHAPE = /(secret|token|password|passwd|passphrase|api_?key|private_?key|bearer|client_secret|access_key|credential_?value|^value$)/i;
const SECRET_VALUE_SHAPE = /^(sk|pk|ghp|gho|xox[baprs]|AKIA)-?[A-Za-z0-9_\-]{8,}$/;
/** Detection and redaction share one substring shape, so nothing classified as a secret survives redaction. */
const SECRET_SUBSTRING_SHAPE = /(?:sk|pk|ghp|gho|xox[baprs]|AKIA)[-_][A-Za-z0-9_\-]{8,}|(?:ghp|gho|xox[baprs]|AKIA)[A-Za-z0-9_\-]{8,}/g;

export const looksLikeSecretValue = value => isText(value) && SECRET_VALUE_SHAPE.test(value);

/** Redact a secret-shaped value, and secret-shaped substrings anywhere inside a longer message. */
const redactString = value => {
  if (typeof value !== 'string') return value;
  if (looksLikeSecretValue(value)) return '[REDACTED]';
  return value.replace(SECRET_SUBSTRING_SHAPE, '[REDACTED]');
};

/** Recursive scan for secret material. `*_ref` keys are handle references and booleans are assertions. */
export function findSecretFields(value, path = 'record', found = [], seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return found;
    seen.add(value);
    value.forEach((item, index) => findSecretFields(item, `${path}[${index}]`, found, seen));
    return found;
  }
  if (typeof value === 'string') {
    if ((looksLikeSecretValue(value) || SECRET_SUBSTRING_SHAPE.test(value)) && !found.includes(path)) found.push(path);
    SECRET_SUBSTRING_SHAPE.lastIndex = 0;
    return found;
  }
  if (typeof value === 'boolean' || value === null) return found;
  if (!isPlainObject(value) || seen.has(value)) return found;
  seen.add(value);
  // Own keys, not enumerable keys: a hidden own field is exactly how a secret would try to ride along.
  for (const key of Reflect.ownKeys(value)) {
    const child = value[key];
    // A symbol key is inadmissible material rather than secret material, but its value is still scanned.
    if (typeof key !== 'string') { findSecretFields(child, `${path}[${String(key)}]`, found, seen); continue; }
    const childPath = `${path}.${key}`;
    const keyIsSecret = SECRET_KEY_SHAPE.test(key) && !/_ref$/.test(key) && typeof child !== 'boolean';
    if (keyIsSecret) {
      if (!found.includes(childPath)) found.push(childPath);
      continue;
    }
    findSecretFields(child, childPath, found, seen);
  }
  return found;
}

/** Redact secret-shaped keys and values anywhere in a diagnostic payload. A cycle is replaced, not walked. */
export function redact(value, key = null, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    return value.map(item => redact(item, null, seen));
  }
  if (typeof value === 'string') {
    if (key !== null && SECRET_KEY_SHAPE.test(key) && !/_ref$/.test(key)) return '[REDACTED]';
    return redactString(value);
  }
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const out = {};
  for (const [childKey, child] of Object.entries(value)) {
    out[childKey] = SECRET_KEY_SHAPE.test(childKey) && !/_ref$/.test(childKey) && typeof child !== 'boolean' ? '[REDACTED]' : redact(child, childKey, seen);
  }
  return out;
}

const PROFILE_SPEC = Object.freeze({
  profile_id: { required: true, type: 'text' },
  connector_kind: { required: true, type: 'text' },
  mode: { required: true, type: 'enum', values: AUTH_MODES },
  persistence: { required: false, type: 'enum', values: PERSISTENCE_KINDS },
  account_ref: { required: false, type: 'text', nullable: true },
  expires_at: { required: false, type: 'instant', nullable: true },
  requires_user_action: { required: false, type: 'bool' },
  at: { required: false, type: 'instant', nullable: true },
});

const BIND_SPEC = Object.freeze({
  profile_id: { required: true, type: 'text' },
  expected_version: { required: true, type: 'int' },
  secret_value: { required: false, type: 'text', nullable: true },
  handle_ref: { required: false, type: 'text', nullable: true },
  expires_at: { required: false, type: 'instant', nullable: true },
  at: { required: false, type: 'instant', nullable: true },
});

const SNAPSHOT_ENTRY_SPEC = Object.freeze({
  profile_id: { required: true, type: 'text' },
  profile_version: { required: false, type: 'int' },
  connector_kind: { required: true, type: 'text' },
  mode: { required: true, type: 'enum', values: AUTH_MODES },
  persistence: { required: true, type: 'enum', values: PERSISTENCE_KINDS },
  account_ref: { required: false, type: 'text', nullable: true },
  handle_ref: { required: false, type: 'text', nullable: true },
  expires_at: { required: false, type: 'instant', nullable: true },
  requires_user_action: { required: false, type: 'bool' },
});

/** Admissibility is decided on the object itself: plain, and no field outside the canonical allow-list. */
function checkAdmissible(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be a plain object`); return false; }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.hasOwn(spec, key)) errors.push(`${path}.${String(key)} is not part of the canonical contract`);
  }
  return true;
}

/** Read every declared field exactly once, so the value that is validated is the value that is used. */
function takeFields(value, spec) {
  const taken = {};
  for (const key of Object.keys(spec)) if (Object.hasOwn(value, key)) taken[key] = value[key];
  return taken;
}

function checkFields(value, path, spec, errors) {
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isRealInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int' && (!Number.isSafeInteger(field) || field < 0)) errors.push(`${fieldPath} must be a non-negative integer`);
    if (rule.type === 'bool' && typeof field !== 'boolean') errors.push(`${fieldPath} must be a boolean`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`${fieldPath} must be one of ${rule.values.join(', ')}`);
  }
}

/** The legacy surface this layer replaces. It is a bridge, not the schema. */
export const LEGACY_SOURCES = Object.freeze({ DEEPSEEK_API_KEY: { connector_kind: 'DEEPSEEK', mode: 'API_KEY' } });

export function createAuthProfileLayer({ handleStore = null, clock = () => new Date().toISOString() } = {}) {
  if (typeof clock !== 'function') throw new AuthProfileError('INVALID_PROFILE', 'clock must be a function returning an ISO-8601 UTC instant');
  const profiles = new Map();
  const log = [];

  const at = value => {
    if (value === undefined || value === null) {
      const produced = clock();
      if (!isRealInstant(produced)) throw new AuthProfileError('INVALID_PROFILE', 'clock() must return a real ISO-8601 UTC instant');
      return produced;
    }
    if (!isRealInstant(value)) throw new AuthProfileError('INVALID_PROFILE', 'at must be a real ISO-8601 UTC instant');
    // Freshness cannot be rewound: an instant before the layer's own clock would let a caller ask the
    // freshness question as of a moment when an expired credential still looked valid.
    const current = clock();
    if (isRealInstant(current) && Date.parse(value) < Date.parse(current)) {
      throw new AuthProfileError('INVALID_PROFILE', `at ${value} precedes the layer's current instant ${current}; freshness cannot be rewound`);
    }
    return value;
  };

  const requireProfile = profile_id => {
    const record = profiles.get(profile_id);
    if (!record) throw new AuthProfileError('UNKNOWN_PROFILE', `no auth profile ${profile_id}`);
    return record;
  };

  const storeAvailable = () => isPlainObject(handleStore) && typeof handleStore.putHandle === 'function' && typeof handleStore.resolveHandle === 'function';

  /** Every failure is recorded redacted: a hostile store message can never leak a secret into a log. */
  const record = (event, detail = {}) => {
    log.push(freeze({ event, at: at(undefined), ...redact(detail) }));
    return log.length - 1;
  };

  const project = (profile, evaluatedAt) => {
    const reference = MODE_REFERENCE[profile.mode];
    const expires = profile.expires_at;
    // Calendar reality, not shape: an expiry this layer cannot interpret is never "fresh", and an
    // uninterpretable evaluation instant cannot silently make an expired session look READY.
    const expiresParsed = isRealInstant(expires) ? Date.parse(expires) : null;
    const evaluatedParsed = isRealInstant(evaluatedAt) ? Date.parse(evaluatedAt) : null;
    const expired = expiresParsed !== null && (evaluatedParsed === null || expiresParsed <= evaluatedParsed);
    let status = profile.status;
    let reason = profile.reason;
    let handleResolvable = null;
    if (profile.mode === 'NONE') {
      status = 'READY';
      reason = 'NO_AUTH_REQUIRED';
    } else if (!storeAvailable()) {
      status = profile.handle_ref ? 'UNAVAILABLE' : 'MISSING';
      reason = profile.handle_ref ? 'SECURE_STORE_UNAVAILABLE' : 'NO_HANDLE_BOUND';
    } else if (!profile.handle_ref) {
      status = profile.requires_user_action ? 'NEEDS_USER' : 'MISSING';
      reason = profile.requires_user_action ? 'USER_ACTION_REQUIRED' : 'NO_HANDLE_BOUND';
    } else if (expired) {
      status = 'EXPIRED';
      reason = 'SESSION_EXPIRED';
    } else {
      try {
        handleStore.resolveHandle(profile.handle_ref);
        handleResolvable = true;
        status = profile.requires_user_action ? 'NEEDS_USER' : 'READY';
        reason = profile.requires_user_action ? 'USER_ACTION_REQUIRED' : 'READY';
      } catch (error) {
        handleResolvable = false;
        status = 'MISSING';
        reason = 'HANDLE_UNRESOLVABLE';
        record('HANDLE_UNRESOLVABLE', { profile_id: profile.profile_id, handle_ref: profile.handle_ref, error: String(error?.message ?? error) });
      }
    }
    const reference_out = { credential_ref: null, profile_ref: null, session_ref: null };
    if (profile.handle_ref !== null && reference === 'CREDENTIAL') reference_out.credential_ref = profile.handle_ref;
    if (profile.handle_ref !== null && reference === 'PROFILE') reference_out.profile_ref = profile.handle_ref;
    if (profile.handle_ref !== null && reference === 'SESSION') reference_out.session_ref = profile.handle_ref;
    const projection = {
      contract_version: AUTH_PROFILE_CONTRACT_VERSION,
      profile_id: profile.profile_id,
      profile_version: profile.profile_version,
      connector_kind: profile.connector_kind,
      mode: profile.mode,
      persistence: profile.persistence,
      account_ref: profile.account_ref,
      reference_kind: reference,
      ...reference_out,
      handle_ref: profile.handle_ref,
      handle_kind: reference,
      auth_status: status,
      status,
      reason,
      requires_user_action: status === 'NEEDS_USER',
      attention_required: status === 'EXPIRED' || status === 'NEEDS_USER' || status === 'MISSING' || status === 'UNAVAILABLE',
      handle_resolvable: handleResolvable,
      store_available: storeAvailable(),
      revoked_at: profile.revoked_at ?? null,
      revoked_reason: profile.revoked_reason ?? null,
      freshness: freeze({ evaluated_at: evaluatedAt, expires_at: expires, expired, fresh: !expired && status === 'READY' }),
    };
    // The claim is measured on the record that is actually returned, not asserted about it.
    return freeze({ ...projection, references_only: findSecretFields(projection).length === 0, plaintext_fallback_used: false });
  };

  /** Register a profile. Only the mode/persistence/expiry shape is known here — never a secret. */
  const registerProfile = input => {
      const errors = [];
      checkAdmissible(input, 'profile', PROFILE_SPEC, errors);
      // The scan runs on every input, not only on a malformed one: a well-shaped record carrying a secret
      // in profile_id/connector_kind/account_ref would otherwise be admitted to canonical state.
      const secrets = findSecretFields(input);
      if (secrets.length) throw new AuthProfileError('PLAINTEXT_REFUSED', `profile input carries secret material at ${secrets.join(', ')}`);
      if (errors.length) throw new AuthProfileError('INVALID_PROFILE', errors.join('; '));
      const fields = takeFields(input, PROFILE_SPEC);
      checkFields(fields, 'profile', PROFILE_SPEC, errors);
      if (errors.length) throw new AuthProfileError('INVALID_PROFILE', errors.join('; '));
      if (profiles.has(fields.profile_id)) throw new AuthProfileError('DUPLICATE_PROFILE', `auth profile ${fields.profile_id} already exists`);
      const persistence = fields.persistence ?? 'EPHEMERAL';
      if (persistence === 'PERSISTENT' && !PERSISTABLE_MODES.includes(fields.mode)) {
        throw new AuthProfileError('MODE_NOT_PERSISTABLE', `${fields.mode} material is not a restorable session and may not be persisted`);
      }
      const timestamp = at(fields.at);
      const stored = {
        profile_id: fields.profile_id,
        profile_version: 1,
        connector_kind: fields.connector_kind,
        mode: fields.mode,
        persistence,
        account_ref: fields.account_ref ?? null,
        expires_at: fields.expires_at ?? null,
        requires_user_action: fields.requires_user_action ?? false,
        handle_ref: null,
        handle_bound_by_layer: false,
        status: 'MISSING',
        reason: 'NO_HANDLE_BOUND',
        revoked_at: null,
        revoked_reason: null,
        created_at: timestamp,
        updated_at: timestamp,
      };
      profiles.set(stored.profile_id, stored);
      record('PROFILE_REGISTERED', { profile_id: stored.profile_id, mode: stored.mode, persistence: stored.persistence });
      return project(stored, timestamp);
  };

  /**
   * Bind a secret to a profile. The value goes straight into the neutral handle store; only the handle
   * reference is retained. Without a store this refuses — it never writes plaintext into a record, and a
   * "reference" that is itself secret material is refused on both the caller and the store side.
   */
  const bindSecret = input => {
      const errors = [];
      checkAdmissible(input, 'bind', BIND_SPEC, errors);
      // secret_value is the one field allowed to carry secret material (it goes straight to the store);
      // every other declared field is scanned, so a secret cannot ride in on profile_id or handle_ref.
      const scanTarget = {};
      for (const key of Object.keys(BIND_SPEC)) {
        if (key !== 'secret_value' && isPlainObject(input) && Object.hasOwn(input, key)) scanTarget[key] = input[key];
      }
      const secrets = findSecretFields(scanTarget);
      if (secrets.length) throw new AuthProfileError('PLAINTEXT_REFUSED', `bind input carries secret material outside secret_value at ${secrets.join(', ')}`);
      if (errors.length) throw new AuthProfileError('INVALID_PROFILE', errors.join('; '));
      const fields = takeFields(input, BIND_SPEC);
      checkFields(fields, 'bind', BIND_SPEC, errors);
      if (errors.length) throw new AuthProfileError('INVALID_PROFILE', errors.join('; '));
      const profile = requireProfile(fields.profile_id);
      if (fields.expected_version !== profile.profile_version) {
        throw new AuthProfileError('PROFILE_VERSION_CONFLICT', `profile ${profile.profile_id} is at version ${profile.profile_version}, bind assumed ${fields.expected_version}`);
      }
      if (profile.mode === 'NONE') throw new AuthProfileError('MODE_REQUIRES_NO_HANDLE', 'mode NONE authenticates with nothing and takes no handle');
      const hasSecret = isText(fields.secret_value);
      const hasHandle = isText(fields.handle_ref);
      if (hasSecret && hasHandle) throw new AuthProfileError('INVALID_PROFILE', 'bindSecret takes either a secret_value to store or an existing handle_ref, never both');
      if (!hasSecret && !hasHandle) throw new AuthProfileError('SECRET_VALUE_REQUIRED', 'bindSecret needs a secret_value to store or an existing handle_ref');
      const previousHandleRef = profile.handle_ref;
      const previousBoundByLayer = profile.handle_bound_by_layer === true;
      if (hasHandle) {
        if (!storeAvailable()) throw new AuthProfileError('SECURE_STORE_UNAVAILABLE', 'no secure handle store is available; refusing to record a handle this layer cannot resolve');
        profile.handle_ref = fields.handle_ref;
        profile.handle_bound_by_layer = false;
      } else {
        if (!storeAvailable()) {
          record('SECURE_STORE_UNAVAILABLE', { profile_id: profile.profile_id, secret_present: true });
          throw new AuthProfileError('SECURE_STORE_REQUIRED', 'the neutral SecureHandleStorePort is required; this layer must not store plaintext secrets itself');
        }
        let storedRef = null;
        try {
          const stored = handleStore.putHandle({ kind: MODE_REFERENCE[profile.mode], value: fields.secret_value });
          if (!isText(stored?.handle_ref)) throw new Error('handle store returned no handle_ref');
          storedRef = stored.handle_ref;
        } catch (error) {
          record('SECURE_STORE_FAILED', { profile_id: profile.profile_id, error: String(error?.message ?? error) });
          throw new AuthProfileError('SECURE_STORE_FAILED', 'the secure handle store failed; no handle was recorded and no secret was retained');
        }
        // A store that hands back the value instead of a handle would put plaintext straight into
        // canonical state, so the returned reference is checked before it is recorded.
        if (looksLikeSecretValue(storedRef)) {
          record('PLAINTEXT_REFUSED', { profile_id: profile.profile_id, source: 'handle_store' });
          throw new AuthProfileError('PLAINTEXT_REFUSED', 'the secure handle store returned what looks like secret material instead of a handle reference; no reference was recorded');
        }
        profile.handle_ref = storedRef;
        profile.handle_bound_by_layer = true;
      }
      // A rotation must not abandon the handle it replaces: this layer is the only holder of that
      // reference, and leaving it live in the store would keep a superseded secret usable.
      let previousHandleRevoked = null;
      if (isText(previousHandleRef) && previousHandleRef !== profile.handle_ref && previousBoundByLayer && typeof handleStore.revokeHandle === 'function') {
        try {
          previousHandleRevoked = handleStore.revokeHandle(previousHandleRef)?.revoked === true;
        } catch (error) {
          previousHandleRevoked = false;
          record('REVOKE_FAILED', { profile_id: profile.profile_id, handle_ref: previousHandleRef, error: String(error?.message ?? error) });
        }
      }
      // An expiry is a property of the credential that was bound. When a new one is bound without an
      // expiry, the previous instant is kept (failing closed) but the carry-over is made observable
      // rather than silent; pass expires_at: null explicitly to clear it.
      const expiryCarriedOver = fields.expires_at === undefined && isText(profile.expires_at);
      if (fields.expires_at !== undefined) profile.expires_at = fields.expires_at;
      profile.profile_version += 1;
      profile.updated_at = at(fields.at);
      profile.requires_user_action = false;
      profile.revoked_at = null;
      profile.revoked_reason = null;
      record('HANDLE_BOUND', { profile_id: profile.profile_id, handle_ref: profile.handle_ref, previous_handle_revoked: previousHandleRevoked, expiry_carried_over: expiryCarriedOver });
      return project(profile, profile.updated_at);
  };

  return {
    registerProfile,
    bindSecret,

    /** Typed absence: an unknown profile is null, not a thrown error. */
    getProfile(profile_id) {
      const profile = profiles.get(profile_id);
      return profile ? project(profile, at(undefined)) : null;
    },

    authStatusFor({ profile_id, job_ref = null, at: when } = {}) {
      const profile = requireProfile(profile_id);
      const timestamp = at(when);
      const status = project(profile, timestamp);
      let attention = null;
      let attention_skipped_reason = null;
      if (status.attention_required) {
        if (!isText(job_ref)) {
          attention_skipped_reason = 'ATTENTION_IS_JOB_SCOPED';
        } else {
          attention = freeze({
            contract_version: 1,
            attention_id: `attention:auth:${profile.profile_id}:${status.status}`,
            job_ref,
            connector_ref: profile.connector_kind,
            kind: 'AUTHENTICATION',
            question: status.status === 'NEEDS_USER'
              ? `${profile.connector_kind} needs you to sign in (${profile.mode})`
              : status.status === 'EXPIRED'
                ? `${profile.connector_kind} ${profile.mode} session expired; sign in again`
                : status.status === 'UNAVAILABLE'
                  ? `no secure store is available for ${profile.connector_kind} credentials`
                  : `${profile.connector_kind} credentials are missing (${profile.mode})`,
            blocking: true,
            created_at: timestamp,
          });
        }
      }
      return freeze({ ...status, attention, attention_skipped_reason });
    },

    /** Record whether a human still has to complete the sign-in for a profile. */
    markUserActionRequired({ profile_id, required = true, at: when } = {}) {
      const profile = requireProfile(profile_id);
      // A truthy non-boolean would silently clear a user-action requirement, so the flag is a boolean.
      if (typeof required !== 'boolean') throw new AuthProfileError('INVALID_PROFILE', `required must be true or false, got ${String(required)}`);
      profile.requires_user_action = required;
      profile.profile_version += 1;
      profile.updated_at = at(when);
      record('USER_ACTION_FLAG', { profile_id: profile.profile_id, required: profile.requires_user_action });
      return project(profile, profile.updated_at);
    },

    revoke({ profile_id, at: when } = {}) {
      const profile = requireProfile(profile_id);
      let revoked = false;
      let storeAsked = false;
      if (profile.handle_ref && storeAvailable() && typeof handleStore.revokeHandle === 'function') {
        storeAsked = true;
        try {
          revoked = handleStore.revokeHandle(profile.handle_ref)?.revoked === true;
        } catch (error) {
          record('REVOKE_FAILED', { profile_id: profile.profile_id, error: String(error?.message ?? error) });
        }
      }
      const timestamp = at(when);
      profile.handle_ref = null;
      profile.handle_bound_by_layer = false;
      profile.status = 'MISSING';
      profile.reason = 'HANDLE_REVOKED';
      profile.revoked_at = timestamp;
      profile.revoked_reason = 'HANDLE_REVOKED';
      profile.profile_version += 1;
      profile.updated_at = timestamp;
      record('PROFILE_REVOKED', { profile_id: profile.profile_id, store_revoked: revoked, store_asked: storeAsked });
      // The layer's own authority is gone either way, but whether the store actually released the secret
      // is reported instead of assumed: a revoke that leaves the handle live must be visible to the caller.
      return freeze({ ...project(profile, profile.updated_at), handle_released: revoked, store_revoke_attempted: storeAsked });
    },

    /** What may survive a restart: persistent session references only, and never a secret. */
    exportPersistentRefs() {
      const exported = [];
      for (const profile of profiles.values()) {
        if (profile.persistence !== 'PERSISTENT') continue;
        exported.push(freeze({
          profile_id: profile.profile_id,
          profile_version: profile.profile_version,
          connector_kind: profile.connector_kind,
          mode: profile.mode,
          persistence: profile.persistence,
          account_ref: profile.account_ref,
          handle_ref: profile.handle_ref,
          expires_at: profile.expires_at,
          requires_user_action: profile.requires_user_action,
        }));
      }
      const snapshot = freeze({ contract_version: AUTH_PROFILE_CONTRACT_VERSION, profiles: exported });
      if (findSecretFields(snapshot).length) throw new AuthProfileError('PLAINTEXT_REFUSED', 'refusing to export a snapshot that contains secret material');
      return snapshot;
    },

    /**
     * Restart. Persistent session references come back; a reference the store can no longer resolve is
     * reported honestly instead of being presented as READY, and ephemeral profiles simply do not return.
     * A snapshot entry is validated as strictly as a fresh registration would be.
     */
    restore({ snapshot, at: when } = {}) {
      if (!isPlainObject(snapshot) || !Array.isArray(snapshot.profiles)) throw new AuthProfileError('INVALID_PROFILE', 'restore needs a snapshot with a profiles array');
      const secrets = findSecretFields(snapshot);
      if (secrets.length) throw new AuthProfileError('PLAINTEXT_REFUSED', `refusing to restore a snapshot carrying secret material at ${secrets.join(', ')}`);
      const timestamp = at(when);
      // Everything is validated before anything is installed: a refused restore must not leave a
      // half-restored layer behind, and it must not replace a profile that is already live.
      const prepared = [];
      const skipped = [];
      snapshot.profiles.forEach((entry, index) => {
        const path = `snapshot.profiles[${index}]`;
        const errors = [];
        checkAdmissible(entry, path, SNAPSHOT_ENTRY_SPEC, errors);
        if (errors.length) throw new AuthProfileError('INVALID_PROFILE', errors.join('; '));
        const fields = takeFields(entry, SNAPSHOT_ENTRY_SPEC);
        checkFields(fields, path, SNAPSHOT_ENTRY_SPEC, errors);
        if (errors.length) throw new AuthProfileError('INVALID_PROFILE', errors.join('; '));
        if (!PERSISTABLE_MODES.includes(fields.mode)) { skipped.push(fields.profile_id); return; }
        prepared.push({
          profile_id: fields.profile_id,
          profile_version: fields.profile_version ?? 1,
          connector_kind: fields.connector_kind,
          mode: fields.mode,
          persistence: 'PERSISTENT',
          account_ref: fields.account_ref ?? null,
          expires_at: fields.expires_at ?? null,
          requires_user_action: fields.requires_user_action === true,
          handle_ref: fields.handle_ref ?? null,
          // The layer did not create this handle in this process, so it may not revoke it behind the
          // caller's back; it is a reference the snapshot vouched for.
          handle_bound_by_layer: false,
          status: 'MISSING',
          reason: 'RESTORED',
          revoked_at: null,
          revoked_reason: null,
          created_at: timestamp,
          updated_at: timestamp,
        });
      });
      for (const stored of prepared) {
        if (profiles.has(stored.profile_id)) throw new AuthProfileError('DUPLICATE_PROFILE', `auth profile ${stored.profile_id} is already registered; restore does not replace a live profile`);
      }
      const restored = [];
      const degraded = [];
      for (const stored of prepared) {
        profiles.set(stored.profile_id, stored);
        const status = project(stored, timestamp);
        if (status.handle_ref !== null && status.handle_resolvable !== true) degraded.push(stored.profile_id);
        restored.push(stored.profile_id);
      }
      record('SNAPSHOT_RESTORED', { restored, skipped, degraded });
      return freeze({
        restored_profiles: restored,
        skipped_non_persistent: skipped,
        degraded_profiles: degraded,
        references_only: findSecretFields({ restored_profiles: restored, skipped_non_persistent: skipped, degraded_profiles: degraded }).length === 0,
        plaintext_fallback_used: false,
        at: timestamp,
      });
    },

    /** The read surface a registry/report may embed: references and statuses, never secret material. */
    diagnosticSnapshot() {
      const timestamp = at(undefined);
      const snapshot = {
        contract_version: AUTH_PROFILE_CONTRACT_VERSION,
        store_available: storeAvailable(),
        store_port: SECURE_HANDLE_STORE_PORT.interface,
        profiles: [...profiles.values()].map(profile => {
          const status = project(profile, timestamp);
          return { profile_id: profile.profile_id, mode: profile.mode, persistence: profile.persistence, handle_ref: profile.handle_ref, status: status.status, reason: status.reason, expires_at: profile.expires_at };
        }),
      };
      return freeze({ ...snapshot, references_only: findSecretFields(snapshot).length === 0 });
    },

    /** Redacted log. Available so a failure test can prove no secret reached it. */
    logEntries() { return clone(log); },
    clearLog() { log.length = 0; },

    /**
     * Legacy DeepSeek .env discovery, bridged. The result is a NEUTRAL profile descriptor — it has no
     * provider-specific field, so it cannot become the universal schema, and the key itself is only ever
     * handed to the handle store.
     */
    discoverFromLegacyEnv({ env, at: when } = {}) {
      if (!isPlainObject(env)) throw new AuthProfileError('UNKNOWN_LEGACY_SOURCE', 'legacy discovery needs an env object');
      const source = Object.keys(LEGACY_SOURCES).find(key => isText(env[key]));
      if (!source) {
        record('LEGACY_DISCOVERY_EMPTY', { candidates: Object.keys(LEGACY_SOURCES) });
        return freeze({ discovered: false, legacy_source: null, profile: null, mode: null, secret_stored: false, secret_returned: false });
      }
      const legacy = LEGACY_SOURCES[source];
      const legacyValue = env[source];
      const profile_id = 'profile:default';
      const existing = profiles.get(profile_id);
      // The default profile must belong to the connector the environment key describes: binding a
      // DeepSeek key into whatever profile happens to own that id would hand the key to a foreign
      // connector and, for a persistent profile, export it as that connector's session reference.
      if (existing && (existing.connector_kind !== legacy.connector_kind || existing.mode !== legacy.mode)) {
        throw new AuthProfileError('INVALID_PROFILE', `profile:default belongs to ${existing.connector_kind}/${existing.mode}, not ${legacy.connector_kind}/${legacy.mode}`);
      }
      let bound = null;
      if (existing) {
        bound = bindSecret({ profile_id, expected_version: existing.profile_version, secret_value: legacyValue, at: when });
      } else {
        registerProfile({ profile_id, connector_kind: legacy.connector_kind, mode: legacy.mode, persistence: 'EPHEMERAL', at: when });
        bound = bindSecret({ profile_id, expected_version: 1, secret_value: legacyValue, at: when });
      }
      record('LEGACY_DISCOVERY', { legacy_source: source, profile_id });
      // The descriptor is built from the record that was actually written, never from the static table.
      return freeze({
        discovered: true,
        legacy_source: source,
        mode: bound.mode,
        connector_kind: bound.connector_kind,
        secret_stored: bound.handle_ref !== null,
        secret_returned: false,
        profile: bound,
      });
    },
  };
}
