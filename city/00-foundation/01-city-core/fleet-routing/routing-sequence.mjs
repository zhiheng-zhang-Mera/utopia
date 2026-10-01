// The routing sequence for multi-device rescheduling (RS-202 step 3).
//
// Step 3 asks for an ordered sequence: the current device/provider may run directly; otherwise a
// provider switch is OFFERED; if the user does not switch, the scheduler queues or diverts to an
// alternate eligible device; and retry is bounded. Three rules from the workbook shape the design, and
// each is enforced structurally rather than documented:
//
//   - SUGGESTING A SWITCH IS NOT DOING IT. This module ships no function that performs a switch, and
//     every plan carries `executed: false`. The separation cannot be broken by a later caller passing a
//     flag, because the capability was never built.
//   - TRANSIENT NO-RESOURCE IS NOT TASK FAILURE. `terminal_failure` is ALWAYS false here. Routing does
//     not get to end a task; the honest signal is `rescan_required`, because a candidate that is busy
//     now may be free in a minute and one that is disabled may be re-enabled by its user.
//   - INELIGIBILITY AND TEMPORARY ABSENCE ARE DIFFERENT FACTS. A pool where every candidate is
//     structurally refused reports INELIGIBLE; a pool where candidates are merely saturated reports
//     TEMPORARY_NO_RESOURCE. If ANY candidate is merely busy, the pool is temporary - there is hope.
//
// The result always returns to the ORIGIN device. `origin_device_ref` is carried on every path because
// the workbook requires that the user does not have to walk to the executing device to see the result.
import { DEFAULT_PRESSURE_POLICY, evaluateEligibility } from './pressure.mjs';

export const ROUTE_CONTRACT_VERSION = 1;

/** The ordered stages of the sequence, as data so a caller can render them without re-deriving order. */
export const ROUTE_STAGES = Object.freeze(['DIRECT', 'SWITCH_OFFERED', 'ALTERNATE_DEVICE', 'QUEUED', 'EXHAUSTED']);

/** Structural refusals: no amount of waiting makes these schedulable without someone acting. */
export const STRUCTURAL_REASONS = Object.freeze(['USER_DISABLED', 'REFUSING_WORK', 'UNREACHABLE', 'POLICY_EXCLUDED']);

/** Resource refusals: these become schedulable on their own, so they must never be called ineligible. */
export const RESOURCE_REASONS = Object.freeze(['AT_CAPACITY', 'PRESSURE_PAUSED', 'LOAD_UNKNOWN', 'SESSION_CONGESTED']);

export const NO_RESOURCE_KINDS = Object.freeze(['NONE', 'TEMPORARY_NO_RESOURCE', 'INELIGIBLE']);

