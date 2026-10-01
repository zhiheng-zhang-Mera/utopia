// Health + resilience + honest degradation (GAI-008).
//
// General AI is Web-first, and its failure must stay General AI's problem. This module keeps five things
// strictly apart — availability, health, auth state, rate-limit state and budget state — because collapsing
// them is how "the provider answered" becomes "the user is signed in" or "there is budget".
//
// Retry is bounded and only for genuinely transient technical failures. A human-blocked state
// (AUTH_REQUIRED / NEEDS_USER) is never an auto-retry loop and never auto-resumes as though a technical retry
// had succeeded: it stays pending until a human action is explicitly acknowledged. An ambiguous or
// destructive failure is not retried at all without an idempotency key.
//
// Circuits are scoped to one provider/account/model/channel, so one bad provider cannot trip all AI, and a
// General AI outage leaves independent Utopia surfaces (Rooms, City tasks) usable. A Web failure may propose
// another device or remain unavailable — it never silently triggers the API channel.
//
// Pure module: the clock is injected; no network, storage or ambient state.
export const RESILIENCE_CONTRACT_VERSION = 1;

/** Same four-value health vocabulary as the Engineering registry, so two programmes cannot disagree. */
export const HEALTH_STATES = Object.freeze(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);
export const READINESS = Object.freeze(['READY', 'NOT_READY', 'UNKNOWN']);
export const AVAILABILITY_STATES = Object.freeze(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN']);
export const AUTH_STATES = Object.freeze(['READY', 'MISSING', 'EXPIRED', 'NEEDS_USER', 'UNAVAILABLE', 'UNKNOWN']);
export const RATE_LIMIT_STATES = Object.freeze(['WITHIN_LIMIT', 'LIMITED', 'UNKNOWN']);
export const BUDGET_STATES = Object.freeze(['WITHIN_BUDGET', 'EXHAUSTED', 'UNKNOWN']);
export const SCOPE_KINDS = Object.freeze(['PROVIDER', 'ACCOUNT', 'MODEL', 'WEB_CHANNEL', 'API_CHANNEL']);
export const FAULT_CLASSES = Object.freeze(['TRANSIENT_TECHNICAL', 'HUMAN_BLOCKED', 'PERMANENT', 'AMBIGUOUS']);
export const CIRCUIT_STATES = Object.freeze(['CLOSED', 'OPEN', 'HALF_OPEN']);
export const SIGNAL_KINDS = Object.freeze(['AVAILABILITY', 'HEALTH', 'AUTH', 'RATE_LIMIT', 'BUDGET']);
export const LOCAL_SURFACES = Object.freeze(['ROOMS', 'CITY_TASKS', 'ARCADES', 'LOCAL_CAPABILITIES']);

export const RESILIENCE_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'INVALID_SCOPE', 'INVALID_SIGNAL', 'UNKNOWN_SCOPE',
  'RETRY_NOT_PERMITTED', 'RETRY_BUDGET_EXHAUSTED', 'IDEMPOTENCY_REQUIRED', 'HUMAN_ACTION_REQUIRED',
  'CIRCUIT_OPEN', 'API_ESCALATION_IS_NOT_AUTOMATIC', 'STALE_OBSERVATION', 'ALREADY_ACKNOWLEDGED',
]);

const CONFLICT_CODES = new Set(['CIRCUIT_OPEN', 'RETRY_BUDGET_EXHAUSTED', 'HUMAN_ACTION_REQUIRED', 'IDEMPOTENCY_REQUIRED', 'API_ESCALATION_IS_NOT_AUTOMATIC']);

export class ResilienceError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ResilienceError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_SCOPE' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
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
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

const INSTANT_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
/** Shape is not enough: the regex accepts a calendar-impossible date, so components must round trip. */
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

const callerInstant = (value, label = 'at') => {
  if (!isRealInstant(value)) throw new ResilienceError('INVALID_REQUEST', `${label} must be an ISO-8601 UTC instant such as 2026-01-01T00:00:00Z, got ${String(value)}`);
  return value;
};

