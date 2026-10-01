// RS-203 step 1 — the return-and-projection bridge.
//
// WHY THIS EXISTS, established by reading rather than by searching (see
// reports/RS-203/STEP1_SEAM_AUDIT.md section 7): remote-execution already distinguishes the
// interaction device from the execution device and already emits status/progress/partial/final/
// error correlated to one action id, and return-control already knows the authorized interaction
// surface and the return channels. What was missing was the CONNECTION between them - nothing took
// an execution event, settled it into canonical state, and projected it to the current authorized
// surface. That is this module, and it is an INTEGRATION gap, not a vocabulary gap.
//
// IT MINTS TWO THINGS ONLY, and deliberately nothing else:
//   * a correlation record tying one action to the device the user is interacting with AND the
//     device actually executing it, which is invariant 1;
//   * a monotonic ordering guard, so out-of-order and duplicate progress events are settled rather
//     than applied - the workbook's review list names both explicitly.
// Every other value is REUSED: EVENT_KINDS, ACTION_STATES and TERMINAL_ACTION_STATES from
// remote-execution, RETURN_CHANNELS from return-control. No second lifecycle, and no second truth.
//
// INVARIANTS THIS MODULE IS RESPONSIBLE FOR, quoted from the workbook:
//   1. "current interaction device and executing device may differ" - carried as two fields.
//   2. "execution result/progress/attention must return to canonical/shared state, then project to
//      the current authorized surface" - `apply` returns canonical state AND the projection target.
//   5. "on remote disconnect the state must be truthful unknown/degraded/recovering, not false
//      success" - an unprojectable event reports UNKNOWN/DEGRADED and NEVER SUCCEEDED.
// Pure module: the surface resolver and the clock are injected, as this codebase requires.
import {
  ACTION_STATES, EVENT_KINDS, TERMINAL_ACTION_STATES,
} from '../general-ai-remote-execution-v1/remote-execution.mjs';
import { RETURN_CHANNELS } from '../engineering-return-control-v1/return-control.mjs';

export const RETURN_BRIDGE_VERSION = 1;

/** How each execution event kind reaches the user. REUSED channels, no new ones minted. */
export const CHANNEL_FOR_KIND = Object.freeze({
  STATUS: 'STATE',
  PROGRESS: 'PROGRESS',
  PARTIAL: 'STAGE',
  ERROR: 'EVENT',
  FINAL: 'STATE',
  CANCELLED: 'STATE',
});

/** The canonical ACTION state each kind settles to, or null when the kind carries no state change. */
export const STATE_FOR_KIND = Object.freeze({
  STATUS: null,      // a STATUS event reports where we already are; it does not move the state
  PROGRESS: 'RUNNING',
  PARTIAL: 'RUNNING',
  ERROR: 'FAILED',
  FINAL: 'SUCCEEDED',
  CANCELLED: 'CANCELLED',
});

export const BRIDGE_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'INVALID_SURFACE_RESOLVER', 'UNKNOWN_CORRELATION',
  'DUPLICATE_CORRELATION', 'UNKNOWN_EVENT_KIND', 'OUT_OF_ORDER', 'DUPLICATE_EVENT',
  'LATE_EVENT_AFTER_TERMINAL', 'SURFACE_UNAVAILABLE',
]);

export class ReturnBridgeError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'ReturnBridgeError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * @param resolveSurface  injected; called as resolveSurface({ ownerRef }) and expected to answer
 *                        either a surface record or null. Injected because return-control's
 *                        `resolveInteractionSurface` already owns device authorization, and this
 *                        module must not re-implement or second-guess it.
 * @param clock           injected; returns an ISO instant.
 */