export const DEFAULT_ROUTE_POLICY = Object.freeze({
  policy_ref: 'policy:rs-route-default',
  /** Bounded, because the workbook forbids resolving concurrency conflicts with unbounded sleep/poll. */
  max_retry_attempts: 3,
  /** Mirrors the presence contract's default queue deadline rather than minting a second one. */
  queue_deadline_ms: 300000,
  /** The 20-minute re-scan figure is an UPPER BOUND used as policy, never the mechanism. */
  rescan_ceiling_ms: 1200000,
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const evaluateCandidate = (candidate, policy) => evaluateEligibility({
  device: { state: candidate?.state ?? null, presence: candidate?.presence ?? null },
  enablement: candidate?.enablement ?? null,
  sessionConcurrency: candidate?.sessionConcurrency ?? 0,
  providerConcurrency: candidate?.providerConcurrency ?? 0,
  load: candidate?.load ?? null,
  policy: policy ?? DEFAULT_PRESSURE_POLICY,
  excludedByPolicy: candidate?.excludedByPolicy === true,
});

/**
 * Decide what the pool as a whole can offer, and keep ineligibility and temporary absence apart.
 *
 * If ANY candidate is merely resource-blocked the answer is TEMPORARY_NO_RESOURCE, because that
 * candidate can become usable without anyone acting. Only when every candidate is structurally refused
 * is the pool INELIGIBLE - and even then this function does not call the task finished.
 */
export function classifyNoResource(verdicts = []) {
  if (verdicts.length === 0) {
    return Object.freeze({ kind: 'TEMPORARY_NO_RESOURCE', detail: 'the pool is empty, which is an absence of candidates rather than a refusal of them', reasons: Object.freeze([]) });
  }
  if (verdicts.some(verdict => verdict.eligible)) {
    return Object.freeze({ kind: 'NONE', detail: 'at least one candidate is eligible', reasons: Object.freeze([]) });
  }
  const reasons = Object.freeze([...new Set(verdicts.map(verdict => verdict.reason))]);
  const resourceBlocked = verdicts.filter(verdict => RESOURCE_REASONS.includes(verdict.reason));
  if (resourceBlocked.length > 0) {
    return Object.freeze({
      kind: 'TEMPORARY_NO_RESOURCE',
      detail: `${resourceBlocked.length} of ${verdicts.length} candidate(s) are only resource-blocked, so the pool can become usable without anything being fixed`,
      reasons,
    });
  }
  return Object.freeze({
    kind: 'INELIGIBLE',
    detail: `every candidate is structurally refused (${reasons.join(', ')}); this needs someone to act, not to wait`,
    reasons,
  });
}

/**
 * Plan the route. This function PLANS; it never runs anything and never switches anything.
 */
export function planRoute({
  originDeviceRef = null,
  current = {},
  alternates = [],
  policy = DEFAULT_ROUTE_POLICY,
  pressurePolicy = DEFAULT_PRESSURE_POLICY,
  userDeclinedSwitch = false,
  attemptsUsed = 0,
  candidateSwitchRef = null,
} = {}) {
  const config = { ...DEFAULT_ROUTE_POLICY, ...(isPlainObject(policy) ? policy : {}) };
  const attempt = Number.isSafeInteger(attemptsUsed) && attemptsUsed >= 0 ? attemptsUsed : 0;
  const retry = Object.freeze({
    attempts_used: attempt,
    max_attempts: config.max_retry_attempts,
    remaining: Math.max(0, config.max_retry_attempts - attempt),
    bounded: true,
  });

  const base = {
    route_version: ROUTE_CONTRACT_VERSION,
    origin_device_ref: originDeviceRef,
    retry,
    /** Results return to where the interaction started; the user never has to follow the work. */
    returns_to: originDeviceRef,
    executed: false,
  };

  // Stage 1: the current device and provider may simply run. This is the common, cheap path.
  const direct = evaluateCandidate(current, pressurePolicy);
  if (direct.eligible) {
    return Object.freeze({
      ...base, stage: 'DIRECT', decision: 'DIRECT', current: direct,
      chosen_device_ref: originDeviceRef, switch_offer: null, queue: null,
      no_resource: Object.freeze({ kind: 'NONE', detail: 'the current device is eligible', reasons: Object.freeze([]) }),
      rescan_required: false,
      terminal_failure: false,
    });
  }

  // Stage 2: offer a provider switch. The offer is DATA; nothing here acts on it.
  if (!userDeclinedSwitch) {
    return Object.freeze({
      ...base, stage: 'SWITCH_OFFERED', decision: 'SWITCH_OFFERED', current: direct,
      chosen_device_ref: null,
      switch_offer: Object.freeze({
        suggested_ref: candidateSwitchRef,
        from_ref: originDeviceRef,
        executed: false,
        requires_user_confirmation: true,
        rationale: candidateSwitchRef === null
          ? 'a switch could be offered but no alternative provider is known'
          : `${candidateSwitchRef} is a candidate alternative; the user decides`,
      }),
      queue: null,
      no_resource: Object.freeze({ kind: 'NONE', detail: 'awaiting the user decision; no resource question is settled yet', reasons: Object.freeze([]) }),
      rescan_required: false,
      terminal_failure: false,
    });
  }

  // Stage 3: the user declined to switch, so look for another eligible device of our own.
  const verdicts = alternates.map(candidate => Object.freeze({ device_ref: candidate?.deviceRef ?? null, ...evaluateCandidate(candidate, pressurePolicy) }));
  const eligible = verdicts.find(verdict => verdict.eligible);
  if (eligible) {
    return Object.freeze({
      ...base, stage: 'ALTERNATE_DEVICE', decision: 'ALTERNATE_DEVICE', current: direct,
      chosen_device_ref: eligible.device_ref, switch_offer: null, queue: null,
      alternates: Object.freeze(verdicts),
      no_resource: Object.freeze({ kind: 'NONE', detail: 'an alternate eligible device was found', reasons: Object.freeze([]) }),
      rescan_required: false,
      terminal_failure: false,
    });
  }

  // Stage 4: nothing spare right now. Queue with a deadline, and say whether it is worth re-scanning.
  const noResource = classifyNoResource(verdicts);
  const exhausted = retry.remaining === 0;
  return Object.freeze({
    ...base, stage: exhausted ? 'EXHAUSTED' : 'QUEUED', decision: exhausted ? 'EXHAUSTED' : 'QUEUED',
    current: direct, chosen_device_ref: null, switch_offer: null,
    alternates: Object.freeze(verdicts),
    queue: Object.freeze({
      deadline_ms: config.queue_deadline_ms,
      rescan_ceiling_ms: config.rescan_ceiling_ms,
      /** Event-driven first: the ceiling is a backstop, not the mechanism. */
      event_driven: true,
      poll_based: false,
    }),
    no_resource: noResource,
    rescan_required: noResource.kind === 'TEMPORARY_NO_RESOURCE',
    /**
     * ALWAYS false, on every path, deliberately. Routing is not the component that decides a task is
     * over: a busy candidate frees up and a disabled one can be re-enabled, so the honest signal is
     * `rescan_required`. The workbook forbids mistaking transient no-resource for terminal failure, and
     * the safest way to honour that is to make the mistake unrepresentable here.
     */
    terminal_failure: false,
  });
}

// NOTE: this module deliberately does NOT re-export DEFAULT_PRESSURE_POLICY or anything else from
// pressure.mjs. index.mjs re-exports the whole directory with `export *`, and a name exported by two
// star sources is AMBIGUOUS - importing it then throws rather than resolving. The vocabulary is owned
// by pressure.mjs and is reachable through the same index.
