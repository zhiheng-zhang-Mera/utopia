// Runtime ownership + health / restart / recovery (EM-009).
//
// The long-hosting safety model, ported to Engineering Manager. Three authorities are deliberately kept
// apart, because collapsing them is how a health monitor becomes a destructive supervisor:
//
//   OWNERSHIP   says which live process is really this instance 閳?a reused PID is not this instance.
//   HEALTH      senses pressure and decides it. It cannot restart anything: the monitor's public surface
//               contains no restart, kill or spawn operation, and it holds no handle to the supervisor.
//   RESTART     executes a restart, but may only act on a pressure decision the monitor produced. It owns
//               no thresholds, so it cannot invent pressure policy.
//
// Restarts are bounded: budget, cooldown, an exponential crash-loop ladder and a terminal SAFE_MODE that
// stops the loop instead of retrying forever. A resume happens only after a before-restart checkpoint and
// an after-restart readiness check, and a job that is already terminal in authoritative state can never
// reappear in the active queue.
//
// Scope: this is process/runtime recovery. Cross-device reconnect belongs to Remote Fabric.
// Pure module: probes, ownership store, checkpoint and readiness hooks and the clock are injected.
export const RUNTIME_SUPERVISOR_CONTRACT_VERSION = 1;

/** Pressure ladder. `mapToRegistryHealth` projects this onto EM-004's registry vocabulary. */
export const HEALTH_STATES = Object.freeze(['HEALTHY', 'ELEVATED', 'DEGRADED', 'CRITICAL', 'UNKNOWN']);
export const REGISTRY_HEALTH = Object.freeze(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);
export const RUNTIME_STATES = Object.freeze(['RUNNING', 'RESTARTING', 'SUSPENDED', 'SAFE_MODE', 'STOPPED']);
export const PRESSURE_VERDICTS = Object.freeze(['NONE', 'PRESSURE']);
export const RESTART_REFUSALS = Object.freeze([
  'PRESSURE_REQUIRED', 'POLICY_IS_MONITOR_OWNED', 'STALE_OWNERSHIP', 'PID_REUSED', 'NOT_THE_OWNER',
  'CHECKPOINT_REQUIRED', 'CHECKPOINT_FAILED', 'RESTART_BUDGET_EXHAUSTED', 'SAFE_MODE_ACTIVE',
  'COOLDOWN_ACTIVE', 'TERMINAL_JOB_RESURRECTION_BLOCKED', 'PROCESS_SIGNAL_FAILED',
]);

export const SUPERVISOR_CODES = Object.freeze([
  'INVALID_OWNERSHIP', 'INVALID_PRESSURE', 'INVALID_POLICY', 'INVALID_INSTANCE', 'UNKNOWN_INSTANCE',
  ...RESTART_REFUSALS,
]);

const CONFLICT_CODES = new Set(['STALE_OWNERSHIP', 'PID_REUSED', 'NOT_THE_OWNER', 'SAFE_MODE_ACTIVE', 'COOLDOWN_ACTIVE', 'RESTART_BUDGET_EXHAUSTED']);

export class RuntimeSupervisorError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RuntimeSupervisorError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_INSTANCE' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
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
/** Shape is not enough: a calendar-impossible instant parses to NaN and silently disables comparisons. */
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

/** `null` for an uninterpretable instant, so a caller cannot make a comparison vanish. */
const instantMs = value => (isRealInstant(value) ? Date.parse(value) : null);

/**
 * Unforgeable pressure: a decision is authority only if the exact monitor that produced it says so. The
 * issuer is a symbol, so it stays out of the monitor's public surface (`Object.keys` shows four sensing
 * operations and nothing else), while the supervisor can still verify provenance instead of trusting shape.
 */
export const PRESSURE_ISSUER = Symbol('em009.pressureIssuer');

/**
 * A bound that can be switched off is not a bound: a NaN/Infinity/negative policy value would disable the
 * comparison it feeds (a never-stale monitor, a restart budget that never ends, a cooldown that never holds).
 */
const POLICY_KEYS = Object.freeze({
  pressure: ['policy_ref', 'elevated_at', 'degraded_at', 'critical_at', 'stale_after_ms', 'min_confidence'],
  restart: ['max_restarts', 'cooldown_ms', 'backoff_base_ms', 'backoff_factor', 'backoff_cap_ms'],
});
const nonNegativeInt = value => Number.isSafeInteger(value) && value >= 0;
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);

