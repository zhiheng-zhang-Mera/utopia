// Explainable pressure and eligibility inputs for multi-device rescheduling (RS-202).
//
// Step 2 asks for pressure/eligibility inputs that are EXPLAINABLE: current session and provider
// concurrency, device load, device reachability, policy, and user disablement. Two rules shape
// everything here, and both come from the workbook's own prohibitions:
//
//   - A SINGLE CPU/GPU figure is never "the device is busy". The workbook forbids it outright, so load
//     is a VECTOR over named dimensions and a partial vector is reported as partially unobserved
//     rather than silently averaged into a confident number.
//   - UNKNOWN load is NOT idle. The workbook's review list names stale telemetry as an attack, so a
//     device whose load could not be established is NOT eligible. Treating absence as spare capacity
//     is exactly the vulnerability this contract exists to close.
//
// Eligibility here means SCHEDULABLE ONLY. Nothing in this module reads or writes trust, permission or
// scope, because the workbook forbids crossing the Remote Fabric trust boundary and the completion
// gate requires that pressure may affect scheduling but must never rewrite permissions.
//
// LAYERING NOTE: this module deliberately does NOT import the General AI registry contract. Enablement
// is compared against the same ENABLED/DISABLED spellings by literal, and that alignment is stated here
// rather than enforced by a cross-layer import, because 00-foundation code reaching into a contract
// directory would invert the dependency direction. fleet-routing already defines its own vocabularies
// (FLEET_NODE_STATES, REACHABLE spellings) for the same reason.
export const PRESSURE_CONTRACT_VERSION = 1;

/** The explainable inputs step 2 names, kept as an explicit list so no factor can be added silently. */
export const PRESSURE_FACTORS = Object.freeze([
  'SESSION_CONCURRENCY',
  'PROVIDER_CONCURRENCY',
  'DEVICE_LOAD',
  'DEVICE_REACHABILITY',
  'USER_ENABLEMENT',
  'POLICY',
]);

/**
 * Load dimensions. Deliberately a vector, because the prohibition is about collapsing load to one
 * metric — a device can be idle on CPU and saturated on IO, and a model that cannot express that will
 * mis-schedule under exactly the conditions this task exists for.
 */
export const LOAD_DIMENSIONS = Object.freeze(['cpu', 'memory', 'gpu', 'io', 'network']);

/** Device states that refuse work, mirroring the fleet vocabulary rather than re-minting it. */
export const REFUSING_STATES = Object.freeze(['FAILED', 'DISABLED', 'OFFLINE']);

/** Presence states from which work can actually be placed. BUSY is reachable but not spare. */
export const REACHABLE_STATES = Object.freeze(['ONLINE', 'BUSY', 'DEGRADED']);

/** Why a candidate is or is not schedulable. Ordered by precedence below. */
export const ELIGIBILITY_REASONS = Object.freeze([
  'ELIGIBLE',
  'USER_DISABLED',
  'REFUSING_WORK',
  'UNREACHABLE',
  'POLICY_EXCLUDED',
  'AT_CAPACITY',
  'PRESSURE_PAUSED',
  'LOAD_UNKNOWN',
  'SESSION_CONGESTED',
]);

/**
 * Which reason wins when several apply, highest first. Each step is a judgement, not an accident:
 *   - USER_DISABLED first: the user's instruction outranks observation, and it is the only reason they
 *     can act on directly. Reporting capacity pressure for a device the user switched off would imply
 *     that waiting would help.
 *   - REFUSING_WORK before UNREACHABLE: a device that has declared itself FAILED or DISABLED has said
 *     something more specific than "we cannot currently see it".
 *   - The resource reasons last, so a policy or capacity problem is reported as such rather than being
 *     hidden behind an unobserved load figure.
 *   - SESSION_CONGESTED last of all: it is the reason that a still-eligeible device is momentarily
 *     unsuitable, which is the case the queue/alternate path exists to handle.
 */
export const ELIGIBILITY_PRECEDENCE = Object.freeze([
  'USER_DISABLED',
  'REFUSING_WORK',
  'UNREACHABLE',
  'POLICY_EXCLUDED',
  'AT_CAPACITY',
  'LOAD_UNKNOWN',
  'PRESSURE_PAUSED',
  'SESSION_CONGESTED',
  'ELIGIBLE',
]);

