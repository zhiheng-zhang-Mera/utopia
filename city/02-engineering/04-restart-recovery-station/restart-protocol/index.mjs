/**
 * UTOPIA · Engineering — restart-recovery-station — restart protocol, export site.
 *
 * Donor: dsh-restart `src/shared/protocol.ts`, `src/shared/types.ts` and
 * `src/plugin/request-validator.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd.
 *
 * One place to import the restart wire protocol from:
 *
 *   contracts.mjs          vocabularies as frozen data, plus copy-on-construct
 *                          factories and strict validators for every value shape
 *                          (including the three seams: checkpoint, shutdown,
 *                          system shutdown)
 *   canonical-json.mjs     canonicalJson, the ordering a ticket checksum depends on
 *   request-validator.mjs  validateShape, validateRequest, refuse,
 *                          requestFingerprint and the four field bounds
 *
 * This barrel adds nothing of its own: every name below is re-exported unchanged.
 */

export {
  PROTOCOL_VERSION,
  TICKET_SCHEMA_VERSION,
  RESTART_MODES,
  RESTART_PRIORITIES,
  RESTART_REASON_CODES,
  RESTART_REQUEST_STATES,
  RESTART_LOCK_STATES,
  SUPERVISOR_STATES,
  SELF_REASON_CODES,
  restartRequest,
  validateRestartRequest,
  restartResponse,
  validateRestartResponse,
  restartStatus,
  validateRestartStatus,
  restartActiveRequest,
  validateRestartActiveRequest,
  cooldownState,
  validateCooldownState,
  crashLoopState,
  validateCrashLoopState,
  supervisorPresence,
  validateSupervisorPresence,
  restartAttemptRecord,
  validateRestartAttemptRecord,
  restartTicket,
  validateRestartTicket,
  supervisorHeartbeat,
  validateSupervisorHeartbeat,
  supervisorLedger,
  validateSupervisorLedger,
  modeConfig,
  validateModeConfig,
  safetyConfig,
  validateSafetyConfig,
  supervisorConfig,
  validateSupervisorConfig,
  storageConfig,
  validateStorageConfig,
  restartConfig,
  validateRestartConfig,
  restartConfigOverrides,
  validateRestartConfigOverrides,
  normalizedRequest,
  validateNormalizedRequest,
  validationResult,
  validateValidationResult,
  checkpointOutcome,
  validateCheckpointOutcome,
  validatorContext,
  validateValidatorContext,
  checkpointPort,
  validateCheckpointPort,
  shutdownPort,
  validateShutdownPort,
  systemShutdownPort,
  validateSystemShutdownPort,
} from './contracts.mjs';

export { canonicalJson } from './canonical-json.mjs';

export {
  MAX_ID_LENGTH,
  MAX_SOURCE_LENGTH,
  MAX_REASON_CODE_LENGTH,
  MAX_SUMMARY_LENGTH,
  validateShape,
  validateRequest,
  refuse,
  requestFingerprint,
} from './request-validator.mjs';
