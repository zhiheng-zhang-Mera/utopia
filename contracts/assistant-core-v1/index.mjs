// Public surface of the Assistant Core / Shared Brain runtime (BA-002).
//
// One logical assistant identity, one authoritative durable state, many
// embodiment-specific ContextProjections. Embodiment-local scratch state is never
// authoritative until it is explicitly promoted through a typed durable record.
export * from './core.mjs';
export * from './profile-port.mjs';

export const ASSISTANT_CORE_CONTRACT = Object.freeze({
 id: 'assistant-core',
 version: 1,
 one_logical_identity: true,
 authoritative_state_per_assistant: 1,
 projections_per_embodiment: 1,
 transient_is_authoritative: false,
 promotion_requires_revision_check: true,
 recovery_invalidates_previous_sessions: true
});
