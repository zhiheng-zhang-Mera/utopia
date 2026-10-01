// GAI-005 — deterministic + JEV triage routing.
export {
  TRIAGE_ROUTING_CONTRACT_VERSION,
  CHANNELS,
  INTENTS,
  COMPLEXITIES,
  RISKS,
  DESTRUCTIVE_RISKS,
  RECOMMENDATION_SOURCES,
  FALLBACK_REASONS,
  TRIAGE_CODES,
  EXECUTION_FIELDS,
  DEFAULT_TRIAGE_POLICY,
  TriageError,
  createTriageRouter,
  normalizeJevOutput,
  findExecutionFields,
  isIsoInstant,
} from './triage-routing.mjs';
