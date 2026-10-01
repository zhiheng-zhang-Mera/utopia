// Public surface of the Engineering connector runtime (EM-002).
//
// Provider-neutral and business-agnostic: manifests declare a runtime kind, capabilities, needs
// and budgets; the pipeline isolates every third-party adapter; the managed-process runtime
// bounds startup, heartbeat, logs and restarts; policy (not the adapter) decides permissions.
export * from './manifest.mjs';
export * from './pipeline.mjs';
export * from './runtime.mjs';

export const ENGINEERING_CONNECTOR_CONTRACT = Object.freeze({
  id: 'engineering-connector',
  version: 1,
  adapter_stages: Object.freeze(['detect', 'select', 'adapt', 'validate', 'standardize', 'unify']),
  adapter_fault_isolation: true,
  adapter_may_grant_permissions: false,
  runtime_kinds: Object.freeze(['NODE', 'PYTHON', 'EXE', 'CLI']),
  restart_budget_is_bounded: true,
  terminal_safe_mode: true,
  logs_are_bounded: true,
  caller_policy_may_redact: true,
  new_connector_requires_core_change: false,
});
