// MESH-301 Step 3 — strict target-device routing intent.
//
// WHY THIS IS A NEW FIELD AND NOT A REUSED ONE
//
// The City already carries two device-ish references and neither of them means what this one means:
//
//   providerRef        which SERVICE/route a run should use (a capability or room provider)
//   handoffTargetRef   which device a FAILED run was MOVED to, written by the handoff bridge after the fact
//
// The user intent here is the opposite direction: the user, up front, says "this task belongs to THAT
// physical device". Reusing either field would smuggle a placement decision through a field whose
// semantics are already load-bearing - `handoffTargetRef` in particular is a *reservation* that the
// claim guard and the reservation-expiry sweep both read, so a user target written there would be
// silently released 15 s later if the device looked offline, which is exactly the silent fallback
// MESH-301 forbids. So this module owns a third, explicitly-named field.
//
// THE FIVE PROPERTIES THE WORKBOOK ASKS FOR, AND WHERE EACH LIVES
//
//   target=Alien  -> only Alien may claim        claimAllowedByTarget()   (used by /node/claim)
//   target=Mech   -> only Mech may claim         claimAllowedByTarget()
//   target offline/unknown -> no silent fallback readTargetIntent() + classifyTarget()
//   duplicate user action -> no double execution requestRef replay in server.mjs + Action idempotencyKey
//   untargeted task -> scheduler unchanged        claimAllowedByTarget() returns true when absent
//
// This file is pure: it decides nothing about liveness and starts nothing. `nodes`, `claimNodeFor` and
// `acceptsWork` are passed in, so the module can be unit-tested without a gateway and cannot quietly
// grow its own opinion about what "online" means.

/** The canonical field name. Deliberately not `providerRef`, deliberately not `handoffTargetRef`. */
export const STRICT_TARGET_FIELD = 'targetDeviceRef';

/** Node identity shape, matching the registration contract in server.mjs. */
const IDENTITY = /^[a-zA-Z0-9-]{1,80}$/;

/** The complete refusal/wait vocabulary. A reason outside this set is a bug, not a new state. */
export const TARGET_REASONS = Object.freeze({
  MALFORMED: 'TARGET_DEVICE_MALFORMED',
  UNKNOWN: 'TARGET_DEVICE_UNKNOWN',
  OFFLINE: 'TARGET_DEVICE_OFFLINE',
  INELIGIBLE: 'TARGET_DEVICE_INELIGIBLE',
  BOUND: 'STRICT_TARGET_BOUND',
});

/**
 * Parse the field as a client sent it.
 *
 * An ABSENT or EMPTY field means "untargeted", and untargeted must behave exactly as before this task
 * existed - that is the no-regression requirement, and it is why absence is not an error.
 */
export function readTargetIntent(raw) {
  if (raw === undefined || raw === null) return { present: false, value: null };
  if (typeof raw !== 'string') {
    return { present: true, ok: false, code: TARGET_REASONS.MALFORMED, message: `${STRICT_TARGET_FIELD} must be a string` };
  }
  const value = raw.trim();
  if (value === '') return { present: false, value: null };
  if (!IDENTITY.test(value)) {
    return { present: true, ok: false, code: TARGET_REASONS.MALFORMED, message: `${STRICT_TARGET_FIELD} "${value}" is not a City node identity` };
  }
  return { present: true, ok: true, value };
}

/**
 * Is this device the one the user named? The complete claim-side rule.
 *
 * Returns true for an untargeted task, which is what keeps the pre-existing scheduler behaviour
 * bit-for-bit: the only tasks this function ever withholds are ones carrying an explicit user target
 * that names somebody else.
 */
export function claimAllowedByTarget(task, deviceRef) {
  const ref = task?.[STRICT_TARGET_FIELD];
  if (typeof ref !== 'string' || ref.length === 0) return true;
  return ref === deviceRef;
}

/** True when the task carries a live user target. */
export function isStrictTarget(task) {
  const ref = task?.[STRICT_TARGET_FIELD];
  return typeof ref === 'string' && ref.length > 0;
}

/** A strict target that has not been taken up yet is WAITING for its device, not up for grabs. */
export function isWaitingForTarget(task, terminal = []) {
  return isStrictTarget(task) && !terminal.includes(task.state) && !task.assignedNodeId;
}

/**
 * KNOWN, ONLINE and ELIGIBLE are three different questions and the workbook needs all three.
 *
 * KNOWN      the identity has registered with this City at least once -> the target is a real reference
 * OFFLINE    known, but not currently heartbeating            -> wait, never fall back
 * INELIGIBLE known and online, but cannot take this work     -> wait, never fall back
 * ELIGIBLE   all three hold                                   -> the target may claim
 *
 * `node` is returned so callers can name the display name in a user-facing message; `nodeId` is the
 * identity, which is the only thing a rule may be keyed on.
 */
export function classifyTarget({ targetDeviceRef, nodes = [], claimNodeFor, acceptsWork, requiredCapabilities = [] }) {
  const node = nodes.find(n => n.id === targetDeviceRef) ?? null;
  if (!node) return { state: 'UNKNOWN', nodeId: targetDeviceRef, node: null, reason: TARGET_REASONS.UNKNOWN, claimable: false };
  if (node.online !== true) return { state: 'OFFLINE', nodeId: node.id, node, reason: TARGET_REASONS.OFFLINE, claimable: false };
  const able = typeof acceptsWork === 'function' && typeof claimNodeFor === 'function'
    ? acceptsWork(claimNodeFor(node), { requiredCapabilities }) === true
    : false;
  if (!able) {
    // NAME WHAT IS MISSING. `TARGET_DEVICE_INELIGIBLE` told an owner that their machine could not take the work but
    // not what it lacked, and on the first real deployment that difference WAS the diagnosis: the target was perfectly
    // healthy, it simply did not implement the node half of the task type being sent. The reason code is unchanged,
    // because existing callers and tests depend on it; the detail is additive.
    const held = new Set(Array.isArray(node.capabilities) ? node.capabilities : []);
    const missing = (requiredCapabilities ?? []).filter(capability => !held.has(capability));
    return { state: 'INELIGIBLE', nodeId: node.id, node, reason: TARGET_REASONS.INELIGIBLE,
      detail: missing.length ? `NODE_MISSING_CAPABILITY:${missing.join(',')}` : null, claimable: false };
  }
  return { state: 'ELIGIBLE', nodeId: node.id, node, reason: null, detail: null, claimable: true };
}

/**
 * Why a strict task was withheld from the device asking for work.
 *
 * `/node/claim` used to answer a failed claim with a bare `task: null`, which is honest but mute: a
 * device cannot tell "there is no work" from "there is work and it is not yours". This produces the
 * difference as data. It is additive, so a node that ignores the new field keeps working.
 */
export function withheldTasks({ tasks = [], deviceRef, terminal = [] }) {
  return tasks
    .filter(t => isWaitingForTarget(t, terminal) && !claimAllowedByTarget(t, deviceRef))
    .map(t => ({
      taskId: t.id,
      targetDeviceRef: t[STRICT_TARGET_FIELD],
      reason: TARGET_REASONS.BOUND,
      heldFor: t[STRICT_TARGET_FIELD],
      askedBy: deviceRef,
    }));
}