/**
 * Failure classification. The codes are deliberately the ones a provider or transport actually produces, and
 * anything unrecognized is treated as AMBIGUOUS (never silently retryable).
 */
export const TRANSIENT_CODES = Object.freeze(['TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'UPSTREAM_5XX', 'SERVICE_UNAVAILABLE', 'PROVIDER_FAULT', 'RATE_LIMITED', 'TOO_MANY_REQUESTS']);
export const HUMAN_BLOCKED_CODES = Object.freeze(['AUTH_REQUIRED', 'AUTH_FAILED', 'NEEDS_USER', 'USER_ACTION_REQUIRED', 'PERMISSION_DENIED', 'CONSENT_REQUIRED', 'DEVICE_ACTION_REQUIRED']);
export const PERMANENT_CODES = Object.freeze(['INVALID_REQUEST', 'BAD_REQUEST', 'NOT_FOUND', 'UNSUPPORTED', 'MODEL_NOT_FOUND', 'POLICY_REFUSED']);
export const AMBIGUOUS_CODES = Object.freeze(['AMBIGUOUS_RESULT', 'DESTRUCTIVE_OUTCOME_UNKNOWN', 'UNKNOWN']);

export function classifyFailure({ code, retry_after_ms = null } = {}) {
  const normalized = isText(code) ? code.trim().toUpperCase() : 'UNKNOWN';
  if (HUMAN_BLOCKED_CODES.includes(normalized)) {
    return freeze({ code: normalized, fault_class: 'HUMAN_BLOCKED', retryable: false, human_action_required: true, auto_resume: false, retry_after_ms: null });
  }
  if (TRANSIENT_CODES.includes(normalized)) {
    return freeze({ code: normalized, fault_class: 'TRANSIENT_TECHNICAL', retryable: true, human_action_required: false, auto_resume: true, retry_after_ms: Number.isFinite(retry_after_ms) ? retry_after_ms : null });
  }
  if (PERMANENT_CODES.includes(normalized)) {
    return freeze({ code: normalized, fault_class: 'PERMANENT', retryable: false, human_action_required: false, auto_resume: false, retry_after_ms: null });
  }
  return freeze({ code: normalized, fault_class: 'AMBIGUOUS', retryable: false, human_action_required: false, auto_resume: false, retry_after_ms: null });
}

export const DEFAULT_RESILIENCE_POLICY = Object.freeze({
  policy_ref: 'policy:gai-resilience-default',
  max_attempts: 3,
  backoff_base_ms: 500,
  backoff_factor: 2,
  backoff_cap_ms: 8000,
  failure_threshold: 3,
  circuit_cooldown_ms: 30000,
  health_ttl_ms: 30000,
  max_health_ttl_ms: 600000,
});

export function createResilienceGovernor({ clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new ResilienceError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) throw new ResilienceError('INVALID_REQUEST', 'policy must be an object');
  const config = { ...DEFAULT_RESILIENCE_POLICY, ...(policy ?? {}) };
  for (const key of ['max_attempts', 'backoff_base_ms', 'backoff_cap_ms', 'failure_threshold', 'circuit_cooldown_ms', 'health_ttl_ms', 'max_health_ttl_ms']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new ResilienceError('INVALID_REQUEST', `policy.${key} must be a positive safe integer, got ${String(config[key])}`);
    }
  }
  if (!Number.isFinite(config.backoff_factor) || config.backoff_factor < 1) {
    throw new ResilienceError('INVALID_REQUEST', `policy.backoff_factor must be a finite number >= 1, got ${String(config.backoff_factor)}`);
  }
  if (config.health_ttl_ms > config.max_health_ttl_ms) {
    throw new ResilienceError('INVALID_REQUEST', 'policy.health_ttl_ms may not exceed policy.max_health_ttl_ms');
  }
  const observations = new Map();
  const circuits = new Map();
  const humanBlocked = new Map();
  const attempts = new Map();
  const journal = [];
  let admissions = 0;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new ResilienceError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const scopeKey = (scope_kind, scope_ref) => `${scope_kind}\u0000${scope_ref}`;

  const requireScope = (scope_kind, scope_ref) => {
    if (!SCOPE_KINDS.includes(scope_kind) || !isText(scope_ref)) {
      throw new ResilienceError('INVALID_SCOPE', `scope_kind must be one of ${SCOPE_KINDS.join(', ')} and scope_ref is required`);
    }
    return scopeKey(scope_kind, scope_ref);
  };

  const circuitFor = (key, at) => {
    const circuit = circuits.get(key) ?? null;
    if (circuit === null) return null;
    // The cooldown elapses on the registry's clock: a caller-supplied instant may neither extend nor
    // shorten it.
    if (circuit.state === 'OPEN' && Date.parse(circuit.open_until) <= Date.parse(now())) {
      circuit.state = 'HALF_OPEN';
    }
    return circuit;
  };

  /** The effective state at the registry clock, so a query and a report cannot disagree. */
  const effectiveCircuitState = circuit => {
    if (circuit.state === 'OPEN' && Date.parse(circuit.open_until) <= Date.parse(now())) return 'HALF_OPEN';
    return circuit.state;
  };

  const healthProjection = (observation, at) => {
    const staleAfter = observation.stale_after_ms;
    const age = Date.parse(at) - Date.parse(observation.observed_at);
    const stale = !Number.isFinite(age) || !Number.isFinite(staleAfter) || age > staleAfter;
    const availability = observation.availability;
    const health = stale ? 'UNKNOWN' : observation.health;
    const auth_state = stale ? 'UNKNOWN' : observation.auth_state;
    const rate_limit_state = stale ? 'UNKNOWN' : observation.rate_limit_state;
    const budget_state = stale ? 'UNKNOWN' : observation.budget_state;
    let readonly = 'UNKNOWN';
    if (!stale) {
      if (availability === 'UNAVAILABLE') readonly = 'NOT_READY';
      else if (availability === 'DEGRADED') readonly = 'NOT_READY';
      else if (availability === 'UNKNOWN') readonly = 'UNKNOWN';
      else if (health === 'UNHEALTHY' || health === 'UNKNOWN') readonly = 'UNKNOWN';
      else if (auth_state !== 'READY') readonly = 'NOT_READY';
      else if (rate_limit_state === 'LIMITED') readonly = 'NOT_READY';
      else if (budget_state === 'EXHAUSTED') readonly = 'NOT_READY';
      else readonly = 'READY';
    }
    return freeze({
      contract_version: RESILIENCE_CONTRACT_VERSION,
      scope_kind: observation.scope_kind,
      scope_ref: observation.scope_ref,
      availability,
      health,
      readiness: readonly,
      auth_state,
      rate_limit_state,
      budget_state,
      retry_after_ms: observation.retry_after_ms,
      signals_are_separate: true,
      auth_is_not_health: true,
      budget_is_not_availability: true,
      stale,
      stale_health_is_not_healthy: true,
      freshness: freeze({ observed_at: observation.observed_at, evaluated_at: at, age_ms: age, stale_after_ms: staleAfter }),
      reason: stale ? 'STALE_OBSERVATION' : availability === 'UNAVAILABLE' ? 'UNAVAILABLE' : availability === 'DEGRADED' ? 'AVAILABILITY_DEGRADED' : auth_state !== 'READY' ? `AUTH_${auth_state}` : rate_limit_state === 'LIMITED' ? 'RATE_LIMITED' : budget_state === 'EXHAUSTED' ? 'BUDGET_EXHAUSTED' : health === 'HEALTHY' ? 'HEALTHY' : `HEALTH_${health}`,
    });
  };

  const api = {
    policy: () => freeze(clone(config)),

    /** One typed observation per scope, with all five signals kept apart. */
    observeHealth({
      scope_kind, scope_ref, availability = 'AVAILABLE', health = 'HEALTHY', auth_state = 'READY',
      rate_limit_state = 'WITHIN_LIMIT', budget_state = 'WITHIN_BUDGET', retry_after_ms = null,
      observed_at, ttl_ms,
    } = {}) {
      requireScope(scope_kind, scope_ref);
      if (!AVAILABILITY_STATES.includes(availability)) throw new ResilienceError('INVALID_SIGNAL', `availability must be one of ${AVAILABILITY_STATES.join(', ')}`);
      if (!HEALTH_STATES.includes(health)) throw new ResilienceError('INVALID_SIGNAL', `health must be one of ${HEALTH_STATES.join(', ')}`);
      if (!AUTH_STATES.includes(auth_state)) throw new ResilienceError('INVALID_SIGNAL', `auth_state must be one of ${AUTH_STATES.join(', ')}`);
      if (!RATE_LIMIT_STATES.includes(rate_limit_state)) throw new ResilienceError('INVALID_SIGNAL', `rate_limit_state must be one of ${RATE_LIMIT_STATES.join(', ')}`);
      if (!BUDGET_STATES.includes(budget_state)) throw new ResilienceError('INVALID_SIGNAL', `budget_state must be one of ${BUDGET_STATES.join(', ')}`);
      const at = observed_at === undefined || observed_at === null ? now() : callerInstant(observed_at, 'observed_at');
      const ttl = ttl_ms ?? config.health_ttl_ms;
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > config.max_health_ttl_ms) throw new ResilienceError('INVALID_REQUEST', `ttl_ms must be a positive integer up to ${config.max_health_ttl_ms}`);
      const observation = {
        scope_kind, scope_ref, availability, health, auth_state, rate_limit_state, budget_state,
        retry_after_ms: Number.isFinite(retry_after_ms) ? retry_after_ms : null,
        observed_at: at, stale_after_ms: ttl,
      };
      observations.set(scopeKey(scope_kind, scope_ref), observation);
      note('HEALTH_OBSERVED', at, { scope_kind, scope_ref, health, auth_state });
      return healthProjection(observation, at);
    },

    healthAt({ scope_kind, scope_ref, at: when } = {}) {
      const key = requireScope(scope_kind, scope_ref);
      const observation = observations.get(key);
      if (!observation) {
        return freeze({
          contract_version: RESILIENCE_CONTRACT_VERSION,
          scope_kind, scope_ref,
          availability: 'UNKNOWN', health: 'UNKNOWN', readiness: 'UNKNOWN',
          auth_state: 'UNKNOWN', rate_limit_state: 'UNKNOWN', budget_state: 'UNKNOWN',
          stale: true, reason: 'NO_OBSERVATION', signals_are_separate: true, stale_health_is_not_healthy: true,
        });
      }
      return healthProjection(observation, when === undefined || when === null ? now() : callerInstant(when));
    },

    classifyFailure,

    /** Bounded retry for transient technical faults only, with the circuit honoured per scope. */
    retryDecision({ action_ref, attempt = 1, code, retry_after_ms = null, idempotency_key = null, side_effecting = false, scope_kind = null, scope_ref = null, at: when } = {}) {
      if (!isText(action_ref)) throw new ResilienceError('INVALID_REQUEST', 'action_ref is required');
      if (!Number.isSafeInteger(attempt) || attempt < 1) throw new ResilienceError('INVALID_REQUEST', 'attempt must be a positive integer');
      if (typeof side_effecting !== 'boolean') throw new ResilienceError('INVALID_REQUEST', 'side_effecting must be a boolean when given, so the idempotency requirement cannot be silently skipped');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const classification = classifyFailure({ code, retry_after_ms });
      const base = {
        contract_version: RESILIENCE_CONTRACT_VERSION,
        action_ref, attempt, code: classification.code, fault_class: classification.fault_class,
        human_action_required: classification.human_action_required, evaluated_at: at,
      };

      if (classification.fault_class === 'HUMAN_BLOCKED') {
        const previousBlock = humanBlocked.get(action_ref) ?? null;
        const wasAcknowledged = previousBlock?.resolved === true;
        humanBlocked.set(action_ref, freeze({
          action_ref,
          since: previousBlock?.since ?? at,
          reason: classification.code,
          resolved: wasAcknowledged,
          acknowledged_at: previousBlock?.acknowledged_at ?? null,
          acknowledged_by_ref: previousBlock?.acknowledged_by_ref ?? null,
          reblocked_at: wasAcknowledged ? at : null,
          previously_acknowledged: wasAcknowledged,
          requires_new_acknowledgment: wasAcknowledged,
        }));
        note('HUMAN_BLOCKED', at, { action_ref, code: classification.code });
        return freeze({ ...base, retry: false, auto_resume: false, one_shot_retry_is_not_resume: true, reason: 'HUMAN_ACTION_REQUIRED', human_action_required: true, acknowledged: false, previously_acknowledged: wasAcknowledged });
      }
      if (classification.fault_class === 'PERMANENT') {
        return freeze({ ...base, retry: false, auto_resume: false, reason: 'PERMANENT_FAILURE' });
      }
      if (classification.fault_class === 'AMBIGUOUS') {
        if (!isText(idempotency_key)) {
          return freeze({ ...base, retry: false, auto_resume: false, reason: 'IDEMPOTENCY_REQUIRED', requires_reconciliation: true, idempotency_required: true });
        }
        return freeze({ ...base, retry: true, auto_resume: false, reason: 'AMBIGUOUS_WITH_IDEMPOTENCY', requires_reconciliation: true, backoff_ms: 0, attempts_remaining: Math.max(0, config.max_attempts - attempt) });
      }
      // Transient technical: bounded attempts, scoped circuit, exponential backoff.
      if (scope_kind !== null && scope_ref !== null) {
        const circuit = circuitFor(requireScope(scope_kind, scope_ref), at);
        if (circuit !== null && circuit.state === 'OPEN') {
          note('CIRCUIT_REFUSED_RETRY', at, { action_ref, scope_ref, circuit_state: 'OPEN' });
          return freeze({ ...base, retry: false, auto_resume: false, reason: 'CIRCUIT_OPEN', circuit_state: 'OPEN', scope_kind, scope_ref, retry_after_ms: Math.max(0, Date.parse(circuit.open_until) - Date.parse(at)) });
        }
      }
      if (attempt >= config.max_attempts) {
        note('RETRY_BUDGET_EXHAUSTED', at, { action_ref, attempt });
        return freeze({ ...base, retry: false, auto_resume: false, reason: 'ATTEMPTS_EXHAUSTED', attempts_remaining: 0, max_attempts: config.max_attempts });
      }
      // A destructive retry without an idempotency key could apply the same effect twice, so it is
      // withheld for reconciliation exactly like an ambiguous failure.
      if (side_effecting === true && !isText(idempotency_key)) {
        note('RETRY_WITHHELD_FOR_IDEMPOTENCY', at, { action_ref, code: classification.code });
        return freeze({ ...base, retry: false, auto_resume: false, reason: 'IDEMPOTENCY_REQUIRED', requires_reconciliation: true, idempotency_required: true, side_effecting: true });
      }
      const backoff = Math.min(config.backoff_cap_ms, config.backoff_base_ms * config.backoff_factor ** (attempt - 1));
      const honourRetryAfter = classification.retry_after_ms !== null ? Math.max(backoff, classification.retry_after_ms) : backoff;
      note('RETRY_ALLOWED', at, { action_ref, attempt, backoff_ms: honourRetryAfter });
      return freeze({
        ...base,
        retry: true,
        auto_resume: true,
        reason: 'TRANSIENT_TECHNICAL',
        backoff_ms: honourRetryAfter,
        capped_by_ms: config.backoff_cap_ms,
        attempts_remaining: config.max_attempts - attempt,
        side_effecting_retry_requires_idempotency: side_effecting === true,
        idempotency_key_present: isText(idempotency_key),
      });
    },

    /** Scoped circuit accounting: one provider/account/model/channel cannot trip the others. */
    recordOutcome({ scope_kind, scope_ref, outcome, at: when } = {}) {
      const key = requireScope(scope_kind, scope_ref);
      if (!['SUCCESS', 'FAILURE'].includes(outcome)) throw new ResilienceError('INVALID_REQUEST', 'outcome must be SUCCESS or FAILURE');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const circuit = circuits.get(key) ?? { scope_kind, scope_ref, state: 'CLOSED', consecutive_failures: 0, opened_at: null, open_until: null, half_open_probes: 0 };
      if (outcome === 'SUCCESS') {
        circuit.consecutive_failures = 0;
        circuit.state = 'CLOSED';
        circuit.opened_at = null;
        circuit.open_until = null;
      } else {
        circuit.consecutive_failures += 1;
        if (circuit.state === 'HALF_OPEN' || circuit.consecutive_failures >= config.failure_threshold) {
          circuit.state = 'OPEN';
          circuit.opened_at = at;
          circuit.open_until = new Date(Date.parse(now()) + config.circuit_cooldown_ms).toISOString();
        }
      }
      circuits.set(key, circuit);
      note('CIRCUIT_OUTCOME', at, { scope_kind, scope_ref, outcome, state: circuit.state });
      return freeze({
        contract_version: RESILIENCE_CONTRACT_VERSION,
        scope_kind, scope_ref,
        state: circuit.state,
        consecutive_failures: circuit.consecutive_failures,
        open_until: circuit.open_until,
        cooldown_ms: config.circuit_cooldown_ms,
        circuit_is_global: false,
        other_scopes_affected: freeze([]),
      });
    },

    circuitState({ scope_kind, scope_ref, at: when } = {}) {
      const key = requireScope(scope_kind, scope_ref);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const circuit = circuitFor(key, at);
      if (circuit === null) {
        return freeze({ contract_version: RESILIENCE_CONTRACT_VERSION, scope_kind, scope_ref, state: 'CLOSED', consecutive_failures: 0, open_until: null, circuit_is_global: false });
      }
      return freeze({
        contract_version: RESILIENCE_CONTRACT_VERSION,
        scope_kind, scope_ref,
        state: circuit.state,
        consecutive_failures: circuit.consecutive_failures,
        open_until: circuit.open_until,
        circuit_is_global: false,
        scope_only: true,
      });
    },

    /**
     * A Web failure may propose another device or stay unavailable. It never silently becomes an API call.
     */
    degradeChannel({ channel = 'WEB_CHANNEL', reason = 'WEB_UNAVAILABLE', other_device_available = false, at: when } = {}) {
      const at = when === undefined || when === null ? now() : callerInstant(when);
      if (!isText(channel) || !SCOPE_KINDS.includes(channel)) throw new ResilienceError('INVALID_REQUEST', `channel must be one of ${SCOPE_KINDS.join(', ')}`);
      if (!isText(reason)) throw new ResilienceError('INVALID_REQUEST', 'reason must be nonempty text');
      if (typeof other_device_available !== 'boolean') throw new ResilienceError('INVALID_REQUEST', 'other_device_available must be a boolean when given, so a proposal cannot be silently dropped');
      note('CHANNEL_DEGRADED', at, { channel, reason });
      return freeze({
        contract_version: RESILIENCE_CONTRACT_VERSION,
        channel,
        state: 'UNAVAILABLE',
        reason,
        honest_degradation: true,
        proposal: other_device_available === true
          ? freeze({ kind: 'DEVICE_SWITCH_PROPOSAL', requires_user_confirmation: true, grants_execution_authority: false })
          : null,
        api_escalation: null,
        api_escalation_automatically_triggered: false,
        api_channel_requires_explicit_consent: true,
        local_surfaces_available: freeze([...LOCAL_SURFACES]),
        false_success: false,
        at,
      });
    },

    /** Any attempt to make resilience code escalate to the API is refused outright. */
    escalateToApi() {
      throw new ResilienceError('API_ESCALATION_IS_NOT_AUTOMATIC', 'a channel failure never triggers the API channel; API requires explicit user consent through the admission gate', {
        api_escalation_automatically_triggered: false,
        requires_explicit_consent: true,
      });
    },

    /** Fault isolation statement: one failing scope does not poison the rest of the platform. */
    faultIsolation({ failing_scope_kind = null, failing_scope_ref = null, at: when } = {}) {
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const affected = [...circuits.values()].filter(circuit => effectiveCircuitState(circuit) === 'OPEN');
      return freeze({
        contract_version: RESILIENCE_CONTRACT_VERSION,
        failing_scope_kind,
        failing_scope_ref,
        isolated_scopes: freeze(affected.map(circuit => freeze({ scope_kind: circuit.scope_kind, scope_ref: circuit.scope_ref, state: circuit.state }))),
        unrelated_scopes_affected: freeze([]),
        local_surfaces: freeze([...LOCAL_SURFACES]),
        local_surfaces_use_general_ai: false,
        global_outage: false,
        poisons_all_ai: false,
        at,
      });
    },

    /** A human-blocked action stays pending until it is explicitly acknowledged. */
    acknowledgeHumanAction({ action_ref, by_ref = null, at: when } = {}) {
      const pending = humanBlocked.get(action_ref);
      if (!pending) return freeze({ action_ref, acknowledged: false, reason: 'NOT_BLOCKED' });
      if (pending.resolved === true) return freeze({ action_ref, acknowledged: true, duplicate: true, reason: 'ALREADY_ACKNOWLEDGED' });
      const at = when === undefined || when === null ? now() : callerInstant(when);
      humanBlocked.set(action_ref, freeze({ ...pending, resolved: true, acknowledged_at: at, acknowledged_by_ref: by_ref }));
      note('HUMAN_ACTION_ACKNOWLEDGED', at, { action_ref });
      return freeze({ action_ref, acknowledged: true, duplicate: false, by_ref, acknowledged_at: at, auto_resume_still_required: true });
    },

    humanBlockedAction: action_ref => freeze(clone(humanBlocked.get(action_ref) ?? null)),

    /** Aggregate honest view: stale and unknown are reported as such, never as healthy. */
    resilienceReport({ at: when } = {}) {
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const scopes = [...observations.values()].map(observation => healthProjection(observation, at));
      return freeze({
        contract_version: RESILIENCE_CONTRACT_VERSION,
        policy_ref: config.policy_ref,
        scopes: freeze(scopes),
        healthy_scopes: freeze(scopes.filter(scope => scope.health === 'HEALTHY' && scope.stale === false).map(scope => `${scope.scope_kind}:${scope.scope_ref}`)),
        stale_scopes: freeze(scopes.filter(scope => scope.stale === true).map(scope => `${scope.scope_kind}:${scope.scope_ref}`)),
        open_circuits: freeze([...circuits.values()].filter(circuit => effectiveCircuitState(circuit) === 'OPEN').map(circuit => `${circuit.scope_kind}:${circuit.scope_ref}`)),
        human_blocked_actions: freeze([...humanBlocked.values()].filter(entry => entry.resolved !== true).map(entry => entry.action_ref)),
        api_escalation_automatically_triggered: false,
        local_surfaces_available: freeze([...LOCAL_SURFACES]),
        at,
      });
    },

    journal: () => clone(journal),
    admissionsRecorded: () => admissions,
  };
  return Object.freeze(api);
}
