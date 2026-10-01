// Presence / offline / reconnect + audit (RF-009).
//
// Presence is honest and never collapses: ONLINE, OFFLINE, SLEEPING, BUSY, DEGRADED and UNREACHABLE stay
// distinct, so a sleeping laptop is not reported as up and an unreachable node is not reported as failed.
// Presence is *reachability* metadata 鈥?it never becomes task ownership or permission.
//
// Going offline has an explicit policy per action: queueable work carries a deadline and expires, while a
// non-queueable live action (a camera capture, a click, an unlock) is refused or expired rather than
// executing later out of its live context. A queue that never expires is not a queue this module offers.
//
// Reconnect is reconciliation, not resumption: identity, trust, capability and presence are refreshed,
// pending commands are reconciled, and any upper-layer authority/lease reference is revalidated before a
// side effect may run. A command whose outcome is unknown after transport loss stays UNKNOWN until it is
// reconciled, and a stale replay cannot duplicate a side effect that already completed.
//
// The audit log is append-only and carries causal identifiers (refs, states, classes) while never storing
// secret keys or private payload bodies.
//
// Pure module: the clock is injected; no network, storage or ambient state.
export const PRESENCE_CONTRACT_VERSION = 1;

export const PRESENCE_STATES = Object.freeze(['ONLINE', 'OFFLINE', 'SLEEPING', 'BUSY', 'DEGRADED', 'UNREACHABLE', 'UNKNOWN']);
export const REACHABLE_STATES = Object.freeze(['ONLINE', 'BUSY', 'DEGRADED']);
export const PATH_CLASSES = Object.freeze(['LAN_DIRECT', 'INTERNET_DIRECT', 'NAT_TRAVERSAL', 'RELAY', 'NONE']);
export const QUEUE_POLICIES = Object.freeze(['QUEUEABLE', 'LIVE_ONLY']);
export const PENDING_STATES = Object.freeze(['PENDING', 'UNKNOWN', 'CONFIRMED_SUCCEEDED', 'CONFIRMED_FAILED', 'EXPIRED', 'REFUSED', 'DUPLICATE_SUPPRESSED']);
export const AUDIT_KINDS = Object.freeze(['PAIRING', 'TRUST', 'SESSION', 'PATH', 'COMMAND', 'PRESENCE']);
export const RECONCILE_OUTCOMES = Object.freeze(['RESUMED', 'DROPPED_EXPIRED', 'DROPPED_LIVE_CONTEXT_LOST', 'DROPPED_UNKNOWN', 'DROPPED_NOT_REVALIDATED', 'DUPLICATE_SUPPRESSED']);

export const PRESENCE_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'INVALID_PRESENCE', 'UNKNOWN_NODE', 'LIVE_ACTION_NOT_QUEUEABLE',
  'DEADLINE_REQUIRED', 'ACTION_EXPIRED', 'NOT_REACHABLE', 'RECONCILIATION_REQUIRED', 'REVALIDATION_REQUIRED',
  'DUPLICATE_COMPLETED_EFFECT', 'UNKNOWN_OUTCOME', 'SECRET_MATERIAL_REFUSED', 'INVALID_AUDIT',
]);

const CONFLICT_CODES = new Set(['ACTION_EXPIRED', 'NOT_REACHABLE', 'RECONCILIATION_REQUIRED', 'REVALIDATION_REQUIRED', 'DUPLICATE_COMPLETED_EFFECT', 'UNKNOWN_OUTCOME', 'LIVE_ACTION_NOT_QUEUEABLE']);

export class PresenceError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PresenceError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_NODE' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/** Shape is not enough: a shape-valid but impossible instant parses to NaN and poisons every comparison. */
const isRealInstant = value => isIsoInstant(value) && Number.isFinite(Date.parse(value));

/** A caller-supplied instant is validated like the injected clock. */
const callerInstant = (value, label = 'at') => {
  if (!isRealInstant(value)) throw new PresenceError('INVALID_REQUEST', `${label} must be an ISO-8601 UTC instant such as 2026-01-01T00:00:00Z, got ${String(value)}`);
  return value;
};

