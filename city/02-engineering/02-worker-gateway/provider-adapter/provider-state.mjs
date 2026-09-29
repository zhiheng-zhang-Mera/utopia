/**
 * UTOPIA · City · Worker Gateway — provider lifecycle state.
 *
 * The named, serialized provider lifecycle state (donor plan AP03 / §1.3):
 *
 *   ACTIVE            the task runs; nothing is waiting on the provider
 *   WAITING_PROVIDER  the task waits because the provider is not ready yet — a
 *                     retry deadline, a rate-limit reset, a session rebuild — and
 *                     it resumes by itself
 *   PAUSED_PROVIDER   the task waits on a provider-side *user* action (login,
 *                     approval, side-effect reconciliation, exhausted budget) and
 *                     must NOT auto-resume
 *
 * Donor: Codex-Boss `src/shared/provider-state.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * Determinism: the donor defaulted `now` to `Date.now()`. Here the clock is a
 * required parameter, so the same call with the same timestamp produces the same
 * record and this module reads no ambient time.
 */

import { providerStateRecord, validateProviderState } from './contracts.mjs';

/**
 * Actions that mean "the provider will come back on its own".
 * Donor: `AUTO_ACTIONS`.
 */
export const AUTO_ACTIONS = Object.freeze(['WAIT', 'RETRY', 'RECONSTRUCT', 'DEFER']);

/**
 * Actions that mean "a human has to do something first".
 * Donor: `PAUSED_ACTIONS`.
 */
export const PAUSED_ACTIONS = Object.freeze(['HUMAN_REQUIRED', 'VERIFY_SIDE_EFFECT']);

/** Default reason for an auto-resuming wait. Donor: `reason || "等待服务商恢复"`. */
export const AUTO_REASON = '等待服务商恢复';

/** Default reason for a human-gated pause. Donor: `reason || "等待服务商人工处理"`. */
export const PAUSED_REASON = '等待服务商人工处理';

/** Default reason for a task that is running. Donor: `reason || "运行中"`. */
export const ACTIVE_REASON = '运行中';

const AUTO_ACTION_SET = new Set(AUTO_ACTIONS);
const PAUSED_ACTION_SET = new Set(PAUSED_ACTIONS);

/**
 * The labels the donor reports for the three states.
 *
 * Note the donor's own wording: even ACTIVE reads "等待中" ("waiting"), and the
 * two waiting states name what they are waiting for. That oddity is the donor's
 * and is preserved verbatim rather than tidied.
 */
export const PROVIDER_STATE_LABELS = Object.freeze({
  ACTIVE: '等待中',
  WAITING_PROVIDER: '等待服务商恢复',
  PAUSED_PROVIDER: '等待服务商人工处理',
});

function requireNow(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('now must be a finite millisecond timestamp; this module reads no clock of its own');
  }
  return now;
}

/**
 * Choose the provider lifecycle record for a recovery action.
 *
 * Donor: `stateForRecovery(action, reason, retryAt, now)`. The action sets are
 * closed and an action in neither set yields ACTIVE — the donor's fall-through,
 * not an error. An empty or missing `reason` falls back to that state's default
 * string, exactly as `reason || "…"` did.
 *
 * `retryAt` is present only when it was defined; passing `undefined` leaves the
 * field off the record rather than writing `retryAt: undefined`.
 *
 * @param {string} action one of AUTO_ACTIONS, one of PAUSED_ACTIONS, or anything else
 * @param {string} reason caller wording; falsy falls back to the state's default
 * @param {number|undefined} retryAt optional deadline in milliseconds
 * @param {number} now injected millisecond timestamp used for `updatedAt`
 */
export function stateForRecovery(action, reason, retryAt, now) {
  const clock = requireNow(now);
  let state;
  let fallback;
  let autoResume;
  if (AUTO_ACTION_SET.has(action)) {
    state = 'WAITING_PROVIDER';
    fallback = AUTO_REASON;
    autoResume = true;
  } else if (PAUSED_ACTION_SET.has(action)) {
    state = 'PAUSED_PROVIDER';
    fallback = PAUSED_REASON;
    autoResume = false;
  } else {
    state = 'ACTIVE';
    fallback = ACTIVE_REASON;
    autoResume = true;
  }
  return providerStateRecord({
    state,
    reason: reason || fallback,
    autoResume,
    ...(retryAt !== undefined ? { retryAt } : {}),
    updatedAt: new Date(clock).toISOString(),
  });
}

/**
 * The record for a task paused by a provider-side user action.
 *
 * Donor: `pausedForProvider(reason, now)` — reason is used as given (no default),
 * `autoResume` is false, and `retryAt` is never written: a human-gated pause has
 * no retry deadline.
 */
export function pausedForProvider(reason, now) {
  const clock = requireNow(now);
  return providerStateRecord({
    state: 'PAUSED_PROVIDER',
    reason,
    autoResume: false,
    updatedAt: new Date(clock).toISOString(),
  });
}

/**
 * The human-readable label for a provider state.
 *
 * The donor indexed a literal table with the state and would have returned
 * `undefined` for anything else. This refuses an unknown state instead of
 * handing back `undefined`, so a caller cannot render a blank status.
 */
export function providerStateLabel(state) {
  return PROVIDER_STATE_LABELS[validateProviderState(state)];
}
