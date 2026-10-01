// Duties, permission + proactivity policy (BA-009).
//
// What each assistant is responsible for, and how much initiative it may take — defined as assistant-owned
// policy that can never manufacture authority.
//
// The normative equation is enforced literally:
//
//   EffectivePermission = User/OwnerPolicy ∩ AssistantPolicy ∩ DeviceCapability ∩ TaskActionGrant
//
// A valid execution lease is an additional execution-safety prerequisite and is **not** a permission source:
// a lease proves which executor may act, it does not make a forbidden capability legal. Persona, profile,
// relationship state, foreground binding and a handoff payload contribute nothing, and a handoff to a
// less-privileged assistant stays less privileged because the recipient recomputes its own permission.
//
// Two assistants can hold different duties and proactivity levels while sharing the same authorized
// Digital-Me context, and changing duties never touches canonical user data.
//
// This module contributes an AssistantPolicy into the Shared Core policy contract; it deliberately is not a
// second global policy engine, and the target device (Remote Fabric) revalidates the same effective decision.
//
// Pure module: the clock is injected; no storage, network or ambient state.
export const DUTY_POLICY_CONTRACT_VERSION = 1;

export const POLICY_AXES = Object.freeze(['USER_OWNER_POLICY', 'ASSISTANT_POLICY', 'DEVICE_CAPABILITY', 'TASK_ACTION_GRANT']);
export const PROACTIVITY_LEVELS = Object.freeze(['SILENT', 'NOTIFY', 'SUGGEST', 'ACT_WITH_CONFIRMATION', 'ACT_AUTONOMOUSLY']);
export const DUTY_KINDS = Object.freeze(['IN_DUTY', 'OUT_OF_DUTY', 'DELEGATE', 'REFUSE']);
export const DECISIONS = Object.freeze(['ALLOWED', 'DENIED', 'CONFIRMATION_REQUIRED', 'PROACTIVE_NOTIFICATION', 'DELEGATED', 'REFUSED']);
export const CHANGE_TRIGGERS = Object.freeze(['HANDOFF', 'EXECUTOR_CHANGE', 'DEVICE_CHANGE', 'RECONNECT', 'CAPABILITY_CHANGE', 'DUTY_CHANGE']);
export const DENIAL_AXES = Object.freeze(['USER_OWNER_POLICY', 'ASSISTANT_POLICY', 'DEVICE_CAPABILITY', 'TASK_ACTION_GRANT']);
export const DIGITAL_ME_RELATIONSHIP = 'DIGITAL_ME_CANONICAL';

export const DUTY_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'UNKNOWN_ASSISTANT', 'DUPLICATE_ASSISTANT', 'OUT_OF_DUTY',
  'PERMISSION_DENIED', 'PERMISSION_RECOMPUTE_REQUIRED', 'LEASE_IS_NOT_PERMISSION', 'PERSONA_IS_NOT_PERMISSION',
  'HANDOFF_CANNOT_ELEVATE', 'DIGITAL_ME_IS_READ_ONLY', 'CAPABILITY_MISSING', 'PROACTIVITY_LIMIT',
  'CONFIRMATION_REQUIRED', 'DELEGATION_REQUIRED', 'NOT_THE_RECOMPUTING_ASSISTANT',
]);

const CONFLICT_CODES = new Set(['OUT_OF_DUTY', 'PERMISSION_DENIED', 'PERMISSION_RECOMPUTE_REQUIRED', 'HANDOFF_CANNOT_ELEVATE', 'CAPABILITY_MISSING', 'PROACTIVITY_LIMIT', 'CONFIRMATION_REQUIRED', 'DELEGATION_REQUIRED']);

export class DutyPolicyError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'DutyPolicyError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_ASSISTANT' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
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
/** Cycle-safe: a caller-supplied structure must not be able to blow the stack. */
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

