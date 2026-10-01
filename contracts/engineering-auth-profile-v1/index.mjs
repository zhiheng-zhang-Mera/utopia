// EM-008 — credential references + persistent connector profiles/sessions.
export {
  AUTH_PROFILE_CONTRACT_VERSION,
  AUTH_MODES,
  AUTH_STATUSES,
  REFERENCE_KINDS,
  MODE_REFERENCE,
  PERSISTABLE_MODES,
  PERSISTENCE_KINDS,
  SECURE_HANDLE_STORE_PORT,
  LEGACY_SOURCES,
  AUTH_PROFILE_CODES,
  AuthProfileError,
  createAuthProfileLayer,
  findSecretFields,
  redact,
  looksLikeSecretValue,
  isIsoInstant,
} from './auth-profile.mjs';
