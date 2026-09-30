// GAI-007 — device-aware remote execution + result return.
export {
  REMOTE_EXECUTION_CONTRACT_VERSION,
  EXECUTION_ROUTES,
  PRESENCE_STATES,
  ACTION_STATES,
  TERMINAL_ACTION_STATES,
  EVENT_KINDS,
  EXCLUSION_REASONS,
  STAGING_POLICIES,
  REMOTE_EXECUTION_PORT,
  REMOTE_EXECUTION_CODES,
  DEFAULT_REMOTE_POLICY,
  RemoteExecutionError,
  createRemoteExecutionRouter,
  isIsoInstant,
} from './remote-execution.mjs';
