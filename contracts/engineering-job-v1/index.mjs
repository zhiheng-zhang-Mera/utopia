// Public surface of the Engineering job / event / result / artifact protocol (EM-003).
//
// Engineering domain semantics. Cross-device carriage may use Remote Fabric RPC/EVENT/STREAM, but
// an RF transport envelope never replaces canonical Engineering job/event/result state.
export * from './envelopes.mjs';
export * from './reconcile.mjs';

export const ENGINEERING_JOB_PROTOCOL = Object.freeze({
  id: 'engineering-job-protocol',
  version: 1,
  execution_modes: Object.freeze(['AUTONOMOUS_AGENT', 'SCRIPTED_EXECUTOR', 'INTERACTIVE_AGENT']),
  autonomous_jobs_require_operations: false,
  scripted_jobs_require_operations: true,
  partial_events_can_end_a_job: false,
  terminal_state_is_final: true,
  late_and_duplicate_events_are_idempotent: true,
  artifact_provenance_required: true,
  transport_neutral: true,
});