function checkPolicyKeys(policy, kind, path, errors) {
  const allowed = POLICY_KEYS[kind];
  for (const key of Reflect.ownKeys(policy)) {
    if (typeof key !== 'string' || !allowed.includes(key)) errors.push(`${path}.${String(key)} is not part of the ${kind} policy`);
  }
}

function validatePressurePolicy(policy) {
  const errors = [];
  if (!isPlainObject(policy)) throw new RuntimeSupervisorError('INVALID_POLICY', 'policy must be a plain object');
  checkPolicyKeys(policy, 'pressure', 'policy', errors);
  const thresholds = ['elevated_at', 'degraded_at', 'critical_at'];
  for (const key of thresholds) {
    if (!nonNegativeInt(policy[key])) errors.push(`policy.${key} must be a non-negative integer, got ${String(policy[key])}`);
  }
  if (nonNegativeInt(policy.elevated_at) && nonNegativeInt(policy.degraded_at) && policy.elevated_at > policy.degraded_at) errors.push('policy.elevated_at may not exceed policy.degraded_at');
  if (nonNegativeInt(policy.degraded_at) && nonNegativeInt(policy.critical_at) && policy.degraded_at > policy.critical_at) errors.push('policy.degraded_at may not exceed policy.critical_at');
  if (!Number.isSafeInteger(policy.stale_after_ms) || policy.stale_after_ms <= 0) errors.push(`policy.stale_after_ms must be a positive integer, got ${String(policy.stale_after_ms)}`);
  if (!finiteNumber(policy.min_confidence) || policy.min_confidence < 0 || policy.min_confidence > 1) errors.push(`policy.min_confidence must be a number between 0 and 1, got ${String(policy.min_confidence)}`);
  if (!isText(policy.policy_ref)) errors.push('policy.policy_ref must be nonempty text');
  if (errors.length) throw new RuntimeSupervisorError('INVALID_POLICY', errors.join('; '));
  return policy;
}

function validateRestartPolicy(policy) {
  const errors = [];
  if (!isPlainObject(policy)) throw new RuntimeSupervisorError('INVALID_POLICY', 'policy must be a plain object');
  checkPolicyKeys(policy, 'restart', 'policy', errors);
  if (!nonNegativeInt(policy.max_restarts)) errors.push(`policy.max_restarts must be a non-negative integer, got ${String(policy.max_restarts)}`);
  if (!nonNegativeInt(policy.cooldown_ms)) errors.push(`policy.cooldown_ms must be a non-negative integer, got ${String(policy.cooldown_ms)}`);
  if (!nonNegativeInt(policy.backoff_base_ms)) errors.push(`policy.backoff_base_ms must be a non-negative integer, got ${String(policy.backoff_base_ms)}`);
  if (!finiteNumber(policy.backoff_factor) || policy.backoff_factor < 1) errors.push(`policy.backoff_factor must be a number of at least 1, got ${String(policy.backoff_factor)}`);
  if (!nonNegativeInt(policy.backoff_cap_ms)) errors.push(`policy.backoff_cap_ms must be a non-negative integer, got ${String(policy.backoff_cap_ms)}`);
  if (nonNegativeInt(policy.backoff_base_ms) && nonNegativeInt(policy.backoff_cap_ms) && policy.backoff_base_ms > policy.backoff_cap_ms) errors.push('policy.backoff_base_ms may not exceed policy.backoff_cap_ms');
  if (errors.length) throw new RuntimeSupervisorError('INVALID_POLICY', errors.join('; '));
  return policy;
}

/** Defaults are policy the MONITOR owns. The supervisor only enforces what it is handed. */
export const DEFAULT_PRESSURE_POLICY = Object.freeze({
  policy_ref: 'policy:default',
  elevated_at: 1,
  degraded_at: 2,
  critical_at: 3,
  stale_after_ms: 30000,
  min_confidence: 0.5,
});

export const DEFAULT_RESTART_POLICY = Object.freeze({
  max_restarts: 3,
  cooldown_ms: 60000,
  backoff_base_ms: 1000,
  backoff_factor: 2,
  backoff_cap_ms: 30000,
});

