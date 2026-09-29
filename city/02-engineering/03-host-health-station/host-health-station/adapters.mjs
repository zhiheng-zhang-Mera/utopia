/**
 * UTOPIA · City · Host Health Station — action adapters.
 *
 * Ported from the donor `dsh-health-scheduler` src/adapters/types.js @ 985e2b7;
 * see DONOR.json for the porting ledger. Behaviour is unchanged.
 *
 * Action adapters.
 *
 * This plugin decides; it does not act on the operating system. Every action that
 * leaves the process goes through an adapter, which is the only place allowed to
 * know how the capability is reached:
 *
 * - {@link RestartAdapter} talks to the `dsh-restart` bundle when it is installed.
 *   When it is not, the capability is reported `unavailable` and monitoring
 *   continues unchanged.
 * - {@link WorkerControlAdapter} asks the harness to lower its own concurrency.
 *   It never touches worker internals.
 *
 * @module host-health-station/adapters
 */
/**
 * A restart adapter that always reports `unavailable`.
 *
 * This is what the scheduler uses when `dsh-restart` is not installed. It exists
 * so that "restart is impossible" is a normal, well-typed outcome rather than a
 * `null` check scattered through the decision path.
 */
export class UnavailableRestartAdapter {
  id = 'restart-unavailable';
  capability = 'unavailable';
  /** Why the capability is unavailable, surfaced in audit records. */
  reason;
  constructor(reason = 'dsh-restart is not installed in this profile') {
    this.reason = reason;
  }
  requestApplicationRestart() {
    return Promise.resolve({ accepted: false, state: 'rejected', reason: this.reason });
  }
  requestSystemRestart() {
    return Promise.resolve({ accepted: false, state: 'rejected', reason: this.reason });
  }
  cancelPendingRestart() {
    return Promise.resolve(false);
  }
}
/** A worker-control adapter that reports `unavailable`. */
export class UnavailableWorkerControlAdapter {
  id = 'worker-control-unavailable';
  capability = 'unavailable';
  /** Why the capability is unavailable, surfaced in audit records. */
  reason;
  constructor(reason = 'no harness worker-control service is bound in this profile') {
    this.reason = reason;
  }
  setConcurrencyLimit() {
    return Promise.resolve();
  }
  pauseNewWorkers() {
    return Promise.resolve();
  }
  resumeNormalConcurrency() {
    return Promise.resolve();
  }
  currentConcurrencyLimit() {
    return null;
  }
}
/**
 * Build the audit outcome for one adapter call.
 * @param {{applied: boolean, adapter: string, detail: string, reference?: string}} outcome - the adapter's raw result.
 * @returns {{applied: boolean, capability: string, adapter: string, detail: string, reference?: string}} the outcome as an audit record.
 */
export function outcomeForAction(outcome) {
  return {
    applied: outcome.applied,
    capability: outcome.applied ? 'available' : 'failed',
    adapter: outcome.adapter,
    detail: outcome.detail,
    ...(outcome.reference === undefined ? {} : { reference: outcome.reference }),
  };
}
