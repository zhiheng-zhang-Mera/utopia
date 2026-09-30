/**
 * UTOPIA · City Foundation — city-node-network — device-identity module entry point.
 *
 * RF-001: logical device identity (`device_id`) and installation lifecycle
 * (`installation_id`). New construction, not a donor migration; the provenance that a
 * `DONOR.json` would carry for a migration is in `./PROVENANCE.json`, and the boundary
 * this module deliberately does not cross is recorded there too.
 *
 * The public surface is the whole governed contract: versioned document shapes
 * (`contracts.mjs`), the lifecycle that produces and refuses them (`identity.mjs`), and the
 * MAC rule that is stated once and enforced by absence — no function in this module reads a
 * MAC to decide anything.
 */

/** Versioned document contract: shapes, vocabularies, validation and canonical form. */
export {
  DEVICE_IDENTITY_AUTHORITY_FIELDS,
  DEVICE_IDENTITY_FIELDS,
  DEVICE_IDENTITY_KIND,
  DEVICE_INSTALLATION_KIND,
  DEVICE_KEY_FIELDS,
  DEVICE_METADATA_FIELDS,
  DEVICE_ID_PATTERN,
  DEVICE_STATES,
  DeviceIdentityError,
  IDENTITY_REJECTION_CODES,
  IDENTITY_SCHEMA_VERSION,
  INSTALLATION_CREDENTIAL_FIELDS,
  INSTALLATION_FIELDS,
  INSTALLATION_ID_PATTERN,
  INSTALLATION_QUARANTINE_FIELDS,
  INSTALLATION_REBIND_FIELDS,
  INSTALLATION_STATES,
  INSTANCE_ID_PATTERN,
  KEY_ALGORITHMS,
  KEY_FINGERPRINT_PATTERN,
  KEY_ID_PATTERN,
  KEY_STATES,
  LEGACY_GATEWAY_NODE_FIELDS,
  MAC_AUTHORITY,
  MAC_EVIDENCE_FIELDS,
  MAC_EVIDENCE_ROLE,
  MAC_SOURCES,
  METADATA_AUTHORITY,
  assertDeviceIdentity,
  assertInstallation,
  canonicalJson,
  deviceIdentityDigest,
  deviceIdentityDocument,
  deviceIdentityFromDocument,
  deviceKey,
  deviceMetadata,
  fingerprintKeyMaterial,
  installationDigest,
  installationDocument,
  installationFromDocument,
  isIsoInstant,
  isLocallyAdministeredMac,
  macEvidence,
  normalizeMac,
  sha256,
  validateDeviceIdentity,
  validateInstallation,
} from './contracts.mjs';

/** Lifecycle: enrollment, keys, installations, clone detection and the legacy upgrade. */
export {
  IDENTITY_FIELD_LIST,
  IdentityLifecycleError,
  METADATA_IS_NOT_AUTHORITY,
  PRESENTATION_VERDICTS,
  assertActiveKey,
  createInstallation,
  credentialFingerprint,
  credentialLeakScan,
  detectCredentialClones,
  enrollDevice,
  enrollInstallation,
  instantOf,
  macPairingEvidence,
  migrateDeviceIdentity,
  mintCredentialId,
  mintDeviceId,
  mintInstallationId,
  mintInstanceId,
  quarantineInstallation,
  randomEntropy,
  rebindInstallation,
  recordNetworkMetadata,
  reinstallInstallation,
  renameDevice,
  resolveInstallationPresentation,
  retireDevice,
  retireInstallation,
  revokeDeviceKey,
  rotateDeviceKey,
  serializeDeviceIdentity,
  serializeInstallation,
  trustFromMacEvidence,
} from './identity.mjs';