/** EM-004 speaks a four-value registry vocabulary; the ladder maps onto it without inventing facts. */
export function mapToRegistryHealth(health) {
  if (health === 'HEALTHY') return 'HEALTHY';
  if (health === 'ELEVATED' || health === 'DEGRADED') return 'DEGRADED';
  if (health === 'CRITICAL') return 'UNHEALTHY';
  return 'UNKNOWN';
}

/**
 * The monitor: senses, decides pressure, and can do nothing else. It has no restart/kill/spawn member and
 * no reference to a supervisor, which is what makes "monitor cannot execute restart" a structural fact.
 */
export function createHealthMonitor({ probe, policy = {}, clock = () => new Date().toISOString() } = {}) {
  if (typeof probe !== 'function') throw new RuntimeSupervisorError('INVALID_PRESSURE', 'a probe function is required to sense runtime health');
  if (typeof clock !== 'function') throw new RuntimeSupervisorError('INVALID_PRESSURE', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) throw new RuntimeSupervisorError('INVALID_POLICY', 'policy must be a plain object');
  const pressurePolicy = validatePressurePolicy({ ...DEFAULT_PRESSURE_POLICY, ...(isPlainObject(policy) ? policy : {}) });
  const readings = [];
  /** decision_id -> the decision this monitor minted. The issuer vouches for the content, not the id. */
  const issued = new Map();
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new RuntimeSupervisorError('INVALID_PRESSURE', 'clock() must return a real ISO-8601 UTC instant');
    return produced;
  };

  return Object.freeze({
    policy: () => freeze(clone(pressurePolicy)),

    /** Sense one instance. A probe that throws is UNKNOWN with zero confidence 閳?never HEALTHY. */
    sense({ instance_ref, instance, at: when } = {}) {
      if (!isText(instance_ref)) throw new RuntimeSupervisorError('INVALID_INSTANCE', 'instance_ref is required');
      const observed_at = when === undefined || when === null ? now() : when;
      if (!isRealInstant(observed_at)) throw new RuntimeSupervisorError('INVALID_PRESSURE', 'at must be a real ISO-8601 UTC instant');
      let sample;
      let probe_error = null;
      try {
        sample = probe({ instance_ref, instance, at: observed_at });
      } catch (error) {
        probe_error = String(error?.message ?? error);
        sample = null;
      }
      const consecutive_failures = probe_error === null && Number.isFinite(sample?.consecutive_failures) ? sample.consecutive_failures : null;
      const last_liveness_at = isRealInstant(sample?.last_liveness_at) ? sample.last_liveness_at : null;
      // An instant that cannot be interpreted is stale evidence, not fresh evidence: the comparison must
      // never silently vanish into NaN and let old evidence read as current pressure.
      const observed_ms = instantMs(observed_at);
      const liveness_ms = instantMs(last_liveness_at);
      const stale = observed_ms === null || liveness_ms === null || observed_ms - liveness_ms > pressurePolicy.stale_after_ms;
      // An absent confidence is no confidence; a default that equals the threshold would pass the gate.
      const confidence = probe_error !== null ? 0 : Number.isFinite(sample?.confidence) ? sample.confidence : 0;
      let health = 'UNKNOWN';
      if (probe_error === null && !stale) {
        if (consecutive_failures === null) health = 'UNKNOWN';
        else if (consecutive_failures >= pressurePolicy.critical_at) health = 'CRITICAL';
        else if (consecutive_failures >= pressurePolicy.degraded_at) health = 'DEGRADED';
        else if (consecutive_failures >= pressurePolicy.elevated_at) health = 'ELEVATED';
        else health = 'HEALTHY';
      }
      if (confidence < pressurePolicy.min_confidence && health !== 'HEALTHY') health = 'UNKNOWN';
      counter += 1;
      const reading = freeze({
        contract_version: RUNTIME_SUPERVISOR_CONTRACT_VERSION,
        reading_id: `reading:${counter}`,
        instance_ref,
        health,
        registry_health: mapToRegistryHealth(health),
        confidence,
        freshness: freeze({ observed_at, last_liveness_at, stale, stale_after_ms: pressurePolicy.stale_after_ms }),
        consecutive_failures,
        probe_error,
        probe_failed: probe_error !== null,
        observed_at,
      });
      readings.push(reading);
      return reading;
    },

    /**
     * Decide pressure from a reading. This is the ONLY object a restart may be executed from, and it is
     * minted here, so the supervisor cannot invent pressure and the monitor never restarts anything.
     */
    decidePressure({ reading, at: when } = {}) {
      if (!isPlainObject(reading) || !isText(reading.reading_id) || !isText(reading.instance_ref)) {
        throw new RuntimeSupervisorError('INVALID_PRESSURE', 'decidePressure needs a reading produced by this monitor');
      }
      // The reading this monitor RECORDED is the evidence. A caller's copy only names it, so forging the
      // health, confidence or freshness of a real reading id cannot mint pressure.
      const reading_id = reading.reading_id;
      const instance_ref = reading.instance_ref;
      const recorded = readings.find(entry => entry.reading_id === reading_id && entry.instance_ref === instance_ref) ?? null;
      if (recorded === null) throw new RuntimeSupervisorError('INVALID_PRESSURE', 'the reading was not produced by this monitor');
      const timestamp = when === undefined || when === null ? now() : when;
      if (!isRealInstant(timestamp)) throw new RuntimeSupervisorError('INVALID_PRESSURE', 'at must be a real ISO-8601 UTC instant');
      const actionable = recorded.health === 'CRITICAL' && recorded.confidence >= pressurePolicy.min_confidence && recorded.freshness.stale === false;
      const decision_id = `pressure:${recorded.reading_id}`;
      if (actionable) {
        // The minted summary is what the issuer will compare against, so a copy that retargets the
        // decision at another instance (or edits its verdict) is not authority.
        issued.set(decision_id, freeze({
          kind: 'PRESSURE',
          instance_ref: recorded.instance_ref,
          verdict: 'PRESSURE',
          action: 'RESTART',
          health: recorded.health,
          confidence: recorded.confidence,
          policy_ref: pressurePolicy.policy_ref,
          decided_at: timestamp,
        }));
      }
      return freeze({
        contract_version: RUNTIME_SUPERVISOR_CONTRACT_VERSION,
        decision_id,
        kind: 'PRESSURE',
        instance_ref: recorded.instance_ref,
        verdict: actionable ? 'PRESSURE' : 'NONE',
        health: recorded.health,
        confidence: recorded.confidence,
        action: actionable ? 'RESTART' : 'OBSERVE',
        policy_ref: pressurePolicy.policy_ref,
        thresholds: freeze(clone(pressurePolicy)),
        decided_at: timestamp,
        destructive_authority: false,
        restart_executed: false,
        reason: actionable ? 'CRITICAL_HEALTH_CONFIRMED' : `NO_PRESSURE_${recorded.health}`,
      });
    },

    readings: () => clone(readings),

    /**
     * Proof of provenance for the supervisor. Not enumerable, so it is not part of the sensing surface.
     * It vouches for the decision's own content — instance, verdict, action, evidence and instant — so a
     * copy that retargets or rewrites a minted decision is not authority. `consume` retires the decision
     * once the restart it authorized has actually been signalled: one decision, one restart.
     */
    [PRESSURE_ISSUER]: (decision, consume = false) => {
      if (!isPlainObject(decision) || !isText(decision.decision_id)) return false;
      const minted = issued.get(decision.decision_id) ?? null;
      if (minted === null) return false;
      const matches = decision.kind === minted.kind
        && decision.instance_ref === minted.instance_ref
        && decision.verdict === minted.verdict
        && decision.action === minted.action
        && decision.health === minted.health
        && decision.confidence === minted.confidence
        && decision.policy_ref === minted.policy_ref
        && decision.decided_at === minted.decided_at;
      if (matches && consume === true) issued.delete(decision.decision_id);
      return matches;
    },
  });
}