const POLICY_KEYS = Object.freeze(['policy_ref', 'proactivity_ceiling', 'notification_audiences', 'confirmation_required_for_proactivity']);
/** Keys a handoff may carry. Anything authority-bearing is refused whatever its shape. */
const HANDOFF_ALLOWED_KEYS = Object.freeze(['responsibility_ref', 'checkpoint_ref', 'evidence_refs', 'from_assistant_ref', 'to_assistant_ref', 'task_ref', 'reason']);
const HANDOFF_AUTHORITY_KEYS = Object.freeze(['grants', 'grant', 'permissions', 'permission', 'capabilities', 'capability', 'scopes', 'scope', 'roles', 'role', 'allow', 'allowed', 'elevate', 'authority']);

function validateDutyPolicy(config) {
  const errors = [];
  for (const key of Reflect.ownKeys(config)) {
    if (typeof key !== 'string' || !POLICY_KEYS.includes(key)) errors.push('policy.' + String(key) + ' is not part of the duty policy');
  }
  if (!isText(config.policy_ref)) errors.push('policy.policy_ref must be nonempty text');
  if (!PROACTIVITY_LEVELS.includes(config.proactivity_ceiling)) errors.push('policy.proactivity_ceiling must be one of ' + PROACTIVITY_LEVELS.join(', '));
  if (!Array.isArray(config.confirmation_required_for_proactivity) || config.confirmation_required_for_proactivity.some(level => !PROACTIVITY_LEVELS.includes(level))) {
    errors.push('policy.confirmation_required_for_proactivity must be a list of proactivity levels');
  }
  if (!Array.isArray(config.notification_audiences) || config.notification_audiences.some(audience => !isText(audience))) {
    errors.push('policy.notification_audiences must be a list of audience references');
  }
  if (errors.length) throw new DutyPolicyError('INVALID_REQUEST', errors.join('; '));
  return config;
}

export const DEFAULT_DUTY_POLICY = Object.freeze({
  policy_ref: 'policy:ba-duty-default',
  proactivity_ceiling: 'ACT_WITH_CONFIRMATION',
  notification_audiences: Object.freeze(['USER']),
  confirmation_required_for_proactivity: Object.freeze(['ACT_WITH_CONFIRMATION', 'ACT_AUTONOMOUSLY']),
});

const PROACTIVITY_RANK = Object.freeze(Object.fromEntries(PROACTIVITY_LEVELS.map((level, index) => [level, index])));

let REGISTRY_SEQ = 0;