export const DEFAULT_PRESSURE_POLICY = Object.freeze({
  policy_ref: 'policy:rs-pressure-default',
  /** Concurrency ceilings, per session and per provider. Absent means "not configured", not "unlimited". */
  max_session_concurrency: 1,
  max_provider_concurrency: 2,
  /** Load at or above this pauses placement, mirroring foreman's pressure_pause_threshold. */
  pressure_pause_threshold: 0.9,
  /** Minimum share of the load vector that must be observed before load is trusted at all. */
  min_observed_dimensions: 1,
});

const rank = reason => {
  const index = ELIGIBILITY_PRECEDENCE.indexOf(reason);
  return index === -1 ? ELIGIBILITY_PRECEDENCE.length : index;
};
const worst = reasons => reasons.slice().sort((a, b) => rank(a) - rank(b))[0] ?? 'LOAD_UNKNOWN';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ratio = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * Collapse a load VECTOR into a pressure figure, and say how much of the vector was actually observed.
 *
 * A missing dimension is not zero: it is UNOBSERVED. This is the whole reason the function returns
 * `observed` and `missing` rather than only a number, because a caller that only receives a number
 * cannot tell "idle" apart from "we have no idea", and that distinction is the difference between
 * queueing harmlessly and stampeding a saturated device.
 */
export function loadPressure({ load, policy = DEFAULT_PRESSURE_POLICY } = {}) {
  const unknown = detail => Object.freeze({
    pressure: null, mean: null, binding_dimension: null, known: false,
    observed: Object.freeze([]), missing: Object.freeze([...LOAD_DIMENSIONS]), detail,
  });
  if (!isPlainObject(load)) return unknown('no load vector was supplied');
  const observed = [];
  const missing = [];
  const contributions = [];
  for (const dimension of LOAD_DIMENSIONS) {
    const value = ratio(load[dimension]);
    if (value === null) { missing.push(dimension); continue; }
    observed.push(dimension);
    contributions.push({ dimension, value });
  }
  const minimum = Number.isSafeInteger(policy?.min_observed_dimensions) ? policy.min_observed_dimensions : 1;
  if (observed.length < minimum) {
    return Object.freeze({
      pressure: null, known: false,
      observed: Object.freeze(observed), missing: Object.freeze(missing),
      detail: `only ${observed.length} of ${LOAD_DIMENSIONS.length} load dimensions observed, below the minimum of ${minimum}`,
    });
  }
  /**
   * The BINDING constraint is the maximum observed dimension, NOT the average.
   *
   * This was originally an average and the tests caught what that gets wrong: a device at 95% CPU with
   * four idle dimensions averaged to 0.27 and was therefore scheduled, which is the precise opposite of
   * noticing saturation. Averaging lets idle capacity dilute a saturated resource, and a saturated
   * resource does not care that something else is idle.
   *
   * This is also the correct reading of the workbook's prohibition. "Do not crudely equate one CPU/GPU
   * figure with the device being busy" forbids IGNORING the other dimensions, not averaging them away:
   * the vector is still required, every dimension is still reported, an unobserved dimension is still
   * unknown rather than free, and `mean` is returned alongside so the difference is visible rather than
   * hidden inside one number.
   */
  const binding = contributions.reduce((max, entry) => (entry.value > max.value ? entry : max), contributions[0]);
  const mean = contributions.reduce((sum, entry) => sum + entry.value, 0) / contributions.length;
  return Object.freeze({
    pressure: binding.value,
    mean,
    binding_dimension: binding.dimension,
    known: true,
    observed: Object.freeze(observed),
    missing: Object.freeze(missing),
    /** Stated so no caller has to infer whether a number was computed from a partial vector. */
    partial: missing.length > 0,
    detail: `pressure ${binding.value.toFixed(4)} binding on ${binding.dimension}${missing.length ? `; unobserved: ${missing.join(', ')}` : ''}`,
  });
}

/**
 * Decide whether a candidate device may be scheduled, and say exactly why not when it may not.
 *
 * Returns reasons rather than a bare boolean because the workbook asks for explainable inputs, and a
 * refusal a user cannot read is indistinguishable from a bug.
 */
