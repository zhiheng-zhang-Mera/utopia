// Public surface of the Engineering Manager contract (EM-001).
//
// Consumers (EM-002..EM-013, Web/Android control surfaces) import from here.
// Engineering Manager owns Engineering execution semantics only: task truth
// belongs to Shared Task/Action Core, trust/transport to Remote Fabric,
// assistant semantics to Butler and general-AI semantics to General AI Gateway.
export * from './canonical.mjs';
export * from './ownership.mjs';
export * from './envelopes.mjs';
export * from './ports.mjs';
export * from './replay.mjs';

export const ENGINEERING_MANAGER_CONTRACT = Object.freeze({
 id: 'engineering-manager',
 version: 1,
 route: 'ENGINEERING',
 execution_modes: Object.freeze(['AUTONOMOUS_AGENT', 'SCRIPTED_EXECUTOR', 'INTERACTIVE_AGENT']),
 canonical_task_truth_owner: 'Shared Task/Action Core',
 engineering_manager_owns_task_truth: false,
 placement_policy: 'LOCAL_FIRST',
 remote_fallback: 'ASK_USER',
 connector_hub_is_provider_neutral: true
});
