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

/**
 * Step 2 additions.
 *
 * `AWAITING_USER` is declared by remote-execution's ACTION_STATES and step 2 requires covering
 * "waiting for user", but no EVENT_KIND maps to it - and minting a new kind would be the parallel
 * vocabulary this module exists to avoid. So attention is carried as an explicit INPUT on apply():
 * a STATUS event with `attention: true` settles AWAITING_USER, which is the truthful way to say
 * "the run is fine and is waiting for the person". Clearing it is the same mechanism in reverse -
 * attention false on the next STATUS - which is also what step 3's RESPOND command will drive.
 *
 * `remote_state` is deliberately SEPARATE from the canonical ACTION state, because a disconnected
 * execution host has not failed and has not succeeded: the run's truth is unchanged while our
 * KNOWLEDGE of it degrades. Collapsing the two would be exactly the false success invariant 5
 * forbids.
 */
export const REMOTE_STATES = Object.freeze(['ONLINE', 'UNKNOWN', 'RECOVERING']);

export const BRIDGE_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'INVALID_SURFACE_RESOLVER', 'UNKNOWN_CORRELATION',
  'DUPLICATE_CORRELATION', 'UNKNOWN_EVENT_KIND', 'OUT_OF_ORDER', 'DUPLICATE_EVENT',
  'LATE_EVENT_AFTER_TERMINAL', 'SURFACE_UNAVAILABLE',
  // step 3
  'UNKNOWN_CONFIRMATION', 'CONFIRMATION_ALREADY_ANSWERED', 'CONFIRMATION_EXPIRED',
  'INVALID_DECISION', 'NOT_AUTHORIZED_SURFACE',
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
  const counters = { registered: 0, applied: 0, duplicates: 0, out_of_order: 0, late: 0, unprojected: 0, disconnected: 0, confirmations_requested: 0, confirmations_undeliverable: 0, confirmations_answered: 0, confirmations_refused: 0, confirmations_expired: 0 };

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
      remote_state: 'ONLINE',
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
  function apply({ actionRef, sequence, kind, payload = null, attention = false } = {}) {
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
      remote_state: record.remote_state,
      interaction_device_ref: record.interaction_device_ref,
      execution_device_ref: record.execution_device_ref,
      devices_differ: record.devices_differ,
    });

    if (record.terminal) { counters.late += 1; return settled('LATE_EVENT_AFTER_TERMINAL', `${kind} arrived after ${record.state}`); }
    if (record.last_sequence !== null && sequence === record.last_sequence) { counters.duplicates += 1; return settled('DUPLICATE_EVENT', `sequence ${sequence} was already applied`); }
    if (record.last_sequence !== null && sequence < record.last_sequence) { counters.out_of_order += 1; return settled('OUT_OF_ORDER', `sequence ${sequence} is behind ${record.last_sequence}`); }

    // Step 2: attention is an INPUT rather than a minted event kind, and it only applies to a
    // STATUS report. A non-STATUS kind carrying attention is refused as ambiguous rather than
    // guessed at, because "PROGRESS and also waiting for you" has no single truthful state.
    if (attention === true && kind !== 'STATUS') {
      throw new ReturnBridgeError('INVALID_REQUEST', `attention is only meaningful on a STATUS event, not ${kind}`);
    }
    const nextState = attention === true ? 'AWAITING_USER' : (STATE_FOR_KIND[kind] ?? null);
    const previousState = record.state;
    const previousRemote = record.remote_state;
    if (nextState !== null) record.state = nextState;
    // An applied event is first-hand knowledge, so it clears any degraded view of the remote host.
    record.remote_state = 'ONLINE';
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
      remote_state: record.remote_state,
      remote_state_recovered: previousRemote !== 'ONLINE' && record.remote_state === 'ONLINE',
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

  /**
   * The execution host went away mid-run. Step 2's "device disconnect" case, and the one place
   * invariant 5 is easiest to get wrong.
   *
   * A disconnect is NOT a failure and NOT a success: the run's canonical state is left exactly as
   * it was, `terminal` stays false so a later event can still settle it, and only our KNOWLEDGE
   * degrades - reported as remote_state UNKNOWN. Nothing here reports success, and a caller asking
   * "is this a truthful success?" is told no.
   */
  function markDisconnected({ actionRef, detail = null } = {}) {
    const record = correlations.get(actionRef);
    if (!record) throw new ReturnBridgeError('UNKNOWN_CORRELATION', `no correlation for ${String(actionRef)}`);
    const previous = record.remote_state;
    // A terminal run keeps whatever it had: a disconnect after the end changes nothing about a
    // result that already landed. A live run's knowledge degrades to UNKNOWN.
    if (!record.terminal) record.remote_state = 'UNKNOWN';
    counters.disconnected += 1;
    return Object.freeze({
      action_ref: actionRef,
      canonical_state: record.state,
      state_changed: false,          // a disconnect never moves the run's truth
      previous_remote_state: previous,
      remote_state: record.remote_state,
      terminal: record.terminal,
      // Explicit, and the point of the case: a disconnected run is not a success, and a caller
      // must not be able to read it as one.
      truthful_success: false,
      recovered: false,
      detail,
    });
  }

  /**
   * STEP 3 - confirmation routing, timeout and the offline path.
   *
   * The workbook's requirement is exact and has two halves that pull against each other: the
   * confirmation must return to the CURRENT AUTHORIZED interaction surface, and a timeout or an
   * offline surface must follow an EXPLAINABLE recovery path rather than either being dropped or
   * being recorded as a failure. Both are implemented here, and neither is allowed to weaken the
   * other.
   *
   * Note what is NOT here: nothing in this section moves the interaction surface. A handoff changes
   * which device EXECUTES; it must never move where the user is asked, which is the workbook's
   * "handoff does not transfer permissions" read as a routing guarantee.
   */
  const confirmations = new Map();   // promptRef -> record

  const surfaceRefOf = (resolved) => (resolved ? (resolved.device_ref ?? resolved.surface_ref ?? null) : null);

  function resolveNow(ownerRef) {
    try { return resolveSurface({ ownerRef }) ?? null; } catch { return null; }
  }

  function requestConfirmation({ actionRef, promptRef, deadlineMs = 60000, at = clock() } = {}) {
    const record = correlations.get(actionRef);
    if (!record) throw new ReturnBridgeError('UNKNOWN_CORRELATION', `no correlation for ${String(actionRef)}`);
    if (!isText(promptRef)) throw new ReturnBridgeError('INVALID_REQUEST', 'promptRef is required');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new ReturnBridgeError('INVALID_REQUEST', 'deadlineMs must be a positive integer');
    if (confirmations.has(promptRef)) throw new ReturnBridgeError('DUPLICATE_CORRELATION', `${promptRef} already exists`);

    const surface = resolveNow(record.owner_ref);
    const target = surfaceRefOf(surface);
    // Offline/unresolvable is NOT a failure and NOT a silent drop: it is UNDELIVERABLE with a reason
    // and a named recovery path, and it stays open so the user can still answer when they return.
    const status = target === null ? 'UNDELIVERABLE' : 'PENDING';
    const entry = {
      prompt_ref: promptRef, action_ref: actionRef, status,
      delivered_to: target,
      asked_on: target,
      deadline_at: at,
      deadline_ms: deadlineMs,
      answer: null,
      reason: target === null ? 'no authorized interaction surface is currently reachable' : null,
      recovery: target === null
        ? Object.freeze({ code: 'AWAIT_SURFACE', detail: 'the prompt is held, not lost, and will be delivered when an authorized surface returns', next: 'RESUME_WHEN_AUTHORIZED' })
        : Object.freeze({ code: 'ANSWERABLE', detail: 'awaiting a response on the current authorized surface', next: 'RESPOND' }),
    };
    confirmations.set(promptRef, entry);
    counters.confirmations_requested += 1;
    if (status === 'UNDELIVERABLE') counters.confirmations_undeliverable += 1;
    return Object.freeze({ ...entry });
  }

  /**
   * A response is only accepted from the CURRENT authorized surface. This is the half of step 3
   * that is easy to fake: accepting a response from any device that knows the prompt id would let a
   * stale or wrong device answer for the user.
   */
  function respond({ promptRef, command = 'RESPOND', decision, viaDeviceRef } = {}) {
    const entry = confirmations.get(promptRef);
    if (!entry) throw new ReturnBridgeError('UNKNOWN_CONFIRMATION', `no confirmation for ${String(promptRef)}`);
    if (entry.status === 'ANSWERED') throw new ReturnBridgeError('CONFIRMATION_ALREADY_ANSWERED', `${promptRef} was already answered with ${entry.answer}`);
    if (!['APPROVE', 'DENY'].includes(decision)) throw new ReturnBridgeError('INVALID_DECISION', `decision must be APPROVE or DENY, not ${String(decision)}`);
    if (command !== 'RESPOND') throw new ReturnBridgeError('INVALID_REQUEST', `the only control command here is RESPOND, not ${String(command)}`);

    const record = correlations.get(entry.action_ref);
    const surface = resolveNow(record.owner_ref);
    const current = surfaceRefOf(surface);
    const from = isText(viaDeviceRef) ? viaDeviceRef : null;
    if (current === null || from === null || from !== current) {
      counters.confirmations_refused += 1;
      return Object.freeze({
        prompt_ref: promptRef, accepted: false, verdict: 'NOT_AUTHORIZED_SURFACE',
        via_device_ref: from, current_surface_ref: current,
        detail: current === null
          ? 'no authorized interaction surface is currently reachable, so no response can be attributed'
          : `${String(from)} is not the current authorized interaction surface (${current})`,
      });
    }

    entry.status = 'ANSWERED';
    entry.answer = decision;
    entry.answered_via = from;
    counters.confirmations_answered += 1;
    return Object.freeze({
      prompt_ref: promptRef, accepted: true, verdict: 'ANSWERED', answer: decision,
      via_device_ref: from, current_surface_ref: current,
      action_ref: entry.action_ref,
    });
  }

  /**
   * The timeout path. An expired prompt is EXPLAINED and RECOVERABLE, never a failure: the run keeps
   * whatever state it had, an open prompt stays open for a later answer, and the caller is told the
   * reason and the next step.
   */
  function expire({ promptRef, now = clock() } = {}) {
    const entry = confirmations.get(promptRef);
    if (!entry) throw new ReturnBridgeError('UNKNOWN_CONFIRMATION', `no confirmation for ${String(promptRef)}`);
    if (entry.status === 'ANSWERED') return Object.freeze({ prompt_ref: promptRef, status: 'ANSWERED', expired: false, reason: 'already answered; a timeout cannot retract an answer' });
    entry.status = 'EXPIRED';
    counters.confirmations_expired += 1;
    return Object.freeze({
      prompt_ref: promptRef,
      action_ref: entry.action_ref,
      status: 'EXPIRED',
      expired: true,
      at: now,
      // Explainable, and explicitly not terminal: the workbook forbids turning a timeout into a
      // failure, and it forbids asking the user to go to another device.
      reason: 'the user did not answer within the deadline',
      recovery: Object.freeze({ code: 'STILL_ANSWERABLE', detail: 'the prompt remains open and the run is unchanged; no device change is required of the user', next: 'RESPOND_WHEN_READY' }),
      truthful_success: false,
    });
  }

  return Object.freeze({
    register,
    handoff,
    apply,
    markDisconnected,
    requestConfirmation,
    respond,
    expire,
    confirmation: (promptRef) => (confirmations.has(promptRef) ? Object.freeze({ ...confirmations.get(promptRef) }) : null),
    correlation: (actionRef) => (correlations.has(actionRef) ? Object.freeze({ ...correlations.get(actionRef) }) : null),
    stats: () => Object.freeze({ ...counters }),
  });
}
