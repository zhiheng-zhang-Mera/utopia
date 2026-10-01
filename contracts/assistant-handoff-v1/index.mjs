// Public surface of the assistant switching + explicit handoff contract (BA-004).
//
// Switching the foreground assistant is not a handoff; a handoff moves responsibility, never authority.
export * from './handoff.mjs';

export const ASSISTANT_HANDOFF_CONTRACT = Object.freeze({
  id: 'assistant-handoff',
  version: 1,
  multiple_online_assistants: true,
  switching_is_a_handoff: false,
  switching_changes_task_ownership: false,
  handoff_transfers_authority: false,
  recipient_recomputes_permission: true,
  recipient_acceptance_required: true,
  rejected_handoff_changes_ownership: false,
  handoff_restarts_executor: false,
  checkpoint_required_for_transfer: true,
});