/** Ownership records: which live process is really this instance. */
export function createOwnershipRegistry({ clock = () => new Date().toISOString() } = {}) {
  const records = new Map();
  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new RuntimeSupervisorError('INVALID_OWNERSHIP', 'clock() must return a real ISO-8601 UTC instant');
    return produced;
  };

  return Object.freeze({
    claim({ instance_ref, owner_token, pid, process_start_marker, at: when } = {}) {
      if (!isText(instance_ref) || !isText(owner_token) || !Number.isSafeInteger(pid) || pid <= 0 || !isText(process_start_marker)) {
        throw new RuntimeSupervisorError('INVALID_OWNERSHIP', 'instance_ref, owner_token, a positive integer pid and a process_start_marker are required');
      }
      const timestamp = when ?? now();
      if (!isRealInstant(timestamp)) throw new RuntimeSupervisorError('INVALID_OWNERSHIP', 'at must be a real ISO-8601 UTC instant');
      const record = freeze({
        contract_version: RUNTIME_SUPERVISOR_CONTRACT_VERSION,
        instance_ref,
        owner_token,
        pid,
        process_start_marker,
        claimed_at: timestamp,
        updated_at: timestamp,
      });
      records.set(instance_ref, record);
      return record;
    },

    get(instance_ref) { return records.get(instance_ref) ?? null; },

    /**
     * Validate ownership against the live process table. A matching pid with a different start marker is a
     * REUSED pid 閳?a different process that this instance must never signal.
     */
    validate({ instance_ref, live_processes = [], owner_token = null } = {}) {
      const record = records.get(instance_ref);
      if (!record) return freeze({ valid: false, reason: 'NOT_THE_OWNER', instance_ref, pid: null, process_identity_proven: false });
      const live = Array.isArray(live_processes) ? live_processes.find(entry => entry?.pid === record.pid) ?? null : null;
      if (owner_token !== null && owner_token !== record.owner_token) {
        return freeze({ valid: false, reason: 'NOT_THE_OWNER', instance_ref, pid: record.pid, process_identity_proven: false, expected_owner_token: record.owner_token });
      }
      if (!live) return freeze({ valid: false, reason: 'STALE_OWNERSHIP', instance_ref, pid: record.pid, process_identity_proven: false, detail: 'no live process with that pid' });
      if (live.process_start_marker !== record.process_start_marker) {
        return freeze({ valid: false, reason: 'PID_REUSED', instance_ref, pid: record.pid, process_identity_proven: false, recorded_start_marker: record.process_start_marker, live_start_marker: live.process_start_marker ?? null, detail: 'the pid now belongs to a different process' });
      }
      return freeze({ valid: true, reason: 'OWNED', instance_ref, pid: record.pid, owner_token: record.owner_token, process_identity_proven: true });
    },
  });
}