export function createReturnBridge({ resolveSurface, clock = () => new Date().toISOString() } = {}) {
  if (typeof resolveSurface !== 'function') throw new ReturnBridgeError('INVALID_SURFACE_RESOLVER', 'resolveSurface must be a function');
  if (typeof clock !== 'function') throw new ReturnBridgeError('INVALID_CLOCK', 'clock must be a function');

  /** actionRef -> correlation record */
  const correlations = new Map();
  const counters = { registered: 0, applied: 0, duplicates: 0, out_of_order: 0, late: 0, unprojected: 0 };

  function register({ actionRef, interactionDeviceRef, executionDeviceRef, ownerRef = null } = {}) {
    if (!isText(actionRef)) throw new ReturnBridgeError('INVALID_REQUEST', 'actionRef is required');
    if (!isText(interactionDeviceRef)) throw new ReturnBridgeError('INVALID_REQUEST', 'interactionDeviceRef is required');
    if (!isText(executionDeviceRef)) throw new ReturnBridgeError('INVALID_REQUEST', 'executionDeviceRef is required');
    if (correlations.has(actionRef)) throw new ReturnBridgeError('DUPLICATE_CORRELATION', `${actionRef} is already correlated`);
    const record = {
      action_ref: actionRef,
      interaction_device_ref: interactionDeviceRef,
      execution_device_ref: executionDeviceRef,
      owner_ref: ownerRef,
      // Invariant 1, asserted rather than assumed: the two devices MAY differ, and a handoff
      // records which side changed. Nothing else in this module ever rewrites the interaction side.
      devices_differ: interactionDeviceRef !== executionDeviceRef,
      state: 'DISPATCHED',
      last_sequence: null,
      applied_events: 0,
      terminal: false,
      registered_at: clock(),
      handed_off_at: null,
    };
    correlations.set(actionRef, record);
    counters.registered += 1;
    return Object.freeze({ ...record });
  }

  /**
   * Record that the EXECUTION device changed while the interaction device did not - invariant 1's
   * second half, and the reason a handoff must not be modelled as a new correlation.
   */
  function handoff({ actionRef, toExecutionDeviceRef } = {}) {
    const record = correlations.get(actionRef);
    if (!record) throw new ReturnBridgeError('UNKNOWN_CORRELATION', `no correlation for ${String(actionRef)}`);
    if (!isText(toExecutionDeviceRef)) throw new ReturnBridgeError('INVALID_REQUEST', 'toExecutionDeviceRef is required');
    const interactionBefore = record.interaction_device_ref;
    record.execution_device_ref = toExecutionDeviceRef;
    record.devices_differ = record.interaction_device_ref !== toExecutionDeviceRef;
    record.handed_off_at = clock();
    return Object.freeze({
      action_ref: actionRef,
      execution_device_ref: toExecutionDeviceRef,
      // Stated as data so a caller can assert it rather than trust it: a handoff NEVER moves the
      // user's interaction surface, which is the workbook's "handoff does not transfer permissions"
      // read as an interaction guarantee.
      interaction_device_ref: record.interaction_device_ref,
      interaction_device_unchanged: record.interaction_device_ref === interactionBefore,
    });
  }

  /**
   * Settle one execution event: order it, map it to canonical ACTION state, and project it.
   *
   * Ordering is by an explicit sequence supplied by the producer. A repeated sequence is a
   * DUPLICATE and is ignored; a lower sequence is OUT_OF_ORDER and is ignored; anything arriving
   * after a terminal state is LATE_EVENT_AFTER_TERMINAL and is ignored. In all three cases the
   * event is NOT applied and the canonical state is unchanged, because applying a stale progress
   * event over a finished run is exactly the false-success the workbook forbids.
   */
  function apply({ actionRef, sequence, kind, payload = null } = {}) {
    const record = correlations.get(actionRef);
    if (!record) throw new ReturnBridgeError('UNKNOWN_CORRELATION', `no correlation for ${String(actionRef)}`);
    if (!EVENT_KINDS.includes(kind)) throw new ReturnBridgeError('UNKNOWN_EVENT_KIND', `${String(kind)} is not one of ${EVENT_KINDS.join(', ')}`);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new ReturnBridgeError('INVALID_REQUEST', 'sequence must be a non-negative integer');

    const settled = (verdict, detail) => Object.freeze({
      action_ref: actionRef,
      kind,
      sequence,
      applied: false,
      verdict,
      detail,
      canonical_state: record.state,
      state_changed: false,
      interaction_device_ref: record.interaction_device_ref,
      execution_device_ref: record.execution_device_ref,
      devices_differ: record.devices_differ,
    });

    if (record.terminal) { counters.late += 1; return settled('LATE_EVENT_AFTER_TERMINAL', `${kind} arrived after ${record.state}`); }
    if (record.last_sequence !== null && sequence === record.last_sequence) { counters.duplicates += 1; return settled('DUPLICATE_EVENT', `sequence ${sequence} was already applied`); }
    if (record.last_sequence !== null && sequence < record.last_sequence) { counters.out_of_order += 1; return settled('OUT_OF_ORDER', `sequence ${sequence} is behind ${record.last_sequence}`); }

    const nextState = STATE_FOR_KIND[kind] ?? null;
    const previousState = record.state;
    if (nextState !== null) record.state = nextState;
    record.last_sequence = sequence;
    record.applied_events += 1;
    record.terminal = TERMINAL_ACTION_STATES.includes(record.state);
    counters.applied += 1;

    const channel = CHANNEL_FOR_KIND[kind];
    // Invariant 2: project to the CURRENT authorized surface. A resolver that cannot answer, or
    // answers null, must not be read as success - it is a truthful UNKNOWN and the canonical state
    // still advances, because the run really did move even if nobody can be told yet.
    let surface = null;
    let projection = 'PROJECTED';
    try {
      surface = resolveSurface({ ownerRef: record.owner_ref }) ?? null;
    } catch (error) {
      surface = null;
      projection = 'DEGRADED';
    }
    if (surface === null) { projection = projection === 'DEGRADED' ? 'DEGRADED' : 'UNKNOWN'; counters.unprojected += 1; }

    return Object.freeze({
      action_ref: actionRef,
      kind,
      sequence,
      applied: true,
      verdict: 'APPLIED',
      channel,
      channel_is_declared: RETURN_CHANNELS.includes(channel),
      canonical_state: record.state,
      previous_state: previousState,
      state_changed: previousState !== record.state,
      state_is_declared: ACTION_STATES.includes(record.state),
      terminal: record.terminal,
      interaction_device_ref: record.interaction_device_ref,
      execution_device_ref: record.execution_device_ref,
      devices_differ: record.devices_differ,
      projection,
      projected_to: surface ? (surface.device_ref ?? surface.surface_ref ?? null) : null,
      // Explicit, and the point of invariant 5: an unprojected result is NEVER reported as success.
      truthful_success: projection === 'PROJECTED' && record.state === 'SUCCEEDED',
      payload,
    });
  }

  return Object.freeze({
    register,
    handoff,
    apply,
    correlation: (actionRef) => (correlations.has(actionRef) ? Object.freeze({ ...correlations.get(actionRef) }) : null),
    stats: () => Object.freeze({ ...counters }),
  });
}