export function evaluateEligibility({
  device = {},
  enablement = null,
  sessionConcurrency = 0,
  providerConcurrency = 0,
  load = null,
  policy = DEFAULT_PRESSURE_POLICY,
  excludedByPolicy = false,
} = {}) {
  const reasons = [];
  const evidence = [];
  const config = { ...DEFAULT_PRESSURE_POLICY, ...(isPlainObject(policy) ? policy : {}) };

  // User disablement. Anything that is not an explicit ENABLED is refused, so an unreadable
  // enablement cannot be read as consent - the same rule RS-201 applies in the registry.
  const effectiveEnablement = enablement ?? device.enablement ?? null;
  if (effectiveEnablement === 'DISABLED') { reasons.push('USER_DISABLED'); evidence.push('enablement=DISABLED'); }
  else if (effectiveEnablement !== 'ENABLED') { reasons.push('USER_DISABLED'); evidence.push(`enablement=${String(effectiveEnablement)} is not an explicit ENABLED`); }

  const state = typeof device.state === 'string' ? device.state : null;
  const presence = typeof device.presence === 'string' ? device.presence : null;

  if (state !== null && REFUSING_STATES.includes(state)) { reasons.push('REFUSING_WORK'); evidence.push(`fleet state=${state}`); }
  if (presence !== null && !REACHABLE_STATES.includes(presence)) { reasons.push('UNREACHABLE'); evidence.push(`presence=${presence}`); }
  if (excludedByPolicy) { reasons.push('POLICY_EXCLUDED'); evidence.push('excluded by policy'); }

  const sessionCeiling = config.max_session_concurrency;
  const providerCeiling = config.max_provider_concurrency;
  if (Number.isSafeInteger(sessionCeiling) && sessionConcurrency >= sessionCeiling) {
    reasons.push('AT_CAPACITY'); evidence.push(`session concurrency ${sessionConcurrency} at ceiling ${sessionCeiling}`);
  }
  if (Number.isSafeInteger(providerCeiling) && providerConcurrency >= providerCeiling) {
    reasons.push('AT_CAPACITY'); evidence.push(`provider concurrency ${providerConcurrency} at ceiling ${providerCeiling}`);
  }

  const pressure = loadPressure({ load, policy: config });
  if (!pressure.known) {
    // Not idle: unobserved pressure is refused, and the missing dimensions are named so the refusal is
    // actionable rather than mysterious.
    reasons.push('LOAD_UNKNOWN'); evidence.push(pressure.detail);
  } else if (pressure.pressure >= config.pressure_pause_threshold) {
    reasons.push('PRESSURE_PAUSED'); evidence.push(`pressure ${pressure.pressure.toFixed(4)} at threshold ${config.pressure_pause_threshold}`);
  }

  // A reachable device that is already at its provider ceiling is momentarily unsuitable rather than
  // ineligible, which is the distinction the queue/alternate path exists to consume.
  if (reasons.length === 0 && presence === 'BUSY') { reasons.push('SESSION_CONGESTED'); evidence.push('presence=BUSY'); }

  const reason = reasons.length === 0 ? 'ELIGIBLE' : worst(reasons);
  return Object.freeze({
    pressure_version: PRESSURE_CONTRACT_VERSION,
    eligible: reason === 'ELIGIBLE',
    reason,
    /**
     * Reasons are NOT de-duplicated, deliberately: `reasons[i]` pairs with `evidence[i]`, so a caller
     * reading the refusal sees WHICH facts produced WHICH reason. Two exceeded ceilings are two
     * reasons, because collapsing them would hide that both apply.
     */
    reasons: Object.freeze([...reasons]),
    evidence: Object.freeze(evidence),
    load: pressure,
    factors: Object.freeze([...PRESSURE_FACTORS]),
  });
}

/** The explainable input bundle step 2 names, assembled in one place so every caller sees the same set. */
export function buildPressureInputs({ device = {}, enablement = null, sessionConcurrency = 0, providerConcurrency = 0, load = null, policy = DEFAULT_PRESSURE_POLICY, excludedByPolicy = false } = {}) {
  return Object.freeze({
    pressure_version: PRESSURE_CONTRACT_VERSION,
    factors: Object.freeze({
      SESSION_CONCURRENCY: sessionConcurrency,
      PROVIDER_CONCURRENCY: providerConcurrency,
      DEVICE_LOAD: load === null ? null : Object.freeze({ ...load }),
      DEVICE_REACHABILITY: Object.freeze({ state: device.state ?? null, presence: device.presence ?? null }),
      USER_ENABLEMENT: enablement ?? device.enablement ?? null,
      POLICY: Object.freeze({ ...DEFAULT_PRESSURE_POLICY, ...(isPlainObject(policy) ? policy : {}) }),
    }),
    verdict: evaluateEligibility({ device, enablement, sessionConcurrency, providerConcurrency, load, policy, excludedByPolicy }),
  });
}
