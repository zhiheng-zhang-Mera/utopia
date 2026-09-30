// Credential references + persistent connector profiles/sessions (EM-008).
//
// Auth is connector-neutral. A profile says HOW a connector authenticates (mode), WHERE its secret
// handle lives and HOW FRESH that answer is 鈥?it never holds a secret itself. Raw secret material is
// handed to the neutral 00-Foundation `SecureHandleStorePort` and only the returned handle reference is
// kept, so canonical job/connector/task state, logs, reports, artifacts and diagnostics carry references
// instead of plaintext.
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

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

const SECRET_KEY_SHAPE = /(secret|token|password|passwd|passphrase|api_?key|private_?key|bearer|client_secret|access_key|credential_?value|^value$)/i;
const SECRET_VALUE_SHAPE = /^(sk|pk|ghp|gho|xox[baprs]|AKIA)-?[A-Za-z0-9_\-]{8,}$/;
const SECRET_SUBSTRING_SHAPE = /(?:sk|pk|ghp|gho|xox[baprs]|AKIA)-[A-Za-z0-9_\-]{8,}/g;

export const looksLikeSecretValue = value => isText(value) && SECRET_VALUE_SHAPE.test(value);

/** Redact secret-shaped substrings anywhere inside a longer message (a store error is not a safe channel). */
const redactString = value => (typeof value === 'string' ? value.replace(SECRET_SUBSTRING_SHAPE, '[REDACTED]') : value);

/** Recursive scan for secret material. `*_ref` keys are handle references and booleans are assertions. */
export function findSecretFields(value, path = 'record', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretFields(item, `${path}[${index}]`, found));
    return found;
  }
  if (typeof value === 'string') {
    if ((looksLikeSecretValue(value) || SECRET_SUBSTRING_SHAPE.test(value)) && !found.includes(path)) found.push(path);
    SECRET_SUBSTRING_SHAPE.lastIndex = 0;
    return found;
  }
  if (typeof value === 'boolean' || value === null) return found;
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const keyIsSecret = SECRET_KEY_SHAPE.test(key) && !/_ref$/.test(key) && typeof child !== 'boolean';
    if (keyIsSecret) {
      if (!found.includes(childPath)) found.push(childPath);
      continue;
    }
    findSecretFields(child, childPath, found);
  }
  return found;
}

