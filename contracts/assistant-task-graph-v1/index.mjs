// BA-006 — Authoritative task graph + ownership/executor separation.
export {
  TASK_GRAPH_CONTRACT_VERSION,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  TASK_SCOPES,
  SIDE_EFFECT_KINDS,
  MUTATION_ROLES,
  CAUSAL_KINDS,
  EXPLICIT_ONLY_FIELDS,
  AUTHORITY_FIELDS,
  TASK_GRAPH_CODES,
  TaskGraphError,
  createTaskGraph,
  findAuthorityFields,
  isSessionShapedRef,
  isDeviceShapedRef,
  isIsoInstant,
} from './task-graph.mjs';