export function createDutyPolicyRegistry({ clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new DutyPolicyError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) throw new DutyPolicyError('INVALID_REQUEST', 'policy must be a plain object');
  const config = validateDutyPolicy({ ...DEFAULT_DUTY_POLICY, ...(isPlainObject(policy) ? policy : {}) });
  const duties = new Map();
  const decisions = new Map();
  const journal = [];
  let counter = 0;
  REGISTRY_SEQ += 1;
  const registry_token = REGISTRY_SEQ;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new DutyPolicyError('INVALID_CLOCK', 'clock() must return a real ISO-8601 UTC instant');
    return produced;
  };

  /** A caller-supplied instant is validated: a recorded timestamp is evidence, including its reality. */
  const atFrom = when => {
    if (when === undefined || when === null) return now();
    if (!isRealInstant(when)) throw new DutyPolicyError('INVALID_REQUEST', `at must be a real ISO-8601 UTC instant, got ${String(when)}`);
    return when;
  };

  /** A handoff may carry responsibility and references; anything else is an elevation attempt. */
  const assertHandoffCarriesNoAuthority = handoff => {
    if (handoff === null || handoff === undefined) return null;
    if (!isPlainObject(handoff)) throw new DutyPolicyError('HANDOFF_CANNOT_ELEVATE', 'a handoff payload must be a plain record', { recipient_elevated: false, elevation_applied: false });
    for (const key of Reflect.ownKeys(handoff)) {
      const name = typeof key === 'string' ? key : String(key);
      if (HANDOFF_AUTHORITY_KEYS.includes(name) || !HANDOFF_ALLOWED_KEYS.includes(name)) {
        throw new DutyPolicyError('HANDOFF_CANNOT_ELEVATE', `a handoff payload may not carry ${name}; the recipient recomputes its own permission`, {
          payload_key: name, recipient_elevated: false, elevation_applied: false, authority_keys: freeze([...HANDOFF_AUTHORITY_KEYS]),
        });
      }
    }
    return handoff;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const requireDuty = assistant_ref => {
    const duty = duties.get(assistant_ref);
    if (!duty) throw new DutyPolicyError('UNKNOWN_ASSISTANT', `no duty policy for ${String(assistant_ref)}`);
    return duty;
  };

  /**
   * The effective permission. Every axis must hold, and the function publishes that a lease, persona,
   * profile or foreground binding contributed nothing.
   */
  const evaluate = ({ assistant_ref, axes = {}, context = {} }) => {
    const values = {
      USER_OWNER_POLICY: axes.user_owner_policy === true,
      // The assistant axis is the assistant policy this registry owns: an in-duty action inside the
      // deployment ceiling. A caller may only narrow it, never assert it on the assistant's behalf.
      ASSISTANT_POLICY: context.assistant_policy_holds === true && axes.assistant_policy !== false,
      DEVICE_CAPABILITY: axes.device_capability === true,
      TASK_ACTION_GRANT: axes.task_action_grant === true,
    };
    const missing = POLICY_AXES.filter(axis => values[axis] !== true);
    return freeze({
      contract_version: DUTY_POLICY_CONTRACT_VERSION,
      assistant_ref,
      granted: missing.length === 0,
      axes: freeze(values),
      denied_axes: freeze(missing),
      permission_is_intersectional: true,
      lease_is_not_permission: true,
      lease_ref: context.lease_ref ?? null,
      lease_present: isText(context.lease_ref),
      // The three Core-owned axes and a lease's validity are supplied by the caller; this module cannot
      // verify them, and it says so rather than implying it did.
      caller_declared_axes: freeze(['USER_OWNER_POLICY', 'DEVICE_CAPABILITY', 'TASK_ACTION_GRANT']),
      core_axes_verified_here: false,
      lease_validity_source: 'CALLER_DECLARED',
      lease_verified_here: false,
      lease_does_not_grant_forbidden_capability: true,
      persona_is_not_permission: true,
      profile_is_not_permission: true,
      relationship_state_is_not_permission: true,
      foreground_is_not_permission: true,
      active_changes: freeze(context.active_changes ?? []),
      recomputed_at: context.recomputed_at ?? null,
    });
  };

  const api = {
    policy: () => freeze(clone(config)),
    axes: () => freeze([...POLICY_AXES]),
    proactivityLevels: () => freeze([...PROACTIVITY_LEVELS]),
    /** AssistantPolicy is contributed into Shared Core, not owned by a second engine. */
    sharedCoreContribution() {
      return freeze({
        contract_version: DUTY_POLICY_CONTRACT_VERSION,
        contributes_to: 'SHARED_CORE_POLICY_CONTRACT',
        is_second_global_policy_engine: false,
        root_core_authority_moved: false,
        fabric_revalidates_effective_decision: true,
        axes: freeze([...POLICY_AXES]),
        equation: 'USER_OWNER_POLICY ∩ ASSISTANT_POLICY ∩ DEVICE_CAPABILITY ∩ TASK_ACTION_GRANT',
      });
    },

    /** Duties and proactivity are assistant-owned policy; canonical user data is never written. */
    setDutyPolicy({ assistant_ref, duties: duty_refs = [], proactivity = 'NOTIFY', confirmation_required = null, notification_audiences = null, at: when } = {}) {
      if (!isText(assistant_ref)) throw new DutyPolicyError('INVALID_REQUEST', 'assistant_ref is required');
      if (!Array.isArray(duty_refs) || duty_refs.some(duty => !isText(duty))) throw new DutyPolicyError('INVALID_REQUEST', 'duties must be an array of duty references');
      if (!PROACTIVITY_LEVELS.includes(proactivity)) throw new DutyPolicyError('INVALID_REQUEST', `proactivity must be one of ${PROACTIVITY_LEVELS.join(', ')}`);
      if (PROACTIVITY_RANK[proactivity] > PROACTIVITY_RANK[config.proactivity_ceiling]) {
        throw new DutyPolicyError('PROACTIVITY_LIMIT', `${assistant_ref} may not exceed the deployment ceiling ${config.proactivity_ceiling}`, {
          assistant_ref, requested: proactivity, ceiling: config.proactivity_ceiling, independent_of_digital_me: true,
        });
      }
      if (confirmation_required !== null && confirmation_required !== undefined && typeof confirmation_required !== 'boolean') {
        throw new DutyPolicyError('INVALID_REQUEST', 'confirmation_required must be a boolean when supplied');
      }
      if (notification_audiences !== null && notification_audiences !== undefined
        && (!Array.isArray(notification_audiences) || notification_audiences.some(audience => !isText(audience)))) {
        throw new DutyPolicyError('INVALID_REQUEST', 'notification_audiences must be a list of audience references');
      }
      const at = atFrom(when);
      // The deployment policy sets a confirmation floor for high proactivity; an assistant policy may add to
      // it but may not switch it off for a level the deployment requires.
      const policyRequiresConfirmation = config.confirmation_required_for_proactivity.includes(proactivity);
      const duty = {
        assistant_ref,
        duties: freeze([...new Set(duty_refs)]),
        proactivity,
        confirmation_required: policyRequiresConfirmation || confirmation_required === true,
        notification_audiences: freeze([...new Set(notification_audiences ?? [...config.notification_audiences])]),
        updated_at: at,
        revision: (duties.get(assistant_ref)?.revision ?? 0) + 1,
        source: 'ASSISTANT_OWNED_POLICY',
        writes_digital_me: false,
      };
      duties.set(assistant_ref, duty);
      note('DUTY_POLICY_SET', at, { assistant_ref, proactivity });
      return freeze(clone(duty));
    },

    dutyPolicy: assistant_ref => {
      const duty = duties.get(assistant_ref);
      return duty ? freeze(clone(duty)) : null;
    },

    /** Is this action within the assistant's duties at all? Out-of-duty is refused or delegated, never granted. */
    checkDuty({ assistant_ref, action_ref, duty_ref = null, at: when } = {}) {
      const duty = requireDuty(assistant_ref);
      if (!isText(action_ref)) throw new DutyPolicyError('INVALID_REQUEST', 'action_ref is required');
      const at = atFrom(when);
      const required = duty_ref ?? action_ref;
      const inDuty = duty.duties.includes(required) || duty.duties.includes('*');
      note(inDuty ? 'DUTY_MATCHED' : 'DUTY_MISSED', at, { assistant_ref, action_ref, required });
      return freeze({
        contract_version: DUTY_POLICY_CONTRACT_VERSION,
        assistant_ref,
        action_ref,
        required_duty_ref: required,
        duty_kind: inDuty ? 'IN_DUTY' : 'OUT_OF_DUTY',
        in_duty: inDuty,
        underlying_permissions_changed: false,
        delegated_to: inDuty ? null : 'SHARED_CORE_DUTY_MATCHER',
        at,
      });
    },

    /**
     * The single decision entry point. Duty, permission, capability and proactivity are all considered, and a
     * lease is validated as an execution-safety prerequisite only.
     */
    decide({ assistant_ref, action_ref, duty_ref = null, axes = {}, capability_ref = null, capability_available = true, lease = null, handoff = null, at: when } = {}) {
      const duty = requireDuty(assistant_ref);
      if (!isText(action_ref)) throw new DutyPolicyError('INVALID_REQUEST', 'action_ref is required');
      if (typeof capability_available !== 'boolean') throw new DutyPolicyError('INVALID_REQUEST', 'capability_available must be true or false');
      if (capability_ref !== null && !isText(capability_ref)) throw new DutyPolicyError('INVALID_REQUEST', 'capability_ref must be a reference when supplied');
      const at = atFrom(when);
      counter += 1;
      // Ids are scoped to the registry that minted them: a bare counter collides across registries.
      const decision_id = `decision:${registry_token}:${counter}`;
      const required = duty_ref ?? action_ref;
      // The duty check is bound to the ACTION. A caller-supplied duty reference that the assistant happens
      // to hold can no longer stand in for an action it is not in duty for; it only narrows the decision.
      const actionInDuty = duty.duties.includes(action_ref) || duty.duties.includes('*');
      const namedDutyInDuty = duty_ref === null ? true : duty.duties.includes(duty_ref) || duty.duties.includes('*');
      const inDuty = actionInDuty && namedDutyInDuty;

      // A handoff payload can never elevate: the recipient's own duty policy and axes are what count, and
      // any authority-bearing key is refused whatever its shape (an object or string "grants" used to pass).
      try {
        assertHandoffCarriesNoAuthority(handoff);
      } catch (error) {
        note('HANDOFF_ELEVATION_REFUSED', at, { assistant_ref, payload_key: error.payload_key ?? null });
        throw error;
      }

      const effective = evaluate({
        assistant_ref,
        axes,
        context: { lease_ref: lease?.lease_ref ?? null, recomputed_at: at, active_changes: handoff !== null ? ['HANDOFF'] : [], assistant_policy_holds: inDuty },
      });
      // A lease is usable only if it is declared valid, unexpired and held by this assistant. An expired or
      // foreign lease is not execution safety either.
      const leaseExpiresAt = isPlainObject(lease) && lease.expires_at !== undefined && lease.expires_at !== null ? lease.expires_at : null;
      if (leaseExpiresAt !== null && !isRealInstant(leaseExpiresAt)) {
        throw new DutyPolicyError('INVALID_REQUEST', `lease.expires_at must be a real ISO-8601 UTC instant, got ${String(leaseExpiresAt)}`);
      }
      const leaseHolder = isPlainObject(lease) && isText(lease.holder_ref) ? lease.holder_ref : null;
      const leaseUnexpired = leaseExpiresAt === null || Date.parse(leaseExpiresAt) > Date.parse(at);
      const leaseHeldHere = leaseHolder === null || leaseHolder === assistant_ref;
      const leaseUsable = isPlainObject(lease) && lease.lease_valid === true && isText(lease.lease_ref) && leaseUnexpired && leaseHeldHere;
      const proactivityRank = PROACTIVITY_RANK[duty.proactivity];
      const result = {
        contract_version: DUTY_POLICY_CONTRACT_VERSION,
        decision_id,
        assistant_ref,
        action_ref,
        required_duty_ref: required,
        duty_kind: inDuty ? 'IN_DUTY' : 'OUT_OF_DUTY',
        action_in_duty: actionInDuty,
        duty_ref_in_duty: namedDutyInDuty,
        effective_permission: effective,
        capability_ref,
        capability_available,
        lease_ref: lease?.lease_ref ?? null,
        lease_usable: leaseUsable,
        proactivity: duty.proactivity,
        permission_recomputed: true,
        uses_cached_permission: false,
        at,
      };

      if (!inDuty) {
        // Out-of-duty is refused or delegated; the underlying permission is untouched.
        decisions.set(decision_id, freeze({ ...result, decision: 'REFUSED', reason: 'OUT_OF_DUTY' }));
        return freeze({ ...result, decision: 'REFUSED', reason: 'OUT_OF_DUTY', underlying_permissions_changed: false, executed: false });
      }
      if (!effective.granted) {
        decisions.set(decision_id, freeze({ ...result, decision: 'DENIED', reason: 'PERMISSION_DENIED' }));
        return freeze({ ...result, decision: 'DENIED', reason: 'PERMISSION_DENIED', denied_axes: effective.denied_axes, executed: false, lease_would_not_help: leaseUsable });
      }
      if (capability_available !== true) {
        // Moving execution to a device without the capability blocks the action even for an authorized owner.
        decisions.set(decision_id, freeze({ ...result, decision: 'DENIED', reason: 'CAPABILITY_MISSING' }));
        return freeze({ ...result, decision: 'DENIED', reason: 'CAPABILITY_MISSING', capability_ref, task_owner_authorized: true, executed: false, lease_would_not_help: leaseUsable });
      }
      if (PROACTIVITY_RANK[duty.proactivity] >= PROACTIVITY_RANK['ACT_WITH_CONFIRMATION'] && duty.confirmation_required === true) {
        decisions.set(decision_id, freeze({ ...result, decision: 'CONFIRMATION_REQUIRED', reason: 'PROACTIVITY_REQUIRES_CONFIRMATION' }));
        return freeze({ ...result, decision: 'CONFIRMATION_REQUIRED', reason: 'PROACTIVITY_REQUIRES_CONFIRMATION', confirmation_required: true, executed: false, lease_would_not_help: false });
      }
      decisions.set(decision_id, freeze({ ...result, decision: 'ALLOWED', reason: 'ALL_AXES_SATISFIED' }));
      return freeze({ ...result, decision: 'ALLOWED', reason: 'ALL_AXES_SATISFIED', executed: false, execution_safety_prerequisite: leaseUsable ? 'LEASE_VALID' : 'LEASE_REQUIRED_FOR_SIDE_EFFECTS' });
    },

    /** Proactive initiative is bounded by the assistant's level and its notification audiences. */
    proactiveNotice({ assistant_ref, topic_ref, audience = 'USER', at: when } = {}) {
      const duty = requireDuty(assistant_ref);
      if (!isText(topic_ref)) throw new DutyPolicyError('INVALID_REQUEST', 'topic_ref is required');
      const at = atFrom(when);
      const allowedAudiences = duty.notification_audiences;
      if (!allowedAudiences.includes(audience)) {
        return freeze({
          contract_version: DUTY_POLICY_CONTRACT_VERSION,
          assistant_ref,
          decision: 'REFUSED',
          reason: 'PROACTIVITY_LIMIT',
          requested_audience: audience,
          allowed_audiences: allowedAudiences,
          proactive: true,
          user_permission_unchanged: true,
          at,
        });
      }
      const level = duty.proactivity;
      const decision = level === 'SILENT' ? 'REFUSED' : level === 'NOTIFY' || level === 'SUGGEST' ? 'PROACTIVE_NOTIFICATION' : 'CONFIRMATION_REQUIRED';
      note('PROACTIVE_NOTICE', at, { assistant_ref, topic_ref, decision });
      return freeze({
        contract_version: DUTY_POLICY_CONTRACT_VERSION,
        assistant_ref,
        topic_ref,
        audience,
        proactivity: level,
        decision,
        reason: decision === 'REFUSED' ? 'SILENT_ASSISTANT' : decision === 'CONFIRMATION_REQUIRED' ? 'INITIATIVE_REQUIRES_CONFIRMATION' : 'NOTIFICATION_ONLY',
        initiative_executed: false,
        user_permission_unchanged: true,
        at,
      });
    },

    /**
     * Permission is recomputed after a handoff, executor/device change, reconnect or capability change; a
     * cached decision is never reused across such a change.
     */
    recomputeForChange({ assistant_ref, action_ref, trigger, axes = {}, capability_available = true, lease = null, at: when } = {}) {
      if (!CHANGE_TRIGGERS.includes(trigger)) throw new DutyPolicyError('INVALID_REQUEST', `trigger must be one of ${CHANGE_TRIGGERS.join(', ')}`);
      requireDuty(assistant_ref);
      const at = atFrom(when);
      const decision = api.decide({ assistant_ref, action_ref, axes, capability_available, lease, at });
      // A decision made before this change is not current authority: earlier decisions about the same
      // assistant and action are marked superseded rather than left readable as if still valid.
      for (const [previous_id, previous] of decisions) {
        if (previous_id === decision.decision_id) continue;
        if (previous.assistant_ref === assistant_ref && previous.action_ref === action_ref && previous.superseded_by === undefined) {
          decisions.set(previous_id, freeze({ ...previous, superseded_by: decision.decision_id }));
        }
      }
      note('PERMISSION_RECOMPUTED', at, { assistant_ref, trigger });
      return freeze({
        ...clone(decision),
        trigger,
        recomputed_after_change: true,
        cached_decision_reused: false,
        inherited_permission: false,
        at,
      });
    },

    /** A handoff moves responsibility, never authority: the recipient's own policy decides. */
    evaluateHandoff({ from_assistant_ref, to_assistant_ref, action_ref, axes = {}, capability_available = true, handoff = null, at: when } = {}) {
      if (typeof capability_available !== 'boolean') throw new DutyPolicyError('INVALID_REQUEST', 'capability_available must be true or false');
      requireDuty(from_assistant_ref);
      requireDuty(to_assistant_ref);
      const at = atFrom(when);
      assertHandoffCarriesNoAuthority(handoff);
      // The recipient is recomputed with the same capability factor: a handoff does not conjure a
      // capability the target device does not have.
      const fromDecision = api.decide({ assistant_ref: from_assistant_ref, action_ref, axes, capability_available, at });
      const toDecision = api.decide({ assistant_ref: to_assistant_ref, action_ref, axes, capability_available, at });
      note('HANDOFF_EVALUATED', at, { from_assistant_ref, to_assistant_ref });
      return freeze({
        contract_version: DUTY_POLICY_CONTRACT_VERSION,
        from_assistant_ref,
        to_assistant_ref,
        action_ref,
        from_decision: fromDecision.decision,
        to_decision: toDecision.decision,
        recipient_recomputed_permission: true,
        recipient_inherits_grants: false,
        recipient_more_privileged_than_sender: fromDecision.decision !== 'ALLOWED' && toDecision.decision === 'ALLOWED',
        capability_available,
        recipient_capability_checked: true,
        recipient_more_privileged_than_before: false,
        authority_transferred: false,
        at,
      });
    },

    /** Digital-Me canonical data is read-only for this module: duties never rewrite it. */
    writeDigitalMe() {
      throw new DutyPolicyError('DIGITAL_ME_IS_READ_ONLY', 'duties and proactivity are assistant-owned policy and never rewrite canonical user data', {
        written: false, canonical_source: DIGITAL_ME_RELATIONSHIP,
      });
    },

    /** A lease is never a substitute for policy or capability. */
    assertLeaseIsNotPermission({ lease_ref, action_ref, axes = {}, capability_available = true, assistant_ref = null } = {}) {
      if (!isText(lease_ref)) throw new DutyPolicyError('INVALID_REQUEST', 'lease_ref is required');
      const decision = api.decide({ assistant_ref, action_ref, axes, capability_available, lease: { lease_ref, lease_valid: true } });
      if (decision.decision !== 'ALLOWED') {
        return freeze({
          contract_version: DUTY_POLICY_CONTRACT_VERSION,
          lease_ref,
          action_ref,
          decision: decision.decision,
          lease_is_permission: false,
          lease_supplied_capability: false,
          reason: decision.reason,
          denied_axes: decision.denied_axes ?? freeze([]),
        });
      }
      return freeze({
        contract_version: DUTY_POLICY_CONTRACT_VERSION,
        lease_ref,
        action_ref,
        decision: 'ALLOWED',
        lease_is_permission: false,
        lease_supplied_capability: false,
        execution_safety_prerequisite: 'LEASE_VALID',
      });
    },

    decisions: () => clone([...decisions.values()]),
    decision: decision_id => {
      const decision = decisions.get(decision_id);
      return decision ? freeze(clone(decision)) : null;
    },
    assistants: () => freeze([...duties.keys()]),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