/** Redact secret-shaped keys and values anywhere in a diagnostic payload. */
export function redact(value, key = null) {
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (typeof value === 'string') {
    if (key !== null && SECRET_KEY_SHAPE.test(key) && !/_ref$/.test(key)) return '[REDACTED]';
    return redactString(value);
  }
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [childKey, child] of Object.entries(value)) {
    out[childKey] = SECRET_KEY_SHAPE.test(childKey) && !/_ref$/.test(childKey) && typeof child !== 'boolean' ? '[REDACTED]' : redact(child, childKey);
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

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  for (const key of Object.keys(value)) if (!(key in spec)) errors.push(`${path}.${key} is not part of the canonical contract`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int' && !Number.isSafeInteger(field)) errors.push(`${fieldPath} must be an integer`);
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
      if (!isIsoInstant(produced)) throw new AuthProfileError('INVALID_PROFILE', 'clock() must return an ISO-8601 UTC instant');
      return produced;
    }
    if (!isIsoInstant(value)) throw new AuthProfileError('INVALID_PROFILE', 'at must be an ISO-8601 UTC instant');
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
    const expired = isIsoInstant(expires) && Date.parse(expires) <= Date.parse(evaluatedAt);
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
    return freeze({
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
      freshness: freeze({ evaluated_at: evaluatedAt, expires_at: expires, expired, fresh: !expired && status === 'READY' }),
      references_only: true,
      plaintext_fallback_used: false,
    });
  };

  /** Register a profile. Only the mode/persistence/expiry shape is known here 鈥?never a secret. */
  const registerProfile = input => {
      const errors = [];
      checkShape(input, 'profile', PROFILE_SPEC, errors);
      if (errors.length) {
        if (isPlainObject(input) && findSecretFields(input).length) throw new AuthProfileError('PLAINTEXT_REFUSED', `profile input carries secret material at ${findSecretFields(input).join(', ')}`);
        throw new AuthProfileError('INVALID_PROFILE', errors.join('; '));
      }
      if (!AUTH_MODES.includes(input.mode)) throw new AuthProfileError('INVALID_MODE', `unknown auth mode ${input.mode}`);
      if (profiles.has(input.profile_id)) throw new AuthProfileError('DUPLICATE_PROFILE', `auth profile ${input.profile_id} already exists`);
      const persistence = input.persistence ?? 'EPHEMERAL';
      if (persistence === 'PERSISTENT' && !PERSISTABLE_MODES.includes(input.mode)) {
        throw new AuthProfileError('MODE_NOT_PERSISTABLE', `${input.mode} material is not a restorable session and may not be persisted`);
      }
      const timestamp = at(input.at);
      const stored = {
        profile_id: input.profile_id,
        profile_version: 1,
        connector_kind: input.connector_kind,
        mode: input.mode,
        persistence,
        account_ref: input.account_ref ?? null,
        expires_at: input.expires_at ?? null,
        requires_user_action: input.requires_user_action ?? false,
        handle_ref: null,
        status: 'MISSING',
        reason: 'NO_HANDLE_BOUND',
        created_at: timestamp,
        updated_at: timestamp,
      };
      profiles.set(stored.profile_id, stored);
      record('PROFILE_REGISTERED', { profile_id: stored.profile_id, mode: stored.mode, persistence: stored.persistence });
      return project(stored, timestamp);
  };

  /**
   * Bind a secret to a profile. The value goes straight into the neutral handle store; only the handle
   * reference is retained. Without a store this refuses 鈥?it never writes plaintext into a record.
   */
  const bindSecret = input => {
      const errors = [];
      checkShape(input, 'bind', BIND_SPEC, errors);
      if (errors.length) throw new AuthProfileError('INVALID_PROFILE', errors.join('; '));
      const profile = requireProfile(input.profile_id);
      if (input.expected_version !== profile.profile_version) {
        throw new AuthProfileError('PROFILE_VERSION_CONFLICT', `profile ${profile.profile_id} is at version ${profile.profile_version}, bind assumed ${input.expected_version}`);
      }
      if (profile.mode === 'NONE') throw new AuthProfileError('MODE_REQUIRES_NO_HANDLE', 'mode NONE authenticates with nothing and takes no handle');
      if (!isText(input.secret_value) && !isText(input.handle_ref)) throw new AuthProfileError('SECRET_VALUE_REQUIRED', 'bindSecret needs a secret_value to store or an existing handle_ref');
      if (isText(input.handle_ref)) {
        if (!storeAvailable()) throw new AuthProfileError('SECURE_STORE_UNAVAILABLE', 'no secure handle store is available; refusing to record a handle this layer cannot resolve');
        profile.handle_ref = input.handle_ref;
      } else {
        if (!storeAvailable()) {
          record('SECURE_STORE_UNAVAILABLE', { profile_id: profile.profile_id, secret_present: true });
          throw new AuthProfileError('SECURE_STORE_REQUIRED', 'the neutral SecureHandleStorePort is required; this layer must not store plaintext secrets itself');
        }
        try {
          const stored = handleStore.putHandle({ kind: MODE_REFERENCE[profile.mode], value: input.secret_value });
          if (!isText(stored?.handle_ref)) throw new Error('handle store returned no handle_ref');
          profile.handle_ref = stored.handle_ref;
        } catch (error) {
          record('SECURE_STORE_FAILED', { profile_id: profile.profile_id, error: String(error?.message ?? error) });
          throw new AuthProfileError('SECURE_STORE_FAILED', 'the secure handle store failed; no handle was recorded and no secret was retained');
        }
      }
      if (input.expires_at !== undefined) profile.expires_at = input.expires_at;
      profile.profile_version += 1;
      profile.updated_at = at(input.at);
      profile.requires_user_action = false;
      record('HANDLE_BOUND', { profile_id: profile.profile_id, handle_ref: profile.handle_ref });
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

    /** Record that a human completed the sign-in for a profile whose mode needs one. */
    markUserActionRequired({ profile_id, required = true, at: when } = {}) {
      const profile = requireProfile(profile_id);
      profile.requires_user_action = required === true;
      profile.profile_version += 1;
      profile.updated_at = at(when);
      record('USER_ACTION_FLAG', { profile_id: profile.profile_id, required: profile.requires_user_action });
      return project(profile, profile.updated_at);
    },

    revoke({ profile_id, at: when } = {}) {
      const profile = requireProfile(profile_id);
      let revoked = false;
      if (profile.handle_ref && storeAvailable() && typeof handleStore.revokeHandle === 'function') {
        try {
          revoked = handleStore.revokeHandle(profile.handle_ref)?.revoked === true;
        } catch (error) {
          record('REVOKE_FAILED', { profile_id: profile.profile_id, error: String(error?.message ?? error) });
        }
      }
      profile.handle_ref = null;
      profile.status = 'MISSING';
      profile.reason = 'HANDLE_REVOKED';
      profile.profile_version += 1;
      profile.updated_at = at(when);
      record('PROFILE_REVOKED', { profile_id: profile.profile_id, store_revoked: revoked });
      return project(profile, profile.updated_at);
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
     */
    restore({ snapshot, at: when } = {}) {
      if (!isPlainObject(snapshot) || !Array.isArray(snapshot.profiles)) throw new AuthProfileError('INVALID_PROFILE', 'restore needs a snapshot with a profiles array');
      const secrets = findSecretFields(snapshot);
      if (secrets.length) throw new AuthProfileError('PLAINTEXT_REFUSED', `refusing to restore a snapshot carrying secret material at ${secrets.join(', ')}`);
      const timestamp = at(when);
      const restored = [];
      const skipped = [];
      const degraded = [];
      for (const entry of snapshot.profiles) {
        if (!isPlainObject(entry) || !isText(entry.profile_id) || !AUTH_MODES.includes(entry.mode)) throw new AuthProfileError('INVALID_PROFILE', 'snapshot entry is not a valid profile reference');
        if (entry.persistence !== 'PERSISTENT' || !PERSISTABLE_MODES.includes(entry.mode)) { skipped.push(entry.profile_id ?? 'unknown'); continue; }
        const stored = {
          profile_id: entry.profile_id,
          profile_version: Number.isSafeInteger(entry.profile_version) ? entry.profile_version : 1,
          connector_kind: entry.connector_kind,
          mode: entry.mode,
          persistence: 'PERSISTENT',
          account_ref: entry.account_ref ?? null,
          expires_at: entry.expires_at ?? null,
          requires_user_action: entry.requires_user_action === true,
          handle_ref: entry.handle_ref ?? null,
          status: 'MISSING',
          reason: 'RESTORED',
          created_at: timestamp,
          updated_at: timestamp,
        };
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
        references_only: true,
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
     * Legacy DeepSeek .env discovery, bridged. The result is a NEUTRAL profile descriptor 鈥?it has no
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
      const profile_id = 'profile:default';
      const existing = profiles.get(profile_id);
      let bound = null;
      if (existing) {
        bound = bindSecret({ profile_id, expected_version: existing.profile_version, secret_value: env[source], at: when });
      } else {
        registerProfile({ profile_id, connector_kind: legacy.connector_kind, mode: legacy.mode, persistence: 'EPHEMERAL', at: when });
        bound = bindSecret({ profile_id, expected_version: 1, secret_value: env[source], at: when });
      }
      record('LEGACY_DISCOVERY', { legacy_source: source, profile_id });
      return freeze({
        discovered: true,
        legacy_source: source,
        mode: legacy.mode,
        connector_kind: legacy.connector_kind,
        secret_stored: bound.handle_ref !== null,
        secret_returned: false,
        profile: bound,
      });
    },
  };
}