/**
 * The restart executor. It enforces the monitor's decision, the restart policy it was handed and the
 * checkpoint/readiness hooks; it never decides health and never invents a threshold.
 */
export function createRestartSupervisor({
  monitor,
  ownership,
  processes,
  checkpoint = null,
  readiness = null,
  policy = {},
  clock = () => new Date().toISOString(),
} = {}) {
  if (!isPlainObject(monitor) || typeof monitor.decidePressure !== 'function' || typeof monitor.sense !== 'function' || typeof monitor[PRESSURE_ISSUER] !== 'function') {
    throw new RuntimeSupervisorError('INVALID_PRESSURE', 'the restart supervisor requires the health monitor, including its pressure issuer');
  }
  if (!isPlainObject(ownership) || typeof ownership.validate !== 'function') {
    throw new RuntimeSupervisorError('INVALID_OWNERSHIP', 'the restart supervisor requires the ownership registry');
  }
  if (!isPlainObject(processes) || typeof processes.signal !== 'function') {
    throw new RuntimeSupervisorError('INVALID_INSTANCE', 'a process port with signal() is required');
  }
  const restartPolicy = validateRestartPolicy({ ...DEFAULT_RESTART_POLICY, ...(isPlainObject(policy) ? policy : {}) });
  const state = new Map();
  const decisions = [];
  const journal = [];

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new RuntimeSupervisorError('INVALID_INSTANCE', 'clock() must return a real ISO-8601 UTC instant');
    return produced;
  };

  const ensure = instance_ref => {
    if (!state.has(instance_ref)) {
      state.set(instance_ref, { instance_ref, runtime_state: 'RUNNING', restarts: 0, last_restart_at: null, safe_mode_reason: null, suspended_reason: null, checkpoints: [], terminations: [] });
    }
    return state.get(instance_ref);
  };

  const backoffFor = attempts => Math.min(restartPolicy.backoff_cap_ms, restartPolicy.backoff_base_ms * restartPolicy.backoff_factor ** Math.max(0, attempts - 1));

  const refuse = (instance, code, detail, extra = {}) => {
    journal.push(freeze({ event: 'RESTART_REFUSED', instance_ref: instance.instance_ref, code, at: currentTimestamp(), ...extra }));
    return freeze({ restarted: false, refused: true, code, detail, instance_ref: instance.instance_ref, runtime_state: instance.runtime_state, process_signalled: false, ...extra });
  };

  function currentTimestamp() { return now(); }

  const api = {
    policy: () => freeze(clone(restartPolicy)),

    stateFor(instance_ref) {
      const instance = state.get(instance_ref);
      if (!instance) throw new RuntimeSupervisorError('UNKNOWN_INSTANCE', `no runtime state for ${instance_ref}`);
      return freeze(clone(instance));
    },

    /**
     * Execute a restart for one instance. Every precondition is checked BEFORE any signal is sent, so a
     * refused restart has no side effect at all.
     */
    restart({ decision, instance_ref, owner_token = null, live_processes = [], at: when } = {}) {
      const decisionRef = isPlainObject(decision) && isText(decision.instance_ref) ? decision.instance_ref : null;
      const target = isText(instance_ref) ? instance_ref : decisionRef;
      if (!isText(target)) throw new RuntimeSupervisorError('INVALID_INSTANCE', 'instance_ref is required');
      const instance = ensure(target);

      if (!isPlainObject(decision) || decision.kind !== 'PRESSURE' || !isText(decision.policy_ref) || !isRealInstant(decision.decided_at) || monitor[PRESSURE_ISSUER](decision) !== true) {
        return refuse(instance, 'PRESSURE_REQUIRED', 'a restart may only be executed from a pressure decision minted by this health monitor');
      }
      decisions.push(freeze(clone(decision)));
      if (decisionRef !== target) {
        return refuse(instance, 'PRESSURE_REQUIRED', `the decision is for ${String(decisionRef)}, not ${target}`);
      }
      if (decision.verdict !== 'PRESSURE' || decision.action !== 'RESTART') {
        return refuse(instance, 'PRESSURE_REQUIRED', `the monitor decided ${decision.verdict}/${decision.action}, not PRESSURE/RESTART`, { health: decision.health });
      }
      if (!isPlainObject(decision.thresholds)) {
        return refuse(instance, 'POLICY_IS_MONITOR_OWNED', 'the decision carries no pressure thresholds; the supervisor does not own health policy');
      }
      if (instance.runtime_state === 'SAFE_MODE') {
        return refuse(instance, 'SAFE_MODE_ACTIVE', instance.safe_mode_reason ?? 'safe mode is active');
      }
      if (instance.restarts >= restartPolicy.max_restarts) {
        instance.runtime_state = 'SAFE_MODE';
        instance.safe_mode_reason = `restart budget exhausted after ${instance.restarts} restarts`;
        instance.terminations.push(freeze({ at: currentTimestamp(), kind: 'SAFE_MODE_ENTERED', restarts: instance.restarts }));
        return refuse(instance, 'RESTART_BUDGET_EXHAUSTED', instance.safe_mode_reason, { safe_mode: true, restarts: instance.restarts });
      }
      const timestamp = when ?? now();
      if (!isRealInstant(timestamp)) throw new RuntimeSupervisorError('INVALID_INSTANCE', 'at must be a real ISO-8601 UTC instant');
      if (instance.last_restart_at !== null) {
        const last_ms = instantMs(instance.last_restart_at);
        const now_ms = instantMs(timestamp);
        // A cooldown whose arithmetic is NaN is no cooldown at all: an uninterpretable instant holds the
        // brake rather than releasing it.
        const elapsed = last_ms === null || now_ms === null ? 0 : now_ms - last_ms;
        const required = backoffFor(instance.restarts);
        if (elapsed < required) {
          return refuse(instance, 'COOLDOWN_ACTIVE', `only ${elapsed}ms since the last restart; ${required}ms required`, { retry_after_ms: required - elapsed, backoff_ms: required });
        }
      }

      // Ownership must prove this exact process before anything is signalled.
      const validation = ownership.validate({ instance_ref: target, live_processes, owner_token });
      if (!validation.valid) {
        return refuse(instance, validation.reason === 'PID_REUSED' ? 'PID_REUSED' : validation.reason === 'NOT_THE_OWNER' ? 'NOT_THE_OWNER' : 'STALE_OWNERSHIP', validation.detail ?? 'ownership is not proven', { ownership: validation, process_signalled: false });
      }

      // Checkpoint before the restart; no checkpoint means no restart.
      let checkpoint_result = null;
      if (checkpoint === null) {
        return refuse(instance, 'CHECKPOINT_REQUIRED', 'no before-restart checkpoint hook is configured');
      }
      try {
        checkpoint_result = checkpoint.capture({ instance_ref: target, decision_id: decision.decision_id });
      } catch (error) {
        return refuse(instance, 'CHECKPOINT_FAILED', `checkpoint failed: ${String(error?.message ?? error)}`);
      }
      if (!isPlainObject(checkpoint_result) || !isText(checkpoint_result.checkpoint_ref)) {
        return refuse(instance, 'CHECKPOINT_FAILED', 'the checkpoint hook returned no checkpoint reference');
      }

      // The port is signalled inside a guard: a throwing port must leave a typed refusal and a consistent
      // state, not an untyped error after work was already recorded as done.
      let signal_result = null;
      try {
        signal_result = processes.signal({ instance_ref: target, pid: validation.pid, signal: 'RESTART', owner_token: validation.owner_token });
      } catch (error) {
        return refuse(instance, 'PROCESS_SIGNAL_FAILED', `the process port failed to signal pid ${validation.pid}: ${String(error?.message ?? error)}`, { pid: validation.pid, checkpoint_ref: checkpoint_result.checkpoint_ref, signal_error: true });
      }
      instance.checkpoints.push(freeze({ at: timestamp, checkpoint_ref: checkpoint_result.checkpoint_ref, decision_id: decision.decision_id }));
      instance.restarts += 1;
      instance.last_restart_at = timestamp;
      instance.runtime_state = 'RESTARTING';
      instance.terminations.push(freeze({ at: timestamp, kind: 'RESTART_SIGNALLED', pid: validation.pid, restarts: instance.restarts }));
      journal.push(freeze({ event: 'RESTART_EXECUTED', instance_ref: target, at: timestamp, restarts: instance.restarts, checkpoint_ref: checkpoint_result.checkpoint_ref }));
      // The decision has now been spent: replaying it cannot buy a second restart.
      monitor[PRESSURE_ISSUER](decision, true);

      // A resume requires the readiness hook to confirm the instance is actually back. A hook that throws is
      // an unconfirmed resume, never a half-applied one.
      let resumed = false;
      let resume_withheld_reason = null;
      if (readiness === null) {
        instance.runtime_state = 'SUSPENDED';
        instance.suspended_reason = 'NO_READINESS_HOOK';
        resume_withheld_reason = 'NO_READINESS_HOOK';
      } else {
        let verdict = null;
        let readiness_error = null;
        try {
          verdict = readiness.confirm({ instance_ref: target, checkpoint_ref: checkpoint_result.checkpoint_ref });
        } catch (error) {
          readiness_error = String(error?.message ?? error);
        }
        // An answer that names an instance or checkpoint must name this one: a confirmation for somebody
        // else is not this instance's resume.
        const confirmed_for_other = isPlainObject(verdict)
          && ((isText(verdict.instance_ref) && verdict.instance_ref !== target)
            || (isText(verdict.checkpoint_ref) && verdict.checkpoint_ref !== checkpoint_result.checkpoint_ref));
        if (verdict === true || (isPlainObject(verdict) && verdict.ready === true)) {
          if (confirmed_for_other) {
            instance.runtime_state = 'SUSPENDED';
            instance.suspended_reason = 'READINESS_CONFIRMED_FOR_ANOTHER';
            resume_withheld_reason = 'READINESS_CONFIRMED_FOR_ANOTHER';
          } else {
            instance.runtime_state = 'RUNNING';
            instance.suspended_reason = null;
            resumed = true;
          }
        } else {
          instance.runtime_state = 'SUSPENDED';
          instance.suspended_reason = readiness_error === null ? 'READINESS_NOT_CONFIRMED' : 'READINESS_CHECK_FAILED';
          resume_withheld_reason = instance.suspended_reason;
        }
      }
      // An unrecordable port answer must not escape as an untyped error after a real restart happened.
      let signal_snapshot = null;
      try {
        signal_snapshot = freeze(clone(signal_result ?? null));
      } catch (error) {
        journal.push(freeze({ event: 'SIGNAL_RESULT_UNRECORDABLE', instance_ref: target, at: timestamp, detail: String(error?.message ?? error) }));
      }
      return freeze({
        restarted: true,
        refused: false,
        code: 'RESTARTED',
        instance_ref: target,
        restarts: instance.restarts,
        runtime_state: instance.runtime_state,
        process_signalled: true,
        pid: validation.pid,
        checkpoint_ref: checkpoint_result.checkpoint_ref,
        resumed,
        resume_withheld_reason,
        readiness_confirmed: resumed,
        signal_result: signal_snapshot,
        other_instances_touched: [],
        safe_mode: instance.runtime_state === 'SAFE_MODE',
      });
    },

    /**
     * Reconcile the queue after a restart. A job that is terminal in authoritative state must not come back
     * as active, no matter what a recovered local queue claims.
     */
    reconcileQueue({ active = [], terminal = [], at: when } = {}) {
      if (!Array.isArray(active) || !Array.isArray(terminal)) {
        // Silently treating a malformed terminal list as empty is how a finished job resurrects.
        throw new RuntimeSupervisorError('INVALID_INSTANCE', 'active and terminal must be arrays of job references');
      }
      const terminalIds = new Set(terminal.map(entry => (isText(entry) ? entry : entry?.job_ref)).filter(isText));
      const resumed = [];
      const dropped = [];
      const malformed = [];
      for (const entry of active) {
        const job_ref = isText(entry) ? entry : entry?.job_ref;
        // An entry this layer cannot read is reported, not quietly forgotten: a lost active job looks
        // exactly like a job that never existed.
        if (!isText(job_ref)) { malformed.push({ entry: isPlainObject(entry) ? 'OBJECT_WITHOUT_JOB_REF' : typeof entry }); continue; }
        if (terminalIds.has(job_ref)) dropped.push(job_ref);
        else resumed.push(job_ref);
      }
      const timestamp = when ?? now();
      if (!isRealInstant(timestamp)) throw new RuntimeSupervisorError('INVALID_INSTANCE', 'at must be a real ISO-8601 UTC instant');
      journal.push(freeze({ event: 'QUEUE_RECONCILED', at: timestamp, resumed: resumed.length, dropped: dropped.length, malformed: malformed.length }));
      return freeze({
        resumed_jobs: resumed,
        dropped_terminal_jobs: dropped,
        malformed_active_entries: freeze(malformed),
        terminal_did_not_resurrect: dropped.length === 0 || resumed.every(job => !terminalIds.has(job)),
        authoritative_state_wins: true,
        reconciled_at: timestamp,
      });
    },

    /** Supervise several instances: one crash never touches an unrelated instance. */
    supervise({ instances = [], decisions: supplied = [], live_processes = [], at: when } = {}) {
      if (!Array.isArray(instances) || !Array.isArray(supplied) || !Array.isArray(live_processes)) {
        // A malformed input must be a typed refusal, never an untyped TypeError part-way through the set.
        throw new RuntimeSupervisorError('INVALID_INSTANCE', 'instances, decisions and live_processes must be arrays');
      }
      const outcomes = [];
      for (const instance of instances) {
        const instance_ref = isText(instance) ? instance : instance?.instance_ref;
        const decision = supplied.find(entry => entry?.instance_ref === instance_ref) ?? null;
        outcomes.push(api.restart({ decision, instance_ref, live_processes, at: when }));
      }
      const restarted = outcomes.filter(outcome => outcome.restarted).map(outcome => outcome.instance_ref);
      return freeze({
        outcomes: freeze(outcomes),
        restarted,
        untouched: instances.map(entry => (isText(entry) ? entry : entry?.instance_ref)).filter(ref => !restarted.includes(ref)),
        other_instances_terminated: [],
        supervised_at: when ?? now(),
      });
    },

    decisions: () => clone(decisions),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
