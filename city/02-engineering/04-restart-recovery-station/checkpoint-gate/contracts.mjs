/**
 * UTOPIA · Engineering — checkpoint gate contracts.
 *
 * The value shapes one checkpoint attempt is described with, expressed as data plus
 * copy-on-construct factories. Nothing here reaches a harness: these are the shapes a
 * gate result is reported in, and the failure shape every failing path funnels
 * through.
 *
 * Ported from the donor `src/plugin/checkpoint-gate.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd, whose `GateResult` and failure factory
 * are declared there and stay local here.
 *
 * `CheckpointOutcome` is not this module's to declare. The donor's
 * `checkpoint-gate.ts` imports it from the shared contract layer (`import type {
 * CheckpointOutcome, CheckpointPort } from '../shared/types.js'`). In this building
 * that shared layer is the sibling `restart-protocol` module, so the outcome shape
 * and its copy constructor are imported from it and re-exported unchanged: one
 * declaration in the building, exactly as one exists in the donor, and nothing the
 * gate validates can drift from what the rest of the protocol believes a checkpoint
 * answer is.
 *
 * Vocabulary:
 *   GateResult         one checkpoint attempt: the outcome, its elapsed time and
 *                      whether the request may proceed
 *   checkpointFailure  the one shape every failure path produces
 *   NO_CHECKPOINT_PORT / UNBOUND_PORT_ID / UNBOUND_PORT_REASON  the unbound port's
 *                      own declarations, local to checkpoint-gate.ts
 *   CheckpointOutcome  what the harness answered (shared contract layer)
 *   checkpointOutcome  validate one answered outcome, copied (shared too)
 */

// The donor's single shared contract layer, kept as a single source.
import { checkpointOutcome } from '../restart-protocol/contracts.mjs';

export { checkpointOutcome } from '../restart-protocol/contracts.mjs';

/** The machine-readable reasons the gate itself raises. */
export const GATE_FAILURE_REASONS = Object.freeze(['checkpoint_threw', 'checkpoint_timeout']);

/** The reason the unbound port reports: nothing is bound, so nothing can be verified. */
export const NO_CHECKPOINT_PORT = 'no_checkpoint_port';

/** The donor's default reason for an unbound port. */
export const UNBOUND_PORT_REASON = 'no checkpoint port is bound in this profile';

/** The donor's port id for the unbound port. */
export const UNBOUND_PORT_ID = 'checkpoint-unbound';

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

/** A non-empty string, for fields the shape cannot do without. */
function requireText(value, field) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

/**
 * Build the failure outcome every failing path produces.
 *
 * One factory, so a missing port, a throw, a timeout and an explicit `safe: false`
 * are indistinguishable in shape: no checkpoint, therefore no restart.
 *
 * @param {unknown} reason
 * @param {unknown} detail
 */
export function checkpointFailure(reason, detail) {
  return Object.freeze({
    safe: false,
    reason: requireText(reason, 'outcome.reason'),
    checkpointId: null,
    resumeToken: null,
    completed: false,
    detail: requireText(detail, 'outcome.detail'),
  });
}

/**
 * Validate and copy one gate result.
 *
 * @param {{outcome: object, elapsedMs: unknown, authorized: unknown}} result
 */
export function gateResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('gate result must be an object');
  const elapsedMs = result.elapsedMs;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) throw new TypeError('gate result.elapsedMs must be a finite number');
  return Object.freeze({
    outcome: checkpointOutcome(result.outcome),
    elapsedMs,
    authorized: requireBoolean(result.authorized, 'gate result.authorized'),
  });
}