/** Identifiers are text, so a cyclic object can never reach the deep freezer. */
const requireText = (value, label) => {
  if (!isText(value)) throw new PresenceError('INVALID_REQUEST', `${label} must be nonempty text when given`);
  return value;
};
const optionalText = (value, label) => (value === null || value === undefined ? null : requireText(value, label));

const SECRET_KEY_SHAPE = /(secret|token|password|api_?key|private_?key|session_key|key_material|^key$|body|payload_body|plaintext)/i;

/** Audit entries carry causal identifiers, never secrets or private payload bodies. */
export function findForbiddenAuditFields(value, path = 'audit', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenAuditFields(item, `${path}[${index}]`, found));
    return found;
  }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY_SHAPE.test(key) && !/_ref$/.test(key) && typeof child !== 'boolean') found.push(childPath);
    findForbiddenAuditFields(child, childPath, found);
  }
  return found;
}

export const DEFAULT_PRESENCE_POLICY = Object.freeze({
  policy_ref: 'policy:rf-presence-default',
  offline_after_ms: 60000,
  default_queue_deadline_ms: 300000,
  max_queue_deadline_ms: 3600000,
  max_audit_entries: 1000,
});

export function createPresenceTracker({ clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new PresenceError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) throw new PresenceError('INVALID_REQUEST', 'policy must be an object');
  const config = { ...DEFAULT_PRESENCE_POLICY, ...(policy ?? {}) };
  for (const key of ['offline_after_ms', 'default_queue_deadline_ms', 'max_queue_deadline_ms', 'max_audit_entries']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new PresenceError('INVALID_REQUEST', `policy.${key} must be a positive safe integer, got ${String(config[key])}`);
    }
  }
  if (config.default_queue_deadline_ms > config.max_queue_deadline_ms) {
    throw new PresenceError('INVALID_REQUEST', 'policy.default_queue_deadline_ms may not exceed policy.max_queue_deadline_ms');
  }
  const nodes = new Map();
  const pending = new Map();
  const completedEffects = new Map();
  const audit = [];
  let auditSeq = 0;
  let auditDropped = 0;
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new PresenceError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const append = ({ kind, at, node_ref = null, session_ref = null, path_ref = null, command_ref = null, action_ref = null, from_state = null, to_state = null, detail_ref = null, outcome = null }) => {
    if (!AUDIT_KINDS.includes(kind)) throw new PresenceError('INVALID_AUDIT', `audit kind must be one of ${AUDIT_KINDS.join(', ')}`);
    const candidate = {
      contract_version: PRESENCE_CONTRACT_VERSION,
      audit_seq: auditSeq + 1,
      kind, at, node_ref, session_ref, path_ref, command_ref, action_ref, from_state, to_state, detail_ref, outcome,
      contains_secret_material: false,
      contains_private_payload: false,
      append_only: true,
      causal_identifiers_present: Boolean(node_ref || session_ref || path_ref || command_ref || action_ref),
    };
    // The secret-freedom claim is checked rather than asserted: an entry may never carry secret
    // material or a private payload body, and a caller-supplied object could hide one.
    const forbidden = findForbiddenAuditFields(candidate, 'audit');
    if (forbidden.length > 0) {
      throw new PresenceError('SECRET_MATERIAL_REFUSED', `an audit entry may not carry secret material or payload bodies: ${forbidden.join(', ')}`, { refused_fields: freeze(forbidden), recorded: false });
    }
    if (audit.length >= config.max_audit_entries) { audit.shift(); auditDropped += 1; }
    auditSeq += 1;
    const entry = freeze({ ...candidate, audit_seq: auditSeq, retained_entries: audit.length + 1, dropped_entries: auditDropped });
    audit.push(entry);
    return entry;
  };

  const requireNode = node_ref => {
    const node = nodes.get(node_ref);
    if (!node) throw new PresenceError('UNKNOWN_NODE', `no presence record for ${String(node_ref)}`);
    return node;
  };

  /**
   * One identity predicate for a completed effect: an effect is identified by the action it performed
   * whenever an action ref is known, and by its command otherwise. confirmEffect, reconcile and
   * assertNotDuplicate must agree, or a replay would miss the recorded effect and run it twice.
   */
  const completedEffectFor = (node_ref, { action_ref = null, command_ref = null, subject = null } = {}) => {
    const wanted = subject ?? action_ref ?? command_ref;
    for (const [key, effect] of completedEffects) {
      if (!key.startsWith(`${node_ref}\u0000`)) continue;
      if ((action_ref !== null && action_ref !== undefined && effect.action_ref === action_ref)
        || (command_ref !== null && command_ref !== undefined && effect.command_ref === command_ref)
        || (wanted !== null && wanted !== undefined && key.endsWith(`\u0000${wanted}`))) return effect;
    }
    return null;
  };

  const project = (node, at) => {
    const ageMs = Date.parse(at) - Date.parse(node.last_seen_at);
    const timedOut = node.state !== 'OFFLINE' && node.state !== 'UNKNOWN' && ageMs > config.offline_after_ms;
    const state = timedOut ? 'UNREACHABLE' : node.state;
    return freeze({
      contract_version: PRESENCE_CONTRACT_VERSION,
      node_ref: node.node_ref,
      device_id: node.device_id,
      installation_id: node.installation_id,
      state,
      reported_state: node.state,
      reachable: REACHABLE_STATES.includes(state),
      last_seen_at: node.last_seen_at,
      last_seen_age_ms: ageMs,
      stale: timedOut,
      timed_out_from: timedOut ? node.state : null,
      path_class: node.path_class,
      quality: clone(node.quality),
      session_ref: node.session_ref,
      presence_is_reachability_only: true,
      presence_is_not_ownership: true,
      presence_grants_permission: false,
      logical_identity_preserved: true,
      at,
    });
  };

  const api = {
    policy: () => freeze(clone(config)),

    registerNode({ node_ref, device_id, installation_id = null, at: when } = {}) {
      if (!isText(node_ref) || !isText(device_id)) throw new PresenceError('INVALID_REQUEST', 'node_ref and device_id are required');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      if (Date.parse(at) > Date.parse(now())) throw new PresenceError('INVALID_REQUEST', 'an observation instant may not lie in the future');
      const installationRef = optionalText(installation_id, 'installation_id');
      // Logical identity is cryptographic and binding: if a presence record could be rebound to another
      // device, the rebind would satisfy reconcile()'s identity check and let one device resume another
      // device's queued work.
      const bound = nodes.get(node_ref) ?? null;
      if (bound !== null && (bound.device_id !== device_id || (bound.installation_id ?? null) !== installationRef)) {
        throw new PresenceError('INVALID_REQUEST', `node ${node_ref} is already bound to ${bound.device_id}${bound.installation_id ? `/${bound.installation_id}` : ''}; a presence record may not change its logical identity`, { node_ref, bound_device_id: bound.device_id, offered_device_id: device_id, rebound: false });
      }
      const node = {
        node_ref,
        device_id,
        installation_id: installationRef,
        state: 'UNKNOWN',
        last_seen_at: at,
        path_class: 'NONE',
        quality: { latency_ms: null, network_quality: null, power: null },
        session_ref: null,
      };
      nodes.set(node_ref, node);
      append({ kind: 'PRESENCE', at, node_ref, to_state: 'UNKNOWN', outcome: 'NODE_REGISTERED' });
      return project(node, at);
    },

    /** A reported state is preserved verbatim; only age turns it into UNREACHABLE. */
    observePresence({ node_ref, state, path_class = null, latency_ms = null, network_quality = null, power = null, session_ref = null, at: when } = {}) {
      const node = requireNode(node_ref);
      if (!PRESENCE_STATES.includes(state)) throw new PresenceError('INVALID_PRESENCE', `state must be one of ${PRESENCE_STATES.join(', ')}`);
      if (path_class !== null && !PATH_CLASSES.includes(path_class)) throw new PresenceError('INVALID_PRESENCE', `path_class must be one of ${PATH_CLASSES.join(', ')}`);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      if (Date.parse(at) > Date.parse(now())) throw new PresenceError('INVALID_REQUEST', 'an observation instant may not lie in the future');
      const sessionRef = optionalText(session_ref, 'session_ref');
      if (latency_ms !== null && latency_ms !== undefined && (!Number.isFinite(latency_ms) || latency_ms < 0)) {
        throw new PresenceError('INVALID_PRESENCE', 'latency_ms must be a non-negative number when given');
      }
      const previous = node.state;
      node.state = state;
      node.last_seen_at = at;
      if (path_class !== null) node.path_class = path_class;
      node.quality = freeze({
        latency_ms: latency_ms === null || latency_ms === undefined ? node.quality.latency_ms : latency_ms,
        network_quality: isText(network_quality) ? network_quality : node.quality.network_quality,
        power: isText(power) ? power : node.quality.power,
      });
      if (sessionRef !== null) node.session_ref = sessionRef;
      append({ kind: 'PRESENCE', at, node_ref, session_ref: node.session_ref, from_state: previous, to_state: state, outcome: 'OBSERVED' });
      return project(node, at);
    },

    presenceOf({ node_ref, at: when } = {}) {
      const node = requireNode(node_ref);
      return project(node, when === undefined || when === null ? now() : callerInstant(when));
    },

    /** Queue an action with an explicit offline policy. Live-only actions may not be queued. */
    enqueueAction({ command_ref, node_ref, action_ref = null, queue_policy = 'QUEUEABLE', deadline_at = null, requires_live_session = false, interaction_ref = null, at: when } = {}) {
      requireNode(node_ref);
      if (!isText(command_ref)) throw new PresenceError('INVALID_REQUEST', 'command_ref is required');
      if (!QUEUE_POLICIES.includes(queue_policy)) throw new PresenceError('INVALID_REQUEST', `queue_policy must be one of ${QUEUE_POLICIES.join(', ')}`);
  if (typeof requires_live_session !== 'boolean') throw new PresenceError('INVALID_REQUEST', 'requires_live_session must be a boolean when given, so a live action cannot be silently downgraded to queued work');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const actionRef = optionalText(action_ref, 'action_ref');
      const interactionRef = optionalText(interaction_ref, 'interaction_ref');
      // An outcome that is genuinely unknown stays unknown until it is reconciled: a replayed enqueue
      // would otherwise reset it to PENDING, and reconciliation would then resume a stale side effect.
      const tracked = pending.get(command_ref) ?? null;
      if (tracked !== null && tracked.state === 'UNKNOWN') {
        append({ kind: 'COMMAND', at, node_ref, command_ref, action_ref: actionRef, to_state: 'UNKNOWN', outcome: 'REPLAY_OF_UNKNOWN_OUTCOME_REFUSED' });
        throw new PresenceError('RECONCILIATION_REQUIRED', `command ${command_ref} has an unknown outcome and stays UNKNOWN until it is reconciled`, { command_ref, node_ref, state: 'UNKNOWN', queued: false, duplicate_side_effect_prevented: true });
      }
      if (queue_policy === 'LIVE_ONLY' || requires_live_session === true) {
        const node = requireNode(node_ref);
        const presence = project(node, at);
        const presenceAtClock = project(node, now());
        if (!presence.reachable || !presenceAtClock.reachable) {
          append({ kind: 'COMMAND', at, node_ref, command_ref, action_ref, to_state: 'REFUSED', outcome: 'LIVE_ACTION_WHILE_NOT_REACHABLE' });
          throw new PresenceError('LIVE_ACTION_NOT_QUEUEABLE', `a live action cannot be queued while ${node_ref} is ${presence.state}`, {
            command_ref, node_ref, presence_state: !presence.reachable ? presence.state : presenceAtClock.state, queued: false, expires_later: false,
            interactive_action_must_not_run_late: true,
          });
        }
        counter += 1;
        const record = { command_ref, node_ref, action_ref: actionRef, queue_policy: 'LIVE_ONLY', requires_live_session: true, deadline_at: at, state: 'PENDING', created_at: at, interaction_ref: interactionRef, live_context_at: at };
        pending.set(command_ref, record);
        append({ kind: 'COMMAND', at, node_ref, command_ref, action_ref, to_state: 'PENDING', outcome: 'LIVE_ACTION_ACCEPTED_NOW' });
        return freeze({ ...clone(record), accepted: true, queued: false, live_window_ms: 0 });
      }
      const deadline = deadline_at ?? new Date(Date.parse(at) + config.default_queue_deadline_ms).toISOString();
      if (!isRealInstant(deadline)) throw new PresenceError('DEADLINE_REQUIRED', 'a queueable action needs a real ISO-8601 deadline');
      if (Date.parse(deadline) <= Date.parse(at)) {
        append({ kind: 'COMMAND', at, node_ref, command_ref, action_ref, to_state: 'EXPIRED', outcome: 'ENQUEUE_AFTER_DEADLINE' });
        throw new PresenceError('ACTION_EXPIRED', `command ${command_ref} would be queued after its deadline ${deadline}`);
      }
      if (Date.parse(deadline) - Date.parse(at) > config.max_queue_deadline_ms) {
        throw new PresenceError('DEADLINE_REQUIRED', `a queued action may not outlive ${config.max_queue_deadline_ms}ms`);
      }
      counter += 1;
      const record = { command_ref, node_ref, action_ref: actionRef, queue_policy: 'QUEUEABLE', requires_live_session: false, deadline_at: deadline, state: 'PENDING', created_at: at, interaction_ref: interactionRef, live_context_at: null };
      pending.set(command_ref, record);
      append({ kind: 'COMMAND', at, node_ref, command_ref, action_ref, to_state: 'PENDING', outcome: 'QUEUED' });
      return freeze({ ...clone(record), accepted: true, queued: true, queue_expires_at: deadline });
    },

    /** Record a transport loss whose outcome for a command is genuinely unknown. */
    markOutcomeUnknown({ command_ref, reason = 'TRANSPORT_LOST', at: when } = {}) {
      const record = pending.get(command_ref);
      if (!record) throw new PresenceError('INVALID_REQUEST', `no pending command ${String(command_ref)}`);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      if (['CONFIRMED_SUCCEEDED', 'CONFIRMED_FAILED', 'EXPIRED', 'REFUSED', 'DUPLICATE_SUPPRESSED'].includes(record.state)) {
        throw new PresenceError('INVALID_REQUEST', `command ${command_ref} is already ${record.state}; a settled outcome is not regressed to UNKNOWN`, { command_ref, existing_state: record.state, recorded: false });
      }
      const unknownReason = requireText(reason, 'reason');
      record.state = 'UNKNOWN';
      record.unknown_reason = unknownReason;
      append({ kind: 'COMMAND', at, node_ref: record.node_ref, command_ref, action_ref: record.action_ref, to_state: 'UNKNOWN', outcome: reason });
      return freeze({
        contract_version: PRESENCE_CONTRACT_VERSION,
        command_ref,
        state: 'UNKNOWN',
        reported_success: false,
        reported_failure: false,
        reconciliation_required: true,
        unknown_outcome_is_not_success: true,
        at,
      });
    },

    /**
     * Reconnect reconciliation: refresh identity/trust/capability/presence, reconcile pending commands, and
     * revalidate any upper-layer authority before a side effect resumes.
     */
    reconcile({ node_ref, refreshed, authority, at: when } = {}) {
      const node = requireNode(node_ref);
      if (!isPlainObject(refreshed)) throw new PresenceError('INVALID_REQUEST', 'refreshed identity/trust/capability/presence state is required');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const refreshedSessionRef = optionalText(refreshed.session_ref, 'refreshed.session_ref');
      const trustOk = refreshed.trust_state === 'TRUSTED';
      const capabilityOk = refreshed.capability_available === true;
      const identityOk = refreshed.device_id === node.device_id;
      const presenceOk = REACHABLE_STATES.includes(refreshed.presence_state ?? '');
      const authorityOk = isPlainObject(authority) && authority.lease_valid === true && isText(authority.lease_ref);
      if (refreshed.presence_state !== undefined && PRESENCE_STATES.includes(refreshed.presence_state)) {
        const previous = node.state;
        node.state = refreshed.presence_state;
        node.last_seen_at = at;
        append({ kind: 'PRESENCE', at, node_ref, from_state: previous, to_state: node.state, outcome: 'RECONNECT_REFRESH' });
      }
      const decisionInstant = now();
      const outcomes = [];
      for (const record of [...pending.values()]) {
        if (record.node_ref !== node_ref) continue;
        // Expiry and live-context loss are judged at the registry clock as well as at the claimed
        // instant, otherwise a caller could backdate reconciliation and resume a stale side effect.
        const expired = Date.parse(record.deadline_at) <= Date.parse(at) || Date.parse(record.deadline_at) <= Date.parse(decisionInstant);
        const liveContextLost = Date.parse(at) - Date.parse(record.live_context_at) > 0 || Date.parse(decisionInstant) - Date.parse(record.live_context_at) > 0;
        if (record.queue_policy === 'LIVE_ONLY' && liveContextLost) {
          record.state = 'EXPIRED';
          outcomes.push({ command_ref: record.command_ref, outcome: 'DROPPED_LIVE_CONTEXT_LOST', executed: false });
          append({ kind: 'COMMAND', at, node_ref, command_ref: record.command_ref, to_state: 'EXPIRED', outcome: 'DROPPED_LIVE_CONTEXT_LOST' });
          continue;
        }
        if (expired) {
          record.state = 'EXPIRED';
          outcomes.push({ command_ref: record.command_ref, outcome: 'DROPPED_EXPIRED', executed: false, expired_at: record.deadline_at });
          append({ kind: 'COMMAND', at, node_ref, command_ref: record.command_ref, to_state: 'EXPIRED', outcome: 'DROPPED_EXPIRED' });
          continue;
        }
        if (record.state === 'UNKNOWN') {
          outcomes.push({ command_ref: record.command_ref, outcome: 'DROPPED_UNKNOWN', executed: false, reconciliation_required: true });
          append({ kind: 'COMMAND', at, node_ref, command_ref: record.command_ref, to_state: 'UNKNOWN', outcome: 'UNKNOWN_OUTCOME_UNRECONCILED' });
          continue;
        }
        if (!(trustOk && capabilityOk && identityOk && presenceOk && authorityOk)) {
          record.state = 'REFUSED';
          outcomes.push({ command_ref: record.command_ref, outcome: 'DROPPED_NOT_REVALIDATED', executed: false, reason: !trustOk ? 'TRUST_NOT_REFRESHED' : !capabilityOk ? 'CAPABILITY_NOT_REFRESHED' : !identityOk ? 'IDENTITY_MISMATCH' : !presenceOk ? 'PRESENCE_NOT_REACHABLE' : 'AUTHORITY_NOT_REVALIDATED' });
          append({ kind: 'COMMAND', at, node_ref, command_ref: record.command_ref, to_state: 'REFUSED', outcome: 'DROPPED_NOT_REVALIDATED' });
          continue;
        }
        // A stale replay must not duplicate an effect that already completed. The predicate is the
        // same one confirmEffect filed the effect under and assertNotDuplicate enforces.
        const completed = completedEffectFor(record.node_ref, { action_ref: record.action_ref, command_ref: record.command_ref });
        if (completed !== null) {
          record.state = 'DUPLICATE_SUPPRESSED';
          outcomes.push({ command_ref: record.command_ref, outcome: 'DUPLICATE_SUPPRESSED', executed: false, completed_effect_ref: completed.effect_ref });
          append({ kind: 'COMMAND', at, node_ref, command_ref: record.command_ref, to_state: 'DUPLICATE_SUPPRESSED', outcome: 'DUPLICATE_SUPPRESSED' });
          continue;
        }
        record.state = 'PENDING';
        outcomes.push({ command_ref: record.command_ref, outcome: 'RESUMED', executed: false, requires_caller_dispatch: true });
        append({ kind: 'COMMAND', at, node_ref, command_ref: record.command_ref, to_state: 'PENDING', outcome: 'RESUMED' });
      }
      append({ kind: 'SESSION', at, node_ref, session_ref: refreshedSessionRef ?? node.session_ref, outcome: 'RECONCILED' });
      return freeze({
        contract_version: PRESENCE_CONTRACT_VERSION,
        node_ref,
        device_id: node.device_id,
        identity_preserved: identityOk,
        trust_refreshed: trustOk,
        capability_refreshed: capabilityOk,
        presence_reachable: presenceOk,
        authority_revalidated: authorityOk,
        presence: project(node, at),
        outcomes: freeze(outcomes),
        resumed_commands: freeze(outcomes.filter(entry => entry.outcome === 'RESUMED').map(entry => entry.command_ref)),
        dropped_commands: freeze(outcomes.filter(entry => entry.outcome !== 'RESUMED').map(entry => entry.command_ref)),
        stale_local_state_used_as_authority: false,
        side_effects_resumed_without_revalidation: false,
        at,
      });
    },

    /** Confirm an effect so a later replay can be suppressed rather than repeated. */
    confirmEffect({ node_ref, effect_ref, command_ref = null, action_ref = null, outcome = 'CONFIRMED_SUCCEEDED', at: when } = {}) {
      requireNode(node_ref);
      if (!isText(effect_ref)) throw new PresenceError('INVALID_REQUEST', 'effect_ref is required');
      if (!['CONFIRMED_SUCCEEDED', 'CONFIRMED_FAILED'].includes(outcome)) throw new PresenceError('INVALID_REQUEST', 'outcome must be CONFIRMED_SUCCEEDED or CONFIRMED_FAILED');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const pendingActionRef = command_ref !== null ? pending.get(command_ref)?.action_ref ?? null : null;
      // The action is recorded whenever it is known — from the caller or from the in-flight command —
      // so a later replay that carries only the action ref still finds the effect.
      const boundActionRef = optionalText(action_ref, 'action_ref') ?? pendingActionRef;
      const key = `${node_ref}\u0000${boundActionRef ?? command_ref ?? effect_ref}`;
      completedEffects.set(key, freeze({ effect_ref, node_ref, command_ref, action_ref: boundActionRef, outcome, at }));
      if (command_ref !== null && pending.has(command_ref)) pending.get(command_ref).state = outcome;
      append({ kind: 'COMMAND', at, node_ref, command_ref, detail_ref: effect_ref, to_state: outcome, outcome });
      return freeze({ contract_version: PRESENCE_CONTRACT_VERSION, effect_ref, node_ref, command_ref, outcome, recorded: true, duplicate_suppression_armed: true, at });
    },

    /** A late replay of a completed effect is refused rather than repeated. */
    assertNotDuplicate({ node_ref, action_ref = null, command_ref = null, at: when } = {}) {
      requireNode(node_ref);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const actionRef = optionalText(action_ref, 'action_ref');
      const commandRef = optionalText(command_ref, 'command_ref');
      const subject = actionRef ?? commandRef;
      if (subject === null) throw new PresenceError('INVALID_REQUEST', 'assertNotDuplicate needs an action_ref or a command_ref to identify the effect');
      const effect = completedEffectFor(node_ref, { action_ref: actionRef, command_ref: commandRef, subject });
      if (effect !== null) {
        append({ kind: 'COMMAND', at, node_ref, command_ref: commandRef, action_ref: actionRef, outcome: 'DUPLICATE_COMPLETED_EFFECT' });
        throw new PresenceError('DUPLICATE_COMPLETED_EFFECT', `an effect for ${subject} already completed on ${node_ref}`, {
          node_ref, action_ref: actionRef, command_ref: commandRef, completed_effect_ref: effect.effect_ref, executed: false,
        });
      }
      return freeze({ contract_version: PRESENCE_CONTRACT_VERSION, node_ref, duplicate: false, at });
    },

    /** An unreachable node refuses new work instead of pretending it succeeded. */
    assertReachable({ node_ref, at: when } = {}) {
      const node = requireNode(node_ref);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const presence = project(node, at);
      // Reachability is judged at the registry clock as well: a backdated instant must not make a
      // silent node look reachable to the path that refuses new work.
      const presenceAtClock = project(node, now());
      if (!presence.reachable || !presenceAtClock.reachable) {
        const state = !presence.reachable ? presence.state : presenceAtClock.state;
        append({ kind: 'PRESENCE', at, node_ref, to_state: state, outcome: 'NOT_REACHABLE' });
        throw new PresenceError('NOT_REACHABLE', `${node_ref} is ${state}`, {
          node_ref, presence_state: state, reachable: false, pretended_success: false,
        });
      }
      return presence;
    },

    pendingCommands: ({ node_ref = null } = {}) => clone([...pending.values()].filter(record => node_ref === null || record.node_ref === node_ref)).map(record => freeze(record)),
    completedEffects: () => clone([...completedEffects.values()]),
    auditLog: () => clone(audit),
    auditFor: ({ node_ref } = {}) => clone(audit.filter(entry => entry.node_ref === node_ref)),
  };
  return Object.freeze(api);
}
