/**
 * UTOPIA · City Foundation — city-node-network — pairing-trust module entry point.
 *
 * RF-002: one pairing/trust state machine every join entry point converges on. New
 * construction, not a donor migration; the provenance a `DONOR.json` would carry for a
 * migration is in `./PROVENANCE.json`, together with the boundaries this module
 * deliberately does not cross.
 *
 * The public surface is the whole governed contract: the versioned vocabularies and
 * document shapes (`contracts.mjs`), and the state machine plus trust lifecycle that
 * produce and refuse them (`pairing.mjs`).
 */

/** Versioned contract: entry points, phases, roles, validation, preview and digests. */
export {
  DEFAULT_SESSION_TTL_MS,
  DEVICE_ID_PATTERN,
  ENTRY_POINTS,
  FINGERPRINT_PATTERN,
  MAC_AUTHORITY,
  MAX_CONFIRMATION_ATTEMPTS,
  MAC_EVIDENCE_ROLE,
  PAIRING_PHASES,
  PAIRING_REJECTION_CODES,
  PAIRING_SCHEMA_VERSION,
  PAIRING_SESSION_KIND,
  PAIRING_STATES,
  PAIRING_TERMINAL_STATES,
  PAIRING_TRANSITIONS,
  PREVIEW_FIELDS,
  PairingError,
  PairingValidationError,
  REVOCATION_REASONS,
  SESSION_FIELDS,
  SESSION_ID_PATTERN,
  TRUST_RECORD_FIELDS,
  TRUST_RECORD_KIND,
  TRUST_ROLES,
  TRUST_STATES,
  TRUST_ID_PATTERN,
  assertPairingSession,
  assertTrustRecord,
  buildDevicePreview,
  capabilitiesFromTrustRole,
  canonicalJson,
  findSecretMaterial,
  instantOf,
  isIsoInstant,
  isFinalState,
  isLocallyAdministeredMac,
  normalizeMac,
  sessionDigest,
  sessionDocument,
  sha256,
  trustDigest,
  trustDocument,
  resolveActiveTrust,
  trustFromMacEvidence,
  validatePairingSession,
  validateTrustRecord,
} from './contracts.mjs';

/** State machine and trust lifecycle. */
export {
  MAX_AUDIT_ENTRIES,
  challengeFromNonce,
  createPairingAuthority,
  inspectSessionDocument,
  mintSessionId,
  mintTrustId,
  randomEntropy,
} from './pairing.mjs';
